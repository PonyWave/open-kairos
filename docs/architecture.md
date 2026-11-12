# 整体架构

本文描述 open-kairos 的当前架构。术语定义见[目标与范围](goals-and-scope.md)。

## 1. 启动与进程结构

`kairos start` 在一个命令中拉起 Server 与内嵌 Daemon。Daemon 通过 loopback WSS 连接本机 Server，配对、Operation 与输出回传和远程设备使用同一套协议。Server 在同一端口托管本地网页（GUI），启动时自动探测空闲端口并打印带本地会话令牌的访问地址；`KAIROS_PORT` 用于固定端口。

```text
kairos start
  ├─ Server（Fastify + SQLite + Agent Loop + Provider + 工具调度，同端口托管 GUI 静态页面）
  └─ 内嵌 Daemon（loopback WSS，执行主环境操作）
```

远程设备通过既有 Daemon 配对流程接入，协议相同。

## 2. 主环境与设备

Server 首次启动时自动注册主环境：写入环境记录、完成设备绑定，根目录默认为启动命令所在目录，可通过配置修改。主环境不可删除、不可撤销，默认出现在设备列表，模型侧别名为 `main`。

其他设备通过 Daemon 主动建立的 WSS 连接配对，设备身份、绑定与撤销机制对各设备一致。

环境之间的文件与目录复制由 `env_sync` 工具执行：在两个已授权环境之间复制普通文件或目录，冲突策略为 `fail`（默认值）、`skip` 或 `overwrite`，内容相同的文件始终跳过。同步意图、进度与结果保存在 `environment_operations` 命名空间。

## 3. 工作空间与执行默认值

工作空间由名称、`env_id` 和规范化工作目录组成，`(env_id, path)` 在租户内唯一。创建工作空间时在同一事务创建其工作空间 main。

- 执行规格按 Thread 所属工作空间记录默认 `env_id` 与路径，bash 等工具的默认执行位置为该目录。
- 工具的可选 `env_id` 参数：省略时使用工作空间默认值，显式传入时作为单次调用目标，可指向任何已授权设备和任意路径。工作空间不构成权限边界。
- 全局 main 与临时对话的默认执行位置为主环境及其根目录。
- 附件写入 `<工作目录>/.kairos/attachments/`。全局 main 与临时对话的附件写入主环境根目录下的 `.kairos/attachments/`。

### 3.1 资源快照

全部 Agent 的 `AGENTS.md` 与 `.agents/skills/<name>/SKILL.md` 资源快照固定从主环境根目录读取，保存在绑定历史快照中，不随工作空间设备变化。

系统提示词按两级注入资源：`AGENTS.md` 注入全文；skills 注入目录（`<workspace-skills>`，每个 skill 一行名称与描述）。`SKILL.md` 支持 YAML frontmatter，`description` 字段作为目录描述；无 frontmatter 时描述回退为正文首个非空行，`name` 字段如存在必须与目录名一致。Agent 用 `skill` 工具按名称加载某个 skill 的完整正文，正文取自该执行固定的绑定快照，不经设备往返；读取 skill 引用的附属文件时用文件工具显式传 `env_id=main`。

`write` 与 `edit` 在目标环境执行成功后，Server 探测目标文件目录链上的 `AGENTS.md`（最多 5 级，主环境工作区根目录除外），发现时在工具结果中附加 `agents_md_hint` 提醒；同一执行内已提醒过的路径不再重复。`<agent-execution-environment>` JSON 记录 `started_at`（对话创建时间）；需要精确当前时间时在 bash 中执行 `date`。

## 4. 对话层级与通知

| Thread 类型   | 数量           | 创建方式                                            |
| ------------- | -------------- | --------------------------------------------------- |
| 全局 main     | 每用户一个     | 系统初始化                                          |
| 工作空间 main | 每工作空间一个 | 创建工作空间时在同一事务创建                        |
| 任务 Thread   | 任意           | 全局 main 或本工作空间 main 通过 `thread_call` 创建 |
| 临时对话      | 任意           | 全局 main 通过 `thread_call` 创建                   |

- 全局 main 可调用任何 Thread，包括各工作空间 main。
- 工作空间 main 注册 `thread_call`、`thread_list`、`thread_read`、`thread_cancel`，范围限定本工作空间内的 Thread。
- 任务 Thread 与临时对话不注册 Thread 工具。

### 4.1 通知

- `thread_notify` 的目标参数：`workspace`（默认值，发送方所在工作空间的 main）或 `global`（全局 main）。
- 任务 Thread 只能通知本工作空间的 main 或全局 main，不能跨工作空间通知其他工作空间的 main。临时对话只能使用 `global`。
- 工作空间 main 注册 `thread_notify`，目标固定 `global`。
- 全局 main 向工作空间 main 发消息复用 `thread_call`，response 按委派三元组交付。

## 5. 召回与 Automation

- recall 只开放 `thread`、`context`、`recap` 三张查询表。`thread` 表包含 `workspace_id` 列，临时对话该列为 `NULL`。可见范围按调用方 Run 分级：全局 main 根 Run 覆盖本用户全部 Thread，工作空间 main 根 Run 覆盖本工作空间，其余限当前 Thread，矩阵见[数据定义与运行状态](domain-and-state.md#6-recall-查询表)。
- `workspace_list` 工具供 Agent 查询合法工作空间。
- Automation 定义包含可选 `workspace_id`。fire 创建新 Thread 时写入对应工作空间，为空时落入临时对话列表。
- automation_only Thread 根 Run 的 recall 可见范围为本用户全部 Thread，dream 依赖该能力读取历史。
- 记忆目录存在时，根 Agent 的系统指令注入 Memory Wiki 索引（`MEMORY.md`，缺失或超限降级处理），全局 main 额外获得写策略；内置 `记忆整理 (dream)` Automation 按固定 client action 幂等播种，`new_automation_only` 目标每日触发，约定见[数据定义与运行状态](domain-and-state.md#8-memory-wiki-与-dream)。

## 6. GUI 结构

- 侧栏按工作空间聚类：全局 main 固定顶部；每个工作空间分组显示名称、设备与路径，组内固定展示其 main 对话（无消息也展示）和任务 Thread；临时对话列表独立展示，不含 main 对话。
- 新建话题入口挂在工作空间分组内。
- 工作空间管理页复用目录浏览 RPC 选择设备与目录。
- 全部对话卡片按工作空间分组。
