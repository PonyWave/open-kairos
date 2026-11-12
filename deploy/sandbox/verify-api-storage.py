#!/usr/bin/python3 -I
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

GUARD='/opt/kairos-sandbox/bin/cluster-command.py'


def kctl(*arguments):
    return subprocess.check_output([GUARD,'kubectl',*arguments],text=True)


if os.geteuid()!=0:
    raise SystemExit('Root is required for the M0 control-plane check')
service=json.loads(kctl('get','service','opensandbox-server','-n','opensandbox-system','-o','json'))
base='http://'+service['spec']['clusterIP']+':'+str(service['spec']['ports'][0]['port'])
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
key=Path('/var/lib/kairos-sandbox/secrets/api-key').read_text()


def status(value=None):
    headers={} if value is None else {'OPEN-SANDBOX-API-KEY':value}
    try:
        with opener.open(urllib.request.Request(base+'/v1/sandboxes',headers=headers),timeout=15) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        error.read()
        return error.code


auth={'missingKey':status(),'wrongKey':status('m0-intentionally-invalid'),'correctKey':status(key)}
if auth['missingKey'] not in [401,403] or auth['wrongKey'] not in [401,403] or auth['correctKey']!=200:
    raise SystemExit('Lifecycle API authentication verification failed: '+json.dumps(auth))
selector=','.join(name+'='+value for name,value in sorted(service['spec']['selector'].items()))
pods=json.loads(kctl('get','pods','-n','opensandbox-system','-l',selector,'-o','json'))['items']
running=[pod for pod in pods if pod['status']['phase']=='Running' and not pod['metadata'].get('deletionTimestamp')]
if len(running)!=1:
    raise SystemExit('Expected exactly one running lifecycle Server')
pod=running[0]
mounts=pod['spec']['containers'][0]['volumeMounts']
state=[mount for mount in mounts if mount['mountPath']=='/var/lib/opensandbox']
if len(state)!=1:
    raise SystemExit('Lifecycle metadata mount is missing')
volume=next(volume for volume in pod['spec']['volumes'] if volume['name']==state[0]['name'])
claim=volume.get('persistentVolumeClaim',{}).get('claimName')
if claim!='opensandbox-metadata':
    raise SystemExit('Unexpected lifecycle metadata PVC')
program='''import json,sqlite3,os,stat
from pathlib import Path
p=Path('/var/lib/opensandbox/opensandbox.db')
if not p.is_file():raise SystemExit('Configured SQLite file is missing')
with sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True) as db:
 tables=[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
 databases=list(db.execute('PRAGMA database_list'))
mounts=[line for line in Path('/proc/self/mountinfo').read_text().splitlines() if ' /var/lib/opensandbox ' in line]
if not mounts:raise SystemExit('SQLite directory is not a mounted volume')
print(json.dumps({'path':str(p),'inode':p.stat().st_ino,'device':p.stat().st_dev,'bytes':p.stat().st_size,'mode':oct(stat.S_IMODE(p.stat().st_mode)),'tables':tables,'databaseList':databases,'mountInfo':mounts}))'''
stored=json.loads(kctl('exec','-n','opensandbox-system',pod['metadata']['name'],'--','python3','-I','-c',program))
if 'snapshots' not in stored['tables']:
    raise SystemExit('Snapshot repository schema is missing')
pvc=json.loads(kctl('get','pvc',claim,'-n','opensandbox-system','-o','json'))
pv=json.loads(kctl('get','pv',pvc['spec']['volumeName'],'-o','json'))
volume_path=pv['spec'].get('hostPath',{}).get('path') or pv['spec'].get('local',{}).get('path')
if not volume_path or not volume_path.startswith('/var/lib/kairos-sandbox/volumes/'):
    raise SystemExit('Unexpected metadata PV location')
host_database=Path(volume_path)/'opensandbox.db'
if host_database.stat().st_ino!=stored['inode'] or host_database.stat().st_dev!=stored['device']:
    raise SystemExit('SQLite file does not match the configured PVC backing file')
report={'status':'api_auth_and_sqlite_pvc_verified','apiBase':base,'serviceUid':service['metadata']['uid'],
        'authentication':auth,'serverPodUid':pod['metadata']['uid'],'metadataPvcUid':pvc['metadata']['uid'],
        'metadataPvName':pv['metadata']['name'],'storage':stored,
        'metadataScope':'public snapshot repository; native BatchSandbox/pause state remains in Kubernetes CRDs'}
output=Path('/var/lib/kairos-sandbox/evidence/api-storage.json')
output.write_text(json.dumps(report,indent=2)+'\n');output.chmod(0o600)
print(json.dumps(report,sort_keys=True))
