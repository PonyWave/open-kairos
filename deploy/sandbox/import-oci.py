#!/usr/bin/python3 -I
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

if os.geteuid()!=0 or len(sys.argv) not in [2,3]:
    raise SystemExit('Usage: sudo import-oci.py <verified-staging-directory> [node|tools]')
staging=Path(sys.argv[1]).resolve()
if not str(staging).startswith('/home/wanghailong/kairos/runtime/sandbox/staging/'):
    raise SystemExit('Unexpected staging directory')
lock=json.loads((Path(__file__).parent/'versions.json').read_text())
subprocess.run(['/opt/kairos-sandbox/bin/cluster-command.py','identity'],check=True)
environment={**os.environ,'K3S_DATA_DIR':'/var/lib/kairos-sandbox/k3s'}
ctr=['/opt/kairos-sandbox/bin/k3s','ctr','--address','/run/k3s/containerd/containerd.sock','--namespace','k8s.io']
version=subprocess.check_output(ctr+['version'],env=environment,text=True)
if version.count('v2.2.10-k3s1')!=2:
    raise SystemExit('Unexpected dedicated containerd version')
results=[]
selected=['registry','ubuntu'] if len(sys.argv)==2 else [sys.argv[2]]
if any(name not in ['registry','ubuntu','node','tools'] for name in selected):raise SystemExit('Unreviewed image selection')
for name in selected:
    expected=lock['offlineImages'][name]
    archive=staging/expected['archiveName']
    digest=hashlib.sha256()
    with archive.open('rb') as stream:
        while True:
            chunk=stream.read(1024*1024)
            if not chunk:break
            digest.update(chunk)
    if digest.hexdigest()!=expected['archiveSha256']:
        raise SystemExit('OCI archive digest mismatch: '+name)
    subprocess.run(ctr+['images','import','--platform','linux/amd64','--digests',str(archive)],env=environment,check=True)
    normalized='docker.io/'+expected['repository']+'@'+expected['platformManifestDigest']
    subprocess.run(ctr+['images','tag','--force',expected['archiveImageReference'],normalized],env=environment,check=True)
    crictl=['/opt/kairos-sandbox/bin/k3s','crictl','--runtime-endpoint','unix:///run/k3s/containerd/containerd.sock','--image-endpoint','unix:///run/k3s/containerd/containerd.sock','inspecti',normalized]
    inspected=json.loads(subprocess.check_output(crictl,env=environment,text=True))
    status=inspected['status']
    if normalized not in status.get('repoDigests',[]):
        raise SystemExit('CRI does not report the expected normalized repoDigest')
    results.append({'image':name,'normalizedRepoDigest':normalized,'imageConfigId':status['id'],'repoDigests':status['repoDigests']})
report={'status':'dedicated_cri_images_verified','runtimeSocket':'/run/k3s/containerd/containerd.sock','namespace':'k8s.io','images':results}
output=Path('/var/lib/kairos-sandbox/evidence/oci-import-'+selected[0]+'.json' if selected in [['node'],['tools']] else '/var/lib/kairos-sandbox/evidence/oci-import.json')
output.write_text(json.dumps(report,indent=2)+'\n');output.chmod(0o600)
print(json.dumps(report,sort_keys=True))
