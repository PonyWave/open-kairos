#!/usr/bin/python3 -I
"""Apply reviewed policies only inside the dedicated k1 cluster/network namespace."""
import json
import os
from pathlib import Path
import socket
import subprocess

if os.geteuid()!=0:raise SystemExit('Root is required for reviewed platform network installation')
scope={}
for line in Path('/etc/kairos-sandbox/scope.env').read_text().splitlines():
    key,value=line.split('=',1);scope[key]=value
if os.readlink('/proc/self/ns/net')!=scope.get('KAIROS_K1_NET_NAMESPACE'):raise SystemExit('Not in the reviewed k1 private network namespace')
for hostname in ['kairos-wanghailong-test.app.msh.team','kairos-wanghailong-prod.app.msh.team']:
    addresses={value[4][0] for value in socket.getaddrinfo(hostname,443,type=socket.SOCK_STREAM)}
    if addresses!={'172.27.65.55'}:raise SystemExit('WSS DNS changed; review exact permitted destinations before deployment')
rules=subprocess.check_output(['iptables-save','-t','filter'],text=True)
if ':KUBE-ROUTER-INPUT ' not in rules or ':KUBE-NWPLCY-DEFAULT ' not in rules:raise SystemExit('The dedicated K3s NetworkPolicy controller rules are absent')
guard='/opt/kairos-sandbox/bin/cluster-command.py'
subprocess.run([guard,'kubectl','apply','-f',str(Path(__file__).parent/'platform-network-policy.yaml')],check=True)
subprocess.run([guard,'kubectl','get','networkpolicies','-n','opensandbox'],check=True)
print(json.dumps({'status':'reviewed_network_policies_applied_not_yet_isolation_tested','networkNamespace':scope['KAIROS_K1_NET_NAMESPACE'],'wssAddress':'172.27.65.55:443','scope':'opensandbox tenant/helper Pod policies; existing namespaces and base chains preserved'}))
