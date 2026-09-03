# Plugin Development

Build a plugin with the `trek-plugin-sdk` package. A plugin is a directory with a
manifest (`trek-plugin.json`), a built server entry, and — for page/widget
plugins — a static client bundle. TREK runs your server code in an **isolated
child process** and reaches it only over RPC; the browser part runs in a
**sandboxed, opaque-origin iframe**. There is no other way in or out.

## Before you start

Two resources sit alongside this page:

- **[Plugin-Skill](https://github.com/liketrek/Plugin-Skill)** — an agent skill
  that teaches Claude Code and other SKILL.md-compatible coding agents how to
  build, test and publish a TREK plugin. It covers the same ground as this page,
  but the agent reads it instead of you. Add it to the repo you build your plugin
  in and it loads automatically whenever the task touches TREK plugins.
- **[TREK-Plugins](https://github.com/liketrek/TREK-Plugins)** — the community
  registry. It is a static index with no server and no account: you list a plugin
  by opening a pull request that adds one JSON file. Your plugin's code stays in
  your own repository; the registry only points at it. See
  [Plugin-Publishing](Plugin-Publishing) for the submission flow and the CI gates.

Neither is required. You can build, install and run a plugin without touching
either — the registry only matters when you want other people's TREK instances
to find it.

## Scaffold

```bash
npx trek-plugin-sdk create                # interactive wizard
npx trek-plugin-sdk create my-plugin --type integration|page|widget|trip-page   # or direct
cd my-plugin
```

The wizard (run `create` with no name) asks for the id, type, author, icon (checked
against lucide — a typo there is invisible locally but rejected by the registry),
permissions, egress hosts and required addons; the direct form takes them as flags.

This emits:

```
my-plugin/
  trek-plugin.json      # manifest — including `icon`, and a widget's `slot`
  package.json          # CommonJS marker + the SDK as a devDependency
  server/index.js       # your plugin code (built, plain JS)
  client/index.html     # native UI via the design kit (page / widget / trip-page only)
  README.md             # fill this in — the registry requires four sections and a screenshot
  docs/                 # where docs/screenshot.png goes; `trek-plugin shot` writes it
  .gitattributes        # LF everywhere, so the packed artifact's sha256 is reproducible
```

The scaffold declares `"trek": ">=4.0.0 <5.0.0"` — the host surface it is written
against is the TREK 4 surface, and claiming an older floor would let the plugin
install on a host where parts of it are missing. Picking `oauth:client` in the wizard
also scaffolds the five instance-scope settings the OAuth broker reads (see
[Host-brokered OAuth](#host-brokered-oauth-ctxoauth)).

What you get **runs and packs immediately**, but it does **not** pass `validate` yet:
the README is still a template and there is no screenshot. That is deliberate — those
are yours to write — and `trek-plugin status` says exactly what is missing.

## Run it locally with hot reload

```bash
npx trek-plugin-sdk dev        # http://localhost:4317
```

`dev` works straight after `create` — no `npm install` needed, because it
injects `require('trek-plugin-sdk')` from the CLI itself, exactly like TREK
injects it in production. It loads your `server/index.js` through the same
`definePlugin` contract the host uses and gives you a **real request loop
without a full TREK**: a dashboard
listing your routes, the routes served under `/api/<path>`, your page/widget UI
at `/ui`, a **themed host preview at `/preview`** (a real sandboxed frame with a
theme/accent/appearance toggle, `trek.invoke()` proxied to your routes), and a reload
on every save. The injected `ctx` is the **full surface** — every capability (`costs`, `packing`,
`files`, `notify`, `ai`, `settings`, `scheduler`, `meta`, `oauth`, `weather`, `rates`,
`journal`, `db.tx`, …), not just routes + `db:own` — and **enforces exactly the
permissions your manifest grants**: an ungranted call throws `PERMISSION_DENIED`, so
you catch a missing grant here rather than after install. `db:own` is backed by a real
SQLite file (`.trek-dev/db.sqlite`) when the runtime has `node:sqlite`; every other
capability is served from your fixtures with the same rules as production.

- Hit a route as an unauthenticated request with `?_anon=1` (an `auth: true`
  route then returns 401, mirroring the host).
- Feed the fixtures by dropping a `dev-fixtures.json` next to the manifest — it takes
  the **same shape as `createMockHost` options**, so you can seed trips, users, costs,
  settings, weather, canned AI results, etc.: `{ "actingUserId": 1, "trips": { "1": {
  "members": [1], "data": { … }, "costs": [ … ] } }, "users": {} }`.
- Fire a **non-route** entry point with `GET /__dev/fire/<kind>[/<name>][/<fn>]` (a JSON
  body or query params become the payload/args): `/__dev/fire/job/refresh`,
  `/__dev/fire/scheduled/daily`, `/__dev/fire/event/place:created`,
  `/__dev/fire/hook/tripCardProvider/getCards`, `/__dev/fire/deleteUserData?userId=1` —
  so jobs, scheduled timers, event subscriptions and provider hooks are all testable in
  the same hot-reload loop as your routes.

### Test against a real instance's data (dev-link)

`dev` above is fast but its host data is **synthetic** (fixtures / a scratch
`db:own`). When you need your plugin to run against **real** trips, places,
reservations, costs and real membership/permissions, link it into a running TREK
instance instead of packing + uploading it every time.

On the **server** (a local `trek-dev` or a dev instance — **never production**), set:

```bash
TREK_PLUGINS_DEV_LINK=1
```

With the flag set, the **Admin → Plugins** tab shows a **“Link a local plugin”**
field. Paste the absolute path to your **built** plugin directory (the one holding
`trek-plugin.json` + `server/index.js` — build first, the loader runs the compiled
artifact, not TS source) and hit **Link**. The plugin is symlinked into the plugins
volume and registered INACTIVE, and shows a **Dev-link** badge in the list.

Prefer scripting? The same thing over HTTP:

```bash
curl -XPOST /api/admin/plugins/link -H 'content-type: application/json' \
  -d '{ "path": "/abs/path/to/your/plugin" }'
```

Activate it in the admin UI and consent to its permissions as usual. It now runs
through the **same capability RPC host** as any installed plugin: real,
membership-gated data, the acting user resolved host-side, no impersonation — code
origin never touches the security gate.

**Hot-reload:** rebuild your plugin (e.g. `tsc --watch` emitting `server/index.js`)
and TREK re-forks it automatically (a file-watch on the linked dir). To force it,
`POST /api/admin/plugins/:id/reload`, or just hit **Restart** in the admin UI —
both re-fork the child, picking up the new code (a rebuilt manifest that widened
permissions still requires explicit re-consent).

> Dev-link is gated behind `TREK_PLUGINS_DEV_LINK` on top of admin + the plugin
> kill-switch, and is **off by default**. It loads unsigned local code that mutates
> live between restarts, and under `npm run dev` the OS permission jail is off — so
> only ever enable it on a machine you control, pointed at a dev instance.

## The plugin types

- **integration** — background logic (jobs, routes) with no UI of its own. Every
  provider hook is **live** — from placeDetailProvider and warningProvider through
  photoProvider (Memories) and calendarSource — see [Provider hooks](#provider-hooks).
- **page** — adds a nav entry that opens a full-page sandboxed iframe.
- **widget** — adds a card to the dashboard (`sidebar` slot), a hero-bar overlay
  (`hero` slot), a panel inside the trip planner's **place-detail** view
  (`place-detail` slot — the frame also receives the open `placeId` in
  `trek:context`, so it can show place-specific info like reviews or ratings), a
  panel inside the **day-detail** view (`day-detail` slot — receives the open `dayId`;
  the home for per-day content like outfit planning, live flight status or logistics),
  or a panel at the foot of a booking card in the **reservation-detail** view
  (`reservation-detail` slot — receives the open `reservationId`, for things like
  live check-in status or a seat map). Set the slot in `capabilities.widget.slot`.
- **trip-page** — adds a tab **inside every trip planner**, so your UI lives in the
  trip alongside Plan / Transports / Files. The frame is the same sandboxed iframe as
  a `page`, but it receives the current `tripId` in `trek:context` (so you can scope
  data to the open trip) and it has no dashboard nav entry. The tab shows on desktop
  and mobile. Via `capabilities.tripPage` the plugin can also **take over core tabs**:
  `replaces: ['transports', 'buchungen', …]` hides the named tabs while the plugin is
  active (they return the moment it's deactivated; `plan` is never replaceable), and
  `position` picks the 0-based index of your tab in the bar instead of appending it.
  A plugin that replaces tabs gets a "Replaces planner tabs" chip in the admin list,
  so the takeover is visible before activation.

## The SDK package

`trek-plugin-sdk` is **injected at runtime** — the host makes
`require('trek-plugin-sdk')` resolve inside the child, so **do not vendor it**
into your artifact. Add it as a **devDependency** only, so you get types,
`createMockHost` for tests, and the `trek-plugin` CLI:

```bash
npm i -D trek-plugin-sdk
```

## Writing the server

Your `server/index.js` exports a `definePlugin(...)` object. Everything reaches
TREK through the `ctx` argument.

```js
const { definePlugin } = require('trek-plugin-sdk')

module.exports = definePlugin({
  // Runs once when the plugin is activated. NOTE: onLoad has no user context —
  // ctx.trips.* is refused here (see the ctx table).
  async onLoad(ctx) {
    await ctx.db.migrate('001_init', 'CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT)')
    ctx.log.info('loaded')
  },

  // Runs once on deactivation/stop. Use it to flush or release resources.
  async onUnload(ctx) {
    ctx.log.info('unloading')
  },

  // HTTP routes, mounted at /api/plugins/<id><path>.
  routes: [
    { method: 'GET', path: '/status', auth: true, async handler(req, ctx) {
      const rows = await ctx.db.query('SELECT COUNT(*) AS n FROM cache')
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: rows[0].n, user: req.user?.username }),
      }
    }},
  ],

  // Scheduled jobs — TREK owns the cron and calls your handler on the schedule.
  // Requires the `jobs:run` permission (opt-in: scheduled work runs with NO user,
  // so its trip reads are refused — a job can only use ctx.db and declared egress).
  // An invalid cron expression is skipped; jobs stop when the plugin is deactivated.
  jobs: [
    { id: 'refresh', schedule: '*/15 * * * *', async handler(ctx) { /* … */ } },
  ],

  // Persistent, userless timers you arm at runtime with ctx.scheduler — they
  // survive restarts and call this handler when due. Also needs `jobs:run`.
  //   await ctx.scheduler.in(3_600_000, 'remind', { tripId })   // once, in 1h
  //   await ctx.scheduler.every(86_400_000, 'digest')           // daily
  async scheduled({ name, payload }, ctx) {
    if (name === 'remind') { /* … one-shot fired; re-arm if you want another */ }
  },

  // GDPR data-subject rights (needs `hook:user-data`). Userless — you only get the
  // userId and act on your OWN db. deleteUserData is delivered DURABLY (queued and
  // retried until it succeeds, even across restarts), so make it idempotent.
  async deleteUserData({ userId }, ctx) {
    await ctx.db.exec('DELETE FROM my_prefs WHERE user_id = ?', userId)
  },
  async exportUserData({ userId }, ctx) {
    return await ctx.db.query('SELECT * FROM my_prefs WHERE user_id = ?', userId)
  },
})
```

The routes and job ids you declare here are the **authoritative** ones: the host
reads them off your loaded definition (a route's array index is its internal id).
The scaffold writes no `routes` block into `trek-plugin.json`, and the manifest
parser would ignore one if you added it.

### The `ctx` object

| Area | Methods | Requires |
|---|---|---|
| `ctx.db` | `query(sql, …args)` / `exec(sql, …args)` / `migrate(id, sql)` / `tx(ops)` against your **own** SQLite file. `tx([{sql, args?}, …])` runs up to 100 statements in one transaction (all commit or all roll back; reads see the batch's own earlier writes) → `{ results: [{changes?}\|{rows?}, …] }`. Your file is capped at **256 MB** (a write past it fails `SQLITE_FULL`, contained to your plugin) and a single result set at **100,000 rows** — page your reads instead of materialising a cartesian product | `db:own` |
| `ctx.trips` | `getById` / `getPlaces` / `getReservations` / `getDays` / `getAccommodations` / `listMine()` — enumerate every trip the acting user can access (membership-checked). `getDays` includes each day's `assignments` + `notes_items`; `getReservations` includes `endpoints` + `day_positions` | `db:read:trips` |
| `ctx.trips.update(tripId, fields)` | update trip fields (title/dates/currency/reminder_days/…) | `db:write:trips` |
| `ctx.trips.create(input)` | create a **new trip owned by the acting user** (importers) — `title` required, plus `description?`/`start_date?`/`end_date?`/`currency?`/`reminder_days?`/`day_count?` | `db:create:trips` (+ `trip_create`) |
| `ctx.places` | `create(tripId, fields)` / `update(tripId, placeId, fields)` / `delete(tripId, placeId)` | `db:write:places` |
| `ctx.days` | `create(tripId, {date?, notes?})` / `update(tripId, dayId, {notes?, title?})` / `delete(tripId, dayId)` | `db:write:days` |
| `ctx.itinerary` | `assign(tripId, dayId, placeId, notes?)` / `unassign(tripId, assignmentId)` — place↔day | `db:write:itinerary` |
| `ctx.meta` | `get` / `set` / `list` / `delete` your **own** namespaced data on a `trip`/`place`/`day`/`reservation`/`accommodation` (enrich core entities without forking the schema) | `db:meta` |
| `ctx.packing` | `list(tripId)` — a trip's packing items (membership-checked, respects private-item visibility) | `db:read:packing` |
| `ctx.files` | `list(tripId)` — a trip's files, trash excluded (membership-checked) | `db:read:files` |
| `ctx.files.getContent` | `getContent(tripId, fileId)` → `{ name, mimetype, size, content_base64 }` — a file's bytes as base64 (10MB cap; trashed files refused) | `db:read:files:content` |
| `ctx.journal` | `listMine()` — the acting user's own travel journals; `getEntries(journeyId)` — one journey's entries (photos/story/checkins, access-checked) | `db:read:journal` (+ Journey addon) |
| `ctx.atlas` | `visited()` — the acting user's visited countries + regions; `bucketList()` — their bucket-list items | `db:read:atlas` (+ Atlas addon) |
| `ctx.vacay` | `mine()` — the acting user's vacation plan | `db:read:vacay` (+ Vacay addon) |
| `ctx.collections` | `listMine()` / `get(id)` — the acting user's saved-place collections | `db:read:collections` (+ Collections addon) |
| `ctx.collections` (write) | `create(input)` / `update(id, input)` / `savePlace(input)` / `copyToTrip(input)` / `deletePlace(placeId)` — per-collection role enforced by the service | `db:write:collections` (+ Collections addon) |
| `ctx.atlas` (write) | `markCountry(code)` / `unmarkCountry` / `markRegion(regionCode, countryCode, regionName?)` / `unmarkRegion` / `createBucketItem(input)` / `deleteBucketItem(itemId)` — the acting user's own rows | `db:write:atlas` (+ Atlas addon) |
| `ctx.vacay` (write) | `toggleEntry(date)` — the acting user's own PTO day on their active plan; `toggleCompanyHoliday(date, note?)` | `db:write:vacay` (+ Vacay addon) |
| `ctx.journal` (write) | `createEntry(journeyId, {entry_date, ...})` / `updateEntry(entryId, fields)` / `deleteEntry(entryId)` — owner/contributor-gated; `createJourney({title, subtitle?, trip_ids?})` / `deleteJourney(journeyId)` — a new journal owned by the acting user (importers bootstrap the journal they then fill) | `db:write:journal` (+ Journey addon) |
| `ctx.files` (write) | `create(tripId, {name, content_base64, mimetype?, ...})` (10MB cap, blocked extensions refused) / `createLink(tripId, fileId, opts)` / `update` / `softDelete` — broadcasts `file:*` | `db:write:files` (+ the acting user's `file_upload`/`file_edit`/`file_delete`) |
| `ctx.collab` | `listNotes(tripId)` / `listPolls(tripId)` / `listMessages(tripId, before?)` — a trip's notes, polls (with options + voters) and chat (newest 100, oldest first; `before` = a message id to page back), membership-checked | `db:read:collab` (+ Collab addon) |
| `ctx.collab` (write) | `createNote(tripId, {title, ...})` / `createPoll(tripId, {question, options})` / `votePoll(tripId, pollId, optionIndex)` / `createMessage(tripId, text, replyTo?)` — broadcasts `collab:*` | `db:write:collab` (+ `collab_edit`, Collab addon) |
| `ctx.trips.addMember` / `.removeMember` | `addMember(tripId, userId)` — **grants trip access**; `removeMember(tripId, userId)` — revokes it (never the owner), so a directory-sync integration can reconcile departures too | `db:write:members` (+ `member_manage`) |
| `ctx.notify` | `send({title, body, link?, scope, targetId})` — bell inbox + email/ntfy fan-out; recipient forced to the acting user (`scope:'user'`) or a trip they belong to (`scope:'trip'`) | `notify:send` |
| `ctx.ai` | `complete(prompt, system?)` → `{ text }`; `extract(text, jsonSchema, prompt?)` → `{ results }` — the admin/user-configured provider; host holds the key; output is DATA (no auto-writes) | `ai:invoke` |
| `ctx.oauth` | `getAccessToken()` → a **short-lived access token** for the acting user of a third-party service the host connected on their behalf (Settings → Plugins → Connect); `null` if not connected / userless. Host holds the refresh token + client secret | `oauth:client` |
| `ctx.scheduler` | `at(whenMs, name, payload?)` / `in(ms, name, payload?)` / `every(ms, name, payload?)` / `cancel(name)` — **persistent, userless** timers that survive restarts and fire your `scheduled(input, ctx)` handler. `set` is an upsert by `name`; caps: ≤100 tasks, 8 KB payload, recurring interval ≥ 60 s, ≤ ~1 year out. Same risk class as `jobs` (no acting user → trip reads refused) | `jobs:run` |
| `ctx.settings` | `get(key)` — the **acting user's** own value for one of your `scope:'user'` settings fields (decrypted host-side), or the field's manifest `default` when they never set it. Returns `undefined` for a field with neither, and in a userless context (job/onLoad) — fall back to `ctx.config` there. Users fill these in under **Settings → Plugins**; secrets are stored encrypted and never echoed back | none (your own settings) |
| `ctx.daynotes` | `list(tripId, dayId)` — a day's notes (membership-checked) | `db:read:daynotes` |
| `ctx.daynotes` (write) | `create(tripId, dayId, {text, time?, icon?, sort_order?})` / `update(tripId, dayId, noteId, fields)` / `delete(tripId, dayId, noteId)` — broadcasts `dayNote:*` | `db:write:daynotes` |
| `ctx.packing` (write) | `create(tripId, {name, category?, checked?, is_private?, visibility?, recipient_ids?})` / `update(tripId, itemId, fields)` / `delete(tripId, itemId)` — broadcasts `packing:*`, private items (#858) stay owner-scoped | `db:write:packing` |
| `ctx.packing` (bags) | `listBags(tripId)` / `createBag(tripId, {name, color?})` / `updateBag` / `deleteBag` / `setBagMembers(tripId, bagId, userIds)` — bags carry no privacy | `db:write:packing` |
| `ctx.weather` | `get(lat, lng, date?)` — the host's cached forecast (tenant-free) | `weather:read` |
| `ctx.rates` | `get(base)` → a map of quote → rate relative to `base` (e.g. `'EUR'` → `{ USD: 1.08, … }`; cached upstream, tenant-free); `null` on an upstream failure | `rates:read` |
| `ctx.categories` | `list()` — the global place-category list | `db:read:categories` |
| `ctx.tags` | `list()` / `create({name, color?})` / `update(tagId, fields)` / `delete(tagId)` — the acting user's own tags | `db:read:tags` / `db:write:tags` |
| `ctx.trips.members` | `members(tripId)` — the trip roster (id + display fields), membership-checked | `db:read:trips` |
| `ctx.todos` | `list(tripId)` / `create(tripId, {name, ...})` / `update(tripId, todoId, fields)` / `delete(tripId, todoId)` — broadcasts `todo:*` | `db:read:todos` / `db:write:todos` (+ `packing_edit`) |
| `ctx.costs` | `getByTrip(tripId)` / `listMine()` — read budget items (membership-checked) | `db:read:costs` |
| `ctx.costs` (write) | `create(tripId, input)` / `update(tripId, itemId, input)` / `delete(tripId, itemId)` — broadcasts `budget:*` | `db:write:costs` |
| `ctx.reservations` | `listMine()` — every booking across the acting user's accessible trips (membership-checked) | `db:read:trips` |
| `ctx.reservations` (write) | `create(tripId, input)` / `update(tripId, reservationId, input)` / `delete(tripId, reservationId)` — full parity with the app (accommodation, budget-sync, notification, broadcasts `reservation:*`). `input.endpoints` = array of `{ role: 'from'\|'to'\|'stop', name, lat, lng, code?, sequence?, timezone?, local_time?, local_date? }`; update semantics: omitted = keep, `[]` = delete all, array = replace (endpoint ids are not stable) | `db:write:reservations` |
| `ctx.accommodations` | `create(tripId, { place_id, start_day_id, end_day_id, check_in?, check_in_end?, check_out?, confirmation?, notes? })` / `update(tripId, accommodationId, fields)` / `delete(tripId, accommodationId)` — lodging blocks; create auto-creates the partner hotel reservation, delete cascades it (broadcasts like the app) | `db:write:accommodations` (+ `day_edit`) |
| `ctx.users` | `getById(id)` — public profile only (`id, username, display_name, avatar`) | `db:read:users` |
| `ctx.ws.broadcastToTrip(tripId, event, data)` | broadcast to a trip's members (event forced to `plugin:<id>:<event>`) | `ws:broadcast:trip` |
| `ctx.ws.broadcastToUser(userId, event, data)` | broadcast to one user | `ws:broadcast:user` |
| `ctx.plugins.call(id, fn, args?)` | call a function another plugin **exposes** and get its result — `id` must be a declared, satisfied `pluginDependency` that lists `fn` in its `capabilities.provides` | a plugin dependency (no permission) |
| `ctx.events.emit(name, payload?)` | publish an event to dependents that subscribed — `name` must be in your `capabilities.emits` | — (no permission) |
| `ctx.config` | your `scope:'instance'` settings (secrets delivered decrypted, a field nobody set resolves to its manifest `default`), frozen at activation | — |
| `ctx.log` | `info` / `warn` / `error` → your error log | — |
| `ctx.id` | your plugin id (string) | — |

Calling a method your manifest didn't grant returns `PERMISSION_DENIED`; a method
the host doesn't expose at all returns `UNKNOWN_METHOD`.

**`ctx.trips` only works inside a route handler.** The host binds the acting user
from the authenticated request and membership-checks every trip read against it.
`onLoad` and `jobs` have **no user**, so their trip reads are refused with
`RESOURCE_FORBIDDEN`. The SDK's `getById(tripId, asUserId?)` signature keeps an
`asUserId` parameter for source compatibility, but **the host ignores it** — you
cannot read another user's trips by passing an id.

**Writes (`ctx.trips.update` / `ctx.places` / `ctx.days` / `ctx.itinerary` /
`ctx.costs.create`) are route-context only too, and doubly gated:** the host checks
the acting user can **access** the trip AND holds the app's edit permission for that
entity (`place_edit` / `day_edit` / `trip_edit`), exactly like the web UI. They run
through the same services and broadcast the same events, so open sessions update
live. Input is validated against TREK's own schemas (a bad payload is `BAD_PARAMS`),
and every write is recorded in the tamper-evident capability audit log against the
acting user. A plugin can only change what its user could change by hand.

**`ctx.costs` ("costs" = budget items)** behaves exactly like `ctx.trips`: reads are
membership-checked against the request's user and only work **inside a route handler**
(`onLoad`/`jobs` have no user → `RESOURCE_FORBIDDEN`). `getByTrip(tripId)` returns one
trip's budget items (hydrated with members/payers); `listMine()` aggregates budget items
across every trip the acting user can access. `create/update/delete(tripId, …)` mutate a
trip's budget items — gated exactly like a normal budget write (the same model the planner
write scopes `db:write:places`/`days`/`itinerary`/`trips` use): the acting user needs the
**`budget_edit`** permission on that trip, the input is
validated against TREK's budget schema, and a successful create broadcasts the same
`budget:created` event the app emits. **Every `ctx.costs.*` call also requires the Costs
(budget) addon to be enabled** — if the admin has turned it off, the call is refused with
`RESOURCE_FORBIDDEN`.

### Route auth

Routes are authenticated by default (`req.user` is the logged-in user). Set
`auth: false` for OAuth callbacks or webhooks that can't carry a session.

The proxy forwards `{ method, path, query, body, rawBodyBase64, headers, user }`.
**`req.headers` is populated ONLY on `auth: false` routes** (an authenticated route
gets `{}`) and only an explicit, credential-free **allowlist** — the common provider
signature + event headers (`stripe-signature`, `x-hub-signature-256`,
`svix-signature`, `x-gitlab-event`, `content-type`, `user-agent`, …). **`Cookie`,
`Authorization`, `X-Socket-Id` and every session/forwarded-auth header are stripped**
and never reach your code, so a forwarded header can't leak a TREK session.

**`req.rawBodyBase64` is webhook-only in the same way** — the exact request bytes,
base64-encoded, on `auth: false` routes, and absent on an authenticated route, which
never needs them. To trust a webhook, verify the provider's signature over *those*
bytes against a secret you hold in `ctx.config` (admin-set instance setting) or
`ctx.settings` (per-user). Never re-serialize `req.body` for the check:
`JSON.stringify` won't reproduce the key order, whitespace and unicode escaping the
sender signed, so the HMAC won't match.

The snippet below handles two things, and yours has to as well. TREK only keeps the
raw bytes when a body parser ran, i.e. for `application/json` and
`application/x-www-form-urlencoded` — a webhook posted as `text/plain` or a GET
callback with no body arrives with `rawBodyBase64: null`, so **fail closed** instead
of running the HMAC over an empty buffer, which is a constant anyone can forge. And
the request body ceiling is 100 kB; a larger payload is rejected before your route
runs.

```js
const crypto = require('node:crypto')

if (typeof req.rawBodyBase64 !== 'string') return { status: 400, body: { error: 'no raw body' } }
const raw  = Buffer.from(req.rawBodyBase64, 'base64')
const mac  = crypto.createHmac('sha256', ctx.config.webhookSecret).update(raw).digest()
const sent = Buffer.from(String(req.headers['x-hub-signature-256'] || '').replace(/^sha256=/, ''), 'hex')
if (sent.length !== mac.length || !crypto.timingSafeEqual(mac, sent)) return { status: 401, body: { error: 'bad signature' } }
```

### Runtime limits

The host enforces these on every plugin. They are generous for real work and only
bite a runaway one, but they are exactly what a plugin that loops over `ctx.*` or
stores blobs in `ctx.db` runs into, so build against them.

| Area | Limit |
|---|---|
| every `ctx.*` call | burst 60, sustained 20/s, 16 in-flight per plugin; a throttled call is refused with `HOST_ERROR: rate limit exceeded — slow down ctx.* calls`. Tunable with `TREK_PLUGIN_RPC_BURST` / `TREK_PLUGIN_RPC_PER_SEC` / `TREK_PLUGIN_RPC_INFLIGHT` (see [Environment-Variables](Environment-Variables#plugins)) |
| `ctx.db` | 256 MB per plugin, one result set capped at 100,000 rows |
| event subscriptions | 200 events buffered per plugin while it restarts, dropped unreplayed after 15 minutes |
| the plugin process | 300 MB RSS (`TREK_PLUGIN_MAX_RSS_MB`) — the child is killed past it; auto-disabled with status `error` after 5 crashes inside a 5-minute window |

The daily `ctx.ai` / `ctx.notify` budgets and the `ctx.meta` quotas are in
[Testing without a running TREK](#testing-without-a-running-trek), because the mock
host enforces those too.

## Writing the client (page / widget)

The iframe is served same-origin from `/plugin-frame/<id>/…` but sandboxed
**without `allow-same-origin`**, so it runs at an **opaque origin**: it can't read
cookies or the parent DOM. It talks to TREK only via `postMessage` (target origin
must be `'*'` — an opaque frame has no nameable origin).

Your whole `client/` directory is served (and shipped by `pack`) — not just
`index.html`. The frame CSP allows the plugin its **own** static files (and nothing
from any other host), so a **multi-file build works as-is**: point a bundler at
`client/` and use **relative asset paths** (Vite: `base: './'`), drop the output in,
done. That includes React/Vue/Svelte builds — no more inlining the bundle into
`index.html` (inline still works, and is what the design-kit marker does).

### The design kit (recommended)

Because the frame can't load TREK's stylesheet, we ship it. Drop **one line** in your
`client/index.html` `<head>`:

```html
<!-- trek:ui -->
```

`dev` and `pack` expand that marker into the inlined **TREK design kit** — a
token-driven stylesheet plus a `window.trek` bridge. It costs nothing to keep the
source a one-liner, and a rebuild always ships the current kit. The kit:

- gives you native components — **glass panels, cards, buttons, inputs, chips, list
  rows, hover** — that swap correctly between light and dark;
- follows the user's live **accent scheme, custom accent and high-contrast** (it
  applies the tokens TREK sends);
- mirrors the host's **appearance flags** (reduced-motion, no-transparency, density);
- **auto-reports your height** (widgets/pages self-size — no manual `trek:resize`);
- installs `window.trek` so you never hand-roll `postMessage`.

`window.trek` also carries **`trek.ui`** — tiny DOM builders that emit kit-styled
elements, so you can build UI with no bundler and no CSS:

```js
const { ui } = trek
ui.mount(ui.card([
  ui.el('div', { class: 'trek-title', text: 'Nearby' }),
  ui.button('Refresh', { variant: 'primary', onClick: refresh }),
  ui.chip('open now', 'success'),
]))
// ui.el(tag, props, children) is the general builder; props take class/text/html/on:{event}.
```

The scaffold seeds a working example. A minimal client:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- trek:ui -->
</head>
<body>
  <div class="trek-glass trek-stack" style="margin:16px">
    <div class="trek-title">Your plugin</div>
    <p class="trek-muted" id="hello">…</p>
    <button class="trek-btn trek-btn--primary" id="go">Say hello</button>
  </div>
  <script>
    trek.onContext((ctx) => { document.getElementById('hello').textContent = 'theme: ' + ctx.theme })
    document.getElementById('go').addEventListener('click', async () => {
      try { const data = await trek.invoke('/hello'); document.getElementById('hello').textContent = 'Hello ' + data.hello }
      catch (e) { trek.notify('error', e.message) }
    })
  </script>
</body>
</html>
```

**Component classes** (the bootstrap adds `trek-ui` to `<body>`):

| Class | What |
|---|---|
| `.trek-glass` | the signature frosted-glass surface |
| `.trek-card` | a solid card |
| `.trek-interactive` | add to a glass/card for the native hover-lift |
| `.trek-btn` + `--primary` / `--secondary` / `--ghost` / `--danger` | buttons |
| `.trek-input` / `.trek-textarea` / `.trek-select` / `.trek-label` | form controls |
| `.trek-chip` + `--accent` / `--success` / `--danger` / `--warning` / `--info` | chips / badges |
| `.trek-row` | a hover-highlight list row |
| `.trek-title` / `.trek-muted` / `.trek-faint` | text helpers |
| `.trek-stack` / `.trek-cluster` | vertical / horizontal flex with gap |
| `.trek-menu-enter` / `.trek-menu-enter-left` | dropdown enter (scales from its trigger corner) |
| `.trek-popover-enter` / `.trek-modal-enter` / `.trek-backdrop-enter` / `.trek-toast-enter` | the host's enter animations (`trek-modal-enter` becomes a bottom drawer below 640px) |
| `.trek-page-enter` | subtle fade-up on mount |
| `.trek-stagger` | children fade up with a 40ms cascade |
| `.trek-skeleton` | shimmer loading placeholder |
| `.trek-pie-reveal` / `.trek-bar-fill` | chart reveal animations (plus the `trek-progress-fill` keyframe, driven by `--trek-progress-to`) |

All animations honour reduced motion: under `[data-reduce-motion]` or
`prefers-reduced-motion` they degrade to a gentle 120ms fade, and the skeleton
stops shimmering.

**Selects are auto-upgraded.** With the kit inlined, every native `<select>` becomes
a host-styled, keyboard-accessible dropdown that matches TREK — the OS-drawn popup
can't be themed, so the kit replaces it while keeping the real `<select>` as the
value/form source (it still fires `change`). Write a plain `<select>` and it just
works. Add `data-trek-native` to a field to keep the browser default; `multiple` and
`size` selects are always left native.

**The `window.trek` bridge:**

| Call | Does |
|---|---|
| `trek.onContext(cb)` | run `cb(context)` now (if already received) and on every update; returns an unsubscribe fn |
| `trek.context` | the last context (or `null`) |
| `trek.invoke(sub, { method, body })` | call your own route; returns a `Promise` (rejects with an `Error`, `.code` = HTTP status) |
| `trek.session.get(key, options?)`, `.set(key, value, options?)`, `.remove(key, options?)`, `.clear(options?)` | Host-managed JSON session state for this browser tab. `scope: 'plugin'` is the default; `scope: 'trip'` additionally partitions it by the trip in view and rejects with `NO_TRIP_CONTEXT` outside a trip. Missing `get()` values are `undefined`. Each plugin or individual trip scope is limited to 32 keys, 64 characters/key, and 1 KiB/value. Do not use it to store secrets. |
| `trek.notify(level, message, duration?)` | toast (`info`/`success`/`warning`/`error`); optional duration in ms (clamped 1.5–15s) |
| `trek.confirm({ title?, message, confirmLabel?, cancelLabel?, danger? })` | host-rendered native confirm dialog; resolves `true`/`false` (one at a time — a second concurrent request resolves `false`) |
| `trek.navigate(to)` | in-app navigation (relative paths only) |
| `trek.openExternal(url)` | open an `http(s)` URL in a new tab (the sandbox itself can't) |
| `trek.onEvent(cb)` | `cb(event, tripId)` for core events on the trip in view — names only, no payloads; refetch via `invoke()`; returns an unsubscribe fn |
| `trek.resize(px)` | override the auto height (ignored on full pages — see `trek:resize` below) |
| `trek.geolocation.get()` | one browser position as `{ lat, lng, accuracy, heading, speed, timestamp }` — **needs the `geolocation:read` permission**; rejects with `.code` `forbidden`/`denied`/`timeout`/`unavailable`/`unsupported`. The HOST reads the position (the sandbox never gains the API) and the browser's own site prompt still applies |
| `trek.geolocation.watch(cb)` | stream positions — `cb(position, error)`; returns an unsubscribe fn. The host keeps ONE GPS watch per frame and force-stops it when the frame closes |
| `trek.ready()` / `trek.requestContext()` | re-handshake / re-request the context |

**Preview it:** `npx trek-plugin-sdk dev`, then open **`/preview`** — it renders your UI
in a real sandboxed frame with a theme/accent/appearance toggle and proxies
`trek.invoke()` to your routes.

### The raw bridge (without the kit)

If you'd rather not use the kit, talk to the frame yourself. Announce readiness and
handle messages:

```js
window.parent.postMessage({ type: 'trek:ready' }, '*') // TREK replies with trek:context
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return          // opaque frame: trust the parent window
  const m = e.data
  if (m.type === 'trek:context') { /* m.theme, m.tokens, m.appearance, … (below) */ }
  if (m.type === 'trek:response') { /* m.requestId, m.data */ }
  if (m.type === 'trek:error')    { /* m.requestId, m.code, m.message */ }
})
window.parent.postMessage({ type: 'trek:invoke', requestId: '1', sub: '/status', method: 'GET' }, '*')
```

**Messages you send to TREK:**

| Message | Payload | Effect |
|---|---|---|
| `trek:ready` | — | TREK replies with `trek:context` |
| `trek:context:request` | — | re-request the context |
| `trek:navigate` | `{ to }` | in-app navigation (relative paths only) |
| `trek:notify` | `{ level, message, duration? }` | toast; `level` = `info`/`success`/`warning`/`error`; `duration` in ms, clamped 1500–15000 |
| `trek:resize` | `{ height }` | set the iframe height (capped at 2000px); **ignored for full pages** (`page` / `trip-page`), which always fill their host container |
| `trek:invoke` | `{ requestId, sub, method, body }` | call your own route; resolves as `trek:response` or `trek:error` |
| `trek:confirm` | `{ requestId, title?, message?, confirmLabel?, cancelLabel?, danger? }` | host-rendered ConfirmDialog; answered as `trek:confirm:result` |
| `trek:openExternal` | `{ url }` | open an `http(s)` URL in a new `noopener` tab; anything else is dropped |
| `trek:geolocation` | `{ requestId, action?: 'get'\|'watch'\|'clear' }` | host-brokered browser position (needs `geolocation:read`); answered as `trek:geolocation:result`, watch updates stream as `trek:geolocation:update` |
| `trek:session:get` | `{ requestId, key, scope?: 'plugin'\|'trip' }` | read tab-scoped state; answered as `trek:response` with `data` (`undefined` when unset) |
| `trek:session:set` | `{ requestId, key, value, scope? }` | store a JSON-serialisable value; answered as `trek:response` |
| `trek:session:remove` | `{ requestId, key, scope? }` | drop one key; answered as `trek:response` |
| `trek:session:clear` | `{ requestId, scope? }` | drop every key in that scope; answered as `trek:response` |

The session messages are rejected as `trek:error` with `code` set to `NO_TRIP_CONTEXT`
(trip scope outside a trip), `SESSION_INVALID_KEY` (empty or over 64 characters),
`SESSION_INVALID_VALUE` (not JSON-serialisable), `SESSION_VALUE_TOO_LARGE` (over 1 KiB
serialised), `SESSION_KEY_LIMIT` (over 32 keys in that scope) or `SESSION_STORAGE_ERROR`
(the browser refused the write). The storage key itself is host-owned and includes the
signed-in user and your plugin id, so scopes never collide.

**Messages TREK sends you:**

| Message | Payload |
|---|---|
| `trek:context` | `{ tripId, placeId, dayId, reservationId, userId, theme, locale, dir, hostOrigin, user, formats, tokens, appearance }` (see below) — re-sent whenever the theme, appearance, **locale or formats** change |
| `trek:response` | `{ requestId, data }` — a successful `trek:invoke` or `trek:session:*` |
| `trek:error` | `{ requestId, code, message }` — a failed request; for `trek:invoke` `code` is the HTTP status or `"error"`, for `trek:session:*` one of the `SESSION_*` / `NO_TRIP_CONTEXT` codes above |
| `trek:confirm:result` | `{ requestId, confirmed }` — the user's answer to your `trek:confirm` |
| `trek:event` | `{ event, tripId }` — a core event fired on the trip in view; **names only, never payloads** — refetch what you need via `trek:invoke` |
| `trek:geolocation:result` | `{ requestId, position? \| watching? \| cleared? \| error? }` — the answer to a `trek:geolocation` request (`error` ∈ `forbidden`/`denied`/`timeout`/`unavailable`/`unsupported`) |
| `trek:geolocation:update` | `{ position? , error? }` — a streamed watch fix (`position` = `{ lat, lng, accuracy, heading, speed, timestamp }`) |

The frame's CSP is locked down per plugin: `default-src 'none'`, own inline
scripts/styles + the plugin's **own** `/plugin-frame/<id>/` files only (no other
host may serve it script/style/img), `connect-src` limited to the hosts you were
**granted** via `http:outbound:<host>` permissions (not merely the `egress[]` you
declared), no popups.

### The context payload

| Field | Type |
|---|---|
| `tripId` | `string \| null` — the trip in view (a `trip-page` tab, or a widget on a trip), else `null`. **IDs arrive as strings** — compare with `String(id)` |
| `placeId` | `string \| null` — the place in view (a `place-detail` slot), else `null` |
| `dayId` | `string \| null` — the day in view (a `day-detail` slot), else `null` |
| `reservationId` | `string \| null` — the reservation in view (a `reservation-detail` slot), else `null` |
| `dir` | `'ltr' \| 'rtl'` — the host's text direction; the kit mirrors it onto your `<html>` so RTL hosts get RTL plugin UIs |
| `userId` | `string \| null` |
| `theme` | `'light' \| 'dark'` |
| `locale` | e.g. `'en'` |
| `hostOrigin` | the app origin |
| `user` | `{ name, avatar, isAdmin } \| null` — **never** an email; role only as a boolean |
| `formats` | `{ locale, currency, timeFormat, distanceUnit, temperatureUnit, timezone, blurBookingCodes }` — `blurBookingCodes` mirrors the user's "blur booking codes" preference so your UI can hide confirmation numbers until they're revealed. It is a **display hint, not redaction**: the codes still reach your plugin in full over `trek:invoke`. |
| `tokens` | TREK's resolved CSS design tokens for the current theme (see below) |
| `appearance` | `{ scheme, density: 'comfortable'\|'compact', reducedMotion, noTransparency }` |

### Matching the TREK look by hand (`m.tokens`)

`tokens` is the global palette resolved for the **current** theme — surfaces
(`--bg-card`, `--bg-hover`, …), text (`--text-primary`/`-secondary`/`-muted`/`-faint`),
borders, the **accent family** (`--accent`, `--accent-text`, `--accent-hover`,
`--accent-subtle`), semantic + soft fills (`--success`/`--danger`/`--warning`/`--info`
`-soft`), shadows (`--shadow-*`), radii (`--radius-*`) and fonts (`--font-system`).
Apply them as CSS variables and your UI follows the host through a theme toggle, a
custom accent and high-contrast, instead of hard-coding a palette that drifts. (Fonts
are named, not shipped: the files live in the host bundle, so declare your own or fall
back to a system stack.)

```js
function applyContext(m) {
  document.documentElement.dataset.theme = m.theme                 // for your dark rules
  for (const k in m.tokens) document.documentElement.style.setProperty(k, m.tokens[k])
  const a = m.appearance || {}
  document.documentElement.toggleAttribute('data-reduce-motion', !!a.reducedMotion)
  document.documentElement.toggleAttribute('data-no-transparency', !!a.noTransparency)
}
// in your trek:context handler: applyContext(m)
```

`tokens`/`appearance` are non-secret display values only, re-sent on every theme or
appearance change so plugins feel native rather than bolted-on. (The glassy tokens the
dashboard uses — `--glass-*`, `--r-*`, `--sh-*` — aren't in `tokens`; the design kit
bakes those, since they only change with light/dark, not the accent.) Honour
`appearance.reducedMotion` / `noTransparency`, and the frame also inherits the OS
`prefers-reduced-motion`. Dashboard widgets are wrapped in the native glassy tool card
and auto-size to the height you report via `trek:resize`, so render flush and
transparent — the design kit reports your height for you.

## On a phone

TREK 4 gives the phone its own design, and your plugin is mounted inside it. Two things
follow from that, and both arrive in `trek:context` under `viewport`:

```js
m.viewport = {
  surface: 'trip-tab',      // where you are mounted, see the table below
  formFactor: 'phone',      // 'phone' | 'desktop'
  fill: true,               // true = fill the host container, false = report your height
  insets: { top: 82, bottom: 106 },  // px the host ALREADY keeps clear around you
}
```

### Know which surface you are on

| `surface` | Shape | Notes |
|---|---|---|
| `trip-tab` | fills | Your own tab in a trip. You scroll yourself. |
| `plugin-page` | fills | `/plugins/:id`. You scroll yourself. |
| `dashboard-widget` | reports height | A card on the dashboard. |
| `user-settings` | reports height | Your `settings.html`. |
| `detail-slot` | reports height | A narrow column inside a place/day/reservation panel. |
| `action-frame` | fills | The modal a table action opens. |

This matters because the contract differs: on a **filling** surface your `trek:resize`
height is deliberately ignored, so give your document `height: 100%` and put the
scrolling on an inner element. On a **reporting** surface let the content decide the
height and never set `100%`, or the host reserves a screenful for two lines of text.
The design kit does both for you when it sees `viewport.fill`.

### `insets` is not padding you have to add

It is the space the host is *already* keeping clear. On the mobile trip tab, floating
controls hover above your frame and a translucent dock hovers below it, and the host
holds both areas free for you. Use the numbers to line your own sticky header up with
the host's chrome, not to add margin — that would double the gap.

### The mobile palette

Inside the mobile shell, `tokens` carries a **second** family alongside the global one:
`--m-ink`, `--m-muted`, `--m-faint`, `--m-bg`, `--m-card`, `--m-cbr`, `--m-glass`,
`--m-gbr`, `--m-inner`, `--m-act`, `--m-actfg`, `--m-ic`, `--m-rowbr`, the status canon
(`--m-st-confirmed`, `--m-st-pending`, `--m-st-info`, `--m-st-danger`, `--m-st-neutral`)
and `--m-safe-top`. These are what the native mobile screens are built from; the global
palette describes the desktop chrome and looks foreign next to them.

They are **absent on desktop**, so branch on their presence rather than assuming both
families are there:

```css
.card {
  background: var(--m-card, var(--bg-card));
  border: 1px solid var(--m-cbr, var(--border-primary));
}
```

### Four rules that decide whether it feels native

1. **Inputs at 16px or larger.** Below that, iOS Safari zooms the page on focus and does
   not zoom back. This is the most common mobile bug in embedded UI.
2. **Touch feedback on `:active`, not `:hover`.** A hover rule never fires on a phone, so
   a tap gives no response at all.
3. **Targets at least 44px.** Anything smaller is a coin toss with a thumb.
4. **No drop shadows on the mobile surface.** The design is translucent and border-led
   over a gradient; a shadow reads as a sticker glued on top.

The design kit applies all four automatically once `data-form-factor="phone"` is set,
which it does from `viewport`. If you style everything yourself, they are on you.

### Seeing it

`trek-plugin dev` previews at a desktop size. Until that grows a phone width, resize the
browser window and use your browser's device emulation — the frame is a real browsing
context, so media queries inside it measure the frame, and they work.

## Settings

Declare settings in the manifest; TREK renders the form (you write no settings
UI). `scope: "instance"` settings are set once by the admin — under
**Admin → Plugins → ⋯ → Instance settings**, where only the fields your manifest declares
are stored and saving re-spawns a running plugin — and arrive resolved in `ctx.config`.
`scope: "user"` settings are edited by each user under **Settings → Plugins** and are read
one key at a time with `await ctx.settings.get(key)` (a userless job / `onLoad` gets `undefined` —
fall back to `ctx.config` there). `secret: true` fields are stored encrypted and
delivered decrypted through whichever of the two applies (server-side only) —
never to the iframe.

Two attributes do more than decorate the form:

- **`default`** is the field's value wherever nobody set one. The form pre-fills it
  **and the runtime resolves it** — `ctx.config.api_url` and
  `ctx.settings.get('region')` return the default until someone saves something
  else — so a plugin that ships sensible defaults works before anyone opens the
  form. A default satisfies `required`. It is refused on a `secret` (the manifest
  is public), must be a boolean on a `checkbox`, and must be one of the `options`
  when those are declared; the host drops a default that breaks these rules at
  install, `trek-plugin validate` errors on it first.
- **`required`** is enforced on both ends: the form refuses Save while the field is
  blank (naming it), and the host answers `400 { error: 'Missing required setting
  "<key>"' }` if a save reaches it anyway. A `checkbox` is exempt. A required
  `scope:'user'` field also decides whether a notification channel dispatches to
  that user at all.

Any attribute outside `key, label, input_type, placeholder, hint, required, secret,
scope, options, oauth, default` is silently dropped at install; `trek-plugin
validate` warns on one (`manifest.settings-known-keys`).

### A custom settings page (`capabilities.settingsUi`)

When declared fields aren't enough — a picker with previews, anything visual —
set `"capabilities": { "settingsUi": true }` and ship a `client/settings.html`.
TREK frames it as a card on the user's **Settings → Plugins** page, in the same
opaque-origin sandbox and postMessage bridge as your widget: it can only reach
your own declared routes (`trek:invoke`), receives `trek:context`, and should
report its height via `trek:resize`. Persist whatever it edits through one of
your own routes (e.g. into your `db:own` database keyed by `req.user.id`) — the
settings page has no special storage powers. Hosts older than this capability
simply ignore the flag, so declaring it never breaks an install.

## Host-brokered OAuth (`ctx.oauth`)

A plugin can act as an OAuth *client* of a third-party service **without ever handling the secrets**. The **host** runs the entire flow — authorize → callback → token exchange → refresh — with PKCE (S256) and a `state` check, and holds the tokens. The plugin only triggers "connect" and reads a **short-lived access token** at runtime.

**Setup.** Declare the provider as `scope: "instance"` settings the admin fills in: `oauth_authorize_url`, `oauth_token_url`, `oauth_scopes` (optional), plus `oauth_client_id` and the `secret: true` `oauth_client_secret`. (A settings field may also carry an `oauth: { initPath, callbackPath }` block.) `trek-plugin create` scaffolds all five for you when you pick the `oauth:client` permission.

**Connecting.** A user connects under **Settings → Plugins → Connect**, which sends them to the provider's authorize page. The callback returns to `…/api/plugin-oauth/<id>/callback`; the host verifies the `state` (single-use, 10-minute TTL, bound to that user — CSRF defence), exchanges the code and stores the tokens **per user, encrypted at rest**.

**Using it.** Read the access token in a route handler:

```js
const token = await ctx.oauth.getAccessToken() // needs the `oauth:client` permission
if (!token) return { status: 401, body: 'connect this plugin first' }
// call the third-party API with `Authorization: Bearer ${token}`
```

- Returns `null` when the acting user hasn't connected, or in a **userless** context (a job / `onLoad`).
- The host **auto-refreshes** a token that is expiring (60-second skew) using the refresh token it holds.
- The plugin **never** sees the refresh token or the client secret.
- The authorize/token URLs must be `https` to a non-private host, and the host-side token exchange goes through the SSRF guard (blocks the link-local / cloud-metadata range and pins the resolved IP against DNS-rebind; a self-hosted internal IdP on loopback/LAN still works).

## GDPR data-subject hooks

Grant `hook:user-data` and implement either handler to honour data-subject rights. Both are **userless** — the plugin only receives the `userId` and acts on its **own** `ctx.db`:

```js
// trek-plugin.json: "permissions": ["db:own", "hook:user-data"]
module.exports = definePlugin({
  async deleteUserData({ userId }, ctx) {           // erasure
    await ctx.db.exec('DELETE FROM my_prefs WHERE user_id = ?', userId)
  },
  async exportUserData({ userId }, ctx) {           // portability / access
    return await ctx.db.query('SELECT * FROM my_prefs WHERE user_id = ?', userId)
  },
})
```

- **Erasure is durable.** When a user is deleted, `deleteUserData` is queued and **retried until the plugin ACKs**, across restarts and even after the plugin is later reactivated — so make it **idempotent**.
- **Export is complete-or-flagged.** A data-access request aggregates `exportUserData` across every granted plugin. A plugin that is currently **inactive** but holds `hook:user-data`, or one whose export **errored/timed out**, is flagged `pending` (never silently omitted), so the admin knows to reactivate it to finish the request.
- Uninstalling a plugin also **purges its stored OAuth tokens and state**.

## Provider hooks

A hook is core calling **into** your plugin for data (host→plugin). Declare it on
the plugin definition and grant the matching `hook:*` permission:

```js
module.exports = definePlugin({
  hooks: {
    placeDetailProvider: {
      // Return extra rows TREK renders natively on a place. Runs with the current
      // user bound, on a short timeout — a slow/failing call is skipped, never fatal.
      async getDetails(placeId, ctx) {
        return [{ label: 'Crowd', value: 'Quiet now' }, { label: 'Guide', url: 'https://…' }]
      },
    },
  },
})
```

| Hook | Permission | Status |
|---|---|---|
| `placeDetailProvider.getDetails(placeId, ctx)` → `{ label, value?, url? }[]` | `hook:place-detail-provider` | **live** — shown in the place-detail panel; also `GET /api/place-details/:placeId` |
| `warningProvider.getWarnings(tripId, ctx)` → `{ level, message, dayId?, placeId? }[]` | `hook:trip-warning-provider` | **live** — validation warnings shown as a non-blocking banner in the trip planner; also `GET /api/trip-warnings/:tripId`, and to a connected assistant as the `get_trip_warnings` MCP tool (≤20 warnings per provider, message ≤300 chars) — that path needs only the trips read scope, not `plugins:use` |
| `tableContributor.getContributions(view, tripId, ctx)` → `TableContribution[]` | `hook:table-contributor` | **live** — host-rendered **columns/actions** keyed by `entityId` in the reservations, transports, places, day, costs, packing, files and todos views. A `column` is `{kind:'column', entityId, id, label, value?, url?, icon?, tone?}` (url is http/https/mailto only); an `action` is `{kind:'action', entityId, id, label, icon?, target}` where `target` opens your sandboxed frame (`{kind:'frame', sub}`) or calls a route (`{kind:'route', method, sub}`). All fields are bounded + normalized host-side; also `GET /api/view-contributions/:view/:tripId` |
| `mapMarkerProvider.getMarkers(tripId, ctx)` → `MapMarkerContribution[]` | `hook:map-marker-provider` | **live** — bounded markers overlaid on the trip map (#587). Each is `{id, lat, lng, label?, popupText?, url?, icon?, tone?}`; coordinates are range-checked (−90..90 / −180..180), text length-capped, url http/https/mailto-only, count capped (≤200/plugin). Declarative only — plugin JS never runs on the map canvas. Also `GET /api/map-markers/:tripId` |
| `mapLayerProvider.getLayers(tripId, ctx)` → `MapLayerContribution[]` | `hook:map-layer-provider` | **live** — bounded vector overlays on the trip map: a computed route, a reachable-range corridor, a zone. Each layer is `{id, name?, features}` with features `{type: 'polyline'\|'polygon'\|'circle', points?/center?+radiusM?, tone?, width?, dash?, opacity?, fill?, label?}`. Styling stays in the tone palette; width (1–8), opacity (0.05–1) and radius (≤2000 km) are clamped, `dash` is an enum. Budgets per plugin: ≤4 layers, ≤150 features, ≤8000 vertices, ≤2000 vertices/shape — an oversized or partly-invalid shape is dropped whole, never truncated. Declarative only; drawn beneath TREK's own day route on both the Leaflet and GL renderers. Also `GET /api/map-layers/:tripId` |
| `routeProvider.getRoute(request, ctx)` → `RouteProviderResult` | `hook:route-provider` | **live** — routes a day's stops under one of the plugin's declared `capabilities.routeProfiles` (an EV profile with charging stops, a scenic profile…). `request` is `{tripId, dayId, profile, waypoints}` (2–30 located stops in visit order); the result is `{coordinates, distance, duration, legs, viaPoints?}` and is validated **whole**: ≤10000 vertices, `legs` must be exactly `waypoints−1` entries (each `{distance, duration, note?}` — `note` ≤120 chars shows on the sidebar connector), ≤40 via points (`{lat, lng, label?, tone?, dwellSeconds?}` drawn as stops on the route line). A malformed result is discarded and the planner falls back to straight lines. **Targeted, not a fan-out**: TREK calls exactly the provider whose profile the user picked in the route toggle, with a 20 s timeout (room to call an external solver through your declared egress). `POST /api/plugin-routes/:pluginId/:profileId` |
| `dayScheduleProvider.getSchedule(tripId, ctx)` → `DayScheduleContribution[]` | `hook:day-schedule-provider` | **live** — time contributions rendered into the day plan on desktop and mobile: "35 min charging at this stop", "45 min security before this flight". Each is `{id, dayId, assignmentId?/reservationId?/position?, minutes?, label, tone?}` — anchored under a place/booking row or at a day's start/end (default end). `dayId` must belong to the trip (checked server-side), `minutes` (1–1440) is shown on the row **and folded into the day's route-footer total**, `label` ≤120 chars, ≤60 items/plugin. Also `GET /api/day-schedule/:tripId` |
| `dayTintProvider.getDayTints(tripId, ctx)` → `DayTintContribution[]` | `hook:day-tint-provider` | **live** — colours painted into a day card in the Plan sidebar (and into that day's mobile chip), so a trip split into legs shows its leg membership while you scroll. Each is `{dayId, tone?, color?, badgeTone?, badgeColor?, headerTone?, headerColor?, activityTone?, activityColor?, label?}`. The card has **three separately tintable regions** — the day-number badge (also the mobile chip), the header row, and the expanded activity list — so a plugin can mark the leg boldly on the badge while leaving the dense activity list plain; `tone` / `color` are the shorthands that fill every region you do not name, and an unnamed region renders exactly as it does with no plugin. Paint a region with a palette tone or with your own `#rrggbb` (nothing else is accepted — the value lands inside a CSS colour); a colour beats a tone within a region, and anything a region names beats the shorthand. You choose the hue, the host chooses the weight: it sets the alpha per theme **and** per region and clamps a colour's lightness into a band that reads in both themes, so the tint stays subtle in light and dark, no contribution can make a day unreadable, and a tinted header hovers to a deeper mix of its own colour. `dayId` must belong to the trip (checked server-side), `label` ≤ 60 chars becomes the day's tooltip, raw array sliced at 2000. **A day takes at most one contribution, resolved whole**: within your own list the first entry for a day wins, and across plugins the first granted provider wins — so a day never flickers between colours, and a losing plugin cannot fill in the winner's untinted regions. Bounded by the trip's day count rather than a fixed item cap, which is why this is not `dayScheduleProvider` (≤60 items would tint only the first 60 days of a long trip). Also `GET /api/day-tints/:tripId` |
| `pdfSectionProvider.getSections(tripId, ctx)` → `PdfSection[]` | `hook:pdf-section-provider` | **live** — text-only sections appended to the trip PDF export. Each is `{title, paragraphs?, table?}`; the host escapes and lays everything out itself (no markup ever reaches the document), caps counts (≤5 sections/plugin, ≤20 paragraphs, ≤8 headers, ≤50 rows) + lengths (title 120, paragraph 2000, header 60, cell 200) and clips rows to the header width. Also `GET /api/pdf-sections/:tripId` |
| `atlasLayerProvider.getLayers(ctx)` → `AtlasLayer[]` | `hook:atlas-layer-provider` | **live** — country tint layers drawn over the Atlas world map (wishlists, advisories, …). **User-scoped**: the host binds the acting user, the hook takes no target parameter. Each layer is `{id, name?, countries: [{code, tone?, label?}]}`; codes must be ISO-3166 alpha-2 (uppercase-coerced), tone is enum-whitelisted, counts capped (≤3 layers/plugin, ≤300 countries/layer). Declarative only — plugin JS never runs on the map canvas. Also `GET /api/atlas-layers` |
| `journalEntryProvider.getRows(entryId, ctx)` → `{ label, value?, url? }[]` | `hook:journal-entry-provider` | **live** — extra rows rendered under a journal entry card (needs the Journey addon; the entry's journey is access-checked like the journal detail routes). Same hardening as place details plus server-side normalization: ≤12 rows/plugin, label ≤60, value ≤200, url http/https/mailto-only. Also `GET /api/journal-entry-rows/:entryId` |
| `tripCardProvider.getCards(tripIds, ctx)` → `TripCardContribution[]` | `hook:trip-card-provider` | **live** — small badges on the dashboard trip cards. Called ONCE with all visible `tripIds` (each already access-checked for the acting user), returns `{ tripId, id, label, value?, icon?, tone?, url? }[]`; the host bounds every field (label 64, value 256, tone enum, url http/https/mailto-only), caps the count (≤4 badges per trip, ≤240 total per plugin) and drops any badge whose `tripId` wasn't requested. Declarative only. Also `GET /api/trip-card-contributions?tripIds=…` |
| `photoProvider.search(query, {page, limit}, ctx)` / `.getById(id, ctx)` | `hook:photo-provider` | **live** — plugin photo sources aggregated at `GET /api/plugin-photos/search` (+ `/sources`, `/item`) for the picker. Each `{id, title?, thumbnailUrl, fullUrl, takenAt?}`; thumbnail/full URLs must be http/https, per-source count capped, a failing source skipped |
| `calendarSource.getName(ctx)` / `.getEvents(userId, start, end, ctx)` | `hook:calendar-source` | **live** — plugin calendar events aggregated for the signed-in user at `GET /api/plugin-calendar?start=&end=`. Each `{id, title, start, end, allDay}` (ISO dates); count capped, a failing source skipped |
| `notificationChannel.send(msg, config, ctx)` / `.test(config, ctx)` | `hook:notification-channel` | **live** — registers a new notification channel. **Userless** (see below). See [Notification channels](#notification-channels) |
| `mcpToolProvider.callTool({name, args}, ctx)` + `tools: string[]` | `mcp:tools` | **live** — publishes MCP tools on TREK's own MCP server, advertised to connected assistants as `plugin_<id>_<name>`. Runs **as the requesting MCP user** (route-like ctx). Declared in `capabilities.mcpTools`; only the intersection of the manifest declaration and the `tools` array is advertised. See [MCP tools](#mcp-tools) |

Each hook method receives its args plus the per-invocation `ctx`, so any `ctx.trips.*`
read it makes is membership-checked against the current user (like a route handler) —
with **one exception**, the notification channel, which has no acting user at all.

Every string a hook returns is **emoji-stripped at the render boundary** — badges, columns,
warnings, PDF sections, map-marker labels, calendar and photo titles, notifications — so
plugin text stays inside TREK's own icon language; use the declarative `icon` field (a
lucide name) instead. Your plugin's own sandboxed frame is untouched: that markup is yours
to design.

## Notification channels

`hook:notification-channel` lets your plugin become a delivery channel alongside TREK's
built-in email / webhook / ntfy — Gotify, Pushover, Telegram, whatever takes a message.

Scaffold one with:

```bash
npx create-trek-plugin my-gotify --type integration --template notification-channel
```

```js
module.exports = definePlugin({
  hooks: {
    notificationChannel: {
      // msg is ALREADY RENDERED in the recipient's language, with the deep link built.
      // config is that recipient's own scope:'user' settings, decrypted by the host.
      async send(msg, config, ctx) {
        const res = await fetch(`${config.serverUrl}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Gotify-Key': config.appToken },
          body: JSON.stringify({ title: msg.title, message: msg.body + '\n\n' + (msg.url ?? '') }),
        })
        // THROW on failure — the host logs and isolates it, so a dead channel
        // can never stop email/in-app/the other channels from being delivered.
        if (!res.ok) throw new Error(`Gotify responded ${res.status}`)
      },
      // Optional — backs the "Send test" button in the user's notification settings.
      async test(config, ctx) { /* … */ },
    },
  },
})
```

```json
{
  "type": "integration",
  "permissions": ["hook:notification-channel", "http:outbound:gotify.example.com"],
  "egress": ["gotify.example.com"],
  "capabilities": { "notificationChannel": { "title": "Gotify" } },
  "settings": [
    { "key": "serverUrl", "label": "Server URL", "scope": "user", "required": true },
    { "key": "appToken", "label": "App token", "scope": "user", "required": true, "secret": true }
  ]
}
```

**This hook is host-initiated, so it runs with NO acting user.** A notification is dispatched
*to* an arbitrary recipient — nobody is "calling" your plugin — so:

- `ctx.settings.get()` returns `undefined` here, and `ctx.trips.*` reads are refused.
- The recipient's credentials arrive as the `config` argument instead: the host reads your
  plugin's `scope:'user'` settings for that recipient, decrypts them, and hands them over.

That is deliberate. It is what lets a channel plugin be given someone's push token *without*
also being given the right to read their trips as them.

Notes:

- **`title`** names the column in the notification preferences matrix (defaults to your
  plugin's name). **`events`** may *narrow* which events the channel carries; omit it and
  the channel carries all ten deliverable events: `trip_invite`, `booking_change`,
  `trip_reminder`, `todo_due`, `vacay_invite`, `collection_invite`, `photos_shared`,
  `collab_message`, `packing_tagged`, `plugin_notification`. The SDK exports the same list
  as `CHANNEL_EVENTS`, and both `trek-plugin validate` and the installer refuse anything
  outside it with `capabilities.notificationChannel.events: "x" is not a plugin-deliverable
  event`.

  The four events TREK sends that a plugin channel never carries are the admin-scoped
  `version_available` and `replica_failure` (those go over the admin's own credentials),
  the in-app-only `synology_session_cleared`, and `vacay_share`. Don't read the set off the
  table in [Notifications](Notifications) — that one lists what a user can toggle, not what
  a channel can carry.
- **Configured-ness is inferred, not asked.** A user's column is "not configured" until every
  `required`, `scope:'user'` field has a value. A plugin with no required user fields counts as
  configured for everyone (an instance-wide channel, e.g. a shared workspace webhook).
- **Per-host egress is mandatory.** Bare `http:outbound` does **not** open any host at runtime —
  you need `http:outbound:<host>` per host (see below).
- **For a self-hosted target, set `operatorEgress`** — see the next section. Your manifest can't
  name the operator's Gotify; the admin does it after install.
- **Reaching a service on your own LAN** (a Gotify next to TREK) additionally needs
  `TREK_PLUGIN_ALLOW_PRIVATE_EGRESS=on` on the TREK process — plugins may not reach private
  addresses by default. It relaxes the policy for *every* installed plugin, so enable it only
  if you trust them all.

## MCP tools

A plugin can publish tools on **TREK's own MCP server**, so an assistant a user has
connected to TREK (Claude, or any MCP client) can call into the plugin. Three parts,
all required — miss one and nothing is advertised:

1. **`capabilities.mcpTools`** in the manifest — the declaration the admin consents
   to. Up to **8** tools, each `{ name, description, title?, inputSchema?,
   annotations? }`: `name` lowercase `^[a-z0-9_]{1,48}$` (unique, no dash/dot),
   `description` required, `inputSchema` an optional JSON Schema whose root `type`
   (if present) is `"object"`.
2. **The `mcp:tools` permission** — the one hook grant not named `hook:*`.
   Declaring the capability without it fails `trek-plugin validate` *and* install.
3. **`hooks.mcpToolProvider`** on the definition:

```js
module.exports = definePlugin({
  hooks: {
    mcpToolProvider: {
      tools: ['pin_note', 'list_notes'],       // plugin-local names
      async callTool({ name, args }, ctx) {    // ONE function for all tools
        if (name === 'pin_note') { /* … */ }
        return { pinned: true }                // any JSON value; the host builds the MCP envelope
      },
    },
  },
})
```

Semantics worth knowing before you ship one:

- **Only the intersection** of `capabilities.mcpTools[].name` and the code's
  `tools` array is advertised — **silently**. A name mismatch drops the tool with
  no warning anywhere, so a tool missing from `tools/list` is almost always these
  two lists disagreeing. Keep them identical.
- **Names are prefixed** for assistants: `plugin_<id>_<name>`; `callTool` receives
  the local name. Global cap: 32 plugin tools across all installed plugins.
- **`callTool` runs as the requesting MCP user** — route-like, never userless. The
  host binds the user from the MCP session (a plugin can't name one); user-scoped
  `ctx.*` reads are membership-checked against *that* user, and `mcp:tools` itself
  unlocks no ctx method — the tool can only do what your other grants allow.
  Timeout 15 s; demo users are refused before your code runs.
- **Arguments are validated against your declared `inputSchema` before `callTool`
  runs.** `required` is enforced, `additionalProperties: false` rejects extras,
  enum/const/ranges/pattern/format are enforced — and nothing may be advertised
  that cannot be enforced, so an unsupported schema keyword (`oneOf`, `$ref`, an
  unknown `format`) **fails the install**, not silently drops. A `pattern` is capped at
  **200 chars** and may not be ReDoS-shaped (a quantified group that itself repeats or
  alternates); property names must look like identifiers
  (`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`, so `__proto__` & co are rejected);
  `additionalProperties` must be a boolean; and the schema **root** may not use `enum`,
  `const` or `nullable`. `default` is advertisement only — the host does not inject it;
  apply defaults yourself.
- **A throw is a tool error, not a crash** — the assistant sees a sanitised
  message (≤ 300 chars). Results are capped at 64 KiB / 32 content blocks with a
  visible `[truncated: …]` marker; every string the assistant reads is sanitised
  (control characters and newlines collapsed, emoji stripped) so plugin text can't
  fake headings or instructions.
- **Annotations are clamped against your grants**: `readOnlyHint: true` is lowered
  if the plugin holds any write-ish grant; `openWorldHint` is forced true if you
  hold any `http:outbound*`; `destructiveHint` defaults true unless read-only or
  explicitly `false`.
- **Caller side:** the MCP client's token needs the **`plugins:use`** OAuth scope —
  deliberately coarse (not per-plugin or per-tool) and opt-in only; static `trek_`
  tokens and web-session JWTs have it implicitly. The scope grants no data access
  of its own: the plugin acts with the grants the **admin** consented to.
- **The tool surface is frozen per MCP session.** Activating, deactivating,
  updating, re-trusting or uninstalling a plugin (or flipping an addon that
  affects one) closes every live MCP session; clients pick up the new surface on
  the next initialize. A dev-link **Reload** does *not* invalidate — reconnect
  your MCP client yourself after changing `tools`.

Admin → Plugins shows the tools a plugin will advertise. `trek-plugin dev` warns at
load about a `mcpToolProvider` without the `mcp:tools` grant and 403s
`/__dev/fire/hook/mcpToolProvider/callTool`, like any other hook.

## Settings-page actions

A plugin can put **buttons on its own settings form** — "Test connection", "Sync now",
"Clear cache" — on a user's settings page or, with `scope: "instance"`, in the admin's
instance-settings dialog. Declare them in the manifest and implement them on the definition:

```json
"actions": [
  { "key": "testConnection", "label": "Test connection", "hint": "Pings the API." },
  { "key": "purge", "label": "Delete my data", "danger": true },
  { "key": "purgeCache", "label": "Purge cache", "scope": "instance" }
]
```

```js
module.exports = definePlugin({
  actions: {
    async testConnection(ctx) {
      const token = await ctx.settings.get('appToken')   // the CLICKING user's own
      const res = await fetch('https://api.example.com/ping', { headers: { authorization: token } })
      return { ok: res.ok, message: res.ok ? 'Connected' : `Failed: ${res.status}` }
    },
  },
})
```

An action is **user-initiated**, which is what makes it different from the
`notificationChannel` hook: the acting user is *whoever clicked the button*. So
`ctx.settings.get()` returns **their** value and any trip read is membership-checked
against them — exactly what a "test my credentials" button needs.

`scope` decides *which* clicker, and where the button renders. The default, `"user"`, puts
it under **Settings → Plugins** beneath that plugin's own fields. `"instance"` puts it in
the admin's instance-settings dialog instead (**Admin → Plugins → ⋯ → Instance settings**),
next to the `scope: "instance"` fields it operates on — a "Purge cache" or a "Test SMTP"
that acts on instance configuration rather than one person's credentials. Both bind the
clicker as acting user, so an instance action is admin-*surfaced*, not admin-privileged: it
still sees that admin's own `ctx.settings` alongside `ctx.config`, and its trip reads are
membership-checked against them.

Notes:

- Return `{ ok, message? }`. Throwing is the same as `{ ok: false }` with the error text.
  The message is bounded (200 chars) and emoji-stripped host-side before it's shown.
- `danger: true` renders it destructively and asks for confirmation first.
- The key must be a valid settings key, and the host refuses any key the manifest didn't
  declare — the key arrives from the URL, so it is never forwarded to your plugin blindly.
  The scope is fixed by the route as well: a `"user"` key can never be fired from the admin
  route, nor an `"instance"` key from the settings page.
- Max 8 actions **across both scopes**, with keys unique across them too; label capped at 60
  chars (a blank one falls back to the key), hint at 200. A `scope` that is anything but
  `"user"` or `"instance"` fails install and `trek-plugin validate` with
  `action "<key>".scope must be "user" or "instance"`.
- An instance action needs a **running** plugin: the button is disabled until the plugin is
  active, the dialog saves an edited form before firing it, and the host answers
  `404 { error: 'Plugin is not active' }` if the child is gone anyway.
- **Hosts older than TREK 4.2.0 ignore `scope`** and render the button on every user's
  settings tab, so a plugin using `scope: "instance"` should set a manifest `trek` floor of
  `>=4.2.0`.

## Operator-supplied egress hosts (`operatorEgress`)

A plugin's `egress` list is fixed in its manifest **at publish time**. That works for a cloud
API (`api.pushover.net`), but not for a **self-hosted** service — you cannot know that a user's
Gotify lives at `gotify.alice.net`. Without a way out, a community plugin for a self-hosted
target could serve nobody.

Declare `operatorEgress` and the **admin** supplies the real hosts after install:

```json
{
  "permissions": ["hook:notification-channel", "http:outbound:gotify.net"],
  "egress": ["gotify.net"],        // hosts you DO know (the cloud offering)
  "operatorEgress": true            // …plus whatever the admin adds
}
```

If there is **no** host you can name — a plugin for a service that is *only* ever self-hosted —
`operatorEgress` is what lets you declare outbound with an **empty `egress[]`** (omit the key).
It is the one case where that is legal; without the flag, `http:outbound` with no egress is a
manifest error:

```json
{
  "permissions": ["hook:notification-channel", "http:outbound"],
  "operatorEgress": true            // every host comes from the admin
}
```

Such a plugin still **installs and activates normally** — it may have useful non-network
features — but until an admin adds a host it reaches *nothing*: the child's allow-list is the
union of your `http:outbound:<host>` grants and the admin's hosts, and both are empty, so every
outbound call fails with `egress: <host> is not in the plugin's declared hosts`. An empty
`egress[]` is never an allow-all.

The admin then opens **Admin → Plugins → ⋯ → Allowed hosts** and adds `gotify.alice.net`. The
runtime unions that into the child's allow-list and **re-spawns the plugin** — the egress guard
is installed once at child start and a second `init` is deliberately refused, so a live child's
allow-list can never be widened in place.

What this deliberately does *not* do:

- **An end user can never widen egress.** Only an admin can, and only for a plugin that
  *declared* `operatorEgress` — so the consent given at install still bounds what is possible.
  A plugin that never asked for it can never be given a host.
- **Hosts get the same validation as manifest egress**: no bare `*`, no whole-TLD `*.com`, no
  scheme, no spaces. A wildcard needs a real multi-label suffix (`*.mydomain.com`).
- **Uninstalling drops the hosts**, so a later plugin reusing the id can't inherit consent
  granted to a different one.

Users then point their own settings at one of the approved hosts. Anything else is refused by
the guard with `egress: <host> is not in the plugin's declared hosts`.

## Event subscriptions

React to core activity with `events` + the `events:subscribe` permission. Handlers
fire **without a user** (like a job) and receive
`{ event, tripId, entity?, entityId?, snapshot? }`: `entity` is the event family
(`'reservation'`, `'place'`, …), `entityId` says **which** entity changed, and
`snapshot` is a **whitelisted field view of the changed entity** — delivered only
when your plugin *also* holds the family's read grant (`db:read:trips` for
place/day/reservation/accommodation/assignment/trip, `db:read:costs` for budget,
`db:read:packing` for packing, `db:read:daynotes` for dayNote, `db:read:files` for
file). Without that grant you get exactly the id hint, as before:

```js
// trek-plugin.json: "permissions": ["events:subscribe", "db:read:trips"]
module.exports = definePlugin({
  events: [
    { on: 'reservation:created', async handler({ event, tripId, entityId, snapshot }, ctx) {
        // with db:read:trips the snapshot carries the reservation's fields
        // (title, times, type, endpoints, ...) — no refetch needed
        await ctx.db.exec('INSERT INTO seen (trip, res, title) VALUES (?, ?, ?)', tripId, entityId, snapshot?.title ?? '')
    } },
    { on: '*', handler(e) { /* firehose: every core event */ } },
  ],
})
```

`entityId` is absent for bulk/reorder events and for events with no single entity;
`snapshot` is additionally absent for **deletes** (nothing left to show) and for a
**private packing item** (its broadcast is owner-scoped — #858). Never assume either
is set. The snapshot whitelist never carries user ids (owner/paid-by/participants),
`trips.feed_token` or other secrets — the id is only ever the changed entity's own
id (never a parent or a user id).

Delivery is fire-and-forget on a short timeout, so a slow subscriber never blocks a
core write. Because there's no user, trip reads (`ctx.trips.*`) are refused inside a
handler — beyond the snapshot, use the plugin's own `ctx.db`, `ctx.ws.*`, or an
outbound call. A plugin's own `plugin:*` broadcasts are never delivered back, so
handlers can't loop. Event names follow `<family>:<verb>` (`place:created`,
`day:updated`, `file:*`, `assignment:*`, `budget:*`, `accommodation:*`, …); the SDK
exports the authoritative family list and the snapshot-grant mapping as
`EVENT_FAMILIES` and `EVENT_SNAPSHOT_GRANT`.

## Dependencies

A plugin can declare that it needs certain **addons** enabled, or other **plugins**
installed, before it will run. Both are top-level manifest arrays, and both are
enforced at **activation** — installing always succeeds, so a missing dependency is a
fixable state, never a broken download.

### `requiredAddons`

```json
"requiredAddons": ["budget", "journey"]
```

Addon ids (see [[Addons Overview|Addons-Overview]]) that must be **enabled** for the
plugin to activate. If one is off, enabling the plugin is refused and the admin panel
names the addon to turn on. Turning a required addon **off** while the plugin is
running **auto-disables the plugin** (and anything that depends on it) — a plugin
never runs against a disabled addon. Ids are validated for shape only, so a plugin may
name an addon a given TREK build doesn't have; it just stays un-activatable there.

### `pluginDependencies`

```json
"pluginDependencies": [
  { "id": "koffi", "version": ">=1.2.0 <2.0.0" }
]
```

Other plugins that must be **installed and version-satisfied** (a standard semver
range) before this one activates. That range is the real contract for anything you
call on the dependency (see [Talking to other plugins](#talking-to-other-plugins)).

Enforcement, all at activation time:

- **Missing** dependency → activation is blocked and the panel offers a one-click
  **download** that fetches the newest registry version satisfying your range (pulling
  *its* own dependencies too), then retries.
- **Installed but out of range** → same block; the panel offers to update it.
- **Installed but disabled** → enabling your plugin **auto-enables the dependency
  first**, transitively (deepest dependency first).
- **Disabling a dependency** cascades: every plugin that (transitively) depends on it
  is disabled too.
- A dependency **cycle** (A → B → A) is refused with a clear error.

Dependencies are also resolved deps-first at boot, so a plugin's dependencies are
already up before it starts.

## Talking to other plugins

Isolation is the default — plugins can't see each other. To let a plugin be *used* by
the plugins that depend on it, it opts in by declaring a surface in its manifest
`capabilities`, and the host routes calls/events between the two child processes.
There is **no permission** for this: authorization is the dependency edge itself —
plugin A may call or subscribe to plugin B only if A declares B as a satisfied
`pluginDependency`, and only for the names B publicly declares.

### Exports — request / response

The **dependency** (B) exposes named functions and lists them in `capabilities.provides`:

```js
// plugin "koffi"
module.exports = definePlugin({
  exports: {
    // `args` is whatever the caller passed; `ctx` is a per-call context.
    async convert({ amount, from, to }, ctx) {
      return { amount: amount * rate(from, to), to }
    },
  },
})
// manifest: "capabilities": { "provides": ["convert"] }
```

The **dependent** (A) declares koffi as a dependency and calls it:

```js
// manifest: "pluginDependencies": [{ "id": "koffi", "version": ">=1.0.0 <2.0.0" }]
const out = await ctx.plugins.call('koffi', 'convert', { amount: 10, from: 'USD', to: 'EUR' })
```

- A call is refused (`RESOURCE_FORBIDDEN`) if the target isn't a satisfied dependency,
  isn't currently active, or the function isn't in the target's `provides`.
- **The acting user is propagated:** B's export runs as A's current user, so any
  `ctx.trips.*` read B makes is membership-checked against that user — B can't be
  tricked into reading data the calling user couldn't see.
- The call is bounded by a timeout and recorded in the capability audit log
  (`plugin:<target>#<fn>`), attributed to A and the acting user.
- B owns its contract: only functions in `provides` are reachable — routes, jobs and
  helpers stay private. Because your `pluginDependencies` range pins B's version, B can
  refactor internals freely and only breaks you on a major bump.

### Events — publish / subscribe

The **emitter** (B) declares event names in `capabilities.emits` and publishes them:

```js
// manifest: "capabilities": { "emits": ["rate.updated"] }
ctx.events.emit('rate.updated', { pair: 'USD/EUR', rate: 0.92 })   // fire-and-forget
```

A **dependent** (A) subscribes by naming the source plugin + event:

```js
module.exports = definePlugin({
  subscriptions: [
    { plugin: 'koffi', event: 'rate.updated', async handler(payload, ctx) {
        await ctx.db.exec('UPDATE cache SET rate = ?', payload.rate)
    } },
  ],
})
```

- An event reaches A only if A declares `koffi` as a satisfied dependency **and**
  subscribed to that `(plugin, event)`. Emitting an event not in your `emits` is refused.
- Like core [event subscriptions](#event-subscriptions), handlers run **without a
  user** — but unlike them they **do** receive the emitter's payload. Delivery is
  fire-and-forget on a short timeout; a slow subscriber never blocks the emitter.

## Testing without a running TREK

`createMockHost` gives you a `ctx` that enforces the **same** permission model, so
a test can prove your plugin degrades gracefully when a grant is missing:

```js
import { createMockHost } from 'trek-plugin-sdk/testing'

const { ctx, broadcasts } = createMockHost({
  grants: ['db:read:trips'],
  actingUserId: 42,                                   // the user every read is checked against
  trips: {
    1: { members: [42], data: { id: 1, name: 'Japan' } },
    2: { members: [99], data: { id: 2, name: 'Peru' } },
  },
})
await ctx.trips.getById(1)                            // ok — member
await expect(ctx.trips.getById(2)).rejects…           // RESOURCE_FORBIDDEN
await expect(ctx.db.query('SELECT 1')).rejects…       // PERMISSION_DENIED (no db:own)
```

The mock db is a recorder — set `queryResults` for canned rows, or use an
integration test for real SQL. To test inter-plugin calls, pass
`pluginExports: { koffi: { convert: (args) => … } }` and assert on `mock.emitted`
for anything your plugin publishes via `ctx.events.emit`.

The mock also enforces the host's operational limits, so a test can prove your
plugin backs off correctly: the **daily AI and notification budgets** (defaults
200 / 100 per day; configure with `aiPerDay` / `notifyPerDay` — `0` disables the
broker entirely, the exhausted call fails with the host's exact error) and the
**`ctx.meta` quotas** (≤256-char keys, ≤64 KB serialized values, ≤100 keys per
entity).

### Driving your plugin's handlers

`createMockHost` also gives you `run(def)` — the other half of a test. Where the
`ctx` recorders (`calls`, `broadcasts`, `emitted`, `notifications`, `scheduled`)
capture what your plugin *read*, `run` fires each entry point so you can assert
what it *did*, all against the same mock `ctx`:

```js
const host = createMockHost({ grants: ['jobs:run', 'hook:trip-card-provider'], actingUserId: 7 })
const app  = host.run(myPlugin)

await app.route({ method: 'GET', path: '/ping' })          // → the route's response
await app.job('refresh')                                    // fire a background job (userless)
await app.scheduled('daily', { tripId: 1 })                 // fire the `scheduled` handler
await app.event('place:created', { tripId: 1, entityId: 9 })// deliver a core event to `events`
await app.deleteUserData(42)                                // GDPR erasure handler
const dump  = await app.exportUserData(42)                  // GDPR export handler
const cards = await app.hook('tripCardProvider', 'getCards', [1, 2]) // any provider hook

host.scheduled.get('daily')                                 // timers the plugin armed via ctx.scheduler
```

A handler your plugin didn't declare throws a clear error (not a silent no-op),
so a test catches a missing `scheduled`/`deleteUserData`/job before release.

#### Settings actions and notification channels

These two have their own driver methods, because the host invokes them in ways a
plain `hook()` call can't express:

```js
const host = createMockHost({ actingUserId: 7, userSettings: { token: 'abc' } })
const app  = host.run(myPlugin)

// A settings-page button. USER-INITIATED, so ctx.settings.get() returns the clicker's
// own value. You get back the result the user would actually see: a handler that
// returns nothing is { ok: true }, and one that THROWS is { ok: false, message } —
// the documented contract, so this never rejects.
await app.action('test')            // → { ok: true, message: 'Connected' }

// A notification channel. USERLESS — the host fires it for an arbitrary recipient, so
// ctx.settings.get() returns undefined and trip reads are refused; the recipient's
// decrypted settings arrive as the `config` ARGUMENT instead (defaulting to the
// `userSettings` fixture). That asymmetry is the security property of a channel
// plugin — it is handed someone's push token without the right to read their trips.
await app.channel.send({ event: 'trip_invite', title: 'Hi', body: 'Japan' })
await app.channel.test({ token: 'abc' })
```

An event outside [`CHANNEL_EVENTS`](#notification-channels) — or outside your
manifest's `capabilities.notificationChannel.events`, which may only *narrow* that
set — is refused rather than delivered, so a test can't pass on a notification the
host would never route to you. Pass `declaredActions` / `channelEvents` to model
what your manifest declares.

`declaredActions` takes plain keys or `{ key, scope? }` entries, so a manifest with both
scopes models faithfully:

```js
const host = createMockHost({
  actingUserId: 7,
  declaredActions: ['testConnection', { key: 'purgeCache', scope: 'instance' }],
})
```

`app.action(key)` drives either one, and driving a key you didn't declare throws
(`RESOURCE_FORBIDDEN`) like the host. The scope itself has no runtime effect in the mock:
both scopes get the acting-user ctx, exactly as the host gives both the clicker's.

## Rules

- **No native modules** (`.node`, `binding.gyp`, `prebuilds/`) — rejected at pack
  and install time.
- **Don't vendor `trek-plugin-sdk`** — it's injected at runtime (devDependency
  only). Vendor any *other* runtime deps: TREK never runs `npm install` on a plugin.
- **Ship built JS** in `server/index.js` and pre-built static files in `client/`.
  `.ts` and `.map` files are stripped by `pack`.
- Declare every outbound host in `egress[]` whenever you use `http:outbound` — **and
  grant each of them a matching `http:outbound:<host>` permission**. The runtime builds
  the child process's network allow-list and the iframe's CSP from those *permissions*
  only; it never reads `egress[]`, which exists for the admin's consent screen. A host
  listed in `egress[]` with no matching permission installs, activates, consents — and
  is then silently unreachable. `validate` errors on this.

## Manifest reference (`trek-plugin.json`)

| Field | Type | Notes |
|---|---|---|
| `id` | string, **required** | lowercase slug, `^[a-z][a-z0-9-]{2,39}$` (3–40 chars). Must match the directory name. |
| `name` | string, **required** | display name; also the page nav label. |
| `version` | string, **required** | semver (`1.2.3`, optional pre-release). |
| `apiVersion` | number | plugin API version (currently `1`; `PLUGIN_API_VERSION`). Defaults to `1`; must be a positive integer, and a version newer than the host supports is refused at install and won't activate (`API_VERSION_INCOMPATIBLE`). |
| `type` | string, **required** | `integration` \| `page` \| `widget` \| `trip-page`. |
| `trek` | string, **required** | the TREK versions this plugin supports, as a semver **range**: `">=4.0.0 <5.0.0"` (what the scaffold writes). Must be *satisfiable* (`">=4.0.0 <3.0.0"` parses but nothing can satisfy it — rejected). **Enforced at install and at activation** (see below); it is copied verbatim onto the registry entry, which is the entry's only compatibility field. Keep it **bounded** — an unbounded range claims support for TREK versions that do not exist yet. |
| `author` | string | shown in the store. |
| `description` | string | one-line summary for the store. |
| `icon` | string | lucide-react icon name (default `Blocks`); used for the page nav entry. |
| `homepage` | string | project URL. |
| `tags` | string[] | store keywords, copied verbatim onto the registry entry. Each must be a lowercase slug of 2–24 chars (`[a-z0-9-]`), at most 8 — `validate` rejects a capital or a space, because the registry's schema does. |
| `license` | string | shown in the store detail (read from the manifest, not enforced). |
| `nativeModules` | boolean | must be `false`/absent — `true` is rejected. |
| `permissions` | string[] | see below. |
| `egress` | string[] | allowed outbound hosts; required (non-empty, no bare `*`) when any `http:outbound` permission is present — **unless** `operatorEgress` is `true`, in which case it may be empty/omitted and the admin supplies the hosts. |
| `capabilities.widget` | object | `{ title, slot, defaultSize }` — `slot` is `sidebar` (default), `hero`, `place-detail`, `day-detail`, or `reservation-detail`. |
| `capabilities.tripPage` | object | `{ replaces?, position? }` for `trip-page` plugins — `replaces` names core planner tabs to hide while active (`transports`, `buchungen`, `listen`, `finanzplan`, `dateien`, `collab`; never `plan`), `position` is the tab's 0-based index in the bar (0–50; omitted = appended). |
| `actions` | array | Buttons on the plugin's settings form — `{ key, label, hint?, danger?, scope? }` (max 8 across both scopes, keys unique across them). Implement each as `actions[key](ctx)` on the definition. `scope` is `user` (default — renders under **Settings → Plugins**) or `instance` (renders in **Admin → Plugins → ⋯ → Instance settings**, needs `trek` ≥ 4.2.0). Either way the action is **initiated by the person who clicked it** and runs as them, so `ctx.settings.get()` returns *that* user's value. See [Settings-page actions](#settings-page-actions). |
| `operatorEgress` | boolean | The plugin talks to a **self-hosted** service whose hostname only the operator knows. The admin adds the real hosts after install (Admin → Plugins → Allowed hosts) and the runtime unions them into the egress allow-list. Requires an `http:outbound` permission, and is the only way to declare one with an empty `egress[]`. See [Operator-supplied egress hosts](#operator-supplied-egress-hosts-operatoregress). |
| `capabilities.notificationChannel` | object | `{ title?, events? }` for a plugin implementing the `notificationChannel` hook — `title` names the column in the notification preferences matrix (default: the plugin's `name`), `events` **narrows** which events the channel carries (default: all ten plugin-deliverable events; `events` may only narrow that set). Requires the `hook:notification-channel` permission. See [Notification channels](#notification-channels). |
| `capabilities.routeProfiles` | array | up to 3 `{ id, label, icon? }` entries for a plugin implementing the `routeProvider` hook — each becomes a selectable mode in the planner's route toggle (next to Driving/Walking). `id` is lowercase `[a-z][a-z0-9-]` (max 24 chars) and is what `getRoute` receives as `request.profile`; `label` (≤40 chars) is shown to the user. Requires the `hook:route-provider` permission. |
| `capabilities.mcpTools` | array | up to **8** MCP tools for a plugin implementing the `mcpToolProvider` hook — each `{ name, description, title?, inputSchema?, annotations? }` (`name` lowercase `^[a-z0-9_]{1,48}$`, unique; `description` required; `inputSchema` a JSON Schema with root `type: "object"` built from a small enforced keyword set — an unsupported keyword fails the install). Requires the `mcp:tools` permission. See [MCP tools](#mcp-tools). |
| `capabilities.provides` | string[] | function names this plugin exposes to its dependents via `ctx.plugins.call` (see [Talking to other plugins](#talking-to-other-plugins)). |
| `capabilities.emits` | string[] | event names this plugin publishes to its dependents via `ctx.events.emit`. |
| `requiredAddons` | string[] | addon ids that must be **enabled** for the plugin to activate (see [Dependencies](#dependencies)). |
| `pluginDependencies` | `{ id, version }[]` | other plugins (semver range) that must be installed + version-satisfied to activate. |
| `settings` | array | setting fields (below). |

#### TREK version compatibility (`trek`)

The `trek` range is a **hard contract**, enforced in both directions:

- **Install** is refused when the running TREK falls outside it — on every path:
  registry install, an explicitly pinned version, an update, a sideloaded archive,
  and a dev-link. A manifest with no range (or an unsatisfiable one) cannot be
  installed at all.
- **Activation** re-checks it, which is the half install cannot cover: a plugin
  legitimately installed on 3.3 is still on disk after an upgrade to 4.0, and if it
  declared `<4.0.0` it now refuses to start. It stays installed and listed,
  switched off, with the reason shown (`TREK_VERSION_INCOMPATIBLE`; a plugin that
  declares no range at all reports `TREK_VERSION_UNKNOWN`).
- **One operator escape hatch, loudly.** The range is the author's own statement
  that the plugin does not work there, so there is no per-install override in the
  UI. An operator who is stuck on a plugin whose author has not yet updated its
  range can set `TREK_PLUGINS_IGNORE_TREK_RANGE=1` on the server: every gate above
  then warns instead of refusing (a missing range is tolerated too), "install
  latest" takes the newest published version, each bypass is logged, the response
  carries a `trekRangeBypassed` marker, and the admin sees a warning dialog plus a
  persistent chip on the row. Nothing guarantees the plugin works there, and a
  mismatched plugin can in rare cases corrupt TREK data — so ship the range bump
  rather than telling your users to flip the switch. The plugin-API version gate
  (`apiVersion`) is never bypassed.

Two behaviours follow. "Install latest" resolves to the newest version *this* TREK
can run rather than the newest published, so shipping a 2.0.0 that needs TREK 4
doesn't strand 3.x users. And an **update** that would move a working plugin out of
compatibility is refused rather than performed.

One gap, by design: a host whose `APP_VERSION` is not a semver version — the Docker
build arg defaults to the literal `dev` — has nothing to compare a range against, so
the check is skipped and an unversioned build installs anything. Plugins should still
guard optional `ctx.*` namespaces.

**Permissions** — the commonly-used core subset below; the **full list of 64**
(all read/write scopes, the notify/ai/oauth brokers, every provider hook, `mcp:tools`)
lives in **[[Plugin Permissions|Plugin-Permissions]]**. Unknown values are rejected at
install (and by `trek-plugin validate` and registry CI, which check against the same list).

| Permission | Grants |
|---|---|
| `db:own` | `ctx.db` — your own SQLite file |
| `db:read:trips` | `ctx.trips.*` (membership-checked, route handlers only) |
| `db:read:packing` | `ctx.packing.list(tripId)` — a trip's packing items (membership-checked) |
| `db:read:files` | `ctx.files.list(tripId)` — a trip's files, trash excluded (membership-checked) |
| `db:read:costs` | `ctx.costs.getByTrip` / `ctx.costs.listMine` (Costs addon, route handlers only) |
| `db:write:costs` | `ctx.costs.create/update/delete` (Costs addon + acting user's `budget_edit`) |
| `db:write:places` | `ctx.places.create/update/delete` (acting user's `place_edit`) |
| `db:write:days` | `ctx.days.create/update/delete` (acting user's `day_edit`) |
| `db:write:itinerary` | `ctx.itinerary.assign/unassign` (acting user's `day_edit`) |
| `db:write:trips` | `ctx.trips.update` (acting user's `trip_edit`) |
| `db:write:packing` | `ctx.packing.create/update/delete` (acting user's `packing_edit`; private items stay owner-scoped) |
| `db:meta` | `ctx.meta.*` — your own namespaced data on a trip/place/day/reservation/accommodation |
| `db:read:users` | `ctx.users.getById` |
| `events:subscribe` | receive core activity events via `events: [...]` (event name + tripId + a { entity, entityId } hint, plus a whitelisted entity **snapshot** when the plugin also holds the family's `db:read:*` grant; never a user) |
| `hook:trip-card-provider` | `hooks.tripCardProvider` — small badges on the dashboard trip cards (`getCards(tripIds, ctx)` → `{ tripId, id, label, value?, icon?, tone?, url? }[]`; `id` is required — a badge without one is dropped; the host bounds every field and access-checks each tripId) |
| `jobs:run` | run declared background `jobs` on their cron schedule **and** `ctx.scheduler` runtime timers → `scheduled` handler (opt-in; no user, so trip reads are refused) |
| `ws:broadcast:trip` | `ctx.ws.broadcastToTrip` |
| `ws:broadcast:user` | `ctx.ws.broadcastToUser` |
| `http:outbound` or `http:outbound:<host>` | outbound HTTP to `egress[]` hosts |
| `hook:place-detail-provider` | `hooks.placeDetailProvider` — extra place rows TREK renders (see [Provider hooks](#provider-hooks)) |
| `hook:trip-warning-provider` | `hooks.warningProvider` — validation warnings in the planner (see [Provider hooks](#provider-hooks)) |
| `hook:table-contributor` | `hooks.tableContributor` — host-rendered columns/actions in the reservations, transports, places, day, costs, packing, files and todos views (see [Provider hooks](#provider-hooks)) |
| `hook:map-marker-provider` | `hooks.mapMarkerProvider` — bounded markers on the trip map |
| `hook:map-layer-provider` | `hooks.mapLayerProvider` — bounded vector overlays (routes, corridors, zones) on the trip map |
| `hook:route-provider` | `hooks.routeProvider` — routing profiles for the planner's route toggle (declared in `capabilities.routeProfiles`) |
| `hook:day-schedule-provider` | `hooks.dayScheduleProvider` — time contributions in the day plan (charging, buffers), totalled in the route footer |
| `hook:day-tint-provider` | `hooks.dayTintProvider` — colours for a day card's badge / header / activity list in the Plan sidebar (e.g. which leg of the trip a day belongs to). One contribution per day: first granted provider wins |
| `hook:pdf-section-provider` | `hooks.pdfSectionProvider` — sections appended to the trip PDF export |
| `hook:atlas-layer-provider` | `hooks.atlasLayerProvider` — per-user country tint layers on the Atlas map |
| `hook:journal-entry-provider` | `hooks.journalEntryProvider` — extra rows on a journal entry card |
| `hook:user-data` | `deleteUserData` / `exportUserData` handlers — honour GDPR erasure (durable, retried) and data-export for a deleted/requesting user (userless; own db only) |
| `hook:photo-provider` | `hooks.photoProvider` — a photo source for Memories, aggregated at `GET /api/plugin-photos/search` (see [Provider hooks](#provider-hooks)) |
| `hook:calendar-source` | `hooks.calendarSource` — calendar events for the signed-in user, aggregated at `GET /api/plugin-calendar` (see [Provider hooks](#provider-hooks)) |
| `mcp:tools` | `hooks.mcpToolProvider` — publish MCP tools on TREK's MCP server, declared in `capabilities.mcpTools`; runs as the requesting MCP user (see [MCP tools](#mcp-tools)) |

> There is **no `ws:broadcast:*`** — use `ws:broadcast:trip` and/or
> `ws:broadcast:user` explicitly.

**Settings field** (`settings[]`):

| Key | Notes |
|---|---|
| `key` | **required** identifier; empty-key entries are dropped. |
| `label` | form label. |
| `input_type` | **snake_case**; e.g. `text` (default), `password`, `number`, `select`. |
| `scope` | `instance` (default) or `user`. |
| `required` | boolean. |
| `secret` | boolean — encrypted at rest, decrypted only into `ctx.config`. |
| `placeholder`, `hint` | form hints. |
| `options` | `[{ value, label }]` for select inputs; bare strings/numbers are accepted and coerced, but an option needs a non-empty `value`. |
| `oauth` | `{ initPath, callbackPath }` for OAuth flows. |

**Page nav:** the host builds a page plugin's nav entry from the top-level `name`
and `icon` — there is no `capabilities.nav`, so there is nothing else to set.
`icon` must be a real lucide name: TREK resolves it at render time and silently
falls back to `Blocks`, which makes a typo invisible locally, so `validate`
rejects one.

See [[Plugin Permissions|Plugin-Permissions]] for the full permission model.

## The `trek-plugin` CLI

Run `npx trek-plugin-sdk` **with no command** in a terminal and you get an
interactive menu — create / dev / status / shot / publish, with validate, pack,
signing and the registry-entry commands under **Advanced…** It picks which command to
run and asks which plugin directory to run it against; that command then prompts for
whatever else it needs. Pass a command explicitly to skip the menu (and for scripts and
CI). `trek-plugin help <command>` — or `trek-plugin <command> --help` — prints a full
page for any command.

**The path is four commands**, and the others are steps one of them already does
(with two exceptions that undo or repair: `unrelease` and `rotate-key`):

```bash
trek-plugin create [name] [--type integration|page|widget|trip-page]
trek-plugin dev [dir] [--port 4317]
trek-plugin status [dir]
trek-plugin publish [dir] --repo owner/name --tag vX.Y.Z [--sign]
```

`status` is the one to reach for when you are not sure what to do next. It runs every
gate the TREK-Plugins registry enforces that can be answered **without a network** —
which is nearly all of them — and prints the whole journey as a checklist grouped by
stage (Manifest, Code, Docs, Release, Repo), with the one command to run next. It never
exits non-zero: it is for orientation, not for gating.

```bash
# The gate. The SAME checks as `status`, but it exits 1. This is the form for CI.
trek-plugin validate [dir]

# Build plugin.zip in the installer's exact layout. Prints sha256 + byte size,
# refuses native binaries, enforces the same size limits (25MB/file, 50MB total).
# Ships trek-plugin.json, README.md, LICENSE(.md), package.json + server/ + client/.
# docs/ is intentionally NOT shipped — the store fetches docs/screenshot.png from
# your repo. It refuses a plugin that could not LOAD, but deliberately does not
# enforce the publish gates (an unwritten README, a missing screenshot) — packing is
# how you sideload a plugin to try it locally.
trek-plugin pack [dir] [--out plugin.zip] [--json]

# Boot the dev server, render the plugin in the themed /preview frame, and write a
# 1600x900 docs/screenshot.png. Needs Playwright (not an SDK dependency — it ships a
# browser): npm i -D playwright && npx playwright install chromium
trek-plugin shot [dir] [--port 4317] [--out docs/screenshot.png] [--dark] [--no-serve]

# Ed25519 signing. keygen once; `publish --sign` is the usual way to use the key.
trek-plugin keygen [--key file]
trek-plugin sign [zip] [--key file]

# Move a published plugin to a NEW signing key WITHOUT shipping a version (lost or
# compromised key, planned rotation): fetches your published entry, re-signs every
# pinned version's artifact with the new key (each verified against its sha256 first,
# all-or-nothing), swaps authorPublicKey, and opens a registry PR flagged as a
# rotation. The PR needs a maintainer's `allow-key-change` label, and every admin who
# has the plugin must re-trust the new key. To rotate WHILE shipping a version, use
# `publish --sign --allow-key-change` instead.
trek-plugin rotate-key [dir] [--id plugin-id] [--key file] [--out entry.json] [--draft]

# Emit the ready-to-PR registry entry: commitSha (resolved from the git tag),
# downloadUrl, sha256, size, and the manifest's `trek` range verbatim — plus
# requiredAddons and pluginDependencies, which the registry parity-checks against the
# manifest. --merge prepends a new version onto an existing entry (the update case,
# kept newest-first).
trek-plugin entry --repo owner/name --tag vX.Y.Z [--zip plugin.zip] [--merge entry.json] [--out file]

# The registry checks that genuinely need the network: the tag resolves to the commit
# the entry pins, the released artifact downloads and hashes to the pinned sha256, the
# id is not bound to another GitHub owner, and an update does not drop or rotate a
# signing key you already published under (`--allow-key-change` declares a deliberate
# rotation, turning that refusal into a pass). `publish` runs this for you.
trek-plugin preflight [dir] --repo owner/name --tag vX.Y.Z [--entry file.json] [--all] [--allow-key-change]

# Pack -> cut the GitHub release -> print the entry, without opening the registry PR.
trek-plugin release [dir] --repo owner/name --tag vX.Y.Z [--sign] [--merge entry.json]

# Fork the registry, write registry/plugins/<id>.json, open the PR. Needs `gh`.
trek-plugin submit [dir] --repo owner/name --tag vX.Y.Z [--registry o/n] [--draft]

# Delete a stranded release + remote tag + local tag in one go. Checks the published
# registry index first and REFUSES a version that is actually published (immutable);
# --yes consents when the index can't be reached.
trek-plugin unrelease vX.Y.Z [dir] --repo owner/name [--yes]
```

`publish` chains those last steps in the order that matters: **check → pack → release →
preflight → submit**. The local gates run *before* anything is tagged or released,
because a GitHub release is effectively immutable — the registry pins its sha256 —
and a failure *after* the release is cut rolls back everything that run created (the
release, both tags), so the same tag is free to re-run against (`--keep-release`
opts out). See [[Publishing a Plugin|Plugin-Publishing]].

## Registry & publishing

- **No reserved namespaces** — any unique slug id is accepted. (A tiny set of ids
  like `registry`/`install`/`rescan` is blocked only because they'd collide with
  admin API routes.)
- **Owner-binding** still prevents anyone but the original author from repointing
  an existing id to a different repo.
- **Optional author signing:** an entry may carry `authorPublicKey` (stable,
  TOFU-pinned on first install) and each version a `signature` over the artifact
  bytes. Unsigned plugins install on sha256 alone; a plugin that was signed can't
  later go unsigned, and a key *rotation* is a deliberate act the SDK drives —
  `trek-plugin rotate-key`, or `publish --sign --allow-key-change` — that still
  needs a registry maintainer's `allow-key-change` label plus an explicit admin
  re-trust on every instance.

Full walkthrough: [[Publishing a Plugin|Plugin-Publishing]]. Overview:
[[Plugins|Plugins]].
