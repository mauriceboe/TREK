import type { Assignment, DayNote, Reservation } from '../types'

export type MergedPlanItem =
  | { type: 'place'; sortKey: number; data: Assignment }
  | { type: 'note'; sortKey: number; data: DayNote }

export type TimeBucket = 0 | 1 | 2 | 3

type ReservationWithAssignment = Reservation & { assignment_id?: number; reservation_time?: string }

export function parseHHMMToMinutes(s: string | null | undefined): number | null {
  if (!s || typeof s !== 'string') return null
  const parts = s.trim().split(':')
  if (parts.length < 2) return null
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

export function parseNoteTimeMinutes(s: string | null | undefined): number | null {
  if (!s || typeof s !== 'string') return null
  const match = s.match(/\b(\d{1,2}):(\d{2})\b/)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/** Morning 5:00–11:59, afternoon 12:00–16:59, evening otherwise (incl. night / early hours). */
export function minutesToBucket(mins: number): 1 | 2 | 3 {
  if (mins >= 300 && mins < 720) return 1
  if (mins >= 720 && mins < 1020) return 2
  return 3
}

export function getMergedItemTimeMeta(
  item: MergedPlanItem,
  reservations: Reservation[]
): { bucket: TimeBucket; minutes: number; sortKey: number } {
  const sortKey = item.sortKey
  if (item.type === 'place') {
    const a = item.data
    let mins = parseHHMMToMinutes(a.place?.place_time)
    if (mins == null) {
      const res = reservations.find((r) => (r as ReservationWithAssignment).assignment_id === a.id) as
        | ReservationWithAssignment
        | undefined
      const rt = res?.reservation_time
      if (rt?.includes('T')) {
        try {
          const d = new Date(rt)
          mins = d.getHours() * 60 + d.getMinutes()
        } catch { /* ignore */ }
      }
    }
    if (mins == null) return { bucket: 0, minutes: 0, sortKey }
    return { bucket: minutesToBucket(mins), minutes: mins, sortKey }
  }
  const mins = parseNoteTimeMinutes(item.data.time)
  if (mins == null) return { bucket: 0, minutes: 0, sortKey }
  return { bucket: minutesToBucket(mins), minutes: mins, sortKey }
}

export function sortMergedByTimeOfDayIfNeeded(merged: MergedPlanItem[], reservations: Reservation[]): MergedPlanItem[] {
  const metas = merged.map((item) => getMergedItemTimeMeta(item, reservations))
  const hasAnyTimed = metas.some((m) => m.bucket > 0)
  if (!hasAnyTimed) return merged
  const decorated = merged.map((item, index) => ({ item, meta: metas[index], index }))
  decorated.sort((A, B) => {
    const ta = A.meta.bucket > 0
    const tb = B.meta.bucket > 0
    if (!ta && !tb) return A.item.sortKey - B.item.sortKey || A.index - B.index
    if (!ta && tb) return -1
    if (ta && !tb) return 1
    if (A.meta.bucket !== B.meta.bucket) return A.meta.bucket - B.meta.bucket
    if (A.meta.minutes !== B.meta.minutes) return A.meta.minutes - B.meta.minutes
    return A.item.sortKey - B.item.sortKey || A.index - B.index
  })
  return decorated.map((d) => d.item)
}

export function timeBucketLabel(bucket: TimeBucket, t: (key: string) => string): string {
  if (bucket === 1) return t('dayplan.timeMorning')
  if (bucket === 2) return t('dayplan.timeAfternoon')
  return t('dayplan.timeEvening')
}
