import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { AppConfigModule } from './app-config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { PlatformModule } from './platform/platform.module';
import { McpTransportModule } from './mcp-transport/mcp-transport.module';
import { GlobalAuthGuard } from './auth/global-auth.guard';
import { MfaPolicyGuard } from './auth/mfa-policy.guard';
import { ManagedGuard } from './common/managed.guard';
import { WeatherModule } from './weather/weather.module';
import { PublicApiModule } from './public-api/public-api.module';
import { HelpModule } from './help/help.module';
import { AirportsModule } from './airports/airports.module';
import { ConfigModule } from './config/config.module';
import { SystemNoticesModule } from './system-notices/system-notices.module';
import { ManagedExtModule } from './managed/managed-ext.module';
import { MapsModule } from './maps/maps.module';
import { GeoModule } from './geo/geo.module';
import { PlaceEnrichmentModule } from './place-enrichment/place-enrichment.module';
import { PlaceShadowModule } from './place-shadow/place-shadow.module';
import { CategoriesModule } from './categories/categories.module';
import { TagsModule } from './tags/tags.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AtlasModule } from './atlas/atlas.module';
import { VacayModule } from './vacay/vacay.module';
import { PackingModule } from './packing/packing.module';
import { BudgetModule } from './budget/budget.module';
import { ReservationsModule } from './reservations/reservations.module';
import { DaysModule } from './days/days.module';
import { DayNotesModule } from './day-notes/day-notes.module';
import { AccommodationsModule } from './accommodations/accommodations.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { PlacesModule } from './places/places.module';
import { TripsModule } from './trips/trips.module';
import { TodoModule } from './todo/todo.module';
import { CollabModule } from './collab/collab.module';
import { FilesModule } from './files/files.module';
import { PhotosModule } from './photos/photos.module';
import { MemoriesModule } from './memories/memories.module';
import { AirtrailModule } from './integrations/airtrail.module';
import { JourneyModule } from './journey/journey.module';
import { CollectionsModule } from './collections/collections.module';
import { ShareModule } from './share/share.module';
import { TripInviteModule } from './trip-invite/trip-invite.module';
import { TransitModule } from './transit/transit.module';
import { FeedsModule } from './feeds/feeds.module';
import { SettingsModule } from './settings/settings.module';
import { StorageModule } from './storage/storage.module';
import { BackupModule } from './backup/backup.module';
import { BookingImportModule } from './booking-import/booking-import.module';
import { ReservationImportModule } from './reservation-import/reservation-import.module';
import { LlmParseModule } from './llm-parse/llm-parse.module';
import { AuthModule } from './auth/auth.module';
import { OidcModule } from './oidc/oidc.module';
import { OauthModule } from './oauth/oauth.module';
import { AdminModule } from './admin/admin.module';
import { AddonsModule } from './addons/addons.module';
import { AuditModule } from './audit/audit.module';
import { PermissionsModule } from './permissions/permissions.module';
import { PluginsModule } from './plugins/plugins.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { McpModule } from '../nest-mcp';
import { trekMcpAccessPolicy, trekMcpValidateAccess } from '../mcp/nest-mcp-policy';
import { TrekExceptionFilter } from './common/trek-exception.filter';
import { SpaFallbackFilter } from './platform/spa-fallback.filter';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { SessionRenewalInterceptor } from './auth/session-renewal.interceptor';
import { IdempotencyCleanupJob } from './common/idempotency-cleanup.job';
import { RealtimeGatewayModule } from './realtime/realtime-gateway.module';

/**
 * Root NestJS module for the incremental migration. Domain modules
 * (weather, notifications, integrations, ...) get registered here as they are
 * migrated.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, RealtimeModule, RealtimeGatewayModule, SchedulingModule, McpModule.forRoot({ accessPolicy: trekMcpAccessPolicy, validateAccess: trekMcpValidateAccess }), HealthModule, PlatformModule, McpTransportModule, WeatherModule, PublicApiModule, HelpModule, AirportsModule, ConfigModule, SystemNoticesModule, GeoModule, MapsModule, PlaceEnrichmentModule, PlaceShadowModule, CategoriesModule, TagsModule, NotificationsModule, AtlasModule, VacayModule, PackingModule, TodoModule, BudgetModule, ReservationsModule, DaysModule, DayNotesModule, AccommodationsModule, AssignmentsModule, PlacesModule, TripsModule, CollabModule, FilesModule, PhotosModule, MemoriesModule, AirtrailModule, JourneyModule, CollectionsModule, ShareModule, TripInviteModule, TransitModule, FeedsModule, SettingsModule, StorageModule, BackupModule, AuthModule, OidcModule, OauthModule, AdminModule, AddonsModule, AuditModule, PermissionsModule, PluginsModule, BookingImportModule, ReservationImportModule, LlmParseModule, ManagedExtModule],
  providers: [
    // Default-deny: a route is authenticated unless it carries @Public() or
    // @OptionalAuth(), or declares its own @UseGuards chain. Protection used to
    // be opt-in, which made a forgotten guard a silent bypass instead of an error.
    { provide: APP_GUARD, useClass: GlobalAuthGuard },
    // Second, and only second: it reads the user the guard above resolved
    // instead of verifying the token a second time, which is what the Express
    // middleware it replaces did on every /api request.
    { provide: APP_GUARD, useClass: MfaPolicyGuard },
    // Third, and only third: a stranger gets the 401 the two above would have
    // given them rather than a 403 that confirms the route exists. Inert unless
    // the instance is centrally administered AND the route carries the marker.
    { provide: APP_GUARD, useClass: ManagedGuard },
    // Global error-envelope normaliser (DI-registered so it also catches
    // framework-level exceptions like the not-found handler).
    { provide: APP_FILTER, useClass: TrekExceptionFilter },
    // SPA fallback: serves index.html for unmatched GETs in production (the Nest
    // equivalent of the legacy Express app.get('*') catch-all). @Catch(NotFoundException)
    // is more specific than TrekExceptionFilter, so Nest routes 404s here.
    { provide: APP_FILTER, useClass: SpaFallbackFilter },
    // Replays the X-Idempotency-Key the client sends on every write, so retried
    // mutations don't double-apply.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // Sliding session renewal: re-issues the trek_session cookie once a
    // cookie-authenticated token is past half its lifetime (#1927).
    { provide: APP_INTERCEPTOR, useClass: SessionRenewalInterceptor },
    // Its nightly TTL purge — a provider here because common/ has no module.
    IdempotencyCleanupJob,
    // Global Zod validation: any parameter typed with a createZodDto class
    // (the <domain>.dto.ts wrappers over @trek/shared schemas) is validated;
    // everything else passes through untouched. Paired with the boot gate in
    // common/validate-body-contracts.ts so unvalidated mutation bodies refuse
    // to boot instead of shipping silently.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
