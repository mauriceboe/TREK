import { useState, useEffect } from 'react'
import { type LucideIcon, CalendarOff, AlertCircle, Building2, Unlink, ArrowRightLeft, Globe, Plus, Trash2 } from 'lucide-react'
import { useVacayStore } from '../../store/vacayStore'
import { getIntlLanguage, useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import CustomSelect from '../shared/CustomSelect'
// Vacay holiday settings stubbed
const apiClient: any = {
  get: async (_url: string, _opts?: any) => ({ data: [] as any[] }),
}
import type { VacayHolidayCalendar } from '../../types'

interface VacaySettingsProps {
  onClose: () => void
}

export default function VacaySettings({ onClose }: VacaySettingsProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const { plan, updatePlan, addHolidayCalendar, updateHolidayCalendar, deleteHolidayCalendar, isFused, dissolve, users } = useVacayStore()
  const [countries, setCountries] = useState<{ value: string; label: string }[]>([])
  const [showAddForm, setShowAddForm] = useState(false)

  const { language } = useTranslation()

  // Load available countries with localized names
  useEffect(() => {
    apiClient.get('/addons/vacay/holidays/countries').then(r => {
      let displayNames
      try { displayNames = new Intl.DisplayNames([getIntlLanguage(language)], { type: 'region' }) } catch { /* */ }
      const list = r.data.map(c => ({
        value: c.countryCode,
        label: displayNames ? (displayNames.of(c.countryCode) || c.name) : c.name,
      }))
      list.sort((a, b) => a.label.localeCompare(b.label))
      setCountries(list)
    }).catch(() => {})
  }, [language])

  if (!plan) return null

  const toggle = (key: string) => updatePlan({ [key]: !plan[key] })

  return (
    <div className="space-y-5">
      {/* Block weekends */}
      <SettingToggle
        icon={CalendarOff}
        label={t('vacay.blockWeekends')}
        hint={t('vacay.blockWeekendsHint')}
        value={plan.block_weekends}
        onChange={() => toggle('block_weekends')}
      />

      {/* Weekend days selector */}
      {plan.block_weekends !== false && (
        <div style={{ paddingLeft: 36 }}>
          <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>{t('vacay.weekendDays')}</p>
          <div className="flex flex-wrap gap-1.5">
            {[
              { day: 1, label: t('vacay.mon') },
              { day: 2, label: t('vacay.tue') },
              { day: 3, label: t('vacay.wed') },
              { day: 4, label: t('vacay.thu') },
              { day: 5, label: t('vacay.fri') },
              { day: 6, label: t('vacay.sat') },
              { day: 0, label: t('vacay.sun') },
            ].map(({ day, label }) => {
              const current: number[] = plan.weekend_days ? String(plan.weekend_days).split(',').map(Number) : [0, 6]
              const active = current.includes(day)
              return (
                <button key={day} onClick={() => {
                  const next = active ? current.filter(d => d !== day) : [...current, day]
                  updatePlan({ weekend_days: next.join(',') })
                }}
                  style={{
                    padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'inherit', border: '1px solid', transition: 'all 0.12s',
                    background: active ? 'var(--text-primary)' : 'var(--bg-card)',
                    borderColor: active ? 'var(--text-primary)' : 'var(--border-primary)',
                    color: active ? 'var(--bg-primary)' : 'var(--text-muted)',
                  }}>
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Carry-over */}
      <SettingToggle
        icon={ArrowRightLeft}
        label={t('vacay.carryOver')}
        hint={t('vacay.carryOverHint')}
        value={plan.carry_over_enabled}
        onChange={() => toggle('carry_over_enabled')}
      />

      {/* Company holidays */}
      <div>
        <SettingToggle
          icon={Building2}
          label={t('vacay.companyHolidays')}
          hint={t('vacay.companyHolidaysHint')}
          value={plan.company_holidays_enabled}
          onChange={() => toggle('company_holidays_enabled')}
        />
        {plan.company_holidays_enabled && (
          <div className="ml-7 mt-2">
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md" style={{ background: 'var(--bg-secondary)' }}>
              <AlertCircle size={12} style={{ color: 'var(--text-faint)' }} />
              <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>{t('vacay.companyHolidaysNoDeduct')}</span>
            </div>
          </div>
        )}
      </div>

      {/* Public holidays */}
      <div>
        <SettingToggle
          icon={Globe}
          label={t('vacay.publicHolidays')}
          hint={t('vacay.publicHolidaysHint')}
          value={plan.holidays_enabled}
          onChange={() => toggle('holidays_enabled')}
        />
        {plan.holidays_enabled && (
          <div className="ml-7 mt-2 space-y-2">
            {(plan.holiday_calendars ?? []).length === 0 && (
              <p className="text-xs" style={{ color: 'var(--text-faint)' }}>{t('vacay.noCalendars')}</p>
            )}
            {(plan.holiday_calendars ?? []).map(cal => (
              <CalendarRow
                key={cal.id}
                cal={cal}
                countries={countries}
                language={language}
                onUpdate={(data) => updateHolidayCalendar(cal.id, data)}
                onDelete={() => deleteHolidayCalendar(cal.id)}
              />
            ))}
            {showAddForm ? (
              <AddCalendarForm
                countries={countries}
                language={language}
                onAdd={async (data) => { await addHolidayCalendar(data); setShowAddForm(false) }}
                onCancel={() => setShowAddForm(false)}
              />
            ) : (
              <button
                onClick={() => setShowAddForm(true)}
                className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md transition-colors"
                style={{ color: 'var(--text-muted)', background: 'var(--bg-secondary)' }}
              >
                <Plus size={12} />
                {t('vacay.addCalendar')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Dissolve fusion */}
      {isFused && (
        <div className="pt-4 mt-2 border-t" style={{ borderColor: 'var(--border-secondary)' }}>
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(239,68,68,0.2)' }}>
            <div className="px-4 py-3 flex items-center gap-3" style={{ background: 'rgba(239,68,68,0.06)' }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.1)' }}>
                <Unlink size={16} className="text-red-500" />
              </div>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('vacay.dissolve')}</p>
                <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>{t('vacay.dissolveHint')}</p>
              </div>
            </div>
            <div className="px-4 py-3 flex items-center gap-2 flex-wrap" style={{ borderTop: '1px solid rgba(239,68,68,0.1)' }}>
              {users.map(u => (
                <div key={u.id} className="flex items-center gap-1.5 px-2 py-1 rounded-md" style={{ background: 'var(--bg-secondary)' }}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: u.color || '#6366f1' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{u.username}</span>
                </div>
              ))}
            </div>
            <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(239,68,68,0.1)' }}>
              <button
                onClick={async () => {
                  await dissolve()
                  toast.success(t('vacay.dissolved'))
                  onClose()
                }}
                className="w-full px-3 py-2 text-xs font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors"
              >
                {t('vacay.dissolveAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface SettingToggleProps {
  icon: LucideIcon
  label: string
  hint: string
  value: boolean
  onChange: () => void
}

function SettingToggle({ icon: Icon, label, hint, value, onChange }: SettingToggleProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <Icon size={15} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</p>
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>{hint}</p>
        </div>
      </div>
      <button onClick={onChange}
        className="relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors"
        style={{ background: value ? 'var(--text-primary)' : 'var(--border-primary)' }}>
        <span className="absolute left-1 h-4 w-4 rounded-full transition-transform duration-200"
          style={{ background: 'var(--bg-card)', transform: value ? 'translateX(20px)' : 'translateX(0)' }} />
      </button>
    </div>
  )
}

// ── shared region-loading helper ─────────────────────────────────────────────
async function fetchRegionOptions(country: string): Promise<{ value: string; label: string }[]> {
  try {
    const year = new Date().getFullYear()
    const r = await apiClient.get(`/addons/vacay/holidays/${year}/${country}`)
    const allCounties = new Set<string>()
    r.data.forEach(h => { if (h.counties) h.counties.forEach(c => allCounties.add(c)) })
    if (allCounties.size === 0) return []
    return [...allCounties].sort().map(c => {
      let label = c.split('-')[1] || c
      if (c.startsWith('DE-')) {
        const m: Record<string, string> = { BW:'Baden-Württemberg',BY:'Bayern',BE:'Berlin',BB:'Brandenburg',HB:'Bremen',HH:'Hamburg',HE:'Hessen',MV:'Mecklenburg-Vorpommern',NI:'Niedersachsen',NW:'Nordrhein-Westfalen',RP:'Rheinland-Pfalz',SL:'Saarland',SN:'Sachsen',ST:'Sachsen-Anhalt',SH:'Schleswig-Holstein',TH:'Thüringen' }
        label = m[c.split('-')[1]] || label
      } else if (c.startsWith('CH-')) {
        const m: Record<string, string> = { AG:'Aargau',AI:'Appenzell Innerrhoden',AR:'Appenzell Ausserrhoden',BE:'Bern',BL:'Basel-Landschaft',BS:'Basel-Stadt',FR:'Freiburg',GE:'Genf',GL:'Glarus',GR:'Graubünden',JU:'Jura',LU:'Luzern',NE:'Neuenburg',NW:'Nidwalden',OW:'Obwalden',SG:'St. Gallen',SH:'Schaffhausen',SO:'Solothurn',SZ:'Schwyz',TG:'Thurgau',TI:'Tessin',UR:'Uri',VD:'Waadt',VS:'Wallis',ZG:'Zug',ZH:'Zürich' }
        label = m[c.split('-')[1]] || label
      }
      return { value: c, label }
    })
  } catch {
    return []
  }
}

// ── Existing calendar row (inline edit) ──────────────────────────────────────
function CalendarRow({ cal, countries, onUpdate, onDelete }: {
  cal: VacayHolidayCalendar
  countries: { value: string; label: string }[]
  language: string
  onUpdate: (data: { region?: string; color?: string; label?: string | null }) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [localColor, setLocalColor] = useState(cal.color)
  const [localLabel, setLocalLabel] = useState(cal.label || '')
  const [regions, setRegions] = useState<{ value: string; label: string }[]>([])

  const selectedCountry = cal.region.split('-')[0]
  const selectedRegion = cal.region.includes('-') ? cal.region : ''

  useEffect(() => { setLocalColor(cal.color) }, [cal.color])
  useEffect(() => { setLocalLabel(cal.label || '') }, [cal.label])

  useEffect(() => {
    if (!selectedCountry) { setRegions([]); return }
    fetchRegionOptions(selectedCountry).then(setRegions)
  }, [selectedCountry])

  const PRESET_COLORS = ['#fecaca', '#fed7aa', '#fde68a', '#bbf7d0', '#a5f3fc', '#c7d2fe', '#e9d5ff', '#fda4af', '#6366f1', '#ef4444', '#22c55e', '#3b82f6']
  const [showColorPicker, setShowColorPicker] = useState(false)

  return (
    <div className="flex gap-3 items-start p-3 rounded-xl" style={{ background: 'var(--bg-secondary)' }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          onClick={() => setShowColorPicker(!showColorPicker)}
          style={{ width: 28, height: 28, borderRadius: 8, background: localColor, border: '2px solid var(--border-primary)', cursor: 'pointer' }}
          title={t('vacay.calendarColor')}
        />
        {showColorPicker && (
          <div style={{ position: 'absolute', top: 34, left: 0, zIndex: 50, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 12, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, width: 120 }}>
            {PRESET_COLORS.map(c => (
              <button key={c} onClick={() => { setLocalColor(c); setShowColorPicker(false); if (c !== cal.color) onUpdate({ color: c }) }}
                style={{ width: 24, height: 24, borderRadius: 6, background: c, border: localColor === c ? '2px solid var(--text-primary)' : '2px solid transparent', cursor: 'pointer' }} />
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <input
          type="text"
          value={localLabel}
          onChange={e => setLocalLabel(e.target.value)}
          onBlur={() => { const v = localLabel.trim() || null; if (v !== cal.label) onUpdate({ label: v }) }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder={t('vacay.calendarLabel')}
          style={{ width: '100%', fontSize: 12, padding: '6px 10px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none' }}
        />
        <CustomSelect
          value={selectedCountry}
          onChange={v => onUpdate({ region: v })}
          options={countries}
          placeholder={t('vacay.selectCountry')}
          searchable
        />
        {regions.length > 0 && (
          <CustomSelect
            value={selectedRegion}
            onChange={v => onUpdate({ region: v })}
            options={regions}
            placeholder={t('vacay.selectRegion')}
            searchable
          />
        )}
      </div>
      <button
        onClick={onDelete}
        className="shrink-0 p-1.5 rounded-md transition-colors"
        style={{ color: 'var(--text-faint)' }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.1)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

// ── Add-new-calendar form ─────────────────────────────────────────────────────
function AddCalendarForm({ countries, onAdd, onCancel }: {
  countries: { value: string; label: string }[]
  language: string
  onAdd: (data: { region: string; color: string; label: string | null }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [region, setRegion] = useState('')
  const [color, setColor] = useState('#fecaca')
  const [label, setLabel] = useState('')
  const [regions, setRegions] = useState<{ value: string; label: string }[]>([])
  const [loadingRegions, setLoadingRegions] = useState(false)

  const selectedCountry = region.split('-')[0] || ''
  const selectedRegion = region.includes('-') ? region : ''

  useEffect(() => {
    if (!selectedCountry) { setRegions([]); return }
    setLoadingRegions(true)
    fetchRegionOptions(selectedCountry).then(list => { setRegions(list) }).finally(() => setLoadingRegions(false))
  }, [selectedCountry])

  const canAdd = selectedCountry && (regions.length === 0 || selectedRegion !== '')

  const PRESET_COLORS = ['#fecaca', '#fed7aa', '#fde68a', '#bbf7d0', '#a5f3fc', '#c7d2fe', '#e9d5ff', '#fda4af', '#6366f1', '#ef4444', '#22c55e', '#3b82f6']
  const [showColorPicker, setShowColorPicker] = useState(false)

  return (
    <div className="flex gap-3 items-start p-3 rounded-xl border border-dashed" style={{ borderColor: 'var(--border-primary)' }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          onClick={() => setShowColorPicker(!showColorPicker)}
          style={{ width: 28, height: 28, borderRadius: 8, background: color, border: '2px solid var(--border-primary)', cursor: 'pointer' }}
          title={t('vacay.calendarColor')}
        />
        {showColorPicker && (
          <div style={{ position: 'absolute', top: 34, left: 0, zIndex: 50, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 12, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, width: 120 }}>
            {PRESET_COLORS.map(c => (
              <button key={c} onClick={() => { setColor(c); setShowColorPicker(false) }}
                style={{ width: 24, height: 24, borderRadius: 6, background: c, border: color === c ? '2px solid var(--text-primary)' : '2px solid transparent', cursor: 'pointer' }} />
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <input
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={t('vacay.calendarLabel')}
          style={{ width: '100%', fontSize: 12, padding: '6px 10px', borderRadius: 8, background: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none' }}
        />
        <CustomSelect
          value={selectedCountry}
          onChange={v => { setRegion(v); setRegions([]) }}
          options={countries}
          placeholder={t('vacay.selectCountry')}
          searchable
        />
        {regions.length > 0 && (
          <CustomSelect
            value={selectedRegion}
            onChange={v => setRegion(v)}
            options={regions}
            placeholder={t('vacay.selectRegion')}
            searchable
          />
        )}
        <div className="flex gap-1.5 pt-0.5">
          <button
            disabled={!canAdd}
            onClick={() => onAdd({ region: region || selectedCountry, color, label: label.trim() || null })}
            className="flex-1 text-xs px-2 py-1.5 rounded-md font-medium transition-colors disabled:opacity-40"
            style={{ background: 'var(--text-primary)', color: 'var(--bg-card)' }}
          >
            {t('vacay.add')}
          </button>
          <button
            onClick={onCancel}
            className="text-xs px-2 py-1.5 rounded-md transition-colors"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
