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
  it('fetches with credentials:include and opens blob URL in new tab', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200))
    const mockWin = { closed: false }
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(mockWin as Window)

    await openFile('/uploads/files/doc.pdf')

    expect(window.fetch).toHaveBeenCalledWith('/uploads/files/doc.pdf', { credentials: 'include' })
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(openSpy).toHaveBeenCalledWith('blob:mock-url', '_blank', 'noreferrer')

    // Revoke happens after 30s timeout
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('falls back to anchor download when popup is blocked', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200))
    vi.spyOn(window, 'open').mockReturnValue(null)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openFile('/uploads/files/doc.pdf')

    expect(clickSpy).toHaveBeenCalled()
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('throws on 401 response', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, new Blob([], { type: 'application/pdf' })))
    await expect(openFile('/uploads/files/secret.pdf')).rejects.toThrow('Unauthorized')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('forces download for unsafe MIME types (HTML, SVG) instead of opening inline', async () => {
    const htmlBlob = new Blob(['<script>alert(1)</script>'], { type: 'text/html' })
    vi.stubGlobal('fetch', makeFetchMock(200, htmlBlob))
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openFile('/uploads/files/malicious.html')

    // Must NOT open inline — download anchor clicked instead
    expect(openSpy).not.toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
  })

  it('forces download for SVG MIME type', async () => {
    const svgBlob = new Blob(['<svg><script>alert(1)</script></svg>'], { type: 'image/svg+xml' })
    vi.stubGlobal('fetch', makeFetchMock(200, svgBlob))
    vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openFile('/uploads/files/malicious.svg')

    expect(window.open).not.toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
  })
})
