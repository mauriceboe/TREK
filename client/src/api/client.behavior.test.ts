// FE-APIWIRE-001 to FE-APIWIRE-036
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { weatherResultSchema } from '@trek/shared'

// client.ts probes the health endpoint to tell an edge-proxy auth wall apart
// from a plain offline boot — the probe result decides whether it tears down
// the service worker, so the tests drive it directly.
const { probeNow } = vi.hoisted(() => ({
  probeNow: vi.fn(async (): Promise<'online' | 'offline' | 'proxy-wall'> => 'offline'),
}))
vi.mock('../sync/connectivity', () => ({ probeNow }))

const { apiClient, adminApi, mapsApi, pluginsApi, parseInDev } = await import('./client')

interface FakeLocation {
  href: string
  origin: string
  pathname: string
  search: string
  hash: string
  reload: () => void
}

let reload: ReturnType<typeof vi.fn<() => void>>

function setLocation(pathname: string, search = '', hash = ''): FakeLocation {
  reload = vi.fn<() => void>()
  const loc: FakeLocation = {
    href: `http://localhost:3000${pathname}${search}${hash}`,
    origin: 'http://localhost:3000',
    pathname,
    search,
    hash,
    reload,
  }
  Object.defineProperty(window, 'location', { writable: true, configurable: true, value: loc })
  return loc
}

const realLocation = window.location

/** Records the outgoing config and answers 200 without touching the network. */
function okAdapter(sink: InternalAxiosRequestConfig[]): AxiosAdapter {
  return (config) => {
    sink.push(config)
    return Promise.resolve({
      data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config,
    } as AxiosResponse)
  }
}

/** Rejects the way a CORS/offline failure does: an error with no `response`. */
const networkErrorAdapter: AxiosAdapter = (config) =>
  Promise.reject(new AxiosError('Network Error', AxiosError.ERR_NETWORK, config))

async function captureError(run: () => Promise<unknown>): Promise<AxiosError> {
  const err = await run().then(() => null, (e: unknown) => e as AxiosError)
  expect(err, 'expected the request to reject').not.toBeNull()
  return err as AxiosError
}

beforeEach(() => {
  probeNow.mockResolvedValue('offline')
  setLocation('/dashboard')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'location', { writable: true, configurable: true, value: realLocation })
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
})

describe('client > request interceptor', () => {
  it('FE-APIWIRE-001: mutating requests get an idempotency key, reads do not', async () => {
    const sink: InternalAxiosRequestConfig[] = []
    const adapter = okAdapter(sink)

    await apiClient.get('/probe', { adapter })
    await apiClient.post('/probe', {}, { adapter })
    await apiClient.put('/probe', {}, { adapter })
    await apiClient.patch('/probe', {}, { adapter })
    await apiClient.delete('/probe', { adapter })

    const keys = sink.map(c => c.headers['X-Idempotency-Key'])
    expect(keys[0]).toBeUndefined()
    for (const key of keys.slice(1)) expect(typeof key).toBe('string')
  })

  it('FE-APIWIRE-002: each write gets its own key so retries can be deduplicated', async () => {
    const sink: InternalAxiosRequestConfig[] = []
    const adapter = okAdapter(sink)

    await apiClient.post('/probe', {}, { adapter })
    await apiClient.post('/probe', {}, { adapter })

    expect(sink[0].headers['X-Idempotency-Key']).not.toBe(sink[1].headers['X-Idempotency-Key'])
  })

  it('FE-APIWIRE-003: a pre-generated key from the mutation queue is left alone', async () => {
    const sink: InternalAxiosRequestConfig[] = []

    await apiClient.post('/probe', {}, {
      adapter: okAdapter(sink),
      headers: { 'X-Idempotency-Key': 'queued-key' },
    })

    expect(sink[0].headers['X-Idempotency-Key']).toBe('queued-key')
  })

  it('FE-APIWIRE-004: falls back to getRandomValues when crypto.randomUUID is missing', async () => {
    const realCrypto = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    } as unknown as Crypto)

    const sink: InternalAxiosRequestConfig[] = []
    await apiClient.post('/probe', {}, { adapter: okAdapter(sink) })

    // randomUUID needs a secure context, so on the plain-http installs the
    // README documents this branch is what actually runs. getRandomValues has no
    // such requirement, so the fallback is still a full v4 UUID.
    expect(String(sink[0].headers['X-Idempotency-Key'])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('FE-APIWIRE-004b: the last-resort key is never degenerate, even with no Web Crypto at all', async () => {
    vi.stubGlobal('crypto', undefined)

    const keys = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const sink: InternalAxiosRequestConfig[] = []
      await apiClient.post('/probe', {}, { adapter: okAdapter(sink) })
      keys.add(String(sink[0].headers['X-Idempotency-Key']))
    }

    // The old fallback was Math.random().toString(36).slice(2), which is not
    // length-stable: 0.5 yields a single character and 0 yields the empty string.
    // An empty key makes the server skip deduplication entirely, so a retried
    // write applies twice.
    for (const k of keys) expect(k.length).toBeGreaterThan(16)
    expect(keys.size).toBe(50)
  })

  it('FE-APIWIRE-005: the socket id header is omitted while no socket is connected', async () => {
    const sink: InternalAxiosRequestConfig[] = []
    await apiClient.get('/probe', { adapter: okAdapter(sink) })
    expect(sink[0].headers['X-Socket-Id']).toBeUndefined()
  })

  it('FE-APIWIRE-034: a rejection from an earlier request interceptor is passed on untouched', async () => {
    const boom = new Error('interceptor refused the request')
    const id = apiClient.interceptors.request.use(() => Promise.reject(boom))
    const sink: InternalAxiosRequestConfig[] = []

    try {
      await expect(apiClient.post('/probe', {}, { adapter: okAdapter(sink) })).rejects.toBe(boom)
    } finally {
      apiClient.interceptors.request.eject(id)
    }

    expect(sink).toHaveLength(0)
  })
})

describe('client > rate-limit translation', () => {
  beforeEach(() => {
    server.use(http.get('/api/limited', () => HttpResponse.json({ error: 'Too Many Requests' }, { status: 429 })))
  })

  it('FE-APIWIRE-006: a 429 is rewritten in the stored app language', async () => {
    localStorage.setItem('app_language', 'de')
    const err = await captureError(() => apiClient.get('/limited'))

    expect(err.message).toBe('Zu viele Versuche. Bitte versuchen Sie es später erneut.')
    expect((err.response?.data as { error: string }).error)
      .toBe('Zu viele Versuche. Bitte versuchen Sie es später erneut.')
  })

  it('FE-APIWIRE-007: an unsupported language falls back to English', async () => {
    localStorage.setItem('app_language', 'kl')
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.message).toBe('Too many attempts. Please try again later.')
  })

  it('FE-APIWIRE-008: no stored language falls back to English', async () => {
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.message).toBe('Too many attempts. Please try again later.')
  })

  it('FE-APIWIRE-009: a blocked localStorage still yields the English message', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.message).toBe('Too many attempts. Please try again later.')
  })

  it('FE-APIWIRE-010: a non-object 429 body is replaced with the translated error object', async () => {
    server.use(http.get('/api/limited', () => new HttpResponse('slow down', { status: 429 })))
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.response?.data).toEqual({ error: 'Too many attempts. Please try again later.' })
  })

  it('FE-APIWIRE-035: an array 429 body is replaced, not grafted onto', async () => {
    server.use(http.get('/api/limited', () => HttpResponse.json([{ field: 'email' }], { status: 429 })))
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.response?.data).toEqual({ error: 'Too many attempts. Please try again later.' })
  })

  it('FE-APIWIRE-036: Catalan, Greek and Vietnamese have their own 429 message', async () => {
    for (const lang of ['ca', 'gr', 'vi']) {
      localStorage.setItem('app_language', lang)
      const err = await captureError(() => apiClient.get('/limited'))
      expect(err.message).not.toBe('Too many attempts. Please try again later.')
    }
  })
})

describe('client > proxy auth challenges', () => {
  function installServiceWorker(unregister: () => Promise<boolean>) {
    const getRegistration = vi.fn(async () => ({ unregister }))
    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true, configurable: true, value: { getRegistration },
    })
    return getRegistration
  }

  it('FE-APIWIRE-011: an HTML 401 behind a confirmed proxy wall unregisters the service worker and reloads', async () => {
    probeNow.mockResolvedValue('proxy-wall')
    const unregister = vi.fn(async () => true)
    installServiceWorker(unregister)
    server.use(http.get('/api/auth/me', () =>
      new HttpResponse('<html>login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } })))

    await captureError(() => apiClient.get('/auth/me'))

    expect(unregister).toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('proxy_reauth_attempted')).toBe('1')
  })

  it('FE-APIWIRE-016: an HTML 401 from TREK itself keeps the service worker (#2228)', async () => {
    // text/html is not proof of a proxy: several of TREK's own routes answer
    // res.status(401).send('Authentication required'), which Express labels
    // text/html. Tearing the worker down for one of those costs the user
    // offline mode for a wall that is not there, so confirm reachability first.
    probeNow.mockResolvedValue('online')
    const unregister = vi.fn(async () => true)
    installServiceWorker(unregister)
    server.use(http.get('/api/auth/me', () =>
      new HttpResponse('Authentication required', { status: 401, headers: { 'Content-Type': 'text/html' } })))

    await captureError(() => apiClient.get('/auth/me'))

    expect(probeNow).toHaveBeenCalled()
    expect(unregister).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('proxy_reauth_attempted')).toBeNull()
  })

  it('FE-APIWIRE-012: the reauth reload only fires once per session', async () => {
    installServiceWorker(vi.fn(async () => true))
    sessionStorage.setItem('proxy_reauth_attempted', '1')
    server.use(http.get('/api/auth/me', () =>
      new HttpResponse('<html>login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } })))

    await captureError(() => apiClient.get('/auth/me'))

    expect(reload).not.toHaveBeenCalled()
  })

  it('FE-APIWIRE-013: an HTML 401 on a public path never reloads', async () => {
    setLocation('/login')
    server.use(http.get('/api/auth/me', () =>
      new HttpResponse('<html>login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } })))

    await captureError(() => apiClient.get('/auth/me'))

    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('proxy_reauth_attempted')).toBeNull()
  })

  it('FE-APIWIRE-014: a response-less failure that probes proxy-wall reloads', async () => {
    probeNow.mockResolvedValue('proxy-wall')
    installServiceWorker(vi.fn(async () => true))

    await captureError(() => apiClient.get('/auth/me', { adapter: networkErrorAdapter }))

    expect(probeNow).toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('FE-APIWIRE-015: a response-less failure that probes offline keeps the SW (#1346)', async () => {
    probeNow.mockResolvedValue('offline')
    const getRegistration = installServiceWorker(vi.fn(async () => true))

    await captureError(() => apiClient.get('/auth/me', { adapter: networkErrorAdapter }))

    expect(getRegistration).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('proxy_reauth_attempted')).toBeNull()
  })

  it('FE-APIWIRE-016: a failing unregister still reloads into the proxy challenge', async () => {
    probeNow.mockResolvedValue('proxy-wall')
    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true, configurable: true,
      value: { getRegistration: vi.fn(async () => { throw new Error('SW gone') }) },
    })

    await captureError(() => apiClient.get('/auth/me', { adapter: networkErrorAdapter }))

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('FE-APIWIRE-017: a proxy-wall probe on a shared page does not reload', async () => {
    setLocation('/shared/tok123')
    probeNow.mockResolvedValue('proxy-wall')

    await captureError(() => apiClient.get('/auth/me', { adapter: networkErrorAdapter }))

    expect(reload).not.toHaveBeenCalled()
  })

  it('FE-APIWIRE-035: a 401 without a content-type is not mistaken for a proxy login page', async () => {
    installServiceWorker(vi.fn(async () => true))
    server.use(http.get('/api/auth/me', () => new HttpResponse(null, { status: 401 })))

    await captureError(() => apiClient.get('/auth/me'))

    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('proxy_reauth_attempted')).toBeNull()
  })

  it('FE-APIWIRE-018: a successful response clears the reauth marker', async () => {
    sessionStorage.setItem('proxy_reauth_attempted', '1')
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ ok: true })))

    await apiClient.get('/auth/me')

    expect(sessionStorage.getItem('proxy_reauth_attempted')).toBeNull()
  })
})

describe('client > redirect handling', () => {
  it('FE-APIWIRE-019: a JSON AUTH_REQUIRED 401 redirects with the full current path', async () => {
    const loc = setLocation('/trips/7', '?tab=map', '#day-2')
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ code: 'AUTH_REQUIRED' }, { status: 401 })))

    await captureError(() => apiClient.get('/auth/me'))

    expect(loc.href).toBe('/login?redirect=' + encodeURIComponent('/trips/7?tab=map#day-2'))
  })

  it('FE-APIWIRE-020: an MFA_REQUIRED 403 sends the user to the settings page', async () => {
    const loc = setLocation('/dashboard')
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ code: 'MFA_REQUIRED' }, { status: 403 })))

    await captureError(() => apiClient.get('/auth/me'))

    expect(loc.href).toBe('/settings?mfa=required')
  })
})

describe('client > dev-only contract drift checks', () => {
  it('FE-APIWIRE-021: parseInDev passes a matching payload straight through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = { temp: 21, main: 'Clear', description: 'clear sky', type: 'sun' }

    expect(parseInDev(weatherResultSchema, payload, 'weather.get')).toBe(payload)
    expect(warn).not.toHaveBeenCalled()
  })

  it('FE-APIWIRE-022: parseInDev warns but still returns a drifting payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = { temp: 'warm', main: 'Clear', description: 'clear sky', type: 'sun' }

    expect(parseInDev(weatherResultSchema, payload, 'weather.get')).toBe(payload)
    expect(warn).toHaveBeenCalledWith(
      '[api] weather.get: response did not match the @trek/shared schema',
      expect.anything(),
    )
  })

  it('FE-APIWIRE-023: a drifting maps response is reported under its own label', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(http.post('/api/maps/search', () => HttpResponse.json({ nonsense: true })))

    await expect(mapsApi.search('Rome')).resolves.toEqual({ nonsense: true })
    expect(warn).toHaveBeenCalledWith(
      '[api] maps.search: response did not match the @trek/shared schema',
      expect.anything(),
    )
  })
})

describe('client > pluginsApi.invoke namespace guard', () => {
  it('FE-APIWIRE-024: a relative sub-path stays inside the plugin namespace', async () => {
    let seen = ''
    server.use(http.get('/api/plugins/koffi/ping', ({ request }) => {
      seen = new URL(request.url).pathname
      return HttpResponse.json({ pong: true })
    }))

    await expect(pluginsApi.invoke('koffi', '/ping')).resolves.toEqual({ pong: true })
    expect(seen).toBe('/api/plugins/koffi/ping')
  })

  it('FE-APIWIRE-025: method, body and query string survive the rewrite', async () => {
    let received: unknown
    let query = ''
    server.use(http.post('/api/plugins/koffi/sync', async ({ request }) => {
      received = await request.json()
      query = new URL(request.url).search
      return HttpResponse.json({ ok: true })
    }))

    await pluginsApi.invoke('koffi', 'sync?full=1', { method: 'POST', body: { since: 5 } })

    expect(received).toEqual({ since: 5 })
    expect(query).toBe('?full=1')
  })

  it('FE-APIWIRE-026: traversal out of the plugin prefix is refused', async () => {
    await expect(pluginsApi.invoke('koffi', '/../../auth/me'))
      .rejects.toThrow('plugin route escapes its namespace')
  })

  it('FE-APIWIRE-027: an absolute off-origin target is refused', async () => {
    await expect(pluginsApi.invoke('koffi', 'https://evil.test/steal'))
      .rejects.toThrow('plugin route escapes its namespace')
  })

  it('FE-APIWIRE-028: an unparseable sub-path is refused before any request', async () => {
    await expect(pluginsApi.invoke('koffi', 'http://')).rejects.toThrow('invalid plugin route')
  })
})

describe('client > adminApi.llmLocalPull', () => {
  function streamingResponse(chunks: string[]): Response {
    let i = 0
    const encoder = new TextEncoder()
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
    } as unknown as Response
  }

  it('FE-APIWIRE-029: NDJSON progress lines are reported even when split across chunks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(streamingResponse([
      '{"status":"pulling","total":100,"completed":10}\n{"status":"pul',
      'ling","total":100,"completed":90}\n{"status":"success"}\n',
    ]))
    const onProgress = vi.fn((_p: { status?: string }) => {})

    await adminApi.llmLocalPull('http://ollama:11434', 'qwen3:8b', onProgress)

    expect(onProgress.mock.calls.map(c => c[0])).toEqual([
      { status: 'pulling', total: 100, completed: 10 },
      { status: 'pulling', total: 100, completed: 90 },
      { status: 'success' },
    ])
  })

  it('FE-APIWIRE-030: blank and half-written lines are skipped instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(streamingResponse([
      '\n   \n{"status":"a"}\nnot-json\n{"status":"b"}\n',
    ]))
    const onProgress = vi.fn((_p: { status?: string }) => {})

    await adminApi.llmLocalPull('http://ollama:11434', 'qwen3:8b', onProgress)

    expect(onProgress.mock.calls.map(c => c[0])).toEqual([{ status: 'a' }, { status: 'b' }])
  })

  it('FE-APIWIRE-031: a JSON error body becomes the thrown message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 502, body: null,
      json: async () => ({ error: 'ollama unreachable' }),
    } as unknown as Response)

    await expect(adminApi.llmLocalPull('http://ollama:11434', 'x', vi.fn()))
      .rejects.toThrow('ollama unreachable')
  })

  it('FE-APIWIRE-032: a non-JSON error body falls back to the status code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 500, body: null,
      json: async () => { throw new SyntaxError('not json') },
    } as unknown as Response)

    await expect(adminApi.llmLocalPull('http://ollama:11434', 'x', vi.fn()))
      .rejects.toThrow('Pull failed (500)')
  })

  it('FE-APIWIRE-036: a throw from onProgress aborts the pull', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(streamingResponse([
      '{"status":"pulling manifest"}\n{"error":"manifest not found"}\n{"status":"success"}\n',
    ]))
    const onProgress = vi.fn((p: { error?: string }) => {
      if (p.error) throw new Error(p.error)
    })

    await expect(adminApi.llmLocalPull('http://ollama:11434', 'x', onProgress))
      .rejects.toThrow('manifest not found')
    expect(onProgress).toHaveBeenCalledTimes(2)
  })

  it('FE-APIWIRE-033: a 200 without a readable body reports the missing stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200, body: null,
      json: async () => ({}),
    } as unknown as Response)

    await expect(adminApi.llmLocalPull('http://ollama:11434', 'x', vi.fn()))
      .rejects.toThrow('Pull returned no progress stream')
  })
})
