// Run a representative command per capability against the live demo environment and
// record real results (status, error code, sources, versions, duration) as evidence of
// "隔离环境验证". Writes demo/verification/report.md and raw envelopes.
// Usage: npm run build && WORKCTL_CONFIG=demo/environment/workctl.yaml node scripts/verify-demo.mjs [cases.json]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cases = JSON.parse(readFileSync(process.argv[2] ?? 'demo/verification/cases.json', 'utf8'));
const outDir = 'demo/verification/envelopes';
mkdirSync(outDir, { recursive: true });
const rows = [];
for (const c of cases) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['dist/workctl.js', '--json', ...c.args], { encoding: 'utf8', timeout: (c.timeout_s ?? 120) * 1000 });
  let env = null;
  try {
    env = JSON.parse(r.stdout);
  } catch {
    /* non-JSON */
  }
  const file = join(outDir, `${c.id}.json`);
  writeFileSync(file, r.stdout || r.stderr);
  const expect = c.expect ?? 'success';
  const actual = env ? (env.status === 'error' ? env.error.code : env.status) : `exit ${r.status}`;
  const ok = Array.isArray(expect) ? expect.includes(actual) : expect === actual;
  rows.push({
    id: c.id,
    command: `workctl ${c.args.join(' ')}`,
    expect: Array.isArray(expect) ? expect.join('/') : expect,
    actual,
    ok,
    exit: r.status,
    ms: Date.now() - t0,
    sources: env?.meta?.sources?.map((s) => `${s.system}${s.version ? `@${s.version}` : ''}`).filter((v, i, a) => a.indexOf(v) === i).join(', ') ?? '',
    note: c.note ?? '',
  });
  process.stderr.write(`${ok ? 'ok  ' : 'FAIL'} ${c.id} -> ${actual} (${Date.now() - t0}ms)\n`);
}
const lines = [
  '# 隔离演示环境验证记录',
  '',
  `> 由 \`node scripts/verify-demo.mjs\` 生成于 ${new Date().toISOString()}；原始结果信封见 \`demo/verification/envelopes/\`。全部为合成数据。`,
  '',
  `通过 ${rows.filter((r) => r.ok).length} / ${rows.length}`,
  '',
  '| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} ${r.id} | \`${r.command.replace(/\|/g, '\\|')}\` | ${r.expect} | ${r.actual} | ${r.exit} | ${r.ms} | ${r.sources} | ${r.note} |`),
];
writeFileSync('demo/verification/report.md', lines.join('\n') + '\n');
console.log(`passed ${rows.filter((r) => r.ok).length}/${rows.length}`);
process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
