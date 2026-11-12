#!/usr/bin/python3 -I
"""Publish an already verified Kairos Linux release into the shared program PV."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

if os.geteuid()!=0 or len(sys.argv)!=5:
    raise SystemExit('Usage: sudo publish-program.py <archive> <sha256> <test|prod> <program-pvc>')
archive=Path(sys.argv[1]);expected=sys.argv[2];deployment=sys.argv[3];claim=sys.argv[4]
seed_source=Path(__file__).parent/'workspace/AGENTS.md'
seed=seed_source.read_bytes()
if not seed or len(seed)>65536:raise SystemExit('The reviewed platform workspace seed is missing or oversized')
seed_digest=hashlib.sha256(seed).hexdigest()
if deployment not in ['test','prod'] or len(expected)!=64:raise SystemExit('Invalid publication identity')
guard='/opt/kairos-sandbox/bin/cluster-command.py'
pvc=json.loads(subprocess.check_output([guard,'kubectl','get','pvc',claim,'-n','opensandbox','-o','json']))
pv=json.loads(subprocess.check_output([guard,'kubectl','get','pv',pvc['spec']['volumeName'],'-o','json']))
root=Path(pv['spec'].get('hostPath',{}).get('path') or pv['spec'].get('local',{}).get('path',''))
if not str(root).startswith('/var/lib/kairos-sandbox/volumes/') or pv['spec']['persistentVolumeReclaimPolicy']!='Retain':raise SystemExit('Unexpected shared program PV')
hasher=hashlib.sha256()
with archive.open('rb') as source:
    while True:
        block=source.read(1024*1024)
        if not block:break
        hasher.update(block)
if hasher.hexdigest()!=expected:raise SystemExit('Program archive SHA256 mismatch')
releases=root/'releases';releases.mkdir(mode=0o755,exist_ok=True)
stage=Path(tempfile.mkdtemp(prefix='.publish-',dir=releases))
try:
    with tarfile.open(archive) as bundle:
        for entry in bundle:
            relative=Path(entry.name)
            if relative.is_absolute() or '..' in relative.parts:raise SystemExit('Unsafe program archive path')
            # Release node_modules contain relative package symlinks; reject any link escaping the extracted tree.
            if entry.issym():
                candidate=(stage/relative.parent/entry.linkname).resolve()
                if not candidate.is_relative_to(stage):raise SystemExit('Program symlink escapes its release')
            if entry.islnk() or entry.isdev() or entry.isfifo():raise SystemExit('Unsupported program archive entry')
            target=stage/relative
            if not target.resolve().is_relative_to(stage):raise SystemExit('Program path escapes its release')
            if entry.isdir():target.mkdir(parents=True,exist_ok=True)
            elif entry.issym():
                target.parent.mkdir(parents=True,exist_ok=True);target.symlink_to(entry.linkname)
            elif entry.isfile():
                target.parent.mkdir(parents=True,exist_ok=True)
                with bundle.extractfile(entry) as contents,target.open('xb') as output:shutil.copyfileobj(contents,output)
                target.chmod(0o755 if entry.mode&0o111 else 0o644)
            else:raise SystemExit('Unsupported program archive entry')
    roots=list(stage.iterdir());release=roots[0] if len(roots)==1 and roots[0].is_dir() else stage
    version=(release/'VERSION').read_text().strip()
    if len(version)!=40 or any(value not in '0123456789abcdef' for value in version):raise SystemExit('Program release version is invalid')
    if not (release/'node/bin/node').is_file() or not (release/'app/apps/daemon/dist/main.js').is_file():raise SystemExit('Expected Kairos Linux program layout is missing')
    destination=releases/version
    if destination.exists():
        recorded=(destination/'PLATFORM_ARCHIVE_SHA256').read_text().strip()
        if recorded!=expected:raise SystemExit('Immutable program version already has different contents')
        if json.loads((destination/'workspace-seed/manifest.json').read_text())!={'AGENTS.md':seed_digest} or hashlib.sha256((destination/'workspace-seed/AGENTS.md').read_bytes()).hexdigest()!=seed_digest:raise SystemExit('Immutable workspace seed differs from the reviewed version')
    else:
        (release/'PLATFORM_ARCHIVE_SHA256').write_text(expected+'\n')
        seed_root=release/'workspace-seed';seed_root.mkdir(mode=0o755)
        (seed_root/'AGENTS.md').write_bytes(seed)
        (seed_root/'manifest.json').write_text(json.dumps({'AGENTS.md':seed_digest})+'\n')
        release.rename(destination)
        for path in [destination,*destination.rglob('*')]:
            if not path.is_symlink():path.chmod(0o755 if path.is_dir() or path.stat().st_mode&0o111 else 0o644)
    target=root/deployment;target.mkdir(mode=0o755,exist_ok=True)
    pending=target/'current.new'
    if pending.exists() or pending.is_symlink():raise SystemExit('A publication is already in progress')
    pending.symlink_to(Path('../releases')/version)
    pending.replace(target/'current')
    print(json.dumps({'deployment':deployment,'version':version,'archiveSha256':expected,'programPvcUid':pvc['metadata']['uid'],'programPv':pv['metadata']['name'],'entrypoint':deployment+'/current/bin/kairos-daemon'}))
finally:
    if stage.exists():shutil.rmtree(stage)
