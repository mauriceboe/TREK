# CLAUDE.md

Scope: the **`@trek/shared`** workspace — the **single source of truth** for API contracts (Zod) and all i18n strings; server and client both import from it. See the repo-root `CLAUDE.md` for the monorepo picture.

## Commands (run from `shared/`)

```bash
npm run build              # tsdown → dist/ (CJS + ESM + .d.ts). REQUIRED before server/client typecheck or run
npm run build:watch        # what the root `npm run dev` runs
npm run typecheck          # tsc --noEmit
npm run lint               # eslint --fix (rewrites files)
npm run test               # vitest run — co-located *.spec.ts files
npm run i18n:parity        # audit locale drift, exits 0
npm run i18n:parity:strict # CI gate — exits 1 on any drift
```

Single test: `npx vitest run src/i18n/i18n-parity.spec.ts`, or `npx vitest run -t "rejects extra keys"`.

**Always rebuild after changing a schema or locale** — the consumers import the compiled `dist/`, not `src/`. If a server/client typecheck can't see a new export, you forgot `npm run build` here.

## Build & exports

`tsdown.config.ts` emits the root barrel, the i18n metadata barrel, and **one entry per locale** so each locale is its own lazy-loadable chunk (the client dynamic-imports them). `zod` is never bundled. The `exports` map exposes `@trek/shared` (contracts), `@trek/shared/i18n` (metadata/types) and `@trek/shared/i18n/<locale>`.

## Contracts (`src/<domain>/<domain>.schema.ts`)

One folder per domain exporting Zod schemas plus inferred types (`export type X = z.infer<typeof xSchema>`), re-exported from the root barrel. Domain-agnostic primitives (`idSchema`, `idParamSchema`, `nonEmptyString`, pagination) live in `src/common/`. A few pure isomorphic helpers live beside the schemas because both sides need the same answer; they follow the same rules as everything here.

**`src/plugin-permissions.ts` is machine-generated** from the server's plugin protocol — never hand-edit it; `npm run gen:plugin-facts` from `server/` regenerates it and `check:plugin-facts` is the CI drift gate.

**Schemas mirror the exact wire behavior of existing routes** (`weather/weather.schema.ts` is the example): strings stay strings if the route never coerced them, optional fields reflect partial response subsets, and bespoke 4xx error strings are reproduced in the server controller, not derived from the schema. Don't "tidy up" a schema to be stricter than the contract it documents.

## Rules for new contracts

The parity rule governs **existing** routes; it is not a license to mint new debt:

- **The contract describes the wire, not the storage engine.** New booleans are `z.boolean()` — convert SQLite 0/1 at the service boundary, never add a `z.union([z.boolean(), z.number()])`. New ids use `idSchema`/`idParamSchema`, never `number | string`. Request and response types for a field must agree.
- **Use the shared primitives** instead of re-declaring bare `z.number()`/`z.string()` per domain. Narrow an existing open object rather than adding a new `z.record(...)`/passthrough body — "any object" gives zero drift protection.
- **Add a schema, add a spec** — especially for lenient parsers fed by untrusted or LLM input.
- **Stay lean and isomorphic**: zero imports from client/server, no `node:` APIs, effectively no new runtime dependencies (the contract layer approaches `zod`-only; i18n is a separable concern — don't couple new contract code to it).
- **Never hand-copy a locale list.** `SUPPORTED_LANGUAGES` in `src/i18n/languages.ts` is the one registry — derive barrels, loaders and spec maps from it.
- **This is the monorepo's strict-TypeScript template** (`strict` + `noUncheckedIndexedAccess`). No new `any`, no new suppressions.

## i18n (`src/i18n/`)

- **`languages.ts`** — `SUPPORTED_LANGUAGES` is the canonical registry and the source of `SupportedLanguageCode`. Adding a language starts here.
- **`<locale>/`** — one folder per language, one file per UI domain plus an `index.ts` barrel; each file exports a flat map of dot-namespaced keys typed as `TranslationStrings`. The runtime `t(key)` only resolves these top-level keys.
- **`en/` is canonical.** Every other locale must have the identical file set and top-level keys — `i18n:parity:strict` enforces it in CI. When you add or rename a key, update every locale.
- **Every locale gets a real translation — an English placeholder is not acceptable.** Parity only checks that the key exists, so copying the `en` string passes CI while shipping English to those users. Write native phrasing with the locale's own punctuation and the same `{placeholders}` as `en`; if you genuinely cannot translate one, say so instead of filling it with English.
- **Further i18n specs run in `npm test`** and fail changes that parity lets through: placeholder parity (every `{placeholder}` in an `en` string must appear in each translation), no `en` string may call TREK "self-hosted" (the same build runs on managed installs; exemptions live in the spec), and a wording regression test for plugin permission descriptions (currently one string — add a case there when a permission's real behavior changes). None of these are part of `i18n:parity`, which checks key sets only.

## Sanitization (`src/sanitize/sanitize.ts`)

`isomorphic-dompurify` with a minimal inline-only allow-list (a rich-text variant already exists there for when rich text ships). `sanitizeInlineHtml` backs the client's HTML translation path; `escapeHtml` is used wherever the client builds markup from user strings (map popups, account screens). This is meant to be the one home for escaping. No lint rule enforces that yet and a handful of client files still carry a local `escapeHtml` — that is debt to fold in, not a pattern to copy.
