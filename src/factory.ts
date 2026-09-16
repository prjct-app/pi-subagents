import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { ROLES, type Role } from './schema.ts';

export const FACTORY_AGENTS = [
  'product-discovery',
  'specification-architect',
  'bug-triager',
  'implementer',
  'quality-reviewer',
  'delivery-engineer',
  'product-documenter',
] as const;
export type FactoryAgentName = (typeof FACTORY_AGENTS)[number];

export type FactoryAgent = {
  name: FactoryAgentName;
  description: string;
  role: Role;
  workspace: 'source' | 'isolated';
  skills: string[];
  explicitOnly: boolean;
  instructions: string;
};

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  role?: unknown;
  workspace?: unknown;
  skills?: unknown;
  explicitOnly?: unknown;
};
type SkillFrontmatter = { name?: unknown; description?: unknown };

export const factoryRoot = (): string => fileURLToPath(new URL('../factory/', import.meta.url));
const list = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
  .filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);

export function loadFactoryAgent(name: string, root = factoryRoot()): FactoryAgent {
  if (!(FACTORY_AGENTS as readonly string[]).includes(name)) throw new Error(`Unknown factory agent "${name}". Available: ${FACTORY_AGENTS.join(', ')}.`);
  const raw = readFileSync(join(root, 'agents', `${name}.md`), 'utf8');
  const parsed = parseFrontmatter<AgentFrontmatter>(raw);
  const role = parsed.frontmatter.role;
  const workspace = parsed.frontmatter.workspace;
  const skills = list(parsed.frontmatter.skills);
  if (parsed.frontmatter.name !== name || typeof parsed.frontmatter.description !== 'string'
    || !(ROLES as readonly unknown[]).includes(role) || (workspace !== 'source' && workspace !== 'isolated') || skills.length === 0) {
    throw new Error(`Invalid factory agent definition: ${name}.`);
  }
  const skillText = skills.map(skill => {
    if (!/^[a-z0-9-]+$/.test(skill)) throw new Error(`Invalid skill name "${skill}" in ${name}.`);
    const loaded = parseFrontmatter<SkillFrontmatter>(readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8'));
    if (loaded.frontmatter.name !== skill || typeof loaded.frontmatter.description !== 'string') throw new Error(`Invalid factory skill definition: ${skill}.`);
    return `### ${skill}\n\n${loaded.body.trim()}`;
  }).join('\n\n');
  return {
    name: name as FactoryAgentName,
    description: parsed.frontmatter.description,
    role: role as Role,
    workspace,
    skills,
    explicitOnly: parsed.frontmatter.explicitOnly === true,
    instructions: [`## Factory profile: ${name}`, parsed.body.trim(), '## Assigned playbooks', skillText].join('\n\n'),
  };
}

const cache = new Map<FactoryAgentName, FactoryAgent>();
export function factoryAgent(name: string): FactoryAgent {
  const known = cache.get(name as FactoryAgentName);
  if (known) return known;
  const loaded = loadFactoryAgent(name);
  cache.set(loaded.name, loaded);
  return loaded;
}

export const factoryCatalogue = (): string => FACTORY_AGENTS.map(name => {
  const profile = factoryAgent(name);
  return `${profile.name}: ${profile.description}${profile.explicitOnly ? ' Invoke only after an explicit user request.' : ''}`;
}).join('\n');
