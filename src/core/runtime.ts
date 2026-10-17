import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { LoadedConfig, Profile } from './config';
import { resolveSecretRef } from './config';
import { WorkError } from './output';
import type { CapabilityDef } from './registry';
import type { Registry } from './registry';
import { ResourceStore } from './resources';
import { PlanStore } from './operations';

export class Endpoint {
  constructor(
    readonly kind: string,
    readonly name: string,
    readonly cfg: Record<string, unknown>,
    private readonly baseDir: string,
  ) {}

  str(key: string): string | undefined;
  str(key: string, fallback: string): string;
  str(key: string, fallback?: string): string | undefined {
    const v = this.cfg[key];
    return v === undefined || v === null ? fallback : String(v);
  }

  require(key: string): string {
    const v = this.str(key);
    if (v === undefined || v === '') {
      throw new WorkError('NOT_CONFIGURED', `端点 ${this.kind}/${this.name} 缺少配置项 ${key}`);
    }
    return v;
  }

  num(key: string, fallback?: number): number | undefined {
    const v = this.cfg[key];
    if (v === undefined || v === null) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new WorkError('INVALID_ARGUMENT', `端点 ${this.kind}/${this.name}.${key} 不是数字`);
    return n;
  }

  bool(key: string, fallback = false): boolean {
    const v = this.cfg[key];
    return v === undefined || v === null ? fallback : v === true || v === 'true';
  }

  obj<T = Record<string, unknown>>(key: string): T | undefined {
    return this.cfg[key] as T | undefined;
  }

  /** Resolve `${key}_ref`; returns undefined when no reference is configured. */
  secret(key: string): string | undefined {
    const ref = this.cfg[`${key}_ref`];
    if (ref === undefined || ref === null || ref === '') return undefined;
    return resolveSecretRef(String(ref), this.baseDir);
  }

  /** A path config value, resolved relative to the config file. */
  path(key: string): string | undefined {
    const v = this.str(key);
    if (!v) return undefined;
    return isAbsolute(v) ? v : resolve(this.baseDir, v);
  }

  /** Credential-free identifier for provenance. */
  get id(): string {
    return `${this.kind}/${this.name}`;
  }
}

export interface CtxOptions {
  registry: Registry;
  loaded: LoadedConfig;
  profileName: string | null;
  requestId: string;
  timeoutMs: number;
  capability?: CapabilityDef;
  signal?: AbortSignal;
  debug?: boolean;
}

export class Ctx {
  readonly registry: Registry;
  readonly loaded: LoadedConfig;
  readonly profileName: string | null;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly capability?: CapabilityDef;
  readonly signal: AbortSignal;
  readonly startedAt = Date.now();
  readonly warnings: string[] = [];
  private resourceStore?: ResourceStore;
  private planStore?: PlanStore;
  private readonly debugOn: boolean;

  constructor(o: CtxOptions) {
    this.registry = o.registry;
    this.loaded = o.loaded;
    this.profileName = o.profileName;
    this.requestId = o.requestId;
    this.timeoutMs = o.timeoutMs;
    this.capability = o.capability;
    this.signal = o.signal ?? AbortSignal.timeout(o.timeoutMs);
    this.debugOn = o.debug ?? false;
  }

  get profile(): Profile | null {
    return this.profileName ? this.loaded.config.profiles[this.profileName] ?? null : null;
  }

  requireProfile(): Profile {
    const p = this.profile;
    if (!p) {
      throw new WorkError('NOT_CONFIGURED', '没有可用的 profile', {
        hint: '通过 --profile 指定，或在配置文件中设置 current_profile（见 docs/quickstart.md）',
      });
    }
    return p;
  }

  get env(): string | null {
    return this.profile?.env ?? null;
  }

  get dataMode(): string | null {
    return this.profile?.data_mode ?? null;
  }

  /** Remaining time budget in ms (never below 1). */
  remainingMs(): number {
    return Math.max(1, this.timeoutMs - (Date.now() - this.startedAt));
  }

  endpointNames(kind: string): string[] {
    return Object.keys(this.profile?.endpoints[kind] ?? {});
  }

  endpoint(kind: string, name?: string): Endpoint {
    const p = this.requireProfile();
    const named = p.endpoints[kind] ?? {};
    const names = Object.keys(named);
    const chosen = name ?? p.defaults[kind] ?? (names.length === 1 ? names[0] : undefined);
    if (!chosen) {
      throw new WorkError('NOT_CONFIGURED', names.length ? `需要指定 ${kind} 端点` : `profile ${this.profileName} 未配置 ${kind} 端点`, {
        hint: names.length ? `可用: ${names.join(', ')}` : `在 profiles.${this.profileName}.endpoints.${kind} 中添加端点`,
      });
    }
    const cfg = named[chosen];
    if (!cfg) {
      throw new WorkError('NOT_FOUND', `profile ${this.profileName} 中没有 ${kind} 端点 ${chosen}`, {
        hint: names.length ? `可用: ${names.join(', ')}` : undefined,
      });
    }
    return new Endpoint(kind, chosen, cfg, this.loaded.baseDir);
  }

  hasEndpoint(kind: string, name?: string): boolean {
    const named = this.profile?.endpoints[kind];
    if (!named) return false;
    return name ? name in named : Object.keys(named).length > 0;
  }

  get stateDir(): string {
    const configured = this.profile?.state_dir;
    if (configured) return isAbsolute(configured) ? configured : resolve(this.loaded.baseDir, configured);
    const home = process.env.WORKCTL_HOME ?? join(homedir(), '.local', 'share', 'workctl');
    return join(home, 'state', this.profileName ?? 'default');
  }

  resources(): ResourceStore {
    if (!this.resourceStore) {
      const f = this.profile?.resources_file;
      this.resourceStore = ResourceStore.load(f ? (isAbsolute(f) ? f : resolve(this.loaded.baseDir, f)) : null);
    }
    return this.resourceStore;
  }

  plans(): PlanStore {
    if (!this.planStore) this.planStore = new PlanStore(join(this.stateDir, 'operations'));
    return this.planStore;
  }

  /**
   * Invoke another capability through the same engine (same profile, config and
   * request id). This is how capabilities compose without sharing adapter code.
   */
  async call(capability: string, inputs: Record<string, unknown>): Promise<import('./output').Envelope> {
    const { invoke } = await import('./engine');
    return invoke(this.registry, capability, inputs, {
      loaded: this.loaded,
      profile: this.profileName ?? undefined,
      timeoutMs: this.remainingMs(),
      requestId: this.requestId,
      debug: this.debugOn,
    });
  }

  warn(msg: string): void {
    this.warnings.push(msg);
  }

  debug(msg: string): void {
    if (this.debugOn) process.stderr.write(`[workctl debug ${this.requestId}] ${msg}\n`);
  }
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

export function parseDuration(v: string): number {
  const m = DURATION_RE.exec(String(v).trim());
  if (!m) throw new WorkError('INVALID_ARGUMENT', `无法解析时长: ${v}`, { hint: '使用如 500ms、30s、15m、2h、1d' });
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
  return Math.round(n * mult);
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** [now - window, now] as ISO strings. */
export function windowFromNow(windowMs: number, now = new Date()): { start: string; end: string } {
  return { start: new Date(now.getTime() - windowMs).toISOString(), end: now.toISOString() };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new WorkError('TIMEOUT', '调用超过时间预算', { hint: '增大 --timeout 或缩小采样窗口' }));
    }, { once: true });
  });
}
