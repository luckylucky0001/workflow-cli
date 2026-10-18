import { WorkError, type Result, type Source } from '../../core/output';
import { formatDuration, windowFromNow, type Ctx } from '../../core/runtime';
import { shortId } from '../container/docker';
import { resolveEnv } from '../container/workload';
import { longTextNote, maskedNote, matches, type ContainerScan, type FilterStats, type LogEntry, type LogFilter } from './logs';
import {
  buildLogQuery,
  buildStatQueries,
  containerOf,
  isoToNs,
  LEVEL_LABEL,
  logqlString,
  lokiClient,
  normaliseLevel,
  pagedQuery,
  renderSelector,
  sumBy,
  type LogProviderChoice,
  type LokiClient,
  type LokiVectorSample,
} from './loki';
import { spanFromFields, type SpanLog, type SpanRecord } from './trace';

const containerKey = (m: Record<string, string>) => `${m.container ?? ''}|${m.container_id ?? ''}`;
const sumAll = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

function selectorFor(loki: LokiClient, choice: LogProviderChoice, service: string, env: string | null): { selector: string; origin: string } {
  if (choice.selector) return { selector: renderSelector(choice.selector, service, env), origin: `bindings: ${service}.attributes.log_selector` };
  const labels = loki.ep.cfg.labels;
  return {
    selector: renderSelector(labels, service, env),
    origin: labels === undefined ? `endpoints.loki.${loki.ep.name} 未配置 labels，使用默认 {service="$service"}` : `endpoints.loki.${loki.ep.name}.labels`,
  };
}

function lookbackNote(lb: { ms: number | null; origin: string }, win: { start: string; end: string }): string | null {
  if (!lb.ms) return null;
  const oldest = Date.parse(win.end) - lb.ms;
  if (Date.parse(win.start) < oldest) {
    return `窗口起点早于 Loki 保留期/查询回看上限 ${formatDuration(lb.ms)}（${lb.origin}）：${new Date(oldest).toISOString()} 之前的日志不可见`;
  }
  return null;
}

function ingestionNote(loki: LokiClient): string {
  const d = loki.ep.str('push_interval');
  return `Loki 中的日志在日志采集器（shipper）推送后才可见${d ? `（推送间隔约 ${d}）` : ''}：窗口末尾刚写入的日志可能尚未入库，与 Docker 直读相比末尾可能少几行`;
}

/** `log query` served by Loki; same output contract as the Docker path. */
export async function lokiLogQuery(ctx: Ctx, i: Record<string, any>, choice: LogProviderChoice): Promise<Result> {
  const limit = Number(i.limit);
  const loki = lokiClient(ctx, choice.endpoint);
  const env = resolveEnv(ctx, i.env);
  const { selector, origin } = selectorFor(loki, choice, i.service, env);
  const win = windowFromNow(i.window as number);
  const startNs = isoToNs(win.start);
  const endNs = isoToNs(win.end);
  const order = i.order as 'newest' | 'oldest';
  const direction = order === 'newest' ? 'backward' : 'forward';
  const filter: LogFilter = { minLevel: i.level, contains: i.contains, traceId: i.trace_id, includeSpans: !!i.include_spans };
  const query = buildLogQuery(selector, filter);
  const rangeS = Math.max(1, Math.ceil(Number(endNs - startNs) / 1e9));
  const sq = buildStatQueries(selector, filter, rangeS);
  // the shared filter re-checks every line; its counters are not the window stats (those come from Loki)
  const scratch: FilterStats = { lines: 0, unparsed: 0, spans_skipped: 0, unparsed_excluded_by_level: 0 };
  const statsP = Promise.all([
    loki.instant(sq.scanned, endNs),
    loki.instant(sq.matched, endNs),
    loki.instant(sq.unparsed, endNs),
    filter.includeSpans ? Promise.resolve([] as LokiVectorSample[]) : loki.instant(sq.spans, endNs),
  ]).then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  const [paged, st, lookback] = await Promise.all([
    pagedQuery(loki, query, { startNs, endNs }, direction, limit + 1, (e, full) => matches(e, full, filter, scratch)),
    statsP,
    loki.lookback(),
  ]);
  const warnings: string[] = [];
  const notes: string[] = [`日志 provider: loki（${choice.origin}）`, `流选择器: ${selector}（${origin}）`];

  const truncated = paged.matched.length > limit;
  const entries: LogEntry[] = paged.matched.slice(0, limit);

  let scannedBy = new Map<string, number>();
  let matchedBy = new Map<string, number>();
  let byLevel: Record<string, number> = {};
  let linesScanned = paged.fetched;
  let matchedTotal = entries.length + (truncated ? 1 : 0);
  let unparsed = entries.filter((e) => e.raw !== null).length;
  let spansSkipped = 0;
  const exactCounts = () => {
    byLevel = {};
    matchedBy = new Map();
    for (const e of entries) {
      byLevel[e.level ?? 'unknown'] = (byLevel[e.level ?? 'unknown'] ?? 0) + 1;
    }
  };
  if (st.ok) {
    const [scanned, matched, unp, spans] = st.r;
    scannedBy = sumBy(scanned, containerKey);
    linesScanned = sumAll(scannedBy);
    unparsed = sumAll(sumBy(unp, () => 'all'));
    spansSkipped = filter.includeSpans ? 0 : sumAll(sumBy(spans, () => 'all'));
    if (truncated) {
      matchedBy = sumBy(matched, containerKey);
      matchedTotal = sumAll(matchedBy);
      byLevel = Object.fromEntries(sumBy(matched, (m) => normaliseLevel(m[LEVEL_LABEL])));
      if (matchedTotal <= limit) {
        notes.push(`统计查询的 matched=${matchedTotal} 与日志查询（已超过 limit=${limit}）不一致：两次查询之间有新日志入库或窗口边界差异`);
        matchedTotal = limit + 1;
      }
    } else {
      // not truncated: the returned entries are the complete match set, count them exactly
      exactCounts();
      matchedTotal = entries.length;
      const statMatched = sumAll(sumBy(matched, () => 'all'));
      if (statMatched !== entries.length) notes.push(`统计查询 matched=${statMatched}，日志查询返回 ${entries.length} 条（两次查询之间有新日志入库或窗口边界差异），以返回条目为准`);
    }
    notes.push(`stats.lines_scanned / unparsed_lines / spans_skipped 来自 Loki count_over_time 统计查询（[${rangeS}s]，截至窗口终点）`);
  } else {
    exactCounts();
    const err = st.e instanceof Error ? st.e.message : String(st.e);
    warnings.push(`Loki 统计查询失败（${err}）：lines_scanned 只计已拉取行，unparsed_lines/spans_skipped 只计返回条目`);
  }
  if (!truncated) {
    for (const e of entries) {
      const key = [...paged.labels.entries()].find(([, l]) => containerOf(l) === e.container)?.[0] ?? `${e.container}|`;
      matchedBy.set(key, (matchedBy.get(key) ?? 0) + 1);
    }
  }

  // containers: one row per Loki stream identity (container name + container_id label)
  const keys = new Set<string>([...scannedBy.keys(), ...paged.labels.keys(), ...matchedBy.keys()]);
  if (!keys.size) {
    // no stream at all in the window: is the selector known to Loki at all?
    const lbMs = lookback.ms ?? 7 * 86_400_000;
    const seriesStart = endNs - BigInt(lbMs) * 1_000_000n;
    const series = await loki.series(selector, seriesStart, endNs);
    if (!series.length) {
      throw new WorkError('NOT_FOUND', `Loki 中没有匹配 ${selector} 的日志流（回看 ${formatDuration(lbMs)}）`, {
        hint: `检查 endpoints.loki.${loki.ep.name}.labels 映射与日志采集器（promtail）是否在推送该服务；或改用 Docker provider`,
        details: { selector, endpoint: loki.ep.id },
      });
    }
    notes.push(`窗口内没有日志行；Loki 在更早时间有 ${series.length} 个匹配的日志流`);
  }
  const labelsByKey = new Map<string, Record<string, string>>(paged.labels);
  const containers: ContainerScan[] = [...keys]
    .map((k) => {
      const [name, cid] = k.split('|');
      const l = labelsByKey.get(k);
      const cname = l ? containerOf(l) : name || '(无 container 标签)';
      return {
        name: cname,
        id: cid ? shortId(cid) : '',
        log_driver: null,
        created_at: '',
        started_at: null,
        lines_scanned: scannedBy.get(k) ?? 0,
        matched: matchedBy.get(k) ?? 0,
        status: 'ok' as const,
        note: `Loki 流 ${selector}${cid ? ` container_id=${shortId(cid)}` : ''}；容器创建/启动时间与日志驱动不在 Loki 中（created_at 为空）`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (new Set(containers.map((c) => c.name)).size < containers.length) {
    notes.push('同名容器出现多个 container_id：Loki 保留了已被重建/删除的旧容器的日志（Docker 直读看不到这些）');
  }

  notes.push(order === 'newest' ? '按时间倒序（最新在前）' : '按时间正序（最早在前）');
  if (truncated) notes.push(`匹配 ${matchedTotal} 条，只返回 ${entries.length} 条（--limit）`);
  if (spansSkipped && !filter.includeSpans) notes.push(`省略了 ${spansSkipped} 条 span 记录（--include-spans 返回，或用 trace get）`);
  const cut = entries.filter((e) => e.truncated).length;
  if (cut) notes.push(longTextNote(cut));
  const maskedN = entries.filter((e) => e.credentials_masked).length;
  if (maskedN) notes.push(maskedNote(maskedN));
  if (paged.streamUnknown) notes.push(`${paged.streamUnknown} 条日志所在的 Loki 流没有 stream 标签，stream 记为 stdout`);
  if (paged.clientRejected) notes.push(`LogQL 预过滤后有 ${paged.clientRejected} 行被本地过滤排除（口径差异，见指南）`);
  notes.push(ingestionNote(loki));
  const lbNote = lookbackNote(lookback, win);
  if (lbNote) notes.push(lbNote);
  let incomplete = false;
  if (!truncated && !paged.exhausted && paged.matched.length < limit + 1) {
    incomplete = true;
    notes.push(paged.stoppedAtSameTimestamp ? '同一时间戳的日志行超过单页上限，分页无法继续' : `分页达到上限（${paged.pages} 页、${paged.fetched} 行）仍未取完`);
  }

  const sources: Source[] = [await loki.source(`GET /loki/api/v1/query_range query=${query} direction=${direction} limit=${limit + 1}`)];
  if (st.ok) sources.push(await loki.source(`GET /loki/api/v1/query count_over_time（stats，[${rangeS}s]）`));
  return {
    data: {
      service: i.service,
      env,
      matched_by: `loki selector ${selector}（${origin}）`,
      window: win,
      order,
      entries,
      stats: {
        lines_scanned: linesScanned,
        matched: matchedTotal,
        returned: entries.length,
        unparsed_lines: unparsed,
        spans_skipped: spansSkipped,
        unparsed_excluded_by_level: filter.minLevel ? unparsed : 0,
        by_level: byLevel,
      },
      containers,
    },
    sources,
    coverage: {
      complete: !truncated && !incomplete,
      window: win,
      truncated,
      limit,
      scope: `Loki ${loki.ep.id} 流 ${selector}`,
      notes,
    },
    warnings,
  };
}

export interface LokiTraceScan {
  containers: string[];
  lines_scanned: number;
  spans: SpanRecord[];
  logs: SpanLog[];
  notes: string[];
  source: Source;
  /** span/log records whose text hit MAX_LOG_TEXT */
  truncated_lines: number;
  /** span/log records with masked credentials */
  masked_lines: number;
  /** the page budget ran out before all lines with the trace_id were read */
  incomplete: boolean;
}

/** Collect span records and trace logs of one service from Loki (`|= "<trace_id>"`). */
export async function lokiTraceScan(ctx: Ctx, service: string, traceId: string, win: { start: string; end: string }, choice: LogProviderChoice): Promise<LokiTraceScan> {
  const loki = lokiClient(ctx, choice.endpoint);
  const { selector, origin } = selectorFor(loki, choice, service, ctx.env);
  const startNs = isoToNs(win.start);
  const endNs = isoToNs(win.end);
  const rangeS = Math.max(1, Math.ceil(Number(endNs - startNs) / 1e9));
  const query = `${selector} |= ${logqlString(traceId)}`;
  const spans: SpanRecord[] = [];
  const logs: SpanLog[] = [];
  let truncatedLines = 0;
  let maskedLines = 0;
  const [paged, scanned] = await Promise.all([
    pagedQuery(loki, query, { startNs, endNs }, 'forward', Number.POSITIVE_INFINITY, (e) => {
      if (!e.fields || e.trace_id !== traceId) return false;
      if (e.truncated) truncatedLines++;
      if (e.credentials_masked) maskedLines++;
      if (e.kind === 'span') {
        const s = spanFromFields({ ...e.fields, trace_id: e.trace_id, span_id: e.span_id }, e.container);
        if (s) spans.push(s);
      } else logs.push({ ts: e.ts, level: e.level, msg: e.msg, span_id: e.span_id, container: e.container, fields: e.fields });
      return true;
    }),
    loki.instant(`sum by (container) (count_over_time(${selector}[${rangeS}s]))`, endNs).catch(() => null),
  ]);
  const notes = [`${service}: 日志 provider loki（${choice.origin}），流选择器 ${selector}（${origin}）`];
  const byContainer = scanned ? sumBy(scanned, (m) => m.container ?? '(无 container 标签)') : new Map<string, number>();
  if (!scanned) notes.push(`${service}: Loki 统计查询失败，lines_scanned 只计含 trace_id 的已拉取行`);
  if (!paged.exhausted) notes.push(`${service}: 含该 trace_id 的日志行超过扫描预算（${paged.pages} 页、${paged.fetched} 行），可能不完整`);
  const names = new Set<string>([...byContainer.keys(), ...[...paged.labels.values()].map(containerOf)]);
  return {
    containers: [...names].sort(),
    lines_scanned: scanned ? sumAll(byContainer) : paged.fetched,
    spans,
    logs,
    notes,
    truncated_lines: truncatedLines,
    masked_lines: maskedLines,
    incomplete: !paged.exhausted,
    source: await loki.source(`GET /loki/api/v1/query_range query=${query}（kind=span 记录重建）`, 'derived'),
  };
}
