import React, { useEffect, useState, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { useTranslation } from '../i18n'
import { useVacayStore } from '../store/vacayStore'
import { addListener, removeListener } from '../api/websocket'
import Navbar from '../components/Layout/Navbar'
import VacayCalendar from '../components/Vacay/VacayCalendar'
import VacayPersons from '../components/Vacay/VacayPersons'
import VacayStats from '../components/Vacay/VacayStats'
import VacaySettings from '../components/Vacay/VacaySettings'
import { Plus, Minus, ChevronLeft, ChevronRight, Settings, CalendarDays, AlertTriangle, Users, Eye, Pencil, Trash2, Unlink, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import Modal from '../components/shared/Modal'

export default function VacayPage(): React.ReactElement {
  const { t } = useTranslation()
  const { years, selectedYear, setSelectedYear, addYear, removeYear, loadAll, loadPlan, loadEntries, loadStats, loadHolidays, loading, incomingInvites, acceptInvite, declineInvite, plan } = useVacayStore()
  const [showSettings, setShowSettings] = useState<boolean>(false)
  const [deleteYear, setDeleteYear] = useState<number | null>(null)
  const [showMobileSidebar, setShowMobileSidebar] = useState<boolean>(false)

  useEffect(() => { loadAll() }, [])

  // Live sync via WebSocket
  const handleWsMessage = useCallback((msg: { type: string }) => {
    if (msg.type === 'vacay:update' || msg.type === 'vacay:settings') {
      loadPlan()
      loadEntries(selectedYear)
      loadStats(selectedYear)
      if (msg.type === 'vacay:settings') loadAll()
    }
    if (msg.type === 'vacay:invite' || msg.type === 'vacay:accepted' || msg.type === 'vacay:declined' || msg.type === 'vacay:cancelled' || msg.type === 'vacay:dissolved') {
      loadAll()
    }
  }, [selectedYear])

  useEffect(() => {
    addListener(handleWsMessage)
    return () => removeListener(handleWsMessage)
  }, [handleWsMessage])
  useEffect(() => {
    if (selectedYear) { loadEntries(selectedYear); loadStats(selectedYear); loadHolidays(selectedYear) }
  }, [selectedYear])

  const handleAddNextYear = () => {
    const nextYear = years.length > 0 ? Math.max(...years) + 1 : new Date().getFullYear()
    addYear(nextYear)
  }

  const handleAddPrevYear = () => {
    const prevYear = years.length > 0 ? Math.min(...years) - 1 : new Date().getFullYear()
    addYear(prevYear)
  }

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <Navbar />
        <div className="flex items-center justify-center" style={{ paddingTop: 'var(--nav-h)', minHeight: 'calc(100vh - var(--nav-h))' }}>
          <div className="w-8 h-8 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }} />
        </div>
      </div>
    )
  }

  // Sidebar content (shared between desktop sidebar and mobile drawer)
  const sidebarContent = (
    <>
      {/* Year Selector */}
      <div className="rounded-xl border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <div className="flex items-center mb-2">
          <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>{t('vacay.year')}</span>
        </div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1">
            <button onClick={handleAddPrevYear} className="p-0.5 rounded transition-colors" style={{ color: 'var(--text-faint)' }} title={t('vacay.addPrevYear')}>
              <Plus size={14} />
            </button>
            <button onClick={() => { const idx = years.indexOf(selectedYear); if (idx > 0) setSelectedYear(years[idx - 1]) }} disabled={years.indexOf(selectedYear) <= 0} className="p-1 rounded-lg disabled:opacity-20 transition-colors" style={{ background: 'var(--bg-secondary)' }}>
              <ChevronLeft size={16} style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>
          <span className="text-xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{selectedYear}</span>
          <div className="flex items-center gap-1">
            <button onClick={() => { const idx = years.indexOf(selectedYear); if (idx < years.length - 1) setSelectedYear(years[idx + 1]) }} disabled={years.indexOf(selectedYear) >= years.length - 1} className="p-1 rounded-lg disabled:opacity-20 transition-colors" style={{ background: 'var(--bg-secondary)' }}>
              <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
            </button>
            <button onClick={handleAddNextYear} className="p-0.5 rounded transition-colors" style={{ color: 'var(--text-faint)' }} title={t('vacay.addYear')}>
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {years.map(y => (
            <div key={y} onClick={() => setSelectedYear(y)}
              className="group relative py-1.5 rounded-lg text-xs font-medium transition-all text-center cursor-pointer"
              style={{
                background: y === selectedYear ? 'var(--text-primary)' : 'var(--bg-secondary)',
                color: y === selectedYear ? 'var(--bg-card)' : 'var(--text-muted)',
              }}>
              {y}
              {years.length > 1 && (
                <span onClick={e => { e.stopPropagation(); setDeleteYear(y); setShowMobileSidebar(false) }}
                  className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[7px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                  <Minus size={7} />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <VacayPersons />

      {/* Legend */}
      {(plan?.holidays_enabled || plan?.company_holidays_enabled || plan?.block_weekends) && (
        <div className="rounded-xl border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
          <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>{t('vacay.legend')}</span>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5">
            {plan?.holidays_enabled && (plan?.holiday_calendars ?? []).length === 0 && (
              <LegendItem color="#fecaca" label={t('vacay.publicHoliday')} />
            )}
            {plan?.holidays_enabled && (plan?.holiday_calendars ?? []).map(cal => (
              <LegendItem key={cal.id} color={cal.color} label={cal.label || cal.region} />
            ))}
            {plan?.company_holidays_enabled && <LegendItem color="#fde68a" label={t('vacay.companyHoliday')} />}
            {plan?.block_weekends && <LegendItem color="#e5e7eb" label={t('vacay.weekend')} />}
          </div>
        </div>
      )}

      <VacayStats />
    </>
  )

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <Navbar />

      <div style={{ paddingTop: 'var(--nav-h)' }}>
        <div className="max-w-[1800px] mx-auto px-3 sm:px-4 py-4 sm:py-6">
          {/* Mobile header */}
          <div className="md:hidden flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
                <CalendarDays size={18} style={{ color: 'var(--text-primary)' }} />
              </div>
              <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('admin.addons.catalog.vacay.name')}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowMobileSidebar(true)}
                className="lg:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
              >
                <SlidersHorizontal size={14} />
              </button>
              <button
                onClick={() => setShowSettings(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
              >
                <Settings size={14} />
              </button>
            </div>
          </div>

          {/* Desktop header — unified toolbar */}
          <div className="hidden md:block" style={{ marginBottom: 20 }}>
            <div style={{
              background: 'var(--bg-tertiary)', borderRadius: 18,
              border: '1px solid var(--border-primary)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
              padding: '14px 16px 14px 22px',
              display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', flexShrink: 0 }}>
                {t('admin.addons.catalog.vacay.name')}
              </h2>
              <div style={{ width: 1, height: 22, background: 'var(--border-faint)', flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {t('vacay.subtitle')}
              </span>
              <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexShrink: 0 }}>
                <button
                  onClick={() => setShowMobileSidebar(true)}
                  className="lg:hidden"
                  title={t('vacay.filters') || 'Filters'}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '7px 11px', borderRadius: 99,
                    background: 'transparent', color: 'var(--text-muted)',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
                >
                  <SlidersHorizontal size={15} />
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                    background: 'var(--accent)', color: 'var(--accent-text)', flexShrink: 0,
                    marginLeft: 2,
                    transition: 'opacity 0.15s ease',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <Settings size={14} strokeWidth={2.5} /> {t('vacay.settings')}
                </button>
              </div>
            </div>
          </div>

          {/* Main layout */}
          <div className="flex gap-4 items-start">
            {/* Desktop Sidebar */}
            <div className="hidden lg:flex w-[240px] shrink-0 flex-col gap-3 sticky top-[70px]">
              {sidebarContent}
            </div>

            {/* Calendar */}
            <div className="flex-1 min-w-0">
              <VacayCalendar />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Sidebar Drawer */}
      {showMobileSidebar && ReactDOM.createPortal(
        <div className="fixed inset-0 lg:hidden" style={{ zIndex: 99980 }}>
          <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={() => setShowMobileSidebar(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-[280px] overflow-y-auto p-3 flex flex-col gap-3"
            style={{ background: 'var(--bg-primary)', boxShadow: '4px 0 24px rgba(0,0,0,0.15)', animation: 'slideInLeft 0.2s ease-out' }}>
            {sidebarContent}
          </div>
        </div>,
        document.body
      )}

      {/* Settings Modal */}
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title={t('vacay.settings')} size="md">
        <VacaySettings onClose={() => setShowSettings(false)} />
      </Modal>

      {/* Delete Year Modal */}
      <Modal isOpen={deleteYear !== null} onClose={() => setDeleteYear(null)} title={t('vacay.removeYear')} size="sm">
        <div className="space-y-4">
          <div className="flex gap-3 p-3 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
            <AlertTriangle size={18} className="text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {t('vacay.removeYearConfirm', { year: deleteYear })}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {t('vacay.removeYearHint')}
              </p>
            </div>
          </div>
          <div className="flex gap-3 justify-end">
            <button onClick={() => setDeleteYear(null)} className="px-4 py-2 text-sm rounded-lg transition-colors" style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}>
              {t('common.cancel')}
            </button>
            <button onClick={async () => { await removeYear(deleteYear); setDeleteYear(null) }} className="px-4 py-2 text-sm bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors">
              {t('vacay.remove')}
            </button>
          </div>
        </div>
      </Modal>

      {/* Incoming invite — forced fullscreen modal */}
      {incomingInvites.length > 0 && ReactDOM.createPortal(
        <div className="fixed inset-0 flex items-center justify-center px-4"
          style={{ zIndex: 99995, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          {incomingInvites.map(inv => (
            <div key={inv.id} className="w-full max-w-md rounded-2xl shadow-2xl overflow-hidden"
              style={{ background: 'var(--bg-card)', animation: 'modalIn 0.25s ease-out' }}>
              <div className="px-6 pt-6 pb-4 text-center">
                <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center text-lg font-bold"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                  {inv.username?.[0]?.toUpperCase()}
                </div>
                <h2 className="text-lg font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                  {t('vacay.inviteTitle')}
                </h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{inv.username}</span> {t('vacay.inviteWantsToFuse')}
                </p>
              </div>
              <div className="px-6 pb-4 space-y-2">
                <InfoItem icon={Eye} text={t('vacay.fuseInfo1')} />
                <InfoItem icon={Pencil} text={t('vacay.fuseInfo2')} />
                <InfoItem icon={Trash2} text={t('vacay.fuseInfo3')} />
                <InfoItem icon={ShieldCheck} text={t('vacay.fuseInfo4')} />
                <InfoItem icon={Unlink} text={t('vacay.fuseInfo5')} />
              </div>
              <div className="px-6 pb-6 flex gap-3">
                <button onClick={() => declineInvite(inv.plan_id)}
                  className="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl transition-colors"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}>
                  {t('vacay.decline')}
                </button>
                <button onClick={() => acceptInvite(inv.plan_id)}
                  className="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl transition-colors"
                  style={{ background: 'var(--text-primary)', color: 'var(--bg-card)' }}>
                  {t('vacay.acceptFusion')}
                </button>
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}

      <style>{`
        @keyframes slideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}

function InfoItem({ icon: Icon, text }: { icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>; text: string }): React.ReactElement {
  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
      <Icon size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
      <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{text}</span>
    </div>
  )
}

function LegendItem({ color, label }: { color: string; label: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="w-4 h-3 rounded" style={{ background: color, border: `1px solid ${color}` }} />
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}
