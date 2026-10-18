/**
 * Pure consumer-lag arithmetic (no Kafka client), so the semantics are unit-testable.
 *
 * Kafka semantics kept explicit:
 * - committed offset = offset of the NEXT message the group will read; -1 means "no committed offset"
 * - end offset = what ListOffsets(latest) returns; under read_committed this is the last stable offset,
 *   which equals the high watermark when there are no open transactions
 * - lag = end - committed, measured in offsets (control records of transactions also occupy offsets),
 *   it is NOT a time delay
 */

export type PartitionLagState =
  | 'ok'
  | 'no_committed_offset'
  | 'committed_before_log_start'
  | 'committed_ahead_of_end'
  | 'end_offset_unavailable';

export interface PartitionOffsets {
  partition: number;
  /** committed offset; null or negative = no committed offset */
  committed: number | null;
  /** end offset (latest); null when it could not be read */
  end: number | null;
  /** log start offset (earliest); null when unknown */
  logStart: number | null;
  /** client_id of the member the partition is currently assigned to, if any */
  assignedTo?: string | null;
}

export interface PartitionLag {
  partition: number;
  committed_offset: number | null;
  end_offset: number | null;
  log_start_offset: number | null;
  lag: number | null;
  state: PartitionLagState;
  explanation?: string;
  assigned_member: string | null;
}

export interface TopicLag {
  topic: string;
  partitions: PartitionLag[];
  total_lag: number;
  partitions_with_commit: number;
  partitions_without_commit: number;
}

export interface LagTotals {
  topics: number;
  partitions: number;
  partitions_with_commit: number;
  partitions_without_commit: number;
  partitions_lag_unknown: number;
  total_lag: number;
  max_partition_lag: { topic: string; partition: number; lag: number } | null;
}

/** Parse a Kafka int64 offset as returned by kafkajs (string). Negative values (-1) mean "none". */
export function parseOffset(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!Number.isSafeInteger(n)) throw new RangeError(`offset ${v} exceeds JS safe integer range`);
  return n;
}

export function computePartitionLag(p: PartitionOffsets): PartitionLag {
  const committed = p.committed !== null && p.committed >= 0 ? p.committed : null;
  const base = {
    partition: p.partition,
    committed_offset: committed,
    end_offset: p.end,
    log_start_offset: p.logStart,
    assigned_member: p.assignedTo ?? null,
  };
  if (committed === null) {
    return {
      ...base,
      lag: null,
      state: 'no_committed_offset',
      explanation:
        '该分区没有已提交位点（消费组从未在此分区提交，或位点已按 offsets.retention 过期），无法按位点计算 lag；消费者下次启动时按 auto.offset.reset 决定起点。',
    };
  }
  if (p.end === null) {
    return { ...base, lag: null, state: 'end_offset_unavailable', explanation: '未能读取该分区的结束位点，lag 未计算。' };
  }
  if (committed > p.end) {
    return {
      ...base,
      lag: null,
      state: 'committed_ahead_of_end',
      explanation: `已提交位点 ${committed} 大于结束位点 ${p.end}（topic 可能被删除重建，或存在未提交的事务导致 LSO 落后），lag 不可信，未计算。`,
    };
  }
  const lag = p.end - committed;
  if (p.logStart !== null && committed < p.logStart) {
    return {
      ...base,
      lag,
      state: 'committed_before_log_start',
      explanation: `已提交位点早于日志起始位点 ${p.logStart}：其中 ${p.logStart - committed} 个位点的消息已被 retention 删除、无法再消费；仍可消费的积压为 ${p.end - p.logStart}。`,
    };
  }
  return { ...base, lag, state: 'ok' };
}

export function summarizeTopic(topic: string, partitions: PartitionOffsets[]): TopicLag {
  const rows = [...partitions].sort((a, b) => a.partition - b.partition).map(computePartitionLag);
  return {
    topic,
    partitions: rows,
    total_lag: rows.reduce((s, r) => s + (r.lag ?? 0), 0),
    partitions_with_commit: rows.filter((r) => r.committed_offset !== null).length,
    partitions_without_commit: rows.filter((r) => r.committed_offset === null).length,
  };
}

export function summarizeTotals(topics: TopicLag[]): LagTotals {
  let max: LagTotals['max_partition_lag'] = null;
  let partitions = 0;
  let unknown = 0;
  for (const t of topics) {
    for (const p of t.partitions) {
      partitions++;
      if (p.lag === null) unknown++;
      else if (!max || p.lag > max.lag) max = { topic: t.topic, partition: p.partition, lag: p.lag };
    }
  }
  return {
    topics: topics.length,
    partitions,
    partitions_with_commit: topics.reduce((s, t) => s + t.partitions_with_commit, 0),
    partitions_without_commit: topics.reduce((s, t) => s + t.partitions_without_commit, 0),
    partitions_lag_unknown: unknown,
    total_lag: topics.reduce((s, t) => s + t.total_lag, 0),
    max_partition_lag: max,
  };
}

/**
 * Partitions whose end offset was not read (deleted topic, or committed offsets for partitions the
 * topic no longer has after being re-created with fewer partitions): their lag was not collected,
 * so the result is partial, unlike `no_committed_offset` / `committed_ahead_of_end`, which are
 * observed states.
 */
export function partitionsWithoutEnd(topics: TopicLag[]): Array<{ topic: string; partition: number }> {
  return topics.flatMap((t) => t.partitions.filter((p) => p.state === 'end_offset_unavailable').map((p) => ({ topic: t.topic, partition: p.partition })));
}
