import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'

export function batchLiteral(value) {
  if (/[\r\n%!"]/u.test(value)) throw new Error(`Path cannot be represented safely in a launcher: ${value}`)
  return value
}

export function manualLauncher(executable, profile) {
  return [
    '@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE="', 'set "ELECTRON_RENDERER_URL="',
    'set "DEVDOCK_TEST_MODE="', `set "DEVDOCK_DATA_DIR=${batchLiteral(profile)}"`,
    `start "" "${batchLiteral(executable)}"`, 'exit /b', '',
  ].join('\r\n')
}

/** Add the unregistered, non-Git setup example without overwriting any user edits. */
export async function prepareGitSetupFixture(base) {
  const project = join(base, '10-git-setup')
  await mkdir(project, { recursive: true })
  const files = {
    'README.md': '# DevDock 仓库与账号验收\n\n这个文件夹初始没有 Git 仓库。请从 DevDock 添加它，按人工验收 H01–H15 操作。\n\nTest 检查加法函数；Build 生成 dist/build-result.json。\n',
    'package.json': JSON.stringify({ name: 'devdock-git-setup-manual', version: '1.0.0', private: true, scripts: { test: 'node check.cjs', build: 'node build.cjs' } }, null, 2) + '\n',
    '.gitignore': 'dist/\nnode_modules/\n',
    'calculator.cjs': 'exports.add = (a, b) => a + b;\n',
    'check.cjs': "const assert = require('node:assert/strict');\nconst { add } = require('./calculator.cjs');\nassert.equal(add(2, 3), 5);\nassert.equal(add(-2, 2), 0);\nassert.equal(add(0, 0), 0);\nconsole.log('PASS: 3 calculator assertions.');\n",
    'build.cjs': "const fs = require('node:fs');\nconst path = require('node:path');\nconst output = path.join(__dirname, 'dist', 'build-result.json');\nfs.mkdirSync(path.dirname(output), { recursive: true });\nfs.writeFileSync(output, JSON.stringify({ result: 'success', builtAt: new Date().toISOString() }, null, 2));\nconsole.log('Build complete: ' + output);\n",
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(project, name), content, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  return project
}

export async function readOnlineEvidence(root) {
  try { return JSON.parse(await readFile(join(root, 'artifacts', 'github-validation.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function onlineProfileAvailable(evidence) {
  if (!evidence?.profile || !evidence?.project) return false
  try { await access(join(evidence.profile, 'config.json')); await access(evidence.project); return true }
  catch { return false }
}

export async function prepareManualChecklist(root, base, manifest, evidence) {
  const replacements = {
    '{{SUITE_ROOT}}': base,
    '{{ADD_PROJECT_PATH}}': manifest.scenarios.addMe.path,
    '{{GIT_SETUP_PROJECT_PATH}}': manifest.scenarios.gitSetup.path,
    '{{LOCAL_CHECK_REMOTE}}': manifest.scenarios.firstPush.remotePath,
    '{{CUSTOM_COMMAND}}': `"${manifest.nodeExecutable}" -e "console.log('HELLO MANUAL')"`,
    '{{DEFAULT_TEST_COMMAND}}': manifest.defaultTestCommand,
    '{{LONG_TEST_COMMAND}}': manifest.longTestCommand,
    '{{ONLINE_PROJECT_PATH}}': evidence?.project || '尚未准备联网项目；可按 H08–H10 创建新的测试仓库',
    '{{ONLINE_REPOSITORY}}': evidence?.owner && evidence?.name ? `${evidence.owner}/${evidence.name}` : '你账号下用于验收的测试仓库',
    '{{ONLINE_ACCOUNT}}': evidence?.owner || '你的 GitHub 账号',
  }
  let checklist = await readFile(join(root, 'docs', 'manual-acceptance.md'), 'utf8')
  for (const [key, value] of Object.entries(replacements)) checklist = checklist.replaceAll(key, String(value))
  if (/\{\{[A-Z_]+\}\}/.test(checklist)) throw new Error('Manual checklist contains an unresolved placeholder')
  return checklist
}

export function onlineVerificationNote(evidence, version, hasLauncher) {
  if (!evidence) return `# 联网验证说明\n\n应用版本：${version}。本次生成器没有找到已完成的联网验证记录，因此没有预设 GitHub 仓库或联网启动入口。\n\n主验收 A–G 使用本机远程。H01–H15 从 10-git-setup 开始，可自行连接 GitHub 账号、选择已有仓库或创建私有测试仓库。创建和 Push 按钮会真实操作你选择的 GitHub 账号与仓库。\n\n首次浏览器 OAuth 登录需由你在 GitHub 页面确认，清单 H15 用于记录这一步。\n`
  const translations = [
    [/account detected/i, '应用识别已登录的 GitHub 账号。'],
    [/Initialized a new repository/i, '通过桌面界面初始化普通文件夹的 Git 仓库。'],
    [/Saved project-local commit identity/i, '将 GitHub 姓名和隐私邮箱保存为项目本地提交身份。'],
    [/Created and connected private repository/i, '通过界面创建并关联私有 GitHub 仓库。'],
    [/Authenticated Git connection/i, '使用已认证连接读取远程，空仓库也能正确识别。'],
    [/Test and first Commit/i, 'Test 与首次 Commit 成功，包含中文及带空格的文件名。'],
    [/First Push reached/i, '首次 Push 上传到真实 GitHub 并关联 origin/main，本地和服务器提交 SHA 一致。'],
    [/Existing-repository selection/i, '选择已有仓库、添加远程、编辑改名、连接测试和移除远程成功。'],
    [/Fetch sees/i, 'Fetch 识别真实远程新增提交并更新落后数量，没有自动合并工作区。'],
    [/non-fast-forward/i, '真实的非快进 Push 被拒绝，界面显示失败，远程历史没有被强制覆盖。'],
    [/Build, streaming command/i, '联网项目内的 Build、持续输出命令和 Stop 成功。'],
  ]
  const checks = (evidence.checks || []).map(item => translations.find(([pattern]) => pattern.test(item))?.[1] || item)
  return `# 联网验证说明\n\n应用版本：${version}。以下是已经执行的自动验证记录，人工验收结果仍由你填写。\n\n- GitHub 账号：${evidence.owner}\n- 私有测试仓库：${evidence.url}\n- 本地联网项目：\`${evidence.project}\`\n- 独立配置目录：\`${evidence.profile}\`\n- 自动验证完成时间：${evidence.completedAt}\n- 记录中的最终提交：\`${evidence.finalHead}\`\n\n${hasLauncher ? '双击 `08-启动联网验收.cmd` 可打开这一独立联网项目。主验收仍使用 `01-启动主验收.cmd`，原先的 8 个预设项目、配置与历史保留。' : '本机没有找到记录中的完整配置和项目，未生成联网启动器。可按 H01–H10 准备一份新的测试项目。'}\n\n## 已验证范围\n\n${checks.map(item => `- ${item}`).join('\n')}\n\n本地远程表单另有真实界面操作验证：新增、编辑地址和名称、测试空远程、取消移除及确认移除。\n\n## 人工复测\n\n打开联网入口可以检查账号、远程、提交记录、Test / Build 和日志。面板显示的是当前 Git 状态，以上列表记录的是已执行过的成功及失败场景。\n\n需要从初始化到首次上传完整再做一遍时，请在主验收中添加 \`10-git-setup\`，按 H01–H15 操作。H09 使用新的仓库名称和 fresh-origin，不覆盖已有 origin。点击创建和 Push 会真实创建仓库、上传测试文件。\n\n## 首次登录的验证边界\n\n当前机器已有 ${evidence.owner} 的 GitHub CLI 登录，因此本次没有退出账号，也没有重复首次浏览器 OAuth 授权。H15 可在尚未登录的环境中人工验证；当前环境可填写“未测”。GitHub 密码或令牌不需要粘贴到 DevDock。\n`
}
