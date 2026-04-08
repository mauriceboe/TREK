import {
  convexUpdateDay,
  convexCreateDayNote,
  convexUpdateDayNote,
  convexDeleteDayNote,
} from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { DayNote } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface DayNotesSlice {
  updateDayNotes: (tripId: number | string, dayId: number | string, notes: string) => Promise<void>
  updateDayTitle: (tripId: number | string, dayId: number | string, title: string) => Promise<void>
  addDayNote: (tripId: number | string, dayId: number | string, data: Partial<DayNote>) => Promise<DayNote>
  updateDayNote: (tripId: number | string, dayId: number | string, id: number | string, data: Partial<DayNote>) => Promise<DayNote>
  deleteDayNote: (tripId: number | string, dayId: number | string, id: number | string) => Promise<void>
  moveDayNote: (tripId: number | string, fromDayId: number | string, toDayId: number | string, noteId: number | string, sort_order?: number) => Promise<void>
}

export const createDayNotesSlice = (set: SetState, get: GetState): DayNotesSlice => ({
  updateDayNotes: async (_tripId, dayId, notes) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) return
    set(state => ({
      days: state.days.map(d => String(d.id) === String(dayId) ? { ...d, notes } : d)
    }))
    await convexUpdateDay(convexTripId as any, dayId as any, { notes })
  },

  updateDayTitle: async (_tripId, dayId, title) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) return
    set(state => ({
      days: state.days.map(d => String(d.id) === String(dayId) ? { ...d, title } : d)
    }))
    await convexUpdateDay(convexTripId as any, dayId as any, { title })
  },

  addDayNote: async (_tripId, dayId, data) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) throw new Error('Trip not loaded')
    const tempId = `temp_${Date.now()}`
    const tempNote: DayNote = { id: tempId, day_id: dayId, ...data, created_at: new Date().toISOString() } as DayNote
    set(state => ({
      dayNotes: {
        ...state.dayNotes,
        [String(dayId)]: [...(state.dayNotes[String(dayId)] || []), tempNote],
      }
    }))
    try {
      const result = await convexCreateDayNote(convexTripId as any, dayId as any, data as any)
      return result as any as DayNote
    } catch (err: unknown) {
      set(state => ({
        dayNotes: {
          ...state.dayNotes,
          [String(dayId)]: (state.dayNotes[String(dayId)] || []).filter(n => n.id !== tempId),
        }
      }))
      throw new Error(String(err))
    }
  },

  updateDayNote: async (_tripId, _dayId, id, data) => {
    const result = await convexUpdateDayNote(id as any, data as any)
    return result as any as DayNote
  },

  deleteDayNote: async (_tripId, dayId, id) => {
    const prev = get().dayNotes
    set(state => ({
      dayNotes: {
        ...state.dayNotes,
        [String(dayId)]: (state.dayNotes[String(dayId)] || []).filter(n => n.id !== id),
      }
    }))
    try {
      await convexDeleteDayNote(id as any)
    } catch (err: unknown) {
      set({ dayNotes: prev })
      throw new Error(String(err))
    }
  },

  moveDayNote: async (_tripId, fromDayId, toDayId, noteId, sort_order = 9999) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) return
    const state = get()
    const note = (state.dayNotes[String(fromDayId)] || []).find(n => n.id === noteId)
    if (!note) return

    set(s => ({
      dayNotes: {
        ...s.dayNotes,
        [String(fromDayId)]: (s.dayNotes[String(fromDayId)] || []).filter(n => n.id !== noteId),
      }
    }))

    try {
      await convexDeleteDayNote(noteId as any)
      await convexCreateDayNote(convexTripId as any, toDayId as any, {
        text: note.text, time: note.time, icon: note.icon, sort_order,
      })
    } catch (err: unknown) {
      set(s => ({
        dayNotes: {
          ...s.dayNotes,
          [String(fromDayId)]: [...(s.dayNotes[String(fromDayId)] || []), note],
        }
      }))
      throw new Error(String(err))
    }
  },
})
