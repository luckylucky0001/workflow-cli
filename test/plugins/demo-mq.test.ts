import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Kafka, logLevel, type Admin } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { installPlugin, loadPlugins, PluginManifestSchema } from '../../src/core/plugins';
import { Registry } from '../../src/core/registry';
import { HANDLERS } from '../../plugins/demo-mq/src/capabilities';
import { mapKafkaError, requireTopicName, resolveEndpoint } from '../../plugins/demo-mq/src/kafka';
import { computePartitionLag, parseOffset, summarizeTopic, summarizeTotals } from '../../plugins/demo-mq/src/lag';
import { buildManifest, CAPABILITIES } from '../../plugins/demo-mq/src/manifest';
import { RequestSchema, serializeResponse, successResponse } from '../../plugins/demo-mq/src/protocol';
import { OUTPUT_SCHEMAS } from '../../plugins/demo-mq/src/schemas';

const pluginDir = resolve(__dirname, '..', '..', 'plugins', 'demo-mq');
const entry = join(pluginDir, 'dist', 'plugin.mjs');
const tgz = join(pluginDir, 'dist', 'demo-mq-plugin.tgz');

describe('demo-mq lag arithmetic', () => {
  it('parses kafkajs offsets; -1 means no committed offset', () => {
    expect(parseOffset('42')).toBe(42);
    expect(parseOffset('-1')).toBeNull();
    expect(parseOffset('')).toBeNull();
    expect(parseOffset(undefined)).toBeNull();
    expect(parseOffset(0)).toBe(0);
    expect(() => parseOffset('9007199254740993')).toThrow(RangeError);
  });

  it('lag = end - committed for a normal partition', () => {
    const r = computePartitionLag({ partition: 0, committed: 36, end: 91, logStart: 0 });
    expect(r).toMatchObject({ lag: 55, state: 'ok', committed_offset: 36, end_offset: 91, assigned_member: null });
    expect(r.explanation).toBeUndefined();
    expect(computePartitionLag({ partition: 0, committed: 91, end: 91, logStart: 0 }).lag).toBe(0);
  });

  it('no committed offset: lag is null and explained, never 0 or end', () => {
    for (const committed of [null, -1]) {
      const r = computePartitionLag({ partition: 2, committed, end: 100, logStart: 0 });
      expect(r.lag).toBeNull();
      expect(r.committed_offset).toBeNull();
      expect(r.state).toBe('no_committed_offset');
      expect(r.explanation).toContain('auto.offset.reset');
    }
  });

  it('committed before log start keeps offset lag but explains deleted messages', () => {
    const r = computePartitionLag({ partition: 0, committed: 2, end: 10, logStart: 4 });
    expect(r.lag).toBe(8);
    expect(r.state).toBe('committed_before_log_start');
    expect(r.explanation).toContain('2 个位点');
    expect(r.explanation).toContain('积压为 6');
  });

  it('committed ahead of end and unknown end are not computed', () => {
    expect(computePartitionLag({ partition: 0, committed: 50, end: 10, logStart: 0 })).toMatchObject({ lag: null, state: 'committed_ahead_of_end' });
    expect(computePartitionLag({ partition: 0, committed: 5, end: null, logStart: null })).toMatchObject({ lag: null, state: 'end_offset_unavailable' });
  });

  it('summarises topics and totals, excluding unknown lag from sums', () => {
    const t = summarizeTopic('orders', [
      { partition: 2, committed: null, end: 102, logStart: 0 },
      { partition: 0, committed: 36, end: 91, logStart: 0, assignedTo: 'c-1' },
      { partition: 1, committed: 42, end: 107, logStart: 0 },
    ]);
    expect(t.partitions.map((p) => p.partition)).toEqual([0, 1, 2]);
    expect(t.partitions[0].assigned_member).toBe('c-1');
    expect(t.total_lag).toBe(55 + 65);
    expect(t.partitions_with_commit).toBe(2);
    expect(t.partitions_without_commit).toBe(1);
    const other = summarizeTopic('payments', [{ partition: 0, committed: 0, end: 70, logStart: 0 }]);
    const totals = summarizeTotals([t, other]);
    expect(totals).toMatchObject({ topics: 2, partitions: 4, total_lag: 190, partitions_lag_unknown: 1, partitions_without_commit: 1 });
    expect(totals.max_partition_lag).toEqual({ topic: 'payments', partition: 0, lag: 70 });
    expect(summarizeTotals([])).toMatchObject({ total_lag: 0, max_partition_lag: null });
  });
});

describe('demo-mq protocol and error mapping', () => {
  const req = RequestSchema.parse({
    protocol: 'workctl-plugin/1',
    capability: 'mq.topic.list',
    inputs: {},
    endpoints: { kafka: { 'demo-mq': { brokers: ['127.0.0.1:19092'], client_id: 'workctl' }, 'sasl-mq': { brokers: 'a:1,b:2', sasl_mechanism: 'plain', sasl_username: 'u' } } },
    defaults: { kafka: 'demo-mq' },
  });

  it('resolves endpoints by cluster name, falling back to defaults.kafka', () => {
    expect(resolveEndpoint(req, 'demo-mq').label).toBe('kafka/demo-mq');
    expect(resolveEndpoint(req, undefined).name).toBe('demo-mq');
    expect(() => resolveEndpoint(req, 'nope')).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
    // SASL configured without a password reference
    expect(() => resolveEndpoint(req, 'sasl-mq')).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('validates topic names', () => {
    expect(requireTopicName('demo.order.events')).toBe('demo.order.events');
    expect(() => requireTopicName('bad topic')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => requireTopicName('')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('maps kafkajs errors to stable codes', () => {
    const ctx = { cluster: 'demo-mq', topic: 't', group: 'g' };
    const proto = (type: string) => Object.assign(new Error(type), { name: 'KafkaJSProtocolError', type });
    expect(mapKafkaError(proto('UNKNOWN_TOPIC_OR_PARTITION'), ctx).code).toBe('NOT_FOUND');
    expect(mapKafkaError(proto('GROUP_AUTHORIZATION_FAILED'), ctx).code).toBe('PERMISSION_DENIED');
    expect(mapKafkaError(proto('SASL_AUTHENTICATION_FAILED'), ctx).code).toBe('UNAUTHENTICATED');
    expect(mapKafkaError(proto('REQUEST_TIMED_OUT'), ctx).code).toBe('TIMEOUT');
    expect(mapKafkaError(proto('COORDINATOR_NOT_AVAILABLE'), ctx).code).toBe('UPSTREAM_UNAVAILABLE');
    const refused = Object.assign(new Error('Connection error: connect ECONNREFUSED'), { name: 'KafkaJSNumberOfRetriesExceeded' });
    (refused as any).cause = Object.assign(new Error('connect ECONNREFUSED'), { name: 'KafkaJSConnectionError', code: 'ECONNREFUSED' });
    const mapped = mapKafkaError(refused, ctx);
    expect(mapped.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapped.details?.errno).toBe('ECONNREFUSED');
    expect(mapKafkaError(new TypeError('boom'), ctx).code).toBe('INTERNAL');
  });
});

describe('demo-mq manifest', () => {
  const manifest = buildManifest();

  it('is accepted by the core plugin manifest schema', () => {
    const parsed = PluginManifestSchema.safeParse(manifest);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('every available capability has a handler and an output schema; planned ones have neither', () => {
    for (const c of CAPABILITIES) {
      expect(c.name.startsWith('mq.')).toBe(true);
      if (c.status === 'available') {
        expect(HANDLERS[c.name], c.name).toBeTypeOf('function');
        expect(OUTPUT_SCHEMAS[c.name], c.name).toBeDefined();
        expect(c.output_schema).toBe(`schemas/${c.name}.v1.json`);
      } else {
        expect(HANDLERS[c.name]).toBeUndefined();
        expect(c.output_schema).toBeUndefined();
      }
      for (const k of Object.keys(c.inputs)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(CAPABILITIES.find((c) => c.name === 'mq.queue.get')?.status).toBe('planned');
    expect((manifest.compatibility as any).engines[0].verified.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Live: spawn the bundled plugin against the demo Kafka broker (demo-kafka, localhost:19092)
// ---------------------------------------------------------------------------------------------
interface PluginOut {
  stdout: string;
  stderr: string;
  code: number | null;
  json: any;
}

function runPlugin(capability: string, inputs: Record<string, unknown>, brokers: string[]): Promise<PluginOut> {
  const request = {
    protocol: 'workctl-plugin/1',
    capability,
    inputs,
    endpoints: { kafka: { 'demo-mq': { brokers, client_id: 'workctl-it' } } },
    defaults: { kafka: 'demo-mq' },
    profile: 'demo',
    env: 'sandbox',
    request_id: `req-it-${Date.now()}`,
    timeout_ms: 20_000,
  };
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => {
      try {
        res({ stdout, stderr, code, json: JSON.parse(stdout) });
      } catch (e) {
        rej(new Error(`plugin stdout is not one JSON document: ${stdout.slice(0, 300)} / ${stderr.slice(0, 300)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

describe.skipIf(process.env.WORKCTL_IT !== '1')('demo-mq live (WORKCTL_IT=1, demo-kafka)', () => {
  const brokers = (process.env.KAFKA_BROKERS ?? '127.0.0.1:19092').split(',');
  const suffix = `${Date.now().toString(36)}`;
  const topic = `workctl-it.lag.${suffix}`;
  const group = `workctl-it-${suffix}`;
  let admin: Admin;

  beforeAll(async () => {
    if (!existsSync(entry) || !existsSync(tgz)) execFileSync(process.execPath, [join(pluginDir, 'build.mjs')], { stdio: 'inherit' });
    const kafka = new Kafka({ brokers, clientId: 'workctl-it-setup', logLevel: logLevel.NOTHING });
    admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 3, replicationFactor: 1 }] });
    const producer = kafka.producer();
    await producer.connect();
    for (const partition of [0, 1, 2]) {
      await producer.send({ topic, acks: -1, messages: Array.from({ length: 10 }, (_, i) => ({ partition, value: JSON.stringify({ seq: i, synthetic: true }) })) });
    }
    await producer.disconnect();
    // p0: committed 2 but records before 4 deleted; p1: never committed; p2: committed 7
    await admin.setOffsets({ groupId: group, topic, partitions: [{ partition: 0, offset: '2' }, { partition: 2, offset: '7' }] });
    await admin.deleteTopicRecords({ topic, partitions: [{ partition: 0, offset: '4' }] });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.deleteGroups([group]).catch(() => undefined);
    await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
    await admin.disconnect();
  });

  it('mq.consumer.lag reports per-partition lag with explicit semantics', async () => {
    const out = await runPlugin('mq.consumer.lag', { cluster: 'demo-mq', group }, brokers);
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    const r = out.json;
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.data.group_state).toBe('Empty');
    expect(r.data.member_count).toBe(0);
    const t = r.data.topics.find((x: any) => x.topic === topic);
    expect(t.partitions).toEqual([
      expect.objectContaining({ partition: 0, committed_offset: 2, end_offset: 10, log_start_offset: 4, lag: 8, state: 'committed_before_log_start' }),
      expect.objectContaining({ partition: 1, committed_offset: null, end_offset: 10, lag: null, state: 'no_committed_offset' }),
      expect.objectContaining({ partition: 2, committed_offset: 7, end_offset: 10, lag: 3, state: 'ok' }),
    ]);
    expect(r.data.totals).toMatchObject({ total_lag: 11, partitions_without_commit: 1, partitions_lag_unknown: 1 });
    expect(r.data.lag_basis).toBe('offset_difference');
    expect(r.meta.coverage.complete).toBe(true);
    expect(r.meta.warnings.join(' ')).toContain('没有已提交位点');
    expect(r.meta.sources.map((s: any) => s.relation)).toContain('derived');
    expect(r.meta.sources.every((s: any) => s.system === 'kafka' && s.endpoint === 'kafka/demo-mq')).toBe(true);
    // validates against the published schema's zod source
    expect(OUTPUT_SCHEMAS['mq.consumer.lag'].safeParse(r.data).success).toBe(true);
  });

  it('mq.consumer.lag returns NOT_FOUND for an unknown group and topic', async () => {
    const g = await runPlugin('mq.consumer.lag', { cluster: 'demo-mq', group: `${group}-missing` }, brokers);
    expect(g.json.status).toBe('error');
    expect(g.json.error.code).toBe('NOT_FOUND');
    expect(g.json.error.details.group_state).toBe('Dead');
    const t = await runPlugin('mq.consumer.lag', { cluster: 'demo-mq', group, topic: `${topic}.missing` }, brokers);
    expect(t.json.error.code).toBe('NOT_FOUND');
  });

  it('mq.topic.get returns partitions, watermarks and configs', async () => {
    const r = (await runPlugin('mq.topic.get', { cluster: 'demo-mq', topic }, brokers)).json;
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.data.partition_count).toBe(3);
    expect(r.data.partitions[0]).toMatchObject({ partition: 0, log_start_offset: 4, end_offset: 10, offset_span: 6, under_replicated: false });
    expect(r.data.partitions[0].leader).toBeTypeOf('number');
    expect(r.data.configs['cleanup.policy'].value).toBe('delete');
    expect(r.data.configs['retention.ms'].value).toMatch(/^-?\d+$/);
    expect(OUTPUT_SCHEMAS['mq.topic.get'].safeParse(r.data).success).toBe(true);
  });

  it('mq.topic.list excludes internal topics unless asked', async () => {
    const r = (await runPlugin('mq.topic.list', { cluster: 'demo-mq', include_internal: false, limit: 500 }, brokers)).json;
    expect(r.status).toBe('success');
    const names = r.data.topics.map((t: any) => t.name);
    expect(names).toContain(topic);
    expect(names).not.toContain('__consumer_offsets');
    const all = (await runPlugin('mq.topic.list', { cluster: 'demo-mq', include_internal: true }, brokers)).json;
    expect(all.data.topics.map((t: any) => t.name)).toContain('__consumer_offsets');
    expect(OUTPUT_SCHEMAS['mq.topic.list'].safeParse(all.data).success).toBe(true);
  });

  it('reports an unreachable broker as UPSTREAM_UNAVAILABLE in JSON with exit 0', async () => {
    const r = await runPlugin('mq.topic.list', { cluster: 'demo-mq' }, ['127.0.0.1:1']);
    expect(r.code).toBe(0);
    expect(r.json.status).toBe('error');
    expect(r.json.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('installs the packaged tgz through core and answers through the same engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-demo-mq-'));
    const prevHome = process.env.WORKCTL_HOME;
    process.env.WORKCTL_HOME = join(dir, 'home');
    process.env.WORKCTL_IT_KAFKA_PW = 'pw-should-not-leak-123';
    try {
      const installed = installPlugin(tgz, new Registry());
      expect(installed.manifest.name).toBe('demo-mq');
      const reg = new Registry();
      expect(loadPlugins(reg).loaded).toEqual(['demo-mq@0.1.0']);
      expect(reg.get('mq.consumer.lag')?.origin).toBe('plugin:demo-mq@0.1.0');
      expect(reg.get('mq.queue.get')?.status).toBe('planned');
      const configPath = join(dir, 'workctl.yaml');
      writeFileSync(
        configPath,
        [
          'current_profile: it',
          'profiles:',
          '  it:',
          '    env: sandbox',
          '    defaults: { kafka: demo-mq }',
          '    endpoints:',
          '      kafka:',
          `        demo-mq: { brokers: [${brokers.join(', ')}], client_id: workctl-it }`,
          `        sasl-mq: { brokers: [${brokers.join(', ')}], sasl_mechanism: plain, sasl_username: u, sasl_password_ref: "env:WORKCTL_IT_KAFKA_PW" }`,
          '',
        ].join('\n'),
      );
      const env = await invoke(reg, 'mq.consumer.lag', { cluster: 'demo-mq', group }, { configPath, requestId: 'req-it-core' });
      expect(env.status, JSON.stringify(env.error)).toBe('success');
      expect(env.context).toMatchObject({ request_id: 'req-it-core', adapter: 'kafka-admin', operation: 'read', env: 'sandbox' });
      expect((env.data as any).totals.total_lag).toBe(11);
      expect(env.meta.sources.length).toBeGreaterThan(0);
      const missing = await invoke(reg, 'mq.consumer.lag', { cluster: 'demo-mq', group: `${group}-missing` }, { configPath });
      expect(missing.error?.code).toBe('NOT_FOUND');
      const planned = await invoke(reg, 'mq.queue.get', { cluster: 'demo-mq', queue: 'q' }, { configPath });
      expect(planned.error?.code).toBe('CAPABILITY_PLANNED');
      // credential resolved by core, passed via stdin only, never echoed back
      const sasl = await invoke(reg, 'mq.topic.list', { cluster: 'sasl-mq' }, { configPath });
      expect(sasl.error?.code).toBe('UNAUTHENTICATED');
      expect(JSON.stringify(sasl)).not.toContain('pw-should-not-leak-123');
    } finally {
      process.env.WORKCTL_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packaged tgz has the manifest, entry, schemas, guide and skill at its root', () => {
    const list = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n');
    for (const f of ['workctl-plugin.json', 'dist/plugin.mjs', 'schemas/mq.consumer.lag.v1.json', 'guides/mq.md', 'skills/mq-operations/SKILL.md', 'README.md']) {
      expect(list).toContain(f);
    }
    const staged = JSON.parse(readFileSync(join(pluginDir, 'dist', 'package', 'workctl-plugin.json'), 'utf8'));
    expect(staged.name).toBe('demo-mq');
  });
});

describe('demo-mq protocol robustness (review regression)', () => {
  it('always produces exactly one JSON document, even when the payload cannot be serialized', () => {
    const ok = JSON.parse(serializeResponse(successResponse({ data: { lag: 1 }, sources: [], coverage: null })));
    expect(ok).toMatchObject({ status: 'success', data: { lag: 1 } });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const data of [{ offset: 10n }, circular]) {
      const out = serializeResponse(successResponse({ data, sources: [], coverage: null }));
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('error');
      expect(parsed.error.code).toBe('INTERNAL');
      expect(out.includes('\n')).toBe(false);
    }
  });
});
