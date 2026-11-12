#!/usr/bin/python3 -I
import base64
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request

BASE='https://10.251.0.50:5000'
SECRETS=Path('/var/lib/kairos-sandbox/secrets')
GUARD='/opt/kairos-sandbox/bin/cluster-command.py'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*arguments,**keywords):
        raise RuntimeError('Registry redirects are forbidden')


def main():
    if os.geteuid()!=0 or len(sys.argv) not in [2,3]:
        raise RuntimeError('Usage: sudo push-base-image.py <verified-staging-directory> [node|tools]')
    staging=Path(sys.argv[1]).resolve()
    if not str(staging).startswith('/home/wanghailong/kairos/runtime/sandbox/staging/'):
        raise RuntimeError('Unexpected artifact directory')
    lock=json.loads((Path(__file__).parent/'versions.json').read_text())
    variant=sys.argv[2] if len(sys.argv)==3 else 'ubuntu'
    if variant not in ['ubuntu','node','tools']:raise RuntimeError('Unreviewed base image selection')
    expected=lock['offlineImages'][variant]
    repository='base/'+variant
    tag='24.04-amd64' if variant=='ubuntu' else '26.4.0-bookworm-slim-amd64' if variant=='node' else expected['sourceTag']+'-amd64'
    service=json.loads(subprocess.check_output([GUARD,'kubectl','get','service','snapshot-registry','-n','kairos-registry','-o','json']))
    if service['spec']['clusterIP']!='10.251.0.50':
        raise RuntimeError('Registry service identity changed')
    credentials=json.loads((SECRETS/'registry-credentials.json').read_text())
    authorization='Basic '+base64.b64encode((credentials['username']+':'+credentials['password']).encode()).decode()
    context=ssl.create_default_context(cafile=str(SECRETS/'registry-ca.crt'))
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPSHandler(context=context))

    def request(method,path,data=None,media_type=None,authenticated=True):
        url=urllib.parse.urljoin(BASE,path)
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!='https' or parsed.netloc!='10.251.0.50:5000':
            raise RuntimeError('Unexpected registry upload endpoint')
        headers={'Accept':'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}
        if authenticated:headers['Authorization']=authorization
        if media_type:headers['Content-Type']=media_type
        try:
            with opener.open(urllib.request.Request(url,method=method,data=data,headers=headers),timeout=30) as response:
                return response.status,dict(response.headers),response.read()
        except urllib.error.HTTPError as error:
            return error.code,dict(error.headers),error.read()

    if request('GET','/v2/',authenticated=False)[0]!=401:
        raise RuntimeError('Unauthenticated registry access was not rejected')
    if request('GET','/v2/')[0]!=200:
        raise RuntimeError('Registry TLS/authentication check failed')
    archive_path=staging/expected['archiveName']
    hasher=hashlib.sha256()
    with archive_path.open('rb') as stream:
        while True:
            block=stream.read(1024*1024)
            if not block:break
            hasher.update(block)
    if hasher.hexdigest()!=expected['archiveSha256']:
        raise RuntimeError('Platform base archive digest mismatch')
    uploaded=[]
    with tarfile.open(archive_path) as archive:
        index=json.load(archive.extractfile('index.json'))
        descriptor=index['manifests'][0]
        if len(index['manifests'])!=1 or descriptor['digest']!=expected['platformManifestDigest']:
            raise RuntimeError('Unexpected platform manifest')
        manifest_bytes=archive.extractfile('blobs/sha256/'+descriptor['digest'].split(':')[1]).read()
        if 'sha256:'+hashlib.sha256(manifest_bytes).hexdigest()!=descriptor['digest']:
            raise RuntimeError('Manifest content digest mismatch')
        manifest=json.loads(manifest_bytes)
        for blob in [manifest['config'],*manifest['layers']]:
            digest=blob['digest']
            status,headers,_=request('HEAD','/v2/'+repository+'/blobs/'+digest)
            if status==404:
                data=archive.extractfile('blobs/sha256/'+digest.split(':')[1]).read()
                if len(data)!=blob['size'] or 'sha256:'+hashlib.sha256(data).hexdigest()!=digest:
                    raise RuntimeError('Blob content digest mismatch')
                status,headers,_=request('POST','/v2/'+repository+'/blobs/uploads/',b'')
                if status!=202:raise RuntimeError('Registry upload initiation failed: '+str(status))
                location=headers.get('Location') or headers.get('location')
                if not location:raise RuntimeError('Registry upload location is missing')
                separator='&' if '?' in location else '?'
                status,headers,_=request('PUT',location+separator+urllib.parse.urlencode({'digest':digest}),data,'application/octet-stream')
                if status!=201:raise RuntimeError('Registry blob upload failed: '+str(status))
            elif status!=200:
                raise RuntimeError('Registry blob lookup failed: '+str(status))
            uploaded.append(digest)
        status,_,_=request('PUT','/v2/'+repository+'/manifests/'+tag,manifest_bytes,descriptor['mediaType'])
        if status!=201:raise RuntimeError('Registry manifest upload failed: '+str(status))
        status,headers,actual_bytes=request('GET','/v2/'+repository+'/manifests/'+tag)
        actual_digest='sha256:'+hashlib.sha256(actual_bytes).hexdigest()
        header_digest=headers.get('Docker-Content-Digest') or headers.get('docker-content-digest')
        if status!=200 or actual_digest!=descriptor['digest'] or header_digest!=actual_digest:
            raise RuntimeError('Pushed manifest digest verification failed')
    report={'status':'registry_push_verified','registryServiceUid':service['metadata']['uid'],
            'sourceIndexDigest':expected['sourceIndexDigest'],'actualManifestDigest':actual_digest,
            'imageReference':'10.251.0.50:5000/'+repository+':'+tag+'@'+actual_digest,
            'verifiedBlobDigests':uploaded,'tlsVerified':True,'unauthenticatedStatus':401}
    destination=Path('/var/lib/kairos-sandbox/evidence/base-image-'+variant+'.json' if variant!='ubuntu' else '/var/lib/kairos-sandbox/evidence/base-image.json')
    destination.write_text(json.dumps(report,indent=2)+'\n');destination.chmod(0o600)
    print(json.dumps(report,sort_keys=True))


if __name__=='__main__':
    try:main()
    except (OSError,ValueError,KeyError,RuntimeError,urllib.error.URLError) as error:
        print('Base image push failed: '+str(error),file=sys.stderr)
        raise SystemExit(1)
