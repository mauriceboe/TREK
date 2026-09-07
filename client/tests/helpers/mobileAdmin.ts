import { vi } from 'vitest';
import type { useAdmin } from '../../src/pages/admin/useAdmin';
import type { AdminUser } from '../../src/pages/admin/adminModel';

/**
 * Fixture for the mobile admin sections. MAdminUsersSection, MAdminSettingsSection
 * and MAdminSheets are pure presentation over the useAdmin() bag, so tests render
 * them with this builder instead of mounting MAdmin and its data loading.
 *
 * Defaults are the "nothing configured yet" state; every setter and handler is a
 * spy so tests can assert the exact call, including state updater functions.
 */

export type AdminHook = ReturnType<typeof useAdmin>;

export function buildAdminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 1,
    username: 'admin',
    email: 'admin@example.com',
    role: 'admin',
    created_at: '2025-01-01T00:00:00.000Z',
    avatar_url: null,
    ...overrides,
  };
}

export function buildAdminToast(): Record<string, ReturnType<typeof vi.fn>> {
  return { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
}

export function buildAdminHook(overrides: Record<string, unknown> = {}): AdminHook {
  const base: Record<string, unknown> = {
    // store-derived
    demoMode: false,
    serverTimezone: 'UTC',
    hour12: false,
    mcpEnabled: false,
    devMode: false,
    currentUser: buildAdminUser(),
    updateApiKeys: vi.fn(async () => undefined),
    setAppRequireMfa: vi.fn(),
    setTripRemindersEnabled: vi.fn(),
    setPlacesPhotosEnabled: vi.fn(),
    setPlacesAutocompleteEnabled: vi.fn(),
    setPlacesDetailsEnabled: vi.fn(),
    setPlacesEnrichEnabled: vi.fn(),
    logout: vi.fn(async () => undefined),
    navigate: vi.fn(),
    toast: buildAdminToast(),

    // users
    activeTab: 'users',
    setActiveTab: vi.fn(),
    users: [] as AdminUser[],
    setUsers: vi.fn(),
    stats: null,
    isLoading: false,
    editingUser: null,
    setEditingUser: vi.fn(),
    editForm: { username: '', email: '', role: 'user', password: '' },
    setEditForm: vi.fn(),
    showCreateUser: false,
    setShowCreateUser: vi.fn(),
    createForm: { username: '', email: '', password: '', role: 'user' },
    setCreateForm: vi.fn(),

    // feature flags
    bagTrackingEnabled: false,
    setBagTrackingEnabled: vi.fn(),
    placesPhotosEnabled: false,
    setPlacesPhotosEnabledState: vi.fn(),
    placesAutocompleteEnabled: false,
    setPlacesAutocompleteEnabledState: vi.fn(),
    placesDetailsEnabled: false,
    setPlacesDetailsEnabledState: vi.fn(),
    placesEnrichEnabled: true,
    setPlacesEnrichEnabledState: vi.fn(),
    collabFeatures: { chat: true, notes: true, polls: true, whatsnext: true },
    setCollabFeatures: vi.fn(),

    // auth / OIDC
    oidcConfig: {
      issuer: '',
      client_id: '',
      client_secret: '',
      client_secret_set: false,
      display_name: '',
      discovery_url: '',
    },
    setOidcConfig: vi.fn(),
    savingOidc: false,
    setSavingOidc: vi.fn(),
    passwordLogin: true,
    setPasswordLogin: vi.fn(),
    passwordRegistration: true,
    setPasswordRegistration: vi.fn(),
    oidcLogin: false,
    setOidcLogin: vi.fn(),
    oidcRegistration: false,
    setOidcRegistration: vi.fn(),
    envOverrideOidcOnly: false,
    setEnvOverrideOidcOnly: vi.fn(),
    oidcConfigured: false,
    setOidcConfigured: vi.fn(),
    requireMfa: false,
    setRequireMfa: vi.fn(),
    passkeyLogin: false,
    setPasskeyLogin: vi.fn(),
    passkeyConfigured: false,
    webauthnRpId: '',
    setWebauthnRpId: vi.fn(),
    webauthnOrigins: '',
    setWebauthnOrigins: vi.fn(),
    savingWebauthn: false,
    handleSaveWebauthn: vi.fn(),

    // invites
    invites: [] as unknown[],
    setInvites: vi.fn(),
    inviteTrips: [] as { id: number; title: string }[],
    showCreateInvite: false,
    setShowCreateInvite: vi.fn(),
    inviteForm: { max_uses: 1, expires_in_days: 7, trip_id: '' },
    setInviteForm: vi.fn(),

    // misc settings
    allowedFileTypes: 'jpg,png,pdf',
    setAllowedFileTypes: vi.fn(),
    savingFileTypes: false,
    setSavingFileTypes: vi.fn(),
    smtpValues: {},
    setSmtpValues: vi.fn(),
    smtpLoaded: true,
    mapsKey: '',
    setMapsKey: vi.fn(),
    weatherKey: '',
    setWeatherKey: vi.fn(),
    unsplashKey: '',
    setUnsplashKey: vi.fn(),
    amapKey: '',
    setAmapKey: vi.fn(),
    placesProvider: 'auto',
    savingPlacesProvider: false,
    showKeys: {},
    setShowKeys: vi.fn(),
    savingKeys: false,
    validating: {},
    validation: {},

    // update / danger zone
    updateInfo: null,
    setUpdateInfo: vi.fn(),
    showUpdateModal: false,
    setShowUpdateModal: vi.fn(),
    showRotateJwtModal: false,
    setShowRotateJwtModal: vi.fn(),
    rotatingJwt: false,
    setRotatingJwt: vi.fn(),

    // handlers
    loadData: vi.fn(),
    loadAppConfig: vi.fn(),
    loadApiKeys: vi.fn(),
    handleToggleAuthSetting: vi.fn(),
    handleToggleRequireMfa: vi.fn(),
    toggleKey: vi.fn(),
    handleSaveApiKeys: vi.fn(),
    handleValidateKeys: vi.fn(),
    handleValidateKey: vi.fn(),
    handleSavePlacesProvider: vi.fn(),
    handleCreateUser: vi.fn(),
    handleCreateInvite: vi.fn(),
    handleDeleteInvite: vi.fn(),
    copyInviteLink: vi.fn(),
    handleEditUser: vi.fn(),
    handleSaveUser: vi.fn(),
    handleDeleteUser: vi.fn(),
  };

  return { ...base, ...overrides } as unknown as AdminHook;
}
