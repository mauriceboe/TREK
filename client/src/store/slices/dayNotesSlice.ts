import { daysApi, dayNotesApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { DayNote, DaySection } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface DayNotesSlice {
  updateDayNotes: (tripId: number | string, dayId: number | string, notes: string) => Promise<void>
  updateDayTitle: (tripId: number | string, dayId: number | string, title: string) => Promise<void>
  addDayNote: (tripId: number | string, dayId: number | string, data: Partial<DayNote>) => Promise<DayNote>
  updateDayNote: (tripId: number | string, dayId: number | string, id: number, data: Partial<DayNote>) => Promise<DayNote>
  deleteDayNote: (tripId: number | string, dayId: number | string, id: number) => Promise<void>
  moveDayNote: (tripId: number | string, fromDayId: number | string, toDayId: number | string, noteId: number, sort_order?: number, day_section?: DaySection) => Promise<void>
}

export const createDayNotesSlice = (set: SetState, get: GetState): DayNotesSlice => ({
  updateDayNotes: async (tripId, dayId, notes) => {
    try {
      await daysApi.update(tripId, dayId, { notes })
      set(state => ({
        days: state.days.map(d => d.id === parseInt(String(dayId)) ? { ...d, notes } : d)
      }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating notes'))
    }
  },

  updateDayTitle: async (tripId, dayId, title) => {
    try {
      await daysApi.update(tripId, dayId, { title })
      set(state => ({
        days: state.days.map(d => d.id === parseInt(String(dayId)) ? { ...d, title } : d)
      }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating day name'))
    }
  },

  addDayNote: async (tripId, dayId, data) => {
    const tempId = Date.now() * -1
    const tempNote: DayNote = { id: tempId, day_id: dayId as number, ...data, created_at: new Date().toISOString() } as DayNote
    set(state => ({
      dayNotes: {
        ...state.dayNotes,
        [String(dayId)]: [...(state.dayNotes[String(dayId)] || []), tempNote],
      }
    }))
    try {
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
      const result = await dayNotesApi.update(tripId, dayId, id, data)
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
      await dayNotesApi.delete(tripId, dayId, id)
    } catch (err: unknown) {
      set({ dayNotes: prev })
      throw new Error(getApiErrorMessage(err, 'Error deleting note'))
    }
  },

  moveDayNote: async (tripId, fromDayId, toDayId, noteId, sort_order = 9999, day_section) => {
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
      await dayNotesApi.delete(tripId, fromDayId, noteId)
      const result = await dayNotesApi.create(tripId, toDayId, {
        text: note.text, time: note.time, icon: note.icon, sort_order, day_section: day_section ?? note.day_section,
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
