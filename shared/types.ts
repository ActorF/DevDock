export type CommandKind = 'test' | 'build' | 'run' | 'custom'
export interface CommandConfig { id: string; name: string; command: string; cwd?: string; kind: CommandKind }
export interface Project { id: string; name: string; path: string; commands: CommandConfig[]; createdAt: string }
export interface AppSettings {
  alwaysOnTop: boolean; compact: boolean; notifications: boolean; shortcut: string
  bounds?: { x: number; y: number; width: number; height: number }
}
export interface AppConfig { version: 1; projects: Project[]; activeProjectId: string | null; settings: AppSettings }
export interface GitFile { path: string; originalPath?: string; indexStatus: string; worktreeStatus: string; untracked: boolean; conflicted: boolean }
export interface GitRemote { name: string; url: string; pushUrl?: string; urlRedacted?: boolean }
export interface GitIdentity { name: string; email: string; localName: string; localEmail: string }
export interface RemoteInput { name: string; url: string; originalName?: string }
export interface RemoteConnection { name: string; url: string; reachable: boolean; defaultBranch?: string; heads: number; message: string }
export interface GitHubAccountState {
  available: boolean; state: 'disconnected' | 'connecting' | 'connected' | 'error'
  login?: string; name?: string; id?: number; url?: string
  verificationUri?: string; deviceCode?: string; message?: string
}
export interface GitHubRepository {
  name: string; fullName: string; url: string; cloneUrl: string; sshUrl: string
  private: boolean; defaultBranch: string; description?: string
}
export interface CreateGitHubRepositoryInput { name: string; description?: string; private: boolean; remoteName: string }
export interface RepoStatus {
  isRepo: boolean; root: string; branch: string; head: string | null; files: GitFile[]
  upstream: string | null; ahead: number; behind: number; remotes: GitRemote[]
  fingerprint: string; mergeInProgress: boolean; error?: string
}
export interface GitDiff { path: string; text: string; binary: boolean; staged: boolean }
export type RunStatus = 'running' | 'success' | 'failed' | 'stopped' | 'interrupted'
export interface RunRecord {
  id: string; projectId: string; projectName: string; commandId?: string
  label: string; kind: CommandKind | 'git'; command: string; cwd: string
  status: RunStatus; startedAt: string; endedAt?: string; exitCode?: number | null
  output: string; fingerprint?: string
}
export interface Bootstrap { config: AppConfig; runs: RunRecord[]; version: string; platform: string; startupWarning?: string }
export interface PushOptions { remote?: string; branch?: string; setUpstream?: boolean }
export interface DockApi {
  bootstrap(): Promise<Bootstrap>
  chooseProject(): Promise<AppConfig | null>
  addProject(path: string): Promise<AppConfig>
  selectProject(id: string): Promise<AppConfig>
  removeProject(id: string): Promise<AppConfig>
  saveCommand(projectId: string, command: CommandConfig): Promise<AppConfig>
  deleteCommand(projectId: string, commandId: string): Promise<AppConfig>
  saveSettings(settings: Partial<AppSettings>): Promise<AppConfig>
  repoStatus(projectId: string): Promise<RepoStatus>
  gitDiff(projectId: string, path: string, staged: boolean): Promise<GitDiff>
  gitStage(projectId: string, paths: string[], staged: boolean): Promise<RepoStatus>
  gitCommit(projectId: string, message: string, expectedFingerprint: string): Promise<RunRecord>
  gitPush(projectId: string, options?: PushOptions): Promise<RunRecord>
  gitFetch(projectId: string): Promise<RunRecord>
  gitInitialize(projectId: string, branch?: string): Promise<RepoStatus>
  gitIdentity(projectId: string): Promise<GitIdentity>
  gitSaveIdentity(projectId: string, identity: { name: string; email: string }): Promise<GitIdentity>
  gitSaveRemote(projectId: string, input: RemoteInput): Promise<RepoStatus>
  gitRemoveRemote(projectId: string, name: string): Promise<RepoStatus>
  gitTestRemote(projectId: string, name: string): Promise<RemoteConnection>
  githubStatus(): Promise<GitHubAccountState>
  githubLogin(): Promise<GitHubAccountState>
  githubCancelLogin(): Promise<GitHubAccountState>
  githubRepositories(): Promise<GitHubRepository[]>
  githubCreateRepository(projectId: string, input: CreateGitHubRepositoryInput): Promise<GitHubRepository>
  githubConnectRepository(projectId: string, input: { url: string; remoteName: string }): Promise<RepoStatus>
  githubUseIdentity(projectId: string): Promise<GitIdentity>
  openGitHubHelp(): Promise<void>
  runCommand(projectId: string, commandId: string): Promise<RunRecord>
  stopRun(runId: string): Promise<void>
  clearHistory(projectId: string): Promise<void>
  openFolder(projectId: string): Promise<void>
  openTerminal(projectId: string): Promise<void>
  copyText(text: string): Promise<void>
  windowAction(action: 'minimize' | 'hide' | 'quit' | 'expand' | 'panel'): Promise<void>
  onConfig(callback: (config: AppConfig) => void): () => void
  onRun(callback: (run: RunRecord) => void): () => void
  onRepoChanged(callback: (projectId: string) => void): () => void
}
