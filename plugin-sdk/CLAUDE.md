# CLAUDE.md

## What this package is

`trek-plugin-sdk` — the author-facing SDK and CLI for building TREK plugins. It lives in the TREK monorepo but is **not a root npm workspace**: own `package-lock.json`, versioned and published to npm independently, and it must ship standalone (a published copy has no access to the rest of the repo). Run all commands from `plugin-sdk/`. The root `CLAUDE.md` conventions (target `dev`, conventional commits, no attribution trailers) still apply.

Three bins from one codebase: `trek-plugin-sdk` / `trek-plugin` (same entry, `src/cli/trek-plugin.ts`, one file per command under `src/cli/`) and `create-trek-plugin` (`src/cli/create.ts`). `README.md` here is the author guide; the `trek-plugin-dev` skill is the long-form authoring reference.

## Commands

```bash
npm install
npm run build         # tsc ESM build + tsc CJS build + scripts/finish-cjs.mjs
npm run typecheck     # tsc --noEmit (CI)
npm test              # vitest run
npm run test:coverage # what CI runs (feeds the Sonar new-code coverage gate)
npx vitest run test/sdk.test.ts        # single test file
node scripts/gen-lucide-icon-names.mjs # regenerate src/lucide-icon-names.ts (uses repo-root lucide-react)
```

Node >= 18, `"type": "module"`; the dual build emits ESM to `dist/` and CJS to `dist/cjs/` (finish-cjs.mjs writes the `{"type":"commonjs"}` marker there — without it Node parses the CJS output as ESM). There is no lint script here.

**Release**: a pushed `plugin-sdk-v*` tag runs `npm ci && npm publish` via the root `publish-plugin-sdk.yml`; `prepublishOnly` builds and tests first. The published version is whatever `package.json` says — bump it in the same PR as the SDK change. Never push the tag yourself.

## The load-bearing principle: mirrored host code + parity tests

The SDK's promise is that local results equal host/registry results: `dev` enforces what a real TREK enforces, and `validate` passes iff the TREK-Plugins registry CI passes. A drift in the lenient direction is the worst bug in this package — a **false green** lets an author cut an effectively immutable GitHub release (the registry pins its sha256) that the registry then rejects.

Because the package ships standalone it cannot import server code, so several files are deliberate **copies** of host sources, each guarded by a parity test that reads the original directly. Those tests skip outside the monorepo but run in this checkout — keep the pairs in sync when touching either side:

| SDK copy | Source of truth | Parity test |
|---|---|---|
| `src/generated/host-facts.ts` (permissions, RPC methods, hooks, event catalog) | `server/src/nest/plugins/protocol/envelope.ts` via `server/scripts/gen-plugin-facts.ts` — **machine-written, never hand-edit** | server `check:plugin-facts` CI gate |
| `src/egress-policy.ts` (pure helpers, kept **byte-identical**) | `server/src/nest/plugins/runtime/egress-policy.ts` | `test/permissions-parity.test.ts` |
| `src/manifest.ts` (validation rules incl. the `trek` version range, `KNOWN_ADDONS`) | `server/src/nest/plugins/install/` + `server/src/addons.ts` | kept in sync by hand |
| `src/cli/checks/*` (registry gates) | TREK-Plugins registry repo (`scripts/validate-entry.mjs`, `check-readme.mjs`) | `test/checks-parity.test.ts` (runs the registry's real script; `TREK_PLUGINS_REPO` points at a checkout) |
| `src/zip.ts` (ZIP writer) | server `safe-extract.ts` reader | format frozen against the reader |

**Direction: single-source the contract.** The hand-kept copies are the residual risk, and the parity tests' skip-outside-the-monorepo guards mean the published SDK's own CI can green-light drift in them — keep moving copies into the generated/parity-tested set, never away from it. Changing an egress rule, manifest rule or registry gate means touching **every** copy in one change; parity gates fail closed; version/compat checks fail **closed** on unknown host versions.

A subtlety documented in `src/permissions.ts`: ctx methods fail loudly at call time, but hooks/events/jobs are gated *before* the plugin is reached and fail **silently** in production — so the dev server and mock host deliberately make those failures loud.

## Architecture

- **`src/index.ts`** — the plugin API surface: all types, `definePlugin`, `PLUGIN_API_VERSION` (bump on any breaking API change). Pure and dependency-free; it mirrors exactly what TREK's plugin runtime injects. Runtime deps for the whole package are only `@clack/prompts`, `semver`, `update-notifier` — keep it that way (Playwright for `shot` is the author's devDependency; the ZIP writer is in-tree).
- **Two package exports**: `.` (the SDK) and `./testing` (`src/mock-host.ts`) — a mock `PluginContext` enforcing the same permission model against fixtures.
- **`src/cli/`** — interactive TTY sessions get prompts; non-TTY stays flag-driven. Machine output (`entry` JSON, `pack --json`, PR URLs) goes to stdout, notices to stderr.
- **`src/cli/checks/`** — one check registry, two depths: `runOffline` (synchronous on purpose, so packing can validate before zipping) and `runAll` (adds the GitHub-dependent gates used by `preflight`/`publish`).
- **`src/ui/kit.ts`** — the design kit as plain strings, inlined where the `<!-- trek:ui -->` marker sits in a plugin's `client/index.html` (the opaque-origin iframe CSP forbids external link/script). Not a security boundary.
- **`src/lucide-icon-names.ts`** — generated snapshot; an unknown icon is a validate **warning**, never an error.
- **`test/helpers.ts`** — `makePublishable(dir)` turns a fresh scaffold into a registry-passing plugin; the scaffold deliberately fails publish gates, so tests choose "fresh" vs "publishable" explicitly.

## Behavioral contracts to not break

- `status` never exits non-zero; `validate` is the enforcing form.
- `publish` order is check → pack → release → preflight → submit, and a check failure must stop anything from being tagged or released.
- Signed → unsigned is refused forever; unsigned → signed is always allowed.
- Update notices print to stderr only and are silent in CI/`NODE_ENV=test`/non-TTY, so JSON output stays pipeable.
