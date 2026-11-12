import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const scopeSchema = z.object({
  root: z.string().startsWith('/sys/fs/cgroup/'),
  rootInode: z.number().int(),
  podsInode: z.number().int(),
  kubepodsInode: z.number().int(),
  device: z.number().int(),
});
export const physicalEvidenceSchema = z.object({
  scope: scopeSchema,
  podUid: z.string(),
  path: z.string(),
  inode: z.number().int(),
  device: z.number().int(),
});
export type PhysicalEvidence = z.infer<typeof physicalEvidenceSchema>;
export const retiredHelperEvidenceSchema = z.object({
  scope: scopeSchema,
  podUid: z.string(),
  candidatePaths: z.array(z.string()),
  kind: z.literal('retired_helper_no_processes'),
});
export type RetiredHelperEvidence = z.infer<typeof retiredHelperEvidenceSchema>;
export interface PlatformPhysicalObserver {
  observe(podUid: string): Promise<PhysicalEvidence | undefined>;
  exited(evidence: PhysicalEvidence): Promise<boolean>;
  retiredHelper?(podUid: string): Promise<RetiredHelperEvidence>;
}

/** Reads an administrator-issued public scope proof; never enters a namespace or writes cgroups. */
export class CgroupPhysicalObserver implements PlatformPhysicalObserver {
  constructor(readonly proofFile: string) {}
  async #scope() {
    if ((await realpath(this.proofFile)) !== this.proofFile)
      throw new Error('Platform scope proof path contains a symlink.');
    for (let parent = dirname(this.proofFile); ; parent = dirname(parent)) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
        throw new Error(
          'Platform scope proof parent directory must be root-owned and not writable by Server.',
        );
      if (parent === '/') break;
    }
    const identity = await lstat(this.proofFile);
    if (
      identity.uid !== 0 ||
      identity.isSymbolicLink() ||
      !identity.isFile() ||
      (identity.mode & 0o022) !== 0
    )
      throw new Error('Platform physical scope proof must be a root-owned read-only regular file.');
    const proof = z
      .object({ version: z.literal(1), scope: scopeSchema })
      .parse(JSON.parse(await readFile(this.proofFile, 'utf8'))).scope;
    if ((await realpath(proof.root)) !== proof.root)
      throw new Error('Platform cgroup scope contains a symlink.');
    for (const [path, inode] of [
      [proof.root, proof.rootInode],
      [join(proof.root, 'pods'), proof.podsInode],
      [join(proof.root, 'pods/kubepods'), proof.kubepodsInode],
    ] as const) {
      const info = await stat(path);
      if (info.ino !== inode || info.dev !== proof.device)
        throw new Error('Platform cgroup scope incarnation changed.');
    }
    return proof;
  }
  async observe(podUid: string): Promise<PhysicalEvidence | undefined> {
    if (!/^[a-f0-9-]{36}$/.test(podUid)) throw new Error('Platform Pod UID is invalid.');
    const scope = await this.#scope();
    const found: PhysicalEvidence[] = [];
    for (const qos of ['', 'burstable', 'besteffort']) {
      const path = join(scope.root, 'pods/kubepods', qos, `pod${podUid}`);
      try {
        const info = await stat(path);
        if (!info.isDirectory() || info.dev !== scope.device || (await realpath(path)) !== path)
          throw new Error('Pod cgroup identity is invalid.');
        found.push({ scope, podUid, path, inode: info.ino, device: info.dev });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    if (found.length > 1) throw new Error('Pod UID has multiple physical cgroups.');
    return found[0];
  }
  async exited(evidence: PhysicalEvidence): Promise<boolean> {
    const scope = await this.#scope();
    if (JSON.stringify(scope) !== JSON.stringify(evidence.scope))
      throw new Error('Physical scope proof changed after observation.');
    const current = await this.observe(evidence.podUid);
    if (current === undefined) return true;
    if (current.inode !== evidence.inode || current.device !== evidence.device)
      throw new Error('Observed Pod cgroup inode was replaced.');
    const events = await readFile(join(current.path, 'cgroup.events'), 'utf8');
    return /^populated 0$/m.test(events);
  }
  async retiredHelper(podUid: string): Promise<RetiredHelperEvidence> {
    if (!/^[a-f0-9-]{36}$/.test(podUid)) throw new Error('Retired helper Pod UID is invalid.');
    const before = await this.#scope();
    const current = await this.observe(podUid);
    if (current && !(await this.exited(current)))
      throw new Error('The retired helper still has processes.');
    const after = await this.#scope();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('Physical scope changed during retired helper verification.');
    return {
      scope: before,
      podUid,
      candidatePaths: ['', 'burstable', 'besteffort'].map((qos) =>
        join(before.root, 'pods/kubepods', qos, `pod${podUid}`),
      ),
      kind: 'retired_helper_no_processes',
    };
  }
}
