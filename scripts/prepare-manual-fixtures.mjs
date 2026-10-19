import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const quote = value => process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`

function execute(file, args, cwd, env, allowed = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => allowed.includes(code) ? resolve({ code, stdout, stderr }) : reject(new Error(`${file} ${args.join(' ')} failed (${code})\n${stderr}\n${stdout}`)))
  })
}

// Every helper validates both its fixture marker and the actual target path before
// writing. These actions never resolve, reset, or modify the user's own projects.
const helperSource = String.raw`import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const helper = fileURLToPath(import.meta.url);
const base = await fs.realpath(path.dirname(path.dirname(helper)));
const marker = JSON.parse(await fs.readFile(path.join(base, '.devdock-manual-fixtures.json'), 'utf8'));
assert.equal(marker.purpose, 'DevDock isolated manual acceptance fixtures');
const manifest = JSON.parse(await fs.readFile(path.join(base, 'fixture-manifest.json'), 'utf8'));
assert.equal(marker.id, manifest.fixtureId);
function inside(root, target) { const r = path.relative(root, target); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); }
async function safe(target) {
  target = path.resolve(target);
  assert(inside(base, target) && target !== base, 'Refusing a target outside the fixture directory');
  let ancestor = target;
  while (true) {
    try { assert(inside(base, await fs.realpath(ancestor)), 'Refusing a symlink outside the fixtures'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  return target;
}
const action = process.argv[2];
const project = await fs.realpath(process.argv[3] || process.cwd());
assert(Object.values(manifest.scenarios).some(s => path.resolve(s.path).toLowerCase() === project.toLowerCase()), 'Unknown fixture project');
await safe(project);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function write(relative, value) { const filename = await safe(path.join(project, relative)); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, value); return filename; }
async function git(cwd, args) {
  await safe(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, '_helpers', 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_') && key !== 'GIT_CONFIG_NOSYSTEM' && key !== 'GIT_CONFIG_GLOBAL') delete env[key];
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  await new Promise((resolve, reject) => {
    const child = spawn(manifest.gitExecutable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => process.stdout.write(data)); child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Fixture Git command failed: ' + code)));
  });
}
if (action === 'test') {
  const delay = process.argv[4] === undefined ? 700 : Number(process.argv[4]);
  assert(Number.isFinite(delay) && delay >= 0 && delay <= 60000, 'Test delay must be between 0 and 60000 ms');
  console.log('Running the real fixture assertions after ' + delay + ' ms...'); await pause(delay);
  const require = createRequire(import.meta.url);
  const { add } = require(path.join(project, 'src', 'calculator.cjs'));
  assert.equal(add(2, 3), 5); console.log('PASS add(2, 3) === 5');
  assert.equal(add(-2, 2), 0); console.log('PASS add(-2, 2) === 0');
  assert.equal(add(0, 0), 0); console.log('PASS add(0, 0) === 0');
  console.log('3 assertions passed. Exit code 0.');
} else if (action === 'build') {
  const out = await write('dist/build-result.json', JSON.stringify({ builtAt: new Date().toISOString(), project, result: 'success' }, null, 2));
  console.log('Build complete. Real output file: ' + out);
} else if (action === 'run') {
  const runtime = await safe(path.join(project, '.manual-runtime')); await fs.mkdir(runtime, { recursive: true });
  const child = spawn(process.execPath, [helper, 'child', project], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  console.log('RUN parent PID=' + process.pid + ' child PID=' + child.pid);
  console.log('Click the same Run button again, or Stop in the log, to stop the entire process tree.');
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  let tick = 0; setInterval(() => console.log('[parent] heartbeat ' + (++tick) + ' ' + new Date().toISOString()), 1000);
} else if (action === 'child') {
  let tick = 0;
  const beat = async () => { await write('.manual-runtime/child-heartbeat.txt', new Date().toISOString()); console.log('[child] heartbeat ' + (++tick) + ' PID=' + process.pid); };
  await beat(); setInterval(() => void beat(), 1000);
} else if (action === 'check-stop') {
  const heartbeat = await safe(path.join(project, '.manual-runtime/child-heartbeat.txt'));
  let before; try { before = await fs.readFile(heartbeat, 'utf8'); } catch (e) { if (e.code === 'ENOENT') throw new Error('Run the Run button once before checking Stop.'); throw e; }
  console.log('Watching the child heartbeat for 3 seconds...'); await pause(3000);
  const after = await fs.readFile(heartbeat, 'utf8');
  assert.equal(after, before, 'The child is still running. Stop Run first, then check again.');
  console.log('PASS: child heartbeat is unchanged. The child process has stopped.');
} else if (action === 'lint') {
  const text = await fs.readFile(await safe(path.join(project, 'src', 'calculator.cjs')), 'utf8');
  assert(!text.includes('\t'), 'Tabs are forbidden in the example source');
  console.log('Lint passed: source has no tab indentation.');
} else if (action === 'format') {
  const filename = await safe(path.join(project, 'notes', 'format-me.txt'));
  const original = await fs.readFile(filename, 'utf8');
  const formatted = original.split(/\r?\n/).map(line => line.trimEnd()).join('\n').trimEnd() + '\n';
  await fs.writeFile(filename, formatted); console.log('Formatted notes/format-me.txt. Inspect its real Git diff.');
} else if (action === 'fail') {
  console.log('This command deliberately tests failure presentation.');
  console.error('DELIBERATE FAILURE: sample assertion failed. Expected exit code 7.'); process.exitCode = 7;
} else if (action === 'notify') {
  console.log('Finishing in 15 seconds. Switch to another app to test the desktop notification.');
  await pause(15000); console.log('Completed successfully. A notification depends on the app setting and Windows notification settings.');
} else if (action === 'change') {
  const filename = await safe(path.join(project, 'README.md'));
  await fs.appendFile(filename, '\nManual code-change marker: ' + new Date().toISOString() + '\n');
  console.log('README.md changed. A previous successful Test should now show as out of date.');
} else if (action === 'flood') {
  console.log('LOG-BEGIN: this first marker is expected to be removed by truncation.');
  for (let i = 0; i < 5000; i++) console.log(String(i).padStart(4, '0') + ' bounded log verification: abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  console.log('LOG-END: this final marker must remain visible after truncation.');
} else if (action === 'success') {
  console.log('Fixed successful command. Exit code 0.');
} else if (action === 'cwd') {
  console.log('Current working directory: ' + process.cwd());
  console.log('Files: ' + (await fs.readdir(process.cwd())).join(', '));
} else if (action === 'disable-hook') {
  assert.equal(project.toLowerCase(), path.resolve(manifest.scenarios.commitRejected.path).toLowerCase());
  const hook = await safe(path.join(project, '.git', 'devdock-hooks', 'pre-commit'));
  await fs.unlink(hook).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log('The deliberate rejection hook is disabled in this fixture only. Retry your retained commit message.');
} else if (action === 'advance-remote') {
  assert.equal(project.toLowerCase(), path.resolve(manifest.scenarios.pushRejected.path).toLowerCase());
  const peer = await safe(manifest.scenarios.pushRejected.peerPath);
  const filename = await safe(path.join(peer, 'remote-note.txt'));
  await fs.appendFile(filename, '\nAnother remote-only commit ' + new Date().toISOString() + '\n');
  await git(peer, ['add', '--', 'remote-note.txt']); await git(peer, ['commit', '-m', 'Add remote-only fixture update']); await git(peer, ['push', 'origin', 'main']);
  console.log('The LOCAL bare remote advanced. Click Fetch in DevDock to refresh its behind count.');
} else if (action === 'conflict') {
  console.log(await fs.readFile(await safe(path.join(project, 'conflict.txt')), 'utf8'));
  console.log('This is a real unresolved merge conflict. Commit should be blocked; no automatic resolution is performed.');
} else if (action === 'hello') {
  console.log('Custom command works. Project: ' + project); console.log('Unicode output: 中文 / café / 日本語 / ✅');
} else throw new Error('Unknown fixture action: ' + action);
`

/** Create a fresh, isolated, network-free manual acceptance suite. Never overwrites. */
export async function prepareManualFixtures(baseDir) {
  baseDir = path.resolve(baseDir)
  const parent = await fs.realpath(path.dirname(baseDir))
  baseDir = path.join(parent, path.basename(baseDir))
  if (!path.basename(baseDir).startsWith('DevDock-manual-')) throw new Error('Use a fresh directory named DevDock-manual-*')
  await fs.mkdir(baseDir) // EEXIST intentionally refuses to touch an earlier acceptance run.
  const helpersDir = path.join(baseDir, '_helpers')
  const remotesDir = path.join(baseDir, '_remotes')
  const peersDir = path.join(baseDir, '_peers')
  await Promise.all([helpersDir, remotesDir, peersDir].map(p => fs.mkdir(p)))
  const emptyConfig = path.join(helpersDir, 'empty-gitconfig')
  await fs.writeFile(emptyConfig, '')
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key]
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key]
  const gitExecutable = process.platform === 'win32'
    ? (await execute('where.exe', ['git.exe'], baseDir, env)).stdout.split(/\r?\n/).find(Boolean)
    : (await execute('which', ['git'], baseDir, env)).stdout.trim()
  if (!gitExecutable) throw new Error('Git was not found on PATH. Install Git before preparing manual fixtures.')
  const git = (cwd, args, allowed) => execute(gitExecutable, ['--no-pager', ...args], cwd, env, allowed)
  const outside = await git(baseDir, ['rev-parse', '--show-toplevel'], [0, 128])
  if (outside.code === 0) throw new Error('Fixture directory must be outside every existing Git worktree, so non-Git checks remain meaningful.')
  const emptyTemplate = path.join(helpersDir, 'empty-git-template')
  await fs.mkdir(emptyTemplate)
  const helper = path.join(helpersDir, 'fixture-command.mjs')
  await fs.writeFile(helper, helperSource)
  const fixtureId = randomUUID(), createdAt = new Date().toISOString()
  await fs.writeFile(path.join(baseDir, '.devdock-manual-fixtures.json'), JSON.stringify({ fixtureId, id: fixtureId, purpose: 'DevDock isolated manual acceptance fixtures' }, null, 2))
  const projects = [], scenarios = {}
  const commandText = (action, project) => `${quote(process.execPath)} ${quote(helper)} ${action} ${quote(project)}`
  const command = (name, action, project, kind = 'custom', cwd) => ({ id: randomUUID(), name, kind, command: commandText(action, project), ...(cwd ? { cwd } : {}) })
  async function files(project, title) {
    await fs.mkdir(path.join(project, 'src'), { recursive: true }); await fs.mkdir(path.join(project, 'notes'), { recursive: true })
    await fs.writeFile(path.join(project, 'README.md'), `# ${title}\n\nThis is an isolated DevDock manual acceptance fixture. No external network is used.\n`)
    await fs.writeFile(path.join(project, '.gitignore'), 'dist/\n.manual-runtime/\n')
    await fs.writeFile(path.join(project, 'src', 'calculator.cjs'), 'exports.add = (a, b) => a + b;\n')
    await fs.writeFile(path.join(project, 'notes', 'format-me.txt'), 'A line with trailing spaces.   \nAnother line.  \n')
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: path.basename(project), private: true, version: '1.0.0', scripts: { test: commandText('test', project), build: commandText('build', project), start: commandText('run', project), lint: commandText('lint', project), format: commandText('format', project) } }, null, 2))
  }
  async function configure(project) {
    for (const [key, value] of Object.entries({ 'user.name': 'DevDock Manual Tester', 'user.email': 'manual-test@example.invalid', 'commit.gpgsign': 'false', 'tag.gpgsign': 'false', 'core.autocrlf': 'false', 'core.hooksPath': path.join(project, '.git', 'devdock-hooks'), 'rerere.enabled': 'false' })) await git(project, ['config', '--local', key, value])
    await fs.mkdir(path.join(project, '.git', 'devdock-hooks'), { recursive: true })
  }
  async function make(key, dirname, name, { repository = true, initialCommit = true, configured = true } = {}) {
    const projectPath = path.join(baseDir, dirname)
    await fs.mkdir(projectPath); await files(projectPath, name)
    if (repository) {
      await git(projectPath, ['init', '-b', 'main', `--template=${emptyTemplate}`]); await configure(projectPath)
      if (initialCommit) { await git(projectPath, ['add', '.']); await git(projectPath, ['commit', '-m', 'Initial acceptance fixture']) }
    }
    const project = { id: randomUUID(), name, path: projectPath, commands: [], createdAt }
    if (configured) projects.push(project)
    scenarios[key] = { path: projectPath, ...(configured ? { projectId: project.id } : {}) }
    return project
  }
  async function remote(project, name, push) {
    const target = path.join(remotesDir, name + '.git'); await fs.mkdir(target)
    await git(target, ['init', '--bare', '-b', 'main', `--template=${emptyTemplate}`])
    await git(project.path, ['remote', 'add', 'origin', target])
    if (push) await git(project.path, ['push', '-u', 'origin', 'main'])
    return target
  }
  const workflow = await make('workflow', '01-workflow', '01 · 日常工作流')
  await fs.mkdir(path.join(workflow.path, 'assets'))
  await fs.writeFile(path.join(workflow.path, 'assets', 'sample.bin'), Buffer.from([0, 1, 2, 3, 0, 4]))
  await fs.writeFile(path.join(workflow.path, 'notes', 'obsolete.txt'), 'This tracked file will be deleted.\n')
  await fs.writeFile(path.join(workflow.path, 'notes', 'mixed.txt'), 'Original committed line.\n')
  await git(workflow.path, ['add', '.']); await git(workflow.path, ['commit', '-m', 'Add diff examples'])
  scenarios.workflow.remotePath = await remote(workflow, 'workflow', true)
  await fs.writeFile(path.join(workflow.path, 'notes', 'mixed.txt'), 'Original committed line.\nThis line is STAGED.\n')
  await git(workflow.path, ['add', '--', 'notes/mixed.txt'])
  await fs.appendFile(path.join(workflow.path, 'notes', 'mixed.txt'), 'This line is UNSTAGED.\n')
  await fs.appendFile(path.join(workflow.path, 'README.md'), '\nAn ordinary unstaged text change.\n')
  await fs.writeFile(path.join(workflow.path, 'notes', 'new 中文 file.txt'), 'An untracked filename with spaces and Unicode.\n')
  await fs.unlink(path.join(workflow.path, 'notes', 'obsolete.txt'))
  await fs.writeFile(path.join(workflow.path, 'assets', 'sample.bin'), Buffer.from([0, 9, 8, 7, 0, 6]))
  workflow.commands = [command('Test', 'test', workflow.path, 'test'), command('Build', 'build', workflow.path, 'build'), command('Run', 'run', workflow.path, 'run'), command('Lint', 'lint', workflow.path), command('Format', 'format', workflow.path), command('故意失败', 'fail', workflow.path), command('15秒后完成', 'notify', workflow.path), command('制造代码变更', 'change', workflow.path), command('验证子进程停止', 'check-stop', workflow.path), command('大量日志（截断）', 'flood', workflow.path), command('固定成功', 'success', workflow.path)]
  const first = await make('firstPush', '02-first-push', '02 · 首次 Push')
  scenarios.firstPush.remotePath = await remote(first, 'first-push', false)
  first.commands = [command('Test', 'test', first.path, 'test')]
  const rejected = await make('commitRejected', '03-commit-rejected', '03 · Commit 被拒绝')
  await fs.writeFile(path.join(rejected.path, '.git', 'devdock-hooks', 'pre-commit'), '#!/bin/sh\necho "DELIBERATE REJECTION: manual acceptance pre-commit hook." >&2\nexit 1\n', { mode: 0o755 })
  await fs.appendFile(path.join(rejected.path, 'README.md'), '\nStage this change and verify failed Commit keeps your message.\n')
  rejected.commands = [command('Test', 'test', rejected.path, 'test'), command('解除提交拦截', 'disable-hook', rejected.path)]
  const pushRejected = await make('pushRejected', '04-push-rejected', '04 · Push 拒绝与 Fetch')
  scenarios.pushRejected.remotePath = await remote(pushRejected, 'push-rejected', true)
  const peer = path.join(peersDir, 'push-peer')
  await git(peersDir, ['clone', `--template=${emptyTemplate}`, scenarios.pushRejected.remotePath, peer]); await configure(peer)
  scenarios.pushRejected.peerPath = peer
  await fs.writeFile(path.join(pushRejected.path, 'local-note.txt'), 'A local-only commit.\n')
  await git(pushRejected.path, ['add', '.']); await git(pushRejected.path, ['commit', '-m', 'Add local-only fixture update'])
  await fs.writeFile(path.join(peer, 'remote-note.txt'), 'A remote-only commit.\n')
  await git(peer, ['add', '.']); await git(peer, ['commit', '-m', 'Add remote-only fixture update']); await git(peer, ['push', 'origin', 'main'])
  pushRejected.commands = [command('Test', 'test', pushRejected.path, 'test'), command('远端再增加一次提交', 'advance-remote', pushRejected.path)]
  const nonGit = await make('nonGit', '05-non-git', '05 · 普通文件夹', { repository: false })
  await fs.mkdir(path.join(nonGit.path, 'sub folder'))
  await fs.writeFile(path.join(nonGit.path, 'sub folder', '工作目录标记.txt'), 'The cwd button must print this folder and this file.\n')
  nonGit.commands = [command('Test', 'test', nonGit.path, 'test'), command('输出中文', 'hello', nonGit.path), command('显示自定义工作目录', 'cwd', nonGit.path, 'custom', 'sub folder')]
  const conflict = await make('conflict', '06-conflict', '06 · 未解决的合并冲突')
  await fs.writeFile(path.join(conflict.path, 'conflict.txt'), 'choice=original\n'); await git(conflict.path, ['add', '.']); await git(conflict.path, ['commit', '-m', 'Conflict base'])
  await git(conflict.path, ['checkout', '-b', 'side']); await fs.writeFile(path.join(conflict.path, 'conflict.txt'), 'choice=side\n'); await git(conflict.path, ['commit', '-am', 'Side choice'])
  await git(conflict.path, ['checkout', 'main']); await fs.writeFile(path.join(conflict.path, 'conflict.txt'), 'choice=main\n'); await git(conflict.path, ['commit', '-am', 'Main choice'])
  const merge = await git(conflict.path, ['-c', 'merge.conflictStyle=merge', 'merge', 'side'], [1])
  if (!merge.stdout.includes('CONFLICT')) throw new Error('Expected the conflict fixture to contain a real merge conflict')
  conflict.commands = [command('查看冲突内容', 'conflict', conflict.path)]
  const unborn = await make('unborn', '07-unborn', '07 · 尚无提交和远端', { initialCommit: false })
  unborn.commands = [command('Test', 'test', unborn.path, 'test')]
  const removable = await make('removeMe', '08-remove-me', '08 · 移除与重新添加')
  await fs.writeFile(path.join(removable.path, 'KEEP-ME.txt'), 'Removing this project from DevDock must NOT delete this file.\n')
  await git(removable.path, ['add', '.']); await git(removable.path, ['commit', '-m', 'Keep file after project removal'])
  removable.commands = [command('输出中文', 'hello', removable.path)]
  const add = await make('addMe', '09-add-me', '09 · 手动添加与自动识别', { configured: false })
  const manifest = { fixtureId, createdAt, baseDir, helpersDir, nodeExecutable: process.execPath, gitExecutable, scenarios, customCommandExample: commandText('hello', nonGit.path), defaultTestCommand: commandText('test', workflow.path), longTestCommand: commandText('test', workflow.path) + ' 15000', addProjectPath: add.path, environment: 'Local repositories and bare remotes only. No network or user repository modifications.' }
  await fs.writeFile(path.join(baseDir, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(baseDir, 'fixture-projects.json'), JSON.stringify(projects, null, 2))
  return { projects, manifest }
}
