/**
 * Response-size cap of the shared HTTP client: a body larger than maxBytes is not buffered
 * whole — `error` aborts with DATA_UNAVAILABLE, `tail` keeps only the last maxBytes bytes.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_RESPONSE_BYTES, httpJson, rawRequest } from '../../src/core/http';
import { WorkError } from '../../src/core/output';

let url = '';
let close: () => Promise<void>;

beforeAll(async () => {
  const srv = createServer((req, res) => {
    const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? 0);
    const chunked = req.url?.includes('chunked');
    const body = Buffer.from(Array.from({ length: n }, (_, i) => `line ${String(i).padStart(6, '0')}\n`).join(''));
    res.writeHead(200, { 'content-type': 'text/plain', ...(chunked ? {} : { 'content-length': String(body.length) }) });
    if (chunked) {
      // no content-length: the cap must be enforced while streaming
      for (let i = 0; i < body.length; i += 4096) res.write(body.subarray(i, i + 4096));
      res.end();
    } else res.end(body);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => new Promise((ok) => srv.close(() => ok()));
});
afterAll(async () => close());

describe('http response size cap', () => {
  it('has a 16 MiB default', () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
  });

  it('small bodies are unaffected', async () => {
    const r = await httpJson(null, `${url}/?n=10`, { maxBytes: 1024 });
    expect(r.text.split('\n').filter(Boolean)).toHaveLength(10);
    expect(r.truncated).toBeUndefined();
  });

  for (const mode of ['sized', 'chunked']) {
    it(`aborts a ${mode} body over maxBytes with DATA_UNAVAILABLE`, async () => {
      const e = await httpJson(null, `${url}/${mode}?n=5000`, { maxBytes: 10_000 }).catch((x) => x);
      expect(e).toBeInstanceOf(WorkError);
      expect(e.code).toBe('DATA_UNAVAILABLE');
      expect(e.message).toMatch(/超过 10000 字节/);
      expect(e.hint).toBeTruthy();
      expect(e.details).toMatchObject({ reason: 'response_too_large', max_bytes: 10_000 });
    });

    it(`overflow=tail keeps only the last maxBytes of a ${mode} body`, async () => {
      const r = await rawRequest(`${url}/${mode}?n=5000`, { method: 'GET', headers: {}, timeoutMs: 5000, maxBytes: 10_000, overflow: 'tail' });
      expect(r.truncated).toBe(true);
      expect(r.buffer.length).toBe(10_000);
      expect(r.bytes).toBe(5000 * 12);
      expect(r.text.endsWith('line 004999\n')).toBe(true);
    });
  }
});
