import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Download, X, FileText, ChevronLeft, ChevronRight, FileImage } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { getAuthUrl } from '../../api/authUrl'
import { openFile as openFileUrl } from '../../utils/fileDownload'
import { triggerDownload, isImage } from '../Files/FileManager.helpers'
import type { BudgetItemReceipt } from '../../types'

interface ReceiptPreviewModalProps {
  receipts: BudgetItemReceipt[]
  initialIndex?: number
  onClose: () => void
}

export function ReceiptPreviewModal({ receipts, initialIndex = 0, onClose }: ReceiptPreviewModalProps) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, receipts.length - 1)))
  const [signedUrl, setSignedUrl] = useState('')
  const [loading, setLoading] = useState(false)

  const current = receipts[index]
  const isImg = isImage(current?.mime_type)
  const isPdf = current?.mime_type === 'application/pdf' || current?.original_name?.toLowerCase().endsWith('.pdf')

  useEffect(() => {
    if (!current) return
    let cancelled = false
    setLoading(true)
    setSignedUrl('')

    getAuthUrl(current.url, 'download')
      .then(url => {
        if (!cancelled) {
          setSignedUrl(url)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [current?.url])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && index > 0) setIndex(i => i - 1)
      if (e.key === 'ArrowRight' && index < receipts.length - 1) setIndex(i => i + 1)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [index, receipts.length, onClose])

  if (!current) return null

  const handleOpenTab = () => {
    openFileUrl(current.url, current.original_name).catch(() => {})
  }

  const handleDownload = () => {
    triggerDownload(current.url, current.original_name)
  }

  return createPortal(
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="presentation"
        style={{
          width: '100%',
          maxWidth: 950,
          height: '94vh',
          background: 'var(--bg-card)',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header - identical to PdfPreviewModal */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--border-primary)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 'calc(13px * var(--fs-scale-body, 1))',
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {current.original_name}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleOpenTab}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                color: 'var(--text-muted)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textDecoration: 'none',
                padding: '4px 8px',
                borderRadius: 6,
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              <ExternalLink size={13} /> {t('files.openTab')}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                color: 'var(--text-muted)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textDecoration: 'none',
                padding: '4px 8px',
                borderRadius: 6,
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
            >
              <Download size={13} /> {t('files.download') || 'Download'}
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-faint)',
                display: 'flex',
                padding: 4,
                borderRadius: 6,
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-faint)')}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Tab strip if multiple receipts */}
        {receipts.length > 1 && (
          <div
            className="bg-surface-secondary"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 14px',
              borderBottom: '1px solid var(--border-primary)',
              overflowX: 'auto',
              flexShrink: 0,
            }}
          >
            {receipts.map((r, i) => {
              const active = i === index
              const isRImg = isImage(r.mime_type)
              const Icon = isRImg ? FileImage : FileText
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setIndex(i)}
                  className={active ? 'bg-surface-card text-content font-semibold shadow-sm' : 'text-content-muted hover:text-content'}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 11px',
                    borderRadius: 8,
                    border: active ? '1px solid var(--border-primary)' : '1px solid transparent',
                    background: active ? 'var(--bg-card)' : 'none',
                    fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    fontFamily: 'inherit',
                    transition: 'all 0.15s',
                  }}
                >
                  <Icon size={12} className={active ? 'text-content' : 'text-content-faint'} />
                  <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.original_name}
                  </span>
                  <span
                    style={{
                      fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
                      opacity: active ? 0.8 : 0.5,
                      marginLeft: 2,
                    }}
                  >
                    #{i + 1}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* Content Body */}
        <div
          style={{
            flex: 1,
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            background: isImg ? '#0f141c' : 'var(--bg-card)',
            minHeight: 0,
          }}
        >
          {receipts.length > 1 && index > 0 && (
            <button
              type="button"
              onClick={() => setIndex(i => i - 1)}
              style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 10,
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'rgba(0,0,0,0.5)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <ChevronLeft size={20} />
            </button>
          )}

          {receipts.length > 1 && index < receipts.length - 1 && (
            <button
              type="button"
              onClick={() => setIndex(i => i + 1)}
              style={{
                position: 'absolute',
                right: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 10,
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: 'rgba(0,0,0,0.5)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <ChevronRight size={20} />
            </button>
          )}

          {isPdf ? (
            <object
              data={signedUrl ? `${signedUrl}#view=FitH` : undefined}
              type="application/pdf"
              style={{ flex: 1, width: '100%', height: '100%', border: 'none' }}
              title={current.original_name}
            >
              <p style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                <button
                  type="button"
                  onClick={handleOpenTab}
                  style={{
                    color: 'var(--text-primary)',
                    textDecoration: 'underline',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  {t('files.downloadPdf')}
                </button>
              </p>
            </object>
          ) : isImg ? (
            <div
              style={{
                padding: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: '100%',
              }}
            >
              {signedUrl ? (
                <img
                  src={signedUrl}
                  alt={current.original_name}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    borderRadius: 6,
                    display: 'block',
                  }}
                />
              ) : (
                <div className="text-content-faint" style={{ padding: 48 }}>
                  {loading ? `${t('common.loading')}...` : current.original_name}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <FileText size={44} className="text-content-muted mx-auto" style={{ marginBottom: 16 }} />
              <p className="text-content font-medium" style={{ marginBottom: 14 }}>
                {current.original_name}
              </p>
              <button
                type="button"
                onClick={handleDownload}
                className="bg-primary text-white"
                style={{
                  padding: '9px 18px',
                  borderRadius: 10,
                  border: 0,
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 'calc(13px * var(--fs-scale-body, 1))',
                  fontFamily: 'inherit',
                }}
              >
                {t('files.download')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
