# CLAUDE.md

Guidance for Claude Code in this repository. This file holds the commands, the invariants, the gates and the philosophy. Inventories (file lists, counts, history) deliberately live in the code and its READMEs, not here — when this file disagrees with the code, the code wins; fix the doc.

## What TREK is

A self-hosted, real-time collaborative travel planner. npm-workspaces monorepo:

- **`shared/`** (`@trek/shared`) — Zod schemas, the **single source of truth** for API contracts, plus all i18n locales. Must be built before server/client typecheck or run.
- **`server/`** (`@trek/server`) — NestJS API (Express adapter), SQLite via `better-sqlite3`, WebSocket sync, built-in MCP server, sandboxed plugin runtime.
- **`client/`** (`@trek/client`) — React 19 + Vite + Zustand + Tailwind PWA, offline-first via Dexie/IndexedDB.
- **`plugin-sdk/`** (`trek-plugin-sdk`) — **not a root workspace**: own lockfile, published to npm independently, must ship standalone. Run its commands from `plugin-sdk/`.

Each package has its own `CLAUDE.md`; this file covers the monorepo picture.

## Commands

Run from the repo root unless noted. **Use `npm run ... --workspace=<pkg>`, not `npm -w <pkg>`**.

```bash
npm run dev                       # build shared, then watch shared + server + client concurrently
npm run build                     # build shared → server → client (order matters)
npm run lint                      # lint all three workspaces (server and shared run eslint --fix and rewrite files; client is check-only)
npm run format                    # prettier --write all three
```

Tests:

```bash
npm run test                                       # all workspaces
npm run test --workspace=server                    # vitest run (server); also test:unit / test:integration / test:ws
npm run test:e2e                                   # server e2e (boots Nest against a temp SQLite)
npm run test:cov                                   # coverage (lcov) for all four packages incl. plugin-sdk
cd client && npm run test                          # client vitest run
cd client && npm run e2e                           # Playwright (local only)
cd client && npm run lint:pages                    # enforce the Page pattern (CI gate)
cd client && npm run theme:lint                    # flag styling that bypasses appearance tokens (local only)
npm run typecheck --workspace=server               # tsc --noEmit (also client/shared; server also has typecheck:tests)
```

Run a single test file or test:

```bash
npx vitest run tests/unit/nest/weather.controller.test.ts   # (from server/ or client/)
npx vitest run -t "name of the test"                        # by test-name pattern
```

i18n parity (CI gate — every non-`en` locale must have the identical file set and top-level keys):

```bash
npm run i18n:parity --workspace=shared            # audit (exit 0)
npm run i18n:parity:strict --workspace=shared     # CI gate (exit 1 on drift)
```

Dev ports: the server listens on **3001**; the Vite dev server proxies the API, websocket, uploads, MCP and OAuth paths to it (see `client/vite.config.js`). There is no Node version pin — the CI workflows and the Dockerfile define what is tested. `server/.env.example` is the env-var reference.

## Server invariants

Nest owns everything: every domain is a DI module under `server/src/nest/<domain>/` (`controller` + `service` + `module`, registered in `app.module.ts`), and ESLint refuses imports of the deleted legacy `services/` layer. `server/src/nest/README.md` is the module blueprint; **`weather/` is the reference implementation** — copy its shape. The domain's Zod contract lives in `shared/src/<domain>/`.

- **`bootstrap.ts` — `buildApp()`** is the single builder for production and the test harness. **Composition order is load-bearing**: everything registered on the raw Express instance must come **before `app.init()`**, because Nest's router throws `NotFoundException` on unmatched routes and nothing registered after init is reachable. Don't add routes to that pre-init shell — it bypasses every global guard, interceptor and filter.
- **`/mcp` bodies are raw by design** — the parser wrappers exempt `/mcp` so the MCP SDK reads the untouched stream; never `@Body()` a `/mcp` route.
- **Auth is default-deny**: global guards run as `APP_GUARD`s; public routes opt out with `@Public()`, and a boot-time ratchet (`validate-route-guards.ts`) refuses any public route not on its allow-list.
- **Trip-scoped routes** verify trip access (404) and the permission (403) — `@UseGuards(JwtAuthGuard, TripAccessGuard)` + `@RequirePermission('<action>')` per handler — and forward `X-Socket-Id` to the broadcast so the originating client doesn't echo its own change. **Never gate a multipart upload with a guard** (the client sees ECONNRESET instead of 403 — check in the handler).
- **DB** (`server/src/db/`): `better-sqlite3`, WAL, FK on. Migrations are positional and append-only. `NODE_ENV=test` gives each vitest worker an isolated `:memory:` DB.
- **Realtime**: `/ws` is a Nest gateway in `server/src/nest/realtime/` — inject `RealtimeService`; `server/src/websocket.ts` is a legacy re-export stub.
- **MCP**: tools are declared in `<domain>.mcp.ts` files beside each module, on the `server/src/nest-mcp/` decorator layer. A validation or permission change on a REST route must land in the parallel MCP tool in the same change. See `MCP.md`.
- **Addons** are admin-toggleable feature modules keyed by `ADDON_IDS` in `server/src/addons.ts`.
- **Plugins** (`server/src/nest/plugins/`): one forked child process per plugin, permission-gated RPC (a handler is registered only if the plugin holds the unlocking permission), install-time manifest/signature/egress/version-range gates. The protocol tables are **generated** into `plugin-sdk/` and `shared/` by `gen:plugin-facts`; `check:plugin-facts` is the CI gate. Author tooling is `plugin-sdk/`; the `trek-plugin-dev` skill covers authoring.
- **Storage**: uploads go through the driver abstraction in `server/src/nest/storage/` (local / S3 / mirror). Never touch the filesystem or the S3 SDK from a domain service.
- **Crons** go through `server/src/nest/scheduling/` only — never a `@Cron` decorator (it bypasses the test-time gate).

## Client invariants

Offline-first, with a layered data flow. A Page never owns state directly:

- **Page pattern** (enforced by `lint:pages`, spec in `client/src/pages/PATTERN.md`): a `*Page.tsx` is a **wiring container** composing a co-located `use<Page>()` hook; it must not call React state/effect/memo hooks itself.
- **Data flow**: `store (Zustand, client/src/store/) → repo (client/src/repo/) → api (client/src/api/) | Dexie (client/src/db/offlineDb.ts)`. Writes go through `sync/mutationQueue.ts`: optimistic Dexie write, then a replay with an `X-Idempotency-Key` header on reconnect. `store/slices/remoteEventHandler.ts` applies incoming WebSocket events. Components never call the API directly.
- **Styling**: semantic Tailwind tokens (`bg-surface*`, `text-content*`, `border-edge*`, `bg-accent*`) or the underlying `var(--token)` variables — never color literals, arbitrary-value color classes or numeric inline `fontSize`, so user-chosen scheme/transparency/text-size keep working. `theme:lint` flags bypasses; suppress intentional exceptions (map/PDF/brand) with a `theme-lint-disable` line comment.
- **PWA**: `vite-plugin-pwa` + Workbox cache tiles, API and uploads; `prebuild` generates icons.

## Shared contracts & i18n

- A route is "done" only once its contract lives in `shared/` and both sides import the inferred types. Edit the Zod schema, rebuild shared, then server (validation + DTO types) and client (typed requests) pick it up.
- Locale files live in `shared/src/i18n/<locale>/`, one file per domain; `en/` is canonical. When you add or change a key, **add a real translation to every locale** — parity fails CI on missing keys, and an English placeholder is not acceptable in a non-`en` locale.

## Project direction

These principles come out of a full-repo audit and shape all new code:

- **Protect the crown jewels.** The client's offline-first data core (repos + mutation queue + Dexie), the out-of-process plugin sandbox, the Zod contract layer, and the auth primitives are production-grade. Extend them; never route around them or rewrite them in anger.
- **No "modern shell over legacy core."** The debt pattern is a modern frame delegating to the old approach underneath (on the client: feature components calling the raw API past the offline core). New code goes all-in on the target architecture; when touching a legacy seam, migrate it rather than adding another wrapper.
- **Single source of truth over manual synchronization.** Never add a hand-mirrored copy of state, schema, or contract (server↔Dexie↔Zustand, schema↔SQL, the plugin contract). Derive from one source, or guard the copy with a parity test that cannot silently skip.
- **DI over global mutable module state.** New server code injects its dependencies; new client code avoids `window`-global buses and mutable module state.
- **Use the runtime's native idioms.** Prefer React 19 features (`useOptimistic`, Actions, `use()`/Suspense) and Nest subsystems (providers, pipes, guards, `@nestjs/schedule`) over hand-rolled equivalents.
- **Fail closed, gates stay on.** Security switches default to safe; misconfiguration must refuse, not degrade. Never lower a quality gate to land a change — no new `any`, no new `eslint-disable`, no downgrading rules to `warn`, no lowered coverage thresholds.

## Conventions (from CONTRIBUTING.md)

- **Target the `dev` branch** for PRs, not `main` (exception: `wiki/`-only changes).
- **Discuss first**: outside contributions are pitched in the `#github-pr` Discord channel before any code is written.
- **PRs follow `.github/PULL_REQUEST_TEMPLATE.md`** and need a linked issue (`Closes #N`) for fixes or an approved feature discussion for features.
- **Conventional commits** (`fix(maps): ...`, `feat(budget): ...`). **No Co-Authored-By or other tool-attribution trailers.**
- One focused change per PR; no breaking changes; no unrelated reformatting. Tests ship in the same change — the project holds 80%+ coverage.
- **Parity is law** when touching a route: same URL, method, query/body, HTTP status, `Set-Cookie` and JSON body, including bespoke error strings. Nest defaults POST to 201 — add `@HttpCode(200)` where the contract returns 200. Declare static sub-routes (`/reorder`) **before** `:id` param routes.

## Quality gates in CI

`.github/workflows/test.yml` runs, per package: typecheck (server also `typecheck:tests`), `lint:check`, `lint:pages`, `check:plugin-facts`, `i18n:parity:strict`, the S3 contract suite, coverage for all four packages, then a SonarCloud scan. `lint-prettier.yml` additionally runs `lint` + `format:check` on `shared/`. `plugin-sdk` has no lint script and is outside the eslint gates. **Not in CI**: `theme:lint`, Playwright, `check:gl-split` — run them locally. There are no git hooks; nothing runs before a commit except you. Other workflows build Docker images, scan them, and publish `trek-plugin-sdk` on `plugin-sdk-v*` tags.

**SonarCloud** (project `liketrek_TREK`, the built-in Sonar way gate; the run takes 20–25 min, so get it right before pushing) measures **new code only** on a PR; any failing condition blocks it:

| Condition (new code) | Must be |
|---|---|
| Coverage | ≥ 80% |
| Duplicated lines | ≤ 3% |
| Security / reliability / maintainability rating | A |
| Security hotspots reviewed | 100% |

- **Duplication is the one that bites.** Desktop and phone shells (`client/src/components/<X>` ↔ `client/src/mobile/screens/.../M<X>`) are deliberate mirrors that are already heavily duplicated. Every line added identically to both counts against the 3% budget, so a feature touching both shells fails on its own. Put the logic in ONE hook/module (precedents: `useInstanceSettings`, `useRangeBypass` under `client/src/components/Admin/`) and leave only markup in each shell. Locale files are excluded from duplication, so i18n additions are free.
- **Coverage is per new line across all four packages.** A new file without tests drags the PR under 80%. Files in `sonar.coverage.exclusions` don't count either way.
- **Ratings are about new issues.** One new bug drops reliability; one new vulnerability drops security. Don't introduce hotspot patterns (`Math.random` in anything security-adjacent, `child_process` through PATH, backtracking regexes, secret-looking strings). Path-wide suppressions live only in `sonar-project.properties` with a written justification; one-off findings are resolved on SonarCloud, never with an inline `// NOSONAR`.
- **Check it yourself.** The `sonarqube` MCP is connected: `list_pull_requests` → `get_project_quality_gate_status` shows each condition's value; `search_duplicated_files` + `get_duplications` show what tripped duplication; `search_sonar_issues_in_projects` lists new issues. Test files are excluded from analysis — when duplication fires, the source is the problem.

## Reference docs

- `MCP.md` (MCP server, tools, scopes) · `README.md` (deployment, env vars, reverse proxy) · `server/src/nest/README.md` (module blueprint, test layout) · `server/src/app-config/README.md` (env parsing quirks) · `plugin-sdk/README.md` (plugin author guide).
- `wiki/` — end-user documentation. `Dockerfile` / `docker-compose*.yml` — the deployment path and the local S3 test stack.
