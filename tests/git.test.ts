import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService, redactGitOutput } from '../electron/services/git'
import { removeTestDirectory } from './temp-cleanup'

const execute = promisify(execFile)
const temporaryDirectories: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } })).stdout.trim()
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devdock-git-'))
  temporaryDirectories.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'DevDock Test')
  await git(root, 'config', 'user.email', 'devdock-test@example.invalid')
  await git(root, 'config', 'commit.gpgsign', 'false')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'core.hooksPath', path.join(root, 'no-hooks'))
  return root
}

async function initialCommit(root: string): Promise<void> {
  await writeFile(path.join(root, 'base.txt'), 'original\n')
  await git(root, 'add', '--', 'base.txt')
  await git(root, 'commit', '-m', 'initial')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe('GitService real repositories', () => {
  it('reports non-repositories and unborn branches without pretending they are clean repos', async () => {
    const service = new GitService()
    const root = await repository()
    const status = await service.status(root)
    expect(status).toMatchObject({ isRepo: true, head: null, branch: 'main', files: [], upstream: null })
    const empty = await mkdtemp(path.join(os.tmpdir(), 'devdock-not-git-'))
    temporaryDirectories.push(empty)
    expect(await service.status(empty)).toMatchObject({ isRepo: false })
  })

  it('stages and unstages Chinese/spaced/literal-pathspec filenames in an unborn repository', async () => {
    const root = await repository()
    const service = new GitService()
    const filename = '中文 文件 [1].txt'
    await writeFile(path.join(root, filename), 'hello 世界\n')
    await writeFile(path.join(root, '中文 文件 1.txt'), 'must stay untracked\n')
    const staged = await service.stage(root, [filename], true)
    expect(staged.files.find(file => file.path === filename)).toMatchObject({ indexStatus: 'A', worktreeStatus: ' ', untracked: false })
    expect(staged.files.find(file => file.path === '中文 文件 1.txt')?.untracked).toBe(true)
    const unstaged = await service.stage(root, [filename], false)
    expect(unstaged.files.find(file => file.path === filename)?.untracked).toBe(true)
    expect(await readFile(path.join(root, filename), 'utf8')).toBe('hello 世界\n')
  })

  it('preserves existing staged files, commits only the index, and handles a literal multiline message', async () => {
    const root = await repository()
    await initialCommit(root)
    const service = new GitService()
    await writeFile(path.join(root, 'already.txt'), 'existing staged content\n')
    await git(root, 'add', 'already.txt')
    await writeFile(path.join(root, '中文 文件.txt'), 'first version\n')
    await writeFile(path.join(root, 'stay.txt'), 'untracked\n')
    await service.stage(root, ['中文 文件.txt'], true)
    await writeFile(path.join(root, '中文 文件.txt'), 'later working tree version\n')
    const before = await service.status(root)
    expect(before.files.find(file => file.path === 'already.txt')?.indexStatus).toBe('A')
    const message = 'feat: literal $(echo no) `command` & text\n\n第二行说明'
    await service.commit(root, message, before.fingerprint)
    expect(await git(root, 'log', '-1', '--format=%B')).toBe(message)
    expect(await git(root, 'show', 'HEAD:中文 文件.txt')).toBe('first version')
    expect(await git(root, 'show', 'HEAD:already.txt')).toBe('existing staged content')
    const after = await service.status(root)
    expect(after.files.find(file => file.path === '中文 文件.txt')).toMatchObject({ indexStatus: ' ', worktreeStatus: 'M' })
    expect(after.files.find(file => file.path === 'stay.txt')?.untracked).toBe(true)
    expect(after.head).not.toBe(before.head)
  })

  it('changes fingerprint on content edits while porcelain status stays the same and ignores ignored files', async () => {
    const root = await repository()
    await initialCommit(root)
    const service = new GitService()
    await writeFile(path.join(root, '.gitignore'), 'ignored.log\n')
    await writeFile(path.join(root, 'base.txt'), 'changed A\n')
    await service.stage(root, ['base.txt'], true)
    await writeFile(path.join(root, 'base.txt'), 'changed B\n')
    const first = await service.status(root)
    await writeFile(path.join(root, 'base.txt'), 'changed C\n')
    const second = await service.status(root)
    expect(second.files).toEqual(first.files)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    await expect(service.commit(root, 'should reject stale content', first.fingerprint)).rejects.toThrow('已变化')
    await writeFile(path.join(root, 'ignored.log'), 'irrelevant changed bytes')
    expect((await service.status(root)).fingerprint).toBe(second.fingerprint)
  })

  it('tracks dirty submodule contents when their parent status remains unchanged', async () => {
    const root = await repository()
    const nested = await repository()
    await initialCommit(root)
    await initialCommit(nested)
    await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', nested, 'deps/library')
    await git(root, 'commit', '-m', 'add test submodule')
    const service = new GitService()
    await writeFile(path.join(root, 'deps', 'library', 'base.txt'), 'submodule one\n')
    const first = await service.status(root)
    await writeFile(path.join(root, 'deps', 'library', 'base.txt'), 'submodule two\n')
    const second = await service.status(root)
    expect(first.files).toEqual(second.files)
    expect(first.fingerprint).not.toBe(second.fingerprint)
  }, 15_000)

  it('previews untracked, binary, deleted and staged files and blocks outside/clean paths', async () => {
    const root = await repository()
    await initialCommit(root)
    const service = new GitService()
    await writeFile(path.join(root, 'new.txt'), 'new preview\n')
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    expect((await service.diff(root, 'new.txt', false)).text).toContain('+new preview')
    expect((await service.diff(root, 'binary.bin', false)).binary).toBe(true)
    await expect(service.diff(root, '../private.txt', false)).rejects.toThrow('路径')
    await expect(service.diff(root, path.join(root, 'new.txt'), false)).rejects.toThrow('路径')
    await expect(service.diff(root, 'base.txt', false)).rejects.toThrow('改动列表')
    await expect(service.stage(root, ['../private.txt'], true)).rejects.toThrow('路径')
    await rm(path.join(root, 'base.txt'))
    expect((await service.diff(root, 'base.txt', false)).text).toContain('-original')
    await service.stage(root, ['base.txt'], true)
    expect((await service.diff(root, 'base.txt', true)).text).toContain('deleted file')
  })

  it('parses staged renames and unstages both sides while retaining working files', async () => {
    const root = await repository()
    await initialCommit(root)
    const service = new GitService()
    await git(root, 'mv', 'base.txt', '重新 命名.txt')
    const status = await service.status(root)
    expect(status.files).toContainEqual(expect.objectContaining({ path: '重新 命名.txt', originalPath: 'base.txt', indexStatus: 'R' }))
    expect((await service.diff(root, '重新 命名.txt', true)).text).toContain('rename')
    const unstaged = await service.stage(root, ['重新 命名.txt'], false)
    expect(unstaged.files.every(file => file.indexStatus === ' ' || file.untracked)).toBe(true)
    expect(await readFile(path.join(root, '重新 命名.txt'), 'utf8')).toBe('original\n')
  })

  it('rejects empty/unstaged commits and detects merge conflicts', async () => {
    const root = await repository()
    await initialCommit(root)
    const service = new GitService()
    await expect(service.commit(root, '   ', 'anything')).rejects.toThrow('提交说明')
    await expect(service.commit(root, 'empty', (await service.status(root)).fingerprint)).rejects.toThrow('已暂存')
    await git(root, 'checkout', '-b', 'other')
    await writeFile(path.join(root, 'base.txt'), 'other branch\n')
    await git(root, 'commit', '-am', 'other')
    await git(root, 'checkout', 'main')
    await writeFile(path.join(root, 'base.txt'), 'main branch\n')
    await git(root, 'commit', '-am', 'main')
    await git(root, 'merge', 'other').catch(() => {})
    const status = await service.status(root)
    expect(status.mergeInProgress).toBe(true)
    expect(status.files.some(file => file.conflicted)).toBe(true)
    await expect(service.commit(root, 'conflicted', status.fingerprint)).rejects.toThrow('冲突')
  })

  it('rejects concurrent writes until a commit hook has actually finished', async () => {
    const root = await repository()
    await initialCommit(root)
    const service = new GitService()
    await writeFile(path.join(root, 'base.txt'), 'pending commit\n')
    await writeFile(path.join(root, 'next.txt'), 'next operation\n')
    const staged = await service.stage(root, ['base.txt'], true)
    await git(root, 'config', 'core.hooksPath', '.git/hooks')
    await writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n: > .git/devdock-hook-running\nsleep 1\n', { mode: 0o755 })
    const committing = service.commit(root, 'slow hook', staged.fingerprint)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await stat(path.join(root, '.git', 'devdock-hook-running')).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await expect(service.stage(root, ['next.txt'], true)).rejects.toThrow('另一个 Git 操作')
    await committing
    expect((await service.stage(root, ['next.txt'], true)).files.find(file => file.path === 'next.txt')?.indexStatus).toBe('A')
  })

  it('supports first push, current-branch push, fetch, ahead/behind and safe remote validation', async () => {
    const root = await repository()
    await initialCommit(root)
    const remote = await mkdtemp(path.join(os.tmpdir(), 'devdock-bare-'))
    temporaryDirectories.push(remote)
    await git(remote, 'init', '--bare', '-b', 'main')
    await git(root, 'remote', 'add', 'origin', remote)
    const service = new GitService()
    await expect(service.push(root)).rejects.toThrow('上游')
    await expect(service.push(root, { remote: '--all', branch: 'main', setUpstream: true })).rejects.toThrow('远程仓库')
    await expect(service.push(root, { remote: 'origin', branch: '../bad', setUpstream: true })).rejects.toThrow('分支名称')
    const beforePush = await service.status(root)
    await service.push(root, { remote: 'origin', branch: 'main', setUpstream: true })
    expect((await service.status(root)).upstream).toBe('origin/main')
    expect((await service.status(root)).fingerprint).toBe(beforePush.fingerprint)
    await writeFile(path.join(root, 'base.txt'), 'second commit\n')
    const staged = await service.stage(root, ['base.txt'], true)
    await service.commit(root, 'second', staged.fingerprint)
    expect((await service.status(root)).ahead).toBe(1)
    await service.push(root)
    expect((await service.status(root)).ahead).toBe(0)
    expect(await git(remote, 'rev-parse', 'main')).toBe(await git(root, 'rev-parse', 'HEAD'))
    const other = await repository()
    await git(other, 'remote', 'add', 'origin', remote)
    await git(other, 'fetch', 'origin')
    await git(other, 'reset', '--hard', 'origin/main')
    await writeFile(path.join(other, 'remote-only.txt'), 'from collaborator\n')
    await git(other, 'add', 'remote-only.txt')
    await git(other, 'commit', '-m', 'remote commit')
    await git(other, 'push', 'origin', 'HEAD:main')
    await service.fetch(root)
    expect((await service.status(root)).behind).toBe(1)
    expect(await git(root, 'log', '-1', '--format=%s')).toBe('second')
    const remoteHead = await git(remote, 'rev-parse', 'main')
    await writeFile(path.join(root, 'base.txt'), 'diverging local commit\n')
    const diverged = await service.stage(root, ['base.txt'], true)
    await service.commit(root, 'local divergence', diverged.fingerprint)
    await expect(service.push(root)).rejects.toThrow('Git 操作失败')
    expect(await git(remote, 'rev-parse', 'main')).toBe(remoteHead)
  }, 30_000)

  it('does not follow symlink targets when previewing an untracked link', async () => {
    const root = await repository()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'devdock-outside-'))
    temporaryDirectories.push(outside)
    await writeFile(path.join(outside, 'secret.txt'), 'DO_NOT_EXPOSE_SECRET_CONTENT')
    try { await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file') }
    catch (error) {
      // Windows without Developer Mode disallows file symlinks. Junctions remain testable.
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      await mkdir(path.join(root, 'tracked'))
      await writeFile(path.join(root, 'tracked', 'secret.txt'), 'safe original\n')
      await git(root, 'add', 'tracked/secret.txt')
      await git(root, 'commit', '-m', 'track normal directory')
      await removeTestDirectory(path.join(root, 'tracked'))
      await symlink(outside, path.join(root, 'tracked'), 'junction')
      await expect(new GitService().diff(root, 'tracked/secret.txt', false)).rejects.toThrow()
      return
    }
    const preview = await new GitService().diff(root, 'link.txt', false)
    expect(preview.text).toContain('符号链接')
    expect(preview.text).not.toContain('DO_NOT_EXPOSE_SECRET_CONTENT')
  })

  it('redacts credential-bearing URLs in status and output', async () => {
    const root = await repository()
    await git(root, 'remote', 'add', 'origin', 'https://username:top-secret@example.invalid/repo.git?access_token=hidden-token')
    const remote = (await new GitService().status(root)).remotes[0]
    expect(remote.url).not.toContain('top-secret')
    expect(remote.url).not.toContain('hidden-token')
    expect(redactGitOutput('fatal: https://token-secret@example.invalid')).not.toContain('token-secret')
  })
})
