import { assignmentsApi } from '../../api/client'
import {
  convexAssignPlace,
  convexRemoveAssignment,
  convexReorderAssignments,
  convexMoveAssignment,
} from '../../convex/mutationClient'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Assignment, AssignmentsMap } from '../../types'
import { getApiErrorMessage } from '../../types'

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
  assignPlaceToDay: async (tripId, dayId, placeId, position) => {
    if (get().tripBackend === 'convex') {
      const state = get()
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
        const result = await convexAssignPlace(tripId as any, dayId as any, placeId as any)
        // Convex reactivity will replace the temp assignment via the bridge hook
        if (position != null) {
          // Get updated assignments from the reactive query after the mutation settles
          const updated = get().assignments[String(dayId)] || []
          const ids = updated.map(a => a.id).filter(id => !String(id).startsWith('temp_'))
          if (ids.length > 0) {
            await convexReorderAssignments(tripId as any, dayId as any, ids as any)
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
    }

    // Legacy Express path
    const state = get()
    const place = state.places.find(p => p.id === parseInt(String(placeId)))
    if (!place) return

    const tempId = Date.now() * -1
    const current = [...(state.assignments[String(dayId)] || [])]
    const insertIdx = position != null ? position : current.length
    const tempAssignment: Assignment = {
      id: tempId,
      day_id: parseInt(String(dayId)),
      order_index: insertIdx,
      notes: null,
      place,
    }

    current.splice(insertIdx, 0, tempAssignment)
    set(state => ({
      assignments: {
        ...state.assignments,
        [String(dayId)]: current,
      }
    }))

    try {
      const data = await assignmentsApi.create(tripId, dayId, { place_id: placeId })
      const newAssignment: Assignment = {
        ...data.assignment,
        place: data.assignment.place || place,
        order_index: position != null ? insertIdx : data.assignment.order_index,
      }
      set(state => ({
        assignments: {
          ...state.assignments,
          [String(dayId)]: state.assignments[String(dayId)].map(
            a => a.id === tempId ? newAssignment : a
          ),
        }
      }))
      if (position != null) {
        const updated = get().assignments[String(dayId)] || []
        const orderedIds = updated.map(a => a.id).filter(id => (id as number) > 0)
        if (orderedIds.length > 0) {
          try {
            await assignmentsApi.reorder(tripId, dayId, orderedIds as number[])
            set(state => {
              const items = state.assignments[String(dayId)] || []
              const reordered = orderedIds.map((id, idx) => {
                const item = items.find(a => a.id === id)
                return item ? { ...item, order_index: idx } : null
              }).filter((item): item is Assignment => item !== null)
              return {
                assignments: {
                  ...state.assignments,
                  [String(dayId)]: reordered,
                }
              }
            })
          } catch {}
        }
      }
      return data.assignment
    } catch (err: unknown) {
      set(state => ({
        assignments: {
          ...state.assignments,
          [String(dayId)]: state.assignments[String(dayId)].filter(a => a.id !== tempId),
        }
      }))
      throw new Error(getApiErrorMessage(err, 'Error assigning place'))
    }
  },

  removeAssignment: async (tripId, dayId, assignmentId) => {
    const prevAssignments = get().assignments

    set(state => ({
      assignments: {
        ...state.assignments,
        [String(dayId)]: (state.assignments[String(dayId)] || []).filter(a => a.id !== assignmentId),
      }
    }))

    try {
      if (get().tripBackend === 'convex') {
        await convexRemoveAssignment(tripId as any, assignmentId as any)
      } else {
        await assignmentsApi.delete(tripId, dayId, assignmentId as number)
      }
    } catch (err: unknown) {
      set({ assignments: prevAssignments })
      throw new Error(getApiErrorMessage(err, 'Error removing assignment'))
    }
  },

  reorderAssignments: async (tripId, dayId, orderedIds) => {
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
      if (get().tripBackend === 'convex') {
        await convexReorderAssignments(tripId as any, dayId as any, orderedIds as any)
      } else {
        await assignmentsApi.reorder(tripId, dayId, orderedIds as number[])
      }
    } catch (err: unknown) {
      set({ assignments: prevAssignments })
      throw new Error(getApiErrorMessage(err, 'Error reordering'))
    }
  },

  moveAssignment: async (tripId, assignmentId, fromDayId, toDayId, toOrderIndex = null) => {
    const state = get()
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
      if (get().tripBackend === 'convex') {
        await convexMoveAssignment(tripId as any, assignmentId as any, toDayId as any, insertAt)
        if (newToItems.length > 1) {
          await convexReorderAssignments(tripId as any, toDayId as any, newToItems.map(a => a.id) as any)
        }
      } else {
        await assignmentsApi.move(tripId, assignmentId as number, toDayId, insertAt)
        if (newToItems.length > 1) {
          await assignmentsApi.reorder(tripId, toDayId, newToItems.map(a => a.id) as number[])
        }
      }
    } catch (err: unknown) {
      set({ assignments: prevAssignments })
      throw new Error(getApiErrorMessage(err, 'Error moving assignment'))
    }
  },

  setAssignments: (assignments) => {
    set({ assignments })
  },
})
