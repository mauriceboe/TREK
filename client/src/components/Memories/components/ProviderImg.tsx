import { useEffect, useState } from 'react'
import { fetchImageAsBlob } from '../../../api/authUrl'

interface ProviderImgProps {
  baseUrl: string
  style?: React.CSSProperties
  loading?: 'lazy' | 'eager'
}

export function ProviderImg({ baseUrl, style, loading }: ProviderImgProps) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    let revoke = ''
    fetchImageAsBlob('/api' + baseUrl).then(blobUrl => {
      revoke = blobUrl
      setSrc(blobUrl)
    })

    return () => {
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [baseUrl])

  return src ? <img src={src} alt="" loading={loading} style={style} /> : null
}
