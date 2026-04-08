import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { convexUpdateTrip, convexCreateTag, convexCreateCategory } from '../convex/mutationClient'
import { createPlacesSlice } from './slices/placesSlice'
import { createAssignmentsSlice } from './slices/assignmentsSlice'
import { createDayNotesSlice } from './slices/dayNotesSlice'
import { createPackingSlice } from './slices/packingSlice'
import { createBudgetSlice } from './slices/budgetSlice'
import { createReservationsSlice } from './slices/reservationsSlice'
import { createFilesSlice } from './slices/filesSlice'
import { createLegsSlice } from './slices/legsSlice'
import type {
  Trip, Day, Place, Assignment, DayNote, PackingItem,
  Tag, Category, BudgetItem, TripFile, Reservation, TripLeg,
  AssignmentsMap, DayNotesMap, WebSocketEvent,
} from '../types'
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
  tripBackend: 'convex' | null
  selectedDayId: number | string | null
  isLoading: boolean
  error: string | null

  setSelectedDay: (dayId: number | string | null) => void
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

  // No-op: Convex reactivity handles real-time sync, no WebSocket needed
  handleRemoteEvent: (_event: WebSocketEvent) => {},

  loadTrip: async (tripId: number | string) => {
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
      tripBackend: 'convex',
      isLoading: true,
      error: null,
    })
    // The useConvexTripData hook handles loading trip, days, places,
    // assignments, dayNotes, tags, categories, legs via reactive queries.
    // Nothing else to do here — the hook will set isLoading: false.
  },

  refreshDays: async (_tripId: number | string) => {
    // Convex reactivity handles refreshes automatically
  },

  updateTrip: async (tripId: number | string, data: Partial<Trip>) => {
    const result = await convexUpdateTrip(tripId as any, data as any)
    // Convex reactivity will update the store via the bridge hook
    return result as any as Trip
  },

  addTag: async (data: Partial<Tag>) => {
    const result = await convexCreateTag(data as any)
    return result as any as Tag
  },

  addCategory: async (data: Partial<Category>) => {
    const result = await convexCreateCategory(data as any)
    return result as any as Category
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
