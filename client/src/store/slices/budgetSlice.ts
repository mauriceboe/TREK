import { budgetApi } from '../../api/client'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { BudgetItem, BudgetMember } from '../../types'
import { getApiErrorMessage } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

export interface BudgetSlice {
  loadBudgetItems: (tripId: number | string) => Promise<void>
  addBudgetItem: (tripId: number | string, data: Partial<BudgetItem>) => Promise<BudgetItem>
  updateBudgetItem: (tripId: number | string, id: number, data: Partial<BudgetItem>) => Promise<BudgetItem>
  deleteBudgetItem: (tripId: number | string, id: number) => Promise<void>
  setBudgetItemMembers: (tripId: number | string, itemId: number, userIds: number[]) => Promise<{ members: BudgetMember[]; item: BudgetItem }>
  toggleBudgetMemberPaid: (tripId: number | string, itemId: number, userId: number, paid: boolean) => Promise<void>
}

export const createBudgetSlice = (set: SetState, get: GetState): BudgetSlice => ({
  loadBudgetItems: async (tripId) => {
    try {
      const data = await budgetApi.list(tripId)
      set({ budgetItems: data.items })
    } catch (err: unknown) {
      console.error('Failed to load budget items:', err)
    }
  },

  addBudgetItem: async (tripId, data) => {
    try {
      const result = await budgetApi.create(tripId, data)
      set(state => ({ budgetItems: [...state.budgetItems, result.item] }))
      return result.item
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error adding budget item'))
    }
  },

  updateBudgetItem: async (tripId, id, data) => {
    try {
      const result = await budgetApi.update(tripId, id, data)
      set(state => ({
        budgetItems: state.budgetItems.map(item => item.id === id ? result.item : item)
      }))
      if (result.item.reservation_id && data.total_price !== undefined) {
        get().loadReservations(tripId)
      }
      return result.item
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating budget item'))
    }
  },

  deleteBudgetItem: async (tripId, id) => {
    const prev = get().budgetItems
    set(state => ({ budgetItems: state.budgetItems.filter(item => item.id !== id) }))
    try {
      await budgetApi.delete(tripId, id)
    } catch (err: unknown) {
      set({ budgetItems: prev })
      throw new Error(getApiErrorMessage(err, 'Error deleting budget item'))
    }
  },

  setBudgetItemMembers: async (tripId, itemId, userIds) => {
    const result = await budgetApi.setMembers(tripId, itemId, userIds);
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        item.id === itemId ? { ...item, members: result.members, persons: result.item.persons } : item
      )
    }));
    return result;
  },

  toggleBudgetMemberPaid: async (tripId, itemId, userId, paid) => {
    await budgetApi.togglePaid(tripId, itemId, userId, paid);
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        item.id === itemId
          ? { ...item, members: (item.members || []).map(m => m.user_id === userId ? { ...m, paid } : m) }
          : item
      )
    }));
  },
})
