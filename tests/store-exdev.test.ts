import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../electron/services/store'
import type { RunRecord } from '../shared/types'
import { removeTestDirectory } from './temp-cleanup'

function filesystemError(code: string, source: string, destination: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated rename failure`), { code, syscall: 'rename', path: source, dest: destination })
}

function pathKey(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

describe('Store persistence through a redirected user-data directory', () => {
  let temporary: string
  let physicalDir: string
  let logicalDir: string
  let projectDir: string
  let store: Store
  let originalRename: typeof fs.rename

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devdock-store-exdev-'))
    // Keep every fixture on its canonical filesystem path. Only logicalDir is
    // deliberately redirected, as happens to packaged-app Roaming directories.
    const canonicalTemporary = await fs.realpath(temporary)
    physicalDir = path.join(canonicalTemporary, 'physical-data')
    logicalDir = path.join(canonicalTemporary, 'logical-data')
    projectDir = path.join(canonicalTemporary, 'project')
    await fs.mkdir(physicalDir)
    await fs.mkdir(projectDir)
    await fs.symlink(physicalDir, logicalDir, process.platform === 'win32' ? 'junction' : 'dir')
    originalRename = fs.rename.bind(fs)
    store = new Store(logicalDir)
    await store.init()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await store?.flush()
    await removeTestDirectory(temporary)
  })

  function rejectLogicalRenames() {
    return vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      const sourcePath = String(source)
      const destinationPath = String(destination)
      if (pathKey(path.dirname(sourcePath)) === pathKey(logicalDir) || pathKey(path.dirname(destinationPath)) === pathKey(logicalDir)) {
        throw filesystemError('EXDEV', sourcePath, destinationPath)
      }
      return originalRename(source, destination)
    })
  }

  function assertPhysicalRenames(calls: ReadonlyArray<readonly [unknown, unknown]>) {
    expect(calls.length).toBeGreaterThan(0)
    for (const [source, destination] of calls) {
      expect(pathKey(path.dirname(String(source)))).toBe(pathKey(physicalDir))
      expect(pathKey(path.dirname(String(destination)))).toBe(pathKey(physicalDir))
    }
  }

  async function assertNoTemporaryFiles() {
    expect((await fs.readdir(physicalDir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  }

  function run(id: string, status: RunRecord['status'] = 'success'): RunRecord {
    return {
      id, projectId: 'project', projectName: 'Example', label: 'Test', kind: 'test', command: 'npm test',
      cwd: projectDir, status, startedAt: new Date(Number(id)).toISOString(), output: `run ${id}`,
    }
  }

  it('creates the first project configuration on the canonical directory and survives restart', async () => {
    const rename = rejectLogicalRenames()
    const config = await store.addProject(projectDir)
    expect(config.projects[0].path).toBe(await fs.realpath(projectDir))
    expect(JSON.parse(await fs.readFile(path.join(logicalDir, 'config.json'), 'utf8'))).toEqual(config)
    const restarted = new Store(logicalDir)
    await restarted.init()
    expect(restarted.getConfig()).toEqual(config)
    assertPhysicalRenames(rename.mock.calls)
    await assertNoTemporaryFiles()
  })

  it('replaces an existing config for settings, command and project updates through the canonical directory', async () => {
    const initial = await store.addProject(projectDir)
    const firstId = initial.activeProjectId!
    const secondProject = path.join(path.dirname(projectDir), 'second-project')
    await fs.mkdir(secondProject)
    const rename = rejectLogicalRenames()
    await store.addProject(secondProject)
    await store.selectProject(firstId)
    await store.saveCommand(firstId, { id: 'test', name: 'Test', kind: 'test', command: 'python -m pytest' })
    await store.saveSettings({ compact: true, alwaysOnTop: false })
    const expected = store.getConfig()
    const restarted = new Store(logicalDir)
    await restarted.init()
    expect(restarted.getConfig()).toEqual(expected)
    expect(restarted.getConfig().projects[0].commands[0].command).toBe('python -m pytest')
    await restarted.deleteCommand(firstId, 'test')
    const secondId = expected.projects.find(project => project.id !== firstId)!.id
    await restarted.removeProject(secondId)
    const again = new Store(logicalDir)
    await again.init()
    expect(again.getConfig().projects).toHaveLength(1)
    expect(again.getConfig().projects[0].commands).toEqual([])
    expect(again.getConfig().settings.compact).toBe(true)
    assertPhysicalRenames(rename.mock.calls)
    await assertNoTemporaryFiles()
  })

  it('persists and clears run history using canonical rename paths', async () => {
    const rename = rejectLogicalRenames()
    await store.saveRun(run('1', 'running'))
    await store.saveRun({ ...run('1'), output: 'finished' })
    await store.saveRun(run('2'))
    const restarted = new Store(logicalDir)
    await restarted.init()
    expect(restarted.getRuns().map(record => [record.id, record.status, record.output])).toEqual([
      ['2', 'success', 'run 2'], ['1', 'success', 'finished'],
    ])
    await restarted.clearHistory('project')
    const again = new Store(logicalDir)
    await again.init()
    expect(again.getRuns()).toEqual([])
    assertPhysicalRenames(rename.mock.calls)
    await assertNoTemporaryFiles()
  })

  it('recovers a running task and persists interrupted state through the canonical path', async () => {
    await store.saveRun(run('1', 'running'))
    const rename = rejectLogicalRenames()
    const restarted = new Store(logicalDir)
    await restarted.init()
    expect(restarted.getRuns()[0].status).toBe('interrupted')
    const again = new Store(logicalDir)
    await again.init()
    expect(again.getRuns()[0].status).toBe('interrupted')
    assertPhysicalRenames(rename.mock.calls)
    await assertNoTemporaryFiles()
  })

  it('backs up corrupt config and history on the physical directory before creating replacement data', async () => {
    const brokenConfig = '{corrupt configuration'
    const brokenHistory = '{corrupt history'
    await fs.writeFile(path.join(logicalDir, 'config.json'), brokenConfig)
    await fs.writeFile(path.join(logicalDir, 'history.json'), brokenHistory)
    const rename = rejectLogicalRenames()
    const restarted = new Store(logicalDir)
    await restarted.init()
    expect(restarted.startupWarning).toContain('config.json')
    expect(restarted.startupWarning).toContain('history.json')
    const backups = (await fs.readdir(physicalDir)).filter(name => name.endsWith('.bak'))
    expect(backups).toHaveLength(2)
    expect(await fs.readFile(path.join(physicalDir, backups.find(name => name.startsWith('config.json.'))!), 'utf8')).toBe(brokenConfig)
    expect(await fs.readFile(path.join(physicalDir, backups.find(name => name.startsWith('history.json.'))!), 'utf8')).toBe(brokenHistory)
    await restarted.addProject(projectDir)
    await restarted.saveRun(run('1'))
    const again = new Store(logicalDir)
    await again.init()
    expect(again.startupWarning).toBeUndefined()
    expect(again.getConfig().projects).toHaveLength(1)
    expect(again.getRuns()).toHaveLength(1)
    assertPhysicalRenames(rename.mock.calls)
    await assertNoTemporaryFiles()
  })

  it('propagates non-EXDEV errors on first save without changing in-memory configuration', async () => {
    const before = store.getConfig()
    const failure = filesystemError('EACCES', physicalDir, physicalDir)
    vi.spyOn(fs, 'rename').mockRejectedValue(failure)
    await expect(store.addProject(projectDir)).rejects.toBe(failure)
    expect(store.getConfig()).toEqual(before)
    await expect(fs.access(path.join(physicalDir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await assertNoTemporaryFiles()
  })

  it('leaves an existing config and in-memory settings unchanged when atomic replacement is denied', async () => {
    await store.addProject(projectDir)
    const before = store.getConfig()
    const contentBefore = await fs.readFile(path.join(physicalDir, 'config.json'), 'utf8')
    const failure = filesystemError('EPERM', physicalDir, physicalDir)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(failure)
    await expect(store.saveSettings({ alwaysOnTop: false, compact: true })).rejects.toBe(failure)
    expect(store.getConfig()).toEqual(before)
    expect(await fs.readFile(path.join(physicalDir, 'config.json'), 'utf8')).toBe(contentBefore)
    await assertNoTemporaryFiles()
    rename.mockRestore()
    const restarted = new Store(logicalDir)
    await restarted.init()
    expect(restarted.getConfig()).toEqual(before)
  })

  it('does not update in-memory history or overwrite its file when rename fails', async () => {
    await store.saveRun(run('1'))
    const before = store.getRuns()
    const contentBefore = await fs.readFile(path.join(physicalDir, 'history.json'), 'utf8')
    const failure = filesystemError('EACCES', physicalDir, physicalDir)
    vi.spyOn(fs, 'rename').mockRejectedValue(failure)
    await expect(store.saveRun(run('2'))).rejects.toBe(failure)
    expect(store.getRuns()).toEqual(before)
    expect(await fs.readFile(path.join(physicalDir, 'history.json'), 'utf8')).toBe(contentBefore)
    await assertNoTemporaryFiles()
  })

  it('propagates a failed corrupt-file backup and preserves the original bytes', async () => {
    const broken = '{do not lose this file'
    await fs.writeFile(path.join(physicalDir, 'config.json'), broken)
    const failure = filesystemError('EACCES', physicalDir, physicalDir)
    vi.spyOn(fs, 'rename').mockRejectedValue(failure)
    const restarted = new Store(logicalDir)
    await expect(restarted.init()).rejects.toBe(failure)
    expect(await fs.readFile(path.join(physicalDir, 'config.json'), 'utf8')).toBe(broken)
    expect((await fs.readdir(physicalDir)).filter(name => name.endsWith('.bak'))).toEqual([])
  })
})
