import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { Html5Qrcode } from 'html5-qrcode'
import { X, QrCode, Image as ImageIcon, Loader2, Camera, RefreshCw } from 'lucide-react'
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
  const [isProcessingFile, setIsProcessingFile] = useState(false)
  const [isCameraActive, setIsCameraActive] = useState(true)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  // Force stop video tracks within this specific modal instance
  const killLocalVideoTracks = () => {
    try {
      const container = document.getElementById('qr-reader-instance')
      if (!container) return

      container.querySelectorAll('video').forEach(video => {
        const stream = video.srcObject
        if (stream instanceof MediaStream) {
          stream.getTracks().forEach(track => {
            track.stop()
            track.enabled = false
          })
          video.srcObject = null
        }
      })
    } catch (e) {
      console.error("Error killing local video tracks:", e)
    }
  }

  const startScanner = async () => {
    if (!scannerRef.current) return
    setError(null)
    setIsInitialized(false)
    setIsCameraActive(true)
    setImagePreview(null)

    try {
      const qrboxFunction = (viewfinderWidth: number, viewfinderHeight: number) => {
        const minEdgePercentage = 0.7; // 70%
        const minEdgeSize = Math.min(viewfinderWidth, viewfinderHeight);
        const qrboxSize = Math.floor(minEdgeSize * minEdgePercentage);
        return {
          width: qrboxSize,
          height: qrboxSize
        };
      }

      await scannerRef.current.start(
        { facingMode: "environment" },
        { 
          fps: 30, 
          qrbox: qrboxFunction,
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
          }
        },
        async (decodedText) => {
          try {
            if (scannerRef.current?.isScanning) {
              await scannerRef.current.stop()
              killLocalVideoTracks()
              setIsCameraActive(false)
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
      setIsCameraActive(false)
    }
  }

  useEffect(() => {
    document.body.style.overflow = 'hidden'

    const readerId = "qr-reader-instance"
    const scanner = new Html5Qrcode(readerId)
    scannerRef.current = scanner

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
            killLocalVideoTracks()
          }
        }
      }
      cleanup()
    }
  }, [])

  /**
   * Resizes and enhances an image for better QR detection.
   */
  const preprocessImage = (file: File, options: { grayscale?: boolean, contrast?: boolean } = {}): Promise<File> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        const MAX_DIM = 1200
        let width = img.width
        let height = img.height

        // Downscale if needed
        if (width > MAX_DIM || height > MAX_DIM) {
          const ratio = Math.min(MAX_DIM / width, MAX_DIM / height)
          width *= ratio
          height *= ratio
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(file)
          return
        }

        ctx.drawImage(img, 0, 0, width, height)

        if (options.grayscale || options.contrast) {
          const imageData = ctx.getImageData(0, 0, width, height)
          const data = imageData.data
          for (let i = 0; i < data.length; i += 4) {
            if (options.grayscale) {
              const avg = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
              data[i] = avg
              data[i + 1] = avg
              data[i + 2] = avg
            }
            if (options.contrast) {
              const factor = 1.6
              data[i] = Math.min(255, Math.max(0, (data[i] - 128) * factor + 128))
              data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] - 128) * factor + 128))
              data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] - 128) * factor + 128))
            }
          }
          ctx.putImageData(imageData, 0, 0)
        }

        canvas.toBlob((blob) => {
          if (blob) {
            const processedFile = new File([blob], file.name, { type: 'image/jpeg' })
            resolve(processedFile)
          } else {
            resolve(file)
          }
        }, 'image/jpeg', 0.9)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        resolve(file)
      }
      img.src = url
    })
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !scannerRef.current) return

    setError(null)
    setIsProcessingFile(true)
    
    // Create preview
    const reader = new FileReader()
    reader.onload = (event) => {
      setImagePreview(event.target?.result as string)
    }
    reader.readAsDataURL(file)

    const s = scannerRef.current
    
    try {
      if (s.isScanning) {
        await s.stop()
        killLocalVideoTracks()
        setIsCameraActive(false)
      }
      
      // 1. Try original file (unless it's massive)
      if (file.size < 8 * 1024 * 1024) {
        try {
          const decodedText = await s.scanFile(file, false)
          onScan(decodedText)
          return
        } catch (err) {
          console.log("Original scan failed, trying enhancements...")
        }
      }

      // 2. Try Standard Resize
      const resized = await preprocessImage(file)
      try {
        const decodedText = await s.scanFile(resized, false)
        onScan(decodedText)
        return
      } catch (err) {}

      // 3. Try Grayscale + Contrast
      const enhanced = await preprocessImage(file, { grayscale: true, contrast: true })
      const decodedText = await s.scanFile(enhanced, false)
      onScan(decodedText)

    } catch (err) {
      console.error("All file scan attempts failed:", err)
      setError(t('packing.qrNoCodeFound', 'No QR code found in this image. Please ensure the QR code is clear, well-lit, and not blurry.'))
    } finally {
      setIsProcessingFile(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return ReactDOM.createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 24, padding: '24px 24px 32px',
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
          borderRadius: 20, 
          overflow: 'hidden', 
          position: 'relative',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)'
        }}>
          {/* Camera Container */}
          <div id="qr-reader-instance" style={{ 
            width: '100%', 
            height: '100%',
            display: isCameraActive ? 'block' : 'none'
          }}></div>

          {/* Image Preview */}
          {imagePreview && !isCameraActive && (
            <div style={{ 
              position: 'absolute', 
              inset: 0, 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              background: '#000'
            }}>
              <img 
                src={imagePreview} 
                alt="Preview" 
                style={{ 
                  maxWidth: '100%', 
                  maxHeight: '100%', 
                  objectFit: 'contain',
                  opacity: isProcessingFile ? 0.5 : 1,
                  transition: 'opacity 0.2s'
                }} 
              />
            </div>
          )}
          
          {(isProcessingFile || (!isInitialized && isCameraActive)) && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', background: 'rgba(0,0,0,0.7)', gap: 12, zIndex: 5 }}>
              <Loader2 className="animate-spin" size={32} />
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                {isProcessingFile ? t('packing.processingImage', 'Analyzing image...') : t('packing.startingCamera', 'Starting camera...')}
              </div>
            </div>
          )}

          {!isCameraActive && !isProcessingFile && !imagePreview && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', background: 'rgba(0,0,0,0.4)', gap: 16, zIndex: 4 }}>
              <div style={{ opacity: 0.6 }}><ImageIcon size={48} /></div>
            </div>
          )}
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
          {error && (
            <div style={{ 
              fontSize: 13, 
              color: '#ef4444', 
              textAlign: 'center', 
              padding: '12px 16px', 
              background: 'rgba(239, 68, 68, 0.1)', 
              borderRadius: 12,
              fontWeight: 500,
              lineHeight: 1.5
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
            
            {!isCameraActive && !isProcessingFile ? (
              <button 
                onClick={startScanner}
                style={{
                  flex: 1,
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '14px 16px', borderRadius: 14, border: 'none',
                  background: 'var(--accent)', color: 'white',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                  justifyContent: 'center', transition: 'all 0.2s',
                  boxShadow: '0 4px 12px rgba(var(--accent-rgb), 0.3)'
                }}
              >
                <Camera size={18} />
                {t('packing.useCamera', 'Use Camera')}
              </button>
            ) : null}

            <button 
              disabled={isProcessingFile}
              onClick={() => fileInputRef.current?.click()}
              style={{
                flex: 1,
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '14px 16px', borderRadius: 14, border: '1px solid var(--border-primary)',
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                cursor: isProcessingFile ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                justifyContent: 'center', transition: 'all 0.2s',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                opacity: isProcessingFile ? 0.6 : 1
              }}
            >
              {isProcessingFile ? <Loader2 className="animate-spin" size={18} /> : (imagePreview ? <RefreshCw size={18} /> : <ImageIcon size={18} />)}
              {imagePreview ? t('packing.tryAnother', 'Try Another') : t('packing.uploadImage')}
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body
  )
}
