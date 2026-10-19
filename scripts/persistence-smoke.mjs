import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, readFile, realpath, rename, unlink, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Exercise the same Roaming path used by the installed app, including Windows
// profile redirection. Never share the user's actual DevDock profile.
assert.ok(process.env.APPDATA, 'This Windows regression check requires APPDATA')
const root = resolve(import.meta.dirname, '..')
const artifactRoot = join(root, 'artifacts')
await mkdir(artifactRoot, { recursive: true })
const data = await mkdtemp(join(process.env.APPDATA, 'devdock-persistence-smoke-'))
const project = await mkdtemp(join(artifactRoot, 'devdock-persistence-project-'))
const canonicalData = await realpath(data)
const canonicalProject = await realpath(project)
// A virtualized APPDATA directory and a newly created child can resolve to
// different roots. Record the owned child's actual parent after creation.
const canonicalRoaming = dirname(canonicalData)
const canonicalArtifacts = await realpath(artifactRoot)
const env = { ...process.env, DEVDOCK_TEST_MODE: '1', DEVDOCK_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let instance
let passed = false
const rendererErrors = []
const exec = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function poll(read, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${description}`)
}

async function launch() {
  const executablePath = process.env.DEVDOCK_TEST_EXECUTABLE
  instance = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 60000 })
  const page = await instance.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => rendererErrors.push(error.message))
  await instance.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
      window.showInactive()
    }
  })
  await page.waitForFunction(() => !!window.dock, undefined, { polling: 100 })
  await page.locator('.titlebar').waitFor({ state: 'visible' })
  return page
}

async function closeApp(page) {
  const closed = instance.waitForEvent('close', { timeout: 15000 })
  await page.evaluate(() => window.dock.windowAction('quit')).catch(() => {})
  await closed
  instance = undefined
}

async function removeFixture(logicalPath, logicalParent, expectedCanonical, parent, prefix) {
  const target = await realpath(logicalPath)
  const child = relative(parent, target)
  assert.equal(dirname(resolve(logicalPath)), resolve(logicalParent), 'Logical fixture path must be a direct child of the intended directory')
  assert.equal(target, expectedCanonical, 'Fixture must still resolve to the originally created directory')
  assert.equal(basename(target), basename(logicalPath), 'Fixture name must match the unique directory created by mkdtemp')
  assert.ok(child && !isAbsolute(child) && !child.includes(sep) && child.startsWith(prefix), 'Cleanup is limited to one owned direct child of the expected parent')
  assert.equal(dirname(target), parent)
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

try {
  // This reproduces EXDEV on redirected profiles and documents why tests using
  // Local/Temp alone do not cover the installed application's storage behavior.
  const source = join(data, 'rename-probe.tmp')
  const destination = join(data, 'rename-probe.json')
  try {
    await writeFile(source, 'probe', { flag: 'wx' })
    await rename(source, destination)
    await writeFile(source, 'replacement', { flag: 'wx' })
    await rename(source, destination)
    console.log('Logical Roaming rename probe: supported on this profile.')
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    console.log('Logical Roaming rename probe: reproduced EXDEV.')
  } finally {
    for (const filename of [source, destination]) {
      await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  console.log(`Logical profile: ${data}`)
  console.log(`Physical profile: ${canonicalData}`)
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'persistence-fixture', private: true, scripts: { test: 'node check.cjs' } }, null, 2))
  await writeFile(join(project, 'check.cjs'), 'console.log("Roaming persistence test passed.");\n')
  // Keep Git discovery inside this fixture rather than adopting the source
  // workspace that contains the artifacts directory.
  await exec('git', ['init', '-b', 'main'], { cwd: project, windowsHide: true })

  let page = await launch()
  await instance.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  await page.getByTestId('add-project-button').click()
  const added = await poll(async () => {
    const state = await page.evaluate(() => window.dock.bootstrap())
    return state.config.projects.length === 1 ? state : null
  }, 'native folder chooser saves the selected project')
  const savedProject = added.config.projects[0]
  assert.equal(savedProject.path, canonicalProject)
  assert.equal(savedProject.name, basename(project))
  assert.equal(savedProject.commands.length, 1)
  assert.equal(savedProject.commands[0].kind, 'test')
  assert.equal(JSON.parse(await readFile(join(data, 'config.json'), 'utf8')).activeProjectId, savedProject.id)
  console.log('Folder chooser saved the D: project into the logical Roaming profile.')

  await page.getByTestId('test-button').click()
  const run = await poll(async () => {
    const state = await page.evaluate(() => window.dock.bootstrap())
    return state.runs.find(run => run.kind === 'test' && run.status !== 'running')
  }, 'Test button completes')
  assert.equal(run.status, 'success', run.output)
  assert.match(run.output, /Roaming persistence test passed/)

  await page.getByTitle('添加自定义命令', { exact: true }).click()
  await page.getByLabel('按钮名称', { exact: true }).fill('Persistence check')
  await page.getByLabel('执行命令', { exact: true }).fill('node -e "console.log(42)"')
  await page.getByRole('button', { name: '保存按钮', exact: true }).click()
  await poll(async () => (await page.evaluate(() => window.dock.bootstrap())).config.projects[0].commands.length === 2, 'custom command saved')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const pin = page.getByRole('switch', { name: '始终置顶', exact: true })
  assert.equal(await pin.getAttribute('aria-checked'), 'true')
  await pin.click()
  await poll(async () => (await page.evaluate(() => window.dock.bootstrap())).config.settings.alwaysOnTop === false, 'settings replaced existing configuration')
  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await closeApp(page)

  const persisted = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'))
  const history = JSON.parse(await readFile(join(data, 'history.json'), 'utf8'))
  assert.equal(persisted.projects[0].commands.length, 2)
  assert.equal(persisted.settings.alwaysOnTop, false)
  assert.ok(history.some(saved => saved.id === run.id && saved.status === 'success'))
  page = await launch()
  const reopened = await page.evaluate(() => window.dock.bootstrap())
  assert.equal(reopened.config.activeProjectId, savedProject.id)
  assert.equal(reopened.config.projects[0].path, canonicalProject)
  assert.equal(reopened.config.projects[0].commands.find(command => command.name === 'Persistence check')?.command, 'node -e "console.log(42)"')
  assert.equal(reopened.config.settings.alwaysOnTop, false)
  assert.ok(reopened.runs.some(saved => saved.id === run.id && saved.status === 'success' && saved.output.includes('Roaming persistence test passed.')))
  assert.equal(reopened.startupWarning, undefined)
  assert.deepEqual(rendererErrors, [])
  await closeApp(page)
  passed = true
  console.log('PASS: actual Roaming profile, folder chooser, Test button, command/settings updates, history, graceful quit and restart persistence.')
} finally {
  if (instance) {
    const closed = instance.waitForEvent('close', { timeout: 10000 }).catch(() => {})
    await instance.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await closed
  }
  if (passed) {
    await removeFixture(data, process.env.APPDATA, canonicalData, canonicalRoaming, 'devdock-persistence-smoke-')
    await removeFixture(project, artifactRoot, canonicalProject, canonicalArtifacts, 'devdock-persistence-project-')
    console.log('Owned test profile and project cleaned up.')
  } else {
    console.error(`Failed test fixtures retained for inspection:\n${data}\n${project}`)
  }
}
