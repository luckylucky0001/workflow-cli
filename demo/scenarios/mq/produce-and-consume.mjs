#!/usr/bin/env node
// Demo scenario: leave REAL consumer lag on the isolated Kafka broker (demo-kafka).
//
// 1. create topic demo.order.events (3 partitions) if missing
// 2. produce N synthetic order events (keyed by order_id)
// 3. run consumer group demo-consumer, consume only a fraction of each partition's
//    new messages, commit exactly those offsets, then leave the group
//
// All data is synthetic (payload field synthetic=true). Run from the repo root:
//   node demo/scenarios/mq/produce-and-consume.mjs [--messages 300] [--consume-ratio 0.4]
//        [--skip-partition 2] [--reset] [--brokers 127.0.0.1:19092]
import kafkajs from 'kafkajs';
import { randomUUID } from 'node:crypto';

const { Kafka, Partitioners, logLevel } = kafkajs;

function parseArgs(argv) {
  const opts = {
    brokers: process.env.KAFKA_BROKERS ?? '127.0.0.1:19092',
    topic: 'demo.order.events',
    group: 'demo-consumer',
    partitions: 3,
    messages: 300,
    consumeRatio: 0.4,
    skipPartition: null,
    reset: false,
    timeoutMs: 60_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--brokers': opts.brokers = next(); break;
      case '--topic': opts.topic = next(); break;
      case '--group': opts.group = next(); break;
      case '--messages': opts.messages = Number.parseInt(next(), 10); break;
      case '--consume-ratio': opts.consumeRatio = Number.parseFloat(next()); break;
      case '--skip-partition': opts.skipPartition = Number.parseInt(next(), 10); break;
      case '--reset': opts.reset = true; break;
      case '--timeout-ms': opts.timeoutMs = Number.parseInt(next(), 10); break;
      case '-h':
      case '--help':
        console.log('用法: node demo/scenarios/mq/produce-and-consume.mjs [--messages N] [--consume-ratio 0..1] [--skip-partition P] [--reset] [--brokers host:port]');
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 ${a}`);
    }
  }
  if (!Number.isInteger(opts.messages) || opts.messages < 1) throw new Error('--messages 必须是正整数');
  if (!(opts.consumeRatio >= 0 && opts.consumeRatio <= 1)) throw new Error('--consume-ratio 必须在 0..1 之间');
  return opts;
}

const EVENT_TYPES = ['order.created', 'order.paid', 'order.shipped', 'order.cancelled'];

function syntheticEvent(i, runId) {
  const orderNo = 100000 + Math.floor(Math.random() * 900);
  return {
    event_id: randomUUID(),
    run_id: runId,
    seq: i,
    order_id: `DEMO-${orderNo}`,
    event_type: EVENT_TYPES[i % EVENT_TYPES.length],
    amount_cents: 100 + Math.floor(Math.random() * 50000),
    currency: 'CNY',
    occurred_at: new Date().toISOString(),
    synthetic: true,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureTopic(admin, opts) {
  if (opts.reset) {
    const groups = (await admin.listGroups()).groups.map((g) => g.groupId);
    if (groups.includes(opts.group)) {
      await admin.deleteGroups([opts.group]);
      console.log(`[reset] 已删除消费组 ${opts.group}`);
    }
    if ((await admin.listTopics()).includes(opts.topic)) {
      await admin.deleteTopics({ topics: [opts.topic], timeout: 10_000 });
      console.log(`[reset] 已删除 topic ${opts.topic}`);
      // topic deletion is asynchronous on the broker; wait until it is gone
      for (let i = 0; i < 30 && (await admin.listTopics()).includes(opts.topic); i++) await sleep(500);
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const topics = await admin.listTopics();
    if (topics.includes(opts.topic)) {
      const meta = await admin.fetchTopicMetadata({ topics: [opts.topic] });
      const n = meta.topics[0]?.partitions.length ?? 0;
      console.log(`topic ${opts.topic} 已存在（${n} 个分区）`);
      return;
    }
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic: opts.topic, numPartitions: opts.partitions, replicationFactor: 1 }],
      });
      console.log(`已创建 topic ${opts.topic}（${opts.partitions} 个分区）`);
      return;
    } catch (e) {
      // right after a delete the broker may still report TOPIC_ALREADY_EXISTS
      if (e?.type !== 'TOPIC_ALREADY_EXISTS') throw e;
      await sleep(500);
    }
  }
  throw new Error(`无法创建 topic ${opts.topic}`);
}

async function committedOffsets(admin, opts) {
  const res = await admin.fetchOffsets({ groupId: opts.group, topics: [opts.topic] });
  const out = new Map();
  for (const p of res.find((t) => t.topic === opts.topic)?.partitions ?? []) out.set(p.partition, Number(p.offset));
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runId = `run-${Date.now().toString(36)}`;
  const kafka = new Kafka({
    clientId: 'workctl-demo-scenario',
    brokers: opts.brokers.split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: logLevel.ERROR,
    retry: { retries: 5 },
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    await ensureTopic(admin, opts);

    // --- produce -------------------------------------------------------------
    const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
    await producer.connect();
    const events = Array.from({ length: opts.messages }, (_, i) => syntheticEvent(i, runId));
    const BATCH = 100;
    for (let i = 0; i < events.length; i += BATCH) {
      await producer.send({
        topic: opts.topic,
        acks: -1,
        messages: events.slice(i, i + BATCH).map((e) => ({
          key: e.order_id,
          value: JSON.stringify(e),
          headers: { 'x-synthetic': 'true', 'x-run-id': runId },
        })),
      });
    }
    await producer.disconnect();
    console.log(`已生产 ${events.length} 条合成订单事件（run_id=${runId}）`);

    // --- plan the partial consumption ---------------------------------------
    const ends = await admin.fetchTopicOffsets(opts.topic);
    const before = await committedOffsets(admin, opts);
    const plan = ends.map(({ partition, high, low }) => {
      const end = Number(high);
      const committed = before.get(partition) ?? -1;
      const start = committed >= 0 ? committed : Number(low);
      const skip = opts.skipPartition === partition;
      const target = skip ? start : start + Math.floor((end - start) * opts.consumeRatio);
      return { partition, start, end, target, skip };
    }).sort((a, b) => a.partition - b.partition);

    // --- consume part of it and commit --------------------------------------
    const consumer = kafka.consumer({ groupId: opts.group, sessionTimeout: 10_000, heartbeatInterval: 1_000 });
    await consumer.connect();
    await consumer.subscribe({ topics: [opts.topic], fromBeginning: true });
    const next = new Map(plan.map((p) => [p.partition, p.start]));
    const target = new Map(plan.map((p) => [p.partition, p.target]));
    let processed = 0;
    const isDone = () => plan.every((p) => p.skip || next.get(p.partition) >= p.target);

    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const offset = Number(message.offset);
        const t = target.get(partition) ?? 0;
        if (opts.skipPartition === partition || offset >= t) {
          consumer.pause([{ topic, partitions: [partition] }]);
          if (isDone()) resolveDone();
          return;
        }
        // "process" the event: a real consumer would update downstream state here
        JSON.parse(message.value.toString('utf8'));
        processed++;
        next.set(partition, offset + 1);
        if (offset + 1 >= t) consumer.pause([{ topic, partitions: [partition] }]);
        if (isDone()) resolveDone();
      },
    });
    if (isDone()) resolveDone();
    const timer = setTimeout(() => resolveDone('timeout'), opts.timeoutMs);
    const outcome = await done;
    clearTimeout(timer);
    if (outcome === 'timeout') console.error(`警告: ${opts.timeoutMs}ms 内未消费到目标位点，按已处理位点提交`);

    const commits = plan
      .filter((p) => !p.skip && next.get(p.partition) > p.start)
      .map((p) => ({ topic: opts.topic, partition: p.partition, offset: String(next.get(p.partition)) }));
    if (commits.length) await consumer.commitOffsets(commits);
    await consumer.disconnect();
    console.log(`消费组 ${opts.group} 处理了 ${processed} 条并已提交位点，随后退出（组内无活跃成员）`);

    // --- summary (computed by this script; compare with workctl mq consumer lag) ---
    const after = await committedOffsets(admin, opts);
    console.log('\n分区  end_offset  committed  预期lag');
    let total = 0;
    for (const p of plan) {
      const c = after.get(p.partition) ?? -1;
      const lag = c >= 0 ? p.end - c : null;
      if (lag !== null) total += lag;
      console.log(`${String(p.partition).padEnd(4)}  ${String(p.end).padEnd(10)}  ${String(c >= 0 ? c : '(无)').padEnd(9)}  ${lag ?? '无已提交位点'}`);
    }
    console.log(`合计（仅含有已提交位点的分区）: ${total}`);
    console.log(`\n下一步: workctl mq consumer lag --cluster demo-mq --group ${opts.group}`);
  } finally {
    await admin.disconnect();
  }
}

main().catch((e) => {
  console.error(`场景执行失败: ${e?.message ?? e}`);
  if (e?.type) console.error(`kafka error type: ${e.type}`);
  process.exit(1);
});
