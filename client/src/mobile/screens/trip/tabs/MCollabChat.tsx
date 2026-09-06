import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ChevronUp, ImagePlus, Loader2, Reply, Trash2 } from 'lucide-react'
import MDancingTrek from '../../../components/MDancingTrek'
import { collabApi } from '../../../../api/client'
import { addListener, removeListener } from '../../../../api/websocket'
import { useAuthStore } from '../../../../store/authStore'
import { useTranslation } from '../../../../i18n'
import type { TripPlanner } from '../MTripShell'
import {
  OTHER_BUBBLE_RADIUS,
  OWN_BUBBLE_RADIUS,
  QUICK_REACTIONS,
  formatChatClockTime,
  formatChatDateSeparator,
  isEmojiOnlyText,
  isSameSender,
  shouldShowChatDateSeparator,
  type ChatMessage,
  type ChatReaction,
} from './collabModel'

const PAGE_SIZE = 100
const LONG_PRESS_MS = 500
const DOUBLE_TAP_MS = 300
const MOVE_CANCEL_PX = 10
const POPOVER_WIDTH = 224
// Emoji grid + reply row, plus the delete row when it is shown — used to keep
// the popover inside the viewport.
const POPOVER_HEIGHT = 150
const POPOVER_DELETE_ROW = 37
const POPOVER_MARGIN = 8

interface MCollabChatProps {
  planner: TripPlanner
}

interface GetMessagesResponse { messages: ChatMessage[] }
interface SendMessageResponse { message: ChatMessage }
interface ReactMessageResponse { reactions: ChatReaction[] }

/**
 * Trip-tab Collab / Chat. Owns its own state + WebSocket listener per the
 * architecture note in 10-tab-databindings.md §8.2 — chat never touches
 * `planner.tripActions`, it talks to `collabApi` directly, exactly like
 * `useCollabChat.ts` on desktop (reimplemented rather than imported).
 *
 * Layout deviates from the other tabs on purpose (spec 03 §6.1): its own
 * flex-column, not TabScroller, so the composer can sit flush above the dock.
 */
export default function MCollabChat({ planner }: MCollabChatProps) {
  const { t, tripId, toast } = planner
  const { locale } = useTranslation()
  const { user } = useAuthStore()
  const canEdit = planner.can('collab_edit', planner.trip)
  const is12h = planner.settings.time_format === '12h'
  const currentUserId = user?.id ?? null

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [sending, setSending] = useState(false)
  const [imageFiles, setImageFiles] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<string[]>([])
  const [popover, setPopover] = useState<{ msg: ChatMessage; x: number; y: number } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const isAtBottomRef = useRef(true)
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior }))
  }, [])

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  // ── Initial load ──
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    collabApi.getMessages(tripId).then((data: GetMessagesResponse) => {
      if (cancelled) return
      const msgs = (data.messages || []).map(m => (m.deleted ? { ...m, _deleted: true } : m))
      setMessages(msgs)
      setHasMore(msgs.length >= PAGE_SIZE)
      setLoading(false)
      setTimeout(() => scrollToBottom(), 30)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tripId, scrollToBottom])

  // ── WebSocket (own listener, not handleRemoteEvent — collab has no store slice) ──
  useEffect(() => {
    const handler = (event: Record<string, unknown>) => {
      if (String(event.tripId) !== String(tripId)) return
      if (event.type === 'collab:message:created') {
        const message = event.message as ChatMessage
        setMessages(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]))
        if (isAtBottomRef.current) setTimeout(() => scrollToBottom('smooth'), 30)
      }
      if (event.type === 'collab:message:deleted') {
        const messageId = event.messageId as number
        setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, _deleted: true } : m)))
      }
      if (event.type === 'collab:message:reacted') {
        const messageId = event.messageId as number
        const reactions = event.reactions as ChatReaction[]
        setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, reactions } : m)))
      }
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [tripId, scrollToBottom])

  const handleLoadMore = useCallback(async () => {
    const current = messagesRef.current
    if (loadingMore || current.length === 0) return
    setLoadingMore(true)
    const el = scrollRef.current
    const prevHeight = el ? el.scrollHeight : 0
    try {
      const beforeId = current[0]?.id
      const data = (await collabApi.getMessages(tripId, beforeId != null ? String(beforeId) : undefined)) as GetMessagesResponse
      const older = (data.messages || []).map(m => (m.deleted ? { ...m, _deleted: true } : m))
      if (older.length === 0) {
        setHasMore(false)
      } else {
        setMessages(prev => [...older, ...prev])
        setHasMore(older.length >= PAGE_SIZE)
        requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevHeight })
      }
    } catch {
      toast.error(t('common.error'))
    } finally {
      setLoadingMore(false)
    }
  }, [tripId, loadingMore, toast, t])

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      const h = Math.min(ta.scrollHeight, 100)
      ta.style.height = `${h}px`
      ta.style.overflowY = ta.scrollHeight > 100 ? 'auto' : 'hidden'
    }
  }

  const addImageFiles = (incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter(f => ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.type) && f.size <= 10 * 1024 * 1024)
    setImageFiles(prev => {
      const next = [...prev, ...valid].slice(0, 4)
      setImagePreviews(next.map(f => URL.createObjectURL(f)))
      return next
    })
  }

  const handleSend = useCallback(async () => {
    const body = text.trim()
    if ((!body && !imageFiles.length) || sending || !canEdit) return
    setSending(true)
    try {
      let data: SendMessageResponse
      if (imageFiles.length) {
        const form = new FormData()
        if (body) form.append('text', body)
        if (replyTo) form.append('reply_to', String(replyTo.id))
        imageFiles.forEach(file => form.append('images', file))
        data = (await collabApi.sendMessage(tripId, form)) as SendMessageResponse
      } else {
        const payload: { text: string; reply_to?: number } = { text: body }
        if (replyTo) payload.reply_to = replyTo.id
        data = (await collabApi.sendMessage(tripId, payload)) as SendMessageResponse
      }
      if (data.message) {
        setMessages(prev => (prev.some(m => m.id === data.message.id) ? prev : [...prev, data.message]))
      }
      setText('')
      setReplyTo(null)
      imagePreviews.forEach(URL.revokeObjectURL)
      setImageFiles([])
      setImagePreviews([])
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      isAtBottomRef.current = true
      setTimeout(() => scrollToBottom('smooth'), 50)
    } catch {
      toast.error(t('common.error'))
    } finally {
      setSending(false)
    }
  }, [text, sending, canEdit, replyTo, tripId, scrollToBottom, toast, t, imageFiles, imagePreviews])

  const handleDelete = useCallback(async (msgId: number) => {
    setPopover(null)
    try {
      await collabApi.deleteMessage(tripId, msgId)
      setMessages(prev => prev.map(m => (m.id === msgId ? { ...m, _deleted: true } : m)))
    } catch {
      toast.error(t('common.error'))
    }
  }, [tripId, toast, t])

  const handleReact = useCallback(async (msgId: number, emoji: string) => {
    setPopover(null)
    try {
      const data = (await collabApi.reactMessage(tripId, msgId, emoji)) as ReactMessageResponse
      setMessages(prev => prev.map(m => (m.id === msgId ? { ...m, reactions: data.reactions } : m)))
    } catch {
      toast.error(t('common.error'))
    }
  }, [tripId, toast, t])

  const openReply = (msg: ChatMessage) => {
    setPopover(null)
    setReplyTo(msg)
    textareaRef.current?.focus()
  }

  return (
    <div className="flex h-full flex-col px-4 pb-[var(--bottom-nav-h,84px)] pt-[calc(var(--m-safe-top,12px)+58px)]">
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={22} strokeWidth={2} className="animate-spin text-m-faint" />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 py-10 text-center">
          <MDancingTrek scene="chat" className="mb-2" />
          <p className="font-geist text-[0.8125rem] font-medium text-m-muted">{t('collab.chat.empty')}</p>
        </div>
      ) : (
        <div ref={scrollRef} onScroll={checkAtBottom} className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {hasMore && (
            <div className="flex justify-center pb-[10px]">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-1 rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-[14px] py-[5px] font-geist text-[0.6875rem] font-bold text-m-muted"
              >
                {loadingMore ? <Loader2 size={13} strokeWidth={2.2} className="animate-spin" /> : <ChevronUp size={13} strokeWidth={2.2} />}
                {t('collab.chat.loadMore')}
              </button>
            </div>
          )}

          {messages.map((msg, idx) => {
            const prevMsg = messages[idx - 1]
            const nextMsg = messages[idx + 1]
            const isNewGroup = !isSameSender(msg, prevMsg) || shouldShowChatDateSeparator(msg, prevMsg)
            const isLastInGroup = !nextMsg || !isSameSender(msg, nextMsg) || shouldShowChatDateSeparator(nextMsg, msg)
            const own = currentUserId != null && String(msg.user_id) === String(currentUserId)

            return (
              <div key={msg.id}>
                {shouldShowChatDateSeparator(msg, prevMsg) && (
                  <div className="flex justify-center pb-[6px] pt-[14px]">
                    <span className="rounded-full bg-[color:var(--m-ic)] px-3 py-1 font-geist text-[0.625rem] font-bold uppercase tracking-[.03em] text-m-faint">
                      {formatChatDateSeparator(msg.created_at, t, locale)}
                    </span>
                  </div>
                )}
                {msg._deleted ? (
                  <div className="flex justify-center py-1">
                    <span className="font-geist text-[0.6875rem] italic text-m-faint">
                      {msg.username} {t('collab.chat.deletedMessage')} · {formatChatClockTime(msg.created_at, is12h)}
                    </span>
                  </div>
                ) : (
                  <ChatBubbleRow
                    msg={msg}
                    own={own}
                    showHeader={!own && isNewGroup}
                    isLastInGroup={isLastInGroup}
                    marginTop={isNewGroup ? 10 : 2}
                    is12h={is12h}
                    canEdit={canEdit}
                    t={t}
                    onOpenActions={(x, y) => setPopover({ msg, x, y })}
                    onReactBadgeTap={emoji => canEdit && handleReact(msg.id, emoji)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-[10px] flex flex-none flex-col gap-2">
        {replyTo && (
          <div className="flex items-center gap-2 rounded-[12px] border-l-[3px] border-m-act bg-[color:var(--m-ic)] px-[10px] py-[6px]">
            <Reply size={12} strokeWidth={2} className="flex-none text-m-faint" />
            <span className="min-w-0 flex-1 truncate font-geist text-[0.71875rem] text-m-muted">
              <strong className="text-m-ink">{replyTo.username}</strong>: {replyTo.text.slice(0, 60)}
            </span>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              aria-label={t('common.close')}
              className="flex-none font-geist text-[0.75rem] font-bold text-m-faint"
            >
              ×
            </button>
          </div>
        )}

        {canEdit ? (
          <>
            {imagePreviews.length > 0 && (
              <div className="flex gap-2 overflow-x-auto">
                {imagePreviews.map((url, i) => (
                  <div key={url} className="relative">
                    <img src={url} alt="" className="h-14 w-14 rounded-lg object-cover" />
                    <button type="button" aria-label="Remove image" onClick={() => { setImageFiles(prev => prev.filter((_, idx) => idx !== i)); setImagePreviews(prev => prev.filter((_, idx) => idx !== i)) }} className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-m-ink text-[10px] text-m-bg">×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
            <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden onChange={e => { if (e.target.files) addImageFiles(e.target.files); e.currentTarget.value = '' }} />
            <button type="button" aria-label="Attach images" onClick={() => imageInputRef.current?.click()} className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full text-m-muted">
              <ImagePlus size={18} strokeWidth={2.2} />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={handleTextChange}
              onPaste={e => { if (e.clipboardData.files.length) addImageFiles(e.clipboardData.files) }}
              placeholder={t('collab.chat.placeholder')}
              maxLength={5000}
              className="max-h-[100px] min-w-0 flex-1 resize-none rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-[14px] py-[11px] font-[inherit] text-[0.8125rem] text-m-ink outline-none placeholder:text-m-faint"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={(!text.trim() && !imageFiles.length) || sending}
              aria-label={t('collab.chat.send')}
              className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full bg-m-act text-m-actfg disabled:opacity-40"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          </div>
          </>
        ) : (
          <div className="rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-[14px] py-[11px] text-center font-geist text-[0.75rem] text-m-faint">
            {t('collab.chat.readOnly')}
          </div>
        )}
      </div>

      {popover && (
        <MessageActionsPopover
          x={popover.x}
          y={popover.y}
          canDeleteOwn={canEdit && currentUserId != null && String(popover.msg.user_id) === String(currentUserId)}
          t={t}
          onReact={emoji => handleReact(popover.msg.id, emoji)}
          onReply={() => openReply(popover.msg)}
          onDelete={() => handleDelete(popover.msg.id)}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ChatBubbleRow({ msg, own, showHeader, isLastInGroup, marginTop, is12h, canEdit, t, onOpenActions, onReactBadgeTap }: {
  msg: ChatMessage
  own: boolean
  showHeader: boolean
  isLastInGroup: boolean
  marginTop: number
  is12h: boolean
  canEdit: boolean
  t: TripPlanner['t']
  onOpenActions: (x: number, y: number) => void
  onReactBadgeTap: (emoji: string) => void
}) {
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firedRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })
  const lastTapRef = useRef(0)

  const clearPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canEdit) return
    firedRef.current = false
    startRef.current = { x: e.clientX, y: e.clientY }
    pressTimer.current = setTimeout(() => {
      firedRef.current = true
      onOpenActions(e.clientX, e.clientY)
    }, LONG_PRESS_MS)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pressTimer.current) return
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) clearPress()
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!canEdit) return
    const wasLongPress = firedRef.current
    clearPress()
    if (wasLongPress) return
    const now = Date.now()
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0
      onOpenActions(e.clientX, e.clientY)
    } else {
      lastTapRef.current = now
    }
  }

  const bigEmoji = isEmojiOnlyText(msg.text)
  // A reply to a since-deleted message keeps reply_to but loses the quoted
  // text — no quote box then instead of an empty one.
  const hasReply = !!msg.reply_text
  const initial = (msg.username || '?')[0]?.toUpperCase() || '?'

  return (
    <div
      className={`flex gap-2 ${own ? 'flex-row-reverse pl-10' : 'flex-row pr-10'}`}
      style={{ marginTop }}
    >
      {!own && (
        <div className="w-7 flex-none self-end">
          {showHeader && (
            msg.avatar_url ? (
              <img src={msg.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover" />
            ) : (
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--m-ic)] font-geist text-[0.6875rem] font-bold text-m-muted">
                {initial}
              </div>
            )
          )}
        </div>
      )}

      <div className={`flex min-w-0 max-w-[78%] flex-col ${own ? 'items-end' : 'items-start'}`}>
        {showHeader && (
          <span className="mb-[2px] pl-1 font-geist text-[0.59375rem] font-bold text-m-faint">{msg.username}</span>
        )}

        <button
          type="button"
          aria-label={canEdit ? t('collab.chat.messageOptions') : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={clearPress}
          className="max-w-full text-left"
        >
          {bigEmoji ? (
            <div className="py-[2px] text-[2.5rem] leading-[1.15]">{msg.text}</div>
          ) : (
            <div
              className={`px-[13px] py-[9px] text-[0.8125rem] leading-[1.45] ${
                own ? 'bg-m-act text-m-actfg' : 'border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] text-m-ink'
              }`}
              style={{ borderRadius: own ? OWN_BUBBLE_RADIUS : OTHER_BUBBLE_RADIUS }}
            >
              {hasReply && (
                <div className="mb-1 rounded-[10px] bg-[color:var(--m-card)] px-[10px] py-[5px]">
                  <div className="font-geist text-[0.625rem] font-bold opacity-70">{msg.reply_username}</div>
                  <div className="truncate text-[0.71875rem] opacity-80">{msg.reply_text?.slice(0, 80)}</div>
                </div>
              )}
              <span className="whitespace-pre-wrap break-words">{msg.text}</span>
              {msg.attachments?.map(att => (
                <img key={att.id} src={att.url} alt={att.original_name || ''} className="mt-2 max-h-52 w-full rounded-[10px] object-cover" />
              ))}
            </div>
          )}
        </button>

        {msg.reactions.length > 0 && (
          <div className="mt-[-4px] flex flex-wrap gap-[3px] px-1">
            {msg.reactions.map(r => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onReactBadgeTap(r.emoji)}
                className="inline-flex items-center gap-1 rounded-full border border-[color:var(--m-rowbr)] bg-m-card px-[7px] py-[2px] text-[0.75rem]"
              >
                <span>{r.emoji}</span>
                {r.count > 1 && <span className="font-geist text-[0.625rem] font-bold text-m-muted">{r.count}</span>}
              </button>
            ))}
          </div>
        )}

        {isLastInGroup && (
          <span className="mt-[2px] px-1 font-geist text-[0.5625rem] text-m-faint">
            {formatChatClockTime(msg.created_at, is12h)}
          </span>
        )}
      </div>
    </div>
  )
}

function MessageActionsPopover({ x, y, canDeleteOwn, t, onReact, onReply, onDelete, onClose }: {
  x: number
  y: number
  canDeleteOwn: boolean
  t: TripPlanner['t']
  onReact: (emoji: string) => void
  onReply: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [onClose])

  const width = POPOVER_WIDTH
  const left = Math.max(width / 2 + POPOVER_MARGIN, Math.min(x, window.innerWidth - width / 2 - POPOVER_MARGIN))
  const height = POPOVER_HEIGHT + (canDeleteOwn ? POPOVER_DELETE_ROW : 0)
  const top = Math.max(64, Math.min(y - 96, window.innerHeight - height - POPOVER_MARGIN))

  return createPortal(
    <div className="m-root fixed inset-0 z-[55]">
      <div
        ref={ref}
        style={{ top, left, width }}
        className="fixed -translate-x-1/2 rounded-[18px] border border-[color:var(--m-shbr)] bg-[color:var(--m-sheetop)] p-2 shadow-[0_12px_32px_rgba(0,0,0,.28)]"
      >
        <div className="grid grid-cols-4 gap-1">
          {QUICK_REACTIONS.map(emoji => (
            <button
              key={emoji}
              type="button"
              onClick={() => onReact(emoji)}
              aria-label={emoji}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[1.15rem] active:bg-[color:var(--m-ic)]"
            >
              {emoji}
            </button>
          ))}
        </div>
        <div className="mt-1 border-t border-[color:var(--m-rowbr)] pt-1">
          <button
            type="button"
            onClick={onReply}
            className="flex w-full items-center gap-2 rounded-[10px] px-2 py-[8px] text-left text-[0.8125rem] font-semibold text-m-ink"
          >
            <Reply size={14} strokeWidth={2} /> {t('collab.chat.reply')}
          </button>
          {canDeleteOwn && (
            <button
              type="button"
              onClick={onDelete}
              className="flex w-full items-center gap-2 rounded-[10px] px-2 py-[8px] text-left text-[0.8125rem] font-semibold text-[color:var(--m-st-danger)]"
            >
              <Trash2 size={14} strokeWidth={2} /> {t('common.delete')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
