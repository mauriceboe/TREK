import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { sanitizedMarkdownPlugins, sanitizedMarkdownComponents } from '../../../../components/shared/markdownSanitize'
import { Check, ExternalLink, FileText, Paperclip, Pin, PinOff, Plus, StickyNote, Trash2, X } from 'lucide-react'
import MDancingTrek from '../../../components/MDancingTrek'
import { collabApi } from '../../../../api/client'
import { addListener, removeListener } from '../../../../api/websocket'
import { openFile } from '../../../../utils/fileDownload'
import { safeExternalHref } from '../../../../utils/safeUrl'
import MSheet from '../../../components/MSheet'
import { Eyebrow, FIELD_AREA_CLS, FIELD_CLS, FormSheetFooter, FormSheetHeader } from '../sheets/PlSheetChrome'
import MConfirmSheet from '../../settings/MConfirmSheet'
import type { TripPlanner } from '../MTripShell'
import { TabScroller } from './tabChrome'
import {
  buildCategoryColorMap,
  getCategoryColor,
  noteCategoriesList,
  sortNotes,
  type CollabNoteData,
  type CollabNoteFile,
} from './collabModel'

interface MCollabNotesProps {
  planner: TripPlanner
}

interface GetNotesResponse { notes: CollabNoteData[] }
interface NoteResponse { note: CollabNoteData }

type NoteFormTarget = 'new' | CollabNoteData

interface NoteFormSubmitData {
  title: string
  content?: string
  category?: string
  color: string
  website: string | null
  pendingFiles: File[]
}

/** Label for a link chip: the host is what people recognise, "www." is noise. */
function linkHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

/**
 * Trip-tab Collab / Notes. Same architecture as MCollabChat: own state, own
 * `collabApi` calls, own WebSocket listener — no `tripStore`/`tripActions`
 * (10-tab-databindings.md §8.4). The demo only has a placeholder for this
 * sub-tab, so the card/filter/form design below is new (spec 03 §6.4 audit
 * item), built in the same visual language as MTransportsTab.
 */
export default function MCollabNotes({ planner }: MCollabNotesProps) {
  const { t, tripId, toast } = planner
  const canEdit = planner.can('collab_edit', planner.trip)
  const canUploadFiles = planner.can('file_upload', planner.trip)

  const [notes, setNotes] = useState<CollabNoteData[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [formTarget, setFormTarget] = useState<NoteFormTarget | null>(null)
  const [viewingNote, setViewingNote] = useState<CollabNoteData | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  // ── Load ──
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    collabApi.getNotes(tripId).then((data: GetNotesResponse) => {
      if (!cancelled) setNotes(data.notes || [])
    }).catch(() => { /* leave notes empty */ }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tripId])

  // ── WebSocket (own listener, not handleRemoteEvent) ──
  useEffect(() => {
    const handler = (event: Record<string, unknown>) => {
      if (String(event.tripId) !== String(tripId)) return
      if (event.type === 'collab:note:created') {
        const note = event.note as CollabNoteData
        setNotes(prev => (prev.some(n => n.id === note.id) ? prev : [note, ...prev]))
      }
      if (event.type === 'collab:note:updated') {
        const note = event.note as CollabNoteData
        setNotes(prev => prev.map(n => (n.id === note.id ? { ...n, ...note } : n)))
      }
      if (event.type === 'collab:note:deleted') {
        const noteId = event.noteId as number
        setNotes(prev => prev.filter(n => n.id !== noteId))
      }
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [tripId])

  const categories = noteCategoriesList(notes)
  const colorMap = buildCategoryColorMap(notes)
  const sorted = sortNotes(notes, activeCategory)

  const handleCreate = useCallback(async (data: NoteFormSubmitData) => {
    let created: CollabNoteData
    try {
      const res = (await collabApi.createNote(tripId, {
        title: data.title, content: data.content, category: data.category, color: data.color,
        website: data.website,
      })) as NoteResponse
      created = res.note
    } catch {
      toast.error(t('common.error'))
      throw new Error('create failed')
    }
    if (data.pendingFiles.length > 0) {
      for (const file of data.pendingFiles) {
        const fd = new FormData()
        fd.append('file', file)
        try { await collabApi.uploadNoteFile(tripId, created.id, fd) } catch { toast.error(t('common.error')) }
      }
      const fresh = (await collabApi.getNotes(tripId)) as GetNotesResponse
      setNotes(fresh.notes || [])
      return
    }
    setNotes(prev => (prev.some(n => n.id === created.id) ? prev : [created, ...prev]))
  }, [tripId, toast, t])

  const handleUpdate = useCallback(async (
    noteId: number,
    data: { title?: string; content?: string; category?: string; color?: string; pinned?: boolean; website?: string | null },
    pendingFiles: File[] = [],
  ) => {
    let updated: CollabNoteData | undefined
    try {
      const res = (await collabApi.updateNote(tripId, noteId, data)) as NoteResponse
      updated = res.note
    } catch {
      toast.error(t('common.error'))
      throw new Error('update failed')
    }
    if (pendingFiles.length > 0) {
      for (const file of pendingFiles) {
        const fd = new FormData()
        fd.append('file', file)
        try { await collabApi.uploadNoteFile(tripId, noteId, fd) } catch { toast.error(t('common.error')) }
      }
      const fresh = (await collabApi.getNotes(tripId)) as GetNotesResponse
      setNotes(fresh.notes || [])
      return
    }
    if (updated) setNotes(prev => prev.map(n => (n.id === noteId ? { ...n, ...updated } : n)))
  }, [tripId, toast, t])

  const handleDelete = useCallback(async (noteId: number) => {
    try {
      await collabApi.deleteNote(tripId, noteId)
      setNotes(prev => prev.filter(n => n.id !== noteId))
    } catch {
      toast.error(t('common.error'))
    }
  }, [tripId, toast, t])

  // Returns whether the file is really gone — the form sheet only drops the
  // chip once the server confirmed it.
  const handleDeleteFile = useCallback(async (noteId: number, fileId: number) => {
    try {
      await collabApi.deleteNoteFile(tripId, noteId, fileId)
      setNotes(prev => prev.map(n => (
        n.id === noteId ? { ...n, attachments: n.attachments.filter(f => f.id !== fileId) } : n
      )))
      return true
    } catch {
      toast.error(t('common.error'))
      return false
    }
  }, [tripId, toast, t])

  const openNote = (note: CollabNoteData) => (canEdit ? setFormTarget(note) : setViewingNote(note))

  if (loading) {
    return (
      <TabScroller>
        <div className="flex flex-col items-center px-8 pt-16 text-center">
          <MDancingTrek size={84} className="mb-1" />
          <p className="font-geist text-[0.8125rem] font-medium text-m-muted">{t('common.loading')}</p>
        </div>
      </TabScroller>
    )
  }

  return (
    <TabScroller>
      <div className="flex items-center justify-between gap-2">
        {categories.length > 0 ? (
          <div className="flex flex-1 gap-[6px] overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              className={`flex-none whitespace-nowrap rounded-full px-3 py-[5px] font-geist text-[0.6875rem] font-bold uppercase tracking-[.02em] ${
                activeCategory === null ? 'bg-m-act text-m-actfg' : 'bg-[color:var(--m-ic)] text-m-muted'
              }`}
            >
              {t('collab.notes.all')}
            </button>
            {categories.map(cat => {
              const c = getCategoryColor(cat, colorMap)
              const active = activeCategory === cat
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setActiveCategory(prev => (prev === cat ? null : cat))}
                  className="flex-none whitespace-nowrap rounded-full px-3 py-[5px] font-geist text-[0.6875rem] font-bold uppercase tracking-[.02em]"
                  style={active ? { background: `${c}26`, color: c } : { background: 'var(--m-ic)', color: 'var(--m-muted)' }}
                >
                  {cat}
                </button>
              )
            })}
          </div>
        ) : (
          <span />
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => setFormTarget('new')}
            className="flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full bg-m-act px-[15px] py-[8px] font-geist text-[0.75rem] font-bold text-m-actfg"
          >
            <Plus size={13} strokeWidth={2.4} />
            {t('collab.notes.new')}
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="flex min-h-full flex-1 flex-col items-center justify-center px-8 py-10 text-center">
          <MDancingTrek scene="notes" className="mb-2" />
          <p className="font-geist text-[0.8125rem] font-medium text-m-muted">{t('collab.notes.empty')}</p>
        </div>
      ) : (
        sorted.map(note => (
          <NoteCardRow
            key={note.id}
            note={note}
            color={getCategoryColor(note.category, colorMap)}
            canEdit={canEdit}
            onTap={() => openNote(note)}
            onTogglePin={() => handleUpdate(note.id, { pinned: !note.pinned })}
            onDelete={() => setPendingDeleteId(note.id)}
            t={t}
          />
        ))
      )}

      <NoteFormSheet
        open={formTarget !== null}
        target={formTarget}
        categories={categories}
        colorMap={colorMap}
        canUploadFiles={canUploadFiles}
        onClose={() => setFormTarget(null)}
        onSubmit={async data => {
          if (formTarget && formTarget !== 'new') {
            await handleUpdate(formTarget.id, {
              title: data.title, content: data.content, category: data.category, color: data.color,
              website: data.website,
            }, data.pendingFiles)
          } else {
            await handleCreate(data)
          }
        }}
        onDeleteExistingFile={handleDeleteFile}
        t={t}
      />

      <NoteViewSheet open={viewingNote !== null} note={viewingNote} onClose={() => setViewingNote(null)} t={t} />

      <MConfirmSheet
        open={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        title={t('collab.notes.confirmDeleteTitle')}
        message={t('collab.notes.confirmDeleteBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          if (pendingDeleteId !== null) handleDelete(pendingDeleteId)
          setPendingDeleteId(null)
        }}
      />
    </TabScroller>
  )
}

/* ------------------------------------------------------------------ */

function NoteCardRow({ note, color, canEdit, onTap, onTogglePin, onDelete, t }: {
  note: CollabNoteData
  color: string
  canEdit: boolean
  onTap: () => void
  onTogglePin: () => void
  onDelete: () => void
  t: TripPlanner['t']
}) {
  const initial = (note.username || '?')[0]?.toUpperCase() || '?'
  // An editor is routed to the form sheet, never to the viewer, so the card is
  // the only surface where both roles can reach the link (#2222). The field
  // takes any string, so the href is allow-listed the way the desktop tile is.
  const websiteHref = safeExternalHref(note.website)

  return (
    <div className="mt-2 overflow-hidden rounded-2xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)]">
      <div className="flex items-center gap-[7px] px-3 py-[10px]" style={{ background: `${color}0d` }}>
        {!!note.pinned && <Pin size={11} strokeWidth={2.4} style={{ color }} className="flex-none" />}
        <button type="button" onClick={onTap} className="flex min-w-0 flex-1 items-center gap-[7px] text-left">
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold text-m-ink">{note.title}</span>
          {note.category && (
            <span
              className="flex-none rounded-full px-2 py-[2px] font-geist text-[0.5625rem] font-bold uppercase tracking-[.03em]"
              style={{ color, background: `${color}18` }}
            >
              {note.category}
            </span>
          )}
        </button>
        {websiteHref && (
          <a
            href={websiteHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('collab.notes.website')}
            className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-[color:var(--m-ic)] text-m-muted"
          >
            <ExternalLink size={12} strokeWidth={2.2} />
          </a>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-label={note.pinned ? t('collab.notes.unpin') : t('collab.notes.pin')}
            className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-[color:var(--m-ic)] text-m-muted"
          >
            {note.pinned ? <PinOff size={12} strokeWidth={2.2} /> : <Pin size={12} strokeWidth={2.2} />}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('collab.notes.delete')}
            className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-[color:var(--m-ic)] text-m-muted"
          >
            <Trash2 size={12} strokeWidth={2} />
          </button>
        )}
      </div>

      <button type="button" onClick={onTap} className="block w-full px-3 pb-3 pt-[9px] text-left">
        {note.content && (
          <div className="line-clamp-3 font-geist text-[0.75rem] leading-[1.5] text-m-muted [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:mb-1 [&_strong]:font-bold [&_ul]:list-disc [&_ul]:pl-4">
            <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={sanitizedMarkdownPlugins} components={sanitizedMarkdownComponents}>{note.content}</Markdown>
          </div>
        )}
        <div className={`flex items-center gap-[6px] ${note.content ? 'mt-2' : ''}`}>
          <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full bg-m-card font-geist text-[0.5rem] font-bold text-m-muted">
            {initial}
          </span>
          <span className="min-w-0 flex-1 truncate font-geist text-[0.625rem] text-m-faint">{note.username}</span>
          {note.attachments.length > 0 && (
            <span className="flex flex-none items-center gap-[3px] font-geist text-[0.625rem] font-semibold text-m-faint">
              <Paperclip size={10} strokeWidth={2.2} />
              {note.attachments.length}
            </span>
          )}
        </div>
      </button>
    </div>
  )
}

function NoteFormSheet({ open, target, categories, colorMap, canUploadFiles, onClose, onSubmit, onDeleteExistingFile, t }: {
  open: boolean
  target: NoteFormTarget | null
  categories: string[]
  colorMap: Record<string, string>
  canUploadFiles: boolean
  onClose: () => void
  onSubmit: (data: NoteFormSubmitData) => Promise<void>
  onDeleteExistingFile: (noteId: number, fileId: number) => Promise<boolean>
  t: TripPlanner['t']
}) {
  const note = target && target !== 'new' ? target : null
  const isEdit = !!note

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryDraft, setNewCategoryDraft] = useState('')
  const [website, setWebsite] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [existingFiles, setExistingFiles] = useState<CollabNoteFile[]>([])
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle(note?.title || '')
    setContent(note?.content || '')
    setCategory(note?.category || null)
    setAddingCategory(false)
    setNewCategoryDraft('')
    setWebsite(note?.website || '')
    setPendingFiles([])
    setExistingFiles(note?.attachments || [])
  }, [open, note])

  const canSubmit = title.trim().length > 0 && !submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await onSubmit({
        title: title.trim(),
        content: content.trim() || undefined,
        category: category || undefined,
        color: getCategoryColor(category, colorMap),
        // Always sent, never undefined: the server only writes the column when
        // the key is present, so an emptied field has to arrive as null to clear.
        website: website.trim() || null,
        pendingFiles,
      })
      onClose()
    } catch {
      // onSubmit already surfaced a toast
    } finally {
      setSubmitting(false)
    }
  }

  const confirmNewCategory = () => {
    const name = newCategoryDraft.trim()
    if (name) setCategory(name)
    setAddingCategory(false)
    setNewCategoryDraft('')
  }

  return (
    <MSheet open={open} onClose={onClose} ariaLabel={isEdit ? t('collab.notes.edit') : t('collab.notes.new')}>
      <FormSheetHeader
        icon={StickyNote}
        title={isEdit ? t('collab.notes.edit') : t('collab.notes.new')}
        onClose={onClose}
        closeLabel={t('common.close')}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[6px] pt-1">
        <Eyebrow className="mb-[5px] uppercase">{t('collab.notes.title')} *</Eyebrow>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={200}
          placeholder={t('collab.notes.titlePlaceholder')}
          className={FIELD_CLS}
        />

        <Eyebrow className="mb-[5px] mt-3 uppercase">{t('collab.notes.content')}</Eyebrow>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={5}
          placeholder={t('collab.notes.contentPlaceholder')}
          className={FIELD_AREA_CLS}
        />

        <Eyebrow className="mb-[6px] mt-3 uppercase">{t('collab.notes.category')}</Eyebrow>
        <div className="flex flex-wrap gap-[6px]">
          {categories.map(cat => {
            const c = getCategoryColor(cat, colorMap)
            const active = category === cat
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className="rounded-full px-3 py-[5px] font-geist text-[0.6875rem] font-bold"
                style={{
                  border: `1.5px solid ${active ? c : 'var(--m-rowbr)'}`,
                  background: active ? `${c}20` : 'transparent',
                  color: active ? c : 'var(--m-muted)',
                }}
              >
                {cat}
              </button>
            )
          })}
          {addingCategory ? (
            <div className="flex items-center gap-[4px]">
              <input
                autoFocus
                value={newCategoryDraft}
                onChange={e => setNewCategoryDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirmNewCategory() } }}
                placeholder={t('collab.notes.newCategory')}
                className="w-[130px] rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[5px] font-[inherit] text-[0.6875rem] text-m-ink outline-none placeholder:text-m-faint"
              />
              <button
                type="button"
                onClick={confirmNewCategory}
                aria-label={t('common.add')}
                className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-m-act text-m-actfg"
              >
                <Check size={12} strokeWidth={2.4} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingCategory(true)}
              className="flex items-center gap-1 rounded-full border border-dashed border-[color:var(--m-rowbr)] px-3 py-[5px] font-geist text-[0.6875rem] font-bold text-m-faint"
            >
              <Plus size={11} strokeWidth={2.4} /> {t('collab.notes.newCategory')}
            </button>
          )}
        </div>

        <Eyebrow className="mb-[5px] mt-3 uppercase">{t('collab.notes.website')}</Eyebrow>
        <input
          type="url"
          inputMode="url"
          value={website}
          onChange={e => setWebsite(e.target.value)}
          placeholder={t('collab.notes.websitePlaceholder')}
          className={FIELD_CLS}
        />

        {canUploadFiles && (
          <>
            <Eyebrow className="mb-[6px] mt-3 uppercase">{t('collab.notes.attachFiles')}</Eyebrow>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => {
                const files = e.target.files
                if (files?.length) setPendingFiles(prev => [...prev, ...Array.from(files)])
                e.target.value = ''
              }}
            />
            <div className="flex flex-wrap items-center gap-[6px]">
              {existingFiles.map(f => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-[5px] rounded-[10px] border border-[color:var(--m-rowbr)] bg-m-card px-[9px] py-[5px] font-geist text-[0.65625rem] font-semibold text-m-muted"
                >
                  {f.original_name.length > 20 ? `${f.original_name.slice(0, 17)}...` : f.original_name}
                  <button
                    type="button"
                    onClick={async () => {
                      if (!note) return
                      const removed = await onDeleteExistingFile(note.id, f.id)
                      if (removed) setExistingFiles(prev => prev.filter(x => x.id !== f.id))
                    }}
                    aria-label={t('collab.notes.removeFile', { name: f.original_name })}
                    className="text-[color:var(--m-st-danger)]"
                  >
                    <X size={10} strokeWidth={2.4} />
                  </button>
                </span>
              ))}
              {pendingFiles.map((f, i) => (
                <span
                  key={`pending-${i}`}
                  className="inline-flex items-center gap-[5px] rounded-[10px] border border-[color:var(--m-rowbr)] bg-m-card px-[9px] py-[5px] font-geist text-[0.65625rem] font-semibold text-m-muted"
                >
                  {f.name.length > 20 ? `${f.name.slice(0, 17)}...` : f.name}
                  <button
                    type="button"
                    onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                    aria-label={t('collab.notes.removeFile', { name: f.name })}
                    className="text-m-faint"
                  >
                    <X size={10} strokeWidth={2.4} />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label={t('collab.notes.attachFiles')}
                className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[10px] border border-dashed border-[color:var(--m-rowbr)] text-m-faint"
              >
                <Plus size={13} strokeWidth={2.2} />
              </button>
            </div>
          </>
        )}
      </div>

      <FormSheetFooter
        onCancel={onClose}
        cancelLabel={t('collab.notes.cancel')}
        onSubmit={handleSubmit}
        submitLabel={isEdit ? t('collab.notes.save') : t('collab.notes.create')}
        submitDisabled={!canSubmit}
      />
    </MSheet>
  )
}

function NoteViewSheet({ open, note, onClose, t }: {
  open: boolean
  note: CollabNoteData | null
  onClose: () => void
  t: TripPlanner['t']
}) {
  // Snapshot-on-open (same reasoning as MNoteSheet.tsx): the caller nulls
  // `note` immediately on close, but MSheet keeps rendering children through
  // its 280ms exit animation, so the sheet needs its own copy to survive it.
  const [snapshot, setSnapshot] = useState<CollabNoteData | null>(null)
  useEffect(() => {
    if (open) setSnapshot(note)
  }, [open, note])
  const websiteHref = safeExternalHref(snapshot?.website)

  return (
    <MSheet open={open} onClose={onClose} ariaLabel={snapshot?.title}>
      <FormSheetHeader
        icon={StickyNote}
        title={snapshot?.title || ''}
        subtitle={snapshot?.category || undefined}
        onClose={onClose}
        closeLabel={t('common.close')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-4 pt-1">
        {snapshot?.content && (
          <div className="font-geist text-[0.8125rem] leading-[1.6] text-m-ink [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_strong]:font-bold [&_ul]:list-disc [&_ul]:pl-5">
            <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={sanitizedMarkdownPlugins} components={sanitizedMarkdownComponents}>{snapshot.content}</Markdown>
          </div>
        )}
        {websiteHref && (
          <a
            href={websiteHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-[5px] rounded-full border border-[color:var(--m-rowbr)] bg-m-card px-3 py-[7px] font-geist text-[0.71875rem] font-semibold text-m-ink"
          >
            <ExternalLink size={13} strokeWidth={2} className="text-m-muted" />
            {linkHost(websiteHref)}
          </a>
        )}
        {(snapshot?.attachments.length ?? 0) > 0 && (
          <div className="mt-4 flex flex-col gap-[6px]">
            {snapshot?.attachments.map(f => (
              <button
                key={f.id}
                type="button"
                onClick={() => openFile(f.url, f.original_name)}
                className="flex items-center gap-[6px] rounded-[10px] border border-[color:var(--m-rowbr)] bg-m-card px-[10px] py-[8px] text-left"
              >
                <FileText size={13} strokeWidth={2} className="flex-none text-m-muted" />
                <span className="min-w-0 flex-1 truncate font-geist text-[0.71875rem] font-semibold text-m-muted">
                  {f.original_name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </MSheet>
  )
}
