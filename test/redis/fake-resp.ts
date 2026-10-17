import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export type Reply = string | number | null | Error | Reply[] | { simple: string };

function encode(r: Reply): string {
  if (r === null) return '$-1\r\n';
  if (r instanceof Error) return `-${r.message}\r\n`;
  if (typeof r === 'number') return `:${r}\r\n`;
  if (typeof r === 'string') return `$${Buffer.byteLength(r)}\r\n${r}\r\n`;
  if (Array.isArray(r)) return `*${r.length}\r\n${r.map(encode).join('')}`;
  return `+${r.simple}\r\n`;
}

/** Minimal RESP2 server for unit tests: `handler(args)` returns the reply for one command. */
export async function fakeRedis(handler: (args: string[]) => Reply): Promise<{ port: number; close: () => Promise<void>; commands: string[][] }> {
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  const srv = createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const parsed = parse(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.used);
        commands.push(parsed.args);
        const name = parsed.args[0]?.toUpperCase();
        sock.write(encode(name === 'QUIT' ? { simple: 'OK' } : handler(parsed.args)));
      }
    });
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  return {
    port: (srv.address() as AddressInfo).port,
    commands,
    close: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy();
        srv.close(() => ok());
      }),
  };
}

function parse(buf: Buffer): { args: string[]; used: number } | null {
  if (!buf.length || buf[0] !== 0x2a) return null; // '*'
  let pos = buf.indexOf('\r\n');
  if (pos < 0) return null;
  const n = Number(buf.subarray(1, pos).toString());
  let off = pos + 2;
  const args: string[] = [];
  for (let k = 0; k < n; k++) {
    pos = buf.indexOf('\r\n', off);
    if (pos < 0) return null;
    const len = Number(buf.subarray(off + 1, pos).toString());
    const start = pos + 2;
    if (buf.length < start + len + 2) return null;
    args.push(buf.subarray(start, start + len).toString());
    off = start + len + 2;
  }
  return { args, used: off };
}
