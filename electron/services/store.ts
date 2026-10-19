import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppConfig, AppSettings, CommandConfig, Project, RunRecord } from '../../shared/types'
import { boundedOutput } from './bounded-log'

const HISTORY_LIMIT = 100
const COMMAND_KINDS = new Set(['test', 'build', 'run', 'custom'])
const RUN_STATUSES = new Set(['running', 'success', 'failed', 'stopped', 'interrupted'])
const DEFAULT_SETTINGS: AppSettings = {
  alwaysOnTop: true, compact: false, notifications: true, shortcut: 'CommandOrControl+Shift+Space',
}

function freshConfig(): AppConfig {
  return { version: 1, projects: [], activeProjectId: null, settings: { ...DEFAULT_SETTINGS } }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置格式无效')
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, max = 4096, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) {
    throw new Error(`${label}无效`)
  }
  return value
}

function validCommand(value: unknown, allowNew = false): CommandConfig {
  const input = object(value)
  const id = allowNew && !input.id ? randomUUID() : string(input.id, '按钮 ID', 128)
  const kind = string(input.kind, '按钮类型', 16)
  if (!COMMAND_KINDS.has(kind)) throw new Error('不支持的按钮类型')
  const cwd = input.cwd === undefined || input.cwd === '' ? undefined : string(input.cwd, '工作目录')
  return {
    id, name: string(input.name, '按钮名称', 80).trim(),
    command: string(input.command, '命令', 16_384).trim(),
    kind: kind as CommandConfig['kind'], ...(cwd ? { cwd } : {}),
  }
}

function validSettings(value: unknown, current: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const input = object(value)
  const result = { ...current }
  for (const key of ['alwaysOnTop', 'compact', 'notifications'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`)
      result[key] = input[key]
    }
  }
  if (input.shortcut !== undefined) result.shortcut = string(input.shortcut, '快捷键', 120, true)
  if (input.bounds !== undefined) {
    const bounds = object(input.bounds)
    for (const key of ['x', 'y', 'width', 'height']) {
      if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key])) throw new Error('窗口位置无效')
    }
    if ((bounds.width as number) < 100 || (bounds.height as number) < 40) throw new Error('窗口大小无效')
    result.bounds = {
      x: Math.round(bounds.x as number), y: Math.round(bounds.y as number),
      width: Math.round(bounds.width as number), height: Math.round(bounds.height as number),
    }
  }
  return result
}

function validConfig(value: unknown): AppConfig {
  const input = object(value)
  if (input.version !== 1 || !Array.isArray(input.projects)) throw new Error('配置版本或项目列表无效')
  const projects: Project[] = input.projects.map((item: unknown) => {
    const project = object(item)
    if (!Array.isArray(project.commands)) throw new Error('项目按钮列表无效')
    const commands = project.commands.map(command => validCommand(command))
    if (new Set(commands.map(command => command.id)).size !== commands.length) throw new Error('按钮 ID 重复')
    const projectPath = string(project.path, '项目目录')
    if (!path.isAbsolute(projectPath)) throw new Error('项目目录必须是绝对路径')
    return {
      id: string(project.id, '项目 ID', 128), name: string(project.name, '项目名称', 256),
      path: projectPath, createdAt: string(project.createdAt, '创建时间', 64), commands,
    }
  })
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw new Error('项目 ID 重复')
  const activeId = input.activeProjectId === null ? null : string(input.activeProjectId, '当前项目 ID', 128)
  return {
    version: 1, projects,
    activeProjectId: projects.some(project => project.id === activeId) ? activeId : projects[0]?.id ?? null,
    settings: validSettings(input.settings),
  }
}

function validRun(value: unknown): RunRecord {
  const input = object(value)
  const status = string(input.status, '运行状态', 16)
  const kind = string(input.kind, '运行类型', 16)
  if (!RUN_STATUSES.has(status) || !(COMMAND_KINDS.has(kind) || kind === 'git')) throw new Error('运行记录无效')
  if (input.exitCode !== undefined && input.exitCode !== null && !Number.isInteger(input.exitCode)) throw new Error('退出码无效')
  return {
    id: string(input.id, '运行 ID', 128), projectId: string(input.projectId, '项目 ID', 128),
    projectName: string(input.projectName, '项目名称', 256), label: string(input.label, '操作名称', 128),
    command: string(input.command, '命令', 16_384), cwd: string(input.cwd, '工作目录'),
    kind: kind as RunRecord['kind'], status: status as RunRecord['status'],
    startedAt: string(input.startedAt, '开始时间', 64), output: boundedOutput(string(input.output, '日志', 16 * 1024 * 1024, true)),
    ...(input.endedAt !== undefined ? { endedAt: string(input.endedAt, '结束时间', 64) } : {}),
    ...(input.commandId !== undefined ? { commandId: string(input.commandId, '按钮 ID', 128) } : {}),
    ...(input.fingerprint !== undefined ? { fingerprint: string(input.fingerprint, '版本标识', 1024, true) } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode as number | null } : {}),
  }
}

async function exists(filename: string): Promise<boolean> {
  try { await fs.access(filename); return true } catch { return false }
}

async function detectCommands(projectPath: string): Promise<CommandConfig[]> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'))
    const scripts = object(manifest.scripts ?? {})
    const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : ''
    let manager = ['npm', 'pnpm', 'yarn', 'bun'].includes(declared) ? declared : 'npm'
    if (!declared) {
      if (await exists(path.join(projectPath, 'pnpm-lock.yaml'))) manager = 'pnpm'
      else if (await exists(path.join(projectPath, 'yarn.lock'))) manager = 'yarn'
      else if (await exists(path.join(projectPath, 'bun.lockb')) || await exists(path.join(projectPath, 'bun.lock'))) manager = 'bun'
    }
    const candidates: Array<[string, string, CommandConfig['kind']]> = [
      ['test', 'Test', 'test'], ['build', 'Build', 'build'],
      [typeof scripts.dev === 'string' ? 'dev' : 'start', 'Run', 'run'],
      ['lint', 'Lint', 'custom'], ['format', 'Format', 'custom'],
    ]
    return candidates.filter(([script]) => typeof scripts[script] === 'string').map(([script, name, kind]) => ({
      id: randomUUID(), name, kind, command: `${manager} run ${script}`,
    }))
  } catch {
    // Non-JavaScript projects and malformed manifests can still be configured manually.
    return []
  }
}

export class Store {
  startupWarning?: string
  private config = freshConfig()
  private runs: RunRecord[] = []
  private pending: Promise<unknown> = Promise.resolve()
  private runBatch?: { updates: Map<string, RunRecord>; completion: Promise<void> }

  constructor(private dataDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    // Resolve directory links, but retain per-file resolution below: Windows
    // AppData virtualization can redirect files while the parent stays on C:.
    this.dataDir = await fs.realpath(this.dataDir)
    this.config = await this.readFile('config.json', validConfig, freshConfig())
    this.runs = await this.readFile('history.json', value => {
      if (!Array.isArray(value)) throw new Error('历史记录格式无效')
      return value.map(validRun).slice(0, HISTORY_LIMIT)
    }, [])
    let interrupted = false
    this.runs = this.runs.map(run => {
      if (run.status !== 'running') return run
      interrupted = true
      return {
        ...run, status: 'interrupted', endedAt: new Date().toISOString(), exitCode: null,
        output: boundedOutput(`${run.output}\n[上次应用退出时此任务尚未完成，请检查结果后重新运行。]\n`),
      }
    })
    if (interrupted) await this.writeFile('history.json', this.runs)
  }

  getConfig(): AppConfig { return structuredClone(this.config) }
  getRuns(): RunRecord[] { return structuredClone(this.runs) }
  async flush(): Promise<void> { await this.pending }
  getProject(id: string): Project {
    const project = this.config.projects.find(item => item.id === id)
    if (!project) throw new Error('项目不存在，请重新选择项目')
    return structuredClone(project)
  }

  addProject(projectPath: string): Promise<AppConfig> {
    return this.update(async config => {
      const canonical = await fs.realpath(string(projectPath, '项目目录'))
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('请选择项目文件夹')
      const compare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
      const existing = config.projects.find(project => compare(project.path) === compare(canonical))
      if (existing) { config.activeProjectId = existing.id; return }
      const project: Project = {
        id: randomUUID(), name: path.basename(canonical) || canonical,
        path: canonical, createdAt: new Date().toISOString(), commands: await detectCommands(canonical),
      }
      config.projects.push(project)
      config.activeProjectId = project.id
    })
  }

  selectProject(id: string): Promise<AppConfig> {
    return this.update(config => {
      this.findProject(config, id)
      config.activeProjectId = id
    })
  }

  removeProject(id: string): Promise<AppConfig> {
    return this.update(config => {
      this.findProject(config, id)
      config.projects = config.projects.filter(project => project.id !== id)
      if (config.activeProjectId === id) config.activeProjectId = config.projects[0]?.id ?? null
    })
  }

  saveCommand(projectId: string, command: CommandConfig): Promise<AppConfig> {
    return this.update(config => {
      const project = this.findProject(config, projectId)
      const validated = validCommand(command, true)
      const index = project.commands.findIndex(item => item.id === validated.id)
      if (index === -1) project.commands.push(validated)
      else project.commands[index] = validated
    })
  }

  deleteCommand(projectId: string, commandId: string): Promise<AppConfig> {
    return this.update(config => {
      const project = this.findProject(config, projectId)
      if (!project.commands.some(command => command.id === commandId)) throw new Error('按钮不存在')
      project.commands = project.commands.filter(command => command.id !== commandId)
    })
  }

  saveSettings(settings: Partial<AppSettings>): Promise<AppConfig> {
    return this.update(config => { config.settings = validSettings(settings, config.settings) })
  }

  saveRun(run: RunRecord): Promise<void> {
    const copy = validRun(run)
    if (this.runBatch) {
      this.runBatch.updates.set(copy.id, copy)
      return this.runBatch.completion
    }
    const updates = new Map([[copy.id, copy]])
    const completion = this.enqueue(async () => {
      // Updates arriving during this disk write share one subsequent batch, rather
      // than queueing an entire copy of all history for every output event.
      if (this.runBatch?.updates === updates) this.runBatch = undefined
      const next = this.runs.filter(item => !updates.has(item.id))
      next.push(...updates.values())
      next.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
      await this.writeFile('history.json', next.slice(0, HISTORY_LIMIT))
      this.runs = next.slice(0, HISTORY_LIMIT)
    })
    this.runBatch = { updates, completion }
    return completion
  }

  clearHistory(projectId: string): Promise<void> {
    // Preserve call ordering if a new update arrives after the clear request.
    this.runBatch = undefined
    return this.enqueue(async () => {
      const next = this.runs.filter(run => run.projectId !== projectId || run.status === 'running')
      await this.writeFile('history.json', next)
      this.runs = next
    })
  }

  private findProject(config: AppConfig, id: string): Project {
    const project = config.projects.find(item => item.id === id)
    if (!project) throw new Error('项目不存在，请重新选择项目')
    return project
  }

  private update(change: (config: AppConfig) => void | Promise<void>): Promise<AppConfig> {
    return this.enqueue(async () => {
      const next = this.getConfig()
      await change(next)
      await this.writeFile('config.json', next)
      this.config = next
      return this.getConfig()
    })
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action)
    this.pending = next.catch(() => {})
    return next
  }

  private async readFile<T>(name: string, validate: (value: unknown) => T, fallback: T): Promise<T> {
    const filename = path.join(this.dataDir, name)
    let content: string
    try { content = await fs.readFile(filename, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw error
    }
    try { return validate(JSON.parse(content)) }
    catch {
      const physicalFile = await fs.realpath(filename)
      const backup = `${physicalFile}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`
      await fs.rename(physicalFile, backup)
      const warning = `${name} 无法读取，已保留原文件：${backup}。当前使用默认数据。`
      this.startupWarning = this.startupWarning ? `${this.startupWarning}\n${warning}` : warning
      return fallback
    }
  }

  private async writeFile(name: string, data: unknown): Promise<void> {
    const destination = path.join(this.dataDir, name)
    let temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' })
      // Resolve the newly created file, not just its parent. MSIX can overlay
      // an existing C: directory with new files on D:. Renaming two logical
      // siblings then fails with EXDEV; physical siblings remain atomic.
      temporary = await fs.realpath(temporary)
      await fs.rename(temporary, path.join(path.dirname(temporary), name))
    } finally {
      await fs.unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }
}
