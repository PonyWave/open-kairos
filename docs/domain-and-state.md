# 数据定义与运行状态

本文定义 open-kairos 的存储结构与状态规则。Context、Recap、当前视图、委派三元组、结果交付、取消与恢复等行为规则沿用 Kairos 现行设计。术语定义见[目标与范围](goals-and-scope.md)。

## 1. 命名空间与版本基线

各命名空间以版本 1 安装最终结构，新库安装即最终结构：

| 命名空间                 | 说明                                   |
| ------------------------ | -------------------------------------- |
| `context_recap`          | Context、Recap、附件、环境、身份与设置记录。 |
| `server_runtime`         | Thread、输入队列、Run、Automation、通知交付与工作空间。 |
| `devices`                | 设备身份与绑定。                       |
| `environment_operations` | 远程 Operation 意图、状态与输出，以及环境间文件同步记录。 |

正常启动先预检全部命名空间，存在未迁移旧版本时在任何 DDL 或 DML 前拒绝启动；`migrate.js` 只识别 v1 数据库，带旧版本或未版本化应用表的数据库明确拒绝。

## 2. 单用户身份

首次启动初始化唯一用户与租户。会话使用本地令牌。身份数据保存在 `users`、`tenants` 表中，租户字段作为数据归属范围。

## 3. 工作空间与 Thread

### 3.1 workspaces

| 字段           | 类型   | 说明                            |
| -------------- | ------ | ------------------------------- |
| `workspace_id` | `TEXT` | 稳定工作空间 ID，主键。         |
| `tenant_id`    | `TEXT` | 归属租户。                      |
| `name`         | `TEXT` | 显示名称。                      |
| `env_id`       | `TEXT` | 默认设备，主环境或已配对设备。  |
| `path`         | `TEXT` | 规范化工作目录。                |
| `created_at`   | `TEXT` | 创建时间，UTC ISO 8601。        |

约束：`(tenant_id, env_id, path)` 唯一。创建工作空间时在同一事务创建其工作空间 main。

### 3.2 threads

`threads` 表包含 `workspace_id TEXT NULL` 列，`thread_type` 取值 `main` / `workspace_main` / `task`。

| 约束                               | 实现         |
| ---------------------------------- | ------------ |
| 全局 main 每租户一个               | 唯一索引     |
| 工作空间 main 每工作空间一个       | 部分唯一索引 |
| 工作空间 main 必须归属工作空间     | 字段校验     |
| 任务 Thread 的 `workspace_id` 可空 | 空值即临时对话 |

执行默认值：全局 main 与临时对话使用主环境及其根目录；工作空间 Thread 使用工作空间的 `env_id` 与路径。执行规格按 `(run_id, generation)` 保存固定环境、目录与资源快照，规则见 `agent_execution_environments` 表。

## 4. 通知与交付

`thread_notifications` 保存 Thread 间通知，目标字段支持全局 main 与工作空间 main 两类。发送方限定为任务 Thread、临时对话或工作空间 main：任务 Thread 只能通知本工作空间的 main 或全局 main，临时对话只能通知全局 main，工作空间 main 只能通知全局 main。接受、注入、失效与审计规则沿用现有设计。

## 5. Automation

`automations` 表包含 `workspace_id TEXT NULL` 列。fire 创建新 Thread 时写入对应工作空间，为空时落入临时对话列表。cron 计算、游标、fire 去重与恢复规则沿用现有设计。

内置 `记忆整理 (dream)` Automation 在启动时按固定 client action 幂等播种，目标为 `new_automation_only`，每日 cron 触发；用户禁用或删除后不重建，重新启用走 GUI 的 Automation 开关。`KAIROS_MEMORY_DREAM_ENABLED=false` 时不播种。

## 6. recall 查询表

只开放 `thread`、`context`、`recap` 三张查询表。`thread` 表包含 `workspace_id` 列，临时对话该列为 `NULL`。

可见范围按调用方 Run 分级，SQL 不改变授权边界：

| 调用方 Run                        | 可见范围                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| 全局 main 根 Run                  | 本用户全部 Thread（含 automation_only）及其全部 Agent 作用域          |
| automation_only Thread 根 Run     | 本用户全部 Thread（含 automation_only）及其全部 Agent 作用域          |
| 工作空间 main 根 Run              | 本工作空间全部 Thread 与当前 Thread，及其全部 Agent 作用域            |
| 任务 Thread、临时对话与子 Agent   | 当前 Thread 内的当前 Agent 作用域；根 Run 扩展为同 Thread 后代 Agent  |

## 7. 设备与 Operation

主环境在首次启动写入环境记录并完成设备绑定，不可删除、不可撤销。远程设备配对、`environment_operations` 意图与恢复、输出与日志规则沿用现有设计。

## 8. Memory Wiki 与 dream

Memory Wiki 是主环境上的用户级长期记忆目录（默认 `<KAIROS_DATA_DIR>/memory`，`KAIROS_MEMORY_DIR` 覆盖）。`MEMORY.md` 为索引页（上限 `KAIROS_MEMORY_INDEX_MAX_BYTES`，默认 10 KiB，超限截断降级），主题页 `<slug>.md` 按需读取，`STATE.json` 为 dream 水位文件，目录可建 git 基线。

- 读路径：记忆目录存在时，根 Agent（`agent_id = 'thread'`）的系统指令注入 memory 使用说明与索引块；目录不存在时不注入任何 memory 指令（首次 dream 运行创建目录或用户手工创建后生效）。索引缺失、空白或非法 UTF-8 时不注入索引块，不阻断对话。
- 写路径一：全局 main 的根 Agent 额外获得写策略指令，用文件工具主动更新主题页与索引页；工作空间 Thread 经 `thread_notify` 向全局 main 提议。
- 写路径二：dream Automation 的每次 fire 新建 automation_only Thread，按 `STATE.json` 水位增量整理 Wiki，其根 Run 的 recall 可见范围为本用户全部 Thread。
