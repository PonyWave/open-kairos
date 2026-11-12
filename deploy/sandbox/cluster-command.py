#!/usr/bin/python3 -I
"""Run commands only against the explicitly registered Kairos M0 cluster."""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

CONFIG='/etc/rancher/k3s/k3s.yaml'
IDENTITY=Path('/etc/kairos-sandbox/cluster-identity.json')
SERVER_CA=Path('/var/lib/kairos-sandbox/k3s/server/tls/server-ca.crt')
NODE='kairos-k1'
SERVER='https://127.0.0.1:6443'
def command_environment(source):
    clean={key:value for key,value in source.items() if not key.startswith('HELM_') and key not in ['KUBECONFIG','KUBERNETES_MASTER','KUBERNETES_SERVICE_HOST','KUBERNETES_SERVICE_PORT']}
    return {**clean,'K3S_DATA_DIR':'/var/lib/kairos-sandbox/k3s','KUBECONFIG':CONFIG,
            'HELM_CACHE_HOME':'/var/lib/kairos-sandbox/helm/cache',
            'HELM_CONFIG_HOME':'/var/lib/kairos-sandbox/helm/config',
            'HELM_DATA_HOME':'/var/lib/kairos-sandbox/helm/data'}


ENV=command_environment(os.environ)
CLI=['/opt/kairos-sandbox/bin/k3s','kubectl','--kubeconfig='+CONFIG]


def read_json(arguments):
    completed=subprocess.run(CLI+arguments,env=ENV,capture_output=True,text=True,timeout=15)
    if completed.returncode:
        raise RuntimeError('New-cluster verification failed: '+completed.stderr.strip()[:500])
    return json.loads(completed.stdout)


def verified_identity():
    config=read_json(['config','view','--raw','--minify','-o','json'])
    clusters=config.get('clusters',[])
    if len(clusters)!=1:
        raise RuntimeError('A single explicit cluster is required')
    cluster=clusters[0]['cluster']
    if cluster.get('server')!=SERVER or cluster.get('insecure-skip-tls-verify'):
        raise RuntimeError('Unexpected API endpoint or TLS configuration')
    certificate=base64.b64decode(cluster['certificate-authority-data'],validate=True)
    if certificate!=SERVER_CA.read_bytes():
        raise RuntimeError('The explicit kubeconfig does not contain the new cluster CA')
    fingerprint=hashlib.sha256(certificate).hexdigest()
    if IDENTITY.exists():
        saved=json.loads(IDENTITY.read_text())
        if saved['server']!=SERVER or saved['caPemSha256']!=fingerprint:
            raise RuntimeError('The registered cluster CA changed')
    nodes=read_json(['get','nodes','-o','json'])['items']
    if len(nodes)!=1 or nodes[0]['metadata']['name']!=NODE:
        raise RuntimeError('Unexpected cluster node identity')
    node_uid=nodes[0]['metadata']['uid']
    if IDENTITY.exists() and saved['nodeUid']!=node_uid:
        raise RuntimeError('The registered cluster node UID changed')
    return {'server':SERVER,'caPemSha256':fingerprint,'nodeName':NODE,'nodeUid':node_uid,'kubeconfig':CONFIG}


def main():
    if os.geteuid()!=0 or len(sys.argv)<2:
        raise RuntimeError('Usage: sudo cluster-command.py bootstrap|kubectl|helm|identity [arguments]')
    mode=sys.argv[1]
    if mode!='bootstrap' and not IDENTITY.exists():
        raise RuntimeError('Bootstrap the identity of the new cluster first')
    identity=verified_identity()
    if mode=='bootstrap':
        if not IDENTITY.exists():
            with IDENTITY.open('x') as target:
                os.chmod(IDENTITY,0o600)
                json.dump(identity,target,indent=2)
                target.write('\n')
        print(json.dumps(identity,sort_keys=True))
        return
    if mode=='identity':
        print(json.dumps(identity,sort_keys=True))
        return
    arguments=sys.argv[2:]
    validate_arguments(mode,arguments)
    if mode=='kubectl':
        os.execvpe(CLI[0],CLI+arguments,ENV)
    if mode=='helm':
        command=['/opt/kairos-sandbox/bin/helm','--kubeconfig='+CONFIG,*arguments]
        os.execvpe(command[0],command,ENV)
    raise RuntimeError('Unknown cluster command')


def validate_arguments(mode,arguments):
    denied=['--kubeconfig','--context','--cluster','--user','--server','--token','--client-key','--client-certificate','--certificate-authority','--insecure-skip-tls-verify']
    for argument in arguments:
        if argument=='--':
            break
        if ((mode=='kubectl' and argument.startswith('-s')) or
            any(argument==flag or argument.startswith(flag+'=') for flag in denied) or
            (mode=='helm' and argument.startswith('--kube') and not argument.startswith('--kube-version'))):
            raise RuntimeError('Cluster identity overrides are forbidden')


if __name__=='__main__':
    try:
        main()
    except (OSError,ValueError,KeyError,RuntimeError) as error:
        print(str(error),file=sys.stderr)
        raise SystemExit(1)
