import { daysApi, dayNotesApi } from '../../api/client'
import {
  convexUpdateDay,
  convexCreateDayNote,
  convexUpdateDayNote,
  convexDeleteDayNote,
} from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { DayNote } from '../../types'
import { getApiErrorMessage } from '../../types'

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
  updateDayNotes: async (tripId, dayId, notes) => {
    // Optimistic update
    set(state => ({
      days: state.days.map(d => String(d.id) === String(dayId) ? { ...d, notes } : d)
    }))
    try {
      if (get().tripBackend === 'convex') {
        await convexUpdateDay(tripId as any, dayId as any, { notes })
      } else {
        await daysApi.update(tripId, dayId, { notes })
      }
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating notes'))
    }
  },

  updateDayTitle: async (tripId, dayId, title) => {
    set(state => ({
      days: state.days.map(d => String(d.id) === String(dayId) ? { ...d, title } : d)
    }))
    try {
      if (get().tripBackend === 'convex') {
        await convexUpdateDay(tripId as any, dayId as any, { title })
      } else {
        await daysApi.update(tripId, dayId, { title })
      }
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating day name'))
    }
  },

  addDayNote: async (tripId, dayId, data) => {
    const tempId = `temp_${Date.now()}`
    const tempNote: DayNote = { id: tempId, day_id: dayId, ...data, created_at: new Date().toISOString() } as DayNote
    set(state => ({
      dayNotes: {
        ...state.dayNotes,
        [String(dayId)]: [...(state.dayNotes[String(dayId)] || []), tempNote],
      }
    }))
    try {
      if (get().tripBackend === 'convex') {
        const result = await convexCreateDayNote(tripId as any, dayId as any, data as any)
        // Convex reactivity will replace the temp note
        return result as any as DayNote
      }
      const result = await dayNotesApi.create(tripId, dayId, data)
      set(state => ({
        dayNotes: {
          ...state.dayNotes,
          [String(dayId)]: (state.dayNotes[String(dayId)] || []).map(n => n.id === tempId ? result.note : n),
        }
      }))
      return result.note
    } catch (err: unknown) {
      set(state => ({
        dayNotes: {
          ...state.dayNotes,
          [String(dayId)]: (state.dayNotes[String(dayId)] || []).filter(n => n.id !== tempId),
        }
      }))
      throw new Error(getApiErrorMessage(err, 'Error adding note'))
    }
  },

  updateDayNote: async (tripId, dayId, id, data) => {
    try {
      if (get().tripBackend === 'convex') {
        const result = await convexUpdateDayNote(id as any, data as any)
        return result as any as DayNote
      }
      const result = await dayNotesApi.update(tripId, dayId, id as number, data)
      set(state => ({
        dayNotes: {
          ...state.dayNotes,
          [String(dayId)]: (state.dayNotes[String(dayId)] || []).map(n => n.id === id ? result.note : n),
        }
      }))
      return result.note
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating note'))
    }
  },

  deleteDayNote: async (tripId, dayId, id) => {
    const prev = get().dayNotes
    set(state => ({
      dayNotes: {
        ...state.dayNotes,
        [String(dayId)]: (state.dayNotes[String(dayId)] || []).filter(n => n.id !== id),
      }
    }))
    try {
      if (get().tripBackend === 'convex') {
        await convexDeleteDayNote(id as any)
      } else {
        await dayNotesApi.delete(tripId, dayId, id as number)
      }
    } catch (err: unknown) {
      set({ dayNotes: prev })
      throw new Error(getApiErrorMessage(err, 'Error deleting note'))
    }
  },

  moveDayNote: async (tripId, fromDayId, toDayId, noteId, sort_order = 9999) => {
    const state = get()
    const note = (state.dayNotes[String(fromDayId)] || []).find(n => n.id === noteId)
    if (!note) return

    // Optimistic: remove from source
    set(s => ({
      dayNotes: {
        ...s.dayNotes,
        [String(fromDayId)]: (s.dayNotes[String(fromDayId)] || []).filter(n => n.id !== noteId),
      }
    }))

    try {
      if (get().tripBackend === 'convex') {
        await convexDeleteDayNote(noteId as any)
        const result = await convexCreateDayNote(tripId as any, toDayId as any, {
          text: note.text, time: note.time, icon: note.icon, sort_order,
        })
        // Convex reactivity handles the rest
        return
      }
      await dayNotesApi.delete(tripId, fromDayId, noteId as number)
      const result = await dayNotesApi.create(tripId, toDayId, {
        text: note.text, time: note.time, icon: note.icon, sort_order,
      })
      set(s => ({
        dayNotes: {
          ...s.dayNotes,
          [String(toDayId)]: [...(s.dayNotes[String(toDayId)] || []), result.note],
        }
      }))
    } catch (err: unknown) {
      set(s => ({
        dayNotes: {
          ...s.dayNotes,
          [String(fromDayId)]: [...(s.dayNotes[String(fromDayId)] || []), note],
        }
      }))
      throw new Error(getApiErrorMessage(err, 'Error moving note'))
    }
  },
})
