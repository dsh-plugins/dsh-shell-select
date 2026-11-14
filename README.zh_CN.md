<div align="center">

<img src="icon.svg" alt="Shell 选择" width="96" height="96">

# Shell 选择

**选择每个智能体命令运行所用的 Shell，并查看这台机器实际解析出的结果。**

[English](README.md) · [简体中文](README.zh_CN.md)

[![npm](https://img.shields.io/npm/v/@dsh-plugin/dsh-shell-select.svg)](https://www.npmjs.com/package/@dsh-plugin/dsh-shell-select)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)

</div>

PowerShell、Windows PowerShell、`cmd.exe`、Git Bash、WSL Bash、`bash`、`zsh`、
`fish` 或系统 `sh`：你选一个，它作为插件设置保存下来，此后每个智能体命令都用它。

选择权属于部署，不属于模型。智能体只有**一个** `shell` 工具，无法为单条命令换
Shell；当前权限模式无法限制的 Shell 会被拒绝，而不是在沙箱之外运行。

## 功能

| 能力 | 说明 |
|---|---|
| 一个部署一个 Shell | 选择器接管 `ctx.shell`，因此 `shell` 工具、hook 命令与宿主自带的探测都走它。自带的 `bash` 与 `pwsh` 工具被拒绝，并在理由里指名 `shell`。 |
| 自动探测 + 显式覆盖 | Shell 按名字经宿主自己的可执行文件解析查找。Shell 装在非常规位置、或同一 Shell 装了两份时，设置 `executable`。无法解析、或指向了**另一个** Shell 的路径是错误，绝不会退化成「再找找看」。 |
| 失败即拒绝的沙箱 | 所选 Shell 在当前权限模式下无法被限制时，调用在**任何进程存在之前**就被拒绝。不静默回退，也不静默丢掉沙箱。 |
| 事实，而非声明 | 面板分开报告三件事：可执行文件能否解析、目录对该平台沙箱能力的**预期**、以及这台机器**实测**到的行为。 |
| 固定自检 | 一个按钮用已保存的选择跑一条固定命令，走的限制与模型调用相同，在部署的工作区根目录执行。 |
| 模型知道该 Shell 的写法 | 每个 Shell 自带语法说明（PowerShell 路径、`cmd` 变量展开、WSL 的 `/mnt/...`、fish 的非 POSIX 语法），每个模型步都会重新读取。 |
| 不自建执行机制 | 超时、输出上限、后台任务与沙箱限制全部沿用宿主原实现。 |

## 快速开始

```sh
dsh plugin --profile web add "@dsh-plugin/dsh-shell-select"
dsh web
```

然后打开 **设置 → 插件 → Shell 选择**：

1. 选择一个 Shell。默认的**自动**会从平台和 `executable` 覆盖解析；**Shell facts**
   面板会告诉你解析成了哪个。
2. 点击**保存**。
3. 在「Test the selection」面板点击**测试 Shell**，用已保存的选择跑一条固定命令。

**自检跑的是已保存的选择，而不是表单里暂存的修改。** 它报告拒绝，就是此刻命令会
得到的拒绝。

### 从本地检出版本安装

```sh
git clone https://github.com/dsh-plugins/dsh-shell-select
cd dsh-shell-select && npm install && npm run build
dsh plugin --profile web add link:/absolute/path/to/dsh-shell-select
```

`link:` 安装会让检出版本保持活动：改完插件、重启 profile 即可看到变化。插件安装到
已提供宿主的 profile，因为它从**正在运行的安装**解析宿主包，而不是自带一份副本。

## 支持的 Shell 与兼容性

| 平台 | 目录条目 | 本仓库实测过的限制能力 |
|---|---|---|
| Windows（主要） | `pwsh`、`powershell 5.1`、`cmd`、`gitbash`、`wsl` | `cmd.exe` 与 PowerShell 5.1，已验证 |
| Linux | `bash`、`zsh`、`fish`、`sh`、`pwsh` | POSIX 各行依据宿主文档化的包装行为，**不是**本插件实测 |
| macOS | `bash`、`zsh`、`fish`、`sh`、`pwsh` | 未验证 |

**在 Windows 上，Git Bash 与 WSL Bash 无法在沙箱使用的受限令牌下启动**，因此在
`workspace-write` 与 `read-only` 下被拒绝，面板的版本探测也不例外；它们只在
`danger-full-access` 下运行。这个拒绝是刻意的：否则就是在运行一个沙箱限制不住的
Shell。

`engines.dsh` 为 `>=0.2.2-0`：插件需要 0.2.2 的 shell seam（`resolve`/`execute`）
与 config-api 设置页。CI 在 Windows、Linux、macOS 三个平台跑测试套件；上表的平台
一列说明的是本插件**自己实测**的结果，而非宿主文档的描述。

## 配置

插件的设置保存在 `<profile>/config/dsh-shell-select/config.json`，由 dsh-loader
写入，在插件页面编辑。

| 设置 | 默认值 | 含义 |
|---|---|---|
| `shell` | `auto` | 一个目录 id，或 `auto`。 |
| `executable` | 空 | 所选 Shell 的显式路径，优先于自动探测。无法解析、或指向**另一个** Shell 的路径是错误，而不是去搜索的提示。 |
| `loginShell` | `false` | 以 `-l` 运行 bash 系列，每条命令都会加载你的 profile 脚本。 |
| `wslDistro` | 空 | WSL 发行版名称；留空使用该发行版默认值。 |
| `wslMountRoot` | `/mnt` | 该发行版挂载 Windows 磁盘的位置。 |
| `enableRunInBackground` | `true` | 在 `shell` 工具上开放 `run_in_background`。 |
| `timeoutMs` | `120000` | 前台命令默认超时。 |
| `maxTimeoutMs` | `600000` | 单次调用超时覆盖的上限。 |
| `maxOutputBytes` | `64000` | 每路内存输出上限。 |
| `maxSpillBytes` | `67108864` | 每路溢写文件上限。 |
| `graceMs` | `3000` | SIGTERM→SIGKILL 宽限期。 |

**自动**是默认值，因为它复现部署原本的行为：目录中第一个能解析的条目——Windows 上
是 PowerShell（宿主自带执行器所运行的），Linux 上则跟随 `$SHELL` 命中的目录条目。
显式的 `executable` 会改变答案，因为覆盖本身就声称了「我要这个 Shell」：`shell` 为
`auto` 而 `executable` 指向某个 `bash.exe` 时，跑的就是那个 bash，用 bash 的参数。

设置变更只影响后续调用。它绝不改变正在准备的调用、正在运行的进程，或已结束调用记录的
事实。

## 从 `dsh-shell-select` 0.1.x 升级

包已改名为 `@dsh-plugin/dsh-shell-select`，重写为 TypeScript，并把目标提高到
dsh ≥ 0.2.2。**设置不会自动迁移**：dsh 0.2.2 移除了旧版本使用的按命名空间 settings
契约，因此需要在新表单里重新选择一次。其余部分——单一 `shell` 工具、
`bash`/`pwsh` 的拒绝、`auto` 规则、各个 argv 方言——语义不变。完整破坏性变更清单见
[migration.md](docs/migration.md)。

## 排查与限制

**找不到 `<shell>` 可执行文件。** 插件按名字查找但没找到。安装它，或把 `executable`
设为完整路径。错误里列出了所有探测过的位置。

**在当前权限模式下被拒绝。** 所选 Shell 无法被本次会话解析出的沙箱限制。Windows 上
Git Bash 与 WSL Bash 在 `workspace-write`、`read-only` 下属于预期。拒绝信息会指名
Shell 与模式；请选择该模式能限制的 Shell，或故意把会话切到 `danger-full-access`。

**自动显示「未知」。** 宿主还没有解析出 `executable` 覆盖，或该覆盖指向的东西没装。
「自动」是按它自己的配置解析的，与「已保存的选择跑什么」是两个不同的问题。

**插件加载失败，消息里列出一串锚点。** `src/host.ts` 找不到可绑定的 dsh ≥ 0.2.2。
消息里列出了所有尝试过的锚点；把 `DSH_SHELL_SELECT_HOST_ANCHOR` 设为正在运行的
`dsh` 入口的绝对路径（通常是 `<dsh>/lib/bin.js`）即可指定。

**`cmd` 的特殊行为。** 命令一次性抵达 `cmd.exe`，因此命令里的 `%NAME%` 保持字面；
需要展开时写 `call echo %CD%`。非 ASCII 输出取决于控制台代码页。Unicode 路径与文件名
不受影响。

**`wsl.exe` 的诊断信息显示为乱码。** 未安装任何发行版时，`wsl` 以 UTF-16LE 写出
「请运行 `wsl.exe --install`」之类的提示，而输出收集器按 UTF-8 解码，于是显示为乱码。
命令本身已执行、退出码也如实报告，只是措辞无法阅读。解码归 subprocess seam 负责，
本插件不重新编码。

**选择器不控制的路径。** 智能体命令走所选 Shell，但 `run_code` 的程序体、基于 PTY 的
终端工具、以及进程外子智能体会自行创建进程。完整清单与原因见
[architecture.md](docs/architecture.md#execution-routes-covered-and-not-covered)。

Shell 选择不是破坏性命令防护。沙箱按会话权限模式限制写类访问；本插件不提供破坏性命令
检测，也不是安全层。

## 开发

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

测试在 `<projectRoot>/.test-tmp/<unique-id>/` 下创建临时目录。它们拒绝落在真实用户
profile 内的根目录，因此位于 profile 内的检出版本（`$HOME` 下的克隆、CI runner）必须
指定一个在外的、被批准的根目录：

```sh
# Linux、macOS 或 Git Bash——用 /var/tmp，不要 /tmp：POSIX profile 把 /tmp 授予可写
DSH_SHELL_SELECT_TEST_TMP=/var/tmp/dsh-shell-select npm test
```

```powershell
# Windows：指定 profile 之外的路径，因为 %TEMP% 就在 profile 内
$env:DSH_SHELL_SELECT_TEST_TMP = 'D:\dsh-shell-select-test-tmp'
npm test
```

一次调用如何被决定、宿主包为何在运行时解析而不是声明为依赖，见
[architecture.md](docs/architecture.md)。

测试套件位于 `tests/`，针对 `lib/` 下的构建产物运行（即 profile 实际安装的内容）：

| 套件 | 覆盖内容 |
|---|---|
| `catalog` | 两个平台的目录、条目身份、身份守卫、限制结论、候选枚举与探测选择 |
| `dialects` | 每个方言的完整 argv、`cmd` 的环境变量传输、WSL 挂载路径翻译、版本查询 |
| `discovery` | 经 seam 解析、显式路径按名失败、工作目录规则 |
| `executor` | 决策与各类拒绝（零次 spawn）、两个平台的 `auto`、模型可见描述、状态表面 |
| `tool` | 单一 `shell` 工具、`bash`/`pwsh` 守卫、两种调用卡片、后台任务路径 |
| `config` | 配置模型的默认值与拒绝、由它派生的表单 |
| `status` | 三类事实各自独立、自检的失败阶段 |
| `package` | 包契约：入口、随包文件、locale、图标、`engines.dsh` |

## 许可证

[MIT](LICENSE)，版权所有 2026 Muhammad Athif Humam。

启动时先提供 shell 服务，设置加载与工具注册分别在依赖可用后完成；设置 I/O 和探测不会加入 Cordis 启动等待链。Windows 父类不再扫描本机 PATH，真正执行命令时仍通过宿主 subprocess 解析并验证所选 shell。
