import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// This is an explicitly invoked live acceptance check. It creates one PRIVATE
// repository in the authenticated account; it is not part of npm test.
assert.ok(process.argv.includes('--live'), 'Live GitHub changes require the explicit --live option.')
const root = resolve(import.meta.dirname, '..')
const exec = promisify(execFile)
const gh = async (...args) => (await exec('gh', args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GH_HOST: 'github.com' } })).stdout.trim()
const accountForRun = JSON.parse(await gh('api', '--hostname', 'github.com', 'user', '--jq', '{login,id,name}'))
assert.ok(accountForRun.login, 'Log into github.com with GitHub CLI before running live validation.')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const evidencePath = join(root, 'artifacts', 'github-validation.json')
await mkdir(dirname(evidencePath), { recursive: true })
let evidence
try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!evidence) {
  const base = await mkdtemp(join(dirname(root), 'DevDock-online-validation-'))
  const fixtureId = randomUUID()
  const name = `devdock-validation-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${fixtureId.slice(0, 8)}`
  evidence = { base, project: join(base, 'online-demo'), peer: join(base, 'peer'), profile: join(base, 'profile'), name, owner: accountForRun.login, fixtureId, checks: [] }
  evidence.description = `DevDock ${version} private acceptance fixture ${evidence.fixtureId}`
  await mkdir(evidence.project)
  await mkdir(evidence.profile)
  await writeFile(join(evidence.project, 'README.md'), '# DevDock online validation\n\nAn isolated fixture for validating desktop Git operations.\n')
  await writeFile(join(evidence.project, '.gitignore'), 'dist/\n.runtime/\n')
  await writeFile(join(evidence.project, 'package.json'), JSON.stringify({ name: 'devdock-online-check', private: true, scripts: { test: 'node check.cjs', build: 'node build.cjs', dev: 'node server.cjs' } }, null, 2))
  await writeFile(join(evidence.project, 'check.cjs'), 'const assert = require("node:assert/strict"); assert.equal(2 + 3, 5); console.log("Online fixture test passed.");\n')
  await writeFile(join(evidence.project, 'build.cjs'), 'const fs = require("node:fs"); fs.mkdirSync("dist", {recursive: true}); fs.writeFileSync("dist/result.txt", "Built successfully"); console.log("Build complete.");\n')
  await writeFile(join(evidence.project, 'server.cjs'), 'console.log("Live validation service started"); setInterval(() => console.log("heartbeat"), 1000);\n')
  await writeFile(join(evidence.project, '中文 示例.txt'), 'UTF-8 sample for a real GitHub commit.\n')
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
}
assert.equal(evidence.owner, accountForRun.login, 'Saved live validation belongs to a different account; refusing to reuse it.')
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2))
const check = async message => { if (!evidence.checks.includes(message)) evidence.checks.push(message); await persist(); console.log(message) }
// The peer clone also uses the authenticated CLI account, without requiring
// a global Git credential helper or changing the developer's Git settings.
const git = async (cwd, ...args) => (await exec('git', [
  '-c', 'credential.https://github.com.helper=',
  '-c', 'credential.https://github.com.helper=!gh auth git-credential', ...args,
], { cwd, windowsHide: true, env: { ...process.env, GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } })).stdout.trim()
const env = { ...process.env, DEVDOCK_TEST_MODE: '1', DEVDOCK_DATA_DIR: evidence.profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read, label, timeout = 60000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await read(); if (value) return value; await sleep(150) }
  throw new Error(`Timed out: ${label}`)
}
let instance
try {
  const executablePath = process.env.DEVDOCK_TEST_EXECUTABLE
  instance = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 60000 })
  const page = await instance.firstWindow()
  await instance.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setBackgroundThrottling(false); w.showInactive() })
  page.setDefaultTimeout(20000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.waitForFunction(() => !!window.dock, undefined, { polling: 100 })
  const account = await page.evaluate(() => window.dock.githubStatus())
  assert.equal(account.state, 'connected', account.message)
  assert.equal(account.login, evidence.owner, 'Create only in the explicitly identified current account')
  await check(`GitHub account detected through the application: ${account.login}.`)
  let boot = await page.evaluate(() => window.dock.bootstrap())
  if (!boot.config.projects.length) {
    await page.getByRole('button', { name: '或手动输入路径' }).click()
    await page.getByLabel('项目路径', { exact: true }).fill(evidence.project)
    await page.getByRole('button', { name: '添加项目', exact: true }).click()
    boot = await poll(async () => { const b = await page.evaluate(() => window.dock.bootstrap()); return b.config.projects.length ? b : null }, 'add fixture project')
  }
  const project = boot.config.projects.find(item => item.path.toLowerCase() === evidence.project.toLowerCase())
  assert.ok(project)
  const projectId = project.id
  const repoStatus = () => page.evaluate(id => window.dock.repoStatus(id), projectId)
  async function waitRun(id) {
    return poll(async () => { const r = await page.evaluate(async id => (await window.dock.bootstrap()).runs.find(r => r.id === id), id); return r && r.status !== 'running' ? r : null }, 'task completion')
  }
  await page.getByTestId('git-setup-open').first().click()
  if (!(await repoStatus()).isRepo) {
    await page.getByTestId('git-initialize').click()
    await poll(async () => (await repoStatus()).isRepo, 'Git initialization')
  }
  await check('Initialized a new repository from the desktop UI.')
  await git(evidence.project, 'config', '--local', 'commit.gpgsign', 'false')
  await git(evidence.project, 'config', '--local', 'core.hooksPath', join(evidence.base, 'empty-hooks'))
  await page.getByTestId('github-use-identity').click()
  await poll(async () => (await page.evaluate(id => window.dock.gitIdentity(id), projectId)).email.includes('@users.noreply.github.com'), 'GitHub identity saved')
  await check('Saved project-local commit identity using the GitHub private noreply address.')
  if (!(await repoStatus()).remotes.some(remote => remote.name === 'origin')) {
    // Do not reuse or overwrite an unrelated pre-existing repository.
    let existing
    try { existing = JSON.parse(await gh('api', `repos/${evidence.owner}/${evidence.name}`)) }
    catch (error) { if (!String(error.stderr).includes('404') && !String(error.message).includes('404')) throw error }
    if (existing) {
      assert.equal(existing.description, evidence.description, 'Only resume our uniquely marked acceptance repository')
      await page.evaluate(({ id, url }) => window.dock.githubConnectRepository(id, { url, remoteName: 'origin' }), { id: projectId, url: existing.clone_url })
    } else {
      await page.getByRole('button', { name: '创建新仓库', exact: true }).click()
      await page.getByLabel('GitHub 仓库名称', { exact: true }).fill(evidence.name)
      await page.getByLabel('仓库说明', { exact: true }).fill(evidence.description)
      assert.equal(await page.getByRole('radio', { name: /私有/ }).isChecked(), true)
      await page.getByTestId('github-create-repo').click()
      await poll(async () => (await repoStatus()).remotes.some(remote => remote.name === 'origin'), 'create private GitHub repository and attach remote')
    }
  }
  const remote = JSON.parse(await gh('api', `repos/${evidence.owner}/${evidence.name}`))
  assert.equal(remote.private, true)
  assert.equal(remote.description, evidence.description)
  evidence.url = remote.html_url
  evidence.cloneUrl = remote.clone_url
  await check(`Created and connected private repository: ${remote.html_url}`)
  const connection = await page.evaluate(id => window.dock.gitTestRemote(id, 'origin'), projectId)
  assert.equal(connection.reachable, true, connection.message)
  await check('Authenticated Git connection succeeds, including an initially empty remote.')
  await page.screenshot({ path: join(evidence.base, '01-github-setup.png'), fullPage: true })
  await page.getByRole('button', { name: '返回悬浮面板', exact: true }).click()
  await page.getByTestId('test-button').click()
  await poll(() => page.getByText('上次测试通过', { exact: true }).count(), 'Test success')
  if (!(await repoStatus()).head) {
    const status = await repoStatus()
    await page.evaluate(({ id, paths }) => window.dock.gitStage(id, paths, true), { id: projectId, paths: status.files.map(file => file.path) })
    await page.getByTestId('commit-button').click()
    await page.getByLabel('提交说明', { exact: false }).fill('test: validate DevDock first GitHub commit')
    await page.getByRole('button', { name: /^提交 \d+ 个文件$/ }).click()
    await poll(async () => !!(await repoStatus()).head, 'initial commit')
    await page.getByRole('button', { name: '返回面板', exact: true }).click()
  }
  await check('Test and first Commit succeeded; UTF-8 and spaced filenames are included.')
  if (!(await repoStatus()).upstream) {
    await page.getByTestId('push-button').click()
    await page.getByLabel('目标分支', { exact: true }).fill('main')
    await page.getByRole('button', { name: '推送并关联上游', exact: true }).click()
    await poll(async () => (await repoStatus()).upstream === 'origin/main', 'first HTTPS push with configured CLI credentials')
    await poll(async () => (await page.evaluate(() => window.dock.bootstrap())).runs.some(r => r.label === 'Push' && r.status === 'success'), 'push result')
    await page.getByRole('button', { name: '返回面板', exact: true }).click()
  }
  assert.equal(await git(evidence.project, 'rev-parse', 'HEAD'), JSON.parse(await gh('api', `repos/${evidence.owner}/${evidence.name}/commits/main`)).sha)
  await check('First Push reached real GitHub and established origin/main; local and server commit SHAs match.')
  const repositories = await page.evaluate(() => window.dock.githubRepositories())
  assert.ok(repositories.some(repo => repo.fullName === `${evidence.owner}/${evidence.name}` && repo.private))
  const tempName = 'validation-extra'
  if (!(await repoStatus()).remotes.some(r => r.name === tempName)) {
    await page.evaluate(({ id, url }) => window.dock.githubConnectRepository(id, { url, remoteName: 'validation-extra' }), { id: projectId, url: remote.clone_url })
  }
  await page.evaluate(({ id, url }) => window.dock.gitSaveRemote(id, { originalName: 'validation-extra', name: 'validation-renamed', url }), { id: projectId, url: remote.clone_url })
  assert.equal((await page.evaluate(id => window.dock.gitTestRemote(id, 'validation-renamed'), projectId)).reachable, true)
  await page.evaluate(id => window.dock.gitRemoveRemote(id, 'validation-renamed'), projectId)
  assert.equal((await repoStatus()).remotes.length, 1)
  await check('Existing-repository selection, additional remote, edit/rename, connection test and removal work.')
  if (!evidence.remoteFetchDone) {
    await git(evidence.base, 'clone', remote.clone_url, evidence.peer)
    await git(evidence.peer, 'config', '--local', 'user.name', account.name || account.login)
    await git(evidence.peer, 'config', '--local', 'user.email', `${account.id}+${account.login}@users.noreply.github.com`)
    await git(evidence.peer, 'config', '--local', 'commit.gpgsign', 'false')
    await git(evidence.peer, 'config', '--local', 'core.hooksPath', join(evidence.base, 'empty-hooks'))
    await writeFile(join(evidence.peer, 'remote-update.txt'), 'A real GitHub update used to test Fetch.\n')
    await git(evidence.peer, 'add', '--', 'remote-update.txt')
    await git(evidence.peer, 'commit', '-m', 'test: remote change for Fetch validation')
    await git(evidence.peer, 'push', 'origin', 'main')
    const fetched = await waitRun((await page.evaluate(id => window.dock.gitFetch(id), projectId)).id)
    assert.equal(fetched.status, 'success', fetched.output)
    assert.equal((await repoStatus()).behind, 1)
    // Fixture-only synchronization; the product deliberately does not auto-merge.
    await git(evidence.project, 'merge', '--ff-only', 'origin/main')
    evidence.remoteFetchDone = true
    await persist()
  }
  await check('Fetch sees a real remote-only commit and reports the correct behind count without auto-merging.')
  if (!evidence.rejectDone) {
    await git(evidence.project, 'checkout', '-b', 'codex/push-rejection')
    let result = await waitRun((await page.evaluate(id => window.dock.gitPush(id, { remote: 'origin', branch: 'codex/push-rejection', setUpstream: true }), projectId)).id)
    assert.equal(result.status, 'success', result.output)
    await git(evidence.peer, 'fetch', 'origin')
    await git(evidence.peer, 'checkout', '-b', 'codex/push-rejection', 'origin/codex/push-rejection')
    await writeFile(join(evidence.peer, 'peer-only.txt'), 'Remote branch advances independently.\n')
    await git(evidence.peer, 'add', '--', 'peer-only.txt')
    await git(evidence.peer, 'commit', '-m', 'test: competing remote commit')
    await git(evidence.peer, 'push', 'origin', 'codex/push-rejection')
    await writeFile(join(evidence.project, 'local-only.txt'), 'Local branch advances independently.\n')
    const staged = await page.evaluate(id => window.dock.gitStage(id, ['local-only.txt'], true), projectId)
    result = await waitRun((await page.evaluate(({ id, fp }) => window.dock.gitCommit(id, 'test: competing local commit', fp), { id: projectId, fp: staged.fingerprint })).id)
    assert.equal(result.status, 'success', result.output)
    result = await waitRun((await page.evaluate(id => window.dock.gitPush(id), projectId)).id)
    assert.equal(result.status, 'failed')
    assert.match(result.output, /reject|fetch first|non-fast-forward/i)
    await waitRun((await page.evaluate(id => window.dock.gitFetch(id), projectId)).id)
    assert.equal((await repoStatus()).behind, 1)
    assert.equal((await repoStatus()).ahead, 1)
    // Reconcile only this deliberately divergent fixture; do not leave it broken.
    await git(evidence.project, 'merge', '--no-edit', 'origin/codex/push-rejection')
    result = await waitRun((await page.evaluate(id => window.dock.gitPush(id), projectId)).id)
    assert.equal(result.status, 'success', result.output)
    await git(evidence.project, 'checkout', 'main')
    evidence.rejectDone = true
    await persist()
  }
  await check('A real non-fast-forward Push is rejected; error is visible and no remote history is force-overwritten.')
  const build = project.commands.find(c => c.kind === 'build')
  assert.equal((await waitRun((await page.evaluate(({ id, cmd }) => window.dock.runCommand(id, cmd), { id: projectId, cmd: build.id })).id)).status, 'success')
  const dev = project.commands.find(c => c.kind === 'run')
  const active = await page.evaluate(({ id, cmd }) => window.dock.runCommand(id, cmd), { id: projectId, cmd: dev.id })
  await poll(() => page.evaluate(async id => (await window.dock.bootstrap()).runs.find(r => r.id === id)?.output.includes('service started'), active.id), 'Run output')
  await page.evaluate(id => window.dock.stopRun(id), active.id)
  assert.equal((await waitRun(active.id)).status, 'stopped')
  await check('Build, streaming command and Stop work in the connected project.')
  assert.deepEqual(pageErrors, [])
  evidence.version = (await page.evaluate(() => window.dock.bootstrap())).version
  evidence.completedAt = new Date().toISOString()
  delete evidence.lastError
  evidence.finalHead = await git(evidence.project, 'rev-parse', 'HEAD')
  await persist()
  const closed = instance.waitForEvent('close', { timeout: 15000 })
  await page.evaluate(() => window.dock.windowAction('quit')).catch(() => {})
  await closed
  instance = undefined
  console.log(`PASS: ${evidence.url}\nEvidence: ${evidencePath}\nFixture: ${evidence.project}`)
} catch (error) {
  evidence.lastError = error.message
  await persist()
  throw error
} finally {
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {})
}
