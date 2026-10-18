import { describe, expect, it, vi } from 'vitest';

// Fake kafkajs admin: group "g" has commits on orders partitions 0..2, but the topic was
// re-created with a single partition, so partitions 1 and 2 have no end offset.
vi.mock('kafkajs', async (orig) => {
  const real = await orig<typeof import('kafkajs')>();
  const admin = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    describeCluster: async () => ({ clusterId: 'c1', controller: null, brokers: [] }),
    describeGroups: async () => ({ groups: [{ groupId: 'g', state: 'Empty', protocolType: 'consumer', protocol: '', members: [] }] }),
    fetchOffsets: async () => [{ topic: 'orders', partitions: [0, 1, 2].map((p) => ({ partition: p, offset: '5' })) }],
    fetchTopicOffsets: async () => [{ partition: 0, high: '10', low: '0', offset: '10' }],
  };
  class Kafka {
    admin() {
      return admin;
    }
  }
  return { ...real, Kafka };
});

const { HANDLERS } = await import('../../plugins/demo-mq/src/capabilities');

describe('demo-mq consumer lag coverage (review regression)', () => {
  it('committed partitions missing from the current topic make the result partial, not complete', async () => {
    const req = { protocol: 'workctl-plugin/1', capability: 'mq.consumer.lag', inputs: {}, endpoints: { kafka: { k: { brokers: ['127.0.0.1:1'] } } }, defaults: { kafka: 'k' } };
    const r = await HANDLERS['mq.consumer.lag'](req as any, { group: 'g' }, 5000);
    const d = r.data as any;
    expect(d.totals.partitions_lag_unknown).toBe(2);
    expect(d.totals.total_lag).toBe(5);
    expect(r.status).toBe('partial');
    expect(r.coverage?.complete).toBe(false);
    expect((r.warnings ?? []).join('\n')).toMatch(/orders-1, orders-2/);
  });
});
