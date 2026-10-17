/**
 * demo-mq plugin entry. Executed by workctl core as `node dist/plugin.mjs`:
 * stdin = one workctl-plugin/1 request, stdout = exactly one JSON response, exit code 0.
 * Logs go to stderr only.
 */
import { HANDLERS } from './capabilities';
import { CAPABILITIES, PLUGIN_NAME, PLUGIN_VERSION } from './manifest';
import { PROTOCOL, PluginError, RequestSchema, errorResponse, successResponse, type PluginResponse } from './protocol';

// stdout is reserved for the protocol response: route any stray console output to stderr.
const toStderr = (...args: unknown[]) => process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

let responded = false;
function respond(res: PluginResponse): void {
  if (responded) return;
  responded = true;
  process.stdout.write(`${JSON.stringify(res)}\n`, () => process.exit(0));
}

function fail(e: unknown): void {
  const err = e instanceof PluginError ? e : new PluginError('INTERNAL', e instanceof Error ? e.message : String(e), { details: { plugin: `${PLUGIN_NAME}@${PLUGIN_VERSION}` } });
  if (!(e instanceof PluginError) && process.env.WORKCTL_DEBUG === '1') process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
  respond(errorResponse(err));
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new PluginError('INVALID_ARGUMENT', '插件需要从 stdin 读取 workctl-plugin/1 请求', { hint: '由 workctl 调用；手动调试: echo \'{"protocol":"workctl-plugin/1",...}\' | node dist/plugin.mjs' });
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PluginError('INVALID_ARGUMENT', 'stdin 不是合法 JSON');
  }
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    throw new PluginError('INVALID_ARGUMENT', '请求不符合 workctl-plugin/1 协议', { details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } });
  }
  const req = parsed.data;
  if (req.protocol !== PROTOCOL) {
    throw new PluginError('UNSUPPORTED', `不支持的协议版本 ${req.protocol}`, { details: { supported: [PROTOCOL] } });
  }
  const handler = HANDLERS[req.capability];
  if (!handler) {
    const declared = CAPABILITIES.find((c) => c.name === req.capability);
    throw new PluginError('UNSUPPORTED', declared ? `能力 ${req.capability} 在插件 ${PLUGIN_NAME} 中为 ${declared.status}，尚未实现` : `插件 ${PLUGIN_NAME} 不提供能力 ${req.capability}`, {
      details: { available: Object.keys(HANDLERS) },
    });
  }
  // answer before core's own deadline kills the process
  const budget = Math.max(500, (req.timeout_ms ?? 30_000) - 500);
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    handler(req, req.inputs, budget),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new PluginError('TIMEOUT', `调用超过 ${budget}ms 时间预算`, { hint: '增大 --timeout 或检查 broker 状态' })), budget);
    }),
  ]);
  clearTimeout(timer);
  respond(successResponse(result));
}

main().catch(fail);
