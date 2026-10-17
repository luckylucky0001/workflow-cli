import { z } from 'zod';
import { WorkError, type Source } from '../../../core/output';
import { defineCapability } from '../../../core/registry';
import { ADAPTER, AUTH_PROVIDER, GUIDE, ENDPOINT_KIND, assertIdentifier, bindingFor, isoFromPg, num, sensitiveColumns, withPg } from '../client';
import { COMMON_PREREQS, DATABASE_OPT, INSTANCE, SCHEMA, TABLE } from '../inputs';

const KEY_SETTINGS = [
  'max_connections',
  'superuser_reserved_connections',
  'shared_buffers',
  'work_mem',
  'maintenance_work_mem',
  'effective_cache_size',
  'max_wal_size',
  'wal_level',
  'autovacuum',
  'track_activities',
  'track_counts',
  'track_io_timing',
  'track_activity_query_size',
  'statement_timeout',
  'idle_in_transaction_session_timeout',
  'log_min_duration_statement',
  'default_transaction_read_only',
  'server_encoding',
  'TimeZone',
  'shared_preload_libraries',
  'pg_stat_statements.track',
  'pg_stat_statements.max',
];

const BindingSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    env: z.string().nullable(),
    owner: z.string().nullable(),
    labels: z.record(z.string(), z.string()),
    attributes: z.record(z.string(), z.unknown()),
  })
  .nullable()
  .describe('平台元数据（资源绑定文件），不是引擎查询结果');

const SettingSchema = z.object({
  value: z.string().describe('pg_settings.setting 原值（单位见 unit）'),
  unit: z.string().nullable(),
  display: z.string().describe('current_setting() 的人类可读值，如 128MB'),
  source: z.string().nullable(),
  pending_restart: z.boolean(),
});

export const instanceGet = defineCapability({
  name: 'postgres.instance.get',
  command: 'pg instance get',
  summary: '查看 PostgreSQL 实例概况：版本、运行时长、关键参数、连接使用、主备角色、已安装扩展，并附平台绑定元数据',
  domain: 'postgres',
  inputs: { instance: INSTANCE },
  output: z.object({
    instance: z.string(),
    binding: BindingSchema,
    engine: z.object({
      version: z.string().describe('server_version'),
      version_num: z.number(),
      version_full: z.string().describe('version() 全文'),
      current_user: z.string(),
      connected_database: z.string(),
      started_at: z.string().nullable(),
      uptime_s: z.number().nullable(),
      in_recovery: z.boolean().describe('pg_is_in_recovery()：true 表示备库（standby）'),
      role: z.enum(['primary', 'standby']),
    }),
    settings: z.record(z.string(), SettingSchema).describe('关键参数；当前角色看不到的参数（如 shared_preload_libraries 需 pg_read_all_settings）不出现，见 hidden_settings'),
    hidden_settings: z.array(z.string()).describe('请求了但对当前角色不可见或不存在的参数'),
    connections: z.object({
      max_connections: z.number().nullable(),
      superuser_reserved: z.number().nullable(),
      client_backends: z.number().describe('pg_stat_activity 中 backend_type=client backend 的数量（含 workctl 自身）'),
      by_state: z.record(z.string(), z.number()),
      usage_ratio: z.number().nullable().describe('client_backends / (max_connections − superuser_reserved)'),
    }),
    replication: z.object({
      replicas_connected: z.number().nullable().describe('主库：pg_stat_replication 行数；备库为 null'),
      last_replay_at: z.string().nullable().describe('备库：pg_last_xact_replay_timestamp()'),
    }),
    extensions: z.array(z.object({ name: z.string(), version: z.string(), schema: z.string() })).describe('当前连接库中已 CREATE EXTENSION 的扩展（扩展按库安装）'),
    observability: z.object({
      pg_stat_statements_installed: z.boolean().describe('当前库已 CREATE EXTENSION pg_stat_statements'),
      pg_stat_statements_loaded: z.boolean().nullable().describe('已通过 shared_preload_libraries 加载；null 表示无法判断'),
      track_counts: z.boolean().nullable(),
      track_io_timing: z.boolean().nullable(),
    }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: COMMON_PREREQS,
  notes: [
    'binding 来自资源绑定文件（平台元数据，relation=explicit），engine/settings/connections 来自引擎实时查询，两者分开标注',
    '扩展按库安装：extensions 只反映当前连接的库（--instance 端点配置的 database）',
    '连接数是瞬时快照；累计计数（提交/回滚/死锁）见 pg database list，是自统计重置以来的累计值',
  ],
  examples: ['workctl pg instance get --instance demo-postgres'],
  handler: async (ctx, i) =>
    withPg(ctx, i.instance, async (s) => {
      const [base] = await s.query(
        `SELECT version() AS version_full, pg_postmaster_start_time() AS started_at,
                EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint AS uptime_s, pg_is_in_recovery() AS in_recovery`,
      );
      const settingsRows = await s.query(`SELECT name, setting, unit, source, pending_restart, current_setting(name) AS display FROM pg_settings WHERE name = ANY($1::text[])`, [KEY_SETTINGS]);
      const settings: Record<string, z.infer<typeof SettingSchema>> = {};
      for (const r of settingsRows) {
        settings[String(r.name)] = { value: String(r.setting), unit: r.unit ?? null, display: String(r.display), source: r.source ?? null, pending_restart: r.pending_restart === true };
      }
      const hidden = KEY_SETTINGS.filter((k) => !(k in settings));
      const act = await s.query(`SELECT coalesce(state, 'unknown') AS state, count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1`);
      const byState = Object.fromEntries(act.map((r) => [String(r.state), Number(r.n)]));
      const clients = act.reduce((a, r) => a + Number(r.n), 0);
      const maxConn = num(settings.max_connections?.value);
      const reserved = num(settings.superuser_reserved_connections?.value);
      const inRecovery = base.in_recovery === true;
      let replicas: number | null = null;
      let lastReplay: string | null = null;
      if (inRecovery) {
        const [r] = await s.query('SELECT pg_last_xact_replay_timestamp() AS ts');
        lastReplay = isoFromPg(r?.ts);
      } else {
        const [r] = await s.query('SELECT count(*)::int AS n FROM pg_stat_replication');
        replicas = num(r?.n);
      }
      const ext = await s.query('SELECT e.extname, e.extversion, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname');
      const pssInstalled = ext.some((e) => e.extname === 'pg_stat_statements');
      let pssLoaded: boolean | null = null;
      if (settings.shared_preload_libraries) pssLoaded = /(^|[\s,"])pg_stat_statements([\s,"]|$)/.test(settings.shared_preload_libraries.value);
      else if (settings['pg_stat_statements.max']) pssLoaded = true; // the module's GUCs only exist once it is loaded
      const { binding, source: bsrc } = bindingFor(ctx, ENDPOINT_KIND, s.ep.name);
      const sources: Source[] = [s.src('version(); pg_settings; pg_stat_activity; pg_is_in_recovery(); pg_extension')];
      if (bsrc) sources.push(bsrc);
      const usable = maxConn !== null ? maxConn - (reserved ?? 0) : null;
      return {
        data: {
          instance: s.ep.name,
          binding,
          engine: {
            version: s.version,
            version_num: s.versionNum,
            version_full: String(base.version_full),
            current_user: s.user,
            connected_database: s.database,
            started_at: isoFromPg(base.started_at),
            uptime_s: num(base.uptime_s),
            in_recovery: inRecovery,
            role: inRecovery ? ('standby' as const) : ('primary' as const),
          },
          settings,
          hidden_settings: hidden,
          connections: {
            max_connections: maxConn,
            superuser_reserved: reserved,
            client_backends: clients,
            by_state: byState,
            usage_ratio: usable && usable > 0 ? Math.round((clients / usable) * 10000) / 10000 : null,
          },
          replication: { replicas_connected: replicas, last_replay_at: lastReplay },
          extensions: ext.map((e) => ({ name: String(e.extname), version: String(e.extversion), schema: String(e.nspname) })),
          observability: {
            pg_stat_statements_installed: pssInstalled,
            pg_stat_statements_loaded: pssLoaded,
            track_counts: settings.track_counts ? settings.track_counts.value === 'on' : null,
            track_io_timing: settings.track_io_timing ? settings.track_io_timing.value === 'on' : null,
          },
        },
        sources,
        coverage: {
          complete: hidden.length === 0,
          notes: [
            ...(binding ? [] : ['资源绑定中没有该端点的平台元数据（binding=null）']),
            ...(hidden.length ? [`以下参数对角色 ${s.user} 不可见或不存在: ${hidden.join(', ')}（如 shared_preload_libraries 需 pg_read_all_settings）`] : []),
            '连接数为瞬时快照',
          ],
        },
      };
    }),
});

export const databaseList = defineCapability({
  name: 'postgres.database.list',
  command: 'pg database list',
  summary: '列出实例中的数据库：大小、连接数、事务/缓存/死锁累计计数与统计重置时间、事务 ID 年龄',
  domain: 'postgres',
  inputs: {
    instance: INSTANCE,
    include_templates: { type: 'bool', default: false, description: '包含 template0 / template1' },
  },
  output: z.object({
    instance: z.string(),
    databases: z.array(
      z.object({
        name: z.string(),
        owner: z.string().nullable(),
        encoding: z.string(),
        collate: z.string().nullable(),
        is_template: z.boolean(),
        allow_connections: z.boolean(),
        connection_limit: z.number().nullable().describe('-1 表示不限'),
        can_connect: z.boolean().describe('当前角色是否有 CONNECT 权限'),
        size_bytes: z.number().nullable().describe('pg_database_size；无 CONNECT 权限且非 pg_read_all_stats 时为 null'),
        backends: z.number().nullable().describe('当前连接数（瞬时）'),
        xact_commit: z.number().nullable(),
        xact_rollback: z.number().nullable(),
        blks_read: z.number().nullable(),
        blks_hit: z.number().nullable(),
        cache_hit_ratio: z.number().nullable().describe('blks_hit/(blks_hit+blks_read)，累计值计算，不是窗口值'),
        deadlocks: z.number().nullable(),
        temp_bytes: z.number().nullable(),
        stats_reset: z.string().nullable().describe('以上累计计数的起点；null 表示自 initdb 以来从未重置'),
        xid_age: z.number().nullable().describe('age(datfrozenxid)，接近 20 亿需关注回卷'),
      }),
    ),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: COMMON_PREREQS,
  notes: [
    'xact_commit / blks_hit / deadlocks / temp_bytes 等来自 pg_stat_database，是自 stats_reset（或 initdb）以来的累计值，不是窗口值',
    'backends 是瞬时值；size_bytes 是调用时的实际大小',
  ],
  examples: ['workctl pg database list --instance demo-postgres'],
  handler: async (ctx, i) =>
    withPg(ctx, i.instance, async (s) => {
      const rows = await s.query(
        `SELECT d.datname, pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding, d.datcollate,
                d.datistemplate, d.datallowconn, d.datconnlimit, has_database_privilege(d.oid, 'CONNECT') AS can_connect,
                CASE WHEN has_database_privilege(d.oid, 'CONNECT') OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
                     THEN pg_database_size(d.oid) END AS size_bytes,
                sd.numbackends, sd.xact_commit, sd.xact_rollback, sd.blks_read, sd.blks_hit, sd.deadlocks, sd.temp_bytes, sd.stats_reset,
                age(d.datfrozenxid) AS xid_age
           FROM pg_database d LEFT JOIN pg_stat_database sd ON sd.datid = d.oid
          WHERE $1::boolean OR NOT d.datistemplate
          ORDER BY d.datname`,
        [i.include_templates === true],
      );
      return {
        data: {
          instance: s.ep.name,
          databases: rows.map((r) => {
            const hit = num(r.blks_hit);
            const read = num(r.blks_read);
            return {
              name: String(r.datname),
              owner: r.owner ?? null,
              encoding: String(r.encoding),
              collate: r.datcollate ?? null,
              is_template: r.datistemplate === true,
              allow_connections: r.datallowconn === true,
              connection_limit: num(r.datconnlimit),
              can_connect: r.can_connect === true,
              size_bytes: num(r.size_bytes),
              backends: num(r.numbackends),
              xact_commit: num(r.xact_commit),
              xact_rollback: num(r.xact_rollback),
              blks_read: read,
              blks_hit: hit,
              cache_hit_ratio: hit !== null && read !== null && hit + read > 0 ? Math.round((hit / (hit + read)) * 10000) / 10000 : null,
              deadlocks: num(r.deadlocks),
              temp_bytes: num(r.temp_bytes),
              stats_reset: isoFromPg(r.stats_reset),
              xid_age: num(r.xid_age),
            };
          }),
        },
        sources: [s.src('pg_database LEFT JOIN pg_stat_database')],
        coverage: { complete: true, notes: ['计数类字段为自 stats_reset 以来的累计值；backends 为瞬时值', ...(i.include_templates ? [] : ['未包含模板库（加 --include-templates）'])] },
      };
    }),
});

const IndexSchema = z.object({
  name: z.string(),
  definition: z.string().describe('pg_get_indexdef'),
  primary: z.boolean(),
  unique: z.boolean(),
  valid: z.boolean().describe('false 表示 CREATE INDEX CONCURRENTLY 失败留下的无效索引'),
  columns: z.array(z.string()),
  size_bytes: z.number().nullable(),
  idx_scan: z.number().nullable().describe('自统计重置以来的索引扫描次数（累计）'),
  idx_tup_read: z.number().nullable(),
  idx_tup_fetch: z.number().nullable(),
  last_idx_scan: z.string().nullable().describe('PG16+：最近一次使用该索引的时间'),
});

export const tableGet = defineCapability({
  name: 'postgres.table.get',
  command: 'pg table get',
  summary: '查看表结构、索引、大小与表级统计（扫描次数、活/死元组估计、最近 vacuum/analyze）',
  domain: 'postgres',
  inputs: { instance: INSTANCE, database: DATABASE_OPT, schema: SCHEMA, table: TABLE },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    schema: z.string(),
    table: z.string(),
    kind: z.string().describe('relkind：table / partitioned table / view / materialized view / foreign table'),
    comment: z.string().nullable(),
    access: z.object({ select: z.boolean().describe('当前角色对该表是否有 SELECT 权限（目录元数据对所有角色可见，与能否读数据无关）') }),
    size: z.object({
      heap_bytes: z.number().nullable().describe('pg_relation_size：主数据文件'),
      table_bytes: z.number().nullable().describe('pg_table_size：含 TOAST / FSM / VM，不含索引'),
      indexes_bytes: z.number().nullable(),
      total_bytes: z.number().nullable().describe('pg_total_relation_size'),
    }),
    rows_estimate: z.number().nullable().describe('pg_class.reltuples：ANALYZE/VACUUM 时的估计值；-1 表示从未 ANALYZE'),
    columns: z.array(
      z.object({
        name: z.string(),
        position: z.number(),
        type: z.string(),
        nullable: z.boolean(),
        default: z.string().nullable(),
        identity: z.string().nullable().describe('a=ALWAYS, d=BY DEFAULT'),
        comment: z.string().nullable(),
        sensitive: z.boolean().describe('列名命中端点 sensitive_columns（query run 会脱敏）'),
      }),
    ),
    indexes: z.array(IndexSchema),
    stats: z
      .object({
        seq_scan: z.number().nullable(),
        seq_tup_read: z.number().nullable(),
        idx_scan: z.number().nullable(),
        idx_tup_fetch: z.number().nullable(),
        n_tup_ins: z.number().nullable(),
        n_tup_upd: z.number().nullable(),
        n_tup_del: z.number().nullable(),
        n_tup_hot_upd: z.number().nullable(),
        n_live_tup: z.number().nullable().describe('估计值'),
        n_dead_tup: z.number().nullable().describe('估计值'),
        dead_ratio: z.number().nullable().describe('n_dead_tup/(n_live_tup+n_dead_tup)'),
        n_mod_since_analyze: z.number().nullable(),
        last_vacuum: z.string().nullable(),
        last_autovacuum: z.string().nullable(),
        last_analyze: z.string().nullable(),
        last_autoanalyze: z.string().nullable(),
        vacuum_count: z.number().nullable(),
        autovacuum_count: z.number().nullable(),
        analyze_count: z.number().nullable(),
        autoanalyze_count: z.number().nullable(),
      })
      .nullable()
      .describe('pg_stat_user_tables；扫描/增删改计数是自统计重置以来的累计值'),
    stats_reset: z.string().nullable().describe('所在库 pg_stat_database.stats_reset：累计计数的起点（null=自 initdb 以来未重置）'),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'CONNECT on 目标库；系统目录对所有角色可见，所以没有 SELECT 权限也能看到结构（access.select=false）'],
  notes: [
    'n_live_tup / n_dead_tup / reltuples 是估计值；seq_scan / idx_scan / n_tup_* 是自统计重置以来的累计值，不是窗口值',
    '名称区分大小写，按实际对象名给出（不加双引号）；表不存在返回 NOT_FOUND',
    'seq_scan 远大于 idx_scan 且表不小，常见于缺索引；结合 pg query explain 确认',
  ],
  examples: ['workctl pg table get --instance demo-postgres --database demo_orders --table orders', 'workctl pg table get --instance demo-postgres --schema public --table order_items'],
  handler: async (ctx, i) => {
    const schema = assertIdentifier('schema', String(i.schema ?? 'public'));
    const table = assertIdentifier('table', String(i.table));
    if (i.database !== undefined) assertIdentifier('database', String(i.database));
    return withPg(
      ctx,
      i.instance,
      async (s) => {
        const [t] = await s.query(
          `SELECT c.oid, c.relkind, c.reltuples, obj_description(c.oid, 'pg_class') AS comment,
                  has_table_privilege(c.oid, 'SELECT') AS can_select,
                  pg_relation_size(c.oid) AS heap_bytes, pg_table_size(c.oid) AS table_bytes,
                  pg_indexes_size(c.oid) AS indexes_bytes, pg_total_relation_size(c.oid) AS total_bytes
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
          [schema, table],
        );
        if (!t) {
          const near = await s.query(
            `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE lower(c.relname) = lower($1) AND c.relkind IN ('r','p','v','m','f') LIMIT 5`,
            [table],
          );
          throw new WorkError('NOT_FOUND', `表不存在: ${s.database}.${schema}.${table}`, {
            hint: near.length ? `同名（忽略大小写）对象: ${near.map((r) => r.name).join(', ')}` : '用 workctl pg query run 查询 information_schema.tables 查看可见表',
          });
        }
        const cols = await s.query(
          `SELECT a.attname, a.attnum, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def,
                  NULLIF(a.attidentity, '') AS identity, col_description(a.attrelid, a.attnum) AS comment
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
          [t.oid],
        );
        const lastIdxScan = s.versionNum >= 160000 ? 'su.last_idx_scan' : 'NULL::timestamptz';
        const idx = await s.query(
          `SELECT ic.relname AS name, pg_get_indexdef(x.indexrelid) AS def, x.indisprimary, x.indisunique, x.indisvalid,
                  pg_relation_size(x.indexrelid) AS size_bytes, su.idx_scan, su.idx_tup_read, su.idx_tup_fetch, ${lastIdxScan} AS last_idx_scan,
                  ARRAY(SELECT CASE WHEN k.attnum = 0 THEN pg_get_indexdef(x.indexrelid, k.ord::int, true) ELSE a.attname::text END
                          FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                          LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
                         WHERE k.ord <= x.indnkeyatts ORDER BY k.ord) AS columns
             FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
             LEFT JOIN pg_stat_all_indexes su ON su.indexrelid = x.indexrelid
            WHERE x.indrelid = $1 ORDER BY x.indisprimary DESC, ic.relname`,
          [t.oid],
        );
        const [st] = await s.query(
          `SELECT seq_scan, seq_tup_read, idx_scan, idx_tup_fetch, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd, n_live_tup, n_dead_tup,
                  n_mod_since_analyze, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze, vacuum_count, autovacuum_count,
                  analyze_count, autoanalyze_count
             FROM pg_stat_all_tables WHERE relid = $1`,
          [t.oid],
        );
        const [db] = await s.query('SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()');
        const sens = sensitiveColumns(s.ep);
        const live = num(st?.n_live_tup);
        const dead = num(st?.n_dead_tup);
        const KIND: Record<string, string> = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table' };
        return {
          data: {
            instance: s.ep.name,
            database: s.database,
            schema,
            table,
            kind: KIND[String(t.relkind)] ?? String(t.relkind),
            comment: t.comment ?? null,
            access: { select: t.can_select === true },
            size: { heap_bytes: num(t.heap_bytes), table_bytes: num(t.table_bytes), indexes_bytes: num(t.indexes_bytes), total_bytes: num(t.total_bytes) },
            rows_estimate: num(t.reltuples),
            columns: cols.map((c) => ({
              name: String(c.attname),
              position: Number(c.attnum),
              type: String(c.type),
              nullable: c.attnotnull !== true,
              default: c.def ?? null,
              identity: c.identity ?? null,
              comment: c.comment ?? null,
              sensitive: sens.has(String(c.attname).toLowerCase()),
            })),
            indexes: idx.map((x) => ({
              name: String(x.name),
              definition: String(x.def),
              primary: x.indisprimary === true,
              unique: x.indisunique === true,
              valid: x.indisvalid === true,
              columns: (x.columns ?? []).map(String),
              size_bytes: num(x.size_bytes),
              idx_scan: num(x.idx_scan),
              idx_tup_read: num(x.idx_tup_read),
              idx_tup_fetch: num(x.idx_tup_fetch),
              last_idx_scan: isoFromPg(x.last_idx_scan),
            })),
            stats: st
              ? {
                  seq_scan: num(st.seq_scan),
                  seq_tup_read: num(st.seq_tup_read),
                  idx_scan: num(st.idx_scan),
                  idx_tup_fetch: num(st.idx_tup_fetch),
                  n_tup_ins: num(st.n_tup_ins),
                  n_tup_upd: num(st.n_tup_upd),
                  n_tup_del: num(st.n_tup_del),
                  n_tup_hot_upd: num(st.n_tup_hot_upd),
                  n_live_tup: live,
                  n_dead_tup: dead,
                  dead_ratio: live !== null && dead !== null && live + dead > 0 ? Math.round((dead / (live + dead)) * 10000) / 10000 : null,
                  n_mod_since_analyze: num(st.n_mod_since_analyze),
                  last_vacuum: isoFromPg(st.last_vacuum),
                  last_autovacuum: isoFromPg(st.last_autovacuum),
                  last_analyze: isoFromPg(st.last_analyze),
                  last_autoanalyze: isoFromPg(st.last_autoanalyze),
                  vacuum_count: num(st.vacuum_count),
                  autovacuum_count: num(st.autovacuum_count),
                  analyze_count: num(st.analyze_count),
                  autoanalyze_count: num(st.autoanalyze_count),
                }
              : null,
            stats_reset: isoFromPg(db?.stats_reset),
          },
          sources: [s.src('pg_class / pg_attribute / pg_index / pg_stat_all_tables / pg_stat_all_indexes / pg_*_size()')],
          coverage: {
            complete: true,
            notes: [
              'n_live_tup / n_dead_tup / rows_estimate 为估计值；seq_scan / idx_scan / n_tup_* 为自 stats_reset 以来的累计值',
              ...(t.can_select === true ? [] : [`角色 ${s.user} 对该表没有 SELECT 权限：结构来自系统目录（对所有角色可见），数据查询会返回 PERMISSION_DENIED`]),
              ...(st ? [] : ['该对象没有表级统计（视图等）']),
            ],
          },
        };
      },
      { database: i.database },
    );
  },
});
