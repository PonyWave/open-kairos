#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'kairos-k3s: %s\n' "$*" >&2
  exit 78
}

if [[ ${1:-} != --namespace-child ]]; then
  [[ $EUID = 0 ]] || fail 'A dedicated root service is required.'
  [[ -n ${KAIROS_K1_CGROUP_ROOT:-} && -n ${KAIROS_K1_NET_NAMESPACE:-} ]] || fail 'Expected k1 scope is missing.'
  init_group=$(sed -n 's/^0:://p' /proc/1/cgroup)
  [[ "$init_group" = "$KAIROS_K1_CGROUP_ROOT/init.scope" ]] || fail 'The k1 delegation root changed.'
  [[ "$(readlink /proc/self/ns/net)" = "$KAIROS_K1_NET_NAMESPACE" ]] || fail 'The k1 network namespace changed.'
  own_group=$(sed -n 's/^0:://p' /proc/self/cgroup)
  [[ "$own_group" = "$KAIROS_K1_CGROUP_ROOT/system.slice/kairos-k3s.service" ]] || fail 'Unexpected service cgroup.'
  [[ "$own_group" != / ]] || fail 'Global cgroup root is forbidden.'
  group_inode=$(stat -c %i "/sys/fs/cgroup$own_group")
  old_cgroup_namespace=$(readlink /proc/self/ns/cgroup)
  old_mount_namespace=$(readlink /proc/self/ns/mnt)
  exec unshare --mount --cgroup "$0" --namespace-child "$group_inode" "$old_cgroup_namespace" "$old_mount_namespace"
fi

[[ $# = 4 ]] || fail 'Invalid namespace arguments.'
expected_inode=$2
old_cgroup_namespace=$3
old_mount_namespace=$4
[[ "$(readlink /proc/self/ns/cgroup)" != "$old_cgroup_namespace" ]] || fail 'Cgroup namespace was not isolated.'
[[ "$(readlink /proc/self/ns/mnt)" != "$old_mount_namespace" ]] || fail 'Mount namespace was not isolated.'
[[ "$(sed -n 's/^0:://p' /proc/self/cgroup)" = / ]] || fail 'Unexpected namespace root.'
mount --make-rprivate /
[[ "$(findmnt -n -o PROPAGATION /)" = private ]] || fail 'Mount propagation is shared.'
[[ "$(findmnt -n -o PROPAGATION /sys/fs/cgroup)" = private ]] || fail 'Cgroup propagation is shared.'
umount /sys/fs/cgroup
mount -t cgroup2 -o nosuid,nodev,noexec none /sys/fs/cgroup
[[ "$(stat -c %i /sys/fs/cgroup)" = "$expected_inode" ]] || fail 'Cgroup root inode does not match the service.'
[[ "$(findmnt -n -o PROPAGATION /sys/fs/cgroup)" = private ]] || fail 'New cgroup mount propagation is shared.'

# The upstream rootfs commit Job always mounts /run/containerd/fifo.
# Keep that path private without exposing or writing the existing runtime directory.
[[ -d /run/containerd ]] || fail 'Expected legacy runtime mount target is missing.'
legacy_runtime_inode=$(stat -c %d:%i /run/containerd)
mount -t tmpfs -o mode=0755,size=1048576,nosuid,nodev,noexec kairos-snapshot-fifo /run/containerd
[[ "$(findmnt -n -o FSTYPE /run/containerd)" = tmpfs ]] || fail 'Snapshot FIFO mount is not private tmpfs.'
[[ "$(findmnt -n -o PROPAGATION /run/containerd)" = private ]] || fail 'Snapshot FIFO propagation is shared.'
[[ "$(stat -c %d:%i /run/containerd)" != "$legacy_runtime_inode" ]] || fail 'Legacy runtime directory was not hidden.'
[[ ! -e /run/containerd/containerd.sock ]] || fail 'Legacy runtime socket remains visible.'

for socket_path in /run/systemd/private /run/dbus/system_bus_socket; do
  [[ -S "$socket_path" ]] || fail 'Expected management socket is missing.'
  mount --bind /dev/null "$socket_path"
  [[ ! -S "$socket_path" ]] || fail 'Management socket was not masked.'
done

mapfile -t root_pids < /sys/fs/cgroup/cgroup.procs
[[ ${#root_pids[@]} = 1 && "${root_pids[0]}" = "$$" ]] || fail 'Another process entered this service before isolation.'
for controller in cpuset cpu io memory pids; do
  grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers || fail "Controller $controller is unavailable."
done
mkdir /sys/fs/cgroup/manager
printf '%s\n' "$$" > /sys/fs/cgroup/manager/cgroup.procs
mapfile -t remaining_root_pids < /sys/fs/cgroup/cgroup.procs
[[ ${#remaining_root_pids[@]} = 0 ]] || fail 'Service root still contains a process.'
printf '+cpuset +cpu +io +memory +pids\n' > /sys/fs/cgroup/cgroup.subtree_control
mkdir /sys/fs/cgroup/pods
printf '+cpuset +cpu +io +memory +pids\n' > /sys/fs/cgroup/pods/cgroup.subtree_control

# These parameters affect the shared kernel. Require the observed values and never rewrite them.
python3 -I - <<'PY'
from pathlib import Path
expected={
    'vm/overcommit_memory':'1','vm/panic_on_oom':'0','kernel/panic':'10',
    'kernel/panic_on_oops':'1','kernel/keys/root_maxkeys':'1000000',
    'kernel/keys/root_maxbytes':'25000000',
}
for name,value in expected.items():
    actual=(Path('/proc/sys')/name).read_text().strip()
    if actual!=value:
        raise SystemExit('Shared kernel defaults changed: '+name)
PY

binary=/opt/kairos-sandbox/bin/k3s
expected_sha256=b9a7c47aab81db66d0253378ddea0d06f8a6dca4dace7a26db3f00fa2f0e3717
[[ "$(sha256sum "$binary" | cut -d ' ' -f 1)" = "$expected_sha256" ]] || fail 'K3s binary does not match the approved version.'
printf 'kairos-k3s: isolated cgroup root inode %s; manager=/manager; pods=/pods\n' "$expected_inode"

# The pinned K3s release uses INVOCATION_ID to select systemd cgroups for both runtime and kubelet.
# Masked sockets make an unintended DBus fallback fail in this private mount namespace.
exec env -u INVOCATION_ID -u NOTIFY_SOCKET \
  K3S_DATA_DIR=/var/lib/kairos-sandbox/k3s \
  DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/kairos-k3s-no-dbus \
  "$binary" server --config /etc/rancher/k3s/config.yaml \
  --protect-kernel-defaults=true --flannel-backend=host-gw \
  --kubelet-arg=cgroup-driver=cgroupfs --kubelet-arg=cgroup-root=/pods \
  --kubelet-arg=kubelet-cgroups=/manager --kubelet-arg=runtime-cgroups=/manager
