import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

// All mutations stay in this fixture. GitHub status is read-only; no login,
// repository creation, GitHub push, or global Git configuration is performed.
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'devdock-git-setup-ui-'))
const project = join(scratch, 'new-project')
const remoteA = join(scratch, 'remote-a.git')
const remoteB = join(scratch, 'remote-b.git')
const screenshots = join(root, 'artifacts', 'screenshots')
await mkdir(project)
await mkdir(screenshots, { recursive: true })
await writeFile(join(project, 'README.md'), '# Local Git setup UI fixture\n')
const git = async (...args) => (await exec('git', args, { cwd: project, windowsHide: true })).stdout.trim()
await git('init', '--bare', remoteA)
await git('init', '--bare', remoteB)

const env = { ...process.env, DEVDOCK_TEST_MODE: '1', DEVDOCK_DATA_DIR: join(scratch, 'user-data') }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read, description, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await read()
    if (result) return result
    await wait(100)
  }
  throw new Error(`Timed out: ${description}`)
}

let instance
const errors = []
try {
  const executablePath = process.env.DEVDOCK_TEST_EXECUTABLE
  instance = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 60000 })
  const page = await instance.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => void dialog.accept())
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.showInactive()
  })
  await page.getByRole('button', { name: '或手动输入路径' }).click()
  await page.getByLabel('项目路径', { exact: true }).fill(project)
  await page.getByRole('button', { name: '添加项目', exact: true }).click()
  await page.getByTestId('git-setup-open').click()
  await page.getByLabel('初始分支', { exact: true }).fill('main')
  await page.getByTestId('git-initialize').click()
  await poll(() => git('symbolic-ref', '--short', 'HEAD').then(value => value === 'main').catch(() => false), 'Git initialized from UI')
  await poll(() => page.getByRole('button', { name: '保存提交身份', exact: true }).count(), 'identity form after initialization')
  // The initial identity read finishes independently of the initialization result.
  await poll(() => page.locator('.setup-field-heading').filter({ hasText: /当前项目配置|继承本机配置/ }).count(), 'initial identity loaded')
  await page.getByLabel('提交者姓名', { exact: true }).fill('DevDock Local UI')
  await page.getByLabel('提交者邮箱', { exact: true }).fill('devdock-ui@example.invalid')
  await page.getByRole('button', { name: '保存提交身份', exact: true }).click()
  await poll(() => git('config', '--local', 'user.name').then(value => value === 'DevDock Local UI').catch(() => false), 'local identity saved')
  assert.equal(await git('config', '--local', 'user.email'), 'devdock-ui@example.invalid')
  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await page.getByTestId('git-setup-open').click()
  await poll(() => page.getByLabel('提交者姓名', { exact: true }).inputValue().then(value => value === 'DevDock Local UI'), 'saved identity reloaded')
  assert.equal(await page.getByLabel('提交者邮箱', { exact: true }).inputValue(), 'devdock-ui@example.invalid')
  console.log('UI initialization, project-local identity save and reopened form persistence passed.')

  await page.getByRole('button', { name: '添加远程', exact: true }).click()
  await page.getByLabel('远程名称', { exact: true }).fill('origin')
  await page.getByLabel('远程地址', { exact: true }).fill(remoteA)
  await page.getByTestId('remote-save').click()
  await poll(() => git('remote', 'get-url', 'origin').then(value => value === remoteA).catch(() => false), 'origin added from UI')
  await poll(() => page.locator('.setup-remote').filter({ has: page.getByText('origin', { exact: true }) }).count(), 'origin row')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await poll(() => page.locator('.setup-remote-result.success').count(), 'empty bare remote reachable')
  assert.match(await page.locator('.setup-remote-result.success').innerText(), /空仓库/)

  await page.getByRole('button', { name: '编辑远程 origin', exact: true }).click()
  await page.getByLabel('远程名称', { exact: true }).fill('archive')
  await page.getByLabel('远程地址', { exact: true }).fill(remoteB)
  await page.getByTestId('remote-save').click()
  await poll(() => git('remote', 'get-url', 'archive').then(value => value === remoteB).catch(() => false), 'remote renamed and URL changed from UI')
  assert.equal(await git('remote'), 'archive')
  await poll(() => page.locator('.remote-editor').count().then(count => count === 0), 'remote editor closed')
  await poll(() => page.getByRole('button', { name: '编辑远程 archive', exact: true }).count(), 'renamed remote row refreshed')
  assert.equal(await page.locator('.setup-remote-result').count(), 0, 'Editing a remote clears the old connection result')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await poll(() => page.locator('.setup-remote-result.success').count(), 'edited remote reachable')
  await page.locator('.git-setup-scroll').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: join(screenshots, '10-git-setup-local-ui.png'), animations: 'disabled' })
  console.log('UI remote add, empty-remote connection test, rename and URL editing passed.')

  // Supply both confirmation decisions deterministically, without leaving an OS
  // modal on the user's desktop. Assert the actual application prompt and branch.
  await page.evaluate(() => {
    window.__devdockConfirmPrompts = []
    window.__devdockAcceptRemoval = false
    window.confirm = message => {
      window.__devdockConfirmPrompts.push(message)
      return window.__devdockAcceptRemoval
    }
  })
  await page.getByRole('button', { name: '移除远程 archive', exact: true }).click()
  assert.equal(await git('remote'), 'archive', 'Cancel preserves remote configuration')
  await page.evaluate(() => { window.__devdockAcceptRemoval = true })
  await page.getByRole('button', { name: '移除远程 archive', exact: true }).click()
  await poll(() => git('remote').then(value => value === ''), 'confirmed remote removed')
  const prompts = await page.evaluate(() => window.__devdockConfirmPrompts)
  assert.equal(prompts.length, 2)
  assert.ok(prompts.every(message => message.includes('archive') && message.includes('不会删除')))
  await poll(() => page.getByText('还没有远程仓库', { exact: true }).count(), 'empty remote view after removal')
  assert.equal(await git('config', '--local', 'user.name'), 'DevDock Local UI', 'Removing remote preserves identity')
  assert.deepEqual(errors, [], 'No renderer errors')
  console.log('Removal cancel/confirm branches and empty remote state passed. All local Git setup UI checks passed.')
  console.log(`Git setup UI fixture: ${scratch}`)
  const closed = instance.waitForEvent('close')
  await page.evaluate(() => window.dock.windowAction('quit')).catch(() => {})
  await closed
  instance = undefined
} finally {
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {})
}
