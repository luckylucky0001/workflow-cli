import { WorkError } from '../../core/output';
import { int, unb64, type EtcdKv } from './etcd';

export const MASK = '***';

/**
 * Secret-like names: a name segment (split on . _ - / and camelCase) equal to one of these.
 * Matching is by name only — values are never inspected to decide.
 */
const SECRET_SEGMENTS = new Set(['password', 'passwd', 'pwd', 'secret', 'secrets', 'token', 'key', 'apikey', 'credential', 'credentials', 'dsn', 'privatekey', 'accesskey', 'secretkey']);

export function isSecretName(name: string): boolean {
  const segs = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[._\-/\s]+/)
    .filter(Boolean);
  if (segs.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const joined = segs.join('');
  return /(password|passwd|secret|token|apikey|privatekey|accesskey|secretkey)/.test(joined);
}

export type ValueFormat = 'json' | 'text' | 'binary_base64' | 'empty';

export interface DecodedValue {
  value: unknown;
  value_format: ValueFormat;
  /** Raw size in bytes; null when the whole value is masked (its length would leak the secret's length). */
  value_bytes: number | null;
  masked: boolean;
  masked_paths: string[];
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Recursively replace values of secret-like object properties; returns the masked JSON paths.
 * Below a secret-like property every scalar leaf is masked (e.g. "credentials": {...}, "api_keys": [...]).
 */
function maskJson(v: unknown, path: string, out: string[], secret = false): unknown {
  if (Array.isArray(v)) return v.map((x, i) => maskJson(x, `${path}[${i}]`, out, secret));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = maskJson(x, `${path}.${k}`, out, secret || isSecretName(k));
    return o;
  }
  if (secret && v !== null) {
    out.push(path);
    return MASK;
  }
  return v;
}

/** Integer literals outside ±2^53 lose digits in JSON.parse; quote them (outside strings) to keep the exact digits. */
const BIG_INT = /"(?:[^"\\]|\\.)*"|(?<![\d.eE+-])-?\d{16,}(?![\d.eE])/g;
function quoteUnsafeInts(t: string): string {
  return t.replace(BIG_INT, (m) => (m.startsWith('"') || Number.isSafeInteger(Number(m)) ? m : `"${m}"`));
}

/**
 * Decode an etcd value: UTF-8 text, parsed as JSON when it is a JSON object/array/number/bool/null,
 * otherwise kept as text; non-UTF-8 bytes are returned base64-encoded. Secret-like names are masked:
 * the whole value when the key name matches, otherwise matching JSON properties.
 */
export function decodeValue(raw: Buffer, name: string): DecodedValue {
  const bytes = raw.length;
  if (bytes === 0) return { value: '', value_format: 'empty', value_bytes: 0, masked: false, masked_paths: [] };
  let text: string | null;
  try {
    text = utf8.decode(raw);
  } catch {
    text = null;
  }
  if (isSecretName(name)) return { value: MASK, value_format: text === null ? 'binary_base64' : 'text', value_bytes: null, masked: true, masked_paths: ['$'] };
  if (text === null) return { value: raw.toString('base64'), value_format: 'binary_base64', value_bytes: bytes, masked: false, masked_paths: [] };
  const t = text.trim();
  if (/^[[{]/.test(t) || /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(t)) {
    try {
      let parsed = JSON.parse(t);
      // a bare number that JSON cannot carry exactly (> 2^53 or overflow) stays text: never show rounded digits
      if (typeof parsed === 'number' && (!Number.isFinite(parsed) || (/^-?\d+$/.test(t) && !Number.isSafeInteger(parsed)))) {
        return { value: text, value_format: 'text', value_bytes: bytes, masked: false, masked_paths: [] };
      }
      if (typeof parsed === 'object' && parsed !== null) {
        const exact = quoteUnsafeInts(t);
        if (exact !== t) {
          try {
            parsed = JSON.parse(exact);
          } catch {
            /* keep the first parse: masking must still apply */
          }
        }
      }
      const paths: string[] = [];
      const value = maskJson(parsed, '$', paths);
      return { value, value_format: 'json', value_bytes: bytes, masked: paths.length > 0, masked_paths: paths };
    } catch {
      /* not JSON: keep text */
    }
  }
  return { value: text, value_format: 'text', value_bytes: bytes, masked: false, masked_paths: [] };
}

export interface ConfigItem extends DecodedValue {
  key: string;
  name: string;
  create_revision: number;
  mod_revision: number;
  version: number;
  lease: string | null;
}

export function toItem(kv: EtcdKv, prefix: string): ConfigItem {
  const key = unb64(kv.key).toString('utf8');
  const name = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return {
    key,
    name,
    ...decodeValue(unb64(kv.value), name),
    create_revision: int(kv.create_revision),
    mod_revision: int(kv.mod_revision),
    version: int(kv.version),
    lease: kv.lease && kv.lease !== '0' ? String(kv.lease) : null,
  };
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function checkSegment(label: string, v: string): string {
  if (!SEGMENT.test(v)) throw new WorkError('INVALID_ARGUMENT', `${label} 不合法: ${v}`, { hint: '只允许字母、数字、点、下划线、连字符，且不能以符号开头' });
  return v;
}

/** Relative config key below the service prefix: segments separated by '/', no '..', no leading '/'. */
export function checkRelKey(v: string): string {
  if (v.length > 512 || v.startsWith('/') || v.split('/').some((s) => !s || s === '.' || s === '..' || !/^[A-Za-z0-9._-]+$/.test(s))) {
    throw new WorkError('INVALID_ARGUMENT', `--key 不合法: ${v}`, { hint: '使用服务前缀下的相对键名，如 cache.ttl_seconds' });
  }
  return v;
}

export function normPrefix(p: string): string {
  if (!p.startsWith('/')) p = `/${p}`;
  return p.endsWith('/') ? p : `${p}/`;
}

/** Parse --to-rev: a positive integer or 'current'. */
export function parseRev(label: string, v: unknown): number | 'current' {
  const s = String(v).trim();
  if (s === 'current' || s === 'latest') return 'current';
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) < 1) {
    throw new WorkError('INVALID_ARGUMENT', `${label} 须为正整数修订号或 current: ${s}`);
  }
  return Number(s);
}
