/**
 * Which provider place search will actually use, as far as the client can tell.
 *
 * This mirrors the server's MapsService.resolvePlacesProvider(): the instance's
 * places_provider choice, the keys the server reported for this caller, and the
 * same precedence. It exists so a notice can say the truth — "search is running
 * on OpenStreetMap", not "you lack a Google key" on an install whose admin
 * deliberately picked Amap.
 *
 * A mirror and not the source of truth on purpose: the server resolves keys per
 * request against the database, and only it knows for sure. If the two ever
 * disagree, the client shows a slightly wrong hint under a notice and nothing
 * else — search itself keeps asking the server.
 */

export type PlacesProviderChoice = 'auto' | 'google' | 'amap' | 'openstreetmap'
export type EffectiveSearchProvider = 'google' | 'amap' | 'openstreetmap'

export interface PlacesProviderState {
  /** The admin's places_provider choice; anything unrecognised means 'auto'. */
  placesProvider?: string | null
  /** Whether a Google key resolves for this caller (operator env, instance, own row). */
  hasMapsKey: boolean
  hasAmapKey: boolean
}

export function effectivePlacesProvider(state: PlacesProviderState): EffectiveSearchProvider {
  const choice: PlacesProviderChoice =
    state.placesProvider === 'google' || state.placesProvider === 'amap' || state.placesProvider === 'openstreetmap'
      ? state.placesProvider
      : 'auto'

  if (choice === 'openstreetmap') return 'openstreetmap'
  if (choice === 'google') return state.hasMapsKey ? 'google' : 'openstreetmap'
  if (choice === 'amap') return state.hasAmapKey ? 'amap' : 'openstreetmap'

  // auto prefers Google, the incumbent: an existing install must not move to a
  // different provider, with a different bill, just because Amap appeared.
  if (state.hasMapsKey) return 'google'
  if (state.hasAmapKey) return 'amap'
  return 'openstreetmap'
}

/**
 * Which key the "still on OpenStreetMap" upsell should suggest.
 *
 * A chosen provider names the key that belongs to it — telling an admin who
 * picked Amap to add a Google key is advice they already declined. `auto` with
 * no key at all is the only case where both are worth naming.
 *
 * Null when the admin explicitly chose OpenStreetMap: that is a decision, not a
 * gap to fill, and the notices stay quiet rather than nag.
 */
export type KeySuggestion = 'google' | 'amap' | 'any'

export function osmKeySuggestion(placesProvider?: string | null): KeySuggestion | null {
  switch (placesProvider) {
    case 'google':
      return 'google'
    case 'amap':
      return 'amap'
    case 'openstreetmap':
      return null
    // auto resolving to OSM means neither key is configured (a Google key would
    // have won), so both are honest suggestions.
    default:
      return 'any'
  }
}
