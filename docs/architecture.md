# 整体架构

本文描述 open-kairos 的当前架构。术语定义见[目标与范围](goals-and-scope.md)。

## 1. 启动与进程结构

`kairos start` 在一个命令中拉起 Server 与内嵌 Daemon。Daemon 通过 loopback WSS 连接本机 Server，配对、Operation 与输出回传和远程设备使用同一套协议。主从结构只体现在部署形态上，不引入第二套执行通道。Server 托管本地网页（GUI）。GUI 端口启动时自动探测空闲端口并打印访问地址；`--port` 用于固定端口。

```text
kairos start
  ├─ Server（Fastify + SQLite + Agent Loop + Provider + 工具调度）
  ├─ 内嵌 Daemon（loopback WSS，执行主环境操作）
  └─ GUI（本地网页，自动空闲端口）
```

远程设备通过既有 Daemon 配对流程接入，协议不变。

## 2. 主环境与设备

Server 首次启动时自动注册主环境：写入环境记录、完成设备绑定，根目录默认为启动命令所在目录，可通过配置修改。主环境不可删除、不可撤销，默认出现在设备列表，模型侧别名为 `main`。

其他设备通过 Daemon 主动建立的 WSS 连接配对，沿用现有设备身份、绑定与撤销机制。

## 3. 工作空间与执行默认值

工作空间由名称、`env_id` 和规范化工作目录组成，`(env_id, path)` 在租户内唯一。创建工作空间时在同一事务创建其工作空间 main。

- 执行规格按 Thread 所属工作空间记录默认 `env_id` 与路径，bash 等工具的默认执行位置为该目录。
- 工具的可选 `env_id` 语义不变：省略时使用工作空间默认值，显式传入时作为单次调用目标，可指向任何已授权设备和任意路径。工作空间不构成权限边界。
- 全局 main 与临时对话的默认执行位置为主环境及其根目录。
- 附件写入 `<工作目录>/.kairos/attachments/`。全局 main 与临时对话的附件写入主环境根目录下的 `.kairos/attachments/`。

### 3.1 资源快照

全部 Agent 的 `AGENTS.md` 与 `.agents/skills/<name>/SKILL.md` 资源快照固定从主环境根目录读取，保存在绑定历史快照中，不随工作空间设备变化。Agent 用文件工具读取 skill 内容时显式传 `env_id=main`。

## 4. 对话层级与通知

| Thread 类型        | 数量           | 创建方式                                   |
| ------------------ | -------------- | ------------------------------------------ |
| 全局 main          | 每用户一个     | 系统初始化                                 |
| 工作空间 main      | 每工作空间一个 | 创建工作空间时在同一事务创建               |
| 任务 Thread        | 任意           | 全局 main 或本工作空间 main 通过 `thread_call` 创建 |
| 临时对话           | 任意           | 全局 main 通过 `thread_call` 创建          |

- 全局 main 可调用任何 Thread，包括各工作空间 main。
- 工作空间 main 注册 `thread_call`、`thread_list`、`thread_read`、`thread_cancel`，范围限定本工作空间内的 Thread。
- 任务 Thread 与临时对话不注册 Thread 工具。

### 4.1 通知

- `thread_notify` 增加目标参数：`workspace`（默认值，发送方所在工作空间的 main）或 `global`（全局 main）。
- 任务 Thread 只能通知本工作空间的 main 或全局 main，不能跨工作空间通知其他工作空间的 main。临时对话只能使用 `global`。
- 工作空间 main 注册 `thread_notify`，目标固定 `global`。
- 全局 main 向工作空间 main 发消息复用 `thread_call`，response 按委派三元组交付。

## 5. 召回与 Automation

- recall 仍只开放 `thread`、`context`、`recap` 三张查询表。`thread` 表增加 `workspace_id` 列，临时对话该列为 `NULL`。
- 新增 `workspace_list` 工具，供 Agent 查询合法工作空间。
- Automation 定义增加可选 `workspace_id`。fire 创建新 Thread 时写入对应工作空间，为空时落入临时对话列表。

## 6. GUI 结构

- 侧栏按工作空间聚类：全局 main 固定顶部；每个工作空间分组显示名称、设备与路径，组内固定展示其 main 对话（无消息也展示）和任务 Thread；临时对话列表独立展示，不含 main 对话。
- 新建话题入口挂在工作空间分组内。
- 工作空间管理页复用目录浏览 RPC 选择设备与目录。
- 全部对话卡片按工作空间分组。

## 7. 移除内容

- 平台 sandbox 全部逻辑与 `sandbox` 别名。
- 三期部署物：K3s、网关、镜像仓库。
- 显式单机模式环境变量分支。
- 多用户认证：邮箱验证码、SMTP、注册流程。
