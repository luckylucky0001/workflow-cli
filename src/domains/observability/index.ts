import { z } from 'zod';
import { source, WorkError, type Result, type Source } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import { formatDuration, windowFromNow, type Ctx } from '../../core/runtime';
import { dockerClient, type ContainerInspect } from '../container/docker';
import { listServiceContainers, resolveEnv, selectionNotes, type ServiceContainers } from '../container/workload';
import { BoundedCollector, matches, parseLogLine, scanContainerLogs, type ContainerScan, type FilterStats, type LogEntry } from './logs';
import { lokiClient, resolveLogProvider } from './loki';
import { lokiLogQuery, lokiTraceScan } from './loki-query';
import { catalog, promClient, renderQuery, summarize, type MatrixSeries } from './prometheus';
import { buildTrace, spanFromFields, type SpanLog, type SpanRecord } from './trace';

const GUIDE = 'docs/guides/observability.md';
const WindowSchema = z.object({ start: z.string(), end: z.string() });

// ---------------------------------------------------------------------------
// metric query / metric list
// ---------------------------------------------------------------------------
const MAX_POINTS = 11_000;

const metricQuery = defineCapability({
  name: 'observability.metric.query',
  command: 'metric query',
  domain: 'observability',
  summary: '查询资源的时间序列指标（Prometheus query_range），返回数据点与窗口内 min/max/avg/last',
  description: '--metric 通过 profile 中 Prometheus 端点的 metrics 目录解析为 PromQL（$service 替换为资源 ID）；也可用 --promql 直接查询。',
  inputs: {
    resource: { type: 'string', description: '资源 ID（如服务 demo-order），替换指标模板中的 $service' },
    metric: { type: 'string', description: '指标目录中的名称，如 request_latency、cache_hit_ratio（见 metric list）' },
    promql: { type: 'string', description: '直接给出 PromQL（与 --metric 二选一）' },
    window: { type: 'duration', default: '15m', description: '查询窗口（截至当前）' },
    step: { type: 'duration', default: '15s', description: '采样步长' },
    endpoint: { type: 'string', description: 'Prometheus 端点名（默认取 profile defaults.prometheus）' },
  },
  output: z.object({
    resource: z.string().nullable(),
    metric: z.string().nullable(),
    promql: z.string(),
    unit: z.string().nullable(),
    description: z.string().nullable(),
    window: WindowSchema,
    step_seconds: z.number(),
    result_type: z.string(),
    series: z.array(
      z.object({
        labels: z.record(z.string(), z.string()),
        points: z.array(z.tuple([z.string(), z.number().nullable()])).describe('[时间, 值]；null 表示 NaN 或 ±Inf，分别计入 nan_points / inf_points'),
        summary: z.object({
          points: z.number(),
          nan_points: z.number(),
          inf_points: z.number().describe('+Inf/-Inf 点数（如分位数落在最大有限桶之上）；不计入 min/max/avg'),
          min: z.number().nullable(),
          max: z.number().nullable(),
          avg: z.number().nullable(),
          last: z.number().nullable(),
          last_at: z.string().nullable(),
        }),
      }),
    ),
    empty: z.boolean().describe('窗口内没有任何样本'),
  }),
  adapter: 'prometheus-http-api',
  operation: 'read',
  auth_provider: 'none',
  guide: GUIDE,
  prerequisites: ['profile 配置 endpoints.prometheus.<name>.url', '指标目录 endpoints.prometheus.<name>.metrics（使用 --metric 时）'],
  notes: [
    '窗口内没有样本时返回 success + 空 series（empty=true），与 Prometheus 不可达（UPSTREAM_UNAVAILABLE）区分',
    '比率类指标在分母为零（窗口内无请求）时 Prometheus 返回 NaN，输出为 null 并计入 nan_points',
    'rate() 已处理计数器重置；目录中的查询窗口（如 [1m]）决定平滑程度',
  ],
  examples: [
    'workctl metric query --resource demo-order --metric request_latency --window 15m',
    "workctl metric query --resource demo-order --promql 'sum by (route) (rate(http_requests_total{service=\"demo-order\"}[1m]))'",
  ],
  handler: async (ctx, i): Promise<Result> => {
    if (!i.metric && !i.promql) throw new WorkError('INVALID_ARGUMENT', '需要 --metric 或 --promql', { hint: 'workctl metric list --resource <id> 查看可用指标' });
    if (i.metric && i.promql) throw new WorkError('INVALID_ARGUMENT', '--metric 与 --promql 只能二选一');
    const prom = promClient(ctx, i.endpoint);
    let promql: string;
    let unit: string | null = null;
    let description: string | null = null;
    const warnings: string[] = [];
    if (i.metric) {
      if (!i.resource) throw new WorkError('INVALID_ARGUMENT', '--metric 需要 --resource');
      const entry = catalog(prom.ep).find((m) => m.name === i.metric);
      if (!entry) {
        throw new WorkError('INVALID_ARGUMENT', `指标目录中没有 ${i.metric}`, {
          hint: `可用: ${catalog(prom.ep).map((m) => m.name).join(', ') || '(目录为空)'}；或用 --promql`,
        });
      }
      promql = renderQuery(entry.query, i.resource);
      unit = entry.unit;
      description = entry.description;
    } else promql = String(i.promql);
    if (i.resource) {
      try {
        const store = ctx.resources();
        if (store.configured && !store.get(i.resource)) warnings.push(`资源绑定中没有 ${i.resource}；仍按标签值查询`);
      } catch {
        /* bindings optional */
      }
    }
    const windowMs = i.window as number;
    const stepMs = i.step as number;
    if (stepMs < 1000) throw new WorkError('INVALID_ARGUMENT', '--step 不能小于 1s');
    if (windowMs / stepMs > MAX_POINTS) {
      throw new WorkError('INVALID_ARGUMENT', `窗口/步长产生的点数超过 ${MAX_POINTS}`, { hint: '增大 --step 或缩小 --window' });
    }
    const now = new Date();
    // align end to the step so repeated queries hit the same evaluation timestamps
    const endS = Math.floor(now.getTime() / stepMs) * (stepMs / 1000);
    const startS = endS - windowMs / 1000;
    const win = { start: new Date(startS * 1000).toISOString(), end: new Date(endS * 1000).toISOString() };
    const r = await prom.get<{ resultType: string; result: MatrixSeries[] }>('/api/v1/query_range', {
      query: promql,
      start: String(startS),
      end: String(endS),
      step: `${stepMs / 1000}s`,
    });
    warnings.push(...r.warnings.map((w) => `Prometheus: ${w}`));
    const series = (r.data.result ?? []).map((s) => {
      const { points, summary } = summarize(s.values ?? []);
      return { labels: s.metric ?? {}, points, summary };
    });
    const expected = Math.floor(windowMs / stepMs) + 1;
    const notes = [`窗口 ${formatDuration(windowMs)}，步长 ${formatDuration(stepMs)}，每条序列最多 ${expected} 个点`];
    if (!series.length) notes.push('no samples in window：窗口内没有匹配的样本（目标未被抓取、标签不匹配或该时段无数据）');
    for (const s of series) {
      if (s.summary.points < expected) notes.push(`序列 ${JSON.stringify(s.labels)} 只有 ${s.summary.points}/${expected} 个点（抓取缺失或序列中途出现/消失）`);
      if (s.summary.nan_points) notes.push(`序列 ${JSON.stringify(s.labels)} 有 ${s.summary.nan_points} 个 NaN 点（通常是分母为零：窗口内无请求）`);
      if (s.summary.inf_points) {
        notes.push(`序列 ${JSON.stringify(s.labels)} 有 ${s.summary.inf_points} 个 ±Inf 点（输出为 null，不计入 min/max/avg）；histogram_quantile 返回 +Inf 表示分位数超过最大有限桶上界，是极高值而不是缺数据`);
      }
    }
    return {
      data: {
        resource: i.resource ?? null,
        metric: i.metric ?? null,
        promql,
        unit,
        description,
        window: win,
        step_seconds: stepMs / 1000,
        result_type: r.data.resultType,
        series,
        empty: series.length === 0,
      },
      sources: [
        await prom.source(`GET /api/v1/query_range query=${promql}`),
        ...(i.metric ? [source('workctl', 'metric-catalog', { endpoint: prom.ep.id, method: `metrics.${i.metric}`, relation: 'explicit' })] : []),
      ],
      coverage: { complete: true, window: win, notes },
      warnings,
    };
  },
});

const metricList = defineCapability({
  name: 'observability.metric.list',
  command: 'metric list',
  domain: 'observability',
  summary: '列出 profile 中配置的指标目录（名称、含义、单位、渲染后的 PromQL）',
  inputs: {
    resource: { type: 'string', description: '资源 ID，用于渲染 $service 模板' },
    endpoint: { type: 'string', description: 'Prometheus 端点名' },
  },
  output: z.object({
    endpoint: z.string(),
    resource: z.string().nullable(),
    metrics: z.array(z.object({ name: z.string(), description: z.string().nullable(), unit: z.string().nullable(), query_template: z.string(), query: z.string().nullable() })),
  }),
  adapter: 'prometheus-http-api',
  operation: 'read',
  auth_provider: 'none',
  guide: GUIDE,
  notes: ['目录来自 workctl 配置，不代表 Prometheus 中一定有数据；用 metric query 验证'],
  examples: ['workctl metric list --resource demo-order'],
  handler: async (ctx, i): Promise<Result> => {
    const ep = ctx.endpoint('prometheus', i.endpoint);
    const metrics = catalog(ep).map((m) => ({
      name: m.name,
      description: m.description,
      unit: m.unit,
      query_template: m.query,
      query: i.resource ? renderQuery(m.query, i.resource) : null,
    }));
    return {
      data: { endpoint: ep.id, resource: i.resource ?? null, metrics },
      sources: [source('workctl', 'metric-catalog', { endpoint: ep.id, method: `profiles.${ctx.profileName}.endpoints.prometheus.${ep.name}.metrics`, relation: 'explicit' })],
      coverage: { complete: true, scope: `端点 ${ep.id} 的指标目录` },
      warnings: metrics.length ? [] : [`端点 ${ep.id} 未配置 metrics 目录`],
    };
  },
});

// ---------------------------------------------------------------------------
// log query
// ---------------------------------------------------------------------------
const LogEntrySchema = z.object({
  ts: z.string().describe('Docker 记录的时间戳'),
  container: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  level: z.string().nullable(),
  msg: z.string().nullable(),
  kind: z.string().nullable(),
  trace_id: z.string().nullable(),
  span_id: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()).nullable().describe('JSON 日志的其余字段；非 JSON 行为 null'),
  raw: z.string().nullable().describe('非 JSON 行的原文'),
});

const ContainerScanSchema = z.object({
  name: z.string(),
  id: z.string(),
  log_driver: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  lines_scanned: z.number(),
  matched: z.number(),
  status: z.enum(['ok', 'collection_disabled', 'error']),
  note: z.string().nullable(),
});

async function inspectAll(ctx: Ctx, sc: ServiceContainers): Promise<ContainerInspect[]> {
  const docker = dockerClient(ctx);
  return Promise.all(sc.containers.map((c) => docker.getJson<ContainerInspect>(`/containers/${c.Id}/json`)));
}

function retentionNotes(scans: ContainerScan[], win: { start: string; end: string }, inspects: ContainerInspect[]): string[] {
  const notes: string[] = [];
  for (const s of scans) {
    if (Date.parse(s.created_at) > Date.parse(win.start)) {
      notes.push(`${s.name} 创建于 ${s.created_at}，窗口内更早时段的日志不在该容器中（若之前的容器已被重建删除，其日志不可见）`);
    }
    const insp = inspects.find((x) => x.Id.startsWith(s.id));
    const cfg = insp?.HostConfig?.LogConfig?.Config ?? {};
    if (cfg['max-size']) notes.push(`${s.name} 日志驱动 ${s.log_driver} 配置了轮转（max-size=${cfg['max-size']}, max-file=${cfg['max-file'] ?? '1'}），较早日志可能已被轮转删除`);
    if (s.status !== 'ok') notes.push(`${s.name}: ${s.note}`);
  }
  return notes;
}

const logQuery = defineCapability({
  name: 'observability.log.query',
  command: 'log query',
  domain: 'observability',
  summary: '查询服务容器在时间窗口内的日志（解析结构化 JSON，按级别/关键字/trace_id 过滤）',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID（按容器标签解析容器）' },
    env: { type: 'string', description: '环境；默认取 profile 的 env' },
    window: { type: 'duration', default: '15m', description: '回看窗口' },
    level: { type: 'enum', enum: ['debug', 'info', 'warn', 'error', 'fatal'], description: '最低级别（error 返回 error 和 fatal）' },
    contains: { type: 'string', description: '原始行包含的子串（区分大小写）' },
    trace_id: { type: 'string', description: '只返回该 trace 的日志' },
    include_spans: { type: 'bool', default: false, description: '是否返回 kind=span 的 span 记录（默认省略，用 trace get 查看）' },
    order: { type: 'enum', enum: ['newest', 'oldest'], default: 'newest', description: 'newest：返回最新的 N 条并按时间倒序；oldest：返回最早的 N 条并按时间正序' },
    limit: { type: 'int', default: 200, description: '最多返回条数（1-2000）' },
  },
  output: z.object({
    service: z.string(),
    env: z.string().nullable(),
    matched_by: z.string().describe('匹配容器所用的选择器（标签或资源绑定中的精确容器名）'),
    window: WindowSchema,
    order: z.enum(['newest', 'oldest']),
    entries: z.array(LogEntrySchema),
    stats: z.object({
      lines_scanned: z.number(),
      matched: z.number(),
      returned: z.number(),
      unparsed_lines: z.number().describe('非 JSON 行（原文保留在 raw）'),
      spans_skipped: z.number(),
      unparsed_excluded_by_level: z.number().describe('因无法确定级别而被 --level 排除的非 JSON 行'),
      by_level: z.record(z.string(), z.number()).describe('匹配条目的级别分布'),
    }),
    containers: z.array(ContainerScanSchema),
  }),
  adapter: 'docker-engine-api|loki-http-api',
  operation: 'read',
  auth_provider: 'docker-socket',
  guide: GUIDE,
  prerequisites: ['容器日志驱动支持读取（json-file / local / journald）', 'endpoints.docker 可访问'],
  notes: [
    '日志来自 Docker /containers/{id}/logs（stdout+stderr 多路复用流已解帧）；保留期取决于日志驱动与轮转配置，容器重建后旧日志不可见',
    '默认 order=newest：返回窗口内最新的 limit 条，按时间倒序；truncated=true 表示匹配条数超过 limit',
    'provider 由资源绑定 attributes.log_provider 或 profile defaults.logs 决定（docker 默认 | loki）；Loki 经 LogQL query_range 查询，输出契约相同，差异（入库延迟、保留期、limit 口径）见指南',
  ],
  examples: [
    'workctl log query --service demo-order --window 15m --level error',
    'workctl log query --service demo-order --trace-id <trace_id> --include-spans',
  ],
  handler: async (ctx, i): Promise<Result> => {
    const limit = Number(i.limit);
    if (limit < 1 || limit > 2000) throw new WorkError('INVALID_ARGUMENT', '--limit 取值 1-2000');
    const provider = resolveLogProvider(ctx, i.service);
    if (provider.kind === 'loki') return lokiLogQuery(ctx, i, provider);
    const docker = dockerClient(ctx);
    const env = resolveEnv(ctx, i.env);
    const sc = await listServiceContainers(ctx, docker, i.service, env);
    if (!sc.containers.length) {
      throw new WorkError('NOT_FOUND', `没有容器匹配 ${sc.tried.map((t) => t.matched_by).join(' / ')}${env ? `（env=${env}）` : ''}`, { hint: `workctl container workload get --service ${i.service}` });
    }
    const inspects = await inspectAll(ctx, sc);
    const win = windowFromNow(i.window as number);
    const order = i.order as 'newest' | 'oldest';
    const stats: FilterStats = { lines: 0, unparsed: 0, spans_skipped: 0, unparsed_excluded_by_level: 0 };
    const collector = new BoundedCollector(limit, order);
    const byLevel: Record<string, number> = {};
    const filter = { minLevel: i.level, contains: i.contains, traceId: i.trace_id, includeSpans: !!i.include_spans };
    const scans: ContainerScan[] = [];
    for (const insp of inspects) {
      let matchedHere = 0;
      const scan = await scanContainerLogs(ctx, docker, insp, win, (line, stream, container) => {
        const e = parseLogLine(line, container, stream);
        if (e.raw !== null) stats.unparsed++;
        if (!matches(e, line, filter, stats)) return;
        matchedHere++;
        byLevel[e.level ?? 'unknown'] = (byLevel[e.level ?? 'unknown'] ?? 0) + 1;
        collector.add(e);
      });
      scan.matched = matchedHere;
      scans.push(scan);
    }
    const disabled = scans.filter((s) => s.status === 'collection_disabled');
    if (disabled.length === scans.length) {
      throw new WorkError('COLLECTION_DISABLED', `服务 ${i.service} 的容器日志不可通过 Docker API 读取`, {
        hint: '日志驱动需为 json-file/local/journald，或改用 Loki provider（profile defaults.logs: loki）',
        details: { containers: scans.map((s) => ({ name: s.name, driver: s.log_driver, note: s.note })) },
      });
    }
    let entries: LogEntry[] = collector.entries();
    if (order === 'newest') entries = entries.reverse();
    const scanned = scans.reduce((a, s) => a + s.lines_scanned, 0);
    const truncated = collector.matched > entries.length;
    const failed = scans.filter((s) => s.status !== 'ok');
    const notes = [
      ...selectionNotes(sc),
      ...retentionNotes(scans, win, inspects),
      order === 'newest' ? '按时间倒序（最新在前）' : '按时间正序（最早在前）',
    ];
    if (truncated) notes.push(`匹配 ${collector.matched} 条，只返回 ${entries.length} 条（--limit）`);
    if (stats.spans_skipped && !i.include_spans) notes.push(`省略了 ${stats.spans_skipped} 条 span 记录（--include-spans 返回，或用 trace get）`);
    return {
      status: failed.length ? 'partial' : 'success',
      data: {
        service: i.service,
        env,
        matched_by: sc.selector.matched_by,
        window: win,
        order,
        entries: entries.map((e) => ({ ...e })),
        stats: {
          lines_scanned: scanned,
          matched: collector.matched,
          returned: entries.length,
          unparsed_lines: stats.unparsed,
          spans_skipped: stats.spans_skipped,
          unparsed_excluded_by_level: stats.unparsed_excluded_by_level,
          by_level: byLevel,
        },
        containers: scans,
      },
      sources: [await docker.source('GET /containers/{id}/logs?stdout=1&stderr=1&timestamps=1&since&until')],
      coverage: {
        complete: !truncated && !failed.length,
        window: win,
        truncated,
        limit,
        scope: `容器: ${scans.map((s) => s.name).join(', ')}`,
        notes,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// trace get (log-derived)
// ---------------------------------------------------------------------------
const traceGet = defineCapability({
  name: 'observability.trace.get',
  command: 'trace get',
  domain: 'observability',
  summary: '按 trace_id 从结构化日志重建调用链（span 树、总耗时、各 span 自身耗时占比）',
  description: '扫描资源绑定中服务的容器日志，收集 kind=span 记录与带 trace_id 的日志行，重建父子关系。这是日志派生视图，不是追踪后端。',
  inputs: {
    id: { type: 'string', required: true, description: 'trace_id（32 位十六进制，见响应头 x-trace-id 或日志）' },
    window: { type: 'duration', default: '1h', description: '扫描日志的回看窗口' },
    service: { type: 'string', description: '只扫描该服务的容器（默认扫描资源绑定中全部 service）' },
  },
  output: z.object({
    trace_id: z.string(),
    start: z.string(),
    end: z.string(),
    duration_ms: z.number(),
    span_count: z.number(),
    services: z.array(z.string()),
    error_spans: z.number(),
    roots: z.array(z.string()),
    cyclic_parents: z.array(z.string()).describe('父子关系成环的 span（日志数据异常），已提升为根以免丢失'),
    external_parent: z.string().nullable().describe('根 span 的父 span 不在日志中（来自外部调用方）'),
    spans: z.array(
      z.object({
        span_id: z.string(),
        parent_span_id: z.string().nullable(),
        name: z.string(),
        service: z.string().nullable(),
        container: z.string(),
        depth: z.number(),
        start: z.string(),
        offset_ms: z.number(),
        duration_ms: z.number(),
        self_ms: z.number().describe('扣除子 span 覆盖时间后的自身耗时'),
        pct_of_trace: z.number(),
        status: z.string().nullable(),
        attributes: z.record(z.string(), z.unknown()),
        children: z.array(z.string()),
        logs: z.array(z.object({ ts: z.string(), level: z.string().nullable(), msg: z.string().nullable(), fields: z.record(z.string(), z.unknown()) })),
        orphan: z.boolean(),
      }),
    ),
    breakdown: z.array(z.object({ name: z.string(), count: z.number(), total_ms: z.number(), self_ms: z.number(), pct_of_trace: z.number().describe('自身耗时占整条 trace 的百分比') })),
    unattached_logs: z.array(z.object({ ts: z.string(), level: z.string().nullable(), msg: z.string().nullable(), container: z.string() })),
    scanned: z.array(z.object({ service: z.string(), containers: z.array(z.string()), lines_scanned: z.number() })),
  }),
  adapter: 'docker-engine-api|loki-http-api',
  operation: 'diagnose',
  auth_provider: 'docker-socket',
  guide: GUIDE,
  prerequisites: ['服务输出结构化 span 日志（kind=span, trace_id, span_id, parent_span_id, start, duration_ms）', '容器日志仍在保留期内'],
  notes: [
    'relation=derived：由日志重建，只包含被记录且仍保留的 span；未打点的耗时体现为父 span 的 self_ms',
    '找不到时返回 NOT_FOUND；可扩大 --window 或确认 trace_id',
    '日志来源按服务的日志 provider（docker 默认 | loki）；Loki 下以 |= "<trace_id>" 拉取后用同一逻辑重建',
    'Jaeger / Tempo 等追踪后端是规划中的 provider',
  ],
  examples: ['workctl trace get --id 0d9ae006bb776f65c5bcca19759fce81 --window 1h'],
  handler: async (ctx, i): Promise<Result> => {
    const id = String(i.id).toLowerCase();
    if (!/^[0-9a-f]{16,32}$/.test(id)) throw new WorkError('INVALID_ARGUMENT', `trace_id 格式不正确: ${i.id}`, { hint: '16-32 位十六进制' });
    let services: string[];
    if (i.service) services = [i.service];
    else {
      const store = ctx.resources();
      services = store.list({ type: 'service', env: ctx.env ?? undefined }).filter((r) => r.type === 'service').map((r) => r.id);
      if (!services.length) throw new WorkError('NOT_CONFIGURED', '资源绑定中没有 service，无法确定扫描范围', { hint: '用 --service 指定服务' });
    }
    const win = windowFromNow(i.window as number);
    const spans: SpanRecord[] = [];
    const logs: SpanLog[] = [];
    const scanned: { service: string; containers: string[]; lines_scanned: number }[] = [];
    const notes: string[] = [];
    const lokiSources: Source[] = [];
    let dockerUsed = false;
    for (const svc of services) {
      const provider = resolveLogProvider(ctx, svc);
      if (provider.kind === 'loki') {
        const ls = await lokiTraceScan(ctx, svc, id, win, provider);
        spans.push(...ls.spans);
        logs.push(...ls.logs);
        notes.push(...ls.notes);
        scanned.push({ service: svc, containers: ls.containers, lines_scanned: ls.lines_scanned });
        if (!lokiSources.some((x) => x.endpoint === ls.source.endpoint)) lokiSources.push(ls.source);
        continue;
      }
      dockerUsed = true;
      const docker = dockerClient(ctx);
      const sc = await listServiceContainers(ctx, docker, svc, resolveEnv(ctx, undefined));
      const inspects = await inspectAll(ctx, sc);
      let lines = 0;
      const names: string[] = [];
      for (const insp of inspects) {
        const scan = await scanContainerLogs(
          ctx,
          docker,
          insp,
          win,
          (line, stream, container) => {
            const e = parseLogLine(line, container, stream);
            if (!e.fields || e.trace_id !== id) return;
            if (e.kind === 'span') {
              const s = spanFromFields({ ...e.fields, trace_id: e.trace_id, span_id: e.span_id }, container);
              if (s) spans.push(s);
            } else logs.push({ ts: e.ts, level: e.level, msg: e.msg, span_id: e.span_id, container, fields: e.fields });
          },
          { prefilter: id },
        );
        lines += scan.lines_scanned;
        names.push(scan.name);
        if (scan.status !== 'ok') notes.push(`${scan.name}: ${scan.note}`);
      }
      scanned.push({ service: svc, containers: names, lines_scanned: lines });
    }
    if (!spans.length) {
      throw new WorkError('NOT_FOUND', `在 ${formatDuration(i.window as number)} 窗口内的日志中没有 trace ${id} 的 span 记录${logs.length ? `（找到 ${logs.length} 条相关日志但没有 span）` : ''}`, {
        hint: '扩大 --window（如 6h），或用 --service 指定产生该 trace 的服务；trace_id 可从响应头 x-trace-id 或 log query 获取',
        details: { scanned, window: win },
      });
    }
    const view = buildTrace(id, spans, logs);
    if (view.roots.length > 1) notes.push(`有 ${view.roots.length} 个根 span（部分父 span 不在已扫描日志中）`);
    if (view.external_parent) notes.push(`根 span 的父 span ${view.external_parent} 来自未记录日志的调用方`);
    if (view.cyclic_parents.length) notes.push(`span 父子关系成环（${view.cyclic_parents.join(', ')}），日志中的 parent_span_id 不可信，相关层级仅供参考`);
    return {
      data: { ...view, scanned },
      sources: [...(dockerUsed ? [await dockerClient(ctx).source('GET /containers/{id}/logs（kind=span 记录重建）', 'derived')] : []), ...lokiSources],
      coverage: {
        complete: view.roots.length === 1 && view.cyclic_parents.length === 0,
        window: win,
        scope: `服务: ${services.join(', ')} 的${dockerUsed && lokiSources.length ? '容器日志 / Loki 日志' : lokiSources.length ? ' Loki 日志' : '容器日志'}`,
        notes: [...notes, '日志派生的调用链：只包含已记录且仍保留的 span'],
      },
    };
  },
});

// ---------------------------------------------------------------------------
// planned
// ---------------------------------------------------------------------------
const quotaGet = defineCapability({
  name: 'observability.quota.get',
  command: 'quota get',
  domain: 'observability',
  summary: '查看命名空间/项目的资源配额与使用（规划中：Kubernetes ResourceQuota、云配额）',
  adapter: 'quota-provider (待接入)',
  operation: 'read',
  auth_provider: 'tbd',
  guide: GUIDE,
  status: 'planned',
});

export default defineDomain({
  name: 'observability',
  title: '可观测性',
  summary: '指标（Prometheus）、日志（Docker 容器日志 / Loki）与日志派生调用链；Jaeger / Tempo 规划中',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: 'skills/service-latency-investigation/SKILL.md',
  capabilities: [metricQuery, metricList, logQuery, traceGet, quotaGet],
  probes: {
    prometheus: async (ctx, name) => {
      const prom = promClient(ctx, name);
      const v = await prom.version();
      if (!v) return { ok: false, detail: 'buildinfo 不可用' };
      return { ok: true, version: v };
    },
    loki: async (ctx, name) => {
      const loki = lokiClient(ctx, name);
      const [v, ready] = await Promise.all([loki.version(), loki.ready()]);
      if (!v) return { ok: false, detail: `buildinfo 不可用；/ready: ${ready.detail}` };
      return { ok: ready.ok, version: v, detail: `/ready: ${ready.detail}`, ...(loki.ep.str('tenant') ? { identity: `tenant ${loki.ep.str('tenant')}` } : {}) };
    },
  },
});

