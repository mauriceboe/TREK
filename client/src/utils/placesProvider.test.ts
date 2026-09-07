import { describe, expect, it } from 'vitest'
import { effectivePlacesProvider, osmKeySuggestion } from './placesProvider'

/**
 * These mirror MapsService.resolvePlacesProvider() on the server, case for case.
 * The point of the mirror is honest notices, so every case where the notices
 * would lie — "add a Google key" on an install whose admin picked Amap — is
 * pinned here.
 */
describe('effectivePlacesProvider', () => {
  it('auto keeps Google when a Google key is configured, Amap key or not', () => {
    // The incumbent wins: an existing install must not move providers because
    // a new one became available.
    expect(effectivePlacesProvider({ placesProvider: 'auto', hasMapsKey: true, hasAmapKey: true })).toBe('google')
    expect(effectivePlacesProvider({ placesProvider: 'auto', hasMapsKey: true, hasAmapKey: false })).toBe('google')
  })

  it('auto falls to Amap only when there is no Google key', () => {
    expect(effectivePlacesProvider({ placesProvider: 'auto', hasMapsKey: false, hasAmapKey: true })).toBe('amap')
  })

  it('auto with neither key means OpenStreetMap', () => {
    expect(effectivePlacesProvider({ placesProvider: 'auto', hasMapsKey: false, hasAmapKey: false })).toBe('openstreetmap')
  })

  it('an explicit amap choice wins even with a Google key configured', () => {
    expect(effectivePlacesProvider({ placesProvider: 'amap', hasMapsKey: true, hasAmapKey: true })).toBe('amap')
  })

  it('an explicit google choice never silently uses Amap instead', () => {
    // Misconfigured means "answer with OSM", matching the server — not "bill
    // somebody else's provider".
    expect(effectivePlacesProvider({ placesProvider: 'google', hasMapsKey: false, hasAmapKey: true })).toBe('openstreetmap')
  })

  it('openstreetmap ignores both keys', () => {
    expect(effectivePlacesProvider({ placesProvider: 'openstreetmap', hasMapsKey: true, hasAmapKey: true })).toBe('openstreetmap')
  })

  it('a nonsense stored value degrades to auto rather than throwing', () => {
    expect(effectivePlacesProvider({ placesProvider: 'not-a-provider', hasMapsKey: false, hasAmapKey: true })).toBe('amap')
    expect(effectivePlacesProvider({ placesProvider: undefined, hasMapsKey: true, hasAmapKey: false })).toBe('google')
  })
})

describe('osmKeySuggestion', () => {
  it('a chosen provider names its own key', () => {
    expect(osmKeySuggestion('google')).toBe('google')
    expect(osmKeySuggestion('amap')).toBe('amap')
  })

  it('auto names both, because landing on OSM means neither key is set', () => {
    expect(osmKeySuggestion('auto')).toBe('any')
  })

  it('an explicit OpenStreetMap choice gets no upsell — it is a decision, not a gap', () => {
    expect(osmKeySuggestion('openstreetmap')).toBeNull()
    // An unrecognised value behaves like auto: the reader degrades it to auto,
    // so the notice must not claim the admin chose OSM when they chose nothing.
    expect(osmKeySuggestion('garbage')).toBe('any')
    expect(osmKeySuggestion(undefined)).toBe('any')
  })
})
