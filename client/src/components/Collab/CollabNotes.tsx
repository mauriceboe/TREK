import ReactDOM from 'react-dom'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import DOM from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Plus, Trash2, Pin, PinOff, Pencil, X, Check, StickyNote, Settings, ExternalLink, Maximize2 } from 'lucide-react'
import { collabApi } from '../../api/client'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { addListener, removeListener } from '../../api/websocket'
import { useTranslation } from '../../i18n'
import type { User } from '../../types'

interface NoteFile {
  id: number
  filename: string
  original_name: string
  mime_type: string
  url?: string
}

interface CollabNote {
  id: number
  trip_id: number
  title: string
  content: string
  category: string
  website: string | null
  pinned: boolean
  color: string | null
  username: string
  avatar_url: string | null
  avatar: string | null
  user_id: number
  created_at: string
  author?: { username: string; avatar: string | null }
  user?: { username: string; avatar: string | null }
  files?: NoteFile[]
}

interface NoteAuthor {
  username: string
  avatar?: string | null
}

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"

// ── Website Thumbnail (fetches OG image) ────────────────────────────────────
const ogCache = {}

interface WebsiteThumbnailProps {
  url: string
  tripId: number
  color: string
}

function WebsiteThumbnail({ url, tripId, color }: WebsiteThumbnailProps) {
  const [data, setData] = useState(ogCache[url] || null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (ogCache[url]) { setData(ogCache[url]); return }
    collabApi.linkPreview(tripId, url).then(d => { ogCache[url] = d; setData(d) }).catch(() => setFailed(true))
  }, [url, tripId])

  const domain = (() => { try { return new URL(url).hostname.replace('www.', '') } catch { return 'link' } })()

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={data?.title || url}
      style={{
        width: 48, height: 48, borderRadius: 8, cursor: 'pointer', overflow: 'hidden',
        background: data?.image ? 'none' : 'var(--bg-tertiary)', border: 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
        textDecoration: 'none', transition: 'transform 0.12s, box-shadow 0.12s', flexShrink: 0,
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)' }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none' }}>
      {data?.image && !failed ? (
        <img src={data.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setFailed(true)} />
      ) : (
        <>
          <ExternalLink size={14} color="var(--text-muted)" />
          <span style={{ fontSize: 7, fontWeight: 600, color: 'var(--text-muted)', maxWidth: 42, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
            {domain}
          </span>
        </>
      )}
    </a>
  )
}

// ── File Preview Portal ─────────────────────────────────────────────────────
interface FilePreviewPortalProps {
  file: NoteFile | null
  onClose: () => void
}

function FilePreviewPortal({ file, onClose }: FilePreviewPortalProps) {
  if (!file) return null
  const url = file.url || `/uploads/${file.filename}`
  const isImage = file.mime_type?.startsWith('image/')
  const isPdf = file.mime_type === 'application/pdf'
  const isTxt = file.mime_type?.startsWith('text/')

  return ReactDOM.createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      {isImage ? (
        /* Image lightbox — floating controls */
        <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
          <img src={url} alt={file.original_name} style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8, display: 'block' }} />
          <div style={{ position: 'absolute', top: -36, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{file.original_name}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <a href={url} target="_blank" rel="noreferrer" style={{ color: 'rgba(255,255,255,0.7)', display: 'flex' }}><ExternalLink size={15} /></a>
              <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.7)', display: 'flex', padding: 0 }}><X size={17} /></button>
            </div>
          </div>
        </div>
      ) : (
        /* Document viewer — card with header */
        <div style={{ width: '100%', maxWidth: 950, height: '94vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-card)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--border-primary)', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{file.original_name}</span>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <a href={url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--text-muted)', textDecoration: 'none' }}><ExternalLink size={13} /></a>
              <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 2 }}><X size={18} /></button>
            </div>
          </div>
          {(isPdf || isTxt) ? (
            <object data={`${url}#view=FitH`} type={file.mime_type} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} title={file.original_name}>
              <p style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-primary)', textDecoration: 'underline' }}>Download</a>
              </p>
            </object>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
              <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-primary)', textDecoration: 'underline', fontSize: 14 }}>Download {file.original_name}</a>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body
  )
}

const NOTE_COLORS = [
  { value: '#6366f1', label: 'Indigo' },
  { value: '#ef4444', label: 'Red' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#10b981', label: 'Emerald' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Violet' },
]

const formatTimestamp = (ts, t, locale) => {
  if (!ts) return ''
  const d = new Date(ts.endsWith?.('Z') ? ts : ts + 'Z')
  const now = new Date()
  const diffMs = now - d
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return t('collab.chat.justNow') || 'just now'
  if (diffMins < 60) return t('collab.chat.minutesAgo', { n: diffMins }) || `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return t('collab.chat.hoursAgo', { n: diffHrs }) || `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 7) return t('collab.notes.daysAgo', { n: diffDays }) || `${diffDays}d ago`
  return d.toLocaleDateString(locale || undefined, { month: 'short', day: 'numeric' })
}

// ── Avatar ──────────────────────────────────────────────────────────────────
interface UserAvatarProps {
  user: NoteAuthor | null
  size?: number
}

function UserAvatar({ user, size = 14 }: UserAvatarProps) {
  if (!user) return null
  if (user.avatar) {
    return (
      <img
        src={user.avatar}
        alt={user.username}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
          background: 'var(--bg-tertiary)',
        }}
      />
    )
  }
  const initials = (user.username || '?').slice(0, 1)
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: 'var(--bg-tertiary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size * 0.45,
      fontWeight: 600,
      color: 'var(--text-faint)',
      flexShrink: 0,
      textTransform: 'uppercase',
      fontFamily: FONT,
    }}>
      {initials}
    </div>
  )
}

// ── New Note Modal (portal to body) ─────────────────────────────────────────
interface NoteFormModalProps {
  onClose: () => void
  onSubmit: (data: { title: string; content: string; category: string; website: string; files?: File[] }) => Promise<void>
  onDeleteFile?: (noteId: number, fileId: number) => Promise<void>
  existingCategories: string[]
  categoryColors: Record<string, string>
  getCategoryColor: (category: string) => string
  note: CollabNote | null
  tripId: number
  t: (key: string) => string
}

function NoteFormModal({ onClose, onSubmit, onDeleteFile, existingCategories, categoryColors, getCategoryColor, note, tripId, t }: NoteFormModalProps) {
  const can = useCanDo()
  const tripObj = useTripStore((s) => s.trip)
  const canUploadFiles = can('file_upload', tripObj)
  const isEdit = !!note
  const allCategories = [...new Set([...existingCategories, ...Object.keys(categoryColors || {})])].filter(Boolean)

  const [title, setTitle] = useState(note?.title || '')
  const [content, setContent] = useState(note?.content || '')
  const [category, setCategory] = useState(note?.category || allCategories[0] || '')
  const [website, setWebsite] = useState(note?.website || '')
  const [pendingFiles, setPendingFiles] = useState([])
  const [existingAttachments, setExistingAttachments] = useState(note?.attachments || [])
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef(null)

  const finalCategory = category

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await onSubmit({
        title: title.trim(),
        content: content.trim(),
        category: finalCategory || null,
        color: getCategoryColor(finalCategory),
        website: website.trim() || null,
        _pendingFiles: pendingFiles,
      })
      onClose()
    } catch {
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteAttachment = async (fileId) => {
    if (onDeleteFile && note) {
      await onDeleteFile(note.id, fileId)
      setExistingAttachments(prev => prev.filter(a => a.id !== fileId))
    }
  }

  const canSubmit = title.trim() && !submitting

  return ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--overlay-bg, rgba(0,0,0,0.35))',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
        fontFamily: FONT,
      }}
      onClick={onClose}
    >
      <form
        style={{
          background: 'var(--bg-card)',
          borderRadius: 16,
          width: '100%',
          maxWidth: 400,
          maxHeight: '90vh',
          overflow: 'auto',
          border: '1px solid var(--border-faint)',
        }}
        onClick={e => e.stopPropagation()}
        onPaste={e => {
          if (!canUploadFiles) return
          const items = e.clipboardData?.items
          if (!items) return
          for (const item of Array.from(items)) {
            if (item.type.startsWith('image/') || item.type === 'application/pdf') {
              e.preventDefault()
              const file = item.getAsFile()
              if (file) setPendingFiles(prev => [...prev, file])
              return
            }
          }
        }}
        onSubmit={handleSubmit}
      >
        {/* Modal header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 12px',
          borderBottom: '1px solid var(--border-faint)',
        }}>
          <h3 style={{
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--text-primary)',
            margin: 0,
            fontFamily: FONT,
          }}>
            {isEdit ? t('collab.notes.edit') : t('collab.notes.new')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-faint)',
              padding: 2,
              borderRadius: 6,
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Modal body */}
        <div style={{
          padding: '14px 16px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {/* Title */}
          <div>
            <div style={{
              fontSize: 9,
              fontWeight: 600,
              color: 'var(--text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
              fontFamily: FONT,
            }}>
              {t('collab.notes.title')}
            </div>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('collab.notes.titlePlaceholder')}
              style={{
                width: '100%',
                border: '1px solid var(--border-primary)',
                borderRadius: 10,
                padding: '8px 12px',
                fontSize: 13,
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Content */}
          <div>
            <div style={{
              fontSize: 9,
              fontWeight: 600,
              color: 'var(--text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
              fontFamily: FONT,
            }}>
              {t('collab.notes.contentPlaceholder')}
            </div>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={t('collab.notes.contentPlaceholder')}
              style={{
                width: '100%',
                border: '1px solid var(--border-primary)',
                borderRadius: 10,
                padding: '8px 12px',
                fontSize: 13,
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
                resize: 'vertical',
                minHeight: 180,
                lineHeight: 1.5,
              }}
            />
          </div>

          {/* Category pills */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, fontFamily: FONT }}>
              {t('collab.notes.category')}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {allCategories.map(cat => {
                const c = getCategoryColor(cat)
                const active = category === cat
                return (
                  <button key={cat} type="button" onClick={() => setCategory(cat)}
                    style={{ padding: '4px 12px', borderRadius: 99, border: active ? `1.5px solid ${c}` : '1px solid var(--border-faint)', background: active ? `${c}18` : 'transparent', color: active ? c : 'var(--text-muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                    {cat}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Website */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontFamily: FONT }}>
              {t('collab.notes.website')}
            </div>
            <input value={website} onChange={e => setWebsite(e.target.value)}
              placeholder={t('collab.notes.websitePlaceholder')}
              style={{ width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10, padding: '8px 12px', fontSize: 13, background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
          </div>

          {/* File attachments */}
          {canUploadFiles && <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontFamily: FONT }}>
              {t('collab.notes.attachFiles')}
            </div>
            <input id="note-file-input" ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={e => { setPendingFiles(prev => [...prev, ...Array.from((e.target as HTMLInputElement).files)]); e.target.value = '' }} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Existing attachments (edit mode) */}
              {existingAttachments.map(a => {
                const isImage = a.mime_type?.startsWith('image/')
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)' }}>
                    {isImage && <img src={a.url} style={{ width: 18, height: 18, objectFit: 'cover', borderRadius: 3 }} />}
                    {(a.original_name || '').length > 20 ? a.original_name.slice(0, 17) + '...' : a.original_name}
                    <button type="button" onClick={() => handleDeleteAttachment(a.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 0, display: 'flex' }}>
                      <X size={10} />
                    </button>
                  </div>
                )
              })}
              {/* New pending files */}
              {pendingFiles.map((f, i) => (
                <div key={`new-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)' }}>
                  {f.name.length > 20 ? f.name.slice(0, 17) + '...' : f.name}
                  <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 0, display: 'flex' }}>
                    <X size={10} />
                  </button>
                </div>
              ))}
              <label htmlFor="note-file-input"
                style={{ padding: '4px 10px', borderRadius: 8, border: '1px dashed var(--border-faint)', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 11, fontFamily: FONT, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Plus size={11} /> {t('files.attach') || 'Add'}
              </label>
            </div>
          </div>}

          {/* Submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              width: '100%',
              borderRadius: 99,
              padding: '7px 14px',
              background: canSubmit ? 'var(--accent)' : 'var(--border-primary)',
              color: canSubmit ? 'var(--accent-text)' : 'var(--text-faint)',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT,
              border: 'none',
              cursor: canSubmit ? 'pointer' : 'default',
              marginTop: 4,
            }}
          >
            {submitting ? '...' : isEdit ? t('collab.notes.save') : t('collab.notes.create')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

interface EditableCatNameProps {
  name: string
  onRename: (newName: string) => void
}

function EditableCatName({ name, onRename }: EditableCatNameProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const inputRef = useRef(null)

  useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select() } }, [editing])

  const save = () => {
    setEditing(false)
    if (value.trim() && value.trim() !== name) onRename(value.trim())
    else setValue(name)
  }

  if (editing) {
    return <input ref={inputRef} value={value} onChange={e => setValue(e.target.value)}
      onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setValue(name); setEditing(false) } }}
      style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: 6, padding: '2px 8px', background: 'var(--bg-input)', fontFamily: 'inherit', outline: 'none' }} />
  }

  return (
    <span onClick={() => { setValue(name); setEditing(true) }}
      style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', padding: '2px 0' }}
      title="Click to rename">
      {name}
    </span>
  )
}

// ── Category Settings Modal ──────────────────────────────────────────────────
interface CategorySettingsModalProps {
  onClose: () => void
  categories: string[]
  categoryColors: Record<string, string>
  onSave: (colors: Record<string, string>) => void
  onRenameCategory: (oldName: string, newName: string) => Promise<void>
  t: (key: string) => string
}

function CategorySettingsModal({ onClose, categories, categoryColors, onSave, onRenameCategory, t }: CategorySettingsModalProps) {
  const [localColors, setLocalColors] = useState({ ...categoryColors })
  const [renames, setRenames] = useState({}) // { oldName: newName }
  const [newCatName, setNewCatName] = useState('')

  const handleColorChange = (cat, color) => {
    setLocalColors(prev => ({ ...prev, [cat]: color }))
  }

  const handleAddCategory = () => {
    if (!newCatName.trim() || localColors[newCatName.trim()]) return
    setLocalColors(prev => ({ ...prev, [newCatName.trim()]: NOTE_COLORS[Object.keys(prev).length % NOTE_COLORS.length].value }))
    setNewCatName('')
  }

  const handleRemoveCategory = (cat) => {
    setLocalColors(prev => { const n = { ...prev }; delete n[cat]; return n })
  }

  const handleRenameCategory = (oldName, newName) => {
    if (!newName.trim() || newName.trim() === oldName || localColors[newName.trim()]) return
    // Track rename for saving to DB later
    const originalName = Object.entries(renames).find(([, v]) => v === oldName)?.[0] || oldName
    setRenames(prev => ({ ...prev, [originalName]: newName.trim() }))
    setLocalColors(prev => {
      const n = {}
      for (const [k, v] of Object.entries(prev)) {
        n[k === oldName ? newName.trim() : k] = v
      }
      return n
    })
  }

  const handleSave = async () => {
    // Apply renames to notes in DB
    for (const [oldName, newName] of Object.entries(renames)) {
      if (oldName !== newName) await onRenameCategory(oldName, newName)
    }
    await onSave(localColors)
    onClose()
  }

  // Merge existing categories from notes with saved colors
  const allCats = [...new Set([...categories, ...Object.keys(localColors)])]

  return ReactDOM.createPortal(
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.35))',
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16, fontFamily: FONT,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 16, width: '100%', maxWidth: 420,
        maxHeight: '80vh', overflow: 'auto', border: '1px solid var(--border-faint)',
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 12px', borderBottom: '1px solid var(--border-faint)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            {t('collab.notes.categorySettings') || 'Category Settings'}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 2, display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        {/* Categories list */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {allCats.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-faint)', textAlign: 'center', padding: 16 }}>
              {t('collab.notes.noCategoriesYet') || 'No categories yet'}
            </p>
          )}
          {allCats.map(cat => (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Color swatches */}
              <div style={{ display: 'flex', gap: 4 }}>
                {NOTE_COLORS.map(c => (
                  <button key={c.value} onClick={() => handleColorChange(cat, c.value)} style={{
                    width: 20, height: 20, borderRadius: 6, background: c.value, border: 'none', cursor: 'pointer', padding: 0,
                    outline: (localColors[cat] || NOTE_COLORS[0].value) === c.value ? '2px solid var(--text-primary)' : '2px solid transparent',
                    outlineOffset: 1, transition: 'transform 0.1s',
                    transform: (localColors[cat] || NOTE_COLORS[0].value) === c.value ? 'scale(1.1)' : 'scale(1)',
                  }} />
                ))}
              </div>
              {/* Category name — editable */}
              <EditableCatName name={cat} onRename={(newName) => handleRenameCategory(cat, newName)} />
              {/* Delete */}
              <button onClick={() => handleRemoveCategory(cat)} style={{
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 3, display: 'flex',
              }}
                onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          {/* Add new */}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input value={newCatName} onChange={e => setNewCatName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddCategory()}
              placeholder={t('collab.notes.newCategory')}
              style={{
                flex: 1, border: '1px solid var(--border-primary)', borderRadius: 10, padding: '8px 12px',
                fontSize: 13, background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
              }} />
            <button onClick={handleAddCategory} disabled={!newCatName.trim()} style={{
              background: newCatName.trim() ? 'var(--accent)' : 'var(--border-primary)', color: 'var(--accent-text)',
              border: 'none', borderRadius: 10, padding: '8px 14px', cursor: newCatName.trim() ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', flexShrink: 0,
            }}>
              <Plus size={14} />
            </button>
          </div>

          {/* Save */}
          <button onClick={handleSave} style={{
            width: '100%', borderRadius: 99, padding: '9px 14px', background: 'var(--accent)', color: 'var(--accent-text)',
            fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', marginTop: 8,
          }}>
            {t('collab.notes.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Note Card ───────────────────────────────────────────────────────────────
interface NoteCardProps {
  note: CollabNote
  currentUser: User
  canEdit: boolean
  onUpdate: (noteId: number, data: Partial<CollabNote>) => Promise<void>
  onDelete: (noteId: number) => Promise<void>
  onEdit: (note: CollabNote) => void
  onView: (note: CollabNote) => void
  onPreviewFile: (file: NoteFile) => void
  getCategoryColor: (category: string) => string
  tripId: number
  t: (key: string) => string
}

function NoteCard({ note, currentUser, canEdit, onUpdate, onDelete, onEdit, onView, onPreviewFile, getCategoryColor, tripId, t }: NoteCardProps) {
  const [hovered, setHovered] = useState(false)

  const author = note.author || note.user || { username: note.username, avatar: note.avatar_url || (note.avatar ? `/uploads/avatars/${note.avatar}` : null) }
  const color = getCategoryColor ? getCategoryColor(note.category) : (note.color || '#6366f1')

  const handleTogglePin = useCallback(() => {
    onUpdate(note.id, { pinned: !note.pinned })
  }, [note.id, note.pinned, onUpdate])

  const handleDelete = useCallback(() => {
    onDelete(note.id)
  }, [note.id, onDelete])

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        borderRadius: 12,
        overflow: 'hidden',
        border: `1px solid ${note.pinned ? color + '40' : color + '25'}`,
        background: note.pinned ? `${color}08` : 'var(--bg-card)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT,
        transition: 'transform 0.12s, box-shadow 0.12s',
        ...(hovered ? { transform: 'translateY(-1px)', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' } : {}),
      }}
    >
      {/* Header bar — like reservation cards */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
        background: `${color}0d`,
      }}>
        {!!note.pinned && <Pin size={9} color={color} style={{ flexShrink: 0 }} />}
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {note.title}
          </span>
          {note.category && (
            <span style={{ fontSize: 8, fontWeight: 600, color, background: `${color}18`, padding: '2px 6px', borderRadius: 99, flexShrink: 0, letterSpacing: '0.02em', textTransform: 'uppercase' }}>
              {note.category}
            </span>
          )}
        </span>

        {/* Hover actions in header */}
        {(
          <div style={{
            display: 'flex', gap: 2,
          }}>
            {note.content && (
              <button onClick={() => onView?.(note)} title={t('collab.notes.expand') || 'Expand'}
                style={{ padding: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <Maximize2 size={10} />
              </button>
            )}
            {canEdit && <button onClick={handleTogglePin} title={note.pinned ? t('collab.notes.unpin') : t('collab.notes.pin')}
              style={{ padding: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}
              onMouseEnter={e => e.currentTarget.style.color = color}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
              {note.pinned ? <PinOff size={10} /> : <Pin size={10} />}
            </button>}
            {canEdit && <button onClick={() => onEdit?.(note)} title={t('collab.notes.edit')}
              style={{ padding: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
              <Pencil size={10} />
            </button>}
            {canEdit && <button onClick={handleDelete} title={t('collab.notes.delete')}
              style={{ padding: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}
              onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
              <Trash2 size={10} />
            </button>}
            <div style={{ width: 1, height: 12, background: 'var(--border-faint)', flexShrink: 0, marginLeft: 1, marginRight: 1 }} />
            {/* Author avatar */}
            <div style={{ position: 'relative', flexShrink: 0 }}
              onMouseEnter={e => { const tip = e.currentTarget.querySelector('[data-tip]'); if (tip) tip.style.opacity = '1' }}
              onMouseLeave={e => { const tip = e.currentTarget.querySelector('[data-tip]'); if (tip) tip.style.opacity = '0' }}>
              <UserAvatar user={author} size={16} />
              <div data-tip style={{
                position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
                marginBottom: 6, pointerEvents: 'none', opacity: 0, transition: 'opacity 0.12s',
                whiteSpace: 'nowrap', zIndex: 10,
                background: 'var(--bg-card)', color: 'var(--text-primary)',
                fontSize: 11, fontWeight: 500, padding: '5px 10px', borderRadius: 8,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid var(--border-faint)',
              }}>
                {author.username}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Card body */}
      <div style={{
        padding: '8px 12px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        flex: 1,
      }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {note.content && (
              <div className="collab-note-md" style={{
                fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0,
                maxHeight: '4.5em', overflow: 'hidden',
                wordBreak: 'break-word', fontFamily: FONT,
              }}>
                <Markdown remarkPlugins={[remarkGfm]}>{note.content}</Markdown>
              </div>
            )}
          </div>
              {/* Right: website + attachment thumbnails */}
              {(note.website || note.attachments?.length > 0) && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start' }}>
                  {/* Website */}
                  {note.website && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      <span style={{ fontSize: 7, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.3 }}>Link</span>
                      <WebsiteThumbnail url={note.website} tripId={tripId} color={color} />
                    </div>
                  )}
                  {/* Files */}
                  {(note.attachments || []).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      <span style={{ fontSize: 7, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{t('files.title')}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                  {(note.attachments || []).slice(0, note.website ? 1 : 2).map(a => {
                    const isImage = a.mime_type?.startsWith('image/')
                    const ext = (a.original_name || '').split('.').pop()?.toUpperCase() || '?'
                    return isImage ? (
                      <img key={a.id} src={a.url} alt={a.original_name}
                        style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, cursor: 'pointer', transition: 'transform 0.12s, box-shadow 0.12s' }}
                        onClick={() => onPreviewFile?.(a)}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)' }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none' }} />
                    ) : (
                      <div key={a.id} title={a.original_name} onClick={() => onPreviewFile?.(a)}
                        style={{
                          width: 48, height: 48, borderRadius: 8, cursor: 'pointer',
                          background: a.mime_type === 'application/pdf' ? '#ef44441a' : 'var(--bg-secondary)',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                          transition: 'transform 0.12s, box-shadow 0.12s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)' }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none' }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: a.mime_type === 'application/pdf' ? '#ef4444' : 'var(--text-muted)', letterSpacing: 0.3 }}>{ext}</span>
                      </div>
                    )
                  })}
                  {(note.attachments?.length || 0) > (note.website ? 1 : 2) && (
                    <span style={{ fontSize: 8, color: 'var(--text-faint)', textAlign: 'center' }}>+{(note.attachments?.length || 0) - (note.website ? 1 : 2)}</span>
                  )}
                      </div>
                    </div>
                  )}
                </div>
              )}
        </div>
      </div>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────
interface CollabNotesProps {
  tripId: number
  currentUser: User
}

export default function CollabNotes({ tripId, currentUser }: CollabNotesProps) {
  const { t } = useTranslation()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const canEdit = can('collab_edit', trip)
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [showNewModal, setShowNewModal] = useState(false)
  const [editingNote, setEditingNote] = useState(null)
  const [viewingNote, setViewingNote] = useState<CollabNote | null>(null)
  const [previewFile, setPreviewFile] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [activeCategory, setActiveCategory] = useState(null)

  // Empty categories (no notes yet) stored in localStorage
  const [emptyCategories, setEmptyCategories] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`collab-cats-${tripId}`)) || {} } catch { return {} }
  })
  const saveEmptyCategories = (map) => {
    setEmptyCategories(map)
    localStorage.setItem(`collab-cats-${tripId}`, JSON.stringify(map))
  }

  // Category colors: from notes first, then from empty categories
  const categoryColors = useMemo(() => {
    const map = { ...emptyCategories }
    for (const n of notes) {
      if (n.category && n.color) map[n.category] = n.color
    }
    return map
  }, [notes, emptyCategories])

  const getCategoryColor = (cat) => {
    if (!cat) return NOTE_COLORS[0].value
    if (categoryColors[cat]) return categoryColors[cat]
    return NOTE_COLORS[Object.keys(categoryColors).length % NOTE_COLORS.length].value
  }

  // ── Load notes on mount ──
  useEffect(() => {
    if (!tripId) return
    let cancelled = false
    setLoading(true)
    collabApi.getNotes(tripId)
      .then(data => { if (!cancelled) setNotes(data?.notes || data || []) })
      .catch(() => { if (!cancelled) setNotes([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tripId])

  // ── WebSocket real-time sync ──
  useEffect(() => {
    if (!tripId) return

    const handler = (msg) => {
      if (msg.type === 'collab:note:created' && msg.note) {
        setNotes(prev => {
          if (prev.some(n => n.id === msg.note.id)) return prev
          return [msg.note, ...prev]
        })
      }
      if (msg.type === 'collab:note:updated' && msg.note) {
        setNotes(prev =>
          prev.map(n => (n.id === msg.note.id ? { ...n, ...msg.note } : n))
        )
      }
      if (msg.type === 'collab:note:deleted') {
        const deletedId = msg.noteId || msg.id
        if (deletedId) {
          setNotes(prev => prev.filter(n => n.id !== deletedId))
        }
      }
    }

    addListener(handler)
    return () => removeListener(handler)
  }, [tripId])

  // ── Actions ──
  const handleCreateNote = useCallback(async (data) => {
    const pendingFiles = data._pendingFiles || []
    delete data._pendingFiles
    const created = await collabApi.createNote(tripId, data)
    if (created) {
      const note = created.note || created
      // Upload pending files
      if (pendingFiles.length > 0 && note.id) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          try { await collabApi.uploadNoteFile(tripId, note.id, fd) } catch {}
        }
        // Reload note with attachments
        const fresh = await collabApi.getNotes(tripId)
        if (fresh?.notes) setNotes(fresh.notes)
        window.dispatchEvent(new Event('collab-files-changed'))
        return
      }
      setNotes(prev => {
        if (prev.some(n => n.id === note.id)) return prev
        return [note, ...prev]
      })
    }
  }, [tripId])

  const handleUpdateNote = useCallback(async (noteId, data) => {
    const result = await collabApi.updateNote(tripId, noteId, data)
    const updated = result?.note || result
    if (updated) {
      setNotes(prev =>
        prev.map(n => (n.id === noteId ? { ...n, ...updated } : n))
      )
    }
  }, [tripId])

  const saveCategoryColors = useCallback(async (newMap) => {
    // Update notes with changed colors
    for (const [cat, color] of Object.entries(newMap)) {
      const notesInCat = notes.filter(n => n.category === cat)
      if (notesInCat.length > 0 && categoryColors[cat] !== color) {
        for (const n of notesInCat) {
          await handleUpdateNote(n.id, { color })
        }
      }
    }
    // Save all categories (including empty ones) to localStorage
    const emptyCats = {}
    for (const [cat, color] of Object.entries(newMap)) {
      if (!notes.some(n => n.category === cat)) {
        emptyCats[cat] = color
      }
    }
    saveEmptyCategories(emptyCats)
  }, [categoryColors, notes, handleUpdateNote])

  const handleEditSubmit = useCallback(async (data) => {
    if (!editingNote) return
    const pendingFiles = data._pendingFiles || []
    delete data._pendingFiles
    await handleUpdateNote(editingNote.id, data)
    if (pendingFiles.length > 0) {
      for (const file of pendingFiles) {
        const fd = new FormData()
        fd.append('file', file)
        try { await collabApi.uploadNoteFile(tripId, editingNote.id, fd) } catch {}
      }
      const fresh = await collabApi.getNotes(tripId)
      if (fresh?.notes) setNotes(fresh.notes)
      window.dispatchEvent(new Event('collab-files-changed'))
    }
  }, [editingNote, tripId, handleUpdateNote])

  const handleDeleteNoteFile = useCallback(async (noteId, fileId) => {
    try { await collabApi.deleteNoteFile(tripId, noteId, fileId) } catch {}
    window.dispatchEvent(new Event('collab-files-changed'))
  }, [tripId])

  const handleDeleteNote = useCallback(async (noteId) => {
    await collabApi.deleteNote(tripId, noteId)
    setNotes(prev => prev.filter(n => n.id !== noteId))
    window.dispatchEvent(new Event('collab-files-changed'))
  }, [tripId])

  // ── Derived data ──
  const categories = [...new Set(notes.map(n => n.category).filter(Boolean))]

  const sortedNotes = [...notes]
    .filter(n => activeCategory === null || n.category === activeCategory)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      const tA = new Date(a.updated_at || a.created_at || 0).getTime()
      const tB = new Date(b.updated_at || b.created_at || 0).getTime()
      return tB - tA
    })

  // ── Loading state ──
  if (loading) {
    return (
      <div style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT,
      }}>
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-faint)',
        }}>
          <h3 style={{
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--text-primary)',
            margin: 0,
            fontFamily: FONT,
          }}>
            {t('collab.notes.title')}
          </h3>
        </div>
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            width: 20,
            height: 20,
            border: '2px solid var(--border-primary)',
            borderTopColor: 'var(--text-primary)',
            borderRadius: '50%',
            animation: 'collab-notes-spin 0.7s linear infinite',
          }} />
          <style>{`@keyframes collab-notes-spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: FONT,
    }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        flexShrink: 0,
      }}>
        <h3 style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-muted)',
          margin: 0,
          fontFamily: FONT,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
        }}>
          <StickyNote size={14} color="var(--text-faint)" />
          {t('collab.notes.title')}
        </h3>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {canEdit && <button onClick={() => setShowSettings(true)} title={t('collab.notes.categorySettings') || 'Categories'}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)', transition: 'color 0.12s' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
            <Settings size={14} />
          </button>}
          {canEdit && <button onClick={() => setShowNewModal(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 99, padding: '6px 12px', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600, fontFamily: FONT, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <Plus size={12} />
            {t('collab.notes.new')}
          </button>}
        </div>
      </div>

      {/* ── Category filter pills ── */}
      {categories.length > 0 && (
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '8px 12px 0',
          overflowX: 'auto',
          flexShrink: 0,
        }}>
          <button
            onClick={() => setActiveCategory(null)}
            style={{
              flexShrink: 0,
              borderRadius: 99,
              padding: '3px 10px',
              fontSize: 10,
              fontWeight: 600,
              fontFamily: FONT,
              border: activeCategory === null
                ? '1px solid var(--accent)'
                : '1px solid var(--border-faint)',
              background: activeCategory === null
                ? 'var(--accent)'
                : 'transparent',
              color: activeCategory === null
                ? 'var(--accent-text)'
                : 'var(--text-secondary)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
            }}
          >
            {t('collab.notes.all')}
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(prev => prev === cat ? null : cat)}
              style={{
                flexShrink: 0,
                borderRadius: 99,
                padding: '3px 10px',
                fontSize: 10,
                fontWeight: 600,
                fontFamily: FONT,
                border: activeCategory === cat
                  ? '1px solid var(--accent)'
                  : '1px solid var(--border-faint)',
                background: activeCategory === cat
                  ? 'var(--accent)'
                  : 'transparent',
                color: activeCategory === cat
                  ? 'var(--accent-text)'
                  : 'var(--text-secondary)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                textTransform: 'uppercase',
                letterSpacing: '0.03em',
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* ── Scrollable content ── */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: 12,
      }}>
        {sortedNotes.length === 0 ? (
          /* ── Empty state ── */
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '48px 20px',
            textAlign: 'center',
            height: '100%',
          }}>
            <Pencil size={36} color="var(--text-faint)" style={{ marginBottom: 12 }} />
            <div style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: 4,
              fontFamily: FONT,
            }}>
              {t('collab.notes.empty')}
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--text-faint)',
              fontFamily: FONT,
            }}>
              {t('collab.notes.emptyDesc') || 'Create a note to get started'}
            </div>
          </div>
        ) : (
          /* ── Notes grid — 2 columns ── */
          <div style={{
            display: 'grid',
            gridTemplateColumns: window.innerWidth < 768 ? '1fr' : 'repeat(2, 1fr)',
            gap: 8,
          }}>
            {sortedNotes.map(note => (
              <NoteCard
                key={note.id}
                note={note}
                currentUser={currentUser}
                canEdit={canEdit}
                onUpdate={handleUpdateNote}
                onDelete={handleDeleteNote}
                onEdit={setEditingNote}
                onView={setViewingNote}
                onPreviewFile={setPreviewFile}
                getCategoryColor={getCategoryColor}
                tripId={tripId}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── New Note Modal ── */}
      {/* View note modal */}
      {viewingNote && ReactDOM.createPortal(
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 10000, padding: 16,
          }}
          onClick={() => setViewingNote(null)}
        >
          <div
            style={{
              background: 'var(--bg-card)', borderRadius: 16,
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
              width: 'min(700px, calc(100vw - 32px))', maxHeight: '80vh',
              overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{
              padding: '16px 20px 12px', borderBottom: '1px solid var(--border-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>{viewingNote.title}</div>
                {viewingNote.category && (
                  <span style={{
                    display: 'inline-block', marginTop: 4, fontSize: 10, fontWeight: 600,
                    color: getCategoryColor(viewingNote.category),
                    background: `${getCategoryColor(viewingNote.category)}18`,
                    padding: '2px 8px', borderRadius: 6,
                  }}>{viewingNote.category}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {canEdit && <button onClick={() => { setViewingNote(null); setEditingNote(viewingNote) }}
                  style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', borderRadius: 6 }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                  <Pencil size={16} />
                </button>}
                <button onClick={() => setViewingNote(null)}
                  style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', borderRadius: 6 }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="collab-note-md-full" style={{ padding: '16px 20px', overflowY: 'auto', fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.7 }}>
              <Markdown remarkPlugins={[remarkGfm]}>{viewingNote.content || ''}</Markdown>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showNewModal && (
        <NoteFormModal
          note={null}
          tripId={tripId}
          onClose={() => setShowNewModal(false)}
          onSubmit={handleCreateNote}
          existingCategories={categories}
          categoryColors={categoryColors}
          getCategoryColor={getCategoryColor}
          t={t}
        />
      )}

      {/* ── Edit Note Modal ── */}
      {editingNote && (
        <NoteFormModal
          note={editingNote}
          tripId={tripId}
          onClose={() => setEditingNote(null)}
          onSubmit={handleEditSubmit}
          onDeleteFile={handleDeleteNoteFile}
          existingCategories={categories}
          categoryColors={categoryColors}
          getCategoryColor={getCategoryColor}
          t={t}
        />
      )}

      {/* ── File Preview ── */}
      <FilePreviewPortal file={previewFile} onClose={() => setPreviewFile(null)} />

      {/* ── Category Settings Modal ── */}
      {showSettings && (
        <CategorySettingsModal
          onClose={() => setShowSettings(false)}
          categories={categories}
          categoryColors={categoryColors}
          onSave={saveCategoryColors}
          onRenameCategory={async (oldName, newName) => {
            // Update all notes with this category in DB
            const toUpdate = notes.filter(n => n.category === oldName)
            for (const n of toUpdate) {
              await handleUpdateNote(n.id, { category: newName })
            }
          }}
          t={t}
        />
      )}
    </div>
  )
}
