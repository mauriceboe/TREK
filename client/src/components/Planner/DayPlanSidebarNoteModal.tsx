import { useRef } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { NOTE_ICONS, getNoteIcon } from './DayPlanSidebar.constants'
import NoteFormatToolbar from '../shared/NoteFormatToolbar'
import NoteColorPicker from '../shared/NoteColorPicker'
import { noteSurface } from './noteSurface'
import { markdownLinkComponents } from '../shared/markdownLink'

interface NoteModalUi {
  mode: 'add' | 'edit'
  noteId?: number
  icon: string
  text: string
  time: string
  color?: string | null
}

type NoteUiMap = Record<string, NoteModalUi | undefined>

interface DayPlanSidebarNoteModalProps {
  noteUi: NoteUiMap
  setNoteUi: (updater: (prev: NoteUiMap) => NoteUiMap) => void
  noteInputRef: React.RefObject<HTMLInputElement>
  cancelNote: (dayId: number) => void
  saveNote: (dayId: number) => void
  /** Asks the planner to confirm and then delete the note being edited (#2249). */
  onRequestDelete: (dayId: number, noteId: number) => void
  t: (key: string, params?: Record<string, unknown>) => string
}

const BODY_MAX = 2000

/**
 * Add/edit dialog for a day note (#1629).
 *
 * Two columns on anything wider than a phone: how the note looks on the left
 * (icon, colour, and a preview of the card it will become), what it says on the
 * right. The preview is the reason the colour picker is worth having — a swatch
 * row tells you nothing about what a tinted card looks like next to a place.
 */
export function DayPlanSidebarNoteModal({ noteUi, setNoteUi, noteInputRef, cancelNote, saveNote, onRequestDelete, t }: DayPlanSidebarNoteModalProps) {
  return (
    <>
      {Object.entries(noteUi).map(([dayId, ui]) => ui && createPortal(
        <NoteDialog key={dayId} dayId={dayId} ui={ui} setNoteUi={setNoteUi} noteInputRef={noteInputRef}
          cancelNote={cancelNote} saveNote={saveNote} onRequestDelete={onRequestDelete} t={t} />,
        document.body
      ))}
    </>
  )
}

function NoteDialog({ dayId, ui, setNoteUi, noteInputRef, cancelNote, saveNote, onRequestDelete, t }: Omit<DayPlanSidebarNoteModalProps, 'noteUi'> & {
  dayId: string
  ui: NoteModalUi
}) {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const patch = (fields: Partial<NoteModalUi>) =>
    setNoteUi(prev => ({ ...prev, [dayId]: { ...(prev[dayId] as NoteModalUi), ...fields } }))

  const color = ui.color ?? null
  const surface = noteSurface(color)
  const PreviewIcon = getNoteIcon(ui.icon)
  const canSave = Boolean(ui.text?.trim())
  const bodyLen = ui.time?.length || 0

  return (
    <div className="bg-[rgba(0,0,0,0.3)]" style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      backdropFilter: 'blur(3px)',
    }} role="presentation" onClick={() => cancelNote(Number(dayId))}>
      <div className="bg-surface-card note-modal" style={{
        width: '100%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto', borderRadius: 16,
        boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: '22px 22px 18px',
        display: 'flex', flexDirection: 'column', gap: 16,
      }} role="presentation" onClick={e => e.stopPropagation()}>
        <div className="text-content" style={{ fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 600 }}>
          {ui.mode === 'add' ? t('dayplan.noteAdd') : t('dayplan.noteEdit')}
        </div>

        <div className="note-modal-cols" style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 20, alignItems: 'start' }}>
          {/* Left — how it looks. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <div>
              <div className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 7 }}>
                {t('dayplan.noteIcon')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {NOTE_ICONS.map(({ id, Icon }) => (
                  <button key={id} type="button" onClick={() => patch({ icon: id })} title={id}
                    aria-pressed={ui.icon === id}
                    className={ui.icon === id ? 'bg-surface-hover' : 'bg-transparent'}
                    style={{ width: 38, height: 38, borderRadius: 8, border: ui.icon === id ? '2px solid var(--text-primary)' : '2px solid var(--border-faint)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                    <Icon size={16} strokeWidth={1.8} color={ui.icon === id ? (color ?? 'var(--text-primary)') : 'var(--text-muted)'} />
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 7 }}>
                {t('notes.color.label')}
              </div>
              <NoteColorPicker value={color} onChange={c => patch({ color: c })} />
            </div>

            <div>
              <div className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 7 }}>
                {t('notes.preview')}
              </div>
              {/* The same shape the card takes in the day plan. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 6, border: `1px solid ${surface.border}`, background: surface.background }}>
                <div style={{ width: 28, height: 28, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: '50%', background: surface.iconBackground }}>
                  <PreviewIcon size={13} strokeWidth={1.8} color={surface.iconColor} />
                </div>
                <span className="text-content" style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 500, minWidth: 0, wordBreak: 'break-word' }}>
                  {ui.text?.trim() || t('dayplan.noteTitle')}
                </span>
              </div>
            </div>
          </div>

          {/* Right — what it says. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <div>
              <label className="text-content-faint" htmlFor="note-title" style={{ display: 'block', fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 7 }}>
                {t('dayplan.noteTitle')} *
              </label>
              <input
                id="note-title"
                ref={noteInputRef}
                type="text"
                value={ui.text}
                onChange={e => patch({ text: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveNote(Number(dayId)) } if (e.key === 'Escape') cancelNote(Number(dayId)) }}
                placeholder={t('dayplan.noteTitle')}
                required
                className="text-content bg-surface-input"
                style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '9px 11px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
                <label className="text-content-faint" htmlFor="note-body" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em' }}>
                  {t('dayplan.noteSubtitle')}
                </label>
                <NoteFormatToolbar textareaRef={bodyRef} onChange={v => patch({ time: v })} compact />
              </div>
              <textarea
                id="note-body"
                ref={bodyRef}
                value={ui.time}
                maxLength={BODY_MAX}
                rows={6}
                onChange={e => patch({ time: e.target.value })}
                onKeyDown={e => { if (e.key === 'Escape') cancelNote(Number(dayId)) }}
                placeholder={t('notes.bodyPlaceholder')}
                className="text-content bg-surface-input"
                style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '9px 11px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.5 }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                <span className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))' }}>{t('notes.markdownHint')}</span>
                <span className={bodyLen >= BODY_MAX - 100 ? 'text-[#d97706]' : 'text-content-faint'} style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))' }}>{bodyLen}/{BODY_MAX}</span>
              </div>
            </div>

            {ui.time?.trim() && (
              <div className="collab-note-md-full text-content-muted" style={{ borderRadius: 10, border: `1px solid ${surface.border}`, background: surface.background, padding: '10px 12px', fontSize: 'calc(12px * var(--fs-scale-body, 1))', lineHeight: 1.55, wordBreak: 'break-word', overflowWrap: 'anywhere', maxHeight: 200, overflowY: 'auto' }}>
                <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownLinkComponents}>{ui.time}</Markdown>
              </div>
            )}
          </div>
        </div>

        {/* Delete lives here rather than on the row: the row's floating pencil/trash
            pill covered the reorder chevrons and, on a coarse pointer, never went
            away (#2249). The planner still confirms before it deletes. */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {ui.mode === 'edit' && ui.noteId != null && (
            <button type="button" onClick={() => onRequestDelete(Number(dayId), ui.noteId!)}
              className="text-danger"
              style={{ marginRight: 'auto', fontSize: 'calc(12px * var(--fs-scale-body, 1))', background: 'none', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '7px 15px', cursor: 'pointer', fontFamily: 'inherit' }}>
              {t('common.delete')}
            </button>
          )}
          <button type="button" onClick={() => cancelNote(Number(dayId))} className="text-content-muted" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', background: 'none', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '7px 15px', cursor: 'pointer', fontFamily: 'inherit' }}>{t('common.cancel')}</button>
          <button type="button" onClick={() => saveNote(Number(dayId))} disabled={!canSave}
            className={!canSave ? 'bg-[var(--border-primary)] text-content-faint' : 'bg-accent text-accent-text'}
            style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', border: 'none', borderRadius: 8, padding: '7px 17px', cursor: !canSave ? 'not-allowed' : 'pointer', fontWeight: 600, fontFamily: 'inherit', transition: 'background 0.15s, color 0.15s' }}>
            {ui.mode === 'add' ? t('common.add') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
