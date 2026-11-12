#!/usr/bin/python3 -I
"""Exercise one explicitly recorded M0 sandbox; never replay an uncertain create."""
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

GUARD='/opt/kairos-sandbox/bin/cluster-command.py'
ROOT=Path('/var/lib/kairos-sandbox')
STATE=ROOT/'evidence/lifecycle.json'
SECRETS=ROOT/'secrets'
ENV={**os.environ,'K3S_DATA_DIR':str(ROOT/'k3s')}
RUNTIME=['/opt/kairos-sandbox/bin/k3s','crictl','--runtime-endpoint','unix:///run/k3s/containerd/containerd.sock','--image-endpoint','unix:///run/k3s/containerd/containerd.sock']
HTTP=urllib.request.build_opener(urllib.request.ProxyHandler({}))
API=json.loads((ROOT/'evidence/api-storage.json').read_text())['apiBase']
API_KEY=(SECRETS/'api-key').read_text()


def kctl(*arguments):
    return subprocess.check_output([GUARD,'kubectl',*arguments],text=True)


def resource(kind,name=None):
    if kind in ['batchsandboxes','sandboxsnapshots']:
        kind=kind+'.sandbox.opensandbox.io'
    arguments=['get',kind]
    if name:arguments.append(name)
    return json.loads(kctl(*arguments,'-n','opensandbox','-o','json'))


def save(state):
    temporary=STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state,indent=2)+'\n');temporary.chmod(0o600)
    temporary.replace(STATE)


def api(method,path,data=None):
    body=None if data is None else json.dumps(data).encode()
    request=urllib.request.Request(API+'/v1'+path,method=method,data=body,headers={'OPEN-SANDBOX-API-KEY':API_KEY,'Content-Type':'application/json'})
    try:
        with HTTP.open(request,timeout=60) as response:
            raw=response.read()
            return response.status,json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        error.read()
        raise RuntimeError('Lifecycle API '+method+' failed with HTTP '+str(error.code))


def wait_for(check,description,seconds=120):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=check()
        if value:return value
        time.sleep(0.5)
    raise RuntimeError('Timed out: '+description)


def owned(objects,uid):
    return [value for value in objects if any(owner['uid']==uid for owner in value['metadata'].get('ownerReferences',[]))]


def warm(state):
    def ready():
        _,remote=api('GET','/sandboxes/'+state['id'])
        if remote['status']['state']=='Failed':raise RuntimeError('Sandbox entered Failed')
        if remote['status']['state']!='Running':return None
        batch=resource('batchsandboxes',state['id'])
        pods=owned(resource('pods')['items'],batch['metadata']['uid'])
        pods=[pod for pod in pods if not pod['metadata'].get('deletionTimestamp')]
        if len(pods)!=1:return None
        pod=pods[0]
        if pod['status']['phase']!='Running' or not all(item.get('ready') for item in pod['status'].get('containerStatuses',[])):return None
        return batch,pod
    batch,pod=wait_for(ready,'sandbox ready',180)
    if batch['spec'].get('expireTime') or batch['spec'].get('poolRef') or batch['spec'].get('replicas')!=1:
        raise RuntimeError('Unexpected expiry, Pool or replica configuration')
    if state.get('batchUid') and state['batchUid']!=batch['metadata']['uid']:
        raise RuntimeError('BatchSandbox UID changed')
    if state.get('current'):
        container=next(value for value in pod['spec']['containers'] if value['name']==state['current']['containerName'])
    else:
        container=next(value for value in pod['spec']['containers'] if value['image'].startswith('10.251.0.50:5000/base/ubuntu'))
    name=container['name']
    actual_user=kctl('exec',pod['metadata']['name'],'-n','opensandbox','-c',name,'--','id','-u').strip()
    if actual_user!='1000' or pod['spec'].get('automountServiceAccountToken') is not False:
        raise RuntimeError('Business container privileges do not match the template')
    statuses=pod['status']['containerStatuses']
    ids=[value['containerID'].removeprefix('containerd://') for value in statuses]
    main=next(value for value in statuses if value['name']==name)
    inspected=json.loads(subprocess.check_output(RUNTIME+['inspect',main['containerID'].removeprefix('containerd://')],env=ENV,text=True))
    cgroup=inspected['info']['runtimeSpec']['linux']['cgroupsPath']
    if not cgroup.startswith('/pods/') or '..' in Path(cgroup).parts:
        raise RuntimeError('Business container cgroup escaped the dedicated Pod subtree')
    control=subprocess.check_output(['systemctl','show','kairos-k3s.service','--property=ControlGroup','--value'],text=True).strip()
    scope=Path('/sys/fs/cgroup')/control.lstrip('/')
    incarnation=json.loads((ROOT/'evidence/post-fifo-scope.json').read_text())
    if scope.stat().st_ino!=incarnation['unitRootInode']:
        raise RuntimeError('K3s scope incarnation changed')
    leaf=scope/cgroup.lstrip('/')
    pod_group=leaf.parent
    processes=[]
    for source in pod_group.rglob('cgroup.procs'):
        for value in source.read_text().splitlines():
            try:
                record=Path('/proc/'+value+'/stat').read_text()
                processes.append({'pid':int(value),'startTime':record[record.rindex(')')+2:].split()[19]})
            except FileNotFoundError:pass
    info={'name':pod['metadata']['name'],'uid':pod['metadata']['uid'],'containerName':name,'containerIds':ids,
          'cgroup':str(pod_group),'cgroupInode':pod_group.stat().st_ino,
          'memoryCurrentBytes':int((pod_group/'memory.current').read_text()),'processes':processes}
    return batch,info


def markers(pod,values,write=False):
    if write:
        # The base image intentionally needs no Python installation.
        for path,value in values.items():
            command='printf %s "$1" > "$2"'
            kctl('exec',pod['name'],'-n','opensandbox','-c',pod['containerName'],'--','/bin/sh','-c',command,'m0',value,path)
    for path,value in values.items():
        actual=kctl('exec',pod['name'],'-n','opensandbox','-c',pod['containerName'],'--','cat',path)
        if actual!=value:raise RuntimeError('Restored marker mismatch: '+path)


def registry_manifest(reference,expected):
    prefix='10.251.0.50:5000/'
    if not reference.startswith(prefix):raise RuntimeError('Unexpected snapshot registry')
    relative=reference.removeprefix(prefix)
    repository,selector=relative.split('@',1) if '@' in relative else relative.rsplit(':',1)
    credentials=json.loads((SECRETS/'registry-credentials.json').read_text())
    auth=base64.b64encode((credentials['username']+':'+credentials['password']).encode()).decode()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*arguments,**keywords):
            raise RuntimeError('Snapshot registry redirects are forbidden')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(SECRETS/'registry-ca.crt'))))
    request=urllib.request.Request('https://10.251.0.50:5000/v2/'+repository+'/manifests/'+selector,headers={'Authorization':'Basic '+auth,'Accept':'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
    with opener.open(request,timeout=15) as response:
        content=response.read();header=response.headers.get('Docker-Content-Digest')
    actual='sha256:'+hashlib.sha256(content).hexdigest()
    if actual!=expected or header!=actual:raise RuntimeError('Snapshot manifest digest does not match the registry')
    return {'imageUri':reference,'manifestDigest':actual,'layerCount':len(json.loads(content)['layers'])}


def pause(state,source,dispatch=True):
    if dispatch:
        state['pauseStartedMonotonic']=time.monotonic();state['stage']='pausing';save(state)
        code,_=api('POST','/sandboxes/'+state['id']+'/pause')
        if code!=202:raise RuntimeError('Pause was not accepted with HTTP 202')
    def succeeded():
        snapshots=owned(resource('sandboxsnapshots')['items'],state['batchUid'])
        matches=[item for item in snapshots if item['spec']['sandboxName']==state['id']]
        if len(matches)!=1:return None
        snapshot=matches[0]
        if snapshot.get('status',{}).get('phase')=='Failed':raise RuntimeError('Native pause snapshot failed; inspect the recorded resource')
        return snapshot if snapshot.get('status',{}).get('phase')=='Succeed' else None
    snapshot=wait_for(succeeded,'snapshot Succeed',600)
    containers=snapshot['status']['containers']
    images=[registry_manifest(value['imageUri'],value['imageDigest']) for value in containers]
    jobs=owned(resource('jobs')['items'],snapshot['metadata']['uid'])
    recovered_events=[]
    if not jobs and not dispatch:
        recorded=ROOT/'evidence/first-pause-recovery/events.json'
        if recorded.exists():recovered_events=json.loads(recorded.read_text())['items']
    event_jobs=[]
    event_pods=[]
    for event in recovered_events:
        reference=event.get('involvedObject') or event.get('regarding',{})
        if reference.get('kind')=='Job' and reference.get('name')==snapshot['metadata']['name']+'-commit':event_jobs.append(reference)
        if reference.get('kind')=='Pod' and reference.get('name','').startswith(snapshot['metadata']['name']+'-commit-'):event_pods.append(reference)
    job_uids=sorted({value['metadata']['uid'] for value in jobs}|{value['uid'] for value in event_jobs})
    if not job_uids:raise RuntimeError('Snapshot Job UID was not captured before resume')
    observed_job_pods=[]
    def released():
        if owned(resource('pods')['items'],state['batchUid']):return False
        job_pods=[pod for pod in resource('pods')['items'] if any(owner['uid'] in job_uids for owner in pod['metadata'].get('ownerReferences',[]))]
        observed_job_pods[:]=[{'name':pod['metadata']['name'],'uid':pod['metadata']['uid'],'phase':pod['status']['phase'],
                             'containers':[{'name':item['name'],'containerId':item.get('containerID'),'state':item.get('state')} for item in pod['status'].get('containerStatuses',[])]} for pod in job_pods]
        if any(any('running' in item.get('state',{}) for item in pod['status'].get('containerStatuses',[])) for pod in job_pods):return False
        if Path(source['cgroup']).exists():return False
        for process in source['processes']:
            try:
                record=Path('/proc/'+str(process['pid'])+'/stat').read_text()
                if record[record.rindex(')')+2:].split()[19]==process['startTime']:return False
            except FileNotFoundError:pass
        return True
    wait_for(released,'source Pod and business/snapshot processes released',120)
    if not observed_job_pods and event_pods:
        observed_job_pods=[{'name':value['name'],'uid':value['uid'],'evidence':'Kubernetes event; Pod already garbage-collected'} for value in {value['uid']:value for value in event_pods}.values()]
    control=subprocess.check_output(['systemctl','show','kairos-k3s.service','--property=ControlGroup','--value'],text=True).strip()
    pod_root=Path('/sys/fs/cgroup')/control.lstrip('/')/'pods/kubepods'
    for pod in observed_job_pods:
        candidates=[pod_root/('pod'+pod['uid']),pod_root/'burstable'/('pod'+pod['uid']),pod_root/'besteffort'/('pod'+pod['uid'])]
        existing=[path for path in candidates if path.exists()]
        for path in existing:
            if 'populated 0' not in (path/'cgroup.events').read_text():raise RuntimeError('Snapshot Job still has a populated cgroup')
        pod['cgroupProcessExited']=True;pod['cgroupRemoved']=not existing
    job_details=[]
    for item in jobs:
        source_uids=[value['value'] for container in item['spec']['template']['spec']['containers'] for value in container.get('env',[]) if value['name']=='SOURCE_POD_UID']
        if source_uids!=[source['uid']]:raise RuntimeError('Snapshot Job source Pod UID does not match the captured instance')
        job_details.append({'name':item['metadata']['name'],'uid':item['metadata']['uid'],'sourcePodUid':source_uids[0]})
    _,remote=api('GET','/sandboxes/'+state['id'])
    if remote['status']['state']!='Paused':raise RuntimeError('Lifecycle API is not Paused after physical release')
    record={'snapshotUid':snapshot['metadata']['uid'],'snapshotName':snapshot['metadata']['name'],'snapshotSpec':snapshot['spec'],
            'sourcePodName':snapshot['status'].get('sourcePodName'),'sourcePodUid':source['uid'],
            'containers':containers,'images':images,'jobUids':job_uids,'jobPods':observed_job_pods,'jobEvidenceFromEvents':not bool(jobs),'jobs':job_details,
            'source':source,'sourcePodRemoved':True,'businessCgroupRemoved':True,'businessProcessCountAfter':0,
            'businessMemoryCurrentAfter':None,'elapsedSeconds':round(time.monotonic()-state['pauseStartedMonotonic'],3) if state.get('pauseStartedMonotonic') else None,
            'completedAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    ready_time=next(condition['lastTransitionTime'] for condition in snapshot['status'].get('conditions',[]) if condition['type']=='Ready' and condition['status']=='True')
    record['snapshotSeconds']=(datetime.fromisoformat(ready_time.replace('Z','+00:00'))-datetime.fromisoformat(snapshot['metadata']['creationTimestamp'].replace('Z','+00:00'))).total_seconds()
    record['runtimeUnitMemoryCurrentBytes']=int((pod_root.parent.parent/'memory.current').read_text())
    state.setdefault('pauses',[]).append(record);state['stage']='paused';save(state)
    print(json.dumps({'action':'paused','id':state['id'],'snapshotUid':record['snapshotUid'],'elapsedSeconds':record['elapsedSeconds'],'sourcePodUid':source['uid'],'sourceCgroupRemoved':True}),flush=True)
    return record


def resume(state):
    if state['stage']!='paused':raise RuntimeError('Resume requires a recorded physically released pause')
    paused=state['pauses'][-1];source=paused['source']
    state['stage']='resume-dispatched';save(state);started=time.monotonic()
    code,_=api('POST','/sandboxes/'+state['id']+'/resume')
    if code!=202:raise RuntimeError('Resume was not accepted with HTTP 202')
    batch,new=warm(state)
    if new['uid']==source['uid'] or set(new['containerIds'])&set(source['containerIds']):raise RuntimeError('Resume reused a Pod/container instance')
    markers(new,state['markers'])
    state['cycles'].append({'number':len(state['cycles'])+1,'pauseSnapshotUid':paused['snapshotUid'],'oldPodUid':source['uid'],'newPodUid':new['uid'],'oldContainerIds':source['containerIds'],'newContainerIds':new['containerIds'],'resumeSeconds':round(time.monotonic()-started,3),'allMarkersRestored':True})
    state['current']=new;state['stage']='running';save(state)
    print(json.dumps({'action':'cycle-completed','id':state['id'],**state['cycles'][-1]}),flush=True)


def main():
    if os.geteuid()!=0 or len(sys.argv)!=2:raise RuntimeError('Usage: sudo verify-lifecycle.py create|cycle|pause|resume')
    action=sys.argv[1]
    subprocess.run([GUARD,'identity'],check=True)
    if action=='create':
        existing=resource('batchsandboxes')['items']
        if STATE.exists():
            state=json.loads(STATE.read_text())
            if state['stage']!='create-dispatched':raise RuntimeError('The recorded create is not recoverable at this step')
            matches=[value for value in existing if value['metadata'].get('labels',{}).get('kairos.m0.run')==state['runId']]
            if len(existing)!=1 or len(matches)!=1:raise RuntimeError('The uncertain create cannot be uniquely reconciled; it will not be replayed')
            state['id']=matches[0]['metadata']['name'];state['createReconciledWithoutReplay']=True;save(state)
        else:
            if existing:raise RuntimeError('A BatchSandbox already exists; another business sandbox will not be created')
            state={'runId':str(uuid.uuid4()),'stage':'create-dispatched','cycles':[]}
            request=json.loads((Path(__file__).parent/'create-test-sandbox.json').read_text())
            request['metadata']['kairos.m0.run']=state['runId'];state['request']=request;save(state)
            code,created=api('POST','/sandboxes',request)
            state['createHttpStatus']=code;state['id']=created['id'];save(state)
            if code!=202:raise RuntimeError('The pinned lifecycle create did not return HTTP 202')
        batch,pod=warm(state);state['batchUid']=batch['metadata']['uid']
        if not state.get('markers'):
            state['markers']={path:str(uuid.uuid4()) for path in ['/tmp/p3-m0-rootfs.txt','/workspace/p3-m0-workspace.txt','/home/agent/p3-m0-home.txt']}
        save(state)
        markers(pod,state['markers'],write=True)
        state['initial']=pod;state['current']=pod;state['stage']='running';save(state)
        print(json.dumps({'action':'created','id':state['id'],'batchUid':state['batchUid'],'pod':pod}),flush=True)
        return
    state=json.loads(STATE.read_text())
    if action=='finish-pause':
        if state['stage']!='pausing':raise RuntimeError('Only an already-dispatched pause can be reconciled')
        pause(state,state['current'],dispatch=False);return
    if action=='resume':
        resume(state);return
    if state['stage']!='running':raise RuntimeError('The recorded sandbox is not at a safe running step')
    batch,source=warm(state);markers(source,state['markers'])
    if action=='pause':
        pause(state,source);return
    if action!='cycle':raise RuntimeError('Unknown lifecycle validation step')
    cycle_number=len(state['cycles'])+1
    state['markers']['/tmp/p3-m0-cycle-'+str(cycle_number)+'.txt']=str(uuid.uuid4())
    markers(source,state['markers'],write=True)
    pause(state,source)
    resume(state)


if __name__=='__main__':
    try:main()
    except (OSError,ValueError,KeyError,RuntimeError,subprocess.CalledProcessError,urllib.error.URLError) as error:
        print('M0 lifecycle verification stopped: '+str(error),file=sys.stderr)
        raise SystemExit(1)
