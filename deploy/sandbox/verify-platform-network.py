#!/usr/bin/python3 -I
"""Test two already-authorized live tenant Pods; create no Kubernetes resources."""
import json
import os
import select
from pathlib import Path
import subprocess
import sys
import uuid

if os.geteuid()!=0 or len(sys.argv)!=5:
    raise SystemExit('Usage: sudo verify-platform-network.py <left-pod> <left-uid> <right-pod> <right-uid>')
guard='/opt/kairos-sandbox/bin/cluster-command.py'


def get(*arguments):
    return json.loads(subprocess.check_output([guard,'kubectl','get',*arguments,'-o','json']))


def pod(name,uid):
    value=get('pod',name,'-n','opensandbox')
    if value['metadata']['uid']!=uid or value['metadata'].get('labels',{}).get('kairos.io/network-role')!='tenant' or value['status']['phase']!='Running' or value['spec']['nodeName']!='kairos-k1':raise SystemExit('Expected a stable, live, protected tenant Pod')
    deployment=value['metadata']['labels'].get('kairos.io/deployment')
    if deployment not in ['test','prod']:raise SystemExit('Unexpected platform deployment')
    return value


left=pod(sys.argv[1],sys.argv[2]);right=pod(sys.argv[3],sys.argv[4])
if left['metadata']['labels'].get('kairos.io/env')==right['metadata']['labels'].get('kairos.io/env'):raise SystemExit('Two different tenant environments are required')


def command(value,program,*arguments):
    deployment=value['metadata']['labels']['kairos.io/deployment']
    shell=f'release=$(readlink -f /opt/kairos-program/{deployment}/current); test -n "$release" && exec "$release/node/bin/node" -e "$1" "${{@:2}}"'
    return [guard,'kubectl','exec',value['metadata']['name'],'-n','opensandbox','-c','sandbox','--','/bin/bash','-c',shell,'network-probe',program,*arguments]


token='kairos-net-probe-'+uuid.uuid4().hex
listener="const s=require('node:net').createServer(c=>c.end('controlled probe'));s.listen(18081,'0.0.0.0',()=>console.log(JSON.stringify({pid:process.pid})));setTimeout(()=>s.close(),60000);"
workers=[];records=[]
try:
    for value in [left,right]:
        process=subprocess.Popen(command(value,listener,token),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        if not select.select([process.stdout],[],[],10)[0]:
            process.terminate();raise SystemExit('Controlled listener readiness exceeded its deadline')
        ready=json.loads(process.stdout.readline())
        if not isinstance(ready.get('pid'),int):raise SystemExit('Controlled listener did not start')
        workers.append((value,process,ready['pid']))
    services=[('kubernetes',get('service','kubernetes','-n','default')),
              ('opensandbox',get('service','opensandbox-server','-n','opensandbox-system')),
              ('gateway',get('service','opensandbox-ingress-gateway','-n','opensandbox-system')),
              ('registry',get('service','snapshot-registry','-n','kairos-registry'))]
    probe=r'''const net=require('node:net'),tls=require('node:tls'),dns=require('node:dns').promises,https=require('node:https');
const config=JSON.parse(process.argv[1]);
function tcp(host,port,secure=false){return new Promise(resolve=>{const c=secure?tls.connect({host,port,servername:config.wssHost,rejectUnauthorized:true}):net.connect({host,port});const done=v=>{c.destroy();resolve(v)};c.setTimeout(1500,()=>done(false));c.once(secure?'secureConnect':'connect',()=>done(true));c.once('error',()=>done(false));})}
function publicRead(){return new Promise(resolve=>{const request=https.get('https://example.com/',{family:4},response=>{let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)response.destroy()});response.on('end',()=>resolve({status:response.statusCode,bytes}));response.on('error',()=>resolve({status:0,bytes}));});request.setTimeout(5000,()=>request.destroy());request.once('error',()=>resolve({status:0,bytes:0}));});}
(async()=>{const local=await tcp('127.0.0.1',18081);if(!local)throw Error('Local controlled listener is unavailable');const resolved=await dns.lookup(config.wssHost,{all:true});if(!resolved.length||resolved.some(a=>a.address!=='172.27.65.55'))throw Error('Unexpected WSS DNS');const wss=await tcp(config.wssHost,443,true);const publicHttps=await publicRead();const forbidden=[];for(const target of config.forbidden)forbidden.push({...target,reachable:await tcp(target.host,target.port)});console.log(JSON.stringify({localListener:true,dns:true,wssTls443:wss,publicHttps,forbidden}));})().catch(e=>{console.error(e.message);process.exitCode=1});'''
    for value,other in [(left,right),(right,left)]:
        deployment=value['metadata']['labels']['kairos.io/deployment']
        forbidden=[{'name':'other-tenant','host':other['status']['podIP'],'port':18081},
                   {'name':'node-kubernetes','host':'172.27.134.23','port':6443},
                   {'name':'node-kubelet','host':'172.27.134.23','port':10250}]
        for name,service in services:
            forbidden.append({'name':name,'host':service['spec']['clusterIP'],'port':service['spec']['ports'][0]['port']})
        result=json.loads(subprocess.check_output(command(value,probe,json.dumps({'wssHost':'kairos-wanghailong-'+deployment+'.app.msh.team','forbidden':forbidden})),text=True,timeout=30))
        records.append({'podUid':value['metadata']['uid'],'podIp':value['status']['podIP'],**result})
    for value in [left,right]:pod(value['metadata']['name'],value['metadata']['uid'])
    passed=all(result['wssTls443'] and 200<=result['publicHttps']['status']<400 and result['publicHttps']['bytes']>0 and not any(target['reachable'] for target in result['forbidden']) for result in records)
    report={'status':'passed' if passed else 'failed_stop_isolation_acceptance','networkNamespace':os.readlink('/proc/self/ns/net'),'results':records,'scope':'two tenant TCP isolation, management endpoints blocked, DNS and authenticated TLS endpoint reachable; actual Daemon authentication is verified separately'}
    destination=Path('/var/lib/kairos-sandbox/evidence/m1-network.json');destination.write_text(json.dumps(report,indent=2)+'\n');destination.chmod(0o600)
    print(json.dumps(report,sort_keys=True))
    if not passed:raise SystemExit('Tenant network isolation failed; inspect source/target and policy chains before continuing')
finally:
    cleanup="const fs=require('node:fs');const pid=Number(process.argv[1]);const token=process.argv[2];try{const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8');if(!args.includes(token))throw Error('Probe process identity changed');process.kill(pid,'SIGTERM')}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e}"
    for value,process,pid in workers:
        subprocess.run(command(value,cleanup,str(pid),token),capture_output=True,text=True,timeout=15)
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.terminate()
