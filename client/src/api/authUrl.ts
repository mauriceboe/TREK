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
