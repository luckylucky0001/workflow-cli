// Bundle the sample service (and its mysql2 / ioredis dependencies from the repo's
// node_modules) into a single file, so the Docker image needs no `npm install`.
//   node demo/sample-service/build.mjs        (from the repository root)
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, 'src/server.ts')],
  outfile: join(here, 'dist/server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`built ${join(here, 'dist/server.cjs')}`);
