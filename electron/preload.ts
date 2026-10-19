import { contextBridge, ipcRenderer } from 'electron'
import type { DockApi } from '../shared/types'

const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`dock:${name}`, ...args)
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => callback(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
const api: DockApi = {
  bootstrap: () => invoke('bootstrap'),
  chooseProject: () => invoke('chooseProject'),
  addProject: path => invoke('addProject', path),
  selectProject: id => invoke('selectProject', id),
  removeProject: id => invoke('removeProject', id),
  saveCommand: (projectId, command) => invoke('saveCommand', projectId, command),
  deleteCommand: (projectId, commandId) => invoke('deleteCommand', projectId, commandId),
  saveSettings: settings => invoke('saveSettings', settings),
  repoStatus: id => invoke('repoStatus', id),
  gitDiff: (id, path, staged) => invoke('gitDiff', id, path, staged),
  gitStage: (id, paths, staged) => invoke('gitStage', id, paths, staged),
  gitCommit: (id, message, fingerprint) => invoke('gitCommit', id, message, fingerprint),
  gitPush: (id, options) => invoke('gitPush', id, options),
  gitFetch: id => invoke('gitFetch', id),
  gitInitialize: (id, branch) => invoke('gitInitialize', id, branch),
  gitIdentity: id => invoke('gitIdentity', id),
  gitSaveIdentity: (id, identity) => invoke('gitSaveIdentity', id, identity),
  gitSaveRemote: (id, input) => invoke('gitSaveRemote', id, input),
  gitRemoveRemote: (id, name) => invoke('gitRemoveRemote', id, name),
  gitTestRemote: (id, name) => invoke('gitTestRemote', id, name),
  githubStatus: () => invoke('githubStatus'),
  githubLogin: () => invoke('githubLogin'),
  githubCancelLogin: () => invoke('githubCancelLogin'),
  githubRepositories: () => invoke('githubRepositories'),
  githubCreateRepository: (id, input) => invoke('githubCreateRepository', id, input),
  githubConnectRepository: (id, input) => invoke('githubConnectRepository', id, input),
  githubUseIdentity: id => invoke('githubUseIdentity', id),
  openGitHubHelp: () => invoke('openGitHubHelp'),
  runCommand: (id, commandId) => invoke('runCommand', id, commandId),
  stopRun: id => invoke('stopRun', id),
  clearHistory: id => invoke('clearHistory', id),
  openFolder: id => invoke('openFolder', id),
  openTerminal: id => invoke('openTerminal', id),
  copyText: text => invoke('copyText', text),
  windowAction: action => invoke('windowAction', action),
  onConfig: callback => subscribe('dock:config', callback),
  onRun: callback => subscribe('dock:run', callback),
  onRepoChanged: callback => subscribe('dock:repo-changed', callback)
}
contextBridge.exposeInMainWorld('dock', api)
