#!/usr/bin/env node
// Build the demo-mq plugin package:
//   dist/plugin.mjs            single esbuild bundle (kafkajs + zod inlined), run by core as `node dist/plugin.mjs`
//   schemas/*.json             JSON Schema of each capability's data (z.toJSONSchema)
//   dist/package/              staging dir = package root
//   dist/demo-mq-plugin.tgz    installable package (workctl plugin install <tgz>)
// Usage (from repo root): node plugins/demo-mq/build.mjs
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const src = join(here, 'src');
const distDir = join(here, 'dist');
const tmpDir = join(here, '.build');
const stage = join(distDir, 'package');
const tgz = join(distDir, 'demo-mq-plugin.tgz');

const banner = "import { createRequire as __workctlCreateRequire } from 'node:module'; const require = __workctlCreateRequire(import.meta.url);";

rmSync(distDir, { recursive: true, force: true });
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

// 1. plugin entry bundle
await build({
  entryPoints: [join(src, 'plugin.ts')],
  outfile: join(distDir, 'plugin.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: `#!/usr/bin/env node\n${banner}` },
  legalComments: 'none',
  logLevel: 'warning',
});

// 2. manifest + schemas, evaluated from the same TS sources
const infoFile = join(tmpDir, 'build-info.mjs');
await build({
  stdin: {
    contents: "export { buildManifest, CAPABILITIES } from './manifest'; export { outputJsonSchemas } from './schemas'; export { HANDLERS } from './capabilities';",
    resolveDir: src,
    loader: 'ts',
  },
  outfile: infoFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: banner },
  logLevel: 'warning',
});
const info = await import(pathToFileURL(infoFile).href);
const manifest = info.buildManifest();
const schemas = info.outputJsonSchemas();

const problems = [];
const schemaDir = join(here, 'schemas');
rmSync(schemaDir, { recursive: true, force: true });
mkdirSync(schemaDir, { recursive: true });
for (const cap of info.CAPABILITIES) {
  const handled = Object.hasOwn(info.HANDLERS, cap.name);
  if (cap.status === 'available' && !handled) problems.push(`${cap.name} 是 available 但没有 handler`);
  if (cap.status === 'planned' && handled) problems.push(`${cap.name} 是 planned 但有 handler`);
  if (!cap.output_schema) {
    if (cap.status === 'available') problems.push(`${cap.name} 缺少 output_schema`);
    continue;
  }
  const schema = schemas[cap.name];
  if (!schema) {
    problems.push(`${cap.name} 没有对应的 zod 输出 schema`);
    continue;
  }
  const major = cap.capability_version.split('.')[0];
  const expected = `schemas/${cap.name}.v${major}.json`;
  if (cap.output_schema !== expected) problems.push(`${cap.name} output_schema 应为 ${expected}`);
  writeFileSync(join(here, cap.output_schema), `${JSON.stringify({ $id: `${manifest.name}/${cap.name}.v${major}`, title: `${cap.name} data`, ...schema }, null, 2)}\n`);
}
const skillSrc = join(repoRoot, 'skills', 'mq-operations', 'SKILL.md');
for (const f of [join(here, 'guides', 'mq.md'), join(here, 'README.md'), skillSrc]) {
  if (!existsSync(f)) problems.push(`缺少文件 ${f}`);
}
if (problems.length) {
  console.error(`构建失败:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// 3. staging dir = package root
mkdirSync(join(stage, 'dist'), { recursive: true });
mkdirSync(join(stage, 'schemas'), { recursive: true });
mkdirSync(join(stage, 'guides'), { recursive: true });
mkdirSync(join(stage, 'skills', 'mq-operations'), { recursive: true });
writeFileSync(join(stage, 'workctl-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(distDir, 'plugin.mjs'), join(stage, 'dist', 'plugin.mjs'));
for (const cap of info.CAPABILITIES) if (cap.output_schema) copyFileSync(join(here, cap.output_schema), join(stage, cap.output_schema));
copyFileSync(join(here, 'guides', 'mq.md'), join(stage, 'guides', 'mq.md'));
copyFileSync(skillSrc, join(stage, 'skills', 'mq-operations', 'SKILL.md'));
copyFileSync(join(here, 'README.md'), join(stage, 'README.md'));

// 4. tgz whose root holds workctl-plugin.json, dist/, schemas/, guides/, skills/, README.md
execFileSync('tar', ['-czf', tgz, '-C', stage, 'workctl-plugin.json', 'dist', 'schemas', 'guides', 'skills', 'README.md']);
rmSync(tmpDir, { recursive: true, force: true });

const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex');
const kb = (f) => `${(statSync(f).size / 1024).toFixed(1)} KiB`;
console.log(`plugin ${manifest.name}@${manifest.version} (${manifest.backend_mode})`);
console.log(`  entry   ${join(distDir, 'plugin.mjs')} ${kb(join(distDir, 'plugin.mjs'))}`);
console.log(`  schemas ${Object.keys(schemas).length} -> ${schemaDir}`);
console.log(`  package ${tgz} ${kb(tgz)} sha256=${sha}`);
