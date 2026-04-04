import { useState, useEffect } from 'react'
import { Clock, Plus, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'

const POPULAR_ZONES = [
  { label: 'New York', tz: 'America/New_York' },
  { label: 'London', tz: 'Europe/London' },
  { label: 'Berlin', tz: 'Europe/Berlin' },
  { label: 'Paris', tz: 'Europe/Paris' },
  { label: 'Dubai', tz: 'Asia/Dubai' },
  { label: 'Mumbai', tz: 'Asia/Kolkata' },
  { label: 'Bangkok', tz: 'Asia/Bangkok' },
  { label: 'Tokyo', tz: 'Asia/Tokyo' },
  { label: 'Sydney', tz: 'Australia/Sydney' },
  { label: 'Los Angeles', tz: 'America/Los_Angeles' },
  { label: 'Chicago', tz: 'America/Chicago' },
  { label: 'São Paulo', tz: 'America/Sao_Paulo' },
  { label: 'Istanbul', tz: 'Europe/Istanbul' },
  { label: 'Singapore', tz: 'Asia/Singapore' },
  { label: 'Hong Kong', tz: 'Asia/Hong_Kong' },
  { label: 'Seoul', tz: 'Asia/Seoul' },
  { label: 'Moscow', tz: 'Europe/Moscow' },
  { label: 'Cairo', tz: 'Africa/Cairo' },
]

function getTime(tz, locale, is12h) {
  try {
    return new Date().toLocaleTimeString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: is12h })
  } catch { return '—' }
}

function getOffset(tz) {
  try {
    const now = new Date()
    const local = new Date(now.toLocaleString('en-US', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))
    const remote = new Date(now.toLocaleString('en-US', { timeZone: tz }))
    const diff = (remote.getTime() - local.getTime()) / 3600000
    const sign = diff >= 0 ? '+' : ''
    return `${sign}${diff}h`
  } catch { return '' }
}

export default function TimezoneWidget() {
  const { t, locale } = useTranslation()
  const is12h = useSettingsStore(s => s.settings.time_format) === '12h'
  const [zones, setZones] = useState(() => {
    const saved = localStorage.getItem('dashboard_timezones')
    return saved ? JSON.parse(saved) : [
      { label: 'New York', tz: 'America/New_York' },
      { label: 'Tokyo', tz: 'Asia/Tokyo' },
    ]
  })
  const [now, setNow] = useState(Date.now())
  const [showAdd, setShowAdd] = useState(false)
  const [customLabel, setCustomLabel] = useState('')
  const [customTz, setCustomTz] = useState('')
  const [customError, setCustomError] = useState('')

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(i)
  }, [])

  useEffect(() => {
    localStorage.setItem('dashboard_timezones', JSON.stringify(zones))
  }, [zones])

  const isValidTz = (tz: string) => {
    try { Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date()); return true } catch { return false }
  }

  const addCustomZone = () => {
    const tz = customTz.trim()
    if (!tz) { setCustomError(t('dashboard.timezoneCustomErrorEmpty')); return }
    if (!isValidTz(tz)) { setCustomError(t('dashboard.timezoneCustomErrorInvalid')); return }
    if (zones.find(z => z.tz === tz)) { setCustomError(t('dashboard.timezoneCustomErrorDuplicate')); return }
    const label = customLabel.trim() || tz.split('/').pop()?.replace(/_/g, ' ') || tz
    setZones([...zones, { label, tz }])
    setCustomLabel(''); setCustomTz(''); setCustomError(''); setShowAdd(false)
  }

  const addZone = (zone) => {
    if (!zones.find(z => z.tz === zone.tz)) {
      setZones([...zones, zone])
    }
    setShowAdd(false)
  }

  const removeZone = (tz) => setZones(zones.filter(z => z.tz !== tz))

  const localTime = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: is12h })
  const rawZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const localZone = rawZone.split('/').pop().replace(/_/g, ' ')
  // Show abbreviated timezone name (e.g. CET, CEST, EST)
  const tzAbbr = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop()

  return (
    <div className="rounded-2xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>{t('dashboard.timezone')}</span>
        <button onClick={() => setShowAdd(!showAdd)} className="p-1 rounded-md transition-colors" style={{ color: 'var(--text-faint)' }}>
          <Plus size={12} />
        </button>
      </div>

      {/* Local time */}
      <div className="mb-3 pb-3" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
        <p className="text-2xl font-black tabular-nums" style={{ color: 'var(--text-primary)' }}>{localTime}</p>
        <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>{localZone} ({tzAbbr}) · {t('dashboard.localTime')}</p>
      </div>

      {/* Zone list */}
      <div className="space-y-2">
        {zones.map(z => (
          <div key={z.tz} className="flex items-center justify-between group">
            <div>
              <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{getTime(z.tz, locale, is12h)}</p>
              <p className="text-[10px]" style={{ color: 'var(--text-faint)' }}>{z.label} <span style={{ color: 'var(--text-muted)' }}>{getOffset(z.tz)}</span></p>
            </div>
            <button onClick={() => removeZone(z.tz)} className="opacity-0 group-hover:opacity-100 p-1 rounded transition-all" style={{ color: 'var(--text-faint)' }}>
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* Add zone dropdown */}
      {showAdd && (
        <div className="mt-2 rounded-xl p-2 max-h-[280px] overflow-auto" style={{ background: 'var(--bg-secondary)' }}>
          {/* Custom timezone */}
          <div className="px-2 py-2 mb-2 rounded-lg" style={{ background: 'var(--bg-card)' }}>
            <p className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-faint)' }}>{t('dashboard.timezoneCustomTitle')}</p>
            <div className="space-y-1.5">
              <input value={customLabel} onChange={e => setCustomLabel(e.target.value)}
                placeholder={t('dashboard.timezoneCustomLabelPlaceholder')}
                className="w-full px-2 py-1.5 rounded-lg text-xs outline-none"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-secondary)' }} />
              <input value={customTz} onChange={e => { setCustomTz(e.target.value); setCustomError('') }}
                placeholder={t('dashboard.timezoneCustomTzPlaceholder')}
                className="w-full px-2 py-1.5 rounded-lg text-xs outline-none"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: `1px solid ${customError ? '#ef4444' : 'var(--border-secondary)'}` }}
                onKeyDown={e => { if (e.key === 'Enter') addCustomZone() }} />
              {customError && <p className="text-[10px]" style={{ color: '#ef4444' }}>{customError}</p>}
              <button onClick={addCustomZone}
                className="w-full py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ background: 'var(--text-primary)', color: 'var(--bg-primary)' }}>
                {t('dashboard.timezoneCustomAdd')}
              </button>
            </div>
          </div>
          {/* Popular zones */}
          {POPULAR_ZONES.filter(z => !zones.find(existing => existing.tz === z.tz)).map(z => (
            <button key={z.tz} onClick={() => addZone(z)}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs text-left transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <span className="font-medium">{z.label}</span>
              <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>{getTime(z.tz, locale, is12h)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
