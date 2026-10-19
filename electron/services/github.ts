import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { GitHubAccountState, GitHubRepository } from '../../shared/types'
import { redactGitOutput } from './git'

const DEVICE_URI = 'https://github.com/login/device'
const USER_FIELDS = '{login,name,id,html_url}'
const REPOSITORY_FIELDS = '{name,full_name,html_url,clone_url,ssh_url,private,default_branch}'
const OUTPUT_LIMIT = 2 * 1024 * 1024

type GitHubSpawn = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
interface Dependencies {
  findExecutable?: () => Promise<string>
  spawn?: GitHubSpawn
  commandTimeoutMs?: number
  loginTimeoutMs?: number
}
interface CommandResult { stdout: string; stderr: string; code: number }
interface CommandHandle { completion: Promise<CommandResult>; stop(): Promise<void> }
interface LoginSession { handle: CommandHandle; completion: Promise<void>; cancelled: boolean }

function safeMessage(value: string): string {
  return redactGitOutput(value)
    .replace(/(authorization\s*:\s*)(?:bearer|token|basic)\s+[^\s]+/gi, '$1[已隐藏]')
    .replace(/((?:oauth_token|access_token|refresh_token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .slice(0, 2000).trim()
}

class GitHubCommandError extends Error {
  constructor(readonly result: CommandResult) {
    super(safeMessage(result.stderr || result.stdout) || `GitHub 操作失败（退出码 ${result.code}）。`)
  }
}

async function findExecutable(): Promise<string> {
  const executable = process.platform === 'win32' ? 'gh.exe' : 'gh'
  const directories = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) directories.push(path.join(base, 'GitHub CLI'))
    }
    if (process.env.LOCALAPPDATA) directories.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI'))
  }
  for (const directory of directories) {
    const cleaned = directory.replace(/^"|"$/g, '')
    // Do not resolve an executable from the currently selected project directory.
    if (!path.isAbsolute(cleaned)) continue
    const candidate = path.join(cleaned, executable)
    if (await stat(candidate).then(value => value.isFile(), () => false)) return candidate
  }
  throw new Error('未安装 GitHub CLI。安装后重新检测，即可在这里登录 GitHub。')
}

function environment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1', CLICOLOR: '0', GIT_TERMINAL_PROMPT: '0',
  }
  // Debug mode logs HTTP headers. Tokens must never enter the application output.
  delete result.GH_DEBUG
  delete result.GH_FORCE_TTY
  return result
}

function readJson(value: string): unknown {
  try { return JSON.parse(value) }
  catch { throw new Error('GitHub 返回的数据无法解析，请稍后重试。') }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub 返回的数据格式不正确。')
  return value as Record<string, unknown>
}

function repository(value: unknown): GitHubRepository {
  const item = record(value)
  if (typeof item.name !== 'string' || typeof item.full_name !== 'string' ||
    typeof item.html_url !== 'string' || typeof item.clone_url !== 'string' ||
    typeof item.ssh_url !== 'string' || typeof item.private !== 'boolean') {
    throw new Error('GitHub 返回的仓库信息不完整。')
  }
  // The service is deliberately scoped to github.com; URLs returned to the renderer
  // cannot point a subsequent authenticated Git command at another host.
  const fullName = item.full_name
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) ||
    item.html_url !== `https://github.com/${fullName}` ||
    item.clone_url !== `https://github.com/${fullName}.git` ||
    item.ssh_url !== `git@github.com:${fullName}.git`) {
    throw new Error('GitHub 返回了不受支持的仓库地址。')
  }
  return {
    name: item.name, fullName, url: item.html_url, cloneUrl: item.clone_url, sshUrl: item.ssh_url,
    private: item.private, defaultBranch: typeof item.default_branch === 'string' ? item.default_branch : 'main',
  }
}

/** GitHub CLI owns credentials; DevDock only handles public account/repository metadata. */
export class GithubService {
  private readonly dependencies: Required<Dependencies>
  private account: GitHubAccountState = { available: false, state: 'disconnected' }
  private loginSession?: LoginSession
  private statusRequest?: Promise<GitHubAccountState>
  private accountRevision = 0
  private loginError?: string
  private disposed = false

  constructor(dependencies: Dependencies = {}) {
    this.dependencies = {
      findExecutable: dependencies.findExecutable ?? findExecutable,
      spawn: dependencies.spawn ?? ((executable, args, options) => spawn(executable, args, { ...options, stdio: 'pipe' })),
      commandTimeoutMs: dependencies.commandTimeoutMs ?? 30_000,
      loginTimeoutMs: dependencies.loginTimeoutMs ?? 10 * 60_000,
    }
  }

  async executable(): Promise<string> { return this.dependencies.findExecutable() }

  async status(): Promise<GitHubAccountState> {
    if (this.loginSession) return { ...this.account }
    if (!this.statusRequest) {
      this.statusRequest = this.refreshStatus().finally(() => { this.statusRequest = undefined })
    }
    return { ...await this.statusRequest }
  }

  private async refreshStatus(): Promise<GitHubAccountState> {
    const revision = this.accountRevision
    const publish = (value: GitHubAccountState): GitHubAccountState => {
      if (revision === this.accountRevision) this.account = value
      return this.account
    }
    let executable: string
    try { executable = await this.executable() }
    catch (error) {
      return publish({ available: false, state: 'disconnected', message: safeMessage((error as Error).message) })
    }
    try {
      const result = await this.command(executable, ['api', '--hostname', 'github.com', 'user', '--jq', USER_FIELDS]).completion
      const user = record(readJson(result.stdout))
      if (typeof user.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(user.login) ||
        typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) {
        throw new Error('GitHub 返回的账号信息不完整。')
      }
      this.loginError = undefined
      return publish({
        available: true, state: 'connected', login: user.login,
        name: typeof user.name === 'string' && user.name ? user.name : user.login,
        id: user.id, url: `https://github.com/${user.login}`,
      })
    } catch (error) {
      const message = safeMessage((error as Error).message)
      const needsLogin = /HTTP 401|Bad credentials|not logged|gh auth login|authentication token|requires authentication/i.test(message)
      return publish({ available: true, state: needsLogin && !this.loginError ? 'disconnected' : 'error', message: this.loginError ?? message })
    }
  }

  async login(): Promise<GitHubAccountState> {
    if (this.disposed) throw new Error('应用正在退出，无法开始登录。')
    if (this.loginSession || this.account.state === 'connected') return { ...this.account }
    // Finish any prior status call before changing the login state so an old response
    // cannot overwrite the code currently shown to the user.
    if (this.statusRequest) {
      const current = await this.statusRequest
      if (current.state === 'connected') return { ...current }
    }
    let executable: string
    try { executable = await this.executable() }
    catch (error) {
      this.account = { available: false, state: 'disconnected', message: safeMessage((error as Error).message) }
      return { ...this.account }
    }
    if (this.disposed) throw new Error('应用正在退出，无法开始登录。')
    if (this.loginSession) return { ...this.account }
    this.accountRevision++
    this.loginError = undefined
    this.account = { available: true, state: 'connecting', verificationUri: DEVICE_URI, message: '正在获取一次性验证码…' }
    let transcript = ''
    // Piped stdio makes gh noninteractive: it prints the device code/URL and waits
    // for approval. The renderer opens DEVICE_URI on an explicit user action.
    const handle = this.command(executable, [
      'auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key',
    ], undefined, this.dependencies.loginTimeoutMs, chunk => {
      transcript = (transcript + chunk).slice(-16_384)
      const code = transcript.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1]
      if (code && this.account.state === 'connecting') {
        this.account = { available: true, state: 'connecting', verificationUri: DEVICE_URI, deviceCode: code.toUpperCase(), message: '在 GitHub 页面输入验证码并授权，完成后会自动连接。' }
      }
    })
    const session: LoginSession = { handle, cancelled: false, completion: Promise.resolve() }
    this.loginSession = session
    session.completion = handle.completion.then(async () => {
      if (session.cancelled || this.disposed) return
      await this.refreshStatus()
    }, error => {
      if (session.cancelled || this.disposed) return
      this.loginError = safeMessage((error as Error).message)
      this.account = { available: true, state: 'error', message: this.loginError }
    }).finally(() => {
      if (this.loginSession === session) this.loginSession = undefined
    })
    return { ...this.account }
  }

  async cancelLogin(): Promise<GitHubAccountState> {
    const session = this.loginSession
    if (!session) return this.status()
    session.cancelled = true
    this.accountRevision++
    await session.handle.stop()
    await session.completion
    this.loginSession = undefined
    this.loginError = undefined
    this.account = { available: true, state: 'disconnected', message: '已取消本次登录。' }
    return { ...this.account }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.loginSession) await this.cancelLogin()
  }

  async repositories(): Promise<GitHubRepository[]> {
    const result = await this.command(await this.executable(), [
      'api', '--hostname', 'github.com',
      'user/repos?affiliation=owner&sort=updated&direction=desc&per_page=100',
      '--jq', `map(${REPOSITORY_FIELDS})`,
    ]).completion
    const values = readJson(result.stdout)
    if (!Array.isArray(values) || values.length > 100) throw new Error('GitHub 返回的仓库列表格式不正确。')
    return values.map(repository)
  }

  async createRepository(input: { name: string; description?: string; private: boolean }): Promise<GitHubRepository> {
    if (!input || typeof input !== 'object') throw new Error('请输入仓库名称。')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || /^\.+$/.test(name)) {
      throw new Error('仓库名称需要 1–100 个英文字母、数字、短横线、下划线或点，不能只包含点。')
    }
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 350)) {
      throw new Error('仓库说明最多 350 个字符。')
    }
    if (input.private !== undefined && typeof input.private !== 'boolean') throw new Error('请选择有效的仓库可见性。')
    const payload = JSON.stringify({ name, description: input.description ?? '', private: input.private !== false, auto_init: false })
    const result = await this.command(await this.executable(), [
      'api', '--hostname', 'github.com', '--method', 'POST', 'user/repos', '--input', '-', '--jq', REPOSITORY_FIELDS,
    ], payload).completion
    return repository(readJson(result.stdout))
  }

  private command(executable: string, args: string[], input?: string, timeout = this.dependencies.commandTimeoutMs,
    onOutput?: (chunk: string) => void): CommandHandle {
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.dependencies.spawn(executable, args, {
        windowsHide: true, detached: process.platform !== 'win32', env: environment(),
      })
    } catch (error) {
      return { completion: Promise.reject(new Error(`无法启动 GitHub CLI：${safeMessage((error as Error).message)}`)), stop: async () => {} }
    }
    let finished = false
    let stopping: Promise<void> | undefined
    let failure: Error | undefined
    let stdout = ''
    let stderr = ''
    let bytes = 0
    const outputDecoder = new StringDecoder('utf8')
    const errorDecoder = new StringDecoder('utf8')
    const kill = (): Promise<void> => {
      if (finished) return Promise.resolve()
      if (stopping) return stopping
      stopping = new Promise<void>(resolve => {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
          killer.once('error', () => { child.kill(); resolve() })
          killer.once('close', code => { if (code !== 0) child.kill(); resolve() })
        } else {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
            else child.kill()
          } catch { child.kill() }
          resolve()
        }
      })
      return stopping
    }
    let timer: ReturnType<typeof setTimeout>
    const completion = new Promise<CommandResult>((resolve, reject) => {
      const fail = (message: string) => {
        if (finished || failure) return
        failure = new Error(message)
        void kill()
      }
      timer = setTimeout(() => fail(onOutput ? 'GitHub 登录超时，请重新登录。' : 'GitHub 请求超时，请检查网络后重试。'), timeout)
      const collect = (isError: boolean) => (chunk: Buffer) => {
        if (failure || finished) return
        bytes += chunk.length
        if (bytes > OUTPUT_LIMIT) { fail('GitHub 输出过多，已停止本次操作。'); return }
        const text = (isError ? errorDecoder : outputDecoder).write(chunk)
        if (isError) stderr += text
        else stdout += text
        // Keep chunk boundaries intact while parsing the device code. Only the
        // validated short code is ever returned to the UI; transcripts stay private.
        onOutput?.(text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
      }
      child.stdout.on('data', collect(false))
      child.stderr.on('data', collect(true))
      child.stdin.on('error', () => { /* A rejected API request may close stdin before reading its body. */ })
      child.once('error', error => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        reject(new Error(`无法启动 GitHub CLI：${safeMessage(error.message)}`))
      })
      child.once('close', async code => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        await stopping
        if (failure) { reject(failure); return }
        const result = { stdout: stdout + outputDecoder.end(), stderr: stderr + errorDecoder.end(), code: code ?? -1 }
        if (result.code !== 0) reject(new GitHubCommandError(result))
        else resolve(result)
      })
      child.stdin.end(input ?? '')
    })
    return { completion, stop: async () => { await kill(); await completion.catch(() => {}) } }
  }
}
