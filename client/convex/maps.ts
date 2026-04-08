import { ConvexError, v } from 'convex/values';
import { action as rawAction, internalQuery } from './_generated/server';
import { internal } from './_generated/api';

const UA = 'TREK Travel Planner';

// ── Helper: Get maps API key from plannerUsers ──────────

// Internal query to get maps API key (actions can't query DB directly)
export const _getMapsApiKey = internalQuery({
  args: { authUserKey: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query('plannerUsers')
      .withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', args.authUserKey))
      .unique() as any;
    if (user?.mapsApiKey) return user.mapsApiKey as string;
    const allUsers = await ctx.db.query('plannerUsers').collect() as any[];
    const admin = allUsers.find((u: any) => u.role === 'admin' && u.mapsApiKey);
    return (admin?.mapsApiKey as string) || null;
  },
});

async function getMapsKey(ctx: any): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) return null;
  return await ctx.runQuery(internal.maps._getMapsApiKey, { authUserKey: String(identity.subject) });
}

// ── Nominatim (free fallback) ───────────────────────────

async function searchNominatim(query: string, lang?: string) {
  const params = new URLSearchParams({
    q: query, format: 'json', addressdetails: '1', limit: '10',
    'accept-language': lang || 'en',
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': UA },
  });
  if (!response.ok) throw new Error('Nominatim API error');
  const data = await response.json() as any[];
  return data.map((item: any) => ({
    google_place_id: null,
    osm_id: `${item.osm_type}:${item.osm_id}`,
    name: item.name || item.display_name?.split(',')[0] || '',
    address: item.display_name || '',
    lat: parseFloat(item.lat) || null,
    lng: parseFloat(item.lon) || null,
    rating: null, website: null, phone: null, source: 'openstreetmap',
  }));
}

// ── Actions ─────────────────────────────────────────────

export const autocomplete = rawAction({
  args: { query: v.string(), lang: v.optional(v.string()), sessionToken: v.optional(v.string()), mode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.query) return { suggestions: [], source: 'none' };

    const apiKey = await getMapsKey(ctx);
    if (!apiKey) return { suggestions: [], source: 'openstreetmap' };

    const geographyOnly = args.mode === 'destination';
    const fieldMask = geographyOnly
      ? 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types'
      : 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat';

    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify({
        input: args.query,
        languageCode: args.lang || 'en',
        includeQueryPredictions: false,
        sessionToken: args.sessionToken || undefined,
      }),
    });

    const data = await response.json() as any;
    if (!response.ok) throw new ConvexError(data.error?.message || 'Google Places autocomplete error');

    const geographicTypes = new Set(['country', 'locality', 'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3']);

    const suggestions = (data.suggestions || [])
      .map((item: any) => item.placePrediction)
      .filter((item: any) => item)
      .filter((item: any) => {
        if (!geographyOnly) return true;
        return (item.types || []).some((type: string) => geographicTypes.has(type));
      })
      .map((item: any) => ({
        place_id: item.placeId,
        text: item.text?.text || '',
        primary_text: item.structuredFormat?.mainText?.text || item.text?.text || '',
        secondary_text: item.structuredFormat?.secondaryText?.text || '',
        types: item.types || [],
      }));

    return { suggestions, source: 'google' };
  },
});

export const search = rawAction({
  args: { query: v.string(), lang: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.query) return { places: [], source: 'none' };

    const apiKey = await getMapsKey(ctx);

    if (!apiKey) {
      const places = await searchNominatim(args.query, args.lang);
      return { places, source: 'openstreetmap' };
    }

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.websiteUri,places.nationalPhoneNumber,places.types',
      },
      body: JSON.stringify({ textQuery: args.query, languageCode: args.lang || 'en' }),
    });

    const data = await response.json() as any;
    if (!response.ok) throw new ConvexError(data.error?.message || 'Google Places API error');

    const places = (data.places || []).map((p: any) => ({
      google_place_id: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      lat: p.location?.latitude || null,
      lng: p.location?.longitude || null,
      rating: p.rating || null,
      website: p.websiteUri || null,
      phone: p.nationalPhoneNumber || null,
      source: 'google',
    }));

    return { places, source: 'google' };
  },
});

export const details = rawAction({
  args: { placeId: v.string(), lang: v.optional(v.string()), sessionToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // OSM details
    if (args.placeId.includes(':')) {
      const [osmType, osmId] = args.placeId.split(':');
      const typeMap: Record<string, string> = { node: 'node', way: 'way', relation: 'rel' };
      const oType = typeMap[osmType];
      if (!oType) return { place: { website: null, phone: null, opening_hours: null, open_now: null, source: 'openstreetmap' } };
      const query = `[out:json][timeout:5];${oType}(${osmId});out tags;`;
      try {
        const res = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!res.ok) return { place: { source: 'openstreetmap' } };
        const data = await res.json() as any;
        const tags = data.elements?.[0]?.tags || {};
        return {
          place: {
            website: tags['contact:website'] || tags.website || null,
            phone: tags['contact:phone'] || tags.phone || null,
            opening_hours: null, open_now: null,
            osm_url: `https://www.openstreetmap.org/${osmType}/${osmId}`,
            summary: tags.description || null,
            source: 'openstreetmap',
          },
        };
      } catch { return { place: { source: 'openstreetmap' } }; }
    }

    // Google details
    const apiKey = await getMapsKey(ctx);
    if (!apiKey) throw new ConvexError('Google Maps API key not configured');

    const lang = args.lang || 'en';
    const params = new URLSearchParams({ languageCode: lang });
    if (args.sessionToken) params.set('sessionToken', args.sessionToken);

    const response = await fetch(`https://places.googleapis.com/v1/places/${args.placeId}?${params}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,viewport,rating,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri,reviews,editorialSummary',
      },
    });

    const data = await response.json() as any;
    if (!response.ok) throw new ConvexError(data.error?.message || 'Google Places API error');

    return {
      place: {
        google_place_id: data.id,
        name: data.displayName?.text || '',
        address: data.formattedAddress || '',
        lat: data.location?.latitude || null,
        lng: data.location?.longitude || null,
        viewport: data.viewport ? {
          south: data.viewport.low?.latitude ?? null, west: data.viewport.low?.longitude ?? null,
          north: data.viewport.high?.latitude ?? null, east: data.viewport.high?.longitude ?? null,
        } : null,
        rating: data.rating || null,
        rating_count: data.userRatingCount || null,
        website: data.websiteUri || null,
        phone: data.nationalPhoneNumber || null,
        opening_hours: data.regularOpeningHours?.weekdayDescriptions || null,
        open_now: data.regularOpeningHours?.openNow ?? null,
        google_maps_url: data.googleMapsUri || null,
        summary: data.editorialSummary?.text || null,
        reviews: (data.reviews || []).slice(0, 5).map((r: any) => ({
          author: r.authorAttribution?.displayName || null,
          rating: r.rating || null,
          text: r.text?.text || null,
          time: r.relativePublishTimeDescription || null,
          photo: r.authorAttribution?.photoUri || null,
        })),
        source: 'google',
      },
    };
  },
});

export const placePhoto = rawAction({
  args: { placeId: v.string(), lat: v.optional(v.number()), lng: v.optional(v.number()), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const apiKey = await getMapsKey(ctx);

    // No Google key or coordinate-only → try Wikimedia
    if (!apiKey || args.placeId.startsWith('coords:')) {
      if (args.lat && args.lng) {
        try {
          const wiki = await fetchWikimediaPhoto(args.lat, args.lng, args.name);
          if (wiki) return wiki;
        } catch { /* fall through */ }
      }
      return { photoUrl: null, attribution: null };
    }

    // Google Photos
    const detailsRes = await fetch(`https://places.googleapis.com/v1/places/${args.placeId}`, {
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'photos' },
    });
    const details = await detailsRes.json() as any;
    if (!detailsRes.ok || !details.photos?.length) return { photoUrl: null, attribution: null };

    const photo = details.photos[0];
    const attribution = photo.authorAttributions?.[0]?.displayName || null;

    const mediaRes = await fetch(
      `https://places.googleapis.com/v1/${photo.name}/media?maxHeightPx=600&key=${apiKey}&skipHttpRedirect=true`
    );
    const mediaData = await mediaRes.json() as any;
    return { photoUrl: mediaData.photoUri || null, attribution };
  },
});

export const reverse = rawAction({
  args: { lat: v.number(), lng: v.number(), lang: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    const params = new URLSearchParams({
      lat: String(args.lat), lon: String(args.lng), format: 'json',
      addressdetails: '1', zoom: '18', 'accept-language': args.lang || 'en',
    });
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
        headers: { 'User-Agent': UA },
      });
      if (!response.ok) return { name: null, address: null };
      const data = await response.json() as any;
      const addr = data.address || {};
      const name = data.name || addr.tourism || addr.amenity || addr.shop || addr.building || addr.road || null;
      return { name, address: data.display_name || null };
    } catch {
      return { name: null, address: null };
    }
  },
});

// ── Wikimedia Commons helper ────────────────────────────

async function fetchWikimediaPhoto(lat: number, lng: number, name?: string): Promise<{ photoUrl: string; attribution: string | null } | null> {
  if (name) {
    try {
      const searchParams = new URLSearchParams({
        action: 'query', format: 'json', titles: name,
        prop: 'pageimages', piprop: 'original', pilimit: '1', redirects: '1',
      });
      const res = await fetch(`https://en.wikipedia.org/w/api.php?${searchParams}`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const data = await res.json() as any;
        const pages = data.query?.pages;
        if (pages) {
          for (const page of Object.values(pages) as any[]) {
            if (page.original?.source) return { photoUrl: page.original.source, attribution: 'Wikipedia' };
          }
        }
      }
    } catch { /* fall through */ }
  }

  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'geosearch',
    ggsprimary: 'all', ggsnamespace: '6', ggsradius: '300',
    ggscoord: `${lat}|${lng}`, ggslimit: '5',
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '600',
  });
  try {
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const pages = data.query?.pages;
    if (!pages) return null;
    for (const page of Object.values(pages) as any[]) {
      const info = page.imageinfo?.[0];
      const mime = info?.mime || '';
      if (info?.url && (mime.startsWith('image/jpeg') || mime.startsWith('image/png'))) {
        const attribution = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, '').trim() || null;
        return { photoUrl: info.url, attribution };
      }
    }
    return null;
  } catch { return null; }
}
