// Nacos 2.x provider (HTTP Open API): config documents (namespace / group / dataId) parsed into keys,
// config history (pre-image records) for `config diff`, naming instances for `discovery list`.
import YAML from 'yaml';
import { safeUrl } from '../../core/http';
import { source, WorkError, type Result, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';
import { fill, send, type HttpResult, type ProviderChoice } from './provider';
import { MAX_KEYS, side, type Change, type Instance, type Item } from './schema';
import { checkRelKey, checkSegment, decodeValue, MASK } from './values';

export const NACOS_ADAPTER = 'nacos-open-api';
export const NACOS_AUTH = 'nacos-token';

const UNAUTH_RE = /user not found|unknown user|token invalid|token expired|invalid token|not login|token is empty/i;

export function mapNacosError(status: number, body: string, where: string): WorkError {
  const msg = body.replace(/\s+/g, ' ').slice(0, 300);
  const details = { http_status: status, nacos_message: msg };
  if (status === 401 || (status === 403 && UNAUTH_RE.test(body))) {
    return new WorkError('UNAUTHENTICATED', `Nacos 认证失败或缺少凭据: ${msg} (${where})`, { details, hint: '开启鉴权的 Nacos 需在端点配置 username + password_ref（POST /v1/auth/login 换 accessToken）' });
  }
  if (status === 403) return new WorkError('PERMISSION_DENIED', `Nacos 拒绝访问（无该命名空间/资源权限）: ${msg} (${where})`, { details, hint: '为账号的角色授予该命名空间的读权限（权限控制 → 权限管理）' });
  if (status === 404) return new WorkError('NOT_FOUND', `Nacos 返回 404: ${msg} (${where})`, { details });
  if (status === 400) return new WorkError('INVALID_ARGUMENT', `Nacos 拒绝请求参数: ${msg} (${where})`, { details });
  return new WorkError('UPSTREAM_UNAVAILABLE', `Nacos 返回 HTTP ${status}: ${msg} (${where})`, { details });
}

export class NacosClient {
  readonly base: string;
  private token: string | null | undefined;
  private stateCache: Record<string, unknown> | null | undefined;
  authNote: string | null = null;

  constructor(
    private readonly ctx: Ctx,
    readonly endpoint: Endpoint,
  ) {
    const url = endpoint.require('url').replace(/\/+$/, '');
    const cp = endpoint.str('context_path', '/nacos').replace(/\/+$/, '');
    this.base = cp && !url.endsWith(cp) ? `${url}${cp.startsWith('/') ? cp : `/${cp}`}` : url;
  }

  get id(): string {
    return this.endpoint.id;
  }

  get username(): string | null {
    return this.endpoint.str('username') ?? null;
  }

  private raw(method: string, path: string, params: Record<string, string>, body?: string): Promise<HttpResult> {
    const qs = new URLSearchParams(params).toString();
    return send(this.ctx, 'Nacos', this.id, `${this.base}${path}${qs ? `?${qs}` : ''}`, { method, body, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {} }, '确认 Nacos 已启动、url 指向 HTTP 端口（演示环境 127.0.0.1:18848，context_path /nacos）');
  }

  private async accessToken(): Promise<string | null> {
    if (this.token !== undefined) return this.token;
    const user = this.username;
    if (!user) return (this.token = null);
    const password = this.endpoint.secret('password');
    if (password === undefined) throw new WorkError('UNAUTHENTICATED', `端点 ${this.id} 配置了 username 但缺少 password_ref`, { hint: 'password_ref: file:<path> 或 env:<NAME>' });
    const r = await this.raw('POST', '/v1/auth/login', {}, new URLSearchParams({ username: user, password }).toString());
    if (r.status >= 400) {
      // auth disabled servers may not expose the login endpoint at all, or (2.4.x) answer it with
      // HTTP 500 "User <name> not found" (no user initialised): the server state says whether auth is on
      if (r.status === 404 || /auth.*(not enabled|disabled)/i.test(r.text) || (await this.authDisabled())) {
        this.authNote = `Nacos 未开启鉴权，已忽略端点配置的 username（${user}）`;
        return (this.token = null);
      }
      const e = mapNacosError(r.status === 403 || /user \S+ not found/i.test(r.text) ? 401 : r.status, r.text, `${safeUrl(this.base)}/v1/auth/login`);
      throw e;
    }
    const t = r.json?.accessToken ? String(r.json.accessToken) : null;
    if (!t) throw new WorkError('UNAUTHENTICATED', `Nacos 登录未返回 accessToken (${this.id})`);
    return (this.token = t);
  }

  /** true only when the (unauthenticated) server state explicitly reports auth_enabled=false. */
  private async authDisabled(): Promise<boolean> {
    const s = await this.raw('GET', '/v1/console/server/state', {}).catch(() => null);
    if (!s || s.status !== 200 || !s.json || typeof s.json !== 'object') return false;
    if (this.stateCache === undefined) this.stateCache = s.json as Record<string, unknown>;
    return String((s.json as Record<string, unknown>).auth_enabled) === 'false';
  }

  /** GET with auth; returns null on 404 when `allow404` (absence is a fact the caller reports). */
  async get(path: string, params: Record<string, string>, allow404 = false): Promise<HttpResult | null> {
    const token = await this.accessToken();
    const r = await this.raw('GET', path, token ? { ...params, accessToken: token } : params);
    if (r.status === 404 && allow404) return null;
    if (r.status >= 400) throw mapNacosError(r.status, r.text, `${safeUrl(this.base)}${path}`);
    return r;
  }

  async serverState(): Promise<Record<string, unknown>> {
    const r = await this.get('/v1/console/server/state', {});
    return (r?.json ?? {}) as Record<string, unknown>;
  }

  /** Server version for provenance; null when the state endpoint is not readable (never guessed). */
  async version(): Promise<string | null> {
    if (this.stateCache === undefined) {
      try {
        this.stateCache = await this.serverState();
      } catch {
        this.stateCache = null;
      }
    }
    return this.stateCache?.version ? String(this.stateCache.version) : null;
  }

  async retentionDays(): Promise<number | null> {
    await this.version();
    const d = Number(this.stateCache?.config_retention_days);
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    const version = await this.version();
    return source('nacos', NACOS_ADAPTER, { endpoint: `${this.id} (${safeUrl(this.base).replace(/\/$/, '')})`, method, relation, ...(version ? { version } : {}) });
  }
}

export function nacosClient(ctx: Ctx, name?: string): NacosClient {
  return new NacosClient(ctx, ctx.endpoint('nacos', name));
}

// ---------------------------------------------------------------------------
// document parsing
// ---------------------------------------------------------------------------
export type DocFormat = 'properties' | 'yaml' | 'json' | 'text';

export function docFormat(type: string | null, dataId: string): DocFormat {
  // "text" is what Nacos records when the publisher gave no type (SDK publishConfig, v1 API default):
  // the dataId extension then tells more (a typeless demo.properties must still be split and masked)
  const recorded = (type ?? '').toLowerCase();
  const t = (recorded !== 'text' && recorded) || (/\.([a-z]+)$/i.exec(dataId)?.[1] ?? '').toLowerCase();
  if (t === 'properties') return 'properties';
  if (t === 'yaml' || t === 'yml') return 'yaml';
  if (t === 'json') return 'json';
  return 'text';
}

const unescapeProp = (s: string) =>
  s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' } as Record<string, string>)[c] ?? c));

/** java.util.Properties-compatible line parser (comments, = : or whitespace separators, continuations, escapes). */
export function parseProperties(text: string): [string, string][] {
  const out: [string, string][] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(line)) {
      // a continuation backslash on the last line is dropped, as java.util.Properties does at EOF
      line = line.slice(0, -1);
      if (i + 1 >= lines.length) break;
      line += lines[++i].replace(/^\s+/, '');
    }
    const m = /^((?:\\.|[^=:\s\\])*)\s*[=:\s]?\s*(.*)$/.exec(line)!;
    out.push([unescapeProp(m[1]), unescapeProp(m[2])]);
  }
  return out;
}

type Leaf = string | number | boolean | null | bigint;

function flatten(v: unknown, prefix: string, out: [string, Leaf | '{}' | '[]'][]): void {
  if (Array.isArray(v)) {
    if (!v.length && prefix) out.push([prefix, '[]']);
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
  } else if (v && typeof v === 'object' && !(v instanceof Date)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length && prefix) out.push([prefix, '{}']);
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push([prefix, v instanceof Date ? v.toISOString() : (v as Leaf)]);
  }
}

export interface ParsedDoc {
  format: DocFormat;
  parsed: boolean;
  parse_error: string | null;
  /** name → raw text (pre-mask, used for comparison) */
  raw: Map<string, string>;
}

/** Split a document into keys when its format allows; otherwise one entry named after the dataId. */
export function parseDoc(content: string, format: DocFormat, dataId: string): ParsedDoc {
  const raw = new Map<string, string>();
  const whole = (err: string | null): ParsedDoc => {
    raw.set(dataId, content);
    return { format, parsed: false, parse_error: err, raw };
  };
  if (format === 'text') return whole(null);
  try {
    if (format === 'properties') {
      for (const [k, v] of parseProperties(content)) raw.set(k, v);
    } else {
      const doc = YAML.parse(content, { intAsBigInt: true, uniqueKeys: false, merge: true }); // merge: `<<: *anchor` as Spring (SnakeYAML) reads it
      if (doc === null || doc === undefined) return { format, parsed: true, parse_error: null, raw };
      if (typeof doc !== 'object') return whole(`文档顶层不是对象（${typeof doc}）`);
      const leaves: [string, Leaf | '{}' | '[]'][] = [];
      flatten(doc, '', leaves);
      for (const [k, v] of leaves) raw.set(k, typeof v === 'string' ? v : v === null ? 'null' : String(v));
    }
    return { format, parsed: true, parse_error: null, raw };
  } catch (e) {
    raw.clear();
    return whole(`${format} 解析失败: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

function toItems(doc: ParsedDoc, keyBase: string): Item[] {
  return [...doc.raw.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, v]) => {
      const dv = decodeValue(Buffer.from(v, 'utf8'), name);
      // a properties/yaml/json document that failed to parse (e.g. multi-document YAML) is still config
      // whose secret-like keys cannot be located: fail closed and mask the whole document
      const value = doc.parse_error && !dv.masked && dv.value_format !== 'empty' ? { value: MASK, value_format: dv.value_format, value_bytes: null, masked: true, masked_paths: ['$'] } : dv;
      return { key: `${keyBase}#${name}`, name, ...value, create_revision: null, mod_revision: null, version: null, lease: null };
    });
}

// ---------------------------------------------------------------------------
// coordinates
// ---------------------------------------------------------------------------
interface Coords {
  namespace: string;
  group: string;
  dataId: string;
  base: string;
}

function coords(client: NacosClient, env: string, service: string): Coords {
  const vars = { env: checkSegment('--env', env), service: checkSegment('--service', service) };
  let namespace = fill(client.endpoint.str('namespace', '${env}'), vars);
  if (namespace === 'public') namespace = '';
  const group = fill(client.endpoint.str('group', 'DEFAULT_GROUP'), vars);
  const dataId = fill(client.endpoint.str('data_id', '${service}.properties'), vars);
  return { namespace, group, dataId, base: `${namespace || 'public'}/${group}/${dataId}` };
}

interface ConfigDetail {
  content: string;
  type: string | null;
  md5: string | null;
  modifyTime: number | null;
}

async function readConfig(client: NacosClient, c: Coords): Promise<ConfigDetail | null> {
  const r = await client.get('/v1/cs/configs', { dataId: c.dataId, group: c.group, tenant: c.namespace, show: 'all' }, true);
  // show=all answers a missing config with 200 + empty body (without show=all: 404 "config data not exist")
  if (!r || !r.text.trim()) return null;
  const j = r.json;
  if (j && typeof j === 'object' && typeof j.content === 'string') {
    return { content: j.content, type: j.type ? String(j.type) : null, md5: j.md5 ? String(j.md5) : null, modifyTime: Number(j.modifyTime) || null };
  }
  // servers that ignore show=all return the raw content
  return { content: r.text, type: null, md5: null, modifyTime: null };
}

interface HistoryRec {
  id: number;
  op: string;
  modified: string | null;
  user: string | null;
}

/** All retained history records of one config, ascending by id. v2 list API first (2.2+), v1 search=accurately as fallback. */
async function listHistory(client: NacosClient, c: Coords): Promise<{ recs: HistoryRec[]; method: string; truncated: boolean }> {
  const recs: HistoryRec[] = [];
  let method = 'GET /v2/cs/history/list';
  let truncated = false;
  for (let page = 1; page <= 5; page++) {
    let r = await client.get('/v2/cs/history/list', { dataId: c.dataId, group: c.group, namespaceId: c.namespace, pageNo: String(page), pageSize: '100' }, true);
    let data = r?.json?.data;
    if (!r) {
      method = 'GET /v1/cs/history?search=accurately';
      r = await client.get('/v1/cs/history', { search: 'accurately', dataId: c.dataId, group: c.group, tenant: c.namespace, pageNo: String(page), pageSize: '100' });
      data = r?.json;
    }
    const items = (data?.pageItems ?? []) as Record<string, unknown>[];
    for (const it of items) recs.push({ id: Number(it.id), op: String(it.opType ?? '').trim() || '?', modified: it.lastModifiedTime ? String(it.lastModifiedTime) : null, user: it.srcUser ? String(it.srcUser) : null });
    const pages = Number(data?.pagesAvailable ?? 1);
    if (page >= pages || !items.length) break;
    if (page === 5) truncated = true;
  }
  recs.sort((a, b) => a.id - b.id);
  return { recs, method, truncated };
}

async function historyContent(client: NacosClient, c: Coords, nid: number): Promise<string> {
  let r = await client.get('/v2/cs/history', { nid: String(nid), dataId: c.dataId, group: c.group, namespaceId: c.namespace }, true);
  let d = r?.json?.data;
  if (!r) {
    r = await client.get('/v1/cs/history', { nid: String(nid), dataId: c.dataId, group: c.group, tenant: c.namespace });
    d = r?.json;
  }
  if (!d || typeof d.content !== 'string') throw new WorkError('DATA_UNAVAILABLE', `Nacos 历史记录 ${nid} 不可读（可能已过保留期）`, { details: { history_id: nid } });
  return d.content;
}

/**
 * Nacos history rows store the content BEFORE an update/delete (pre-image) and the inserted content for
 * an insert. The state after change k is therefore the pre-image of change k+1, or the current content.
 */
async function stateAfter(client: NacosClient, c: Coords, recs: HistoryRec[], idx: number, current: string | null): Promise<string | null> {
  if (idx < 0) return null;
  if (recs[idx].op === 'D') return null;
  const next = recs[idx + 1];
  if (!next) return current;
  if (next.op === 'I') return null;
  return historyContent(client, c, next.id);
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------
export async function nacosConfigGet(ctx: Ctx, i: Record<string, any>, p: ProviderChoice, env: string): Promise<Result> {
  const client = nacosClient(ctx, p.name);
  const service = String(i.service);
  const c = coords(client, env, service);
  const relKey = i.key ? checkRelKey(String(i.key)) : null;
  const limit = Number(i.limit);
  if (limit < 1 || limit > MAX_KEYS) throw new WorkError('INVALID_ARGUMENT', `--limit 取值 1-${MAX_KEYS}`);
  const detail = await readConfig(client, c);
  const sources = [await client.source(`GET /v1/cs/configs?show=all dataId=${c.dataId} group=${c.group} tenant=${c.namespace || '(public)'}`)];
  let latest: number | null = null;
  let historyError: string | null = null;
  try {
    const h = await listHistory(client, c);
    latest = h.recs.length ? h.recs[h.recs.length - 1].id : null;
    sources.push(await client.source(h.method));
  } catch (e) {
    if (!(e instanceof WorkError) || !['PERMISSION_DENIED', 'NOT_FOUND', 'UPSTREAM_UNAVAILABLE'].includes(e.code)) throw e;
    historyError = `${e.code}: ${e.message}`;
  }
  const format = docFormat(detail?.type ?? null, c.dataId);
  const doc = detail ? parseDoc(detail.content, format, c.dataId) : { format, parsed: false, parse_error: null, raw: new Map<string, string>() };
  let items = toItems(doc, c.base);
  // the document md5 plus every unmasked value is a verifier for the masked ones: withhold it then
  const docMasked = items.some((x) => x.masked);
  if (relKey) {
    items = items.filter((x) => x.name === relKey);
    if (!items.length) {
      const names = [...doc.raw.keys()].slice(0, 20);
      throw new WorkError('NOT_FOUND', detail ? `配置项不存在: ${c.base}#${relKey}` : `配置文档不存在: ${c.base}`, {
        hint: detail ? (names.length ? `该文档中的键（前 20 个）: ${names.join(', ')}` : '文档为空') : '检查 --service / --env 与端点 namespace / group / data_id 模板',
      });
    }
  }
  const count = items.length;
  const truncated = !relKey && count > limit;
  if (truncated) items = items.slice(0, limit);
  const notes: string[] = [];
  if (!detail) notes.push(`配置文档 ${c.base} 不存在；检查 --env / --service 与端点的 namespace / group / data_id 模板`);
  else if (!doc.raw.size) notes.push(`配置文档 ${c.base} 存在但没有配置项`);
  if (doc.parse_error) notes.push(`${doc.parse_error}；整个文档作为一个值（name=${c.dataId}）返回并整体遮蔽（无法定位其中的敏感键）`);
  else if (detail && !doc.parsed) notes.push(`配置类型 ${detail.type ?? '未知'} 不可拆分为键，整个文档作为一个值返回（只按 dataId 名称判断是否整体遮蔽；内容中只遮蔽 URL 密码 / token= / Authorization 等凭据样式，按键名的敏感值不会被识别）`);
  const masked = items.filter((x) => x.masked).length;
  if (masked) notes.push(`${masked} 个配置项的值或字段已遮蔽（按名称匹配敏感模式，或值中内嵌的 URL 密码 / token= 等凭据）`);
  if (truncated) notes.push(`文档中共 ${count} 个键，只返回按键名排序的前 ${items.length} 个`);
  notes.push('Nacos 没有键级修订：create_revision / mod_revision / version 为 null；文档级历史见 nacos.latest_history_id（config diff 的修订空间）');
  if (historyError) notes.push(`配置历史不可读（${historyError}），nacos.latest_history_id 为 null 不表示没有历史`);
  if (detail && docMasked) notes.push('文档含遮蔽值，nacos.md5 / content_bytes 不返回（与其余明文一起可用于校验被遮蔽的值或推算其长度）');
  if (client.authNote) notes.push(client.authNote);
  return {
    status: truncated ? 'partial' : 'success',
    data: {
      endpoint: client.id,
      provider: 'nacos',
      provider_selected_by: p.origin,
      service,
      env,
      prefix: c.base,
      key: relKey,
      revision_space: 'nacos-history-id',
      observed_revision: null,
      count,
      truncated,
      items,
      nacos: {
        namespace: c.namespace,
        group: c.group,
        data_id: c.dataId,
        exists: !!detail,
        type: detail?.type ?? null,
        content_format: doc.format,
        parsed: doc.parsed,
        parse_error: doc.parse_error,
        md5: docMasked ? null : (detail?.md5 ?? null),
        // like value_bytes: with the rest of the document shown, its size gives away the masked values' length
        content_bytes: detail && !docMasked ? Buffer.byteLength(detail.content, 'utf8') : null,
        last_modified: detail?.modifyTime ? new Date(detail.modifyTime).toISOString() : null,
        latest_history_id: latest,
      },
    },
    sources,
    coverage: { complete: !truncated, truncated, limit: relKey ? undefined : limit, scope: `Nacos ${client.id} 配置 ${c.base}`, notes },
  };
}

function docItems(content: string | null, format: DocFormat, c: Coords): { items: Map<string, Item>; raw: Map<string, string> } {
  if (content === null) return { items: new Map(), raw: new Map() };
  const doc = parseDoc(content, format, c.dataId);
  return { items: new Map(toItems(doc, c.base).map((x) => [x.name, x])), raw: doc.raw };
}

export async function nacosConfigDiff(ctx: Ctx, i: Record<string, any>, p: ProviderChoice, env: string, toArg: number | 'current'): Promise<Result> {
  const client = nacosClient(ctx, p.name);
  const service = String(i.service);
  const c = coords(client, env, service);
  const relKey = i.key ? checkRelKey(String(i.key)) : null;
  if (i.from_rev !== undefined && (!Number.isSafeInteger(i.from_rev) || i.from_rev < 0)) throw new WorkError('INVALID_ARGUMENT', `--from-rev 须为非负整数（Nacos 历史 ID）: ${i.from_rev}`);
  if (i.from_rev === undefined && !relKey) throw new WorkError('INVALID_ARGUMENT', '须指定 --from-rev（Nacos 历史 ID），或用 --key 与该键的上一版本比较', { hint: '历史 ID 见 config get 输出的 nacos.latest_history_id，或 Nacos 控制台“历史版本”' });
  const detail = await readConfig(client, c);
  const h = await listHistory(client, c);
  const recs = h.recs;
  const retention = await client.retentionDays();
  const sources = [await client.source(`GET /v1/cs/configs?show=all dataId=${c.dataId}`), await client.source(`${h.method} + GET ${h.method.startsWith('GET /v2') ? '/v2/cs/history?nid=' : '/v1/cs/history?nid='}（前像记录）`)];
  if (!recs.length) {
    throw new WorkError('DATA_UNAVAILABLE', `配置 ${c.base} 没有可读的历史记录`, {
      hint: `Nacos 历史只保留 ${retention ?? 30} 天（nacos.config.retention.days）；${detail ? '当前内容见 config get' : '配置文档也不存在，检查 --service / --env'}`,
      details: { retention_days: retention, exists: !!detail },
    });
  }
  const oldest = recs[0].id;
  const latest = recs[recs.length - 1].id;
  const format = docFormat(detail?.type ?? null, c.dataId);
  const current = detail?.content ?? null;
  const idxAt = (rev: number) => {
    let k = -1;
    for (let j = 0; j < recs.length; j++) if (recs[j].id <= rev) k = j;
    return k;
  };
  const beyond = (label: string, rev: number) =>
    new WorkError('DATA_UNAVAILABLE', `${label} ${rev} 早于${h.truncated ? '已读取（最近 500 条）' : '保留'}的最早历史记录 ${oldest}，该时刻的内容不可知`, {
      details: { requested_revision: rev, oldest_history_id: oldest, retention_days: retention, history_truncated: h.truncated },
      hint: h.truncated ? `该配置的历史超过 500 条，workctl 只读取最近 5 页；用 --from-rev ${oldest} 或更大的历史 ID` : `Nacos 历史只保留 ${retention ?? 30} 天；用 --from-rev ${oldest} 或更大的历史 ID`,
    });
  const ref = (k: number) => (k >= 0 ? { id: recs[k].id, op_type: recs[k].op, modified_at: recs[k].modified, src_user: recs[k].user } : null);
  const notes: string[] = [];
  let mode: 'revisions' | 'previous_version' = 'revisions';
  let fromRev: number;
  let toRev: number;
  let fromIdx: number;
  let toIdx: number;
  let fromContent: string | null;
  let toContent: string | null;
  if (i.from_rev === undefined) {
    mode = 'previous_version';
    if (toArg !== 'current') throw new WorkError('INVALID_ARGUMENT', '--key 上一版本模式只与当前内容比较，不能同时指定 --to-rev');
    const cur = docItems(current, format, c).raw.get(relKey!);
    if (cur === undefined) throw new WorkError('NOT_FOUND', `配置项当前不存在: ${c.base}#${relKey}`, { hint: '键已删除或从未写入；用 --from-rev 指定比较起点' });
    toIdx = recs.length - 1;
    toRev = latest;
    toContent = current;
    // walk back: the latest change after which the key had its current value and before which it differed
    let found = -1;
    let before: string | null = null;
    for (let k = recs.length - 1; k >= 0; k--) {
      const pre = recs[k].op === 'I' ? null : await historyContent(client, c, recs[k].id);
      const v = pre === null ? undefined : docItems(pre, format, c).raw.get(relKey!);
      if (v !== cur) {
        found = k;
        before = pre;
        break;
      }
    }
    if (found < 0) {
      // with the read cap hit, the change may lie in older records that were never read: say so, not "unchanged"
      if (h.truncated) {
        throw new WorkError('DATA_UNAVAILABLE', `已读取的最近 500 条历史记录（最早 ${oldest}）内配置项 ${relKey} 没有变更；该配置历史超过 500 条，更早的记录未读取，上一版本不可知（不代表保留期内未变更）`, {
          details: { oldest_history_id: oldest, retention_days: retention, history_truncated: true, history_records_read: recs.length },
          hint: `workctl 只读取最近 5 页（500 条）历史；用 --from-rev 指定历史 ID（≥ ${oldest}）比较整个文档，或在 Nacos 控制台“历史版本”中查看更早记录`,
        });
      }
      throw new WorkError('DATA_UNAVAILABLE', `保留期内（最早历史 ${oldest}）配置项 ${relKey} 没有变更，上一版本不可知`, { details: { oldest_history_id: oldest, retention_days: retention, history_truncated: false }, hint: '用 --from-rev 指定历史 ID 比较整个文档' });
    }
    fromIdx = found - 1;
    fromRev = recs[found].id - 1;
    fromContent = before;
    notes.push(`该键最近一次变化发生在历史记录 ${recs[found].id}（${recs[found].op}，${recs[found].modified ?? '时间未知'}）；与其前像比较`);
  } else {
    fromRev = i.from_rev;
    if (fromRev < oldest) throw beyond('--from-rev', fromRev);
    // ids are global: a --from-rev after this config's latest change is still a valid point (state = current)
    toRev = toArg === 'current' ? Math.max(latest, fromRev) : toArg;
    if (toRev < oldest) throw beyond('--to-rev', toRev);
    if (fromRev > toRev) throw new WorkError('INVALID_ARGUMENT', `--from-rev ${fromRev} 大于 --to-rev ${toRev}`);
    fromIdx = idxAt(fromRev);
    toIdx = idxAt(toRev);
    fromContent = await stateAfter(client, c, recs, fromIdx, current);
    toContent = await stateAfter(client, c, recs, toIdx, current);
    if (fromRev > latest) notes.push(`--from-rev ${fromRev} 晚于该配置最近一次变更 ${latest}，起点即当前内容`);
  }
  const a = docItems(fromContent, format, c);
  const b = docItems(toContent, format, c);
  const names = [...new Set([...a.raw.keys(), ...b.raw.keys()])].filter((n) => !relKey || n === relKey).sort();
  const changes: Change[] = [];
  const summary = { added: 0, removed: 0, changed: 0, unchanged: 0, rewritten_same_value: 0 };
  for (const n of names) {
    const x = a.items.get(n);
    const y = b.items.get(n);
    const masked = !!(x?.masked || y?.masked);
    const key = `${c.base}#${n}`;
    if (x && y) {
      if (a.raw.get(n) === b.raw.get(n)) summary.unchanged++;
      else {
        summary.changed++;
        changes.push({ name: n, key, change: 'changed', masked, old: side(x), new: side(y) });
      }
    } else if (y) {
      summary.added++;
      changes.push({ name: n, key, change: 'added', masked, old: null, new: side(y) });
    } else if (x) {
      summary.removed++;
      changes.push({ name: n, key, change: 'removed', masked, old: side(x), new: null });
    }
  }
  if (fromContent === null && mode === 'revisions') notes.push(`历史 ID ${fromRev} 时配置文档不存在（尚未创建或已删除）`);
  if (toContent === null) notes.push(`历史 ID ${toRev} 时配置文档不存在（已删除）`);
  if (fromRev === toRev) notes.push('起止历史 ID 相同，差异必然为空');
  if (changes.some((x) => x.masked)) notes.push('部分差异项的值已遮蔽（***），changed 依据原始内容判断');
  notes.push(`修订空间为 Nacos 配置历史 ID（全局递增的 nid）：起点/终点表示“不晚于该 ID 的最后一次变更生效后”的文档；只比较两个时刻，中间值不可见。历史保留 ${retention ?? '（未知，默认 30）'} 天`);
  if (h.truncated) notes.push('历史记录超过 500 条，只读取了前 5 页');
  if (client.authNote) notes.push(client.authNote);
  return {
    status: h.truncated ? 'partial' : 'success',
    data: {
      endpoint: client.id,
      provider: 'nacos',
      provider_selected_by: p.origin,
      service,
      env,
      prefix: c.base,
      key: relKey,
      revision_space: 'nacos-history-id',
      mode,
      from_revision: fromRev,
      to_revision: toRev,
      current_revision: latest,
      changes,
      summary,
      nacos: { namespace: c.namespace, group: c.group, data_id: c.dataId, from_history: ref(fromIdx), to_history: ref(toIdx), history_records: recs.length, oldest_history_id: oldest },
    },
    sources,
    coverage: { complete: !h.truncated, truncated: h.truncated, scope: `Nacos ${client.id} ${relKey ? `键 ${c.base}#${relKey}` : `配置 ${c.base}`}，历史 ID ${fromRev} → ${toRev}`, notes },
  };
}

export async function nacosDiscoveryList(ctx: Ctx, i: Record<string, any>, p: ProviderChoice): Promise<Result> {
  const client = nacosClient(ctx, p.name);
  const service = checkSegment('--service', String(i.service));
  const env = i.env ? checkSegment('--env', String(i.env)) : null;
  const vars = { service, env: env ?? ctx.env ?? '' };
  let namespace = fill(client.endpoint.str('discovery_namespace', client.endpoint.str('namespace', '${env}')), vars);
  if (namespace === 'public') namespace = '';
  const group = fill(client.endpoint.str('discovery_group', 'DEFAULT_GROUP'), vars);
  const sources: Source[] = [];
  const notes: string[] = [];
  // service detail: existence + clusters (absent service → "not registered", not an error)
  const svc = await client.get('/v1/ns/service', { serviceName: service, groupName: group, namespaceId: namespace }, true).catch((e) => {
    // 2.x answers an unknown service with HTTP 400 "service not found"
    if (e instanceof WorkError && /service not found/i.test(String(e.details?.nacos_message ?? ''))) return null;
    throw e;
  });
  sources.push(await client.source(`GET /v1/ns/service serviceName=${service} groupName=${group} namespaceId=${namespace || '(public)'}`));
  const exists = !!svc && !/service not found/i.test(svc.text);
  let hosts: Record<string, any>[] = [];
  let truncated = false;
  let total = 0;
  if (exists) {
    const clusters = ((svc!.json?.clusters ?? []) as { name?: string }[]).map((x) => String(x.name ?? '')).filter(Boolean);
    let viaCatalog = clusters.length > 0;
    let catalogError = false;
    try {
      for (const cl of clusters) {
        const r = await client.get('/v1/ns/catalog/instances', { serviceName: service, groupName: group, namespaceId: namespace, clusterName: cl, pageNo: '1', pageSize: String(MAX_KEYS) });
        const list = (r?.json?.list ?? []) as Record<string, any>[];
        // one page only: `count` is the cluster total
        if (Number(r?.json?.count) > list.length) truncated = true;
        total += Math.max(Number(r?.json?.count) || 0, list.length);
        hosts.push(...list);
      }
    } catch (e) {
      if (e instanceof WorkError && e.code === 'UNAUTHENTICATED') throw e;
      viaCatalog = false;
      catalogError = true;
      truncated = false;
      hosts = [];
    }
    if (viaCatalog) sources.push(await client.source('GET /v1/ns/catalog/instances（逐集群，含 enabled=false 实例）'));
    else {
      const r = await client.get('/v1/ns/instance/list', { serviceName: service, groupName: group, namespaceId: namespace, healthyOnly: 'false' });
      hosts = (r?.json?.hosts ?? []) as Record<string, any>[];
      sources.push(await client.source('GET /v1/ns/instance/list healthyOnly=false'));
      notes.push(`${catalogError ? '控制台目录接口不可用' : '服务详情未列出集群'}，改用 /v1/ns/instance/list：该接口不返回 enabled=false（已下线）的实例`);
    }
  }
  const excluded = { env_mismatch: 0, env_missing: 0, not_healthy: 0, disabled: 0 };
  const instances: Instance[] = [];
  for (const hst of hosts) {
    const meta = hst.metadata && typeof hst.metadata === 'object' ? (hst.metadata as Record<string, unknown>) : {};
    const dv = decodeValue(Buffer.from(JSON.stringify(meta)), '');
    const instEnv = meta.env === undefined ? null : String(meta.env);
    if (env) {
      if (instEnv === null) {
        excluded.env_missing++;
        continue;
      }
      if (instEnv !== env) {
        excluded.env_mismatch++;
        continue;
      }
    }
    const healthy = typeof hst.healthy === 'boolean' ? hst.healthy : null;
    if (i.healthy_only && healthy !== true) {
      excluded.not_healthy++;
      continue;
    }
    // enabled=false (taken offline) receives no traffic even when its health is true: not a healthy instance
    if (i.healthy_only && hst.enabled === false) {
      excluded.disabled++;
      continue;
    }
    const id = String(hst.instanceId ?? `${hst.ip}#${hst.port}#${hst.clusterName ?? 'DEFAULT'}#${group}@@${service}`);
    instances.push({
      instance_id: id,
      key: `${namespace || 'public'}/${group}@@${service}/${id}`,
      payload: dv.value,
      payload_error: null,
      address: hst.ip ? String(hst.ip) : null,
      port: Number.isFinite(Number(hst.port)) ? Number(hst.port) : null,
      version: meta.version === undefined ? null : String(meta.version),
      env: instEnv,
      healthy,
      health_basis: 'registry_health',
      registered_at: null,
      create_revision: null,
      mod_revision: null,
      lease: null,
      nacos: {
        cluster: hst.clusterName ? String(hst.clusterName) : null,
        weight: Number.isFinite(Number(hst.weight)) ? Number(hst.weight) : null,
        enabled: typeof hst.enabled === 'boolean' ? hst.enabled : null,
        ephemeral: typeof hst.ephemeral === 'boolean' ? hst.ephemeral : null,
      },
    });
  }
  instances.sort((x, y) => (x.instance_id < y.instance_id ? -1 : 1));
  const registered = truncated ? total : hosts.length;
  if (truncated) notes.push(`某集群实例数超过 ${MAX_KEYS}，只读取了每个集群的前 ${MAX_KEYS} 个`);
  if (!exists) notes.push(`服务 ${group}@@${service} 未在命名空间 ${namespace || 'public'} 注册（Nacos: service not found）`);
  else if (!registered) notes.push(`服务 ${group}@@${service} 已注册但没有实例（临时实例停止心跳/断开后会被摘除）`);
  else if (!instances.length) notes.push(`服务下有 ${registered} 个实例，过滤后为空`);
  const disabled = instances.filter((x) => x.nacos?.enabled === false).length;
  if (disabled) notes.push(`${disabled} 个实例 enabled=false（已下线，不接收流量，但仍在注册表中）；summary.healthy 不计入它们（见 summary.disabled），实例的 healthy 字段仍是服务端记录的健康状态`);
  if (excluded.disabled) notes.push(`--healthy-only 排除了 ${excluded.disabled} 个 enabled=false（已下线）的实例`);
  if (instances.some((x) => x.nacos?.ephemeral === false)) notes.push('持久实例（ephemeral=false）的健康由服务端主动探测（TCP/HTTP），不会自动删除');
  if (excluded.env_missing) notes.push(`${excluded.env_missing} 个实例 metadata 没有 env，按 --env 过滤时已排除`);
  notes.push('healthy 是 Nacos 服务端记录的健康状态（临时实例：心跳/连接；持久实例：服务端探测），不是 workctl 的探测');
  if (client.authNote) notes.push(client.authNote);
  const healthyN = instances.filter((x) => x.healthy === true && x.nacos?.enabled !== false).length;
  const unhealthyN = instances.filter((x) => x.healthy === false).length;
  const disabledHealthy = instances.filter((x) => x.healthy === true && x.nacos?.enabled === false).length;
  return {
    status: truncated ? 'partial' : 'success',
    data: {
      endpoint: client.id,
      provider: 'nacos',
      provider_selected_by: p.origin,
      service,
      env,
      prefix: `${namespace || 'public'}/${group}@@${service}`,
      observed_revision: null,
      instances,
      summary: { registered, returned: instances.length, healthy: healthyN, unhealthy: unhealthyN, health_unknown: instances.length - healthyN - unhealthyN - disabledHealthy, disabled, without_lease: 0, excluded, service_registered: exists },
    },
    sources,
    coverage: { complete: !truncated, truncated, scope: `Nacos ${client.id} 服务 ${namespace || 'public'}/${group}@@${service}`, notes },
  };
}

export async function nacosProbe(ctx: Ctx, name: string): Promise<{ ok: boolean; identity?: string; version?: string; detail?: string }> {
  const client = nacosClient(ctx, name);
  const st = await client.serverState();
  return {
    ok: true,
    identity: client.username && !client.authNote ? client.username : 'anonymous', // username ignored when auth is off
    version: st.version ? String(st.version) : undefined,
    detail: [`模式 ${st.startup_mode ?? st.standalone_mode ?? '未知'}`, `鉴权${String(st.auth_enabled) === 'true' ? '已开启' : '未开启'}`, st.config_retention_days ? `配置历史保留 ${st.config_retention_days} 天` : '', client.authNote ?? '']
      .filter(Boolean)
      .join('；'),
  };
}

