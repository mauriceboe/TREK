import { createPortal } from 'react-dom'
import { ArrowUp, ImagePlus, Reply, Smile, X } from 'lucide-react'
import type { User } from '../../types'
import { useCollabChat } from './useCollabChat'
import { ChatMessages } from './CollabChatMessages'
import { EmojiPicker } from './CollabChatEmojiPicker'
import { ReactionMenu } from './CollabChatReactionMenu'

/* ── Main Component ── */
interface CollabChatProps {
  tripId: number
  currentUser: User
}

export default function CollabChat({ tripId, currentUser }: CollabChatProps) {
  const S = useCollabChat(tripId, currentUser)
  const { t, canEdit, loading, text, replyTo, setReplyTo, sending, showEmoji, setShowEmoji, reactMenu, setReactMenu, containerRef, textareaRef, emojiBtnRef, imageInputRef, imageFiles, imagePreviews, uploadProgress, addImageFiles, removeImage, handlePaste, handleDrop, handleTextChange, handleSend, handleKeyDown, handleReact, handleEmojiSelect } = S
  if (loading) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border-faint)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }
  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0, height: '100%' }}>
      <ChatMessages {...S} />
      {/* Composer */}
      <div onDragOver={e => e.preventDefault()} onDrop={handleDrop} style={{ flexShrink: 0, paddingTop: 8, paddingLeft: 12, paddingRight: 12, borderTop: '1px solid var(--border-faint)' }} className="pb-3 bg-surface-card">
        {/* Reply preview */}
        {replyTo && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
            padding: '6px 10px', borderRadius: 10, background: 'var(--bg-secondary)',
            borderLeft: '3px solid #007AFF', fontSize: 'calc(12px * var(--fs-scale-body, 1))', color: 'var(--text-muted)',
          }}>
            <Reply size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              <strong>{replyTo.username}</strong>: {(replyTo.text || '').slice(0, 60)}
            </span>
            <button type="button" onClick={() => setReplyTo(null)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)',
              display: 'flex', flexShrink: 0,
            }}>
              <X size={14} />
            </button>
          </div>
        )}

        {imagePreviews.length > 0 && <div style={{ display: 'flex', gap: 8, marginBottom: 8, overflowX: 'auto' }}>{imagePreviews.map((url, i) => <div key={url} style={{ position: 'relative' }}><img src={url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} /><button type="button" onClick={() => removeImage(i)} aria-label="Remove image" style={{ position: 'absolute', top: -6, right: -6, border: 0, borderRadius: '50%', background: 'var(--text-primary)', color: 'var(--bg-primary)', width: 18, height: 18, cursor: 'pointer' }}>×</button></div>)}</div>}
        {uploadProgress > 0 && uploadProgress < 100 && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Uploading {uploadProgress}%</div>}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
          {/* Emoji button */}
          {canEdit && (
            <button type="button" ref={emojiBtnRef} onClick={() => setShowEmoji(!showEmoji)} style={{
              width: 34, height: 34, borderRadius: '50%', border: 'none',
              background: showEmoji ? 'var(--bg-hover)' : 'transparent',
              color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', padding: 0, flexShrink: 0, transition: 'background 0.15s',
            }}>
              <Smile size={20} />
            </button>
          )}

          {canEdit && <><input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden onChange={e => { if (e.target.files) addImageFiles(e.target.files); e.currentTarget.value = '' }} /><button type="button" onClick={() => imageInputRef.current?.click()} aria-label="Attach images" style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: 'transparent', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}><ImagePlus size={19} /></button></>}

          <textarea
            ref={textareaRef}
            rows={1}
            disabled={!canEdit}
            style={{
              flex: 1, resize: 'none', border: '1px solid var(--border-primary)', borderRadius: 20,
              padding: '8px 14px', fontSize: 'calc(14px * var(--fs-scale-body, 1))', lineHeight: 1.4, fontFamily: 'inherit',
              background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none',
              maxHeight: 100, overflowY: 'hidden',
              opacity: canEdit ? 1 : 0.5,
            }}
            placeholder={t('collab.chat.placeholder')}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />

          {/* Send */}
          {canEdit && (
            <button type="button" onClick={handleSend} disabled={(!text.trim() && !imageFiles.length) || sending} style={{
              width: 34, height: 34, borderRadius: '50%', border: 'none',
              background: text.trim() || imageFiles.length ? '#007AFF' : 'var(--border-primary)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: text.trim() || imageFiles.length ? 'pointer' : 'default', flexShrink: 0,
              transition: 'background 0.15s',
            }}>
              <ArrowUp size={18} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>

      {/* Emoji picker */}
      {showEmoji && <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} anchorRef={emojiBtnRef} containerRef={containerRef} />}

      {/* Reaction quick menu (right-click) */}
      {reactMenu && createPortal(
        <ReactionMenu x={reactMenu.x} y={reactMenu.y} onReact={(emoji) => handleReact(reactMenu.msgId, emoji)} onClose={() => setReactMenu(null)} />,
        document.body
      )}
    </div>
  )
}
