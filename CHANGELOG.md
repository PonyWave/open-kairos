# CHANGELOG

## f16b2e2 - 2026-11-13

来源分支：main，合并提交 f16b2e2。

### 变更

- `kairos-daemon start`/`stop`/`status` 的 `env_id` 参数变为可选：单绑定设备自动选择唯一环境；macOS 多绑定设备可传环境 ID 或设备名（如 `kairos-daemon stop my-mac`），终端可交互且未传参时列出候选环境供选择，非交互环境报错并列出可选 ID。
- 配对安装命令的收尾输出完善：告知已安装、配对并启动，可关闭终端；打印本机 GUI 访问地址（与 Server 同源，用 `kairos start` 打印的带令牌地址登录）和 `status`/`stop`/`start` 管理命令。
- GUI 环境详情页的 Daemon 命令指引改为不带 `env_id` 的简洁形式。

## 4f92b6a - 2026-11-13

来源分支：main，合并提交 4f92b6a。

### 新增

- bash 工具结果在输出预览截断或存在缺口时附加 `hint`，指引使用 `read_output` 按 `next_offset` 续读；`read` 还有更多行时附加 `offset` 续读提示。
- `write`/`edit` 成功后在目标环境探测目标文件目录链上的 `AGENTS.md`（至多 5 级，主环境工作区根目录除外），命中时工具结果附加 `agents_md_hint` 提醒，同一执行内按路径去重。
- `<agent-execution-environment>` JSON 新增 `started_at`（对话创建时间）；需要精确当前时间时在 bash 中执行 `date`。

## 760961e - 2026-11-13

来源分支：main，合并提交 760961e。

### 变更

- 后台委派交付与 `thread_notify` 通知的注入文本统一包裹 `<system-reminder>` 标签并附说明行，系统提示词声明其为自动交付记录、不是用户消息。
- 交付的 `response` 超过 8000 字符时截断为预览并标记 `response_truncated`，可用 `thread_read`/`subagent_status` 读取完整结果。

### 新增

- 用户取消 Run 后，下一次根执行的系统指令附带中断提醒（上一执行被用户中断、历史部分输出不完整），执行完成后自动消失。

## d063e30 - 2026-11-13

来源分支：main，合并提交 d063e30。

### 变更

- 系统提示词新增通用规范：Safety（真实机器非沙箱、禁止读取凭据、工作目录外修改与 git 变更需用户明确要求）、Coding and verification（根因修复、最小改动、匹配现有风格、不假设依赖、验证后汇报）、Output（Markdown、文件引用带行号、按变更规模控制长度）与 AGENTS.md 作用域优先级规则。
- `read`/`write`/`edit`/`bash`/`read_output` 等基础工具描述补全语义、参数说明与协作流程；`thread_call`/`subagent`/`thread_notify`/`send_to_user` 描述精简，委派规则以系统提示词为唯一完整副本。

## 787cc9f - 2026-11-13

来源分支：main，合并提交 787cc9f。

### 移除

- 平台 sandbox 遗留协议：`EnvironmentKind` 的平台环境枚举值、`PlatformLifecycleState` 枚举、`Environment.lifecycle_state` 字段与 `ERROR_CODE_SANDBOX_CAPACITY_EXHAUSTED`、`ERROR_CODE_SANDBOX_UNAVAILABLE` 错误码（编号与名称保留）。Server 的平台环境守卫与 sandbox 容量失败分支、GUI 的容量提示卡片一并删除；主环境未就绪时快照通过 `statusReason` 表达。
- 迁移命令中 Kairos 历史数据的转换逻辑（interaction 交付、目录 Operation 初始形态、agent 编号改写等约 500 行不可达代码）；版本预检、备份与逐表复制的迁移框架保留，命令行为不变。
- 无读取方的配置项 `KAIROS_DEVICE_BASH_ENABLED`；设置页账户资料中的邮箱展示行。

### 变更

- `DEVICE_BASH_MAX_TIMEOUT_SECONDS` 更名为 `BASH_MAX_TIMEOUT_SECONDS`，取值不变。
- GUI 测试文件调整：排队输入展示用例迁移至 conversation-queued-input.test.ts，sandbox-draft.test.ts 更名为 topic-drafts.test.ts。

## 3f66760 - 2026-11-13

来源分支：main，合并提交 3f66760。

### 变更

- v1 基线删除无代码使用的 `device_tool_calls`、`device_tool_results`、`auth_email_verifications`、`auth_setup_credentials` 四张表及关联索引，新安装的数据库不再创建这些表。

### 修复

- 文档与实现对齐：固定端口使用 `KAIROS_PORT` 环境变量；启动结构图修正为 Server 同端口托管 GUI；`.env.example` 的迁移与浏览器安装说明改指 `docs/development.md`。
- `goals-and-scope` 功能范围补全 `web_fetch`、`web_search`、`browser`、`send_to_user`、`env_sync` 与文件工具；`development` 补充受限 browser 工具的 Chromium 安装命令。

## 7b7b580 - 2026-11-13

来源分支：main，合并提交 7b7b580。

### 变更

- 存储格式重置为 v1 基线：`context_recap`、`server_runtime`、`devices`、`environment_operations` 四个命名空间各以单一版本 1 安装最终结构，版本号重新计数。删除平台环境表（`platform_environments`、`platform_usage_intents`、`platform_lifecycle_intents`）、`device_bash` 命名空间（`device_bash_operations`、`device_bash_output_chunks`）和 `environments.platform_lifecycle_state` 列。
- 移除旧设备 Bash 审计读取路径（`DeviceBashStore`、`device_tool_results` 恢复）与 `bashOperationChanged` 事件；Bash 日志只读取 `server_bash_operations`。
- 迁移命令现在只识别 v1 数据库；带旧版本或未版本化应用表的数据库明确拒绝，不为 Kairos 旧数据提供迁移。

## 2085fa7 - 2026-11-13

来源分支：main，合并提交 2085fa7。

### 新增

- GUI 按工作空间聚类：侧栏改为工作空间分组，每组固定展示工作空间 main 对话（无消息也展示）与任务 Thread，临时对话独立分组；每个分组内提供新建话题入口，草稿创建携带 `workspace_id`。
- 工作空间管理页：创建（设备选择 + 目录浏览）、重命名、打开主对话。
- 全部对话页按工作空间分组展示卡片。

## 722d959 - 2026-11-13

来源分支：main，合并提交 722d959。

### 新增

- 工作空间模型：`workspaces` 表（设备 + 工作目录，租户内唯一），创建工作空间时在同一事务创建其工作空间 main 对话；`threads` 扩展 `thread_type`（`main` / `workspace_main` / `task`）与 `workspace_id`。
- 执行规格默认环境按工作空间解析，Subagent 继承父执行环境。
- `thread_notify` 增加 `target` 参数（`workspace` / `global`）；工作空间 main 与临时对话固定 `global`。
- `thread_call` / `thread_list` 按工作空间作用域，全局 main 可调用工作空间 main；新增 `workspace_list` 工具。
- 新增 `WorkspacesService` RPC（List/Create/Rename）与 `CreateThread` 的 `workspace_id`；recall 的 `thread` 查询表与 Automation 目标增加 `workspace_id`。

## 4a78ea1 - 2026-11-13

来源分支：main，合并提交 4a78ea1。

### 新增

- `kairos start` 一条命令启动主从架构：拉起 Server 与内嵌 Daemon，自动完成主环境配对，关闭时清理子进程。
- GUI 静态托管在同端口：`/` 提供页面与资产，`/api` 前缀转发 Connect 路由；GUI 端口自动选择空闲端口（`KAIROS_PORT` 可固定），打印带本地会话令牌的访问地址。

### 修复

- 主环境 `auto_detect` 由 Daemon 上报识别系统类型，修复 macOS 配对被拒绝的问题。

## d8aa72d - 2026-11-12

来源分支：main，合并提交 d8aa72d。

### 变更

- 单用户本地认证取代邮箱验证码登录：首次启动初始化唯一用户与租户，启动命令打印带本地会话令牌的访问地址；协议移除 `RequestEmailCode` / `VerifyEmailCode` / `CompleteProfile`，新增 `BootstrapSession`。
- 移除 SMTP、邀请名单、测试账号与资料补全流程；认证密钥缺省时自动生成并保存到 `<KAIROS_DATA_DIR>/auth-secret`（0600）。
- GUI 登录页改为令牌引导：URL fragment 自动登录，也可手动输入令牌。
- Origin 校验默认接受回环地址，`KAIROS_PUBLIC_ORIGIN` 可显式覆盖。

## f6085f6 - 2026-11-12

来源分支：main，合并提交 f6085f6。

### 移除

- 平台 sandbox 全部逻辑：平台生命周期、OpenSandbox 后端、共享控制库、容量名额、三期部署物（`deploy/`）、`sandbox` 模型别名与 server release 构建脚本。

### 新增

- 主环境（`main`）：内置注册、不可撤销，工作目录默认为启动目录（`KAIROS_MAIN_WORKSPACE` 可覆盖），是全局 main 与所有 Agent 的默认执行环境；`AGENTS.md` 与 skills 资源快照固定从主环境读取，模型侧别名为 `main`。
- 执行规格、附件写入路径（`<主环境工作目录>/.kairos/attachments/`）、系统指令与工具描述统一指向主环境。
