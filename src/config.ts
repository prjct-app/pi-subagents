import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_LIMITS, type Limits } from './manager.ts';
import { READ_ONLY_TOOLS, type Role } from './schema.ts';

export type Settings = { runner: 'process' | 'in-process'; retentionDays: number; workspaceRetentionHours: number; artifactPolicy: 'none' | 'requested'; extensionPackages: string[]; limits: Limits };
export const agentHome = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
/** Package-owned state stays outside both Pi's resource tree and client repositories. */
export const prjctHome = (): string => process.env.PRJCT_HOME ?? join(homedir(), '.prjct');
export const defaultSettings = (): Settings => ({ runner: 'process', retentionDays: 7, workspaceRetentionHours: 24, artifactPolicy: 'requested', extensionPackages: [], limits: { ...DEFAULT_LIMITS } });

/** Invalid fields do not erase a valid value from the lower configuration layer. */
export function loadSettings(cwd: string, home = agentHome(), warn: (text: string) => void = console.warn): Settings {
  return [join(home, 'prjct-subagents.json'), join(cwd, '.pi', 'prjct-subagents.json')].reduce((settings, file) => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object');
      const next = { ...settings, limits: { ...settings.limits } };
      for (const [key, value] of Object.entries(raw)) {
        if (key === 'runner' && (value === 'process' || value === 'in-process')) next.runner = value;
        else if (key === 'retentionDays' && Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 365) next.retentionDays = Number(value);
        else if (key === 'workspaceRetentionHours' && Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 720) next.workspaceRetentionHours = Number(value);
        else if (key === 'artifactPolicy' && (value === 'none' || value === 'requested')) next.artifactPolicy = value;
        else if (key === 'extensionPackages' && Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim())) next.extensionPackages = [...new Set(value)];
        else if (key === 'limits' && value && typeof value === 'object' && !Array.isArray(value)) {
          const maxima: Limits = { concurrency: 16, jobs: 256, depth: 8, descendants: 64, taskBytes: 48 * 1024, timeoutMs: 24 * 60 * 60_000 };
          for (const [name, number] of Object.entries(value)) {
            if (name in maxima && Number.isInteger(number) && number > 0 && number <= maxima[name as keyof Limits]) next.limits[name as keyof Limits] = number;
            else warn(`${file}: invalid limits.${name}; keeping the previous value.`);
          }
        } else warn(`${file}: invalid ${key}; keeping the previous value.`);
      }
      return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`${file}: ${String(error)}`);
      return settings;
    }
  }, defaultSettings());
}

const CORE_TOOLS = new Set<string>([...READ_ONLY_TOOLS, 'edit', 'write', 'bash']);

/**
 * A child starts with --no-extensions, so a third-party tool it did not load
 * is missing and fails the startup capability handshake. Only packages named
 * in extensionPackages bring their tools along.
 */
export function roleTools(role: Role, active: readonly string[], allowBash = process.env.PI_SUBAGENTS_ALLOW_BASH === '1', allowExtensionTools = false): string[] {
  const tools = active.filter(name => !name.startsWith('agent_') && !name.startsWith('subagent_'))
    .filter(name => allowExtensionTools || CORE_TOOLS.has(name));
  if (role !== 'worker') return tools.filter(name => (READ_ONLY_TOOLS as readonly string[]).includes(name));
  return tools.filter(name => name !== 'bash' || (allowBash && (tools.includes('edit') || tools.includes('write'))));
}

/** Only already-installed, explicitly named packages are resolved; no installation or ambient discovery. */
export function extensionPaths(packages: readonly string[], cwd: string, home = agentHome()): string[] {
  return packages.flatMap(name => {
    const candidates = [cwd, home, join(home, 'npm'), process.cwd()];
    const manifests = candidates.flatMap(base => {
      const require = createRequire(join(base, '__subagents__.cjs'));
      return (require.resolve.paths(name) ?? []).map(path => join(path, name, 'package.json'));
    });
    const manifest = manifests.find(path => {
      try { return JSON.parse(readFileSync(path, 'utf8')).name === name; } catch { return false; }
    });
    if (!manifest) throw new Error(`Child extension package ${name} is not installed.`);
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    const entries = pkg.pi?.extensions;
    if (!Array.isArray(entries) || !entries.every((v: unknown) => typeof v === 'string')) throw new Error(`${name} must declare pi.extensions.`);
    return entries.map((entry: string) => isAbsolute(entry) ? entry : resolve(dirname(manifest), entry));
  });
}
