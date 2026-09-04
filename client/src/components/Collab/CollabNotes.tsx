import { useState, useEffect, useCallback, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { sanitizedMarkdownComponents, sanitizedMarkdownPlugins } from '../shared/markdownSanitize'
import { createPortal } from 'react-dom'
import { Plus, Pencil, X, StickyNote, Settings, ExternalLink } from 'lucide-react'
import { collabApi } from '../../api/client'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { addListener, removeListener } from '../../api/websocket'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import ConfirmDialog from '../shared/ConfirmDialog'
import EmptyState from '../shared/EmptyState'
import type { User } from '../../types'
import type { CollabNote } from './CollabNotes.types'
import { FONT, NOTE_COLORS } from './CollabNotes.constants'
import { NoteFormModal } from './CollabNotesFormModal'
import { CategorySettingsModal } from './CollabNotesCategorySettingsModal'
import { NoteCard } from './CollabNotesCard'
import { FilePreviewPortal } from './CollabNotesFilePreviewPortal'
import { AuthedImg } from './CollabNotesAuthedImg'
import { safeExternalHref } from '../../utils/safeUrl'

// ── Main Component ──────────────────────────────────────────────────────────
interface CollabNotesProps {
  tripId: number
  currentUser: User
}

/**
 * Collab notes state: load + WebSocket sync, note CRUD (with file uploads),
 * category colors/renames and the view/edit/settings modal toggles. The shell
 * below renders the header, category pills, the note grid and the modals.
 */
function useCollabNotes({ tripId, currentUser }: CollabNotesProps) {
  const { t } = useTranslation()
  const toast = useToast()
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
  const [pendingDeleteNoteId, setPendingDeleteNoteId] = useState<number | null>(null)

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
      // The panel is not remounted on a trip change, so an event still in flight
      // from the trip we just left must not land in this list.
      if (String(msg?.tripId) !== String(tripId)) return
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
    let created
    try {
      created = await collabApi.createNote(tripId, data)
    } catch (err) {
      toast.error(t('common.error'))
      throw err
    }
    if (created) {
      const note = created.note || created
      // Upload pending files
      if (pendingFiles.length > 0 && note.id) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          try { await collabApi.uploadNoteFile(tripId, note.id, fd) } catch (err) { console.error('Failed to upload note attachment:', err); toast.error(t('common.error')) }
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
  }, [tripId, toast, t])

  const handleUpdateNote = useCallback(async (noteId, data, opts: { silent?: boolean } = {}) => {
    let result
    try {
      result = await collabApi.updateNote(tripId, noteId, data)
    } catch (err) {
      // A batch of writes reports once for the whole run instead of once per note.
      if (!opts.silent) toast.error(t('common.error'))
      throw err
    }
    const updated = result?.note || result
    if (updated) {
      setNotes(prev =>
        prev.map(n => (n.id === noteId ? { ...n, ...updated } : n))
      )
    }
  }, [tripId, toast, t])

  // A colour or a rename is N single-note writes; if one of them is rejected the
  // rest still have to run, and the list has to be re-read so it stops showing a
  // change the server never took. Reporting the failure is the caller's job.
  const resyncNotes = useCallback(async () => {
    try {
      const fresh = await collabApi.getNotes(tripId)
      setNotes(fresh?.notes || fresh || [])
    } catch {}
  }, [tripId])

  const saveCategoryColors = useCallback(async (newMap) => {
    let failed = 0
    // Update notes with changed colors
    for (const [cat, color] of Object.entries(newMap)) {
      const notesInCat = notes.filter(n => n.category === cat)
      if (notesInCat.length > 0 && categoryColors[cat] !== color) {
        for (const n of notesInCat) {
          try { await handleUpdateNote(n.id, { color }) } catch { failed++ }
        }
      }
    }
    if (failed > 0) await resyncNotes()
    // Save all categories (including empty ones) to localStorage
    const emptyCats = {}
    for (const [cat, color] of Object.entries(newMap)) {
      if (!notes.some(n => n.category === cat)) {
        emptyCats[cat] = color
      }
    }
    saveEmptyCategories(emptyCats)
  }, [categoryColors, notes, handleUpdateNote, resyncNotes])

  const renameCategory = useCallback(async (oldName, newName) => {
    // Update all notes with this category in DB
    const toUpdate = notes.filter(n => n.category === oldName)
    let failed = 0
    for (const n of toUpdate) {
      try { await handleUpdateNote(n.id, { category: newName }, { silent: true }) } catch { failed++ }
    }
    // The rest still had to run, but a partial rename is not a saved rename: the
    // settings modal has to stay open on the rejection instead of closing on it.
    if (failed > 0) {
      await resyncNotes()
      toast.error(t('common.error'))
      throw new Error(`rename failed for ${failed} of ${toUpdate.length} notes`)
    }
  }, [notes, handleUpdateNote, resyncNotes, toast, t])

  const handleEditSubmit = useCallback(async (data) => {
    if (!editingNote) return
    const pendingFiles = data._pendingFiles || []
    delete data._pendingFiles
    await handleUpdateNote(editingNote.id, data)
    if (pendingFiles.length > 0) {
      for (const file of pendingFiles) {
        const fd = new FormData()
        fd.append('file', file)
        try { await collabApi.uploadNoteFile(tripId, editingNote.id, fd) } catch { toast.error(t('common.error')) }
      }
      const fresh = await collabApi.getNotes(tripId)
      if (fresh?.notes) setNotes(fresh.notes)
      window.dispatchEvent(new Event('collab-files-changed'))
    }
  }, [editingNote, tripId, handleUpdateNote, toast, t])

  const handleDeleteNoteFile = useCallback(async (noteId, fileId) => {
    try { await collabApi.deleteNoteFile(tripId, noteId, fileId) } catch { toast.error(t('common.error')) }
    window.dispatchEvent(new Event('collab-files-changed'))
  }, [tripId, toast, t])

  const handleDeleteNote = useCallback(async (noteId) => {
    try {
      await collabApi.deleteNote(tripId, noteId)
    } catch (err) {
      toast.error(t('common.error'))
      throw err
    }
    setNotes(prev => prev.filter(n => n.id !== noteId))
    window.dispatchEvent(new Event('collab-files-changed'))
  }, [tripId, toast, t])

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

  return {
    tripId, currentUser, t, canEdit,
    notes, loading, showNewModal, setShowNewModal, editingNote, setEditingNote,
    viewingNote, setViewingNote, previewFile, setPreviewFile, showSettings, setShowSettings,
    activeCategory, setActiveCategory, categoryColors, getCategoryColor,
    handleCreateNote, handleUpdateNote, saveCategoryColors, renameCategory, handleEditSubmit,
    handleDeleteNoteFile, handleDeleteNote, categories, sortedNotes,
    pendingDeleteNoteId, setPendingDeleteNoteId,
  }
}

type NotesState = ReturnType<typeof useCollabNotes>

function CollabNotesLoading({ t }: NotesState) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: FONT }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-faint)' }}>
        <h3 style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 700, color: 'var(--text-primary)', margin: 0, fontFamily: FONT }}>
          {t('collab.notes.title')}
        </h3>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          width: 20, height: 20, border: '2px solid var(--border-primary)',
          borderTopColor: 'var(--text-primary)', borderRadius: '50%',
          animation: 'collab-notes-spin 0.7s linear infinite',
        }} />
        <style>{`@keyframes collab-notes-spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </div>
  )
}

function CollabNotesHeader({ t, canEdit, setShowSettings, setShowNewModal }: NotesState) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', flexShrink: 0 }}>
      <h3 style={{
        fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-muted)', margin: 0, fontFamily: FONT,
        letterSpacing: 0.3, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 7,
      }}>
        <StickyNote size={14} color="var(--text-faint)" />
        {t('collab.notes.title')}
      </h3>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {canEdit && <button type="button" onClick={() => setShowSettings(true)} title={t('collab.notes.categorySettings')}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)', transition: 'color 0.12s' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
          <Settings size={14} />
        </button>}
        {canEdit && <button type="button" onClick={() => setShowNewModal(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 99, padding: '6px 12px', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 600, fontFamily: FONT, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <Plus size={12} />
          {t('collab.notes.new')}
        </button>}
      </div>
    </div>
  )
}

function CollabCategoryPills({ categories, activeCategory, setActiveCategory, t }: NotesState) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '8px 12px 0', overflowX: 'auto', flexShrink: 0 }}>
      <button type="button"
        onClick={() => setActiveCategory(null)}
        style={{
          flexShrink: 0, borderRadius: 99, padding: '3px 10px', fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600, fontFamily: FONT,
          border: activeCategory === null ? '1px solid var(--accent)' : '1px solid var(--border-faint)',
          background: activeCategory === null ? 'var(--accent)' : 'transparent',
          color: activeCategory === null ? 'var(--accent-text)' : 'var(--text-secondary)',
          cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.03em',
        }}
      >
        {t('collab.notes.all')}
      </button>
      {categories.map(cat => (
        <button type="button"
          key={cat}
          onClick={() => setActiveCategory(prev => prev === cat ? null : cat)}
          style={{
            flexShrink: 0, borderRadius: 99, padding: '3px 10px', fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600, fontFamily: FONT,
            border: activeCategory === cat ? '1px solid var(--accent)' : '1px solid var(--border-faint)',
            background: activeCategory === cat ? 'var(--accent)' : 'transparent',
            color: activeCategory === cat ? 'var(--accent-text)' : 'var(--text-secondary)',
            cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.03em',
          }}
        >
          {cat}
        </button>
      ))}
    </div>
  )
}

function CollabNotesGrid(S: NotesState) {
  const {
    sortedNotes, currentUser, canEdit, handleUpdateNote, setPendingDeleteNoteId,
    setEditingNote, setViewingNote, setPreviewFile, getCategoryColor, tripId, t,
  } = S
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
      {sortedNotes.length === 0 ? (
        /* ── Empty state ── */
        <EmptyState scene="notes" title={t('collab.notes.empty')} />
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
              onDelete={setPendingDeleteNoteId}
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
  )
}

/** Label for the link chip: the host is what people recognise, "www." is noise. */
function linkHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function ViewNoteModal(S: NotesState) {
  const { viewingNote, setViewingNote, canEdit, setEditingNote, getCategoryColor, t, setPreviewFile } = S
  if (!viewingNote) return null
  // A member without collab_edit only ever gets this modal, so the link has to
  // be here too (#2222). Allow-listed like the card tile: the field takes any
  // string, and a javascript: one would run in this origin.
  const websiteHref = safeExternalHref(viewingNote.website)
  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 10000, padding: 16,
      }}
      role="presentation"
      onClick={e => { if (e.target === e.currentTarget) setViewingNote(null) }}
    >
      <div
        style={{
          background: 'var(--bg-card)', borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          width: 'min(700px, calc(100vw - 32px))', maxHeight: '80vh',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{
          padding: '16px 20px 12px', borderBottom: '1px solid var(--border-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'calc(17px * var(--fs-scale-subtitle, 1))', fontWeight: 600, color: 'var(--text-primary)' }}>{viewingNote.title}</div>
            {viewingNote.category && (
              <span style={{
                display: 'inline-block', marginTop: 4, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600,
                color: getCategoryColor(viewingNote.category),
                background: `${getCategoryColor(viewingNote.category)}18`,
                padding: '2px 8px', borderRadius: 6,
              }}>{viewingNote.category}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {canEdit && <button type="button" onClick={() => { setViewingNote(null); setEditingNote(viewingNote) }}
              style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', borderRadius: 6 }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
              <Pencil size={16} />
            </button>}
            <button type="button" onClick={() => setViewingNote(null)}
              style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', borderRadius: 6 }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="collab-note-md-full" style={{ padding: '16px 20px', overflowY: 'auto', fontSize: 'calc(14px * var(--fs-scale-body, 1))', color: 'var(--text-primary)', lineHeight: 1.7 }}>
          <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={sanitizedMarkdownPlugins} components={sanitizedMarkdownComponents}>{viewingNote.content || ''}</Markdown>
          {websiteHref && (
            <a href={websiteHref} target="_blank" rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12,
                padding: '6px 12px', borderRadius: 999, border: '1px solid var(--border-primary)',
                fontSize: 'calc(12px * var(--fs-scale-caption, 1))', fontWeight: 600,
                color: 'var(--text-primary)', textDecoration: 'none',
              }}>
              <ExternalLink size={13} color="var(--text-muted)" /> {linkHost(websiteHref)}
            </a>
          )}
          {(viewingNote.attachments || []).length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-primary)' }}>
              <div style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>{t('files.title')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(viewingNote.attachments || []).map(a => {
                  const isImage = a.mime_type?.startsWith('image/')
                  const ext = (a.original_name || '').split('.').pop()?.toUpperCase() || '?'
                  return (
                    <div key={a.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, maxWidth: 72 }}>
                      {isImage ? (
                        <AuthedImg src={a.url} alt={a.original_name}
                          style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, cursor: 'pointer', transition: 'transform 0.12s, box-shadow 0.12s' }}
                          onClick={() => setPreviewFile(a)}
                          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.06)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)' }}
                          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none' }} />
                      ) : (
                        <button type="button" title={a.original_name} onClick={() => setPreviewFile(a)}
                          style={{
                            width: 64, height: 64, borderRadius: 8, cursor: 'pointer',
                            background: a.mime_type === 'application/pdf' ? '#ef44441a' : 'var(--bg-secondary)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
                            transition: 'transform 0.12s, box-shadow 0.12s',
                            border: 'none', padding: 0, fontFamily: 'inherit',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.06)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)' }}
                          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none' }}>
                          <span style={{ fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 700, color: a.mime_type === 'application/pdf' ? '#ef4444' : 'var(--text-muted)', letterSpacing: 0.3 }}>{ext}</span>
                        </button>
                      )}
                      <span style={{ fontSize: 'calc(9px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>{a.original_name}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function CollabNotes(props: CollabNotesProps) {
  const S = useCollabNotes(props)
  const {
    loading, tripId, t, categories, categoryColors, getCategoryColor, notes,
    viewingNote, showNewModal, editingNote, previewFile, showSettings,
    setShowNewModal, setEditingNote, setPreviewFile, setShowSettings,
    handleCreateNote, handleEditSubmit, handleDeleteNoteFile, saveCategoryColors, renameCategory, handleUpdateNote,
    handleDeleteNote, pendingDeleteNoteId, setPendingDeleteNoteId,
  } = S

  if (loading) return <CollabNotesLoading {...S} />

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: FONT }}>
      <CollabNotesHeader {...S} />
      {categories.length > 0 && <CollabCategoryPills {...S} />}
      <CollabNotesGrid {...S} />

      {viewingNote && <ViewNoteModal {...S} />}

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

      <FilePreviewPortal file={previewFile} onClose={() => setPreviewFile(null)} />

      {showSettings && (
        <CategorySettingsModal
          onClose={() => setShowSettings(false)}
          categories={categories}
          categoryColors={categoryColors}
          onSave={saveCategoryColors}
          onRenameCategory={renameCategory}
          t={t}
        />
      )}

      {/* Confirm: delete a collab note — guards against accidental deletion */}
      <ConfirmDialog
        isOpen={pendingDeleteNoteId !== null}
        onClose={() => setPendingDeleteNoteId(null)}
        // Hand the promise back so the dialog absorbs the rethrow of a failed DELETE.
        onConfirm={() => (pendingDeleteNoteId !== null ? handleDeleteNote(pendingDeleteNoteId) : undefined)}
        title={t('collab.notes.confirmDeleteTitle')}
        message={t('collab.notes.confirmDeleteBody')}
      />
    </div>
  )
}
