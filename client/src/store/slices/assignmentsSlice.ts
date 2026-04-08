import {
  convexAssignPlace,
  convexRemoveAssignment,
  convexReorderAssignments,
  convexMoveAssignment,
} from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Assignment, AssignmentsMap } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface AssignmentsSlice {
  assignPlaceToDay: (tripId: number | string, dayId: number | string, placeId: number | string, position?: number | null) => Promise<Assignment | undefined>
  removeAssignment: (tripId: number | string, dayId: number | string, assignmentId: number | string) => Promise<void>
  reorderAssignments: (tripId: number | string, dayId: number | string, orderedIds: (number | string)[]) => Promise<void>
  moveAssignment: (tripId: number | string, assignmentId: number | string, fromDayId: number | string, toDayId: number | string, toOrderIndex?: number | null) => Promise<void>
  setAssignments: (assignments: AssignmentsMap) => void
}

export const createAssignmentsSlice = (set: SetState, get: GetState): AssignmentsSlice => ({
  assignPlaceToDay: async (_tripId, dayId, placeId, position) => {
    const state = get()
    const convexTripId = (state.trip as any)?._id
    if (!convexTripId) return
    const place = state.places.find(p => String(p.id) === String(placeId))
    if (!place) return

    // Optimistic: add temp assignment
    const tempId = `temp_${Date.now()}`
    const current = [...(state.assignments[String(dayId)] || [])]
    const insertIdx = position != null ? position : current.length
    const tempAssignment: Assignment = {
      id: tempId,
      day_id: dayId,
      order_index: insertIdx,
      notes: null,
      place,
    }
    current.splice(insertIdx, 0, tempAssignment)
    set(state => ({
      assignments: { ...state.assignments, [String(dayId)]: current }
    }))

    try {
      const result = await convexAssignPlace(convexTripId as any, dayId as any, placeId as any)
      // Convex reactivity will replace the temp assignment via the bridge hook
      if (position != null) {
        const updated = get().assignments[String(dayId)] || []
        const ids = updated.map(a => a.id).filter(id => !String(id).startsWith('temp_'))
        if (ids.length > 0) {
          await convexReorderAssignments(convexTripId as any, dayId as any, ids as any)
        }
      }
      return result as any
    } catch (err: unknown) {
      set(state => ({
        assignments: {
          ...state.assignments,
          [String(dayId)]: (state.assignments[String(dayId)] || []).filter(a => a.id !== tempId),
        }
      }))
      throw new Error(String(err))
    }
  },

  removeAssignment: async (_tripId, _dayId, assignmentId) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) return
    const prevAssignments = get().assignments

    set(state => ({
      assignments: {
        ...state.assignments,
        [String(_dayId)]: (state.assignments[String(_dayId)] || []).filter(a => a.id !== assignmentId),
      }
    }))

    try {
      await convexRemoveAssignment(convexTripId as any, assignmentId as any)
    } catch (err: unknown) {
      set({ assignments: prevAssignments })
      throw new Error(String(err))
    }
  },

  reorderAssignments: async (_tripId, dayId, orderedIds) => {
    const convexTripId = (get().trip as any)?._id
    if (!convexTripId) return
    const prevAssignments = get().assignments
    const dayItems = get().assignments[String(dayId)] || []
    const reordered = orderedIds.map((id, idx) => {
      const item = dayItems.find(a => a.id === id)
      return item ? { ...item, order_index: idx } : null
    }).filter((item): item is Assignment => item !== null)

    set(state => ({
      assignments: {
        ...state.assignments,
        [String(dayId)]: reordered,
      }
    }))

    try {
      await convexReorderAssignments(convexTripId as any, dayId as any, orderedIds as any)
    } catch (err: unknown) {
      set({ assignments: prevAssignments })
      throw new Error(String(err))
    }
  },

  moveAssignment: async (_tripId, assignmentId, fromDayId, toDayId, toOrderIndex = null) => {
    const state = get()
    const convexTripId = (state.trip as any)?._id
    if (!convexTripId) return
    const prevAssignments = state.assignments
    const assignment = (state.assignments[String(fromDayId)] || []).find(a => a.id === assignmentId)
    if (!assignment) return

    const toItems = (state.assignments[String(toDayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    const insertAt = toOrderIndex !== null ? toOrderIndex : toItems.length

    const newToItems = [...toItems]
    newToItems.splice(insertAt, 0, { ...assignment, day_id: toDayId })
    newToItems.forEach((a, i) => { a.order_index = i })

    set(s => ({
      assignments: {
        ...s.assignments,
        [String(fromDayId)]: s.assignments[String(fromDayId)].filter(a => a.id !== assignmentId),
        [String(toDayId)]: newToItems,
      }
    }))

    try {
      await convexMoveAssignment(convexTripId as any, assignmentId as any, toDayId as any, insertAt)
      if (newToItems.length > 1) {
        await convexReorderAssignments(convexTripId as any, toDayId as any, newToItems.map(a => a.id) as any)
      }
    } catch (err: unknown) {
      set({ assignments: prevAssignments })
      throw new Error(String(err))
    }
  },

  setAssignments: (assignments) => {
    set({ assignments })
  },
})
