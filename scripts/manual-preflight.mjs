import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const { base } = JSON.parse(await readFile(join(root, 'artifacts', 'manual-latest.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'))
const config = JSON.parse(await readFile(join(manifest.profiles.main, 'config.json'), 'utf8'))
const data = join(base, 'profiles', `preflight-${Date.now()}`)
await mkdir(data)
await writeFile(join(data, 'config.json'), JSON.stringify(config))
const env = { ...process.env, DEVDOCK_DATA_DIR: data, DEVDOCK_TEST_MODE: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let instance
const verified = []
const check = (message) => { verified.push(message); console.log(message) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read) {
  const end = Date.now() + 30000
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(100) }
  throw new Error('Timed out waiting for fixture command')
}
try {
  instance = await electron.launch({ executablePath: join(root, 'release', 'win-unpacked', 'DevDock.exe'), args: [], env })
  const page = await instance.firstWindow()
  await page.waitForFunction(() => !!window.dock, undefined, { polling: 100 })
  const state = await page.evaluate(() => window.dock.bootstrap())
  assert.equal(state.config.projects.length, 8)
  assert.equal(state.version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version)
  const workflow = config.projects.find(p => p.id === manifest.scenarios.workflow.projectId)
  const status = await page.evaluate(id => window.dock.repoStatus(id), workflow.id)
  assert.equal(status.upstream, 'origin/main')
  assert.equal(status.ahead, 0)
  assert.ok(status.files.some(file => file.path === 'notes/mixed.txt' && file.indexStatus !== '.' && file.worktreeStatus !== '.'))
  assert.ok(status.files.some(file => file.untracked && file.path.includes('中文')))
  const binary = await page.evaluate(id => window.dock.gitDiff(id, 'assets/sample.bin', false), workflow.id)
  assert.equal(binary.binary, true)
  check('Workflow: upstream, staged/worktree changes, Unicode untracked path and binary diff ready.')
  for (const key of ['firstPush', 'nonGit', 'conflict', 'unborn']) {
    const repo = await page.evaluate(id => window.dock.repoStatus(id), manifest.scenarios[key].projectId)
    if (key === 'firstPush') { assert.equal(repo.upstream, null); assert.equal(repo.remotes.length, 1) }
    if (key === 'nonGit') assert.equal(repo.isRepo, false)
    if (key === 'conflict') { assert.ok(repo.files.some(file => file.conflicted)); assert.equal(repo.mergeInProgress, true) }
    if (key === 'unborn') { assert.equal(repo.head, null); assert.equal(repo.remotes.length, 0) }
    check(`Scenario ready: ${key}`)
  }
  async function launchCommand(name) {
    const command = workflow.commands.find(c => c.name === name)
    assert.ok(command, name)
    return page.evaluate(({ projectId, commandId }) => window.dock.runCommand(projectId, commandId), { projectId: workflow.id, commandId: command.id })
  }
  async function waitRun(id) {
    return poll(async () => { const run = await page.evaluate(async id => (await window.dock.bootstrap()).runs.find(r => r.id === id), id); return run && run.status !== 'running' ? run : null })
  }
  for (const name of ['Test', 'Build', 'Lint', '故意失败', '大量日志（截断）']) {
    const result = await waitRun((await launchCommand(name)).id)
    assert.equal(result.status, name === '故意失败' ? 'failed' : 'success', result.output)
    if (name === '故意失败') assert.equal(result.exitCode, 7)
    if (name === '大量日志（截断）') { assert.ok(result.output.length <= 128 * 1024); assert.match(result.output, /LOG-END/); assert.match(result.output, /较早的输出已截断/) }
    check(`Real command verified: ${name}`)
  }
  const running = await launchCommand('Run')
  await poll(() => page.evaluate(async id => (await window.dock.bootstrap()).runs.find(r => r.id === id)?.output.includes('[child] heartbeat'), running.id))
  await page.evaluate(id => window.dock.stopRun(id), running.id)
  assert.equal((await waitRun(running.id)).status, 'stopped')
  assert.equal((await waitRun((await launchCommand('验证子进程停止')).id)).status, 'success')
  check('Run cancellation: parent and child stopped; heartbeat remains unchanged.')
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  await page.screenshot({ path: join(base, 'preflight-panel.png') })
  const closed = instance.waitForEvent('close', { timeout: 15000 })
  await page.evaluate(() => window.dock.windowAction('quit')).catch(() => {})
  await closed
  instance = undefined
  assert.deepEqual(JSON.parse(await readFile(join(manifest.profiles.main, 'history.json'), 'utf8')), [])
  const unchanged = JSON.parse(await readFile(join(manifest.profiles.main, 'config.json'), 'utf8'))
  assert.deepEqual(unchanged, config)
  check('Human acceptance profile remains untouched; automated results live in separate preflight profile.')
  await writeFile(join(base, 'preflight-results.json'), JSON.stringify({ version: state.version, date: new Date().toISOString(), verified, manualResults: 'All pending. This is fixture readiness, not human acceptance.' }, null, 2))
} finally {
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {})
}
