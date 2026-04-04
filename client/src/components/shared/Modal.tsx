import React, { useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'

const sizeClasses: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-5xl',
}

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: React.ReactNode
  children?: React.ReactNode
  size?: string
  footer?: React.ReactNode
  hideCloseButton?: boolean
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  footer,
  hideCloseButton = false,
}: ModalProps) {
  const handleEsc = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleEsc)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleEsc)
      document.body.style.overflow = ''
    }
  }, [isOpen, handleEsc])

  const mouseDownTarget = useRef<EventTarget | null>(null)

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center px-4 modal-backdrop"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.5)', paddingTop: 70, paddingBottom: 20, overflow: 'hidden' }}
      onMouseDown={e => { mouseDownTarget.current = e.target }}
      onClick={e => {
        if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) onClose()
        mouseDownTarget.current = null
      }}
    >
      <div
        className={`
          rounded-2xl shadow-2xl w-full ${sizeClasses[size] || sizeClasses.md}
          flex flex-col max-h-[calc(100vh-90px)]
          animate-in fade-in zoom-in-95 duration-200
        `}
        style={{
          animation: 'modalIn 0.2s ease-out forwards',
          background: 'var(--bg-card)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
          {!hideCloseButton && (
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="p-6" style={{ borderTop: '1px solid var(--border-secondary)' }}>
            {footer}
          </div>
        )}
      </div>

      <style>{`
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.95) translateY(-10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  )
}
