import React from 'react'
import { adminApi, authApi } from '../../api/client'
import { getApiErrorMessage } from '../../types'
import { Eye, EyeOff, Save, CheckCircle, XCircle, Loader2, Sun, RefreshCw, AlertTriangle } from 'lucide-react'
import ToggleSwitch from '../../components/Settings/ToggleSwitch'
import type { TranslationFn } from '../../types'
import type { useAdmin } from './useAdmin'

interface AdminSettingsTabProps {
  admin: ReturnType<typeof useAdmin>
  t: TranslationFn
}

// "Settings" admin tab: auth methods, require-MFA, allowed file types, API keys,
// OIDC config and the danger zone. Pure layout around the useAdmin hook.
export default function AdminSettingsTab({ admin, t }: AdminSettingsTabProps): React.ReactElement {
  const {
    toast,
    setPlacesPhotosEnabled, setPlacesAutocompleteEnabled, setPlacesDetailsEnabled, setPlacesEnrichEnabled,
    placesPhotosEnabled, setPlacesPhotosEnabledState,
    placesAutocompleteEnabled, setPlacesAutocompleteEnabledState,
    placesDetailsEnabled, setPlacesDetailsEnabledState,
    placesEnrichEnabled, setPlacesEnrichEnabledState,
    oidcConfig, setOidcConfig, savingOidc, setSavingOidc,
    passwordLogin, setPasswordLogin, passwordRegistration, setPasswordRegistration,
    oidcLogin, setOidcLogin, oidcRegistration, setOidcRegistration,
    envOverrideOidcOnly, oidcConfigured, requireMfa,
    passkeyLogin, setPasskeyLogin, passkeyConfigured,
    webauthnRpId, setWebauthnRpId, webauthnOrigins, setWebauthnOrigins, savingWebauthn, handleSaveWebauthn,
    allowedFileTypes, setAllowedFileTypes, savingFileTypes, setSavingFileTypes,
    mapsKey, setMapsKey, unsplashKey, setUnsplashKey, amapKey, setAmapKey, showKeys, savingKeys, validating, validation,
    placesProvider, savingPlacesProvider, handleSavePlacesProvider,
    managed,
    setShowRotateJwtModal,
    handleToggleAuthSetting, handleToggleRequireMfa,
    toggleKey, handleSaveApiKeys, handleValidateKey,
  } = admin

  return (
    <div className="space-y-6">
      {/* Authentication Methods */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{t('admin.authMethods')}</h2>
        </div>
        <div className="p-6 space-y-5">
          {envOverrideOidcOnly && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {t('admin.envOverrideHint')}
            </p>
          )}
          {/* Password Login */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.passwordLogin')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.passwordLoginHint')}</p>
            </div>
            <button type="button"
              disabled={envOverrideOidcOnly || (!passwordLogin && !oidcLogin)}
              onClick={() => handleToggleAuthSetting('password_login', !passwordLogin, setPasswordLogin)}
              title={!passwordLogin && !oidcLogin ? t('admin.lockoutWarning') : undefined}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${passwordLogin ? 'bg-content' : 'bg-edge'}`}
            >
              <span
                className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                style={{ transform: passwordLogin ? 'translateX(20px)' : 'translateX(0)' }}
              />
            </button>
          </div>
          {/* Password Registration */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.passwordRegistration')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.passwordRegistrationHint')}</p>
            </div>
            <button type="button"
              disabled={envOverrideOidcOnly}
              onClick={() => handleToggleAuthSetting('password_registration', !passwordRegistration, setPasswordRegistration)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${passwordRegistration ? 'bg-content' : 'bg-edge'}`}
            >
              <span
                className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                style={{ transform: passwordRegistration ? 'translateX(20px)' : 'translateX(0)' }}
              />
            </button>
          </div>
          {/* SSO Login (only when OIDC configured) */}
          {oidcConfigured && (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700">{t('admin.oidcLogin')}</p>
                <p className="text-xs text-slate-400 mt-0.5">{t('admin.oidcLoginHint')}</p>
              </div>
              <button type="button"
                disabled={!passwordLogin && oidcLogin}
                onClick={() => handleToggleAuthSetting('oidc_login', !oidcLogin, setOidcLogin)}
                title={!passwordLogin && oidcLogin ? t('admin.lockoutWarning') : undefined}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${oidcLogin ? 'bg-content' : 'bg-edge'}`}
              >
                <span
                  className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                  style={{ transform: oidcLogin ? 'translateX(20px)' : 'translateX(0)' }}
                />
              </button>
            </div>
          )}
          {/* SSO Registration (only when OIDC configured) */}
          {oidcConfigured && (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700">{t('admin.oidcRegistration')}</p>
                <p className="text-xs text-slate-400 mt-0.5">{t('admin.oidcRegistrationHint')}</p>
              </div>
              <button type="button"
                onClick={() => handleToggleAuthSetting('oidc_registration', !oidcRegistration, setOidcRegistration)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${oidcRegistration ? 'bg-content' : 'bg-edge'}`}
              >
                <span
                  className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                  style={{ transform: oidcRegistration ? 'translateX(20px)' : 'translateX(0)' }}
                />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Passkey (WebAuthn) login */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{t('admin.passkey.title')}</h2>
          <p className="text-xs text-slate-400 mt-1">{t('admin.passkey.cardHint')}</p>
        </div>
        <div className="p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.passkey.login')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.passkey.loginHint')}</p>
            </div>
            <button
              type="button"
              onClick={() => handleToggleAuthSetting('passkey_login', !passkeyLogin, setPasskeyLogin)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${passkeyLogin ? 'bg-content' : 'bg-edge'}`}
            >
              <span
                className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                style={{ transform: passkeyLogin ? 'translateX(20px)' : 'translateX(0)' }}
              />
            </button>
          </div>

          {passkeyLogin && !passkeyConfigured && (
            <p className="flex items-start gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              {t('admin.passkey.notConfigured')}
            </p>
          )}

          {/* The domain passkeys bind to and the origins that may present them
              follow from the address the instance is served on, which the operator
              owns. Getting either wrong invalidates every enrolled passkey, and on
              a shared parent domain a wrong RP ID reaches past this instance
              entirely — so they are pinned per container, not offered here. The
              switch above stays: whether to offer passkeys at all is a house rule. */}
          {!managed && (<>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.passkey.rpId')}</label>
            <p className="text-xs text-slate-400 mb-1.5">{t('admin.passkey.rpIdHint')}</p>
            <input
              type="text"
              value={webauthnRpId}
              onChange={e => setWebauthnRpId(e.target.value)}
              placeholder="trek.example.org"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.passkey.origins')}</label>
            <p className="text-xs text-slate-400 mb-1.5">{t('admin.passkey.originsHint')}</p>
            <input
              type="text"
              value={webauthnOrigins}
              onChange={e => setWebauthnOrigins(e.target.value)}
              placeholder="https://trek.example.org"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
          </div>
          <button
            type="button"
            onClick={handleSaveWebauthn}
            disabled={savingWebauthn}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:opacity-50"
          >
            {savingWebauthn ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {t('common.save')}
          </button>
          </>)}
        </div>
      </div>

      {/* Require 2FA for all users */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{t('admin.requireMfa')}</h2>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.requireMfa')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.requireMfaHint')}</p>
            </div>
            <button
              type="button"
              onClick={() => handleToggleRequireMfa(!requireMfa)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${requireMfa ? 'bg-content' : 'bg-edge'}`}
            >
              <span
                className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                style={{ transform: requireMfa ? 'translateX(20px)' : 'translateX(0)' }}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Allowed File Types */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{t('admin.fileTypes')}</h2>
          <p className="text-xs text-slate-400 mt-1">{t('admin.fileTypesHint')}</p>
        </div>
        <div className="p-6">
          <input
            type="text"
            value={allowedFileTypes}
            onChange={e => setAllowedFileTypes(e.target.value)}
            placeholder="jpg,png,pdf,doc,docx,xls,xlsx,txt,csv"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
          />
          <p className="text-xs text-slate-400 mt-2">{t('admin.fileTypesFormat')}</p>
          <button type="button"
            onClick={async () => {
              setSavingFileTypes(true)
              try {
                await authApi.updateAppSettings({ allowed_file_types: allowedFileTypes })
                toast.success(t('admin.fileTypesSaved'))
              } catch { toast.error(t('common.error')) }
              finally { setSavingFileTypes(false) }
            }}
            disabled={savingFileTypes}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400 mt-3"
          >
            {savingFileTypes ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
            {t('common.save')}
          </button>
        </div>
      </div>

      {/* Google and Unsplash come with the instance, and so does what a lookup costs;
          the per-place toggles only ever traded away quota that is not the customer’s
          to spend. Weather needs no key at all and has nothing to configure. */}
      {!managed && (<>
      {/* API Keys */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{t('admin.apiKeys')}</h2>
          <p className="text-xs text-slate-400 mt-1">{t('admin.apiKeysHint')}</p>
        </div>
        <div className="p-6 space-y-4">
          {/* The two key fields, not the toggles below them: on a centrally
              administered install the operator supplies the keys, while whether
              photos and lookups are offered at all stays the admin’s call. */}
          {!managed && (<>
          {/* Google Maps Key */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1.5">
              {t('admin.mapsKey')}
              <span className="text-[9px] font-medium px-1.5 py-px rounded-full bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200">{t('admin.recommended')}</span>
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKeys.maps ? 'text' : 'password'}
                  aria-label={t('admin.mapsKey')}
                  value={mapsKey}
                  onChange={e => setMapsKey(e.target.value)}
                  placeholder={t('settings.keyPlaceholder')}
                  className="w-full pr-10 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => toggleKey('maps')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showKeys.maps ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <button type="button"
                onClick={() => handleValidateKey('maps')}
                disabled={!mapsKey || validating.maps}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {validating.maps ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : validation.maps === true ? (
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                ) : validation.maps === false ? (
                  <XCircle className="w-4 h-4 text-red-500" />
                ) : null}
                {t('admin.validateKey')}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">{t('admin.mapsKeyHintLong')}</p>
            {validation.maps === true && (
              <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                <span className="w-2 h-2 bg-emerald-500 rounded-full inline-block"></span>
                {t('admin.keyValid')}
              </p>
            )}
            {validation.maps === false && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <span className="w-2 h-2 bg-red-500 rounded-full inline-block"></span>
                {t('admin.keyInvalid')}
              </p>
            )}
          </div>

          {/* Amap Key. No Test button: /auth/validate-keys only knows how to
              probe Google Places and OpenWeatherMap, and a button that silently
              tests something else is worse than no button. */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1.5">
              {t('admin.amapKey')}
            </label>
            <div className="relative">
              <input
                type={showKeys.amap ? 'text' : 'password'}
                aria-label={t('admin.amapKey')}
                value={amapKey}
                onChange={e => setAmapKey(e.target.value)}
                placeholder={t('settings.keyPlaceholder')}
                className="w-full pr-10 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => toggleKey('amap')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showKeys.amap ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">{t('admin.amapKeyHint')}</p>
          </div>

          {/* Unsplash Key */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1.5">
              {t('admin.unsplashKey')}
            </label>
            <div className="relative">
              <input
                type={showKeys.unsplash ? 'text' : 'password'}
                aria-label={t('admin.unsplashKey')}
                value={unsplashKey}
                onChange={e => setUnsplashKey(e.target.value)}
                placeholder={t('settings.keyPlaceholder')}
                className="w-full pr-10 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => toggleKey('unsplash')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showKeys.unsplash ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">{t('admin.unsplashKeyHint')}</p>
          </div>
          </>)}

          {/* Which provider answers place search. Shown on a managed install too:
              the operator owns the credentials, but what their users search
              against is still the admin's call (see server managed.ts). */}
          <div className="py-3 border-t border-slate-100">
            <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor="places-provider">
              {t('admin.placesProvider.title')}
            </label>
            <select
              id="places-provider"
              value={placesProvider}
              disabled={savingPlacesProvider}
              onChange={e => handleSavePlacesProvider(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent disabled:opacity-50"
            >
              <option value="auto">{t('admin.placesProvider.auto')}</option>
              <option value="google">{t('admin.placesProvider.google')}</option>
              <option value="amap">{t('admin.placesProvider.amap')}</option>
              <option value="openstreetmap">{t('admin.placesProvider.openstreetmap')}</option>
            </select>
            <p className="text-xs text-slate-400 mt-1">{t('admin.placesProvider.subtitle')}</p>
            {/* A provider chosen without a key behind it answers with
                OpenStreetMap rather than failing, which is quiet enough to be
                mistaken for the provider working. Say so. */}
            {((placesProvider === 'google' && !mapsKey) || (placesProvider === 'amap' && !amapKey)) && (
              <p className="text-xs text-amber-600 mt-1">{t('admin.placesProvider.missingKey')}</p>
            )}
          </div>

          {/* Place Photos Toggle */}
          <div className="flex items-center justify-between gap-4 py-3 border-t border-slate-100">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.placesPhotos.title')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.placesPhotos.subtitle')}</p>
            </div>
            <ToggleSwitch
              on={placesPhotosEnabled}
              label={t('admin.placesPhotos.title')}
              onToggle={async () => {
                const next = !placesPhotosEnabled
                setPlacesPhotosEnabledState(next)
                setPlacesPhotosEnabled(next)
                try { await adminApi.updatePlacesPhotos(next) } catch { setPlacesPhotosEnabledState(!next); setPlacesPhotosEnabled(!next) }
              }}
            />
          </div>

          {/* Place Autocomplete Toggle */}
          <div className="flex items-center justify-between gap-4 py-3 border-t border-slate-100">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.placesAutocomplete.title')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.placesAutocomplete.subtitle')}</p>
            </div>
            <ToggleSwitch
              on={placesAutocompleteEnabled}
              label={t('admin.placesAutocomplete.title')}
              onToggle={async () => {
                const next = !placesAutocompleteEnabled
                setPlacesAutocompleteEnabledState(next)
                setPlacesAutocompleteEnabled(next)
                try { await adminApi.updatePlacesAutocomplete(next) } catch { setPlacesAutocompleteEnabledState(!next); setPlacesAutocompleteEnabled(!next) }
              }}
            />
          </div>

          {/* Place Details Toggle */}
          <div className="flex items-center justify-between gap-4 py-3 border-t border-slate-100">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.placesDetails.title')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.placesDetails.subtitle')}</p>
            </div>
            <ToggleSwitch
              on={placesDetailsEnabled}
              label={t('admin.placesDetails.title')}
              onToggle={async () => {
                const next = !placesDetailsEnabled
                setPlacesDetailsEnabledState(next)
                setPlacesDetailsEnabled(next)
                try { await adminApi.updatePlacesDetails(next) } catch { setPlacesDetailsEnabledState(!next); setPlacesDetailsEnabled(!next) }
              }}
            />
          </div>

          {/* Place Enrichment Toggle */}
          <div className="flex items-center justify-between gap-4 py-3 border-t border-slate-100">
            <div>
              <p className="text-sm font-medium text-slate-700">{t('admin.placesEnrich.title')}</p>
              <p className="text-xs text-slate-400 mt-0.5">{t('admin.placesEnrich.subtitle')}</p>
            </div>
            <ToggleSwitch
              on={placesEnrichEnabled}
              label={t('admin.placesEnrich.title')}
              onToggle={async () => {
                const next = !placesEnrichEnabled
                setPlacesEnrichEnabledState(next)
                setPlacesEnrichEnabled(next)
                try { await adminApi.updatePlacesEnrich(next) } catch { setPlacesEnrichEnabledState(!next); setPlacesEnrichEnabled(!next) }
              }}
            />
          </div>

          {/* Open-Meteo Weather Info */}
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center flex-shrink-0">
                  <Sun className="w-3.5 h-3.5 text-white" />
                </div>
                <span className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.title')}</span>
              </div>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200">{t('admin.weather.badge')}</span>
            </div>
            <div className="px-4 pb-3">
              <p className="text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed">{t('admin.weather.description')}</p>
              <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1.5 leading-relaxed">{t('admin.weather.locationHint')}</p>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="rounded-md bg-white dark:bg-emerald-900/40 px-3 py-2 border border-emerald-100 dark:border-emerald-800">
                  <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.forecast')}</p>
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('admin.weather.forecastDesc')}</p>
                </div>
                <div className="rounded-md bg-white dark:bg-emerald-900/40 px-3 py-2 border border-emerald-100 dark:border-emerald-800">
                  <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.climate')}</p>
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('admin.weather.climateDesc')}</p>
                </div>
                <div className="rounded-md bg-white dark:bg-emerald-900/40 px-3 py-2 border border-emerald-100 dark:border-emerald-800">
                  <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">{t('admin.weather.requests')}</p>
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('admin.weather.requestsDesc')}</p>
                </div>
              </div>
            </div>
          </div>

          <button type="button"
            onClick={handleSaveApiKeys}
            disabled={savingKeys}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
          >
            {savingKeys ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
            {t('common.save')}
          </button>
        </div>
      </div>

      {/* An issuer the instance names can assert any address as verified, and the
          discovery calls leave from inside the operator’s network. Sign-on is theirs
          to wire, so the fields are not offered. */}
      {!managed && (<>
      </>)}
      {/* OIDC / SSO Configuration */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">{t('admin.oidcTitle')}</h2>
          <p className="text-xs text-slate-400 mt-1">{t('admin.oidcSubtitle')}</p>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('admin.oidcDisplayName')}</label>
            <input
              type="text"
              value={oidcConfig.display_name}
              onChange={e => setOidcConfig(c => ({ ...c, display_name: e.target.value }))}
              placeholder='z.B. Google, Authentik, Keycloak'
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('admin.oidcIssuer')}</label>
            <input
              type="url"
              value={oidcConfig.issuer}
              onChange={e => setOidcConfig(c => ({ ...c, issuer: e.target.value }))}
              placeholder='https://accounts.google.com'
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
            <p className="text-xs text-slate-400 mt-1">{t('admin.oidcIssuerHint')}</p>
          </div>
          <div>
            <label htmlFor="oidc-discovery-url" className="block text-sm font-medium text-slate-700 mb-1.5">Discovery URL <span className="text-slate-400 font-normal">(optional)</span></label>
            <input
              id="oidc-discovery-url"
              type="url"
              value={oidcConfig.discovery_url}
              onChange={e => setOidcConfig(c => ({ ...c, discovery_url: e.target.value }))}
              placeholder='https://auth.example.com/application/o/trek/.well-known/openid-configuration'
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
            <p className="text-xs text-slate-400 mt-1">Override the auto-constructed discovery URL. Required for providers like Authentik where the endpoint is not at <code className="bg-slate-100 px-1 rounded">{'<issuer>/.well-known/openid-configuration'}</code>.</p>
          </div>
          <div>
            <label htmlFor="oidc-client-id" className="block text-sm font-medium text-slate-700 mb-1.5">Client ID</label>
            <input
              id="oidc-client-id"
              type="text"
              value={oidcConfig.client_id}
              onChange={e => setOidcConfig(c => ({ ...c, client_id: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="oidc-client-secret" className="block text-sm font-medium text-slate-700 mb-1.5">Client Secret</label>
            <input
              id="oidc-client-secret"
              type="password"
              value={oidcConfig.client_secret}
              onChange={e => setOidcConfig(c => ({ ...c, client_secret: e.target.value }))}
              placeholder={oidcConfig.client_secret_set ? '••••••••' : ''}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
            />
          </div>
          <button type="button"
            onClick={async () => {
              setSavingOidc(true)
              try {
                const payload: Record<string, unknown> = { issuer: oidcConfig.issuer, client_id: oidcConfig.client_id, display_name: oidcConfig.display_name, discovery_url: oidcConfig.discovery_url }
                if (oidcConfig.client_secret) payload.client_secret = oidcConfig.client_secret
                await adminApi.updateOidc(payload)
                toast.success(t('admin.oidcSaved'))
              } catch (err: unknown) {
                toast.error(getApiErrorMessage(err, t('common.error')))
              } finally {
                setSavingOidc(false)
              }
            }}
            disabled={savingOidc}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
          >
            {savingOidc ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
            {t('common.save')}
          </button>
        </div>
      </div>
      {/* Rotating the secret signs every user out and fixes nothing an instance admin
          can reach: the file it writes belongs to the host. */}
      {!managed && (<>
      </>)}
      {/* Danger Zone */}
      <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-red-100 bg-red-50">
          <h2 className="font-semibold text-red-700 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Danger Zone
          </h2>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-700">Rotate JWT Secret</p>
              <p className="text-xs text-slate-400 mt-0.5">Generate a new JWT signing secret. All active sessions will be invalidated immediately.</p>
            </div>
            <button type="button"
              onClick={() => setShowRotateJwtModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Rotate
            </button>
          </div>
        </div>
      </div>
      </>)}
    </div>
  )
}