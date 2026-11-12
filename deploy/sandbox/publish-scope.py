#!/usr/bin/python3 -I
import json
import os
from pathlib import Path
import subprocess

if os.geteuid()!=0:raise SystemExit('Only the scoped administrator may publish a physical scope proof')
values=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show','kairos-k3s.service','--property=MainPID,ControlGroup,ActiveState'],text=True).splitlines())
if values['ActiveState']!='active' or not values['ControlGroup'].endswith('/system.slice/kairos-k3s.service'):raise SystemExit('The dedicated K3s unit is not active')
root=Path('/sys/fs/cgroup')/values['ControlGroup'].lstrip('/')
view=Path('/proc')/values['MainPID']/'root/sys/fs/cgroup'
if root.stat().st_ino!=view.stat().st_ino:raise SystemExit('The private namespace does not match the dedicated cgroup')
pods=root/'pods';kubepods=pods/'kubepods'
proof={'version':1,'scope':{'root':str(root),'rootInode':root.stat().st_ino,'podsInode':pods.stat().st_ino,'kubepodsInode':kubepods.stat().st_ino,'device':root.stat().st_dev}}
destination=Path('/etc/kairos-sandbox/public-scope.json');pending=destination.with_suffix('.new')
with pending.open('x') as target:
    json.dump(proof,target,indent=2);target.write('\n');target.flush();os.fsync(target.fileno())
pending.chmod(0o444);pending.replace(destination)
print(json.dumps(proof))
