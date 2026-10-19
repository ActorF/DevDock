import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

// Real clicks, real Git, an isolated local bare remote, and a disposable user-data directory.
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'devdock-ui-smoke-'))
const repo = join(scratch, 'workspace-example')
const remote = join(scratch, 'local-remote.git')
const screenshots = join(root, 'artifacts', 'screenshots')
await mkdir(repo)
await mkdir(screenshots, { recursive: true })
const git = async (...args) => (await exec('git', args, { cwd: repo, windowsHide: true })).stdout.trim()
await git('init', '-b', 'main')
await git('config', 'user.name', 'DevDock UI test')
await git('config', 'user.email', 'devdock-ui@example.invalid')
await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'workspace-example', private: true, scripts: { test: 'node check.cjs', dev: 'node server.cjs' } }, null, 2))
await writeFile(join(repo, 'check.cjs'), 'console.log("Checking files..."); setTimeout(() => console.log("Tests passed."), 450);\n')
await writeFile(join(repo, 'server.cjs'), 'console.log("Ready"); setInterval(() => {}, 1000);\n')
await writeFile(join(repo, 'README.md'), '# UI fixture\n')
await mkdir(join(repo, 'src'))
await writeFile(join(repo, 'src', 'panel.ts'), 'export const compact = false;\n')
await git('add', '.')
await git('commit', '-m', 'Initial fixture')
await git('init', '--bare', remote)
await git('remote', 'add', 'origin', remote)
await writeFile(join(repo, 'src', 'panel.ts'), 'export const compact = true;\nexport const theme = "dark";\n')
await writeFile(join(repo, 'README.md'), '# UI fixture\nChanged but not included in the first commit.\n')

const env = { ...process.env, DEVDOCK_TEST_MODE: '1', DEVDOCK_DATA_DIR: join(scratch, 'user-data') }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let instance
const errors = []
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read, description, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await read()
    if (value) return value
    await wait(100)
  }
  throw new Error(`Timed out: ${description}`)
}
try {
  const executablePath = process.env.DEVDOCK_TEST_EXECUTABLE
  instance = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], env, timeout: 60000 })
  const page = await instance.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await instance.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    // A hidden Chromium compositor can capture incomplete layers on Windows.
    window.showInactive()
  })
  await poll(() => page.locator('[data-testid="add-project-button"]').count(), 'welcome view')
  await page.evaluate(() => document.fonts.ready)
  await wait(200)
  const titlebarRect = await page.locator('.titlebar').boundingBox()
  console.log('Welcome titlebar:', titlebarRect)
  assert.ok(titlebarRect && titlebarRect.y >= 0 && titlebarRect.y < 3 && titlebarRect.height >= 49 && titlebarRect.height <= 51, 'Titlebar stays at top, including welcome')
  await page.screenshot({ path: join(screenshots, '04-welcome-ui.png'), animations: 'disabled' })

  await page.getByRole('button', { name: '或手动输入路径' }).click()
  await page.getByLabel('项目路径', { exact: true }).fill(repo)
  await page.getByRole('button', { name: '添加项目', exact: true }).click()
  await poll(() => page.locator('[data-testid="test-button"]').count(), 'project panel')
  await poll(async () => !(await page.locator('[data-testid="commit-button"]').isDisabled()), 'Git ready')
  await page.locator('[data-testid="test-button"]').click()
  await poll(() => page.getByText('上次测试通过', { exact: true }).count(), 'test success')
  const panelTitlebarY = await page.locator('.titlebar').evaluate(el => el.getBoundingClientRect().y)
  assert.ok(panelTitlebarY >= 0 && panelTitlebarY < 2, 'Panel titlebar remains at the top')
  await page.screenshot({ path: join(screenshots, '05-panel-ui.png'), animations: 'disabled' })
  console.log('Manual project add and Test button passed.')

  await page.locator('[data-testid="commit-button"]').click()
  await poll(() => page.locator('.commit-layout').count(), 'commit view')
  await page.getByRole('checkbox', { name: '暂存 src/panel.ts', exact: true }).click()
  await poll(() => page.getByRole('checkbox', { name: '取消暂存 src/panel.ts', exact: true }).count(), 'file staged')
  await poll(() => page.locator('.diff-code').innerText().then(text => text.includes('compact = true')), 'staged diff')
  await page.getByLabel('提交说明', { exact: false }).fill('feat: exercise UI staging')
  await page.screenshot({ path: join(screenshots, '06-commit-ui.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '提交 1 个文件', exact: true }).click()
  await poll(() => git('log', '-1', '--format=%s').then(message => message === 'feat: exercise UI staging'), 'UI commit')
  assert.match(await git('status', '--porcelain'), /README.md/)
  assert.doesNotMatch(await git('status', '--porcelain'), /src\/panel.ts/)
  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await poll(() => page.locator('[data-testid="push-button"]').isEnabled(), 'push available')
  await page.locator('[data-testid="push-button"]').click()
  await page.getByLabel('目标分支', { exact: true }).fill('main')
  await page.getByRole('button', { name: '推送并关联上游', exact: true }).click()
  await poll(() => git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}').then(value => value === 'origin/main').catch(() => false), 'first push sets upstream')
  await poll(() => page.locator('.status-label.success').count(), 'push completed log')
  await page.screenshot({ path: join(screenshots, '07-logs-ui.png'), animations: 'disabled' })
  console.log('Selected-file Commit and first-time Push through UI passed.')

  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await page.getByRole('button', { name: '添加自定义命令', exact: true }).click()
  await page.getByLabel('按钮名称', { exact: true }).fill('Echo')
  await page.getByLabel('执行命令', { exact: true }).fill('node -e "console.log(42)"')
  await page.getByRole('button', { name: '保存按钮', exact: true }).click()
  await page.getByRole('button', { name: 'Echo', exact: true }).click()
  await poll(async () => (await page.evaluate(() => window.dock.bootstrap())).runs.some(run => run.label === 'Echo' && run.status === 'success'), 'custom command')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.screenshot({ path: join(screenshots, '08-settings-ui.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await page.getByRole('button', { name: '收起为工具条', exact: true }).click()
  await poll(() => page.locator('.compact-bar').count(), 'compact toolbar')
  assert.equal(await page.locator('.toast').count(), 0, 'Success toast does not cover compact controls')
  await page.screenshot({ path: join(screenshots, '09-compact-ui.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '切换项目', exact: true }).click()
  await poll(() => page.locator('.project-menu').count(), 'compact project switch expands')
  assert.ok(await page.evaluate(() => window.innerHeight > 400), 'Project menu has room after expansion')
  await page.keyboard.press('Escape')
  console.log('Custom button, settings, compact controls and compact project selector passed.')

  // Preserve a failed commit draft: hook rejects the Git operation after clicking Commit.
  await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "UI fixture intentionally rejected commit" >&2\nexit 1\n')
  await page.locator('[data-testid="commit-button"]').click()
  await page.getByRole('checkbox', { name: '暂存 README.md', exact: true }).click()
  await poll(() => page.getByRole('checkbox', { name: '取消暂存 README.md', exact: true }).count(), 'readme staged')
  await page.getByLabel('提交说明', { exact: false }).fill('keep this draft after failure')
  await page.getByRole('button', { name: '提交 1 个文件', exact: true }).click()
  await poll(() => page.locator('.status-label.failed').count(), 'rejected commit log')
  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await page.locator('[data-testid="commit-button"]').click()
  assert.equal(await page.getByLabel('提交说明', { exact: false }).inputValue(), 'keep this draft after failure')
  assert.deepEqual(errors, [], 'No renderer errors')
  console.log('Failed commit preserves draft. All real UI checks passed.')
  console.log(`UI fixture: ${scratch}`)
  const closed = instance.waitForEvent('close')
  await page.evaluate(() => window.dock.windowAction('quit')).catch(() => {})
  await closed
  instance = undefined
} finally {
  if (instance) await instance.evaluate(({ app }) => app.exit(0)).catch(() => {})
}
