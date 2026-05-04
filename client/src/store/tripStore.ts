import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { tagsApi, categoriesApi } from '../api/client'
import { offlineDb, upsertTags, upsertCategories } from '../db/offlineDb'
import { tripRepo } from '../repo/tripRepo'
import { dayRepo } from '../repo/dayRepo'
import { placeRepo } from '../repo/placeRepo'
import { packingRepo } from '../repo/packingRepo'
import { todoRepo } from '../repo/todoRepo'
import { createPlacesSlice } from './slices/placesSlice'
import { createAssignmentsSlice } from './slices/assignmentsSlice'
import { createDayNotesSlice } from './slices/dayNotesSlice'
import { createPackingSlice } from './slices/packingSlice'
import { createTodoSlice } from './slices/todoSlice'
import { createBudgetSlice } from './slices/budgetSlice'
import { createReservationsSlice } from './slices/reservationsSlice'
import { createFilesSlice } from './slices/filesSlice'
import { handleRemoteEvent } from './slices/remoteEventHandler'
import type {
  Trip, Day, Place, Assignment, DayNote, PackingItem, TodoItem,
  Tag, Category, BudgetItem, TripFile, Reservation,
  AssignmentsMap, DayNotesMap, WebSocketEvent,
} from '../types'
import { getApiErrorMessage } from '../types'
import type { PlacesSlice } from './slices/placesSlice'
import type { AssignmentsSlice } from './slices/assignmentsSlice'
import type { DayNotesSlice } from './slices/dayNotesSlice'
import type { PackingSlice } from './slices/packingSlice'
import type { TodoSlice } from './slices/todoSlice'
import type { BudgetSlice } from './slices/budgetSlice'
import type { ReservationsSlice } from './slices/reservationsSlice'
import type { FilesSlice } from './slices/filesSlice'

export interface TripStoreState
  extends PlacesSlice,
    AssignmentsSlice,
    DayNotesSlice,
    PackingSlice,
    TodoSlice,
    BudgetSlice,
    ReservationsSlice,
    FilesSlice {
  trip: Trip | null
  days: Day[]
  places: Place[]
  assignments: AssignmentsMap
  dayNotes: DayNotesMap
  packingItems: PackingItem[]
  todoItems: TodoItem[]
  tags: Tag[]
  categories: Category[]
  budgetItems: BudgetItem[]
  files: TripFile[]
  reservations: Reservation[]
  selectedDayId: number | null
  isLoading: boolean
  error: string | null

  setSelectedDay: (dayId: number | null) => void
  handleRemoteEvent: (event: WebSocketEvent) => void
  loadTrip: (tripId: number | string) => Promise<void>
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
  todoItems: [],
  tags: [],
  categories: [],
  budgetItems: [],
  files: [],
  reservations: [],
  selectedDayId: null,
  isLoading: false,
  error: null,

  setSelectedDay: (dayId: number | null) => set({ selectedDayId: dayId }),

  handleRemoteEvent: (event: WebSocketEvent) => handleRemoteEvent(set, get, event),

  loadTrip: async (tripId: number | string) => {
    set({ isLoading: true, error: null })
    try {
      // Fire tags/categories network refresh immediately — they're global (not trip-specific)
      // and must be in-flight before the await below so MSW resolves them during the wait
      const tagsRefresh = tagsApi.list()
        .then(fresh => { upsertTags(fresh.tags).catch(() => {}); return fresh })
        .catch(() => null)
      const categoriesRefresh = categoriesApi.list()
        .then(fresh => { upsertCategories(fresh.categories).catch(() => {}); return fresh })
        .catch(() => null)

      // All reads from IndexedDB — instant, no network wait
      const [tripData, daysData, placesData, packingData, todoData, cachedTags, cachedCategories] = await Promise.all([
        tripRepo.get(tripId),
        dayRepo.list(tripId),
        placeRepo.list(tripId),
        packingRepo.list(tripId),
        todoRepo.list(tripId),
        offlineDb.tags.toArray(),
        offlineDb.categories.toArray(),
      ])

      const buildMaps = (days: Day[]) => {
        const assignmentsMap: AssignmentsMap = {}
        const dayNotesMap: DayNotesMap = {}
        for (const day of days) {
          assignmentsMap[String(day.id)] = day.assignments || []
          dayNotesMap[String(day.id)] = day.notes_items || []
        }
        return { assignmentsMap, dayNotesMap }
      }

      const { assignmentsMap, dayNotesMap } = buildMaps(daysData.days)

      set({
        trip: tripData.trip,
        days: daysData.days,
        places: placesData.places,
        assignments: assignmentsMap,
        dayNotes: dayNotesMap,
        packingItems: packingData.items,
        todoItems: todoData.items,
        tags: cachedTags,
        categories: cachedCategories,
        isLoading: false,
      })

      // Apply background refreshes — update state when fresh data arrives
      Promise.all([
        tripData.refresh,
        daysData.refresh,
        placesData.refresh,
        packingData.refresh,
        todoData.refresh,
        tagsRefresh,
        categoriesRefresh,
      ]).then(([freshTrip, freshDays, freshPlaces, freshPacking, freshTodo, freshTags, freshCategories]) => {
        const updates: Partial<TripStoreState> = {}
        if (freshTrip) updates.trip = freshTrip.trip
        if (freshDays) {
          const { assignmentsMap: am, dayNotesMap: dm } = buildMaps(freshDays.days)
          updates.days = freshDays.days
          updates.assignments = am
          updates.dayNotes = dm
        }
        if (freshPlaces) updates.places = freshPlaces.places
        if (freshPacking) updates.packingItems = freshPacking.items
        if (freshTodo) updates.todoItems = freshTodo.items
        if (freshTags) updates.tags = freshTags.tags
        if (freshCategories) updates.categories = freshCategories.categories
        if (Object.keys(updates).length > 0) set(updates)
      }).catch(() => {})
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      set({ isLoading: false, error: message })
      throw err
    }
  },

  refreshDays: async (tripId: number | string) => {
    try {
      const daysData = await dayRepo.list(tripId)
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
    try {
      const result = await tripRepo.update(tripId, data)
      set({ trip: result.trip })
      if (navigator.onLine) {
        const daysData = await dayRepo.list(tripId)
        const assignmentsMap: AssignmentsMap = {}
        const dayNotesMap: DayNotesMap = {}
        for (const day of daysData.days) {
          assignmentsMap[String(day.id)] = day.assignments || []
          dayNotesMap[String(day.id)] = day.notes_items || []
        }
        set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
      }
      return result.trip
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating trip'))
    }
  },

  addTag: async (data: Partial<Tag>) => {
    try {
      const result = await tagsApi.create(data)
      set((state) => ({ tags: [...state.tags, result.tag] }))
      return result.tag
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error creating tag'))
    }
  },

  addCategory: async (data: Partial<Category>) => {
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
  ...createTodoSlice(set, get),
  ...createBudgetSlice(set, get),
  ...createReservationsSlice(set, get),
  ...createFilesSlice(set, get),
}))
