import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { workspaceRoot } from './storage.ts';

const exec = promisify(execFile);
const owner = 'prjct-subagents-workspace-v1';

export type ExternalWorkspace = { sourceCwd: string; cwd: string; workspace: string; patchFile: string };

const safePath = (root: string, path: string): string => {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`Unsafe repository path: ${path}`);
  return absolute;
};

async function copyEntry(sourceRoot: string, targetRoot: string, path: string): Promise<void> {
  const source = safePath(sourceRoot, path);
  const target = safePath(targetRoot, path);
  const info = await lstat(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (info.isSymbolicLink()) { await symlink(await readlink(source), target); return; }
  if (info.isFile()) await copyFile(source, target);
}

/** Create a writable, package-owned snapshot without touching the client's .git metadata. */
export async function createExternalWorkspace(source: string, root = workspaceRoot()): Promise<ExternalWorkspace> {
  const sourceCwd = await realpath(source);
  const project = createHash('sha256').update(sourceCwd).digest('hex').slice(0, 24);
  const projectRoot = join(root, project);
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(projectRoot, 'job-'));
  const cwd = join(workspace, 'repository');
  const patchFile = join(workspace, 'changes.patch');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const listed = await exec('git', ['-C', sourceCwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 32 * 1024 * 1024 })
    .catch(() => { throw new Error('An isolated implementer or documenter requires a Git working tree.'); });
  const paths = listed.stdout.split('\0').filter(Boolean);
  await paths.reduce<Promise<void>>((previous, path) => previous.then(() => copyEntry(sourceCwd, cwd, path)), Promise.resolve());
  await exec('git', ['init', '--quiet'], { cwd });
  await exec('git', ['add', '--all'], { cwd });
  await exec('git', ['-c', 'user.name=prjct.app', '-c', 'user.email=noreply@prjct.app', 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'External workspace baseline'], { cwd });
  await writeFile(join(workspace, 'owner.json'), JSON.stringify({ owner, sourceCwd, pid: process.pid, state: 'running', at: Date.now() }), { mode: 0o600 });
  return { sourceCwd, cwd, workspace, patchFile };
}

/** Materialize the reviewable change set. New files are included without staging their content. */
export async function finalizeExternalWorkspace(input: ExternalWorkspace | { cwd: string; patchFile: string }): Promise<string> {
  await exec('git', ['add', '--intent-to-add', '--all'], { cwd: input.cwd }).catch(() => undefined);
  const diff = await exec('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: input.cwd, maxBuffer: 32 * 1024 * 1024 });
  await writeFile(input.patchFile, diff.stdout, { mode: 0o600 });
  const manifest = join(dirname(input.cwd), 'owner.json');
  const previous = JSON.parse(await readFile(manifest, 'utf8').catch(() => '{}'));
  await writeFile(manifest, JSON.stringify({ ...previous, owner, state: 'settled', at: Date.now() }), { mode: 0o600 });
  return input.patchFile;
}

/** Remove only package-owned settled workspaces, or abandoned ones whose process is gone. */
export async function cleanupExternalWorkspaces(root = workspaceRoot(), hours = 24, now = Date.now()): Promise<void> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter(entry => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))) {
    const directory = join(root, project.name);
    const workspaces = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of workspaces.filter(item => item.isDirectory() && /^job-[A-Za-z0-9]+$/.test(item.name))) {
      const path = join(directory, entry.name);
      try {
        const data = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
        if (data.owner !== owner || !Number.isFinite(data.at) || now - data.at <= hours * 3_600_000) continue;
        if (data.state === 'running') {
          try { process.kill(data.pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        }
        await rm(path, { recursive: true, force: true });
      } catch { /* A malformed or unrelated directory is never permission to remove it. */ }
    }
  }
}

export async function discardExternalWorkspace(workspace: ExternalWorkspace): Promise<void> {
  await rm(workspace.workspace, { recursive: true, force: true });
}

export const workspaceProjectId = (source: string): string => createHash('sha256').update(resolve(source)).digest('hex').slice(0, 24);
