// Regression: after a TIMEOUT envelope the CLI process stayed alive until the abandoned handler
// finished (slow upstream). Non-execute calls must exit right after the envelope is written;
// an in-flight execute is never cut short.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir, writeConfig } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const viteNode = join(root, 'node_modules/.bin/vite-node');

function run(cap: string) {
  const dir = tempDir();
  const cfg = writeConfig(dir, { allow_execute: true });
  const marker = join(dir, 'marker');
  const t0 = Date.now();
  const r = spawnSync(viteNode, [join(here, 'cli-timeout-driver.ts'), '--', 'slowtest', cap, '--json', '--timeout', '1s', '--config', cfg], {
    cwd: root,
    env: { ...process.env, SLOW_MARKER: marker, WORKCTL_HOME: dir },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { r, elapsed: Date.now() - t0, finished: existsSync(marker) };
}

describe('CLI lifetime after TIMEOUT', () => {
  it('a timed-out read exits promptly after writing the envelope', () => {
    const { r, finished } = run('read');
    const env = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(env.error.code).toBe('TIMEOUT');
    expect(r.status).not.toBe(0);
    expect(finished).toBe(false); // exited before the 6s handler completed
  }, 40_000);

  it('a timed-out execute is not aborted: the handler still runs to completion', () => {
    const { r, finished } = run('execute');
    const env = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(env.error.code).toBe('TIMEOUT');
    expect(finished).toBe(true);
  }, 40_000);
});
