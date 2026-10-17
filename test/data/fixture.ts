import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { invoke } from '../../src/core/engine';
import type { Envelope } from '../../src/core/output';
import { Registry } from '../../src/core/registry';
import dataDomain from '../../src/domains/data';

export const REPO = resolve(__dirname, '../..');

export const DAILY_SQL = `-- aggregate one business date
WITH base AS (
  SELECT status, amount, customer_id FROM ods_orders WHERE status <> 'x from y'
)
SELECT CAST('\${business_date}' AS DATE) AS order_date, status, COUNT(*) AS order_count,
       EXTRACT(YEAR FROM CURRENT_DATE) AS y
FROM base
GROUP BY status
`;

export interface Fixture {
  root: string;
  config: string;
  warehouse: string;
  stateDir: string;
  call: (cap: string, inputs: Record<string, unknown>) => Promise<Envelope>;
  writePartition: (table: string, dt: string, rows: (Record<string, unknown> | string)[], opts?: { success?: boolean; crc?: boolean; format?: 'json' | 'csv'; mtime?: Date; file?: string }) => string;
  cleanup: () => void;
}

/** Temp workspace: copies the demo catalog metadata and rulesets, writes its own SQL and config. */
export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'workctl-data-'));
  const demo = join(root, 'demo');
  mkdirSync(join(demo, 'offline-workflows', 'sql'), { recursive: true });
  cpSync(join(REPO, 'demo', 'catalog'), join(demo, 'catalog'), { recursive: true });
  cpSync(join(REPO, 'demo', 'quality-rules'), join(demo, 'quality-rules'), { recursive: true });
  writeFileSync(join(demo, 'offline-workflows', 'sql', 'daily_orders.sql'), DAILY_SQL);
  const warehouse = join(root, 'warehouse');
  mkdirSync(warehouse, { recursive: true });
  const stateDir = join(root, 'state');
  const config = join(root, 'workctl.yaml');
  writeFileSync(
    config,
    [
      'schema_version: "1.0"',
      'current_profile: t',
      'profiles:',
      '  t:',
      '    env: test',
      `    state_dir: ${stateDir}`,
      '    defaults: { catalog: demo }',
      '    endpoints:',
      '      catalog:',
      '        demo:',
      '          provider: file',
      `          metadata_dir: ${join(demo, 'catalog')}`,
      `          warehouse_root: ${warehouse}`,
      '          storage: local-filesystem',
      '',
    ].join('\n'),
  );
  const registry = new Registry();
  registry.addDomain(dataDomain);
  process.env.WORKCTL_VALIDATE_OUTPUT = '1';
  const locations: Record<string, string> = { 'ods.orders': 'ods/orders', 'analytics.daily_orders': 'analytics/daily_orders', 'report.daily_summary': 'report/daily_summary' };
  return {
    root,
    config,
    warehouse,
    stateDir,
    call: (cap, inputs) => invoke(registry, cap, inputs, { configPath: config }),
    writePartition: (table, dt, rows, opts = {}) => {
      const dir = join(warehouse, locations[table] ?? table.replace('.', '/'), `dt=${dt}`);
      mkdirSync(dir, { recursive: true });
      const fmt = opts.format ?? 'json';
      const name = opts.file ?? `part-00000-abc-c000.${fmt}`;
      let body: string;
      if (fmt === 'csv') {
        const objs = rows as Record<string, unknown>[];
        const cols = Object.keys(objs[0] ?? {});
        body = [cols.join(','), ...objs.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(','))].join('\n') + '\n';
      } else {
        body = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + (rows.length ? '\n' : '');
      }
      writeFileSync(join(dir, name), body);
      if (opts.crc !== false) writeFileSync(join(dir, `.${name}.crc`), 'crc');
      if (opts.success !== false) writeFileSync(join(dir, '_SUCCESS'), '');
      if (opts.mtime) {
        utimesSync(join(dir, name), opts.mtime, opts.mtime);
        if (opts.success !== false) utimesSync(join(dir, '_SUCCESS'), opts.mtime, opts.mtime);
      }
      return dir;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];

export function dailyRows(date: string): Record<string, unknown>[] {
  return STATUSES.map((s, i) => ({ order_date: date, status: s, order_count: 10 + i, total_amount: 1000.5 + i, avg_amount: 100.05, customer_count: 9 + i }));
}

export function odsRows(date: string, n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => {
    const sec = Math.floor((i * 86399) / Math.max(1, n));
    const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return {
      order_id: 1000 + i,
      customer_id: 1 + (i % 50),
      status: STATUSES[i % STATUSES.length],
      amount: 10 + i,
      item_count: 1 + (i % 6),
      created_at: `${date}T${hh}:${mm}:${ss}+08:00`,
      updated_at: `${date}T${hh}:${mm}:${ss}+08:00`,
    };
  });
}

export function schemaWarnings(env: Envelope): string[] {
  return env.meta.warnings.filter((w) => w.startsWith('输出与 schema 不一致'));
}
