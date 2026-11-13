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

全部 Agent 的 `AGENTS.md` 与 `.agents/skills/<name>/SKILL.md` 资源快照固定从主环境根目录读取，保存在绑定历史快照中，不随工作空间设备变化。Agent 用文件工具读取 skill 内容时显式传 `env_id=main`。

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

## 6. IM 渠道

Server 内置渠道适配层，把微信与飞书接入全局 main。渠道凭证与绑定关系保存在 `channel_states` 表（凭证加密存储），入站去重记录在 `channel_inbound_events`，出站投递记录在 `channel_deliveries`。

### 6.1 入站

- 微信：腾讯微信团队维护的 ClawBot 通道（协议见 `Tencent/openclaw-weixin` 的 protocol 文档）。用户在设置页扫码绑定，Server 保存 `bot_token` 后以长轮询 `getupdates` 收消息；只接受绑定用户的私聊消息。绑定过程触发微信风控要求数字验证码（`need_verifycode`）时，设置页展示输入框，提交的 `verify_code` 随下一次状态轮询上报，验证码错误或锁定（`verify_code_blocked`）按协议重新输入或刷新二维码。入站消息入队后开启「正在输入」状态（`getconfig` 获取 `typing_ticket` 并缓存，每 5 秒刷新），该用户首条投递成功后取消；输入状态为尽力而为，接口失败不影响消息链路。
- 飞书：自建应用机器人，Server 使用官方 SDK 的长连接订阅 `im.message.receive_v1`，不需要公网入口。保存 App ID/Secret 后生成六位配对码，用户在飞书里把配对码发给机器人完成绑定。
- 入站消息追加到全局 main 的输入队列，`source` 为 `channel` 并携带 `channel` 引用（渠道、类型、外部消息 ID）；文本前缀 `[来自微信]` 或 `[来自飞书]`，GUI 气泡按引用显示「来自微信/飞书」。平台消息 ID 用于去重；入站图片、文件等媒体在 v1 降级为占位文本。

### 6.2 出站与投递失败

- `send_to_user` 始终投递 GUI；全局 main 可额外传 `channels`（`wechat`/`feishu`）。工具执行时为每个渠道创建 `channel_deliveries` 记录，投递 worker 在事务外渲染并调用平台接口：微信渲染为纯文本分段（约 1500 字节），飞书渲染为卡片 JSON 2.0（`markdown` 组件，表格转原生 `table` 组件，单卡不超过 5 个表格、约 24 KB，超出拆卡，失败时降级纯文本）。
- 投递失败先按 2s/10s/30s 退避重试（最多 4 次尝试）；可重试错误耗尽或非可重试错误（未登录、登录态失效、权限不足）置为 `failed`，并向全局 main 注入一条 `channel` 来源的投递失败通知，内容包含失败原因、尝试次数、原内容与引导：可重试错误引导模型用 `send_to_user` 的 `redeliver_of` 重投（不产生新气泡），非可重试错误引导模型提示用户在设置页处理。
- 微信发送依赖入站消息携带的 `context_token`，长时间无入站时主动推送可能失败，按投递失败流程处理。

### 6.3 GUI

- 设置页新增「渠道」栏目：微信扫码登录与解绑（含数字验证码输入）、飞书凭证保存、配对码展示与解绑。
- 入站渠道消息渲染为平台配色的用户气泡（微信绿、飞书蓝），气泡左上角展示平台图标角标；投递失败通知渲染为系统通知卡片；`redeliver_of` 重投不产生新气泡。
- 携带 `channels` 的 `send_to_user` 气泡展示投递角标：投递中半透明、成功后实色；失败的渠道在角标旁显示「i」标记，悬停查看失败原因（错误详情不直接展示给用户，Agent 通过投递失败通知感知）。气泡的投递状态经 `ListChannelDeliveries` 批量查询并轮询至终态。

## 7. GUI 结构

- 侧栏按工作空间聚类：全局 main 固定顶部；每个工作空间分组显示名称、设备与路径，组内固定展示其 main 对话（无消息也展示）和任务 Thread；临时对话列表独立展示，不含 main 对话。
- 新建话题入口挂在工作空间分组内。
- 工作空间管理页复用目录浏览 RPC 选择设备与目录。
- 全部对话卡片按工作空间分组。
