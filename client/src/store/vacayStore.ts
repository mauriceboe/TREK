import { create } from 'zustand'
import apiClient from '../api/client'
import type { AxiosResponse } from 'axios'
import type { VacayPlan, VacayUser, VacayEntry, VacayStat, VacayCompanyHoliday, HolidaysMap, HolidayInfo, VacayHolidayCalendar, VacayAccessInvite, VacayOutgoingInvite } from '../types'


const ax = apiClient

interface VacayPlanResponse {
  plan: VacayPlan
  myColor: string
  connectedUsers: VacayUser[]
  pendingIncoming: VacayAccessInvite[]
  pendingOutgoing: VacayOutgoingInvite[]
}

interface VacayYearsResponse {
  years: number[]
}

interface VacayEntriesResponse {
  entries: VacayEntry[]
  companyHolidays: VacayCompanyHoliday[]
}

interface VacayStatsResponse {
  stats: VacayStat[]
}

interface VacayHolidayRaw {
  date: string
  name: string
  localName: string
  global: boolean
  counties: string[] | null
}

interface VacayApi {
  getPlan: () => Promise<VacayPlanResponse>
  updatePlan: (data: Partial<VacayPlan>) => Promise<{ plan: VacayPlan }>
  updateColor: (color: string) => Promise<unknown>
  grantAccess: (viewerId: number) => Promise<unknown>
  acceptAccess: (granterId: number) => Promise<unknown>
  declineAccess: (granterId: number) => Promise<unknown>
  cancelAccess: (viewerId: number) => Promise<unknown>
  revokeAccess: (userId: number) => Promise<unknown>
  availableUsersForAccess: () => Promise<{ users: VacayUser[] }>
  getForeignEntries: (year: number) => Promise<{ entries: VacayEntry[] }>
  getYears: () => Promise<VacayYearsResponse>
  addYear: (year: number) => Promise<VacayYearsResponse>
  removeYear: (year: number) => Promise<VacayYearsResponse>
  getEntries: (year: number) => Promise<VacayEntriesResponse>
  toggleEntry: (date: string) => Promise<unknown>
  toggleCompanyHoliday: (date: string) => Promise<unknown>
  getStats: (year: number) => Promise<VacayStatsResponse>
  updateStats: (year: number, days: number) => Promise<unknown>
  getCountries: () => Promise<{ countries: string[] }>
  getHolidays: (year: number, country: string) => Promise<VacayHolidayRaw[]>
  addHolidayCalendar: (data: { region: string; color?: string; label?: string | null }) => Promise<{ calendar: VacayHolidayCalendar }>
  updateHolidayCalendar: (id: number, data: { region?: string; color?: string; label?: string | null }) => Promise<{ calendar: VacayHolidayCalendar }>
  deleteHolidayCalendar: (id: number) => Promise<unknown>
}

const api: VacayApi = {
  getPlan: () => ax.get('/addons/vacay/plan').then((r: AxiosResponse) => r.data),
  updatePlan: (data) => ax.put('/addons/vacay/plan', data).then((r: AxiosResponse) => r.data),
  updateColor: (color) => ax.put('/addons/vacay/color', { color }).then((r: AxiosResponse) => r.data),
  grantAccess: (viewerId) => ax.post('/addons/vacay/access/grant', { viewer_id: viewerId }).then((r: AxiosResponse) => r.data),
  acceptAccess: (granterId) => ax.post('/addons/vacay/access/accept', { granter_id: granterId }).then((r: AxiosResponse) => r.data),
  declineAccess: (granterId) => ax.post('/addons/vacay/access/decline', { granter_id: granterId }).then((r: AxiosResponse) => r.data),
  cancelAccess: (viewerId) => ax.post('/addons/vacay/access/cancel', { viewer_id: viewerId }).then((r: AxiosResponse) => r.data),
  revokeAccess: (userId) => ax.delete(`/addons/vacay/access/${userId}`).then((r: AxiosResponse) => r.data),
  availableUsersForAccess: () => ax.get('/addons/vacay/access/available-users').then((r: AxiosResponse) => r.data),
  getForeignEntries: (year) => ax.get(`/addons/vacay/access/foreign-entries/${year}`).then((r: AxiosResponse) => r.data),
  getYears: () => ax.get('/addons/vacay/years').then((r: AxiosResponse) => r.data),
  addYear: (year) => ax.post('/addons/vacay/years', { year }).then((r: AxiosResponse) => r.data),
  removeYear: (year) => ax.delete(`/addons/vacay/years/${year}`).then((r: AxiosResponse) => r.data),
  getEntries: (year) => ax.get(`/addons/vacay/entries/${year}`).then((r: AxiosResponse) => r.data),
  toggleEntry: (date) => ax.post('/addons/vacay/entries/toggle', { date }).then((r: AxiosResponse) => r.data),
  toggleCompanyHoliday: (date) => ax.post('/addons/vacay/entries/company-holiday', { date }).then((r: AxiosResponse) => r.data),
  getStats: (year) => ax.get(`/addons/vacay/stats/${year}`).then((r: AxiosResponse) => r.data),
  updateStats: (year, days) => ax.put(`/addons/vacay/stats/${year}`, { vacation_days: days }).then((r: AxiosResponse) => r.data),
  getCountries: () => ax.get('/addons/vacay/holidays/countries').then((r: AxiosResponse) => r.data),
  getHolidays: (year, country) => ax.get(`/addons/vacay/holidays/${year}/${country}`).then((r: AxiosResponse) => r.data),
  addHolidayCalendar: (data) => ax.post('/addons/vacay/plan/holiday-calendars', data).then((r: AxiosResponse) => r.data),
  updateHolidayCalendar: (id, data) => ax.put(`/addons/vacay/plan/holiday-calendars/${id}`, data).then((r: AxiosResponse) => r.data),
  deleteHolidayCalendar: (id) => ax.delete(`/addons/vacay/plan/holiday-calendars/${id}`).then((r: AxiosResponse) => r.data),
}

interface VacayState {
  plan: VacayPlan | null
  myColor: string
  connectedUsers: VacayUser[]
  pendingIncoming: VacayAccessInvite[]
  pendingOutgoing: VacayOutgoingInvite[]
  visibleGranterIds: number[]
  years: number[]
  entries: VacayEntry[]
  companyHolidays: VacayCompanyHoliday[]
  foreignEntries: VacayEntry[]
  stats: VacayStat[]
  selectedYear: number
  holidays: HolidaysMap
  loading: boolean

  setSelectedYear: (year: number) => void
  toggleGranterVisibility: (id: number) => void
  loadPlan: () => Promise<void>
  updatePlan: (updates: Partial<VacayPlan>) => Promise<void>
  updateColor: (color: string) => Promise<void>
  grantAccess: (userId: number) => Promise<void>
  acceptAccess: (granterId: number) => Promise<void>
  declineAccess: (granterId: number) => Promise<void>
  cancelAccess: (viewerId: number) => Promise<void>
  revokeAccess: (userId: number) => Promise<void>
  loadYears: () => Promise<void>
  addYear: (year: number) => Promise<void>
  removeYear: (year: number) => Promise<void>
  loadEntries: (year?: number) => Promise<void>
  loadForeignEntries: (year?: number) => Promise<void>
  toggleEntry: (date: string) => Promise<void>
  toggleCompanyHoliday: (date: string) => Promise<void>
  loadStats: (year?: number) => Promise<void>
  updateVacationDays: (year: number, days: number) => Promise<void>
  loadHolidays: (year?: number) => Promise<void>
  addHolidayCalendar: (data: { region: string; color?: string; label?: string | null }) => Promise<void>
  updateHolidayCalendar: (id: number, data: { region?: string; color?: string; label?: string | null }) => Promise<void>
  deleteHolidayCalendar: (id: number) => Promise<void>
  loadAll: () => Promise<void>
}

export const useVacayStore = create<VacayState>((set, get) => ({
  plan: null,
  myColor: '#6366f1',
  connectedUsers: [],
  pendingIncoming: [],
  pendingOutgoing: [],
  visibleGranterIds: [],
  years: [],
  entries: [],
  companyHolidays: [],
  foreignEntries: [],
  stats: [],
  selectedYear: new Date().getFullYear(),
  holidays: {},
  loading: false,

  setSelectedYear: (year: number) => set({ selectedYear: year }),

  toggleGranterVisibility: (id: number) => {
    const { visibleGranterIds } = get()
    if (visibleGranterIds.includes(id)) {
      set({ visibleGranterIds: visibleGranterIds.filter(gid => gid !== id) })
    } else {
      set({ visibleGranterIds: [...visibleGranterIds, id] })
    }
  },

  loadPlan: async () => {
    const data = await api.getPlan()
    const prev = get().visibleGranterIds
    const connectedUsers: VacayUser[] = data.connectedUsers
    const newConnectedIds = connectedUsers.map((u: VacayUser) => u.id)
    // Keep existing visibility; auto-show newly connected users
    const updated = [
      ...prev.filter(id => newConnectedIds.includes(id)),
      ...newConnectedIds.filter(id => !prev.includes(id)),
    ]
    set({
      plan: data.plan,
      myColor: data.myColor,
      connectedUsers,
      pendingIncoming: data.pendingIncoming,
      pendingOutgoing: data.pendingOutgoing,
      visibleGranterIds: updated,
    })
  },

  updatePlan: async (updates: Partial<VacayPlan>) => {
    const data = await api.updatePlan(updates)
    set({ plan: data.plan })
    await get().loadEntries()
    await get().loadStats()
    await get().loadHolidays()
  },

  updateColor: async (color: string) => {
    await api.updateColor(color)
    const year = get().selectedYear
    await Promise.all([get().loadPlan(), get().loadEntries(year), get().loadStats(year)])
  },

  grantAccess: async (userId: number) => {
    await api.grantAccess(userId)
    await get().loadPlan()
  },

  acceptAccess: async (granterId: number) => {
    await api.acceptAccess(granterId)
    await get().loadAll()
  },

  declineAccess: async (granterId: number) => {
    await api.declineAccess(granterId)
    await get().loadPlan()
  },

  cancelAccess: async (viewerId: number) => {
    await api.cancelAccess(viewerId)
    await get().loadPlan()
  },

  revokeAccess: async (userId: number) => {
    await api.revokeAccess(userId)
    await get().loadAll()
  },

  loadYears: async () => {
    const data = await api.getYears()
    set({ years: data.years })
    if (data.years.length > 0) {
      set({ selectedYear: data.years[data.years.length - 1] })
    }
  },

  addYear: async (year: number) => {
    const data = await api.addYear(year)
    set({ years: data.years })
    await get().loadStats(year)
  },

  removeYear: async (year: number) => {
    const data = await api.removeYear(year)
    const updates: Partial<VacayState> = { years: data.years }
    if (get().selectedYear === year) {
      updates.selectedYear = data.years.length > 0
        ? data.years[data.years.length - 1]
        : new Date().getFullYear()
    }
    set(updates)
    await get().loadStats()
  },

  loadEntries: async (year?: number) => {
    const y = year || get().selectedYear
    const data = await api.getEntries(y)
    set({ entries: data.entries, companyHolidays: data.companyHolidays })
  },

  loadForeignEntries: async (year?: number) => {
    const y = year || get().selectedYear
    const data = await api.getForeignEntries(y)
    set({ foreignEntries: data.entries })
  },

  toggleEntry: async (date: string) => {
    await api.toggleEntry(date)
    await get().loadEntries()
    await get().loadStats()
  },

  toggleCompanyHoliday: async (date: string) => {
    await api.toggleCompanyHoliday(date)
    await get().loadEntries()
    await get().loadStats()
  },

  loadStats: async (year?: number) => {
    const y = year || get().selectedYear
    const data = await api.getStats(y)
    set({ stats: data.stats })
  },

  updateVacationDays: async (year: number, days: number) => {
    await api.updateStats(year, days)
    await get().loadStats(year)
  },

  loadHolidays: async (year?: number) => {
    const y = year || get().selectedYear
    const plan = get().plan
    const calendars = plan?.holiday_calendars ?? []
    if (!plan?.holidays_enabled || calendars.length === 0) {
      set({ holidays: {} })
      return
    }
    const map: HolidaysMap = {}
    for (const cal of calendars) {
      const country = cal.region.split('-')[0]
      const region = cal.region.includes('-') ? cal.region : null
      try {
        const data = await api.getHolidays(y, country)
        const hasRegions = data.some((h: VacayHolidayRaw) => h.counties && h.counties.length > 0)
        if (hasRegions && !region) continue
        data.forEach((h: VacayHolidayRaw) => {
          if (h.global || !h.counties || (region && h.counties.includes(region))) {
            if (!map[h.date]) {
              map[h.date] = { name: h.name, localName: h.localName, color: cal.color, label: cal.label } as HolidayInfo
            }
          }
        })
      } catch { /* API error, skip */ }
    }
    set({ holidays: map })
  },

  addHolidayCalendar: async (data) => {
    await api.addHolidayCalendar(data)
    await get().loadPlan()
    await get().loadHolidays()
  },

  updateHolidayCalendar: async (id, data) => {
    await api.updateHolidayCalendar(id, data)
    await get().loadPlan()
    await get().loadHolidays()
  },

  deleteHolidayCalendar: async (id) => {
    await api.deleteHolidayCalendar(id)
    await get().loadPlan()
    await get().loadHolidays()
  },

  loadAll: async () => {
    set({ loading: true })
    try {
      await get().loadPlan()
      await get().loadYears()
      const year = get().selectedYear
      await Promise.all([
        get().loadEntries(year),
        get().loadStats(year),
        get().loadHolidays(year),
        get().loadForeignEntries(year),
      ])
    } finally {
      set({ loading: false })
    }
  },
}))
