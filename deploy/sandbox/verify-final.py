#!/usr/bin/python3 -I
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ROOT=Path('/var/lib/kairos-sandbox')
GUARD='/opt/kairos-sandbox/bin/cluster-command.py'
ENV={**os.environ,'K3S_DATA_DIR':str(ROOT/'k3s')}


def kctl(*arguments):
    return json.loads(subprocess.check_output([GUARD,'kubectl',*arguments,'-o','json']))


if os.geteuid()!=0:raise SystemExit('Root is required for final M0 checks')
state=json.loads((ROOT/'evidence/lifecycle.json').read_text())
if state['stage']!='paused' or len(state['cycles'])!=2 or len(state['pauses'])!=3:
    raise SystemExit('Two cycles and a final physically verified pause are required')
batch=kctl('get','batchsandboxes.sandbox.opensandbox.io',state['id'],'-n','opensandbox')
if batch['metadata']['uid']!=state['batchUid'] or batch['status']['phase']!='Paused' or batch['status'].get('replicas')!=0:
    raise SystemExit('The final BatchSandbox is not the original paused resource')
pods=kctl('get','pods','-n','opensandbox')['items']
if any(any(owner['uid']==state['batchUid'] for owner in pod['metadata'].get('ownerReferences',[])) for pod in pods):
    raise SystemExit('A business Pod still exists')
if any(any('running' in container.get('state',{}) for container in pod['status'].get('containerStatuses',[])) for pod in pods):
    raise SystemExit('A snapshot worker still runs')
tracked=set()
for pause in state['pauses']:
    tracked.update(pause['source']['containerIds'])
    for pod in pause['jobPods']:
        for container in pod.get('containers',[]):
            if container.get('containerId'):tracked.add(container['containerId'].removeprefix('containerd://'))
    if Path(pause['source']['cgroup']).exists():raise SystemExit('A retired business cgroup still exists')
tasks=subprocess.check_output(['/opt/kairos-sandbox/bin/k3s','ctr','--address','/run/k3s/containerd/containerd.sock','--namespace','k8s.io','tasks','list'],env=ENV,text=True)
cri=['/opt/kairos-sandbox/bin/k3s','crictl','--runtime-endpoint','unix:///run/k3s/containerd/containerd.sock','--image-endpoint','unix:///run/k3s/containerd/containerd.sock']
containers=json.loads(subprocess.check_output(cri+['ps','--all','--output','json'],env=ENV,text=True))['containers']
sandboxes=json.loads(subprocess.check_output(cri+['pods','--output','json'],env=ENV,text=True))['items']
running=[item for item in containers if item['state']=='CONTAINER_RUNNING']
ready=[item for item in sandboxes if item['state']=='SANDBOX_READY']
if any(item.get('labels',{}).get('io.kubernetes.pod.namespace')=='opensandbox' for item in running):raise SystemExit('A business/snapshot container still runs in CRI')
if any(item['metadata']['namespace']=='opensandbox' for item in ready):raise SystemExit('A business/snapshot sandbox still runs in CRI')
live_runtime_ids={item['id'] for item in [*running,*ready]}
remaining=[]
for line in tasks.splitlines()[1:]:
    fields=line.split()
    if fields and fields[0] in tracked and int(fields[1])>0:remaining.append(fields)
if remaining:raise SystemExit('A tracked runtime task still has a PID')
properties=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show','kairos-k3s.service','--property=MainPID,ControlGroup,MemoryCurrent'],text=True).splitlines())
scope=Path('/sys/fs/cgroup')/properties['ControlGroup'].lstrip('/')
incarnation=json.loads((ROOT/'evidence/post-fifo-scope.json').read_text())
if scope.stat().st_ino!=incarnation['unitRootInode']:raise SystemExit('Scope incarnation changed')
scope_pids=set()
for source in scope.rglob('cgroup.procs'):
    try:scope_pids.update(source.read_text().splitlines())
    except FileNotFoundError:pass
shims=[]
orphan_shims=[]
for pid in scope_pids:
    try:command=Path('/proc/'+pid+'/cmdline').read_bytes()
    except FileNotFoundError:continue
    if b'containerd-shim' in command:
        arguments=[value.decode() for value in command.split(b'\0') if value]
        shim_id=arguments[arguments.index('-id')+1] if '-id' in arguments else None
        if any(identifier.encode() in command for identifier in tracked):shims.append(int(pid))
        if not shim_id or shim_id not in live_runtime_ids:orphan_shims.append(int(pid))
if shims or orphan_shims:raise SystemExit('A retired or orphaned shim remains in the dedicated unit')
baseline=json.loads(Path('/home/wanghailong/kairos/runtime/sandbox/staging/p3-m0-20261108-cf8377d/k1-preinstall-baseline.json').read_text())
for name in ['containerd.service','docker.service']:
    actual=subprocess.check_output(['systemctl','show',name,'--property=ActiveState,SubState,MainPID,ControlGroup'],text=True).strip()
    if actual!=baseline['runtimeServices'][name]['stdout']:raise SystemExit('Existing runtime changed: '+name)
mount_hash=hashlib.sha256(Path('/proc/1/mountinfo').read_bytes()).hexdigest()
if mount_hash!=baseline['globalMountInfoSha256']:raise SystemExit('Global mounts changed')
if Path('/run/containerd/fifo').exists():raise SystemExit('The old runtime FIFO path was modified')
expected={'vm/overcommit_memory':'1','vm/panic_on_oom':'0','kernel/panic':'10','kernel/panic_on_oops':'1','kernel/keys/root_maxkeys':'1000000','kernel/keys/root_maxbytes':'25000000'}
for name,value in expected.items():
    if (Path('/proc/sys')/name).read_text().strip()!=value:raise SystemExit('Shared kernel parameter changed: '+name)
health=[]
for url in ['http://127.0.0.1:4317/health','http://127.0.0.1:4318/health','https://kairos-wanghailong-test.app.msh.team/health','https://kairos-wanghailong-prod.app.msh.team/health']:
    with urllib.request.urlopen(url,timeout=15) as response:
        value=json.load(response)
        if response.status!=200 or value.get('status')!='ok':raise SystemExit('Existing Kairos health check failed')
        health.append({'url':url,'status':response.status})
pvc_info=[]
for namespace,name in [('opensandbox','p3-m0-workspace'),('opensandbox','p3-m0-home'),('kairos-registry','snapshots'),('opensandbox-system','opensandbox-metadata')]:
    pvc=kctl('get','pvc',name,'-n',namespace)
    pv=kctl('get','pv',pvc['spec']['volumeName'])
    if pvc['status']['phase']!='Bound' or pv['spec']['persistentVolumeReclaimPolicy']!='Retain':raise SystemExit('Required PVC/PV retention changed')
    volume_path=pv['spec'].get('hostPath',{}).get('path') or pv['spec'].get('local',{}).get('path')
    if not volume_path.startswith('/var/lib/kairos-sandbox/volumes/'):raise SystemExit('PV escaped the dedicated volume directory')
    usage=int(subprocess.check_output(['du','-sb',volume_path],text=True).split()[0])
    pvc_info.append({'namespace':namespace,'name':name,'uid':pvc['metadata']['uid'],'pvName':pv['metadata']['name'],'retention':'Retain','currentBytes':usage})
report={'status':'m0_backend_verified_finally_paused','sandboxId':state['id'],'batchUid':state['batchUid'],
        'cyclesVerified':2,'pausesVerified':3,'lastSnapshotUid':state['pauses'][-1]['snapshotUid'],
        'businessPodsPresent':0,'trackedTaskPidsRemaining':remaining,'retiredShimsRemaining':shims,'orphanShimsRemaining':orphan_shims,
        'businessCgroupsRemoved':True,'businessMemoryCounterAfter':None,
        'managementUnitMemoryCurrentBytes':int(properties['MemoryCurrent']),
        'scopeRootInode':scope.stat().st_ino,'globalMountInfoSha256':mount_hash,
        'existingRuntimesUnchanged':True,'globalMountsUnchanged':True,'sharedKernelDefaultsUnchanged':True,
        'oldRuntimeFifoAbsent':True,'health':health,'persistentVolumes':pvc_info,
        'unverified':['Kairos M1 capacity/usage registration and env_id tools','Daemon/real-model integration in a platform image','cross-tenant isolation and resource quota tests','node loss, disk full and off-host backup/restore']}
memory_stat=dict(line.split() for line in (scope/'memory.stat').read_text().splitlines())
report['managementUnitMemoryStatBytes']={name:int(memory_stat[name]) if name in memory_stat else None for name in ['anon','file','kernel','slab','slab_reclaimable','slab_unreclaimable']}
output=ROOT/'evidence/final.json';output.write_text(json.dumps(report,indent=2)+'\n');output.chmod(0o600)
print(json.dumps(report,sort_keys=True))
