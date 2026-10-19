# DevDock

[English](README.md) · **简体中文**

一个独立的 Windows 开发悬浮面板。把 Test、Commit、Push 和项目常用命令放在手边，配合你习惯的编辑器使用。

采用 Electron、React 和 TypeScript，无需 DevDock 账号。当前应用界面为简体中文。

![DevDock 紧凑工具条](docs/screenshots/compact.png)

[主面板](docs/screenshots/panel.png) · [提交界面](docs/screenshots/commit.png)。截图来自隔离的演示项目。

## 功能

- 可拖动的独立窗口，支持置顶、紧凑工具条、系统托盘和自定义全局快捷键。
- 多项目切换，每个项目分别保存命令按钮和工作目录。
- 自动识别 `package.json` 中的 Test、Build、Run、Lint、Format 脚本；其他工具和语言可添加自定义命令。
- 实时命令输出、耗时、退出码、完成通知，以及 Windows 子进程树取消。
- Git 分支与工作区状态、文件差异、整文件暂存和取消暂存，提交实际暂存区内容。
- Push、首次推送关联上游、Fetch；推送前显示目标。
- 仓库设置页面：初始化 Git、设置当前仓库的提交身份、管理远程地址。
- GitHub 账号识别、浏览器授权、选择已有仓库、创建空仓库，默认设为私有。
- 测试结果关联运行开始时的 Git 状态，状态变化后提示测试结果已过期。
- 保存设置与最近 100 次操作记录，重启后识别上次中断的任务。

## 环境要求

- **Windows x64**，暂不支持其他平台。
- 从源码开发或构建需要 **Node.js 24** 和 npm；打包后的应用自带运行环境。
- Git 操作需要 **Git**，并能通过 `PATH` 找到。
- GitHub 账号与仓库设置功能需要 **[GitHub CLI](https://cli.github.com/)**（`gh`）。其他远程仓库可以使用本机已有的 Git 凭据或 SSH 密钥。
- 项目命令需要对应的工具和依赖，例如 Python、Java 或 Node.js。

## 从源码运行

```powershell
git clone https://github.com/ActorF/DevDock.git
cd DevDock
npm ci
npm run dev
```

界面支持热更新。修改 `electron/` 或 `shared/` 后，需要重启开发进程。

在本机运行生产构建：

```powershell
npm run build
npm start
```

构建 Windows 免安装程序：

```powershell
npm run package
```

0.2.0 版本生成 `release/DevDock-0.2.0-portable.exe`。双击即可运行，首次解压启动可能需要几秒。`npm run package:dir` 会生成解包目录，可直接运行其中的 `release/win-unpacked/DevDock.exe`。本地构建的程序未进行代码签名。

## 开始使用

1. 点击 **添加项目**，选择文件夹或输入完整路径。
2. 查看自动识别的命令，也可以通过 **添加按钮** 填写 `python -m pytest`、`mvn test` 等命令。只有点击按钮才会执行。
3. 点击 **Test** 运行测试；打开 **Commit** 查看差异、暂存文件并填写提交说明。
4. 打开 **Push**，确认远程仓库与分支后推送。
5. 默认通过 **Ctrl+Shift+Space** 显示或隐藏面板，也可以在设置中修改快捷键、置顶和通知偏好。

如果文件夹还不是 Git 仓库：

1. 打开 **仓库与账号**，初始化 Git。
2. 连接 GitHub。已有 `gh` 登录会自动识别，否则可以从面板发起浏览器授权。
3. 设置提交姓名和邮箱，或点击 **使用 GitHub 身份**，采用账号姓名和 GitHub 的隐私 noreply 邮箱。
4. 选择已有仓库、创建空仓库，或手动添加远程地址。
5. 完成 Commit 后再 Push。创建或连接仓库不会自动上传项目文件。

提交身份和 GitHub 凭据助手设置只写入所选仓库的本地 Git 配置，不修改全局 Git 身份。GitHub 登录凭据由 GitHub CLI 管理，DevDock 的 JSON 配置中不保存访问令牌。授权行为可参考 [GitHub CLI 官方说明](https://cli.github.com/manual/gh_auth_login)。

## 操作行为

**暂存与提交。** 勾选文件会暂存整个文件，取消勾选会取消该文件的暂存；项目原有暂存内容会保留。如果同一文件同时有暂存和未暂存修改，可以分别查看两个版本。提交只包含实际暂存区内容，提交前会检查状态是否在审阅后发生变化。

**测试。** 成功表示命令正常退出，不会从任意输出中猜测通过了多少个用例。Git 状态变化后，之前成功的测试会显示为已过期。这是辅助提示，不是强制推送门禁。非 Git 文件夹也可以执行命令，但没有 Git 状态跟踪。

**远程。** 领先和落后计数基于本地已经获取的远程信息。Fetch 更新这些信息，不会合并代码。“测试连接”检查读取权限，空仓库也可以连接成功；实际 Push 时才会验证写入权限。DevDock 不自动合并或强制推送。网络 Git 操作有超时限制，没有手动停止按钮。

**命令环境。** Windows 使用 CMD 执行按钮命令，以当前用户权限运行，并继承应用启动时的环境变量。新装工具或修改 `PATH` 后，请重启 DevDock。输出区域是文本日志，不是交互式终端；需要输入密码或选择菜单的命令，可以通过面板的终端入口运行。

**隐藏与退出。** 窗口关闭按钮会隐藏到托盘，命令继续运行。真正退出使用托盘菜单或设置中的退出选项；有任务时会提示。重启 DevDock 不会重新执行上次的命令。

## 本地数据

配置与操作历史保存在：

```text
%APPDATA%\DevDock\config.json
%APPDATA%\DevDock\history.json
```

项目源码保留在原文件夹。移除项目只会移除面板里的配置。备份这两个 JSON 文件即可保留设置和历史。

历史保留最近 100 次操作，单次操作日志保留最后 128 Ki 字符。日志可能包含项目工具输出的数据。GitHub 操作、远程 Git 命令以及你配置的命令可能访问网络；DevDock 没有云端同步服务。

配置通过临时文件和原子替换保存，支持 Windows AppData 跨盘重定向。配置或历史异常时会先备份，再进行恢复。上次仍在运行的任务会在下一次启动时标记为已中断。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:smoke
npm run test:ui
npm run test:persistence
npm run test:git-setup-ui
```

- `npm test` 验证 Git、GitHub 服务行为、命令执行、持久化和存储重定向；GitHub 服务测试使用模拟响应。
- `test:smoke` 使用临时项目、独立配置和本地裸仓库检查真实 Electron 应用。
- `test:ui` 验证实际按钮交互，包括提交失败和提交草稿保留。
- `test:persistence` 在真实 Windows AppData 下创建隔离配置，检查文件夹选择和重启保存。
- `test:git-setup-ui` 通过界面验证仓库初始化、提交身份和远程管理。

这些检查不会向你的远程仓库推送。部分检查会短暂显示窗口，截图保存在已忽略的 `artifacts/screenshots/` 中。检查解包后的程序时，先设置以下变量，再运行 Electron 检查：

```powershell
$env:DEVDOCK_TEST_EXECUTABLE = "$PWD\release\win-unpacked\DevDock.exe"
```

### 人工验收

执行 `npm run package` 后，运行：

```powershell
npm run prepare:manual
npm run test:manual-preflight
```

生成器会在源码目录旁创建一套新的隔离资料：10 个项目文件夹，其中 8 个预加载、2 个供手动添加；另有 5 份配置、启动器和包含 82 项检查的 HTML 清单。清单可在本机保存结果并导出。生成新一轮资料不会覆盖上一轮验收或日常使用的配置。

大部分检查使用本地 Git 远程；可选的 GitHub 检查需要账号和网络。具体操作见 [人工验收清单](docs/manual-acceptance.md)。恢复和历史容量场景中的预置记录明确标注为样例，不代表实际执行过对应命令。

单独运行 `node scripts/github-live-validation.mjs --live` 可以进行联网验证：需要 GitHub CLI 已登录，并会创建私有测试仓库，执行真实 Push 等网络操作。它不属于普通测试命令。验证记录写入本机的 `artifacts/github-validation.json`，不会提交到本仓库。

## 项目结构

```text
electron/main.ts       窗口、托盘、通知和 IPC
electron/preload.ts    受限的界面调用桥接
electron/services/    Git、GitHub、命令执行和持久化
renderer/             React 界面与样式
shared/types.ts       主进程和界面共享的类型
tests/                服务与集成测试
scripts/              开发、打包和验收工具
docs/                 截图与人工验收清单
```

界面启用沙箱和上下文隔离，不开放 Node.js。Git 操作使用参数数组，不会将提交说明拼接为 shell 命令。自定义按钮则按你的配置执行 shell 命令。

## 当前范围

DevDock 0.2.0 面向 Windows x64，提供中文界面。GitHub 选择列表显示已登录账号最近更新的最多 100 个自有仓库，其他仓库地址可以手动输入。目前没有自动更新、按行暂存、冲突编辑器、自动合并、云同步或插件市场。

欢迎通过 [GitHub Issues](https://github.com/ActorF/DevDock/issues) 和 Pull Request 提交问题与改进。

## 许可证

[MIT](LICENSE)。
