# CLAUDE.md

Scope: the **`@trek/client`** workspace (React 19 + Vite + Zustand + Tailwind PWA). See the repo-root `CLAUDE.md` for the monorepo picture and the philosophy, `server/CLAUDE.md` for the API. This file holds the client's commands, invariants and pitfalls; `ls` the directories for the inventory.

## Commands (run from `client/`)

```bash
npm run dev               # Vite dev server; proxies the API/ws/uploads/MCP/OAuth paths → http://localhost:3001
npm run build             # prebuild generates PWA icons, then vite build
npm run typecheck         # tsc --noEmit (CI)
npm run lint              # eslint .   (lint:check in CI)
npm run lint:pages        # enforce the Page pattern (CI gate)
npm run test              # vitest run (tests/** + co-located src/**/*.test.{ts,tsx}); also test:unit / test:integration / test:coverage
npm run e2e               # Playwright (local only; e2e:report opens the last report)
npm run shots             # Playwright screenshot project (shots:promote to accept)
npm run theme:lint        # theme conformance audit (theme:lint:strict exits 1; local only)
npm run check:gl-split    # after build: fails if one chunk bundles both mapbox-gl and maplibre-gl (local only)
```

Single test: `npx vitest run src/store/slices/budgetSlice.test.ts`, or `npx vitest run -t "optimistically adds the place"`.

The dev server needs the API on **:3001** — run `npm run dev` at the repo root to start both.

## Page pattern (enforced — `lint:pages` fails otherwise)

Every `src/pages/*Page.tsx` is a thin **wiring container**; all state/effects/handlers live in a co-located **`use<Page>()` hook** under `src/pages/<page>/`. The page body must **not** call React state/effect/memo/ref hooks — only context hooks like `useTranslation()`. An optional `<page>Model.ts` holds pure, React-free types and helpers. Full spec in `src/pages/PATTERN.md`. When extracting, keep the rendered JSX byte-identical — it is a refactor of where logic lives.

## Data flow — offline-first

The layering is **component → feature hook → store/slice → `repo/` → `api/` | Dexie**, and writes go through a mutation queue:

- **`src/store/`** — Zustand. `tripStore.ts` is composed from slices in `store/slices/`; `slices/remoteEventHandler.ts` applies inbound WebSocket events to local state.
- **`src/repo/`** — per-entity repositories mediating between the network and the offline cache: online, call REST and upsert into Dexie; offline, read Dexie. Always go through a repo for trip data.
- **`src/api/client.ts`** — the single Axios instance, typed from `@trek/shared`. New API surface goes in a per-domain `api/<domain>.ts`, not the god module.
- **`src/db/offlineDb.ts`** — the Dexie schema. Database and table names are the on-device contract — renaming one orphans every user's cache.
- **`src/sync/`** — `mutationQueue.ts`: offline writes do an optimistic Dexie write (temporary **negative id** for creates), then `flush()` replays REST on reconnect with the mutation's UUID as the **`X-Idempotency-Key`** header (matching the server interceptor) and reconciles the row. The rest of the directory drives reconnection sync, the auth gate that stops background loops before logout swaps the DB, offline preferences, and map pre-download (raster and vector prefetchers).

## Rules for new code

The offline core is flagship work surrounded by a periphery that ignores it. New code extends the core's discipline, not the periphery's shortcuts:

- **One data path, no layer skips.** Never import `api/client` (or raw fetch/axios) from a component or modal — especially never *write* from one. A long tail of existing files bypasses the layering and no lint ratchet holds the line yet; that is debt, not precedent.
- **Offline-first is the product promise.** New domains get a repo with read-through and offline writes (temp id → optimistic Dexie write → idempotent queue entry). If a domain is deliberately online-only, say so explicitly.
- **No god components or god hooks.** The page pattern is a floor, not a ceiling. Decompose hooks by concern, split renders into memoizable sections, and don't pass huge prop bags with inline-arrow callbacks.
- **Prefer React 19 idioms**: `useOptimistic`, `useActionState`/`useFormStatus`, `use()` + Suspense, `useSyncExternalStore` for external subscriptions (`hooks/useNetworkMode` is the reference).
- **Optimistic writes must reconcile** — rollback + user-visible toast on failure. No `.catch(() => {})`, no bare `catch {}`.
- **WS remote-event handling must match local slice reducers field-for-field.** Divergence is silent, cross-user data loss.
- **Subscribe with selectors** (`useShallow` for multi-field reads); never whole-store subscriptions; `getState()` for imperative access in effects.
- **Connectivity**: `isEffectivelyOffline()` is the single source of truth — never read `navigator.onLine` in feature code.
- **Rendering security**: never interpolate user content into HTML strings (map popups included — build via DOM + `textContent`, or `escapeHtml` from `@trek/shared`); untrusted markdown gets `rehype-sanitize`; never `rehype-raw` near it.
- **No `window` event buses or global mutable `window` state.** No `any` at boundaries: WS payloads and map renderer props get real types.
- **Hygiene**: error boundaries around new shells/routes (`components/shared/ErrorBoundary.tsx`); every async `.then(setState)` needs a cancelled flag or `AbortController`; no routine `eslint-disable exhaustive-deps` (a missing dep has already shipped wrong money on screen); no sequential-await N+1 fetch loops; search for an existing utility before writing a duplicate.
- **Theming**: use the semantic Tailwind tokens defined in `tailwind.config.js` (`bg-surface*`, `text-content*`, `border-edge*`, `bg-accent*`, status colors) — no palette classes, hex literals, arbitrary-value color classes, or invented CSS vars. Only `applyAppearance()` in `src/theme/` mutates `<html>` styling (see `src/theme/README.md`). `theme:lint` catches literals and `bg-[#...]`-style classes but not named palette classes — review those by hand.

## Big-picture pieces

- **Maps** (`src/components/Map/`): two interchangeable renderers — Leaflet and Mapbox/MapLibre GL — chosen at runtime by `MapViewAuto.tsx`. Keep both in sync when changing map features, and keep `mapbox-gl` and `maplibre-gl` in separate chunks (`check:gl-split`). The raster prefetcher fetches tiles `no-cors` so custom tile providers without CORS headers keep working; the vector prefetcher deliberately uses `cors` because it has to read the responses — don't "align" one with the other.
- **i18n** (`src/i18n/TranslationContext.tsx`): `en` is bundled; every other locale is a dynamic `import('@trek/shared/i18n/<locale>')` so Vite emits one chunk per locale. Strings live in `shared/`, never here.
- **Mobile shell** (`src/mobile/`): below the phone breakpoint (`useIsPhone`) `App.tsx` wraps routes in `MobileShell` and the `M*` screens under `mobile/screens/` take over. A UI change to a domain with an `M*` twin usually needs both — and the shared-hook rule below.
- **Plugins UI** (`src/components/Plugins/`): third-party surfaces render only inside the sandboxed `PluginFrame` iframe (postMessage bridge, live theme-token sync). Host-rendered contribution points (widgets, schedule rows, map layers, planner columns/actions) render server-normalized primitives only — plugin markup never runs inline. Authoring is covered by the `trek-plugin-dev` skill.
- **Managed installs** (`src/managed/index.tsx`): the attachment point for screens that only exist on a centrally administered install. Empty here by design — an operator replaces it at build time. Don't put features there.

## Desktop ↔ mobile shells and the SonarQube duplication gate

Every desktop component with a phone twin is a deliberate copy that is already heavily duplicated. CI's SonarCloud gate allows **≤ 3% duplicated lines on the PR's new code**, so adding the same lines to both shells fails the PR by itself. Put logic in one shared hook/module (`useInstanceSettings`, `useRangeBypass` under `components/Admin/` are the pattern) and keep only markup in each shell. Full gate rules in the root `CLAUDE.md`.

## Tests

vitest with `@vitejs/plugin-react`, a custom jsdom environment (`tests/environment/`), `forks` pool. Tests live in `tests/{unit,integration}/` and co-located as `src/**/*.test.{ts,tsx}`. `msw` mocks HTTP, `fake-indexeddb` backs Dexie. Page tests render JSX against a mocked hook; hook/slice logic is tested in isolation (see `store/slices/budgetSlice.test.ts`).
