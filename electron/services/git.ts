import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { GitDiff, GitFile, GitIdentity, GitRemote, PushOptions, RemoteConnection, RemoteInput, RepoStatus } from '../../shared/types'

const OUTPUT_LIMIT = 16 * 1024 * 1024
const PREVIEW_LIMIT = 512 * 1024

/** Keep credential-bearing remote URLs out of the UI and persisted command history. */
export function redactGitOutput(value: string): string {
  return value
    .replace(/((?:https?|ssh|git|ftps?):\/\/)([^\s/@]+(?::[^\s/@]*)?)@/gi, (match, protocol: string, credentials: string) =>
      protocol.toLowerCase() === 'ssh://' && !credentials.includes(':') ? match : `${protocol}[已隐藏]@`)
    .replace(/([?&](?:access_token|token|password|auth|key)=)[^\s&#]*/gi, '$1[已隐藏]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[已隐藏]')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

interface GitResult { stdout: Buffer; stderr: Buffer; code: number }

class GitCommandError extends Error {
  constructor(public readonly result: GitResult, fallback: string) {
    const detail = redactGitOutput(Buffer.concat([result.stderr, result.stdout]).toString('utf8')).trim()
    super(detail ? `${fallback}\n${detail.slice(0, 5000)}` : fallback)
  }
}

function runGit(cwd: string, args: string[], allowedCodes = [0], timeout = 60_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env }
    // An app launched from another Git process must not inherit its repository or index.
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete environment[name]
    const child = spawn('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...environment,
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C',
      },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let total = 0
    let finished = false
    let pendingFailure: Error | undefined
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => {
      if (process.platform === 'win32' && child.pid) {
        return new Promise(resolveStop => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => { child.kill(); resolveStop() })
          killer.on('close', code => { if (code !== 0) child.kill(); resolveStop() })
        })
      }
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { child.kill('SIGKILL') }
      return Promise.resolve()
    }
    const fail = (error: Error) => {
      if (finished || pendingFailure) return
      pendingFailure = error
      clearTimeout(timer)
      // Do not release the repository's write lock before its process tree has exited.
      stopping = stop()
    }
    const timer = setTimeout(() => fail(new Error('Git 操作超时，已停止。请检查网络、凭据或 Git hook 后重试。')), timeout)
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (pendingFailure) return
      total += chunk.length
      if (total > OUTPUT_LIMIT) fail(new Error('Git 输出超过 16 MB，请缩小本次操作的范围。'))
      else target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(new Error(error.code === 'ENOENT' ? '找不到 Git 或项目目录，请确认已安装 Git 并检查项目路径。' : `无法启动 Git：${redactGitOutput(error.message)}`))
    })
    child.on('close', async code => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      await stopping
      if (pendingFailure) { reject(pendingFailure); return }
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1 }
      if (!allowedCodes.includes(result.code)) reject(new GitCommandError(result, 'Git 操作失败。'))
      else resolve(result)
    })
  })
}

function normalizeFile(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error('文件路径无效，只能操作当前仓库内的改动文件。')
  }
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').some(part => part === '..' || part === '.' || part === '' || part.toLowerCase() === '.git')) {
    throw new Error('文件路径无效，只能操作当前仓库内的改动文件。')
  }
  return normalized
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function cleanValue(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`请填写有效的${label}。`)
  }
  return value.trim()
}

/** Accept Git's normal transports without allowing command-based remote helpers or URL secrets. */
function remoteUrl(value: unknown, allowExistingCredentials = false): string {
  const url = cleanValue(value, '远程仓库地址', 4096)
  if (url.startsWith('-') || url.includes('::') || url.includes('[已隐藏]')) throw new Error('远程仓库地址无效，请使用 HTTPS、SSH 或本地仓库路径。')
  if (!allowExistingCredentials && /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/.test(url)) {
    throw new Error('请勿将密码或访问令牌放进仓库地址；请使用 GitHub 登录或系统 Git 凭据。')
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('远程仓库地址格式无效。') }
    if (!['https:', 'ssh:', 'file:'].includes(parsed.protocol)) throw new Error('请使用 HTTPS、SSH 或本地仓库路径。')
    if (parsed.protocol !== 'file:' && (!parsed.hostname || parsed.pathname.length < 2)) throw new Error('请填写包含仓库路径的完整地址。')
    if (!allowExistingCredentials && (parsed.password || (parsed.protocol !== 'ssh:' && parsed.username) || parsed.search || parsed.hash)) {
      throw new Error('请勿将密码或访问令牌放进仓库地址；请使用 GitHub 登录或系统 Git 凭据。')
    }
    return url
  }
  if (path.isAbsolute(url) || path.win32.isAbsolute(url) || !url.includes(':')) return url
  // SCP-style SSH addresses, e.g. git@github.com:owner/repo.git. No shell is used.
  if (/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+:[^\s:]+$/.test(url)) return url
  throw new Error('远程仓库地址无效，请使用 HTTPS、SSH 或本地仓库路径。')
}

async function remoteName(root: string, value: unknown): Promise<string> {
  const name = cleanValue(value, '远程名称', 100)
  if (name.startsWith('-') || /\s/.test(name)) throw new Error('远程名称无效，请使用 origin 等名称。')
  try { await runGit(root, ['check-ref-format', `refs/remotes/${name}/devdock-check`]) }
  catch { throw new Error('远程名称无效，请使用 origin 等名称。') }
  return name
}

async function safeFile(root: string, filename: string): Promise<string> {
  const target = path.resolve(root, normalizeFile(filename))
  if (!isInside(root, target)) throw new Error('不允许读取仓库外的文件。')
  // A tracked path can be replaced by a directory symlink after checkout. Do not follow it.
  let ancestor = path.dirname(target)
  while (isInside(root, ancestor)) {
    try {
      const actual = await realpath(ancestor)
      if (!isInside(root, actual)) throw new Error('该文件经过指向仓库外的链接，无法预览或暂存。')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (ancestor === root) throw error
      ancestor = path.dirname(ancestor)
    }
  }
  return target
}

function splitFields(record: string, count: number): string[] {
  const values: string[] = []
  let start = 0
  for (let index = 0; index < count; index++) {
    const end = record.indexOf(' ', start)
    if (end === -1) return []
    values.push(record.slice(start, end))
    start = end + 1
  }
  values.push(record.slice(start))
  return values
}

function parseStatus(output: Buffer): Pick<RepoStatus, 'head' | 'branch' | 'upstream' | 'ahead' | 'behind' | 'files'> {
  const records = output.toString('utf8').split('\0')
  let head: string | null = null
  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFile[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.startsWith('# branch.oid ')) head = record.slice(13) === '(initial)' ? null : record.slice(13)
    else if (record.startsWith('# branch.head ')) branch = record.slice(14)
    else if (record.startsWith('# branch.upstream ')) upstream = record.slice(18)
    else if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+) -(\d+)/)
      if (match) { ahead = Number(match[1]); behind = Number(match[2]) }
    } else if (record.startsWith('? ')) {
      files.push({ path: record.slice(2).replace(/\/$/, ''), indexStatus: '?', worktreeStatus: '?', untracked: true, conflicted: false })
    } else if (/^[12u] /.test(record)) {
      const kind = record[0]
      const fields = splitFields(record, kind === '1' ? 8 : kind === '2' ? 9 : 10)
      if (!fields.length) continue
      const xy = fields[1].replace(/\./g, ' ')
      const originalPath = kind === '2' ? records[++index] : undefined
      files.push({ path: fields.at(-1)!, ...(originalPath ? { originalPath } : {}), indexStatus: xy[0], worktreeStatus: xy[1], untracked: false, conflicted: kind === 'u' })
    }
  }
  return { head, branch, upstream, ahead, behind, files }
}

export class GitService {
  private readonly writing = new Set<string>()

  private async root(cwd: string): Promise<string> {
    const result = await runGit(cwd, ['rev-parse', '--show-toplevel'])
    return realpath(result.stdout.toString('utf8').trim())
  }

  private async fingerprint(root: string, raw: Buffer, files: GitFile[]): Promise<string> {
    // Fetch/push can change ahead/behind without changing the code tested by the user.
    const relevant = raw.toString('utf8').split('\0').filter(record => !record.startsWith('# branch.ab ') && !record.startsWith('# branch.upstream ')).join('\0')
    const hash = createHash('sha256').update(relevant)
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(`\0${file.path}\0`)
      const absolute = await safeFile(root, file.path)
      try {
        const info = await lstat(absolute)
        if (info.isSymbolicLink()) hash.update(`link:${await readlink(absolute)}`)
        else if (info.isFile()) {
          // Hash bytes, not just git status: M -> M must still invalidate a previous test.
          const content = createHash('sha256')
          for await (const chunk of createReadStream(absolute)) content.update(chunk as Buffer)
          hash.update(content.digest())
        } else if (info.isDirectory()) {
          // Dirty submodules are represented as one directory by their parent repository.
          const nestedRoot = await this.root(absolute).catch(() => null)
          if (nestedRoot && path.relative(absolute, nestedRoot) === '') {
            const nestedStatus = await runGit(absolute, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'])
            hash.update(await this.fingerprint(absolute, nestedStatus.stdout, parseStatus(nestedStatus.stdout).files))
          } else hash.update(`directory:${info.mtimeMs}`)
        }
        else hash.update('special-file')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted')
        else throw error
      }
    }
    return hash.digest('hex')
  }

  async status(cwd: string): Promise<RepoStatus> {
    const empty: RepoStatus = { isRepo: false, root: cwd, branch: '', head: null, files: [], upstream: null, ahead: 0, behind: 0, remotes: [], fingerprint: '', mergeInProgress: false }
    try {
      const root = await this.root(cwd)
      const [statusResult, remoteResult, mergePath] = await Promise.all([
        runGit(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']),
        runGit(root, ['remote', '-v']),
        runGit(root, ['rev-parse', '--git-path', 'MERGE_HEAD']),
      ])
      const parsed = parseStatus(statusResult.stdout)
      const remoteMap = new Map<string, GitRemote>()
      for (const line of remoteResult.stdout.toString('utf8').split(/\r?\n/)) {
        const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/)
        if (!match) continue
        const [, name, rawUrl, direction] = match
        const url = redactGitOutput(rawUrl)
        const existing = remoteMap.get(name) ?? { name, url }
        if (direction === 'fetch') existing.url = url
        else if (url !== existing.url) existing.pushUrl = url
        if (url !== rawUrl) existing.urlRedacted = true
        remoteMap.set(name, existing)
      }
      const remotes = [...remoteMap.values()]
      const mergeInProgress = await stat(path.resolve(root, mergePath.stdout.toString('utf8').trim())).then(() => true, () => false)
      const fingerprint = await this.fingerprint(root, statusResult.stdout, parsed.files)
      return { isRepo: true, root, ...parsed, remotes, fingerprint, mergeInProgress }
    } catch (error) {
      const message = (error as Error).message
      return { ...empty, error: message.includes('not a git repository') ? '此目录尚未初始化为 Git 仓库。' : message }
    }
  }

  private async requireStatus(cwd: string): Promise<RepoStatus> {
    const status = await this.status(cwd)
    if (!status.isRepo) throw new Error(status.error || '此目录不是 Git 仓库。')
    return status
  }

  private async write<T>(cwd: string, operation: (root: string) => Promise<T>): Promise<T> {
    const root = await this.root(cwd)
    return this.withLock(root, operation)
  }

  private async withLock<T>(root: string, operation: (root: string) => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (this.writing.has(key)) throw new Error('这个仓库正在执行另一个 Git 操作，请等待它完成。')
    this.writing.add(key)
    try { return await operation(root) } finally { this.writing.delete(key) }
  }

  async initialize(cwd: string, branch = 'main'): Promise<RepoStatus> {
    const directory = await realpath(cleanValue(cwd, '项目目录', 32768))
    if (!(await stat(directory)).isDirectory()) throw new Error('请选择一个已经存在的项目文件夹。')
    const initialBranch = cleanValue(branch, '初始分支名称', 200)
    if (initialBranch.startsWith('-')) throw new Error('初始分支名称无效。')
    try { await runGit(directory, ['check-ref-format', '--branch', initialBranch]) }
    catch { throw new Error('初始分支名称无效。') }
    return this.withLock(directory, async root => {
      const probe = await runGit(root, ['rev-parse', '--is-bare-repository'], [0, 128])
      if (probe.code === 0) {
        if (probe.stdout.toString('utf8').trim() === 'true') throw new Error('这是一个裸仓库，请选择有工作文件的项目目录。')
        const existingRoot = await this.root(root)
        if (path.relative(root, existingRoot) !== '') throw new Error('这个文件夹属于上层 Git 仓库，请选择该仓库根目录，避免误建嵌套仓库。')
        return this.requireStatus(root)
      }
      if (!probe.stderr.toString('utf8').includes('not a git repository')) throw new GitCommandError(probe, '无法检查项目仓库。')
      await runGit(root, ['init', '--initial-branch', initialBranch, '--', '.'])
      return this.requireStatus(root)
    })
  }

  async identity(cwd: string): Promise<GitIdentity> {
    const root = await this.root(cwd)
    const read = async (key: string, local: boolean) => (await runGit(root, ['config', ...(local ? ['--local'] : []), '--get', key], [0, 1])).stdout.toString('utf8').trim()
    const [name, email, localName, localEmail] = await Promise.all([
      read('user.name', false), read('user.email', false), read('user.name', true), read('user.email', true),
    ])
    return { name, email, localName, localEmail }
  }

  async saveIdentity(cwd: string, input: { name: string; email: string }): Promise<GitIdentity> {
    const name = cleanValue(input?.name, '提交者姓名', 200)
    const email = cleanValue(input?.email, '提交者邮箱', 320)
    if (/[<>]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw new Error('请填写有效的提交者姓名和邮箱，例如 name@example.com。')
    return this.write(cwd, async root => {
      await runGit(root, ['config', '--local', '--replace-all', 'user.name', name])
      await runGit(root, ['config', '--local', '--replace-all', 'user.email', email])
      return this.identity(root)
    })
  }

  async saveRemote(cwd: string, input: RemoteInput): Promise<RepoStatus> {
    const url = remoteUrl(input?.url)
    return this.write(cwd, async root => {
      const name = await remoteName(root, input?.name)
      const before = await this.requireStatus(root)
      if (input.originalName === undefined) {
        if (before.remotes.some(remote => remote.name === name)) throw new Error('这个远程名称已经存在，请编辑已有远程或换一个名称。')
        await runGit(root, ['remote', 'add', '--', name, url])
      } else {
        const original = await remoteName(root, input.originalName)
        if (!before.remotes.some(remote => remote.name === original)) throw new Error('要编辑的远程仓库已不存在，请刷新后重试。')
        if (name !== original && before.remotes.some(remote => remote.name === name)) throw new Error('这个远程名称已经存在，不能覆盖另一个远程。')
        if (name !== original) await runGit(root, ['remote', 'rename', '--', original, name])
        try { await runGit(root, ['remote', 'set-url', '--', name, url]) }
        catch (error) {
          if (name !== original) await runGit(root, ['remote', 'rename', '--', name, original]).catch(() => {})
          throw error
        }
      }
      return this.requireStatus(root)
    })
  }

  async removeRemote(cwd: string, name: string): Promise<RepoStatus> {
    return this.write(cwd, async root => {
      const remote = await remoteName(root, name)
      if (!(await this.requireStatus(root)).remotes.some(item => item.name === remote)) throw new Error('这个远程仓库已不存在，请刷新后重试。')
      await runGit(root, ['remote', 'remove', '--', remote])
      return this.requireStatus(root)
    })
  }

  async testRemote(cwd: string, name: string): Promise<RemoteConnection> {
    const root = await this.root(cwd)
    const remote = await remoteName(root, name)
    const status = await this.requireStatus(root)
    const selected = status.remotes.find(item => item.name === remote)
    if (!selected) throw new Error('请选择当前项目已经保存的远程仓库。')
    // Resolve the actual URL (including insteadOf rules), but expose only its redacted display form.
    const rawUrl = (await runGit(root, ['remote', 'get-url', '--', remote])).stdout.toString('utf8').trim()
    remoteUrl(rawUrl, true)
    try {
      const result = await runGit(root, ['ls-remote', '--symref', '--', remote], [0], 30_000)
      const lines = result.stdout.toString('utf8').split(/\r?\n/)
      const defaultBranch = lines.map(line => line.match(/^ref: refs\/heads\/(.+)\tHEAD$/)?.[1]).find(Boolean)
      const heads = lines.filter(line => /^[0-9a-f]+\trefs\/heads\//i.test(line)).length
      return { name: remote, url: selected.url, reachable: true, ...(defaultBranch ? { defaultBranch } : {}), heads, message: heads ? `连接成功，读取到 ${heads} 个远程分支。此检查验证读取权限，写入权限会在 Push 时验证。` : '连接成功，这是一个空仓库。写入权限会在 Push 时验证。' }
    } catch (error) {
      return { name: remote, url: selected.url, reachable: false, heads: 0, message: `${redactGitOutput((error as Error).message)}\n请检查仓库地址、网络、GitHub 登录或 SSH 密钥。` }
    }
  }

  async setGitHubCredentialHelper(cwd: string, executablePath: string): Promise<void> {
    const executable = cleanValue(executablePath, 'GitHub CLI 路径', 32768)
    if (!path.isAbsolute(executable) || !(await stat(executable)).isFile()) throw new Error('GitHub CLI 路径无效，请重新检测登录状态。')
    // Git invokes ! helpers through its POSIX shell, including on Windows. Quote a literal path.
    const quoted = `'${executable.replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`
    return this.write(cwd, async root => {
      const key = 'credential.https://github.com.helper'
      await runGit(root, ['config', '--local', '--replace-all', key, ''])
      await runGit(root, ['config', '--local', '--add', key, `!${quoted} auth git-credential`])
    })
  }

  async diff(cwd: string, requestedPath: string, staged: boolean): Promise<GitDiff> {
    const requested = normalizeFile(requestedPath)
    const status = await this.requireStatus(cwd)
    const file = status.files.find(item => item.path === requested)
    if (!file) throw new Error('这个文件不在当前改动列表中，请刷新后重试。')
    const absolute = await safeFile(status.root, requested)
    if (file.untracked) {
      if (staged) return { path: requested, text: '这个文件尚未暂存。', binary: false, staged }
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) return { path: requested, text: `新增符号链接 → ${await readlink(absolute)}`, binary: false, staged }
      if (!info.isFile()) return { path: requested, text: '这是一个目录或特殊文件，无法显示文本预览。', binary: false, staged }
      const handle = await open(absolute, 'r')
      let data: Buffer
      try {
        const buffer = Buffer.alloc(Math.min(info.size, PREVIEW_LIMIT))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        data = buffer.subarray(0, bytesRead)
      } finally { await handle.close() }
      const binary = data.includes(0)
      const text = binary ? '二进制文件，无法显示文本差异。' : `--- /dev/null\n+++ b/${requested}\n${data.toString('utf8').split('\n').map(line => `+${line}`).join('\n')}${info.size > PREVIEW_LIMIT ? '\n\n[文件较大，仅显示前 512 KB]' : ''}`
      return { path: requested, text, binary, staged }
    }
    const paths = [file.path, ...(file.originalPath ? [file.originalPath] : [])]
    const result = await runGit(status.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(staged ? ['--cached'] : []), '--', ...paths])
    const text = result.stdout.toString('utf8')
    return { path: requested, text: text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n[差异较大，预览已截断]` : text, binary: /^Binary files /m.test(text), staged }
  }

  async stage(cwd: string, paths: string[], staged: boolean): Promise<RepoStatus> {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('请先选择要操作的文件。')
    const selected = [...new Set(paths.map(normalizeFile))]
    return this.write(cwd, async root => {
      const before = await this.requireStatus(root)
      const pathspecs: string[] = []
      for (const filename of selected) {
        const file = before.files.find(item => item.path === filename)
        if (!file) throw new Error('选中的文件已不在改动列表，请刷新后重试。')
        await safeFile(root, filename)
        pathspecs.push(filename)
        if (!staged && file.originalPath) pathspecs.push(file.originalPath)
      }
      if (staged) await runGit(root, ['add', '--', ...pathspecs])
      else if (before.head) await runGit(root, ['reset', '--quiet', 'HEAD', '--', ...pathspecs])
      else await runGit(root, ['rm', '--cached', '--force', '--ignore-unmatch', '--', ...pathspecs])
      return this.requireStatus(root)
    })
  }

  async commit(cwd: string, message: string, expectedFingerprint: string): Promise<string> {
    if (typeof message !== 'string' || !message.trim() || message.includes('\0')) throw new Error('请填写有效的提交说明。')
    if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) throw new Error('请先刷新并审阅改动后再提交。')
    return this.write(cwd, async root => {
      const before = await this.requireStatus(root)
      if (before.fingerprint !== expectedFingerprint) throw new Error('代码或暂存内容已变化，请刷新、重新审阅后再提交。')
      if (before.files.some(file => file.conflicted)) throw new Error('仓库存在尚未解决的冲突，请先解决冲突并暂存。')
      if (!before.mergeInProgress && !before.files.some(file => file.indexStatus !== ' ' && file.indexStatus !== '?')) throw new Error('没有已暂存的改动，请先选择文件并暂存。')
      const result = await runGit(root, ['commit', '-m', message.trim()])
      return redactGitOutput(Buffer.concat([result.stdout, result.stderr]).toString('utf8')).trim()
    })
  }

  async push(cwd: string, options: PushOptions = {}): Promise<string> {
    return this.write(cwd, async root => {
      const status = await this.requireStatus(root)
      if (!status.head) throw new Error('请先创建一次本地提交，再推送到远程仓库。')
      if (status.branch === '(detached)' || !status.branch) throw new Error('当前处于游离 HEAD 状态，请先切换到一个分支。')
      if (options.remote !== undefined && (typeof options.remote !== 'string' || !status.remotes.some(item => item.name === options.remote))) throw new Error('请选择当前仓库已配置的远程仓库。')
      const readConfig = async (key: string) => (await runGit(root, ['config', '--get', key], [0, 1])).stdout.toString('utf8').trim()
      const configuredRemote = await readConfig(`branch.${status.branch}.remote`)
      const configuredMerge = await readConfig(`branch.${status.branch}.merge`)
      const remote = options.remote ?? configuredRemote
      if (!remote || remote.startsWith('-') || remote.includes('\0') || !status.remotes.some(item => item.name === remote)) throw new Error('尚未配置有效的上游，请先选择远程仓库和目标分支。')
      const targetBranch = options.branch ?? (options.remote || options.setUpstream ? status.branch : configuredMerge.replace(/^refs\/heads\//, ''))
      if (typeof targetBranch !== 'string' || !targetBranch || targetBranch.startsWith('-') || targetBranch.includes('\0')) throw new Error('请输入有效的目标分支名称。')
      try { await runGit(root, ['check-ref-format', '--branch', targetBranch]) } catch { throw new Error('目标分支名称无效。') }
      const result = await runGit(root, ['push', '--porcelain', ...(options.setUpstream ? ['--set-upstream'] : []), remote, `HEAD:refs/heads/${targetBranch}`])
      return redactGitOutput(Buffer.concat([result.stdout, result.stderr]).toString('utf8')).trim()
    })
  }

  async fetch(cwd: string): Promise<string> {
    return this.write(cwd, async root => {
      const status = await this.requireStatus(root)
      if (!status.remotes.length) throw new Error('此项目尚未配置远程仓库。')
      const result = await runGit(root, ['fetch', '--all'])
      return redactGitOutput(Buffer.concat([result.stdout, result.stderr]).toString('utf8')).trim() || '已更新远程状态。'
    })
  }
}
