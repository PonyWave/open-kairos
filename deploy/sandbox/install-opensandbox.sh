#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID = 0 && $# = 1 ]] || exit 78
artifact_directory=$(realpath "$1")
source_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
guard=/opt/kairos-sandbox/bin/cluster-command.py
"$guard" identity
python3 -I - "$artifact_directory" "$source_directory" <<'PY'
from pathlib import Path
import hashlib,json,sys,tarfile
artifacts=Path(sys.argv[1]);source=Path(sys.argv[2])
lock=json.loads((source/'versions.json').read_text())
archive=artifacts/'opensandbox-62a64f0b.tar.gz'
digest=hashlib.sha256()
with archive.open('rb') as stream:
    while True:
        block=stream.read(1024*1024)
        if not block:break
        digest.update(block)
if digest.hexdigest()!=lock['opensandbox']['sourceArchiveSha256']:
    raise SystemExit('Fixed upstream chart archive digest mismatch')
commit=lock['opensandbox']['commit']
prefix='OpenSandbox-'+commit+'/manifests/charts/'
target=Path('/opt/kairos-sandbox/upstream')/commit/'manifests/charts'
with tarfile.open(archive) as bundle:
    for entry in bundle:
        if not entry.name.startswith(prefix):continue
        relative=Path(entry.name.removeprefix(prefix))
        if relative.is_absolute() or '..' in relative.parts or entry.issym() or entry.islnk():
            raise SystemExit('Unsafe upstream chart archive entry')
        if not entry.isfile():continue
        destination=target/relative
        destination.parent.mkdir(parents=True,exist_ok=True)
        with bundle.extractfile(entry) as contents:
            destination.write_bytes(contents.read())
PY
chart_directory=/opt/kairos-sandbox/upstream/62a64f0b48cdd6b410f36e53c74dc7559c87719a/manifests/charts/opensandbox
"$guard" helm dependency build "$chart_directory"
"$guard" helm template opensandbox "$chart_directory" --namespace opensandbox-system \
  --kube-version 1.34.13 --values "$source_directory/opensandbox-values.yaml" \
  > /var/lib/kairos-sandbox/evidence/opensandbox-rendered.yaml
python3 -I - <<'PY'
from pathlib import Path
rendered=Path('/var/lib/kairos-sandbox/evidence/opensandbox-rendered.yaml').read_text()
count=sum(line.startswith('kind:') for line in rendered.splitlines())
if count!=43:raise SystemExit('Expected exactly 43 fixed upstream chart resources, found '+str(count))
print('Verified 43 rendered upstream chart resources')
PY
"$guard" helm upgrade --install opensandbox "$chart_directory" --namespace opensandbox-system \
  --values "$source_directory/opensandbox-values.yaml" --wait --timeout 180s
