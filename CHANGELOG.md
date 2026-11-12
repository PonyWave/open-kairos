# CHANGELOG

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
