import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../electron/services/store'
import type { RunRecord } from '../shared/types'
import { removeTestDirectory } from './temp-cleanup'

/** Model MSIX's file overlay: the directory itself resolves to C:, but files live on D:. */
describe('Store with per-file AppData redirection', () => {
  let root: string
  let logical: string
  let physical: string
  let project: string
  let renameSpy: ReturnType<typeof vi.spyOn>
  let failReplacements: boolean
  const original = {
    readFile: fs.readFile.bind(fs), writeFile: fs.writeFile.bind(fs),
    rename: fs.rename.bind(fs), realpath: fs.realpath.bind(fs), unlink: fs.unlink.bind(fs),
  }

  const isLogicalFile = (value: unknown): value is string => typeof value === 'string' && path.dirname(value) === logical
  const redirect = (value: unknown) => isLogicalFile(value) ? path.join(physical, path.basename(value)) : value

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devdock-redirection-'))
    logical = path.join(root, 'logical-appdata')
    physical = path.join(root, 'physical-overlay')
    project = path.join(root, 'project')
    await Promise.all([fs.mkdir(logical), fs.mkdir(physical), fs.mkdir(project)])
    failReplacements = false
    // Mock only filesystem routing; all JSON, file writes and replacements remain real.
    vi.spyOn(fs, 'writeFile').mockImplementation((filename, data, options) => original.writeFile(redirect(filename) as Parameters<typeof fs.writeFile>[0], data, options))
    vi.spyOn(fs, 'readFile').mockImplementation(((filename: Parameters<typeof fs.readFile>[0], options: unknown) =>
      original.readFile(redirect(filename) as Parameters<typeof fs.readFile>[0], options as never)) as typeof fs.readFile)
    vi.spyOn(fs, 'realpath').mockImplementation(((filename: Parameters<typeof fs.realpath>[0], options: unknown) =>
      original.realpath(redirect(filename) as Parameters<typeof fs.realpath>[0], options as never)) as typeof fs.realpath)
    vi.spyOn(fs, 'unlink').mockImplementation(filename => original.unlink(redirect(filename) as Parameters<typeof fs.unlink>[0]))
    renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (isLogicalFile(source) || isLogicalFile(destination)) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      }
      if (failReplacements && typeof destination === 'string' && ['config.json', 'history.json'].includes(path.basename(destination))) {
        throw Object.assign(new Error('simulated destination permission failure'), { code: 'EACCES' })
      }
      await original.rename(source, destination)
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await removeTestDirectory(root)
  })

  function history(status: RunRecord['status'] = 'success'): RunRecord {
    return {
      id: 'run-1', projectId: 'project-1', projectName: 'Example', label: 'Test', kind: 'test',
      command: 'npm test', cwd: project, status, startedAt: '2026-10-19T12:00:00.000Z', output: 'saved output',
    }
  }

  it('saves first-run config and history using physical siblings and restores them through logical paths', async () => {
    const store = new Store(logical)
    await store.init()
    expect(await fs.realpath(logical)).toBe(logical)
    const config = await store.addProject(project)
    await store.saveSettings({ alwaysOnTop: false, compact: true })
    await store.saveRun(history())
    await store.flush()
    expect(renameSpy).toHaveBeenCalled()
    for (const [source, destination] of renameSpy.mock.calls) {
      expect(path.dirname(source as string)).toBe(physical)
      expect(path.dirname(destination as string)).toBe(physical)
    }
    const restarted = new Store(logical)
    await restarted.init()
    expect(restarted.getConfig().activeProjectId).toBe(config.activeProjectId)
    expect(restarted.getConfig().projects[0].path).toBe(await original.realpath(project))
    expect(restarted.getConfig().settings).toMatchObject({ alwaysOnTop: false, compact: true })
    expect(restarted.getRuns()).toEqual([history()])
    expect(await fs.readdir(logical)).toEqual([])
    expect((await fs.readdir(physical)).sort()).toEqual(['config.json', 'history.json'])
  })

  it('preserves existing disk and memory state when an atomic replacement fails', async () => {
    const store = new Store(logical)
    await store.init()
    await store.addProject(project)
    await store.saveRun(history())
    const previous = store.getConfig()
    const configBytes = await original.readFile(path.join(physical, 'config.json'))
    const historyBytes = await original.readFile(path.join(physical, 'history.json'))
    const copy = vi.spyOn(fs, 'copyFile')
    failReplacements = true
    await expect(store.saveSettings({ alwaysOnTop: !previous.settings.alwaysOnTop })).rejects.toThrow('permission failure')
    await expect(store.saveRun({ ...history(), output: 'must not replace saved output' })).rejects.toThrow('permission failure')
    expect(store.getConfig()).toEqual(previous)
    expect(store.getRuns()).toEqual([history()])
    expect(await original.readFile(path.join(physical, 'config.json'))).toEqual(configBytes)
    expect(await original.readFile(path.join(physical, 'history.json'))).toEqual(historyBytes)
    expect(copy).not.toHaveBeenCalled()
    expect((await fs.readdir(physical)).some(filename => filename.endsWith('.tmp'))).toBe(false)
    failReplacements = false
    await store.saveSettings({ compact: true })
    const restarted = new Store(logical)
    await restarted.init()
    expect(restarted.getConfig().settings.compact).toBe(true)
    expect(restarted.getRuns()).toEqual([history()])
  })

  it('backs up corrupt files beside their physical originals before restoring defaults', async () => {
    const configBytes = Buffer.from([0xff, 0x7b, 0x62, 0x61, 0x64])
    const historyBytes = Buffer.from('{broken history\n')
    await original.writeFile(path.join(physical, 'config.json'), configBytes)
    await original.writeFile(path.join(physical, 'history.json'), historyBytes)
    const store = new Store(logical)
    await store.init()
    expect(store.startupWarning).toContain(physical)
    expect(store.getConfig().projects).toEqual([])
    expect(store.getRuns()).toEqual([])
    const backups = (await fs.readdir(physical)).filter(filename => filename.endsWith('.bak'))
    expect(backups).toHaveLength(2)
    const configBackup = backups.find(filename => filename.startsWith('config.json'))!
    const historyBackup = backups.find(filename => filename.startsWith('history.json'))!
    expect(await original.readFile(path.join(physical, configBackup))).toEqual(configBytes)
    expect(await original.readFile(path.join(physical, historyBackup))).toEqual(historyBytes)
    await store.addProject(project)
    await store.saveRun(history())
    const restarted = new Store(logical)
    await restarted.init()
    expect(restarted.getConfig().projects).toHaveLength(1)
    expect(restarted.getRuns()).toEqual([history()])
    expect(await original.readFile(path.join(physical, configBackup))).toEqual(configBytes)
  })

  it('recovers and persists interrupted history in the overlay during initialization', async () => {
    await original.writeFile(path.join(physical, 'history.json'), JSON.stringify([history('running')]))
    const store = new Store(logical)
    await store.init()
    expect(store.getRuns()[0]).toMatchObject({ status: 'interrupted', exitCode: null })
    const restarted = new Store(logical)
    await restarted.init()
    expect(restarted.getRuns()[0].status).toBe('interrupted')
    expect(restarted.getRuns()[0].output).toContain('saved output')
    expect((await fs.readdir(physical)).some(filename => filename.endsWith('.tmp'))).toBe(false)
  })
})
