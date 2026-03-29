import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranslation } from '../../i18n'
import { addonsApi } from '../../api/client'
import { Plane, LogOut, Settings, ChevronDown, Shield, ArrowLeft, Users, Moon, Sun, Monitor, CalendarDays, Briefcase, Globe } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const ADDON_ICONS: Record<string, LucideIcon> = { CalendarDays, Briefcase, Globe }

interface NavbarProps {
  tripTitle?: string
  tripId?: string
  onBack?: () => void
  showBack?: boolean
  onShare?: () => void
}

interface Addon {
  id: string
  name: string
  icon: string
  type: string
}

export default function Navbar({ tripTitle, tripId, onBack, showBack, onShare }: NavbarProps): React.ReactElement {
  const { user, logout } = useAuthStore()
  const { settings, updateSetting } = useSettingsStore()
  const { t, locale } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const [userMenuOpen, setUserMenuOpen] = useState<boolean>(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [globalAddons, setGlobalAddons] = useState<Addon[]>([])
  const darkMode = settings.dark_mode
  const dark = darkMode === true || darkMode === 'dark' || (darkMode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const loadAddons = () => {
    if (user) {
      addonsApi.enabled().then(data => {
        setGlobalAddons(data.addons.filter(a => a.type === 'global'))
      }).catch(() => {})
    }
  }
  useEffect(loadAddons, [user, location.pathname])
  // Listen for addon changes from AddonManager
  useEffect(() => {
    const handler = () => loadAddons()
    window.addEventListener('addons-changed', handler)
    return () => window.removeEventListener('addons-changed', handler)
  }, [user])

  useEffect(() => {
    import('../../api/client').then(({ authApi }) => {
      authApi.getAppConfig?.().then(c => setAppVersion(c?.version)).catch(() => {})
    })
  }, [])

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const toggleDarkMode = () => {
    updateSetting('dark_mode', dark ? 'light' : 'dark').catch(() => {})
  }

  const getAddonName = (addon: Addon): string => {
    const key = `admin.addons.catalog.${addon.id}.name`
    const translated = t(key)
    return translated !== key ? translated : addon.name
  }

  return (
    <nav style={{
      background: dark ? 'rgba(9,9,11,0.95)' : 'rgba(255,255,255,0.95)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderBottom: `1px solid ${dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'}`,
      boxShadow: dark ? '0 1px 12px rgba(0,0,0,0.2)' : '0 1px 12px rgba(0,0,0,0.05)',
      touchAction: 'manipulation',
      paddingTop: 'env(safe-area-inset-top, 0px)',
      height: 'var(--nav-h)',
    }} className="flex items-center px-4 gap-4 fixed top-0 left-0 right-0 z-[200]">
      {/* Left side */}
      <div className="flex items-center gap-3 min-w-0">
        {showBack && (
          <button onClick={onBack}
            className="p-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-sm flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.back')}</span>
          </button>
        )}

        <Link to="/dashboard" className="flex items-center transition-colors flex-shrink-0">
          <img src={dark ? '/icons/icon-white.svg' : '/icons/icon-dark.svg'} alt="TREK" className="sm:hidden" style={{ height: 22, width: 22 }} />
          <img src={dark ? '/logo-light.svg' : '/logo-dark.svg'} alt="TREK" className="hidden sm:block" style={{ height: 28 }} />
        </Link>

        {/* Global addon nav items */}
        {globalAddons.length > 0 && !tripTitle && (
          <>
            <span style={{ color: 'var(--text-faint)' }}>|</span>
            <Link to="/dashboard"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors flex-shrink-0"
              style={{
                color: location.pathname === '/dashboard' ? 'var(--text-primary)' : 'var(--text-muted)',
                background: location.pathname === '/dashboard' ? 'var(--bg-hover)' : 'transparent',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => { if (location.pathname !== '/dashboard') e.currentTarget.style.background = 'transparent' }}>
              <Briefcase className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{t('nav.myTrips')}</span>
            </Link>
            {globalAddons.map(addon => {
              const Icon = ADDON_ICONS[addon.icon] || CalendarDays
              const path = `/${addon.id}`
              const isActive = location.pathname === path
              return (
                <Link key={addon.id} to={path}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors flex-shrink-0"
                  style={{
                    color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                    background: isActive ? 'var(--bg-hover)' : 'transparent',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}>
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">{getAddonName(addon)}</span>
                </Link>
              )
            })}
          </>
        )}

        {tripTitle && (
          <>
            <span className="hidden sm:inline" style={{ color: 'var(--text-faint)' }}>/</span>
            <span className="text-sm font-medium truncate max-w-48" style={{ color: 'var(--text-muted)' }}>
              {tripTitle}
            </span>
          </>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Share button */}
      {onShare && (
        <button onClick={onShare}
          className="flex items-center gap-1.5 py-1.5 px-3 rounded-lg border transition-colors text-sm font-medium flex-shrink-0"
          style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)', background: 'var(--bg-card)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-card)'}>
          <Users className="w-4 h-4" />
          <span className="hidden sm:inline">{t('nav.share')}</span>
        </button>
      )}

      {/* Dark mode toggle (light ↔ dark, overrides auto) */}
      <button onClick={toggleDarkMode} title={dark ? t('nav.lightMode') : t('nav.darkMode')}
        className="p-2 rounded-lg transition-colors flex-shrink-0"
        style={{ color: 'var(--text-muted)' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
        {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      {/* User menu */}
      {user && (
        <div className="relative">
          <button onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 py-1.5 px-3 rounded-lg transition-colors"
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                style={{ background: dark ? '#e2e8f0' : '#111827', color: dark ? '#0f172a' : '#ffffff' }}>
                {user.username?.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-sm hidden sm:inline max-w-24 truncate" style={{ color: 'var(--text-secondary)' }}>
              {user.username}
            </span>
            <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-faint)' }} />
          </button>

          {userMenuOpen && ReactDOM.createPortal(
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setUserMenuOpen(false)} />
              <div className="w-52 rounded-xl shadow-xl border overflow-hidden" style={{ position: 'fixed', top: 'var(--nav-h)', right: 8, zIndex: 9999, background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
                <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-secondary)' }}>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{user.username}</p>
                  <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{user.email}</p>
                  {user.role === 'admin' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium mt-1" style={{ color: 'var(--text-secondary)' }}>
                      <Shield className="w-3 h-3" /> {t('nav.administrator')}
                    </span>
                  )}
                </div>

                <div className="py-1">
                  <Link to="/settings" onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 px-4 py-2 text-sm transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <Settings className="w-4 h-4" />
                    {t('nav.settings')}
                  </Link>

                  {user.role === 'admin' && (
                    <Link to="/admin" onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 px-4 py-2 text-sm transition-colors"
                      style={{ color: 'var(--text-secondary)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <Shield className="w-4 h-4" />
                      {t('nav.admin')}
                    </Link>
                  )}
                </div>

                <div className="py-1 border-t" style={{ borderColor: 'var(--border-secondary)' }}>
                  <button onClick={handleLogout}
                    className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-500 hover:bg-red-500/10 transition-colors">
                    <LogOut className="w-4 h-4" />
                    {t('nav.logout')}
                  </button>
                  {appVersion && (
                    <div className="px-4 pt-2 pb-2.5 text-center" style={{ marginTop: 4, borderTop: '1px solid var(--border-secondary)' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--bg-tertiary)', borderRadius: 99, padding: '4px 12px' }}>
                        <img src={dark ? '/text-light.svg' : '/text-dark.svg'} alt="TREK" style={{ height: 10, opacity: 0.5 }} />
                        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)' }}>v{appVersion}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>,
            document.body
          )}
        </div>
      )}
    </nav>
  )
}
