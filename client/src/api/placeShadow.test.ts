import { describe, it, expect, beforeEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { useAuthStore } from '../store/authStore'
import { recordPlacePick } from './placeShadow'
import type { PlaceShadowPickRequest } from '@trek/shared'

/**
 * The point of this module is that it never gets in the way: it must not fire
 * when the instance has the log switched off, must not throw when the request
 * fails, and must not send coordinates finer than the ranking needs.
 */

const PICK: PlaceShadowPickRequest = {
  query: '  losteria rostock  ',
  lang: 'de',
  biasLat: 54.088712,
  biasLng: 12.140493,
  source: 'search:nominatim',
  liveRank: 0,
  liveCount: 8,
  pickedName: "L'Osteria",
  pickedLat: 54.0891234,
  pickedLng: 12.1372987,
  pickedPlaceId: 'osm:node/1',
}

/** Resolves with the body the module posted, or null if it never posted. */
function capture(status = 200) {
  let seen: unknown = null
  let resolve: (v: unknown) => void = () => {}
  const posted = new Promise<unknown>(r => { resolve = r })
  server.use(
    http.post('/api/place-shadow/pick', async ({ request }) => {
      seen = await request.json()
      resolve(seen)
      return status === 200
        ? HttpResponse.json({ recorded: true })
        : HttpResponse.json({ error: 'nope' }, { status })
    }),
  )
  return { posted, seen: () => seen }
}

beforeEach(() => {
  useAuthStore.setState({ placeShadowEnabled: true })
})

describe('recordPlacePick', () => {
  it('sends nothing at all when the instance has the log switched off', async () => {
    useAuthStore.setState({ placeShadowEnabled: false })
    const cap = capture()
    recordPlacePick(PICK)
    await new Promise(r => setTimeout(r, 20))
    expect(cap.seen()).toBeNull()
  })

  it('trims the query and rounds every coordinate to three decimals', async () => {
    const cap = capture()
    recordPlacePick(PICK)
    expect(await cap.posted).toMatchObject({
      query: 'losteria rostock',
      pickedLat: 54.089,
      pickedLng: 12.137,
      biasLat: 54.089,
      biasLng: 12.14,
    })
  })

  it('leaves an absent bias absent rather than sending a zero', async () => {
    const cap = capture()
    recordPlacePick({ ...PICK, biasLat: undefined, biasLng: undefined })
    const body = (await cap.posted) as Record<string, unknown>
    expect(body.biasLat).toBeUndefined()
    expect(body.biasLng).toBeUndefined()
  })

  it('drops a pick with no query, no name or an impossible rank before sending', async () => {
    const cap = capture()
    recordPlacePick({ ...PICK, query: '   ' })
    recordPlacePick({ ...PICK, pickedName: '' })
    recordPlacePick({ ...PICK, liveRank: 8, liveCount: 8 })
    recordPlacePick({ ...PICK, pickedLat: Number.NaN })
    await new Promise(r => setTimeout(r, 20))
    expect(cap.seen()).toBeNull()
  })

  it('swallows a server error instead of surfacing it to the pick that triggered it', async () => {
    const cap = capture(500)
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    expect(() => recordPlacePick(PICK)).not.toThrow()
    await cap.posted
    await new Promise(r => setTimeout(r, 20))
    process.off('unhandledRejection', onUnhandled)
    expect(onUnhandled).not.toHaveBeenCalled()
  })
})
