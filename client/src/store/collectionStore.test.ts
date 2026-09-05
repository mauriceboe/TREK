// FE-STORE-COLLECTION-001 to FE-STORE-COLLECTION-063
//
// The store owns the optimistic updates (status, labels, reorder, bulk delete) and the
// reload chains that follow every mutation, so the API layer is mocked here and the
// assertions are about resulting state + which endpoint got which arguments.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  Collection,
  CollectionDetailResponse,
  CollectionListResponse,
  CollectionPlace,
} from '@trek/shared'

vi.mock('../api/collections', () => ({
  collectionsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    uploadCover: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    savePlace: vi.fn(),
    updatePlace: vi.fn(),
    uploadPlaceImage: vi.fn(),
    setStatus: vi.fn(),
    ratePlace: vi.fn(),
    deletePlace: vi.fn(),
    deleteMany: vi.fn(),
    copyToTrip: vi.fn(),
    createLabel: vi.fn(),
    updateLabel: vi.fn(),
    deleteLabel: vi.fn(),
    assignLabels: vi.fn(),
    unassignLabels: vi.fn(),
    invite: vi.fn(),
    setMemberRole: vi.fn(),
    acceptInvite: vi.fn(),
    declineInvite: vi.fn(),
    cancelInvite: vi.fn(),
    removeMember: vi.fn(),
    leave: vi.fn(),
  },
}))

import { collectionsApi } from '../api/collections'
import { useCollectionStore, ALL_SAVED } from './collectionStore'

const listA: Collection = { id: 1, owner_id: 1, name: 'Tokyo' }
const listB: Collection = { id: 2, owner_id: 1, name: 'Kyoto' }

function buildPlace(over: Partial<CollectionPlace> = {}): CollectionPlace {
  return { id: 10, collection_id: 1, name: 'Shibuya', status: 'want', ...over }
}

function detail(over: Partial<CollectionDetailResponse> = {}): CollectionDetailResponse {
  return { collection: listA, places: [], ...over }
}

function listResponse(over: Partial<CollectionListResponse> = {}): CollectionListResponse {
  return { collections: [listA], incomingInvites: [], ...over }
}

const store = () => useCollectionStore.getState()
const initialState = useCollectionStore.getState()

beforeEach(() => {
  useCollectionStore.setState(initialState, true)
  vi.clearAllMocks()
  vi.mocked(collectionsApi.list).mockResolvedValue(listResponse())
  vi.mocked(collectionsApi.get).mockResolvedValue(detail())
  // The bare collection is what POST /addons/collections actually answers with;
  // mocking a { collection } envelope here is what hid the bug this pins.
  vi.mocked(collectionsApi.create).mockResolvedValue(listA)
  vi.mocked(collectionsApi.update).mockResolvedValue(listA)
  vi.mocked(collectionsApi.uploadCover).mockResolvedValue(listA)
  vi.mocked(collectionsApi.remove).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.reorder).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.savePlace).mockResolvedValue({ place: buildPlace() })
  vi.mocked(collectionsApi.updatePlace).mockResolvedValue(buildPlace())
  vi.mocked(collectionsApi.uploadPlaceImage).mockResolvedValue(buildPlace())
  vi.mocked(collectionsApi.setStatus).mockResolvedValue(buildPlace())
  vi.mocked(collectionsApi.ratePlace).mockResolvedValue(buildPlace())
  vi.mocked(collectionsApi.deletePlace).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.deleteMany).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.copyToTrip).mockResolvedValue({ copied: 0, skipped: [] })
  vi.mocked(collectionsApi.createLabel).mockResolvedValue({ id: 3, collection_id: 1, name: 'Food' })
  vi.mocked(collectionsApi.updateLabel).mockResolvedValue({ id: 3, collection_id: 1, name: 'Food' })
  vi.mocked(collectionsApi.deleteLabel).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.assignLabels).mockResolvedValue({ changed: 1 })
  vi.mocked(collectionsApi.unassignLabels).mockResolvedValue({ changed: 1 })
  vi.mocked(collectionsApi.invite).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.setMemberRole).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.acceptInvite).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.declineInvite).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.cancelInvite).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.removeMember).mockResolvedValue({ success: true })
  vi.mocked(collectionsApi.leave).mockResolvedValue({ success: true })
})

describe('collectionStore — loading', () => {
  it('FE-STORE-COLLECTION-001: loadAll() stores collections and incoming invites', async () => {
    vi.mocked(collectionsApi.list).mockResolvedValue(
      listResponse({
        collections: [listA, listB],
        incomingInvites: [{ collection_id: 9, name: 'Osaka', from: { id: 4, username: 'bob' } }],
      }),
    )

    await store().loadAll()

    expect(store().collections).toEqual([listA, listB])
    expect(store().incomingInvites[0].name).toBe('Osaka')
    expect(store().loading).toBe(false)
  })

  it('FE-STORE-COLLECTION-002: loadAll() clears the loading flag even when the request fails', async () => {
    vi.mocked(collectionsApi.list).mockRejectedValue(new Error('offline'))

    await expect(store().loadAll()).rejects.toThrow('offline')
    expect(store().loading).toBe(false)
    expect(store().collections).toEqual([])
  })

  it('FE-STORE-COLLECTION-003: loadCollection() stores places, members and labels', async () => {
    vi.mocked(collectionsApi.get).mockResolvedValue(
      detail({
        collection: {
          ...listA,
          members: [{ user_id: 5, username: 'bob', status: 'accepted' }],
          labels: [{ id: 3, collection_id: 1, name: 'Food' }],
        },
        places: [buildPlace()],
      }),
    )

    await store().loadCollection(1)

    expect(store().activeId).toBe(1)
    expect(store().places).toHaveLength(1)
    expect(store().members[0].username).toBe('bob')
    expect(store().labels[0].name).toBe('Food')
    expect(store().placesLoading).toBe(false)
  })

  it('FE-STORE-COLLECTION-004: loadCollection() falls back to empty members and labels', async () => {
    vi.mocked(collectionsApi.get).mockResolvedValue(detail({ places: [buildPlace()] }))

    await store().loadCollection(1)

    expect(store().members).toEqual([])
    expect(store().labels).toEqual([])
  })

  it('FE-STORE-COLLECTION-005: loadCollection() clears the active list when the fetch fails for it', async () => {
    useCollectionStore.setState({ activeId: 1, places: [buildPlace()], members: [], labels: [] })
    vi.mocked(collectionsApi.get).mockRejectedValue(new Error('403'))

    await store().loadCollection(1)

    expect(store().activeId).toBeNull()
    expect(store().places).toEqual([])
    expect(store().placesLoading).toBe(false)
  })

  it('FE-STORE-COLLECTION-006: loadCollection() keeps state when a different list fails', async () => {
    useCollectionStore.setState({ activeId: 2, places: [buildPlace()] })
    vi.mocked(collectionsApi.get).mockRejectedValue(new Error('403'))

    await store().loadCollection(1)

    expect(store().activeId).toBe(2)
    expect(store().places).toHaveLength(1)
  })
})

describe('collectionStore — setActive', () => {
  it('FE-STORE-COLLECTION-007: setActive(null) clears the list and the selection', async () => {
    useCollectionStore.setState({
      activeId: 1,
      places: [buildPlace()],
      members: [{ user_id: 5, username: 'bob', status: 'accepted' }],
      labels: [{ id: 3, collection_id: 1, name: 'Food' }],
      selectMode: true,
      selectedIds: [10],
      selectedPlaceId: 10,
      labelFilter: [3],
    })

    await store().setActive(null)

    expect(store().activeId).toBeNull()
    expect(store().places).toEqual([])
    expect(store().members).toEqual([])
    expect(store().labels).toEqual([])
    expect(store().selectMode).toBe(false)
    expect(store().selectedIds).toEqual([])
    expect(store().selectedPlaceId).toBeNull()
    expect(store().labelFilter).toEqual([])
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-008: setActive(ALL_SAVED) unions every list, dedups and skips failures', async () => {
    useCollectionStore.setState({ collections: [listA, listB, { id: 3, owner_id: 1, name: 'Nara' }] })
    vi.mocked(collectionsApi.get).mockImplementation(async (id: number) => {
      if (id === 1) return detail({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] })
      if (id === 2) return detail({ places: [buildPlace({ id: 11 }), buildPlace({ id: 12 })] })
      throw new Error('403')
    })

    await store().setActive(ALL_SAVED)

    expect(store().activeId).toBe(ALL_SAVED)
    expect(store().places.map(p => p.id)).toEqual([10, 11, 12])
    expect(store().members).toEqual([])
    expect(store().placesLoading).toBe(false)
  })

  it('FE-STORE-COLLECTION-009: setActive(ALL_SAVED) loads the lists first when none are known yet', async () => {
    vi.mocked(collectionsApi.list).mockResolvedValue(listResponse({ collections: [listB] }))
    vi.mocked(collectionsApi.get).mockResolvedValue(detail({ places: [buildPlace({ id: 21 })] }))

    await store().setActive(ALL_SAVED)

    expect(collectionsApi.list).toHaveBeenCalled()
    expect(collectionsApi.get).toHaveBeenCalledWith(2)
    expect(store().places.map(p => p.id)).toEqual([21])
  })

  it('FE-STORE-COLLECTION-010: setActive(id) delegates to loadCollection', async () => {
    vi.mocked(collectionsApi.get).mockResolvedValue(detail({ places: [buildPlace()] }))
    useCollectionStore.setState({ selectMode: true, selectedIds: [10], selectedPlaceId: 10, labelFilter: [3] })

    await store().setActive(1)

    expect(collectionsApi.get).toHaveBeenCalledWith(1)
    expect(store().activeId).toBe(1)
    // Switching lists still drops what belongs to the list we came from.
    expect(store().selectMode).toBe(false)
    expect(store().selectedIds).toEqual([])
    expect(store().selectedPlaceId).toBeNull()
    expect(store().labelFilter).toEqual([])
  })

  it('FE-STORE-COLLECTION-011: refreshActive() is a no-op without an active list', async () => {
    await store().refreshActive()

    expect(collectionsApi.get).not.toHaveBeenCalled()
    expect(collectionsApi.list).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-012: refreshActive() re-reads the current list', async () => {
    useCollectionStore.setState({ activeId: 1 })

    await store().refreshActive()

    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-062: refreshActive() keeps the selection and the label filter', async () => {
    vi.mocked(collectionsApi.get).mockResolvedValue(detail({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] }))
    useCollectionStore.setState({ activeId: 1, selectMode: true, selectedIds: [10, 11], selectedPlaceId: 11, labelFilter: [3] })

    await store().refreshActive()

    expect(store().selectMode).toBe(true)
    expect(store().selectedIds).toEqual([10, 11])
    expect(store().selectedPlaceId).toBe(11)
    expect(store().labelFilter).toEqual([3])
  })

  it('FE-STORE-COLLECTION-063: refreshActive() drops selected places the reload no longer has', async () => {
    vi.mocked(collectionsApi.get).mockResolvedValue(detail({ places: [buildPlace({ id: 10 })] }))
    useCollectionStore.setState({ activeId: 1, selectMode: true, selectedIds: [10, 11], selectedPlaceId: 11 })

    await store().refreshActive()

    expect(store().selectedIds).toEqual([10])
    expect(store().selectedPlaceId).toBeNull()
    expect(store().selectMode).toBe(true)
  })
})

describe('collectionStore — list CRUD', () => {
  it('FE-STORE-COLLECTION-013: createCollection() returns the new list and reloads', async () => {
    const created = await store().createCollection({ name: 'Tokyo' })

    expect(collectionsApi.create).toHaveBeenCalledWith({ name: 'Tokyo' })
    expect(created).toEqual(listA)
    expect(store().collections).toEqual([listA])
  })

  it('FE-STORE-COLLECTION-014: createCollection() returns null when the response carries no list', async () => {
    vi.mocked(collectionsApi.create).mockResolvedValue(undefined as unknown as Collection)

    expect(await store().createCollection({ name: 'Tokyo' })).toBeNull()
  })

  // The API declared a { collection } envelope the server never sends, so the id
  // never reached the caller: a cover picked while creating a list was dropped
  // and the new list never opened.
  it('FE-STORE-COLLECTION-014b: createCollection() hands back the id the server sent', async () => {
    const created = await store().createCollection({ name: 'Tokyo' })

    expect(created?.id).toBe(1)
  })

  it('FE-STORE-COLLECTION-015: updateCollection() reloads the detail when the list is active', async () => {
    useCollectionStore.setState({ activeId: 1 })

    await store().updateCollection(1, { name: 'Tokyo 2026' })

    expect(collectionsApi.update).toHaveBeenCalledWith(1, { name: 'Tokyo 2026' })
    expect(collectionsApi.list).toHaveBeenCalled()
    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-016: updateCollection() skips the detail reload for a non-active list', async () => {
    useCollectionStore.setState({ activeId: 2 })

    await store().updateCollection(1, { name: 'Tokyo 2026' })

    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-017: uploadCover() sends the file as a "cover" form field', async () => {
    useCollectionStore.setState({ activeId: 1 })
    const file = new File(['x'], 'cover.jpg', { type: 'image/jpeg' })

    await store().uploadCover(1, file)

    const [id, fd] = vi.mocked(collectionsApi.uploadCover).mock.calls[0]
    expect(id).toBe(1)
    expect(fd.get('cover')).toBe(file)
    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-017b: uploadCover() skips the detail reload for a non-active list', async () => {
    useCollectionStore.setState({ activeId: 2 })

    await store().uploadCover(1, new File(['x'], 'cover.jpg'))

    expect(collectionsApi.uploadCover).toHaveBeenCalled()
    expect(collectionsApi.list).toHaveBeenCalled()
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-018: deleteCollection() clears the active list before reloading', async () => {
    useCollectionStore.setState({
      activeId: 1,
      places: [buildPlace()],
      members: [{ user_id: 5, username: 'bob', status: 'accepted' }],
      labels: [{ id: 3, collection_id: 1, name: 'Food' }],
      labelFilter: [3],
    })

    await store().deleteCollection(1)

    expect(collectionsApi.remove).toHaveBeenCalledWith(1)
    expect(store().activeId).toBeNull()
    expect(store().places).toEqual([])
    expect(store().members).toEqual([])
    // Labels belong to the deleted list, so they go with it.
    expect(store().labels).toEqual([])
    expect(store().labelFilter).toEqual([])
    expect(collectionsApi.list).toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-019: deleteCollection() leaves another active list untouched', async () => {
    useCollectionStore.setState({ activeId: 2, places: [buildPlace()] })

    await store().deleteCollection(1)

    expect(store().activeId).toBe(2)
    expect(store().places).toHaveLength(1)
  })

  it('FE-STORE-COLLECTION-020: reorderCollections() applies the new order optimistically', async () => {
    useCollectionStore.setState({ collections: [listA, listB] })
    let orderDuringRequest: number[] = []
    vi.mocked(collectionsApi.reorder).mockImplementation(async () => {
      orderDuringRequest = store().collections.map(c => c.id)
      return { success: true }
    })

    await store().reorderCollections([2, 1, 99])

    expect(orderDuringRequest).toEqual([2, 1])
    expect(collectionsApi.reorder).toHaveBeenCalledWith([2, 1, 99])
    // the trailing loadAll re-syncs from the server
    expect(store().collections).toEqual([listA])
  })

  it('FE-STORE-COLLECTION-021: reorderCollections() still reloads when the request fails', async () => {
    useCollectionStore.setState({ collections: [listA, listB] })
    vi.mocked(collectionsApi.reorder).mockRejectedValue(new Error('500'))

    await expect(store().reorderCollections([2, 1])).rejects.toThrow('500')
    expect(collectionsApi.list).toHaveBeenCalled()
  })
})

describe('collectionStore — place mutations', () => {
  it('FE-STORE-COLLECTION-022: setStatus() updates the place optimistically', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] })

    await store().setStatus(10, 'visited')

    expect(collectionsApi.setStatus).toHaveBeenCalledWith(10, 'visited')
    expect(store().places[0].status).toBe('visited')
    expect(store().places[1].status).toBe('want')
  })

  it('FE-STORE-COLLECTION-023: setStatus() re-reads the active list when the call fails', async () => {
    useCollectionStore.setState({ activeId: 1, places: [buildPlace({ id: 10 })] })
    vi.mocked(collectionsApi.setStatus).mockRejectedValue(new Error('500'))
    vi.mocked(collectionsApi.get).mockResolvedValue(detail({ places: [buildPlace({ id: 10, status: 'want' })] }))

    await store().setStatus(10, 'visited')

    expect(collectionsApi.get).toHaveBeenCalledWith(1)
    expect(store().places[0].status).toBe('want')
  })

  it('FE-STORE-COLLECTION-024: updatePlace() swaps in the place returned by the server', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] })
    vi.mocked(collectionsApi.updatePlace).mockResolvedValue(buildPlace({ id: 10, name: 'Shibuya Sky' }))

    await store().updatePlace(10, { name: 'Shibuya Sky' })

    expect(store().places[0].name).toBe('Shibuya Sky')
    expect(store().places[1].name).toBe('Shibuya')
  })

  it('FE-STORE-COLLECTION-025: updatePlace() leaves the list alone when nothing comes back', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 })] })
    vi.mocked(collectionsApi.updatePlace).mockResolvedValue(undefined as unknown as CollectionPlace)

    await store().updatePlace(10, { notes: 'x' })

    expect(store().places).toEqual([buildPlace({ id: 10 })])
  })

  it('FE-STORE-COLLECTION-026: uploadPlaceImage() sends an "image" form field and swaps the place', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] })
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
    vi.mocked(collectionsApi.uploadPlaceImage).mockResolvedValue(buildPlace({ id: 10, image_url: '/uploads/p.jpg' }))

    await store().uploadPlaceImage(10, file)

    const [pid, fd] = vi.mocked(collectionsApi.uploadPlaceImage).mock.calls[0]
    expect(pid).toBe(10)
    expect(fd.get('image')).toBe(file)
    expect(store().places[0].image_url).toBe('/uploads/p.jpg')
    expect(store().places[1].image_url).toBeUndefined()
  })

  it('FE-STORE-COLLECTION-026b: uploadPlaceImage() keeps the list when the server returns nothing', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 })] })
    vi.mocked(collectionsApi.uploadPlaceImage).mockResolvedValue(undefined as unknown as CollectionPlace)

    await store().uploadPlaceImage(10, new File(['x'], 'p.jpg'))

    expect(store().places).toEqual([buildPlace({ id: 10 })])
  })

  it('FE-STORE-COLLECTION-027: ratePlace() swaps in the re-aggregated place', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] })
    vi.mocked(collectionsApi.ratePlace).mockResolvedValue(buildPlace({ id: 10, rating_avg: 4.5, rating_count: 2 }))

    await store().ratePlace(10, 5)

    expect(collectionsApi.ratePlace).toHaveBeenCalledWith(10, 5)
    expect(store().places[0].rating_avg).toBe(4.5)
    expect(store().places[1].rating_avg).toBeUndefined()
  })

  it('FE-STORE-COLLECTION-028: ratePlace() keeps the list when the server returns nothing', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10, rating_avg: 3 })] })
    vi.mocked(collectionsApi.ratePlace).mockResolvedValue(undefined as unknown as CollectionPlace)

    await store().ratePlace(10, null)

    expect(store().places[0].rating_avg).toBe(3)
  })

  it('FE-STORE-COLLECTION-029: deletePlace() drops the place and refreshes the counts', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] })

    await store().deletePlace(10)

    expect(store().places.map(p => p.id)).toEqual([11])
    expect(collectionsApi.deletePlace).toHaveBeenCalledWith(10)
    expect(collectionsApi.list).toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-030: deleteMany() drops all selected places and exits select mode', async () => {
    useCollectionStore.setState({
      places: [buildPlace({ id: 10 }), buildPlace({ id: 11 }), buildPlace({ id: 12 })],
      selectedIds: [10, 11],
      selectMode: true,
    })

    await store().deleteMany([10, 11])

    expect(store().places.map(p => p.id)).toEqual([12])
    expect(store().selectedIds).toEqual([])
    expect(store().selectMode).toBe(false)
    expect(collectionsApi.deleteMany).toHaveBeenCalledWith([10, 11])
  })

  it('FE-STORE-COLLECTION-056: deletePlace() puts the row back when the server refuses', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })] })
    vi.mocked(collectionsApi.deletePlace).mockRejectedValue(new Error('nope'))

    await expect(store().deletePlace(10)).rejects.toThrow('nope')

    expect(store().places.map(p => p.id)).toEqual([10, 11])
    expect(collectionsApi.list).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-057: deleteMany() restores the rows and the selection on failure', async () => {
    useCollectionStore.setState({
      places: [buildPlace({ id: 10 }), buildPlace({ id: 11 })],
      selectedIds: [10],
      selectMode: true,
    })
    vi.mocked(collectionsApi.deleteMany).mockRejectedValue(new Error('nope'))

    await expect(store().deleteMany([10])).rejects.toThrow('nope')

    expect(store().places.map(p => p.id)).toEqual([10, 11])
    expect(store().selectedIds).toEqual([10])
    expect(store().selectMode).toBe(true)
  })

  it('FE-STORE-COLLECTION-031: copyToTrip() forwards the payload and returns the dedup report', async () => {
    vi.mocked(collectionsApi.copyToTrip).mockResolvedValue({ copied: 1, skipped: [{ id: 11, name: 'Shibuya' }] })

    const res = await store().copyToTrip(7, [10, 11], true)

    expect(collectionsApi.copyToTrip).toHaveBeenCalledWith({ trip_id: 7, place_ids: [10, 11], force: true })
    expect(res.copied).toBe(1)
    expect(res.skipped).toEqual([{ id: 11, name: 'Shibuya' }])
  })

  it('FE-STORE-COLLECTION-032: moveToList() re-points each place and reloads the active list', async () => {
    useCollectionStore.setState({
      activeId: 1,
      places: [buildPlace({ id: 10 }), buildPlace({ id: 11 }), buildPlace({ id: 12 })],
      selectedIds: [10, 11],
      selectMode: true,
    })

    await store().moveToList([10, 11], 2)

    expect(collectionsApi.updatePlace).toHaveBeenNthCalledWith(1, 10, { collection_id: 2 })
    expect(collectionsApi.updatePlace).toHaveBeenNthCalledWith(2, 11, { collection_id: 2 })
    expect(store().selectedIds).toEqual([])
    expect(store().selectMode).toBe(false)
    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-033: moveToList() skips the detail reload on the "All saved" pseudo-list', async () => {
    useCollectionStore.setState({ activeId: ALL_SAVED, places: [buildPlace({ id: 10 })] })

    await store().moveToList([10], 2)

    expect(store().places).toEqual([])
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-058: moveToList() only drops the places that actually moved', async () => {
    useCollectionStore.setState({
      activeId: 1,
      places: [buildPlace({ id: 10 }), buildPlace({ id: 11 }), buildPlace({ id: 12 })],
      selectedIds: [10, 11],
      selectMode: true,
    })
    vi.mocked(collectionsApi.get).mockResolvedValue(
      detail({ places: [buildPlace({ id: 11 }), buildPlace({ id: 12 })] }),
    )
    vi.mocked(collectionsApi.updatePlace)
      .mockResolvedValueOnce(buildPlace({ id: 10 }))
      .mockRejectedValueOnce(new Error('nope'))

    await expect(store().moveToList([10, 11], 2)).rejects.toThrow('nope')

    // The list is refreshed either way, so the open list matches the server again.
    expect(collectionsApi.get).toHaveBeenCalledWith(1)
    expect(store().places.map(p => p.id)).toEqual([11, 12])
    expect(store().selectedIds).toEqual([])
  })

  it('FE-STORE-COLLECTION-034: duplicateToList() re-saves each place into the target list', async () => {
    const source = buildPlace({
      id: 10,
      name: 'Shibuya Sky',
      description: 'view',
      lat: 35.6,
      lng: 139.7,
      address: 'Shibuya',
      category_id: 4,
      price: 2000,
      currency: 'JPY',
      notes: 'sunset',
      image_url: '/uploads/p.jpg',
      google_place_id: 'g1',
      google_ftid: 'f1',
      osm_id: 'o1',
      website: 'https://example.com',
      phone: '+81',
      status: 'visited',
      links: [{ url: 'https://example.com' }],
    })
    useCollectionStore.setState({ places: [source], selectedIds: [10], selectMode: true })

    await store().duplicateToList([10], 2)

    expect(collectionsApi.savePlace).toHaveBeenCalledWith({
      collection_id: 2,
      name: 'Shibuya Sky',
      description: 'view',
      lat: 35.6,
      lng: 139.7,
      address: 'Shibuya',
      category_id: 4,
      price: 2000,
      currency: 'JPY',
      notes: 'sunset',
      image_url: '/uploads/p.jpg',
      google_place_id: 'g1',
      google_ftid: 'f1',
      osm_id: 'o1',
      website: 'https://example.com',
      phone: '+81',
      status: 'visited',
      links: [{ url: 'https://example.com' }],
      force: true,
    })
    expect(store().selectedIds).toEqual([])
    expect(store().selectMode).toBe(false)
  })

  it('FE-STORE-COLLECTION-035: duplicateToList() normalises absent fields to null and skips unknown ids', async () => {
    useCollectionStore.setState({ places: [buildPlace({ id: 10 })] })

    await store().duplicateToList([10, 999], 2)

    expect(collectionsApi.savePlace).toHaveBeenCalledTimes(1)
    expect(collectionsApi.savePlace).toHaveBeenCalledWith(
      expect.objectContaining({ collection_id: 2, description: null, lat: null, lng: null, links: [] }),
    )
  })
})

describe('collectionStore — labels', () => {
  it('FE-STORE-COLLECTION-036: createLabel() is ignored without a real active list', async () => {
    useCollectionStore.setState({ activeId: ALL_SAVED })

    await store().createLabel('Food', '#ef4444')

    expect(collectionsApi.createLabel).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-037: createLabel() posts to the active list and reloads it', async () => {
    useCollectionStore.setState({ activeId: 1 })

    await store().createLabel('Food', '#ef4444')

    expect(collectionsApi.createLabel).toHaveBeenCalledWith(1, 'Food', '#ef4444')
    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-038: updateLabel() recolors optimistically before the reload', async () => {
    useCollectionStore.setState({
      activeId: 1,
      labels: [{ id: 3, collection_id: 1, name: 'Food', color: '#ef4444' }],
    })
    let optimistic: string | null | undefined
    vi.mocked(collectionsApi.updateLabel).mockImplementation(async () => {
      optimistic = store().labels[0].color
      return { id: 3, collection_id: 1, name: 'Food', color: '#22c55e' }
    })

    await store().updateLabel(3, { color: '#22c55e' })

    expect(optimistic).toBe('#22c55e')
    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-039: updateLabel() skips the reload outside a real list', async () => {
    useCollectionStore.setState({
      activeId: ALL_SAVED,
      labels: [{ id: 3, collection_id: 1, name: 'Food' }, { id: 4, collection_id: 1, name: 'Museum' }],
    })

    await store().updateLabel(3, { name: 'Eats' })

    expect(store().labels[0].name).toBe('Eats')
    expect(store().labels[1].name).toBe('Museum')
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-040: deleteLabel() drops the label, its filter and its assignments', async () => {
    useCollectionStore.setState({
      activeId: ALL_SAVED,
      labels: [{ id: 3, collection_id: 1, name: 'Food' }, { id: 4, collection_id: 1, name: 'Museum' }],
      labelFilter: [3, 4],
      places: [buildPlace({ id: 10, label_ids: [3, 4] }), buildPlace({ id: 11 })],
    })

    await store().deleteLabel(3)

    expect(store().labels.map(l => l.id)).toEqual([4])
    expect(store().labelFilter).toEqual([4])
    expect(store().places[0].label_ids).toEqual([4])
    expect(store().places[1].label_ids).toEqual([])
    expect(collectionsApi.deleteLabel).toHaveBeenCalledWith(3)
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-040b: deleteLabel() reloads the detail when a real list is open', async () => {
    useCollectionStore.setState({ activeId: 1, labels: [{ id: 3, collection_id: 1, name: 'Food' }] })

    await store().deleteLabel(3)

    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-041: assignLabels() adds the labels to the selected places only', async () => {
    useCollectionStore.setState({
      activeId: 1,
      places: [buildPlace({ id: 10, label_ids: [3] }), buildPlace({ id: 11 }), buildPlace({ id: 12 })],
    })
    // The trailing loadCollection() overwrites places, so read the optimistic
    // state while the request is still in flight.
    let optimistic: CollectionPlace[] = []
    vi.mocked(collectionsApi.assignLabels).mockImplementation(async () => {
      optimistic = store().places
      return { changed: 1 }
    })

    await store().assignLabels([3, 4], [10, 12])

    expect(optimistic[0].label_ids).toEqual([3, 4])
    expect(optimistic[1].label_ids).toBeUndefined()
    // a place with no labels yet starts from an empty set
    expect(optimistic[2].label_ids).toEqual([3, 4])
    expect(collectionsApi.assignLabels).toHaveBeenCalledWith([3, 4], [10, 12])
    expect(collectionsApi.unassignLabels).not.toHaveBeenCalled()
    expect(collectionsApi.get).toHaveBeenCalledWith(1)
  })

  it('FE-STORE-COLLECTION-042: assignLabels(remove) strips the labels and hits the unassign endpoint', async () => {
    useCollectionStore.setState({
      activeId: ALL_SAVED,
      places: [buildPlace({ id: 10, label_ids: [3, 4] })],
    })

    await store().assignLabels([3], [10], true)

    expect(store().places[0].label_ids).toEqual([4])
    expect(collectionsApi.unassignLabels).toHaveBeenCalledWith([3], [10])
    expect(collectionsApi.assignLabels).not.toHaveBeenCalled()
  })
  it('FE-STORE-COLLECTION-059: updateLabel() undoes the recolor when the server refuses', async () => {
    useCollectionStore.setState({ activeId: 1, labels: [{ id: 3, collection_id: 1, name: 'Food', color: '#ef4444' }] })
    vi.mocked(collectionsApi.updateLabel).mockRejectedValue(new Error('nope'))

    await expect(store().updateLabel(3, { color: '#22c55e' })).rejects.toThrow('nope')

    expect(store().labels[0]!.color).toBe('#ef4444')
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-060: deleteLabel() restores the label, its filter and its assignments', async () => {
    useCollectionStore.setState({
      activeId: 1,
      labels: [{ id: 3, collection_id: 1, name: 'Food' }],
      labelFilter: [3],
      places: [buildPlace({ id: 10, label_ids: [3] })],
    })
    vi.mocked(collectionsApi.deleteLabel).mockRejectedValue(new Error('nope'))

    await expect(store().deleteLabel(3)).rejects.toThrow('nope')

    expect(store().labels.map(l => l.id)).toEqual([3])
    expect(store().labelFilter).toEqual([3])
    expect(store().places[0]!.label_ids).toEqual([3])
  })

  it('FE-STORE-COLLECTION-061: assignLabels() rolls the chips back on failure', async () => {
    useCollectionStore.setState({ activeId: 1, places: [buildPlace({ id: 10, label_ids: [] })] })
    vi.mocked(collectionsApi.assignLabels).mockRejectedValue(new Error('nope'))

    await expect(store().assignLabels([3], [10])).rejects.toThrow('nope')

    expect(store().places[0]!.label_ids).toEqual([])
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

})

describe('collectionStore — members and invitations', () => {
  it('FE-STORE-COLLECTION-043: invite() reloads the detail only for the active list', async () => {
    useCollectionStore.setState({ activeId: 1 })

    await store().invite(1, 5, 'editor')
    expect(collectionsApi.invite).toHaveBeenCalledWith(1, 5, 'editor')
    expect(collectionsApi.get).toHaveBeenCalledWith(1)

    vi.mocked(collectionsApi.get).mockClear()
    await store().invite(2, 6)
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-044: setMemberRole() reloads the detail only for the active list', async () => {
    useCollectionStore.setState({ activeId: 1 })

    await store().setMemberRole(1, 5, 'admin')
    expect(collectionsApi.setMemberRole).toHaveBeenCalledWith(1, 5, 'admin')
    expect(collectionsApi.get).toHaveBeenCalledWith(1)

    vi.mocked(collectionsApi.get).mockClear()
    await store().setMemberRole(2, 5, 'viewer')
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-045: acceptInvite() reloads the lists', async () => {
    vi.mocked(collectionsApi.list).mockResolvedValue(listResponse({ collections: [listA, listB] }))

    await store().acceptInvite(2)

    expect(collectionsApi.acceptInvite).toHaveBeenCalledWith(2)
    expect(store().collections).toHaveLength(2)
  })

  it('FE-STORE-COLLECTION-046: declineInvite() reloads the lists', async () => {
    useCollectionStore.setState({
      incomingInvites: [{ collection_id: 9, name: 'Osaka', from: { id: 4, username: 'bob' } }],
    })

    await store().declineInvite(9)

    expect(collectionsApi.declineInvite).toHaveBeenCalledWith(9)
    expect(store().incomingInvites).toEqual([])
  })

  it('FE-STORE-COLLECTION-047: cancelInvite() reloads the detail only for the active list', async () => {
    useCollectionStore.setState({ activeId: 1 })

    await store().cancelInvite(1, 5)
    expect(collectionsApi.cancelInvite).toHaveBeenCalledWith(1, 5)
    expect(collectionsApi.get).toHaveBeenCalledWith(1)

    vi.mocked(collectionsApi.get).mockClear()
    await store().cancelInvite(2, 5)
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-048: removeMember() reloads the detail only for the active list', async () => {
    useCollectionStore.setState({ activeId: 1 })

    await store().removeMember(1, 5)
    expect(collectionsApi.removeMember).toHaveBeenCalledWith(1, 5)
    expect(collectionsApi.get).toHaveBeenCalledWith(1)

    vi.mocked(collectionsApi.get).mockClear()
    await store().removeMember(2, 5)
    expect(collectionsApi.get).not.toHaveBeenCalled()
  })

  it('FE-STORE-COLLECTION-049: leave() clears the list when it was the active one', async () => {
    useCollectionStore.setState({
      activeId: 1,
      places: [buildPlace()],
      members: [{ user_id: 5, username: 'bob', status: 'accepted' }],
      labels: [{ id: 3, collection_id: 1, name: 'Food' }],
      labelFilter: [3],
    })
    vi.mocked(collectionsApi.list).mockResolvedValue(listResponse({ collections: [] }))

    await store().leave(1)

    expect(collectionsApi.leave).toHaveBeenCalledWith(1)
    expect(store().activeId).toBeNull()
    expect(store().places).toEqual([])
    expect(store().members).toEqual([])
    // Labels belong to the list we just left.
    expect(store().labels).toEqual([])
    expect(store().labelFilter).toEqual([])
    expect(store().collections).toEqual([])
  })

  it('FE-STORE-COLLECTION-050: leave() keeps a different active list open', async () => {
    useCollectionStore.setState({ activeId: 2, places: [buildPlace()] })

    await store().leave(1)

    expect(store().activeId).toBe(2)
    expect(store().places).toHaveLength(1)
  })
})

describe('collectionStore — view state', () => {
  it('FE-STORE-COLLECTION-051: the view, sort and search setters write straight through', () => {
    store().setView('map')
    store().setSortMode('name_asc')
    store().setSearch('shibuya')
    store().setSelectedPlaceId(10)

    expect(store().view).toBe('map')
    expect(store().sortMode).toBe('name_asc')
    expect(store().search).toBe('shibuya')
    expect(store().selectedPlaceId).toBe(10)
  })

  it('FE-STORE-COLLECTION-052: the filter setters write straight through', () => {
    store().setStatusFilter('visited')
    store().setCategoryFilter(4)
    store().setRatingFilter(3)
    store().setLabelFilter([3, 4])

    expect(store().statusFilter).toBe('visited')
    expect(store().categoryFilter).toBe(4)
    expect(store().ratingFilter).toBe(3)
    expect(store().labelFilter).toEqual([3, 4])
  })

  it('FE-STORE-COLLECTION-053: setSelectMode(false) also drops the current selection', () => {
    useCollectionStore.setState({ selectedIds: [10, 11] })

    store().setSelectMode(true)
    expect(store().selectMode).toBe(true)
    expect(store().selectedIds).toEqual([10, 11])

    store().setSelectMode(false)
    expect(store().selectMode).toBe(false)
    expect(store().selectedIds).toEqual([])
  })

  it('FE-STORE-COLLECTION-054: toggleSelect() adds an unselected id and removes a selected one', () => {
    store().toggleSelect(10)
    store().toggleSelect(11)
    expect(store().selectedIds).toEqual([10, 11])

    store().toggleSelect(10)
    expect(store().selectedIds).toEqual([11])
  })

  it('FE-STORE-COLLECTION-055: setSelectedIds() replaces and clearSelection() resets select mode', () => {
    useCollectionStore.setState({ selectMode: true })

    store().setSelectedIds([10, 11, 12])
    expect(store().selectedIds).toEqual([10, 11, 12])

    store().clearSelection()
    expect(store().selectedIds).toEqual([])
    expect(store().selectMode).toBe(false)
  })
})
