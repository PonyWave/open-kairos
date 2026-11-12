# 目标与范围

本文定义 open-kairos 的设计目标、功能范围和与 Kairos 的关系。除特别标注外，所述能力均已实现。

## 术语

| 名称          | 定义                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| 主环境        | 运行 `kairos start` 的本机执行环境，内置注册、不可删除，模型侧别名 `main`。            |
| 工作空间      | 名称、一台设备（`env_id`）和该设备中一个工作目录组成的持久记录，规定所属 Thread 的默认执行设备与路径。 |
| 全局 main     | 每个用户唯一的全局主对话，不归属任何工作空间。                                         |
| 工作空间 main | 每个工作空间唯一的对话，与所属工作空间在同一事务创建。                                 |
| 任务 Thread   | 归属工作空间或作为临时对话存在的持久对话。                                             |
| 临时对话      | `workspace_id` 为空的任务 Thread，列入临时对话列表，该列表没有工作空间 main。          |

## 设计目标

1. 本地优先：在主电脑执行 `kairos start` 一条命令启动 Server、内嵌 Daemon 与本地网页。GUI 端口启动时自动探测空闲端口，`--port` 用于固定端口。
2. 主环境：运行命令的本机自动注册为设备，默认出现在设备列表，是全局 main 的工作环境。`AGENTS.md` 与 skills 资源快照固定从主环境根目录读取。
3. 工作空间：Thread 归属工作空间后，其工具默认在该设备的工作目录执行。工作空间只提供默认值，不限制访问其他已授权设备和任意路径。
4. 对话层级：全局 main、工作空间 main、任务 Thread 三级。话题按工作空间在 GUI 聚类，每个工作空间展示其 main 对话，空工作空间也展示。
5. 多设备：沿用 Daemon 配对协议连接其他 Linux/macOS 设备。
6. 单用户：首次启动初始化唯一用户与租户，本地会话令牌认证，无邮箱验证与 SMTP。

## 保留的能力

从 Kairos 复制并保留：Agent Loop、Provider 适配、Context 与 Recap、当前视图、SQL 召回、委派与结果交付、Subagent、Automation、环境配对与远程 Operation、Bash 输出与 `read_output`、附件。

## 新增与变更

- 新增 `workspaces` 表与工作空间管理界面。
- `thread_type` 扩展为 `main` / `workspace_main` / `task`。
- `thread_notify` 增加目标参数 `workspace`（默认）或 `global`。
- 工作空间 main 注册 `thread_call` 等 Thread 工具，范围限定本工作空间。
- Automation 定义增加可选 `workspace_id`。
- recall 的 `thread` 查询表增加 `workspace_id` 列，新增 `workspace_list` 工具。

## 移除

- 平台 sandbox：平台环境表、共享控制库、容量名额、OpenSandbox/BatchSandbox 生命周期、`sandbox` 别名。
- 三期部署物：K3s、网关、镜像仓库。
- 显式单机模式环境变量分支，其能力由主环境内置注册取代。
- 邮箱验证码、SMTP 与多用户注册流程。
- 旧 Server Bash 与 `device_bash` 审计结构。开源版无历史数据需要保留。

## 与 Kairos 的关系

open-kairos 从 Kairos 复制代码后独立演进，不回流修改，不为 Kairos 数据提供迁移。schema 版本重新计数，各命名空间初始版本为 1。
