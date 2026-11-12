import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('sandbox cluster guard rejects context overrides, inherited Helm targets and identity drift', () => {
  const guard = fileURLToPath(new URL('../sandbox/cluster-command.py', import.meta.url));
  const program = String.raw`
import base64,hashlib,json,runpy,sys,tempfile
from pathlib import Path
scope=runpy.run_path(sys.argv[1])
validate=scope['validate_arguments']
for mode,args in [('kubectl',['get','pods']),('kubectl',['exec','pod','--','sh','-s']),('helm',['template','release','chart','--kube-version=1.34.13'])]:
    validate(mode,args)
for mode,args in [('kubectl',['get','pods','--kubeconfig=/other']),('kubectl',['get','pods','-shttps://other']),('kubectl',['get','pods','-s','https://other']),('helm',['upgrade','x','chart','--kube-apiserver=https://other']),('helm',['upgrade','x','chart','--kube-ca-file=/other']),('helm',['list','--kube-token=secret']),('helm',['list','--kube-insecure-skip-tls-verify'])]:
    try:validate(mode,args)
    except RuntimeError:pass
    else:raise AssertionError('Cluster override accepted: '+str(args))
env=scope['command_environment']({'PATH':'/usr/bin','KUBECONFIG':'/upper','KUBERNETES_MASTER':'https://upper','HELM_KUBEAPISERVER':'https://upper','HELM_KUBECONTEXT':'upper','HELM_KUBETOKEN':'secret','HELM_KUBECAFILE':'/upper-ca','HELM_KUBEINSECURE_SKIP_TLS_VERIFY':'true'})
assert env['KUBECONFIG']=='/etc/rancher/k3s/k3s.yaml'
assert not any(key.startswith('HELM_KUBE') for key in env)
assert 'KUBERNETES_MASTER' not in env
assert env['PATH']=='/usr/bin'
verified=scope['verified_identity'];shared=verified.__globals__
with tempfile.TemporaryDirectory() as directory:
    ca=Path(directory)/'ca';ca.write_bytes(b'new-cluster-ca\n')
    identity=Path(directory)/'identity.json'
    shared['SERVER_CA']=ca;shared['IDENTITY']=identity
    config={'clusters':[{'cluster':{'server':'https://127.0.0.1:6443','certificate-authority-data':base64.b64encode(ca.read_bytes()).decode()}}]}
    nodes={'items':[{'metadata':{'name':'kairos-k1','uid':'node-1'}}]}
    shared['read_json']=lambda arguments:config if arguments[0]=='config' else nodes
    normal=verified();identity.write_text(json.dumps(normal));assert verified()==normal
    for change,restore in [
      (lambda:config['clusters'][0]['cluster'].update(server='https://upper'),lambda:config['clusters'][0]['cluster'].update(server='https://127.0.0.1:6443')),
      (lambda:nodes['items'][0]['metadata'].update(uid='node-2'),lambda:nodes['items'][0]['metadata'].update(uid='node-1')),
      (lambda:ca.write_bytes(b'other-ca'),lambda:ca.write_bytes(b'new-cluster-ca\n')),
    ]:
        change()
        try:verified()
        except RuntimeError:pass
        else:raise AssertionError('Identity drift accepted')
        restore()
print('guard regression passed')
`;
  const output = execFileSync('python3', ['-c', program, guard], { encoding: 'utf8' });
  assert.equal(output.trim(), 'guard regression passed');
});

test('real fixed Helm render preserves registry CA and every native snapshot gate volume', (context) => {
  const helm = process.env.KAIROS_SANDBOX_HELM_BIN;
  const charts = process.env.KAIROS_SANDBOX_CHARTS;
  if (!helm || !charts) {
    context.skip(
      'Set KAIROS_SANDBOX_HELM_BIN and KAIROS_SANDBOX_CHARTS to the fixed M0 Helm/chart sources.',
    );
    return;
  }
  assert.match(
    execFileSync(helm, ['version', '--short'], { encoding: 'utf8' }),
    /^v3\.19\.2(?:\+|\s|$)/,
  );
  assert.match(
    readFileSync(join(charts, 'opensandbox', 'Chart.yaml'), 'utf8'),
    /^version: 1\.2\.0$/m,
  );
  const source = fileURLToPath(new URL('../sandbox/', import.meta.url));
  const temporary = mkdtempSync(join(tmpdir(), 'kairos-snapshot-helm-'));
  try {
    const localCharts = join(temporary, 'charts');
    cpSync(charts, localCharts, { recursive: true });
    execFileSync(helm, ['dependency', 'build', join(localCharts, 'opensandbox')], {
      stdio: 'pipe',
    });
    const rendered = execFileSync(
      helm,
      [
        'template',
        'opensandbox',
        join(localCharts, 'opensandbox'),
        '--namespace',
        'opensandbox-system',
        '--kube-version',
        '1.34.13',
        '--values',
        join(source, 'opensandbox-values.yaml'),
        '--values',
        join(source, 'platform-controller-values.yaml'),
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    const document = rendered
      .split(/^---\s*$/m)
      .find((value) => value.includes('pod-template.yaml: |'));
    assert.ok(document, 'The controller must mount an image-committer Pod template.');
    const body = document
      .split('pod-template.yaml: |')[1]
      .split('\n')
      .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
      .join('\n');
    const volumeSection = body.match(/^ {2}volumes:\n([\s\S]*)$/m)?.[1];
    assert.ok(volumeSection, 'Snapshot Pod template volumes are required.');
    const volumes = new Set(
      [...volumeSection.matchAll(/^ {4}name: ([a-z0-9-]+)\s*$/gm)].map((match) => match[1]),
    );
    assert.deepEqual([...volumes].sort(), ['physical-observation', 'snapshot-registry-ca']);
    const mountBlocks = [...body.matchAll(/^(\s*)volumeMounts:\n((?:(?:\1 {2}|\1-)[^\n]*\n?)+)/gm)];
    assert.equal(
      mountBlocks.length,
      2,
      'Both commit and observation containers need their mounts.',
    );
    for (const match of mountBlocks) {
      for (const mount of match[2].matchAll(/\bname: ([a-z0-9-]+)/g))
        assert.ok(volumes.has(mount[1]), `Unknown volume mount ${mount[1]}`);
    }
    assert.match(body, /name: SSL_CERT_DIR\n\s+value: \/etc\/ssl\/certs:\/etc\/kairos-registry/);
    assert.match(volumeSection, /configMap:\n\s+name: snapshot-registry-ca/);
    assert.match(body, /kairos\.io\/network-role: snapshot/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
