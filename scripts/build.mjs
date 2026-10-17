// Bundle the CLI and the programmatic API into self-contained ESM files (npm distribution).
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'linked',
  logLevel: 'warning',
  define: { __WORKCTL_VERSION__: JSON.stringify(pkg.version) },
  // mysql2/ioredis use CommonJS internals; provide require() inside the ESM bundle.
  banner: { js: "import { createRequire as __wcCreateRequire } from 'node:module'; const require = __wcCreateRequire(import.meta.url);" },
};

await build({ ...common, entryPoints: ['src/cli/index.ts'], outfile: 'dist/workctl.js', banner: { js: `#!/usr/bin/env node\n${common.banner.js}` } });
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
chmodSync('dist/workctl.js', 0o755);
console.log('built dist/workctl.js, dist/index.js');
