# 目标与范围

本文定义 open-kairos 的设计目标、功能范围和与 Kairos 的关系。除特别标注外，所述能力均已实现。

## 术语

| 名称          | 定义                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| 主环境        | 运行 `kairos start` 的本机执行环境，内置注册、不可删除，模型侧别名 `main`。                             |
| 工作空间      | 名称、一台设备（`env_id`）和该设备中一个工作目录组成的持久记录，规定所属 Thread 的默认执行设备与路径。 |
| 全局 main     | 每个用户唯一的全局主对话，不归属任何工作空间。                                                         |
| 工作空间 main | 每个工作空间唯一的对话，与所属工作空间在同一事务创建。                                                 |
| 任务 Thread   | 归属工作空间或作为临时对话存在的持久对话。                                                             |
| 临时对话      | `workspace_id` 为空的任务 Thread，列入临时对话列表，该列表没有工作空间 main。                          |

## 设计目标

1. 本地优先：在主电脑执行 `kairos start` 一条命令启动 Server、内嵌 Daemon 与本地网页。GUI 端口启动时自动探测空闲端口，`KAIROS_PORT` 用于固定端口。
2. 主环境：运行命令的本机自动注册为设备，默认出现在设备列表，是全局 main 的工作环境。`AGENTS.md` 与 skills 资源快照固定从主环境 Daemon 用户主目录读取（`~/.kairos/AGENTS.md` 与 `~/.agents/skills/`），主环境工作目录只提供默认执行位置。
3. 工作空间：Thread 归属工作空间后，其工具默认在该设备的工作目录执行。工作空间只提供默认值，不限制访问其他已授权设备和任意路径。
4. 对话层级：全局 main、工作空间 main、任务 Thread 三级。话题按工作空间在 GUI 聚类，每个工作空间展示其 main 对话，空工作空间也展示。
5. 多设备：通过 Daemon 配对协议连接其他 Linux/macOS 设备。
6. 单用户：首次启动初始化唯一用户与租户，本地会话令牌认证。

## 功能范围

- Agent Loop 与 Provider 适配：模型请求与工具执行组成的迭代过程，适配多种模型接口协议。
- Context 与 Recap：模型实际接收和产生的完整逐条原始消息，以及关联原始消息的逐条区间概述；当前视图与 SQL 召回共用同一套有效性规则。
- SQL 召回：`recall({ sql })` 工具开放 `thread`、`context`、`recap` 三张只读查询表，可见范围按调用方 Thread 类型分级，全局 main 可查全部对话。
- 对话层级与委派：`thread_call` 委派与结果交付、`thread_notify` 通知、Subagent、`workspace_list` 工作空间查询。
- Automation：cron 定时与手动触发，目标可指定工作空间。
- Memory Wiki 与 dream：主环境上的用户级长期记忆（`MEMORY.md` 索引 + 主题页），根 Agent 注入索引，全局 main 主动更新；内置每日 dream Automation 在一次性 automation_only Thread 中增量整理，可禁用、可删除。
- 多设备执行：Daemon 配对、远程 Operation、bash 后台任务与大输出落盘（主机日志文件）、`env_sync` 环境间文件同步。
- 文件工具：`read`、`write`、`edit`、`read_image`、`glob`、`grep`（Daemon 内置 ripgrep）；附件上传与投递。
- 网页访问：`web_fetch` 抓取网页，`web_search` 搜索（需配置外部索引）。
- MCP 工具桥接：配置经设备通道注入指定环境，命名 `mcp__<server>__<tool>`，远程 server 支持 OAuth 授权。
- `send_to_user`：全局 main 向用户投递回复的通道。

## 与 Kairos 的关系

open-kairos 是 Kairos 的单用户开源版本，从 Kairos 复制代码后独立演进。schema 版本独立计数，各命名空间初始版本为 1。
