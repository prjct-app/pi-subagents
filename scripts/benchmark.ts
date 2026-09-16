import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { inProcessRunner } from '../src/in-process.ts';
import { spawnRunner, type RunnerEvent } from '../src/runner.ts';
import { prepareSession } from '../src/storage.ts';
import { newJobId, type Job } from '../src/schema.ts';

const directory = await mkdtemp(join(tmpdir(), 'agents-benchmark-'));
const prior = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const guard = fileURLToPath(new URL('../src/child.ts', import.meta.url));
const provider = fileURLToPath(new URL('../tests/fixtures/mock-provider.ts', import.meta.url));
const samples: object[] = [];
try {
  for (const backend of ['process', 'in-process'] as const) {
    for (const iteration of [1, 2, 3]) {
      const observations = { pid: 0, childRss: 0, parentRss: process.memoryUsage().rss, runningAt: 0, settledAt: 0, sampling: false };
      const started = performance.now();
      const events: RunnerEvent[] = [];
      const sample = () => {
        observations.parentRss = Math.max(observations.parentRss, process.memoryUsage().rss);
        if (!observations.pid || observations.sampling) return;
        observations.sampling = true;
        execFile('ps', ['-o', 'rss=', '-p', String(observations.pid)], (_error, stdout) => {
          observations.childRss = Math.max(observations.childRss, (Number(stdout.trim()) || 0) * 1024);
          observations.sampling = false;
        });
      };
      const timer = setInterval(sample, 25);
      const runner = (backend === 'process' ? spawnRunner : inProcessRunner)({ guardPath: guard, extensionPaths: [provider], verifyCapabilities: true,
        invoke: args => ({ command: process.execPath, args: [cli, ...args] }),
        spawnProcess: ((...args: Parameters<typeof spawn>) => { const child = spawn(...args); observations.pid = child.pid ?? 0; return child; }) as typeof spawn,
        prepare: job => prepareSession(job, join(directory, 'sessions')) });
      const job: Job = { id: newJobId(), role: 'reviewer', name: 'Ada', subject: 'benchmark', task: 'Return a report.', context: '', provider: 'subagents-fixture', modelId: 'offline', cwd: directory, tools: ['read'], depth: 0, admitted: Date.now(), state: 'starting' };
      const handle = await runner(job, event => {
        events.push(event);
        if (event.type === 'running') observations.runningAt = performance.now();
        if (event.type === 'settled' || event.type === 'failed') observations.settledAt = performance.now();
        sample();
      });
      try {
        const deadline = Date.now() + 20000;
        while (!observations.settledAt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        const failure = events.find(event => event.type === 'failed');
        if (failure || !observations.settledAt) throw new Error(JSON.stringify(failure ?? 'timed out'));
        samples.push({ backend, iteration, startupMs: +(observations.runningAt - started).toFixed(1), reportMs: +(observations.settledAt - started).toFixed(1), parentPeakRssMiB: +(observations.parentRss / 1048576).toFixed(1), childPeakRssMiB: +(observations.childRss / 1048576).toFixed(1) });
      } finally { clearInterval(timer); await handle.stop('benchmark finished'); }
    }
  }
  const result = { node: process.version, platform: process.platform, note: 'Offline provider; parent RSS includes SDK and retained module caches. Sequential samples, not a controlled cross-product benchmark. Child RSS sampled every 25ms; zero means no child process.', samples };
  await mkdir('build', { recursive: true }); await writeFile('build/benchmark.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
  await rm(directory, { recursive: true, force: true });
}
