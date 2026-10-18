import type { Readable, Writable } from 'node:stream';
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
      // same as the engine: a non-negative integer (milliseconds) or a string like 0, 500ms, 30s, 1.5h
      return {
        ...base,
        anyOf: [
          { type: 'integer', minimum: 0, description: '毫秒' },
          { type: 'string', pattern: '^\\s*(0|[0-9]+(\\.[0-9]+)?(ms|s|m|h|d))\\s*$' },
        ],
      };
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

/**
 * Per-connection state of a stdio session. Only `serveMcp` passes one: direct (programmatic)
 * calls without a session are not gated on initialization.
 */
export interface McpSession {
  initialized: boolean;
}

/** JSON-RPC server error used for requests sent before `initialize` (as in LSP's ServerNotInitialized). */
export const NOT_INITIALIZED = -32002;

export async function handleMcpMessage(registry: Registry, o: McpOptions, msg: any, session?: McpSession): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  // a response from the client (result/error, no method) is never answered: replying would
  // reuse the id of a response, which the client may correlate with one of its own requests
  if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.jsonrpc === '2.0' && !('method' in msg) && ('result' in msg || 'error' in msg)) return null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code: -32600, message: 'Invalid Request' } };
  }
  // JSON-RPC: a request without an id is a notification. It is never answered and,
  // for tools/call, never executed (a capability must not run without a reply channel).
  if (!('id' in msg)) return null;
  // JSON-RPC: when the id cannot be determined the error's id is null (never echo an object/array id)
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: id must be a string or number' } };
  // MCP lifecycle: before initialize only pings are served (tools are never listed or run)
  if (session && !session.initialized && (msg.method === 'tools/call' || msg.method === 'tools/list')) {
    return fail(NOT_INITIALIZED, `Server not initialized: send initialize before ${msg.method}`);
  }
  switch (msg.method) {
    case 'initialize': {
      if (session) session.initialized = true;
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
        // the domain filter also bounds core operation.* (plans/executions of other domains' actions)
        allowedDomains: o.domains?.length ? o.domains : undefined,
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

/**
 * One parsed stdio line: a single message or a JSON-RPC batch (protocol 2025-03-26, which this
 * server negotiates, requires receiving batches). A batch is answered with an array of the
 * non-null replies, or nothing when it holds only notifications/responses; an empty batch is invalid.
 */
export async function handleMcpPayload(registry: Registry, o: McpOptions, payload: unknown, session?: McpSession): Promise<any | null> {
  if (!Array.isArray(payload)) return handleMcpMessage(registry, o, payload, session);
  if (payload.length === 0) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } };
  const replies = await Promise.all(
    payload.map((m) =>
      Array.isArray(m)
        ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
        : handleMcpMessage(registry, o, m, session).catch((e) => ({ jsonrpc: '2.0', id: (m as any)?.id ?? null, error: { code: -32603, message: String(e) } })),
    ),
  );
  const out = replies.filter((r) => r !== null);
  return out.length ? out : null;
}

/** Largest accepted stdio line (one JSON-RPC message or batch); longer lines are discarded unbuffered. */
export const MAX_MCP_LINE_BYTES = 4 * 1024 * 1024;

type StdioLine = { line: string } | { tooLong: number };

/**
 * Newline-delimited reader with a per-line cap: an oversized line is never held in memory
 * beyond the cap; its remainder is skipped up to the next newline and reported once.
 */
export async function* readLines(input: Readable, maxBytes = MAX_MCP_LINE_BYTES): AsyncGenerator<StdioLine> {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = 0; // bytes of an oversized line seen so far (0: not skipping)
  for await (const chunk of input) {
    let buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    while (buf.length) {
      const nl = buf.indexOf(10);
      const piece = nl === -1 ? buf : buf.subarray(0, nl);
      if (skipping) skipping += piece.length;
      else if (size + piece.length > maxBytes) {
        skipping = size + piece.length;
        parts = [];
        size = 0;
      } else {
        parts.push(piece);
        size += piece.length;
      }
      if (nl === -1) break;
      buf = buf.subarray(nl + 1);
      if (skipping) {
        yield { tooLong: skipping };
        skipping = 0;
      } else {
        yield { line: Buffer.concat(parts).toString('utf8').replace(/\r$/, '') };
        parts = [];
        size = 0;
      }
    }
  }
  if (skipping) yield { tooLong: skipping };
  else if (size) yield { line: Buffer.concat(parts).toString('utf8').replace(/\r$/, '') };
}

export async function serveMcp(registry: Registry, o: McpOptions, io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }): Promise<void> {
  const write = (v: unknown) => io.output.write(JSON.stringify(v) + '\n');
  const session: McpSession = { initialized: false };
  const pending = new Set<Promise<void>>();
  for await (const item of readLines(io.input)) {
    if ('tooLong' in item) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Invalid Request: message exceeds ${MAX_MCP_LINE_BYTES} bytes (got ${item.tooLong}+)` } });
      continue;
    }
    const line = item.line;
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const p = handleMcpPayload(registry, o, msg, session)
      .then((res) => {
        if (res) write(res);
      })
      .catch((e) => {
        write({ jsonrpc: '2.0', id: ['string', 'number'].includes(typeof (msg as any)?.id) ? (msg as any).id : null, error: { code: -32603, message: String(e) } });
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}
