import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { prjctHome } from './config.ts';
import { isTerminal, type Job } from './schema.ts';

export const storageRoot = (home = prjctHome()): string => join(home, 'subagents', 'state');
export const workspaceRoot = (home = prjctHome()): string => join(home, 'subagents', 'workspaces');
export const artifactRoot = (home = prjctHome()): string => join(home, 'subagents', 'artifacts');
const owner = 'prjct-subagents-v2';
export const sessionRoot = (session: string, root = storageRoot()): string => join(root, createHash('sha256').update(session).digest('hex').slice(0, 24));

export async function prepareSession(job: Job, directory: string): Promise<string> {
  const dir = join(directory, job.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const manager = job.resumeSession
    ? SessionManager.forkFrom(job.resumeSession, job.cwd, dir)
    : SessionManager.create(job.cwd, dir);
  const file = manager.getSessionFile();
  if (!file) throw new Error('Could not create a retained child session.');
  await writeFile(join(dir, 'owner.json'), JSON.stringify({ owner, pid: process.pid, state: 'running', at: Date.now() }), { mode: 0o600 });
  return file;
}

export async function retainSettlement(job: Job, directory: string): Promise<void> {
  if (!isTerminal(job.state)) return;
  const dir = join(directory, job.id);
  const manifest = join(dir, 'owner.json');
  if (!(await stat(manifest).catch(() => undefined))) return;
  const temp = join(dir, 'owner.json.tmp');
  await writeFile(temp, JSON.stringify({ owner, pid: process.pid, state: job.state, at: job.settled ?? Date.now() }), { mode: 0o600 });
  await rename(temp, manifest);
}

/** Cleanup traverses only our manifests; symlink directories and legacy sessions are never followed. */
export async function cleanupStorage(root: string, days: number, now = Date.now()): Promise<void> {
  const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const session of sessions.filter(entry => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))) {
    const dir = join(root, session.name);
    const jobs = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of jobs.filter(item => item.isDirectory() && /^j_[a-f0-9]{32}$/.test(item.name))) {
      const jobDir = join(dir, entry.name);
      try {
        const data = JSON.parse(await readFile(join(jobDir, 'owner.json'), 'utf8'));
        if (data.owner !== owner || !Number.isFinite(data.at) || now - data.at <= days * 86_400_000) continue;
        if (!isTerminal(data.state)) {
          try { process.kill(data.pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        }
        await rm(jobDir, { recursive: true, force: true });
      } catch { /* Incomplete or unrelated manifests are not permission to delete. */ }
    }
    // A tree's wire is owned by its root job; remove it only once all work has expired.
    const remaining = await readdir(dir, { withFileTypes: true });
    if (!remaining.some(entry => entry.isDirectory())) {
      for (const entry of remaining.filter(item => item.isFile() && /^agent-j_[a-f0-9]{32}\.wire\.jsonl$/.test(item.name))) await rm(join(dir, entry.name), { force: true });
    }
  }
}

export async function resumable(job: Job, days: number, now = Date.now()): Promise<string> {
  if (!isTerminal(job.state)) throw new Error('This agent is still active; send a message instead.');
  if (!job.sessionFile || !job.settled || now - job.settled > days * 86_400_000) throw new Error('This conversation expired or was never retained. Delegate a new task instead.');
  const file = resolve(job.sessionFile);
  if (!(await stat(file).catch(() => undefined))?.isFile()) throw new Error('The retained conversation is unavailable. Delegate a new task instead.');
  return file;
}
