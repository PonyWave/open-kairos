# 单节点 sandbox 后端与应用接入

本目录保存 Kairos 独立实现的部署与验证入口。固定组件、发布物 SHA-256 和镜像摘要集中在 [versions.json](versions.json)；上游 Helm chart 作为外部部署依赖校验和解包，不将其应用代码纳入 Kairos。

当前状态：k1 已完成真实 P3-M0 验证，执行两轮原生暂停恢复后再次暂停。文件系统镜像与工作区、HOME 两个 PVC 的不同标记均已恢复，最终没有业务 Pod、业务进程或业务及快照任务的残留 shim。实际版本、资源编号、耗时、失败修复与未验证项见 [M0 收据](../../work/platform-sandbox-m0-2026-11-08.json)。M1 的容量预留、使用登记、默认环境、`env_id` 工具、Daemon 和 GUI 接入已实现并通过既有整仓工程检查，实际验证范围见下文与 [M1 记录](../../work/platform-sandbox-m1-2026-11-08.json)。

## 边界与前置条件

目标为已核对的 k1 Ubuntu 主机。安装需要 root、systemd、mount/cgroup namespace、已委派的 cgroup v2 控制器、Python 3.10 标准库的 bcrypt crypt 支持和 OpenSSL。K3s 使用普通 runc 容器，无需 KVM。

cgroup 是 Linux 管理进程与资源用量的分组；业务 cgroup 指某个 Pod UID 对应的目录。Job 是 Kubernetes 管理的临时任务，本次用其提交快照镜像。

专用 `Delegate=yes` 服务进入私有 mount/cgroup namespace，重新挂载 cgroup2 后核对根 inode。管理进程使用 `/manager`，Pod 使用 `/pods`；kubelet 与 containerd 统一使用 cgroupfs。DBus socket 被遮蔽，`/run/containerd` 在该服务内由私有 tmpfs 遮蔽，上游 Job 固定 FIFO 路径只写入该 tmpfs。原运行时仍在原 namespace 中工作。

入口核对安装时登记的 k1 cgroup/网络 namespace。上层容器重建后，该身份变化会阻止启动，须重新进行范围核对。服务采用手动启停，没有开机启动设置。共享内核参数通过 `ProtectKernelDefaults` 校验；模块加载受限制；单节点使用 host-gw。

| 位置                                | 用途                                          |
| ----------------------------------- | --------------------------------------------- |
| `/opt/kairos-sandbox/`              | 独立二进制、身份校验入口和固定外部 chart。    |
| `/etc/kairos-sandbox/`              | 安装器生成的 scope.env 与新集群身份记录。     |
| `/etc/rancher/k3s/`                 | 本次新 K3s 的配置、CA 信任和明确 kubeconfig。 |
| `/var/lib/kairos-sandbox/k3s/`      | 新 K3s 与专用 containerd 数据。               |
| `/var/lib/kairos-sandbox/volumes/`  | 本次集群的本地持久卷。                        |
| `/var/lib/kairos-sandbox/secrets/`  | 0600 的私钥、认证与签名材料，目录 0700。      |
| `/var/lib/kairos-sandbox/evidence/` | 运行时验证收据，目录 0700。                   |

服务资源上限在 [unit](kairos-k3s.service)，Pod 与网络配置在 [k3s.yaml](k3s.yaml)，组件预算在 [OpenSandbox values](opensandbox-values.yaml)。unit 的内存计数包含管理进程及文件缓存；已删除业务 cgroup 没有可读取的 `memory.current`，收据分别记录目录删除、进程退出和管理 unit 的 anon/file/slab。

## 首次安装

先按版本锁准备 K3s、Helm、官方 airgap、固定 chart 归档及 Registry/Ubuntu 的 linux-amd64 OCI 归档。暂存目录必须位于 Kairos runtime 的专用 staging 子目录，保留完整 SHA256SUMS、原始多架构 index、单平台 manifest 与 blob 校验记录。安装器要求目标路径未占用。

以下命令由管理员按顺序执行，源码目录为本目录的已审阅副本。`staging_directory` 指向已校验的专用暂存目录。

首次启动须等待新 API 和节点出现，再执行 bootstrap；尚未就绪时可以重试 bootstrap。CA、节点或 scope 身份不符时停止操作并核对当前专用服务。

```sh
sudo bash install-k3s.sh "$staging_directory"
sudo systemctl start kairos-k3s.service
sudo /opt/kairos-sandbox/bin/cluster-command.py bootstrap
sudo /opt/kairos-sandbox/bin/cluster-command.py kubectl wait --for=condition=Ready node/kairos-k1 --timeout=60s
sudo python3 -I import-oci.py "$staging_directory"
sudo python3 -I -Wignore::DeprecationWarning create-private-secrets.py
sudo bash setup-registry.sh
sudo python3 -I push-base-image.py "$staging_directory"
sudo bash install-opensandbox.sh "$staging_directory"
sudo python3 -I verify-api-storage.py
```

`cluster-command.py` 在每次操作前核对专用 kubeconfig 的 CA、API 地址与节点 UID，拒绝其他 context/目标参数并清理 Helm 目标环境变量。所有 Kubernetes 和 Helm 操作都使用该入口；上游 chart NOTES 中的裸 kubectl 命令不作为本项目操作方法。

OCI 导入只连接新 socket 的 `k8s.io` namespace，并创建 CRI 需要的规范化 repoDigest 后实际 `inspecti`。Registry 使用单平台摘要。Ubuntu 推入本机 TLS 私仓后，脚本 GET 原始 manifest 并计算摘要；测试请求引用该本地来源。多架构 index 摘要仅保留来源关联，不替代单平台 manifest。

认证材料由脚本首次生成，不覆盖已有文件，不写入参数值、values 或收据。私仓匿名请求及生命周期缺少/错误 key 均须拒绝。OpenSandbox 的 SQLite 用于公开 snapshot 元数据；脚本核对实际数据库 schema、挂载与 PV backing inode。BatchSandbox 与内部暂停状态保存在 Kubernetes CRD。

## 原生暂停恢复验证

验证器只管理一个持久记录的临时 sandbox。创建返回 202 后核对真实就绪；未知创建通过原 runId 关联已有对象，不再次提交 POST。涉及 CRD 的查询使用完整 API 组，避免同名 CRD 歧义。

```sh
sudo python3 -I verify-lifecycle.py create
# 在首次暂停前完成普通用户对准确业务 cgroup 的只读观察。
sudo python3 -I verify-lifecycle.py pause
sudo python3 -I verify-lifecycle.py resume
sudo python3 -I verify-lifecycle.py cycle
sudo python3 -I verify-lifecycle.py pause
sudo python3 -I verify-final.py
```

每次暂停均核对内部 Snapshot Succeed、仓库实际 manifest、原 Pod 与 cgroup 删除、原进程退出以及快照任务终止。每次恢复保持原 sandbox_id 和 Batch UID，产生新的 Pod UID、container ID，并独立读取卷外、workspace 和 HOME 标记。恢复前保存 Snapshot、Job 与 Pod 关联，避免内部 Snapshot 删除后丢失证据。

最终验证还核对专用 CRI 的任务、PodSandbox 和残留 shim，保留四个 Retain PVC，并复核原 runtime、全局挂载、共享内核参数和 Kairos 本地/公开健康。metadata PVC 以及 Registry、K3s 管理组件继续运行。日常暂停保留逻辑资源与磁盘；本目录没有通用卸载或全局网络清理入口。

## M1 接入配置与发布准备

M1 的共享容量、平台前台进程和观察确认配置已实现，整仓工程检查通过。正式产物 `5ae15ce` 的独立实机验收轮已通过 11 项检查，覆盖六租户容量与显式继续、原生暂停与文件和 Skill 恢复、真实设备目标、取消、异常重启和真实模型 read 与 Bash；最终六个环境均暂停，使用登记与名额归零，并核对物理退出与仓库 manifest。两个受控租户 Pod 的网络隔离与允许流量也已验证。正式 test/prod 已部署同一 `5ae15ce` 产物并通过独立检查，GUI 浏览器、离机备份与更广范围故障场景未验证；具体版本和证据见 [M1 记录](../../work/platform-sandbox-m1-2026-11-08.json)。

正式 M1 发布使用同一个已提交的应用版本构建 Server 和 Linux Daemon。共享程序 PVC 只保存不可变的运行包、校验过的工作区初始说明和 test/prod 各自的 current 链接，不保存租户配置或认证材料。

```sh
sudo /opt/kairos-sandbox/bin/cluster-command.py kubectl apply -f platform-resources.yaml
sudo python3 -I publish-program.py "$daemon_archive" "$daemon_archive_sha256" test kairos-platform-program
sudo python3 -I publish-program.py "$daemon_archive" "$daemon_archive_sha256" prod kairos-platform-program
sudo python3 -I export-platform-access.py wanghailong /home/wanghailong/kairos/runtime/sandbox/access
sudo python3 -I publish-scope.py
sudo python3 -I apply-platform-network.py
sudo /opt/kairos-sandbox/bin/cluster-command.py kubectl create configmap kairos-platform-template \
  -n opensandbox-system --from-file=sandbox-template.yaml=platform-template.yaml
```

首次 apply 的静态程序 PV 路径固定在本次专用 volumes 目录，回收策略为 Retain。`publish-program.py` 核对归档 SHA、真实包布局和不可变版本，将 [通用初始说明](workspace/AGENTS.md) 与其 SHA manifest 加入版本目录；相同版本内容不同会拒绝发布。活动进程已解析其物理版本，之后切换 current 只影响下一次冷启动。

访问导出脚本只读取新集群固定 CA/节点下的专用 ServiceAccount，将 token、API key、私仓认证和 CA 写入 Server UID 所有的 0600 文件。目录为 0700，脚本只输出路径、文件名和资源 UID。该 ServiceAccount 的权限见 platform-resources.yaml，只允许专用业务 namespace 的必要资源，以及按名称读取本节点；不授予 exec、上层集群或任意节点管理权限。公开 scope proof 由 root 写入 `/etc/kairos-sandbox/public-scope.json`，文件 0444；原 scope.env 继续保持 root:0600。专用 K3s 重启后先重新发布 proof，Server 核对记录的 incarnation 变化，不能沿用旧 inode 证明退出。

test/prod 的平台配置分别指定 deploymentId 和 WSS 地址，但必须引用同一个规范化控制库路径、容量和集群身份。管理员以实际 Server UID 运行正式产物中的初始化入口，仅在首次安装时创建容量控制库：

```sh
sudo -u wanghailong "$released_node" "$released_server/platform/initialize.js" "$control_initialization_json"
```

初始化 JSON 使用 `path`、`capacity`、`cluster` 四项集群字段；cluster 包含 `caSha256`、`nodeUid`、`nodeName`、`namespace`。控制文件不存在、被替换、损坏或版本/集群不符时，Server 拒绝新的平台分配，不自动初始化空库；历史与自带设备仍可使用。配置入口及部署步骤由主运维文档维护。

生命周期 HTTP 请求使用 75 秒总期限，环境准备使用 180 秒期限；请求期限覆盖上游最多 60 秒的 Pod 启动等待。首次 Hello 可以早于 create HTTP 回执；Manager 先核对已派发的原 create、唯一 Batch 与真实 Pod owner UID，在控制库比较操作和运行版本后关联 sandbox，再验证挂载、实例和配对。晚到回执不得改写已有的不同 sandbox 关联。平台 Daemon 只向 stderr 输出首次连接错误和终态错误的有限类型、代码与固定阶段，不复制凭据、请求对象或外部错误正文。

平台 Hello 通过凭据只读预验后，进入最多 30 秒的独立授权阶段；同一 Pod 的 Kubernetes 状态仍为 Pending 时，Manager 有界重读 Batch 与 Pod，直到 Running 才继续授权和消费凭据。UID、owner、删除状态或终态变化立即拒绝；超时与连接关闭均取消等待，未授权时不登记能力。自带设备仍使用原认证期限。该顺序已由确定性的真实 HTTP/WSS 回归验证；此前实机日志只确认联合身份校验拒绝，未保存当时的具体 phase。

WSS 已监听但 Manager 尚在启动核对时，平台 Hello 在同一授权期限内等待该次核对结果，不自行重复启动核对。启动失败、超时或连接关闭均拒绝授权，且不消费配对凭据。此期间新的使用预留仍立即返回不可用。

Server 重启后，正在 pausing 的环境仅允许原 Daemon 使用有效已有身份，按记录中的 Batch UID、Pod UID/name、运行版本和 instance_id 原样重连。Manager 仍核对真实 Kubernetes、PVC 和原物理范围；该连接只供现有暂停完成，不新增使用登记、目录操作或唤醒，也不把状态改回 running。初配、新 Pod 和新实例均拒绝。

Server 在初配拒绝前保存有限错误类型、协议代码与最多 500 字符的已验证失败说明，不记录 Hello 消息或凭据。平台前台初始化失败另输出固定阶段和已知错误代码，继续返回原失败。上游会自动清理创建失败的 Pod，不能依赖清理后的 Pod 日志持久存在；故障核对以 Server 有界错误与已保存的生命周期、资源 UID 和物理证据为依据。

Server 的 OpenSandbox 配置应引用 `kairos-platform-template`，并在同一固定 Helm 发布中合并 `platform-controller-values.yaml`。该文件为快照 Job 增加有界的物理观察 initContainer；控制器生成的 Job 总期限为 10 分钟，观察等待最多 480 秒，镜像为本机私仓固定 Ubuntu 单平台摘要。Manager 保存真实 scope/Pod UID/leaf inode 后才 PATCH 该 Job Pod 的单个观察注解。Downward API 刷新可能增加冷停耗时，M1 真实验收须重新测量，不能沿用 M0 的耗时。

Manager 在暂停中离线超过观察等待期限时，观察 Job 失败，暂停不能记为成功，运行名额继续保留，原业务 Pod 可能仍在运行。该限制已实测；管理员须核对原 BatchSandbox、Pod、快照与进程后处置，不得重新提交创建，也不得仅按上游 `Succeed` 或连接断开释放名额。

平台业务和初始化 Job 使用版本锁 `images.platformBase` 指定的工具镜像。该镜像以锁定的 Node Debian slim 单平台镜像为基础，包含 Node 运行需要的 libatomic。M0 的 Ubuntu 镜像继续用于观察闸门，原 Node 基础归档继续保留来源与逐层校验。

### 平台工具镜像

[Dockerfile](image/Dockerfile) 按[系统包清单](image/packages.txt)安装 Python 3、pip、venv、Git、curl、wget、jq、ripgrep、SSH 客户端、DNS、压缩与基础编译工具。镜像保留完整安装包版本于 `/usr/local/share/kairos/packages.tsv`。构建验证使用 UID 1000，检查 Python SSL、SQLite、虚拟环境、pip 和实际 C 编译执行。

构建主机需要 Docker Buildx 和已校验的 Node OCI 归档。先按版本锁核对归档 SHA-256，再加载并以本地标签构建，避免构建器重新请求外部仓库元数据。以下路径由操作者指定，输出目录须独立于现有运行资源：

```sh
docker load -i "$node_staging_directory/node-26.4.0-bookworm-slim-linux-amd64.oci.tar"
docker tag 'node:26.4.0-bookworm-slim@sha256:70a832c538c185e6a1a5387d46fc5b615363c50d49dcf50505879ee3f39c6001' kairos-platform-node-source:26.4.0-bookworm-slim
docker buildx build --platform linux/amd64 --load \
  --build-arg KAIROS_BASE_IMAGE=kairos-platform-node-source:26.4.0-bookworm-slim \
  --build-arg DEBIAN_MIRROR=http://mirrors.aliyun.com \
  -t kairos-sandbox-tools:20261108 image
docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user 1000:1000 \
  --memory 1g --cpus 1 --pids-limit 256 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=128m \
  --entrypoint /usr/local/bin/kairos-verify-tools kairos-sandbox-tools:20261108
docker save --platform linux/amd64 -o "$tools_staging_directory/kairos-tools-linux-amd64.oci.tar" kairos-sandbox-tools:20261108
```

`DEBIAN_MIRROR` 只调整下载位置，APT 的发布和包签名检查保持开启。重新构建后需要核对实际 manifest、每个 blob、归档 SHA-256 和软件清单，并更新版本锁；不得假定重建字节与历史产物相同。已验证归档从独立暂存目录导入并推送私仓：

```sh
sudo python3 -I import-oci.py "$tools_staging_directory" tools
sudo python3 -I push-base-image.py "$tools_staging_directory" tools
```

部署时把 test/prod 平台配置的 `image` 设置为版本锁中的 `images.platformBase` 完整摘要，并在服务全部停止后迁移共享控制库与各业务库，命令见[运维说明](../../docs/operations.md#10-三期平台-sandbox-部署后端已验证)。新镜像只影响首次创建；原暂停快照和 PVC 保持，不自动重建现有 sandbox。已暂停环境的工具升级需独立维护，不能通过删除原环境完成。

Python 项目依赖使用 HOME 持久卷中的虚拟环境：

```sh
python3 -m venv /home/agent/.venv
/home/agent/.venv/bin/python -m pip install <package>
```

系统 Python 与镜像工具由镜像版本管理；项目虚拟环境、文件和 HOME 随正常暂停恢复保留。

首次创建前的受信初始化 Job 使用独立 Secret 和身份 PVC，以 UID 1000 写入 0600 bootstrap 文件；它有 150 秒总期限，观察确认等待最多 120 秒。Manager 先持久保存 helper 物理证据，再允许退出，确认进程结束后按原 UID 删除 Secret/Job，随后才派发业务 create。准备失败保留原名额和 create 操作；用户再次显式请求时，仅在 create 尚未派发、旧 helper 的 UID、终态与进程退出均可核对后，有限重试初始化。新尝试先持久化，再轮换未消费凭据；已有 bootstrap 仅允许同一环境、同一初始化操作及已知内容哈希的原子替换，已有 identity 永不覆盖。已派发 create 的未知结果继续查询原关联，不重新创建。业务 Batch 不保存配对凭据；前台进程读取身份目录的 bootstrap 后配对并持续运行，已有身份直接认证。工作区初始化只补缺少的根 AGENTS.md 和 `.agents/skills` 目录，校验固定版本 seed，保留用户已有说明与 Skill。

### M1 网络隔离与真实验收门槛

[固定网络策略](platform-network-policy.yaml)对整个业务 namespace 默认拒绝入站和出站，无标签 Pod 也受限制。平台模板固定 `kairos.io/network-role=tenant`，Server 在接受 Hello 前核对该标签、完整 Batch/Pod UID 与实际 PVC 挂载。业务例外允许公网 IPv4 开发访问，但排除 RFC1918、loopback、link-local、CGNAT、零地址、组播和保留范围；Pod、Service 与节点管理地址均在排除范围内。另允许集群 DNS 的 TCP/UDP 53，以及管理员核对的 WSS 地址 `172.27.65.55:443`。该 WSS 地址来自本次 k1 对 test/prod 入口的实际 DNS 解析，变化时须重新审阅代码和策略，不接受租户传入白名单。本次 K3s 为 IPv4 单栈，没有开放 IPv6 出口。

初始化与快照 Job 分别使用 `bootstrap`、`snapshot` 标签，独立例外只允许 DNS 和本机 TLS 镜像仓库。Job 不取得普通业务标签，业务 Pod 不能通过省略标签绕过默认拒绝。镜像拉取由节点 runtime 执行，不向业务 Pod 开放仓库管理端口。

安装脚本先确认当前网络 namespace 与 root 保存的 k1 身份一致、WSS 精确 DNS 未变、K3s NetworkPolicy 控制器链已存在，再通过新集群身份 guard 应用策略。该步骤不执行 iptables flush、不接触上层 namespace 或其他项目配置。

两个受控租户 Pod 已通过实际网络探针：双向 TCP 和受测管理端点均不可达，DNS、WSS 443 与公网 HTTPS 正常，执行时未修改网络规则。具体受测地址、结果和未验证项见 [M1 记录](../../work/platform-sandbox-m1-2026-11-08.json)；该结果不表示完整 M1 流程或部署验收完成。

后续复验保持两个不同租户的受控业务 Pod 活跃，运行 `verify-platform-network.py <left-pod> <left-uid> <right-pod> <right-uid>`。探针分别启动有期限的 TCP 测试监听，先确认各自本地监听正常，再验证双向连接失败；随后探测节点 `172.27.134.23:6443`、Kubernetes Service、OpenSandbox API、gateway 和 registry 的实际地址与端口，均须不可达。同时从两个 Pod 验证 DNS、WSS 443 和公网 HTTPS 读取正常，确认真实 Daemon 在线。节点地址和 NodePort 可能受 NetworkPolicy 的实现例外影响，出现可达时记录源 Pod IP、目标与命中规则并停止该验收，不能声称管理接口已隔离。共享内核的容器也不提供虚拟机等级的内核隔离保证。
