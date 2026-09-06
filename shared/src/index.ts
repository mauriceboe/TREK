/**
 * @trek/shared — single source of truth for TREK's API contracts.
 *
 * Zod schemas defined here are consumed by BOTH the server (validation +
 * inferred DTO types) and the client (typed requests/responses). A route is
 * only considered "migrated" once its contract lives in this package.
 *
 * Layout: one folder per domain (e.g. src/trip/trip.schema.ts), plus the
 * domain-agnostic primitives below. See the board card "Module blueprint".
 */
export * from './common/primitives.schema';
export * from './common/pagination.schema';

// Domain contracts
export * from './weather/weather.schema';
export * from './public-api/public-api.schema';
export * from './airport/airport.schema';
export * from './config/config.schema';
export * from './system-notice/system-notice.schema';
export * from './maps/maps.schema';
export * from './maps/place-shadow.schema';
export * from './category/category.schema';
export * from './tag/tag.schema';
export * from './notification/notification.schema';
export * from './memories/memories.schema';
export * from './atlas/atlas.schema';
export * from './vacay/vacay.schema';
export * from './packing/packing.schema';
export * from './todo/todo.schema';
export * from './budget/budget.schema';
export * from './reservation/reservation.schema';
export * from './reservation/ki-reservation.schema';
export * from './datetime/datetime-normalize';
export * from './airtrail/airtrail.schema';
export * from './day/day.schema';
export * from './day/note-colors';
export * from './assignment/assignment.schema';
export * from './place/place.schema';
export * from './place/place-match';
export * from './place/track-colors';
export * from './collection/collection.schema';
export * from './trip/trip.schema';
export * from './trip-invite/trip-invite.schema';
export * from './collab/collab.schema';
export * from './file/file.schema';
export * from './journey/journey.schema';
export * from './book/book.schema';
export * from './book/journey-stats.schema';
export * from './book/book-store.schema';
export * from './share/share.schema';
export * from './storage/storage.schema';
export * from './settings/settings.schema';
export * from './appearance/appearance.schema';
export * from './backup/backup.schema';
export * from './auth/auth.schema';
export * from './oidc/oidc.schema';
export * from './oauth/oauth.schema';
export * from './admin/admin.schema';

// Realtime WS event contract registry (event names + payload schemas)
export * from './realtime/events.schema';

// Sanitisation helpers — used by the client today, scoped here so the server
// has them ready if rich-text input ever ships.
export * from './sanitize/sanitize';

// i18n registry (language list + pure helpers — no locale data)
export * from './i18n/languages';

// Plugin permission list, generated from the host's protocol/envelope.ts
// (server/scripts/gen-plugin-facts.ts). The admin consent screens render from it.
export * from './plugin-permissions';
// Plugin settings contracts: the settings-field descriptor + admin instance-config wire shapes.
export * from './plugins/plugins.schema';
