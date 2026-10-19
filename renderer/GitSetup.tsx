import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CheckCircle2, CircleUserRound as Github, Copy, ExternalLink, GitBranch, Globe, Link2, LoaderCircle, LockKeyhole, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2, TriangleAlert, UserRound, X } from 'lucide-react'
import type { GitHubAccountState, GitHubRepository, GitIdentity, GitRemote, Project, RemoteConnection, RepoStatus } from '../shared/types'

const api = window.dock
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
type Props = { project: Project | null; repo: RepoStatus | null; gitRunning: boolean; onChanged: (projectId: string) => Promise<void> }
type Notice = { text: string; error?: boolean }

export default function GitSetup({ project, repo, gitRunning, onChanged }: Props) {
  const [account, setAccount] = useState<GitHubAccountState | null>(null)
  const [identity, setIdentity] = useState<GitIdentity | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [branch, setBranch] = useState('main')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [remoteForm, setRemoteForm] = useState<{ name: string; url: string; originalName?: string } | null>(null)
  const [remoteResults, setRemoteResults] = useState<Record<string, RemoteConnection>>({})
  const [repositories, setRepositories] = useState<GitHubRepository[] | null>(null)
  const [selectedRepository, setSelectedRepository] = useState('')
  const [repositoryMode, setRepositoryMode] = useState<'existing' | 'new'>('existing')
  const [remoteName, setRemoteName] = useState('origin')
  const [repositoryName, setRepositoryName] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const alive = useRef(true)
  const busyRef = useRef(false)
  const disabled = !!busy || gitRunning
  const connected = account?.state === 'connected'
  const remoteExists = repo?.remotes.some(remote => remote.name === remoteName.trim()) ?? false

  useEffect(() => {
    alive.current = true
    api.githubStatus().then(value => { if (alive.current) setAccount(value) }).catch(error => { if (alive.current) setNotice({ text: errorText(error), error: true }) })
    return () => { alive.current = false }
  }, [])

  const setIdentityFields = (value: GitIdentity) => { setIdentity(value); setName(value.name); setEmail(value.email) }
  useEffect(() => {
    if (!project || !repo?.isRepo) return
    let current = true
    api.gitIdentity(project.id).then(value => { if (current && alive.current) setIdentityFields(value) }).catch(error => { if (current && alive.current) setNotice({ text: errorText(error), error: true }) })
    return () => { current = false }
  }, [project?.id, repo?.isRepo])

  useEffect(() => {
    if (account?.state !== 'connecting') return
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.githubStatus()
        if (!current || !alive.current) return
        setAccount(next)
        if (next.state === 'connecting') timer = setTimeout(poll, 2000)
      } catch (error) {
        if (current && alive.current) { setNotice({ text: errorText(error), error: true }); timer = setTimeout(poll, 3000) }
      }
    }
    timer = setTimeout(poll, 2000)
    return () => { current = false; clearTimeout(timer) }
  }, [account?.state])

  async function act<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current || gitRunning) return undefined
    busyRef.current = true; setBusy(key); setNotice(null)
    try {
      const value = await action()
      return alive.current ? value : undefined
    } catch (error) {
      if (alive.current) setNotice({ text: errorText(error), error: true })
      return undefined
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(null)
    }
  }
  async function changed(message: string) {
    if (!project || !alive.current) return
    setNotice({ text: message })
    await onChanged(project.id)
  }
  async function initialize(event: FormEvent) {
    event.preventDefault()
    if (!project) return
    const value = await act('initialize', () => api.gitInitialize(project.id, branch.trim()))
    if (value) await changed('Git 仓库已初始化。接下来设置提交身份，再提交项目文件。')
  }
  async function saveIdentity(event: FormEvent) {
    event.preventDefault()
    if (!project) return
    const value = await act('identity', () => api.gitSaveIdentity(project.id, { name: name.trim(), email: email.trim() }))
    if (value) { setIdentityFields(value); setNotice({ text: '提交身份已保存到当前项目。之后的新提交会使用此身份。' }) }
  }
  async function useGitHubIdentity() {
    if (!project) return
    const value = await act('github-identity', () => api.githubUseIdentity(project.id))
    if (value) { setIdentityFields(value); setNotice({ text: '已使用 GitHub 账号名称和隐私邮箱作为当前项目的提交身份。' }) }
  }
  async function loadRepositories() {
    const value = await act('repositories', () => api.githubRepositories())
    if (value) {
      setRepositories(value)
      setSelectedRepository(current => value.some(item => item.cloneUrl === current) ? current : value[0]?.cloneUrl ?? '')
    }
  }
  async function connectRepository(event: FormEvent) {
    event.preventDefault()
    if (!project || !selectedRepository || remoteExists) return
    const value = await act('connect-repository', () => api.githubConnectRepository(project.id, { url: selectedRepository, remoteName: remoteName.trim() }))
    if (value) await changed(`已连接远程 ${remoteName.trim()}。回到面板审阅并提交，然后点击 Push。`)
  }
  async function createRepository(event: FormEvent) {
    event.preventDefault()
    if (!project || !repositoryName.trim() || remoteExists) return
    const value = await act('create-repository', () => api.githubCreateRepository(project.id, { name: repositoryName.trim(), description: description.trim() || undefined, private: isPrivate, remoteName: remoteName.trim() }))
    if (value) {
      setRepositoryName(''); setDescription('')
      setRepositories(current => current ? [value, ...current.filter(item => item.url !== value.url)] : [value])
      setSelectedRepository(value.cloneUrl)
      await changed(`已创建并连接 ${value.fullName}。仓库当前为空；提交后点击 Push 上传代码。`)
    }
  }
  async function saveRemote(event: FormEvent) {
    event.preventDefault()
    if (!project || !remoteForm) return
    const value = await act('save-remote', () => api.gitSaveRemote(project.id, { ...remoteForm, name: remoteForm.name.trim(), url: remoteForm.url.trim() }))
    if (value) { setRemoteForm(null); setRemoteResults({}); await changed('远程仓库配置已保存。可以测试连接，或回到面板推送提交。') }
  }
  async function removeRemote(remote: GitRemote) {
    if (!project || !window.confirm(`移除远程「${remote.name}」的本地关联？\n不会删除 GitHub 上的仓库或本地提交。`)) return
    const value = await act(`remove-${remote.name}`, () => api.gitRemoveRemote(project.id, remote.name))
    if (value) { setRemoteResults({}); if (remoteForm?.originalName === remote.name) setRemoteForm(null); await changed(`已移除远程 ${remote.name} 的本地关联。`) }
  }
  async function testRemote(remote: GitRemote) {
    if (!project) return
    const value = await act(`test-${remote.name}`, () => api.gitTestRemote(project.id, remote.name))
    if (value) setRemoteResults(current => ({ ...current, [remote.name]: value }))
  }
  const spinner = (key: string) => busy === key ? <LoaderCircle size={14} className="spin" /> : null

  return <div className="git-setup-scroll" data-testid="git-setup-view">
    <div className="git-setup-intro"><div><h2>从本地项目，到远程仓库。</h2><p>配置身份、连接账号和仓库，之后直接使用 Commit 与 Push。</p></div><span className="chip"><ShieldCheck size={13} />按项目配置</span></div>
    {notice && <div className={`git-setup-notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <TriangleAlert size={17} /> : <CheckCircle2 size={17} />}<span>{notice.text}</span><button aria-label="关闭仓库设置提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    {gitRunning && <div className="inline-warning"><LoaderCircle size={15} className="spin" /><span>当前项目正在执行 Git 操作，结束后可修改仓库设置。</span></div>}
    <div className="git-setup-grid">
      <section className="git-setup-card identity-card">
        <div className="git-setup-card-title"><GitBranch size={19} /><div><h3>本地仓库与提交身份</h3><p>Commit 保存到本地；Push 才会上传。</p></div><span className="setup-step">01</span></div>
        {!project ? <div className="git-setup-empty">先在面板中添加一个项目文件夹。</div> : !repo ? <div className="git-setup-empty"><LoaderCircle size={17} className="spin" />正在检查项目…</div> : !repo.isRepo ? <form className="git-setup-form" onSubmit={event => void initialize(event)}>
          <p className="setup-project-path" title={project.path}>{project.path}</p><p className="field-hint">此文件夹尚未使用 Git。初始化后即可选择文件、查看差异和提交。</p>
          <label className="form-field">初始分支<input aria-label="初始分支" value={branch} onChange={event => setBranch(event.target.value)} placeholder="main" spellCheck={false} /></label>
          <button data-testid="git-initialize" className="button primary" disabled={disabled || !branch.trim()} type="submit">{spinner('initialize') || <Plus size={15} />}初始化 Git</button>
        </form> : <>
          <div className="git-local-status"><span className="dot green" /><strong>{repo.branch}</strong><span>{repo.head ? repo.head.slice(0, 7) : '尚无提交'}</span><span title={repo.root}>{repo.root}</span></div>
          <form className="git-setup-form" onSubmit={event => void saveIdentity(event)}>
            <div className="setup-field-heading"><UserRound size={14} /><strong>提交者身份</strong>{identity && <span>{identity.localName || identity.localEmail ? '当前项目配置' : '继承本机配置'}</span>}</div>
            <label className="form-field">姓名<input aria-label="提交者姓名" value={name} onChange={event => setName(event.target.value)} placeholder="你的姓名或昵称" autoComplete="off" maxLength={200} /></label>
            <label className="form-field">邮箱<input aria-label="提交者邮箱" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="off" spellCheck={false} maxLength={254} /></label>
            <p className="field-hint">姓名和邮箱会写进 Git 提交记录。可使用 GitHub 隐私邮箱；保存仅影响当前项目的新提交。</p>
            <div className="setup-buttons"><button className="button primary" disabled={disabled || !name.trim() || !email.trim()} type="submit">{spinner('identity') || <Save size={14} />}保存提交身份</button>{connected && <button data-testid="github-use-identity" className="button" type="button" disabled={disabled} onClick={() => void useGitHubIdentity()}>{spinner('github-identity') || <Github size={14} />}使用 GitHub 身份</button>}</div>
          </form>
        </>}
      </section>

      <section className="git-setup-card github-card">
        <div className="git-setup-card-title"><Github size={20} /><div><h3>GitHub 账号</h3><p>登录后可直接选择或创建远程仓库。</p></div><span className="setup-step">02</span></div>
        <div className="github-account-body">
          {!account ? <div className="git-setup-empty"><LoaderCircle size={17} className="spin" />正在读取登录状态…</div> : connected ? <div className="github-account-row"><span className="github-avatar"><Github size={23} /></span><div><strong>{account.name || account.login}</strong><span>@{account.login}</span></div><span className="account-connected"><span className="dot green" />已连接</span></div> : account.state === 'connecting' ? <div className="github-login-progress"><div><LoaderCircle size={16} className="spin" /><strong>等待浏览器授权</strong></div><p>在已打开的 GitHub 页面输入验证码，并确认授权。</p>{account.deviceCode && <div className="github-device-code"><code>{account.deviceCode}</code><button className="icon-button" title="复制 GitHub 验证码" aria-label="复制 GitHub 验证码" disabled={disabled} onClick={() => void act('copy-code', async () => { await api.copyText(account.deviceCode!); return true }).then(value => { if (value) setNotice({ text: '验证码已复制。' }) })}><Copy size={15} /></button></div>}{account.verificationUri && <p className="github-verification-url">{account.verificationUri}</p>}<button className="button small" disabled={disabled} onClick={() => void act('cancel-login', () => api.githubCancelLogin()).then(value => { if (value) setAccount(value) })}>取消登录</button></div> : <>
            <p className="github-login-description">{account.available ? '通过浏览器授权，DevDock 会使用本机 GitHub CLI 的账号登录状态。' : '连接 GitHub 需要安装官方 GitHub CLI。安装后点击刷新，即可在这里登录。'}</p>
            {account.message && <p className="github-account-message">{account.message}</p>}
            <div className="setup-buttons">{account.available ? <button className="button primary" disabled={disabled} onClick={() => void act('login', () => api.githubLogin()).then(value => { if (value) setAccount(value) })}>{spinner('login') || <Github size={15} />}登录 GitHub</button> : <button className="button primary" disabled={disabled} onClick={() => void act('github-help', () => api.openGitHubHelp())}><ExternalLink size={15} />安装 GitHub CLI</button>}</div>
          </>}
          <button className="subtle-link github-refresh" disabled={disabled || account?.state === 'connecting'} onClick={() => void act('account', () => api.githubStatus()).then(value => { if (value) { setAccount(value); setRepositories(null); setSelectedRepository('') } })}>{spinner('account') || <RefreshCw size={12} />}刷新账号状态</button>
        </div>
        {connected && <div className="github-repository-section">
          {!project || !repo?.isRepo ? <p className="field-hint">先完成左侧的 Git 初始化，即可连接或创建 GitHub 仓库。</p> : <>
            <div className="segmented-control repository-mode"><button className={repositoryMode === 'existing' ? 'selected' : ''} onClick={() => setRepositoryMode('existing')}>选择已有仓库</button><button className={repositoryMode === 'new' ? 'selected' : ''} onClick={() => setRepositoryMode('new')}>创建新仓库</button></div>
            {repositoryMode === 'existing' ? <form className="git-setup-form" onSubmit={event => void connectRepository(event)}>
              <div className="setup-field-heading"><strong>当前账号的仓库</strong><button data-testid="github-load-repos" className="subtle-link" type="button" disabled={disabled} onClick={() => void loadRepositories()}>{spinner('repositories') || <RefreshCw size={12} />}{repositories ? '刷新列表' : '加载仓库列表'}</button></div>
              {repositories?.length ? <label className="form-field">选择仓库<select aria-label="选择 GitHub 仓库" value={selectedRepository} onChange={event => setSelectedRepository(event.target.value)}>{repositories.map(item => <option key={item.url} value={item.cloneUrl}>{item.fullName} · {item.private ? '私有' : '公开'}</option>)}</select></label> : <p className="field-hint">{repositories ? '当前列表中没有仓库。可以创建一个新仓库，或在下方手动填写远程地址。' : '点击加载，选择你要关联的仓库。也可以在下方手动填写远程地址。'}</p>}
              <label className="form-field">远程名称<input aria-label="GitHub 远程名称" value={remoteName} onChange={event => setRemoteName(event.target.value)} placeholder="origin" spellCheck={false} /></label>
              {remoteExists && <p className="field-hint setup-warning">「{remoteName.trim()}」已存在。请填写新的名称，或在下方编辑已有远程。</p>}
              <p className="field-hint">连接只保存远程地址。不会下载或覆盖本地文件。</p>
              <button data-testid="github-connect-repo" className="button primary" disabled={disabled || !selectedRepository || !remoteName.trim() || remoteExists} type="submit">{spinner('connect-repository') || <Link2 size={14} />}连接选中仓库</button>
            </form> : <form className="git-setup-form" onSubmit={event => void createRepository(event)}>
              <label className="form-field">GitHub 仓库名称<input aria-label="GitHub 仓库名称" value={repositoryName} onChange={event => setRepositoryName(event.target.value)} placeholder="my-project" maxLength={100} spellCheck={false} /></label>
              <label className="form-field">仓库说明 · 可选<input aria-label="仓库说明" value={description} onChange={event => setDescription(event.target.value)} placeholder="用一句话描述这个项目" maxLength={350} /></label>
              <label className="form-field">远程名称<input aria-label="新仓库远程名称" value={remoteName} onChange={event => setRemoteName(event.target.value)} placeholder="origin" spellCheck={false} /></label>
              <fieldset className="repository-visibility"><legend>仓库可见性</legend><label className={isPrivate ? 'selected' : ''}><input type="radio" name="visibility" checked={isPrivate} onChange={() => setIsPrivate(true)} /><LockKeyhole size={16} /><span><strong>私有</strong><small>仅你和获邀协作者可访问</small></span></label><label className={!isPrivate ? 'selected' : ''}><input type="radio" name="visibility" checked={!isPrivate} onChange={() => setIsPrivate(false)} /><Globe size={16} /><span><strong>公开</strong><small>任何人都可以查看</small></span></label></fieldset>
              {remoteExists && <p className="field-hint setup-warning">远程「{remoteName.trim()}」已存在，请更换远程名称。</p>}
              <p className="field-hint">将在 @{account.login} 下创建空仓库并关联当前项目。文件会在你点击 Push 后上传。</p>
              <button data-testid="github-create-repo" className="button primary" disabled={disabled || !repositoryName.trim() || !remoteName.trim() || remoteExists} type="submit">{spinner('create-repository') || <Plus size={14} />}创建{isPrivate ? '私有' : '公开'}仓库并连接</button>
            </form>}
          </>}
        </div>}
      </section>

      <section className="git-setup-card remotes-card">
        <div className="git-setup-card-title"><Link2 size={19} /><div><h3>远程仓库</h3><p>支持 GitHub、其他 Git 平台，以及本地测试远程。</p></div><button className="button small" disabled={disabled || !repo?.isRepo || !!remoteForm} onClick={() => setRemoteForm({ name: repo?.remotes.length ? '' : 'origin', url: '' })}><Plus size={14} />添加远程</button></div>
        {!repo?.isRepo ? <div className="git-setup-empty">初始化 Git 仓库后，即可添加远程。</div> : <>
          {!!repo.remotes.length && <div className="setup-remote-list">{repo.remotes.map(remote => {
            const result = remoteResults[remote.name]
            return <div className="setup-remote" key={remote.name}><div className="setup-remote-summary"><span className="setup-remote-icon"><Globe size={17} /></span><div><strong>{remote.name}</strong><code title={remote.url}>{remote.url}</code>{remote.pushUrl && remote.pushUrl !== remote.url && <small>推送地址：{remote.pushUrl}</small>}</div><div className="setup-remote-actions"><button className="button small" disabled={disabled} onClick={() => void testRemote(remote)}>{spinner(`test-${remote.name}`) || <ShieldCheck size={13} />}测试连接</button><button className="icon-button" aria-label={`编辑远程 ${remote.name}`} title={`编辑远程 ${remote.name}`} disabled={disabled} onClick={() => setRemoteForm({ name: remote.name, originalName: remote.name, url: remote.urlRedacted ? '' : remote.url })}><Pencil size={14} /></button><button className="icon-button" aria-label={`移除远程 ${remote.name}`} title={`移除远程 ${remote.name}`} disabled={disabled} onClick={() => void removeRemote(remote)}><Trash2 size={14} /></button></div></div>
              {result && <div className={`setup-remote-result ${result.reachable ? 'success' : 'error'}`} role="status">{result.reachable ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}<span>{result.reachable ? result.heads === 0 ? '连接成功 · 这是空仓库，可以进行首次推送。' : `连接成功 · ${result.heads} 个分支${result.defaultBranch ? ` · 默认 ${result.defaultBranch}` : ''}` : result.message}</span></div>}
            </div>
          })}</div>}
          {!repo.remotes.length && !remoteForm && <div className="git-setup-empty"><Link2 size={20} /><strong>还没有远程仓库</strong><span>可在上方连接 GitHub，或点击“添加远程”填写仓库地址。</span></div>}
          {remoteForm && <form className="remote-editor git-setup-form" onSubmit={event => void saveRemote(event)}>
            <div className="setup-field-heading"><strong>{remoteForm.originalName ? `编辑远程 ${remoteForm.originalName}` : '添加远程仓库'}</strong><button type="button" className="icon-button" aria-label="取消编辑远程" disabled={disabled} onClick={() => setRemoteForm(null)}><X size={14} /></button></div>
            <div className="remote-form-fields"><label className="form-field">远程名称<input aria-label="远程名称" value={remoteForm.name} onChange={event => setRemoteForm({ ...remoteForm, name: event.target.value })} placeholder="origin" spellCheck={false} maxLength={100} /></label><label className="form-field">远程地址<input aria-label="远程地址" value={remoteForm.url} onChange={event => setRemoteForm({ ...remoteForm, url: event.target.value })} placeholder="https://github.com/owner/repository.git" spellCheck={false} autoComplete="off" /></label></div>
            {remoteForm.originalName && repo.remotes.find(remote => remote.name === remoteForm.originalName)?.urlRedacted && <p className="field-hint setup-warning">原地址中的凭据已隐藏。请重新填写不含令牌或密码的仓库地址。</p>}
            {remoteForm.originalName && repo.remotes.some(remote => remote.name === remoteForm.originalName && remote.pushUrl && remote.pushUrl !== remote.url) && <p className="field-hint setup-warning">此远程单独设置了推送地址。本次修改的是获取地址；推送仍使用上方显示的“推送地址”。</p>}
            <p className="field-hint">使用 HTTPS、SSH 或本地路径。请勿将访问令牌或密码写入地址；Git 使用本机凭据或 SSH 密钥认证。</p>
            <div className="setup-buttons"><button data-testid="remote-save" className="button primary" type="submit" disabled={disabled || !remoteForm.name.trim() || !remoteForm.url.trim()}>{spinner('save-remote') || <Save size={14} />}保存远程</button><button className="button" type="button" disabled={disabled} onClick={() => setRemoteForm(null)}>取消</button></div>
          </form>}
          <div className="setup-remote-footer"><ShieldCheck size={13} /><span>连接测试仅检查远程读取是否可达；实际推送还取决于写入权限和分支规则。</span></div>
        </>}
      </section>
    </div>
  </div>
}
