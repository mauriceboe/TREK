# CLAUDE.md

Scope: the **`@trek/server`** workspace. See the repo-root `CLAUDE.md` for the monorepo picture and the philosophy. This file holds the server's commands, invariants and pitfalls; the code and `src/nest/README.md` hold the inventory.

## Commands (run from `server/`)

```bash
npm run dev               # scripts/dev.mjs: tsc -w then node --watch dist/index.js (server on :3001)
npm run build             # scripts/build.mjs — emits even on type errors (see below)
npm run typecheck         # tsc --noEmit — the real type gate
npm run typecheck:tests   # tsc over tests/ — CI runs this too; vitest green does NOT mean typed mocks compile
npm run lint              # eslint --fix
npm run lint:check        # eslint, no fix (CI)
npm run test              # vitest run; also test:unit / test:integration / test:ws / test:e2e
npm run test:coverage     # istanbul coverage; per-domain ratchet over src/nest/**
npm run gen:plugin-facts  # regenerate the plugin-protocol tables into plugin-sdk/ + shared/
npm run check:plugin-facts # CI gate — fails if the generated copies drifted
node scripts/coverage-thresholds.mjs  # after test:coverage — prints the ratchet block for vitest.config.ts
```

Single test: `npx vitest run tests/unit/nest/weather.controller.test.ts`, or `npx vitest run -t "returns 401 without cookie"`.

**Build emits even with type errors** (`scripts/build.mjs` catches `tsc` failures and warns). `npm run build` succeeding does **not** mean the code typechecks — run `npm run typecheck`.

## Architecture invariants

Nest owns everything. Every domain is a DI module under `src/nest/<domain>/` (`controller` + `service` + `module`, registered in `src/nest/app.module.ts`); business logic lives in the injectable `.service.ts`, pure halves in `.helpers.ts`, SQL in a `.repository.ts` where one exists. There is no legacy service layer — ESLint errors on any `services/` import. **`weather/` is the reference module shape; `collections.controller.ts` is the reference for body validation and enumeration-safe access checks.**

- **`src/bootstrap.ts` — `buildApp()`** is the single builder for production and the test harness. Everything on the raw Express instance (global middleware, uploads, discovery metadata, statics, the named `jsonParser`/`urlencodedParser` wrappers) is registered **before `app.init()`**, because Nest throws `NotFoundException` on unmatched routes and nothing after init is reachable. The wrappers exempt `/mcp` so the MCP SDK reads the raw stream — **never `@Body()` a `/mcp` route**. Don't add routes to that pre-init shell; it bypasses every global guard, interceptor and filter.
- **Realtime**: `/ws` is a Nest gateway in `src/nest/realtime/`. Inject `RealtimeService`; `src/websocket.ts` is a re-export stub for old call sites. Trip mutations forward `X-Socket-Id` so the originating client doesn't echo its own change.
- **MCP**: `src/nest-mcp/` is the decorator/registry layer (`@McpController`/`@Tool`/`@Resource`/`@Prompt`; see its `README.md`); tools live in `<domain>.mcp.ts` files beside each module; the HTTP transport is `src/nest/mcp-transport/`; `src/mcp/` holds process-wide state only (scopes, session manager, boot policy). Every tool invocation writes an audit row through the registry's `onInvoke` seam. MCP tools are adapters over the same services and permission checks as REST — a change on one side lands on the other in the same change.
- **Scheduling**: `src/nest/scheduling/` (`CronRegistrarService`) is the one way to schedule a cron. Jobs are `*.job.ts` providers in their owning domain. The registrar refuses to schedule under `NODE_ENV=test` (an integration test pins it). **Never use a `@Cron` decorator** — it bypasses that gate.
- **Plugins** (`src/nest/plugins/`): the child-process runtime (`supervisor/`, `runtime/plugin-host-entry.ts`, `protocol/envelope.ts`) is **intentionally not Nest** — it is the security boundary. `host/rpc-host.ts` registers an RPC method at spawn only if the plugin holds the unlocking permission (registration = authorization). Install-time gates live in `install/`; the manifest's `trek` version range fails closed, and `TREK_PLUGINS_IGNORE_TREK_RANGE` downgrades that to a warning. The protocol tables in `protocol/envelope.ts` (+ `src/plugin-event-sink.ts`) are **generated** into `plugin-sdk/` and `shared/` — run `gen:plugin-facts` after touching them and commit the output. `runtime/egress-policy.ts` is a hand-kept mirror guarded by a parity test in `plugin-sdk/`; change both sides together.
- **Storage**: `src/nest/storage/` is the upload driver abstraction (local / S3 / mirror behind one interface, with an admin surface and a usage job). Domain services never touch the filesystem or the S3 SDK directly.
- **DB** (`src/db/`): `better-sqlite3`, WAL, FK on; `database.ts` runs `schema.ts` → `migrations.ts` → `seeds.ts`. `NODE_ENV=test` ⇒ isolated `:memory:` DB per vitest worker; `TREK_DB_FILE` ⇒ explicit file DB (Playwright harness).

## Rules for new code

- **Thin controller → injectable provider.** Never resurrect a plain function-module service; don't grow god services — split a domain into several modules when it outgrows one class (trips and auth already are).
- **Inject, don't reach for module globals.** No new imports of the global `db` proxy from `nest/` layers; no new code depending on the `ws` singleton or event-sink globals. Modules must be importable without side effects.
- **Transactions are not optional.** Multi-statement writes go in `db.transaction()`; never hand-roll `BEGIN`/`COMMIT`. Bind values with `?`; identifiers only via a literal allow-list.
- **Migrations are append-only.** Identity is positional (array index == `schema_version`) — never reorder, insert mid-list, or delete; no env interpolation in SQL.
- **Every write endpoint validates** through the Zod pipe with a schema from `@trek/shared` — no `Record<string, unknown>` + ad-hoc checks. Also verify every referenced id exists and belongs to the same trip.
- **Every outbound `fetch`** gets a timeout, a response-size cap and boundary validation — no `as`-casting provider responses, no silent `catch → null`. User-influenced URLs go through the SSRF guard. Never fall back to another user's API key.
- **Fail closed.** Unrecognized flag values mean OFF; sandbox/permission opt-outs refuse in production; never pick a less-safe path based on the *absence* of a file. GET handlers must not write.
- **Don't fork canonical paths.** Auth verification is `verifyJwtAndLoadUser` (with the `password_version` gate) — reuse it.
- **Money**: integer cents; largest-remainder splits (`BudgetService.splitEqualShares` is the reference); FX frozen at entry; explicit flags, never sentinel values; custom splits must reconcile to zero before persisting.

## Configuration (app-config)

**Never read `process.env` in `src/**`** — ESLint errors on it. All env access goes through `src/app-config/`:

- Nest classes inject a boot-stable namespace token from `src/nest/app-config/` for values frozen per app build, or use `RuntimeEnvService` / `readEnv()` for runtime-toggled values (DEMO_MODE, NODE_ENV, OIDC_*, …) that tests mutate mid-lifetime.
- Everything else calls `readEnv()` — live, uncached, per call.
- Validation is fail-fast at boot only (`boot-validate.ts`, imported by `index.ts` right after dotenv): malformed values abort startup; unset/blank defaults. Never wire validation into `buildApp()` or `ConfigModule.forRoot`, and never `cache`/snapshot a runtime-toggled value (it breaks the env-mutating tests).
- Booleans go through `parseBool` (true/1/on/yes vs false/0/off/no). Everything else pins its exact legacy coercion — quirks and the ESLint exemption list are in `src/app-config/README.md`.

## Cross-cutting pieces

- **`src/nest/common/`**: the global exception filter (error envelope), the Zod validation pipe, the idempotency interceptor (`X-Idempotency-Key` replay), and `validate-route-guards.ts` (boot-time ratchet refusing any public route not on its allow-list).
- **Auth is default-deny**: the global auth guard and the MFA policy guard run as `APP_GUARD`s, followed by the managed-install guard (`managed.guard.ts`), which refuses the routes a centrally administered install withholds from its own admin — it runs last so strangers still get a 401, never a route-revealing 403. Routes opt out with `@Public()`/`@OptionalAuth()`. The global guard stands down for routes declaring their own guard chain, so `@UseGuards(JwtAuthGuard, TripAccessGuard)` + `@RequirePermission` stacks work. Session is a cookie (`trek_session`); `@CurrentUser()` reads the user. **Never gate a multipart upload with a guard** — guards run before the parser and the client sees ECONNRESET instead of your 403; check in the handler.
- **`src/middleware/globalMiddleware.ts`** is the only Express middleware left (helmet/CSP, CORS, HSTS, forced-HTTPS, logging, cookies).

## Tests

`tests/` is split into `unit/` (mirrors `src/`), `integration/`, `e2e/` (one `<domain>.e2e.test.ts` per module, booting the real guards against a temp DB via `tests/e2e/harness.ts`) and `websocket/`; helpers in `tests/helpers/`, fixtures in `tests/fixtures/`.

- **vitest uses the SWC plugin**, not esbuild, because Nest's DI needs emitted decorator metadata. Keep that in `vitest.config.ts`. Pool is `forks` (isolated DB per worker). The config also aliases `@modelcontextprotocol/sdk/*` to its CJS dist because the SDK's exports map is unresolvable.
- **Coverage is a per-domain ratchet over `src/nest/**`** (≥80% floor, most domains pinned higher). Regenerate the block with `scripts/coverage-thresholds.mjs` when coverage rises; never lower a threshold to land a change.
- CI also runs SonarCloud on the PR's new lines — see the root `CLAUDE.md`.

## Parity discipline (when adding or changing routes)

Routes are **byte-identical** for the client: same URL, method, query/body, status, `Set-Cookie` and JSON body, including bespoke error strings reproduced in the controller. Nest defaults POST to **201** — add `@HttpCode(200)` where the contract returns 200. Declare static sub-routes (`/reorder`, `/in-app/all`) **before** `:id` param routes. Trip-scoped handlers verify trip access (404) and permission (403).
