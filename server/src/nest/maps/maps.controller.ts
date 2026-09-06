import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  MapsAutocompleteResult,
  MapsPlaceDetailsResult,
  MapsPlacePhotoResult,
  MapsResolveUrlResult,
  MapsReverseResult,
  MapsSearchResult,
} from '@trek/shared';
import type { User } from '../../types';
import { MapsService } from './maps.service';
import { StorageService } from '../storage/storage.service';
import { isClientAbortError } from '../storage/storage.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { MapsSearchDto, MapsAutocompleteDto, MapsResolveUrlDto } from './maps.dto';

/** Google's session-token shape: URL-safe ASCII, at most 36 characters. The
 *  autocomplete body is validated by the Zod pipe; the details query is not,
 *  so it is checked here rather than forwarded blindly. */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{1,36}$/;

/** Maps a thrown service error to the same status + { error } body Express sent. */
function toHttpException(err: unknown, fallbackMessage: string, defaultStatus: number): HttpException {
  const status = (err as { status?: number }).status || defaultStatus;
  const message = err instanceof Error ? err.message : fallbackMessage;
  return new HttpException({ error: message }, status);
}

/**
 * /api/maps — place search, autocomplete, details, photos, reverse geocoding and
 * Google-Maps-URL resolution.
 *
 * Behaviour matches the legacy Express route (server/src/routes/maps.ts): same
 * auth, same per-endpoint kill-switch short-circuits, same error status/body
 * mapping, same diagnostic logging, and the same bespoke 400s for non-body
 * validation (reverse's query params). The SSRF guard lives in the underlying
 * service and is reused unchanged.
 *
 * Bodies are validated against the @trek/shared maps schemas via maps.dto.ts
 * (global ZodValidationPipe). This replaced the legacy bespoke 400s ('Search
 * query is required', 'Input is required', 'Input too long (max 200 chars)',
 * 'URL is required', the two 'Invalid locationBias: …' messages) with the
 * pipe's uniform { error: 'field: message; …' } envelope — and the pipe runs
 * before the handler, so an invalid autocomplete body now 400s even while the
 * autocomplete kill-switch is on (the legacy route answered the disabled
 * envelope first).
 */
@Controller('api/maps')
@UseGuards(JwtAuthGuard)
export class MapsController {
  constructor(
    private readonly maps: MapsService,
    private readonly storage: StorageService,
  ) {}

  @Post('search')
  @HttpCode(200) // Express answers with res.json (200); Nest would otherwise default POST to 201.
  async search(
    @CurrentUser() user: User,
    @Body() body: MapsSearchDto,
    @Query('lang') lang?: string,
  ): Promise<MapsSearchResult> {
    try {
      return await this.maps.search(user.id, body.query, lang, body.locationBias);
    } catch (err: unknown) {
      console.error('Maps search error:', err);
      throw toHttpException(err, 'Search error', 500);
    }
  }

  // OSM-only POI explore: places of a category within the current map viewport.
  @Get('pois')
  async pois(
    @Query('category') category?: string,
    @Query('south') south?: string,
    @Query('west') west?: string,
    @Query('north') north?: string,
    @Query('east') east?: string,
    @Query('lang') lang?: string,
  ) {
    if (!category) throw new HttpException({ error: 'A category is required' }, 400);
    const bbox = { south: Number(south), west: Number(west), north: Number(north), east: Number(east) };
    if (Object.values(bbox).some(v => !Number.isFinite(v))) {
      throw new HttpException({ error: 'A valid bbox (south, west, north, east) is required' }, 400);
    }
    try {
      return await this.maps.pois(category, bbox, lang);
    } catch (err: unknown) {
      throw toHttpException(err, 'POI search error', 500);
    }
  }

  /**
   * Every place in a box, for the offline cache. Read-only and cheap.
   *
   * Not a browse endpoint: the index caps the box at 1.5 degrees a side, and
   * this passes the cap's refusal straight through rather than paging around
   * it. The honest use is one trip's area, taken once.
   */
  @Get('area')
  async area(
    @Query('minLat') minLat?: string,
    @Query('minLng') minLng?: string,
    @Query('maxLat') maxLat?: string,
    @Query('maxLng') maxLng?: string,
    @Query('limit') limit?: string,
  ) {
    const bbox = {
      minLat: Number(minLat),
      minLng: Number(minLng),
      maxLat: Number(maxLat),
      maxLng: Number(maxLng),
    };
    if (Object.values(bbox).some((v) => !Number.isFinite(v))) {
      throw new HttpException({ error: 'A valid bbox (minLat, minLng, maxLat, maxLng) is required' }, 400);
    }
    const capped = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
    const area = await this.maps.placesInArea(bbox, capped);
    // A null means the index is off or unreachable. An empty area is not an
    // error — the caller caches nothing and carries on.
    return area ?? { results: [], truncated: false, unavailable: true };
  }

  @Post('autocomplete')
  @HttpCode(200)
  async autocomplete(
    @CurrentUser() user: User,
    @Body() body: MapsAutocompleteDto,
  ): Promise<MapsAutocompleteResult | { suggestions: never[]; source: string }> {
    if (this.maps.autocompleteDisabled()) {
      return { suggestions: [], source: 'disabled' };
    }
    try {
      return await this.maps.autocomplete(user.id, body.input, body.lang, body.locationBias, body.sessionToken);
    } catch (err: unknown) {
      console.error('Maps autocomplete error:', err);
      throw toHttpException(err, 'Autocomplete error', 500);
    }
  }

  @Get('details/:placeId')
  async details(
    @CurrentUser() user: User,
    @Param('placeId') placeId: string,
    @Query('expand') expand?: string,
    @Query('lang') lang?: string,
    @Query('refresh') refresh?: string,
    // Closes the autocomplete session this lookup came from. Only forwarded when
    // it matches Google's shape, so a junk value bills per request instead of
    // breaking the lookup.
    @Query('sessionToken') sessionToken?: string,
  ): Promise<MapsPlaceDetailsResult> {
    if (this.maps.detailsDisabled()) {
      return { place: null, disabled: true };
    }
    try {
      return expand
        ? await this.maps.detailsExpanded(user.id, placeId, lang, refresh === '1')
        : await this.maps.details(user.id, placeId, lang, SESSION_TOKEN.test(sessionToken ?? '') ? sessionToken : undefined);
    } catch (err: unknown) {
      console.error('Maps details error:', err);
      throw toHttpException(err, 'Error fetching place details', 500);
    }
  }

  @Get('place-photo/:placeId')
  async placePhoto(
    @CurrentUser() user: User,
    @Param('placeId') placeId: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('name') name?: string,
  ): Promise<MapsPlacePhotoResult | { photoUrl: null }> {
    // Kill-switch only applies to Google Places fetches — Wikimedia (coords:) stays allowed.
    if (!placeId.startsWith('coords:') && this.maps.photosDisabled()) {
      return { photoUrl: null };
    }
    // A place with no photo resolves to the same { photoUrl: null } body. It is an
    // empty result, not a missing resource, and one 404 per photo-less place gets
    // the user's IP banned by any 404-rate IPS in front of TREK (#1727).
    try {
      return await this.maps.photo(user.id, placeId, Number.parseFloat(lat as string), Number.parseFloat(lng as string), name);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status || 500;
      if (status >= 500) console.error('Place photo error:', err);
      throw toHttpException(err, 'Error fetching photo', 500);
    }
  }

  @Get('place-photo/:placeId/bytes')
  async placePhotoBytes(@Param('placeId') placeId: string, @Res() res: Response): Promise<void> {
    const key = await this.maps.photoBytesKey(placeId);
    if (!key) {
      // Same reasoning as the JSON endpoint above, and the bigger half of #1727:
      // places keep this URL in image_url, so a trip render asks for one photo per
      // place and every entry the cache sweep dropped answered 404 — a whole map
      // worth of them from one IP in one second. An empty 204 leaves the <img>
      // with nothing to show, exactly like the 404 did.
      this.emptyPhoto(res);
      return;
    }
    // Bytes are stream-piped (spec §Serving pins this route's stream contract);
    // headers go on before the stream attempt, matching the old createReadStream
    // ordering — an early failure overrides them via emptyPhoto exactly as the
    // old error event did. Cached photos are always JPEG (placePhotoCache
    // writes `<hash>.jpg`).
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.type('image/jpeg');
    let stream: Readable;
    try {
      ({ stream } = await this.storage.getStream('photos-google', key));
    } catch {
      // Cache-delete race — same terminal state as the old stream error path.
      if (!res.headersSent) this.emptyPhoto(res);
      return;
    }
    try {
      // pipeline destroys the source on any failure (no leaked read handle),
      // matching storage.service.ts's sendToResponse contract.
      await pipeline(stream, res);
    } catch (err) {
      if (!res.headersSent) {
        // Same terminal state as the old pre-flush stream error path.
        this.emptyPhoto(res);
        return;
      }
      // Bytes are already on the wire — a client abort mid-download is the
      // client's problem now, not ours; a real source error still surfaces
      // (to the exception filter, which now no-ops safely on headersSent).
      if (!isClientAbortError(err)) throw err;
    }
  }

  // 204 for "no bytes to serve". Overrides the immutable Cache-Control the hit
  // path already set — a photo that reappears in the cache must not stay hidden
  // behind a month-old empty response.
  private emptyPhoto(res: Response): void {
    res.set('Cache-Control', 'no-store');
    res.status(204).end();
  }

  @Get('reverse')
  async reverse(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('lang') lang?: string,
  ): Promise<MapsReverseResult> {
    if (!lat || !lng) {
      throw new HttpException({ error: 'lat and lng required' }, 400);
    }
    try {
      return await this.maps.reverse(lat, lng, lang);
    } catch {
      // The legacy route swallows reverse-geocode failures into an empty result.
      return { name: null, address: null };
    }
  }

  @Post('resolve-url')
  @HttpCode(200)
  async resolveUrl(@Body() body: MapsResolveUrlDto): Promise<MapsResolveUrlResult> {
    try {
      return await this.maps.resolveUrl(body.url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to resolve URL';
      console.error('[Maps] URL resolve error:', message);
      throw toHttpException(err, 'Failed to resolve URL', 400);
    }
  }
}
