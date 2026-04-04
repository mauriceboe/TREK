import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const reactionUser = v.object({
  user_id: v.string(),
  username: v.string(),
});

export default defineSchema({
  // ── Users ──────────────────────────────────────────────
  plannerUsers: defineTable({
    legacyUserId: v.number(),
    authUserKey: v.string(),
    betterAuthUserId: v.optional(v.string()),
    username: v.string(),
    email: v.string(),
    role: v.string(),
    avatarUrl: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_legacyUserId', ['legacyUserId'])
    .index('by_authUserKey', ['authUserKey']),

  // ── Trips ──────────────────────────────────────────────
  plannerTrips: defineTable({
    legacyId: v.optional(v.number()),
    ownerLegacyUserId: v.optional(v.number()),
    ownerAuthUserKey: v.string(),
    title: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    startDate: v.optional(v.union(v.string(), v.null())),
    endDate: v.optional(v.union(v.string(), v.null())),
    currency: v.string(),
    coverImage: v.optional(v.union(v.string(), v.null())),
    isArchived: v.boolean(),
    destinationName: v.optional(v.union(v.string(), v.null())),
    destinationAddress: v.optional(v.union(v.string(), v.null())),
    destinationLat: v.optional(v.union(v.number(), v.null())),
    destinationLng: v.optional(v.union(v.number(), v.null())),
    destinationViewportSouth: v.optional(v.union(v.number(), v.null())),
    destinationViewportWest: v.optional(v.union(v.number(), v.null())),
    destinationViewportNorth: v.optional(v.union(v.number(), v.null())),
    destinationViewportEast: v.optional(v.union(v.number(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_ownerAuthUserKey', ['ownerAuthUserKey']),

  plannerTripMembers: defineTable({
    legacyId: v.optional(v.number()),
    tripId: v.id('plannerTrips'),
    memberLegacyUserId: v.optional(v.number()),
    memberAuthUserKey: v.string(),
    invitedByLegacyUserId: v.optional(v.union(v.number(), v.null())),
    addedAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_trip_memberAuthUserKey', ['tripId', 'memberAuthUserKey'])
    .index('by_memberAuthUserKey', ['memberAuthUserKey']),

  // ── Days ───────────────────────────────────────────────
  plannerDays: defineTable({
    legacyId: v.optional(v.number()),
    tripId: v.id('plannerTrips'),
    dayNumber: v.number(),
    date: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    title: v.optional(v.union(v.string(), v.null())),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_trip_dayNumber', ['tripId', 'dayNumber']),

  // ── Places ─────────────────────────────────────────────
  plannerPlaces: defineTable({
    legacyId: v.optional(v.number()),
    tripId: v.id('plannerTrips'),
    name: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    lat: v.optional(v.union(v.number(), v.null())),
    lng: v.optional(v.union(v.number(), v.null())),
    address: v.optional(v.union(v.string(), v.null())),
    categoryId: v.optional(v.union(v.id('plannerCategories'), v.null())),
    price: v.optional(v.union(v.number(), v.null())),
    currency: v.optional(v.union(v.string(), v.null())),
    reservationStatus: v.optional(v.string()),
    reservationNotes: v.optional(v.union(v.string(), v.null())),
    reservationDatetime: v.optional(v.union(v.string(), v.null())),
    placeTime: v.optional(v.union(v.string(), v.null())),
    endTime: v.optional(v.union(v.string(), v.null())),
    durationMinutes: v.optional(v.number()),
    notes: v.optional(v.union(v.string(), v.null())),
    imageUrl: v.optional(v.union(v.string(), v.null())),
    googlePlaceId: v.optional(v.union(v.string(), v.null())),
    website: v.optional(v.union(v.string(), v.null())),
    phone: v.optional(v.union(v.string(), v.null())),
    transportMode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_tripId', ['tripId'])
    .index('by_trip_createdAt', ['tripId', 'createdAt']),

  // ── Day Assignments ────────────────────────────────────
  plannerDayAssignments: defineTable({
    legacyId: v.optional(v.number()),
    tripId: v.id('plannerTrips'),
    dayId: v.id('plannerDays'),
    placeId: v.id('plannerPlaces'),
    orderIndex: v.number(),
    notes: v.optional(v.union(v.string(), v.null())),
    assignmentTime: v.optional(v.union(v.string(), v.null())),
    assignmentEndTime: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_dayId_orderIndex', ['dayId', 'orderIndex'])
    .index('by_placeId', ['placeId'])
    .index('by_tripId', ['tripId']),

  // ── Assignment Participants ────────────────────────────
  plannerAssignmentParticipants: defineTable({
    assignmentId: v.id('plannerDayAssignments'),
    userAuthKey: v.string(),
  })
    .index('by_assignmentId', ['assignmentId']),

  // ── Trip Legs ──────────────────────────────────────────
  plannerTripLegs: defineTable({
    legacyId: v.optional(v.number()),
    tripId: v.id('plannerTrips'),
    destinationName: v.string(),
    destinationAddress: v.optional(v.union(v.string(), v.null())),
    destinationLat: v.optional(v.union(v.number(), v.null())),
    destinationLng: v.optional(v.union(v.number(), v.null())),
    destinationViewportSouth: v.optional(v.union(v.number(), v.null())),
    destinationViewportWest: v.optional(v.union(v.number(), v.null())),
    destinationViewportNorth: v.optional(v.union(v.number(), v.null())),
    destinationViewportEast: v.optional(v.union(v.number(), v.null())),
    startDayNumber: v.number(),
    endDayNumber: v.number(),
    color: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_tripId', ['tripId'])
    .index('by_tripId_range', ['tripId', 'startDayNumber']),

  // ── Categories ─────────────────────────────────────────
  plannerCategories: defineTable({
    legacyId: v.optional(v.number()),
    name: v.string(),
    color: v.string(),
    icon: v.string(),
    ownerAuthUserKey: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_ownerAuthUserKey', ['ownerAuthUserKey']),

  // ── Tags ───────────────────────────────────────────────
  plannerTags: defineTable({
    legacyId: v.optional(v.number()),
    name: v.string(),
    color: v.string(),
    ownerAuthUserKey: v.string(),
    createdAt: v.number(),
  })
    .index('by_legacyId', ['legacyId'])
    .index('by_ownerAuthUserKey', ['ownerAuthUserKey']),

  // ── Place–Tag join ─────────────────────────────────────
  plannerPlaceTags: defineTable({
    placeId: v.id('plannerPlaces'),
    tagId: v.id('plannerTags'),
  })
    .index('by_placeId', ['placeId'])
    .index('by_tagId', ['tagId']),

  // ── Day Notes ──────────────────────────────────────────
  plannerDayNotes: defineTable({
    legacyId: v.optional(v.number()),
    dayId: v.id('plannerDays'),
    tripId: v.id('plannerTrips'),
    text: v.string(),
    time: v.optional(v.union(v.string(), v.null())),
    icon: v.string(),
    sortOrder: v.number(),
    createdAt: v.number(),
  })
    .index('by_dayId', ['dayId'])
    .index('by_tripId', ['tripId']),

  // ── Accommodations ─────────────────────────────────────
  plannerAccommodations: defineTable({
    legacyId: v.optional(v.number()),
    tripId: v.id('plannerTrips'),
    placeId: v.id('plannerPlaces'),
    startDayId: v.id('plannerDays'),
    endDayId: v.id('plannerDays'),
    checkIn: v.optional(v.union(v.string(), v.null())),
    checkOut: v.optional(v.union(v.string(), v.null())),
    confirmation: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  // ── Chat Messages ──────────────────────────────────────
  messages: defineTable({
    tripId: v.number(),
    authorId: v.string(),
    authorName: v.string(),
    authorAvatarUrl: v.optional(v.union(v.string(), v.null())),
    text: v.string(),
    deleted: v.boolean(),
    replyToMessageId: v.optional(v.id('messages')),
    replyPreview: v.optional(v.object({
      text: v.string(),
      username: v.string(),
    })),
    reactions: v.array(v.object({
      emoji: v.string(),
      count: v.number(),
      users: v.array(reactionUser),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_trip_createdAt', ['tripId', 'createdAt']),
});
