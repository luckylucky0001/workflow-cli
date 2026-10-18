// Child-process driver for cli-lifetime.test.ts: runs the real CLI entry flow (main + finishCli)
// over a registry with slow synthetic capabilities.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { finishCli, main } from '../../src/cli/main';
import { defineCapability, defineDomain } from '../../src/core/registry';
import { testRegistry } from './helpers';

const marker = process.env.SLOW_MARKER!;
const slow = (operation: 'read' | 'execute') =>
  defineCapability({
    name: `slowtest.${operation}`,
    command: `slowtest ${operation}`,
    summary: 'sleeps beyond the budget',
    domain: 'slowtest',
    output: z.object({}),
    adapter: 'fake',
    operation,
    auth_provider: 'none',
    guide: 'docs/x.md',
    handler: () => new Promise((r) => setTimeout(() => { writeFileSync(marker, 'done'); r({ data: {} }); }, 6000)),
  });
const reg = testRegistry();
reg.addDomain(defineDomain({ name: 'slowtest', title: 'S', summary: 's', pillar: 'supporting', guide: 'docs/x.md', capabilities: [slow('read'), slow('execute')] }));
main(['node', 'workctl', ...process.argv.slice(2)], reg).then(finishCli);
