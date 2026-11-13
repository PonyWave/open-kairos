# 开发说明

本文说明 open-kairos 的开发环境、常用命令和验证方式。术语定义见[目标与范围](goals-and-scope.md)。

## 环境要求

- Node.js 版本以 `.node-version` 为准，pnpm 版本以 `package.json` 的 `packageManager` 为准。
- 依赖安装：`pnpm install`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 构建全部包与应用（含 GUI 静态产物）。 |
| `pnpm start` | 启动 open-kairos：Server + 内嵌 Daemon + 本地网页。 |
| `pnpm dev` | 开发模式：并行运行包构建监听、Server 与 Vite 开发服务器。 |
| `pnpm check` | 完整门禁：依赖边界、文档、proto、lint、类型、测试、构建。 |
| `pnpm test` | 运行全部测试。 |
| `pnpm typecheck` | 类型检查。 |
| `pnpm proto:generate` | 修改 `.proto` 后重新生成跨端代码。 |

## 启动与配置

`pnpm start` 启动后打印带本地会话令牌的访问地址。配置通过环境变量读取，示例见 `.env.example`：

- `KAIROS_DATA_DIR`：数据目录，默认 `~/.kairos/.data`。
- `KAIROS_MAIN_WORKSPACE`：主环境工作目录，默认为启动命令所在目录。
- `KAIROS_PORT`：固定服务端口（GUI 与 RPC 同端口）；未设置时自动选择空闲端口。
- `KAIROS_LOG_DIR`：Server 日志目录，默认 `~/.kairos/log`（`server.log`，同时输出到 stdout）。
- `KAIROS_AUTH_SECRET`：认证密钥；未设置时自动生成并保存到 `<KAIROS_DATA_DIR>/auth-secret`（0600）。
- `KAIROS_AUTH_ENABLED`：本地会话令牌认证开关，`true`（默认）或 `false`；`false` 时启动不打印令牌，网页直接进入。
- `KAIROS_MEMORY_DIR`：Memory Wiki 目录，默认 `~/.kairos/memory`。
- `KAIROS_MEMORY_INDEX_MAX_BYTES`：`MEMORY.md` 注入字节上限，默认 10240。
- `KAIROS_MEMORY_DREAM_ENABLED`：是否播种每日 dream Automation，`true`（默认）或 `false`。
- 模型配置：`KAIROS_MODEL_BASE_URL`、`KAIROS_MODEL_ID` 等，未配置时不能执行 Agent 任务。

GUI 浏览器检查脚本（`check-automation-browser.mjs`、`check-settings-browser.mjs`）使用 Playwright 驱动的 Chromium，首次使用前安装浏览器二进制：

```bash
pnpm exec playwright install chromium
```

`PLAYWRIGHT_BROWSERS_PATH` 可覆盖浏览器二进制的解析位置，见 `.env.example`。

`KAIROS_MCP_CONFIG` 指定 MCP server 配置 JSON 路径（`servers` 数组，字段见 `.env.example` 注释与[整体架构](architecture.md#21-mcp-工具桥接)）；未设置时不注册 MCP 工具。

## 数据与迁移

SQLite 数据库为 `<KAIROS_DATA_DIR>/kairos.sqlite`，新库安装即最终结构（`context_recap` 为 v2，`server_runtime` 为 v3，其余命名空间为 v1）。`node apps/server/dist/migrate.js --data-dir <dir> --backup-dir <dir>` 用于检查与迁移：旧数据库带备份升级到当前版本，未版本化应用表的数据库明确拒绝。

## 验证

- 修改代码、依赖或构建配置后执行 `pnpm check`。
- 默认测试使用测试 Provider、临时数据库和可控时间，不依赖真实 API key、个人数据或在线设备。
- 协议变更后执行 `pnpm proto:generate` 并检查 `packages/contracts/protocol-removals.json` 的破坏性变更审批。
