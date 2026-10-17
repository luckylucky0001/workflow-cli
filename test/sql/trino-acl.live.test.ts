import { describe, expect, it } from 'vitest';

// Database-side boundary for the demo Trino (demo/environment/trino/rules.json): the account workctl
// uses is read-only even if a statement got past workctl's own guard. Talks to Trino directly on purpose.
const URL = process.env.WORKCTL_TRINO_URL ?? 'http://127.0.0.1:18085';

async function run(user: string, sql: string): Promise<{ state: string; error?: string }> {
  let r: any = await (await fetch(`${URL}/v1/statement`, { method: 'POST', body: sql, headers: { 'X-Trino-User': user } })).json();
  while (r.nextUri) {
    await new Promise((res) => setTimeout(res, 200));
    r = await (await fetch(r.nextUri)).json();
  }
  return { state: r.stats.state, error: r.error?.errorName };
}

describe.skipIf(process.env.WORKCTL_IT !== '1')('trino access control (live)', () => {
  it('lets the workctl account read', async () => {
    expect((await run('workctl', 'SELECT count(*) FROM tpch.tiny.nation')).state).toBe('FINISHED');
  });

  it('denies writes for the workctl account at the database layer', async () => {
    const r = await run('workctl', 'CREATE TABLE memory.default.workctl_acl_probe AS SELECT 1 AS x');
    expect(r.state).toBe('FAILED');
    expect(r.error).toBe('PERMISSION_DENIED');
  });
});
