# open-kairos

open-kairos 是 Kairos 的单用户开源版本，本地优先：在主电脑执行 `kairos start` 启动全部服务，通过本地网页使用，可以连接其他设备执行文件与命令操作。

当前状态：主从架构、单用户认证、工作空间模型与 GUI 聚类已可用。docs 中标注为待实现的内容不能作为已实现功能的证据。

## 启动

```bash
pnpm install
pnpm build
pnpm start
```

启动命令拉起 Server 与内嵌 Daemon，自动完成主环境配对，打印带本地会话令牌的访问地址（GUI 端口自动选择空闲端口，`KAIROS_PORT` 可固定）。主环境是运行命令的本机，默认出现在设备列表，工作目录默认为启动目录（`KAIROS_MAIN_WORKSPACE` 可覆盖）。

## 设计目标

- 一条命令启动 Server、内嵌 Daemon 与本地网页，GUI 自动占用空闲端口。
- 主环境内置注册：运行命令的本机默认出现在设备列表，作为全局 main 的工作环境。
- 工作空间：指定一台设备中的一个工作目录，作为话题内工具的默认执行设备与路径；话题按工作空间聚类，每个工作空间有自己的 main 对话。
- 连接其他 Linux/macOS 设备执行操作。
- 单用户，首次启动自动初始化，无需邮箱验证。

## 文档

- [文档索引](docs/README.md)

## 许可证

[MIT](LICENSE)
