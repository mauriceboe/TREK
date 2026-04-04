import React, { useMemo } from 'react'
import { useTripStore } from '../../store/tripStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranslation } from '../../i18n'
import { MapPin, Clock, Calendar, Users, Sparkles } from 'lucide-react'

function formatTime(timeStr, is12h) {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  if (is12h) {
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${String(m).padStart(2, '0')} ${period}`
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatDayLabel(date, t, locale) {
  const d = new Date(date + 'T00:00:00')
  const now = new Date()
  const tomorrow = new Date(); tomorrow.setDate(now.getDate() + 1)

  if (d.toDateString() === now.toDateString()) return t('collab.whatsNext.today') || 'Today'
  if (d.toDateString() === tomorrow.toDateString()) return t('collab.whatsNext.tomorrow') || 'Tomorrow'

  return new Date(date + 'T00:00:00Z').toLocaleDateString(locale || undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

interface TripMember {
  id: number
  username: string
  avatar_url?: string | null
  avatar?: string | null
}

interface WhatsNextWidgetProps {
  tripMembers?: TripMember[]
}

export default function WhatsNextWidget({ tripMembers = [] }: WhatsNextWidgetProps) {
  const { days, assignments } = useTripStore()
  const { t, locale } = useTranslation()
  const is12h = useSettingsStore(s => s.settings.time_format) === '12h'

  const upcoming = useMemo(() => {
    const now = new Date()
    const nowDate = now.toISOString().split('T')[0]
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const items = []

    for (const day of (days || [])) {
      if (!day.date) continue
      const dayAssignments = assignments[String(day.id)] || []
      for (const a of dayAssignments) {
        if (!a.place) continue
        // Include: today (future times) + all future days
        const isFutureDay = day.date > nowDate
        const isTodayFuture = day.date === nowDate && (!a.place.place_time || a.place.place_time >= nowTime)
        if (isFutureDay || isTodayFuture) {
          items.push({
            id: a.id,
            name: a.place.name,
            time: a.place.place_time,
            endTime: a.place.end_time,
            date: day.date,
            dayTitle: day.title,
            category: a.place.category,
            participants: (a.participants && a.participants.length > 0)
              ? a.participants
              : tripMembers.map(m => ({ user_id: m.id, username: m.username, avatar: m.avatar })),
            address: a.place.address,
          })
        }
      }
    }

    items.sort((a, b) => {
      const da = a.date + (a.time || '99:99')
      const db = b.date + (b.time || '99:99')
      return da.localeCompare(db)
    })

    return items.slice(0, 8)
  }, [days, assignments, tripMembers])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
      }}>
        <Sparkles size={14} color="var(--text-faint)" />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: 0.3, textTransform: 'uppercase' }}>
          {t('collab.whatsNext.title') || "What's Next"}
        </span>
      </div>

      {/* List */}
      <div className="chat-scroll" style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
        {upcoming.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '48px 20px', textAlign: 'center' }}>
            <Calendar size={36} color="var(--text-faint)" strokeWidth={1.3} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('collab.whatsNext.empty')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('collab.whatsNext.emptyHint')}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {upcoming.map((item, idx) => {
              const prevItem = upcoming[idx - 1]
              const showDayHeader = !prevItem || prevItem.date !== item.date

              return (
                <React.Fragment key={item.id}>
                  {showDayHeader && (
                    <div style={{
                      fontSize: 10, fontWeight: 500, color: 'var(--text-faint)',
                      textTransform: 'uppercase', letterSpacing: 0.5,
                      padding: idx === 0 ? '0 4px 4px' : '8px 4px 4px',
                    }}>
                      {formatDayLabel(item.date, t, locale)}
                      {item.dayTitle ? ` — ${item.dayTitle}` : ''}
                    </div>
                  )}

                  <div style={{
                    display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 10,
                    background: 'var(--bg-secondary)', transition: 'background 0.1s',
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                  >
                    {/* Time column */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: 44, flexShrink: 0 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', lineHeight: 1 }}>
                        {item.time ? formatTime(item.time, is12h) : 'TBD'}
                      </span>
                      {item.endTime && (
                        <>
                          <span style={{ fontSize: 7, color: 'var(--text-faint)', fontWeight: 600, letterSpacing: 0.3, margin: '2px 0', textTransform: 'uppercase' }}>
                            {t('collab.whatsNext.until') || 'bis'}
                          </span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', lineHeight: 1 }}>
                            {formatTime(item.endTime, is12h)}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Divider */}
                    <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-faint)', flexShrink: 0, margin: '2px 0' }} />

                    {/* Details */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.name}
                      </div>
                      {item.address && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}>
                          <MapPin size={9} color="var(--text-faint)" style={{ flexShrink: 0 }} />
                          <span style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {item.address}
                          </span>
                        </div>
                      )}

                      {/* Participants */}
                      {item.participants.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                          {item.participants.map(p => (
                            <div key={p.user_id} style={{
                              display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px 2px 3px',
                              borderRadius: 99, background: 'var(--bg-tertiary)', border: '1px solid var(--border-faint)',
                            }}>
                              <div style={{
                                width: 16, height: 16, borderRadius: '50%', background: 'var(--bg-secondary)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 7, fontWeight: 700, color: 'var(--text-muted)',
                                overflow: 'hidden', flexShrink: 0,
                              }}>
                                {p.avatar
                                  ? <img src={`/uploads/avatars/${p.avatar}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  : p.username?.[0]?.toUpperCase()
                                }
                              </div>
                              <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)' }}>{p.username}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
