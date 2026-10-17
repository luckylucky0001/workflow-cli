import { main } from './main';

// `workctl ... | head` closes stdout early; that is not an error for a CLI.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw e;
});

main().catch((e) => {
  process.stderr.write(`workctl: unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 1;
});
