import { Injectable, HttpException } from '@nestjs/common';
import { RealtimeService } from '../realtime/realtime.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PlacesService } from '../places/places.service';
import { BudgetService } from '../budget/budget.service';
import { AddonsService } from '../addons/addons.service';
import { ADDON_IDS } from '../../addons';
import { MapsService } from '../maps/maps.service';
import { DatabaseService, type TripAccess } from '../database/database.service';
import type { User } from '../../types';
import { KitineraryExtractorService } from './kitinerary-extractor.service';
import { LlmParseService } from '../llm-parse/llm-parse.service';
import { mapReservations } from './kitinerary-mapper';
import { typeToCostCategory } from '@trek/shared';
import type { BookingImportPreviewItem, BookingImportPreviewResponse, BookingImportConfirmResponse, BookingImportMode, BookingImportFileReport, Reservation } from '@trek/shared';
import type { ParsedBookingItem, KiReservation } from './kitinerary.types';

@Injectable()
export class BookingImportService {
  constructor(
    private readonly extractor: KitineraryExtractorService,
    private readonly llmParse: LlmParseService,
    private readonly dbs: DatabaseService,
    private readonly reservations: ReservationsService,
    private readonly permissions: PermissionsService,
    private readonly budget: BudgetService,
    private readonly addons: AddonsService,
    private readonly realtime: RealtimeService,
    private readonly maps: MapsService,
    private readonly places: PlacesService,
  ) {}

  private get db() {
    return this.dbs.connection;
  }

  private resolveDayId(tripId: string, iso: string | null | undefined): number | null {
    if (!iso) return null;
    const date = iso.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const exact = this.db.prepare('SELECT id FROM days WHERE trip_id = ? AND date = ? LIMIT 1').get(tripId, date) as { id: number } | undefined;
    if (exact) return exact.id;
    // Clamp to the nearest trip day so an out-of-range / unmatched check-in still
    // resolves and the accommodation row is inserted.
    const nearest = this.db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?)) ASC, date ASC LIMIT 1').get(tripId, date) as { id: number } | undefined;
    return nearest?.id ?? null;
  }

  isAvailable(): boolean {
    return this.extractor.isAvailable();
  }

  /** True when the LLM fallback is enabled and configured for this user. */
  aiAvailable(userId: number): boolean {
    return this.llmParse.isAvailable(userId);
  }

  /**
   * Parse uploaded files and return a preview list. Does NOT persist anything.
   * Runs kitinerary first; depending on `mode`, falls back to the LLM:
   *  - no-ai:             kitinerary only
   *  - fallback-on-empty: LLM for files kitinerary returns nothing for
   *  - force-ai:          LLM on every file (kitinerary skipped)
   * LLM-derived items are flagged needs_review. Per-file AI usage is reported.
   */
  /**
   * Give a transport's endpoints coordinates, so they survive the save.
   *
   * kitinerary and the LLM name stations, stops, terminals and rental desks but
   * rarely geo-locate them — only airports come with coordinates, from the
   * mapper's own airport table. `reservation_endpoints.lat`/`lng` are NOT NULL,
   * so `saveEndpoints` drops anything without them. That guard is right; what
   * was missing is this step on the path the clients actually take.
   *
   * It lived in confirm() alone, which nothing calls: both the desktop planner
   * and mobile go preview -> review form -> ordinary save. So an endpoint the
   * extractor had named appeared in the review step's From -> To summary and
   * then vanished on save, with nothing shown and nothing logged (#1969).
   *
   * The query ladder matches the venue lookup above: name plus the booking's
   * location first, then the location alone, then the bare name. Name-only is
   * exactly what fails for a desk label like "Curbside Pickup Counter 7", so it
   * comes last rather than first.
   *
   * Answers are cached for the length of one preview: a multi-leg train repeats
   * its station names, and this lane is rate limited to roughly one request a
   * second. Returns the names it could not place, for the caller to warn about
   * rather than dropping them silently.
   */
  private async geocodeEndpoints(
    endpoints: { name?: string | null; lat?: number | null; lng?: number | null }[] | undefined,
    context: { location?: string | null; address?: string | null },
    cache: Map<string, { lat: number; lng: number } | null>,
  ): Promise<string[]> {
    if (!Array.isArray(endpoints)) return [];
    const unresolved: string[] = [];

    for (const ep of endpoints) {
      if (ep.lat != null && ep.lng != null) continue;
      if (!ep.name) continue;

      const key = ep.name.toLowerCase();
      if (cache.has(key)) {
        const hit = cache.get(key);
        if (hit) { ep.lat = hit.lat; ep.lng = hit.lng; } else { unresolved.push(ep.name); }
        continue;
      }

      const queries = [
        context.location ? `${ep.name} ${context.location}` : null,
        context.address ? `${ep.name} ${context.address}` : null,
        ep.name,
      ].filter((q): q is string => !!q);

      let found: { lat: number; lng: number } | null = null;
      try {
        for (const q of queries) {
          const hit = await this.maps.geocodeQuery(q);
          if (hit) { found = hit; break; }
        }
      } catch {
        // geocoding failure is non-fatal — the endpoint stays, and is warned about
      }

      cache.set(key, found);
      if (found) { ep.lat = found.lat; ep.lng = found.lng; } else { unresolved.push(ep.name); }
    }

    return unresolved;
  }

  async preview(
    files: Express.Multer.File[],
    mode: BookingImportMode,
    userId: number,
    onProgress?: (done: number, total: number, fileName: string) => void,
  ): Promise<BookingImportPreviewResponse> {
    const kitineraryAvailable = this.extractor.isAvailable();
    const aiAvailable = this.llmParse.isAvailable(userId);
    if (!kitineraryAvailable && !aiAvailable) {
      throw new HttpException({ error: 'KItinerary extractor is not available on this server' }, 503);
    }

    const allItems: ParsedBookingItem[] = [];
    const allWarnings: string[] = [];
    // One lookup per distinct endpoint name across the whole preview: a
    // multi-leg train repeats its stations, and this lane allows about one
    // request a second.
    const geoCache = new Map<string, { lat: number; lng: number } | null>();
    const fileReports: BookingImportFileReport[] = [];

    let processed = 0;
    for (const file of files) {
      let kiItems: KiReservation[] = [];
      let aiUsed = false;

      // Stage 1: kitinerary (skipped entirely when forcing AI).
      if (mode !== 'force-ai' && kitineraryAvailable) {
        try {
          kiItems = await this.extractor.extract(file.buffer, file.originalname);
        } catch (err) {
          allWarnings.push(`${file.originalname}: extraction failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Stage 1b: LLM fallback.
      const runLlm = aiAvailable && (mode === 'force-ai' || (mode === 'fallback-on-empty' && kiItems.length === 0));
      if (runLlm) {
        aiUsed = true;
        const llm = await this.llmParse.parse({ buffer: file.buffer, originalName: file.originalname }, userId);
        kiItems = llm.kiItems;
        allWarnings.push(...llm.warnings);
      }

      fileReports.push({ fileName: file.originalname, aiAvailable, aiUsed });

      if (kiItems.length === 0) {
        allWarnings.push(`${file.originalname}: no reservations found`);
      } else {
        const { items, warnings } = mapReservations(kiItems, file.originalname);
        // LLM extraction is less certain than kitinerary — always flag for review.
        if (aiUsed) for (const it of items) it.needs_review = true;

        // Locate the endpoints here, on the path the clients take, rather than
        // in confirm() where the code used to sit and nothing reached it.
        for (const it of items) {
          const missed = await this.geocodeEndpoints(
            (it as { endpoints?: { name?: string | null; lat?: number | null; lng?: number | null }[] }).endpoints,
            { location: (it as { location?: string | null }).location, address: (it as { _venue?: { address?: string | null } })._venue?.address },
            geoCache,
          );
          // Kept on the item rather than filtered, so it is still editable in the
          // review form, and said out loud rather than disappearing on save.
          for (const name of missed) {
            allWarnings.push(`${file.originalname}: could not locate "${name}" — set it manually before saving`);
          }
        }

        allItems.push(...items);
        allWarnings.push(...warnings);
      }

      // Report per-file progress so a background import can drive a live widget.
      onProgress?.(++processed, files.length, file.originalname);
    }

    return { items: allItems, warnings: allWarnings, files: fileReports };
  }

  /**
   * Persist a confirmed list of parsed items.
   * Creates place rows for hotel/restaurant/event venues, then calls createReservation.
   * Broadcasts reservation:created (and accommodation:created if applicable) per item.
   */
  async confirm(
    tripId: string,
    items: BookingImportPreviewItem[],
    socketId: string | undefined,
  ): Promise<BookingImportConfirmResponse> {
    const created: Reservation[] = [];
    const confirmGeoCache = new Map<string, { lat: number; lng: number } | null>();

    for (const item of items) {
      try {
        const { _venue, _accommodation, source: _src, ...reservationData } = item;

        // Auto-create a place row for venue-based reservations
        let placeId: number | undefined;
        if (_venue?.name) {
          // Geocode before creating so the broadcast carries the coordinates
          let lat = _venue.lat;
          let lng = _venue.lng;
          if (lat == null && (_venue.address || _venue.name)) {
            try {
              const queries = [
                _venue.address ? `${_venue.name} ${_venue.address}` : null,
                _venue.address ?? null,
                _venue.name,
              ].filter((q): q is string => !!q);

              for (const q of queries) {
                const hit = await this.maps.geocodeQuery(q);
                if (hit) {
                  lat = hit.lat;
                  lng = hit.lng;
                  break;
                }
              }
            } catch {
              // geocoding failure is non-fatal
            }
          }

          const place = this.places.create(tripId, {
            name: _venue.name,
            lat,
            lng,
            address: _venue.address,
            website: _venue.website,
            phone: _venue.phone,
          });
          placeId = (place as any).id;
          this.realtime.broadcast(tripId, 'place:created', { place }, socketId);
        }

        // The same lookup preview() runs, through the same helper. On anything
        // that came from a preview this is a no-op, since the endpoints already
        // carry coordinates; it stays because this route can also be called
        // with items that never went through one.
        if (Array.isArray(reservationData.endpoints)) {
          await this.geocodeEndpoints(
            reservationData.endpoints,
            { location: (reservationData as { location?: string | null }).location, address: _venue?.address },
            confirmGeoCache,
          );
          // Persist only coord'd endpoints (reservation_endpoints needs lat/lng);
          // ungeocodable ones still appeared in the preview's From→To.
          reservationData.endpoints = reservationData.endpoints.filter((ep) => ep.lat != null && ep.lng != null);
        }

        // Build create_accommodation for hotel reservations.
        // start_day_id / end_day_id are resolved from check-in/out ISO dates so
        // the accommodation row is actually inserted (createReservation gates on them).
        let createAccommodation: { place_id?: number; start_day_id?: number; end_day_id?: number; check_in?: string; check_out?: string; confirmation?: string } | undefined;
        if (item.type === 'hotel' && _accommodation) {
          const startDayId = this.resolveDayId(tripId, _accommodation.check_in);
          const endDayId   = this.resolveDayId(tripId, _accommodation.check_out);
          createAccommodation = {
            place_id: placeId,
            start_day_id: startDayId ?? undefined,
            end_day_id:   endDayId   ?? undefined,
            check_in:     _accommodation.check_in,
            check_out:    _accommodation.check_out,
            confirmation: _accommodation.confirmation,
          };
        }

        const { reservation, accommodationCreated } = this.reservations.create(tripId, {
          ...reservationData,
          place_id: placeId,
          create_accommodation: createAccommodation,
        } as any);

        this.realtime.broadcast(tripId, 'reservation:created', { reservation }, socketId);
        if (accommodationCreated) {
          this.realtime.broadcast(tripId, 'accommodation:created', {}, socketId);
        }

        // Turn an extracted price into a real linked cost (Costs addon), so the
        // booking shows up as an expense — not just a price in metadata.
        if (this.addons.isAddonEnabled(ADDON_IDS.BUDGET)) {
          const meta =
            reservationData.metadata && typeof reservationData.metadata === 'object'
              ? (reservationData.metadata as Record<string, unknown>)
              : null;
          const price = meta && meta.price != null ? Number(meta.price) : Number.NaN;
          if (Number.isFinite(price) && price > 0) {
            try {
              const budgetData = {
                category: typeToCostCategory(item.type),
                name: item.title,
                total_price: price,
                currency: meta && typeof meta.priceCurrency === 'string' ? meta.priceCurrency : null,
                reservation_id: reservation.id,
              };
              // Freeze the live FX rate for a foreign-currency booking price so a
              // settled position isn't re-opened when live rates drift (#1445).
              await this.budget.freezeForeignRate(tripId, budgetData);
              const budgetItem = this.budget.createBudgetItem(tripId, budgetData);
              this.realtime.broadcast(tripId, 'budget:created', { item: budgetItem }, socketId);
            } catch (err) {
              console.error(
                `[booking-import] Failed to create cost for "${item.title}":`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }

        created.push(reservation);
      } catch (err) {
        console.error(`[booking-import] Failed to create reservation "${item.title}":`, err instanceof Error ? err.message : err);
      }
    }

    return { created };
  }
}
