/**
 * Rebuild a trace from structured log records (kind=span). This is a log-derived
 * view, not a tracing backend: only spans that were logged and are still retained
 * by the log driver can appear.
 */
export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  service: string | null;
  container: string;
  start: string;
  duration_ms: number;
  status: string | null;
  attributes: Record<string, unknown>;
}

export interface SpanLog {
  ts: string;
  level: string | null;
  msg: string | null;
  span_id: string | null;
  container: string;
  fields: Record<string, unknown>;
}

export interface TraceSpanView {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  service: string | null;
  container: string;
  depth: number;
  start: string;
  offset_ms: number;
  duration_ms: number;
  self_ms: number;
  pct_of_trace: number;
  status: string | null;
  attributes: Record<string, unknown>;
  children: string[];
  logs: { ts: string; level: string | null; msg: string | null; fields: Record<string, unknown> }[];
  orphan: boolean;
}

export interface TraceView {
  trace_id: string;
  start: string;
  end: string;
  duration_ms: number;
  span_count: number;
  services: string[];
  error_spans: number;
  roots: string[];
  external_parent: string | null;
  spans: TraceSpanView[];
  breakdown: { name: string; count: number; total_ms: number; self_ms: number; pct_of_trace: number }[];
  unattached_logs: { ts: string; level: string | null; msg: string | null; container: string }[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function spanFromFields(fields: Record<string, unknown>, container: string): SpanRecord | null {
  const { trace_id, span_id, name, start, duration_ms } = fields as Record<string, unknown>;
  if (typeof trace_id !== 'string' || typeof span_id !== 'string' || typeof name !== 'string' || typeof start !== 'string') return null;
  const d = Number(duration_ms);
  if (!Number.isFinite(d)) return null;
  return {
    trace_id,
    span_id,
    parent_span_id: typeof fields.parent_span_id === 'string' && fields.parent_span_id ? fields.parent_span_id : null,
    name,
    service: typeof fields.service === 'string' ? fields.service : null,
    container,
    start,
    duration_ms: d,
    status: typeof fields.status === 'string' ? fields.status : null,
    attributes: (fields.attributes as Record<string, unknown>) ?? {},
  };
}

export function buildTrace(traceId: string, spansIn: SpanRecord[], logs: SpanLog[]): TraceView {
  // de-duplicate (same span logged twice, e.g. overlapping scans)
  const byId = new Map<string, SpanRecord>();
  for (const s of spansIn) if (!byId.has(s.span_id)) byId.set(s.span_id, s);
  const spans = [...byId.values()];
  const startMs = Math.min(...spans.map((s) => Date.parse(s.start)));
  const endMs = Math.max(...spans.map((s) => Date.parse(s.start) + s.duration_ms));
  const children = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];
  for (const s of spans) {
    if (s.parent_span_id && byId.has(s.parent_span_id)) {
      const arr = children.get(s.parent_span_id) ?? [];
      arr.push(s);
      children.set(s.parent_span_id, arr);
    } else roots.push(s);
  }
  const byStart = (a: SpanRecord, b: SpanRecord) => Date.parse(a.start) - Date.parse(b.start) || b.duration_ms - a.duration_ms;
  roots.sort(byStart);
  for (const arr of children.values()) arr.sort(byStart);

  const rootDuration = roots.length === 1 ? roots[0].duration_ms : endMs - startMs;
  const total = Math.max(rootDuration, endMs - startMs);
  const logsBySpan = new Map<string, SpanLog[]>();
  const unattached: TraceView['unattached_logs'] = [];
  for (const l of logs) {
    if (l.span_id && byId.has(l.span_id)) {
      const arr = logsBySpan.get(l.span_id) ?? [];
      arr.push(l);
      logsBySpan.set(l.span_id, arr);
    } else unattached.push({ ts: l.ts, level: l.level, msg: l.msg, container: l.container });
  }

  const out: TraceSpanView[] = [];
  const walk = (s: SpanRecord, depth: number, orphan: boolean) => {
    const kids = children.get(s.span_id) ?? [];
    // self time: span duration minus the union of its children's intervals
    const st = Date.parse(s.start);
    const intervals = kids
      .map((k) => [Math.max(st, Date.parse(k.start)), Math.min(st + s.duration_ms, Date.parse(k.start) + k.duration_ms)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let curA = -Infinity;
    let curB = -Infinity;
    for (const [a, b] of intervals) {
      if (a > curB) {
        if (curB > curA) covered += curB - curA;
        curA = a;
        curB = b;
      } else curB = Math.max(curB, b);
    }
    if (curB > curA) covered += curB - curA;
    out.push({
      span_id: s.span_id,
      parent_span_id: s.parent_span_id,
      name: s.name,
      service: s.service,
      container: s.container,
      depth,
      start: s.start,
      offset_ms: r3(st - startMs),
      duration_ms: r3(s.duration_ms),
      self_ms: r3(Math.max(0, s.duration_ms - covered)),
      pct_of_trace: total > 0 ? Math.round((s.duration_ms / total) * 1000) / 10 : 0,
      status: s.status,
      attributes: s.attributes,
      children: kids.map((k) => k.span_id),
      logs: (logsBySpan.get(s.span_id) ?? []).map((l) => ({ ts: l.ts, level: l.level, msg: l.msg, fields: l.fields })),
      orphan,
    });
    for (const k of kids) walk(k, depth + 1, false);
  };
  for (const r of roots) walk(r, 0, roots.length > 1 && r.parent_span_id !== null);

  const agg = new Map<string, { count: number; total: number; self: number }>();
  for (const s of out) {
    const a = agg.get(s.name) ?? { count: 0, total: 0, self: 0 };
    a.count++;
    a.total += s.duration_ms;
    a.self += s.self_ms;
    agg.set(s.name, a);
  }
  const externalParents = [...new Set(roots.map((r) => r.parent_span_id).filter((p): p is string => !!p))];
  return {
    trace_id: traceId,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    duration_ms: r3(total),
    span_count: out.length,
    services: [...new Set(spans.map((s) => s.service).filter((x): x is string => !!x))],
    error_spans: out.filter((s) => s.status === 'error').length,
    roots: roots.map((r) => r.span_id),
    external_parent: externalParents.length === 1 && roots.length === 1 ? externalParents[0] : null,
    spans: out,
    breakdown: [...agg.entries()]
      .map(([name, a]) => ({ name, count: a.count, total_ms: r3(a.total), self_ms: r3(a.self), pct_of_trace: total > 0 ? Math.round((a.self / total) * 1000) / 10 : 0 }))
      .sort((a, b) => b.self_ms - a.self_ms),
    unattached_logs: unattached,
  };
}
