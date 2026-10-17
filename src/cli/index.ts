import { main } from './main';

main().catch((e) => {
  process.stderr.write(`workctl: unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 1;
});
