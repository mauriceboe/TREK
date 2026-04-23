import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadFile, openFile } from '../../../src/utils/fileDownload'

function makeFetchMock(status: number, blob: Blob = new Blob(['data'], { type: 'application/pdf' })) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    blob: () => Promise.resolve(blob),
  })
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el)
  vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('assertRelativeUrl (URL guard)', () => {
  it('rejects absolute http URLs', async () => {
    await expect(downloadFile('https://evil.com/x')).rejects.toThrow('Refusing to fetch non-relative URL')
  })
  it('rejects protocol-relative URLs', async () => {
    await expect(downloadFile('//evil.com/x')).rejects.toThrow('Refusing to fetch non-relative URL')
  })
  it('allows relative paths', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await expect(downloadFile('/trips/1/files/2/download')).resolves.toBeUndefined()
  })
})

describe('downloadFile', () => {
  it('fetches with credentials:include and triggers anchor download', async () => {
    const fetchMock = makeFetchMock(200)
    vi.stubGlobal('fetch', fetchMock)

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await downloadFile('/uploads/files/test.pdf', 'test.pdf')

    expect(fetchMock).toHaveBeenCalledWith('/uploads/files/test.pdf', { credentials: 'include' })
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()

    // Revoke happens after setTimeout(100)
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('sets download attribute to filename when provided', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await downloadFile('/uploads/files/report.pdf', 'report.pdf')

    // Check anchor was created with download attribute
    const appendCalls = (document.body.appendChild as ReturnType<typeof vi.fn>).mock.calls
    const anchor = appendCalls[0]?.[0] as HTMLAnchorElement
    expect(anchor.download).toBe('report.pdf')
  })

  it('throws on 401 response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401))
    await expect(downloadFile('/uploads/files/secret.pdf')).rejects.toThrow('Unauthorized')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

describe('openFile', () => {
  it('fetches with credentials:include and opens blob URL via target=_blank anchor', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200))
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openFile('/uploads/files/doc.pdf')

    expect(window.fetch).toHaveBeenCalledWith('/uploads/files/doc.pdf', { credentials: 'include' })
    expect(URL.createObjectURL).toHaveBeenCalled()
    // Must NOT call window.open — that path returns null when noreferrer is
    // set, which previously caused the file to also open in the current tab.
    expect(openSpy).not.toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalledTimes(1)

    // The anchor used to open the new tab must be target=_blank, must NOT
    // carry a `download` attribute (otherwise it would download in-page
    // instead of opening), and must use rel=noopener noreferrer.
    const appendCalls = (document.body.appendChild as ReturnType<typeof vi.fn>).mock.calls
    const anchor = appendCalls[0]?.[0] as HTMLAnchorElement
    expect(anchor.target).toBe('_blank')
    expect(anchor.rel).toBe('noopener noreferrer')
    expect(anchor.hasAttribute('download')).toBe(false)

    // Revoke happens after 30s timeout
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('does not trigger a second in-page action for safe inline types (regression: no double-open)', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200))
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openFile('/uploads/files/doc.pdf', 'doc.pdf')

    // Exactly ONE anchor click — opening the new tab. No fallback download.
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('throws on 401 response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, new Blob([], { type: 'application/pdf' })))
    await expect(openFile('/uploads/files/secret.pdf')).rejects.toThrow('Unauthorized')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('forces download for unsafe MIME types (HTML) instead of opening inline', async () => {
    const htmlBlob = new Blob(['<script>alert(1)</script>'], { type: 'text/html' })
    vi.stubGlobal('fetch', makeFetchMock(200, htmlBlob))
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openFile('/uploads/files/malicious.html', 'malicious.html')

    // Must NOT open inline — download anchor clicked instead
    expect(openSpy).not.toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalledTimes(1)

    const appendCalls = (document.body.appendChild as ReturnType<typeof vi.fn>).mock.calls
    const anchor = appendCalls[0]?.[0] as HTMLAnchorElement
    expect(anchor.download).toBe('malicious.html')
  })

  it('forces download for SVG MIME type', async () => {
    const svgBlob = new Blob(['<svg><script>alert(1)</script></svg>'], { type: 'image/svg+xml' })
    vi.stubGlobal('fetch', makeFetchMock(200, svgBlob))
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openFile('/uploads/files/malicious.svg')

    expect(openSpy).not.toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to download in iOS PWA standalone mode (blob URL inaccessible to Safari)', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200))
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    // Simulate iOS PWA (Add-to-Home-Screen) context
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })

    try {
      await openFile('/uploads/files/doc.pdf', 'doc.pdf')

      // Single anchor click — and it must be a DOWNLOAD anchor (no target=_blank),
      // because target="_blank" in iOS PWA would hand off to Safari which cannot
      // read the in-WebView blob URL.
      expect(clickSpy).toHaveBeenCalledTimes(1)
      const appendCalls = (document.body.appendChild as ReturnType<typeof vi.fn>).mock.calls
      const anchor = appendCalls[0]?.[0] as HTMLAnchorElement
      expect(anchor.target).toBe('')
      expect(anchor.download).toBe('doc.pdf')
    } finally {
      // Clean up the non-standard iOS-only property we forced above.
      delete (navigator as any).standalone
    }
  })
})
