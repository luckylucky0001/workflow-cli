# workctl — notes for agents working on this repository

TypeScript CLI (Node ≥ 20, ESM, Commander, Zod v4, esbuild, vitest). Imports have no file extensions.

## Layout
- `src/core/` shared runtime: engine (`invoke`), envelope/error codes, config + credential refs, resources, plan store, HTTP client, plugin loader. Domains must use these instead of re-implementing them.
- `src/domains/<name>/index.ts` default-exports `defineDomain({...})`; each capability is a `defineCapability({...})` with a zod `output` schema, `operation` (read|diagnose|plan|execute), notes and examples. Register new domains in `src/domains/index.ts`. Not-yet-implemented capabilities are `status: 'planned'` with no handler.
- `src/cli/` (command tree generated from capabilities, docs generator, skills distribution), `src/mcp/` (stdio MCP server over the same engine).
- `plugins/demo-mq/` example plugin (`workctl-plugin/1` protocol). `skills/` Markdown skills. `docs/` guides + generated catalog/reference/schemas. `demo/` isolated environment, scenarios, verification.

## Rules
- Results: never fabricate; always fill `sources` (system, method, version, relation) and `coverage`; keep empty / not collected (`COLLECTION_DISABLED`) / no permission / partial / running distinguishable. See `docs/design-principles.md`.
- Credentials only via `*_ref: env:|file:`; never print them.
- Writes go through planners/executors; execute needs `allow_execute`.

## Checks before committing
```bash
npm run typecheck && npm run build && npm run docs && npm test   # contract tests fail if docs/ is stale
WORKCTL_IT=1 npm test                                           # live tests; needs demo/environment/up.sh
WORKCTL_CONFIG=demo/environment/workctl.yaml node scripts/verify-demo.mjs
```
