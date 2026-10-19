import { mkdir, writeFile, readFile, access, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { prepareManualFixtures } from './prepare-manual-fixtures.mjs'
import { manualReport } from './manual-report.mjs'
import { manualLauncher, prepareGitSetupFixture, readOnlineEvidence, onlineProfileAvailable, prepareManualChecklist, onlineVerificationNote } from './manual-suite-content.mjs'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const base = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) || join(root, '..', `DevDock-manual-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`))
const executable = join(root, 'release', `DevDock-${version}-portable.exe`)
await access(executable)
const { projects, manifest } = await prepareManualFixtures(base)
manifest.version = version
manifest.scenarios.gitSetup = { path: await prepareGitSetupFixture(base) }
await writeFile(join(base, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2))
const evidence = await readOnlineEvidence(root)
const hasOnlineProfile = await onlineProfileAvailable(evidence)
const settings = { alwaysOnTop: true, compact: false, notifications: true, shortcut: 'Ctrl+Alt+Shift+D' }
const config = (items, shortcut = settings.shortcut) => ({ version: 1, projects: items, activeProjectId: items[0]?.id ?? null, settings: { ...settings, shortcut } })
const profiles = {}
async function profile(name, data, history = []) {
  const directory = join(base, 'profiles', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'config.json'), typeof data === 'string' ? data : JSON.stringify(data, null, 2), { flag: 'wx' })
  await writeFile(join(directory, 'history.json'), typeof history === 'string' ? history : JSON.stringify(history, null, 2), { flag: 'wx' })
  profiles[name] = await realpath(directory)
}
const nonGit = projects.find(project => project.path === manifest.scenarios.nonGit.path)
if (!nonGit) throw new Error('Non-Git fixture is required')
const sample = (index, status = 'success') => ({
  id: `manual-sample-${index}`, projectId: nonGit.id, projectName: nonGit.name,
  label: `预置记录${String(index).padStart(3, '0')}（样例）`, kind: 'custom',
  command: '[预置样例，未执行命令]', cwd: nonGit.path, status,
  startedAt: new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString(),
  ...(status === 'running' ? {} : { endedAt: new Date(Date.UTC(2000, 0, 1, 0, 0, index + 1)).toISOString(), exitCode: 0 }),
  output: '这是人工验收用的预置记录，并未执行命令。用于观察恢复状态或历史容量。\n',
})
await profile('main', config(projects))
await profile('interrupted', config([nonGit], 'Ctrl+Alt+Shift+1'), [sample(1, 'running')])
await profile('corrupt-history', config([nonGit], 'Ctrl+Alt+Shift+2'), '{人工验收：故意损坏的 history.json')
await profile('corrupt-config', '{人工验收：故意损坏的 config.json')
await profile('history-limit', config([nonGit], 'Ctrl+Alt+Shift+3'), Array.from({ length: 99 }, (_, i) => sample(99 - i)))

function batchLiteral(value) {
  if (/[\r\n%!"]/u.test(value)) throw new Error(`Path cannot be represented safely in a launcher: ${value}`)
  return value
}
const launchers = [
  ['01-启动主验收.cmd', 'main'], ['02-启动中断恢复.cmd', 'interrupted'],
  ['03-启动历史损坏.cmd', 'corrupt-history'], ['04-启动配置损坏.cmd', 'corrupt-config'],
  ['05-启动历史容量.cmd', 'history-limit'],
]
for (const [name, key] of launchers) {
  await writeFile(join(base, name), manualLauncher(executable, profiles[key]), { flag: 'wx' })
}
if (hasOnlineProfile) await writeFile(join(base, '08-启动联网验收.cmd'), manualLauncher(executable, evidence.profile), { flag: 'wx' })
await writeFile(join(base, '联网验证说明.md'), onlineVerificationNote(evidence, version, hasOnlineProfile), { flag: 'wx' })
await writeFile(join(base, '06-打开验收目录.cmd'), '@echo off\r\nstart "" explorer.exe "%~dp0"\r\n', { flag: 'wx' })
await writeFile(join(base, '07-生成新一轮.cmd'), [
  '@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE="',
  `"${batchLiteral(process.execPath)}" "${batchLiteral(join(root, 'scripts', 'prepare-manual.mjs'))}" --open`,
  'if errorlevel 1 pause', '',
].join('\r\n'), { flag: 'wx' })
const checklist = await prepareManualChecklist(root, base, manifest, evidence)
await writeFile(join(base, '00-人工验收清单.md'), checklist, { flag: 'wx' })
const fullManifest = { ...manifest, version, profiles, launchers: Object.fromEntries(launchers), executable, preparedAt: new Date().toISOString(), acceptanceId: randomUUID(), ...(evidence ? { onlineValidation: evidence } : {}) }
if (hasOnlineProfile) fullManifest.onlineLauncher = '08-启动联网验收.cmd'
await writeFile(join(base, '00-人工验收.html'), manualReport(checklist, fullManifest.acceptanceId, version), { flag: 'wx' })
await writeFile(join(base, 'manifest.json'), JSON.stringify(fullManifest, null, 2), { flag: 'wx' })
await mkdir(join(root, 'artifacts'), { recursive: true })
await writeFile(join(root, 'artifacts', 'manual-latest.json'), JSON.stringify({ base, profiles, manifest: join(base, 'manifest.json') }, null, 2))
console.log(`Prepared manual acceptance suite: ${base}`)
console.log(`Preloaded projects: ${projects.length}; isolated profiles: ${Object.keys(profiles).length}`)
if (process.argv.includes('--open')) spawn('explorer.exe', [base], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
