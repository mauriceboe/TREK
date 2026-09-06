import { useState } from 'react'
import { X } from 'lucide-react'

export function CollabChatAttachment({ attachment }: { attachment: { url: string; original_name?: string; mime_type?: string } }) {
  const [open, setOpen] = useState(false)
  return <>
    <img src={attachment.url} alt={attachment.original_name || 'Attached image'} onClick={() => setOpen(true)} style={{ display: 'block', width: 180, maxWidth: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 10, cursor: 'zoom-in', marginTop: 4 }} />
    {open && <div role="dialog" onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}><button aria-label="Close image" onClick={() => setOpen(false)} style={{ position: 'fixed', top: 18, right: 18, background: 'rgba(255,255,255,.15)', color: '#fff', border: 0, borderRadius: '50%', width: 36, height: 36 }}><X size={20} /></button><img src={attachment.url} alt={attachment.original_name || 'Attached image'} onClick={e => e.stopPropagation()} style={{ maxWidth: '95vw', maxHeight: '90vh', objectFit: 'contain' }} /></div>}
  </>
}
