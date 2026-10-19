import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../electron/services/git'
import { removeTestDirectory } from './temp-cleanup'

const execute = promisify(execFile)
const directories: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } })).stdout.trim()
}

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devdock-setup-'))
  directories.push(root)
  return root
}

async function repository(): Promise<{ root: string; service: GitService }> {
  const root = await directory()
  const service = new GitService()
  await service.initialize(root)
  await service.saveIdentity(root, { name: 'DevDock Setup Test', email: 'setup@example.invalid' })
  await git(root, 'config', 'commit.gpgsign', 'false')
  await git(root, 'config', 'core.hooksPath', path.join(root, 'no-hooks'))
  await git(root, 'config', 'core.autocrlf', 'false')
  return { root, service }
}

async function commit(root: string, service: GitService): Promise<string> {
  await writeFile(path.join(root, 'hello.txt'), 'hello from setup\n')
  const staged = await service.stage(root, ['hello.txt'], true)
  await service.commit(root, 'first setup commit', staged.fingerprint)
  return git(root, 'rev-parse', 'HEAD')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory))
})

describe('Git repository setup', () => {
  it('initializes an existing folder without rewriting files or an existing branch', async () => {
    const root = await directory()
    const service = new GitService()
    await writeFile(path.join(root, 'work.txt'), 'keep this work')
    const initialized = await service.initialize(root, 'feature/first')
    expect(initialized).toMatchObject({ isRepo: true, branch: 'feature/first', head: null })
    expect(initialized.files.map(file => file.path)).toContain('work.txt')
    expect((await service.initialize(root, 'main')).branch).toBe('feature/first')
    expect(await readFile(path.join(root, 'work.txt'), 'utf8')).toBe('keep this work')
    await expect(service.initialize(root, '--help')).rejects.toThrow('分支')
    await expect(service.initialize(path.join(root, 'missing'))).rejects.toThrow()
    await expect(service.initialize(path.join(root, 'work.txt'))).rejects.toThrow('文件夹')
  })

  it('refuses to create nested repositories or initialize bare repositories', async () => {
    const { root, service } = await repository()
    const child = path.join(root, 'src')
    await mkdir(child)
    await expect(service.initialize(child)).rejects.toThrow('上层 Git 仓库')
    expect(await stat(path.join(child, '.git')).then(() => true, () => false)).toBe(false)
    const bare = await directory()
    await git(bare, 'init', '--bare', '-b', 'main')
    await expect(service.initialize(bare)).rejects.toThrow('裸仓库')
  })

  it('sets repository-local commit identity and rejects malformed values before changing it', async () => {
    const { root, service } = await repository()
    const globalBefore = await git(root, 'config', '--global', '--list')
    expect(await service.saveIdentity(root, { name: '开发者 Actor', email: '123+actor@users.noreply.github.com' }))
      .toEqual({ name: '开发者 Actor', email: '123+actor@users.noreply.github.com', localName: '开发者 Actor', localEmail: '123+actor@users.noreply.github.com' })
    await expect(service.saveIdentity(root, { name: 'Wrong\nName', email: 'a@example.com' })).rejects.toThrow('姓名')
    await expect(service.saveIdentity(root, { name: 'Wrong', email: 'not-an-email' })).rejects.toThrow('邮箱')
    expect((await service.identity(root)).name).toBe('开发者 Actor')
    const head = await commit(root, service)
    expect(await git(root, 'show', '-s', '--format=%an <%ae>', head)).toBe('开发者 Actor <123+actor@users.noreply.github.com>')
    expect(await git(root, 'config', '--global', '--list')).toBe(globalBefore)
  })

  it('adds and tests a remote, pushes a real commit, renames it with upstream, and removes only the connection', async () => {
    const { root, service } = await repository()
    const remoteParent = await directory()
    const remote = path.join(remoteParent, '中文 remote.git')
    await mkdir(remote)
    await git(remote, 'init', '--bare', '-b', 'main')
    expect((await service.saveRemote(root, { name: 'origin', url: remote })).remotes).toEqual([{ name: 'origin', url: remote }])
    expect(await service.testRemote(root, 'origin')).toMatchObject({ name: 'origin', reachable: true, heads: 0 })
    const head = await commit(root, service)
    await service.push(root, { remote: 'origin', branch: 'main', setUpstream: true })
    expect(await service.testRemote(root, 'origin')).toMatchObject({ reachable: true, heads: 1, defaultBranch: 'main' })
    const renamed = await service.saveRemote(root, { originalName: 'origin', name: 'upstream', url: remote })
    expect(renamed.remotes.map(item => item.name)).toEqual(['upstream'])
    expect(renamed.upstream).toBe('upstream/main')
    await service.fetch(root)
    await service.push(root)
    const removed = await service.removeRemote(root, 'upstream')
    expect(removed.remotes).toEqual([])
    expect(removed.head).toBe(head)
    expect(await git(remote, 'rev-parse', 'main')).toBe(head)
    expect(await readFile(path.join(root, 'hello.txt'), 'utf8')).toBe('hello from setup\n')
    await expect(service.testRemote(root, 'upstream')).rejects.toThrow('保存')
  })

  it('does not overwrite existing remotes or a separate push URL when editing the fetch URL', async () => {
    const { root, service } = await repository()
    await service.saveRemote(root, { name: 'origin', url: 'https://github.com/example/fetch.git' })
    await service.saveRemote(root, { name: 'backup', url: 'git@github.com:example/backup.git' })
    await git(root, 'remote', 'set-url', '--push', 'origin', 'ssh://git@github.com/example/push.git')
    const before = (await service.status(root)).remotes.find(remote => remote.name === 'origin')
    expect(before).toMatchObject({ url: 'https://github.com/example/fetch.git', pushUrl: 'ssh://git@github.com/example/push.git' })
    expect(before?.urlRedacted).not.toBe(true)
    await expect(service.saveRemote(root, { name: 'origin', url: 'https://github.com/example/other.git' })).rejects.toThrow('已经存在')
    await expect(service.saveRemote(root, { originalName: 'origin', name: 'backup', url: 'https://github.com/example/other.git' })).rejects.toThrow('覆盖')
    await expect(service.saveRemote(root, { originalName: 'absent', name: 'new', url: 'https://github.com/example/other.git' })).rejects.toThrow('不存在')
    const after = (await service.saveRemote(root, { originalName: 'origin', name: 'origin', url: 'https://github.com/example/new.git' })).remotes.find(remote => remote.name === 'origin')
    expect(after).toMatchObject({ url: 'https://github.com/example/new.git', pushUrl: before?.pushUrl })
  })

  it('rejects executable transports, options, controls, embedded credentials and redacted placeholders', async () => {
    const { root, service } = await repository()
    for (const url of ['ext::sh -c bad', 'http://github.com/x/y.git', 'https://user:password@github.com/x/y.git', 'https://secret@github.com/x/y.git', 'https://github.com/x/y.git?access_token=secret', 'ssh://git:secret@github.com/x/y.git', 'https://[已隐藏]@github.com/x/y.git', '--upload-pack=bad', 'good\nurl']) {
      await expect(service.saveRemote(root, { name: 'origin', url })).rejects.toThrow()
    }
    for (const name of ['--bad', '../bad', 'bad name', 'bad\nname', 'bad.lock']) {
      await expect(service.saveRemote(root, { name, url: 'https://github.com/x/y.git' })).rejects.toThrow('名称')
    }
    expect((await service.status(root)).remotes).toEqual([])
    await git(root, 'remote', 'add', 'credentials', 'https://username:TEST-ONLY@example.invalid/repo.git')
    const display = (await service.status(root)).remotes[0]
    expect(display.urlRedacted).toBe(true)
    expect(display.url).not.toContain('TEST-ONLY')
    await expect(service.saveRemote(root, { originalName: 'credentials', name: 'credentials', url: display.url })).rejects.toThrow()
    await git(root, 'remote', 'add', 'unsafe', 'ext::this-must-not-execute')
    await expect(service.testRemote(root, 'unsafe')).rejects.toThrow('地址')
  })

  it('reports a real failed connection as a failed result without claiming write access', async () => {
    const { root, service } = await repository()
    await service.saveRemote(root, { name: 'missing', url: path.join(root, 'does-not-exist.git') })
    const result = await service.testRemote(root, 'missing')
    expect(result.reachable).toBe(false)
    expect(result.heads).toBe(0)
    expect(result.message).toContain('请检查')
  })

  it('configures the GitHub helper only for this repository and safely quotes executable paths', async () => {
    const { root, service } = await repository()
    const globalBefore = await git(root, 'config', '--global', '--list')
    const folder = path.join(root, "tools with space ' quote")
    await mkdir(folder)
    const executable = path.join(folder, 'gh.exe')
    await writeFile(executable, 'test-only placeholder')
    await git(root, 'config', '--local', 'credential.helper', 'manager')
    await service.setGitHubCredentialHelper(root, executable)
    expect(await git(root, 'config', '--local', '--get', 'credential.helper')).toBe('manager')
    const configured = await git(root, 'config', '--local', '--get-all', 'credential.https://github.com.helper')
    expect(configured).toContain('auth git-credential')
    expect(configured).toContain(`'"'"'`)
    expect(await git(root, 'config', '--global', '--list')).toBe(globalBefore)
    await expect(service.setGitHubCredentialHelper(root, 'gh')).rejects.toThrow('路径')
  })
})
