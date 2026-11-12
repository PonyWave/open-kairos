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
| `pnpm dev` | 开发模式：并行运行 Server 与 Vite 开发服务器。 |
| `pnpm check` | 完整门禁：依赖边界、文档、proto、lint、类型、测试、构建。 |
| `pnpm test` | 运行全部测试。 |
| `pnpm typecheck` | 类型检查。 |
| `pnpm proto:generate` | 修改 `.proto` 后重新生成跨端代码。 |

## 启动与配置

`pnpm start` 启动后打印带本地会话令牌的访问地址。配置通过环境变量读取，示例见 `.env.example`：

- `KAIROS_DATA_DIR`：数据目录，默认 `data/server`。
- `KAIROS_MAIN_WORKSPACE`：主环境工作目录，默认为启动命令所在目录。
- `KAIROS_PORT`：固定 GUI 端口；未设置时自动选择空闲端口。
- `KAIROS_AUTH_SECRET`：认证密钥；未设置时自动生成并保存到 `<KAIROS_DATA_DIR>/auth-secret`（0600）。
- 模型配置：`KAIROS_MODEL_BASE_URL`、`KAIROS_MODEL_ID` 等，未配置时不能执行 Agent 任务。

## 数据与迁移

SQLite 数据库为 `<KAIROS_DATA_DIR>/kairos.sqlite`，各命名空间以版本 1 安装最终结构。`node apps/server/dist/migrate.js --data-dir <dir> --backup-dir <dir>` 用于检查与迁移；当前版本只识别 v1 数据库，带旧版本或未版本化应用表的数据库明确拒绝，不为 Kairos 旧数据提供迁移。

## 验证

- 修改代码、依赖或构建配置后执行 `pnpm check`。
- 默认测试使用测试 Provider、临时数据库和可控时间，不依赖真实 API key、个人数据或在线设备。
- 协议变更后执行 `pnpm proto:generate` 并检查 `packages/contracts/protocol-removals.json` 的破坏性变更审批。
