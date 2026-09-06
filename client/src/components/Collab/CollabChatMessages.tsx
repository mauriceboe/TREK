import React from 'react'
import { Trash2, Reply, ChevronUp } from 'lucide-react'
import { URL_REGEX } from './CollabChat.constants'
import { formatTime, formatDateSeparator, shouldShowDateSeparator } from './CollabChat.helpers'
import { MessageText } from './CollabChatMessageText'
import { CollabChatAttachment } from './CollabChatAttachment'
import { LinkPreview } from './CollabChatLinkPreview'
import { ReactionBadge } from './CollabChatReactionBadge'
import EmptyState from '../shared/EmptyState'

export function ChatMessages(props: any) {
  const { currentUser, tripId, t, is12h, can, trip, canEdit, messages, setMessages, loading, setLoading, hasMore, setHasMore, loadingMore, setLoadingMore, text, setText, replyTo, setReplyTo, hoveredId, setHoveredId, sending, setSending, showEmoji, setShowEmoji, reactMenu, setReactMenu, deletingIds, setDeletingIds, deleteTimersRef, containerRef, messagesRef, scrollRef, textareaRef, emojiBtnRef, isAtBottom, scrollToBottom, checkAtBottom, handleLoadMore, handleTextChange, handleSend, handleKeyDown, handleDelete, handleReact, handleEmojiSelect, isOwn, isEmojiOnly } = props
  return (
    <>
      {/* Messages */}
      {messages.length === 0 ? (
        // flex-1, like the message list it stands in for: without it the empty
        // state was only as tall as its own content and the composer rode up to
        // sit right under the mascot, with the rest of the panel left blank.
        <EmptyState scene="chat" title={t('collab.chat.empty')} className="min-h-0 flex-1" />
      ) : (
        <div ref={scrollRef} onScroll={checkAtBottom} className="chat-scroll" style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 14px 4px', WebkitOverflowScrolling: 'touch',
          display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          {hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 10px' }}>
              <button type="button" onClick={handleLoadMore} disabled={loadingMore} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 600,
                color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '1px solid var(--border-faint)',
                borderRadius: 99, padding: '5px 14px', cursor: 'pointer', fontFamily: 'inherit',
              }}>
                <ChevronUp size={13} />
                {loadingMore ? '...' : t('collab.chat.loadMore')}
              </button>
            </div>
          )}

          {messages.map((msg, idx) => {
            const own = isOwn(msg)
            const prevMsg = messages[idx - 1]
            const nextMsg = messages[idx + 1]
            const isNewGroup = idx === 0 || String(prevMsg?.user_id) !== String(msg.user_id)
            const isLastInGroup = !nextMsg || String(nextMsg?.user_id) !== String(msg.user_id)
            const showDate = shouldShowDateSeparator(msg, prevMsg)
            const showAvatar = !own && isLastInGroup
            const bigEmoji = isEmojiOnly(msg.text)
            const hasReply = msg.reply_text || msg.reply_to
            // Deleted message placeholder
            if (msg._deleted) {
              return (
                <React.Fragment key={msg.id}>
                  {showDate && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0 6px' }}>
                      <span style={{ fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600, color: 'var(--text-faint)', background: 'var(--bg-secondary)', padding: '3px 12px', borderRadius: 99, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                        {formatDateSeparator(msg.created_at, t)}
                      </span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
                    <span style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', fontStyle: 'italic' }}>
                      {msg.username} {t('collab.chat.deletedMessage') || 'deleted a message'} · {formatTime(msg.created_at, is12h)}
                    </span>
                  </div>
                </React.Fragment>
              )
            }

            // Bubble border radius — iMessage style tails
            const br = own
              ? `18px 18px ${isLastInGroup ? '4px' : '18px'} 18px`
              : `18px 18px 18px ${isLastInGroup ? '4px' : '18px'}`

            return (
              <React.Fragment key={msg.id}>
                {/* Date separator */}
                {showDate && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0 6px' }}>
                    <span style={{
                      fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600, color: 'var(--text-faint)',
                      background: 'var(--bg-secondary)', padding: '3px 12px', borderRadius: 99,
                      letterSpacing: 0.3, textTransform: 'uppercase',
                    }}>
                      {formatDateSeparator(msg.created_at, t)}
                    </span>
                  </div>
                )}

                <div style={{
                  display: 'flex', alignItems: own ? 'flex-end' : 'flex-start',
                  flexDirection: own ? 'row-reverse' : 'row',
                  gap: 6, marginTop: isNewGroup ? 10 : 1,
                  paddingLeft: own ? 40 : 0, paddingRight: own ? 0 : 40,
                  transition: 'transform 0.3s ease, opacity 0.3s ease, max-height 0.3s ease',
                  ...(deletingIds.has(msg.id) ? { transform: 'scale(0.3)', opacity: 0, maxHeight: 0, marginTop: 0, overflow: 'hidden' } : {}),
                }}>
                  {/* Avatar slot for others */}
                  {!own && (
                    <div style={{ width: 28, flexShrink: 0, alignSelf: 'flex-end' }}>
                      {showAvatar && (
                        msg.user_avatar ? (
                          <img src={msg.user_avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{
                            width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-tertiary)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 700, color: 'var(--text-muted)',
                          }}>
                            {(msg.username || '?')[0].toUpperCase()}
                          </div>
                        )
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: own ? 'flex-end' : 'flex-start', maxWidth: '78%', minWidth: 0 }}>
                    {/* Username for others at group start */}
                    {!own && isNewGroup && (
                      <span style={{ fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600, color: 'var(--text-faint)', marginBottom: 2, paddingLeft: 4 }}>
                        {msg.username}
                      </span>
                    )}

                    {/* Bubble */}
                    <div
                      style={{ position: 'relative' }}
                      onMouseEnter={() => setHoveredId(msg.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onContextMenu={e => { e.preventDefault(); if (canEdit) setReactMenu({ msgId: msg.id, x: e.clientX, y: e.clientY }) }}
                      onTouchEnd={e => {
                        const now = Date.now()
                        const lastTap = Number(e.currentTarget.dataset.lastTap) || 0
                        if (now - lastTap < 300 && canEdit) {
                          e.preventDefault()
                          const touch = e.changedTouches?.[0]
                          if (touch) setReactMenu({ msgId: msg.id, x: touch.clientX, y: touch.clientY })
                        }
                        e.currentTarget.dataset.lastTap = String(now)
                      }}
                    >
                      {bigEmoji ? (
                        <div style={{ fontSize: 'calc(40px * var(--fs-scale-title, 1))', lineHeight: 1.2, padding: '2px 0' }}>
                          {msg.text}
                        </div>
                      ) : (
                        <div style={{
                          background: own ? '#007AFF' : 'var(--bg-secondary)',
                          color: own ? '#fff' : 'var(--text-primary)',
                          borderRadius: br, padding: hasReply ? '4px 4px 8px 4px' : '8px 14px',
                          fontSize: 'calc(14px * var(--fs-scale-body, 1))', lineHeight: 1.4, wordBreak: 'break-word', whiteSpace: 'pre-wrap',
                        }}>
                          {/* Inline reply quote */}
                          {hasReply && (
                            <div style={{
                              padding: '5px 10px', marginBottom: 4, borderRadius: 12,
                              background: own ? 'rgba(255,255,255,0.15)' : 'var(--bg-tertiary)',
                              fontSize: 'calc(12px * var(--fs-scale-body, 1))', lineHeight: 1.3,
                            }}>
                              <div style={{ fontWeight: 600, fontSize: 'calc(11px * var(--fs-scale-caption, 1))', opacity: 0.7, marginBottom: 1 }}>
                                {msg.reply_username || ''}
                              </div>
                              <div style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {(msg.reply_text || '').slice(0, 80)}
                              </div>
                            </div>
                          )}
                          {hasReply ? (
                            <div style={{ padding: '0 10px 4px' }}><MessageText text={msg.text} /></div>
                          ) : <MessageText text={msg.text} />}
                          {msg.attachments?.map((attachment: any) => <CollabChatAttachment key={attachment.id} attachment={attachment} />)}
                          {(msg.text.match(URL_REGEX) || []).slice(0, 1).map(url => (
                            <LinkPreview key={url} url={url} tripId={tripId} own={own} onLoad={() => { if (isAtBottom.current) setTimeout(() => scrollToBottom('smooth'), 50) }} />
                          ))}
                        </div>
                      )}

                      {/* Hover actions */}
                      <div style={{
                        position: 'absolute', top: -14,
                        display: 'flex', gap: 2,
                        opacity: hoveredId === msg.id ? 1 : 0,
                        pointerEvents: hoveredId === msg.id ? 'auto' : 'none',
                        transition: 'opacity .1s',
                        ...(own ? { left: -6 } : { right: -6 }),
                      }}>
                        <button type="button" onClick={() => setReplyTo(msg)} title={t('collab.chat.reply')} style={{
                          width: 24, height: 24, borderRadius: '50%', border: 'none',
                          background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', color: 'var(--accent-text)', padding: 0,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.15)', transition: 'transform 0.12s',
                        }}
                          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.2)' }}
                          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
                        >
                          <Reply size={11} />
                        </button>
                        {own && canEdit && (
                          <button type="button" onClick={() => handleDelete(msg.id)} title={t('common.delete')} style={{
                            width: 24, height: 24, borderRadius: '50%', border: 'none',
                            background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', color: 'var(--accent-text)', padding: 0,
                            boxShadow: '0 2px 8px rgba(0,0,0,0.15)', transition: 'transform 0.12s, background 0.15s, color 0.15s',
                          }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.2)'; e.currentTarget.style.background = '#ef4444'; e.currentTarget.style.color = '#fff' }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent-text)' }}
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Reactions — iMessage style floating badge */}
                    {msg.reactions?.length > 0 && (
                      <div style={{
                        display: 'flex', gap: 3, marginTop: -6, marginBottom: 4,
                        justifyContent: own ? 'flex-end' : 'flex-start',
                        paddingLeft: own ? 0 : 8, paddingRight: own ? 8 : 0,
                        position: 'relative', zIndex: 1,
                      }}>
                        <div style={{
                          display: 'inline-flex', alignItems: 'center', gap: 2, padding: '3px 6px',
                          borderRadius: 99, background: 'var(--bg-card)',
                          boxShadow: '0 1px 6px rgba(0,0,0,0.12)', border: '1px solid var(--border-faint)',
                        }}>
                          {msg.reactions.map(r => (
                            <ReactionBadge key={r.emoji} reaction={r} currentUserId={currentUser.id} onReact={() => { if (canEdit) handleReact(msg.id, r.emoji) }} />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Timestamp — only on last message of group */}
                    {isLastInGroup && (
                      <span style={{ fontSize: 'calc(9px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', marginTop: 2, padding: '0 4px' }}>
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

    </>
  )
}
