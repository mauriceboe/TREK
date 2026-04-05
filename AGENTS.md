# TREK — Agent Development Guidelines

This document is the **authoritative reference for all AI agents** working on this codebase.
Read it entirely before writing a single line of code.

---

## ⚠️ Iron Rules (non-negotiable)

### Before opening ANY pull request:

```bash
# 1. Server tests — ALL must pass
cd server && npm test
# Expected: Test Files XX passed (XX) | Tests 775+ passed

# 2. Client tests — ALL must pass
cd client && npm test
# Expected: all pass, 0 failures

# ✅ Both green → push and open PR
# ❌ Either fails → fix first, do not open PR
```

**Never** use `continue-on-error: true` on any test job in GitHub Actions.
**Never** merge a PR with failing CI checks.

---

## Branch Workflow

```bash
git checkout main && git pull
git checkout -b feat/<feature-name>   # or fix/<bug-name>

# ... implement, commit incrementally ...

# Before pushing — run BOTH test suites (see Iron Rules above)
cd server && npm test && cd ../client && npm test

git push origin <branch>
gh pr create --base main --head <branch> --title "..." --body "..."
gh pr checks --watch          # wait for CI
gh pr merge --squash --delete-branch
git checkout main && git pull
```

All commits must include the Co-authored-by trailer:
```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Project Structure

```
TREK/
├── server/                   # Express + TypeScript backend
│   ├── src/
│   │   ├── app.ts            # Express app setup — register routes here
│   │   ├── config.ts         # Environment variables / JWT secret
│   │   ├── db/
│   │   │   ├── schema.ts     # CREATE TABLE statements (source of truth for columns)
│   │   │   ├── migrations.ts # ALTER TABLE migrations array (append-only)
│   │   │   └── database.ts   # db singleton + helpers (canAccessTrip, isOwner)
│   │   ├── routes/           # Express routers — one file per resource
│   │   ├── services/         # Business logic — no Express here
│   │   ├── mcp/
│   │   │   ├── index.ts      # MCP auth, sessions, rate limiting
│   │   │   ├── tools.ts      # ALL MCP tools registered in registerTools()
│   │   │   └── resources.ts  # MCP resources
│   │   ├── middleware/
│   │   │   └── auth.ts       # authenticate middleware + AuthRequest type
│   │   └── schemas/          # Zod validation schemas for routes
│   └── tests/
│       ├── integration/      # Supertest integration tests (one file per route)
│       └── unit/             # Unit tests for services
│
├── client/                   # React + Vite + TypeScript frontend
│   └── src/
│       ├── api/
│       │   ├── client.ts     # Axios API wrappers — one namespace per resource
│       │   └── types.ts      # Shared TypeScript interfaces
│       ├── components/       # React components
│       ├── pages/            # Page-level components
│       └── test/             # Vitest tests
│           ├── api/          # API client tests
│           └── utils/        # Utility function tests
│
├── .github/workflows/
│   └── test.yml              # CI: runs server + client tests on every PR
├── docker-compose.yml        # Production deployment
└── server/.env.example       # Environment variable documentation
```

---

## Database Patterns

### Adding a new column

**Step 1** — Add to `schema.ts` `CREATE TABLE` block (for fresh installs):
```sql
new_column TEXT,
```

**Step 2** — Append to `migrations.ts` array (for existing installs):
```typescript
// Simple column add
() => { try { db.exec('ALTER TABLE users ADD COLUMN new_column TEXT'); } catch (err: any) { if (!err.message?.includes('duplicate column name')) throw err; } },

// For non-trivial migrations
() => {
  // wrap in try/catch only for idempotent ops
  db.exec('CREATE TABLE IF NOT EXISTS ...');
},
```

**Rules:**
- The `migrations` array is **append-only** — never change existing entries
- Each migration runs in a transaction and will `process.exit(1)` on failure
- Use `duplicate column name` guard for `ALTER TABLE ADD COLUMN` to be idempotent

### Never do module-level `db.prepare()`

```typescript
// ❌ WRONG — crashes tests before runMigrations() runs
const stmt = db.prepare('SELECT * FROM new_table');

// ✅ CORRECT — lazy initialization
let stmt: ReturnType<typeof db.prepare> | null = null;
function getStmt() {
  if (!stmt) stmt = db.prepare('SELECT * FROM new_table');
  return stmt;
}
```

---

## API Key Pattern

All user-supplied API keys follow this pattern:

1. **Storage**: encrypted in `users` table via `encrypt_api_key()` from `apiKeyCrypto.ts`
2. **Resolution priority** (implement in this order in your service):
   ```typescript
   process.env.MY_API_KEY          // 1. env var (docker-compose / .env)
   → user's encrypted DB key       // 2. per-user key
   → admin's encrypted DB key      // 3. admin fallback
   ```
3. **Read** with `decrypt_api_key(value)` — handles `enc:v1:` prefix and legacy plaintext
4. **Write** with `maybe_encrypt_api_key(value)` — skips empty strings, avoids double-encrypt
5. **Display** with `mask_stored_api_key(value)` — returns `••••••••<last4>` for UI

### Adding a new API key type (e.g. `my_service_api_key`)

```
schema.ts          → add `my_service_api_key TEXT,` to users table
migrations.ts      → append ALTER TABLE migration
userService.ts     → add to updateApiKeys(), updateSettings(), getSettings()
myService.ts       → implement getMyKey(userId) with 3-level resolution
routes/myService.ts → new router + GET /api/my-service/...
app.ts             → register app.use('/api/my-service', myServiceRoutes)
.env.example       → document MY_SERVICE_API_KEY=
docker-compose.yml → add commented #- MY_SERVICE_API_KEY=${MY_SERVICE_API_KEY:-}
AdminPage.tsx      → add key input field (load/save/show-hide)
```

---

## MCP Tools Pattern

All MCP tools live in `server/src/mcp/tools.ts` inside `registerTools(server, userId)`.

```typescript
server.registerTool(
  'tool_name',
  {
    description: 'Clear description of what this does. Mention when to use it relative to other tools.',
    inputSchema: {
      tripId: z.number().int().positive(),
      name:   z.string().min(1).max(200),
    },
  },
  async ({ tripId, name }) => {
    if (isDemoUser(userId)) return demoDenied();
    if (!canAccessTrip(tripId, userId)) return noAccess();

    // ... logic ...

    return ok({ result });          // success
    // return { content: [{ type: 'text', text: '...' }], isError: true };  // error
  }
);
```

**Helper functions** (already defined in tools.ts):
- `ok(data)` — wraps data as `{ content: [{ type: 'text', text: JSON.stringify(data) }] }`
- `noAccess()` — returns 403-style error
- `demoDenied()` — returns demo mode error
- `isDemoUser(userId)` — checks demo mode

**When adding a tool**, also update the MCP documentation in `MCP.md` if it's user-facing.

---

## Route + Validation Pattern

```typescript
// routes/myResource.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  optional_field: z.string().optional().nullable(),
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const userId = (req as AuthRequest).user.id;
  // ... call service ...
  res.status(201).json(result);
});

export default router;
```

---

## Testing

### Server tests (Vitest + Supertest)

```bash
cd server && npm test              # run all
cd server && npm run test:coverage # with coverage report
```

- Test files: `server/tests/integration/` and `server/tests/unit/`
- Each integration test file gets a fresh in-memory SQLite DB via `testDb` helper
- `beforeAll`: calls `createTables(testDb)` + `runMigrations()` — always in this order
- Mock external HTTP calls with `vi.stubGlobal('fetch', mockFetch)`
- **Do not** call real APIs in tests

### Client tests (Vitest + @testing-library/react)

```bash
cd client && npm test              # run all
cd client && npm run test:coverage # with coverage report
```

- Test files: `client/src/test/`
- Mock axios with `vi.hoisted()` + `vi.mock('axios', ...)` pattern:
  ```typescript
  const mockGet = vi.hoisted(() => vi.fn());
  vi.mock('axios', () => ({ default: { create: () => ({ get: mockGet, ... }) } }));
  ```
- Mock websocket: `vi.mock('../api/websocket', () => ({ getSocketId: vi.fn(), ... }))`

### Coverage requirements

- Overall coverage target: **≥ 80%**
- All public API endpoints must have at least one integration test
- All pure utility functions must have unit tests

---

## Environment Variables

### Adding a new env var

1. Add to `server/.env.example` with a comment explaining it
2. Add to `docker-compose.yml` as a commented line:
   ```yaml
   #      - MY_VAR=${MY_VAR:-}   # Description of what this does
   ```
3. Read in code via `process.env.MY_VAR` (add to `server/src/config.ts` if used widely)

### Local development

Create `server/.env` (git-ignored) from `server/.env.example`.
**Never commit secrets or API keys** — `.env` is in `.gitignore`.

---

## Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| Module-level `db.prepare()` breaks all tests | Use lazy initialization (see DB Patterns) |
| `continue-on-error: true` hides test failures | Remove it — test failures must be visible |
| `metadata` sent as object → Zod rejects | `JSON.stringify(metadata)` before sending to API |
| `new Date("20:20")` → Invalid Date | Check `isTimeOnly()` before constructing Date |
| Empty string sent to nullable field | Coerce `'' → null` in form submit handler |
| PR opened before running tests locally | Run both test suites first — iron rule |
| New table queried before migration runs | Lazy-init all `db.prepare()` for new tables |

---

## Docker / Production

```yaml
# docker-compose.yml pattern for new env vars:
environment:
  - EXISTING_VAR=${EXISTING_VAR:-}
#      - NEW_API_KEY=${NEW_API_KEY:-}   # Description. Get from: https://example.com
```

The image is published as `hwchiu/trip:latest`. CI builds and pushes on merge to `main`.

---

## What "Done" Means

A feature is **done** when:
- [ ] Implementation complete and TypeScript compiles (`npx tsc --noEmit`)
- [ ] Server tests pass: `cd server && npm test`
- [ ] Client tests pass: `cd client && npm test`
- [ ] New functionality has tests (integration + unit as appropriate)
- [ ] `server/.env.example` updated if new env vars added
- [ ] `docker-compose.yml` updated if new env vars added
- [ ] PR opened, CI green, merged to main
