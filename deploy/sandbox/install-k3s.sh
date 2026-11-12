#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $EUID = 0 && $# = 1 ]] || { printf 'Usage: sudo install-k3s.sh <verified-staging-directory>\n' >&2; exit 64; }
artifact_directory=$(realpath "$1")
source_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ "$artifact_directory" = /home/wanghailong/kairos/runtime/sandbox/staging/* ]] || exit 78
for target in /opt/kairos-sandbox /etc/kairos-sandbox /etc/rancher/k3s /var/lib/kairos-sandbox /run/k3s /etc/systemd/system/kairos-k3s.service; do
  [[ ! -e "$target" && ! -L "$target" ]] || { printf 'Installation target is occupied: %s\n' "$target" >&2; exit 78; }
done

python3 -I -Wignore::DeprecationWarning - "$artifact_directory" "$source_directory" <<'PY'
import crypt,hashlib,json,os
from pathlib import Path
import sys
artifacts=Path(sys.argv[1]);source=Path(sys.argv[2])
lock=json.loads((source/'versions.json').read_text())
def require(condition,message):
    if not condition:raise SystemExit(message)
def sha(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            block=stream.read(1024*1024)
            if not block:break
            value.update(block)
    return value.hexdigest()
require(sha(artifacts/'k3s-v1.34.13+k3s1-linux-amd64')==lock['k3s']['linuxAmd64Sha256'],'K3s artifact digest mismatch')
require(sha(artifacts/'helm-v3.19.2-linux-amd64.tar.gz')==lock['helm']['linuxAmd64Sha256'],'Helm artifact digest mismatch')
require(sha(artifacts/lock['k3s']['airgapImagesName'])==lock['k3s']['airgapImagesSha256'],'K3s airgap artifact digest mismatch')
baseline=json.loads((artifacts/'k1-preinstall-baseline.json').read_text())
require(os.readlink('/proc/1/ns/net')==baseline['networkNamespace'],'The expected k1 network namespace changed')
init=next(x[3:] for x in Path('/proc/1/cgroup').read_text().splitlines() if x.startswith('0::'))
require(init==baseline['initCgroup'],'The expected k1 cgroup root changed')
require(crypt.METHOD_BLOWFISH in crypt.methods,'Bcrypt password hashing is unavailable')
PY

install -d -m 0755 /opt/kairos-sandbox/bin /etc/kairos-sandbox /etc/rancher/k3s
install -d -m 0700 /var/lib/kairos-sandbox/secrets /var/lib/kairos-sandbox/evidence /var/lib/kairos-sandbox/k3s/agent/images
install -m 0755 "$artifact_directory/k3s-v1.34.13+k3s1-linux-amd64" /opt/kairos-sandbox/bin/k3s
install -m 0755 "$source_directory/isolated-k3s.sh" /opt/kairos-sandbox/bin/isolated-k3s.sh
install -m 0600 "$source_directory/k3s.yaml" /etc/rancher/k3s/config.yaml
install -m 0644 "$source_directory/kairos-k3s.service" /etc/systemd/system/kairos-k3s.service
install -m 0600 "$artifact_directory/k3s-airgap-images-amd64.tar.zst" /var/lib/kairos-sandbox/k3s/agent/images/k3s-airgap-images-amd64.tar.zst

python3 -I - "$artifact_directory" <<'PY'
from pathlib import Path
import json,os,sys,tarfile
artifacts=Path(sys.argv[1])
with tarfile.open(artifacts/'helm-v3.19.2-linux-amd64.tar.gz') as archive:
    binary=archive.extractfile('linux-amd64/helm')
    if binary is None:raise SystemExit('Helm binary is missing from the archive')
    destination=Path('/opt/kairos-sandbox/bin/helm')
    destination.write_bytes(binary.read())
    destination.chmod(0o755)
baseline=json.loads((artifacts/'k1-preinstall-baseline.json').read_text())
root=baseline['initCgroup'].removesuffix('/init.scope')
if root=='/' or not root.startswith('/system.slice/'):raise SystemExit('Unexpected k1 delegation root')
scope=Path('/etc/kairos-sandbox/scope.env')
scope.write_text('KAIROS_K1_CGROUP_ROOT='+root+'\nKAIROS_K1_NET_NAMESPACE='+baseline['networkNamespace']+'\n')
scope.chmod(0o600)
PY

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /var/lib/kairos-sandbox/secrets/registry-ca.key
openssl req -new -x509 -key /var/lib/kairos-sandbox/secrets/registry-ca.key -days 365 \
  -subj /CN=Kairos-M0-Registry-CA -out /var/lib/kairos-sandbox/secrets/registry-ca.crt
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /var/lib/kairos-sandbox/secrets/registry.key
openssl req -new -key /var/lib/kairos-sandbox/secrets/registry.key -subj /CN=10.251.0.50 \
  -out /var/lib/kairos-sandbox/secrets/registry.csr
openssl x509 -req -in /var/lib/kairos-sandbox/secrets/registry.csr \
  -CA /var/lib/kairos-sandbox/secrets/registry-ca.crt -CAkey /var/lib/kairos-sandbox/secrets/registry-ca.key \
  -CAcreateserial -days 365 -out /var/lib/kairos-sandbox/secrets/registry.crt \
  -extfile <(printf 'subjectAltName=IP:10.251.0.50\nextendedKeyUsage=serverAuth\n')
chmod 0600 /var/lib/kairos-sandbox/secrets/*
install -m 0644 /var/lib/kairos-sandbox/secrets/registry-ca.crt /etc/rancher/k3s/registry-ca.crt
install -m 0600 "$source_directory/registries.yaml" /etc/rancher/k3s/registries.yaml
systemctl daemon-reload
printf 'Dedicated K3s files installed; service has not been started or enabled.\n'
