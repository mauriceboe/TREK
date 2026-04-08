import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, MessageCircle, Reply, Smile, Trash2, X } from 'lucide-react'
import { useMutation, useQuery } from 'convex/react'
import { stubbedCollabApi as collabApi } from '../../api/convexApiStub'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranslation } from '../../i18n'
import type { User } from '../../types'

class ChatErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 24, color: 'var(--text-muted)', fontSize: 14, gap: 12, textAlign: 'center' }}>
          <MessageCircle size={32} style={{ opacity: 0.4 }} />
          <p>Chat could not load. Try refreshing the page.</p>
          <button onClick={() => this.setState({ hasError: false })} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

interface ChatReaction {
  emoji: string
  count: number
  users: { user_id: string; username: string }[]
}

interface ChatMessage {
  id: string
  trip_id: number
  user_id: string
  username: string
  user_avatar: string | null
  avatar_url: string | null
  text: string
  deleted?: boolean
  _deleted?: boolean
  reply_to: string | null
  reply_text: string | null
  reply_username: string | null
  reactions: ChatReaction[]
  created_at: string
}

const QUICK_REACTIONS = ['❤️', '😂', '👍', '🔥', '🎉']
const URL_REGEX = /https?:\/\/[^\s<>"']+/g
const previewCache: Record<string, Record<string, unknown>> = {}

function parseUTC(value: string): Date {
  return new Date(value && !value.endsWith('Z') ? `${value}Z` : value)
}

function formatTime(isoString: string, is12h: boolean): string {
  const d = parseUTC(isoString)
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (is12h) {
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${mm} ${period}`
  }
  return `${String(h).padStart(2, '0')}:${mm}`
}

function formatDateSeparator(isoString: string, t: (key: string) => string): string {
  const d = parseUTC(isoString)
  const now = new Date()
  const yesterday = new Date()
  yesterday.setDate(now.getDate() - 1)

  if (d.toDateString() === now.toDateString()) return t('collab.chat.today') || 'Today'
  if (d.toDateString() === yesterday.toDateString()) return t('collab.chat.yesterday') || 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function shouldShowDateSeparator(msg: ChatMessage, prevMsg?: ChatMessage): boolean {
  if (!prevMsg) return true
  return parseUTC(msg.created_at).toDateString() !== parseUTC(prevMsg.created_at).toDateString()
}

function MessageText({ text }: { text: string }) {
  const parts = text.split(URL_REGEX)
  const urls = text.match(URL_REGEX) || []
  const result: React.ReactNode[] = []
  parts.forEach((part, i) => {
    if (part) result.push(part)
    if (urls[i]) {
      result.push(
        <a key={`${urls[i]}-${i}`} href={urls[i]} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2, opacity: 0.85 }}>
          {urls[i]}
        </a>
      )
    }
  })
  return <>{result}</>
}

function LinkPreview({ url, tripId }: { url: string; tripId: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(previewCache[url] || null)
  const [loading, setLoading] = useState(!previewCache[url])

  useEffect(() => {
    if (previewCache[url]) return
    collabApi.linkPreview(tripId, url).then((result) => {
      previewCache[url] = result
      setData(result)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [tripId, url])

  if (loading || !data) return null
  const title = typeof data.title === 'string' ? data.title : ''
  const description = typeof data.description === 'string' ? data.description : ''
  if (!title && !description) return null

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'block',
        marginTop: 8,
        padding: '10px 12px',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.12)',
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      {title && <div style={{ fontSize: 12, fontWeight: 700, marginBottom: description ? 4 : 0 }}>{title}</div>}
      {description && <div style={{ fontSize: 11, opacity: 0.85, lineHeight: 1.4 }}>{description}</div>}
    </a>
  )
}

function ReactionBadge({
  reaction,
  currentUserId,
  onToggle,
}: {
  reaction: ChatReaction
  currentUserId: number
  onToggle: () => void
}) {
  const mine = reaction.users.some((user) => String(user.user_id) === String(currentUserId))
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        border: 'none',
        cursor: 'pointer',
        borderRadius: 999,
        padding: '2px 8px',
        background: mine ? 'rgba(0,122,255,0.12)' : 'transparent',
        color: 'var(--text-primary)',
        fontSize: 11,
        fontFamily: 'inherit',
      }}
      title={reaction.users.map((user) => user.username).join(', ')}
    >
      <span>{reaction.emoji}</span>
      <span>{reaction.count}</span>
    </button>
  )
}

interface ConvexCollabChatProps {
  tripId: number
  currentUser: User
}

function ConvexCollabChatInner({ tripId, currentUser }: ConvexCollabChatProps) {
  const { t } = useTranslation()
  const is12h = useSettingsStore((state) => state.settings.time_format) === '12h'
  const messagesResult = useQuery('chat:listMessages' as any, { tripId, limit: 200 }) as ChatMessage[] | undefined
  const sendMessage = useMutation('chat:sendMessage' as any)
  const deleteMessage = useMutation('chat:deleteMessage' as any)
  const toggleReaction = useMutation('chat:toggleReaction' as any)

  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [sending, setSending] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const isAtBottom = useRef(true)

  const messages = useMemo(
    () => (messagesResult || []).map((message) => message.deleted ? { ...message, _deleted: true } : message),
    [messagesResult]
  )

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior }))
  }, [])

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  useEffect(() => {
    if (isAtBottom.current) scrollToBottom('smooth')
  }, [messages, scrollToBottom])

  const handleTextChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value)
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const h = Math.min(textarea.scrollHeight, 100)
    textarea.style.height = `${h}px`
    textarea.style.overflowY = textarea.scrollHeight > 100 ? 'auto' : 'hidden'
  }, [])

  const handleSend = useCallback(async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    try {
      await sendMessage({
        tripId,
        text: body,
        replyToMessageId: replyTo?.id || undefined,
      })
      setText('')
      setReplyTo(null)
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      isAtBottom.current = true
      setTimeout(() => scrollToBottom('smooth'), 40)
    } finally {
      setSending(false)
    }
  }, [replyTo, scrollToBottom, sendMessage, sending, text, tripId])

  const handleDelete = useCallback(async (messageId: string) => {
    setDeletingIds((prev) => new Set(prev).add(messageId))
    try {
      await deleteMessage({ tripId, messageId })
    } finally {
      setTimeout(() => {
        setDeletingIds((prev) => {
          const next = new Set(prev)
          next.delete(messageId)
          return next
        })
      }, 250)
    }
  }, [deleteMessage, tripId])

  const handleToggleReaction = useCallback(async (messageId: string, emoji: string) => {
    await toggleReaction({ tripId, messageId, emoji })
  }, [toggleReaction, tripId])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }, [handleSend])

  const loading = messagesResult === undefined

  if (loading) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border-faint)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0, height: '100%' }}>
      {messages.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-faint)', padding: 32 }}>
          <MessageCircle size={40} strokeWidth={1.2} style={{ opacity: 0.4 }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{t('collab.chat.empty')}</span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>{t('collab.chat.emptyDesc') || ''}</span>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={checkAtBottom}
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '8px 14px 4px',
            WebkitOverflowScrolling: 'touch',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {messages.map((msg, idx) => {
            const own = String(msg.user_id) === String(currentUser.id)
            const prevMsg = messages[idx - 1]
            const nextMsg = messages[idx + 1]
            const isNewGroup = idx === 0 || String(prevMsg?.user_id) !== String(msg.user_id)
            const isLastInGroup = !nextMsg || String(nextMsg?.user_id) !== String(msg.user_id)
            const showDate = shouldShowDateSeparator(msg, prevMsg)
            const showAvatar = !own && isLastInGroup

            if (msg._deleted) {
              return (
                <React.Fragment key={msg.id}>
                  {showDate && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0 6px' }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', background: 'var(--bg-secondary)', padding: '3px 12px', borderRadius: 99, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                        {formatDateSeparator(msg.created_at, t)}
                      </span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>
                      {msg.username} {t('collab.chat.deletedMessage') || 'deleted a message'} · {formatTime(msg.created_at, is12h)}
                    </span>
                  </div>
                </React.Fragment>
              )
            }

            const bubbleRadius = own
              ? `18px 18px ${isLastInGroup ? '4px' : '18px'} 18px`
              : `18px 18px 18px ${isLastInGroup ? '4px' : '18px'}`

            return (
              <React.Fragment key={msg.id}>
                {showDate && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0 6px' }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', background: 'var(--bg-secondary)', padding: '3px 12px', borderRadius: 99, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                      {formatDateSeparator(msg.created_at, t)}
                    </span>
                  </div>
                )}

                <div
                  style={{
                    display: 'flex',
                    alignItems: own ? 'flex-end' : 'flex-start',
                    flexDirection: own ? 'row-reverse' : 'row',
                    gap: 6,
                    marginTop: isNewGroup ? 10 : 1,
                    paddingLeft: own ? 40 : 0,
                    paddingRight: own ? 0 : 40,
                    transition: 'transform 0.25s ease, opacity 0.25s ease, max-height 0.25s ease',
                    ...(deletingIds.has(msg.id) ? { transform: 'scale(0.8)', opacity: 0.25 } : {}),
                  }}
                >
                  {!own && (
                    <div style={{ width: 28, flexShrink: 0, alignSelf: 'flex-end' }}>
                      {showAvatar && (
                        msg.user_avatar ? (
                          <img src={msg.user_avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                            {(msg.username || '?')[0].toUpperCase()}
                          </div>
                        )
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: own ? 'flex-end' : 'flex-start', maxWidth: '78%', minWidth: 0 }}>
                    {!own && isNewGroup && (
                      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 2, paddingLeft: 4 }}>
                        {msg.username}
                      </span>
                    )}

                    <div
                      style={{ position: 'relative' }}
                      onMouseEnter={() => setHoveredId(msg.id)}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      <div style={{ background: own ? '#007AFF' : 'var(--bg-secondary)', color: own ? '#fff' : 'var(--text-primary)', borderRadius: bubbleRadius, padding: '8px 14px', fontSize: 14, lineHeight: 1.4, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                        {msg.reply_text && (
                          <div style={{ padding: '5px 10px', marginBottom: 6, borderRadius: 12, background: own ? 'rgba(255,255,255,0.15)' : 'var(--bg-tertiary)', fontSize: 12, lineHeight: 1.3 }}>
                            <div style={{ fontWeight: 600, fontSize: 11, opacity: 0.7, marginBottom: 1 }}>{msg.reply_username || ''}</div>
                            <div style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(msg.reply_text || '').slice(0, 80)}</div>
                          </div>
                        )}
                        <MessageText text={msg.text} />
                        {(msg.text.match(URL_REGEX) || []).slice(0, 1).map((url) => (
                          <LinkPreview key={url} url={url} tripId={tripId} />
                        ))}
                      </div>

                      <div style={{ position: 'absolute', top: -14, display: 'flex', gap: 2, opacity: hoveredId === msg.id ? 1 : 0, pointerEvents: hoveredId === msg.id ? 'auto' : 'none', transition: 'opacity .1s', ...(own ? { left: -6 } : { right: -6 }) }}>
                        <button onClick={() => setReplyTo(msg)} title="Reply" style={{ width: 24, height: 24, borderRadius: '50%', border: 'none', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--accent-text)', padding: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                          <Reply size={11} />
                        </button>
                        {own && (
                          <button onClick={() => void handleDelete(msg.id)} title="Delete" style={{ width: 24, height: 24, borderRadius: '50%', border: 'none', background: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', padding: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 4, paddingLeft: own ? 0 : 8, paddingRight: own ? 8 : 0 }}>
                      {msg.reactions?.map((reaction) => (
                        <ReactionBadge key={`${msg.id}-${reaction.emoji}`} reaction={reaction} currentUserId={currentUser.id} onToggle={() => void handleToggleReaction(msg.id, reaction.emoji)} />
                      ))}
                      <div style={{ display: 'inline-flex', gap: 2 }}>
                        {QUICK_REACTIONS.map((emoji) => (
                          <button
                            key={`${msg.id}-${emoji}`}
                            onClick={() => void handleToggleReaction(msg.id, emoji)}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 999, padding: '2px 6px', fontSize: 12 }}
                            title={`React ${emoji}`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>

                    {isLastInGroup && (
                      <span style={{ fontSize: 9, color: 'var(--text-faint)', marginTop: 2, padding: '0 4px' }}>
                        {formatTime(msg.created_at, is12h)}
                      </span>
                    )}
                  </div>
                </div>
              </React.Fragment>
            )
          })}
        </div>
      )}

      <div style={{ flexShrink: 0, padding: '8px 12px calc(12px + env(safe-area-inset-bottom, 0px))', borderTop: '1px solid var(--border-faint)', background: 'var(--bg-card)' }}>
        {replyTo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px', borderRadius: 10, background: 'var(--bg-secondary)', borderLeft: '3px solid #007AFF', fontSize: 12, color: 'var(--text-muted)' }}>
            <Reply size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              <strong>{replyTo.username}</strong>: {(replyTo.text || '').slice(0, 60)}
            </span>
            <button onClick={() => setReplyTo(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)', display: 'flex', flexShrink: 0 }}>
              <X size={14} />
            </button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Smile size={20} />
          </div>

          <textarea
            ref={textareaRef}
            rows={1}
            style={{ flex: 1, resize: 'none', border: '1px solid var(--border-primary)', borderRadius: 20, padding: '8px 14px', fontSize: 14, lineHeight: 1.4, fontFamily: 'inherit', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', maxHeight: 100, overflowY: 'hidden' }}
            placeholder={t('collab.chat.placeholder')}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
          />

          <button
            onClick={() => void handleSend()}
            disabled={!text.trim() || sending}
            style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: text.trim() ? '#007AFF' : 'var(--border-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: text.trim() ? 'pointer' : 'default', flexShrink: 0, transition: 'background 0.15s' }}
          >
            <ArrowUp size={18} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ConvexCollabChat(props: ConvexCollabChatProps) {
  return (
    <ChatErrorBoundary>
      <ConvexCollabChatInner {...props} />
    </ChatErrorBoundary>
  )
}
