import axios, { AxiosInstance } from 'axios'
import type { z } from 'zod'
import type { Place } from '../types'
import { randomId } from '../utils/randomId'
import {
  weatherResultSchema, type WeatherResult,
  inAppListResultSchema, type InAppListResult,
  unreadCountResultSchema, type UnreadCountResult,
  channelTestResultSchema,
  mapsSearchResultSchema, mapsAutocompleteResultSchema, mapsPlaceDetailsResultSchema,
  mapsPlacePhotoResultSchema, mapsReverseResultSchema, mapsResolveUrlResultSchema,
  mapsPlaceEnrichmentResultSchema,
  type NotificationRespondRequest,
  type SettingUpsertRequest, type SettingsBulkRequest,
  type JourneyCreateRequest, type JourneyAddTripRequest, type JourneyTracksResponse,
  type JourneyStats, type BookRecord, type BookSaveRequest,
  type JourneyReorderEntriesRequest, type JourneyProviderPhotosRequest,
  type JourneyShareLinkRequest,
  type RegisterRequest, type LoginRequest, type ForgotPasswordRequest,
  type ResetPasswordRequest, type ChangePasswordRequest,
  type MfaVerifyLoginRequest, type MfaEnableRequest, type McpTokenCreateRequest,
  type TripAddMemberRequest, type TripTransferOwnershipRequest,
  type TripCreateGuestRequest, type TripRenameGuestRequest, type AssignmentReorderRequest,
  type PackingReorderRequest, type PackingCreateBagRequest, type TodoReorderRequest,
  type TripCreateRequest, type TripUpdateRequest, type TripCopyRequest, type ActiveTripResponse,
  type DayCreateRequest, type DayUpdateRequest, type DayReorderRequest,
  type PlaceCreateRequest, type PlaceUpdateRequest,
  type ReservationCreateRequest, type ReservationUpdateRequest,
  type AccommodationCreateRequest, type AccommodationUpdateRequest,
  type BudgetCreateItemRequest, type BudgetUpdateItemRequest,
  type PackingCreateItemRequest, type PackingUpdateItemRequest, type PackingSetSharingRequest,
  type TodoCreateItemRequest, type TodoUpdateItemRequest,
  type AssignmentCreateRequest, type AssignmentNotesRequest, type AssignmentParticipantsRequest, type AssignmentTimeRequest, type AssignmentTransportRequest,
  type PlaceBulkDeleteRequest,
  type PlaceBulkUpdateRequest,
  type DayNoteCreateRequest, type DayNoteUpdateRequest,
  type PackingImportRequest, type PackingBagMembersRequest, type PackingUpdateBagRequest,
  type PackingCategoryAssigneesRequest, type PackingApplyTemplateRequest,
  type BudgetUpdateMembersRequest, type BudgetToggleMemberPaidRequest, type BudgetReorderCategoriesRequest,
  type TodoCategoryAssigneesRequest,
  type CollabNoteCreateRequest, type CollabNoteUpdateRequest, type CollabPollCreateRequest,
  type CollabPollVoteRequest, type CollabMessageCreateRequest, type CollabReactionRequest,
  type FileUpdateRequest, type FileLinkRequest,
  type CreateTagRequest, type UpdateTagRequest,
  type CreateCategoryRequest, type UpdateCategoryRequest,
  type PlaceImportListRequest,
  type BookingImportPreviewItem,
  type BookingImportPreviewResponse,
  type BookingImportConfirmResponse,
  type BookingImportMode,
  type StorageAdminState,
  type StorageBackend,
  type StorageConfigPut,
  type StorageTestResponse,
  type StorageUsage,
  type PluginSettingsField,
  type PluginInstanceConfigResponse,
  type PluginInstanceConfigUpdated,
  type PluginActionDescriptor,
  type PluginActionResult,
  type PluginInstallRequest,
} from '@trek/shared'
import { getSocketId } from './websocket'
import { probeNow } from '../sync/connectivity'
import { downloadBlob } from '../utils/fileDownload'

/**
 * Validate a response payload against its @trek/shared Zod schema — but only in
 * dev, and never throwing. A drift between the server contract and the client's
 * expected shape is surfaced as a console warning during development; in
 * production (and on any mismatch) the data passes through untouched, so adding
 * validation can never break a working call. This is the typed-request helper
 * the FE adopts per domain as each backend module lands on @trek/shared.
 */
const API_DEV = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
export function parseInDev<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.infer<S> {
  if (API_DEV) {
    const result = schema.safeParse(data)
    if (!result.success) {
      console.warn(`[api] ${label}: response did not match the @trek/shared schema`, result.error.issues)
    }
  }
  return data as z.infer<S>
}

/**
 * Same dev-only drift check as parseInDev, but passes the payload straight
 * through with its original inferred type instead of the schema type. Use this
 * for endpoints whose existing consumers rely on the loose `r.data` type — it
 * adds the development contract-drift warning without retyping the public
 * surface (so it can never break a consumer that worked before).
 */
function checkInDev<T>(schema: z.ZodTypeAny, data: T, label: string): T {
  if (API_DEV) {
    const result = schema.safeParse(data)
    if (!result.success) {
      console.warn(`[api] ${label}: response did not match the @trek/shared schema`, result.error.issues)
    }
  }
  return data
}
const RATE_LIMIT_MESSAGES: Record<string, string> = {
  en:      'Too many attempts. Please try again later.',
  de:      'Zu viele Versuche. Bitte versuchen Sie es später erneut.',
  es:      'Demasiados intentos. Inténtelo de nuevo más tarde.',
  fr:      'Trop de tentatives. Veuillez réessayer plus tard.',
  hu:      'Túl sok próbálkozás. Kérjük, próbálja újra később.',
  nl:      'Te veel pogingen. Probeer het later opnieuw.',
  br:      'Muitas tentativas. Tente novamente mais tarde.',
  cs:      'Příliš mnoho pokusů. Zkuste to prosím znovu.',
  pl:      'Zbyt wiele prób. Spróbuj ponownie później.',
  ru:      'Слишком много попыток. Попробуйте позже.',
  zh:      '尝试次数过多，请稍后再试。',
  'zh-TW': '嘗試次數過多，請稍後再試。',
  it:      'Troppi tentativi. Riprova più tardi.',
  tr:      'Çok fazla deneme. Lütfen daha sonra tekrar deneyin.',
  ar:      'محاولات كثيرة جدًا. يرجى المحاولة لاحقًا.',
  id:      'Terlalu banyak percobaan. Coba lagi nanti.',
  ja:      '試行回数が多すぎます。時間をおいて再度お試しください。',
  ko:      '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  uk:      'Занадто багато спроб. Спробуйте пізніше.',
  sv:      'För många försök. Prova igen senare.',
  ca:      'Massa intents. Torneu-ho a provar més tard.',
  gr:      'Πάρα πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.',
  vi:      'Quá nhiều lần thử. Vui lòng thử lại sau.',
}

function translateRateLimit(): string {
  const fallback = RATE_LIMIT_MESSAGES['en']!
  try {
    const lang = localStorage.getItem('app_language') || localStorage.getItem('app_language_server') || 'en'
    return RATE_LIMIT_MESSAGES[lang] ?? fallback
  } catch {
    return fallback
  }
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 8000,
  headers: {
    'Content-Type': 'application/json',
  },
})

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete'])

// Request interceptor - add socket ID + idempotency key for mutating requests
apiClient.interceptors.request.use(
    (config) => {
      const sid = getSocketId()
      if (sid) {
        config.headers['X-Socket-Id'] = sid
      }
      // Attach a per-request idempotency key to all write operations so the
      // server can deduplicate retried requests (e.g. network blips).
      // The mutation queue sets its own pre-generated key; skip if already set.
      const method = (config.method ?? '').toLowerCase()
      if (MUTATING_METHODS.has(method) && !config.headers['X-Idempotency-Key']) {
        config.headers['X-Idempotency-Key'] = randomId()
      }
      return config
    },
    (error) => Promise.reject(error)
)

export function isAuthPublicPath(pathname: string): boolean {
  const publicPaths = ['/login', '/register', '/forgot-password', '/reset-password']
  const publicPrefixes = ['/shared/', '/public/']
  return publicPaths.includes(pathname) || publicPrefixes.some((p) => pathname.startsWith(p))
}

// Unregisters the SW before reloading so the navigation reaches the network.
// Without this, WorkBox's NavigationRoute serves the cached SPA shell and the
// upstream proxy (CF Access / Pangolin) never gets to challenge the user.
async function unregisterSWAndReload(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) await reg.unregister()
  } catch { /* ignore */ }
  window.location.reload()
}

// Response interceptor - handle 401, 403 MFA, 429 rate limit, proxy auth challenges
apiClient.interceptors.response.use(
    (response) => {
      sessionStorage.removeItem('proxy_reauth_attempted')
      return response
    },
    async (error) => {
      // CF Access / Pangolin / similar: cross-origin redirect from /api/* surfaces
      // as a CORS error with no response object. Probe the health endpoint to
      // distinguish a proxy auth challenge from a genuine outage. If the server
      // is reachable, a top-level reload lets the edge proxy run its auth flow.
      if (!error.response && navigator.onLine) {
        // Only an actual edge-proxy auth wall warrants tearing down the SW to
        // reauth: a reachable proxy (CF Access / Pangolin) that intercepts /api
        // with a cross-origin redirect or an HTML login page. A genuine offline
        // boot ALSO lands here — navigator.onLine reflects a network interface,
        // not reachability, and is routinely true on mobile while offline. So
        // gate strictly on a positive proxy signal; on plain offline do nothing
        // and let the request reject so the cached shell + IndexedDB serve the
        // app. Unregistering the SW here reloaded into a dead network and broke
        // PWA offline mode (#1346).
        const state = await probeNow()
        if (state === 'proxy-wall') {
          const { pathname } = window.location
          if (!isAuthPublicPath(pathname) && !sessionStorage.getItem('proxy_reauth_attempted')) {
            sessionStorage.setItem('proxy_reauth_attempted', '1')
            await unregisterSWAndReload()
            return Promise.reject(error)
          }
        }
      }
      // Pangolin header-auth extended compatibility mode: returns 401 with an
      // HTML body (a JS redirect page) instead of a 302.
      //
      // A text/html 401 is NOT unambiguous on its own: several of TREK's own
      // routes answer with res.status(401).send('Authentication required'),
      // which Express labels text/html. Tearing the service worker down for one
      // of those would cost the user offline mode for a proxy wall that isn't
      // there, so confirm a reachable proxy first, exactly like the no-response
      // branch above (#2228).
      if (error.response?.status === 401) {
        const ct = (error.response.headers?.['content-type'] as string | undefined) ?? ''
        if (ct.includes('text/html')) {
          const { pathname } = window.location
          if (!isAuthPublicPath(pathname) && !sessionStorage.getItem('proxy_reauth_attempted')) {
            if (await probeNow() === 'proxy-wall') {
              sessionStorage.setItem('proxy_reauth_attempted', '1')
              await unregisterSWAndReload()
              return Promise.reject(error)
            }
          }
        }
      }
      if (error.response?.status === 401 && (error.response?.data as { code?: string } | undefined)?.code === 'AUTH_REQUIRED') {
        const { pathname } = window.location
        if (!isAuthPublicPath(pathname)) {
          const currentPath = pathname + window.location.search + window.location.hash
          window.location.href = '/login?redirect=' + encodeURIComponent(currentPath)
        }
      }
      if (
          error.response?.status === 403 &&
          (error.response?.data as { code?: string } | undefined)?.code === 'MFA_REQUIRED' &&
          !window.location.pathname.startsWith('/settings')
      ) {
        window.location.href = '/settings?mfa=required'
      }
      if (error.response?.status === 429) {
        const translated = translateRateLimit()
        const data = error.response.data
        // Only a plain object body carries an `error` field worth overwriting;
        // an array (a validation-error list) or a string is replaced outright.
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          (data as { error?: string }).error = translated
        } else {
          error.response.data = { error: translated }
        }
        error.message = translated
      }
      return Promise.reject(error)
    }
)

/**
 * POST a FormData body — the ONLY way this client should upload a file.
 *
 * The shared axios instance carries `timeout: 8000`, and axios' timeout is a whole-
 * request deadline rather than an idle one. A file upload that takes longer than 8s to
 * push its body — a phone photo on a slow uplink, a 500 MB document — is aborted
 * mid-stream, which the server reports as a multer "Request aborted" (#1495).
 *
 * Every upload therefore has to opt out with `timeout: 0`. That opt-out used to be
 * hand-written per call site, so it was forgotten on 7 of 15 — including the two 500 MB
 * endpoints (documents, backup restore). Centralizing makes the correct behavior the
 * default instead of something you have to remember.
 *
 * The Content-Type is set for clarity only: axios unsets it for FormData in the browser
 * so the platform can generate the multipart boundary.
 */
export interface UploadOptions {
  onUploadProgress?: (e: import('axios').AxiosProgressEvent) => void
  idempotencyKey?: string
  signal?: AbortSignal
}

export function postMultipart<T = any>(url: string, formData: FormData, opts?: UploadOptions): Promise<T> {
  return apiClient.post(url, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(opts?.idempotencyKey ? { 'X-Idempotency-Key': opts.idempotencyKey } : {}),
    },
    timeout: 0,
    onUploadProgress: opts?.onUploadProgress,
    signal: opts?.signal,
  }).then(r => r.data as T)
}

export const authApi = {
  register: (data: RegisterRequest) => apiClient.post('/auth/register', data).then(r => r.data),
  validateInvite: (token: string) => apiClient.get(`/auth/invite/${token}`).then(r => r.data),
  login: (data: LoginRequest) => apiClient.post('/auth/login', data).then(r => r.data),
  verifyMfaLogin: (data: MfaVerifyLoginRequest) => apiClient.post('/auth/mfa/verify-login', data).then(r => r.data),
  mfaSetup: () => apiClient.post('/auth/mfa/setup', {}).then(r => r.data),
  mfaEnable: (data: MfaEnableRequest) => apiClient.post('/auth/mfa/enable', data).then(r => r.data as { success: boolean; mfa_enabled: boolean; backup_codes?: string[] }),
  mfaDisable: (data: { password: string; code: string }) => apiClient.post('/auth/mfa/disable', data).then(r => r.data),
  me: () => apiClient.get('/auth/me').then(r => r.data),
  updateMapsKey: (key: string | null) => apiClient.put('/auth/me/maps-key', { maps_api_key: key }).then(r => r.data),
  updateApiKeys: (data: Record<string, string | null>) => apiClient.put('/auth/me/api-keys', data).then(r => r.data),
  updateSettings: (data: Record<string, unknown>) => apiClient.put('/auth/me/settings', data).then(r => r.data),
  getSettings: () => apiClient.get('/auth/me/settings').then(r => r.data),
  listUsers: () => apiClient.get('/auth/users').then(r => r.data),
  uploadAvatar: (formData: FormData) => postMultipart('/auth/avatar', formData),
  deleteAvatar: () => apiClient.delete('/auth/avatar').then(r => r.data),
  getAppConfig: () => apiClient.get('/auth/app-config').then(r => r.data),
  updateAppSettings: (data: Record<string, unknown>) => apiClient.put('/auth/app-settings', data).then(r => r.data),
  validateKeys: () => apiClient.get('/auth/validate-keys').then(r => r.data),
  travelStats: () => apiClient.get('/auth/travel-stats').then(r => r.data),
  changePassword: (data: ChangePasswordRequest) => apiClient.put('/auth/me/password', data).then(r => r.data),
  forgotPassword: (data: ForgotPasswordRequest) => apiClient.post('/auth/forgot-password', data).then(r => r.data as { ok: true }),
  resetPassword: (data: ResetPasswordRequest) => apiClient.post('/auth/reset-password', data).then(r => r.data as { success?: true; mfa_required?: true }),
  deleteOwnAccount: () => apiClient.delete('/auth/me').then(r => r.data),
  demoLogin: () => apiClient.post('/auth/demo-login').then(r => r.data),
  mcpTokens: {
    list: () => apiClient.get('/auth/mcp-tokens').then(r => r.data),
    create: (name: string) => apiClient.post('/auth/mcp-tokens', { name } satisfies McpTokenCreateRequest).then(r => r.data),
    delete: (id: number) => apiClient.delete(`/auth/mcp-tokens/${id}`).then(r => r.data),
  },
  // Keys for the public API. Same shape as the MCP tokens above and a separate
  // credential: one drives the assistant tools, the other reads trips over HTTP,
  // and a key of the wrong kind is refused like one that does not exist.
  apiKeys: {
    list: () => apiClient.get('/auth/api-tokens').then(r => r.data),
    create: (name: string) => apiClient.post('/auth/api-tokens', { name } satisfies McpTokenCreateRequest).then(r => r.data),
    delete: (id: number) => apiClient.delete(`/auth/api-tokens/${id}`).then(r => r.data),
  },
  passkey: {
    registerOptions: (password: string) => apiClient.post('/auth/passkey/register/options', { password }).then(r => r.data),
    registerVerify: (attestationResponse: unknown, name?: string) => apiClient.post('/auth/passkey/register/verify', { attestationResponse, name }).then(r => r.data),
    loginOptions: () => apiClient.post('/auth/passkey/login/options', {}).then(r => r.data),
    loginVerify: (assertionResponse: unknown) => apiClient.post('/auth/passkey/login/verify', { assertionResponse }).then(r => r.data as { token: string; user: Record<string, unknown> }),
    list: () => apiClient.get('/auth/passkey/credentials').then(r => r.data as { credentials: PasskeyCredential[] }),
    rename: (id: number, name: string) => apiClient.patch(`/auth/passkey/credentials/${id}`, { name }).then(r => r.data),
    delete: (id: number, password: string) => apiClient.delete(`/auth/passkey/credentials/${id}`, { data: { password } }).then(r => r.data),
  },
}

export interface PasskeyCredential {
  id: number
  name: string | null
  device_type: string | null
  backed_up: boolean
  created_at: string
  last_used_at: string | null
}

export const oauthApi = {
  /** Validate OAuth authorize params — called by consent page on load */
  validate: (params: {
    response_type: string
    client_id: string
    redirect_uri: string
    scope: string
    state?: string
    code_challenge: string
    code_challenge_method: string
    resource?: string
  }) => apiClient.get('/oauth/authorize/validate', { params }).then(r => r.data),

  /** Submit user consent (approve or deny) */
  authorize: (body: {
    client_id: string
    redirect_uri: string
    scope: string
    state?: string
    code_challenge: string
    code_challenge_method: string
    approved: boolean
    resource?: string
  }) => apiClient.post('/oauth/authorize', body).then(r => r.data),

  clients: {
    list: () => apiClient.get('/oauth/clients').then(r => r.data),
    create: (data: { name: string; redirect_uris?: string[]; allowed_scopes: string[]; allows_client_credentials?: boolean }) =>
        apiClient.post('/oauth/clients', data).then(r => r.data),
    rotate: (id: string) => apiClient.post(`/oauth/clients/${id}/rotate`).then(r => r.data),
    delete: (id: string) => apiClient.delete(`/oauth/clients/${id}`).then(r => r.data),
  },

  sessions: {
    list: () => apiClient.get('/oauth/sessions').then(r => r.data),
    revoke: (id: number) => apiClient.delete(`/oauth/sessions/${id}`).then(r => r.data),
  },
}

export const tripsApi = {
  list: (params?: Record<string, unknown>) => apiClient.get('/trips', { params }).then(r => r.data),
  create: (data: TripCreateRequest) => apiClient.post('/trips', data).then(r => r.data),
  get: (id: number | string) => apiClient.get(`/trips/${id}`).then(r => r.data),
  // The startup redirect's one lookup — deliberately not list(), which would pull
  // every trip with its counts just to read one id.
  active: (): Promise<ActiveTripResponse> => apiClient.get('/trips/active').then(r => r.data),
  update: (id: number | string, data: TripUpdateRequest) => apiClient.put(`/trips/${id}`, data).then(r => r.data),
  delete: (id: number | string) => apiClient.delete(`/trips/${id}`).then(r => r.data),
  uploadCover: (id: number | string, formData: FormData) => postMultipart(`/trips/${id}/cover`, formData),
  searchCoverImages: (query: string) => apiClient.get('/trips/cover-images/search', { params: { query } }).then(r => r.data),
  archive: (id: number | string) => apiClient.put(`/trips/${id}`, { is_archived: true }).then(r => r.data),
  unarchive: (id: number | string) => apiClient.put(`/trips/${id}`, { is_archived: false }).then(r => r.data),
  getMembers: (id: number | string) => apiClient.get(`/trips/${id}/members`).then(r => r.data),
  addMember: (id: number | string, identifier: string) => apiClient.post(`/trips/${id}/members`, { identifier } satisfies TripAddMemberRequest).then(r => r.data),
  removeMember: (id: number | string, userId: number) => apiClient.delete(`/trips/${id}/members/${userId}`).then(r => r.data),
  transferOwnership: (id: number | string, newOwnerId: number) => apiClient.post(`/trips/${id}/transfer`, { newOwnerId } satisfies TripTransferOwnershipRequest).then(r => r.data),
  createGuest: (id: number | string, name: string) => apiClient.post(`/trips/${id}/guests`, { name } satisfies TripCreateGuestRequest).then(r => r.data),
  renameGuest: (id: number | string, userId: number, name: string) => apiClient.put(`/trips/${id}/guests/${userId}`, { name } satisfies TripRenameGuestRequest).then(r => r.data),
  deleteGuest: (id: number | string, userId: number) => apiClient.delete(`/trips/${id}/guests/${userId}`).then(r => r.data),
  copy: (id: number | string, data?: TripCopyRequest) => apiClient.post(`/trips/${id}/copy`, data || {}).then(r => r.data),
  bundle: (id: number | string) => apiClient.get(`/trips/${id}/bundle`).then(r => r.data),
}

export const daysApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/days`).then(r => r.data),
  create: (tripId: number | string, data: DayCreateRequest) => apiClient.post(`/trips/${tripId}/days`, data).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, data: DayUpdateRequest) => apiClient.put(`/trips/${tripId}/days/${dayId}`, data).then(r => r.data),
  // Whole-day default route mode (#1281); per-segment leg modes override it.
  updateTransport: (tripId: number | string, dayId: number | string, mode: string | null) => apiClient.put(`/trips/${tripId}/days/${dayId}/transport`, { transport_mode: mode }).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string) => apiClient.delete(`/trips/${tripId}/days/${dayId}`).then(r => r.data),
  reorder: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/days/reorder`, { orderedIds } satisfies DayReorderRequest).then(r => r.data),
}

export const placesApi = {
  list: (tripId: number | string, params?: Record<string, unknown>) => apiClient.get(`/trips/${tripId}/places`, { params }).then(r => r.data),
  // Typed: an untyped `r.data` is what let `{ place }` be read as a bare place,
  // so every hotel booking minted an unlinked duplicate (#2243).
  create: (tripId: number | string, data: PlaceCreateRequest): Promise<{ place: Place }> =>
    apiClient.post(`/trips/${tripId}/places`, data).then(r => r.data),
  get: (tripId: number | string, id: number | string) => apiClient.get(`/trips/${tripId}/places/${id}`).then(r => r.data),
  update: (tripId: number | string, id: number | string, data: PlaceUpdateRequest) => apiClient.put(`/trips/${tripId}/places/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number | string) => apiClient.delete(`/trips/${tripId}/places/${id}`).then(r => r.data),
  searchImage: (tripId: number | string, id: number | string) => apiClient.get(`/trips/${tripId}/places/${id}/image`).then(r => r.data),
  uploadImage: (tripId: number | string, id: number | string, file: File) => {
    const fd = new FormData()
    fd.append('image', file)
    return postMultipart<{ place: Place }>(`/trips/${tripId}/places/${id}/image`, fd)
  },
  rate: (tripId: number | string, id: number | string, rating: number | null): Promise<{ place: Place }> =>
    rating === null
      ? apiClient.delete(`/trips/${tripId}/places/${id}/rating`).then(r => r.data)
      : apiClient.put(`/trips/${tripId}/places/${id}/rating`, { rating }).then(r => r.data),
  importGpx: (tripId: number | string, file: File, opts?: { waypoints?: boolean; routes?: boolean; tracks?: boolean }) => {
    const fd = new FormData()
    fd.append('file', file)
    if (opts?.waypoints !== undefined) fd.append('importWaypoints', String(opts.waypoints))
    if (opts?.routes !== undefined) fd.append('importRoutes', String(opts.routes))
    if (opts?.tracks !== undefined) fd.append('importTracks', String(opts.tracks))
    return postMultipart(`/trips/${tripId}/places/import/gpx`, fd)
  },
  importMapFile: (tripId: number | string, file: File, opts?: { points?: boolean; paths?: boolean }) => {
    const fd = new FormData()
    fd.append('file', file)
    if (opts?.points !== undefined) fd.append('importPoints', String(opts.points))
    if (opts?.paths !== undefined) fd.append('importPaths', String(opts.paths))
    return postMultipart(`/trips/${tripId}/places/import/map`, fd)
  },
  importGoogleList: (tripId: number | string, url: string, enrich?: boolean) =>
      apiClient.post(`/trips/${tripId}/places/import/google-list`, { url, enrich } satisfies PlaceImportListRequest).then(r => r.data),
  importNaverList: (tripId: number | string, url: string, enrich?: boolean) =>
      apiClient.post(`/trips/${tripId}/places/import/naver-list`, { url, enrich } satisfies PlaceImportListRequest).then(r => r.data),
  bulkDelete: (tripId: number | string, ids: number[]) =>
      apiClient.post(`/trips/${tripId}/places/bulk-delete`, { ids } satisfies PlaceBulkDeleteRequest).then(r => r.data),
  bulkUpdate: (tripId: number | string, ids: number[], data: Omit<PlaceBulkUpdateRequest, 'ids'>) =>
      apiClient.post(`/trips/${tripId}/places/bulk-update`, { ids, ...data } satisfies PlaceBulkUpdateRequest).then(r => r.data),
}

export const assignmentsApi = {
  list: (tripId: number | string, dayId: number | string) => apiClient.get(`/trips/${tripId}/days/${dayId}/assignments`).then(r => r.data),
  create: (tripId: number | string, dayId: number | string, data: AssignmentCreateRequest) => apiClient.post(`/trips/${tripId}/days/${dayId}/assignments`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/days/${dayId}/assignments/${id}`).then(r => r.data),
  reorder: (tripId: number | string, dayId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/days/${dayId}/assignments/reorder`, { orderedIds } satisfies AssignmentReorderRequest).then(r => r.data),
  move: (tripId: number | string, assignmentId: number, newDayId: number | string, orderIndex: number | null) => apiClient.put(`/trips/${tripId}/assignments/${assignmentId}/move`, { new_day_id: newDayId, order_index: orderIndex }).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/days/${dayId}/assignments/${id}`, data).then(r => r.data),
  getParticipants: (tripId: number | string, id: number) => apiClient.get(`/trips/${tripId}/assignments/${id}/participants`).then(r => r.data),
  setParticipants: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/assignments/${id}/participants`, { user_ids: userIds } satisfies AssignmentParticipantsRequest).then(r => r.data),
  updateTime: (tripId: number | string, id: number, times: AssignmentTimeRequest) => apiClient.put(`/trips/${tripId}/assignments/${id}/time`, times).then(r => r.data),
  // Day-specific note on an assignment (#2163) — null clears it.
  updateNotes: (tripId: number | string, id: number, data: AssignmentNotesRequest) => apiClient.put(`/trips/${tripId}/assignments/${id}/notes`, data).then(r => r.data),
  // Per-segment travel mode (#1281): mode of the leg leaving this stop (null = inherit day default).
  // direction defaults to 'outgoing' server-side, so only send it for the incoming (boundary-leg) case
  // and keep the outgoing payload byte-for-byte identical to the pre-#1281 shape.
  updateTransport: (tripId: number | string, id: number, mode: string | null, direction: 'outgoing' | 'incoming' = 'outgoing') => apiClient.put(`/trips/${tripId}/assignments/${id}/transport`, (direction === 'incoming' ? { transport_mode: mode, direction } : { transport_mode: mode }) satisfies Partial<AssignmentTransportRequest>).then(r => r.data),
}

export const packingApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing`).then(r => r.data),
  create: (tripId: number | string, data: PackingCreateItemRequest) => apiClient.post(`/trips/${tripId}/packing`, data).then(r => r.data),
  bulkImport: (tripId: number | string, items: { name: string; category?: string; quantity?: number }[]) => apiClient.post(`/trips/${tripId}/packing/import`, { items } satisfies PackingImportRequest).then(r => r.data),
  update: (tripId: number | string, id: number, data: PackingUpdateItemRequest) => apiClient.put(`/trips/${tripId}/packing/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/packing/${id}`).then(r => r.data),
  reorder: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/packing/reorder`, { orderedIds } satisfies PackingReorderRequest).then(r => r.data),
  setSharing: (tripId: number | string, id: number, data: PackingSetSharingRequest) => apiClient.put(`/trips/${tripId}/packing/${id}/sharing`, data).then(r => r.data),
  clone: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/packing/${id}/clone`).then(r => r.data),
  addContributor: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/packing/${id}/contributors`).then(r => r.data),
  removeContributor: (tripId: number | string, id: number, userId: number) => apiClient.delete(`/trips/${tripId}/packing/${id}/contributors/${userId}`).then(r => r.data),
  getCategoryAssignees: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/category-assignees`).then(r => r.data),
  setCategoryAssignees: (tripId: number | string, categoryName: string, userIds: number[]) => apiClient.put(`/trips/${tripId}/packing/category-assignees/${encodeURIComponent(categoryName)}`, { user_ids: userIds } satisfies PackingCategoryAssigneesRequest).then(r => r.data),
  listTemplates: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/templates`).then(r => r.data),
  applyTemplate: (tripId: number | string, templateId: number, visibility: 'common' | 'personal' = 'common') => apiClient.post(`/trips/${tripId}/packing/apply-template/${templateId}`, { visibility } satisfies PackingApplyTemplateRequest).then(r => r.data),
  saveAsTemplate: (tripId: number | string, name: string) => apiClient.post(`/trips/${tripId}/packing/save-as-template`, { name }).then(r => r.data),
  setBagMembers: (tripId: number | string, bagId: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/packing/bags/${bagId}/members`, { user_ids: userIds } satisfies PackingBagMembersRequest).then(r => r.data),
  listBags: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/bags`).then(r => r.data),
  createBag: (tripId: number | string, data: PackingCreateBagRequest) => apiClient.post(`/trips/${tripId}/packing/bags`, data).then(r => r.data),
  updateBag: (tripId: number | string, bagId: number, data: PackingUpdateBagRequest) => apiClient.put(`/trips/${tripId}/packing/bags/${bagId}`, data).then(r => r.data),
  deleteBag: (tripId: number | string, bagId: number) => apiClient.delete(`/trips/${tripId}/packing/bags/${bagId}`).then(r => r.data),
}

export const todoApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/todo`).then(r => r.data),
  create: (tripId: number | string, data: TodoCreateItemRequest) => apiClient.post(`/trips/${tripId}/todo`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: TodoUpdateItemRequest) => apiClient.put(`/trips/${tripId}/todo/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/todo/${id}`).then(r => r.data),
  reorder: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/todo/reorder`, { orderedIds } satisfies TodoReorderRequest).then(r => r.data),
  getCategoryAssignees: (tripId: number | string) => apiClient.get(`/trips/${tripId}/todo/category-assignees`).then(r => r.data),
  setCategoryAssignees: (tripId: number | string, categoryName: string, userIds: number[]) => apiClient.put(`/trips/${tripId}/todo/category-assignees/${encodeURIComponent(categoryName)}`, { user_ids: userIds } satisfies TodoCategoryAssigneesRequest).then(r => r.data),
}

export const tagsApi = {
  list: () => apiClient.get('/tags').then(r => r.data),
  create: (data: CreateTagRequest) => apiClient.post('/tags', data).then(r => r.data),
  update: (id: number, data: UpdateTagRequest) => apiClient.put(`/tags/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/tags/${id}`).then(r => r.data),
}

export const categoriesApi = {
  list: () => apiClient.get('/categories').then(r => r.data),
  create: (data: CreateCategoryRequest) => apiClient.post('/categories', data).then(r => r.data),
  update: (id: number, data: UpdateCategoryRequest) => apiClient.put(`/categories/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/categories/${id}`).then(r => r.data),
}

export const adminApi = {
  users: () => apiClient.get('/admin/users').then(r => r.data),
  createUser: (data: Record<string, unknown>) => apiClient.post('/admin/users', data).then(r => r.data),
  updateUser: (id: number, data: Record<string, unknown>) => apiClient.put(`/admin/users/${id}`, data).then(r => r.data),
  deleteUser: (id: number) => apiClient.delete(`/admin/users/${id}`).then(r => r.data),
  resetUserPasskeys: (id: number) => apiClient.delete(`/admin/users/${id}/passkeys`).then(r => r.data),
  stats: () => apiClient.get('/admin/stats').then(r => r.data),
  saveDemoBaseline: () => apiClient.post('/admin/save-demo-baseline').then(r => r.data),
  getOidc: () => apiClient.get('/admin/oidc').then(r => r.data),
  updateOidc: (data: Record<string, unknown>) => apiClient.put('/admin/oidc', data).then(r => r.data),
  addons: () => apiClient.get('/admin/addons').then(r => r.data),
  updateAddon: (id: number | string, data: Record<string, unknown>) => apiClient.put(`/admin/addons/${id}`, data).then(r => r.data),
  plugins: () => apiClient.get('/admin/plugins').then(r => r.data),
  pluginBrowse: (refresh?: boolean) => apiClient.get('/admin/plugins/registry', { params: refresh ? { refresh: 1 } : undefined }).then(r => r.data),
  pluginDetail: (id: string) => apiClient.get(`/admin/plugins/registry/${encodeURIComponent(id)}`).then(r => r.data),
  pluginInstall: (id: string, opts?: Pick<PluginInstallRequest, 'version' | 'constraint' | 'withDependencies'>) =>
    apiClient.post('/admin/plugins/install', { id, ...opts } satisfies PluginInstallRequest).then(r => r.data),
  pluginActivate: (id: string, consent?: boolean) => apiClient.post(`/admin/plugins/${id}/activate`, consent ? { consent: true } : {}).then(r => r.data),
  pluginDeactivate: (id: string) => apiClient.post(`/admin/plugins/${id}/deactivate`).then(r => r.data),
  // `version` pins the exact version to install (the rollback path); omitted, the server
  // resolves the newest TREK-compatible version itself.
  pluginUpdate: (id: string, version?: string) =>
    apiClient.post(`/admin/plugins/${id}/update`, version ? { version } : {}).then(r => r.data),
  // Release a per-plugin update hold (set by a deliberate non-latest install).
  pluginResumeUpdates: (id: string) => apiClient.post(`/admin/plugins/${id}/resume-updates`).then(r => r.data),
  // Re-trust a ROTATED author signing key and update, in ONE call. `publicKey` is the
  // full key the admin was shown (not a fingerprint): the server compares it exactly, so
  // it can refuse if the registry entry was re-keyed again since the dialog rendered.
  pluginRetrust: (id: string, version: string, publicKey: string) =>
    apiClient.post(`/admin/plugins/${id}/retrust`, { version, publicKey }).then(r => r.data),
  pluginUninstall: (id: string, deleteData: boolean) => apiClient.post(`/admin/plugins/${id}/uninstall`, { deleteData }).then(r => r.data),
  pluginRescan: () => apiClient.post('/admin/plugins/rescan').then(r => r.data),
  pluginUpload: (file: File) => { const fd = new FormData(); fd.append('file', file); return postMultipart('/admin/plugins/upload', fd) },
  // Dev-link (dev-only): register a plugin from a local built dir + hot-reload it.
  pluginLink: (path: string) => apiClient.post('/admin/plugins/link', { path }).then(r => r.data),
  pluginReload: (id: string) => apiClient.post(`/admin/plugins/${id}/reload`).then(r => r.data),
  // The admin-owned `scope:'instance'` settings: the declared fields plus the stored
  // values (secrets masked). Saving may RESTART a running plugin — the child gets its
  // config once at init — and `restarted` reports whether that happened.
  pluginConfig: (id: string): Promise<PluginInstanceConfigResponse> =>
    apiClient.get(`/admin/plugins/${id}/config`).then(r => r.data),
  pluginSaveConfig: (id: string, config: Record<string, unknown>): Promise<PluginInstanceConfigUpdated> =>
    apiClient.put(`/admin/plugins/${id}/config`, config).then(r => r.data),
  // Run a `scope:'instance'` action the plugin declared ("Purge cache"). Runs AS the
  // clicking admin. 404 when the plugin is inactive (no child process to run it).
  runPluginAction: (id: string, key: string): Promise<PluginActionResult> =>
    apiClient.post(`/admin/plugins/${id}/actions/${encodeURIComponent(key)}`).then(r => r.data),
  // Operator-supplied egress hosts: a plugin talking to a SELF-HOSTED service can't name
  // the operator's hostname in its manifest, so the admin adds it here. Saving re-spawns
  // the plugin with the widened allow-list.
  pluginEgressHosts: (id: string): Promise<{ supported: boolean; hosts: string[] }> =>
    apiClient.get(`/admin/plugins/${id}/egress-hosts`).then(r => r.data),
  pluginSetEgressHosts: (id: string, hosts: string[]): Promise<{ hosts: string[] }> =>
    apiClient.put(`/admin/plugins/${id}/egress-hosts`, { hosts }).then(r => r.data),
  pluginErrors: (id: string) => apiClient.get(`/admin/plugins/${id}/errors`).then(r => r.data),
  pluginAudit: (id: string) => apiClient.get(`/admin/plugins/${id}/audit`).then(r => r.data),
  // Local LLM (Ollama) management for the AI-parsing addon.
  llmLocalModels: (baseUrl: string): Promise<{ models: { name: string; size: number }[] }> =>
    apiClient.get('/admin/llm/local/models', { params: { baseUrl } }).then(r => r.data),
  /** Pull a model, streaming Ollama's NDJSON progress to `onProgress`. */
  llmLocalPull: async (
    baseUrl: string,
    model: string,
    onProgress: (p: { status?: string; total?: number; completed?: number; error?: string }) => void,
  ): Promise<void> => {
    const res = await fetch('/api/admin/llm/local/pull', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl, model }),
    })
    if (!res.ok) {
      let msg = `Pull failed (${res.status})`
      try { msg = (await res.json())?.error ?? msg } catch { /* non-json */ }
      throw new Error(msg)
    }
    // An accepted request without a stream can't be followed to completion.
    if (!res.body) throw new Error('Pull returned no progress stream')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        // split() always yields at least one element; the last one is the
        // trailing (possibly partial) line carried into the next chunk.
        const lines = buf.split('\n')
        buf = lines.pop()!
        for (const line of lines) {
          if (!line.trim()) continue
          // Only the parse is swallowed — a throw from onProgress aborts the pull.
          let frame: { status?: string; total?: number; completed?: number; error?: string }
          try { frame = JSON.parse(line) } catch { continue }
          onProgress(frame)
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  },
  checkVersion: () => apiClient.get('/admin/version-check').then(r => r.data),
  getBagTracking: () => apiClient.get('/admin/bag-tracking').then(r => r.data),
  updateBagTracking: (enabled: boolean) => apiClient.put('/admin/bag-tracking', { enabled }).then(r => r.data),
  getPlacesPhotos: () => apiClient.get('/admin/places-photos').then(r => r.data),
  updatePlacesPhotos: (enabled: boolean) => apiClient.put('/admin/places-photos', { enabled }).then(r => r.data),
  getPlaceShadow: () => apiClient.get('/admin/place-shadow').then(r => r.data),
  updatePlaceShadow: (enabled: boolean) => apiClient.put('/admin/place-shadow', { enabled }).then(r => r.data),
  getPlacesAutocomplete: () => apiClient.get('/admin/places-autocomplete').then(r => r.data),
  updatePlacesAutocomplete: (enabled: boolean) => apiClient.put('/admin/places-autocomplete', { enabled }).then(r => r.data),
  getPlacesDetails: () => apiClient.get('/admin/places-details').then(r => r.data),
  updatePlacesDetails: (enabled: boolean) => apiClient.put('/admin/places-details', { enabled }).then(r => r.data),
  getPlacesEnrich: () => apiClient.get('/admin/places-enrich').then(r => r.data),
  updatePlacesEnrich: (enabled: boolean) => apiClient.put('/admin/places-enrich', { enabled }).then(r => r.data),
  getCollabFeatures: () => apiClient.get('/admin/collab-features').then(r => r.data),
  updateCollabFeatures: (features: Record<string, boolean>) => apiClient.put('/admin/collab-features', features).then(r => r.data),
  packingTemplates: () => apiClient.get('/admin/packing-templates').then(r => r.data),
  getPackingTemplate: (id: number) => apiClient.get(`/admin/packing-templates/${id}`).then(r => r.data),
  createPackingTemplate: (data: { name: string }) => apiClient.post('/admin/packing-templates', data).then(r => r.data),
  updatePackingTemplate: (id: number, data: { name: string }) => apiClient.put(`/admin/packing-templates/${id}`, data).then(r => r.data),
  deletePackingTemplate: (id: number) => apiClient.delete(`/admin/packing-templates/${id}`).then(r => r.data),
  addTemplateCategory: (templateId: number, data: { name: string }) => apiClient.post(`/admin/packing-templates/${templateId}/categories`, data).then(r => r.data),
  updateTemplateCategory: (templateId: number, catId: number, data: { name: string }) => apiClient.put(`/admin/packing-templates/${templateId}/categories/${catId}`, data).then(r => r.data),
  deleteTemplateCategory: (templateId: number, catId: number) => apiClient.delete(`/admin/packing-templates/${templateId}/categories/${catId}`).then(r => r.data),
  addTemplateItem: (templateId: number, catId: number, data: { name: string }) => apiClient.post(`/admin/packing-templates/${templateId}/categories/${catId}/items`, data).then(r => r.data),
  updateTemplateItem: (templateId: number, itemId: number, data: { name: string }) => apiClient.put(`/admin/packing-templates/${templateId}/items/${itemId}`, data).then(r => r.data),
  deleteTemplateItem: (templateId: number, itemId: number) => apiClient.delete(`/admin/packing-templates/${templateId}/items/${itemId}`).then(r => r.data),
  listInvites: () => apiClient.get('/admin/invites').then(r => r.data),
  listInviteTrips: () => apiClient.get('/admin/invites/trips').then(r => r.data),
  createInvite: (data: { max_uses: number; expires_in_days?: number; trip_id?: number | null }) => apiClient.post('/admin/invites', data).then(r => r.data),
  deleteInvite: (id: number) => apiClient.delete(`/admin/invites/${id}`).then(r => r.data),
  auditLog: (params?: { limit?: number; offset?: number }) =>
      apiClient.get('/admin/audit-log', { params }).then(r => r.data),
  mcpTokens: () => apiClient.get('/admin/mcp-tokens').then(r => r.data),
  deleteMcpToken: (id: number) => apiClient.delete(`/admin/mcp-tokens/${id}`).then(r => r.data),
  oauthSessions: () => apiClient.get('/admin/oauth-sessions').then(r => r.data),
  revokeOAuthSession: (id: number) => apiClient.delete(`/admin/oauth-sessions/${id}`).then(r => r.data),
  getPermissions: () => apiClient.get('/admin/permissions').then(r => r.data),
  updatePermissions: (permissions: Record<string, string>) => apiClient.put('/admin/permissions', { permissions }).then(r => r.data),
  rotateJwtSecret: () => apiClient.post('/admin/rotate-jwt-secret').then(r => r.data),
  sendTestNotification: (data: Record<string, unknown>) =>
      apiClient.post('/admin/dev/test-notification', data).then(r => r.data),
  getNotificationPreferences: () => apiClient.get('/admin/notification-preferences').then(r => r.data),
  updateNotificationPreferences: (prefs: Record<string, Record<string, boolean>>) => apiClient.put('/admin/notification-preferences', prefs).then(r => r.data),
  getDefaultUserSettings: () => apiClient.get('/admin/default-user-settings').then(r => r.data),
  updateDefaultUserSettings: (settings: Record<string, unknown>) => apiClient.put('/admin/default-user-settings', settings).then(r => r.data),
  getStorage: (): Promise<StorageAdminState> => apiClient.get('/admin/storage').then(r => r.data),
  updateStorage: (config: StorageConfigPut): Promise<StorageAdminState> =>
    apiClient.put('/admin/storage', config).then(r => r.data),
  // A probe is bounded by the target driver's own timeout (default 30s, ×2 with
  // one retry) and a mirror probes its targets sequentially — the instance-wide
  // 8s axios timeout would abort a legitimate slow probe, so this call carries
  // its own generous ceiling.
  testStorageBackend: (backend: StorageBackend): Promise<StorageTestResponse> =>
    apiClient.post('/admin/storage/test', { backend }, { timeout: 120_000 }).then(r => r.data),
  startStorageBackfill: (backend: string): Promise<{ started: true }> =>
    apiClient.post(`/admin/storage/backends/${encodeURIComponent(backend)}/backfill`).then(r => r.data),
  cancelStorageBackfill: (backend: string): Promise<{ cancelled: true }> =>
    apiClient.delete(`/admin/storage/backends/${encodeURIComponent(backend)}/backfill`).then(r => r.data),
  startStorageMigration: (category: string, to: string): Promise<{ started: true }> =>
    apiClient.post('/admin/storage/migrations', { category, to }).then(r => r.data),
  cancelStorageMigration: (category: string): Promise<{ cancelled: true }> =>
    apiClient.delete(`/admin/storage/migrations/${encodeURIComponent(category)}`).then(r => r.data),
  // A full scan of a large install can exceed the 8s instance timeout.
  refreshStorageStats: (): Promise<StorageUsage> =>
    apiClient.post('/admin/storage/stats/refresh', undefined, { timeout: 120_000 }).then(r => r.data),
}

export const addonsApi = {
  enabled: () => apiClient.get('/addons').then(r => r.data),
}

/** A host-rendered column/action a plugin contributes into a native planner view
 * (reservations/places/day) via the tableContributor hook. Every field is bounded +
 * normalized server-side; a column url is guaranteed http/https/mailto. */
export type ViewContribution =
  | { kind: 'column'; pluginId: string; entityId: number; id: string; label: string; value?: string; url?: string; icon?: string; tone: 'default' | 'success' | 'warn' | 'danger' }
  | { kind: 'action'; pluginId: string; entityId: number; id: string; label: string; icon?: string; target: { kind: 'frame'; sub: string } | { kind: 'route'; method: 'GET' | 'POST'; sub: string } }

/** A badge a plugin adds to a dashboard trip card via the tripCardProvider hook.
 * Bounded + normalized server-side; the url is guaranteed http/https/mailto. */
export interface TripCardBadge {
  pluginId: string; tripId: number; id: string; label: string;
  value?: string; icon?: string; tone: 'default' | 'success' | 'warn' | 'danger'; url?: string;
}

export interface PluginMapMarker {
  pluginId: string; id: string; lat: number; lng: number;
  label?: string; popupText?: string; url?: string; icon?: string;
  tone: 'default' | 'success' | 'warn' | 'danger'
}

/** One shape of a plugin map layer (mapLayerProvider hook). Server-normalized:
 * coordinates range-checked, vertex budget capped, styling clamped to the tone
 * palette + bounded numerics — never free-form CSS or markup. */
export interface PluginMapLayerFeature {
  type: 'polyline' | 'polygon' | 'circle';
  points?: Array<[number, number]>;
  center?: [number, number];
  radiusM?: number;
  tone: 'default' | 'success' | 'warn' | 'danger';
  width: number;
  dash: 'solid' | 'dash' | 'dot';
  opacity: number;
  fill: boolean;
  label?: string;
}

/** A vector overlay a plugin draws on the trip map (routes, corridors, zones). */
export interface PluginMapLayer {
  pluginId: string; id: string; name?: string;
  features: PluginMapLayerFeature[];
}

/** A time contribution a dayScheduleProvider plugin attaches to the day plan
 * ("35 min charging at this stop"). Server-normalized: dayIds checked against
 * the trip, minutes clamped to a day, labels sanitized + capped. */
export interface PluginDayScheduleItem {
  pluginId: string; id: string; dayId: number;
  assignmentId?: number; reservationId?: number;
  position?: 'start' | 'end';
  minutes?: number; label: string;
  tone: 'default' | 'success' | 'warn' | 'danger';
}

/** The colours a dayTintProvider plugin puts into one day card, so leg membership is
 * visible while scrolling the itinerary. The card has three separately tintable
 * regions; an absent one is not tinted and renders exactly as it does with no plugin.
 * Server-normalized: dayIds checked against the trip, one contribution per day (first
 * granted provider wins), the `tone` / `color` shorthands already resolved into the
 * regions, labels sanitized + capped.
 *
 * A region carries EITHER a tone from the fixed palette or the plugin's own colour,
 * never both — the server picked the winner. `*Color` is guaranteed `#rrggbb` (nothing
 * else survives normalization, because it lands inside a CSS value); the client still
 * owns how strongly it renders — alpha per theme and per region, lightness clamped
 * into a readable band. */
export type PluginDayTintTone = 'default' | 'success' | 'warn' | 'danger'
export interface PluginDayTint {
  pluginId: string; dayId: number;
  badgeTone?: PluginDayTintTone;
  badgeColor?: string;
  headerTone?: PluginDayTintTone;
  headerColor?: string;
  activityTone?: PluginDayTintTone;
  activityColor?: string;
  label?: string;
}

/** A route computed by a routeProvider plugin (server-normalized: coordinates
 * range-checked, legs forced to waypoints-1, vias capped). null = provider failed
 * or refused — the caller falls back to straight lines like on an OSRM outage. */
export interface PluginRouteResult {
  pluginId: string; profile: string;
  coordinates: Array<[number, number]>;
  distance: number; duration: number;
  legs: Array<{ distance: number; duration: number; note?: string }>;
  viaPoints: Array<{ lat: number; lng: number; label?: string; tone: 'default' | 'success' | 'warn' | 'danger'; dwellSeconds?: number }>;
}

/** A text-only section a pdfSectionProvider plugin appends to the trip PDF export.
 * Server-normalized: counts + lengths are capped, cells are plain strings. */
export interface PluginPdfSection {
  pluginId: string; title: string; paragraphs: string[];
  table?: { headers: string[]; rows: string[][] }
}

/** A country tint layer an atlasLayerProvider plugin draws over the Atlas map for
 * the signed-in user. Codes are ISO alpha-2 (server-validated), tone enum-whitelisted. */
export interface PluginAtlasLayer {
  pluginId: string; id: string; name?: string;
  countries: Array<{ code: string; tone: 'default' | 'success' | 'warn' | 'danger'; label?: string }>
}

/** The settings-field descriptor is the SHARED contract (both scopes emit the same
 * shape) — aliased so existing per-user settings consumers keep their import path. */
export type PluginUserSettingField = PluginSettingsField

/** A button a plugin contributes to a settings form ("Test connection", "Purge cache").
 * `scope` says which form: the user tab or the admin instance-settings dialog. */
export type PluginAction = PluginActionDescriptor

export const pluginsApi = {
  // Active plugins the client renders (page nav entries, dashboard widgets).
  active: () => apiClient.get('/plugins').then(r => r.data),
  // Extra place info contributed by placeDetailProvider plugins (#1429). Fail-safe:
  // the server skips any slow/failing provider, so this only ever adds rows.
  placeDetails: (placeId: number) =>
    apiClient.get(`/place-details/${placeId}`).then(r => r.data as { providers: Array<{ pluginId: string; items: Array<{ label: string; value?: string; url?: string }> }> }),
  // Validation/warning contributions from warningProvider plugins (#1429). Fail-safe.
  tripWarnings: (tripId: number) =>
    apiClient.get(`/trip-warnings/${tripId}`).then(r => r.data as { warnings: Array<{ pluginId: string; level: 'info' | 'warning' | 'error'; message: string; dayId?: number; placeId?: number }> }),
  // Host-rendered columns/actions plugins add into a native planner view via the
  // tableContributor hook. Fetched once per view, keyed by entityId; fail-safe.
  viewContributions: (view: 'reservations' | 'transports' | 'places' | 'day' | 'costs' | 'packing' | 'files' | 'todos', tripId: number | string) =>
    apiClient.get(`/view-contributions/${view}/${tripId}`).then(r => r.data as { contributions: ViewContribution[] }),
  // Bounded markers plugins overlay on the trip map via the mapMarkerProvider hook
  // (#587). Host-normalized + range-checked; fail-safe (skips slow/failing providers).
  mapMarkers: (tripId: number | string) =>
    apiClient.get(`/map-markers/${tripId}`).then(r => r.data as { markers: PluginMapMarker[] }),
  // Vector overlays (polylines/polygons/circles) plugins draw on the trip map via
  // the mapLayerProvider hook. Host-normalized + vertex-budgeted; fail-safe.
  mapLayers: (tripId: number | string) =>
    apiClient.get(`/map-layers/${tripId}`).then(r => r.data as { layers: PluginMapLayer[] }),
  // Route the given waypoints through ONE routeProvider plugin profile (targeted,
  // not a fan-out — the user picked this profile in the route toggle). Slow by
  // design (external solvers): the server allows the plugin 20 s.
  pluginRoute: (pluginId: string, profileId: string, body: { tripId: number | string; dayId?: number | null; waypoints: Array<{ lat: number; lng: number; name?: string; placeId?: number }> }, opts: { signal?: AbortSignal } = {}) =>
    apiClient.post(`/plugin-routes/${pluginId}/${profileId}`, body, { timeout: 25000, signal: opts.signal }).then(r => r.data as { route: PluginRouteResult | null }),
  // Time contributions plugins attach to the day plan via the dayScheduleProvider
  // hook (charging stops, security buffers). Host-normalized; fail-safe.
  daySchedule: (tripId: number | string) =>
    apiClient.get(`/day-schedule/${tripId}`).then(r => r.data as { items: PluginDayScheduleItem[] }),
  // Per-day colours plugins put behind the day cards via the dayTintProvider hook
  // (which leg of the trip a day belongs to). Host-normalized; fail-safe.
  dayTints: (tripId: number | string) =>
    apiClient.get(`/day-tints/${tripId}`).then(r => r.data as { tints: PluginDayTint[] }),
  // Text-only sections plugins append to the trip PDF export via the
  // pdfSectionProvider hook. Host-normalized (counts + lengths capped); fail-safe.
  pdfSections: (tripId: number | string) =>
    apiClient.get(`/pdf-sections/${tripId}`).then(r => r.data as { sections: PluginPdfSection[] }),
  // Country tint layers plugins draw over the Atlas map for the signed-in user via
  // the atlasLayerProvider hook. No tripId — user-scoped server-side; fail-safe.
  atlasLayers: () =>
    apiClient.get('/atlas-layers').then(r => r.data as { layers: PluginAtlasLayer[] }),
  // Extra rows plugins add under a journal entry via the journalEntryProvider hook.
  // Same shape + hardening as placeDetails (label/value/allowlisted url); fail-safe.
  journalEntryRows: (entryId: number) =>
    apiClient.get(`/journal-entry-rows/${entryId}`).then(r => r.data as { providers: Array<{ pluginId: string; items: Array<{ label: string; value?: string; url?: string }> }> }),
  // Badges plugins add to the dashboard trip cards via the tripCardProvider hook.
  // One call for all visible cards; host access-checks each tripId + bounds every
  // field (label/value/tone/allowlisted url); fail-safe.
  tripCardContributions: (tripIds: Array<number | string>) =>
    apiClient.get(`/trip-card-contributions?tripIds=${tripIds.join(',')}`).then(r => r.data as { contributions: TripCardBadge[] }),
  // The signed-in user's OWN plugin activity log — every host-mediated action a
  // plugin took bound to them, across all plugins, newest first. The user-facing
  // half of the capability audit; what makes the broad read grants accountable.
  myActivity: (limit = 200) =>
    apiClient.get(`/plugin-activity?limit=${limit}`).then(r => r.data as { activity: Array<{ ts: string; plugin_id: string; plugin_name: string | null; method: string; resource: string | null; code: string }> }),
  // A user's OWN scope:'user' settings for a plugin (API key, prefs). Secrets are
  // masked; the write only accepts declared user-scope keys.
  userSettings: (id: string) =>
    apiClient.get(`/plugin-settings/${id}`).then(r => r.data as {
      fields: PluginUserSettingField[]
      config: Record<string, unknown>
      actions: PluginAction[]
    }),
  // Run a settings-page action the plugin declared ("Test connection"). It runs AS the
  // caller, so it reads the caller's own settings.
  runAction: (id: string, key: string) =>
    apiClient.post(`/plugin-settings/${id}/actions/${encodeURIComponent(key)}`)
      .then(r => r.data as PluginActionResult),
  saveUserSettings: (id: string, config: Record<string, unknown>) =>
    apiClient.post(`/plugin-settings/${id}`, { config }).then(r => r.data as { config: Record<string, unknown> }),
  // Host-brokered outbound OAuth (the host owns the tokens; the plugin only triggers).
  oauthStatus: (id: string) =>
    apiClient.get(`/plugin-oauth/${id}/status`).then(r => r.data as { configured: boolean; connected: boolean }),
  oauthConnect: (id: string) =>
    apiClient.post(`/plugin-oauth/${id}/connect`).then(r => r.data as { authorizeUrl: string }),
  oauthDisconnect: (id: string) =>
    apiClient.post(`/plugin-oauth/${id}/disconnect`).then(r => r.data as { connected: boolean }),
  // Call one of a plugin's own declared routes through the host proxy. `sub` is
  // supplied by untrusted plugin code (the trekBridge forwards it verbatim), so it
  // MUST stay inside the plugin's own /plugins/:id/ namespace. We resolve it with
  // the URL parser — which normalizes `../`, encoded traversal and backslashes the
  // same way the browser would before sending — and reject anything that escapes
  // the prefix or points off-origin. Without this a plugin could send
  // sub='/../../auth/me' and drive arbitrary authenticated /api routes as the user.
  invoke: (id: string, sub: string, init?: { method?: string; body?: unknown }) => {
    const prefix = `/api/plugins/${id}/`
    let resolved: URL
    try {
      resolved = new URL(String(sub).replace(/^\/+/, ''), window.location.origin + prefix)
    } catch {
      return Promise.reject(new Error('invalid plugin route'))
    }
    if (resolved.origin !== window.location.origin || !resolved.pathname.startsWith(prefix)) {
      return Promise.reject(new Error('plugin route escapes its namespace'))
    }
    const url = resolved.pathname.slice('/api'.length) + resolved.search
    return apiClient.request({ url, method: init?.method || 'GET', data: init?.body }).then(r => r.data)
  },
}

export const airtrailApi = {
  getSettings: () => apiClient.get('/integrations/airtrail/settings').then(r => r.data),
  saveSettings: (data: { url: string; apiKey?: string; allowInsecureTls?: boolean; writeEnabled?: boolean }) =>
    apiClient.put('/integrations/airtrail/settings', data).then(r => r.data),
  status: () => apiClient.get('/integrations/airtrail/status').then(r => r.data),
  test: (data: { url?: string; apiKey?: string; allowInsecureTls?: boolean }) =>
    apiClient.post('/integrations/airtrail/test', data).then(r => r.data),
  sync: (): Promise<{ changed: number }> => apiClient.post('/integrations/airtrail/sync').then(r => r.data),
  // flights + import are added with the trip-planner import (P2)
  flights: () => apiClient.get('/integrations/airtrail/flights').then(r => r.data),
  import: (tripId: number, flightIds: string[], connections?: string[][]) =>
    apiClient.post(`/trips/${tripId}/reservations/import/airtrail`, connections?.length ? { flightIds, connections } : { flightIds }).then(r => r.data),
}

export const journeyApi = {
  list: () => apiClient.get('/journeys').then(r => r.data),
  create: (data: JourneyCreateRequest) => apiClient.post('/journeys', data).then(r => r.data),
  get: (id: number) => apiClient.get(`/journeys/${id}`).then(r => r.data),
  update: (id: number, data: Record<string, unknown>) => apiClient.patch(`/journeys/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/journeys/${id}`).then(r => r.data),

  suggestions: () => apiClient.get('/journeys/suggestions').then(r => r.data),
  availableTrips: () => apiClient.get('/journeys/available-trips').then(r => r.data),

  // Trips (sync sources)
  addTrip: (id: number, tripId: number) => apiClient.post(`/journeys/${id}/trips`, { trip_id: tripId } satisfies JourneyAddTripRequest).then(r => r.data),
  removeTrip: (id: number, tripId: number) => apiClient.delete(`/journeys/${id}/trips/${tripId}`).then(r => r.data),

  // Entries
  listEntries: (id: number) => apiClient.get(`/journeys/${id}/entries`).then(r => r.data),
  // GPX tracks of the trips this journey's entries came from (#1260).
  listTracks: (id: number): Promise<JourneyTracksResponse> => apiClient.get(`/journeys/${id}/tracks`).then(r => r.data),
  // What the journey adds up to — distance, days, countries, the route (#1973).
  // Read by TREK Studio, which freezes the answer into the book document.
  stats: (id: number): Promise<JourneyStats> => apiClient.get(`/journeys/${id}/stats`).then(r => r.data),

  // The Studio book (#1973). `book` is null for a journey that has none yet —
  // Studio lays one out and the first save creates it.
  getBook: (id: number): Promise<{ book: BookRecord | null }> =>
    apiClient.get(`/journeys/${id}/book`).then(r => r.data),
  // A 409 carries the current record in its body, so a conflict can be shown
  // rather than only announced. See useBookStore.
  saveBook: (id: number, body: BookSaveRequest): Promise<BookRecord> =>
    apiClient.put(`/journeys/${id}/book`, body).then(r => r.data),
  deleteBook: (id: number): Promise<void> =>
    apiClient.delete(`/journeys/${id}/book`).then(r => r.data),
  createEntry: (id: number, data: Record<string, unknown>) => apiClient.post(`/journeys/${id}/entries`, data).then(r => r.data),
  updateEntry: (entryId: number, data: Record<string, unknown>) => apiClient.patch(`/journeys/entries/${entryId}`, data).then(r => r.data),
  deleteEntry: (entryId: number) => apiClient.delete(`/journeys/entries/${entryId}`).then(r => r.data),
  reorderEntries: (journeyId: number, orderedIds: number[]) => apiClient.put(`/journeys/${journeyId}/entries/reorder`, { orderedIds } satisfies JourneyReorderEntriesRequest).then(r => r.data),

  // Photos
  uploadPhotos: (entryId: number, formData: FormData, opts?: UploadOptions) =>
    postMultipart(`/journeys/entries/${entryId}/photos`, formData, opts),
  uploadGalleryPhotos: (journeyId: number, formData: FormData, opts?: UploadOptions) =>
    postMultipart(`/journeys/${journeyId}/gallery/photos`, formData, opts),
  uploadGalleryVideo: (journeyId: number, formData: FormData, opts?: UploadOptions) =>
    postMultipart(`/journeys/${journeyId}/gallery/video`, formData, opts),
  addProviderPhotosToGallery: (journeyId: number, provider: string, assetIds: string[], passphrase?: string, mediaTypes?: string[]) => apiClient.post(`/journeys/${journeyId}/gallery/provider-photos`, { provider, asset_ids: assetIds, ...(passphrase ? { passphrase } : {}), ...(mediaTypes ? { media_types: mediaTypes } : {}) } satisfies JourneyProviderPhotosRequest).then(r => r.data),
  addProviderPhoto: (entryId: number, provider: string, assetId: string, caption?: string, passphrase?: string) => apiClient.post(`/journeys/entries/${entryId}/provider-photos`, { provider, asset_id: assetId, caption, ...(passphrase ? { passphrase } : {}) }).then(r => r.data),
  addProviderPhotos: (entryId: number, provider: string, assetIds: string[], caption?: string, passphrase?: string, mediaTypes?: string[]) => apiClient.post(`/journeys/entries/${entryId}/provider-photos`, { provider, asset_ids: assetIds, caption, ...(passphrase ? { passphrase } : {}), ...(mediaTypes ? { media_types: mediaTypes } : {}) }).then(r => r.data),
  linkPhoto: (entryId: number, journeyPhotoId: number) => apiClient.post(`/journeys/entries/${entryId}/link-photo`, { journey_photo_id: journeyPhotoId }).then(r => r.data),
  unlinkPhoto: (entryId: number, journeyPhotoId: number) => apiClient.delete(`/journeys/entries/${entryId}/photos/${journeyPhotoId}`).then(r => r.data),
  deleteGalleryPhoto: (journeyId: number, journeyPhotoId: number) => apiClient.delete(`/journeys/${journeyId}/gallery/${journeyPhotoId}`).then(r => r.data),
  updatePhoto: (photoId: number, data: Record<string, unknown>) => apiClient.patch(`/journeys/photos/${photoId}`, data).then(r => r.data),
  deletePhoto: (photoId: number) => apiClient.delete(`/journeys/photos/${photoId}`).then(r => r.data),

  // Cover
  uploadCover: (id: number, formData: FormData) => postMultipart(`/journeys/${id}/cover`, formData),

  // Contributors
  addContributor: (id: number, userId: number, role: string) => apiClient.post(`/journeys/${id}/contributors`, { user_id: userId, role }).then(r => r.data),
  updateContributor: (id: number, userId: number, role: string) => apiClient.patch(`/journeys/${id}/contributors/${userId}`, { role }).then(r => r.data),
  removeContributor: (id: number, userId: number) => apiClient.delete(`/journeys/${id}/contributors/${userId}`).then(r => r.data),

  // Preferences
  updatePreferences: (id: number, data: { hide_skeletons?: boolean }) => apiClient.patch(`/journeys/${id}/preferences`, data).then(r => r.data),

  // Share
  getShareLink: (id: number) => apiClient.get(`/journeys/${id}/share-link`).then(r => r.data),
  createShareLink: (id: number, perms: JourneyShareLinkRequest) => apiClient.post(`/journeys/${id}/share-link`, perms).then(r => r.data),
  deleteShareLink: (id: number) => apiClient.delete(`/journeys/${id}/share-link`).then(r => r.data),
  getPublicJourney: (token: string) => apiClient.get(`/public/journey/${token}`).then(r => r.data),
}

// Photo providers (Immich, Synology Photos, …) behind /api/integrations/memories.
// The provider sits on the user's own hardware and the server proxies through to
// it, so the 8s default does not apply — and neither does any number picked
// here. The server already holds the deadline, and its worst case is longer than
// anything that would look reasonable in this file: a Synology call is 30s, and
// an expired session makes it re-authenticate and try again. A client cap below
// that turns a slow NAS into a NAS that reads as disconnected, which is what
// these calls looked like before they moved off raw fetch (which had no timeout
// either). Callers that need to give up early pass an AbortSignal.
const MEMORIES_TIMEOUT = 0

export const memoriesApi = {
  status: (provider: string): Promise<{ connected: boolean }> =>
    apiClient.get(`/integrations/memories/${provider}/status`, { timeout: MEMORIES_TIMEOUT }).then(r => r.data),
  search: (provider: string, body: { from: string; to: string; page: number; size: number }, signal?: AbortSignal) =>
    apiClient.post(`/integrations/memories/${provider}/search`, body, { timeout: MEMORIES_TIMEOUT, signal }).then(r => r.data),
  albums: (provider: string) =>
    apiClient.get(`/integrations/memories/${provider}/albums`, { timeout: MEMORIES_TIMEOUT }).then(r => r.data),
  albumPhotos: (provider: string, albumId: string, passphrase?: string, signal?: AbortSignal) =>
    apiClient.get(`/integrations/memories/${provider}/albums/${albumId}/photos`, {
      timeout: MEMORIES_TIMEOUT,
      params: passphrase ? { passphrase } : undefined,
      signal,
    }).then(r => r.data),
}

export const mapsApi = {
  search: (query: string, lang?: string) => apiClient.post(`/maps/search?lang=${lang || 'en'}`, { query }).then(r => checkInDev(mapsSearchResultSchema, r.data, 'maps.search')),
  autocomplete: (input: string, lang?: string, locationBias?: { low: { lat: number; lng: number }; high: { lat: number; lng: number } }, signal?: AbortSignal, sessionToken?: string) =>
      apiClient.post('/maps/autocomplete', { input, lang, locationBias, sessionToken }, { signal }).then(r => checkInDev(mapsAutocompleteResultSchema, r.data, 'maps.autocomplete')),
  details: (placeId: string, lang?: string, sessionToken?: string) => apiClient.get(`/maps/details/${encodeURIComponent(placeId)}`, { params: { lang, sessionToken } }).then(r => checkInDev(mapsPlaceDetailsResultSchema, r.data, 'maps.details')),
  // Pictures and a description for a place that is being looked at but not yet
  // saved. Fans out to several providers server-side, so it takes a signal and
  // the caller is expected to abort it when the selection changes, and a longer
  // timeout than the global 8s — a cold Wikimedia connection alone can eat that.
  placeEnrichment: (
    body: { placeId?: string; lat: number; lng: number; name: string; lang?: string; details?: Record<string, unknown> },
    signal?: AbortSignal,
  ) => apiClient.post('/maps/enrichment', body, { signal, timeout: 25000 })
      .then(r => checkInDev(mapsPlaceEnrichmentResultSchema, r.data, 'maps.placeEnrichment')),
  // Author + licence for a picture already stored in the photo cache, keyed by
  // the cache key embedded in its proxy URL. Local read, no provider call.
  placePhotoCredit: (key: string) =>
    apiClient.get(`/maps/enrichment/credit/${encodeURIComponent(key)}`).then(r => r.data as { credit: string | null }),
  placePhoto: (placeId: string, lat?: number, lng?: number, name?: string) => apiClient.get(`/maps/place-photo/${encodeURIComponent(placeId)}`, { params: { lat, lng, name } }).then(r => checkInDev(mapsPlacePhotoResultSchema, r.data, 'maps.placePhoto')),
  reverse: (lat: number, lng: number, lang?: string) => apiClient.get('/maps/reverse', { params: { lat, lng, lang } }).then(r => checkInDev(mapsReverseResultSchema, r.data, 'maps.reverse')),
  resolveUrl: (url: string) => apiClient.post('/maps/resolve-url', { url }).then(r => checkInDev(mapsResolveUrlResultSchema, r.data, 'maps.resolveUrl')),
  // OSM-only POI explore: places of a category within the current map viewport bbox.
  // Overpass can be slow on a fresh (uncached) area, so this call gets a longer
  // timeout than the global default instead of aborting at 8s and showing nothing.
  pois: (category: string, bbox: { south: number; west: number; north: number; east: number }, lang?: string, signal?: AbortSignal) =>
    apiClient.get('/maps/pois', { params: { category, ...bbox, lang }, signal, timeout: 20000 }).then(r => r.data as { pois: import('../components/Map/poiCategories').Poi[]; source: string; truncated: boolean; clamped?: boolean }),
}

export const airportsApi = {
  search: (q: string, signal?: AbortSignal) => apiClient.get('/airports/search', { params: { q }, signal }).then(r => r.data),
  byIata: (iata: string) => apiClient.get(`/airports/${encodeURIComponent(iata)}`).then(r => r.data),
}

export const budgetApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget`).then(r => r.data),
  create: (tripId: number | string, data: BudgetCreateItemRequest) => apiClient.post(`/trips/${tripId}/budget`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: BudgetUpdateItemRequest) => apiClient.put(`/trips/${tripId}/budget/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/budget/${id}`).then(r => r.data),
  setMembers: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/budget/${id}/members`, { user_ids: userIds } satisfies BudgetUpdateMembersRequest).then(r => r.data),
  togglePaid: (tripId: number | string, id: number, userId: number, paid: boolean) => apiClient.put(`/trips/${tripId}/budget/${id}/members/${userId}/paid`, { paid } satisfies BudgetToggleMemberPaidRequest).then(r => r.data),
  setPayers: (tripId: number | string, id: number, payers: { user_id: number; amount: number }[]) => apiClient.put(`/trips/${tripId}/budget/${id}/payers`, { payers }).then(r => r.data),
  perPersonSummary: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget/summary/per-person`).then(r => r.data),
  settlement: (tripId: number | string, base?: string) => apiClient.get(`/trips/${tripId}/budget/settlement`, base ? { params: { base } } : undefined).then(r => r.data),
  createSettlement: (tripId: number | string, data: { from_user_id: number; to_user_id: number; amount: number; currency?: string }) => apiClient.post(`/trips/${tripId}/budget/settlements`, data).then(r => r.data),
  updateSettlement: (tripId: number | string, settlementId: number, data: { from_user_id: number; to_user_id: number; amount: number; currency?: string }) => apiClient.put(`/trips/${tripId}/budget/settlements/${settlementId}`, data).then(r => r.data),
  deleteSettlement: (tripId: number | string, settlementId: number) => apiClient.delete(`/trips/${tripId}/budget/settlements/${settlementId}`).then(r => r.data),
  reorderItems: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/budget/reorder/items`, { orderedIds }).then(r => r.data),
  reorderCategories: (tripId: number | string, orderedCategories: string[]) => apiClient.put(`/trips/${tripId}/budget/reorder/categories`, { orderedCategories } satisfies BudgetReorderCategoriesRequest).then(r => r.data),
}

export const filesApi = {
  list: (tripId: number | string, trash?: boolean) => apiClient.get(`/trips/${tripId}/files`, { params: trash ? { trash: 'true' } : {} }).then(r => r.data),
  upload: (tripId: number | string, formData: FormData, opts?: UploadOptions) => postMultipart(`/trips/${tripId}/files`, formData, opts),
  update: (tripId: number | string, id: number, data: FileUpdateRequest) => apiClient.put(`/trips/${tripId}/files/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}`).then(r => r.data),
  toggleStar: (tripId: number | string, id: number) => apiClient.patch(`/trips/${tripId}/files/${id}/star`).then(r => r.data),
  restore: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/files/${id}/restore`).then(r => r.data),
  permanentDelete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}/permanent`).then(r => r.data),
  emptyTrash: (tripId: number | string) => apiClient.delete(`/trips/${tripId}/files/trash/empty`).then(r => r.data),
  addLink: (tripId: number | string, fileId: number, data: FileLinkRequest) => apiClient.post(`/trips/${tripId}/files/${fileId}/link`, data).then(r => r.data),
  removeLink: (tripId: number | string, fileId: number, linkId: number) => apiClient.delete(`/trips/${tripId}/files/${fileId}/link/${linkId}`).then(r => r.data),
  getLinks: (tripId: number | string, fileId: number) => apiClient.get(`/trips/${tripId}/files/${fileId}/links`).then(r => r.data),
}

export const reservationsApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/reservations`).then(r => r.data),
  upcoming: () => apiClient.get('/reservations/upcoming').then(r => r.data),
  create: (tripId: number | string, data: ReservationCreateRequest) => apiClient.post(`/trips/${tripId}/reservations`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: ReservationUpdateRequest) => apiClient.put(`/trips/${tripId}/reservations/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/reservations/${id}`).then(r => r.data),
  // Assign trip members / named guests to a booking (#1517).
  setTravelers: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/reservations/${id}/travelers`, { user_ids: userIds }).then(r => r.data),
  updatePositions: (tripId: number | string, positions: { id: number; day_plan_position: number }[], dayId?: number) => apiClient.put(`/trips/${tripId}/reservations/positions`, { positions, day_id: dayId }).then(r => r.data),
  importBookingPreview: (tripId: number | string, files: File[], mode: BookingImportMode = 'no-ai'): Promise<BookingImportPreviewResponse> => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    fd.append('mode', mode)
    // No client-side timeout: kitinerary + LLM extraction routinely exceeds the
    // global 8s default (a cold local model alone can take ~45s).
    return postMultipart(`/trips/${tripId}/reservations/import/booking`, fd)
  },
  importBookingConfirm: (tripId: number | string, items: BookingImportPreviewItem[]): Promise<BookingImportConfirmResponse> =>
    apiClient.post(`/trips/${tripId}/reservations/import/booking/confirm`, { items }).then(r => r.data),
  // Start a background parse: returns a job id at once; progress + result arrive
  // over the WebSocket (import:progress / import:done / import:error).
  importBookingAsync: (tripId: number | string, files: File[], mode: BookingImportMode = 'no-ai'): Promise<{ jobId: string }> => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    fd.append('mode', mode)
    return postMultipart(`/trips/${tripId}/reservations/import/booking/async`, fd)
  },
  // Poll a background job — recovery path when a WebSocket push was missed.
  importJobStatus: (tripId: number | string, jobId: string): Promise<{ status: 'running' | 'done' | 'error'; done: number; total: number; result?: BookingImportPreviewResponse; error?: string }> =>
    apiClient.get(`/trips/${tripId}/reservations/import/jobs/${jobId}`).then(r => r.data),
}

export const healthApi = {
  features: (): Promise<{ bookingImport: boolean; aiParsing: boolean }> => apiClient.get('/health/features').then(r => r.data),
}

export const weatherApi = {
  // `time` (HH:MM) makes a past date answer for that hour instead of the day (#1614).
  // `lang` localizes the description; when omitted the server keeps its own default (#2167).
  get: (lat: number, lng: number, date: string, lang?: string, time?: string): Promise<WeatherResult> => apiClient.get('/weather', { params: { lat, lng, date, lang, time } }).then(r => parseInDev(weatherResultSchema, r.data, 'weather.get')),
  getCurrent: (lat: number, lng: number, lang?: string): Promise<WeatherResult> => apiClient.get('/weather', { params: { lat, lng, lang } }).then(r => parseInDev(weatherResultSchema, r.data, 'weather.getCurrent')),
  getDetailed: (lat: number, lng: number, date: string, lang?: string): Promise<WeatherResult> => apiClient.get('/weather/detailed', { params: { lat, lng, date, lang } }).then(r => parseInDev(weatherResultSchema, r.data, 'weather.getDetailed')),
}

export const configApi = {
  getPublicConfig: (): Promise<{ defaultLanguage: string }> =>
      apiClient.get('/config').then(r => r.data),
}

export interface HelpNavItem { title: string; slug: string }
export interface HelpNavSection { title: string; pages: HelpNavItem[] }
export interface HelpPageData { slug: string; title: string; markdown: string }

export const helpApi = {
  index: (): Promise<{ sections: HelpNavSection[] }> =>
    apiClient.get('/help/index').then(r => r.data),
  page: (slug: string): Promise<HelpPageData> =>
    apiClient.get(`/help/page/${encodeURIComponent(slug)}`).then(r => r.data),
}

export const settingsApi = {
  get: () => apiClient.get('/settings').then(r => r.data),
  set: (key: string, value: unknown) => {
    const body: SettingUpsertRequest = { key, value }
    return apiClient.put('/settings', body).then(r => r.data)
  },
  setBulk: (settings: Record<string, unknown>) => {
    const body: SettingsBulkRequest = { settings }
    return apiClient.post('/settings/bulk', body).then(r => r.data)
  },
}

export const accommodationsApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/accommodations`).then(r => r.data),
  create: (tripId: number | string, data: AccommodationCreateRequest) => apiClient.post(`/trips/${tripId}/accommodations`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: AccommodationUpdateRequest) => apiClient.put(`/trips/${tripId}/accommodations/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/accommodations/${id}`).then(r => r.data),
}

export const dayNotesApi = {
  list: (tripId: number | string, dayId: number | string) => apiClient.get(`/trips/${tripId}/days/${dayId}/notes`).then(r => r.data),
  create: (tripId: number | string, dayId: number | string, data: DayNoteCreateRequest) => apiClient.post(`/trips/${tripId}/days/${dayId}/notes`, data).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, id: number, data: DayNoteUpdateRequest) => apiClient.put(`/trips/${tripId}/days/${dayId}/notes/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/days/${dayId}/notes/${id}`).then(r => r.data),
}

export const collabApi = {
  getNotes: (tripId: number | string) => apiClient.get(`/trips/${tripId}/collab/notes`).then(r => r.data),
  createNote: (tripId: number | string, data: CollabNoteCreateRequest) => apiClient.post(`/trips/${tripId}/collab/notes`, data).then(r => r.data),
  updateNote: (tripId: number | string, id: number, data: CollabNoteUpdateRequest) => apiClient.put(`/trips/${tripId}/collab/notes/${id}`, data).then(r => r.data),
  deleteNote: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/collab/notes/${id}`).then(r => r.data),
  uploadNoteFile: (tripId: number | string, noteId: number, formData: FormData) => postMultipart(`/trips/${tripId}/collab/notes/${noteId}/files`, formData),
  deleteNoteFile: (tripId: number | string, noteId: number, fileId: number) => apiClient.delete(`/trips/${tripId}/collab/notes/${noteId}/files/${fileId}`).then(r => r.data),
  getPolls: (tripId: number | string) => apiClient.get(`/trips/${tripId}/collab/polls`).then(r => r.data),
  createPoll: (tripId: number | string, data: CollabPollCreateRequest) => apiClient.post(`/trips/${tripId}/collab/polls`, data).then(r => r.data),
  votePoll: (tripId: number | string, id: number, optionIndex: number) => apiClient.post(`/trips/${tripId}/collab/polls/${id}/vote`, { option_index: optionIndex } satisfies CollabPollVoteRequest).then(r => r.data),
  closePoll: (tripId: number | string, id: number) => apiClient.put(`/trips/${tripId}/collab/polls/${id}/close`).then(r => r.data),
  deletePoll: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/collab/polls/${id}`).then(r => r.data),
  getMessages: (tripId: number | string, before?: string) => apiClient.get(`/trips/${tripId}/collab/messages${before ? `?before=${before}` : ''}`).then(r => r.data),
  sendMessage: (tripId: number | string, data: CollabMessageCreateRequest) => apiClient.post(`/trips/${tripId}/collab/messages`, data).then(r => r.data),
  deleteMessage: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/collab/messages/${id}`).then(r => r.data),
  reactMessage: (tripId: number | string, id: number, emoji: string) => apiClient.post(`/trips/${tripId}/collab/messages/${id}/react`, { emoji } satisfies CollabReactionRequest).then(r => r.data),
  linkPreview: (tripId: number | string, url: string) => apiClient.get(`/trips/${tripId}/collab/link-preview?url=${encodeURIComponent(url)}`).then(r => r.data),
}

export const backupApi = {
  list: () => apiClient.get('/backup/list').then(r => r.data),
  create: () => apiClient.post('/backup/create').then(r => r.data),
  download: async (filename: string): Promise<void> => {
    const res = await fetch(`/api/backup/download/${filename}`, {
      credentials: 'include',
    })
    if (!res.ok) throw new Error('Download failed')
    downloadBlob(await res.blob(), filename)
  },
  delete: (filename: string) => apiClient.delete(`/backup/${filename}`).then(r => r.data),
  restore: (filename: string) => apiClient.post(`/backup/restore/${filename}`).then(r => r.data),
  uploadRestore: (file: File) => {
    const form = new FormData()
    form.append('backup', file)
    return postMultipart('/backup/upload-restore', form)
  },
  getAutoSettings: () => apiClient.get('/backup/auto-settings').then(r => r.data),
  setAutoSettings: (settings: Record<string, unknown>) => apiClient.put('/backup/auto-settings', settings).then(r => r.data),
}

export const shareApi = {
  getLink: (tripId: number | string) => apiClient.get(`/trips/${tripId}/share-link`).then(r => r.data),
  createLink: (tripId: number | string, perms?: Record<string, boolean>) => apiClient.post(`/trips/${tripId}/share-link`, perms || {}).then(r => r.data),
  deleteLink: (tripId: number | string) => apiClient.delete(`/trips/${tripId}/share-link`).then(r => r.data),
  getSharedTrip: (token: string) => apiClient.get(`/shared/${token}`).then(r => r.data),
}

// Public transit routing (#1065) — Transitous/MOTIS proxied through the server.
export const transitApi = {
  geocode: (q: string, opts?: { lang?: string; near?: string }) =>
    apiClient.get('/transit/geocode', { params: { q, lang: opts?.lang, near: opts?.near } }).then(r => r.data),
  plan: (params: { from: string; to: string; time?: string; arriveBy?: boolean; modes?: string; maxTransfers?: number }) =>
    apiClient.get('/transit/plan', { params }).then(r => r.data),
}

// Trip invite links (#1143) — join a trip as an existing, logged-in user.
export const tripInviteApi = {
  getLink: (tripId: number | string) => apiClient.get(`/trips/${tripId}/invite-link`).then(r => r.data),
  createLink: (tripId: number | string, expires_in_days?: number | null) =>
    apiClient.post(`/trips/${tripId}/invite-link`, { expires_in_days: expires_in_days ?? null }).then(r => r.data),
  deleteLink: (tripId: number | string) => apiClient.delete(`/trips/${tripId}/invite-link`).then(r => r.data),
  preview: (token: string) => apiClient.get(`/trip-invites/${token}`).then(r => r.data),
  accept: (token: string) => apiClient.post(`/trip-invites/${token}/accept`).then(r => r.data),
}

// A channel test dials a third party the admin just typed in, and the server
// budgets for it: up to 20s for a wrong SMTP port, 10s for a webhook or ntfy
// endpoint. The 8s instance timeout aborted those before the reason came back,
// so the toast could only ever say "failed" (#2196).
const CHANNEL_TEST_TIMEOUT = 40000

export const notificationsApi = {
  getPreferences: () => apiClient.get('/notifications/preferences').then(r => r.data),
  updatePreferences: (prefs: Record<string, Record<string, boolean>>) => apiClient.put('/notifications/preferences', prefs).then(r => r.data),
  testSmtp: (email?: string) => apiClient.post('/notifications/test-smtp', { email }, { timeout: CHANNEL_TEST_TIMEOUT }).then(r => checkInDev(channelTestResultSchema, r.data, 'notifications.testSmtp')),
  testWebhook: (url?: string) => apiClient.post('/notifications/test-webhook', { url }, { timeout: CHANNEL_TEST_TIMEOUT }).then(r => checkInDev(channelTestResultSchema, r.data, 'notifications.testWebhook')),
  testNtfy: (payload: { topic?: string; server?: string | null; token?: string | null }) => apiClient.post('/notifications/test-ntfy', payload, { timeout: CHANNEL_TEST_TIMEOUT }).then(r => checkInDev(channelTestResultSchema, r.data, 'notifications.testNtfy')),
  // Generic channel test — this is how a PLUGIN channel's "Send test" button works.
  testChannel: (channelId: string) =>
    apiClient.post(`/notifications/test/${encodeURIComponent(channelId)}`, undefined, { timeout: CHANNEL_TEST_TIMEOUT })
      .then(r => checkInDev(channelTestResultSchema, r.data, 'notifications.testChannel')),
}

export const inAppNotificationsApi = {
  list: (params?: { limit?: number; offset?: number; unread_only?: boolean }): Promise<InAppListResult> =>
      apiClient.get('/notifications/in-app', { params }).then(r => parseInDev(inAppListResultSchema, r.data, 'notifications.list')),
  unreadCount: (): Promise<UnreadCountResult> =>
      apiClient.get('/notifications/in-app/unread-count').then(r => parseInDev(unreadCountResultSchema, r.data, 'notifications.unreadCount')),
  markRead: (id: number) =>
      apiClient.put(`/notifications/in-app/${id}/read`).then(r => r.data),
  markUnread: (id: number) =>
      apiClient.put(`/notifications/in-app/${id}/unread`).then(r => r.data),
  markAllRead: () =>
      apiClient.put('/notifications/in-app/read-all').then(r => r.data),
  delete: (id: number) =>
      apiClient.delete(`/notifications/in-app/${id}`).then(r => r.data),
  deleteAll: () =>
      apiClient.delete('/notifications/in-app/all').then(r => r.data),
  respond: (id: number, response: NotificationRespondRequest['response']) =>
      apiClient.post(`/notifications/in-app/${id}/respond`, { response }).then(r => r.data),
}

export default apiClient
