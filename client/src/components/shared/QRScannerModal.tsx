import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { Html5Qrcode } from 'html5-qrcode'
import { X, QrCode, Image as ImageIcon, Camera } from 'lucide-react'

interface QRScannerModalProps {
  title: string
  onScan: (decodedText: string) => void
  onClose: () => void
}

export function QRScannerModal({ title, onScan, onClose }: QRScannerModalProps) {
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Prevent background scrolling
    document.body.style.overflow = 'hidden'

    const html5QrCode = new Html5Qrcode("qr-reader")
    html5QrCodeRef.current = html5QrCode

    // Start camera by default
    startCamera()

    return () => {
      document.body.style.overflow = ''
      if (html5QrCodeRef.current && html5QrCodeRef.current.isScanning) {
        html5QrCodeRef.current.stop().catch(console.error)
      }
    }
  }, [])

  const startCamera = async () => {
    if (!html5QrCodeRef.current) return
    setError(null)
    try {
      await html5QrCodeRef.current.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          stopCamera().then(() => onScan(decodedText))
        },
        () => {} // ignore scan errors
      )
      setIsCameraActive(true)
    } catch (err) {
      console.error("Failed to start camera", err)
      setError("Could not access camera. Please check permissions or try uploading an image.")
      setIsCameraActive(false)
    }
  }

  const stopCamera = async () => {
    if (html5QrCodeRef.current && html5QrCodeRef.current.isScanning) {
      await html5QrCodeRef.current.stop()
      setIsCameraActive(false)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !html5QrCodeRef.current) return

    setError(null)
    try {
      // If camera is active, stop it before scanning file
      if (isCameraActive) await stopCamera()
      
      const decodedText = await html5QrCodeRef.current.scanFile(file, true)
      onScan(decodedText)
    } catch (err) {
      console.error("Failed to scan file", err)
      setError("No QR code found in this image.")
      // Restart camera if it was active or if we want to fallback
      if (!isCameraActive) startCamera()
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
          }} onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
            <X size={20} />
          </button>
        </div>

        <div style={{ 
          width: '100%', 
          aspectRatio: '1/1', 
          background: 'black', 
          borderRadius: 16, 
          overflow: 'hidden', 
          position: 'relative',
          boxShadow: 'inset 0 0 20px rgba(255,255,255,0.1)'
        }}>
          <div id="qr-reader" style={{ width: '100%', height: '100%' }}></div>
          {!isCameraActive && !error && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', opacity: 0.5 }}>
              <Camera size={48} />
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
              Upload Image
            </button>
            
            {!isCameraActive && (
              <button 
                onClick={startCamera}
                style={{
                  flex: 1,
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 16px', borderRadius: 12, border: 'none',
                  background: 'var(--accent)', color: 'white',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                  justifyContent: 'center', transition: 'all 0.2s',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
                }}
              >
                <Camera size={18} />
                Try Camera
              </button>
            )}
          </div>
        </div>

      </div>
    </div>,
    document.body
  )
}
