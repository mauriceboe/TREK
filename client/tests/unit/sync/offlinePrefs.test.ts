/**
 * offlinePrefs unit tests — device-local "what to store offline" + conflict strategy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getOfflinePrefs, setCacheTiles, setConflictStrategy,
  isTripOfflineEnabled, setTripOfflineEnabled, isTripPinned, setTripPinned,
  onOfflinePrefsChange, _resetOfflinePrefs,
} from '../../../src/sync/offlinePrefs'

beforeEach(() => {
  _resetOfflinePrefs()
  try { localStorage.removeItem('trek_offline_prefs') } catch { /* ignore */ }
})

describe('offlinePrefs', () => {
  it('defaults to tiles on, no disabled trips, ask strategy', () => {
    const p = getOfflinePrefs()
    expect(p.cacheTiles).toBe(true)
    expect(p.disabledTripIds).toEqual([])
    expect(p.conflictStrategy).toBe('ask')
    expect(isTripOfflineEnabled(5)).toBe(true)
  })

  it('toggles tile caching and persists it', () => {
    setCacheTiles(false)
    expect(getOfflinePrefs().cacheTiles).toBe(false)
    expect(JSON.parse(localStorage.getItem('trek_offline_prefs')!).cacheTiles).toBe(false)
  })

  it('disables and re-enables a single trip', () => {
    setTripOfflineEnabled(7, false)
    expect(isTripOfflineEnabled(7)).toBe(false)
    expect(getOfflinePrefs().disabledTripIds).toContain(7)

    setTripOfflineEnabled(7, true)
    expect(isTripOfflineEnabled(7)).toBe(true)
    expect(getOfflinePrefs().disabledTripIds).not.toContain(7)
  })

  it('does not duplicate a trip id when disabled twice', () => {
    setTripOfflineEnabled(3, false)
    setTripOfflineEnabled(3, false)
    expect(getOfflinePrefs().disabledTripIds.filter(id => id === 3)).toHaveLength(1)
  })

  it('#2228: a trip can be pinned so the date rule cannot skip or evict it', () => {
    expect(getOfflinePrefs().pinnedTripIds).toEqual([])
    setTripPinned(5, true)
    expect(isTripPinned(5)).toBe(true)
    expect(getOfflinePrefs().pinnedTripIds).toEqual([5])
  })

  it('#2228: pinning is idempotent and releasing removes the pin', () => {
    setTripPinned(5, true)
    setTripPinned(5, true)
    expect(getOfflinePrefs().pinnedTripIds).toEqual([5])
    setTripPinned(5, false)
    expect(isTripPinned(5)).toBe(false)
    expect(getOfflinePrefs().pinnedTripIds).toEqual([])
  })

  it('#2228: prefs written before pinning existed still read back cleanly', async () => {
    // An installed device carries the old shape in localStorage. The module reads
    // it once at import, so re-import it to exercise that path: a missing
    // pinnedTripIds must default to "nothing pinned", never undefined.
    localStorage.setItem('trek_offline_prefs', JSON.stringify({ cacheTiles: false, disabledTripIds: [3], conflictStrategy: 'mine' }))
    vi.resetModules()
    const fresh = await import('../../../src/sync/offlinePrefs')
    expect(fresh.getOfflinePrefs().pinnedTripIds).toEqual([])
    expect(fresh.getOfflinePrefs().disabledTripIds).toEqual([3])
    expect(fresh.isTripPinned(3)).toBe(false)
  })

  it('sets the conflict strategy', () => {
    setConflictStrategy('mine')
    expect(getOfflinePrefs().conflictStrategy).toBe('mine')
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    let n = 0
    const unsub = onOfflinePrefsChange(() => { n++ })
    setCacheTiles(false)
    expect(n).toBe(1)
    unsub()
    setCacheTiles(true)
    expect(n).toBe(1)
  })
})
