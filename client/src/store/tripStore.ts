import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { tripsApi, daysApi, placesApi, packingApi, tagsApi, categoriesApi } from '../api/client'
import { convexUpdateTrip, convexCreateTag, convexCreateCategory } from '../convex/mutationClient'
import { isConvexConfigured } from '../convex/config'
import { createPlacesSlice } from './slices/placesSlice'
import { createAssignmentsSlice } from './slices/assignmentsSlice'
import { createDayNotesSlice } from './slices/dayNotesSlice'
import { createPackingSlice } from './slices/packingSlice'
import { createBudgetSlice } from './slices/budgetSlice'
import { createReservationsSlice } from './slices/reservationsSlice'
import { createFilesSlice } from './slices/filesSlice'
import { createLegsSlice } from './slices/legsSlice'
import { handleRemoteEvent } from './slices/remoteEventHandler'
import type {
  Trip, Day, Place, Assignment, DayNote, PackingItem,
  Tag, Category, BudgetItem, TripFile, Reservation, TripLeg,
  AssignmentsMap, DayNotesMap, WebSocketEvent,
} from '../types'
import { getApiErrorMessage } from '../types'
import type { PlacesSlice } from './slices/placesSlice'
import type { AssignmentsSlice } from './slices/assignmentsSlice'
import type { DayNotesSlice } from './slices/dayNotesSlice'
import type { PackingSlice } from './slices/packingSlice'
import type { BudgetSlice } from './slices/budgetSlice'
import type { ReservationsSlice } from './slices/reservationsSlice'
import type { FilesSlice } from './slices/filesSlice'
import type { LegsSlice } from './slices/legsSlice'

export interface TripStoreState
  extends PlacesSlice,
    AssignmentsSlice,
    DayNotesSlice,
    PackingSlice,
    BudgetSlice,
    ReservationsSlice,
    FilesSlice,
    LegsSlice {
  trip: Trip | null
  days: Day[]
  places: Place[]
  assignments: AssignmentsMap
  dayNotes: DayNotesMap
  packingItems: PackingItem[]
  tags: Tag[]
  categories: Category[]
  budgetItems: BudgetItem[]
  files: TripFile[]
  reservations: Reservation[]
  legs: TripLeg[]
  tripBackend: 'legacy' | 'convex' | null
  selectedDayId: number | string | null
  isLoading: boolean
  error: string | null

  setSelectedDay: (dayId: number | string | null) => void
  handleRemoteEvent: (event: WebSocketEvent) => void
  loadTrip: (tripId: number | string, options?: { forceLegacy?: boolean }) => Promise<void>
  refreshDays: (tripId: number | string) => Promise<void>
  updateTrip: (tripId: number | string, data: Partial<Trip>) => Promise<Trip>
  addTag: (data: Partial<Tag>) => Promise<Tag>
  addCategory: (data: Partial<Category>) => Promise<Category>
}

export const useTripStore = create<TripStoreState>((set, get) => ({
  trip: null,
  days: [],
  places: [],
  assignments: {},
  dayNotes: {},
  packingItems: [],
  tags: [],
  categories: [],
  budgetItems: [],
  files: [],
  reservations: [],
  legs: [],
  tripBackend: null,
  selectedDayId: null,
  isLoading: false,
  error: null,

  setSelectedDay: (dayId: number | string | null) => set({ selectedDayId: dayId }),

  handleRemoteEvent: (event: WebSocketEvent) => handleRemoteEvent(set, event),

  loadTrip: async (tripId: number | string, options?: { forceLegacy?: boolean }) => {
    const useConvex = isConvexConfigured() && !options?.forceLegacy
    set({
      trip: null,
      days: [],
      places: [],
      assignments: {},
      dayNotes: {},
      packingItems: [],
      tags: [],
      categories: [],
      budgetItems: [],
      files: [],
      reservations: [],
      legs: [],
      selectedDayId: null,
      tripBackend: useConvex ? 'convex' : 'legacy',
      isLoading: true,
      error: null,
    })

    if (useConvex) {
      // With Convex, the bridge hook (useConvexTripData) handles loading
      // trip, days, places, assignments, dayNotes, tags, categories, legs.
      // We still need to load packing from Express (not yet migrated).
      try {
        const packingData = await packingApi.list(tripId)
        set({ packingItems: packingData.items })
      } catch {
        // Packing may not be available yet
      }
      return
    }

    // Legacy Express path
    try {
      const [tripData, daysData, placesData, packingData, tagsData, categoriesData, legsData] = await Promise.all([
        tripsApi.get(tripId),
        daysApi.list(tripId),
        placesApi.list(tripId),
        packingApi.list(tripId),
        tagsApi.list(),
        categoriesApi.list(),
        tripsApi.getLegs(tripId),
      ])

      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }

      set({
        trip: tripData.trip,
        days: daysData.days,
        places: placesData.places,
        assignments: assignmentsMap,
        dayNotes: dayNotesMap,
        packingItems: packingData.items,
        tags: tagsData.tags,
        categories: categoriesData.categories,
        legs: legsData.legs || [],
        isLoading: false,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      set({ isLoading: false, error: message })
      throw err
    }
  },

  refreshDays: async (tripId: number | string) => {
    // With Convex, the bridge hook handles reactive refreshes
    if (get().tripBackend === 'convex') return
    try {
      const daysData = await daysApi.list(tripId)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
    } catch (err: unknown) {
      console.error('Failed to refresh days:', err)
    }
  },

  updateTrip: async (tripId: number | string, data: Partial<Trip>) => {
    if (get().tripBackend === 'convex') {
      const result = await convexUpdateTrip(tripId as any, data as any)
      // Convex reactivity will update the store via the bridge hook
      return result as any as Trip
    }
    try {
      const result = await tripsApi.update(tripId, data)
      set({ trip: result.trip, ...(result.legs ? { legs: result.legs } : {}) })
      const daysData = await daysApi.list(tripId)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
      return result.trip
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating trip'))
    }
  },

  addTag: async (data: Partial<Tag>) => {
    if (get().tripBackend === 'convex') {
      const result = await convexCreateTag(data as any)
      return result as any as Tag
    }
    try {
      const result = await tagsApi.create(data)
      set((state) => ({ tags: [...state.tags, result.tag] }))
      return result.tag
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error creating tag'))
    }
  },

  addCategory: async (data: Partial<Category>) => {
    if (get().tripBackend === 'convex') {
      const result = await convexCreateCategory(data as any)
      return result as any as Category
    }
    try {
      const result = await categoriesApi.create(data)
      set((state) => ({ categories: [...state.categories, result.category] }))
      return result.category
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error creating category'))
    }
  },

  ...createPlacesSlice(set, get),
  ...createAssignmentsSlice(set, get),
  ...createDayNotesSlice(set, get),
  ...createPackingSlice(set, get),
  ...createBudgetSlice(set, get),
  ...createReservationsSlice(set, get),
  ...createFilesSlice(set, get),
  ...createLegsSlice(set, get),
}))
