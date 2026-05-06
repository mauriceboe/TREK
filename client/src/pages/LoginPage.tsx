import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { SUPPORTED_LANGUAGES, useTranslation, detectBrowserLanguage } from '../i18n'
import { authApi, configApi } from '../api/client'
import { hasStoredLanguage } from '../store/settingsStore'
import { getApiErrorMessage } from '../types'
import { Plane, Eye, EyeOff, Mail, Lock, MapPin, Calendar, Package, User, Globe, Zap, Users, Wallet, Map, CheckSquare, BookMarked, FolderOpen, Route, Shield, KeyRound, ChevronDown } from 'lucide-react'

interface AppConfig {
  has_users: boolean
  allow_registration: boolean
  setup_complete: boolean
  demo_mode: boolean
  oidc_configured: boolean
  oidc_display_name?: string
  oidc_only_mode: boolean
  password_login: boolean
  password_registration: boolean
  oidc_login: boolean
  oidc_registration: boolean
  env_override_oidc_only: boolean
}

export default function LoginPage(): React.ReactElement {
  const { t, language } = useTranslation()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState<string>('')
  const [email, setEmail] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [showPassword, setShowPassword] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null)
  const [inviteToken, setInviteToken] = useState<string>('')
  const [inviteValid, setInviteValid] = useState<boolean>(false)
  const exchangeInitiated = useRef(false)

  const [langDropdownOpen, setLangDropdownOpen] = useState<boolean>(false)

  const { login, register, demoLogin, completeMfaLogin, loadUser } = useAuthStore()
  const { setLanguageLocal, setLanguageTransient } = useSettingsStore()
  const navigate = useNavigate()
  const location = useLocation()
  const noRedirect = !!(location.state as { noRedirect?: boolean } | null)?.noRedirect

  const redirectTarget = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const redirect = params.get('redirect')
    // Only allow relative paths starting with / to prevent open redirect attacks
    if (redirect && redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.startsWith('/\\')) {
      return redirect
    }
    return '/dashboard'
  }, [])

  useEffect(() => {
    if (redirectTarget !== '/dashboard') {
      sessionStorage.setItem('oidc_redirect', redirectTarget)
    }
  }, [redirectTarget])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    const invite = params.get('invite')
    const oidcCode = params.get('oidc_code')
    const oidcError = params.get('oidc_error')

    if (invite) {
      setInviteToken(invite)
      setMode('register')
      authApi.validateInvite(invite).then(() => {
        setInviteValid(true)
      }).catch(() => {
        setError(t('login.invalidInviteLink'))
      })
      window.history.replaceState({}, '', window.location.pathname)
    }

    if (oidcCode) {
      if (exchangeInitiated.current) return
      exchangeInitiated.current = true
      setIsLoading(true)
      fetch('/api/auth/oidc/exchange?code=' + encodeURIComponent(oidcCode), { credentials: 'include' })
        .then(r => r.json())
        .then(async data => {
          window.history.replaceState({}, '', '/login')
          if (data.token) {
            await loadUser()
            const savedRedirect = sessionStorage.getItem('oidc_redirect') || '/dashboard'
            sessionStorage.removeItem('oidc_redirect')
            navigate(savedRedirect, { replace: true })
          } else {
            setError(data.error || t('login.oidcFailed'))
          }
        })
        .catch(() => {
          window.history.replaceState({}, '', '/login')
          setError(t('login.oidcFailed'))
        })
        .finally(() => setIsLoading(false))
      return
    }

    if (oidcError) {
      const errorMessages: Record<string, string> = {
        registration_disabled: t('login.oidc.registrationDisabled'),
        no_email: t('login.oidc.noEmail'),
        token_failed: t('login.oidc.tokenFailed'),
        invalid_state: t('login.oidc.invalidState'),
      }
      setError(errorMessages[oidcError] || oidcError)
      sessionStorage.removeItem('oidc_redirect')
      window.history.replaceState({}, '', '/login')
      return
    }

    const CONFIG_CACHE_KEY = 'trek_app_config_cache'
    authApi.getAppConfig?.()
      .then((config: AppConfig) => {
        try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(config)) } catch { /* ignore quota errors */ }
        return { config, fromCache: false }
      })
      .catch(() => {
        try {
          const raw = localStorage.getItem(CONFIG_CACHE_KEY)
          return raw ? { config: JSON.parse(raw) as AppConfig, fromCache: true } : { config: null as AppConfig | null, fromCache: false }
        } catch { return { config: null as AppConfig | null, fromCache: false } }
      })
      .then(({ config, fromCache }) => {
        if (config) {
          setAppConfig(config)
          if (!config.has_users) setMode('register')
          // Skip auto-redirect when config is from cache — network is unreliable
          // and auto-redirecting to the IdP could loop if the proxy changed.
          if (!fromCache && !config.password_login && config.oidc_login && config.oidc_configured && config.has_users && !invite && !noRedirect) {
            window.location.href = '/api/auth/oidc/login'
          }
        }
      })
  }, [navigate, t, noRedirect])

  // Language detection chain (runs once on mount, only if user has no saved preference):
  // 1. localStorage → already in store initial state, skip
  // 2. Browser/OS language (navigator.languages)
  // 3. Server default (DEFAULT_LANGUAGE env var)
  // 4. 'en' → hardcoded fallback already in store
  useEffect(() => {
    if (hasStoredLanguage()) return

    const detected = detectBrowserLanguage()
    if (detected) {
      setLanguageTransient(detected)
      return
    }

    configApi.getPublicConfig()
      .then(({ defaultLanguage }) => { if (defaultLanguage) setLanguageTransient(defaultLanguage) })
      .catch((err) => console.warn('Failed to fetch default language config:', err))
  }, [setLanguageTransient])

  useEffect(() => {
    if (!langDropdownOpen) return
    const close = () => setLangDropdownOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [langDropdownOpen])

  const handleDemoLogin = async (): Promise<void> => {
    setError('')
    setIsLoading(true)
    try {
      await demoLogin()
      setShowTakeoff(true)
      setTimeout(() => navigate(redirectTarget), 2600)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.demoFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  const [showTakeoff, setShowTakeoff] = useState<boolean>(false)
  const [mfaStep, setMfaStep] = useState(false)
  const [mfaToken, setMfaToken] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [passwordChangeStep, setPasswordChangeStep] = useState(false)
  const [savedLoginPassword, setSavedLoginPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setError('')
    setIsLoading(true)
    try {
      if (passwordChangeStep) {
        if (!newPassword) { setError(t('settings.passwordRequired')); setIsLoading(false); return }
        if (newPassword.length < 8) { setError(t('settings.passwordTooShort')); setIsLoading(false); return }
        if (newPassword !== confirmPassword) { setError(t('settings.passwordMismatch')); setIsLoading(false); return }
        await authApi.changePassword({ current_password: savedLoginPassword, new_password: newPassword })
        await loadUser({ silent: true })
        setShowTakeoff(true)
        setTimeout(() => navigate(redirectTarget), 2600)
        return
      }
      if (mode === 'login' && mfaStep) {
        if (!mfaCode.trim()) {
          setError(t('login.mfaCodeRequired'))
          setIsLoading(false)
          return
        }
        const mfaResult = await completeMfaLogin(mfaToken, mfaCode)
        if ('user' in mfaResult && mfaResult.user?.must_change_password) {
          setSavedLoginPassword(password)
          setPasswordChangeStep(true)
          setIsLoading(false)
          return
        }
        setShowTakeoff(true)
        setTimeout(() => navigate(redirectTarget), 2600)
        return
      }
      if (mode === 'register') {
        if (!username.trim()) { setError(t('login.usernameRequired')); setIsLoading(false); return }
        if (password.length < 8) { setError(t('login.passwordMinLength')); setIsLoading(false); return }
        await register(username, email, password, inviteToken || undefined)
      } else {
        const result = await login(email, password)
        if ('mfa_required' in result && result.mfa_required && 'mfa_token' in result) {
          setMfaToken(result.mfa_token)
          setMfaStep(true)
          setMfaCode('')
          setIsLoading(false)
          return
        }
        if ('user' in result && result.user?.must_change_password) {
          setSavedLoginPassword(password)
          setPasswordChangeStep(true)
          setIsLoading(false)
          return
        }
      }
      setShowTakeoff(true)
      setTimeout(() => navigate(redirectTarget), 2600)
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('login.error')))
      setIsLoading(false)
    }
  }

  const showRegisterOption = (appConfig?.password_registration || !appConfig?.has_users || inviteValid) && (appConfig?.setup_complete !== false || !appConfig?.has_users)

  // In OIDC-only mode, show a minimal page that redirects directly to the IdP
  const oidcOnly = !appConfig?.password_login && appConfig?.oidc_login && appConfig?.oidc_configured

  const inputBase: React.CSSProperties = {
    width: '100%', padding: '11px 12px 11px 40px', border: '1px solid #e5e7eb',
    borderRadius: 12, fontSize: 14, fontFamily: 'inherit', outline: 'none',
    color: '#111827', background: 'white', boxSizing: 'border-box', transition: 'border-color 0.15s',
  }

  if (showTakeoff) {
    return (
      <div className="takeoff-overlay" style={{ position: 'fixed', inset: 0, zIndex: 99999, overflow: 'hidden' }}>
        {/* Sky gradient */}
        <div className="takeoff-sky" style={{ position: 'absolute', inset: 0 }} />

        {/* Stars */}
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} className="takeoff-star" style={{
            position: 'absolute',
            width: Math.random() > 0.7 ? 3 : 1.5,
            height: Math.random() > 0.7 ? 3 : 1.5,
            borderRadius: '50%',
            background: 'white',
            top: `${Math.random() * 100}%`,
            left: `${Math.random() * 100}%`,
            animationDelay: `${0.3 + Math.random() * 0.5}s, ${Math.random() * 1}s`,
          }} />
        ))}

        {/* Clouds rushing past */}
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="takeoff-cloud" style={{
            position: 'absolute',
            width: 120 + i * 40,
            height: 40 + i * 10,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            filter: 'blur(8px)',
            right: -200,
            top: `${25 + i * 12}%`,
            animationDelay: `${0.3 + i * 0.25}s`,
          }} />
        ))}

        {/* Speed lines */}
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="takeoff-speedline" style={{
            position: 'absolute',
            width: 80 + Math.random() * 120,
            height: 1.5,
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
            top: `${10 + Math.random() * 80}%`,
            right: -200,
            animationDelay: `${0.5 + i * 0.12}s`,
          }} />
        ))}

        {/* Plane */}
        <div className="takeoff-plane" style={{ position: 'absolute', left: '50%', bottom: '10%', transform: 'translate(-50%, 0)' }}>
          <svg viewBox="0 0 480 120" style={{ width: 200, filter: 'drop-shadow(0 0 20px rgba(255,255,255,0.3))' }}>
            <g fill="white" transform="translate(240,60) rotate(-12)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <path d="M-100,-5 L-120,-30 L-108,-30 L-90,-8 Z" />
              <path d="M-100,5 L-120,30 L-108,30 L-90,8 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>
        </div>

        {/* Contrail */}
        <div className="takeoff-trail" style={{
          position: 'absolute', left: '50%', bottom: '8%',
          width: 3, height: 0, background: 'linear-gradient(to top, transparent, rgba(255,255,255,0.5))',
          transformOrigin: 'bottom center',
        }} />

        {/* Logo fade in + burst */}
        <div className="takeoff-logo" style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        }}>
          <img src="/logo-light.svg" alt="TREK" style={{ height: 72 }} />
          <p style={{ margin: 0, fontSize: 20, color: 'rgba(255,255,255,0.6)', fontFamily: "'MuseoModerno', sans-serif", textTransform: 'lowercase', whiteSpace: 'nowrap' }}>{t('login.tagline')}</p>
        </div>


        <style>{`
          .takeoff-sky {
            background: linear-gradient(to top, #1a1a2e 0%, #16213e 30%, #0f3460 60%, #0a0a23 100%);
            animation: skyShift 2.6s ease-in-out forwards;
          }
          @keyframes skyShift {
            0%   { background: linear-gradient(to top, #0a0a23 0%, #0f172a 40%, #111827 100%); }
            100% { background: linear-gradient(to top, #000011 0%, #000016 50%, #000011 100%); }
          }

          .takeoff-star {
            opacity: 0;
            animation: starAppear 0.5s ease-out forwards, starTwinkle 2s ease-in-out infinite alternate;
          }
          @keyframes starAppear {
            0%   { opacity: 0; transform: scale(0); }
            100% { opacity: 0.7; transform: scale(1); }
          }
          @keyframes starTwinkle {
            0%   { opacity: 0.3; }
            100% { opacity: 0.9; }
          }

          .takeoff-cloud {
            animation: cloudRush 0.6s ease-in forwards;
          }
          @keyframes cloudRush {
            0%   { right: -200px; opacity: 0; }
            20%  { opacity: 0.4; }
            100% { right: 120%; opacity: 0; }
          }

          .takeoff-speedline {
            animation: speedRush 0.4s ease-in forwards;
          }
          @keyframes speedRush {
            0%   { right: -200px; opacity: 0; }
            30%  { opacity: 0.6; }
            100% { right: 120%; opacity: 0; }
          }

          .takeoff-plane {
            animation: planeUp 1s ease-in forwards;
          }
          @keyframes planeUp {
            0%   { transform: translate(-50%, 0) rotate(0deg) scale(1); bottom: 8%; left: 50%; opacity: 1; }
            100% { transform: translate(-50%, 0) rotate(-22deg) scale(0.15); bottom: 120%; left: 58%; opacity: 0; }
          }

          .takeoff-trail {
            animation: trailGrow 0.9s ease-out 0.15s forwards;
          }
          @keyframes trailGrow {
            0%   { height: 0; opacity: 0; transform: translateX(-50%) rotate(-5deg); }
            30%  { height: 150px; opacity: 0.6; }
            60%  { height: 350px; opacity: 0.4; }
            100% { height: 600px; opacity: 0; transform: translateX(-50%) rotate(-8deg); }
          }

          .takeoff-logo {
            opacity: 0;
            animation: logoReveal 0.5s ease-out 0.9s forwards;
          }
          @keyframes logoReveal {
            0%   { opacity: 0; transform: translate(-50%, -40%) scale(0.9); }
            100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          }
        `}</style>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif", position: 'relative' }}>

      {/* Language dropdown */}
      <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
        <button
          onClick={(e) => { e.stopPropagation(); setLangDropdownOpen(o => !o) }}
          aria-haspopup="listbox"
          aria-expanded={langDropdownOpen}
          aria-label="Change language"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: 99,
            background: 'rgba(0,0,0,0.06)', border: 'none',
            fontSize: 13, fontWeight: 500, color: '#374151',
            cursor: 'pointer', fontFamily: 'inherit',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = 'rgba(0,0,0,0.1)'}
          onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = 'rgba(0,0,0,0.06)'}
        >
          <Globe size={14} />
          {SUPPORTED_LANGUAGES.find(l => l.value === language)?.label ?? language.toUpperCase()}
          <ChevronDown size={12} style={{ transition: 'transform 0.15s', transform: langDropdownOpen ? 'rotate(180deg)' : 'none' }} />
        </button>

        {langDropdownOpen && (
          <div
            role="listbox"
            aria-label="Select language"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 4,
              background: 'white', borderRadius: 12,
              boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
              border: '1px solid rgba(0,0,0,0.08)',
              minWidth: 190, maxHeight: 320, overflowY: 'auto',
            }}
          >
            {SUPPORTED_LANGUAGES.map(({ value, label }) => (
              <button
                key={value}
                role="option"
                aria-selected={value === language}
                onClick={() => { setLanguageLocal(value); setLangDropdownOpen(false) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '9px 16px', border: 'none',
                  background: value === language ? 'rgba(99,102,241,0.08)' : 'transparent',
                  color: value === language ? '#4f46e5' : '#374151',
                  fontWeight: value === language ? 600 : 400,
                  fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { if (value !== language) e.currentTarget.style.background = 'rgba(0,0,0,0.04)' }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { if (value !== language) e.currentTarget.style.background = 'transparent' }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Left — branding */}
      <div style={{ display: 'none', width: '55%', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '60px 48px', position: 'relative', overflow: 'hidden' }}
        className="lg-panel">
        <style>{`@media(min-width:1024px){.lg-panel{display:flex!important}}`}</style>

        {/* Stars */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
          {Array.from({ length: 40 }, (_, i) => (
            <div key={i} className="login-star" style={{
              position: 'absolute',
              width: Math.random() > 0.7 ? 2 : 1,
              height: Math.random() > 0.7 ? 2 : 1,
              borderRadius: '50%',
              background: 'white',
              opacity: 0.15 + Math.random() * 0.25,
              top: `${Math.random() * 70}%`,
              left: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 4}s`,
            }} />
          ))}
        </div>

        {/* Animated glow orbs */}
        <div className="login-orb1" style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)', filter: 'blur(80px)' }} />
        <div className="login-orb2" style={{ position: 'absolute', width: 350, height: 350, borderRadius: '50%', background: 'radial-gradient(circle, rgba(14,165,233,0.08) 0%, transparent 70%)', filter: 'blur(60px)' }} />

        {/* Animated planes — realistic silhouettes at different sizes/speeds */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          {/* Plane 1 — large, slow, foreground */}
          <svg className="login-plane1" viewBox="0 0 480 120" style={{ position: 'absolute', width: 48, opacity: 0.12 }}>
            <g fill="white" transform="translate(240,60) rotate(-12)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <path d="M-100,-5 L-120,-30 L-108,-30 L-90,-8 Z" />
              <path d="M-100,5 L-120,30 L-108,30 L-90,8 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 2 — small, faster, higher */}
          <svg className="login-plane2" viewBox="0 0 480 120" style={{ position: 'absolute', width: 24, opacity: 0.08 }}>
            <g fill="white" transform="translate(240,60) rotate(-12)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 3 — medium, mid-speed */}
          <svg className="login-plane3" viewBox="0 0 480 120" style={{ position: 'absolute', width: 32, opacity: 0.06 }}>
            <g fill="white" transform="translate(240,60) rotate(-5)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <path d="M-100,-5 L-120,-30 L-108,-30 L-90,-8 Z" />
              <path d="M-100,5 L-120,30 L-108,30 L-90,8 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 4 — tiny, fast, high */}
          <svg className="login-plane4" viewBox="0 0 480 120" style={{ position: 'absolute', width: 16, opacity: 0.07 }}>
            <g fill="white" transform="translate(240,60) rotate(-10)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 5 — medium, right to left, lower */}
          <svg className="login-plane5" viewBox="0 0 480 120" style={{ position: 'absolute', width: 28, opacity: 0.05 }}>
            <g fill="white" transform="translate(240,60) rotate(8) scale(-1,1)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <path d="M-100,-5 L-120,-30 L-108,-30 L-90,-8 Z" />
              <path d="M-100,5 L-120,30 L-108,30 L-90,8 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 6 — tiny distant */}
          <svg className="login-plane6" viewBox="0 0 480 120" style={{ position: 'absolute', width: 12, opacity: 0.04 }}>
            <g fill="white" transform="translate(240,60) rotate(-15)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>
        </div>


        <div style={{ position: 'relative', zIndex: 1, maxWidth: 560, textAlign: 'center' }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 48 }}>
            <img src="/logo-light.svg" alt="TREK" style={{ height: 64 }} />
          </div>

          <h2 style={{ margin: '0 0 12px', fontSize: 36, fontWeight: 700, color: 'white', lineHeight: 1.15, letterSpacing: '-0.02em', fontFamily: "'MuseoModerno', sans-serif", textTransform: 'lowercase' }}>
            {t('login.tagline')}
          </h2>
          <p style={{ margin: '0 0 44px', fontSize: 15, color: 'rgba(255,255,255,0.5)', lineHeight: 1.7 }}>
            {t('login.description')}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {[
              { Icon: Map, label: t('login.features.maps'), desc: t('login.features.mapsDesc') },
              { Icon: Zap, label: t('login.features.realtime'), desc: t('login.features.realtimeDesc') },
              { Icon: Wallet, label: t('login.features.budget'), desc: t('login.features.budgetDesc') },
              { Icon: Users, label: t('login.features.collab'), desc: t('login.features.collabDesc') },
              { Icon: CheckSquare, label: t('login.features.packing'), desc: t('login.features.packingDesc') },
              { Icon: BookMarked, label: t('login.features.bookings'), desc: t('login.features.bookingsDesc') },
              { Icon: FolderOpen, label: t('login.features.files'), desc: t('login.features.filesDesc') },
              { Icon: Route, label: t('login.features.routes'), desc: t('login.features.routesDesc') },
            ].map(({ Icon, label, desc }) => (
              <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 14, padding: '14px 12px', border: '1px solid rgba(255,255,255,0.06)', textAlign: 'left', transition: 'background 200ms cubic-bezier(0.23,1,0.32,1), border-color 200ms cubic-bezier(0.23,1,0.32,1)' }}
                onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)' }}
                onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)' }}>
                <Icon size={17} style={{ color: 'rgba(255,255,255,0.7)', marginBottom: 7 }} />
                <div style={{ fontSize: 12.5, color: 'white', fontWeight: 600, marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.4 }}>{desc}</div>
              </div>
            ))}
          </div>

          <p style={{ marginTop: 36, fontSize: 11.5, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.03em' }}>
            {t('login.selfHosted')}
          </p>
        </div>
      </div>

      {/* Right — form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 24px', background: '#f9fafb' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>

          {/* Mobile logo */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginBottom: 36 }}
            className="mobile-logo">
            <style>{`@media(min-width:1024px){.mobile-logo{display:none!important}}`}</style>
            <img src="/logo-dark.svg" alt="TREK" style={{ height: 48 }} />
            <p style={{ margin: 0, fontSize: 16, color: '#9ca3af', fontFamily: "'MuseoModerno', sans-serif", textTransform: 'lowercase', whiteSpace: 'nowrap' }}>{t('login.tagline')}</p>
          </div>

          <div style={{ background: 'white', borderRadius: 20, border: '1px solid #e5e7eb', padding: '36px 32px', boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>
            {oidcOnly ? (
              <>
                <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#111827' }}>{t('login.title')}</h2>
                <p style={{ margin: '0 0 24px', fontSize: 13.5, color: '#9ca3af' }}>{noRedirect ? t('login.oidcLoggedOut') : t('login.oidcOnly')}</p>
                {error && (
                  <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, fontSize: 13, color: '#dc2626', marginBottom: 16 }}>
                    {error}
                  </div>
                )}
                <a href={`/api/auth/oidc/login${inviteToken ? '?invite=' + encodeURIComponent(inviteToken) : ''}`}
                  style={{
                    width: '100%', padding: '12px',
                    background: '#111827', color: 'white',
                    border: 'none', borderRadius: 12,
                    fontSize: 14, fontWeight: 700, cursor: 'pointer',
                    fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    textDecoration: 'none', transition: 'background 180ms cubic-bezier(0.23,1,0.32,1)',
                    boxSizing: 'border-box',
                  }}
                  onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.background = '#1f2937' }}
                  onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.background = '#111827' }}
                >
                  <Shield size={16} />
                  {t('login.oidcSignIn', { name: appConfig?.oidc_display_name || 'SSO' })}
                </a>
              </>
            ) : (
            <>
            <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#111827' }}>
              {passwordChangeStep
                ? t('login.setNewPassword')
                : mode === 'login' && mfaStep
                  ? t('login.mfaTitle')
                  : mode === 'register'
                    ? (!appConfig?.has_users ? t('login.createAdmin') : t('login.createAccount'))
                    : t('login.title')}
            </h2>
            <p style={{ margin: '0 0 28px', fontSize: 13.5, color: '#9ca3af' }}>
              {passwordChangeStep
                ? t('login.setNewPasswordHint')
                : mode === 'login' && mfaStep
                  ? t('login.mfaSubtitle')
                  : mode === 'register'
                    ? (!appConfig?.has_users ? t('login.createAdminHint') : t('login.createAccountHint'))
                    : t('login.subtitle')}
            </p>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {error && (
                <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, fontSize: 13, color: '#dc2626' }}>
                  {error}
                </div>
              )}

              {passwordChangeStep && (
                <>
                  <div style={{ padding: '10px 14px', background: '#fefce8', border: '1px solid #fde68a', borderRadius: 10, fontSize: 13, color: '#92400e' }}>
                    {t('settings.mustChangePassword')}
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('settings.newPassword')}</label>
                    <div style={{ position: 'relative' }}>
                      <Lock size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                      <input
                        type="password" value={newPassword} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPassword(e.target.value)} required
                        placeholder={t('settings.newPassword')} style={inputBase}
                        onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#111827'}
                        onBlur={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#e5e7eb'}
                      />
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('settings.confirmPassword')}</label>
                    <div style={{ position: 'relative' }}>
                      <Lock size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                      <input
                        type="password" value={confirmPassword} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)} required
                        placeholder={t('settings.confirmPassword')} style={inputBase}
                        onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#111827'}
                        onBlur={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#e5e7eb'}
                      />
                    </div>
                  </div>
                </>
              )}

              {mode === 'login' && mfaStep && !passwordChangeStep && (
                <div>
                  <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('login.mfaCodeLabel')}</label>
                  <div style={{ position: 'relative' }}>
                    <KeyRound size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                    <input
                      type="text"
                      inputMode="text"
                      autoComplete="one-time-code"
                      value={mfaCode}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMfaCode(e.target.value.toUpperCase().slice(0, 24))}
                      placeholder="000000 or XXXX-XXXX"
                      required
                      style={inputBase}
                      onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#111827'}
                      onBlur={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#e5e7eb'}
                    />
                  </div>
                  <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>{t('login.mfaHint')}</p>
                  <button
                    type="button"
                    onClick={() => { setMfaStep(false); setMfaToken(''); setMfaCode(''); setError('') }}
                    style={{ marginTop: 8, background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
                  >
                    {t('login.mfaBack')}
                  </button>
                </div>
              )}

              {/* Username (register only) */}
              {mode === 'register' && !passwordChangeStep && (
                <div>
                  <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('login.username')}</label>
                  <div style={{ position: 'relative' }}>
                    <User size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                    <input
                      type="text" value={username} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)} required
                      placeholder="admin" style={inputBase}
                      onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#111827'}
                      onBlur={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#e5e7eb'}
                    />
                  </div>
                </div>
              )}

              {/* Email */}
              {!(mode === 'login' && mfaStep) && !passwordChangeStep && (
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('common.email')}</label>
                <div style={{ position: 'relative' }}>
                  <Mail size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                  <input
                    type="email" value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required
                    placeholder={t('login.emailPlaceholder')} style={inputBase}
                    onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#111827'}
                    onBlur={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#e5e7eb'}
                  />
                </div>
              </div>
              )}

              {/* Password */}
              {!(mode === 'login' && mfaStep) && !passwordChangeStep && (
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('common.password')}</label>
                <div style={{ position: 'relative' }}>
                  <Lock size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                  <input
                    type={showPassword ? 'text' : 'password'} value={password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required
                    placeholder="••••••••" style={{ ...inputBase, paddingRight: 44 }}
                    onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#111827'}
                    onBlur={(e: React.FocusEvent<HTMLInputElement>) => e.target.style.borderColor = '#e5e7eb'}
                  />
                  <button type="button" onClick={() => setShowPassword(v => !v)} style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#9ca3af',
                    width: 22, height: 22,
                  }}>
                    <Eye size={16} style={{
                      position: 'absolute', inset: 3,
                      opacity: showPassword ? 0 : 1,
                      transform: showPassword ? 'scale(0.7) rotate(-20deg)' : 'scale(1) rotate(0)',
                      transition: 'opacity 180ms cubic-bezier(0.23,1,0.32,1), transform 180ms cubic-bezier(0.23,1,0.32,1)',
                    }} />
                    <EyeOff size={16} style={{
                      position: 'absolute', inset: 3,
                      opacity: showPassword ? 1 : 0,
                      transform: showPassword ? 'scale(1) rotate(0)' : 'scale(0.7) rotate(20deg)',
                      transition: 'opacity 180ms cubic-bezier(0.23,1,0.32,1), transform 180ms cubic-bezier(0.23,1,0.32,1)',
                    }} />
                  </button>
                </div>
                {mode === 'login' && (
                  <div style={{ textAlign: 'right', marginTop: 6 }}>
                    <button type="button" onClick={() => navigate('/forgot-password')} style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      color: '#6b7280', fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
                    }}
                      onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.color = '#111827' }}
                      onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.color = '#6b7280' }}
                    >{t('login.forgotPassword')}</button>
                  </div>
                )}
              </div>
              )}

              <button type="submit" disabled={isLoading} style={{
                marginTop: 4, width: '100%', padding: '12px', background: '#111827', color: 'white',
                border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: isLoading ? 'default' : 'pointer',
                fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                opacity: isLoading ? 0.7 : 1, transition: 'opacity 0.15s',
              }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { if (!isLoading) e.currentTarget.style.background = '#1f2937' }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.style.background = '#111827'}
              >
                {isLoading
                  ? <><div style={{ width: 15, height: 15, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />{passwordChangeStep ? t('settings.updatePassword') : mode === 'register' ? t('login.creating') : (mode === 'login' && mfaStep ? t('login.mfaVerify') : t('login.signingIn'))}</>
                  : <><Plane size={16} />{passwordChangeStep ? t('settings.updatePassword') : mode === 'register' ? t('login.createAccount') : (mode === 'login' && mfaStep ? t('login.mfaVerify') : t('login.signIn'))}</>
                }
              </button>
            </form>

            {/* Toggle login/register */}
            {showRegisterOption && appConfig?.has_users && !appConfig?.demo_mode && !passwordChangeStep && (
              <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: '#9ca3af' }}>
                {mode === 'login' ? t('login.noAccount') + ' ' : t('login.hasAccount') + ' '}
                <button onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setError(''); setMfaStep(false); setMfaToken(''); setMfaCode('') }}
                  style={{ background: 'none', border: 'none', color: '#111827', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
                  {mode === 'login' ? t('login.register') : t('login.signIn')}
                </button>
              </p>
            )}
            </>)}
          </div>

          {/* OIDC / SSO login button (only when OIDC is configured, oidc_login enabled, not in oidc-only mode) */}
          {appConfig?.oidc_configured && appConfig?.oidc_login && !oidcOnly && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
                <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('common.or')}</span>
                <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
              </div>
              <a href={`/api/auth/oidc/login${inviteToken ? '?invite=' + encodeURIComponent(inviteToken) : ''}`}
                style={{
                  marginTop: 12, width: '100%', padding: '12px',
                  background: 'white', color: '#374151',
                  border: '1px solid #d1d5db', borderRadius: 12,
                  fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  textDecoration: 'none', transition: 'background 180ms cubic-bezier(0.23,1,0.32,1), border-color 180ms cubic-bezier(0.23,1,0.32,1)',
                  boxSizing: 'border-box',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.borderColor = '#9ca3af' }}
                onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.background = 'white'; e.currentTarget.style.borderColor = '#d1d5db' }}
              >
                <Shield size={16} />
                {t('login.oidcSignIn', { name: appConfig.oidc_display_name })}
              </a>
            </>
          )}

          {/* Demo login button */}
          {appConfig?.demo_mode && (
            <button onClick={handleDemoLogin} disabled={isLoading}
              style={{
                marginTop: 16, width: '100%', padding: '14px',
                background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                color: '#451a03', border: 'none', borderRadius: 14,
                fontSize: 15, fontWeight: 700, cursor: isLoading ? 'default' : 'pointer',
                fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                opacity: isLoading ? 0.7 : 1, transition: 'transform 200ms cubic-bezier(0.23,1,0.32,1), box-shadow 200ms cubic-bezier(0.23,1,0.32,1), opacity 200ms cubic-bezier(0.23,1,0.32,1)',
                boxShadow: '0 2px 12px rgba(245, 158, 11, 0.3)',
              }}
              onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { if (!isLoading) e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(245, 158, 11, 0.4)' }}
              onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 2px 12px rgba(245, 158, 11, 0.3)' }}
            >
              <Plane size={18} />
              {t('login.demoHint')}
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes orbFloat1 {
          0%, 100% { top: 15%; left: 30%; }
          25% { top: 25%; left: 55%; }
          50% { top: 45%; left: 40%; }
          75% { top: 20%; left: 20%; }
        }
        @keyframes orbFloat2 {
          0%, 100% { bottom: 20%; right: 15%; }
          25% { bottom: 35%; right: 35%; }
          50% { bottom: 15%; right: 45%; }
          75% { bottom: 40%; right: 20%; }
        }
        .login-orb1 { animation: orbFloat1 20s ease-in-out infinite; }
        .login-orb2 { animation: orbFloat2 25s ease-in-out infinite; }

        @keyframes twinkle {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.5; }
        }
        .login-star { animation: twinkle 3s ease-in-out infinite; }

        @keyframes plane1Move {
          0%   { left: -8%; top: 30%; transform: rotate(-8deg); }
          100% { left: 108%; top: 10%; transform: rotate(-12deg); }
        }
        @keyframes plane2Move {
          0%   { right: -5%; top: 18%; transform: rotate(5deg); }
          100% { right: 110%; top: 8%; transform: rotate(3deg); }
        }
        @keyframes plane3Move {
          0%   { left: -6%; top: 55%; transform: rotate(-10deg); }
          100% { left: 110%; top: 35%; transform: rotate(-6deg); }
        }
        @keyframes plane4Move {
          0%   { left: -4%; top: 8%; transform: rotate(-3deg); }
          100% { left: 110%; top: 5%; transform: rotate(-5deg); }
        }
        @keyframes plane5Move {
          0%   { right: -6%; top: 65%; transform: rotate(3deg); }
          100% { right: 110%; top: 50%; transform: rotate(-2deg); }
        }
        @keyframes plane6Move {
          0%   { left: -3%; top: 75%; transform: rotate(-7deg); }
          100% { left: 110%; top: 58%; transform: rotate(-5deg); }
        }
        .login-plane1 { animation: plane1Move 24s ease-in-out infinite; }
        .login-plane2 { animation: plane2Move 18s ease-in-out infinite; animation-delay: 6s; }
        .login-plane3 { animation: plane3Move 30s ease-in-out infinite; animation-delay: 12s; }
        .login-plane4 { animation: plane4Move 14s ease-in-out infinite; animation-delay: 3s; }
        .login-plane5 { animation: plane5Move 22s ease-in-out infinite; animation-delay: 9s; }
        .login-plane6 { animation: plane6Move 32s ease-in-out infinite; animation-delay: 16s; }

      `}</style>
    </div>
  )
}
