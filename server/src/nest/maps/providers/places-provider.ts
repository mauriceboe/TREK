/**
 * The places-provider seam.
 *
 * Before this file, MapsService reached Google inline and every method carried
 * its own `if (!apiKey) → OpenStreetMap` branch. That worked for two sources and
 * stops working at three: adding Amap that way means a three-way conditional in
 * `searchPlaces`, another in `autocompletePlaces`, two more in the details pair,
 * and a fourth spelling of "which credential did we end up using" in each.
 *
 * So the *keyed* providers — the ones an admin configures and that bill somebody
 * — are implemented behind this interface, and MapsService keeps what is
 * genuinely its own: the caches, the kill switches, the photo orchestration and
 * the Wikimedia enrichment.
 *
 * OpenStreetMap deliberately does NOT implement this interface. It is the
 * keyless floor every install falls back to, it has no credential to resolve,
 * and its details path is a Nominatim/Overpass merge that answers a different
 * question from a single provider lookup. Dressing it up as a provider would
 * mean either a fake key or an interface full of optionals. `null` from
 * `resolvePlacesProvider` means "use the OSM stack", which is also exactly what
 * the code did before.
 *
 * Every method returns the same normalised place shape regardless of provider —
 * `name/address/lat/lng` in WGS-84, plus whatever provider-specific ids the
 * client already persists (`google_place_id`, `amap_poi_id`, …). Coordinates are
 * WGS-84 by contract: a provider that speaks another datum converts at its own
 * boundary (see amap.provider.ts) so nothing downstream has to care.
 */
import type { ApiKeySource } from '../../settings/instance-api-keys';

/** The keyed providers. OpenStreetMap is absent on purpose — see the file header. */
export type PlacesProviderId = 'google' | 'amap';

/**
 * What an admin can choose. `auto` keeps whatever the install already used:
 * Google when a Google key is configured, Amap when only an Amap key is, and
 * the OSM stack when neither is. Existing installs must not change provider
 * because a new one became available, so `auto` prefers the incumbent.
 */
export type PlacesProviderChoice = 'auto' | PlacesProviderId | 'openstreetmap';

export const PLACES_PROVIDER_CHOICES: readonly PlacesProviderChoice[] = [
  'auto',
  'google',
  'amap',
  'openstreetmap',
];

export function isPlacesProviderChoice(value: unknown): value is PlacesProviderChoice {
  return typeof value === 'string' && (PLACES_PROVIDER_CHOICES as readonly string[]).includes(value);
}

/** A place as the rest of TREK consumes it. Open by design — see maps.schema.ts. */
export type ProviderPlace = Record<string, unknown>;

export interface ProviderSuggestion {
  placeId: string;
  mainText: string;
  secondaryText: string;
}

/** Bias a text search toward a point. Radius in metres; WGS-84. */
export interface SearchBias {
  lat: number;
  lng: number;
  radius?: number;
}

/** Bias autocomplete toward a viewport rectangle. WGS-84. */
export interface ViewportBias {
  low: { lat: number; lng: number };
  high: { lat: number; lng: number };
}

export interface DetailsOptions {
  lang?: string;
  /**
   * Ask for the fields only the richer (and pricier) lookup returns — reviews
   * and the editorial summary at Google. A provider without a two-tier lookup
   * ignores it and answers the same either way.
   */
  expanded?: boolean;
  /** Closes a billed autocomplete session, where the provider has the concept. */
  sessionToken?: string;
}

/** One photo the provider holds, as a reference to fetch bytes for later. */
export interface ProviderPhotoRef {
  /** Provider-opaque handle passed straight back to `photoBytes`. */
  name: string;
  /** The author as the provider names them — not the provider itself. */
  attribution: string | null;
}

/**
 * The credential and its provenance, carried so an error can say WHICH of the
 * three configured places a key can come from was used without ever logging the
 * key. This is the #1939 breadcrumb, kept when the code moved out of the service.
 */
export interface ProviderCredential {
  key: string;
  source: ApiKeySource | null;
  /** Whose request this is; 0 for an unauthenticated read. */
  userId: number;
}

export interface PlacesProvider {
  readonly id: PlacesProviderId;

  /**
   * True when this provider is the one that can resolve `placeId`.
   *
   * Sending an id to the wrong provider is not a harmless miss: Google answers
   * a foreign id with a *billable* 400 INVALID_ARGUMENT, which is the reason
   * `isGooglePlaceId` exists at all. Every details/photo path checks this first.
   */
  ownsPlaceId(placeId: string): boolean;

  searchText(query: string, lang?: string, bias?: SearchBias): Promise<ProviderPlace[]>;

  autocomplete(
    input: string,
    lang?: string,
    bias?: ViewportBias,
    sessionToken?: string,
  ): Promise<ProviderSuggestion[]>;

  /** Null when the provider has no such place — a miss, not an error. */
  placeDetails(placeId: string, opts?: DetailsOptions): Promise<ProviderPlace | null>;

  /**
   * Reverse geocoding, where the provider offers it. Absent means "use
   * Nominatim", which is what every install did before and still does for the
   * OSM stack. Null means the provider had nothing for this point.
   */
  reverse?(lat: number, lng: number, lang?: string): Promise<{ name: string | null; address: string | null } | null>;

  /**
   * Photo candidates for the enrichment picker. Optional because a provider
   * whose image licensing we cannot state is better off not offering any — the
   * Wikimedia fallback then supplies the picture, with its licence attached.
   */
  photoRefs?(placeId: string, cap: number): Promise<ProviderPhotoRef[]>;
  photoBytes?(photoName: string, maxHeightPx?: number): Promise<Buffer | null>;

  /** A one-paragraph description of the place, where the provider has one. */
  editorialSummary?(placeId: string, lang?: string): Promise<string | null>;
}
