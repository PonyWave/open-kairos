#!/usr/bin/python3 -I
import base64
import crypt
import json
import os
from pathlib import Path
import secrets

if os.geteuid()!=0:
    raise SystemExit('Root is required for private M0 secrets')
root=Path('/var/lib/kairos-sandbox/secrets')
if not root.is_dir() or root.stat().st_mode&0o077:
    raise SystemExit('Private secret directory is missing or not restricted')


def write_new(name,value):
    with (root/name).open('x') as target:
        os.chmod(root/name,0o600)
        target.write(value)


username='kairos-m0'
password=secrets.token_urlsafe(32)
write_new('registry-credentials.json',json.dumps({'username':username,'password':password}))
hashed=crypt.crypt(password,crypt.mksalt(crypt.METHOD_BLOWFISH))
if not hashed or not hashed.startswith('$2'):
    raise SystemExit('Bcrypt hashing failed')
write_new('htpasswd',username+':'+hashed+'\n')
auth=base64.b64encode((username+':'+password).encode()).decode()
write_new('registry-dockerconfig.json',json.dumps({'auths':{'10.251.0.50:5000':{'auth':auth}}}))
write_new('api-key',secrets.token_hex(32))
write_new('route.keys','a='+base64.b64encode(secrets.token_bytes(32)).decode())
write_new('route.active-key','a')
print('Created six private M0 secret files with mode 0600; values were not printed.')
