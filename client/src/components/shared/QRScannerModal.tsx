import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { Html5Qrcode } from 'html5-qrcode'
import { X, QrCode, Image as ImageIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface QRScannerModalProps {
  title: string
  onScan: (decodedText: string) => void
  onClose: () => void
}

export function QRScannerModal({ title, onScan, onClose }: QRScannerModalProps) {
  const { t } = useTranslation()
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)

  // Force stop all video tracks on the page
  const killAllVideoTracks = () => {
    try {
      // 1. Stop tracks from the scanner's internal stream if possible
      document.querySelectorAll('video').forEach(video => {
        const stream = video.srcObject
        if (stream instanceof MediaStream) {
          stream.getTracks().forEach(track => {
            track.stop()
            track.enabled = false
          })
          video.srcObject = null
        }
      })
      
      // 2. Clear any lingering tracks from navigator
      if (navigator.mediaDevices && (navigator.mediaDevices as any).getDisplayMedia) {
        // Fallback for some browsers
      }
    } catch (e) {
      console.error("Error killing video tracks:", e)
    }
  }

  useEffect(() => {
    // Prevent background scrolling
    document.body.style.overflow = 'hidden'

    // Create a unique ID for this instance to avoid conflicts
    const readerId = "qr-reader-instance"
    const scanner = new Html5Qrcode(readerId)
    scannerRef.current = scanner

    const startScanner = async () => {
      try {
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          async (decodedText) => {
            // On Success: Stop camera first, then callback
            try {
              if (scanner.isScanning) {
                await scanner.stop()
                killAllVideoTracks()
              }
            } catch (e) {}
            onScan(decodedText)
          },
          () => {} // ignore scan errors
        )
        setIsInitialized(true)
      } catch (err) {
        console.error("Failed to start QR scanner:", err)
        setError("Could not access camera. Please check permissions.")
      }
    }

    // Delay start slightly to ensure DOM is ready
    const timer = setTimeout(startScanner, 100)

    return () => {
      clearTimeout(timer)
      document.body.style.overflow = ''
      
      const cleanup = async () => {
        if (scannerRef.current) {
          try {
            if (scannerRef.current.isScanning) {
              await scannerRef.current.stop()
            }
          } catch (e) {
            console.warn("Scanner stop failed during cleanup:", e)
          } finally {
            try {
              scannerRef.current.clear()
            } catch (e) {}
            scannerRef.current = null
            killAllVideoTracks()
          }
        }
      }
      cleanup()
    }
  }, [])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !scannerRef.current) return

    setError(null)
    try {
      const s = scannerRef.current
      // If camera is active, stop it before scanning file
      if (s.isScanning) {
        await s.stop()
        killAllVideoTracks()
      }
      
      const decodedText = await s.scanFile(file, true)
      onScan(decodedText)
    } catch (err) {
      console.error("Failed to scan file", err)
      setError("No QR code found in this image.")
    }
    // Clear input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return ReactDOM.createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 20, padding: '24px 24px 32px',
        maxWidth: 420, width: '100%', boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24
      }} onClick={e => e.stopPropagation()}>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ background: 'var(--bg-tertiary)', padding: 8, borderRadius: 10, color: 'var(--accent)' }}>
              <QrCode size={20} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
          </div>
          <button onClick={onClose} style={{
            background: 'var(--bg-tertiary)', border: 'none', cursor: 'pointer', padding: 8,
            borderRadius: 10, color: 'var(--text-faint)', display: 'flex', transition: 'all 0.2s'
          }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ 
          width: '100%', 
          aspectRatio: '1/1', 
          background: 'black', 
          borderRadius: 16, 
          overflow: 'hidden', 
          position: 'relative'
        }}>
          {/* IMPORTANT: ID matches the one in new Html5Qrcode() */}
          <div id="qr-reader-instance" style={{ width: '100%', height: '100%' }}></div>
          {!isInitialized && !error && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', opacity: 0.5 }}>
              <div className="animate-pulse">Starting camera...</div>
            </div>
          )}
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
          {error && (
            <div style={{ 
              fontSize: 13, 
              color: '#ef4444', 
              textAlign: 'center', 
              padding: '10px 14px', 
              background: 'rgba(239, 68, 68, 0.1)', 
              borderRadius: 10,
              fontWeight: 500
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, width: '100%' }}>
            <input 
              ref={fileInputRef}
              type="file" 
              accept="image/*" 
              style={{ display: 'none' }} 
              onChange={handleFileUpload}
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              style={{
                flex: 1,
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '12px 16px', borderRadius: 12, border: '1px solid var(--border-primary)',
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                justifyContent: 'center', transition: 'all 0.2s',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
              }}
            >
              <ImageIcon size={18} />
              {t('packing.uploadImage')}
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body
  )
}
