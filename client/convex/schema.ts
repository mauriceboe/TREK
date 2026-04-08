import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const reactionUser = v.object({
  user_id: v.string(),
  username: v.string(),
});

export default defineSchema({
  // ── Users ──────────────────────────────────────────────
  plannerUsers: defineTable({
    legacyUserId: v.optional(v.number()),
    authUserKey: v.string(),
    betterAuthUserId: v.optional(v.string()),
    username: v.string(),
    email: v.string(),
    role: v.string(),
    avatarUrl: v.optional(v.union(v.string(), v.null())),
    mapsApiKey: v.optional(v.union(v.string(), v.null())),
    openweatherApiKey: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_legacyUserId', ['legacyUserId'])
    .index('by_authUserKey', ['authUserKey'])
    .index('by_email', ['email']),

  // ── App Settings ───────────────────────────────────────
  appSettings: defineTable({
    key: v.string(),
    value: v.string(),
  })
    .index('by_key', ['key']),

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

  // ── Budget Items ───────────────────────────────────────
  plannerBudgetItems: defineTable({
    tripId: v.id('plannerTrips'),
    name: v.string(),
    amount: v.number(),
    totalPrice: v.optional(v.union(v.number(), v.null())),
    currency: v.string(),
    category: v.optional(v.union(v.string(), v.null())),
    paidByAuthKey: v.optional(v.union(v.string(), v.null())),
    persons: v.number(),
    days: v.optional(v.number()),
    expenseDate: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  plannerBudgetMembers: defineTable({
    budgetItemId: v.id('plannerBudgetItems'),
    userAuthKey: v.string(),
    paid: v.boolean(),
  })
    .index('by_budgetItemId', ['budgetItemId']),

  // ── Packing Items ──────────────────────────────────────
  plannerPackingItems: defineTable({
    tripId: v.id('plannerTrips'),
    name: v.string(),
    category: v.optional(v.union(v.string(), v.null())),
    checked: v.number(),
    quantity: v.number(),
    weightGrams: v.optional(v.union(v.number(), v.null())),
    bagId: v.optional(v.union(v.string(), v.null())),
    sortOrder: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  // ── Reservations ───────────────────────────────────────
  plannerReservations: defineTable({
    tripId: v.id('plannerTrips'),
    name: v.string(),
    type: v.optional(v.union(v.string(), v.null())),
    status: v.string(),
    date: v.optional(v.union(v.string(), v.null())),
    time: v.optional(v.union(v.string(), v.null())),
    reservationTime: v.optional(v.union(v.string(), v.null())),
    reservationEndTime: v.optional(v.union(v.string(), v.null())),
    location: v.optional(v.union(v.string(), v.null())),
    confirmationNumber: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    url: v.optional(v.union(v.string(), v.null())),
    assignmentId: v.optional(v.union(v.id('plannerDayAssignments'), v.null())),
    accommodationId: v.optional(v.union(v.id('plannerAccommodations'), v.null())),
    dayPlanPosition: v.optional(v.union(v.number(), v.null())),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  // ── User Settings ──────────────────────────────────────
  userSettings: defineTable({
    authUserKey: v.string(),
    key: v.string(),
    value: v.string(),
  })
    .index('by_authUserKey_key', ['authUserKey', 'key'])
    .index('by_authUserKey', ['authUserKey']),

  // ── Addons ─────────────────────────────────────────────
  addons: defineTable({
    addonId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    type: v.string(),
    icon: v.optional(v.string()),
    enabled: v.boolean(),
    sortOrder: v.number(),
  })
    .index('by_addonId', ['addonId']),

  // ── Collab Notes ───────────────────────────────────────
  plannerCollabNotes: defineTable({
    tripId: v.id('plannerTrips'),
    authorAuthUserKey: v.string(),
    title: v.string(),
    content: v.optional(v.union(v.string(), v.null())),
    category: v.optional(v.union(v.string(), v.null())),
    color: v.optional(v.union(v.string(), v.null())),
    pinned: v.optional(v.boolean()),
    website: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  // ── Collab Note Files ─────────────────────────────────
  plannerCollabNoteFiles: defineTable({
    noteId: v.id('plannerCollabNotes'),
    tripId: v.id('plannerTrips'),
    storageId: v.id('_storage'),
    filename: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
    uploadedBy: v.string(),
    createdAt: v.number(),
  })
    .index('by_noteId', ['noteId'])
    .index('by_tripId', ['tripId']),

  // ── Collab Polls ──────────────────────────────────────
  plannerCollabPolls: defineTable({
    tripId: v.id('plannerTrips'),
    authorAuthUserKey: v.string(),
    question: v.string(),
    options: v.array(v.string()),
    multiple: v.optional(v.boolean()),
    closed: v.optional(v.boolean()),
    deadline: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  // ── Collab Poll Votes ─────────────────────────────────
  plannerCollabPollVotes: defineTable({
    pollId: v.id('plannerCollabPolls'),
    voterAuthUserKey: v.string(),
    optionIndex: v.number(),
    createdAt: v.number(),
  })
    .index('by_pollId', ['pollId'])
    .index('by_pollId_voter', ['pollId', 'voterAuthUserKey']),

  // ── Share Tokens ──────────────────────────────────────
  plannerShareTokens: defineTable({
    tripId: v.id('plannerTrips'),
    token: v.string(),
    createdBy: v.string(),
    shareMap: v.optional(v.boolean()),
    shareBookings: v.optional(v.boolean()),
    sharePacking: v.optional(v.boolean()),
    shareBudget: v.optional(v.boolean()),
    shareCollab: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index('by_tripId', ['tripId'])
    .index('by_token', ['token']),

  // ── In-App Notifications ──────────────────────────────
  plannerNotifications: defineTable({
    type: v.string(),
    scope: v.string(),
    recipientAuthUserKey: v.string(),
    senderAuthUserKey: v.optional(v.union(v.string(), v.null())),
    tripId: v.optional(v.union(v.id('plannerTrips'), v.null())),
    titleKey: v.string(),
    titleParams: v.optional(v.union(v.string(), v.null())),
    textKey: v.string(),
    textParams: v.optional(v.union(v.string(), v.null())),
    positiveTextKey: v.optional(v.union(v.string(), v.null())),
    negativeTextKey: v.optional(v.union(v.string(), v.null())),
    navigateTextKey: v.optional(v.union(v.string(), v.null())),
    navigateTarget: v.optional(v.union(v.string(), v.null())),
    response: v.optional(v.union(v.string(), v.null())),
    isRead: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index('by_recipient', ['recipientAuthUserKey'])
    .index('by_recipient_read', ['recipientAuthUserKey', 'isRead']),

  // ── Notification Preferences ──────────────────────────
  plannerNotificationPreferences: defineTable({
    userAuthUserKey: v.string(),
    notifyTripInvite: v.optional(v.boolean()),
    notifyBookingChange: v.optional(v.boolean()),
    notifyTripReminder: v.optional(v.boolean()),
    notifyWebhook: v.optional(v.boolean()),
  })
    .index('by_user', ['userAuthUserKey']),

  // ── Trip Files ────────────────────────────────────────
  plannerFiles: defineTable({
    tripId: v.id('plannerTrips'),
    storageId: v.id('_storage'),
    filename: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    uploadedBy: v.string(),
    starred: v.optional(v.boolean()),
    deletedAt: v.optional(v.union(v.number(), v.null())),
    createdAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  // ── File Links ────────────────────────────────────────
  plannerFileLinks: defineTable({
    fileId: v.id('plannerFiles'),
    reservationId: v.optional(v.union(v.id('plannerReservations'), v.null())),
    assignmentId: v.optional(v.union(v.id('plannerDayAssignments'), v.null())),
    placeId: v.optional(v.union(v.id('plannerPlaces'), v.null())),
    createdAt: v.number(),
  })
    .index('by_fileId', ['fileId']),

  // ── Trip Photos ───────────────────────────────────────
  plannerPhotos: defineTable({
    tripId: v.id('plannerTrips'),
    uploadedBy: v.string(),
    storageId: v.id('_storage'),
    filename: v.string(),
    fileSize: v.number(),
    mimeType: v.string(),
    caption: v.optional(v.union(v.string(), v.null())),
    takenAt: v.optional(v.union(v.string(), v.null())),
    shared: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index('by_tripId', ['tripId']),

  // ── Audit Log ─────────────────────────────────────────
  plannerAuditLog: defineTable({
    userAuthUserKey: v.optional(v.union(v.string(), v.null())),
    action: v.string(),
    resource: v.string(),
    details: v.optional(v.union(v.string(), v.null())),
    createdAt: v.number(),
  })
    .index('by_createdAt', ['createdAt']),

  // ── Invite Tokens ─────────────────────────────────────
  plannerInviteTokens: defineTable({
    token: v.string(),
    maxUses: v.optional(v.union(v.number(), v.null())),
    usedCount: v.number(),
    expiresAt: v.optional(v.union(v.number(), v.null())),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index('by_token', ['token']),

  // ── Packing Templates ────────────────────────────────
  plannerPackingTemplates: defineTable({
    name: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
  }),

  plannerPackingTemplateCategories: defineTable({
    templateId: v.id('plannerPackingTemplates'),
    name: v.string(),
    sortOrder: v.number(),
  })
    .index('by_templateId', ['templateId']),

  plannerPackingTemplateItems: defineTable({
    categoryId: v.id('plannerPackingTemplateCategories'),
    name: v.string(),
    sortOrder: v.number(),
  })
    .index('by_categoryId', ['categoryId']),

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
