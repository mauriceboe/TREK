# Convex Planner Migration

This codebase currently stores planner data in SQLite on the Express server while Better Auth and chat run on Convex.

## Goal

Move planner data into Convex so the app can eventually run without the SQLite-backed Express planner backend.

## Foundation Added

The first migration slice adds Convex planner tables and import/upsert functions for:

- `plannerUsers`
- `plannerTrips`
- `plannerTripMembers`
- `plannerDays`
- `plannerPlaces`

These tables preserve legacy SQLite ids so the migration can happen incrementally without breaking existing client assumptions.

## Import Order

Import data in this order:

1. `upsertUsers`
2. `upsertTrips`
3. `upsertTripMembers`
4. `upsertDays`
5. `upsertPlaces`

Foreign keys are resolved by legacy ids during import.

## Backfill Script

The first operational migration command now lives in `server/`:

```bash
cd server
npm run migrate:planner:convex -- --dry-run
npm run migrate:planner:convex
```

Environment expected by the script:

- `CONVEX_URL` for the `.convex.cloud` deployment URL
- `CONVEX_DEPLOY_KEY` for admin-authenticated internal mutations
- optional `SQLITE_PATH` to override the default `server/data/travel.db`

If `CONVEX_URL` is not set, the script falls back to `VITE_CONVEX_URL` or derives the cloud URL from `CONVEX_SITE_URL`.

The script imports batches in the documented dependency order and prints post-import Convex counts so cutover work can verify the mirror before changing reads.

## Read Surface Added

The initial public Convex read surface is:

- `listTripsForViewer`
- `getTripSummary`
- `getMigrationCounts`

This is enough to begin switching read-only dashboard screens to Convex once data is backfilled.

## Recommended Next Phases

1. Run the backfill script against the target Convex deployment and confirm the mirrored counts.
2. Switch trip list and trip summary reads to Convex.
3. Add Convex write mutations for trips/days/places.
4. Migrate memberships, assignments, reservations, files metadata, budget, packing, settings, and tags.
5. Replace local file storage with object storage before moving fully to Vercel.

## Important Constraint

Even after planner data is moved into Convex, local uploads still block a clean Vercel deployment. File storage will need to move to object storage such as S3-compatible storage or Vercel Blob.
