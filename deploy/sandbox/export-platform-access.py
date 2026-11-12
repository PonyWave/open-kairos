#!/usr/bin/python3 -I
"""Export credentials for this new cluster only, to a dedicated Server-private directory."""
import base64
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import time

if os.geteuid()!=0 or len(sys.argv)!=3:
    raise SystemExit('Usage: sudo export-platform-access.py <server-user> <private-output-directory>')
user=pwd.getpwnam(sys.argv[1]);target=Path(sys.argv[2])
expected=Path(user.pw_dir)/'kairos/runtime/sandbox/access'
if target!=expected or target.is_symlink():raise SystemExit('Expected the dedicated Server access directory')
guard='/opt/kairos-sandbox/bin/cluster-command.py'
identity=json.loads(subprocess.check_output([guard,'identity']))
name='kairos-platform-manager-token'
get=[guard,'kubectl','get','secret',name,'-n','opensandbox','-o','json']
result=subprocess.run(get,capture_output=True,text=True)
if result.returncode:
    manifest={'apiVersion':'v1','kind':'Secret','metadata':{'name':name,'namespace':'opensandbox','labels':{'kairos.io/purpose':'platform-access'},'annotations':{'kubernetes.io/service-account.name':'kairos-platform-manager'}},'type':'kubernetes.io/service-account-token'}
    subprocess.run([guard,'kubectl','create','-f','-'],input=json.dumps(manifest),text=True,check=True)
secret=None
for _ in range(40):
    secret=json.loads(subprocess.check_output(get))
    if secret.get('data',{}).get('token'):break
    time.sleep(0.25)
if not secret or secret['metadata'].get('labels',{}).get('kairos.io/purpose')!='platform-access' or secret['metadata'].get('annotations',{}).get('kubernetes.io/service-account.name')!='kairos-platform-manager':raise SystemExit('Dedicated ServiceAccount token identity mismatch')
token=base64.b64decode(secret.get('data',{}).get('token',''),validate=True)
if not token:raise SystemExit('Dedicated ServiceAccount token is not ready')
target.mkdir(mode=0o700,parents=True,exist_ok=True)
if target.resolve()!=target:raise SystemExit('Server credential directory contains a symlink')
os.chown(target,user.pw_uid,user.pw_gid);target.chmod(0o700)
files={
    'kubernetes-token':token,
    'kubernetes-ca.crt':Path('/var/lib/kairos-sandbox/k3s/server/tls/server-ca.crt').read_bytes(),
    'api-key':Path('/var/lib/kairos-sandbox/secrets/api-key').read_bytes(),
    'registry-ca.crt':Path('/var/lib/kairos-sandbox/secrets/registry-ca.crt').read_bytes(),
    'registry-credentials.json':Path('/var/lib/kairos-sandbox/secrets/registry-credentials.json').read_bytes(),
}
for name,data in files.items():
    pending=target/(name+'.new')
    descriptor=os.open(pending,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(descriptor,'wb') as output:
        output.write(data);output.flush();os.fsync(output.fileno());os.fchown(output.fileno(),user.pw_uid,user.pw_gid)
    pending.replace(target/name)
print(json.dumps({'clusterNodeUid':identity['nodeUid'],'serviceAccountSecretUid':secret['metadata']['uid'],'directory':str(target),'fileNames':list(files),'ownerUid':user.pw_uid,'fileMode':'0600'}))
