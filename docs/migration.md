# 迁移指南：0.1.x（JS）→ 1.0.0（TypeScript，dsh ≥ 0.2.2）

本插件从 `dsh-shell-select` 改名为 `@dsh-plugin/dsh-shell-select`，并从纯
JavaScript、面向 dsh 0.1.6-alpha.1 的实现，重写为 TypeScript、面向 dsh ≥ 0.2.2
的实现。本文逐条记录**破坏性变更**及其替代做法。

## 1. 包名与插件 id

| 项目 | 旧 | 新 |
| --- | --- | --- |
| npm 包名 | `dsh-shell-select` | `@dsh-plugin/dsh-shell-select` |
| Cordis 插件名（`export const name`） | `dsh-shell-select` | `@dsh-plugin/dsh-shell-select` |
| 补丁行 id | `shell-select` | `shell-select`（不变：它只是补丁行标识） |
| 配置模板 id | 无（使用 settings 命名空间 `shell-select`） | `dsh-shell-select` |

补丁行 id 保持不变，是为了让已有的 profile 补丁层（若有人按 id 覆盖过）继续命中。
新安装不需要手动改 `cordis.patch.yml`：`dsh.bundle.patch` 会让
`dsh plugin add` 自动接管。

## 2. 配置存储位置

| 旧 | 新 |
| --- | --- |
| `~/.dsh/settings.yaml` 的 `shell-select:` 段 | `<profile>/config/dsh-shell-select/config.json` |

**不会自动迁移。** dsh 0.2.2 的 settings 服务已删除按命名空间
`register` / `installSection` 的契约（只剩 `describe` / `update` / `replace` /
`mutate`，而那是每个插件 Entry 的 Config 表单），因此旧命名空间在新宿主上根本
注册不进去。请在新插件的设置页重新选择一次 Shell；旧段可以手工删除。

字段名与语义保持不变（`shell`、`executable`、`loginShell`、`wslDistro`、
`wslMountRoot`），另外新增：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enableRunInBackground` | `true` | 是否在 `shell` 工具上开放 `run_in_background` |
| `timeoutMs` | `120000` | 前台命令默认超时 |
| `maxTimeoutMs` | `600000` | 单次调用超时上限 |
| `maxOutputBytes` | `64000` | 每路内存输出上限 |
| `maxSpillBytes` | `67108864` | 每路溢写文件上限 |
| `graceMs` | `3000` | SIGTERM→SIGKILL 宽限期 |

旧版本的 `pwshPath` 字段被移除：它属于 dsh 自带 PowerShell 执行器的配置，而本插件
现在自己解析可执行文件，`executable` 覆盖已经覆盖了同一需求。

## 3. 设置界面

| 旧 | 新 |
| --- | --- |
| 手写 `client.js`（`window.__ModuleLoader__.load(...)`）注入 `settings.plugin.item` 槽位 | dsh-loader 2.0 config-api 配置页：一个字段卡片 + 两个临时操作面板 |

因此本包不再声明 `dsh.client`，也不再导出 `./client`。功能对应关系：

| 旧设置卡 | 新配置页 |
| --- | --- |
| 展开/收起卡片、暂存草稿、保存/放弃 | dsh-loader 配置页的「保存 / 取消修改 / 恢复默认值」 |
| Shell 下拉选择（含 `auto` 的解析结果） | 字段 `shell`（选项标签带所属平台） |
| 「检测到的路径 / 版本 / 解释器 / 沙箱 / 权限模式」事实区 | **Shell facts** 面板（`status` 操作，只读、自动执行） |
| 「测试 Shell」「刷新」按钮 | **Test the selection** 面板（`test` 按钮；结果里同时带最新的 Shell facts） |
| 「未保存」标记、保存失败提示 | 配置页的外层提示与字段错误 |

旧卡片上的「因切换 Shell 已清除」提示不再存在，因为保存整份配置才生效，不存在
「暂存值被清除」这个中间状态。

## 4. 宿主 HTTP 路由

旧版本注册两条仅限 loopback 的路由供设置卡读取：

| 旧路由 | 新位置 |
| --- | --- |
| `GET /dsh-shell-select/status` | `status` 面板操作（dsh-loader 的 `/api/dshloader/config/<id>/operations/refresh`） |
| `POST /dsh-shell-select/test` | `test` 面板操作（同上，`…/operations/run`） |

两条旧路由已删除。它们复用 dsh-loader 配置桥接的宿主认证、同源检查与请求体上限，
不再需要本插件自己判断回环地址。

## 5. 执行器接口

| 旧（0.1.x） | 新（0.2.2） |
| --- | --- |
| `ShellExecutor` 抽象方法 `resolve()` + `run(spec)` + `start(spec)` | `resolve()` + `execute(spec) → ShellExecution` |
| `runArgv(spec, argv)` / `startArgv(spec, argv)` | `protected executeArgv(spec, argvOrPrepare, onStarted?)` |
| 结果直接从 `run()` 返回 | 句柄的 `result()` 是前台投影 |

本插件对应地：`decide()` 产出的 decision 挂在 spec 上，`execute()` 复用；一次调用
的拒绝、可执行文件解析、argv 构建与沙箱事实因此仍只发生一次。

## 6. 依赖声明

| 旧 | 新 |
| --- | --- |
| `dependencies`: `@deepseek-ai/schemastery` | 无运行时依赖 |
| `peerDependencies`: 11 个 `@deepseek-ai/dsh-*` + `@deepseek-ai/cordis` | 仅 `@dsh-plugin/dsh-loader` |
| `engines.node`: `^22.19.0 \|\| >=24.0.0` | `>=24.9.0` |

`@deepseek-ai/*` 不在运行时依赖里，是因为它们必须来自**正在运行的宿主**，而不是
profile 里可能指向上一个版本的解析结果。`src/host.ts` 从运行时的入口脚本锚点
解析并版本校验后才绑定；这一步失败会让插件在加载期明确报错，而不是在第一条命令时
行为异常。

兼容性声明改为 `engines.dsh: ">=0.2.2-0"`：存在该字段时宿主只按它判断，忽略
peer 里的 `@deepseek-ai/dsh-*` 版本。

## 7. 安装与验证命令

```sh
# 安装（推荐，npm 已发布版本）
dsh plugin --profile web add "@dsh-plugin/dsh-shell-select"

# 从本地 checkout 安装（构建产物随 npm 包分发；本地路径安装需先 build）
npm install && npm run build
dsh plugin --profile web add link:/absolute/path/to/dsh-shell-select
```

构建、类型检查与测试：

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

## 8. 未变的部分

- 只有 **一个** 面向模型的工具：`shell`；模型没有按调用选择 Shell 的参数。
- 自带的 `bash` / `pwsh` 工具仍被全局守卫拒绝并指名 `shell`。
- `auto` 的解析规则、各 Shell 的 argv 方言、身份守卫、沙箱拒绝策略均保持原语义。
- 组合补丁仍禁用 `bash-sandbox`、`pwsh-sandbox`、`tool-bash`、`tool-pwsh` 四行。
