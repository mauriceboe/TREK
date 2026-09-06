import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import apiClient, { adminApi, authApi } from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useAddonStore } from '../../store/addonStore'
import { useTranslation } from '../../i18n'
import { getApiErrorMessage } from '../../types'
import { useToast } from '../../components/shared/Toast'
import { managedAdminTabs } from '../../managed'
import type { AdminUser, AdminStats, OidcConfig, UpdateInfo } from './adminModel'
import type { TransitProvider, TransitKeySource } from '@trek/shared'

/**
 * Every tab id AdminPage can render a panel for, whatever this install offers.
 *
 * ?tab= is user input and was taken as read: an id with no panel behind it —
 * a typo, or a link from an install that has tabs this one does not — opened
 * the admin page on an empty content area with nothing selected in the
 * sidebar. Labels and icons stay in AdminPage; this is only the vocabulary.
 */
const ADMIN_TAB_IDS = [
  'users', 'defaults', 'config', 'settings', 'addons', 'plugins', 'storage',
  'notifications', 'mcp-tokens', 'github', 'backup', 'audit', 'dev-notifications',
]

/**
 * The ones a managed install deliberately does not offer.
 *
 * The sidebar entries are built conditionally, but the panels are not, so
 * ?tab=backup opened a backup schedule that competes with the real one on a
 * hosted instance. Checked in an effect rather than in the initial state
 * because `managed` arrives with /app-config, after the first render.
 */
const MANAGED_HIDDEN = ['storage', 'github', 'backup']

/**
 * Admin page logic — owns every admin data slice (users, stats, invites, auth
 * toggles, OIDC, feature flags, API keys, SMTP, version/update) plus the CRUD
 * and toggle handlers. AdminPage stays a wiring container that builds the
 * (t-dependent) tab list and renders the tab panels around this state.
 * Behaviour is identical to the previous in-component logic.
 */
export function useAdmin() {
  const { demoMode, serverTimezone } = useAuthStore()
  const { t } = useTranslation()
  const hour12 = useSettingsStore(s => s.settings.time_format) === '12h'
  const mcpEnabled = useAddonStore(s => s.isEnabled('mcp'))
  const devMode = useAuthStore(s => s.devMode)
  const managed = useAuthStore(s => s.managed)

  // ?tab= makes a section linkable: a support reply, an onboarding mail or a
  // bookmark can point at the one panel it is about instead of at the top of a
  // page with eleven of them. Read once for the initial value and written back
  // on every change, so the address bar keeps saying where the reader is.
  const [searchParams, setSearchParams] = useSearchParams()
  const [activeTab, setActiveTabState] = useState<string>(() => {
    const asked = searchParams.get('tab')
    const known = [...ADMIN_TAB_IDS, ...managedAdminTabs.map(tab => tab.id)]
    return asked && known.includes(asked) ? asked : 'users'
  })
  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab)
    // replace, not push: eleven tabs would otherwise fill the back button with
    // a history of a single page.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (tab === 'users') next.delete('tab')
      else next.set('tab', tab)
      return next
    }, { replace: true })
  }, [setSearchParams])
  useEffect(() => {
    if (managed && MANAGED_HIDDEN.includes(activeTab)) setActiveTab('users')
  }, [managed, activeTab, setActiveTab])

  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null)
  const [editForm, setEditForm] = useState<{ username: string; email: string; role: string; password: string }>({ username: '', email: '', role: 'user', password: '' })
  const [showCreateUser, setShowCreateUser] = useState<boolean>(false)
  const [createForm, setCreateForm] = useState<{ username: string; email: string; password: string; role: string }>({ username: '', email: '', password: '', role: 'user' })

  // Bag tracking
  const [bagTrackingEnabled, setBagTrackingEnabled] = useState<boolean>(false)
  useEffect(() => { adminApi.getBagTracking().then(d => setBagTrackingEnabled(d.enabled)).catch(() => {}) }, [])

  // Places photos
  const [placesPhotosEnabled, setPlacesPhotosEnabledState] = useState<boolean>(true)
  useEffect(() => { adminApi.getPlacesPhotos().then(d => setPlacesPhotosEnabledState(d.enabled)).catch(() => {}) }, [])

  // Places autocomplete
  const [placesAutocompleteEnabled, setPlacesAutocompleteEnabledState] = useState<boolean>(true)
  useEffect(() => { adminApi.getPlacesAutocomplete().then(d => setPlacesAutocompleteEnabledState(d.enabled)).catch(() => {}) }, [])

  // Places details
  const [placesDetailsEnabled, setPlacesDetailsEnabledState] = useState<boolean>(true)
  const [placesEnrichEnabled, setPlacesEnrichEnabledState] = useState<boolean>(true)
  useEffect(() => { adminApi.getPlacesDetails().then(d => setPlacesDetailsEnabledState(d.enabled)).catch(() => {}) }, [])
  useEffect(() => { adminApi.getPlacesEnrich().then(d => setPlacesEnrichEnabledState(d.enabled)).catch(() => {}) }, [])

  // Transit backend (#1699). googleKeySource says where a Google key would come
  // from for this admin — null means picking Google changes nothing, since the
  // request-time fallback to Transitous is silent by design.
  const [transitProvider, setTransitProviderState] = useState<TransitProvider>('transitous')
  const [transitGoogleKeySource, setTransitGoogleKeySource] = useState<TransitKeySource>(null)
  useEffect(() => {
    adminApi.getTransitProvider()
      .then(d => { setTransitProviderState(d.provider); setTransitGoogleKeySource(d.googleKeySource) })
      .catch(() => {})
  }, [])

  // Collab features
  const [collabFeatures, setCollabFeatures] = useState<{ chat: boolean; notes: boolean; polls: boolean; whatsnext: boolean }>({ chat: true, notes: true, polls: true, whatsnext: true })
  useEffect(() => { adminApi.getCollabFeatures().then(d => setCollabFeatures(d)).catch(() => {}) }, [])

  // OIDC config
  const [oidcConfig, setOidcConfig] = useState<OidcConfig>({ issuer: '', client_id: '', client_secret: '', client_secret_set: false, display_name: '', discovery_url: '' })
  const [savingOidc, setSavingOidc] = useState<boolean>(false)

  // Auth toggles
  const [passwordLogin, setPasswordLogin] = useState<boolean>(true)
  const [passwordRegistration, setPasswordRegistration] = useState<boolean>(true)
  const [oidcLogin, setOidcLogin] = useState<boolean>(true)
  const [oidcRegistration, setOidcRegistration] = useState<boolean>(true)
  const [envOverrideOidcOnly, setEnvOverrideOidcOnly] = useState<boolean>(false)
  const [oidcConfigured, setOidcConfigured] = useState<boolean>(false)
  const [requireMfa, setRequireMfa] = useState<boolean>(false)

  // Passkey (WebAuthn) login
  const [passkeyLogin, setPasskeyLogin] = useState<boolean>(false)
  const [passkeyConfigured, setPasskeyConfigured] = useState<boolean>(false)
  const [webauthnRpId, setWebauthnRpId] = useState<string>('')
  const [webauthnOrigins, setWebauthnOrigins] = useState<string>('')
  const [savingWebauthn, setSavingWebauthn] = useState<boolean>(false)

  // Invite links
  const [invites, setInvites] = useState<any[]>([])
  const [inviteTrips, setInviteTrips] = useState<{ id: number; title: string }[]>([])
  const [showCreateInvite, setShowCreateInvite] = useState<boolean>(false)
  const [inviteForm, setInviteForm] = useState<{ max_uses: number; expires_in_days: number | ''; trip_id: number | '' }>({ max_uses: 1, expires_in_days: 7, trip_id: '' })

  // File types
  const [allowedFileTypes, setAllowedFileTypes] = useState<string>('jpg,jpeg,png,gif,webp,heic,pdf,doc,docx,xls,xlsx,txt,csv')
  const [savingFileTypes, setSavingFileTypes] = useState<boolean>(false)

  // SMTP settings
  const [smtpValues, setSmtpValues] = useState<Record<string, string>>({})
  const [smtpLoaded, setSmtpLoaded] = useState(false)
  useEffect(() => {
    apiClient.get('/auth/app-settings').then(r => {
      setSmtpValues(r.data || {})
      if (r.data?.webauthn_rp_id) setWebauthnRpId(r.data.webauthn_rp_id)
      if (r.data?.webauthn_origins) setWebauthnOrigins(r.data.webauthn_origins)
      setSmtpLoaded(true)
    }).catch(() => setSmtpLoaded(true))
  }, [])

  // API Keys
  const [mapsKey, setMapsKey] = useState<string>('')
  const [weatherKey, setWeatherKey] = useState<string>('')
  const [unsplashKey, setUnsplashKey] = useState<string>('')
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [savingKeys, setSavingKeys] = useState<boolean>(false)
  const [validating, setValidating] = useState<Record<string, boolean>>({})
  const [validation, setValidation] = useState<Record<string, boolean | undefined>>({})

  // Version check & update
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [showUpdateModal, setShowUpdateModal] = useState<boolean>(false)

  const { user: currentUser, updateApiKeys, setAppRequireMfa, setTripRemindersEnabled, setPlacesPhotosEnabled, setPlacesAutocompleteEnabled, setPlacesDetailsEnabled, setPlacesEnrichEnabled, logout } = useAuthStore()
  const navigate = useNavigate()
  const toast = useToast()

  const [showRotateJwtModal, setShowRotateJwtModal] = useState<boolean>(false)
  const [rotatingJwt, setRotatingJwt] = useState<boolean>(false)

  useEffect(() => {
    loadData()
    loadAppConfig()
    loadApiKeys()
    // Skipped rather than caught when the route is closed to us: the request
    // still reaches the network, still answers 403, and still prints a red line
    // in the console of every admin who opens this page. Swallowing the promise
    // hides it from the code, not from the reader.
    if (!managed) adminApi.getOidc().then(setOidcConfig).catch(() => {})
    // The operator decides when this instance upgrades, so there is nothing to
    // check and nothing the admin could act on.
    if (managed) return
    adminApi.checkVersion().then(data => {
      if (data.update_available) setUpdateInfo(data)
    }).catch(() => {})
  }, [])

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [usersData, statsData, invitesData, inviteTripsData] = await Promise.all([
        adminApi.users(),
        adminApi.stats(),
        adminApi.listInvites().catch(() => ({ invites: [] })),
        adminApi.listInviteTrips().catch(() => ({ trips: [] })),
      ])
      setUsers(usersData.users)
      setStats(statsData)
      setInvites(invitesData.invites || [])
      setInviteTrips(inviteTripsData.trips || [])
    } catch (err: unknown) {
      toast.error(t('admin.toast.loadError'))
    } finally {
      setIsLoading(false)
    }
  }

  const loadAppConfig = async () => {
    try {
      const config = await authApi.getAppConfig()
      setPasswordLogin(config.password_login ?? true)
      setPasswordRegistration(config.password_registration ?? config.allow_registration ?? true)
      setOidcLogin(config.oidc_login ?? true)
      setOidcRegistration(config.oidc_registration ?? config.allow_registration ?? true)
      setEnvOverrideOidcOnly(config.env_override_oidc_only ?? false)
      setOidcConfigured(config.oidc_configured ?? false)
      if (config.require_mfa !== undefined) setRequireMfa(!!config.require_mfa)
      setPasskeyLogin(!!config.passkey_login)
      setPasskeyConfigured(!!config.passkey_configured)
      if (config.allowed_file_types) setAllowedFileTypes(config.allowed_file_types)
    } catch (err: unknown) {
      // ignore
    }
  }

  const loadApiKeys = async () => {
    try {
      const data = await authApi.getSettings()
      setMapsKey(data.settings?.maps_api_key || '')
      setWeatherKey(data.settings?.openweather_api_key || '')
      setUnsplashKey(data.settings?.unsplash_api_key || '')
    } catch (err: unknown) {
      // ignore
    }
  }

  const handleToggleAuthSetting = async (key: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value)
    try {
      await authApi.updateAppSettings({ [key]: value })
    } catch (err: unknown) {
      setter(!value)
      toast.error(getApiErrorMessage(err, t('common.error')))
    }
  }

  const handleToggleRequireMfa = async (value: boolean) => {
    setRequireMfa(value)
    try {
      await authApi.updateAppSettings({ require_mfa: value })
      setAppRequireMfa(value)
      toast.success(t('common.saved'))
    } catch (err: unknown) {
      setRequireMfa(!value)
      toast.error(getApiErrorMessage(err, t('common.error')))
    }
  }

  const handleSaveWebauthn = async () => {
    setSavingWebauthn(true)
    try {
      await authApi.updateAppSettings({
        webauthn_rp_id: webauthnRpId.trim(),
        webauthn_origins: webauthnOrigins.trim(),
      })
      // Re-read app-config so passkey_configured reflects the new RP ID.
      await loadAppConfig()
      toast.success(t('common.saved'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('common.error')))
    } finally {
      setSavingWebauthn(false)
    }
  }

  const toggleKey = (key) => {
    setShowKeys(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSaveApiKeys = async () => {
    setSavingKeys(true)
    try {
      await updateApiKeys({
        maps_api_key: mapsKey,
        openweather_api_key: weatherKey,
        unsplash_api_key: unsplashKey,
      })
      toast.success(t('admin.keySaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSavingKeys(false)
    }
  }

  const handleValidateKeys = async () => {
    setValidating({ maps: true, weather: true })
    try {
      // Save first so validation uses the current values
      await updateApiKeys({ maps_api_key: mapsKey, openweather_api_key: weatherKey, unsplash_api_key: unsplashKey })
      const result = await authApi.validateKeys()
      setValidation(result)
    } catch (err: unknown) {
      toast.error(t('common.error'))
    } finally {
      setValidating({})
    }
  }

  const handleValidateKey = async (keyType) => {
    setValidating(prev => ({ ...prev, [keyType]: true }))
    try {
      // Save first so validation uses the current values
      await updateApiKeys({ maps_api_key: mapsKey, openweather_api_key: weatherKey, unsplash_api_key: unsplashKey })
      const result = await authApi.validateKeys()
      setValidation(prev => ({ ...prev, [keyType]: result[keyType] }))
    } catch (err: unknown) {
      toast.error(t('common.error'))
    } finally {
      setValidating(prev => ({ ...prev, [keyType]: false }))
    }
  }

  const handleCreateUser = async () => {
    if (!createForm.username.trim() || !createForm.email.trim() || !createForm.password.trim()) {
      toast.error(t('admin.toast.fieldsRequired'))
      return
    }
    if (createForm.password.trim().length < 8) {
      toast.error(t('settings.passwordTooShort'))
      return
    }
    try {
      const data = await adminApi.createUser(createForm)
      setUsers(prev => [data.user, ...prev])
      setShowCreateUser(false)
      setCreateForm({ username: '', email: '', password: '', role: 'user' })
      toast.success(t('admin.toast.userCreated'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.toast.createError')))
    }
  }

  const handleCreateInvite = async () => {
    try {
      const data = await adminApi.createInvite({
        max_uses: inviteForm.max_uses,
        expires_in_days: inviteForm.expires_in_days || undefined,
        trip_id: inviteForm.trip_id === '' ? null : inviteForm.trip_id,
      })
      setInvites(prev => [data.invite, ...prev])
      setShowCreateInvite(false)
      setInviteForm({ max_uses: 1, expires_in_days: 7, trip_id: '' })
      // Copy link to clipboard
      const link = `${window.location.origin}/register?invite=${data.invite.token}`
      navigator.clipboard.writeText(link).then(() => toast.success(t('admin.invite.copied')))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.invite.createError')))
    }
  }

  const handleDeleteInvite = async (id: number) => {
    try {
      await adminApi.deleteInvite(id)
      setInvites(prev => prev.filter(i => i.id !== id))
      toast.success(t('admin.invite.deleted'))
    } catch {
      toast.error(t('admin.invite.deleteError'))
    }
  }

  const copyInviteLink = (token: string) => {
    const link = `${window.location.origin}/register?invite=${token}`
    navigator.clipboard.writeText(link).then(() => toast.success(t('admin.invite.copied')))
  }

  const handleEditUser = (user) => {
    setEditingUser(user)
    setEditForm({ username: user.username, email: user.email, role: user.role, password: '' })
  }

  const handleSaveUser = async () => {
    if (!editingUser) return
    try {
      const payload: { username?: string; email?: string; role: string; password?: string } = {
        username: editForm.username.trim() || undefined,
        email: editForm.email.trim() || undefined,
        role: editForm.role,
      }
      if (editForm.password.trim()) {
        if (editForm.password.trim().length < 8) {
          toast.error(t('settings.passwordTooShort'))
          return
        }
        payload.password = editForm.password.trim()
      }
      const data = await adminApi.updateUser(editingUser.id, payload)
      setUsers(prev => prev.map(u => u.id === editingUser.id ? data.user : u))
      setEditingUser(null)
      toast.success(t('admin.toast.userUpdated'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.toast.updateError')))
    }
  }

  const handleDeleteUser = async (user) => {
    if (user.id === currentUser?.id) {
      toast.error(t('admin.toast.cannotDeleteSelf'))
      return
    }
    if (!confirm(t('admin.deleteUser', { name: user.username }))) return
    try {
      await adminApi.deleteUser(user.id)
      setUsers(prev => prev.filter(u => u.id !== user.id))
      toast.success(t('admin.toast.userDeleted'))
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.toast.deleteError')))
    }
  }

  return {
    // store-derived
    demoMode, serverTimezone, hour12, mcpEnabled, devMode, managed, currentUser,
    updateApiKeys, setAppRequireMfa, setTripRemindersEnabled,
    setPlacesPhotosEnabled, setPlacesAutocompleteEnabled, setPlacesDetailsEnabled, setPlacesEnrichEnabled, logout,
    navigate, toast,
    // state + setters
    activeTab, setActiveTab, users, setUsers, stats, isLoading,
    editingUser, setEditingUser, editForm, setEditForm,
    showCreateUser, setShowCreateUser, createForm, setCreateForm,
    bagTrackingEnabled, setBagTrackingEnabled,
    placesPhotosEnabled, setPlacesPhotosEnabledState,
    placesAutocompleteEnabled, setPlacesAutocompleteEnabledState,
    placesDetailsEnabled, setPlacesDetailsEnabledState,
    placesEnrichEnabled, setPlacesEnrichEnabledState,
    transitProvider, setTransitProviderState,
    transitGoogleKeySource, setTransitGoogleKeySource,
    collabFeatures, setCollabFeatures,
    oidcConfig, setOidcConfig, savingOidc, setSavingOidc,
    passwordLogin, setPasswordLogin, passwordRegistration, setPasswordRegistration,
    oidcLogin, setOidcLogin, oidcRegistration, setOidcRegistration,
    envOverrideOidcOnly, setEnvOverrideOidcOnly, oidcConfigured, setOidcConfigured,
    requireMfa, setRequireMfa,
    passkeyLogin, setPasskeyLogin, passkeyConfigured,
    webauthnRpId, setWebauthnRpId, webauthnOrigins, setWebauthnOrigins, savingWebauthn, handleSaveWebauthn,
    invites, setInvites, inviteTrips, showCreateInvite, setShowCreateInvite, inviteForm, setInviteForm,
    allowedFileTypes, setAllowedFileTypes, savingFileTypes, setSavingFileTypes,
    smtpValues, setSmtpValues, smtpLoaded,
    mapsKey, setMapsKey, weatherKey, setWeatherKey, unsplashKey, setUnsplashKey,
    showKeys, setShowKeys, savingKeys, validating, validation,
    updateInfo, setUpdateInfo, showUpdateModal, setShowUpdateModal,
    showRotateJwtModal, setShowRotateJwtModal, rotatingJwt, setRotatingJwt,
    // handlers
    loadData, loadAppConfig, loadApiKeys, handleToggleAuthSetting, handleToggleRequireMfa,
    toggleKey, handleSaveApiKeys, handleValidateKeys, handleValidateKey,
    handleCreateUser, handleCreateInvite, handleDeleteInvite, copyInviteLink,
    handleEditUser, handleSaveUser, handleDeleteUser,
  }
}
