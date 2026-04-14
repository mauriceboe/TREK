// MIME types safe to open inline (will not execute script in any browser).
// Everything else (text/html, image/svg+xml, text/javascript, …) is forced to
// download so a maliciously-named upload cannot run code in the TREK origin.
const SAFE_INLINE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
])

/**
 * Asserts that `url` is a relative same-origin path so that
 * `credentials: 'include'` cannot be used to send the session cookie to an
 * external host (e.g. if an attacker somehow controls the `url` value).
 */
function assertRelativeUrl(url: string): void {
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) {
    throw new Error(`Refusing to fetch non-relative URL: ${url}`)
  }
}

function triggerAnchorDownload(blobUrl: string, filename?: string): void {
  const a = document.createElement('a')
  a.href = blobUrl
  if (filename) a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove() }, 100)
}

/**
 * Fetches a protected file using cookie auth (credentials: include) and
 * triggers a browser download. Works inside PWA standalone mode because the
 * fetch stays in the PWA's WebView rather than handing off to the system
 * browser (which would lose the session cookie).
 */
export async function downloadFile(url: string, filename?: string): Promise<void> {
  assertRelativeUrl(url)
  const resp = await fetch(url, { credentials: 'include' })
  if (!resp.ok) throw new Error(resp.status === 401 ? 'Unauthorized' : `HTTP ${resp.status}`)
  const blob = await resp.blob()
  const blobUrl = URL.createObjectURL(blob)
  triggerAnchorDownload(blobUrl, filename)
}

/**
 * Fetches a protected file using cookie auth and opens it in a new tab as a
 * blob URL. The blob URL is same-origin to the PWA context so no system
 * browser handoff occurs, fixing the auth error in PWA standalone mode.
 *
 * Only PDFs and raster images are opened inline. All other MIME types
 * (including text/html and image/svg+xml which can execute script) are forced
 * to download so that an uploaded file cannot run code in the TREK origin.
 *
 * Falls back to a download trigger if the popup is blocked.
 */
export async function openFile(url: string, filename?: string): Promise<void> {
  assertRelativeUrl(url)
  const resp = await fetch(url, { credentials: 'include' })
  if (!resp.ok) throw new Error(resp.status === 401 ? 'Unauthorized' : `HTTP ${resp.status}`)
  const blob = await resp.blob()
  const blobUrl = URL.createObjectURL(blob)

  // Force download for MIME types that can execute script when rendered inline
  if (!SAFE_INLINE_TYPES.has(blob.type)) {
    triggerAnchorDownload(blobUrl, filename)
    return
  }

  const win = window.open(blobUrl, '_blank', 'noreferrer')
  if (win) {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
  } else {
    // Popup blocked — fall back to download
    triggerAnchorDownload(blobUrl, filename)
  }
}
