import type { TripPhoto } from './types'

interface VisibleMemoriesInput {
  tripPhotos: TripPhoto[]
  currentUserId?: number
  locationFilter: string
  sortAsc: boolean
}

interface VisibleMemoriesResult {
  ownPhotos: TripPhoto[]
  othersPhotos: TripPhoto[]
  allVisibleRaw: TripPhoto[]
  allVisible: TripPhoto[]
  locations: string[]
}

export function deriveVisibleMemories({
  tripPhotos,
  currentUserId,
  locationFilter,
  sortAsc,
}: VisibleMemoriesInput): VisibleMemoriesResult {
  const ownPhotos = tripPhotos.filter(p => p.user_id === currentUserId)
  const othersPhotos = tripPhotos.filter(p => p.user_id !== currentUserId && p.shared)
  const allVisibleRaw = [...ownPhotos, ...othersPhotos]

  const locations = [...new Set(allVisibleRaw.map(p => p.city).filter(Boolean) as string[])].sort()

  const allVisible = allVisibleRaw
    .filter(p => !locationFilter || p.city === locationFilter)
    .sort((a, b) => {
      const da = new Date(a.added_at || 0).getTime()
      const db = new Date(b.added_at || 0).getTime()
      return sortAsc ? da - db : db - da
    })

  return {
    ownPhotos,
    othersPhotos,
    allVisibleRaw,
    allVisible,
    locations,
  }
}
