import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron'
import { join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Store } from './services/store'
import { Tasks } from './services/tasks'
import { GitService } from './services/git'
import { GithubService } from './services/github'
import { boundedOutput } from './services/bounded-log'
import type { AppConfig, AppSettings, CommandConfig, CreateGitHubRepositoryInput, Project, PushOptions, RemoteInput, RepoStatus, RunRecord } from '../shared/types'

app.setName('DevDock')
app.setPath('userData', process.env.DEVDOCK_DATA_DIR && isAbsolute(process.env.DEVDOCK_DATA_DIR)
  ? process.env.DEVDOCK_DATA_DIR : join(app.getPath('appData'), 'DevDock'))
const testMode = process.env.DEVDOCK_TEST_MODE === '1'
const gotLock = testMode || app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let store: Store
let tasks: Tasks
const git = new GitService()
const github = new GithubService()
const gitRunning = new Map<string, RunRecord>()
const pendingStages = new Set<string>()
const statusReads = new Map<string, Promise<RepoStatus>>()
let expanded = false
let quitting = false
let exiting = false
let quitDialogOpen = false
let registeredShortcut = ''
let extraWarning = ''
let boundsTimer: ReturnType<typeof setTimeout> | undefined
const lastPersisted = new Map<string, number>()

function send(channel: string, data: unknown) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, data)
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function str(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label}无效。`)
  return value
}
function project(id: unknown): Project { return store.getProject(str(id, '项目')) }
function isBusy(projectId: string): boolean {
  return pendingStages.has(projectId) || [...gitRunning.values()].some(run => run.projectId === projectId)
}
function emitConfig(config: AppConfig) { send('dock:config', config); updateTray(); return config }
function updateRun(run: RunRecord) {
  send('dock:run', run)
  const now = Date.now()
  if (run.status !== 'running' || now - (lastPersisted.get(run.id) ?? 0) >= 1000) {
    lastPersisted.set(run.id, now)
    void store.saveRun(run).catch(error => console.error('Unable to save run:', errorMessage(error)))
  }
  if (run.status !== 'running') {
    lastPersisted.delete(run.id)
    send('dock:repo-changed', run.projectId)
    if (!testMode && store.getConfig().settings.notifications && !mainWindow?.isFocused() && Notification.isSupported()) {
      const result = { success: '已完成', failed: '执行失败', stopped: '已停止', interrupted: '已中断' }[run.status]
      const notification = new Notification({ title: `${run.label} · ${result}`, body: run.projectName, silent: true })
      notification.on('click', showWindow)
      notification.show()
    }
  }
}
function showWindow() { mainWindow?.show(); mainWindow?.focus() }
function updateTray() {
  if (!tray || !store) return
  const config = store.getConfig()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DevDock', click: showWindow },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: config.settings.alwaysOnTop, click: item => { void changeSettings({ alwaysOnTop: item.checked }) } },
    { label: '紧凑模式', type: 'checkbox', checked: config.settings.compact, click: item => { void changeSettings({ compact: item.checked }); showWindow() } },
    { type: 'separator' },
    { label: '退出', click: () => { void quitApp() } }
  ]))
}
function clampBounds(width: number, height: number) {
  if (!mainWindow) return
  const current = mainWindow.getBounds()
  const area = screen.getDisplayMatching(current).workArea
  const targetW = Math.min(width, area.width)
  const targetH = Math.min(height, area.height)
  mainWindow.setBounds({
    width: targetW, height: targetH,
    x: Math.max(area.x, Math.min(current.x, area.x + area.width - targetW)),
    y: Math.max(area.y, Math.min(current.y, area.y + area.height - targetH))
  })
}
function resizeWindow() {
  if (!mainWindow) return
  const settings = store.getConfig().settings
  if (settings.compact) {
    mainWindow.setMinimumSize(450, 64)
    mainWindow.setResizable(false)
    clampBounds(520, 68)
  } else if (expanded) {
    mainWindow.setResizable(true)
    mainWindow.setMinimumSize(780, 580)
    clampBounds(980, 740)
  } else {
    mainWindow.setResizable(true)
    mainWindow.setMinimumSize(440, 510)
    clampBounds(Math.max(440, settings.bounds?.width ?? 480), Math.max(510, settings.bounds?.height ?? 590))
  }
}
function registerShortcut(shortcut: string, strict: boolean) {
  if (testMode || registeredShortcut === shortcut) return
  let success = false
  try { success = globalShortcut.register(shortcut, () => { mainWindow?.isVisible() && mainWindow.isFocused() ? mainWindow.hide() : showWindow() }) } catch {}
  if (!success) {
    if (strict) throw new Error('此快捷键无效或已被其他程序占用，请换一个组合。')
    extraWarning = `快捷键 ${shortcut} 未能注册，可以在设置中更换。`
    return
  }
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut)
  registeredShortcut = shortcut
}
async function changeSettings(input: Partial<AppSettings>) {
  if (!input || typeof input !== 'object') throw new Error('设置格式无效。')
  const allowed: Partial<AppSettings> = {}
  for (const key of ['alwaysOnTop', 'compact', 'notifications'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error('设置值无效。')
      allowed[key] = input[key]
    }
  }
  if (input.shortcut !== undefined) {
    allowed.shortcut = str(input.shortcut, '快捷键', 100)
    registerShortcut(allowed.shortcut, true)
  }
  const config = await store.saveSettings(allowed)
  mainWindow?.setAlwaysOnTop(config.settings.alwaysOnTop)
  if (allowed.compact !== undefined) { expanded = false; resizeWindow() }
  return emitConfig(config)
}
async function addProject(path: string) {
  const value = str(path, '目录')
  const status = await git.status(value)
  return emitConfig(await store.addProject(status.isRepo ? status.root : value))
}
async function gitAction(p: Project, label: string, command: string, action: () => Promise<string>): Promise<RunRecord> {
  if (exiting || quitDialogOpen) throw new Error('应用正在退出，请稍候。')
  if (isBusy(p.id)) throw new Error('这个项目还有 Git 操作正在执行，请稍候。')
  const run: RunRecord = { id: randomUUID(), projectId: p.id, projectName: p.name, label, kind: 'git', command, cwd: p.path, status: 'running', startedAt: new Date().toISOString(), output: `$ ${command}\n` }
  gitRunning.set(run.id, run)
  updateRun(run)
  void action().then(output => {
    Object.assign(run, { status: 'success', exitCode: 0, endedAt: new Date().toISOString(), output: boundedOutput(`${run.output}${output || '操作完成。'}\n`) })
  }).catch(error => {
    Object.assign(run, { status: 'failed', exitCode: 1, endedAt: new Date().toISOString(), output: boundedOutput(`${run.output}${errorMessage(error)}\n`) })
  }).finally(() => { gitRunning.delete(run.id); updateRun({ ...run }) })
  return { ...run }
}
async function setupAction<T>(id: unknown, action: (p: Project) => Promise<T>): Promise<T> {
  const p = project(id)
  if (isBusy(p.id) || exiting || quitDialogOpen) throw new Error('请等待当前 Git 操作或退出提示结束。')
  pendingStages.add(p.id)
  try { return await action(p) }
  finally { pendingStages.delete(p.id); send('dock:repo-changed', p.id) }
}
function remoteName(value: unknown): string {
  const name = str(value, '远程名称', 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || name.endsWith('.') || /\.lock$/i.test(name)) throw new Error('远程名称只能使用字母、数字、点、下划线和短横线，不能含连续点或以点、.lock 结尾。')
  return name
}
async function newGitHubRemote(p: Project, name: string) {
  const status = await git.status(p.path)
  if (!status.isRepo) throw new Error('请先初始化 Git 仓库。')
  if (status.remotes.some(remote => remote.name === name)) throw new Error(`远程 ${name} 已存在，请使用其他名称，或在远程列表中编辑。`)
  const account = await github.status()
  if (account.state !== 'connected') throw new Error('请先连接 GitHub 账号。')
  return github.executable()
}
function githubCloneUrl(value: unknown): string {
  const raw = str(value, 'GitHub 仓库地址')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('请输入 https://github.com/用户名/仓库名.git 格式的地址。') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?$/.test(url.pathname)) {
    throw new Error('连接 GitHub 仓库需要不含令牌的 github.com HTTPS 地址。')
  }
  return raw
}
async function quitApp() {
  if (exiting || quitDialogOpen) return
  const hadGitOperations = gitRunning.size > 0 || pendingStages.size > 0
  if (tasks?.hasRunning() || hadGitOperations) {
    quitDialogOpen = true
    let result
    try { result = await dialog.showMessageBox(mainWindow!, {
      type: 'question', title: '仍有任务正在运行', message: '退出 DevDock？',
      detail: hadGitOperations ? 'Git 操作正在执行，请等它结束后再退出。' : '退出会停止本应用启动的任务。隐藏窗口可以让它们继续运行。',
      buttons: hadGitOperations ? ['继续运行', '隐藏面板'] : ['继续运行', '停止任务并退出'], defaultId: 0, cancelId: 0, noLink: true
    }) } finally { quitDialogOpen = false }
    if (hadGitOperations) { if (result.response === 1) mainWindow?.hide(); return }
    if (result.response !== 1) return
  }
  exiting = true
  try {
    clearTimeout(boundsTimer)
    await tasks?.stopAll()
    await persistBounds()
    await store?.flush()
    await github.dispose()
    quitting = true
    app.quit()
  } catch (error) {
    exiting = false
    dialog.showErrorBox('暂时无法退出', errorMessage(error))
  }
}
function installHandlers() {
  function handle(name: string, handler: (...args: any[]) => unknown) {
    ipcMain.handle(`dock:${name}`, async (event, ...args) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('请求来源无效。')
      if (exiting) throw new Error('应用正在退出。')
      try { return await handler(...args) } catch (error) { throw new Error(errorMessage(error)) }
    })
  }
  handle('bootstrap', () => ({ config: store.getConfig(), runs: store.getRuns(), version: app.getVersion(), platform: process.platform, startupWarning: [store.startupWarning, extraWarning].filter(Boolean).join('\n') || undefined }))
  handle('chooseProject', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择项目文件夹', properties: ['openDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : addProject(result.filePaths[0])
  })
  handle('addProject', addProject)
  handle('selectProject', async id => emitConfig(await store.selectProject(str(id, '项目'))))
  handle('removeProject', async id => {
    const p = project(id)
    if (isBusy(p.id) || tasks.getRunning().some(run => run.projectId === p.id)) throw new Error('请先停止此项目正在运行的任务。')
    return emitConfig(await store.removeProject(p.id))
  })
  handle('saveCommand', async (id, command: CommandConfig) => emitConfig(await store.saveCommand(project(id).id, command)))
  handle('deleteCommand', async (id, commandId) => {
    const p = project(id)
    if (tasks.getRunning().some(run => run.projectId === p.id && run.commandId === commandId)) throw new Error('请先停止此命令。')
    return emitConfig(await store.deleteCommand(p.id, str(commandId, '命令')))
  })
  handle('saveSettings', changeSettings)
  handle('repoStatus', id => {
    const p = project(id)
    const existing = statusReads.get(p.id)
    if (existing) return existing
    const read = git.status(p.path).finally(() => { if (statusReads.get(p.id) === read) statusReads.delete(p.id) })
    statusReads.set(p.id, read)
    return read
  })
  handle('gitDiff', (id, path, staged) => git.diff(project(id).path, str(path, '文件'), staged === true))
  handle('gitStage', async (id, paths, staged) => {
    const p = project(id)
    if (isBusy(p.id)) throw new Error('请等待当前 Git 操作完成。')
    if (!Array.isArray(paths) || paths.length > 5000) throw new Error('文件列表无效。')
    if (quitDialogOpen) throw new Error('请先关闭退出提示。')
    pendingStages.add(p.id)
    try {
      const result = await git.stage(p.path, paths.map(value => str(value, '文件')), staged === true)
      send('dock:repo-changed', p.id)
      return result
    } finally { pendingStages.delete(p.id) }
  })
  handle('gitCommit', (id, message, fingerprint) => {
    const p = project(id)
    const msg = str(message, '提交说明', 10000)
    const fp = str(fingerprint, '项目状态')
    return gitAction(p, 'Commit', 'git commit', () => git.commit(p.path, msg, fp))
  })
  handle('gitPush', (id, options?: PushOptions) => {
    const p = project(id)
    if (options !== undefined && (!options || typeof options !== 'object')) throw new Error('推送参数无效。')
    return gitAction(p, 'Push', 'git push', () => git.push(p.path, options))
  })
  handle('gitFetch', id => {
    const p = project(id)
    return gitAction(p, 'Fetch', 'git fetch', () => git.fetch(p.path))
  })
  handle('gitInitialize', (id, branch) => setupAction(id, p => git.initialize(p.path, branch === undefined ? 'main' : str(branch, '分支名称', 120))))
  handle('gitIdentity', id => git.identity(project(id).path))
  handle('gitSaveIdentity', (id, identity) => setupAction(id, p => git.saveIdentity(p.path, identity)))
  handle('gitSaveRemote', (id, input: RemoteInput) => setupAction(id, async p => {
    const status = await git.saveRemote(p.path, input)
    let url: URL | undefined
    try { url = new URL(input.url) } catch { /* SSH shorthand and local paths use their existing Git authentication. */ }
    if (url?.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password) {
      const account = await github.status()
      if (account.state === 'connected') {
        try { await git.setGitHubCredentialHelper(p.path, await github.executable()) }
        catch (error) { throw new Error(`远程已保存，但 GitHub 凭据关联失败：${errorMessage(error)}。请编辑此远程并重新保存以重试。`) }
      }
    }
    return status
  }))
  handle('gitRemoveRemote', (id, name) => setupAction(id, p => git.removeRemote(p.path, str(name, '远程名称', 80))))
  handle('gitTestRemote', (id, name) => setupAction(id, p => git.testRemote(p.path, str(name, '远程名称', 80))))
  handle('githubStatus', () => github.status())
  handle('githubLogin', async () => {
    const state = await github.login()
    if (state.state === 'connecting') await shell.openExternal('https://github.com/login/device')
    return state
  })
  handle('githubCancelLogin', () => github.cancelLogin())
  handle('githubRepositories', () => github.repositories())
  handle('openGitHubHelp', () => shell.openExternal('https://cli.github.com/'))
  handle('githubUseIdentity', id => setupAction(id, async p => {
    const account = await github.status()
    if (account.state !== 'connected' || !account.login || !Number.isSafeInteger(account.id)) throw new Error('请先连接 GitHub 账号。')
    return git.saveIdentity(p.path, { name: account.name?.trim() || account.login, email: `${account.id}+${account.login}@users.noreply.github.com` })
  }))
  handle('githubConnectRepository', (id, input: { url: string; remoteName: string }) => setupAction(id, async p => {
    if (!input || typeof input !== 'object') throw new Error('仓库参数无效。')
    const name = remoteName(input.remoteName)
    const url = githubCloneUrl(input.url)
    const executable = await newGitHubRemote(p, name)
    await git.setGitHubCredentialHelper(p.path, executable)
    await git.saveRemote(p.path, { name, url })
    return git.status(p.path)
  }))
  handle('githubCreateRepository', (id, input: CreateGitHubRepositoryInput) => setupAction(id, async p => {
    if (!input || typeof input !== 'object' || typeof input.private !== 'boolean') throw new Error('请选择仓库名称和可见性。')
    const name = remoteName(input.remoteName)
    const executable = await newGitHubRemote(p, name)
    const created = await github.createRepository({ name: input.name, description: input.description, private: input.private })
    try {
      await git.setGitHubCredentialHelper(p.path, executable)
      await git.saveRemote(p.path, { name, url: githubCloneUrl(created.cloneUrl) })
    } catch (error) {
      throw new Error(`GitHub 仓库已创建：${created.url}。本地关联未完成：${errorMessage(error)}。可从“已有仓库”继续关联。`)
    }
    return created
  }))
  handle('runCommand', async (id, commandId) => {
    const p = project(id)
    const command = p.commands.find(c => c.id === str(commandId, '命令'))
    if (!command) throw new Error('找不到这个命令。')
    const fingerprint = command.kind === 'test' ? (await git.status(p.path)).fingerprint : undefined
    if (exiting || quitDialogOpen) throw new Error('应用正在退出，任务未启动。')
    return tasks.start(p, command, fingerprint)
  })
  handle('stopRun', async id => {
    const value = str(id, '任务')
    if (gitRunning.has(value)) throw new Error('Git 操作会在完成或超时后结束。')
    await tasks.stop(value)
  })
  handle('clearHistory', id => store.clearHistory(project(id).id))
  handle('openFolder', async id => {
    const result = await shell.openPath(project(id).path)
    if (result) throw new Error(result)
  })
  handle('openTerminal', id => {
    const p = project(id)
    if (process.platform !== 'win32') throw new Error('此版本的终端快捷打开功能仅支持 Windows。')
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/K'], { cwd: p.path, detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
  })
  handle('copyText', text => { if (typeof text !== 'string' || text.length > 3_000_000) throw new Error('内容太长。'); clipboard.writeText(text) })
  handle('windowAction', async action => {
    if (action === 'minimize') mainWindow?.minimize()
    else if (action === 'hide') mainWindow?.hide()
    else if (action === 'quit') await quitApp()
    else if (action === 'expand' || action === 'panel') {
      if (store.getConfig().settings.compact) emitConfig(await store.saveSettings({ compact: false }))
      expanded = action === 'expand'
      resizeWindow()
    } else throw new Error('窗口操作无效。')
  })
}
async function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !store) return
  const bounds = mainWindow.getBounds()
  const settings = store.getConfig().settings
  if (expanded || settings.compact) {
    bounds.width = settings.bounds?.width ?? 480
    bounds.height = settings.bounds?.height ?? 590
  }
  await store.saveSettings({ bounds })
}
async function createWindow() {
  const settings = store.getConfig().settings
  const area = screen.getPrimaryDisplay().workArea
  const bounds = settings.bounds
  mainWindow = new BrowserWindow({
    width: 480, height: 590, minWidth: 440, minHeight: 510,
    x: bounds?.x ?? area.x + area.width - 510, y: bounds?.y ?? area.y + 80,
    frame: false, backgroundColor: '#17171e', show: false, title: 'DevDock',
    icon: join(__dirname, '../assets/icon.png'), alwaysOnTop: settings.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: !testMode }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); mainWindow?.hide() } })
  mainWindow.on('focus', () => { const id = store.getConfig().activeProjectId; if (id) send('dock:repo-changed', id) })
  const rememberBounds = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      void persistBounds().catch(() => {})
    }, 500)
  }
  mainWindow.on('move', rememberBounds)
  mainWindow.on('resize', rememberBounds)
  resizeWindow()
  if (!testMode) {
    const icon = nativeImage.createFromPath(join(__dirname, '../assets/icon.png')).resize({ width: 20, height: 20 })
    tray = new Tray(icon)
    tray.setToolTip('DevDock · 开发悬浮面板')
    tray.on('double-click', showWindow)
    updateTray()
  }
  registerShortcut(settings.shortcut, false)
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl && !app.isPackaged && new URL(rendererUrl).hostname === '127.0.0.1') await mainWindow.loadURL(rendererUrl)
  else await mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  if (!testMode) mainWindow.show()
}
if (gotLock) {
  app.whenReady().then(async () => {
    store = new Store(app.getPath('userData'))
    await store.init()
    tasks = new Tasks(updateRun)
    installHandlers()
    await createWindow()
  }).catch(error => { dialog.showErrorBox('DevDock 启动失败', errorMessage(error)); app.exit(1) })
}
app.on('second-instance', showWindow)
app.on('activate', showWindow)
app.on('window-all-closed', () => { if (quitting) app.quit() })
app.on('before-quit', event => { if (!quitting && store) { event.preventDefault(); void quitApp() } })
app.on('will-quit', () => { globalShortcut.unregisterAll(); clearTimeout(boundsTimer) })
