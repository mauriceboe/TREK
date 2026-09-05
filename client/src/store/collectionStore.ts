import { create } from 'zustand'
import { collectionsApi } from '../api/collections'
import type {
  Collection,
  CollectionPlace,
  CollectionMember,
  CollectionStatus,
  CollectionRole,
  CollectionListResponse,
  CollectionCreateRequest,
  CollectionUpdateRequest,
  CollectionPlaceUpdateRequest,
  CollectionLabel,
  CollectionLabelUpdateRequest,
} from '@trek/shared'

/** A pending invitation the current user has received (derived server-side). */
export type IncomingCollectionInvite = CollectionListResponse['incomingInvites'][number]

/** Sentinel id for the client-side "All saved" union pseudo-list. */
export const ALL_SAVED = 'all' as const
export type ActiveCollectionId = number | typeof ALL_SAVED | null

export type CollectionView = 'list' | 'map'
export type StatusFilter = CollectionStatus | 'all'
/** Display order for a list's places: the saved order, or alphabetical by name. */
export type CollectionSortMode = 'default' | 'name_asc'

interface CollectionState {
  collections: Collection[]
  activeId: ActiveCollectionId
  places: CollectionPlace[]
  members: CollectionMember[]
  labels: CollectionLabel[]
  incomingInvites: IncomingCollectionInvite[]
  view: CollectionView
  statusFilter: StatusFilter
  categoryFilter: number | 'all'
  ratingFilter: number | 'all'
  labelFilter: number[]
  sortMode: CollectionSortMode
  search: string
  selectedPlaceId: number | null
  selectMode: boolean
  selectedIds: number[]
  loading: boolean
  placesLoading: boolean

  loadAll: () => Promise<void>
  loadCollection: (id: number) => Promise<void>
  setActive: (id: ActiveCollectionId) => Promise<void>
  refreshActive: () => Promise<void>

  createCollection: (payload: CollectionCreateRequest) => Promise<Collection | null>
  updateCollection: (id: number, updates: CollectionUpdateRequest) => Promise<void>
  uploadCover: (id: number, file: File) => Promise<void>
  deleteCollection: (id: number) => Promise<void>
  reorderCollections: (orderedIds: number[]) => Promise<void>

  setStatus: (placeId: number, status: CollectionStatus) => Promise<void>
  updatePlace: (placeId: number, body: CollectionPlaceUpdateRequest) => Promise<void>
  uploadPlaceImage: (placeId: number, file: File) => Promise<void>
  ratePlace: (placeId: number, rating: number | null) => Promise<void>
  deletePlace: (placeId: number) => Promise<void>
  deleteMany: (ids: number[]) => Promise<void>
  copyToTrip: (tripId: number, placeIds: number[], force?: boolean) => Promise<{ copied: number; skipped: { id: number; name: string }[] }>
  moveToList: (placeIds: number[], targetId: number) => Promise<void>
  duplicateToList: (placeIds: number[], targetId: number) => Promise<void>

  createLabel: (name: string, color?: string) => Promise<void>
  updateLabel: (labelId: number, body: CollectionLabelUpdateRequest) => Promise<void>
  deleteLabel: (labelId: number) => Promise<void>
  assignLabels: (labelIds: number[], placeIds: number[], remove?: boolean) => Promise<void>

  invite: (collectionId: number, userId: number, role?: CollectionRole) => Promise<void>
  setMemberRole: (collectionId: number, userId: number, role: CollectionRole) => Promise<void>
  acceptInvite: (collectionId: number) => Promise<void>
  declineInvite: (collectionId: number) => Promise<void>
  cancelInvite: (collectionId: number, userId: number) => Promise<void>
  removeMember: (collectionId: number, userId: number) => Promise<void>
  leave: (collectionId: number) => Promise<void>

  setView: (view: CollectionView) => void
  setStatusFilter: (filter: StatusFilter) => void
  setCategoryFilter: (filter: number | 'all') => void
  setRatingFilter: (filter: number | 'all') => void
  setLabelFilter: (labelIds: number[]) => void
  setSortMode: (mode: CollectionSortMode) => void
  setSearch: (search: string) => void
  setSelectedPlaceId: (id: number | null) => void
  setSelectMode: (on: boolean) => void
  toggleSelect: (id: number) => void
  setSelectedIds: (ids: number[]) => void
  clearSelection: () => void
}

/**
 * Load whatever `id` points at (a list, the "All saved" union, or nothing) into
 * the store. Split out of setActive() because switching lists also has to drop
 * the per-list UI state, while re-reading the list that is already open must not
 * (#1921: every add from the still-open add-place dialog runs a refresh).
 */
async function loadActive(
  set: (partial: Partial<CollectionState>) => void,
  get: () => CollectionState,
  id: ActiveCollectionId,
): Promise<void> {
  if (id === null) {
    set({ activeId: null, places: [], members: [], labels: [] })
    return
  }
  if (id === ALL_SAVED) {
    set({ activeId: ALL_SAVED, members: [], labels: [], placesLoading: true })
    try {
      // Client-side union of every list the user owns or co-owns (no server change).
      // On first load the lists may not be fetched yet (loadAll still in flight),
      // which would union nothing — make sure they're loaded first.
      let lists = get().collections
      if (lists.length === 0) { await get().loadAll(); lists = get().collections }
      const results = await Promise.all(lists.map(l => collectionsApi.get(l.id).catch(() => null)))
      const seen = new Set<number>()
      const merged: CollectionPlace[] = []
      for (const res of results) {
        if (!res) continue
        for (const p of res.places) {
          if (seen.has(p.id)) continue
          seen.add(p.id)
          merged.push(p)
        }
      }
      set({ places: merged })
    } finally {
      set({ placesLoading: false })
    }
    return
  }
  await get().loadCollection(id)
}

export const useCollectionStore = create<CollectionState>((set, get) => ({
  collections: [],
  activeId: null,
  places: [],
  members: [],
  labels: [],
  incomingInvites: [],
  view: 'list',
  statusFilter: 'all',
  categoryFilter: 'all',
  ratingFilter: 'all',
  labelFilter: [],
  sortMode: 'default',
  search: '',
  selectedPlaceId: null,
  selectMode: false,
  selectedIds: [],
  loading: false,
  placesLoading: false,

  loadAll: async () => {
    set({ loading: true })
    try {
      const data = await collectionsApi.list()
      set({ collections: data.collections, incomingInvites: data.incomingInvites })
    } finally {
      set({ loading: false })
    }
  },

  loadCollection: async (id: number) => {
    set({ placesLoading: true })
    try {
      const data = await collectionsApi.get(id)
      set({
        activeId: id,
        places: data.places,
        members: data.collection.members ?? [],
        labels: data.collection.labels ?? [],
      })
    } catch {
      // The list may have been left / removed / deleted out from under us (a WS
      // event or the URL sync can re-request an id we just lost access to). Clear
      // it instead of leaving an uncaught 403/404 rejection; the route sync then
      // bounces to /collections.
      if (get().activeId === id) set({ activeId: null, places: [], members: [], labels: [] })
    } finally {
      set({ placesLoading: false })
    }
  },

  setActive: async (id: ActiveCollectionId) => {
    // Labels are per-collection, so their filter can't carry across lists.
    set({ selectMode: false, selectedIds: [], selectedPlaceId: null, labelFilter: [] })
    await loadActive(set, get, id)
  },

  refreshActive: async () => {
    const { activeId } = get()
    if (activeId === null) return
    // Same list, so select mode, the selection and the label filter stay put.
    await loadActive(set, get, activeId)
    // Only what the reload no longer contains can't stay selected.
    const ids = new Set(get().places.map(p => p.id))
    const { selectedIds, selectedPlaceId } = get()
    const kept = selectedIds.filter(id => ids.has(id))
    const keptPlaceId = selectedPlaceId != null && ids.has(selectedPlaceId) ? selectedPlaceId : null
    if (kept.length !== selectedIds.length || keptPlaceId !== selectedPlaceId) {
      set({ selectedIds: kept, selectedPlaceId: keptPlaceId })
    }
  },

  createCollection: async (payload) => {
    // POST answers with the collection itself. Reading `.collection` off it
    // returned undefined every time, so the caller never got the new id: a cover
    // picked while creating a list was dropped and the list never opened.
    const created = await collectionsApi.create(payload)
    await get().loadAll()
    return created ?? null
  },

  updateCollection: async (id, updates) => {
    await collectionsApi.update(id, updates)
    await get().loadAll()
    if (get().activeId === id) await get().loadCollection(id)
  },

  uploadCover: async (id: number, file: File) => {
    const fd = new FormData()
    fd.append('cover', file)
    await collectionsApi.uploadCover(id, fd)
    await get().loadAll()
    if (get().activeId === id) await get().loadCollection(id)
  },

  deleteCollection: async (id: number) => {
    await collectionsApi.remove(id)
    // Labels are per-list, so they have to go with the list they belonged to.
    if (get().activeId === id) set({ activeId: null, places: [], members: [], labels: [], labelFilter: [] })
    await get().loadAll()
  },

  reorderCollections: async (orderedIds: number[]) => {
    // optimistic
    const byId = new Map(get().collections.map(c => [c.id, c]))
    const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean) as Collection[]
    set({ collections: reordered })
    try {
      await collectionsApi.reorder(orderedIds)
    } finally {
      await get().loadAll()
    }
  },

  setStatus: async (placeId: number, status: CollectionStatus) => {
    // optimistic
    set({ places: get().places.map(p => (p.id === placeId ? { ...p, status } : p)) })
    try {
      await collectionsApi.setStatus(placeId, status)
    } catch {
      await get().refreshActive()
    }
  },

  updatePlace: async (placeId, body) => {
    // The endpoint returns the updated place directly (not wrapped in { place }).
    const updated = await collectionsApi.updatePlace(placeId, body)
    if (updated) set({ places: get().places.map(p => (p.id === placeId ? updated : p)) })
  },

  uploadPlaceImage: async (placeId: number, file: File) => {
    const fd = new FormData()
    fd.append('image', file)
    const updated = await collectionsApi.uploadPlaceImage(placeId, fd)
    if (updated) set({ places: get().places.map(p => (p.id === placeId ? updated : p)) })
  },

  ratePlace: async (placeId: number, rating: number | null) => {
    const updated = await collectionsApi.ratePlace(placeId, rating)
    if (updated) set({ places: get().places.map(p => (p.id === placeId ? updated : p)) })
  },

  deletePlace: async (placeId: number) => {
    // optimistic; put the row back if the server refuses, then let the caller toast
    const prev = get().places
    set({ places: prev.filter(p => p.id !== placeId) })
    try {
      await collectionsApi.deletePlace(placeId)
    } catch (err) {
      set({ places: prev })
      throw err
    }
    await get().loadAll()
  },

  deleteMany: async (ids: number[]) => {
    const idSet = new Set(ids)
    const prev = get().places
    const prevSelected = get().selectedIds
    const prevSelectMode = get().selectMode
    set({ places: prev.filter(p => !idSet.has(p.id)), selectedIds: [], selectMode: false })
    try {
      await collectionsApi.deleteMany(ids)
    } catch (err) {
      set({ places: prev, selectedIds: prevSelected, selectMode: prevSelectMode })
      throw err
    }
    await get().loadAll()
  },

  copyToTrip: async (tripId: number, placeIds: number[], force?: boolean) => {
    const res = await collectionsApi.copyToTrip({ trip_id: tripId, place_ids: placeIds, force })
    return res
  },

  // Move the selected places into another list (re-point collection_id). They
  // leave the current list, so drop them locally + refresh.
  moveToList: async (placeIds: number[], targetId: number) => {
    // The fan-out can fail halfway through, so drop only the places that really
    // moved and refresh either way — otherwise the open list keeps showing rows
    // that already belong to the target.
    const moved: number[] = []
    let failure: unknown = null
    for (const id of placeIds) {
      try {
        await collectionsApi.updatePlace(id, { collection_id: targetId })
        moved.push(id)
      } catch (err) {
        failure = err
        break
      }
    }
    const idSet = new Set(moved)
    set({ places: get().places.filter(p => !idSet.has(p.id)), selectedIds: [], selectMode: false })
    await get().loadAll()
    const active = get().activeId
    if (typeof active === 'number') await get().loadCollection(active)
    if (failure) throw failure
  },

  // Duplicate the selected places into another list (re-save each place's data).
  duplicateToList: async (placeIds: number[], targetId: number) => {
    const byId = new Map(get().places.map(p => [p.id, p]))
    for (const id of placeIds) {
      const p = byId.get(id)
      if (!p) continue
      await collectionsApi.savePlace({
        collection_id: targetId,
        name: p.name,
        description: p.description ?? null,
        lat: p.lat ?? null,
        lng: p.lng ?? null,
        address: p.address ?? null,
        category_id: p.category_id ?? null,
        price: p.price ?? null,
        currency: p.currency ?? null,
        notes: p.notes ?? null,
        image_url: p.image_url ?? null,
        google_place_id: p.google_place_id ?? null,
        google_ftid: p.google_ftid ?? null,
        osm_id: p.osm_id ?? null,
        website: p.website ?? null,
        phone: p.phone ?? null,
        status: p.status,
        links: p.links ?? [],
        force: true,
      })
    }
    set({ selectedIds: [], selectMode: false })
    await get().loadAll()
  },

  createLabel: async (name: string, color?: string) => {
    const active = get().activeId
    if (typeof active !== 'number') return
    await collectionsApi.createLabel(active, name, color)
    await get().loadCollection(active)
  },

  updateLabel: async (labelId: number, body: CollectionLabelUpdateRequest) => {
    // optimistic recolor/rename
    const prevLabels = get().labels
    set({ labels: prevLabels.map(l => (l.id === labelId ? { ...l, ...body } : l)) })
    try {
      await collectionsApi.updateLabel(labelId, body)
    } catch (err) {
      set({ labels: prevLabels })
      throw err
    }
    const active = get().activeId
    if (typeof active === 'number') await get().loadCollection(active)
  },

  deleteLabel: async (labelId: number) => {
    // optimistic: drop the label + its assignments + any active filter on it
    const prev = { labels: get().labels, labelFilter: get().labelFilter, places: get().places }
    set({
      labels: prev.labels.filter(l => l.id !== labelId),
      labelFilter: prev.labelFilter.filter(id => id !== labelId),
      places: prev.places.map(p => ({ ...p, label_ids: (p.label_ids ?? []).filter(id => id !== labelId) })),
    })
    try {
      await collectionsApi.deleteLabel(labelId)
    } catch (err) {
      set(prev)
      throw err
    }
    const active = get().activeId
    if (typeof active === 'number') await get().loadCollection(active)
  },

  assignLabels: async (labelIds: number[], placeIds: number[], remove = false) => {
    const idSet = new Set(placeIds)
    // optimistic per-place label_ids update
    const prevPlaces = get().places
    set({
      places: prevPlaces.map(p => {
        if (!idSet.has(p.id)) return p
        const current = new Set(p.label_ids ?? [])
        if (remove) labelIds.forEach(id => current.delete(id))
        else labelIds.forEach(id => current.add(id))
        return { ...p, label_ids: [...current] }
      }),
    })
    try {
      if (remove) await collectionsApi.unassignLabels(labelIds, placeIds)
      else await collectionsApi.assignLabels(labelIds, placeIds)
    } catch (err) {
      set({ places: prevPlaces })
      throw err
    }
    const active = get().activeId
    if (typeof active === 'number') await get().loadCollection(active)
  },

  invite: async (collectionId: number, userId: number, role?: CollectionRole) => {
    await collectionsApi.invite(collectionId, userId, role)
    if (get().activeId === collectionId) await get().loadCollection(collectionId)
  },

  setMemberRole: async (collectionId: number, userId: number, role: CollectionRole) => {
    await collectionsApi.setMemberRole(collectionId, userId, role)
    if (get().activeId === collectionId) await get().loadCollection(collectionId)
  },

  acceptInvite: async (collectionId: number) => {
    await collectionsApi.acceptInvite(collectionId)
    await get().loadAll()
  },

  declineInvite: async (collectionId: number) => {
    await collectionsApi.declineInvite(collectionId)
    await get().loadAll()
  },

  cancelInvite: async (collectionId: number, userId: number) => {
    await collectionsApi.cancelInvite(collectionId, userId)
    if (get().activeId === collectionId) await get().loadCollection(collectionId)
  },

  removeMember: async (collectionId: number, userId: number) => {
    await collectionsApi.removeMember(collectionId, userId)
    if (get().activeId === collectionId) await get().loadCollection(collectionId)
  },

  leave: async (collectionId: number) => {
    await collectionsApi.leave(collectionId)
    // Labels are per-list, so they have to go with the list we just left.
    if (get().activeId === collectionId) set({ activeId: null, places: [], members: [], labels: [], labelFilter: [] })
    await get().loadAll()
  },

  setView: (view: CollectionView) => set({ view }),
  setStatusFilter: (filter: StatusFilter) => set({ statusFilter: filter }),
  setCategoryFilter: (filter: number | 'all') => set({ categoryFilter: filter }),
  setRatingFilter: (filter: number | 'all') => set({ ratingFilter: filter }),
  setLabelFilter: (labelIds: number[]) => set({ labelFilter: labelIds }),
  setSortMode: (mode: CollectionSortMode) => set({ sortMode: mode }),
  setSearch: (search: string) => set({ search }),
  setSelectedPlaceId: (id: number | null) => set({ selectedPlaceId: id }),
  setSelectMode: (on: boolean) => set({ selectMode: on, selectedIds: on ? get().selectedIds : [] }),
  toggleSelect: (id: number) => {
    const selected = get().selectedIds
    set({ selectedIds: selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id] })
  },
  setSelectedIds: (ids: number[]) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [], selectMode: false }),
}))
