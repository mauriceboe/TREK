import { describe, expect, it } from 'vitest'
import { gcj02ToWgs84 } from '@trek/shared'
import { getAmapUrlForPlace } from './placeAmap'

describe('getAmapUrlForPlace', () => {
  it('writes the position as lng,lat in GCJ-02', () => {
    const url = getAmapUrlForPlace({ name: '天安门', lat: 39.90869, lng: 116.39124 })!
    const position = new URL(url).searchParams.get('position')!
    const [lng, lat] = position.split(',').map(Number)

    // Longitude first — the opposite of every other pair in TREK, and what
    // Amap's URI API specifies.
    expect(lng).toBeGreaterThan(100)
    expect(lat).toBeLessThan(90)

    // And in Amap's datum: converting back must land on the stored WGS-84 value.
    // Handing the WGS-84 pair over unconverted would drop the pin a few hundred
    // metres away, which in a city is the wrong block.
    const back = gcj02ToWgs84(lat, lng)
    expect(back.lat).toBeCloseTo(39.90869, 4)
    expect(back.lng).toBeCloseTo(116.39124, 4)
    expect(lat).not.toBeCloseTo(39.90869, 4)
  })

  it('carries the place name as the marker label', () => {
    const url = getAmapUrlForPlace({ name: '故宫博物院', lat: 39.9163, lng: 116.3972 })!
    expect(new URL(url).searchParams.get('name')).toBe('故宫博物院')
  })

  it('labels an unnamed place with its coordinates rather than returning nothing', () => {
    // Amap refuses a marker request with no name, so the alternative to this is
    // no link at all for a place added by right-clicking the map.
    const url = getAmapUrlForPlace({ name: '', lat: 39.9163, lng: 116.3972 })!
    const params = new URL(url).searchParams
    expect(params.get('name')).toBe(params.get('position'))
  })

  it('needs coordinates: a name alone has nothing to place', () => {
    expect(getAmapUrlForPlace({ name: '某地', lat: null, lng: null } as never)).toBeNull()
    expect(getAmapUrlForPlace(null)).toBeNull()
  })

  it('leaves a coordinate outside China unshifted', () => {
    // GCJ-02 does not apply there, and shifting it would move the pin off the
    // place for a trip that has nothing to do with China.
    const url = getAmapUrlForPlace({ name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945 })!
    expect(new URL(url).searchParams.get('position')).toBe('2.294500,48.858400')
  })
})
