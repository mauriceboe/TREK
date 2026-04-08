import { convexClient } from '../../convex/provider'
import { api } from '../../../convex/_generated/api'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { BudgetItem, BudgetMember } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

function getClient() {
  if (!convexClient) throw new Error('Convex not configured')
  return convexClient
}

function getTripId(get: GetState): any {
  const trip = get().trip as any
  return trip?._id || trip?.id
}

export interface BudgetSlice {
  loadBudgetItems: (tripId: number | string) => Promise<void>
  addBudgetItem: (tripId: number | string, data: Partial<BudgetItem>) => Promise<BudgetItem>
  updateBudgetItem: (tripId: number | string, id: number, data: Partial<BudgetItem>) => Promise<BudgetItem>
  deleteBudgetItem: (tripId: number | string, id: number) => Promise<void>
  setBudgetItemMembers: (tripId: number | string, itemId: number, userIds: number[]) => Promise<{ members: BudgetMember[]; item: BudgetItem }>
  toggleBudgetMemberPaid: (tripId: number | string, itemId: number, userId: number, paid: boolean) => Promise<void>
}

export const createBudgetSlice = (set: SetState, get: GetState): BudgetSlice => ({
  loadBudgetItems: async (_tripId) => {
    try {
      const convexTripId = getTripId(get)
      if (!convexTripId) return
      const data = await getClient().query(api.budget.list, { tripId: convexTripId })
      set({ budgetItems: data.items as any[] })
    } catch (err) {
      console.error('Failed to load budget items:', err)
    }
  },

  addBudgetItem: async (_tripId, data) => {
    const convexTripId = getTripId(get)
    const result = await getClient().mutation(api.budget.create, { tripId: convexTripId, data })
    set(state => ({ budgetItems: [...state.budgetItems, result.item as any] }))
    return result.item as any
  },

  updateBudgetItem: async (_tripId, id, data) => {
    const convexTripId = getTripId(get)
    const result = await getClient().mutation(api.budget.update, { tripId: convexTripId, itemId: id as any, data })
    set(state => ({ budgetItems: state.budgetItems.map(item => String(item.id) === String(id) ? result.item as any : item) }))
    return result.item as any
  },

  deleteBudgetItem: async (_tripId, id) => {
    const convexTripId = getTripId(get)
    const prev = get().budgetItems
    set(state => ({ budgetItems: state.budgetItems.filter(item => String(item.id) !== String(id)) }))
    try {
      await getClient().mutation(api.budget.remove, { tripId: convexTripId, itemId: id as any })
    } catch {
      set({ budgetItems: prev })
    }
  },

  setBudgetItemMembers: async (_tripId, itemId, userIds) => {
    const convexTripId = getTripId(get)
    // userIds are auth keys in the Convex world
    const result = await getClient().mutation(api.budget.setMembers, {
      tripId: convexTripId, itemId: itemId as any, userAuthKeys: userIds.map(String),
    })
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        String(item.id) === String(itemId) ? { ...item, members: result.members as any[], persons: (result.item as any).persons } : item
      )
    }))
    return result as any
  },

  toggleBudgetMemberPaid: async (_tripId, itemId, userId, paid) => {
    const convexTripId = getTripId(get)
    await getClient().mutation(api.budget.togglePaid, {
      tripId: convexTripId, itemId: itemId as any, userAuthKey: String(userId), paid,
    })
    set(state => ({
      budgetItems: state.budgetItems.map(item =>
        String(item.id) === String(itemId)
          ? { ...item, members: (item.members || []).map((m: any) => String(m.user_id) === String(userId) ? { ...m, paid } : m) }
          : item
      )
    }))
  },
})
