import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { GithubService } from '../electron/services/github'

const user = { login: 'example-user', name: 'Example User', id: 12345, html_url: 'https://github.com/example-user' }
const repo = {
  name: 'example', full_name: 'example-user/example', html_url: 'https://github.com/example-user/example',
  clone_url: 'https://github.com/example-user/example.git', ssh_url: 'git@github.com:example-user/example.git',
  private: true, default_branch: 'main',
}
interface Reply { stdout?: string; stderr?: string; code?: number; hold?: boolean }
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = undefined
  killed = false
  input = ''
  constructor() { super(); this.stdin.on('data', chunk => { this.input += chunk.toString() }) }
  kill(): boolean { this.killed = true; queueMicrotask(() => this.emit('close', null)); return true }
  finish(reply: Reply): void {
    if (reply.stdout) this.stdout.write(reply.stdout)
    if (reply.stderr) this.stderr.write(reply.stderr)
    this.emit('close', reply.code ?? 0)
  }
}

function harness(replies: Reply[], options: { loginTimeoutMs?: number; commandTimeoutMs?: number } = {}) {
  const calls: Array<{ executable: string; args: string[]; options: SpawnOptionsWithoutStdio; child: FakeChild }> = []
  const service = new GithubService({
    ...options,
    findExecutable: async () => 'C:\\Program Files\\GitHub CLI\\gh.exe',
    spawn: (executable, args, spawnOptions) => {
      const child = new FakeChild()
      calls.push({ executable, args, options: spawnOptions, child })
      const reply = replies.shift() ?? { stderr: 'Please run gh auth login (HTTP 401)', code: 1 }
      if (!reply.hold) queueMicrotask(() => child.finish(reply))
      return child as unknown as ChildProcessWithoutNullStreams
    },
  })
  return { service, calls }
}

describe('GithubService', () => {
  it('detects the active account without reading an authentication token or private profile fields', async () => {
    const { service, calls } = harness([{ stdout: JSON.stringify(user) }])
    const [first, second] = await Promise.all([service.status(), service.status()])
    expect(first).toEqual({ available: true, state: 'connected', login: user.login, name: user.name, id: user.id, url: user.html_url })
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['api', '--hostname', 'github.com', 'user', '--jq', '{login,name,id,html_url}'])
    expect(calls[0].options).toMatchObject({ windowsHide: true, env: { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } })
    expect(calls[0].options.env).not.toHaveProperty('GH_DEBUG')
    expect(await service.login()).toEqual(first)
    expect(calls).toHaveLength(1)
  })

  it('distinguishes missing CLI, missing login, and network failures', async () => {
    const missing = new GithubService({ findExecutable: async () => { throw new Error('未安装 GitHub CLI。安装后重新检测。') } })
    expect(await missing.status()).toMatchObject({ available: false, state: 'disconnected', message: expect.stringContaining('安装') })
    const { service } = harness([
      { stderr: 'To get started with GitHub CLI, please run: gh auth login', code: 4 },
      { stderr: 'error connecting to api.github.com', code: 1 },
    ])
    expect(await service.status()).toMatchObject({ available: true, state: 'disconnected' })
    expect(await service.status()).toMatchObject({ available: true, state: 'error', message: expect.stringContaining('connecting') })
  })

  it('validates repository names and descriptions before spawning a process', async () => {
    const { service, calls } = harness([])
    for (const name of ['', '..', 'https://evil.example/repo', 'owner/repo', 'test & calc', 'a'.repeat(101)]) {
      await expect(service.createRepository({ name, private: true })).rejects.toThrow('仓库名称')
    }
    await expect(service.createRepository({ name: 'okay', private: true, description: 'a'.repeat(351) })).rejects.toThrow('350')
    await expect(service.createRepository({ name: 'okay', private: 'false' as unknown as boolean })).rejects.toThrow('可见性')
    expect(calls).toHaveLength(0)
  })

  it('creates an empty private repository using structured stdin with literal description content', async () => {
    const { service, calls } = harness([{ stdout: JSON.stringify(repo) }])
    const description = 'Description with "quotes" & $(literal)\n第二行'
    const result = await service.createRepository({ name: ' example ', description, private: true })
    expect(result).toMatchObject({ name: 'example', fullName: 'example-user/example', private: true, cloneUrl: repo.clone_url })
    expect(calls[0].args).toContain('--input')
    expect(calls[0].args).not.toContain(description)
    expect(JSON.parse(calls[0].child.input)).toEqual({ name: 'example', description, private: true, auto_init: false })
    expect(calls[0].options.shell).toBeUndefined()
  })

  it('defaults omitted visibility to private and honors explicitly selected public visibility', async () => {
    const { service, calls } = harness([{ stdout: JSON.stringify(repo) }, { stdout: JSON.stringify({ ...repo, private: false }) }])
    await service.createRepository({ name: 'example' } as { name: string; private: boolean })
    await service.createRepository({ name: 'example', private: false })
    expect(JSON.parse(calls[0].child.input).private).toBe(true)
    expect(JSON.parse(calls[1].child.input).private).toBe(false)
  })

  it('lists at most 100 owned repositories and rejects foreign credential destinations', async () => {
    const { service, calls } = harness([
      { stdout: JSON.stringify([repo]) },
      { stdout: JSON.stringify([{ ...repo, clone_url: 'https://evil.example/repo.git' }]) },
    ])
    expect(await service.repositories()).toHaveLength(1)
    expect(calls[0].args).toContain('user/repos?affiliation=owner&sort=updated&direction=desc&per_page=100')
    await expect(service.repositories()).rejects.toThrow('不受支持')
  })

  it('redacts credentials from API failures and rejects malformed metadata', async () => {
    const token = `ghp_${'a'.repeat(36)}`
    const { service } = harness([
      { stderr: `HTTP 403: Authorization: Bearer ${token}\nhttps://name:secret@github.com/example?token=private`, code: 1 },
      { stdout: '{"login": false}' },
      { stdout: 'invalid JSON' },
    ])
    const state = await service.status()
    expect(state.state).toBe('error')
    expect(state.message).not.toContain(token)
    expect(state.message).not.toContain('secret')
    expect(state.message).not.toContain('private')
    expect((await service.status()).message).toContain('不完整')
    await expect(service.repositories()).rejects.toThrow('无法解析')
  })

  it('returns promptly during device login, handles split output, and updates the account after approval', async () => {
    const { service, calls } = harness([{ hold: true }, { stdout: JSON.stringify(user) }, { stdout: JSON.stringify(user) }])
    const state = await service.login()
    expect(state).toMatchObject({ available: true, state: 'connecting', verificationUri: 'https://github.com/login/device' })
    expect(calls[0].args).toEqual(['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'])
    calls[0].child.stderr.write('! First copy your one-time ')
    calls[0].child.stderr.write('code: AB12-')
    calls[0].child.stderr.write('CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n')
    expect(await service.status()).toMatchObject({ state: 'connecting', deviceCode: 'AB12-CD34' })
    expect(await service.login()).toMatchObject({ state: 'connecting', deviceCode: 'AB12-CD34' })
    expect(calls).toHaveLength(1)
    calls[0].child.finish({ code: 0 })
    await expect.poll(async () => (await service.status()).state).toBe('connected')
    await service.dispose()
  })

  it('deduplicates concurrent device login and cancels only its owned subprocess without logging out', async () => {
    const { service, calls } = harness([{ hold: true }])
    await Promise.all([service.login(), service.login()])
    expect(calls).toHaveLength(1)
    expect(await service.cancelLogin()).toMatchObject({ state: 'disconnected', message: '已取消本次登录。' })
    expect(calls[0].child.killed).toBe(true)
    expect(calls.some(call => call.args.includes('logout'))).toBe(false)
    await service.dispose()
    await expect(service.login()).rejects.toThrow('退出')
  })

  it('bounds login time, preserves the actionable failure, and cleans up on application disposal', async () => {
    const timeout = harness([{ hold: true }], { loginTimeoutMs: 20 })
    await timeout.service.login()
    await expect.poll(() => timeout.calls[0].child.killed).toBe(true)
    expect(await timeout.service.status()).toMatchObject({ state: 'error', message: expect.stringContaining('登录超时') })
    const disposed = harness([{ hold: true }])
    await disposed.service.login()
    await disposed.service.dispose()
    expect(disposed.calls[0].child.killed).toBe(true)
    expect(disposed.calls).toHaveLength(1)
  })
})
