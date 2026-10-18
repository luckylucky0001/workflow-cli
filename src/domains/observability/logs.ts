import { StringDecoder } from 'node:string_decoder';
import { WorkError } from '../../core/output';
import type { Ctx } from '../../core/runtime';
import { maskCredentialText, MASK } from '../config/values';
import { containerName, dockerTime, shortId, type ContainerInspect, type DockerClient } from '../container/docker';

/**
 * Docker multiplexes stdout/stderr of non-TTY containers into frames:
 *   [stream:1][0][0][0][size:4 big-endian][payload:size]
 * Frames can be split across HTTP chunks; this parser buffers partial headers/payloads.
 */
export class FrameDemuxer {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onFrame: (stream: 'stdout' | 'stderr', payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    while (this.buf.length - off >= 8) {
      const type = this.buf[off];
      const size = this.buf.readUInt32BE(off + 4);
      if (this.buf.length - off - 8 < size) break;
      const payload = this.buf.subarray(off + 8, off + 8 + size);
      this.onFrame(type === 2 ? 'stderr' : 'stdout', payload);
      off += 8 + size;
    }
    this.buf = off ? Buffer.from(this.buf.subarray(off)) : this.buf;
  }

  /** Bytes left in the buffer (a truncated trailing frame). */
  get pending(): number {
    return this.buf.length;
  }
}

/**
 * Splits a stream into complete lines, keeping a partial tail between pushes.
 * Bytes are decoded with a StringDecoder so a multi-byte UTF-8 character split
 * across HTTP chunks (TTY streams) or frames is not turned into U+FFFD.
 */
export class LineSplitter {
  private tail = '';
  private readonly decoder = new StringDecoder('utf8');
  constructor(private readonly onLine: (line: string) => void) {}
  push(data: string | Buffer): void {
    const text = typeof data === 'string' ? data : this.decoder.write(data);
    const parts = (this.tail + text).split('\n');
    this.tail = parts.pop() ?? '';
    for (const p of parts) if (p) this.onLine(p.replace(/\r$/, ''));
  }
  flush(): void {
    this.tail += this.decoder.end();
    if (this.tail) this.onLine(this.tail);
    this.tail = '';
  }
}

export interface LogEntry {
  ts: string;
  container: string;
  stream: 'stdout' | 'stderr';
  level: string | null;
  msg: string | null;
  kind: string | null;
  trace_id: string | null;
  span_id: string | null;
  fields: Record<string, unknown> | null;
  raw: string | null;
  /** msg/raw or a string field was longer than MAX_LOG_TEXT and was cut. */
  truncated: boolean;
  /** credentials in msg/raw/string fields (URL userinfo passwords, Authorization headers, password=/token= params, secret-named fields) were masked. */
  credentials_masked: boolean;
}

/** Per-value cap for log text (msg, raw, string fields): one huge line must not blow up the result. */
export const MAX_LOG_TEXT = 8192;

function capText(v: string, hit: { n: number }): string {
  if (v.length <= MAX_LOG_TEXT) return v;
  hit.n++;
  return `${v.slice(0, MAX_LOG_TEXT)}…[截断，原长 ${v.length} 字符]`;
}

function capValue(v: unknown, hit: { n: number }, depth = 0): unknown {
  if (typeof v === 'string') return capText(v, hit);
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => capValue(x, hit, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = capValue(x, hit, depth + 1);
  return out;
}

export function longTextNote(n: number): string {
  return `${n} 条日志含超过 ${MAX_LOG_TEXT} 字符的文本，已截断（entries[].truncated=true）`;
}

function maskText(v: string, hit: { n: number }): string {
  const m = maskCredentialText(v);
  if (m.masked) hit.n++;
  return m.text;
}

/** Field names whose string values are credentials (narrower than config's rule: a bare `key`, e.g. a cache key, is not). */
const SECRET_FIELD = /password|passwd|pwd|passphrase|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|authorization|credential|cookie/i;

/** Mask credentials in every string of a JSON log's fields; scalar strings under secret-named keys are masked whole. */
function maskValue(v: unknown, hit: { n: number }, depth = 0): unknown {
  if (typeof v === 'string') return maskText(v, hit);
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => maskValue(x, hit, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'string' && x !== '' && SECRET_FIELD.test(k)) {
      hit.n++;
      out[k] = MASK;
    } else out[k] = maskValue(x, hit, depth + 1);
  }
  return out;
}

export function maskedNote(n: number): string {
  return `${n} 条日志含凭据（URL 中的密码、Authorization 头、password=/token= 等参数或敏感字段），已打码为 ***（entries[].credentials_masked=true）`;
}

/**
 * Mask credentials in application log text (sets `credentials_masked`), then apply MAX_LOG_TEXT
 * to every text value (sets `truncated`). Non-credential text is unchanged. Filters (`contains`,
 * trace id) are evaluated on the original line, not on the masked entry.
 */
export function capEntry(e: LogEntry): LogEntry {
  const masked = { n: 0 };
  const mMsg = e.msg === null ? null : maskText(e.msg, masked);
  const mRaw = e.raw === null ? null : maskText(e.raw, masked);
  const mFields = e.fields === null ? null : (maskValue(e.fields, masked) as Record<string, unknown>);
  const hit = { n: 0 };
  const msg = mMsg === null ? null : capText(mMsg, hit);
  const raw = mRaw === null ? null : capText(mRaw, hit);
  const fields = mFields === null ? null : (capValue(mFields, hit) as Record<string, unknown>);
  return { ...e, msg, raw, fields, truncated: e.truncated || hit.n > 0, credentials_masked: e.credentials_masked || masked.n > 0 };
}

const LEVELS: Record<string, number> = { trace: 5, debug: 10, info: 20, notice: 25, warn: 30, warning: 30, error: 40, err: 40, fatal: 50, critical: 50, panic: 50 };
const PINO_LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

export function levelRank(level: string | null | undefined): number | null {
  if (!level) return null;
  return LEVELS[level.toLowerCase()] ?? null;
}

/** Parse one `timestamps=1` log line: `<RFC3339Nano> <content>`. JSON content is parsed; anything else is kept raw. */
export function parseLogLine(line: string, container: string, stream: 'stdout' | 'stderr'): LogEntry {
  const sp = line.indexOf(' ');
  const hasTs = sp > 0 && /^\d{4}-\d{2}-\d{2}T/.test(line);
  const ts = hasTs ? line.slice(0, sp) : '';
  const content = hasTs ? line.slice(sp + 1) : line;
  if (content.startsWith('{')) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const { level: lvRaw, msg, message, ts: _appTs, time: _time, ...rest } = obj;
        let level: string | null = null;
        if (typeof lvRaw === 'string') level = lvRaw.toLowerCase();
        else if (typeof lvRaw === 'number') level = PINO_LEVELS[lvRaw] ?? String(lvRaw);
        const { kind: _k, trace_id: _t, span_id: _s, ...others } = rest;
        const fields: Record<string, unknown> = { ...others };
        if (_appTs !== undefined) fields.app_ts = _appTs;
        return capEntry({
          ts,
          container,
          stream,
          level,
          msg: typeof msg === 'string' ? msg : typeof message === 'string' ? message : null,
          kind: typeof obj.kind === 'string' ? obj.kind : null,
          trace_id: typeof obj.trace_id === 'string' ? obj.trace_id : null,
          span_id: typeof obj.span_id === 'string' ? obj.span_id : null,
          fields,
          raw: null,
          truncated: false,
          credentials_masked: false,
        });
      }
    } catch {
      // fall through to raw
    }
  }
  return capEntry({ ts, container, stream, level: null, msg: null, kind: null, trace_id: null, span_id: null, fields: null, raw: content, truncated: false, credentials_masked: false });
}

export interface LogFilter {
  minLevel?: string;
  contains?: string;
  traceId?: string;
  includeSpans?: boolean;
}

export interface FilterStats {
  lines: number;
  unparsed: number;
  spans_skipped: number;
  unparsed_excluded_by_level: number;
}

export function matches(e: LogEntry, line: string, f: LogFilter, stats: FilterStats): boolean {
  if (e.kind === 'span' && !f.includeSpans) {
    stats.spans_skipped++;
    return false;
  }
  if (f.minLevel) {
    const min = levelRank(f.minLevel) ?? 0;
    const r = levelRank(e.level);
    if (r === null) {
      if (e.raw !== null) stats.unparsed_excluded_by_level++;
      return false;
    }
    if (r < min) return false;
  }
  // raw entries: check the full line, not e.raw (which may be capped at MAX_LOG_TEXT)
  if (f.traceId && e.trace_id !== f.traceId && !(e.raw !== null && line.includes(f.traceId))) return false;
  if (f.contains && !line.includes(f.contains)) return false;
  return true;
}

export interface ContainerScan {
  name: string;
  id: string;
  log_driver: string | null;
  created_at: string;
  started_at: string | null;
  lines_scanned: number;
  matched: number;
  status: 'ok' | 'collection_disabled' | 'error';
  note: string | null;
}

const READABLE_DRIVERS = new Set(['json-file', 'local', 'journald']);

/**
 * Stream the logs of one container for [since, until] and hand each parsed line to
 * `onEntry`. Uses the demultiplexer unless the container runs with a TTY.
 */
export async function scanContainerLogs(
  ctx: Ctx,
  docker: DockerClient,
  inspect: ContainerInspect,
  window: { start: string; end: string },
  onLine: (line: string, stream: 'stdout' | 'stderr', container: string) => void,
  opts: { prefilter?: string } = {},
): Promise<ContainerScan> {
  const name = containerName(inspect);
  const driver = inspect.HostConfig?.LogConfig?.Type ?? null;
  const scan: ContainerScan = {
    name,
    id: shortId(inspect.Id),
    log_driver: driver,
    created_at: inspect.Created,
    started_at: dockerTime(inspect.State?.StartedAt),
    lines_scanned: 0,
    matched: 0,
    status: 'ok',
    note: null,
  };
  if (driver && !READABLE_DRIVERS.has(driver)) {
    scan.status = 'collection_disabled';
    scan.note = `日志驱动 ${driver} 不支持通过 Docker API 读取`;
    return scan;
  }
  const since = (Date.parse(window.start) / 1000).toFixed(3);
  const until = (Date.parse(window.end) / 1000).toFixed(3);
  const path = `/containers/${inspect.Id}/logs?stdout=1&stderr=1&timestamps=1&since=${since}&until=${until}`;
  const splitters = {
    stdout: new LineSplitter((l) => emit(l, 'stdout')),
    stderr: new LineSplitter((l) => emit(l, 'stderr')),
  };
  const emit = (line: string, stream: 'stdout' | 'stderr') => {
    scan.lines_scanned++;
    if (opts.prefilter && !line.includes(opts.prefilter)) return;
    onLine(line, stream, name);
  };
  const tty = !!inspect.Config?.Tty;
  const demux = new FrameDemuxer((stream, payload) => splitters[stream].push(payload));
  const r = await docker.stream(path, (chunk) => (tty ? splitters.stdout.push(chunk) : demux.push(chunk)));
  if (r.status >= 400) {
    const body = r.errorBody ?? '';
    if (/does not support reading|configured logging driver/i.test(body)) {
      scan.status = 'collection_disabled';
      scan.note = `Docker: ${body.trim().slice(0, 200)}`;
      return scan;
    }
    if (r.status === 404) throw new WorkError('NOT_FOUND', `容器不存在: ${name}`);
    scan.status = 'error';
    scan.note = `Docker HTTP ${r.status}: ${body.trim().slice(0, 200)}`;
    return scan;
  }
  splitters.stdout.flush();
  splitters.stderr.flush();
  if (demux.pending) scan.note = `流末尾有 ${demux.pending} 字节不完整帧被忽略`;
  return scan;
}

/** Sortable key for RFC3339 timestamps with variable fractional digits (UTC 'Z' form). */
export function tsKey(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(ts);
  if (!m) return ts;
  return `${m[1]}.${(m[2] ?? '').padEnd(9, '0').slice(0, 9)}Z`;
}

/**
 * Keeps at most `limit` entries: the newest (order=newest) or the oldest (order=oldest).
 * Entries arrive container by container (each in time order), so arrival order is not
 * global time order: trimming always sorts by timestamp before discarding.
 */
export class BoundedCollector {
  private items: LogEntry[] = [];
  matched = 0;
  constructor(readonly limit: number, readonly keep: 'newest' | 'oldest') {}
  add(e: LogEntry): void {
    this.matched++;
    this.items.push(e);
    if (this.items.length > this.limit * 2) {
      const sorted = this.items.sort((a, b) => tsKey(a.ts).localeCompare(tsKey(b.ts)));
      this.items = this.keep === 'newest' ? sorted.slice(-this.limit) : sorted.slice(0, this.limit);
    }
  }
  /** Merge of per-container collectors happens on the caller side; this returns sorted chronological. */
  entries(): LogEntry[] {
    const sorted = [...this.items].sort((a, b) => tsKey(a.ts).localeCompare(tsKey(b.ts)));
    return this.keep === 'newest' ? sorted.slice(-this.limit) : sorted.slice(0, this.limit);
  }
}
