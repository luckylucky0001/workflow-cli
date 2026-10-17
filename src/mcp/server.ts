import { createInterface } from 'node:readline';
import { CLI_VERSION, invoke } from '../core/engine';
import type { CapabilityDef, InputSpec, Registry } from '../core/registry';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Tools are derived from the same capability definitions as the CLI and call the
 * same engine, so CLI, scripts and MCP clients share one implementation and contract.
 */
export interface McpOptions {
  allowExecute: boolean;
  domains?: string[];
  configPath?: string;
  profile?: string;
  timeoutMs: number;
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function toolName(c: CapabilityDef): string {
  return c.name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function inputJsonSchema(spec: InputSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: spec.description };
  switch (spec.type) {
    case 'int':
      return { ...base, type: 'integer' };
    case 'number':
      return { ...base, type: 'number' };
    case 'bool':
      return { ...base, type: 'boolean' };
    case 'enum':
      return { ...base, type: 'string', enum: spec.enum };
    case 'list':
      return { ...base, type: 'array', items: { type: 'string' } };
    case 'duration':
      return { ...base, type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?(ms|s|m|h|d)$' };
    case 'file':
      return { ...base, type: 'string', description: `${spec.description}（本地文件路径）` };
    default:
      return { ...base, type: 'string' };
  }
}

export function toolsFor(registry: Registry, o: Pick<McpOptions, 'allowExecute' | 'domains'>) {
  return registry
    .list()
    .filter((c) => c.status !== 'planned' && c.handler)
    .filter((c) => o.allowExecute || c.operation !== 'execute')
    .filter((c) => !o.domains?.length || o.domains.includes(c.domain) || c.domain === 'core')
    .map((c) => ({
      name: toolName(c),
      title: c.summary,
      description: [
        c.summary,
        `能力 ${c.name} v${c.capability_version}；操作类型 ${c.operation}；适配器 ${c.adapter}；指南 ${c.guide}。`,
        ...(c.notes ?? []).map((n) => `口径：${n}`),
        '返回统一结果信封（status/data/error/meta.sources/meta.coverage/context），请依据 meta 判断来源与覆盖范围。',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(c.inputs).map(([k, v]) => [k, inputJsonSchema(v)])),
        required: Object.entries(c.inputs).filter(([, v]) => v.required).map(([k]) => k),
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: c.operation === 'read' || c.operation === 'diagnose',
        destructiveHint: c.operation === 'execute',
        idempotentHint: c.operation !== 'execute',
        openWorldHint: true,
      },
      _capability: c.name,
    }));
}

export async function handleMcpMessage(registry: Registry, o: McpOptions, msg: any): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code: -32600, message: 'Invalid Request' } };
  }
  // JSON-RPC: a request without an id is a notification. It is never answered and,
  // for tools/call, never executed (a capability must not run without a reply channel).
  if (!('id' in msg)) return null;
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') return fail(-32600, 'Invalid Request: id must be a string or number');
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'workctl', version: CLI_VERSION },
        instructions:
          '企业基础设施、中间件与离线链路能力。先用 capability_list 发现能力，再按需调用；结果中的 meta.sources/coverage 说明来源与覆盖范围，空结果、未采集、无权限、部分结果含义不同。' +
          (o.allowExecute ? '' : ' 本服务未开放 execute 类操作，只能生成计划。'),
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolsFor(registry, o).map(({ _capability, ...t }) => t) });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = toolsFor(registry, o).find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${name}`);
      const args = msg.params?.arguments ?? {};
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return fail(-32602, 'Invalid params: arguments must be an object');
      const env = await invoke(registry, tool._capability, args, {
        configPath: o.configPath,
        profile: o.profile,
        timeoutMs: o.timeoutMs,
        allowExecute: o.allowExecute,
      });
      return reply({
        content: [{ type: 'text', text: JSON.stringify(env, null, 2) }],
        structuredContent: env,
        isError: env.status === 'error',
      });
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function serveMcp(registry: Registry, o: McpOptions): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      continue;
    }
    const p = handleMcpMessage(registry, o, msg)
      .then((res) => {
        if (res) process.stdout.write(JSON.stringify(res) + '\n');
      })
      .catch((e) => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: (msg as any)?.id ?? null, error: { code: -32603, message: String(e) } }) + '\n');
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}
