// FE-API-COLLECTIONS-001 to FE-API-COLLECTIONS-032
//
// The Collections addon wrapper is thin, but every method encodes a URL, a verb and a
// request-body shape that the server contract depends on. These tests drive each method
// through MSW and pin the method + path + payload, plus the unwrapping of `r.data`.
import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse, type JsonBodyType } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { collectionsApi } from './collections'
import type { Collection, CollectionLabel, CollectionPlace } from '@trek/shared'

const BASE = '/api/addons/collections'

const collection: Collection = { id: 1, owner_id: 1, name: 'Tokyo', place_count: 2, is_owner: true }
const place: CollectionPlace = { id: 10, collection_id: 1, name: 'Shibuya Crossing', status: 'want' }
const label: CollectionLabel = { id: 3, collection_id: 1, name: 'Food', color: '#ef4444' }

let requestUrl = ''
let requestBody: unknown

beforeEach(() => {
  requestUrl = ''
  requestBody = undefined
})

/** Records url + parsed JSON body of the intercepted request, then answers with `data`. */
function record<T extends JsonBodyType>(data: T) {
  return async ({ request }: { request: Request }) => {
    requestUrl = request.url
    const text = await request.text()
    if (text) {
      try {
        requestBody = JSON.parse(text)
      } catch {
        requestBody = text
      }
    }
    return HttpResponse.json(data)
  }
}

describe('collectionsApi', () => {
  it('FE-API-COLLECTIONS-001: list() unwraps the collections + incomingInvites envelope', async () => {
    server.use(http.get(BASE, record({ collections: [collection], incomingInvites: [] })))

    const res = await collectionsApi.list()

    expect(res.collections).toEqual([collection])
    expect(res.incomingInvites).toEqual([])
  })

  it('FE-API-COLLECTIONS-002: get() requests the list by id', async () => {
    server.use(http.get(`${BASE}/:id`, record({ collection, places: [place] })))

    const res = await collectionsApi.get(1)

    expect(requestUrl).toContain(`${BASE}/1`)
    expect(res.places).toEqual([place])
    expect(res.collection.name).toBe('Tokyo')
  })

  // Both handlers answer with the BARE collection, the way the controller does —
  // stubbing a { collection } envelope here is what let the client keep reading
  // `.collection` off a response that never had one.
  it('FE-API-COLLECTIONS-003: create() posts the create payload and returns the list itself', async () => {
    server.use(http.post(BASE, record(collection)))

    const res = await collectionsApi.create({ name: 'Tokyo', color: '#111827' })

    expect(requestBody).toEqual({ name: 'Tokyo', color: '#111827' })
    expect(res.id).toBe(1)
  })

  it('FE-API-COLLECTIONS-004: update() patches the list by id', async () => {
    server.use(http.patch(`${BASE}/:id`, record(collection)))

    const res = await collectionsApi.update(1, { name: 'Tokyo 2026' })

    expect(requestUrl).toContain(`${BASE}/1`)
    expect(requestBody).toEqual({ name: 'Tokyo 2026' })
    expect(res).toEqual(collection)
  })

  it('FE-API-COLLECTIONS-005: uploadCover() posts multipart to the cover endpoint', async () => {
    server.use(http.post(`${BASE}/:id/cover`, record(collection)))

    const fd = new FormData()
    fd.append('cover', new File(['x'], 'cover.jpg'))
    const res = await collectionsApi.uploadCover(1, fd)

    expect(requestUrl).toContain(`${BASE}/1/cover`)
    expect(res).toEqual(collection)
  })

  it('FE-API-COLLECTIONS-006: remove() deletes the list', async () => {
    server.use(http.delete(`${BASE}/:id`, record({ success: true })))

    const res = await collectionsApi.remove(4)

    expect(requestUrl).toContain(`${BASE}/4`)
    expect(res).toEqual({ success: true })
  })

  it('FE-API-COLLECTIONS-007: reorder() posts the ordered ids', async () => {
    server.use(http.post(`${BASE}/reorder`, record({ success: true })))

    await collectionsApi.reorder([3, 1, 2])

    expect(requestBody).toEqual({ orderedIds: [3, 1, 2] })
  })

  it('FE-API-COLLECTIONS-008: savePlace() posts the place payload', async () => {
    server.use(http.post(`${BASE}/places`, record({ place })))

    const res = await collectionsApi.savePlace({ collection_id: 1, name: 'Shibuya Crossing', force: true })

    expect(requestBody).toEqual({ collection_id: 1, name: 'Shibuya Crossing', force: true })
    expect(res.place).toEqual(place)
  })

  it('FE-API-COLLECTIONS-009: saveFromTrip() posts the provenance-only payload', async () => {
    server.use(http.post(`${BASE}/places/from-trip`, record({ duplicate: true, duplicateOf: { id: 9, name: 'Shibuya' } })))

    const res = await collectionsApi.saveFromTrip({ collection_id: 1, source_trip_id: 7, source_place_id: 42 })

    expect(requestBody).toEqual({ collection_id: 1, source_trip_id: 7, source_place_id: 42 })
    expect(res.duplicate).toBe(true)
  })

  it('FE-API-COLLECTIONS-010: saveFromTripMany() maps its arguments onto the bulk payload', async () => {
    server.use(http.post(`${BASE}/places/from-trip-many`, record({ copied: 2, skipped: [] })))

    const res = await collectionsApi.saveFromTripMany(1, 7, [11, 12], true)

    expect(requestBody).toEqual({ collection_id: 1, source_trip_id: 7, source_place_ids: [11, 12], force: true })
    expect(res.copied).toBe(2)
  })

  it('FE-API-COLLECTIONS-011: updatePlace() patches the place and returns it unwrapped', async () => {
    server.use(http.patch(`${BASE}/places/:pid`, record({ ...place, notes: 'busy at night' })))

    const res = await collectionsApi.updatePlace(10, { notes: 'busy at night' })

    expect(requestUrl).toContain(`${BASE}/places/10`)
    expect(requestBody).toEqual({ notes: 'busy at night' })
    expect(res.notes).toBe('busy at night')
  })

  it('FE-API-COLLECTIONS-012: uploadPlaceImage() posts multipart to the place image endpoint', async () => {
    server.use(http.post(`${BASE}/places/:pid/image`, record({ ...place, image_url: '/uploads/p.jpg' })))

    const fd = new FormData()
    fd.append('image', new File(['x'], 'p.jpg'))
    const res = await collectionsApi.uploadPlaceImage(10, fd)

    expect(requestUrl).toContain(`${BASE}/places/10/image`)
    expect(res.image_url).toBe('/uploads/p.jpg')
  })

  it('FE-API-COLLECTIONS-013: setStatus() posts the status', async () => {
    server.use(http.post(`${BASE}/places/:pid/status`, record({ ...place, status: 'visited' })))

    const res = await collectionsApi.setStatus(10, 'visited')

    expect(requestUrl).toContain(`${BASE}/places/10/status`)
    expect(requestBody).toEqual({ status: 'visited' })
    expect(res.status).toBe('visited')
  })

  it('FE-API-COLLECTIONS-014: ratePlace() PUTs a numeric rating', async () => {
    server.use(http.put(`${BASE}/places/:pid/rating`, record({ ...place, rating_avg: 4 })))

    const res = await collectionsApi.ratePlace(10, 4)

    expect(requestUrl).toContain(`${BASE}/places/10/rating`)
    expect(requestBody).toEqual({ rating: 4 })
    expect(res.rating_avg).toBe(4)
  })

  it('FE-API-COLLECTIONS-015: ratePlace(null) DELETEs the rating instead', async () => {
    let deleted = false
    server.use(
      http.put(`${BASE}/places/:pid/rating`, () => HttpResponse.json({ error: 'should not be called' }, { status: 500 })),
      http.delete(`${BASE}/places/:pid/rating`, () => {
        deleted = true
        return HttpResponse.json({ ...place, rating_avg: null })
      }),
    )

    const res = await collectionsApi.ratePlace(10, null)

    expect(deleted).toBe(true)
    expect(res.rating_avg).toBeNull()
  })

  it('FE-API-COLLECTIONS-016: deletePlace() deletes the saved place', async () => {
    server.use(http.delete(`${BASE}/places/:pid`, record({ success: true })))

    await collectionsApi.deletePlace(10)

    expect(requestUrl).toContain(`${BASE}/places/10`)
  })

  it('FE-API-COLLECTIONS-017: deleteMany() posts the id list', async () => {
    server.use(http.post(`${BASE}/places/delete-many`, record({ deleted: 2 })))

    const res = await collectionsApi.deleteMany([10, 11])

    expect(requestBody).toEqual({ ids: [10, 11] })
    expect(res).toEqual({ deleted: 2 })
  })

  it('FE-API-COLLECTIONS-018: copyToTrip() posts the copy payload and returns the dedup report', async () => {
    server.use(http.post(`${BASE}/copy-to-trip`, record({ copied: 1, skipped: [{ id: 11, name: 'Shibuya' }] })))

    const res = await collectionsApi.copyToTrip({ trip_id: 7, place_ids: [10, 11] })

    expect(requestBody).toEqual({ trip_id: 7, place_ids: [10, 11] })
    expect(res.copied).toBe(1)
    expect(res.skipped).toEqual([{ id: 11, name: 'Shibuya' }])
  })

  it('FE-API-COLLECTIONS-019: membership() sends the lookup as query params', async () => {
    server.use(http.get(`${BASE}/membership`, record({ saved: true, lists: [{ collection_id: 1, name: 'Tokyo', place_id: 10 }] })))

    const res = await collectionsApi.membership({ google_place_id: 'g1', lat: 35.6, lng: 139.7 })
    const params = new URL(requestUrl).searchParams

    expect(params.get('google_place_id')).toBe('g1')
    expect(params.get('lat')).toBe('35.6')
    expect(params.get('lng')).toBe('139.7')
    expect(res.saved).toBe(true)
  })

  it('FE-API-COLLECTIONS-020: invite() posts collection_id, user_id and role', async () => {
    server.use(http.post(`${BASE}/invite`, record({ success: true })))

    await collectionsApi.invite(1, 5, 'admin')

    expect(requestBody).toEqual({ collection_id: 1, user_id: 5, role: 'admin' })
  })

  it('FE-API-COLLECTIONS-021: setMemberRole() posts the new role', async () => {
    server.use(http.post(`${BASE}/members/role`, record({ success: true })))

    await collectionsApi.setMemberRole(1, 5, 'viewer')

    expect(requestBody).toEqual({ collection_id: 1, user_id: 5, role: 'viewer' })
  })

  it('FE-API-COLLECTIONS-022: acceptInvite() posts only the collection id', async () => {
    server.use(http.post(`${BASE}/invite/accept`, record({ success: true })))

    await collectionsApi.acceptInvite(1)

    expect(requestBody).toEqual({ collection_id: 1 })
  })

  it('FE-API-COLLECTIONS-023: declineInvite() posts only the collection id', async () => {
    server.use(http.post(`${BASE}/invite/decline`, record({ success: true })))

    await collectionsApi.declineInvite(2)

    expect(requestBody).toEqual({ collection_id: 2 })
  })

  it('FE-API-COLLECTIONS-024: cancelInvite() posts collection_id and user_id', async () => {
    server.use(http.post(`${BASE}/invite/cancel`, record({ success: true })))

    await collectionsApi.cancelInvite(1, 5)

    expect(requestBody).toEqual({ collection_id: 1, user_id: 5 })
  })

  it('FE-API-COLLECTIONS-025: leave() posts the collection id', async () => {
    server.use(http.post(`${BASE}/leave`, record({ success: true })))

    await collectionsApi.leave(3)

    expect(requestBody).toEqual({ collection_id: 3 })
  })

  it('FE-API-COLLECTIONS-026: removeMember() posts collection_id and user_id', async () => {
    server.use(http.post(`${BASE}/members/remove`, record({ success: true })))

    await collectionsApi.removeMember(1, 9)

    expect(requestBody).toEqual({ collection_id: 1, user_id: 9 })
  })

  it('FE-API-COLLECTIONS-027: availableUsers() reads the invitable users for a list', async () => {
    server.use(http.get(`${BASE}/:id/available-users`, record({ users: [{ id: 5, username: 'bob' }] })))

    const res = await collectionsApi.availableUsers(1)

    expect(requestUrl).toContain(`${BASE}/1/available-users`)
    expect(res.users).toEqual([{ id: 5, username: 'bob' }])
  })

  it('FE-API-COLLECTIONS-028: createLabel() posts collection_id, name and color', async () => {
    server.use(http.post(`${BASE}/labels`, record(label)))

    const res = await collectionsApi.createLabel(1, 'Food', '#ef4444')

    expect(requestBody).toEqual({ collection_id: 1, name: 'Food', color: '#ef4444' })
    expect(res).toEqual(label)
  })

  it('FE-API-COLLECTIONS-029: updateLabel() patches the label by id', async () => {
    server.use(http.patch(`${BASE}/labels/:id`, record({ ...label, name: 'Eats' })))

    const res = await collectionsApi.updateLabel(3, { name: 'Eats' })

    expect(requestUrl).toContain(`${BASE}/labels/3`)
    expect(requestBody).toEqual({ name: 'Eats' })
    expect(res.name).toBe('Eats')
  })

  it('FE-API-COLLECTIONS-030: deleteLabel() deletes the label by id', async () => {
    server.use(http.delete(`${BASE}/labels/:id`, record({ success: true })))

    await collectionsApi.deleteLabel(3)

    expect(requestUrl).toContain(`${BASE}/labels/3`)
  })

  it('FE-API-COLLECTIONS-031: assignLabels() posts label_ids and place_ids', async () => {
    server.use(http.post(`${BASE}/labels/assign`, record({ changed: 2 })))

    const res = await collectionsApi.assignLabels([3], [10, 11])

    expect(requestBody).toEqual({ label_ids: [3], place_ids: [10, 11] })
    expect(res.changed).toBe(2)
  })

  it('FE-API-COLLECTIONS-032: unassignLabels() posts to the unassign endpoint', async () => {
    server.use(http.post(`${BASE}/labels/unassign`, record({ changed: 1 })))

    const res = await collectionsApi.unassignLabels([3], [10])

    expect(requestUrl).toContain(`${BASE}/labels/unassign`)
    expect(requestBody).toEqual({ label_ids: [3], place_ids: [10] })
    expect(res.changed).toBe(1)
  })
})
