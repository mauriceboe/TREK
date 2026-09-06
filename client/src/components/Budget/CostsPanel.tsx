import { Fragment, useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { ArrowDown, ArrowUp, BarChart3, Plus, Search, ArrowRight, ArrowLeftRight, Check, RotateCcw, Pencil, Trash2, AlertCircle, Download, StickyNote, ChevronDown, Receipt, Paperclip } from 'lucide-react'
import { useTripStore } from '../../store/tripStore'
import { useAuthStore } from '../../store/authStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useCanDo } from '../../store/permissionsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { budgetApi, filesApi } from '../../api/client'
import { useExchangeRates } from '../../hooks/useExchangeRates'
import { useIsMobile } from '../../hooks/useIsMobile'
import { formatMoney, currencyDecimals, currencyLocale, localizeAmountInput, amountToInputString } from '../../utils/formatters'
import { downloadBlob, openFile } from '../../utils/fileDownload'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import { CustomDatePicker } from '../shared/CustomDateTimePicker'
import { localToday } from '../Planner/today'
import { SYMBOLS, currenciesWith, SPLIT_COLORS } from './BudgetPanel.constants'
import { amountPattern, calculateTicketShares, hasTicketSplit, NOTE_MAX, payersBalanced, readTicketItems, readUserNote, rebalancePayers, splitEqualShares, writeTicketItems, type TicketItem } from './CostsPanel.helpers'
import { COST_CATEGORY_LIST, catMeta } from './costsCategories'
import { ReceiptPreviewModal } from './ReceiptPreviewModal'
import type { BudgetItem, BudgetItemReceipt } from '../../types'
import type { TripMember } from './BudgetPanelMemberChips'
import GuestBadge from '../shared/GuestBadge'
import { NumericInput } from '../shared/NumericInput'
import EmptyState from '../shared/EmptyState'

interface CostsPanelProps {
  tripId: number
  tripMembers?: TripMember[]
}

interface Settlement {
  id: number
  from_user_id: number
  to_user_id: number
  amount: number
  // The currency the transfer was entered in. Legacy rows predate it (null) and are
  // read as the display currency, which is what the server assumes for them too.
  currency?: string | null
  created_at?: string
  from_username?: string
  to_username?: string
}
interface SettlementData {
  balances: { user_id: number; username: string; avatar_url: string | null; balance: number }[]
  flows: { from: { user_id: number; username: string }; to: { user_id: number; username: string }; amount: number }[]
  settlements: Settlement[]
}

// One row in the unified Costs ledger — either an expense or a settle-up payment,
// carrying the date used to group it by day.
type LedgerEntry =
  | { kind: 'expense'; date: string; e: BudgetItem }
  | { kind: 'payment'; date: string; s: Settlement }

const round2 = (n: number) => Math.round(n * 100) / 100
const FIELD_H = 40 // shared height for the amount / currency / day row in the modal

export default function CostsPanel({ tripId, tripMembers = [] }: CostsPanelProps) {
  const { trip, budgetItems, deleteBudgetItem, loadBudgetItems } = useTripStore()
  const me = useAuthStore(s => s.user?.id ?? -1)
  const can = useCanDo()
  const canEdit = can('budget_edit', trip)
  const toast = useToast()
  const { t, locale } = useTranslation()
  const isMobile = useIsMobile()

  // Display/base currency = the user's preferred currency (Settings), falling back
  // to the trip's own currency. Everything in Costs is converted to and shown in it.
  const displayCurrency = useSettingsStore(s => s.settings.default_currency)
  const base = (displayCurrency || trip?.currency || 'EUR').toUpperCase()
  // Pre-rework rows stored currency = NULL, meaning "the trip's own currency".
  const tripCurrency = (trip?.currency || base).toUpperCase()
  const { convert } = useExchangeRates(base)
  const curOf = useCallback((e: BudgetItem) => (e.currency || tripCurrency), [tripCurrency])
  const [settlement, setSettlement] = useState<SettlementData | null>(null)
  // A failed settlement read leaves `settlement` null, which the empty views would
  // otherwise present as "everyone is square", a balance claim we cannot make.
  const [settlementError, setSettlementError] = useState(false)
  const [filter, setFilter] = useState<'all' | 'mine' | 'owed'>('all')
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')   // '' = all categories
  const [dayFilter, setDayFilter] = useState('')   // '' = all days, else YYYY-MM-DD
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<BudgetItem | null>(null)
  const [previewReceipts, setPreviewReceipts] = useState<{ receipts: BudgetItemReceipt[]; initialIndex: number } | null>(null)
  // One note open at a time: two expanded rows next to each other read as a mess,
  // and the point of the collapse is that the list stays scannable.
  const [expandedNoteId, setExpandedNoteId] = useState<number | null>(null)
  const [editingSettlement, setEditingSettlement] = useState<Settlement | null>(null)
  const [addingPayment, setAddingPayment] = useState(false)

  const people = tripMembers
  const personById = useCallback((id: number) => people.find(p => p.id === id), [people])
  const personName = useCallback((id: number) => id === me ? t('costs.you') : (personById(id)?.username || '?'), [me, personById, t])
  const colorFor = useCallback((id: number) => {
    const idx = people.findIndex(p => p.id === id)
    return SPLIT_COLORS[(idx >= 0 ? idx : 0) % SPLIT_COLORS.length].gradient
  }, [people])
  const initial = useCallback((id: number) => id === me ? t('costs.youShort') : (personById(id)?.username || '?').charAt(0).toUpperCase(), [me, personById, t])

  const fmt = useCallback((v: number, c = base) => formatMoney(v, c, locale), [base, locale])
  const fmt0 = useCallback((v: number, c = base) => formatMoney(v, c, locale, { decimals: 0 }), [base, locale])

  const loadSettlement = useCallback(() => {
    budgetApi.settlement(tripId, base)
      .then(s => { setSettlement(s); setSettlementError(false) })
      .catch(() => setSettlementError(true))
  }, [tripId, base])

  useEffect(() => { loadBudgetItems(tripId); loadSettlement() }, [tripId])
  useEffect(() => { loadSettlement() }, [budgetItems.length, base])

  // The bottom-nav "+" on the Costs tab opens the add-expense modal via ?create=expense.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('create') === 'expense') {
      setEditing(null); setModalOpen(true)
      setSearchParams(p => { p.delete('create'); return p }, { replace: true })
    }
  }, [searchParams])

  // ── derived expense maths (everything converted to the base currency) ────
  const baseTotal = (e: BudgetItem) => convert(e.total_price || 0, curOf(e))
  const myPaidOf = (e: BudgetItem) => (e.payers || []).filter(p => p.user_id === me).reduce((a, p) => a + convert(p.amount, curOf(e)), 0)
  // "Unfinished": a recorded total nobody has paid yet — counts toward the trip
  // total but stays out of settlements until who-paid is filled in. A negative
  // total (a refund, #2176) is just as unfinished until its recipient is named.
  const isUnfinished = (e: BudgetItem) => baseTotal(e) !== 0 && (e.payers || []).filter(p => p.amount !== 0).length === 0
  const myShareOf = (e: BudgetItem) => {
    // Nobody paid, so nobody owes: the ledger skips these entirely (#2225), and
    // counting them here left the tile contradicting the balances right beside it.
    if (isUnfinished(e)) return 0
    const myMember = (e.members || []).find(m => m.user_id === me)
    if (!myMember) return 0
    if (myMember.amount !== null && myMember.amount !== undefined) {
      return convert(myMember.amount, curOf(e))
    }
    const shares = splitEqualShares(e.total_price || 0, e.members || [], e.id)
    const myShare = shares[me] || 0
    return convert(myShare, curOf(e))
  }

  const totals = useMemo(() => {
    const totalSpend = budgetItems.reduce((a, e) => a + baseTotal(e), 0)
    const myPaid = budgetItems.reduce((a, e) => a + myPaidOf(e), 0)
    const myShare = budgetItems.reduce((a, e) => a + myShareOf(e), 0)
    const owe = (settlement?.flows || []).filter(f => f.from.user_id === me).reduce((a, f) => a + f.amount, 0)
    const owed = (settlement?.flows || []).filter(f => f.to.user_id === me).reduce((a, f) => a + f.amount, 0)
    const outstanding = budgetItems.reduce((a, e) => (isUnfinished(e) ? a + baseTotal(e) : a), 0)
    const outstandingCount = budgetItems.filter(isUnfinished).length
    return { totalSpend, myPaid, myShare, owe, owed, outstanding, outstandingCount }
  }, [budgetItems, settlement, me])

  // ── filtering + day grouping ────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = budgetItems.slice()
    if (filter === 'mine') list = list.filter(e => myPaidOf(e) > 0)
    if (filter === 'owed') list = list.filter(e => round2(myPaidOf(e) - myShareOf(e)) > 0)
    // catMeta normalises legacy/free-text categories to the fixed keys, so the
    // filter matches rows saved before the category rework too.
    if (catFilter) list = list.filter(e => catMeta(e.category).key === catFilter)
    if (dayFilter) list = list.filter(e => (e.expense_date || '') === dayFilter)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter(e => e.name.toLowerCase().includes(q))
    return list
  }, [budgetItems, filter, search, catFilter, dayFilter, me])

  // Settlements ("payments") shown inline in the ledger. They have no name, so a
  // text search hides them; they're excluded from the "owed" expense filter and,
  // under "mine", only show transfers I'm part of.
  const filteredSettlements = useMemo(() => {
    // Payments carry no name or category, so a text/category filter hides them.
    if (search.trim() || catFilter) return []
    if (filter === 'owed') return []
    let list = settlement?.settlements || []
    if (filter === 'mine') list = list.filter(s => s.from_user_id === me || s.to_user_id === me)
    if (dayFilter) list = list.filter(s => (s.created_at || '').slice(0, 10) === dayFilter)
    return list
  }, [settlement, filter, search, catFilter, dayFilter, me])

  const dayGroups = useMemo(() => {
    const entries: LedgerEntry[] = [
      ...filtered.map(e => ({ kind: 'expense' as const, date: e.expense_date || '', e })),
      ...filteredSettlements.map(s => ({ kind: 'payment' as const, date: (s.created_at || '').slice(0, 10), s })),
    ]
    const labelOf = (date: string) => {
      if (!date) return t('costs.noDate')
      try { return new Date(date + 'T00:00:00Z').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) } catch { return date }
    }
    // Newest day first; within a day, expenses before payments (insertion order).
    const sorted = entries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    const groups: { day: string; entries: LedgerEntry[] }[] = []
    for (const en of sorted) {
      const day = labelOf(en.date)
      let g = groups.find(x => x.day === day)
      if (!g) { g = { day, entries: [] }; groups.push(g) }
      g.entries.push(en)
    }
    return groups
  }, [filtered, filteredSettlements, locale, t])

  // ── filter dropdown options (category + single day) ──────────────────────
  const categoryOptions = useMemo(() => [
    { value: '', label: t('costs.filter.allCategories') },
    ...COST_CATEGORY_LIST.map(c => ({ value: c.key, label: t(c.labelKey), icon: <c.Icon size={14} style={{ color: c.color }} /> })),
  ], [t])

  const dayOptions = useMemo(() => {
    const days = Array.from(new Set(budgetItems.map(e => e.expense_date).filter(Boolean) as string[])).sort((a, b) => b.localeCompare(a))
    const fmtDay = (d: string) => {
      try { return new Date(d + 'T00:00:00Z').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) } catch { return d }
    }
    return [{ value: '', label: t('costs.filter.allDays') }, ...days.map(d => ({ value: d, label: fmtDay(d) }))]
  }, [budgetItems, locale, t])

  // ── settle actions ──────────────────────────────────────────────────────
  const settleFlow = async (fromId: number, toId: number, amount: number) => {
    try {
      await budgetApi.createSettlement(tripId, { from_user_id: fromId, to_user_id: toId, amount, currency: base })
      loadSettlement()
    } catch { toast.error(t('common.unknownError')) }
  }
  const undoSettlement = async (id: number) => {
    try { await budgetApi.deleteSettlement(tripId, id); loadSettlement() } catch { toast.error(t('common.unknownError')) }
  }
  const settleAll = async () => {
    const flows = settlement?.flows || []
    if (!flows.length) return
    try {
      for (const f of flows) await budgetApi.createSettlement(tripId, { from_user_id: f.from.user_id, to_user_id: f.to.user_id, amount: f.amount, currency: base })
    } catch { toast.error(t('common.unknownError')) }
    // Refresh even when one transfer failed: the ones created before it are real,
    // and leaving them in the flow list invites a second, doubled settle-up.
    finally { loadSettlement() }
  }

  const dateMeta = useMemo(() => {
    if (!trip?.start_date || !trip?.end_date) return null
    try {
      const s = new Date(trip.start_date + 'T00:00:00Z'), e = new Date(trip.end_date + 'T00:00:00Z')
      const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1
      const opt = { day: 'numeric', month: 'short', timeZone: 'UTC' } as const
      return { range: `${s.toLocaleDateString(locale, opt)} – ${e.toLocaleDateString(locale, opt)}`, days }
    } catch { return null }
  }, [trip?.start_date, trip?.end_date, locale])

  const handleDelete = async (id: number) => {
    try { await deleteBudgetItem(tripId, id); loadSettlement() } catch { toast.error(t('common.unknownError')) }
  }

  // CSV export of all expenses — the wiki-documented export that got lost in the
  // Costs rework (#1500). One row per expense, oldest first.
  const handleExportCsv = () => {
    const sep = ';'
    // A cell starting with =, +, -, @, TAB or CR is evaluated as a formula by Excel
    // and Sheets, and the name/note columns are free text any trip member can write.
    const esc = (v: unknown) => {
      let s = String(v ?? '')
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
      return s.includes(sep) || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const fmtDate = (iso: string) => { if (!iso) return ''; try { return new Date(iso + 'T00:00:00Z').toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) } catch { return iso } }

    const header = ['Date', 'Name', 'Category', 'Amount', 'Currency', 'Amount (' + base + ')', 'Note']
    const rows = [header.join(sep)]
    const items = budgetItems.slice().sort((a, b) => (a.expense_date || '').localeCompare(b.expense_date || ''))
    for (const e of items) {
      const cur = curOf(e)
      const note = readUserNote(e)
      rows.push([
        esc(fmtDate(e.expense_date || '')), esc(e.name), esc(t(catMeta(e.category).labelKey)),
        (e.total_price || 0).toFixed(currencyDecimals(cur)), cur,
        baseTotal(e).toFixed(currencyDecimals(base)),
        esc(note),
      ].join(sep))
    }

    const bom = '﻿'
    const blob = new Blob([bom + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const safeName = (trip?.title || 'trip').replace(/[^a-zA-Z0-9À-ɏ _-]/g, '').trim()
    downloadBlob(blob, `costs-${safeName}.csv`)
  }

  // ── small presentational helpers ────────────────────────────────────────
  const Avatar = ({ id, size = 24 }: { id: number; size?: number }) => {
    const url = personById(id)?.avatar_url
    if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, display: 'block' }} />
    return <span style={{ width: size, height: size, borderRadius: '50%', background: colorFor(id), color: '#fff', display: 'grid', placeItems: 'center', fontSize: size * 0.4, fontWeight: 700, flexShrink: 0 }}>{initial(id)}</span>
  }

  const cardCls = 'bg-surface-card border border-edge'
  const labelCls = 'text-[11px] font-semibold uppercase tracking-[0.12em] text-content-faint'

  // Big money number with the design's muted symbol/decimals, locale-correct via Intl.
  const bigMoney = (amount: number, smallSize: number, mutedColor: string) => {
    let parts: Intl.NumberFormatPart[] | null = null
    try {
      const d = currencyDecimals(base)
      parts = new Intl.NumberFormat(currencyLocale(base), { style: 'currency', currency: base, minimumFractionDigits: d, maximumFractionDigits: d }).formatToParts(amount || 0)
    } catch { return <>{formatMoney(amount, base, locale)}</> }
    const isBig = (p: Intl.NumberFormatPart) => p.type === 'integer' || p.type === 'group' || p.type === 'minusSign'
    return <>{parts.map((p, i) => <span key={i} style={isBig(p) ? undefined : { fontSize: smallSize, fontWeight: 500, color: mutedColor }}>{p.value}</span>)}</>
  }

  // ── category + day filter controls (shared by both layouts) ──────────────
  const filterControls = (
    <>
      <CustomSelect value={catFilter} onChange={v => setCatFilter(String(v))} options={categoryOptions} size="sm" style={{ minWidth: 148 }} />
      <CustomSelect value={dayFilter} onChange={v => setDayFilter(String(v))} options={dayOptions} size="sm" searchable style={{ minWidth: 140 }} />
    </>
  )

  // A prominent summary shown when a single day is selected: the day + its total.
  const dayFilterTotal = dayFilter ? filtered.reduce((a, e) => a + baseTotal(e), 0) : 0
  const dayFilterLabel = dayFilter
    ? (() => { try { return new Date(dayFilter + 'T00:00:00Z').toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) } catch { return dayFilter } })()
    : ''
  const dayBanner = dayFilter ? (
    <div className={cardCls} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, borderRadius: 16, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ minWidth: 0 }}>
        <div className="text-content" style={{ fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 700, letterSpacing: '-0.01em' }}>{dayFilterLabel}</div>
        <div className="text-content-muted" style={{ marginTop: 3, fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>{t('costs.expensesCount', { count: filtered.length })}</div>
      </div>
      <div className="text-content" style={{ fontSize: 'calc(26px * var(--fs-scale-title, 1))', fontWeight: 700, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>{bigMoney(dayFilterTotal, 15, 'var(--text-muted)')}</div>
    </div>
  ) : null

  return (
    <div className="costs-root" style={{ minHeight: '100%', background: 'var(--c-bg)', padding: isMobile ? '6px 14px 28px' : '40px 24px 48px' }}>
     {isMobile ? MobileBody() : (
     <div style={{ maxWidth: '100%', margin: '0 auto' }}>
      {/* ── Header bar ── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, marginBottom: 28, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {dateMeta && (
            <span className="bg-surface-card border border-edge text-content-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 999, fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500, whiteSpace: 'nowrap' }}>
              {dateMeta.range} · <b className="text-content">{t('costs.daysCount', { count: dateMeta.days })}</b>
            </span>
          )}
          <span className="bg-surface-card border border-edge text-content-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px 8px 10px', borderRadius: 999, fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500 }}>
            <span style={{ display: 'inline-flex' }}>
              {people.slice(0, 4).map((p, i) => {
                const common = { width: 22, height: 22, borderRadius: '50%', border: '2px solid var(--bg-card)', marginLeft: i ? -8 : 0, flexShrink: 0 } as const
                return p.avatar_url
                  ? <img key={p.id} src={p.avatar_url} alt="" style={{ ...common, objectFit: 'cover', display: 'block' }} />
                  : <span key={p.id} style={{ ...common, background: colorFor(p.id), color: '#fff', display: 'grid', placeItems: 'center', fontSize: 'calc(9px * var(--fs-scale-caption, 1))', fontWeight: 700 }}>{(p.id === me ? t('costs.youShort') : p.username.charAt(0)).toUpperCase()}</span>
              })}
            </span>
            <b className="text-content">{t('costs.travelers', { count: people.length })}</b>
          </span>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={settleAll} disabled={!(settlement?.flows || []).length}
              className="bg-surface-card border border-edge text-content disabled:opacity-40"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderRadius: 12, fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
              <Check size={16} /> {t('costs.settleUp')}
            </button>
            <button type="button" onClick={() => { setEditing(null); setModalOpen(true) }}
              className="bg-[var(--text-primary)] text-[var(--bg-primary)]"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 12, fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 600, border: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
              <Plus size={16} /> {t('costs.addExpense')}
            </button>
          </div>
        )}
      </div>

      {/* ── Summary cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 36 }} className="costs-summary">
        <SummaryCard label={t('costs.youOwe')} sub={t('costs.youOweSub')} amount={totals.owe} currency={base} locale={locale}
          icon={<ArrowDown size={18} />} tone="owe"
          foot={totals.owe > 0.01
            ? <FlowPills ids={(settlement?.flows || []).filter(f => f.from.user_id === me).map(f => f.to.user_id)} lead={t('costs.to')} Avatar={Avatar} name={personName} />
            : <span className="text-content-faint">{t('costs.allSettled')}</span>} />
        <SummaryCard label={t('costs.youreOwed')} sub={t('costs.youreOwedSub')} amount={totals.owed} currency={base} locale={locale}
          icon={<ArrowUp size={18} />} tone="owed"
          foot={totals.owed > 0.01
            ? <FlowPills ids={(settlement?.flows || []).filter(f => f.to.user_id === me).map(f => f.from.user_id)} lead={t('costs.from')} Avatar={Avatar} name={personName} />
            : <span className="text-content-faint">{t('costs.nothingOwed')}</span>} />
        <SummaryCard label={t('costs.outstanding')} sub={t('costs.outstandingSub')} amount={totals.outstanding} currency={base} locale={locale}
          icon={<AlertCircle size={18} />} tone="unfinished"
          foot={totals.outstandingCount > 0
            ? <span><b>{totals.outstandingCount}</b> {t('costs.outstandingItems')}</span>
            : <span className="text-content-faint">{t('costs.allSettled')}</span>} />
        <SummaryCard label={t('costs.totalSpend')} sub={t('costs.totalSpendSub')} amount={totals.totalSpend} currency={base} locale={locale}
          icon={<BarChart3 size={18} />} tone="total"
          foot={<span style={{ display: 'flex', gap: 16 }}><span>{t('costs.yourShare')} · <b>{fmt0(totals.myShare)}</b></span><span>{t('costs.youPaid')} · <b>{fmt0(totals.myPaid)}</b></span></span>} />
      </div>

      {/* ── Main grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 32, alignItems: 'start' }} className="costs-grid">
        {/* expenses */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
            <h3 className="text-content" style={{ fontSize: 'calc(24px * var(--fs-scale-title, 1))', fontWeight: 600, letterSpacing: '-0.025em', margin: 0 }}>
              {t('costs.expenses')}
            </h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', gap: 6, borderRadius: 10, padding: '0 10px', height: 34 }}>
                <Search size={15} className="text-content-faint" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('costs.searchPlaceholder')}
                  className="text-content" style={{ border: 0, background: 'none', outline: 'none', fontSize: 'calc(13px * var(--fs-scale-body, 1))', width: 150, fontFamily: 'inherit' }} />
              </div>
              {filterControls}
              <div className="bg-surface-secondary" style={{ display: 'flex', borderRadius: 9, padding: 3 }}>
                {(['all', 'mine', 'owed'] as const).map(f => (
                  <button type="button" key={f} onClick={() => setFilter(f)}
                    className={filter === f ? 'bg-surface-card text-content' : 'text-content-muted'}
                    style={{ padding: '6px 11px', fontSize: 'calc(12px * var(--fs-scale-body, 1))', borderRadius: 7, fontWeight: 500, border: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                    {t('costs.filter.' + f)}
                  </button>
                ))}
              </div>
              <button type="button" onClick={handleExportCsv} title={t('budget.exportCsv')} disabled={!budgetItems.length}
                className="bg-surface-input border border-edge text-content-muted disabled:opacity-40"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
                <Download size={15} />
              </button>
            </div>
          </div>

          {dayBanner}
          {dayGroups.length === 0 ? (
            search ? (
              <div className="text-content-faint" style={{ textAlign: 'center', padding: '60px 20px' }}>
                {t('costs.noMatch')}
              </div>
            ) : (
              <EmptyState scene="costs" title={t('costs.emptyText')} />
            )
          ) : dayGroups.map(g => {
            const dtot = g.entries.reduce((a, en) => en.kind === 'expense' ? a + baseTotal(en.e) : a, 0)
            return (
              <div key={g.day} style={{ marginBottom: 22 }}>
                {!dayFilter && (
                <div className={labelCls} style={{ display: 'flex', alignItems: 'center', margin: '0 0 10px 4px' }}>
                  {g.day}<span className="text-content-muted" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>{t('costs.spent', { amount: fmt(dtot) })}</span>
                </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {g.entries.map(en => en.kind === 'expense'
                    ? <Fragment key={'e' + en.e.id}>{ExpenseRow({ e: en.e })}</Fragment>
                    : <Fragment key={'s' + en.s.id}>{SettlementRow({ s: en.s })}</Fragment>)}
                </div>
              </div>
            )
          })}
        </div>

        {/* sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* settle up */}
          <div className={cardCls} style={{ borderRadius: 22, padding: '22px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div className={labelCls}>{t('costs.settleUp')} · <span className="text-content">{(settlement?.flows || []).length}</span></div>
              {canEdit && (
                <button type="button" onClick={() => setAddingPayment(true)}
                  className="text-content-muted bg-surface-secondary border border-edge"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 8, fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  <Plus size={13} /> {t('costs.addPayment')}
                </button>
              )}
            </div>
            {SettleFlows()}
          </div>

          {/* balances */}
          <div className={cardCls} style={{ borderRadius: 22, padding: '22px 24px' }}>
            <div className={labelCls} style={{ marginBottom: 14 }}>{t('costs.balances')}</div>
            {BalancesList({ balances: settlement?.balances || [] })}
          </div>

          {/* by category */}
          <div className={cardCls} style={{ borderRadius: 22, padding: '22px 24px' }}>
            <div className={labelCls} style={{ marginBottom: 14 }}>{t('costs.byCategory')}</div>
            {CategoryBreakdown()}
          </div>
        </div>
      </div>
      </div>)}

      {modalOpen && (
        <ExpenseModal tripId={tripId} base={base} people={people} me={me} editing={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); loadBudgetItems(tripId); loadSettlement() }} />
      )}

      {(editingSettlement || addingPayment) && (
        <SettlementModal tripId={tripId} people={people} me={me} editing={editingSettlement} currency={base}
          onClose={() => { setEditingSettlement(null); setAddingPayment(false) }}
          onSaved={() => { setEditingSettlement(null); setAddingPayment(false); loadSettlement() }} />
      )}

      {previewReceipts && (
        <ReceiptPreviewModal
          receipts={previewReceipts.receipts}
          initialIndex={previewReceipts.initialIndex}
          onClose={() => setPreviewReceipts(null)}
        />
      )}

      <style>{`
        .costs-root {
          --c-bg: #f8fafc; --c-bg2: oklch(0.965 0.01 70);
          --c-surface: #ffffff; --c-surface2: oklch(0.985 0.006 78);
          --c-ink: oklch(0.22 0.012 65); --c-ink2: oklch(0.42 0.012 65); --c-ink3: oklch(0.62 0.01 65);
          --c-line: oklch(0.92 0.008 70);
        }
        html.dark .costs-root {
          --c-bg: #121215; --c-bg2: #18181c;
          --c-surface: #1a1a1e; --c-surface2: #202027;
          --c-ink: #f4f4f5; --c-ink2: #a1a1aa; --c-ink3: #71717a;
          --c-line: #2a2a31;
        }
        .costs-root .bg-surface-card { background: var(--c-surface) !important; }
        .costs-root .bg-surface-secondary, .costs-root .bg-surface-input { background: var(--c-surface2) !important; }
        .costs-root .border-edge { border-color: var(--c-line) !important; }
        /* dark = neutral zinc + a touch of liquid glass, matching the dashboard */
        html.dark .costs-root .bg-surface-card {
          background: rgba(255,255,255,0.035) !important;
          border-color: rgba(255,255,255,0.08) !important;
          backdrop-filter: blur(20px) saturate(1.4);
          -webkit-backdrop-filter: blur(20px) saturate(1.4);
        }
        html.dark .costs-root .bg-surface-secondary,
        html.dark .costs-root .bg-surface-input { background: rgba(255,255,255,0.05) !important; }
        html.dark .costs-root .border-edge { border-color: rgba(255,255,255,0.08) !important; }
        .costs-root .text-content { color: var(--c-ink) !important; }
        .costs-root .text-content-muted { color: var(--c-ink2) !important; }
        .costs-root .text-content-faint { color: var(--c-ink3) !important; }
        .costs-root .exp-actions { opacity: 1; }
        .costs-root .exp-actions button { background: none; }
        .costs-root .exp-actions button:hover { background: var(--bg-secondary); color: var(--c-ink); }
        /* Destructive actions keep their own tint: the neutral one would read as
           "safe" on the button that deletes the expense. */
        .costs-root .exp-actions .exp-action-danger:hover { background: rgba(220,38,38,0.14); color: #dc2626; }
        @media (max-width: 1100px) {
          .costs-root .costs-summary { grid-template-columns: 1fr 1fr !important; }
          .costs-root .costs-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 640px) {
          .costs-root .costs-summary { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  )

  // Settle-up and Balances both come from the one settlement request, so they
  // share the notice that says the numbers are missing rather than zero.
  function loadFailed() {
    return <div className="text-content-muted" style={{ textAlign: 'center', padding: '14px 8px', fontSize: 'calc(12.5px * var(--fs-scale-body, 1))' }}>{t('common.unknownError')}</div>
  }

  // ── shared settle-flow list ──────────────────────────────────────────────
  function SettleFlows() {
    if (settlementError) return loadFailed()
    const flows = settlement?.flows || []
    if (flows.length === 0) return (
      <div style={{ textAlign: 'center', padding: '14px 8px' }}>
        <div style={{ width: 46, height: 46, borderRadius: '50%', margin: '0 auto 10px', display: 'grid', placeItems: 'center', background: 'rgba(22,163,74,0.12)', color: '#16a34a' }}><Check size={22} /></div>
        <div className="text-content" style={{ fontSize: 'calc(14.5px * var(--fs-scale-body, 1))', fontWeight: 600 }}>{t('costs.everyoneSquare')}</div>
        <div className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', marginTop: 2 }}>{t('costs.nothingOutstanding')}</div>
      </div>
    )
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {flows.map((f, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} title={`${personName(f.from.user_id)} → ${f.to.user_id === me ? t('costs.youLower') : personName(f.to.user_id)}`}>
              <Avatar id={f.from.user_id} size={32} /><ArrowRight size={15} className="text-content-faint" /><Avatar id={f.to.user_id} size={32} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span className="text-content" style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 700 }}>{fmt(f.amount)}</span>
              {canEdit && <button type="button" onClick={() => settleFlow(f.from.user_id, f.to.user_id, f.amount)} className="bg-[var(--text-primary)] text-[var(--bg-primary)]" style={{ padding: '7px 12px', borderRadius: 9, fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, border: 0, cursor: 'pointer', fontFamily: 'inherit' }}>{t('costs.settle')}</button>}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ── mobile layout (Budget1Mobile.html): single flat column, total card on top ──
  //
  // Called as a plain function — `{MobileBody()}`, not `<MobileBody />` — and the
  // same goes for ExpenseRow, SettleFlows, BalancesList and CategoryBreakdown.
  // A component declared inside this one is a fresh component type on every
  // render, so React tears the old subtree down and mounts a new one instead of
  // updating it; the search box then loses focus after every keystroke. Calling
  // them keeps the markup inline where it always was. Do not "tidy" these back
  // into elements.
  function MobileBody() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 8 }}>
        {/* Total card */}
        <section style={{ background: 'linear-gradient(135deg,#1f2937,#111827)', color: '#fff', borderRadius: 22, padding: '20px 20px 16px', boxShadow: '0 8px 24px -8px rgba(0,0,0,0.28)' }}>
          <div style={{ fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.6)', fontWeight: 600 }}>{t('costs.totalSpend')}</div>
          <div style={{ fontSize: 'calc(44px * var(--fs-scale-title, 1))', fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1, marginTop: 8, display: 'flex', alignItems: 'baseline' }}>{bigMoney(totals.totalSpend, 24, 'rgba(255,255,255,0.6)')}</div>
          <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 'calc(12px * var(--fs-scale-body, 1))', color: 'rgba(255,255,255,0.6)', flexWrap: 'wrap' }}>
            <span>{t('costs.yourShare')} · <b style={{ color: '#fff', fontWeight: 600 }}>{fmt0(totals.myShare)}</b></span>
            <span>{t('costs.youPaid')} · <b style={{ color: '#fff', fontWeight: 600 }}>{fmt0(totals.myPaid)}</b></span>
          </div>
          {canEdit && (
            <button type="button" onClick={() => { setEditing(null); setModalOpen(true) }} style={{ marginTop: 16, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.16)', color: '#fff', padding: 13, borderRadius: 14, fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              <Plus size={17} /> {t('costs.addExpense')}
            </button>
          )}
        </section>

        {/* Owe / Owed */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className={cardCls} style={{ borderRadius: 18, padding: 16 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', marginBottom: 10, background: '#dc262622', color: '#dc2626' }}><ArrowDown size={17} /></div>
            <div className="text-content" style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 600 }}>{t('costs.youOwe')}</div>
            <div className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))' }}>{t('costs.youOweSub')}</div>
            <div style={{ fontSize: 'calc(27px * var(--fs-scale-title, 1))', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, marginTop: 12, display: 'flex', alignItems: 'baseline', color: '#dc2626' }}>{bigMoney(totals.owe, 16, 'var(--c-ink3)')}</div>
          </div>
          <div className={cardCls} style={{ borderRadius: 18, padding: 16 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', marginBottom: 10, background: '#16a34a22', color: '#16a34a' }}><ArrowUp size={17} /></div>
            <div className="text-content" style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 600 }}>{t('costs.youreOwed')}</div>
            <div className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))' }}>{t('costs.youreOwedSub')}</div>
            <div style={{ fontSize: 'calc(27px * var(--fs-scale-title, 1))', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, marginTop: 12, display: 'flex', alignItems: 'baseline', color: '#16a34a' }}>{bigMoney(totals.owed, 16, 'var(--c-ink3)')}</div>
          </div>
        </div>

        {/* Outstanding */}
        <div className={cardCls} style={{ borderRadius: 18, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: '#d9770622', color: '#d97706', flexShrink: 0 }}><AlertCircle size={17} /></div>
            <div style={{ minWidth: 0 }}>
              <div className="text-content" style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 600 }}>{t('costs.outstanding')}</div>
              <div className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))' }}>{t('costs.outstandingSub')}</div>
            </div>
            <div style={{ marginLeft: 'auto', fontSize: 'calc(27px * var(--fs-scale-title, 1))', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, display: 'flex', alignItems: 'baseline', color: '#d97706' }}>{bigMoney(totals.outstanding, 16, 'var(--c-ink3)')}</div>
          </div>
        </div>

        {/* Settle up */}
        <div className={cardCls} style={{ borderRadius: 18, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 8 }}>
            <div className="text-content" style={{ fontSize: 'calc(19px * var(--fs-scale-subtitle, 1))', fontWeight: 700, letterSpacing: '-0.02em', display: 'flex', alignItems: 'baseline', gap: 8 }}>{t('costs.settleUp')} <span className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 500 }}>{(settlement?.flows || []).length}</span></div>
            {canEdit && (
              <button type="button" onClick={() => setAddingPayment(true)} className="text-content-muted bg-surface-card border border-edge" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 9, fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}><Plus size={13} /> {t('costs.addPayment')}</button>
            )}
          </div>
          {SettleFlows()}
        </div>

        {/* Expenses */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div className="text-content" style={{ fontSize: 'calc(19px * var(--fs-scale-subtitle, 1))', fontWeight: 700, letterSpacing: '-0.02em' }}>{t('costs.expenses')}</div>
            <button type="button" onClick={handleExportCsv} title={t('budget.exportCsv')} disabled={!budgetItems.length}
              className="bg-surface-card border border-edge text-content-muted disabled:opacity-40"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
              <Download size={15} />
            </button>
          </div>
          <div className="bg-surface-card border border-edge" style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 12, padding: '0 12px', height: 42 }}>
            <Search size={16} className="text-content-faint" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('costs.searchPlaceholder')} className="text-content" style={{ border: 0, background: 'none', outline: 'none', fontSize: 'calc(14px * var(--fs-scale-body, 1))', width: '100%', fontFamily: 'inherit' }} />
          </div>
          <div className="bg-surface-secondary" style={{ display: 'flex', borderRadius: 11, padding: 3, gap: 2 }}>
            {(['all', 'mine', 'owed'] as const).map(f => (
              <button type="button" key={f} onClick={() => setFilter(f)} className={filter === f ? 'bg-surface-card text-content' : 'text-content-muted'} style={{ flex: 1, padding: '8px 6px', fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 500, borderRadius: 8, border: 0, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>{t('costs.filter.' + f)}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <CustomSelect value={catFilter} onChange={v => setCatFilter(String(v))} options={categoryOptions} size="sm" style={{ flex: 1, minWidth: 0 }} />
            <CustomSelect value={dayFilter} onChange={v => setDayFilter(String(v))} options={dayOptions} size="sm" searchable style={{ flex: 1, minWidth: 0 }} />
          </div>
          {dayBanner}
          {dayGroups.length === 0
            ? <div className="text-content-faint" style={{ textAlign: 'center', padding: '36px 16px', fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>{search ? t('costs.noMatch') : t('costs.emptyText')}</div>
            : dayGroups.map(g => {
                const dtot = g.entries.reduce((a, en) => en.kind === 'expense' ? a + baseTotal(en.e) : a, 0)
                return (
                  <div key={g.day} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {!dayFilter && <div className={labelCls} style={{ display: 'flex', alignItems: 'center', padding: '0 2px' }}>{g.day}<span className="text-content-muted" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))' }}>{t('costs.spent', { amount: fmt(dtot) })}</span></div>}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{g.entries.map(en => en.kind === 'expense'
                      ? <Fragment key={'e' + en.e.id}>{ExpenseRow({ e: en.e })}</Fragment>
                      : <Fragment key={'s' + en.s.id}>{SettlementRow({ s: en.s })}</Fragment>)}</div>
                  </div>
                )
              })}
        </div>

        {/* Balances */}
        <div className={cardCls} style={{ borderRadius: 18, padding: 16 }}>
          <div className={labelCls} style={{ marginBottom: 14 }}>{t('costs.balances')}</div>
          {BalancesList({ balances: settlement?.balances || [] })}
        </div>

        {/* By category */}
        <div className={cardCls} style={{ borderRadius: 18, padding: 16 }}>
          <div className={labelCls} style={{ marginBottom: 14 }}>{t('costs.byCategory')}</div>
          {CategoryBreakdown()}
        </div>
      </div>
    )
  }

  // ── inline subcomponents (close over helpers) ────────────────────────────
  /**
   * Edit and delete, in a capsule beside the row rather than inside it — the
   * mobile card has always done it this way, and out here the buttons stop
   * competing with the amount for the right edge of the card.
   */
  function RowActions({ onEdit, onDelete, deleteLabel }: { onEdit: () => void; onDelete: () => void; deleteLabel: string }) {
    // No `background` here on purpose: an inline value would beat the :hover
    // rule in the stylesheet block below, which is how the first attempt at
    // this silently did nothing.
    const btn: React.CSSProperties = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 30, height: 30, borderRadius: 999, border: 0,
      cursor: 'pointer', padding: 0,
    }
    return (
      <div className="exp-actions bg-surface-card border border-edge" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, flexShrink: 0, borderRadius: 999, padding: 5 }}>
        <button type="button" title={t('common.edit')} onClick={onEdit} className="text-content-muted transition-colors" style={btn}><Pencil size={13} /></button>
        <button type="button" title={deleteLabel} onClick={onDelete} className="exp-action-danger transition-colors" style={{ ...btn, color: '#dc2626' }}><Trash2 size={13} /></button>
      </div>
    )
  }

  // Called, not rendered — see MobileBody: an element here would remount the
  // list on every keystroke in the search box.
  function ExpenseRow({ e }: { e: BudgetItem }) {
    const c = catMeta(e.category)
    const Icon = c.Icon
    const cur = curOf(e)
    const payers = (e.payers || []).filter(p => p.amount !== 0)
    const net = round2(myPaidOf(e) - myShareOf(e))
    const unfinished = isUnfinished(e)
    const note = readUserNote(e)
    const open = expandedNoteId === e.id

    // Fixed columns, identical on every row, so the eye can run down the list
    // instead of re-finding each field on each line. A row without a note leaves
    // its column empty rather than letting everything after it drift left, which
    // is what made the list read as unstructured.
    const cols = isMobile ? '46px 1fr auto' : '46px minmax(200px, 1fr) minmax(0, 1.5fr) auto'

    return (
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
      <div className="bg-surface-card border border-edge exp-row" style={{ position: 'relative', flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: cols, gap: 18, alignItems: 'center', borderRadius: 18, padding: isMobile ? '16px 20px' : '20px 20px 16px' }}>
        {/* The category rides the card edge as a tab, the way the mobile card
            does, so it stops taking up a slot inside the row itself. */}
        {!isMobile && (
          <span aria-hidden="true" style={{ position: 'absolute', left: -1, top: -1, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 11px 4px 10px', borderRadius: '17px 0 12px 0', background: c.color, color: '#fff', fontSize: 'calc(9.5px * var(--fs-scale-caption, 1))', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', lineHeight: 1.2 }}>
            <Icon size={10} strokeWidth={2.4} />
            {t(c.labelKey)}
          </span>
        )}

        <span style={{ position: 'relative', width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center', background: c.color + '22', color: c.color }}>
          <Icon size={21} />
          {isMobile && unfinished && (
            <span title={t('costs.unfinishedHint')} style={{ position: 'absolute', bottom: -4, right: -4, width: 20, height: 20, borderRadius: '50%', background: '#d97706', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 800, lineHeight: 1, border: '2px solid var(--bg-card)' }}>!</span>
          )}
        </span>

        {/* What it was. */}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <span className="text-content" style={{ fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            {unfinished && !isMobile && (
              <span title={t('costs.unfinishedHint')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px 2px 6px', borderRadius: 999, background: 'rgba(217,119,6,0.14)', color: '#d97706', fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 700, flexShrink: 0 }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#d97706', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 800 }}>!</span>
                {t('costs.unfinished')}
              </span>
            )}
            {(e.receipts || []).length > 0 && (
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation()
                  setPreviewReceipts({ receipts: e.receipts!, initialIndex: 0 })
                }}
                title={t('costs.viewReceipt')}
                className="bg-surface-secondary border border-edge text-content-muted hover:text-content hover:border-content-faint transition-all"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 999,
                  fontSize: 'calc(11px * var(--fs-scale-caption, 1))',
                  fontWeight: 600,
                  flexShrink: 0,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <Receipt size={12} className="text-content-muted" />
                <span>{t('costs.receipts') || 'Beleg'}{e.receipts!.length > 1 ? ` (${e.receipts!.length})` : ''}</span>
              </button>
            )}
          </div>
          {cur !== base && (
            <div className="text-content-faint" style={{ marginTop: 4, fontSize: 'calc(12px * var(--fs-scale-body, 1))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fmt(e.total_price, cur)} {'→'} {fmt(baseTotal(e))}
            </div>
          )}
          {/* Under the name, because a chip reading "Y 122,00" says nothing on
              its own — the name above it is what gives it a meaning. */}
          {payers.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
              {payers.map(p => (
                <span key={p.user_id} className="bg-surface-secondary border border-edge" title={personName(p.user_id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 3px', borderRadius: 999, fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))' }}>
                  <Avatar id={p.user_id} size={18} />
                  <span className="text-content" style={{ fontWeight: 700 }}>{fmt(convert(p.amount, cur))}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* The note, marked by a rule in the category colour instead of a box, so
            it reads as part of the row rather than something dropped onto it. */}
        {!isMobile && (
          note ? (
            <button type="button" onClick={() => setExpandedNoteId(open ? null : e.id)}
              aria-expanded={open} title={open ? t('costs.hideNote') : t('costs.showNote')}
              className="bg-surface-secondary border border-edge text-content-muted hover:text-content hover:border-content-faint transition-colors exp-note-btn"
              style={{ display: 'flex', alignItems: open ? 'flex-start' : 'center', gap: 9, minWidth: 0, width: '100%', padding: open ? '10px 14px 11px 13px' : '7px 12px 7px 11px', borderRadius: open ? 14 : 999, borderLeft: '3px solid ' + c.color, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', lineHeight: 1.5, textAlign: 'left' }}>
              <span style={open
                ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0, flex: 1 }
                : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 }}>{note}</span>
              <ChevronDown size={13} style={{ flexShrink: 0, marginTop: open ? 3 : 0, transition: 'transform .18s ease', transform: open ? 'rotate(180deg)' : 'none' }} />
            </button>
          ) : <span />
        )}

        {/* The money, and what to do with it. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, whiteSpace: 'nowrap' }}>
            <span className="bg-surface-secondary border border-edge text-content" style={{ display: 'inline-flex', alignItems: 'center', padding: isMobile ? '0' : '6px 13px', borderRadius: 999, border: isMobile ? 0 : undefined, background: isMobile ? 'none' : undefined, fontSize: isMobile ? 'calc(18px * var(--fs-scale-subtitle, 1))' : 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(baseTotal(e))}</span>
            {!unfinished && (e.members || []).length > 0 && Math.abs(net) > 0.01 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', padding: isMobile ? 0 : '2px 9px', borderRadius: 999, background: isMobile ? 'none' : (net > 0 ? 'rgba(22,163,74,0.13)' : 'rgba(220,38,38,0.13)'), fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 600, color: net > 0 ? '#16a34a' : '#dc2626' }}>
                {net > 0 ? t('costs.youLent', { amount: fmt(net) }) : t('costs.youBorrowed', { amount: fmt(-net) })}
              </span>
            )}
          </div>
        </div>
      </div>
      {canEdit && RowActions({ onEdit: () => { setEditing(e); setModalOpen(true) }, onDelete: () => handleDelete(e.id), deleteLabel: t('common.delete') })}
      </div>
    )
  }

  // A settle-up payment as a ledger row — visually distinct from an expense, with
  // inline edit + undo (reuses deleteSettlement) so it isn't buried in a modal.
  function SettlementRow({ s }: { s: Settlement }) {
    // Legacy transfers carry no currency and were entered in the display base.
    const cur = (s.currency || base).toUpperCase()
    return (
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
      <div className="bg-surface-card border border-edge exp-row" style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: isMobile ? '46px 1fr auto' : '46px minmax(200px, 1fr) minmax(0, 1.5fr) auto', gap: isMobile ? 16 : 18, alignItems: 'center', borderRadius: 18, padding: '16px 20px' }}>
        <span style={{ width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'rgba(22,163,74,0.12)', color: '#16a34a' }}><ArrowLeftRight size={21} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="text-content" style={{ fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 600, marginBottom: 6 }}>
            {t('costs.payment')}
            {cur !== base && <span className="text-content-faint" style={{ fontWeight: 400, fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}> · {fmt(s.amount, cur)} → {fmt(convert(s.amount, cur))}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }} title={`${personName(s.from_user_id)} → ${personName(s.to_user_id)}`}>
            <Avatar id={s.from_user_id} size={20} /><ArrowRight size={13} className="text-content-faint" /><Avatar id={s.to_user_id} size={20} />
            <span className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{personName(s.from_user_id)} → {personName(s.to_user_id)}</span>
          </div>
        </div>
        {/* A payment carries no note, but it keeps the column so its amount lands
            on the same axis as every expense above it. */}
        {!isMobile && <span />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'center' }}>
          <span className="bg-surface-secondary border border-edge text-content" style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 13px', borderRadius: 999, fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 700, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmt(convert(s.amount, cur))}</span>
        </div>
      </div>
      {canEdit && (
        <div className="exp-actions bg-surface-card border border-edge" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, flexShrink: 0, borderRadius: 999, padding: 5 }}>
          <button type="button" title={t('common.edit')} onClick={() => setEditingSettlement(s)} className="text-content-muted transition-colors" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 999, border: 0, cursor: 'pointer', padding: 0 }}><Pencil size={13} /></button>
          <button type="button" title={t('costs.undo')} onClick={() => undoSettlement(s.id)} className="exp-action-danger transition-colors" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 999, border: 0, cursor: 'pointer', padding: 0, color: '#dc2626' }}><RotateCcw size={13} /></button>
        </div>
      )}
      </div>
    )
  }

  function BalancesList({ balances }: { balances: SettlementData['balances'] }) {
    if (settlementError) return loadFailed()
    const rows = people.map(p => balances.find(b => b.user_id === p.id) || { user_id: p.id, username: p.username, avatar_url: null, balance: 0 })
    const max = Math.max(1, ...rows.map(r => Math.abs(r.balance)))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map(r => {
          const pct = Math.min(100, Math.abs(r.balance) / max * 100)
          const pos = r.balance > 0.01, neg = r.balance < -0.01
          return (
            <div key={r.user_id} style={{ display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: 10, alignItems: 'center' }}>
              <Avatar id={r.user_id} size={28} />
              <div>
                <div className="text-content" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600 }}>{personName(r.user_id)}</div>
                <div className="bg-surface-secondary" style={{ height: 5, borderRadius: 3, marginTop: 5, position: 'relative', overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: 'var(--border-primary)' }} />
                  {pos && <span style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: pct / 2 + '%', background: '#16a34a', borderRadius: 3 }} />}
                  {neg && <span style={{ position: 'absolute', right: '50%', top: 0, bottom: 0, width: pct / 2 + '%', background: '#dc2626', borderRadius: 3 }} />}
                </div>
              </div>
              <div style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600, textAlign: 'right', color: pos ? '#16a34a' : neg ? '#dc2626' : 'var(--text-faint)' }}>
                {pos ? '+' + fmt(r.balance) : neg ? '−' + fmt(-r.balance) : fmt(0)}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  function CategoryBreakdown() {
    // Categories net refunds against spend (#2176): a negative entry lowers its
    // category's sum, and a category that nets negative keeps its own row —
    // just without a bar, since the bars rank positive spend.
    const tot: Record<string, number> = {}
    for (const e of budgetItems) { const k = catMeta(e.category).key; tot[k] = (tot[k] || 0) + baseTotal(e) }
    const rows = COST_CATEGORY_LIST.filter(c => (tot[c.key] || 0) !== 0).sort((a, b) => (tot[b.key] || 0) - (tot[a.key] || 0))
    if (rows.length === 0) return <div className="text-content-faint" style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))' }}>{t('costs.noCategories')}</div>
    // Bars are scaled relative to the most expensive category (the top row fills the
    // bar), not to the trip grand total — makes the relative ranking readable.
    const maxCat = Math.max(0, ...rows.map(c => tot[c.key] || 0))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map(c => {
          const v = tot[c.key]; const pct = maxCat > 0 && v > 0 ? v / maxCat * 100 : 0
          return (
            <div key={c.key} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center' }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: c.color }} />
              <span className="text-content" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500 }}>{t(c.labelKey)}</span>
              <span className="text-content-muted" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600 }}>{fmt0(v)}</span>
              <div className="bg-surface-secondary" style={{ gridColumn: '1 / -1', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: -2 }}>
                <span style={{ display: 'block', height: '100%', width: pct + '%', background: c.color, borderRadius: 3 }} />
              </div>
            </div>
          )
        })}
      </div>
    )
  }
}

// ── pure subcomponents ─────────────────────────────────────────────────────
function SummaryCard({ label, sub, amount, currency, locale, icon, foot, tone }: { label: string; sub: string; amount: number; currency: string; locale: string; icon: React.ReactNode; foot: React.ReactNode; tone: 'owe' | 'owed' | 'total' | 'unfinished' }) {
  const total = tone === 'total'
  const accent = tone === 'owe' ? '#dc2626' : tone === 'owed' ? '#16a34a' : tone === 'unfinished' ? '#d97706' : undefined
  const muted = total ? 'rgba(255,255,255,0.55)' : 'var(--text-faint)'
  // formatToParts keeps the design's "big integer + muted symbol/decimals" styling
  // while letting Intl place the symbol and pick separators per locale + currency.
  let parts: Intl.NumberFormatPart[] | null = null
  try {
    const d = currencyDecimals(currency)
    parts = new Intl.NumberFormat(currencyLocale(currency), { style: 'currency', currency: (currency || 'EUR').toUpperCase(), minimumFractionDigits: d, maximumFractionDigits: d }).formatToParts(amount || 0)
  } catch { parts = null }
  const big = (p: Intl.NumberFormatPart) => p.type === 'integer' || p.type === 'group' || p.type === 'minusSign'
  return (
    <div className={total ? '' : 'bg-surface-card border border-edge'}
      style={{ borderRadius: 22, padding: '26px 28px', position: 'relative', overflow: 'hidden', ...(total ? { background: 'linear-gradient(135deg,#1f2937,#111827)', color: '#fff' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', background: total ? 'rgba(255,255,255,0.12)' : (accent + '22'), color: total ? '#fff' : accent }}>{icon}</span>
        <div>
          <div style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600 }} className={total ? '' : 'text-content'}>{label}</div>
          <div style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', opacity: total ? 0.6 : 1 }} className={total ? '' : 'text-content-faint'}>{sub}</div>
        </div>
      </div>
      <div style={{ fontSize: 'calc(46px * var(--fs-scale-title, 1))', fontWeight: 600, letterSpacing: '-0.035em', lineHeight: 1, marginTop: 20, display: 'flex', alignItems: 'baseline', color: total ? '#fff' : accent }}>
        {parts
          ? parts.map((p, i) => <span key={i} style={big(p) ? undefined : { fontSize: 'calc(26px * var(--fs-scale-title, 1))', fontWeight: 500, color: muted }}>{p.value}</span>)
          : <span>{formatMoney(amount, currency, locale)}</span>}
      </div>
      <div style={{ marginTop: 16, fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', opacity: total ? 0.85 : 1 }}>{foot}</div>
    </div>
  )
}

function FlowPills({ ids, lead, Avatar, name }: { ids: number[]; lead: string; Avatar: (p: { id: number; size?: number }) => React.JSX.Element; name: (id: number) => string }) {
  const uniq = Array.from(new Set(ids))
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span className="text-content-faint">{lead}</span>
      {uniq.map(id => (
        <span key={id} className="bg-surface-secondary border border-edge text-content" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px 3px 3px', borderRadius: 999, fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600 }}>
          <Avatar id={id} size={18} />{name(id)}
        </span>
      ))}
    </span>
  )
}

// Add or edit a settle-up payment (from / to / amount / currency). Reachable inline
// from the ledger row and from a manual "Add payment" button, so recording "I sent
// money to X" works the same whether or not there's an outstanding expense behind it.
// A transfer can be made in any currency — paying a rouble debt in euros is normal —
// so it carries its own, defaulting to the display currency. The server freezes its
// FX rate on write, the same way an expense's is frozen.
function SettlementModal({ tripId, people, me, editing, currency, onClose, onSaved }: {
  tripId: number; people: TripMember[]; me: number; editing: Settlement | null; currency: string; onClose: () => void; onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const otherDefault = people.find(p => p.id !== me)?.id ?? me
  const [fromId, setFromId] = useState<string>(String(editing?.from_user_id ?? me))
  const [toId, setToId] = useState<string>(String(editing?.to_user_id ?? otherDefault))
  // Seeded with the transfer's own currency decimals, so a reopened 4,90 reads
  // "4.90" and not "4.9" (#2175) — and a JPY transfer gets no fake decimals.
  const [amount, setAmount] = useState<string>(editing ? amountToInputString(editing.amount, (editing.currency || currency).toUpperCase()) : '')
  const [cur, setCur] = useState<string>((editing?.currency || currency).toUpperCase())
  const [saving, setSaving] = useState(false)

  const amt = Number.parseFloat(amount) || 0
  const valid = amt > 0 && fromId !== toId
  const opts = people.map(p => ({ value: String(p.id), label: p.id === me ? t('costs.you') : p.username }))

  const save = async () => {
    if (!valid) return
    setSaving(true)
    const data = { from_user_id: Number(fromId), to_user_id: Number(toId), amount: amt, currency: cur }
    try {
      if (editing) await budgetApi.updateSettlement(tripId, editing.id, data)
      else await budgetApi.createSettlement(tripId, data)
      onSaved()
    } catch { toast.error(t('common.unknownError')) } finally { setSaving(false) }
  }

  const labelCls = 'block text-[11px] font-semibold uppercase tracking-[0.08em] text-content-faint mb-[6px]'

  return (
    <Modal isOpen onClose={onClose} title={editing ? t('costs.editPayment') : t('costs.addPayment')} size="md"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} className="text-content-muted border border-edge" style={{ padding: '8px 16px', borderRadius: 10, background: 'none', fontSize: 'calc(13px * var(--fs-scale-body, 1))', cursor: 'pointer', fontFamily: 'inherit' }}>{t('common.cancel')}</button>
          <button type="button" onClick={save} disabled={!valid || saving} className="bg-[var(--text-primary)] text-[var(--bg-primary)]" style={{ padding: '8px 20px', borderRadius: 10, border: 0, fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: !valid || saving ? 0.5 : 1 }}>{editing ? t('common.save') : t('costs.addPayment')}</button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className={labelCls}>{t('costs.from')}</label>
          <CustomSelect value={fromId} onChange={v => setFromId(String(v))} options={opts} style={{ width: '100%' }} />
        </div>
        <div>
          <label className={labelCls}>{t('costs.to')}</label>
          <CustomSelect value={toId} onChange={v => setToId(String(v))} options={opts} style={{ width: '100%' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <label className={labelCls}>{t('costs.amount')}</label>
            <div className="bg-surface-input border border-edge" style={{ height: FIELD_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', borderRadius: 10, padding: '0 12px' }}>
              <span className="text-content-faint" style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))' }}>{SYMBOLS[cur] || (cur + ' ')}</span>
              <input type="text" inputMode="decimal" placeholder="0.00" value={amount}
                onChange={e => setAmount(e.target.value.replace(',', '.'))}
                className="text-content" style={{ flex: 1, border: 0, background: 'none', outline: 'none', fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 600, paddingLeft: 6, width: '100%' }} />
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <label className={labelCls}>{t('costs.currency')}</label>
            <CustomSelect value={cur} onChange={v => setCur(String(v))} searchable
              options={currenciesWith(cur).map(c => ({ value: c, label: SYMBOLS[c] ? `${c}  ${SYMBOLS[c]}` : c }))}
              style={{ width: '100%' }} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ── Add / edit expense modal ───────────────────────────────────────────────
export interface ExpensePrefill {
  name?: string
  category?: string
  amount?: number
  reservationId?: number
  /** Set when the expense is being created from a place (#1298). */
  placeId?: number
}

export function ExpenseModal({ tripId, base, people, me, editing, prefill, onClose, onSaved }: {
  tripId: number; base: string; people: TripMember[]; me: number; editing: BudgetItem | null; prefill?: ExpensePrefill; onClose: () => void; onSaved: () => void
}) {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const isMobile = useIsMobile()
  const { addBudgetItem, updateBudgetItem } = useTripStore()
  const { convert } = useExchangeRates(base)
  const sym = (c: string) => SYMBOLS[c] || (c + ' ')

  const [name, setName] = useState(editing?.name || prefill?.name || '')
  const [cat, setCat] = useState<string>(editing ? catMeta(editing.category).key : (prefill?.category || 'food'))
  const [currency, setCurrency] = useState((editing?.currency || base).toUpperCase())
  const [day, setDay] = useState(editing?.expense_date || localToday())
  const [note, setNote] = useState(() => readUserNote(editing))
  // Edit and prefill seeds are padded to the currency's decimals (#2175): the DB
  // returns numbers, so a saved 4,90 would otherwise reopen as "4,9" and a saved
  // 5,00 as "5". A prefill has no currency of its own — it is read as `base`,
  // which is also what the currency field starts on.
  const [total, setTotal] = useState<string>(() => {
    if (editing) return editing.total_price ? amountToInputString(editing.total_price, (editing.currency || base).toUpperCase()) : ''
    if (prefill?.amount != null) return amountToInputString(prefill.amount, base)
    return ''
  })
  const [participants, setParticipants] = useState<Set<number>>(() =>
    editing ? new Set((editing.members || []).map(m => m.user_id)) : new Set(people.map(p => p.id)))

  // Payer state. An expense can be fronted by several people, each with their own
  // amount (budget_item_payers) — a shared card, or "I got this round, you get the
  // next". The single-payer dropdown stays the default path; multiPayer swaps in a
  // per-person amount editor. 0 represents "Nobody (planning entry)"; on an
  // existing expense a missing payer is a deliberate choice, so only a brand-new
  // one defaults to me. A negative payer (the recipient of a refund, #2176) is a
  // real payer — filtering on > 0 here would silently drop them on save.
  const initialPayers = (editing?.payers || []).filter(p => p.amount !== 0)

  const [payerId, setPayerId] = useState<number>(() => {
    const existingPayer = initialPayers[0]
    if (existingPayer) return existingPayer.user_id
    return editing ? 0 : me
  })
  const [multiPayer, setMultiPayer] = useState(() => initialPayers.length > 1)
  const [payerIds, setPayerIds] = useState<Set<number>>(() => new Set(initialPayers.map(p => p.user_id)))
  const [payerAmounts, setPayerAmounts] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {}
    for (const p of initialPayers) m[p.user_id] = amountToInputString(p.amount, currency)
    return m
  })
  // Payers the user typed an amount for: rebalance leaves these alone and makes
  // the others absorb the remainder.
  const [pinnedPayers, setPinnedPayers] = useState<Set<number>>(() => new Set(initialPayers.map(p => p.user_id)))

  const [splitMode, setSplitMode] = useState<'equally' | 'custom' | 'ticket'>(() => {
    if (hasTicketSplit(editing)) {
      return 'ticket'
    }
    if (editing && editing.members && editing.members.length > 0) {
      const hasCustom = editing.members.some(m => m.amount !== null && m.amount !== undefined)
      return hasCustom ? 'custom' : 'equally'
    }
    return 'equally'
  })

  const [ticketItems, setTicketItems] = useState<TicketItem[]>(() => readTicketItems(editing))

  const [customAmounts, setCustomAmounts] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {}
    if (editing && editing.members) {
      for (const member of editing.members) {
        if (member.amount !== null && member.amount !== undefined) {
          m[member.user_id] = amountToInputString(member.amount, currency)
        }
      }
    }
    return m
  })

  const [receipts, setReceipts] = useState<BudgetItemReceipt[]>(() => editing?.receipts || [])
  const [pendingReceiptFiles, setPendingReceiptFiles] = useState<File[]>([])
  const [uploadingReceipt, setUploadingReceipt] = useState(false)
  const [modalPreviewReceipts, setModalPreviewReceipts] = useState<{ receipts: BudgetItemReceipt[]; initialIndex: number } | null>(null)

  const handleReceiptFileSelect = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    setPendingReceiptFiles(prev => [...prev, ...Array.from(files)])
  }

  const handleRemoveReceipt = (receiptId: number) => {
    setReceipts(prev => prev.filter(r => r.id !== receiptId))
  }

  const handleRemovePendingReceipt = (index: number) => {
    setPendingReceiptFiles(prev => prev.filter((_, i) => i !== index))
  }

  const [saving, setSaving] = useState(false)

  const isTicketMode = splitMode === 'ticket'

  const ticketInfo = useMemo(() => {
    return calculateTicketShares(ticketItems)
  }, [ticketItems])

  const totalNum = isTicketMode ? ticketInfo.total : (Number.parseFloat(total) || 0)
  const splitSum = [...participants].reduce((sum, id) => sum + (Number.parseFloat(customAmounts[id]) || 0), 0)
  const customBalanced = Math.round(splitSum * 100) === Math.round(totalNum * 100)
  // How much is still to be handed out, read on the total's own side: on a refund
  // (#2176) the shares run negative, so a plain total minus sum flips under and
  // over around and sends the user the wrong way.
  const splitShortfall = totalNum < 0 ? splitSum - totalNum : totalNum - splitSum
  const each = participants.size > 0 ? totalNum / participants.size : 0
  const equalShares = useMemo(() => {
    return splitEqualShares(totalNum, [...participants].map(id => ({ user_id: id })), editing?.id || 0)
  }, [totalNum, participants, editing])

  const placeholderShares = useMemo(() => {
    const emptyParts = [...participants].filter(id => !customAmounts[id])
    if (emptyParts.length === 0) return {}

    const enteredSum = [...participants]
      .filter(id => customAmounts[id])
      .reduce((sum, id) => sum + (Number.parseFloat(customAmounts[id]) || 0), 0)
    // Clamped toward zero on the total's own side, so an over-entered positive
    // split never suggests negative leftovers — while a negative total (#2176)
    // still previews its negative equal shares.
    const rest = totalNum - enteredSum
    const remaining = totalNum >= 0 ? Math.max(0, rest) : Math.min(0, rest)

    return splitEqualShares(remaining, emptyParts.map(id => ({ user_id: id })), editing?.id || 0)
  }, [totalNum, participants, customAmounts, editing])

  const ticketValid = ticketItems.length > 0 && ticketItems.every(item => item.name.trim().length > 0 && (Number.parseFloat(item.price) || 0) > 0 && item.participants.size > 0)
  const payersOk = !multiPayer || (payerIds.size > 0 && payersBalanced(payerAmounts, payerIds, totalNum))
  // A negative total is a valid entry (a refund, #2176); only zero has nothing to say.
  const valid = name.trim().length > 0 && payersOk && (
    isTicketMode
      ? ticketValid
      : totalNum !== 0 && (participants.size === 0 || splitMode === 'equally' || customBalanced)
  )

  const onTotalChange = (v: string) => {
    setTotal(v.replace(',', '.'))
  }

  // Keep the payer amounts summing to the total as it changes — including in ticket
  // mode, where the total is derived from the ticket items rather than typed.
  useEffect(() => {
    if (!multiPayer) return
    setPayerAmounts(prev => rebalancePayers(prev, pinnedPayers, payerIds, totalNum))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalNum])

  const enableMultiPayer = () => {
    const seed = payerIds.size > 0 ? new Set(payerIds) : new Set<number>([payerId > 0 ? payerId : me])
    const pinned = new Set<number>()
    setPayerIds(seed)
    setPinnedPayers(pinned)
    setPayerAmounts(prev => rebalancePayers(prev, pinned, seed, totalNum))
    setMultiPayer(true)
  }

  const disableMultiPayer = () => {
    // Collapsing back keeps the first payer; their amount becomes the whole total.
    const [first] = [...payerIds]
    setPayerId(first ?? me)
    setMultiPayer(false)
  }

  const togglePayer = (id: number) => {
    const nextIds = new Set(payerIds)
    const nextPinned = new Set(pinnedPayers)
    if (nextIds.has(id)) {
      nextIds.delete(id)
      nextPinned.delete(id)
    } else {
      nextIds.add(id)
    }
    setPayerIds(nextIds)
    setPinnedPayers(nextPinned)
    setPayerAmounts(prev => rebalancePayers(prev, nextPinned, nextIds, totalNum))
  }

  const onPayerAmountChange = (id: number, v: string) => {
    const val = v.replace(',', '.')
    const nextPinned = new Set(pinnedPayers)
    nextPinned.add(id)
    setPinnedPayers(nextPinned)
    setPayerAmounts(prev => rebalancePayers({ ...prev, [id]: val }, nextPinned, payerIds, totalNum))
  }

  const handleCustomAmountChange = (id: number, val: string) => {
    val = val.replace(',', '.')
    if (val === '' || amountPattern(currency, true).test(val)) {
      setCustomAmounts(prev => ({ ...prev, [id]: val }))
    }
  }

  const handleAddEmptyItem = () => {
    setTicketItems(prev => [
      ...prev,
      {
        id: String(Date.now() + Math.random()),
        name: '',
        price: '',
        participants: new Set(people.map(p => p.id))
      }
    ])
  }

  const handleUpdateItemName = (id: string, name: string) => {
    setTicketItems(prev => prev.map(item => item.id === id ? { ...item, name } : item))
  }

  const handleUpdateItemPrice = (id: string, price: string) => {
    price = price.replace(',', '.')
    if (price === '' || amountPattern(currency, false).test(price)) {
      setTicketItems(prev => prev.map(item => item.id === id ? { ...item, price } : item))
    }
  }

  const handleRemoveItem = (id: string) => {
    setTicketItems(prev => prev.filter(item => item.id !== id))
  }

  const handleToggleItemParticipant = (itemId: string, userId: number) => {
    setTicketItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const nextParts = new Set(item.participants)
        if (nextParts.has(userId)) nextParts.delete(userId)
        else nextParts.add(userId)
        return { ...item, participants: nextParts }
      }
      return item
    }))
  }

  const toggleParticipant = (id: number) => {
    const nextParts = new Set(participants)
    if (nextParts.has(id)) {
      nextParts.delete(id)
      setCustomAmounts(prev => {
        const copy = { ...prev }
        delete copy[id]
        return copy
      })
    } else {
      nextParts.add(id)
    }
    setParticipants(nextParts)
  }

  const save = async () => {
    if (!valid) return
    setSaving(true)
    // A picked payer always goes out, even when nobody shares the expense: the
    // server re-derives total_price from the payer sum (CostsPanel.helpers), so
    // dropping the payer would store the entry with a total of 0.
    const payerList = multiPayer
      ? [...payerIds]
          .map(id => ({ user_id: id, amount: Number.parseFloat(payerAmounts[id]) || 0 }))
          .filter(p => p.amount !== 0)
      : payerId > 0 ? [{ user_id: payerId, amount: totalNum }] : []
    // A receipt line can name somebody who is not ticked as a participant. Sending
    // only the ticked set would drop their share, leaving the member sum short of
    // total_price and handing the settlement a difference it can never clear (#1382).
    const memberIds = splitMode === 'ticket'
      ? [...new Set([...participants, ...Object.keys(ticketInfo.shares).map(Number)])].sort((a, b) => a - b)
      : [...participants]
    const memberList = memberIds.map(id => ({
      user_id: id,
      amount: splitMode === 'custom'
        ? (Number.parseFloat(customAmounts[id]) || 0)
        : splitMode === 'ticket'
        ? (ticketInfo.shares[id] || 0)
        : null
    }))
    const data = {
      name: name.trim(),
      category: cat,
      currency,
      payers: payerList,
      members: memberList,
      member_ids: memberIds,
      expense_date: day || null,
      total_price: totalNum,
      note: note.trim() || null,
      ticket_json: splitMode === 'ticket' ? writeTicketItems(ticketItems) : null,
      ...(!editing && prefill?.reservationId ? { reservation_id: prefill.reservationId } : {}),
      ...(!editing && prefill?.placeId ? { place_id: prefill.placeId } : {}),
    }
    try {
      // Upload any pending receipt files
      const uploadedFileIds: number[] = []
      try {
        for (const f of pendingReceiptFiles) {
          const fd = new FormData()
          fd.append('file', f)
          if (editing) {
            fd.append('budget_item_id', String(editing.id))
          }
          const res = await filesApi.upload(tripId, fd)
          if (res?.file?.id) {
            uploadedFileIds.push(res.file.id)
          }
        }
      } catch (err) {
        for (const fid of uploadedFileIds) {
          try { await filesApi.permanentDelete(tripId, fid) } catch {}
        }
        throw err
      }

      let createdOrUpdated: BudgetItem
      if (editing) {
        try {
          createdOrUpdated = await updateBudgetItem(tripId, editing.id, {
            ...data,
            receipt_file_ids: [...receipts.map(r => r.id), ...uploadedFileIds],
          })
        } catch (err) {
          for (const fid of uploadedFileIds) {
            try { await filesApi.permanentDelete(tripId, fid) } catch {}
          }
          throw err
        }
      } else {
        try {
          createdOrUpdated = await addBudgetItem(tripId, {
            ...data,
            receipt_file_ids: uploadedFileIds,
          })
        } catch (err) {
          for (const fid of uploadedFileIds) {
            try { await filesApi.permanentDelete(tripId, fid) } catch {}
          }
          throw err
        }
      }
      onSaved()
    } catch {
      toast.error(t('common.unknownError'))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full bg-surface-input border border-edge text-content'
  const labelCls = 'block text-caption font-semibold uppercase tracking-[0.14em] text-content-faint mb-2'
  // Borrowed from the trip dialog (TripFormModal): related fields sit together in
  // a panel instead of running as one undifferentiated column of inputs.
  const panelCls = 'rounded-2xl border border-edge bg-surface-secondary p-4'

  return (
    <Modal isOpen onClose={onClose} title={editing ? t('costs.editExpense') : t('costs.addExpense')} size={isMobile ? '2xl' : '5xl'}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} className="text-content-muted border border-edge" style={{ padding: '8px 16px', borderRadius: 10, background: 'none', fontSize: 'calc(13px * var(--fs-scale-body, 1))', cursor: 'pointer', fontFamily: 'inherit' }}>{t('common.cancel')}</button>
          <button type="button" onClick={save} disabled={!valid || saving} className="bg-[var(--text-primary)] text-[var(--bg-primary)]" style={{ padding: '8px 20px', borderRadius: 10, border: 0, fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: !valid || saving ? 0.5 : 1 }}>{editing ? t('common.save') : t('costs.addExpense')}</button>
        </div>
      }>
      {/* Two columns on desktop: what the expense was on the left, how it is
          shared on the right. The split follows the two questions the dialog
          actually asks, so neither side is a leftovers pile. */}
      <div style={{ display: isMobile ? 'flex' : 'grid', flexDirection: 'column', gridTemplateColumns: '1fr 1fr', alignItems: 'start', gap: isMobile ? 14 : 28 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div className={panelCls} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className={labelCls}>{t('costs.whatFor')}</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('costs.namePlaceholder')} className={inputCls} style={{ borderRadius: 10, padding: '11px 13px', fontSize: 'calc(14px * var(--fs-scale-body, 1))', outline: 'none' }} />
        </div>

        <div>
          <label className={labelCls}>{t('costs.totalAmount')}</label>
          <div className="bg-surface-input border border-edge" style={{ height: FIELD_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', borderRadius: 10, padding: '0 12px', opacity: isTicketMode ? 0.6 : 1 }}>
            <span className="text-content-faint" style={{ fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))' }}>{sym(currency)}</span>
            <NumericInput mode="signed-decimal" placeholder={localizeAmountInput('0.00', currency)} value={localizeAmountInput(isTicketMode ? ticketInfo.total.toFixed(2) : total, currency)}
              onValueChange={onTotalChange}
              signToggleLabel={t('costs.toggleSign')}
              disabled={isTicketMode}
              className="text-content" style={{ flex: 1, border: 0, background: 'none', outline: 'none', fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 600, paddingLeft: 6, width: '100%' }} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <label className={labelCls}>{t('costs.currency')}</label>
            <CustomSelect value={currency} onChange={v => setCurrency(String(v))} searchable
              options={currenciesWith(currency).map(c => ({ value: c, label: SYMBOLS[c] ? `${c}  ${SYMBOLS[c]}` : c }))}
              style={{ width: '100%' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <label className={labelCls}>{t('costs.day')}</label>
            <CustomDatePicker value={day} onChange={setDay} style={{ width: '100%' }} />
          </div>
        </div>

        {currency !== base && totalNum !== 0 && (
          <div className="bg-surface-secondary border border-edge text-content-muted" style={{ borderRadius: 10, padding: '10px 12px', fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{formatMoney(totalNum, currency, locale)}</span>
            <span className="text-content-faint">≈</span>
            <span className="text-content" style={{ fontWeight: 600 }}>{formatMoney(convert(totalNum, currency), base, locale)}</span>
            <span className="text-content-faint">· {t('costs.liveRate')}</span>
          </div>
        )}

        </div>

        <div className={panelCls}>
          <label className={labelCls}>{t('costs.category')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {COST_CATEGORY_LIST.map(c => {
              const Icon = c.Icon; const on = cat === c.key
              return (
                <button type="button" key={c.key} onClick={() => setCat(c.key)}
                  className={on ? 'bg-surface-card text-content border' : 'bg-surface-secondary text-content-muted border border-edge'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px 6px 7px', borderRadius: 999, fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', borderColor: on ? 'var(--text-primary)' : undefined }}>
                  <span style={{ width: 20, height: 20, borderRadius: 6, display: 'grid', placeItems: 'center', background: c.color + '22', color: c.color }}><Icon size={12} /></span>
                  {t(c.labelKey)}
                </button>
              )
            })}
          </div>
        </div>

        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div className={panelCls}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label className={labelCls} style={{ marginBottom: 0 }}>{t('costs.whoPaid')}</label>
            <button type="button" onClick={() => (multiPayer ? disableMultiPayer() : enableMultiPayer())}
              className="text-content-muted"
              style={{ background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 600, textDecoration: 'underline' }}>
              {multiPayer ? t('costs.singlePayer') : t('costs.multiplePayers')}
            </button>
          </div>
          {!multiPayer ? (
            <CustomSelect value={String(payerId)} onChange={v => setPayerId(Number(v))}
              options={[
                { value: '0', label: t('costs.noOnePaid') || 'Nobody (planning entry)' },
                ...people.map(p => ({ value: String(p.id), label: p.id === me ? t('costs.you') : p.username }))
              ]}
              style={{ width: '100%' }} />
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {people.map((p, idx) => {
                  const on = payerIds.has(p.id)
                  return (
                    <div key={p.id} className="bg-surface-secondary border border-edge"
                      style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'center', padding: '8px 11px', borderRadius: 10, opacity: on ? 1 : 0.5 }}>
                      <button type="button" onClick={() => togglePayer(p.id)} data-testid="payer-toggle"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', padding: 0, minWidth: 0, textAlign: 'left' }}>
                        {p.avatar_url
                          ? <img src={p.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0, opacity: on ? 1 : 0.45 }} />
                          : <span style={{ width: 22, height: 22, borderRadius: '50%', background: SPLIT_COLORS[idx % SPLIT_COLORS.length].gradient, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, flexShrink: 0, opacity: on ? 1 : 0.45 }}>
                              {(p.id === me ? t('costs.youShort') : p.username.charAt(0)).toUpperCase()}
                            </span>}
                        <span className="text-content" style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.id === me ? t('costs.you') : p.username}
                        </span>
                      </button>
                      {on ? (
                        <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, padding: '0 10px' }}>
                          <span className="text-content-faint" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>{sym(currency)}</span>
                          <NumericInput mode="signed-decimal" placeholder={localizeAmountInput('0.00', currency)} data-testid="payer-amount"
                            value={localizeAmountInput(payerAmounts[p.id] || '', currency)}
                            onValueChange={v => onPayerAmountChange(p.id, v)}
                            className="text-content"
                            style={{ width: '100%', border: 0, background: 'none', outline: 'none', fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 600, padding: '8px 0', textAlign: 'right' }} />
                        </div>
                      ) : (
                        <button type="button" onClick={() => togglePayer(p.id)} className="text-content-faint"
                          style={{ background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(12px * var(--fs-scale-caption, 1))', textAlign: 'right' }}>
                          {t('costs.tapToInclude')}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              {!payersOk && (
                <div style={{ marginTop: 8, fontSize: 'calc(12.5px * var(--fs-scale-caption, 1))', color: '#d97706' }}>
                  {t('costs.payersUnbalanced', { amount: formatMoney(totalNum, currency, locale) })}
                </div>
              )}
            </>
          )}
        </div>

        <div className={panelCls}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label className={labelCls} style={{ marginBottom: 0 }}>{t('costs.split') || 'Split'}</label>
            <div className="bg-surface-card border border-edge" style={{ display: 'flex', borderRadius: 999, padding: 2 }}>
              <button type="button" onClick={() => setSplitMode('equally')}
                className={splitMode === 'equally' ? 'bg-surface-secondary text-content' : 'text-content-muted'}
                style={{ padding: '4px 12px', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', borderRadius: 999, fontWeight: 600, border: 0, background: splitMode === 'equally' ? undefined : 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {t('costs.splitEqually') || 'Equally'}
              </button>
              <button type="button" onClick={() => setSplitMode('custom')}
                className={splitMode === 'custom' ? 'bg-surface-secondary text-content' : 'text-content-muted'}
                style={{ padding: '4px 12px', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', borderRadius: 999, fontWeight: 600, border: 0, background: splitMode === 'custom' ? undefined : 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {t('costs.splitCustom') || 'Custom'}
              </button>
              <button type="button" onClick={() => setSplitMode('ticket')}
                className={splitMode === 'ticket' ? 'bg-surface-secondary text-content' : 'text-content-muted'}
                style={{ padding: '4px 12px', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', borderRadius: 999, fontWeight: 600, border: 0, background: splitMode === 'ticket' ? undefined : 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {t('costs.splitTicket') || 'Ticket'}
              </button>
            </div>
          </div>
          {splitMode === 'ticket' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ticketItems.map((item, itemIdx) => (
                  <div key={item.id} className="bg-surface-secondary border border-edge" style={{ padding: 10, borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 130px auto', gap: 8, alignItems: 'center' }}>
                      <input
                        type="text"
                        placeholder={t('costs.ticketItemName')}
                        value={item.name}
                        onChange={e => handleUpdateItemName(item.id, e.target.value)}
                        className="bg-surface-input border border-edge text-content"
                        style={{ minWidth: 0, padding: '6px 10px', borderRadius: 8, fontSize: 13, border: '1px solid var(--border-color)', outline: 'none' }}
                      />
                      <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', padding: '0 8px', borderRadius: 8 }}>
                        <span className="text-content-faint" style={{ fontSize: 12 }}>{sym(currency)}</span>
                        <NumericInput
                          mode="decimal"
                          placeholder={localizeAmountInput('0.00', currency)}
                          value={localizeAmountInput(item.price, currency)}
                          onValueChange={v => handleUpdateItemPrice(item.id, v)}
                          className="text-content"
                          style={{ width: '100%', border: 0, background: 'none', outline: 'none', fontSize: 13, fontWeight: 600, textAlign: 'right', padding: '6px 0' }}
                        />
                      </div>
                      <button type="button" onClick={() => handleRemoveItem(item.id)} className="text-content-muted" style={{ background: 'none', border: 0, cursor: 'pointer', padding: 4 }}>
                        <Trash2 size={15} />
                      </button>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                      <span className="text-content-faint" style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', marginRight: 4 }}>{t('costs.ticketSplitting')}</span>
                      {people.map((p, pIdx) => {
                        const active = item.participants.has(p.id)
                        return (
                          <button
                            type="button"
                            key={p.id}
                            onClick={() => handleToggleItemParticipant(item.id, p.id)}
                            className={active ? 'bg-surface-card text-content border' : 'bg-surface-secondary text-content-muted border border-edge'}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', border: active ? '1px solid var(--text-primary)' : undefined }}
                          >
                            {p.avatar_url
                              ? <img src={p.avatar_url} alt="" style={{ width: 14, height: 14, borderRadius: '50%', objectFit: 'cover' }} />
                              : <span style={{ width: 14, height: 14, borderRadius: '50%', background: SPLIT_COLORS[pIdx % SPLIT_COLORS.length].gradient, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 7, fontWeight: 700 }}>{(p.id === me ? t('costs.youShort') : p.username.charAt(0)).toUpperCase()}</span>}
                            <span>{p.id === me ? t('costs.you') : p.username}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <button type="button" onClick={handleAddEmptyItem} className="border border-dashed border-edge text-content-muted" style={{ padding: '8px 12px', borderRadius: 10, background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Plus size={14} /> {t('costs.ticketAddItem')}
              </button>

              {ticketItems.length > 0 && (
                <div className="bg-surface-secondary border border-edge" style={{ padding: 12, borderRadius: 10 }}>
                  <div className="text-content" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t('costs.ticketShares')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {people.map(p => {
                      const share = ticketInfo.shares[p.id] || 0
                      return (
                        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                          <span className="text-content-muted">{p.id === me ? t('costs.you') : p.username}</span>
                          <span className="text-content" style={{ fontWeight: 600 }}>{sym(currency)}{share.toFixed(2)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {people.map((p, idx) => {
                  const on = participants.has(p.id)
                  return (
                    <div key={p.id} className="bg-surface-secondary border border-edge" style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'center', padding: '8px 11px', borderRadius: 10, opacity: on ? 1 : 0.5 }}>
                      <button type="button" onClick={() => toggleParticipant(p.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', padding: 0, minWidth: 0, textAlign: 'left' }}>
                        {p.avatar_url
                          ? <img src={p.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0, opacity: on ? 1 : 0.45 }} />
                          : <span style={{ width: 22, height: 22, borderRadius: '50%', background: SPLIT_COLORS[idx % SPLIT_COLORS.length].gradient, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, flexShrink: 0, opacity: on ? 1 : 0.45 }}>{(p.id === me ? t('costs.youShort') : p.username.charAt(0)).toUpperCase()}</span>}
                        <span className="text-content" style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.id === me ? t('costs.you') : p.username}</span>
                        {p.is_guest && <GuestBadge size="xs" />}
                      </button>
                      {splitMode === 'equally' ? (
                        on ? (
                          <span className="text-content" style={{ fontSize: 14, fontWeight: 600, textAlign: 'right', paddingRight: 10 }}>
                            {sym(currency)}{(equalShares[p.id] || 0).toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-content-faint" style={{ fontSize: 12, textAlign: 'right', paddingRight: 10 }}>{t('costs.excluded')}</span>
                        )
                      ) : (
                        on ? (
                          <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, padding: '0 10px' }}>
                            <span className="text-content-faint" style={{ fontSize: 13 }}>{sym(currency)}</span>
                            <input type="text" inputMode="decimal" placeholder={localizeAmountInput((placeholderShares[p.id] || 0).toFixed(2), currency)} value={localizeAmountInput(customAmounts[p.id] || '', currency)}
                              onChange={e => handleCustomAmountChange(p.id, e.target.value)}
                              className="text-content" style={{ width: '100%', border: 0, background: 'none', outline: 'none', fontSize: 14, fontWeight: 600, padding: '8px 0', textAlign: 'right' }} />
                          </div>
                        ) : (
                          <button type="button" onClick={() => toggleParticipant(p.id)} className="text-content-faint" style={{ background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, textAlign: 'right' }}>{t('costs.tapToInclude')}</button>
                        )
                      )}
                    </div>
                  )
                })}
              </div>
              <div style={{ marginTop: 10, fontSize: 12.5, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                {splitMode === 'equally' ? (
                  <span className="text-content-faint">
                    {participants.size > 0 && t('costs.splitSummary', { count: participants.size, amount: sym(currency) + each.toFixed(2) })}
                  </span>
                ) : (
                  <span style={{ fontWeight: 600, color: customBalanced ? '#16a34a' : '#dc2626' }}>
                    {customBalanced
                      ? t('costs.splitBalanced')
                      : t(splitShortfall > 0 ? 'costs.splitSumUnder' : 'costs.splitSumOver', {
                          sum: sym(currency) + splitSum.toFixed(2),
                          total: sym(currency) + totalNum.toFixed(2),
                          diff: sym(currency) + Math.abs(totalNum - splitSum).toFixed(2),
                        })}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div className={panelCls}>
          <label className={labelCls} htmlFor="expense-note">{t('costs.note')}</label>
          <textarea id="expense-note" value={note} onChange={e => setNote(e.target.value)} rows={2}
            placeholder={t('costs.notePlaceholder')} maxLength={NOTE_MAX}
            className={inputCls} style={{ borderRadius: 10, padding: '10px 13px', fontSize: 'calc(13.5px * var(--fs-scale-body, 1))', outline: 'none', resize: 'vertical', minHeight: 68, width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5 }} />
        </div>

        <div className={panelCls}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <label className={labelCls} style={{ marginBottom: 0 }}>{t('costs.receiptsTitle') || t('costs.receipts')}</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'calc(12px * var(--fs-scale-caption, 1))', fontWeight: 600, color: 'var(--text-primary)' }}>
              <input
                type="file"
                multiple
                accept="image/*,application/pdf"
                style={{ display: 'none' }}
                onChange={e => {
                  handleReceiptFileSelect(e.target.files)
                  e.target.value = ''
                }}
              />
              <span className="bg-surface-card border border-edge text-content-muted hover:text-content transition-colors" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 999 }}>
                <Plus size={13} /> {t('costs.attachReceipt')}
              </span>
            </label>
          </div>

          {uploadingReceipt && (
            <div className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-caption, 1))', marginBottom: 8 }}>
              {t('common.saving')}...
            </div>
          )}

          {receipts.length === 0 && pendingReceiptFiles.length === 0 ? (
            <div className="text-content-faint" style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', padding: '6px 0' }}>
              {t('costs.noReceipts')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {receipts.map((r, rIdx) => (
                <div key={r.id} className="bg-surface-secondary border border-edge" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 11px', borderRadius: 10 }}>
                  <button
                    type="button"
                    onClick={() => setModalPreviewReceipts({ receipts, initialIndex: rIdx })}
                    className="text-content hover:underline"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}
                  >
                    <Receipt size={14} className="text-content-faint flex-shrink-0" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.original_name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveReceipt(r.id)}
                    title={t('costs.deleteReceipt')}
                    className="text-content-muted hover:text-red-500 transition-colors"
                    style={{ background: 'none', border: 0, padding: 3, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {pendingReceiptFiles.map((file, idx) => (
                <div key={idx} className="bg-surface-secondary border border-edge" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 11px', borderRadius: 10 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>
                    <Paperclip size={14} className="text-content-faint flex-shrink-0" />
                    <span className="text-content" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemovePendingReceipt(idx)}
                    title={t('costs.deleteReceipt')}
                    className="text-content-muted hover:text-red-500 transition-colors"
                    style={{ background: 'none', border: 0, padding: 3, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      </div>

      {modalPreviewReceipts && (
        <ReceiptPreviewModal
          receipts={modalPreviewReceipts.receipts}
          initialIndex={modalPreviewReceipts.initialIndex}
          onClose={() => setModalPreviewReceipts(null)}
        />
      )}
    </Modal>
  )
}
