export async function getAuthUrl(url: string, purpose: 'download' | 'immich'): Promise<string> {
  if (!url) return url
  try {
    const resp = await fetch('/api/auth/resource-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ purpose }),
    })
    if (!resp.ok) return url
    const { token } = await resp.json()
    return `${url}${url.includes('?') ? '&' : '?'}token=${token}`
  } catch {
    return url
  }
}

// ── Blob-based image fetching (Safari-safe, no ephemeral tokens needed) ────

const MAX_CONCURRENT = 6
let active = 0
const queue: Array<() => void> = []

function dequeue() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    active++
    queue.shift()!()
  }
}

export function clearImageQueue() {
  queue.length = 0
}

export async function fetchImageAsBlob(url: string): Promise<string> {
  if (!url) return ''
  return new Promise<string>((resolve) => {
    const run = async () => {
      try {
        const resp = await fetch(url, { credentials: 'include' })
        if (!resp.ok) { resolve(''); return }
        const blob = await resp.blob()
        resolve(URL.createObjectURL(blob))
      } catch {
        resolve('')
      } finally {
        active--
        dequeue()
      }
    }
    if (active < MAX_CONCURRENT) {
      active++
      run()
    } else {
      queue.push(run)
    }
  })
}
