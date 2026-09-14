import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Pi discovers exactly the resources declared by the package manifest', async () => {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), 'pi-package-discovery-')));
  try {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [root] }));
    const loader = new DefaultResourceLoader({ cwd: agentDir, agentDir, noContextFiles: true });
    await loader.reload();

    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    assert.equal(extensions.extensions.length, 1);
    assert.equal(resolve(extensions.extensions[0].path), resolve(root, 'index.ts'));
    assert.deepEqual(loader.getPrompts().prompts, []);
    assert.deepEqual(loader.getThemes().themes, []);

    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const packageSkills = loader.getSkills().skills.filter((skill) => skill.filePath.startsWith(root));
    assert.equal(packageSkills.length, manifest.pi.skills ? 3 : 0);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
