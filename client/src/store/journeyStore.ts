import { create } from 'zustand'
import { journeyApi } from '../api/client'

export interface Journey {
  id: number
  user_id: number
  title: string
  subtitle?: string | null
  cover_gradient?: string | null
  cover_image?: string | null
  status: 'draft' | 'active' | 'completed'
  created_at: number
  updated_at: number
}

export interface JourneyEntry {
  id: number
  journey_id: number
  source_trip_id?: number | null
  source_place_id?: number | null
  source_trip_name?: string | null
  author_id: number
  type: 'entry' | 'checkin' | 'skeleton'
  title?: string | null
  story?: string | null
  entry_date: string
  entry_time?: string | null
  location_name?: string | null
  location_lat?: number | null
  location_lng?: number | null
  mood?: string | null
  weather?: string | null
  tags?: string[]
  pros_cons?: { pros: string[]; cons: string[] } | null
  visibility: string
  sort_order: number
  photos: JourneyPhoto[]
  created_at: number
  updated_at: number
}

export interface JourneyPhoto {
  id: number
  entry_id: number
  photo_id: number
  caption?: string | null
  sort_order: number
  shared: number
  created_at: number
  // Joined from trek_photos for display
  provider?: string
  asset_id?: string | null
  owner_id?: number | null
  file_path?: string | null
  thumbnail_path?: string | null
  width?: number | null
  height?: number | null
}

export interface JourneyTrip {
  trip_id: number
  added_at: number
  title: string
  start_date?: string | null
  end_date?: string | null
  cover_image?: string | null
  currency?: string
  place_count: number
}

export interface JourneyContributor {
  journey_id: number
  user_id: number
  role: 'owner' | 'editor' | 'viewer'
  added_at: number
  username: string
  avatar?: string | null
}

export interface JourneyDetail extends Journey {
  entries: JourneyEntry[]
  trips: JourneyTrip[]
  contributors: JourneyContributor[]
  stats: { entries: number; photos: number; cities: number }
  hide_skeletons?: boolean
}

interface JourneyState {
  journeys: Journey[]
  current: JourneyDetail | null
  loading: boolean
  notFound: boolean

  loadJourneys: () => Promise<void>
  loadJourney: (id: number) => Promise<void>
  createJourney: (data: { title: string; subtitle?: string; trip_ids?: number[] }) => Promise<Journey>
  updateJourney: (id: number, data: Record<string, unknown>) => Promise<void>
  deleteJourney: (id: number) => Promise<void>

  createEntry: (journeyId: number, data: Record<string, unknown>) => Promise<JourneyEntry>
  updateEntry: (entryId: number, data: Record<string, unknown>) => Promise<void>
  deleteEntry: (entryId: number) => Promise<void>

  uploadPhotos: (entryId: number, formData: FormData) => Promise<JourneyPhoto[]>
  deletePhoto: (photoId: number) => Promise<void>

  clear: () => void
}

export const useJourneyStore = create<JourneyState>((set, get) => ({
  journeys: [],
  current: null,
  loading: false,
  notFound: false,

  loadJourneys: async () => {
    set({ loading: true })
    try {
      const data = await journeyApi.list()
      set({ journeys: data.journeys || [] })
    } finally {
      set({ loading: false })
    }
  },

  loadJourney: async (id) => {
    const cold = get().current?.id !== id
    if (cold) set({ loading: true, notFound: false })
    try {
      const data = await journeyApi.get(id)
      set({ current: data })
    } catch (err: any) {
      if (err?.response?.status === 404) {
        set({ current: null, notFound: true })
      }
      throw err
    } finally {
      if (cold) set({ loading: false })
    }
  },

  createJourney: async (data) => {
    const journey = await journeyApi.create(data)
    set(s => ({ journeys: [journey, ...s.journeys] }))
    return journey
  },

  updateJourney: async (id, data) => {
    const updated = await journeyApi.update(id, data)
    set(s => ({
      journeys: s.journeys.map(j => j.id === id ? { ...j, ...updated } : j),
      current: s.current?.id === id ? { ...s.current, ...updated } : s.current,
    }))
  },

  deleteJourney: async (id) => {
    await journeyApi.delete(id)
    set(s => ({
      journeys: s.journeys.filter(j => j.id !== id),
      current: s.current?.id === id ? null : s.current,
    }))
  },

  createEntry: async (journeyId, data) => {
    const entry = await journeyApi.createEntry(journeyId, data)
    entry.photos = entry.photos || []
    set(s => {
      if (s.current?.id !== journeyId) return s
      return { current: { ...s.current, entries: [...s.current.entries, entry] } }
    })
    return entry
  },

  updateEntry: async (entryId, data) => {
    const updated = await journeyApi.updateEntry(entryId, data)
    set(s => {
      if (!s.current) return s
      return { current: { ...s.current, entries: s.current.entries.map(e => e.id === entryId ? { ...e, ...updated } : e) } }
    })
  },

  deleteEntry: async (entryId) => {
    await journeyApi.deleteEntry(entryId)
    set(s => {
      if (!s.current) return s
      return { current: { ...s.current, entries: s.current.entries.filter(e => e.id !== entryId) } }
    })
  },

  uploadPhotos: async (entryId, formData) => {
    const data = await journeyApi.uploadPhotos(entryId, formData)
    const photos = data.photos || []
    set(s => {
      if (!s.current) return s
      return {
        current: {
          ...s.current,
          entries: s.current.entries.map(e =>
            e.id === entryId ? { ...e, photos: [...(e.photos || []), ...photos] } : e
          ),
        },
      }
    })
    return photos
  },

  deletePhoto: async (photoId) => {
    await journeyApi.deletePhoto(photoId)
    set(s => {
      if (!s.current) return s
      return {
        current: {
          ...s.current,
          entries: s.current.entries.map(e => ({
            ...e,
            photos: (e.photos || []).filter(p => p.id !== photoId),
          })),
        },
      }
    })
  },

  clear: () => set({ journeys: [], current: null, loading: false }),
}))
