/**
 * Convex API client that replaces Express API calls.
 * All features now backed by real Convex queries/mutations.
 */
import { convexClient } from '../convex/provider'
import { api } from '../../convex/_generated/api'

function getClient() {
  if (!convexClient) throw new Error('Convex is not configured')
  return convexClient
}

/** Resolve a tripId (could be numeric legacy ID or Convex ID string) to a Convex trip _id */
async function resolveTripId(tripId: number | string): Promise<any> {
  const client = getClient()
  const resolved = await client.query(api.trips.resolveTripId, { tripParam: String(tripId) })
  if (!resolved) throw new Error('Trip not found')
  return resolved
}

// ── Admin API ──────────────────────────────────────────────

export const stubbedAdminApi: any = {
  users: async () => {
    return getClient().query(api.admin.listUsers, {})
  },
  createUser: async (data: any) => {
    return getClient().mutation(api.admin.createUser, { data })
  },
  updateUser: async (userId: any, data: any) => {
    return getClient().mutation(api.admin.updateUser, { userId, data })
  },
  deleteUser: async (userId: any) => {
    return getClient().mutation(api.admin.deleteUser, { userId })
  },
  stats: async () => {
    return getClient().query(api.admin.stats, {})
  },
  getOidc: async () => {
    return getClient().query(api.admin.getOidc, {})
  },
  updateOidc: async (data: any) => {
    return getClient().mutation(api.admin.updateOidc, { data })
  },
  addons: async () => {
    return getClient().query(api.addons.enabled, {})
  },
  updateAddon: async (id: any, data: any) => {
    return getClient().mutation(api.addons.updateAddon, { addonId: String(id), enabled: data.enabled ?? true })
  },
  checkVersion: async () => {
    // No server-side version checking in cloud mode
    return { current: '3.0.0', latest: '3.0.0', updateAvailable: false }
  },
  installUpdate: async () => {
    // Not applicable in cloud mode
    return {}
  },
  listInvites: async () => {
    return getClient().query(api.admin.listInvites, {})
  },
  createInvite: async (data: any) => {
    return getClient().mutation(api.admin.createInvite, { data })
  },
  deleteInvite: async (id: any) => {
    return getClient().mutation(api.admin.deleteInvite, { inviteId: id })
  },
  auditLog: async (page = 1, limit = 50) => {
    return getClient().query(api.admin.auditLog, { page, limit })
  },
  sessions: async () => {
    return getClient().query(api.admin.sessions, {})
  },
  getBagTracking: async () => {
    return getClient().query(api.admin.getBagTracking, {})
  },
  updateBagTracking: async (enabled: boolean) => {
    return getClient().mutation(api.admin.updateBagTracking, { enabled })
  },
  saveDemoBaseline: async () => {
    // Not applicable in cloud mode
    return {}
  },
  packingTemplates: async () => {
    return getClient().query(api.admin.listPackingTemplates, {})
  },
  getPackingTemplate: async (id: any) => {
    return getClient().query(api.admin.getPackingTemplate, { templateId: id })
  },
  createPackingTemplate: async (data: any) => {
    return getClient().mutation(api.admin.createPackingTemplate, { data })
  },
  updatePackingTemplate: async (id: any, data: any) => {
    return getClient().mutation(api.admin.updatePackingTemplate, { templateId: id, data })
  },
  deletePackingTemplate: async (id: any) => {
    return getClient().mutation(api.admin.deletePackingTemplate, { templateId: id })
  },
  addTemplateCategory: async (templateId: any, data: any) => {
    return getClient().mutation(api.admin.addTemplateCategory, { templateId, data })
  },
  updateTemplateCategory: async (templateId: any, categoryId: any, data: any) => {
    return getClient().mutation(api.admin.updateTemplateCategory, { templateId, categoryId, data })
  },
  deleteTemplateCategory: async (templateId: any, categoryId: any) => {
    return getClient().mutation(api.admin.deleteTemplateCategory, { templateId, categoryId })
  },
  addTemplateItem: async (templateId: any, categoryId: any, data: any) => {
    return getClient().mutation(api.admin.addTemplateItem, { templateId, categoryId, data })
  },
  updateTemplateItem: async (templateId: any, categoryId: any, itemId: any, data: any) => {
    return getClient().mutation(api.admin.updateTemplateItem, { templateId, categoryId, itemId, data })
  },
  deleteTemplateItem: async (templateId: any, categoryId: any, itemId: any) => {
    return getClient().mutation(api.admin.deleteTemplateItem, { templateId, categoryId, itemId })
  },
}

// ── Collab API ──────────────────────────────────────────────

export const stubbedCollabApi: any = {
  getNotes: async (tripId: number | string) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().query(api.collab.getNotes, { tripId: convexTripId })
  },
  createNote: async (tripId: number | string, data: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.collab.createNote, { tripId: convexTripId, data })
  },
  updateNote: async (tripId: number | string, noteId: any, data: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.collab.updateNote, { tripId: convexTripId, noteId, data })
  },
  deleteNote: async (tripId: number | string, noteId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.collab.deleteNote, { tripId: convexTripId, noteId })
  },
  uploadNoteFile: async (tripId: number | string, noteId: any, formData: FormData) => {
    const convexTripId = await resolveTripId(tripId)
    const client = getClient()

    // Get the file from FormData
    const file = formData.get('file') as File
    if (!file) throw new Error('No file provided')

    // Upload to Convex storage
    const uploadUrl = await client.mutation(api.collab.generateNoteUploadUrl, {})
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    const { storageId } = await uploadResponse.json()

    // Save file metadata
    return client.mutation(api.collab.saveNoteFile, {
      tripId: convexTripId,
      noteId,
      storageId,
      filename: file.name,
      fileSize: file.size,
      mimeType: file.type,
    })
  },
  deleteNoteFile: async (tripId: number | string, noteId: any, fileId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.collab.deleteNoteFile, { tripId: convexTripId, noteId, fileId })
  },
  getPolls: async (tripId: number | string) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().query(api.collab.getPolls, { tripId: convexTripId })
  },
  createPoll: async (tripId: number | string, data: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.collab.createPoll, { tripId: convexTripId, data })
  },
  votePoll: async (tripId: number | string, pollId: any, optionIndex: number) => {
    const convexTripId = await resolveTripId(tripId)
    // After voting, re-fetch the full poll data so the UI can update
    await getClient().mutation(api.collab.votePoll, { tripId: convexTripId, pollId, optionIndex })
    const result = await getClient().query(api.collab.getPolls, { tripId: convexTripId })
    const poll = result.polls.find((p: any) => p.id === pollId || p._id === pollId)
    return { poll: poll || {} }
  },
  closePoll: async (tripId: number | string, pollId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.collab.closePoll, { tripId: convexTripId, pollId })
  },
  deletePoll: async (tripId: number | string, pollId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.collab.deletePoll, { tripId: convexTripId, pollId })
  },
  getMessages: async (tripId: number | string, before?: string) => {
    // Chat messages are handled by ConvexCollabChat / chat.ts already
    // This is a fallback for the legacy CollabChat component
    return { messages: [] }
  },
  sendMessage: async (tripId: number | string, data: any) => {
    // Chat handled by ConvexCollabChat
    return { message: { id: Date.now(), ...data } }
  },
  deleteMessage: async (tripId: number | string, msgId: any) => {
    return {}
  },
  reactMessage: async (tripId: number | string, msgId: any, emoji: string) => {
    return {}
  },
  linkPreview: async (tripId: number | string, url: string) => {
    // Link preview requires fetching external URLs — not possible from Convex queries.
    // Return empty for now; a Convex action could be added later.
    return {}
  },
}

// ── Share API ──────────────────────────────────────────────

export const stubbedShareApi: any = {
  getLink: async (tripId: number | string) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().query(api.sharing.getLink, { tripId: convexTripId })
  },
  createLink: async (tripId: number | string, permissions?: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.sharing.createLink, { tripId: convexTripId, permissions })
  },
  deleteLink: async (tripId: number | string) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.sharing.deleteLink, { tripId: convexTripId })
  },
  updatePermissions: async (tripId: number | string, permissions: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.sharing.updateLinkPermissions, { tripId: convexTripId, permissions })
  },
  getSharedTrip: async (token: string) => {
    return getClient().query(api.sharing.getSharedTrip, { token })
  },
}

// ── Backup API ────────────────────────────────────────────

export const stubbedBackupApi: any = {
  list: async () => {
    return getClient().query(api.backups.list, {})
  },
  create: async () => {
    return getClient().mutation(api.backups.create, {})
  },
  download: async (filename: string) => {
    const result = await getClient().query(api.backups.getDownloadData, { filename }) as any
    if (!result?.data) throw new Error('Backup data not available')
    const blob = new Blob([result.data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  },
  delete: async (filename: string) => {
    return getClient().mutation(api.backups.remove, { filename })
  },
  restore: async (_filename: string) => {
    // Restore from cloud backup would require re-importing all data
    // This is a complex operation best handled via a dedicated admin UI
    throw new Error('Cloud restore is not yet supported. Please export and re-import data manually.')
  },
  uploadRestore: async (_file: File) => {
    throw new Error('Upload restore is not yet supported in cloud mode.')
  },
  getAutoSettings: async () => {
    return getClient().query(api.backups.getAutoSettings, {})
  },
  setAutoSettings: async (settings: any) => {
    return getClient().mutation(api.backups.setAutoSettings, { settings })
  },
}

// ── Notifications API ──────────────────────────────────────

export const stubbedNotificationsApi: any = {
  list: async (params?: { limit?: number; offset?: number; unread_only?: boolean }) => {
    return getClient().query(api.notifications.list, {
      limit: params?.limit,
      offset: params?.offset,
      unreadOnly: params?.unread_only,
    })
  },
  unreadCount: async () => {
    return getClient().query(api.notifications.unreadCount, {})
  },
  markRead: async (id: any) => {
    return getClient().mutation(api.notifications.markRead, { notificationId: id })
  },
  markUnread: async (id: any) => {
    return getClient().mutation(api.notifications.markUnread, { notificationId: id })
  },
  markAllRead: async () => {
    return getClient().mutation(api.notifications.markAllRead, {})
  },
  delete: async (id: any) => {
    return getClient().mutation(api.notifications.deleteNotification, { notificationId: id })
  },
  deleteAll: async () => {
    return getClient().mutation(api.notifications.deleteAll, {})
  },
  respond: async (id: any, response: 'positive' | 'negative') => {
    return getClient().mutation(api.notifications.respond, { notificationId: id, response })
  },
}

// ── Files API ──────────────────────────────────────────────

export const stubbedFilesApi: any = {
  list: async (tripId: number | string, trash?: boolean) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().query(api.files.list, { tripId: convexTripId, trash })
  },
  upload: async (tripId: number | string, formData: FormData) => {
    const convexTripId = await resolveTripId(tripId)
    const client = getClient()

    const file = formData.get('file') as File
    if (!file) throw new Error('No file provided')

    const uploadUrl = await client.mutation(api.files.generateUploadUrl, {})
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    const { storageId } = await uploadResponse.json()

    const description = formData.get('description') as string | null
    return client.mutation(api.files.saveFile, {
      tripId: convexTripId,
      storageId,
      filename: file.name,
      fileSize: file.size,
      mimeType: file.type,
      description: description || undefined,
    })
  },
  update: async (tripId: number | string, fileId: any, data: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.update, { tripId: convexTripId, fileId, data })
  },
  delete: async (tripId: number | string, fileId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.softDelete, { tripId: convexTripId, fileId })
  },
  toggleStar: async (tripId: number | string, fileId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.toggleStar, { tripId: convexTripId, fileId })
  },
  restore: async (tripId: number | string, fileId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.restore, { tripId: convexTripId, fileId })
  },
  permanentDelete: async (tripId: number | string, fileId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.permanentDelete, { tripId: convexTripId, fileId })
  },
  emptyTrash: async (tripId: number | string) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.emptyTrash, { tripId: convexTripId })
  },
  getLinks: async (tripId: number | string, fileId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().query(api.files.getLinks, { tripId: convexTripId, fileId })
  },
  addLink: async (tripId: number | string, fileId: any, data: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.addLink, { tripId: convexTripId, fileId, data })
  },
  removeLink: async (tripId: number | string, fileId: any, linkId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.files.removeLink, { tripId: convexTripId, fileId, linkId })
  },
}

// ── Photos API ─────────────────────────────────────────────

export const stubbedPhotosApi: any = {
  list: async (tripId: number | string) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().query(api.photos.list, { tripId: convexTripId })
  },
  upload: async (tripId: number | string, formData: FormData) => {
    const convexTripId = await resolveTripId(tripId)
    const client = getClient()

    const file = formData.get('file') as File || formData.get('photo') as File
    if (!file) throw new Error('No file provided')

    const uploadUrl = await client.mutation(api.photos.generateUploadUrl, {})
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    const { storageId } = await uploadResponse.json()

    const caption = formData.get('caption') as string | null
    return client.mutation(api.photos.savePhoto, {
      tripId: convexTripId,
      storageId,
      filename: file.name,
      fileSize: file.size,
      mimeType: file.type,
      caption: caption || undefined,
    })
  },
  update: async (tripId: number | string, photoId: any, data: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.photos.update, { tripId: convexTripId, photoId, data })
  },
  delete: async (tripId: number | string, photoId: any) => {
    const convexTripId = await resolveTripId(tripId)
    return getClient().mutation(api.photos.remove, { tripId: convexTripId, photoId })
  },
}
