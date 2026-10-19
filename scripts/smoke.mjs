import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'devdock-smoke-'))
const repo = join(scratch, 'portfolio-app')
const remote = join(scratch, 'remote.git')
const data = join(scratch, 'user-data')
const screenshots = join(root, 'artifacts', 'screenshots')
await mkdir(repo)
await mkdir(screenshots, { recursive: true })
const git = async (...args) => (await exec('git', args, { cwd: repo, windowsHide: true })).stdout.trim()
await git('init', '-b', 'main')
await git('config', 'user.name', 'DevDock smoke test')
await git('config', 'user.email', 'devdock-test@example.invalid')
await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'portfolio-app', private: true, scripts: { test: 'node check.cjs', build: 'node -e "console.log(\'Build complete\')"', dev: 'node server.cjs' } }, null, 2))
await writeFile(join(repo, 'check.cjs'), 'console.log("Running project tests..."); setTimeout(() => { console.log("All 24 tests passed."); }, 350);\n')
await writeFile(join(repo, 'server.cjs'), 'console.log("Development server is ready"); setInterval(() => console.log("heartbeat"), 1000);\n')
await writeFile(join(repo, 'README.md'), '# Example project\n')
await mkdir(join(repo, 'src'))
await writeFile(join(repo, 'src', 'panel.ts'), 'export const compact = false;\n')
await git('add', '.')
await git('commit', '-m', 'Initial fixture')
await git('init', '--bare', remote)
await git('remote', 'add', 'origin', remote)
await git('push', '-u', 'origin', 'main')
await writeFile(join(repo, 'src', 'panel.ts'), 'export const compact = true;\nexport const theme = "dark";\n')
await writeFile(join(repo, 'README.md'), '# Example project\nA focused developer panel.\n')

const env = { ...process.env, DEVDOCK_TEST_MODE: '1', DEVDOCK_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let instance
const failures = []
async function launch() {
  const executablePath = process.env.DEVDOCK_TEST_EXECUTABLE
  instance = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 60000 })
  const page = await instance.firstWindow()
  await instance.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.showInactive() } })
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => failures.push(error.message))
  await page.waitForFunction(() => !!window.dock, undefined, { polling: 100 })
  await page.locator('.titlebar').waitFor({ state: 'visible' })
  return page
}
async function poll(callback, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await callback()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for an application result')
}
async function waitRun(page, id) {
  return poll(async () => {
    const run = await page.evaluate(async runId => (await window.dock.bootstrap()).runs.find(run => run.id === runId), id)
    return run && run.status !== 'running' ? run : null
  })
}
async function closeApp(page) {
  const closed = instance.waitForEvent('close', { timeout: 15000 })
  await page.evaluate(() => window.dock.windowAction('quit')).catch(() => {})
  await closed
  instance = undefined
}
try {
  let page = await launch()
  await page.screenshot({ path: join(screenshots, '01-welcome.png') })
  const config = await page.evaluate(path => window.dock.addProject(path), repo)
  const project = config.projects[0]
  assert.equal(project.commands.length, 3, 'Recognize test, build and dev scripts')
  await page.waitForFunction(() => document.body.innerText.includes('portfolio-app'), undefined, { polling: 100 })
  console.log('Project added and scripts detected.')
  let status = await page.evaluate(id => window.dock.repoStatus(id), project.id)
  assert.equal(status.files.length, 2)
  assert.equal(status.upstream, 'origin/main')
  const testCommand = project.commands.find(command => command.kind === 'test')
  const testRun = await page.evaluate(({ id, commandId }) => window.dock.runCommand(id, commandId), { id: project.id, commandId: testCommand.id })
  const completed = await waitRun(page, testRun.id)
  assert.equal(completed.status, 'success')
  assert.match(completed.output, /24 tests passed/)
  console.log('Real test command passed.')
  await page.screenshot({ path: join(screenshots, '02-panel.png') })
  await writeFile(join(repo, 'src', 'panel.ts'), 'export const compact = true;\nexport const theme = "violet";\n')
  const changed = await page.evaluate(id => window.dock.repoStatus(id), project.id)
  assert.notEqual(changed.fingerprint, completed.fingerprint, 'Editing an already modified file expires a test result')

  status = await page.evaluate(id => window.dock.gitStage(id, ['src/panel.ts'], true), project.id)
  const diff = await page.evaluate(id => window.dock.gitDiff(id, 'src/panel.ts', true), project.id)
  assert.match(diff.text, /violet/)
  const commit = await page.evaluate(({ id, fp }) => window.dock.gitCommit(id, 'feat: add compact panel', fp), { id: project.id, fp: status.fingerprint })
  assert.equal((await waitRun(page, commit.id)).status, 'success')
  console.log('Selected-file Git commit passed.')
  assert.equal(await git('log', '-1', '--format=%s'), 'feat: add compact panel')
  assert.match(await git('status', '--porcelain'), /README.md/)
  assert.doesNotMatch(await git('status', '--porcelain'), /src\/panel.ts/)
  const push = await page.evaluate(id => window.dock.gitPush(id), project.id)
  assert.equal((await waitRun(page, push.id)).status, 'success')
  console.log('Push to isolated local remote passed.')
  assert.equal((await page.evaluate(id => window.dock.repoStatus(id), project.id)).ahead, 0)

  const command = { id: 'smoke-custom', name: 'Check', command: 'node -e "console.log(42)"', kind: 'custom' }
  await page.evaluate(({ id, command }) => window.dock.saveCommand(id, command), { id: project.id, command })
  const customRun = await page.evaluate(id => window.dock.runCommand(id, 'smoke-custom'), project.id)
  assert.equal((await waitRun(page, customRun.id)).status, 'success')
  const runCommand = project.commands.find(command => command.kind === 'run')
  const serviceRun = await page.evaluate(({ id, commandId }) => window.dock.runCommand(id, commandId), { id: project.id, commandId: runCommand.id })
  await poll(() => page.evaluate(async id => (await window.dock.bootstrap()).runs.find(run => run.id === id)?.output.includes('server is ready'), serviceRun.id))
  await page.evaluate(id => window.dock.stopRun(id), serviceRun.id)
  assert.equal((await waitRun(page, serviceRun.id)).status, 'stopped')

  await page.evaluate(() => window.dock.saveSettings({ compact: true }))
  await page.waitForFunction(() => window.innerHeight < 100, undefined, { polling: 100 })
  await page.screenshot({ path: join(screenshots, '03-compact.png') })
  await page.evaluate(() => window.dock.saveSettings({ compact: false, alwaysOnTop: false }))
  await page.waitForFunction(() => window.innerHeight > 400, undefined, { polling: 100 })
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false)
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined')
  await closeApp(page)
  page = await launch()
  const reopened = await page.evaluate(() => window.dock.bootstrap())
  assert.equal(reopened.config.activeProjectId, project.id)
  assert.equal(reopened.config.projects[0].commands.length, 4)
  assert.equal(reopened.config.settings.alwaysOnTop, false)
  assert.ok(reopened.runs.some(run => run.id === testRun.id && run.status === 'success'))
  assert.ok(reopened.runs.every(run => run.status !== 'running'))
  assert.deepEqual(failures, [], 'No renderer exceptions')
  console.log('PASS: real Electron IPC, project detection, test output, stale result, selected-file commit, local remote push, custom command, process cancellation, compact/pin, sandbox, restart persistence.')
  console.log(`Screenshots: ${screenshots}`)
  console.log(`Isolated fixture: ${scratch}`)
} catch (error) {
  console.error('Smoke failure:', error)
  throw error
} finally {
  if (instance) {
    await instance.evaluate(({ app }) => app.exit(0)).catch(() => {})
  }
}
