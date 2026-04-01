import ReactDOM from 'react-dom'
import { useState, useCallback, useRef, useEffect } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, Trash2, ExternalLink, X, FileText, FileImage, File, MapPin, Ticket, StickyNote, Star, RotateCcw, Pencil, Check } from 'lucide-react'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { filesApi } from '../../api/client'
import type { Place, Reservation, TripFile, Day, AssignmentsMap } from '../../types'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'

import { getAuthUrl } from '../../api/authUrl'

function isImage(mimeType) {
  if (!mimeType) return false
  return mimeType.startsWith('image/')
}

function getFileIcon(mimeType) {
  if (!mimeType) return File
  if (mimeType === 'application/pdf') return FileText
  if (isImage(mimeType)) return FileImage
  return File
}

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDateWithLocale(dateStr, locale) {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch { return '' }
}

// Image lightbox
interface ImageLightboxProps {
  file: TripFile & { url: string }
  onClose: () => void
}

function ImageLightbox({ file, onClose }: ImageLightboxProps) {
  const { t } = useTranslation()
  const [imgSrc, setImgSrc] = useState('')
  useEffect(() => {
    getAuthUrl(file.url, 'download').then(setImgSrc)
  }, [file.url])
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
        <img
          src={imgSrc}
          alt={file.original_name}
          style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8, display: 'block' }}
        />
        <div style={{ position: 'absolute', top: -40, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%' }}>{file.original_name}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={async () => { const u = await getAuthUrl(file.url, 'download'); window.open(u, '_blank', 'noreferrer') }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.7)', display: 'flex', padding: 0 }}
              title={t('files.openTab')}
            >
              <ExternalLink size={16} />
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.7)', display: 'flex', padding: 0 }}>
              <X size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Authenticated image — fetches a short-lived download token and renders the image
function AuthedImg({ src, style }: { src: string; style?: React.CSSProperties }) {
  const [authSrc, setAuthSrc] = useState('')
  useEffect(() => {
    getAuthUrl(src, 'download').then(setAuthSrc)
  }, [src])
  return authSrc ? <img src={authSrc} alt="" style={style} /> : null
}

// Source badge
interface SourceBadgeProps {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  label: string
}

function SourceBadge({ icon: Icon, label }: SourceBadgeProps) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10.5, color: '#4b5563',
      background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
      borderRadius: 6, padding: '2px 7px',
      fontWeight: 500, maxWidth: '100%', overflow: 'hidden',
    }}>
      <Icon size={10} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  )
}

function AvatarChip({ name, avatarUrl, size = 20 }: { name: string; avatarUrl?: string | null; size?: number }) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)

  const onEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 })
    }
    setHover(true)
  }

  return (
    <>
      <div ref={ref} onMouseEnter={onEnter} onMouseLeave={() => setHover(false)}
        style={{
          width: size, height: size, borderRadius: '50%', border: '1.5px solid var(--border-primary)',
          background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: size * 0.4, fontWeight: 700, color: 'var(--text-muted)', overflow: 'hidden', flexShrink: 0,
          cursor: 'default',
        }}>
        {avatarUrl
          ? <img src={avatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : name?.[0]?.toUpperCase()
        }
      </div>
      {hover && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)',
          background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          fontSize: 11, fontWeight: 500, padding: '3px 8px', borderRadius: 6,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', zIndex: 9999,
          pointerEvents: 'none',
        }}>
          {name}
        </div>,
        document.body
      )}
    </>
  )
}

interface FileManagerProps {
  files?: TripFile[]
  onUpload: (fd: FormData) => Promise<any>
  onDelete: (fileId: number) => Promise<void>
  onUpdate: (fileId: number, data: Partial<TripFile>) => Promise<void>
  places: Place[]
  days?: Day[]
  assignments?: AssignmentsMap
  reservations?: Reservation[]
  tripId: number
  allowedFileTypes: Record<string, string[]>
}

export default function FileManager({ files = [], onUpload, onDelete, onUpdate, places, days = [], assignments = {}, reservations = [], tripId, allowedFileTypes }: FileManagerProps) {
  const [uploading, setUploading] = useState(false)
  const [filterType, setFilterType] = useState('all')
  const [lightboxFile, setLightboxFile] = useState(null)
  const [showTrash, setShowTrash] = useState(false)
  const [trashFiles, setTrashFiles] = useState<TripFile[]>([])
  const [loadingTrash, setLoadingTrash] = useState(false)
  const toast = useToast()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const { t, locale } = useTranslation()

  const loadTrash = useCallback(async () => {
    setLoadingTrash(true)
    try {
      const data = await filesApi.list(tripId, true)
      setTrashFiles(data.files || [])
    } catch { /* */ }
    setLoadingTrash(false)
  }, [tripId])

  const toggleTrash = useCallback(() => {
    if (!showTrash) loadTrash()
    setShowTrash(v => !v)
  }, [showTrash, loadTrash])

  const refreshFiles = useCallback(async () => {
    if (onUpdate) onUpdate(0, {} as any)
  }, [onUpdate])

  const handleStar = async (fileId: number) => {
    try {
      await filesApi.toggleStar(tripId, fileId)
      refreshFiles()
    } catch { /* */ }
  }

  const handleRestore = async (fileId: number) => {
    try {
      await filesApi.restore(tripId, fileId)
      setTrashFiles(prev => prev.filter(f => f.id !== fileId))
      refreshFiles()
      toast.success(t('files.toast.restored'))
    } catch {
      toast.error(t('files.toast.restoreError'))
    }
  }

  const handlePermanentDelete = async (fileId: number) => {
    if (!confirm(t('files.confirm.permanentDelete'))) return
    try {
      await filesApi.permanentDelete(tripId, fileId)
      setTrashFiles(prev => prev.filter(f => f.id !== fileId))
      toast.success(t('files.toast.deleted'))
    } catch {
      toast.error(t('files.toast.deleteError'))
    }
  }

  const handleEmptyTrash = async () => {
    if (!confirm(t('files.confirm.emptyTrash'))) return
    try {
      await filesApi.emptyTrash(tripId)
      setTrashFiles([])
      toast.success(t('files.toast.trashEmptied') || 'Trash emptied')
    } catch {
      toast.error(t('files.toast.deleteError'))
    }
  }

  const [lastUploadedIds, setLastUploadedIds] = useState<number[]>([])

  const onDrop = useCallback(async (acceptedFiles) => {
    if (acceptedFiles.length === 0) return
    setUploading(true)
    const uploadedIds: number[] = []
    try {
      for (const file of acceptedFiles) {
        const formData = new FormData()
        formData.append('file', file)
        const result = await onUpload(formData)
        const fileObj = result?.file || result
        if (fileObj?.id) uploadedIds.push(fileObj.id)
      }
      toast.success(t('files.uploaded', { count: acceptedFiles.length }))
      // Open assign modal for the last uploaded file
      const lastId = uploadedIds[uploadedIds.length - 1]
      if (lastId && (places.length > 0 || reservations.length > 0)) {
        setAssignFileId(lastId)
      }
    } catch {
      toast.error(t('files.uploadError'))
    } finally {
      setUploading(false)
    }
  }, [onUpload, toast, t, places, reservations])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxSize: 50 * 1024 * 1024,
    noClick: false,
  })

  const handlePaste = useCallback((e) => {
    if (!can('file_upload', trip)) return
    const items = e.clipboardData?.items
    if (!items) return
    const pastedFiles = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) pastedFiles.push(file)
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault()
      onDrop(pastedFiles)
    }
  }, [onDrop])

  const filteredFiles = files.filter(f => {
    if (filterType === 'starred') return !!f.starred
    if (filterType === 'pdf') return f.mime_type === 'application/pdf'
    if (filterType === 'image') return isImage(f.mime_type)
    if (filterType === 'doc') return (f.mime_type || '').includes('word') || (f.mime_type || '').includes('excel') || (f.mime_type || '').includes('text')
    if (filterType === 'collab') return !!f.note_id
    return true
  })

  const handleDelete = async (id) => {
    try {
      await onDelete(id)
      toast.success(t('files.toast.trashed') || 'Moved to trash')
    } catch {
      toast.error(t('files.toast.deleteError'))
    }
  }

  const [previewFile, setPreviewFile] = useState(null)
  const [previewFileUrl, setPreviewFileUrl] = useState('')
  useEffect(() => {
    if (previewFile) {
      getAuthUrl(previewFile.url, 'download').then(setPreviewFileUrl)
    } else {
      setPreviewFileUrl('')
    }
  }, [previewFile?.url])
  const [assignFileId, setAssignFileId] = useState<number | null>(null)

  const handleAssign = async (fileId: number, data: { place_id?: number | null; reservation_id?: number | null }) => {
    try {
      await filesApi.update(tripId, fileId, data)
      refreshFiles()
    } catch {
      toast.error(t('files.toast.assignError'))
    }
  }

  const openFile = (file) => {
    if (isImage(file.mime_type)) {
      setLightboxFile(file)
    } else {
      setPreviewFile(file)
    }
  }

  const renderFileRow = (file: TripFile, isTrash = false) => {
    const FileIcon = getFileIcon(file.mime_type)
    const allLinkedPlaceIds = new Set<number>()
    if (file.place_id) allLinkedPlaceIds.add(file.place_id)
    for (const pid of (file.linked_place_ids || [])) allLinkedPlaceIds.add(pid)
    const linkedPlaces = [...allLinkedPlaceIds].map(pid => places?.find(p => p.id === pid)).filter(Boolean)
    // All linked reservations (primary + file_links)
    const allLinkedResIds = new Set<number>()
    if (file.reservation_id) allLinkedResIds.add(file.reservation_id)
    for (const rid of (file.linked_reservation_ids || [])) allLinkedResIds.add(rid)
    const linkedReservations = [...allLinkedResIds].map(rid => reservations?.find(r => r.id === rid)).filter(Boolean)
    return (
      <div key={file.id} style={{
        background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 12,
        padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 10,
        transition: 'border-color 0.12s',
        opacity: isTrash ? 0.7 : 1,
      }}
        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--text-faint)'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-primary)'}
        className="group"
      >
        {/* Icon or thumbnail */}
        <div
          onClick={() => !isTrash && openFile(file)}
          style={{
            flexShrink: 0, width: 36, height: 36, borderRadius: 8,
            background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: isTrash ? 'default' : 'pointer', overflow: 'hidden',
          }}
        >
          {isImage(file.mime_type)
            ? <AuthedImg src={file.url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : (() => {
                const ext = (file.original_name || '').split('.').pop()?.toUpperCase() || '?'
                const isPdf = file.mime_type === 'application/pdf'
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: isPdf ? '#ef44441a' : 'var(--bg-tertiary)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: isPdf ? '#ef4444' : 'var(--text-muted)', letterSpacing: 0.3 }}>{ext}</span>
                  </div>
                )
              })()
          }
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {file.uploaded_by_name && (
              <AvatarChip name={file.uploaded_by_name} avatarUrl={file.uploaded_by_avatar} size={20} />
            )}
            {!isTrash && file.starred ? <Star size={12} fill="#facc15" color="#facc15" style={{ flexShrink: 0 }} /> : null}
            <span
              onClick={() => !isTrash && openFile(file)}
              style={{ fontWeight: 500, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: isTrash ? 'default' : 'pointer' }}
            >
              {file.original_name}
            </span>
          </div>

          {file.description && (
            <p style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.description}</p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {file.file_size && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{formatSize(file.file_size)}</span>}
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{formatDateWithLocale(file.created_at, locale)}</span>

            {linkedPlaces.map(p => (
              <SourceBadge key={p.id} icon={MapPin} label={`${t('files.sourcePlan')} · ${p.name}`} />
            ))}
            {linkedReservations.map(r => (
              <SourceBadge key={r.id} icon={Ticket} label={`${t('files.sourceBooking')} · ${r.title || t('files.sourceBooking')}`} />
            ))}
            {file.note_id && (
              <SourceBadge icon={StickyNote} label={t('files.sourceCollab') || 'Collab Notes'} />
            )}
          </div>
        </div>

        {/* Actions — always visible on mobile, hover on desktop */}
        <div className="file-actions" style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          {isTrash ? (
            <>
              {can('file_delete', trip) && <button onClick={() => handleRestore(file.id)} title={t('files.restore') || 'Restore'} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}
                onMouseEnter={e => e.currentTarget.style.color = '#22c55e'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <RotateCcw size={14} />
              </button>}
              {can('file_delete', trip) && <button onClick={() => handlePermanentDelete(file.id)} title={t('common.delete')} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}
                onMouseEnter={e => e.currentTarget.style.color = '#ef4444'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <Trash2 size={14} />
              </button>}
            </>
          ) : (
            <>
              <button onClick={() => handleStar(file.id)} title={file.starred ? t('files.unstar') || 'Unstar' : t('files.star') || 'Star'} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: file.starred ? '#facc15' : 'var(--text-faint)', borderRadius: 6, display: 'flex' }}
                onMouseEnter={e => { if (!file.starred) e.currentTarget.style.color = '#facc15' }} onMouseLeave={e => { if (!file.starred) e.currentTarget.style.color = 'var(--text-faint)' }}>
                <Star size={14} fill={file.starred ? '#facc15' : 'none'} />
              </button>
              {can('file_edit', trip) && <button onClick={() => setAssignFileId(file.id)} title={t('files.assign') || 'Assign'} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <Pencil size={14} />
              </button>}
              <button onClick={() => openFile(file)} title={t('common.open')} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <ExternalLink size={14} />
              </button>
              {can('file_delete', trip) && <button onClick={() => handleDelete(file.id)} title={t('common.delete')} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}
                onMouseEnter={e => e.currentTarget.style.color = '#ef4444'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <Trash2 size={14} />
              </button>}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }} onPaste={handlePaste} tabIndex={-1}>
      {/* Lightbox */}
      {lightboxFile && <ImageLightbox file={lightboxFile} onClose={() => setLightboxFile(null)} />}

      {/* Assign modal */}
      {assignFileId && ReactDOM.createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setAssignFileId(null)}>
          <div style={{
            background: 'var(--bg-card)', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            width: 'min(600px, calc(100vw - 32px))', maxHeight: '70vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('files.assignTitle')}</div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {files.find(f => f.id === assignFileId)?.original_name || ''}
                </div>
              </div>
              <button onClick={() => setAssignFileId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 4, display: 'flex', flexShrink: 0 }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '8px 12px 0' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', padding: '0 2px 4px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t('files.noteLabel') || 'Note'}
              </div>
              <input
                type="text"
                placeholder={t('files.notePlaceholder')}
                defaultValue={files.find(f => f.id === assignFileId)?.description || ''}
                onBlur={e => {
                  const val = e.target.value.trim()
                  const file = files.find(f => f.id === assignFileId)
                  if (file && val !== (file.description || '')) {
                    handleAssign(file.id, { description: val } as any)
                  }
                }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                style={{
                  width: '100%', padding: '7px 10px', fontSize: 13, borderRadius: 8,
                  border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
                }}
              />
            </div>
            <div style={{ overflowY: 'auto', padding: 8 }}>
              {(() => {
                const file = files.find(f => f.id === assignFileId)
                if (!file) return null
                const assignedPlaceIds = new Set<number>()
                const dayGroups: { day: Day; dayPlaces: Place[] }[] = []
                for (const day of days) {
                  const da = assignments[String(day.id)] || []
                  const dayPlaces = da.map(a => places.find(p => p.id === a.place?.id || p.id === a.place_id)).filter(Boolean) as Place[]
                  if (dayPlaces.length > 0) {
                    dayGroups.push({ day, dayPlaces })
                    dayPlaces.forEach(p => assignedPlaceIds.add(p.id))
                  }
                }
                const unassigned = places.filter(p => !assignedPlaceIds.has(p.id))
                const placeBtn = (p: Place) => {
                  const isLinked = file.place_id === p.id || (file.linked_place_ids || []).includes(p.id)
                  return (
                    <button key={p.id} onClick={async () => {
                      if (isLinked) {
                        if (file.place_id === p.id) {
                          await handleAssign(file.id, { place_id: null })
                        } else {
                          try {
                            const linksRes = await filesApi.getLinks(tripId, file.id)
                            const link = (linksRes.links || []).find((l: any) => l.place_id === p.id)
                            if (link) await filesApi.removeLink(tripId, file.id, link.id)
                            refreshFiles()
                          } catch {}
                        }
                      } else {
                        if (!file.place_id) {
                          await handleAssign(file.id, { place_id: p.id })
                        } else {
                          try {
                            await filesApi.addLink(tripId, file.id, { place_id: p.id })
                            refreshFiles()
                          } catch {}
                        }
                      }
                    }} style={{
                      width: '100%', textAlign: 'left', padding: '6px 10px 6px 20px', background: isLinked ? 'var(--bg-hover)' : 'none',
                      border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)',
                      borderRadius: 8, fontFamily: 'inherit', fontWeight: isLinked ? 600 : 400,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = isLinked ? 'var(--bg-hover)' : 'transparent'}>
                      <MapPin size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      {isLinked && <Check size={14} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--accent)' }} />}
                    </button>
                  )
                }

                const placesSection = places.length > 0 && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', padding: '8px 10px 4px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {t('files.assignPlace')}
                    </div>
                    {dayGroups.map(({ day, dayPlaces }) => (
                      <div key={day.id}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', padding: '8px 10px 2px' }}>
                          {day.title || `${t('dayplan.dayN', { n: day.day_number })}${day.date ? ` · ${day.date}` : ''}`}
                        </div>
                        {dayPlaces.map(placeBtn)}
                      </div>
                    ))}
                    {unassigned.length > 0 && (
                      <div>
                        {dayGroups.length > 0 && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', padding: '8px 10px 2px' }}>{t('files.unassigned')}</div>}
                        {unassigned.map(placeBtn)}
                      </div>
                    )}
                  </div>
                )

                const bookingsSection = reservations.length > 0 && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', padding: '8px 10px 4px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {t('files.assignBooking')}
                    </div>
                    {reservations.map(r => {
                      const isLinked = file.reservation_id === r.id || (file.linked_reservation_ids || []).includes(r.id)
                      return (
                        <button key={r.id} onClick={async () => {
                          if (isLinked) {
                            // Unlink: if primary reservation_id, clear it; if via file_links, remove link
                            if (file.reservation_id === r.id) {
                              await handleAssign(file.id, { reservation_id: null })
                            } else {
                              try {
                                const linksRes = await filesApi.getLinks(tripId, file.id)
                                const link = (linksRes.links || []).find((l: any) => l.reservation_id === r.id)
                                if (link) await filesApi.removeLink(tripId, file.id, link.id)
                                refreshFiles()
                              } catch {}
                            }
                          } else {
                            // Link: if no primary, set it; otherwise use file_links
                            if (!file.reservation_id) {
                              await handleAssign(file.id, { reservation_id: r.id })
                            } else {
                              try {
                                await filesApi.addLink(tripId, file.id, { reservation_id: r.id })
                                refreshFiles()
                              } catch {}
                            }
                          }
                        }} style={{
                          width: '100%', textAlign: 'left', padding: '6px 10px 6px 20px', background: isLinked ? 'var(--bg-hover)' : 'none',
                          border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)',
                          borderRadius: 8, fontFamily: 'inherit', fontWeight: isLinked ? 600 : 400,
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                          onMouseLeave={e => e.currentTarget.style.background = isLinked ? 'var(--bg-hover)' : 'transparent'}>
                          <Ticket size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title || r.name}</span>
                          {isLinked && <Check size={14} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--accent)' }} />}
                        </button>
                      )
                    })}
                  </div>
                )

                const hasBoth = placesSection && bookingsSection
                return (
                  <div className={hasBoth ? 'md:flex' : ''}>
                    <div className={hasBoth ? 'md:w-1/2' : ''} style={{ overflowY: 'auto', maxHeight: '55vh', paddingRight: hasBoth ? 6 : 0 }}>{placesSection}</div>
                    {hasBoth && <div className="hidden md:block" style={{ width: 1, background: 'var(--border-primary)', flexShrink: 0 }} />}
                    {hasBoth && <div className="block md:hidden" style={{ height: 1, background: 'var(--border-primary)', margin: '8px 0' }} />}
                    <div className={hasBoth ? 'md:w-1/2' : ''} style={{ overflowY: 'auto', maxHeight: '55vh', paddingLeft: hasBoth ? 6 : 0 }}>{bookingsSection}</div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* PDF preview modal */}
      {previewFile && ReactDOM.createPortal(
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setPreviewFile(null)}
        >
          <div
            style={{ width: '100%', maxWidth: 950, height: '94vh', background: 'var(--bg-card)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--border-primary)', flexShrink: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{previewFile.original_name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={async () => { const u = await getAuthUrl(previewFile.url, 'download'); window.open(u, '_blank', 'noreferrer') }}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'none', padding: '4px 8px', borderRadius: 6, transition: 'color 0.15s' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'}>
                  <ExternalLink size={13} /> {t('files.openTab')}
                </button>
                <button onClick={() => setPreviewFile(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 4, borderRadius: 6, transition: 'color 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <object
              data={previewFileUrl ? `${previewFileUrl}#view=FitH` : undefined}
              type="application/pdf"
              style={{ flex: 1, width: '100%', border: 'none' }}
              title={previewFile.original_name}
            >
              <p style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                <button onClick={async () => { const u = await getAuthUrl(previewFile.url, 'download'); window.open(u, '_blank', 'noopener noreferrer') }} style={{ color: 'var(--text-primary)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}>PDF herunterladen</button>
              </p>
            </object>
          </div>
        </div>,
        document.body
      )}

      {/* Header */}
      <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{showTrash ? (t('files.trash') || 'Trash') : t('files.title')}</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
            {showTrash
              ? `${trashFiles.length} ${trashFiles.length === 1 ? 'file' : 'files'}`
              : (files.length === 1 ? t('files.countSingular') : t('files.count', { count: files.length }))}
          </p>
        </div>
        <button onClick={toggleTrash} style={{
          padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-primary)',
          background: showTrash ? 'var(--accent)' : 'var(--bg-card)',
          color: showTrash ? 'var(--accent-text)' : 'var(--text-muted)',
          fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
          fontFamily: 'inherit',
        }}>
          <Trash2 size={13} /> {t('files.trash') || 'Trash'}
        </button>
      </div>

      {showTrash ? (
        /* Trash view */
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 16px' }}>
          {trashFiles.length > 0 && can('file_delete', trip) && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button onClick={handleEmptyTrash} style={{
                padding: '5px 12px', borderRadius: 8, border: '1px solid #fecaca',
                background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'inherit',
              }}>
                {t('files.emptyTrash') || 'Empty Trash'}
              </button>
            </div>
          )}
          {loadingTrash ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-faint)' }}>
              <div style={{ width: 20, height: 20, border: '2px solid var(--text-faint)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
            </div>
          ) : trashFiles.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-faint)' }}>
              <Trash2 size={40} style={{ color: 'var(--text-faint)', display: 'block', margin: '0 auto 12px' }} />
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{t('files.trashEmpty') || 'Trash is empty'}</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {trashFiles.map(file => renderFileRow(file, true))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Upload zone */}
          {can('file_upload', trip) && <div
            {...getRootProps()}
            style={{
              margin: '16px 16px 0', border: '2px dashed', borderRadius: 14, padding: '20px 16px',
              textAlign: 'center', cursor: 'pointer', transition: 'all 0.15s',
              borderColor: isDragActive ? 'var(--text-secondary)' : 'var(--border-primary)',
              background: isDragActive ? 'var(--bg-secondary)' : 'var(--bg-card)',
            }}
          >
            <input {...getInputProps()} />
            <Upload size={24} style={{ margin: '0 auto 8px', color: isDragActive ? 'var(--text-secondary)' : 'var(--text-faint)', display: 'block' }} />
            {uploading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
                <div style={{ width: 14, height: 14, border: '2px solid var(--text-secondary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                {t('files.uploading')}
              </div>
            ) : (
              <>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500, margin: 0 }}>{t('files.dropzone')}</p>
                <p style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 3 }}>{t('files.dropzoneHint')}</p>
                <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6, opacity: 0.7 }}>
                  {(allowedFileTypes || 'jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv').toUpperCase().split(',').join(', ')} · Max 50 MB
                </p>
              </>
            )}
          </div>}

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 4, padding: '12px 16px 0', flexShrink: 0, flexWrap: 'wrap' }}>
            {[
              { id: 'all', label: t('files.filterAll') },
              ...(files.some(f => f.starred) ? [{ id: 'starred', icon: Star }] : []),
              { id: 'pdf', label: t('files.filterPdf') },
              { id: 'image', label: t('files.filterImages') },
              { id: 'doc', label: t('files.filterDocs') },
              ...(files.some(f => f.note_id) ? [{ id: 'collab', label: t('files.filterCollab') || 'Collab' }] : []),
            ].map(tab => (
              <button key={tab.id} onClick={() => setFilterType(tab.id)} style={{
                padding: '4px 12px', borderRadius: 99, border: 'none', cursor: 'pointer', fontSize: 12,
                fontFamily: 'inherit', transition: 'all 0.12s',
                background: filterType === tab.id ? 'var(--accent)' : 'transparent',
                color: filterType === tab.id ? 'var(--accent-text)' : 'var(--text-muted)',
                fontWeight: filterType === tab.id ? 600 : 400,
              }}>{tab.icon ? <tab.icon size={13} fill={filterType === tab.id ? '#facc15' : 'none'} color={filterType === tab.id ? '#facc15' : 'currentColor'} /> : tab.label}</button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-faint)', alignSelf: 'center' }}>
              {filteredFiles.length === 1 ? t('files.countSingular') : t('files.count', { count: filteredFiles.length })}
            </span>
          </div>

          {/* File list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 16px' }}>
            {filteredFiles.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-faint)' }}>
                <FileText size={40} style={{ color: 'var(--text-faint)', display: 'block', margin: '0 auto 12px' }} />
                <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{t('files.empty')}</p>
                <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: 0 }}>{t('files.emptyHint')}</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filteredFiles.map(file => renderFileRow(file))}
              </div>
            )}
          </div>
        </>
      )}

      <style>{`
        @media (max-width: 767px) {
          .file-actions button { padding: 8px !important; }
          .file-actions svg { width: 18px !important; height: 18px !important; }
        }
      `}</style>
    </div>
  )
}
