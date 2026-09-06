/**
 * Collab view-model — types + pure helpers shared by MCollabChat/Notes/Polls.
 * Mirrors the real `/api/trips/:tripId/collab/*` response shapes (verified
 * against `server/src/nest/collab/collab.controller.ts` +
 * `server/src/services/collabService.ts`, byte-identical to the legacy Express
 * route), NOT the desktop demo state — see analysis/10-tab-databindings.md §8.
 * Collab has no store slice, so unlike `transportsModel.ts` these helpers never
 * touch `useTripStore` data.
 */

/** Same shape `t()` has everywhere else (TranslationContext.tsx) — kept local
 *  so this file stays planner-agnostic like transportsModel.ts. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/* ------------------------------------------------------------------ */
/*  Chat                                                                */
/* ------------------------------------------------------------------ */

export interface ChatReactionUser {
  user_id: number
  username: string
}

export interface ChatReaction {
  emoji: string
  users: ChatReactionUser[]
  count: number
}

export interface ChatMessage {
  id: number
  trip_id: number
  user_id: number
  text: string
  reply_to: number | null
  reply_text?: string | null
  reply_username?: string | null
  username: string
  avatar: string | null
  avatar_url: string | null
  user_avatar?: string | null
  created_at: string
  deleted?: number | boolean
  reactions: ChatReaction[]
  attachments?: Array<{ id: number; url: string; original_name?: string; mime_type?: string }>
  /** Client-only: set once a delete (own or via WS) has landed. */
  _deleted?: boolean
}

/** The 8 quick-tap reactions (long-press / double-tap popover). Same set the
 *  desktop right-click menu offers — kept in sync for cross-platform muscle
 *  memory, redefined locally since we don't import Desktop Collab files. */
export const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🔥', '👏', '🎉']

/** Bubble corner radii, spec 03 §6.1 — constant per sender, not per group
 *  position (grouping is expressed through spacing + a single trailing
 *  timestamp instead, see MCollabChat). */
export const OWN_BUBBLE_RADIUS = '16px 16px 4px 16px'
export const OTHER_BUBBLE_RADIUS = '4px 16px 16px 16px'

// SQLite stores UTC without a 'Z' suffix — append one so JS parses it as UTC
// rather than local time (same fix the desktop helpers apply).
export function parseUtcDate(iso: string): Date {
  return new Date(iso && !iso.endsWith('Z') ? `${iso}Z` : iso)
}

/** 1-3 emoji and nothing else → render large, no bubble background. */
export function isEmojiOnlyText(text: string): boolean {
  const emojiRegex =
    /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*){1,3}$/u
  return emojiRegex.test(text.trim())
}

export function formatChatClockTime(iso: string, is12h: boolean): string {
  const d = parseUtcDate(iso)
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (is12h) {
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${mm} ${period}`
  }
  return `${String(h).padStart(2, '0')}:${mm}`
}

export function formatChatDateSeparator(iso: string, t: Translate, locale: string): string {
  const d = parseUtcDate(iso)
  const now = new Date()
  const yesterday = new Date()
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return t('collab.chat.today')
  if (d.toDateString() === yesterday.toDateString()) return t('collab.chat.yesterday')
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function shouldShowChatDateSeparator(msg: ChatMessage, prevMsg?: ChatMessage): boolean {
  if (!prevMsg) return true
  return parseUtcDate(msg.created_at).toDateString() !== parseUtcDate(prevMsg.created_at).toDateString()
}

/** Same sender → part of the same visual group (spacing tightens, avatar and
 *  name collapse to the first message, timestamp moves to the last one). */
export function isSameSender(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  if (!a || !b) return false
  return String(a.user_id) === String(b.user_id)
}

/* ------------------------------------------------------------------ */
/*  Notes                                                               */
/* ------------------------------------------------------------------ */

export interface CollabNoteFile {
  id: number
  filename: string
  original_name: string
  file_size?: number | null
  mime_type?: string | null
  url: string
}

export interface CollabNoteData {
  id: number
  trip_id: number
  user_id: number
  title: string
  content: string | null
  category: string | null
  color: string | null
  website: string | null
  pinned: number | boolean
  username: string
  avatar: string | null
  avatar_url: string | null
  created_at: string
  updated_at?: string
  attachments: CollabNoteFile[]
}

/** Category swatch palette — same 6 hex values the desktop picker uses
 *  (product-level consistency), redefined locally per the no-Collab-reuse rule. */
export const NOTE_COLORS = ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6']

/** One color per category, taken from whatever any note in that category
 *  already has stored (every note in a category is written with the same
 *  color at create time, so first-seen === all-seen in practice). */
export function buildCategoryColorMap(notes: CollabNoteData[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const n of notes) {
    if (n.category && n.color && !map[n.category]) map[n.category] = n.color
  }
  return map
}

/** Round-robins a fresh category onto the next unused palette color. */
export function getCategoryColor(category: string | null | undefined, colorMap: Record<string, string>): string {
  if (!category) return NOTE_COLORS[0]
  if (colorMap[category]) return colorMap[category]
  return NOTE_COLORS[Object.keys(colorMap).length % NOTE_COLORS.length]
}

/** Distinct categories in first-appearance order (for the filter pill row). */
export function noteCategoriesList(notes: CollabNoteData[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of notes) {
    if (n.category && !seen.has(n.category)) {
      seen.add(n.category)
      out.push(n.category)
    }
  }
  return out
}

/** Pinned first, then most-recently-touched — same order the desktop grid uses. */
export function sortNotes(notes: CollabNoteData[], activeCategory: string | null): CollabNoteData[] {
  return notes
    .filter(n => activeCategory === null || n.category === activeCategory)
    .slice()
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      const tA = new Date(a.updated_at || a.created_at).getTime()
      const tB = new Date(b.updated_at || b.created_at).getTime()
      return tB - tA
    })
}

/* ------------------------------------------------------------------ */
/*  Polls                                                               */
/* ------------------------------------------------------------------ */

export interface PollVoter {
  id: number
  user_id: number
  username: string
  avatar: string | null
  avatar_url: string | null
}

export interface PollOptionData {
  text: string
  label: string
  voters: PollVoter[]
}

export interface CollabPollData {
  id: number
  trip_id: number
  user_id: number
  question: string
  options: PollOptionData[]
  multiple_choice: boolean
  is_closed: boolean
  deadline: string | null
  username: string
  avatar: string | null
  avatar_url: string | null
  created_at: string
}

export function totalPollVotes(poll: CollabPollData): number {
  return (poll.options || []).reduce((sum, o) => sum + (o.voters?.length || 0), 0)
}

/** Highest single-option vote count — used to mark the winning option once closed. */
export function pollMaxVoteCount(poll: CollabPollData): number {
  return (poll.options || []).reduce((max, o) => Math.max(max, o.voters?.length || 0), 0)
}

export function hasUserVoted(poll: CollabPollData, userId: number): boolean {
  return (poll.options || []).some(o => (o.voters || []).some(v => String(v.user_id) === String(userId)))
}

export function isPollExpired(deadline: string | null): boolean {
  if (!deadline) return false
  return new Date(deadline).getTime() <= Date.now()
}

export function isPollActive(poll: CollabPollData): boolean {
  return !poll.is_closed && !isPollExpired(poll.deadline)
}

export function splitPolls(polls: CollabPollData[]): { active: CollabPollData[]; closed: CollabPollData[] } {
  const active: CollabPollData[] = []
  const closed: CollabPollData[] = []
  for (const p of polls) (isPollActive(p) ? active : closed).push(p)
  return { active, closed }
}

/** "2d 4h left" / "3h 45m left" / "12m left", localized; null once expired
 *  or when there is no deadline. Same three-tier breakdown the desktop poll
 *  card uses, ported here because the desktop create form never actually
 *  exposes a deadline input (see MCollabPolls / task report). */
export function formatPollCountdown(deadline: string | null, t: Translate): string | null {
  if (!deadline) return null
  const diffMs = new Date(deadline).getTime() - Date.now()
  if (diffMs <= 0) return null
  const mins = Math.floor(diffMs / 60000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return t('collab.polls.countdownDaysHours', { d: days, h: hrs % 24 })
  if (hrs > 0) return t('collab.polls.countdownHoursMinutes', { h: hrs, m: mins % 60 })
  return t('collab.polls.countdownMinutes', { m: mins })
}
