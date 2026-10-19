import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Bell, Check,
  CheckCircle2, ChevronDown, ChevronRight, ChevronsLeftRight, Clock3,
  Copy, Expand, FileCode2, FileDiff,
  Folder, FolderOpen, GitBranch, GitCommitHorizontal, GripVertical,
  Info, Keyboard, LoaderCircle, Minus, Pin,
  Play, Plus, RefreshCw, Rocket, Settings2, ShieldCheck,
  Square, Terminal, Trash2, TriangleAlert, Upload, X, XCircle,
} from 'lucide-react'
import type {
  AppConfig, AppSettings, CommandConfig, CommandKind, GitDiff, GitFile,
  Project, RepoStatus, RunRecord,
} from '../shared/types'
import GitSetup from './GitSetup'

type View = 'panel' | 'commit' | 'logs' | 'settings' | 'push' | 'git-setup'
type Toast = { id: number; text: string; error: boolean }
type CommandEditor = { projectId: string; command: CommandConfig; isNew: boolean }
type LogFilter = 'all' | 'running' | 'failed'

const KIND_LABEL: Record<CommandKind, string> = { test: '测试', build: '构建', run: '持续运行', custom: '自定义' }
const STATUS_LABEL: Record<RunRecord['status'], string> = {
  running: '运行中', success: '成功', failed: '失败', stopped: '已停止', interrupted: '已中断',
}
const VIEW_LABEL: Record<View, string> = { panel: '工作面板', commit: '审阅并提交', logs: '运行记录', settings: '设置', push: '推送提交', 'git-setup': '仓库与账号' }
const api = window.dock
const getError = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
const isStaged = (file: GitFile) => !file.untracked && file.indexStatus !== ' ' && file.indexStatus !== '?'
const shortPath = (path: string) => path.replace(/\\/g, '/')
const displayShortcut = (shortcut: string) => shortcut.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl')
const filename = (path: string) => shortPath(path).split('/').pop() || path
const timeLabel = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
function duration(run: RunRecord, now = Date.now()) {
  const ms = Math.max(0, (run.endedAt ? new Date(run.endedAt).getTime() : now) - new Date(run.startedAt).getTime())
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.floor(ms % 60_000 / 1000)} 秒`
}
function newCommand(kind: CommandKind = 'custom'): CommandConfig {
  return { id: crypto.randomUUID(), name: kind === 'test' ? 'Test' : '', command: '', kind }
}
function RunIcon({ status, size = 15 }: { status: RunRecord['status']; size?: number }) {
  if (status === 'running') return <LoaderCircle size={size} className="spin" />
  if (status === 'success') return <CheckCircle2 size={size} />
  if (status === 'failed') return <XCircle size={size} />
  return <Square size={size} />
}
function CommandIcon({ kind, size = 16 }: { kind: CommandKind; size?: number }) {
  if (kind === 'test') return <ShieldCheck size={size} />
  if (kind === 'build') return <Rocket size={size} />
  if (kind === 'run') return <Play size={size} />
  return <Terminal size={size} />
}
function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark${small ? ' small' : ''}`} aria-hidden="true"><i /><i /><i /><i /></span>
}
function EmptyNote({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-note"><span className="empty-note-icon">{icon}</span><strong>{title}</strong>{children && <p>{children}</p>}</div>
}
function IconButton({ title, children, onClick, active, disabled, className = '' }: {
  title: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; className?: string
}) {
  return <button type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick} className={`icon-button no-drag ${active ? 'active' : ''} ${className}`}>{children}</button>
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [repo, setRepo] = useState<RepoStatus | null>(null)
  const [repoError, setRepoError] = useState('')
  const [version, setVersion] = useState('')
  const [bootError, setBootError] = useState('')
  const [view, setView] = useState<View>('panel')
  const [projectMenu, setProjectMenu] = useState(false)
  const [pathDialog, setPathDialog] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [editor, setEditor] = useState<CommandEditor | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diffStaged, setDiffStaged] = useState(true)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffError, setDiffError] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState<LogFilter>('all')
  const [logSearch, setLogSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [pushRemote, setPushRemote] = useState('')
  const [pushBranch, setPushBranch] = useState('')
  const [shortcut, setShortcut] = useState('')
  const [now, setNow] = useState(Date.now())
  const activeProjectId = config?.activeProjectId ?? null
  const activeProject = config?.projects.find(project => project.id === activeProjectId) ?? null
  const activeIdRef = useRef(activeProjectId)
  const configRef = useRef(config)
  const refreshSequence = useRef(0)
  const diffSequence = useRef(0)
  const logRef = useRef<HTMLPreElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const completedNotices = useRef(new Set<string>())
  const pendingCommit = useRef<{ projectId: string; message: string } | null>(null)
  activeIdRef.current = activeProjectId
  configRef.current = config

  const notify = useCallback((text: string, error = false) => setToast({ id: Date.now(), text, error }), [])
  const execute = useCallback(async <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    try { return await action() } catch (error) { notify(getError(error), true); return undefined }
    finally { setBusy(current => current === key ? null : current) }
  }, [notify])
  const updateRuns = useCallback((run: RunRecord) => {
    setRuns(current => {
      const previous = current.find(item => item.id === run.id)
      // An IPC event can finish a task before the invocation returns its initial snapshot.
      if (previous && run.status === 'running' && (previous.status !== 'running' || previous.output.length > run.output.length)) return current
      return [run, ...current.filter(item => item.id !== run.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    })
  }, [])
  const refreshRepo = useCallback(async (projectId: string, visible = false) => {
    const sequence = ++refreshSequence.current
    if (visible) setRefreshing(true)
    try {
      const next = await api.repoStatus(projectId)
      if (sequence !== refreshSequence.current || activeIdRef.current !== projectId) return
      setRepo(next)
      setRepoError(next.error || '')
    } catch (error) {
      if (sequence === refreshSequence.current && activeIdRef.current === projectId) setRepoError(getError(error))
    } finally { if (sequence === refreshSequence.current) setRefreshing(false) }
  }, [])

  useEffect(() => {
    if (!api) { setBootError('桌面连接尚未就绪。请通过 DevDock 应用启动，而不是直接打开网页。'); return }
    let alive = true
    api.bootstrap().then(data => {
      if (!alive) return
      setConfig(data.config); setRuns(data.runs); setVersion(data.version)
      setShortcut(displayShortcut(data.config.settings.shortcut))
      for (const run of data.runs) if (run.status !== 'running') completedNotices.current.add(run.id)
      if (data.startupWarning) notify(data.startupWarning, true)
    }).catch(error => { if (alive) setBootError(getError(error)) })
    const offConfig = api.onConfig(next => { if (alive) setConfig(next) })
    const offRun = api.onRun(run => {
      if (!alive) return
      updateRuns(run)
      if (run.status !== 'running' && !completedNotices.current.has(run.id)) {
        completedNotices.current.add(run.id)
        if (run.projectId === activeIdRef.current) {
          notify(`${run.label} · ${STATUS_LABEL[run.status]}`, run.status === 'failed' || run.status === 'interrupted')
          void refreshRepo(run.projectId)
        }
        if (run.kind === 'git' && run.label === 'Commit' && pendingCommit.current?.projectId === run.projectId) {
          const submitted = pendingCommit.current
          if (run.status === 'success' && activeIdRef.current === submitted.projectId) setCommitMessage(current => current === submitted.message ? '' : current)
          pendingCommit.current = null
        }
      }
    })
    const offRepo = api.onRepoChanged(id => { if (alive && id === activeIdRef.current) void refreshRepo(id) })
    return () => { alive = false; offConfig(); offRun(); offRepo() }
  }, [notify, refreshRepo, updateRuns])

  useEffect(() => {
    setRepo(null); setRepoError(''); setSelectedFile(null); setDiff(null); setCommitMessage('')
    if (!activeProjectId) return
    void refreshRepo(activeProjectId, true)
    const timer = setInterval(() => void refreshRepo(activeProjectId), 5000)
    return () => { clearInterval(timer); refreshSequence.current++ }
  }, [activeProjectId, refreshRepo])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), toast.error ? 9000 : 4200)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (!toast?.error || !config?.settings.compact) return
    // Errors need readable space. Routine success notices should never cover compact controls.
    void api.saveSettings({ compact: false }).then(setConfig).catch(() => {})
  }, [toast, config?.settings.compact])
  useEffect(() => {
    if (!runs.some(run => run.status === 'running')) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runs.some(run => run.status === 'running')])
  useEffect(() => {
    if (config?.settings.shortcut) setShortcut(displayShortcut(config.settings.shortcut))
  }, [config?.settings.shortcut])
  useEffect(() => {
    if (!config?.settings.compact) return
    setView('panel'); setProjectMenu(false); setPathDialog(false); setEditor(null)
  }, [config?.settings.compact])
  useEffect(() => {
    const close = (event: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) setProjectMenu(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  useEffect(() => {
    if (!editor && !pathDialog) return
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
      const controls = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')
      if (!controls?.length) return
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', containFocus)
    return () => document.removeEventListener('keydown', containFocus)
  }, [editor, pathDialog])

  const saveSettings = async (settings: Partial<AppSettings>) => {
    const next = await execute('settings', () => api.saveSettings(settings))
    if (next) setConfig(next)
    return next
  }
  const openView = useCallback(async (next: View) => {
    setProjectMenu(false)
    try {
      if (configRef.current?.settings.compact) setConfig(await api.saveSettings({ compact: false }))
      await api.windowAction(next === 'panel' ? 'panel' : 'expand')
      setView(next)
    } catch (error) { notify(getError(error), true) }
  }, [notify])
  const closeView = useCallback(() => void openView('panel'), [openView])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (editor) setEditor(null)
      else if (pathDialog) setPathDialog(false)
      else if (projectMenu) setProjectMenu(false)
      else if (view !== 'panel') closeView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, pathDialog, projectMenu, view, closeView])

  useEffect(() => {
    if (view !== 'commit' || !activeProjectId || !selectedFile) { setDiff(null); return }
    const sequence = ++diffSequence.current
    setDiffLoading(true); setDiffError('')
    api.gitDiff(activeProjectId, selectedFile, diffStaged).then(next => {
      if (sequence === diffSequence.current) setDiff(next)
    }).catch(error => { if (sequence === diffSequence.current) { setDiff(null); setDiffError(getError(error)) } })
      .finally(() => { if (sequence === diffSequence.current) setDiffLoading(false) })
    return () => { diffSequence.current++ }
  }, [view, activeProjectId, selectedFile, diffStaged, repo?.fingerprint])
  useEffect(() => {
    if (!repo?.files.length) { setSelectedFile(null); return }
    if (!selectedFile || !repo.files.some(file => file.path === selectedFile)) {
      setSelectedFile(repo.files[0].path); setDiffStaged(isStaged(repo.files[0]))
    }
  }, [repo?.files, selectedFile])

  const projectRuns = runs.filter(run => run.projectId === activeProjectId)
  const runningRuns = projectRuns.filter(run => run.status === 'running')
  const gitRunning = runningRuns.some(run => run.kind === 'git')
  const testCommand = activeProject?.commands.find(command => command.kind === 'test')
  const testRun = testCommand ? projectRuns.find(run => run.commandId === testCommand.id) : undefined
  const latestTest = projectRuns.find(run => run.kind === 'test')
  const testExpired = !!(latestTest?.status === 'success' && latestTest.fingerprint && repo?.fingerprint && latestTest.fingerprint !== repo.fingerprint)
  const stagedFiles = repo?.files.filter(isStaged) ?? []
  const filteredRuns = projectRuns.filter(run => (logFilter === 'all' || run.status === logFilter) && (!logSearch || `${run.label} ${run.command}`.toLowerCase().includes(logSearch.toLowerCase())))
  const displayedRun = filteredRuns.find(run => run.id === selectedRun) ?? filteredRuns[0]
  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [displayedRun?.id, displayedRun?.output, autoScroll, view])

  const chooseProject = async () => {
    setProjectMenu(false)
    const next = await execute('choose-project', () => api.chooseProject())
    if (next) { setConfig(next); setPathDialog(false); setPathInput('') }
  }
  const selectProject = async (id: string) => {
    setProjectMenu(false)
    const next = await execute('select-project', () => api.selectProject(id))
    if (next) setConfig(next)
  }
  const addByPath = async (event: FormEvent) => {
    event.preventDefault()
    if (!pathInput.trim()) return
    const next = await execute('add-project', () => api.addProject(pathInput.trim()))
    if (next) { setConfig(next); setPathDialog(false); setPathInput('') }
  }
  const removeProject = async (project: Project) => {
    if (!window.confirm(`从 DevDock 移除「${project.name}」？\n磁盘上的项目文件不会被删除。`)) return
    const next = await execute('remove-project', () => api.removeProject(project.id))
    if (next) { setConfig(next); notify('已移除项目，磁盘文件保持不变') }
  }
  const showEditor = async (command?: CommandConfig, kind: CommandKind = 'custom') => {
    if (!activeProject) return
    if (config?.settings.compact) {
      const next = await saveSettings({ compact: false })
      if (!next) return
    }
    setEditor({ projectId: activeProject.id, command: command ? { ...command } : newCommand(kind), isNew: !command })
  }
  const runCommand = async (command: CommandConfig) => {
    if (!activeProject) return
    const existing = runningRuns.find(run => run.commandId === command.id)
    if (existing) { await execute(`stop-${existing.id}`, () => api.stopRun(existing.id)); return }
    const run = await execute(`run-${command.id}`, () => api.runCommand(activeProject.id, command.id))
    if (run) { updateRuns(run); setSelectedRun(run.id) }
  }
  const runTest = () => {
    if (testCommand) void runCommand(testCommand)
    else showEditor(undefined, 'test')
  }
  const showLogs = (run?: RunRecord) => {
    if (run) setSelectedRun(run.id)
    setLogFilter('all'); setLogSearch(''); void openView('logs')
  }
  const toggleStage = async (file: GitFile) => {
    if (!activeProject) return
    const id = activeProject.id
    const next = await execute(`stage-${file.path}`, () => api.gitStage(id, [file.path], !isStaged(file)))
    if (next && activeIdRef.current === id) { setRepo(next); setSelectedFile(file.path); setDiffStaged(!isStaged(file)) }
  }
  const commit = async () => {
    if (!activeProject || !repo || !stagedFiles.length || !commitMessage.trim()) return
    pendingCommit.current = { projectId: activeProject.id, message: commitMessage }
    const run = await execute('commit', () => api.gitCommit(activeProject.id, commitMessage.trim(), repo.fingerprint))
    if (run) {
      updateRuns(run)
      if (run.status === 'success') setCommitMessage(current => current === pendingCommit.current?.message ? '' : current)
      showLogs(run)
    } else pendingCommit.current = null
  }
  const openPush = () => {
    if (!repo) return
    setPushRemote(repo.remotes.some(remote => remote.name === 'origin') ? 'origin' : repo.remotes[0]?.name ?? '')
    setPushBranch(repo.branch === 'HEAD' ? '' : repo.branch)
    void openView('push')
  }
  const push = async () => {
    if (!activeProject || !repo) return
    const run = await execute('push', () => api.gitPush(activeProject.id, repo.upstream ? undefined : { remote: pushRemote, branch: pushBranch.trim(), setUpstream: true }))
    if (run) { updateRuns(run); showLogs(run) }
  }
  const fetchRemote = async () => {
    if (!activeProject) return
    const run = await execute('fetch', () => api.gitFetch(activeProject.id))
    if (run) { updateRuns(run); showLogs(run) }
  }
  const toggleCompact = async () => {
    const next = await saveSettings({ compact: !config?.settings.compact })
    if (next) { setView('panel'); setProjectMenu(false) }
  }
  const copy = async (value: string) => {
    const result = await execute('copy', async () => { await api.copyText(value); return true })
    if (result) notify('已复制到剪贴板')
  }

  if (bootError) return <div className="boot-error"><Brand /><h1>DevDock 未能启动</h1><p>{bootError}</p><button className="button primary" onClick={() => location.reload()}>重新连接</button></div>
  if (!config) return <div className="boot-loading"><Brand /><span>DevDock</span><LoaderCircle size={18} className="spin" /></div>

  const compact = config.settings.compact && view === 'panel'
  const topActions = <>
    <IconButton title={config.settings.alwaysOnTop ? '取消置顶' : '窗口置顶'} active={config.settings.alwaysOnTop} onClick={() => void saveSettings({ alwaysOnTop: !config.settings.alwaysOnTop })}><Pin size={14} /></IconButton>
    <IconButton title={compact ? '展开面板' : '收起为工具条'} onClick={() => void toggleCompact()}>{compact ? <Expand size={14} /> : <Minus size={15} />}</IconButton>
    {!compact && <IconButton title="设置" active={view === 'settings'} onClick={() => void openView(view === 'settings' ? 'panel' : 'settings')}><Settings2 size={15} /></IconButton>}
    <IconButton title="隐藏到系统托盘" onClick={() => void execute('hide', () => api.windowAction('hide'))}><X size={15} /></IconButton>
  </>
  const projectSelect = <div className="project-switcher no-drag" ref={menuRef}>
    <button className={`project-select ${projectMenu ? 'open' : ''}`} onClick={() => {
      if (compact) void saveSettings({ compact: false }).then(next => { if (next) setProjectMenu(true) })
      else setProjectMenu(!projectMenu)
    }} title={activeProject?.path || '选择项目'} aria-expanded={projectMenu} aria-label="切换项目">
      {compact ? <Folder size={14} /> : <span className="project-icon"><Folder size={18} /></span>}
      <span className="project-name">{activeProject?.name || '选择项目'}</span><ChevronDown size={14} />
    </button>
    {projectMenu && <div className="project-menu">
      <div className="menu-label">工作项目</div>
      {config.projects.length === 0 && <p className="menu-empty">还没有添加项目</p>}
      {config.projects.map(project => <button className="project-option" key={project.id} onClick={() => void selectProject(project.id)}>
        <Folder size={15} /><span><strong>{project.name}</strong><small title={project.path}>{project.path}</small></span>{project.id === activeProjectId && <Check size={15} />}
      </button>)}
      <div className="menu-divider" /><button className="menu-action" onClick={() => void chooseProject()}><Plus size={15} />添加项目文件夹</button>
      <button className="menu-action" onClick={() => { setProjectMenu(false); setPathDialog(true) }}><Terminal size={15} />输入项目路径</button>
    </div>}
  </div>

  return <div className={`app ${compact ? 'compact' : ''} ${view !== 'panel' ? 'expanded' : ''}`}>
    {compact ? <div className="compact-bar drag-region">
      <GripVertical size={13} className="drag-grip" /><Brand small />
      {projectSelect}<span className="compact-separator" />
      <button className="compact-action no-drag" disabled={!activeProject || !!busy} onClick={runTest} title={testRun?.status === 'running' ? '停止测试' : '运行测试'}>{testRun?.status === 'running' ? <LoaderCircle size={14} className="spin" /> : <Play size={13} />}<span>Test</span></button>
      <button className="compact-action no-drag" disabled={!repo?.isRepo || !!busy} onClick={() => void openView('commit')} title="审阅并提交"><GitCommitHorizontal size={15} /><span>Commit</span>{!!repo?.files.length && <i>{repo.files.length}</i>}</button>
      <button className="compact-action no-drag" disabled={!repo?.isRepo || !!busy} onClick={openPush} title={repo?.upstream ? `推送到 ${repo.upstream}` : '设置推送目标'}><ArrowUp size={14} /><span>Push</span></button>
      <div className="window-actions compact-window-actions">{topActions}</div>
    </div> : <>
      <header className="titlebar drag-region">
        <div className="brand"><Brand /><span>DevDock</span><span className="brand-tag">YOUR DEV SHORTCUT</span></div>
        <div className="window-actions">{topActions}</div>
      </header>
      {view === 'panel' ? <main className={`panel ${!activeProject ? 'welcome-panel' : ''}`}>
        {!activeProject ? <>
          <div className="welcome-visual"><div className="welcome-orbit orbit-one" /><div className="welcome-orbit orbit-two" /><span className="welcome-center"><Terminal size={34} strokeWidth={1.5} /></span><span className="welcome-node node-test"><Check size={15} /></span><span className="welcome-node node-git"><GitBranch size={16} /></span><span className="welcome-node node-run"><Play size={13} fill="currentColor" /></span></div>
          <div className="eyebrow">LESS TYPING. MORE BUILDING.</div>
          <h1>你的开发工作，<br /><span>一键就绪。</span></h1>
          <p className="welcome-description">测试、提交、推送，还有你的常用命令。<br />把它们放进一个随手可用的小面板。</p>
          <button data-testid="add-project-button" className="button primary welcome-button" onClick={() => void chooseProject()} disabled={!!busy}>{busy === 'choose-project' ? <LoaderCircle size={17} className="spin" /> : <FolderOpen size={17} />}选择项目文件夹<ArrowRight size={16} /></button>
          <button className="text-button" onClick={() => setPathDialog(true)}>或手动输入路径<ChevronRight size={13} /></button>
          <div className="welcome-hint"><ShieldCheck size={13} />命令在本机运行，项目保留在原来的位置</div>
        </> : <>
          <section className="project-section">
            <div className="section-label">当前工作项目<span className="local-badge"><span />LOCAL</span></div>
            <div className="project-heading">{projectSelect}<IconButton title="打开项目文件夹" onClick={() => void execute('open-folder', () => api.openFolder(activeProject.id))}><ArrowUpRight size={17} /></IconButton></div>
            <div className="project-path" title={activeProject.path}>{activeProject.path}</div>
            <div className="repo-chips">
              {repo?.isRepo ? <>
                <span className="chip branch-chip" title={repo.branch}><GitBranch size={13} />{repo.branch}</span>
                <button className={`chip ${repo.files.length ? 'changes-chip' : ''}`} onClick={() => void openView('commit')}><span className={repo.files.length ? 'dot amber' : 'dot green'} />{repo.files.length ? `${repo.files.length} 个改动` : '工作区干净'}</button>
                {repo.upstream ? <button className="chip" onClick={openPush} title={`上游 ${repo.upstream} · 刷新后更新`}><ArrowUp size={12} />{repo.ahead}<ArrowDown size={12} />{repo.behind}</button> : <button className="chip" onClick={openPush}>未关联上游</button>}
              </> : <span className="chip muted">{repo ? '普通文件夹 · 可运行命令' : refreshing ? '正在检查项目…' : 'Git 状态不可用'}</span>}
              <button data-testid="git-setup-open" className="chip setup-entry-chip" onClick={() => void openView('git-setup')}><Settings2 size={12} />{repo && !repo.isRepo ? '初始化 Git' : '仓库与账号'}</button>
              <IconButton title="刷新本地状态" disabled={refreshing} onClick={() => void refreshRepo(activeProject.id, true)} className="refresh-button"><RefreshCw size={13} className={refreshing ? 'spin' : ''} /></IconButton>
            </div>
          </section>
          {repoError && <div className="inline-warning"><TriangleAlert size={14} /><span>{repoError}</span></div>}
          {repo?.mergeInProgress && <div className="inline-warning"><GitBranch size={14} /><span>正在合并分支。解决冲突后再提交。</span></div>}
          <section className="primary-actions" aria-label="开发操作">
            <button data-testid="test-button" className={`action-card test-card ${testRun?.status === 'running' ? 'is-running' : ''}`} disabled={!!busy} onClick={runTest}>
              <span className="action-icon">{testRun?.status === 'running' ? <LoaderCircle size={24} className="spin" /> : <Play size={24} strokeWidth={1.8} />}</span><strong>{testRun?.status === 'running' ? 'Stop' : 'Test'}</strong><small>{testRun?.status === 'running' ? '停止测试' : testCommand ? '运行测试' : '配置测试'}</small><span className="action-key">01</span>
            </button>
            <button data-testid="commit-button" className="action-card commit-card" disabled={!repo?.isRepo || !!busy || gitRunning} onClick={() => void openView('commit')} title={!repo?.isRepo ? '需要 Git 仓库' : '查看差异，选择暂存内容并提交'}>
              <span className="action-icon"><GitCommitHorizontal size={27} strokeWidth={1.7} /></span><strong>Commit</strong><small>审阅并提交</small><span className="action-key">02</span>
            </button>
            <button data-testid="push-button" className="action-card push-card" disabled={!repo?.isRepo || !!busy || gitRunning} onClick={openPush} title={!repo?.isRepo ? '需要 Git 仓库' : repo.upstream ? `推送到 ${repo.upstream}` : '配置推送目标'}>
              <span className="action-icon"><ArrowUp size={26} strokeWidth={1.8} /></span><strong>Push</strong><small>{gitRunning ? 'Git 处理中' : repo?.ahead ? `${repo.ahead} 个待推送` : '推送到远程'}</small><span className="action-key">03</span>
            </button>
          </section>
          <section className="commands-section">
            <div className="section-label">快捷命令<button className="subtle-link" onClick={() => void openView('settings')}>管理<ChevronRight size={12} /></button></div>
            <div className="command-buttons">
              {activeProject.commands.filter(command => command.id !== testCommand?.id).map(command => {
                const running = runningRuns.find(run => run.commandId === command.id)
                return <button className={`command-button ${running ? 'running' : ''}`} key={command.id} disabled={!!busy} onClick={() => void runCommand(command)} onContextMenu={event => { event.preventDefault(); showEditor(command) }} title={`${command.command}${running ? '\n点击停止' : '\n右键编辑'}`}>
                  {running ? <Square size={12} /> : <CommandIcon kind={command.kind} size={14} />}<span>{command.name}</span>{running && <span className="dot green pulse" />}
                </button>
              })}
              <button className="command-button add-command" onClick={() => showEditor()} title="添加自定义命令"><Plus size={15} />{activeProject.commands.filter(command => command.id !== testCommand?.id).length === 0 && <span>添加命令</span>}</button>
            </div>
          </section>
          <section className={`test-summary ${latestTest?.status === 'running' ? 'running' : testExpired ? 'expired' : latestTest?.status ?? ''}`}>
            <span className="test-status-icon">{testExpired ? <Clock3 size={18} /> : latestTest ? <RunIcon status={latestTest.status} size={18} /> : <ShieldCheck size={18} />}</span>
            <div><strong>{!latestTest ? '准备好，运行第一次测试' : testExpired ? '代码已变化，测试结果已过期' : latestTest.status === 'running' ? '正在执行测试…' : `上次测试${latestTest.status === 'success' ? '通过' : latestTest.status === 'failed' ? '失败' : STATUS_LABEL[latestTest.status]}`}</strong><small>{latestTest ? `${timeLabel(latestTest.startedAt)} · ${duration(latestTest, now)}${latestTest.fingerprint ? '' : ' · 历史结果'}` : '添加测试命令后，点击 Test 即可开始'}</small></div>
            {latestTest && <button className="subtle-link" onClick={() => showLogs(latestTest)}>日志<ChevronRight size={13} /></button>}
          </section>
          <section className="recent-section">
            <div className="section-label">最近活动<button className="subtle-link" onClick={() => showLogs()}>全部记录<ArrowUpRight size={12} /></button></div>
            {projectRuns.length ? <div className="recent-list">{projectRuns.slice(0, 3).map(run => <button key={run.id} className="recent-row" onClick={() => showLogs(run)}><span className={`run-status ${run.status}`}><RunIcon status={run.status} size={13} /></span><strong>{run.label}</strong><span className={`recent-status ${run.status}`}>{STATUS_LABEL[run.status]}</span><time>{timeLabel(run.startedAt)}</time></button>)}</div> : <div className="no-activity"><span className="dashed-line" />你的下一次操作，会记录在这里<span className="dashed-line" /></div>}
          </section>
        </>}
      </main> : <main className="workspace">
        <div className="workspace-heading">
          <div className="workspace-title"><IconButton title="返回悬浮面板" onClick={closeView}><ArrowLeft size={17} /></IconButton><h1>{VIEW_LABEL[view]}</h1><span className="workspace-project">{activeProject?.name || 'DevDock'}{repo?.isRepo && <><span>/</span><GitBranch size={12} />{repo.branch}</>}</span></div>
          <button className="subtle-link" onClick={closeView}>返回面板<ChevronsLeftRight size={14} /></button>
        </div>
        {view === 'commit' && <>
          {!repo?.isRepo ? <EmptyNote icon={<GitBranch size={26} />} title="当前项目不是 Git 仓库">选择一个已有 Git 仓库后，即可审阅并提交改动。</EmptyNote> : <div className="commit-layout">
            <aside className="files-pane">
              <div className="pane-heading"><span>改动文件 <b>{repo.files.length}</b></span><IconButton title="刷新改动" disabled={refreshing} onClick={() => activeProject && void refreshRepo(activeProject.id, true)}><RefreshCw size={13} className={refreshing ? 'spin' : ''} /></IconButton></div>
              <p className="pane-hint">勾选暂存整个文件；取消勾选移出暂存区。</p>
              <div className="files-list">{repo.files.length ? repo.files.map(file => <div key={file.path} className={`file-row ${selectedFile === file.path ? 'selected' : ''}`}>
                <input type="checkbox" checked={isStaged(file)} disabled={!!busy || gitRunning} onChange={() => void toggleStage(file)} aria-label={`${isStaged(file) ? '取消暂存' : '暂存'} ${file.path}`} title={isStaged(file) && file.worktreeStatus !== ' ' ? '已有暂存内容，工作区还有额外改动；取消勾选将取消暂存' : isStaged(file) ? '取消暂存' : '暂存文件'} />
                <button className="file-select" onClick={() => { setSelectedFile(file.path); setDiffStaged(isStaged(file)) }} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}>
                  <FileCode2 size={14} /><span><strong>{filename(file.path)}</strong><small>{shortPath(file.path)}</small></span><span className={`file-state ${file.conflicted ? 'conflict' : file.untracked ? 'new' : ''}`}>{file.conflicted ? '!' : file.untracked ? 'U' : `${file.indexStatus.trim()}${file.worktreeStatus.trim()}`}</span>
                </button>
              </div>) : <div className="files-empty"><CheckCircle2 size={23} /><span>工作区干净</span></div>}</div>
              <div className="staged-count"><span className="dot violet" />{stagedFiles.length} 个文件已暂存{repo.files.some(file => file.conflicted) && <span className="danger-text">存在冲突</span>}</div>
            </aside>
            <section className="diff-pane">
              <div className="diff-heading"><span className="diff-path" title={selectedFile || ''}><FileDiff size={14} />{selectedFile || '选择文件查看差异'}</span><div className="segmented-control"><button className={diffStaged ? 'selected' : ''} onClick={() => setDiffStaged(true)}>已暂存</button><button className={!diffStaged ? 'selected' : ''} onClick={() => setDiffStaged(false)}>工作区</button></div></div>
              <div className="diff-content">
                {diffLoading ? <div className="center-message"><LoaderCircle size={20} className="spin" />读取差异…</div> : diffError ? <EmptyNote icon={<TriangleAlert size={24} />} title="无法读取差异">{diffError}</EmptyNote> : !selectedFile ? <EmptyNote icon={<CheckCircle2 size={27} />} title="没有需要提交的改动">修改项目文件后，改动会显示在这里。</EmptyNote> : diff?.binary ? <EmptyNote icon={<FileCode2 size={27} />} title="二进制文件">此文件不能显示文本差异，仍然可以暂存并提交。</EmptyNote> : !diff?.text ? <EmptyNote icon={<FileDiff size={25} />} title={diffStaged ? '此文件没有已暂存差异' : '此文件没有工作区差异'}>{diffStaged ? '切换到工作区查看尚未暂存的改动。' : '切换到已暂存查看将被提交的内容。'}</EmptyNote> : <pre className="diff-code">{diff.text.split('\n').map((line, index) => <span key={index} className={line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'diff-meta' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line || ' '}{'\n'}</span>)}</pre>}
              </div>
              <div className="commit-form">
                <label htmlFor="commit-message">提交说明<span>只提交当前暂存区内容</span></label>
                <button className="subtle-link commit-identity-link" onClick={() => void openView('git-setup')}>配置提交姓名与邮箱<ChevronRight size={12} /></button>
                <textarea id="commit-message" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} placeholder="描述这次改动，例如：feat: 添加项目切换" rows={3} maxLength={10000} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && stagedFiles.length && !busy && !gitRunning && !repo.files.some(file => file.conflicted)) { event.preventDefault(); void commit() } }} />
                <div className="commit-footer"><span><Info size={13} />提交保存在本地，推送需单独执行</span><button className="button primary" disabled={!stagedFiles.length || !commitMessage.trim() || !!busy || gitRunning || repo.files.some(file => file.conflicted)} onClick={() => void commit()}>{busy === 'commit' ? <LoaderCircle size={15} className="spin" /> : <GitCommitHorizontal size={17} />}提交 {stagedFiles.length || ''} 个文件</button></div>
              </div>
            </section>
          </div>}
        </>}
        {view === 'logs' && <div className="logs-layout">
          <aside className="history-pane">
            <div className="pane-heading"><span>操作历史 <b>{projectRuns.length}</b></span><IconButton title="清除已结束的历史记录" disabled={!projectRuns.some(run => run.status !== 'running') || !!busy} onClick={() => {
              if (!activeProject || !window.confirm('清除当前项目已结束的操作记录？正在运行的任务会保留。')) return
              void execute('clear-history', async () => { await api.clearHistory(activeProject.id); setRuns(current => current.filter(run => run.projectId !== activeProject.id || run.status === 'running')); notify('历史记录已清除') })
            }}><Trash2 size={13} /></IconButton></div>
            <div className="history-tools"><input className="search-input" placeholder="查找命令…" value={logSearch} onChange={event => setLogSearch(event.target.value)} aria-label="查找历史命令" /><div className="segmented-control"><button className={logFilter === 'all' ? 'selected' : ''} onClick={() => setLogFilter('all')}>全部</button><button className={logFilter === 'running' ? 'selected' : ''} onClick={() => setLogFilter('running')}>运行中</button><button className={logFilter === 'failed' ? 'selected' : ''} onClick={() => setLogFilter('failed')}>失败</button></div></div>
            <div className="history-list">{filteredRuns.length ? filteredRuns.map(run => <button key={run.id} className={`history-row ${displayedRun?.id === run.id ? 'selected' : ''}`} onClick={() => setSelectedRun(run.id)}><span className={`run-status ${run.status}`}><RunIcon status={run.status} size={16} /></span><span><strong>{run.label}</strong><small>{new Date(run.startedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} · {timeLabel(run.startedAt)}</small></span><span className={`history-status ${run.status}`}>{STATUS_LABEL[run.status]}</span></button>) : <div className="history-empty">{projectRuns.length ? '没有符合条件的记录' : '运行命令后，会在这里留下记录'}</div>}</div>
          </aside>
          <section className="output-pane">{displayedRun ? <>
            <div className="output-heading"><div><span className={`status-label ${displayedRun.status}`}><RunIcon status={displayedRun.status} size={13} />{STATUS_LABEL[displayedRun.status]}</span><strong>{displayedRun.label}</strong></div><div className="output-actions">{displayedRun.status === 'running' && displayedRun.kind !== 'git' && <button className="button small danger" disabled={!!busy} onClick={() => void execute(`stop-${displayedRun.id}`, () => api.stopRun(displayedRun.id))}><Square size={12} />停止</button>}<IconButton title="复制完整日志" onClick={() => void copy(displayedRun.output)}><Copy size={14} /></IconButton></div></div>
            <div className="command-detail"><div><Terminal size={13} /><code>{displayedRun.command}</code></div><div><Folder size={13} /><span>{displayedRun.cwd}</span></div></div>
            <pre className="terminal-output" ref={logRef}>{displayedRun.output || (displayedRun.status === 'running' ? '等待进程输出…' : '此操作没有输出。')}{displayedRun.status === 'running' && <span className="terminal-cursor" />}</pre>
            <div className="output-footer"><span>{duration(displayedRun, now)}{displayedRun.exitCode != null ? ` · 退出码 ${displayedRun.exitCode}` : ''}</span><label><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />自动滚动</label></div>
          </> : <EmptyNote icon={<Terminal size={28} />} title="每一次运行，都有迹可循">运行测试、自定义命令或 Git 操作后，在这里查看完整输出。</EmptyNote>}</section>
        </div>}
        {view === 'push' && <div className="push-view"><div className="push-visual"><Upload size={29} strokeWidth={1.6} /></div><div className="eyebrow">LOCAL → REMOTE</div><h2>把你的改动，推送到远程。</h2><p className="push-description">只推送已提交的内容。尚未提交的文件不会上传。</p>
          {repo?.isRepo ? <div className="push-card-content">
            <div className="push-source"><span className="section-label">本地分支</span><strong><GitBranch size={16} />{repo.branch}</strong><span className="push-head">{repo.head?.slice(0, 7) || '尚无提交'}</span></div>
            {repo.upstream ? <><div className="push-target"><ArrowDown size={18} /><div><span className="section-label">远程目标</span><strong>{repo.upstream}</strong></div><span className="chip">{repo.ahead} 个待推送</span></div><div className="sync-note"><Info size={13} /><span>与上次获取的远程状态比较。{repo.behind > 0 ? `远程领先 ${repo.behind} 个提交，请先同步。` : '可先获取远程状态，确认最新差异。'}</span><button className="subtle-link" disabled={!!busy || gitRunning} onClick={() => void fetchRemote()}>获取状态<RefreshCw size={12} /></button></div></> : <>
              <div className="first-push-note"><Info size={14} />首次推送，请选择远程仓库和目标分支。</div>
              <div className="push-fields"><label>远程仓库<select value={pushRemote} onChange={event => setPushRemote(event.target.value)} disabled={!repo.remotes.length}><option value="" disabled>选择远程仓库</option>{repo.remotes.map(remote => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select></label><label>目标分支<input value={pushBranch} onChange={event => setPushBranch(event.target.value)} placeholder="例如 main" /></label></div>
              {pushRemote && <p className="remote-url" title={repo.remotes.find(remote => remote.name === pushRemote)?.pushUrl || repo.remotes.find(remote => remote.name === pushRemote)?.url}>{repo.remotes.find(remote => remote.name === pushRemote)?.pushUrl || repo.remotes.find(remote => remote.name === pushRemote)?.url}</p>}
              {!repo.remotes.length && <div className="inline-warning push-setup-note"><TriangleAlert size={15} /><span>此项目还没有远程仓库。</span><button className="subtle-link" onClick={() => void openView('git-setup')}>连接或创建仓库<ChevronRight size={12} /></button></div>}
              <p className="field-hint">成功后会关联上游分支，下次直接使用同一目标。</p>
            </>}
            {!!repo.remotes.length && <div className="push-manage-remote"><button className="subtle-link" onClick={() => void openView('git-setup')}><Settings2 size={12} />管理远程与登录账号<ChevronRight size={12} /></button></div>}
            {repo.files.length > 0 && <div className="uncommitted-note"><FileDiff size={14} />还有 {repo.files.length} 个本地文件改动，不包含在这次推送中。<button className="subtle-link" onClick={() => void openView('commit')}>查看</button></div>}
            <button className="button primary push-submit" disabled={!!busy || gitRunning || !repo.head || (!repo.upstream && (!pushRemote || !pushBranch.trim()))} onClick={() => void push()}>{busy === 'push' ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}{repo.upstream ? `推送到 ${repo.upstream}` : '推送并关联上游'}</button>
          </div> : <EmptyNote icon={<GitBranch size={25} />} title="请选择一个 Git 仓库" />}
        </div>}
        {view === 'git-setup' && <GitSetup key={activeProjectId ?? 'no-project'} project={activeProject} repo={repo} gitRunning={gitRunning} onChanged={id => refreshRepo(id, true)} />}
        {view === 'settings' && <div className="settings-scroll"><div className="settings-layout">
          <button className="settings-git-entry" onClick={() => void openView('git-setup')}><span><GitBranch size={21} /></span><div><strong>仓库与账号</strong><small>Git 初始化、提交身份、GitHub 登录与远程仓库管理</small></div><ChevronRight size={17} /></button>
          <section className="settings-section"><div className="settings-section-title"><Settings2 size={17} /><div><h2>面板偏好</h2><p>随手可用，也随时可以收起。</p></div></div>
            <SettingToggle icon={<Pin size={16} />} title="始终置顶" description="让面板显示在其他窗口上方" checked={config.settings.alwaysOnTop} onChange={() => void saveSettings({ alwaysOnTop: !config.settings.alwaysOnTop })} />
            <SettingToggle icon={<Bell size={16} />} title="完成通知" description="任务结束后显示系统通知" checked={config.settings.notifications} onChange={() => void saveSettings({ notifications: !config.settings.notifications })} />
            <div className="setting-row shortcut-setting"><Keyboard size={16} /><div><strong>唤出 / 隐藏快捷键</strong><small>例如 Ctrl+Alt+D；修改后点击保存</small><div className="shortcut-input"><input aria-label="全局快捷键" value={shortcut} onChange={event => setShortcut(event.target.value)} spellCheck={false} /><button className="button small" disabled={!!busy || shortcut.trim() === displayShortcut(config.settings.shortcut)} onClick={() => void saveSettings({ shortcut: shortcut.trim() }).then(next => { if (next) notify('快捷键已保存') })}>保存</button></div></div></div>
            <div className="settings-note"><Info size={14} /><span>点击右上角 × 会隐藏到系统托盘，任务继续运行。可通过托盘或快捷键重新打开。</span></div>
          </section>
          <section className="settings-section"><div className="settings-section-title"><Folder size={17} /><div><h2>工作项目</h2><p>配置按项目保存，移除项目不会删除文件。</p></div><button className="button small" disabled={!!busy} onClick={() => void chooseProject()}><Plus size={14} />添加</button></div>
            {config.projects.length ? <div className="settings-projects">{config.projects.map(project => <div className={`settings-project-row ${project.id === activeProjectId ? 'selected' : ''}`} key={project.id}><Folder size={17} /><button onClick={() => void selectProject(project.id)} title={project.path}><strong>{project.name}{project.id === activeProjectId && <span className="tiny-tag">当前</span>}</strong><small>{project.path}</small></button><IconButton title={`移除项目 ${project.name}`} disabled={!!busy || runs.some(run => run.projectId === project.id && run.status === 'running')} onClick={() => void removeProject(project)}><Trash2 size={14} /></IconButton></div>)}</div> : <p className="settings-empty">添加项目后，可以配置专属的开发按钮。</p>}
          </section>
          <section className="settings-section commands-settings"><div className="settings-section-title"><Terminal size={17} /><div><h2>快捷命令</h2><p>{activeProject ? `${activeProject.name} 的命令配置。运行环境继承桌面应用。` : '先添加项目，再配置快捷命令。'}</p></div><button className="button small" disabled={!activeProject} onClick={() => showEditor()}><Plus size={14} />添加</button></div>
            {activeProject?.commands.length ? <div className="settings-command-list">{activeProject.commands.map(command => <div className="settings-command-row" key={command.id}><span className="settings-command-icon"><CommandIcon kind={command.kind} size={17} /></span><button className="command-edit" onClick={() => showEditor(command)}><strong>{command.name}<span className="tiny-tag">{KIND_LABEL[command.kind]}</span></strong><code>{command.command}</code><small>{command.cwd || activeProject.path}</small></button><button className="subtle-link" onClick={() => showEditor(command)}>编辑</button><IconButton title={`删除命令 ${command.name}`} disabled={!!busy || runningRuns.some(run => run.commandId === command.id)} onClick={() => {
              if (!window.confirm(`删除「${command.name}」按钮？`)) return
              void execute('delete-command', () => api.deleteCommand(activeProject.id, command.id)).then(next => { if (next) setConfig(next) })
            }}><Trash2 size={14} /></IconButton></div>)}</div> : <div className="settings-empty">还没有快捷命令。添加 Test、Build 或你每天重复输入的命令。</div>}
          </section>
          <div className="settings-about"><div className="brand"><Brand small /><strong>DevDock</strong><span>v{version}</span></div><span>你的开发快捷入口 · 本地运行</span><button className="text-button danger-text" onClick={() => {
            void execute('quit', () => api.windowAction('quit'))
          }}>退出应用</button></div>
        </div></div>}
      </main>}
      <footer className="statusbar"><span><span className={`dot ${runningRuns.length ? 'green pulse' : 'subtle'}`} />{runningRuns.length ? `${runningRuns.length} 个任务正在运行` : activeProject ? '准备就绪' : '本地开发，轻装上阵'}</span><div>{activeProject && <button onClick={() => void execute('open-terminal', () => api.openTerminal(activeProject.id))} title="在项目目录打开终端"><Terminal size={12} /><span>终端</span></button>}<span className="shortcut-hint">{config.settings.shortcut.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl').replaceAll('+', ' + ')}</span></div></footer>
    </>}
    {toast && !compact && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}<span>{toast.text}</span><button onClick={() => setToast(null)} aria-label="关闭提示"><X size={14} /></button></div>}
    {pathDialog && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setPathDialog(false) }}><form className="modal path-modal" onSubmit={event => void addByPath(event)} role="dialog" aria-modal="true" aria-labelledby="path-dialog-title"><div className="modal-title"><span className="modal-icon"><FolderOpen size={20} /></span><h2 id="path-dialog-title">添加工作项目</h2><IconButton title="关闭" onClick={() => setPathDialog(false)}><X size={17} /></IconButton></div><p className="modal-description">输入项目文件夹的完整路径，配置会保存在本机。</p><label className="field-label" htmlFor="project-path">项目路径</label><input id="project-path" autoFocus value={pathInput} onChange={event => setPathInput(event.target.value)} placeholder="D:\Projects\my-app" spellCheck={false} /><div className="modal-footer"><button className="button" type="button" disabled={!!busy} onClick={() => void chooseProject()}><Folder size={14} />浏览文件夹</button><button className="button primary" type="submit" disabled={!pathInput.trim() || !!busy}>{busy === 'add-project' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}添加项目</button></div></form></div>}
    {editor && <CommandModal editor={editor} project={config.projects.find(project => project.id === editor.projectId)!} busy={!!busy} onClose={() => setEditor(null)} onSave={async command => { const next = await execute('save-command', () => api.saveCommand(editor.projectId, command)); if (next) { setConfig(next); setEditor(null); notify('快捷命令已保存') } }} />}
  </div>
}

function SettingToggle({ icon, title, description, checked, onChange }: { icon: ReactNode; title: string; description: string; checked: boolean; onChange: () => void }) {
  return <div className="setting-row">{icon}<div><strong>{title}</strong><small>{description}</small></div><button className={`toggle ${checked ? 'checked' : ''}`} role="switch" aria-checked={checked} aria-label={title} onClick={onChange}><span /></button></div>
}

function CommandModal({ editor, project, busy, onClose, onSave }: { editor: CommandEditor; project: Project; busy: boolean; onClose: () => void; onSave: (command: CommandConfig) => Promise<void> }) {
  const [value, setValue] = useState(editor.command)
  const [showDirectory, setShowDirectory] = useState(!!editor.command.cwd)
  const set = <K extends keyof CommandConfig>(key: K, next: CommandConfig[K]) => setValue(current => ({ ...current, [key]: next }))
  const submit = (event: FormEvent) => { event.preventDefault(); if (value.name.trim() && value.command.trim()) void onSave({ ...value, name: value.name.trim(), command: value.command.trim(), cwd: showDirectory && value.cwd?.trim() ? value.cwd.trim() : undefined }) }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}><form className="modal command-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="command-dialog-title">
    <div className="modal-title"><span className="modal-icon"><Terminal size={20} /></span><h2 id="command-dialog-title">{editor.isNew ? '添加快捷命令' : '编辑快捷命令'}</h2><IconButton title="关闭" disabled={busy} onClick={onClose}><X size={17} /></IconButton></div>
    <p className="modal-description">为 {project.name} 保存一个随手可用的按钮。</p>
    <div className="form-row"><label className="form-field">按钮名称<input autoFocus value={value.name} onChange={event => set('name', event.target.value)} placeholder="例如 Build" maxLength={40} required /></label><label className="form-field">用途<select value={value.kind} onChange={event => set('kind', event.target.value as CommandKind)}>{Object.entries(KIND_LABEL).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select></label></div>
    <label className="form-field command-field">执行命令<textarea value={value.command} onChange={event => set('command', event.target.value)} placeholder={value.kind === 'test' ? 'npm test' : value.kind === 'run' ? 'npm run dev' : value.kind === 'build' ? 'npm run build' : '输入你平时在终端运行的命令'} rows={3} spellCheck={false} required /></label>
    <p className="field-hint">{value.kind === 'test' ? '测试命令请使用运行一次后退出的模式；需要时添加 --run 等参数。' : value.kind === 'run' ? '适合开发服务器等持续运行的进程，按钮会变为停止。' : '按系统命令行语法执行，输出显示在运行记录中。'}</p>
    <button className="directory-toggle" type="button" onClick={() => setShowDirectory(!showDirectory)}><ChevronRight size={13} style={{ transform: showDirectory ? 'rotate(90deg)' : undefined } as CSSProperties} />自定义工作目录<span>{showDirectory ? '' : '默认使用项目目录'}</span></button>
    {showDirectory ? <label className="form-field directory-field">工作目录<input value={value.cwd ?? ''} onChange={event => set('cwd', event.target.value)} placeholder={project.path} spellCheck={false} /><small>可填写项目内的相对路径，或完整路径。</small></label> : <div className="command-project-path"><Folder size={13} /><span title={project.path}>{project.path}</span></div>}
    <div className="modal-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={busy || !value.name.trim() || !value.command.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存按钮</button></div>
  </form></div>
}
