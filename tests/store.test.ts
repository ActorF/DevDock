import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../electron/services/store'
import { MAX_OUTPUT_LENGTH } from '../electron/services/bounded-log'
import type { RunRecord } from '../shared/types'
import { removeTestDirectory } from './temp-cleanup'

describe('Store persistence', () => {
  let temporary: string
  let dataDir: string
  let projectDir: string
  let store: Store

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devdock-store-'))
    dataDir = path.join(temporary, 'data')
    projectDir = path.join(temporary, 'project')
    await fs.mkdir(projectDir)
    store = new Store(dataDir)
    await store.init()
  })

  afterEach(async () => {
    await removeTestDirectory(temporary)
  })

  function run(id: string, status: RunRecord['status'] = 'success'): RunRecord {
    return {
      id, projectId: 'project', projectName: 'Example', label: 'Test', kind: 'test',
      command: 'npm test', cwd: projectDir, status, startedAt: new Date(Number(id) || 0).toISOString(), output: 'ok',
    }
  }

  it('persists projects, commands and settings while keeping returned snapshots isolated', async () => {
    let config = await store.addProject(projectDir)
    const projectId = config.activeProjectId!
    expect(config.projects[0].commands).toEqual([])
    config.projects[0].name = 'untrusted mutation'
    await Promise.all([
      store.saveCommand(projectId, { id: 'test', name: 'Test', command: 'python -m pytest', kind: 'test' }),
      store.saveSettings({ compact: true, bounds: { x: -40, y: 50, width: 420, height: 400 } }),
    ])
    const restarted = new Store(dataDir)
    await restarted.init()
    config = restarted.getConfig()
    expect(config.projects[0].name).toBe('project')
    expect(config.projects[0].commands[0].command).toBe('python -m pytest')
    expect(config.settings.compact).toBe(true)
    expect(config.settings.bounds?.x).toBe(-40)
    expect(config.activeProjectId).toBe(projectId)
    expect((await fs.readdir(dataDir)).some(file => file.endsWith('.tmp'))).toBe(false)
  })

  it('deduplicates the same canonical project directory and selects it', async () => {
    const first = await store.addProject(projectDir)
    const otherDir = path.join(temporary, 'other')
    await fs.mkdir(otherDir)
    await store.addProject(otherDir)
    const duplicate = await store.addProject(path.join(projectDir, '.'))
    expect(duplicate.projects).toHaveLength(2)
    expect(duplicate.activeProjectId).toBe(first.activeProjectId)
    if (process.platform === 'win32') {
      expect((await store.addProject(projectDir.toUpperCase())).projects).toHaveLength(2)
    }
  })

  it('detects declared package-manager scripts without executing them', async () => {
    const marker = path.join(projectDir, 'should-not-exist')
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10.0.0', scripts: { test: `touch ${marker}`, build: 'build', dev: 'dev', lint: 'lint' },
    }))
    const config = await store.addProject(projectDir)
    expect(config.projects[0].commands.map(command => command.command)).toEqual([
      'pnpm run test', 'pnpm run build', 'pnpm run dev', 'pnpm run lint',
    ])
    await expect(fs.access(marker)).rejects.toThrow()
  })

  it('detects a lockfile and tolerates malformed or missing package manifests', async () => {
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ scripts: { start: 'start' } }))
    await fs.writeFile(path.join(projectDir, 'yarn.lock'), '')
    expect((await store.addProject(projectDir)).projects[0].commands[0].command).toBe('yarn run start')
    const malformedDir = path.join(temporary, 'malformed')
    await fs.mkdir(malformedDir)
    await fs.writeFile(path.join(malformedDir, 'package.json'), '{broken')
    expect((await store.addProject(malformedDir)).projects[1].commands).toEqual([])
  })

  it('validates commands and removes configuration without deleting project files', async () => {
    const config = await store.addProject(projectDir)
    const id = config.activeProjectId!
    await expect(store.saveCommand(id, { id: '', name: ' ', command: 'node', kind: 'custom' })).rejects.toThrow()
    await expect(store.saveCommand(id, { id: '', name: 'test', command: 'node\0x', kind: 'custom' })).rejects.toThrow()
    const saved = await store.saveCommand(id, { id: '', name: 'Build', command: 'npm run build', kind: 'build' })
    const commandId = saved.projects[0].commands[0].id
    expect(commandId).toBeTruthy()
    expect((await store.deleteCommand(id, commandId)).projects[0].commands).toEqual([])
    expect((await store.removeProject(id)).activeProjectId).toBeNull()
    expect((await fs.stat(projectDir)).isDirectory()).toBe(true)
    await expect(store.addProject(path.join(projectDir, 'missing'))).rejects.toThrow()
  })

  it('preserves corrupt originals and exposes a visible startup warning', async () => {
    const broken = '{this is not valid JSON'
    await fs.writeFile(path.join(dataDir, 'config.json'), broken)
    await fs.writeFile(path.join(dataDir, 'history.json'), '{broken history')
    const restarted = new Store(dataDir)
    await restarted.init()
    expect(restarted.getConfig().projects).toEqual([])
    expect(restarted.getRuns()).toEqual([])
    expect(restarted.startupWarning).toContain('config.json')
    expect(restarted.startupWarning).toContain('history.json')
    const backups = (await fs.readdir(dataDir)).filter(name => name.endsWith('.bak'))
    expect(backups).toHaveLength(2)
    expect(await fs.readFile(path.join(dataDir, backups.find(name => name.startsWith('config'))!), 'utf8')).toBe(broken)
    await restarted.saveSettings({ alwaysOnTop: false })
    expect(await fs.readFile(path.join(dataDir, backups.find(name => name.startsWith('config'))!), 'utf8')).toBe(broken)
  })

  it('recovers unfinished tasks as interrupted and persists that state', async () => {
    await store.saveRun(run('1', 'running'))
    const restarted = new Store(dataDir)
    await restarted.init()
    const recovered = restarted.getRuns()[0]
    expect(recovered.status).toBe('interrupted')
    expect(recovered.endedAt).toBeTruthy()
    expect(recovered.output).toContain('上次应用退出')
    const again = new Store(dataDir)
    await again.init()
    expect(again.getRuns()[0].status).toBe('interrupted')
  })

  it('serializes concurrent history writes, limits size and preserves running items when clearing', async () => {
    await Promise.all(Array.from({ length: 104 }, (_, index) => store.saveRun({
      ...run(String(index + 1)), output: index === 103 ? 'x'.repeat(MAX_OUTPUT_LENGTH + 1000) : 'ok',
    })))
    expect(store.getRuns()).toHaveLength(100)
    expect(store.getRuns()[0].id).toBe('104')
    expect(store.getRuns()[0].output.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH)
    expect(store.getRuns().some(item => item.id === '1')).toBe(false)
    await store.saveRun(run('105', 'running'))
    await store.clearHistory('project')
    expect(store.getRuns().map(item => item.id)).toEqual(['105'])
  })

  it('coalesces rapid updates without losing the final state or changing clear ordering', async () => {
    await Promise.all([
      store.saveRun({ ...run('1', 'running'), output: 'first' }),
      store.saveRun({ ...run('1', 'running'), output: 'second' }),
      store.saveRun({ ...run('1', 'success'), output: 'final' }),
    ])
    expect(store.getRuns()[0].output).toBe('final')
    expect(store.getRuns()[0].status).toBe('success')
    await Promise.all([
      store.saveRun(run('2')),
      store.clearHistory('project'),
      store.saveRun(run('3')),
    ])
    await store.flush()
    expect(store.getRuns().map(item => item.id)).toEqual(['3'])
  })
})
