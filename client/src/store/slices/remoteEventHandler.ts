import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Assignment, Place, Day, DayNote, PackingItem, TodoItem, BudgetItem, BudgetMember, Reservation, Trip, TripFile, WebSocketEvent } from '../../types'
import { offlineDb } from '../../db/offlineDb'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

// ── Dexie write-through ───────────────────────────────────────────────────────

/**
 * Persist remote event to IndexedDB so the data is available offline.
 * Fire-and-forget: errors are swallowed to never block the Zustand update.
 * Called AFTER set() so `state` already reflects the update.
 */
function writeToDexie(
  type: string,
  payload: Record<string, unknown>,
  state: TripStoreState,
): void {
  ;(async () => {
    try {
      switch (type) {
        // ── Places ──────────────────────────────────────────────────────────
        case 'place:created':
        case 'place:updated':
          await offlineDb.places.put(payload.place as Place)
          break
        case 'place:deleted':
          await offlineDb.places.delete(payload.placeId as number)
          break

        // ── Assignments (embedded in Day rows) ──────────────────────────────
        // Read the already-updated Day from the Zustand state and persist it.
        case 'assignment:created':
        case 'assignment:updated': {
          const assignment = payload.assignment as Assignment
          await _writeDayToDb(assignment.day_id, state)
          break
        }
        case 'assignment:deleted': {
          await _writeDayToDb(payload.dayId as number, state)
          break
        }
        case 'assignment:moved': {
          const movedAssignment = payload.assignment as Assignment
          await Promise.all([
            _writeDayToDb(payload.oldDayId as number, state),
            _writeDayToDb(movedAssignment.day_id, state),
          ])
          break
        }
        case 'assignment:reordered':
          await _writeDayToDb(payload.dayId as number, state)
          break

        // ── Days ─────────────────────────────────────────────────────────────
        case 'day:created':
        case 'day:updated': {
          const day = payload.day as Day
          await _writeDayToDb(day.id, state)
          break
        }
        case 'day:deleted':
          await offlineDb.days.delete(payload.dayId as number)
          break

        // ── Day notes (embedded in Day rows) ─────────────────────────────────
        case 'dayNote:created':
        case 'dayNote:updated':
        case 'dayNote:deleted':
          await _writeDayToDb(payload.dayId as number, state)
          break

        // ── Packing ──────────────────────────────────────────────────────────
        case 'packing:created':
        case 'packing:updated':
          await offlineDb.packingItems.put(payload.item as PackingItem)
          break
        case 'packing:deleted':
          await offlineDb.packingItems.delete(payload.itemId as number)
          break

        // ── Todo ─────────────────────────────────────────────────────────────
        case 'todo:created':
        case 'todo:updated':
          await offlineDb.todoItems.put(payload.item as TodoItem)
          break
        case 'todo:deleted':
          await offlineDb.todoItems.delete(payload.itemId as number)
          break

        // ── Budget ───────────────────────────────────────────────────────────
        case 'budget:created':
        case 'budget:updated':
          await offlineDb.budgetItems.put(payload.item as BudgetItem)
          break
        case 'budget:deleted':
          await offlineDb.budgetItems.delete(payload.itemId as number)
          break
        case 'budget:members-updated':
        case 'budget:member-paid-updated':
        case 'budget:reordered': {
          // Partial update — read canonical item(s) from updated Zustand state
          if (type === 'budget:reordered') {
            await offlineDb.budgetItems.bulkPut(state.budgetItems)
          } else {
            const item = state.budgetItems.find(i => i.id === (payload.itemId as number))
            if (item) await offlineDb.budgetItems.put(item)
          }
          break
        }

        // ── Reservations ─────────────────────────────────────────────────────
        case 'reservation:created':
        case 'reservation:updated':
          await offlineDb.reservations.put(payload.reservation as Reservation)
          break
        case 'reservation:deleted':
          await offlineDb.reservations.delete(payload.reservationId as number)
          break

        // ── Trip ─────────────────────────────────────────────────────────────
        case 'trip:updated':
          await offlineDb.trips.put(payload.trip as Trip)
          break

        // ── Files ─────────────────────────────────────────────────────────────
        case 'file:created':
        case 'file:updated':
          await offlineDb.tripFiles.put(payload.file as TripFile)
          break
        case 'file:deleted':
          await offlineDb.tripFiles.delete(payload.fileId as number)
          break

        default:
          break
      }
    } catch {
      // Dexie write failures are non-fatal — online state is source of truth
    }
  })()
}

/** Write a Day (with its current assignments + notes from Zustand) to Dexie. */
async function _writeDayToDb(dayId: number, state: TripStoreState): Promise<void> {
  const day = state.days.find(d => d.id === dayId)
  if (!day) return
  await offlineDb.days.put({
    ...day,
    assignments: state.assignments[String(dayId)] ?? [],
    notes_items: state.dayNotes[String(dayId)] ?? [],
  })
}

// ── Zustand event reducer ─────────────────────────────────────────────────────

/**
 * Applies a remote WebSocket event to the local Zustand store, keeping state in sync across collaborators.
 * Each event type maps to an immutable state update (create/update/delete) for the relevant entity.
 * After the Zustand update, the change is also written through to IndexedDB for offline access.
 */
export function handleRemoteEvent(set: SetState, get: GetState, event: WebSocketEvent): void {
  const { type, ...payload } = event

  set(state => {
    switch (type) {
      // Places
      case 'place:created':
        if (state.places.some(p => p.id === (payload.place as Place).id)) return {}
        return { places: [payload.place as Place, ...state.places] }
      case 'place:updated':
        return {
          places: state.places.map(p => p.id === (payload.place as Place).id ? payload.place as Place : p),
          assignments: Object.fromEntries(
            Object.entries(state.assignments).map(([dayId, items]) => [
              dayId,
              items.map(a => a.place?.id === (payload.place as Place).id ? { ...a, place: payload.place as Place } : a)
            ])
          ),
        }
      case 'place:deleted':
        return {
          places: state.places.filter(p => p.id !== payload.placeId),
          assignments: Object.fromEntries(
            Object.entries(state.assignments).map(([dayId, items]) => [
              dayId,
              items.filter(a => a.place?.id !== payload.placeId)
            ])
          ),
        }

      // Assignments
      case 'assignment:created': {
        const dayKey = String((payload.assignment as Assignment).day_id)
        const existing = (state.assignments[dayKey] || [])
        const placeId = (payload.assignment as Assignment).place?.id || (payload.assignment as Assignment).place_id
        if (existing.some(a => a.id === (payload.assignment as Assignment).id || (placeId && a.place?.id === placeId))) {
          const hasTempVersion = existing.some(a => a.id < 0 && a.place?.id === placeId)
          if (hasTempVersion) {
            return {
              assignments: {
                ...state.assignments,
                [dayKey]: existing.map(a => (a.id < 0 && a.place?.id === placeId) ? payload.assignment as Assignment : a),
              }
            }
          }
          return {}
        }
        return {
          assignments: {
            ...state.assignments,
            [dayKey]: [...existing, payload.assignment as Assignment],
          }
        }
      }
      case 'assignment:updated': {
        const dayKey = String((payload.assignment as Assignment).day_id)
        return {
          assignments: {
            ...state.assignments,
            [dayKey]: (state.assignments[dayKey] || []).map(a =>
              a.id === (payload.assignment as Assignment).id ? { ...a, ...(payload.assignment as Assignment) } : a
            ),
          }
        }
      }
      case 'assignment:deleted': {
        const dayKey = String(payload.dayId)
        return {
          assignments: {
            ...state.assignments,
            [dayKey]: (state.assignments[dayKey] || []).filter(a => a.id !== payload.assignmentId),
          }
        }
      }
      case 'assignment:moved': {
        const oldKey = String(payload.oldDayId)
        const newKey = String(payload.newDayId)
        const movedAssignment = payload.assignment as Assignment
        return {
          assignments: {
            ...state.assignments,
            [oldKey]: (state.assignments[oldKey] || []).filter(a => a.id !== movedAssignment.id),
            [newKey]: [...(state.assignments[newKey] || []).filter(a => a.id !== movedAssignment.id), movedAssignment],
          }
        }
      }
      case 'assignment:reordered': {
        const dayKey = String(payload.dayId)
        const currentItems = state.assignments[dayKey] || []
        const orderedIds: number[] = payload.orderedIds || []
        const reordered = orderedIds.map((id, idx) => {
          const item = currentItems.find(a => a.id === id)
          return item ? { ...item, order_index: idx } : null
        }).filter((item): item is Assignment => item !== null)
        return {
          assignments: {
            ...state.assignments,
            [dayKey]: reordered,
          }
        }
      }

      // Days
      case 'day:created':
        if (state.days.some(d => d.id === (payload.day as Day).id)) return {}
        return { days: [...state.days, payload.day as Day] }
      case 'day:updated':
        return {
          days: state.days.map(d => d.id === (payload.day as Day).id ? payload.day as Day : d),
        }
      case 'day:deleted': {
        const removedDayId = String(payload.dayId)
        const newAssignments = { ...state.assignments }
        delete newAssignments[removedDayId]
        const newDayNotes = { ...state.dayNotes }
        delete newDayNotes[removedDayId]
        return {
          days: state.days.filter(d => d.id !== payload.dayId),
          assignments: newAssignments,
          dayNotes: newDayNotes,
        }
      }

      // Day Notes
      case 'dayNote:created': {
        const dayKey = String(payload.dayId)
        const existingNotes = (state.dayNotes[dayKey] || [])
        if (existingNotes.some(n => n.id === (payload.note as DayNote).id)) return {}
        return {
          dayNotes: {
            ...state.dayNotes,
            [dayKey]: [...existingNotes, payload.note as DayNote],
          }
        }
      }
      case 'dayNote:updated': {
        const dayKey = String(payload.dayId)
        return {
          dayNotes: {
            ...state.dayNotes,
            [dayKey]: (state.dayNotes[dayKey] || []).map(n => n.id === (payload.note as DayNote).id ? payload.note as DayNote : n),
          }
        }
      }
      case 'dayNote:deleted': {
        const dayKey = String(payload.dayId)
        return {
          dayNotes: {
            ...state.dayNotes,
            [dayKey]: (state.dayNotes[dayKey] || []).filter(n => n.id !== payload.noteId),
          }
        }
      }

      // Packing
      case 'packing:created':
        if (state.packingItems.some(i => i.id === (payload.item as PackingItem).id)) return {}
        return { packingItems: [...state.packingItems, payload.item as PackingItem] }
      case 'packing:updated':
        return {
          packingItems: state.packingItems.map(i => i.id === (payload.item as PackingItem).id ? payload.item as PackingItem : i),
        }
      case 'packing:deleted':
        return {
          packingItems: state.packingItems.filter(i => i.id !== payload.itemId),
        }
      case 'packing:category-deleted':
        // Mirror the server-side cascade on packing_items.
        return {
          packingItems: state.packingItems.filter(i => i.category_id !== payload.catId),
        }

      // Todo
      case 'todo:created':
        if (state.todoItems.some(i => i.id === (payload.item as TodoItem).id)) return {}
        return { todoItems: [...state.todoItems, payload.item as TodoItem] }
      case 'todo:updated':
        return {
          todoItems: state.todoItems.map(i => i.id === (payload.item as TodoItem).id ? payload.item as TodoItem : i),
        }
      case 'todo:deleted':
        return {
          todoItems: state.todoItems.filter(i => i.id !== payload.itemId),
        }

      // Budget
      case 'budget:created':
        if (state.budgetItems.some(i => i.id === (payload.item as BudgetItem).id)) return {}
        return { budgetItems: [...state.budgetItems, payload.item as BudgetItem] }
      case 'budget:updated':
        return {
          budgetItems: state.budgetItems.map(i => i.id === (payload.item as BudgetItem).id ? payload.item as BudgetItem : i),
        }
      case 'budget:deleted':
        return {
          budgetItems: state.budgetItems.filter(i => i.id !== payload.itemId),
        }
      case 'budget:members-updated':
        return {
          budgetItems: state.budgetItems.map(i =>
            i.id === payload.itemId ? { ...i, members: payload.members as BudgetMember[], persons: payload.persons as number } : i
          ),
        }
      case 'budget:member-paid-updated':
        return {
          budgetItems: state.budgetItems.map(i =>
            i.id === payload.itemId
              ? { ...i, members: (i.members || []).map(m => m.user_id === payload.userId ? { ...m, paid: payload.paid } : m) }
              : i
          ),
        }
      case 'budget:reordered': {
        if (payload.orderedIds) {
          const orderedIds = payload.orderedIds as number[]
          const byId = new Map(state.budgetItems.map(i => [i.id, i]))
          const reordered = orderedIds.map((id, idx) => {
            const item = byId.get(id)
            return item ? { ...item, sort_order: idx } : null
          }).filter((i): i is BudgetItem => i !== null)
          const remaining = state.budgetItems.filter(i => !orderedIds.includes(i.id))
          return { budgetItems: [...reordered, ...remaining] }
        }
        if (payload.orderedCategories) {
          const orderedCategories = payload.orderedCategories as string[]
          const grouped = new Map<string, BudgetItem[]>()
          for (const item of state.budgetItems) {
            const cat = item.category || 'Other'
            if (!grouped.has(cat)) grouped.set(cat, [])
            grouped.get(cat)!.push(item)
          }
          const reordered: BudgetItem[] = []
          for (const cat of orderedCategories) {
            const items = grouped.get(cat)
            if (items) reordered.push(...items)
          }
          for (const [cat, items] of grouped) {
            if (!orderedCategories.includes(cat)) reordered.push(...items)
          }
          return { budgetItems: reordered }
        }
        return {}
      }

      // Reservations
      case 'reservation:created':
        if (state.reservations.some(r => r.id === (payload.reservation as Reservation).id)) return {}
        return { reservations: [payload.reservation as Reservation, ...state.reservations] }
      case 'reservation:updated':
        return {
          reservations: state.reservations.map(r => r.id === (payload.reservation as Reservation).id ? payload.reservation as Reservation : r),
        }
      case 'reservation:deleted':
        return {
          reservations: state.reservations.filter(r => r.id !== payload.reservationId),
        }

      // Trip
      case 'trip:updated':
        return { trip: payload.trip as Trip }

      // Files
      case 'file:created':
        if (state.files.some(f => f.id === (payload.file as TripFile).id)) return {}
        return { files: [payload.file as TripFile, ...state.files] }
      case 'file:updated':
        return {
          files: state.files.map(f => f.id === (payload.file as TripFile).id ? payload.file as TripFile : f),
        }
      case 'file:deleted':
        return {
          files: state.files.filter(f => f.id !== payload.fileId),
        }

      // Memories / Photos
      case 'memories:updated':
        window.dispatchEvent(new CustomEvent('memories:updated', { detail: payload }))
        return {}

      default:
        return {}
    }
  })

  // Write the change through to IndexedDB using the post-update state
  writeToDexie(type, payload as Record<string, unknown>, get())
}
