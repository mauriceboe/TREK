import { useEffect, useState, useRef } from 'react'
import ReactDOM from 'react-dom'
import QRCode from 'react-qr-code'
import { X, Copy, Check, Printer } from 'lucide-react'

interface QRDisplayModalProps {
  title: string
  value: string
  onClose: () => void
}

export function QRDisplayModal({ title, value, onClose }: QRDisplayModalProps) {
  const [copied, setCopied] = useState(false)
  const qrRef = useRef<HTMLDivElement>(null)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy', err)
    }
  }

  const handlePrint = () => {
    const qrSvg = qrRef.current?.querySelector('svg')
    if (!qrSvg) return

    const printWindow = window.open('', '_blank')
    if (!printWindow) return

    const svgHtml = qrSvg.outerHTML

    printWindow.document.write(`
      <html>
        <head>
          <title>Print QR Code - ${title}</title>
          <style>
            body { 
              display: flex; 
              flex-direction: column; 
              align-items: center; 
              justify-content: center; 
              min-height: 100vh; 
              margin: 0; 
              padding: 40px;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            .container { text-align: center; max-width: 500px; width: 100%; }
            h1 { margin-bottom: 40px; color: #000; font-size: 28px; font-weight: 700; }
            .qr-wrapper { background: white; padding: 20px; display: inline-block; border: 2px solid #000; border-radius: 20px; }
            .qr-wrapper svg { width: 400px !important; height: 400px !important; display: block; }
            @media print {
              body { min-height: auto; padding: 0; }
              .container { margin: 20px auto; border: none; }
              .qr-wrapper { border: none; padding: 0; }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>${title}</h1>
            <div class="qr-wrapper">
              ${svgHtml}
            </div>
          </div>
          <script>
            window.onload = () => {
              setTimeout(() => {
                window.print();
                window.close();
              }, 500);
            };
          </script>
        </body>
      </html>
    `)

    printWindow.document.close()
  }

  // Prevent background scrolling
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return ReactDOM.createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 16, padding: 24,
        maxWidth: 360, width: '100%', boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20
      }} onClick={e => e.stopPropagation()}>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            borderRadius: 8, color: 'var(--text-faint)', display: 'flex'
          }}>
            <X size={18} />
          </button>
        </div>

        <div ref={qrRef} style={{ background: 'white', padding: 16, borderRadius: 12 }}>
          <QRCode
            value={value}
            size={256}
            style={{ height: 'auto', maxWidth: '100%', width: '100%' }}
            viewBox={`0 0 256 256`}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
          <button onClick={handlePrint} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)',
            background: 'var(--bg-secondary)', color: 'var(--text-primary)',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            flex: 1, justifyContent: 'center', transition: 'all 0.2s'
          }}>
            <Printer size={14} />
            Print
          </button>
          <button onClick={handleCopy} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)',
            background: 'var(--bg-secondary)', color: 'var(--text-primary)',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            flex: 1, justifyContent: 'center', transition: 'all 0.2s'
          }}>
            {copied ? <Check size={14} style={{ color: '#10b981' }} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy raw'}
          </button>
        </div>

      </div>
    </div>,
    document.body
  )
}
