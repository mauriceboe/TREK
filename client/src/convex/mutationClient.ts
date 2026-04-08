/**
 * Non-React Convex mutation client for use in Zustand store slices.
 *
 * This wraps the ConvexReactClient to call mutations directly,
 * bypassing React hooks (which can't be used in Zustand).
 *
 * The reactive queries in useConvexTripData automatically pick up
 * changes made through these mutations — no manual store updates needed
 * for reads, only optimistic updates during the mutation.
 */
import { convexClient } from './provider'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

function getClient() {
  if (!convexClient) throw new Error('Convex is not configured')
  return convexClient
}

// ── Trips ────────────────────────────────────────────────

export async function convexListTrips() {
  const client = getClient()
  return client.query(api.trips.listTrips, {})
}

export async function convexResolveTripId(tripParam: string) {
  const client = getClient()
  return client.query(api.trips.resolveTripId, { tripParam })
}

export async function convexGetTrip(tripId: Id<'plannerTrips'>) {
  const client = getClient()
  return client.query(api.trips.getTrip, { tripId })
}

export async function convexCreateTrip(data: Record<string, any>) {
  const client = getClient()
  return client.mutation(api.trips.createTrip, {
    title: data.name ?? data.title,
    description: data.description,
    startDate: data.start_date ?? data.startDate,
    endDate: data.end_date ?? data.endDate,
    currency: data.currency,
    destinationName: data.destination_name ?? data.destinationName,
    destinationAddress: data.destination_address ?? data.destinationAddress,
    destinationLat: toOptionalNumber(data.destination_lat ?? data.destinationLat),
    destinationLng: toOptionalNumber(data.destination_lng ?? data.destinationLng),
    destinationViewportSouth: toOptionalNumber(data.destination_viewport_south ?? data.destinationViewportSouth),
    destinationViewportWest: toOptionalNumber(data.destination_viewport_west ?? data.destinationViewportWest),
    destinationViewportNorth: toOptionalNumber(data.destination_viewport_north ?? data.destinationViewportNorth),
    destinationViewportEast: toOptionalNumber(data.destination_viewport_east ?? data.destinationViewportEast),
  } as any)
}

export async function convexDeleteTrip(tripId: Id<'plannerTrips'>) {
  const client = getClient()
  return client.mutation(api.trips.deleteTrip, { tripId })
}

export async function convexArchiveTrip(tripId: Id<'plannerTrips'>) {
  const client = getClient()
  return client.mutation(api.trips.archiveTrip, { tripId })
}

export async function convexUnarchiveTrip(tripId: Id<'plannerTrips'>) {
  const client = getClient()
  return client.mutation(api.trips.unarchiveTrip, { tripId })
}

export async function convexCopyTrip(tripId: Id<'plannerTrips'>, title?: string) {
  const client = getClient()
  return client.mutation(api.trips.copyTrip, { tripId, title })
}

export async function convexGetTripMembers(tripId: Id<'plannerTrips'>) {
  const client = getClient()
  return client.query(api.trips.getTripMembers, { tripId })
}

export async function convexAddTripMember(tripId: Id<'plannerTrips'>, identifier: string) {
  const client = getClient()
  // Try email first, then username
  const isEmail = identifier.includes('@')
  return client.mutation(api.trips.addTripMember, {
    tripId,
    ...(isEmail ? { email: identifier } : { username: identifier }),
  } as any)
}

export async function convexRemoveTripMember(tripId: Id<'plannerTrips'>, memberAuthUserKey: string) {
  const client = getClient()
  return client.mutation(api.trips.removeTripMember, { tripId, memberAuthUserKey })
}

export async function convexUpdateTrip(
  tripId: Id<'plannerTrips'>,
  data: Record<string, any>,
) {
  const client = getClient()
  return client.mutation(api.trips.updateTrip, {
    tripId,
    title: data.name ?? data.title,
    description: data.description,
    startDate: data.start_date ?? data.startDate,
    endDate: data.end_date ?? data.endDate,
    currency: data.currency,
    destinationName: data.destination_name ?? data.destinationName,
    destinationAddress: data.destination_address ?? data.destinationAddress,
    destinationLat: toOptionalNumber(data.destination_lat ?? data.destinationLat),
    destinationLng: toOptionalNumber(data.destination_lng ?? data.destinationLng),
    destinationViewportSouth: toOptionalNumber(data.destination_viewport_south ?? data.destinationViewportSouth),
    destinationViewportWest: toOptionalNumber(data.destination_viewport_west ?? data.destinationViewportWest),
    destinationViewportNorth: toOptionalNumber(data.destination_viewport_north ?? data.destinationViewportNorth),
    destinationViewportEast: toOptionalNumber(data.destination_viewport_east ?? data.destinationViewportEast),
  } as any)
}

// ── Places ───────────────────────────────────────────────

function toOptionalNumber(value: unknown): number | null | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function convexCreatePlace(
  tripId: Id<'plannerTrips'>,
  data: Record<string, any>,
) {
  const client = getClient()
  return client.mutation(api.places.createPlace, {
    tripId,
    name: data.name,
    description: data.description,
    lat: toOptionalNumber(data.lat),
    lng: toOptionalNumber(data.lng),
    address: data.address,
    categoryId: (data.category_id ?? data.categoryId) || null,
    price: data.price != null ? Number(data.price) : undefined,
    notes: data.notes,
    imageUrl: data.image_url ?? data.imageUrl,
    googlePlaceId: data.google_place_id ?? data.googlePlaceId,
    website: data.website,
    phone: data.phone,
    transportMode: data.transport_mode ?? data.transportMode,
    placeTime: data.place_time ?? data.placeTime,
    endTime: data.end_time ?? data.endTime,
    tagIds: data.tag_ids ?? data.tagIds,
  } as any)
}

export async function convexUpdatePlace(
  tripId: Id<'plannerTrips'>,
  placeId: Id<'plannerPlaces'>,
  data: Record<string, any>,
) {
  const client = getClient()
  return client.mutation(api.places.updatePlace, {
    tripId,
    placeId,
    name: data.name,
    description: data.description,
    lat: toOptionalNumber(data.lat),
    lng: toOptionalNumber(data.lng),
    address: data.address,
    categoryId: (data.category_id ?? data.categoryId) || null,
    price: data.price != null ? Number(data.price) : undefined,
    notes: data.notes,
    imageUrl: data.image_url ?? data.imageUrl,
    googlePlaceId: data.google_place_id ?? data.googlePlaceId,
    website: data.website,
    phone: data.phone,
    transportMode: data.transport_mode ?? data.transportMode,
    placeTime: data.place_time ?? data.placeTime,
    endTime: data.end_time ?? data.endTime,
    tagIds: data.tag_ids ?? data.tagIds,
  } as any)
}

export async function convexDeletePlace(
  tripId: Id<'plannerTrips'>,
  placeId: Id<'plannerPlaces'>,
) {
  const client = getClient()
  return client.mutation(api.places.deletePlace, { tripId, placeId })
}

// ── Assignments ──────────────────────────────────────────

export async function convexAssignPlace(
  tripId: Id<'plannerTrips'>,
  dayId: Id<'plannerDays'>,
  placeId: Id<'plannerPlaces'>,
) {
  const client = getClient()
  return client.mutation(api.assignments.assignPlace, { tripId, dayId, placeId })
}

export async function convexRemoveAssignment(
  tripId: Id<'plannerTrips'>,
  assignmentId: Id<'plannerDayAssignments'>,
) {
  const client = getClient()
  return client.mutation(api.assignments.removeAssignment, { tripId, assignmentId })
}

export async function convexReorderAssignments(
  tripId: Id<'plannerTrips'>,
  dayId: Id<'plannerDays'>,
  orderedIds: Id<'plannerDayAssignments'>[],
) {
  const client = getClient()
  return client.mutation(api.assignments.reorderAssignments, { tripId, dayId, orderedIds })
}

export async function convexMoveAssignment(
  tripId: Id<'plannerTrips'>,
  assignmentId: Id<'plannerDayAssignments'>,
  newDayId: Id<'plannerDays'>,
  orderIndex: number,
) {
  const client = getClient()
  return client.mutation(api.assignments.moveAssignment, { tripId, assignmentId, newDayId, orderIndex })
}

export async function convexUpdateAssignmentTime(
  tripId: Id<'plannerTrips'>,
  assignmentId: Id<'plannerDayAssignments'>,
  times: { place_time?: string | null; end_time?: string | null },
) {
  const client = getClient()
  return client.mutation(api.assignments.updateAssignmentTime, {
    tripId,
    assignmentId,
    assignmentTime: times.place_time ?? null,
    assignmentEndTime: times.end_time ?? null,
  })
}

export async function convexSetAssignmentParticipants(
  tripId: Id<'plannerTrips'>,
  assignmentId: Id<'plannerDayAssignments'>,
  userAuthKeys: string[],
) {
  const client = getClient()
  return client.mutation(api.assignments.setParticipants, {
    tripId,
    assignmentId,
    userAuthKeys,
  })
}

// ── Day Notes ────────────────────────────────────────────

export async function convexUpdateDay(
  tripId: Id<'plannerTrips'>,
  dayId: Id<'plannerDays'>,
  data: { notes?: string; title?: string },
) {
  const client = getClient()
  return client.mutation(api.days.updateDay, { tripId, dayId, ...data } as any)
}

export async function convexCreateDayNote(
  tripId: Id<'plannerTrips'>,
  dayId: Id<'plannerDays'>,
  data: Record<string, any>,
) {
  const client = getClient()
  return client.mutation(api.days.createDayNote as any, {
    tripId,
    dayId,
    text: data.text || '',
    time: data.time,
    icon: data.icon || '📝',
    sortOrder: data.sort_order ?? data.sortOrder ?? 0,
  } as any)
}

export async function convexUpdateDayNote(
  noteId: Id<'plannerDayNotes'>,
  data: Record<string, any>,
) {
  const client = getClient()
  return client.mutation(api.days.updateDayNote as any, {
    noteId,
    text: data.text,
    time: data.time,
    icon: data.icon,
    sortOrder: data.sort_order ?? data.sortOrder,
  } as any)
}

export async function convexDeleteDayNote(noteId: Id<'plannerDayNotes'>) {
  const client = getClient()
  return client.mutation(api.days.deleteDayNote as any, { noteId } as any)
}

// ── Legs ─────────────────────────────────────────────────

export async function convexCreateLeg(
  tripId: Id<'plannerTrips'>,
  data: Record<string, any>,
) {
  const client = getClient()
  return client.mutation(api.legs.createLeg, {
    tripId,
    destinationName: data.destination_name ?? data.destinationName,
    destinationAddress: data.destination_address ?? data.destinationAddress,
    destinationLat: toOptionalNumber(data.destination_lat ?? data.destinationLat),
    destinationLng: toOptionalNumber(data.destination_lng ?? data.destinationLng),
    destinationViewportSouth: toOptionalNumber(data.destination_viewport_south ?? data.destinationViewportSouth),
    destinationViewportWest: toOptionalNumber(data.destination_viewport_west ?? data.destinationViewportWest),
    destinationViewportNorth: toOptionalNumber(data.destination_viewport_north ?? data.destinationViewportNorth),
    destinationViewportEast: toOptionalNumber(data.destination_viewport_east ?? data.destinationViewportEast),
    startDayNumber: data.start_day_number ?? data.startDayNumber,
    endDayNumber: data.end_day_number ?? data.endDayNumber,
    color: data.color,
  } as any)
}

export async function convexUpdateLeg(
  tripId: Id<'plannerTrips'>,
  legId: Id<'plannerTripLegs'>,
  data: Record<string, any>,
) {
  const client = getClient()
  return client.mutation(api.legs.updateLeg, {
    tripId,
    legId,
    destinationName: data.destination_name ?? data.destinationName,
    destinationAddress: data.destination_address ?? data.destinationAddress,
    destinationLat: toOptionalNumber(data.destination_lat ?? data.destinationLat),
    destinationLng: toOptionalNumber(data.destination_lng ?? data.destinationLng),
    destinationViewportSouth: toOptionalNumber(data.destination_viewport_south ?? data.destinationViewportSouth),
    destinationViewportWest: toOptionalNumber(data.destination_viewport_west ?? data.destinationViewportWest),
    destinationViewportNorth: toOptionalNumber(data.destination_viewport_north ?? data.destinationViewportNorth),
    destinationViewportEast: toOptionalNumber(data.destination_viewport_east ?? data.destinationViewportEast),
    startDayNumber: data.start_day_number ?? data.startDayNumber,
    endDayNumber: data.end_day_number ?? data.endDayNumber,
    color: data.color,
  } as any)
}

export async function convexDeleteLeg(
  tripId: Id<'plannerTrips'>,
  legId: Id<'plannerTripLegs'>,
) {
  const client = getClient()
  return client.mutation(api.legs.deleteLeg, { tripId, legId })
}

// ── Tags & Categories ────────────────────────────────────

export async function convexCreateTag(data: Record<string, any>) {
  const client = getClient()
  return client.mutation(api.tags.createTag, {
    name: data.name,
    color: data.color || '#6b7280',
  })
}

export async function convexCreateCategory(data: Record<string, any>) {
  const client = getClient()
  return client.mutation(api.categories.createCategory, {
    name: data.name,
    color: data.color || '#6b7280',
    icon: data.icon || '📍',
  })
}
