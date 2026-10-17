/**
 * Programmatic API for Node scripts: the same engine and contract as the CLI.
 *
 *   import { createClient } from 'workctl';
 *   const wc = createClient({ profile: 'demo' });
 *   const env = await wc.invoke('redis.info.get', { instance: 'demo-redis', section: 'memory' });
 */
import { invoke, type InvokeOptions } from './core/engine';
import { loadPlugins } from './core/plugins';
import { builtinRegistry } from './domains';

export { EnvelopeSchema, ERROR_CODES, type Envelope } from './core/output';

export function createClient(defaults: Omit<InvokeOptions, 'loaded'> = {}) {
  const registry = builtinRegistry();
  loadPlugins(registry);
  return {
    registry,
    invoke: (capability: string, inputs: Record<string, unknown> = {}, opts: InvokeOptions = {}) => invoke(registry, capability, inputs, { ...defaults, ...opts }),
  };
}
