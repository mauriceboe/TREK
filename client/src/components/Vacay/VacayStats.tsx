import { useEffect, useState } from 'react'
import { Briefcase, Pencil } from 'lucide-react'
import { useVacayStore } from '../../store/vacayStore'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import type { VacayStat } from '../../types'

interface VacayStatExtended extends VacayStat {
  username: string
  avatar_url: string | null
  color: string | null
  total_available: number
  remaining: number
  carried_over: number
}

export default function VacayStats() {
  const { t } = useTranslation()
  const { stats, selectedYear, loadStats, updateVacationDays, isFused } = useVacayStore()
  const { user: currentUser } = useAuthStore()

  useEffect(() => { loadStats(selectedYear) }, [selectedYear])

  return (
    <div className="rounded-xl border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
      <div className="flex items-center gap-1.5 mb-3">
        <Briefcase size={13} style={{ color: 'var(--text-faint)' }} />
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
          {t('vacay.entitlement')} {selectedYear}
        </span>
      </div>

      {stats.length === 0 ? (
        <p className="text-[11px] text-center py-3" style={{ color: 'var(--text-faint)' }}>{t('vacay.noData')}</p>
      ) : (
        <div className="space-y-2">
          {stats.map(s => (
            <StatCard
              key={s.user_id}
              stat={s as VacayStatExtended}
              isMe={s.user_id === currentUser?.id}
              canEdit={s.user_id === currentUser?.id || isFused}
              selectedYear={selectedYear}
              onSave={updateVacationDays}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface StatCardProps {
  stat: VacayStatExtended
  isMe: boolean
  canEdit: boolean
  selectedYear: number
  onSave: (year: number, days: number, targetUserId?: number) => Promise<void>
  t: (key: string, params?: Record<string, string | number>) => string
}

function StatCard({ stat: s, isMe, canEdit, selectedYear, onSave, t }: StatCardProps) {
  const [editing, setEditing] = useState(false)
  const [localDays, setLocalDays] = useState<number | string>(s.vacation_days)
  const pct = s.total_available > 0 ? Math.min(100, (s.used / s.total_available) * 100) : 0

  // Sync local state when stats reload from server
  useEffect(() => {
    if (!editing) setLocalDays(s.vacation_days)
  }, [s.vacation_days, editing])

  const handleSave = () => {
    setEditing(false)
    const days = typeof localDays === 'string' ? parseInt(localDays) : localDays
    if (!isNaN(days) && days >= 0 && days <= 365 && days !== s.vacation_days) {
      onSave(selectedYear, days, s.user_id)
    }
  }

  return (
    <div className="rounded-lg p-2.5 space-y-2" style={{ border: '1px solid var(--border-secondary)' }}>
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color || undefined }} />
        <span className="text-xs font-semibold flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
          {s.person_name}
          {isMe && <span style={{ color: 'var(--text-faint)' }}> ({t('vacay.you')})</span>}
        </span>
        <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-faint)' }}>{s.used}/{s.total_available}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: s.color || undefined }} />
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {/* Days — editable */}
        <div
          className="rounded-md px-2 py-2 group/days"
          style={{
            background: canEdit ? 'var(--bg-card)' : 'var(--bg-secondary)',
            border: canEdit ? '1px solid var(--border-primary)' : '1px solid transparent',
            cursor: canEdit ? 'pointer' : 'default',
          }}
          onClick={() => { if (canEdit && !editing) setEditing(true) }}
        >
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-faint)', height: 14, lineHeight: '14px' }}>
            {t('vacay.entitlementDays')} {canEdit && !editing && <Pencil size={9} className="inline opacity-0 group-hover/days:opacity-100 transition-opacity" style={{ color: 'var(--text-faint)', verticalAlign: 'middle' }} />}
          </div>
          {editing ? (
            <input
              type="number"
              value={localDays}
              onChange={e => setLocalDays(e.target.value)}
              onBlur={handleSave}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setLocalDays(s.vacation_days) } }}
              autoFocus
              className="w-full bg-transparent text-sm font-bold outline-none p-0 m-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              style={{ color: 'var(--text-primary)', height: 18, lineHeight: '18px' }}
            />
          ) : (
            <div className="text-sm font-bold" style={{ color: 'var(--text-primary)', height: 18, lineHeight: '18px' }}>{s.vacation_days}</div>
          )}
        </div>
        {/* Used */}
        <div className="rounded-md px-2 py-2" style={{ background: 'var(--bg-secondary)' }}>
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-faint)', height: 14, lineHeight: '14px' }}>{t('vacay.used')}</div>
          <div className="text-sm font-bold" style={{ color: 'var(--text-primary)', height: 18, lineHeight: '18px' }}>{s.used}</div>
        </div>
        {/* Remaining */}
        <div className="rounded-md px-2 py-2" style={{ background: 'var(--bg-secondary)' }}>
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-faint)', height: 14, lineHeight: '14px' }}>{t('vacay.remaining')}</div>
          <div className="text-sm font-bold" style={{ color: s.remaining < 0 ? '#ef4444' : s.remaining <= 3 ? '#f59e0b' : '#22c55e', height: 18, lineHeight: '18px' }}>
            {s.remaining}
          </div>
        </div>
      </div>
      {s.carried_over > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
          <span className="text-[10px]" style={{ color: '#d97706' }}>+{s.carried_over} {t('vacay.carriedOver', { year: selectedYear - 1 })}</span>
        </div>
      )}
    </div>
  )
}
