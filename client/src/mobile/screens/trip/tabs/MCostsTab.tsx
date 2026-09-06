import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, ArrowDown, ArrowLeftRight, ArrowRight, ArrowUp, Check, ChevronDown, ChevronUp,
  Layers, Pencil, Plus, StickyNote, Trash2, Receipt,
} from 'lucide-react'
import MDancingTrek from '../../../components/MDancingTrek'
import { useAuthStore } from '../../../../store/authStore'
import { useSettingsStore } from '../../../../store/settingsStore'
import { useExchangeRates } from '../../../../hooks/useExchangeRates'
import { useTranslation } from '../../../../i18n'
import { formatMoney } from '../../../../utils/formatters'
import { downloadBlob, openFile } from '../../../../utils/fileDownload'
import { budgetApi } from '../../../../api/client'
import MCostSheet from '../sheets/MCostSheet'
import { ReceiptPreviewModal } from '../../../../components/Budget/ReceiptPreviewModal'
import { readUserNote } from '../../../../components/Budget/CostsPanel.helpers'
import { catMeta, COST_CAT_META } from '../../../../components/Budget/costsCategories'
import MConfirmSheet from '../../settings/MConfirmSheet'
import MSheet from '../../../components/MSheet'
import MChip from '../../../components/MChip'
import { Eyebrow, FIELD_CLS, FormSheetFooter, FormSheetHeader } from '../sheets/PlSheetChrome'
import { CountPill, TabScroller } from './tabChrome'
import { STATUS_COLOR, type MTabScreenProps } from './tabModel'
import {
  baseTotal, buildCostsCsv, categoryBreakdown, categoryFilterKeys, computeTotals, currencyOf,
  dayFilterKeys, filterBudgetItems, filterSettlements, groupLedgerByDay, isUnfinished, memberShareOf, tint,
  type CostsCtx, type CostsSegment, type CostsSettlement, type CostsSettlementResponse,
} from './costsModel'
import type { BudgetItem, BudgetItemReceipt, TripMember } from '../../../../types'

type TFn = (key: string, params?: Record<string, string | number>) => string

/**
 * Tab 3 — Kosten (`finanzplan`). Real `planner.budgetItems` + a server-computed
 * settlement (min-transfer, not in the store — `budgetApi.settlement`), summed
 * client-side exactly like the desktop `CostsPanel.tsx` (see `costsModel.ts`).
 * The shell owns the header (Add expense / CSV export); this panel watches
 * `shell.addExpenseSignal` / `shell.exportCostsCsvSignal` the way
 * `useTodoList.ts` watches `addItemSignal`. Add/edit reuses the desktop
 * `ExpenseModal` unchanged; "Add payment" is a small local sheet (no mobile or
 * exported desktop equivalent existed for it).
 */
export default function MCostsTab({ planner, shell }: MTabScreenProps) {
  const { t, tripId, trip, tripMembers, budgetItems, days, toast } = planner
  const { locale } = useTranslation()
  const canEdit = planner.can('budget_edit', trip)
  const me = useAuthStore(s => s.user?.id ?? -1)

  const displayCurrency = useSettingsStore(s => s.settings.default_currency)
  const base = (displayCurrency || trip?.currency || 'EUR').toUpperCase()
  const tripCurrency = (trip?.currency || base).toUpperCase()
  const { convert } = useExchangeRates(base)
  const ctx: CostsCtx = useMemo(() => ({ me, tripCurrency, convert }), [me, tripCurrency, convert])

  const [settlement, setSettlement] = useState<CostsSettlementResponse | null>(null)
  const loadSettlement = useCallback(() => {
    budgetApi.settlement(tripId, base).then(setSettlement).catch(() => {})
  }, [tripId, base])

  // Mirrors CostsPanel.tsx: items reload on trip change, settlement reloads on
  // trip/base change; further refreshes are explicit after each mutation below
  // (add/edit/delete expense, add payment) rather than watching budgetItems, so
  // an unrelated re-render doesn't refetch the settlement.
  useEffect(() => {
    planner.tripActions.loadBudgetItems(tripId)
  }, [tripId, planner.tripActions])
  useEffect(() => {
    loadSettlement()
  }, [loadSettlement])

  const [search, setSearch] = useState('')
  const [segment, setSegment] = useState<CostsSegment>('all')
  const [catFilter, setCatFilter] = useState('')
  const [dayFilter, setDayFilter] = useState('')
  const [catOpen, setCatOpen] = useState(false)
  const [dayOpen, setDayOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(true)
  const [addPaymentOpen, setAddPaymentOpen] = useState(false)
  const [expenseModalOpen, setExpenseModalOpen] = useState(false)
  const [editingExpense, setEditingExpense] = useState<BudgetItem | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BudgetItem | null>(null)
  const [previewReceipts, setPreviewReceipts] = useState<{ receipts: BudgetItemReceipt[]; initialIndex: number } | null>(null)

  const flows = useMemo(() => settlement?.flows || [], [settlement])
  const totals = useMemo(() => computeTotals(budgetItems, flows, ctx), [budgetItems, flows, ctx])
  const filtered = useMemo(
    () => filterBudgetItems(budgetItems, { search, segment, categoryKey: catFilter, dayKey: dayFilter }, ctx),
    [budgetItems, search, segment, catFilter, dayFilter, ctx],
  )
  const filteredSettlements = useMemo(
    () => filterSettlements(settlement?.settlements || [], { search, segment, categoryKey: catFilter, dayKey: dayFilter }, me),
    [settlement, search, segment, catFilter, dayFilter, me],
  )
  const groups = useMemo(() => groupLedgerByDay(filtered, filteredSettlements), [filtered, filteredSettlements])
  const catBreakdown = useMemo(() => categoryBreakdown(budgetItems, ctx), [budgetItems, ctx])
  const catKeys = useMemo(() => categoryFilterKeys(budgetItems), [budgetItems])
  const dayKeys = useMemo(() => dayFilterKeys(budgetItems), [budgetItems])

  const personName = (id: number) => (id === me ? t('costs.you') : tripMembers.find(p => p.id === id)?.username || '?')

  const shortDate = (dateIso: string) => {
    try {
      return new Date(dateIso + 'T00:00:00Z').toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
    } catch {
      return dateIso
    }
  }
  const dayOptionLabel = (dateIso: string) => {
    const dayNumber = days.find(d => d.date && d.date.slice(0, 10) === dateIso)?.day_number
    return dayNumber != null ? `${t('dayplan.dayN', { n: dayNumber })} · ${shortDate(dateIso)}` : shortDate(dateIso)
  }
  const groupLabel = (dateIso: string) => {
    if (!dateIso) return t('costs.noDate')
    try {
      return new Date(dateIso + 'T00:00:00Z').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    } catch {
      return dateIso
    }
  }

  const handleExportCsv = useCallback(() => {
    const { filename, content } = buildCostsCsv(budgetItems, { base, ctx, locale, tripTitle: trip?.title, t })
    const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' })
    downloadBlob(blob, filename)
  }, [budgetItems, base, ctx, locale, trip?.title, t])

  // Header intent signals (spec 03 §3.8 addExpense/csvGo) — increment-only
  // counters the shell owns; pattern mirrors useTodoList.ts's addItemSignal.
  const lastAddSignal = useRef(shell.addExpenseSignal)
  useEffect(() => {
    if (shell.addExpenseSignal !== lastAddSignal.current && shell.addExpenseSignal > 0) {
      setEditingExpense(null)
      setExpenseModalOpen(true)
    }
    lastAddSignal.current = shell.addExpenseSignal
  }, [shell.addExpenseSignal])

  const lastCsvSignal = useRef(shell.exportCostsCsvSignal)
  useEffect(() => {
    if (shell.exportCostsCsvSignal !== lastCsvSignal.current && shell.exportCostsCsvSignal > 0) {
      handleExportCsv()
    }
    lastCsvSignal.current = shell.exportCostsCsvSignal
  }, [shell.exportCostsCsvSignal, handleExportCsv])

  const handleDeleteExpense = async (item: BudgetItem) => {
    try {
      await planner.tripActions.deleteBudgetItem(tripId, item.id)
      loadSettlement()
    } catch {
      toast.error(t('common.unknownError'))
    }
  }

  const handleTogglePaid = async (itemId: number, userId: number, paid: boolean) => {
    try {
      await planner.tripActions.toggleBudgetMemberPaid(tripId, itemId, userId, paid)
    } catch {
      toast.error(t('common.unknownError'))
    }
  }

  return (
    <TabScroller>
      {/* Hero — "Total Trip Spend" (spec §3.1). Fixed dark card, both themes. */}
      <div className="rounded-[20px] p-4 shadow-[0_18px_44px_-18px_rgba(0,0,0,.5)]" style={{ background: '#15151A', color: '#F5F5F7' }}>
        <div className="font-geist text-[0.625rem] font-bold uppercase tracking-[.09em]" style={{ color: 'rgba(245,245,247,.55)' }}>
          {t('costs.totalSpend')}
        </div>
        <div className="mt-1 font-geist text-[1.875rem] font-extrabold tabular-nums tracking-[-0.02em]">
          {formatMoney(totals.totalSpend, base, locale)}
        </div>
        <div className="mt-[6px] flex flex-wrap gap-[14px] text-[0.6875rem]" style={{ color: 'rgba(245,245,247,.7)' }}>
          <span>{t('costs.yourShare')} · <b style={{ color: '#F5F5F7' }}>{formatMoney(totals.myShare, base, locale)}</b></span>
          <span>{t('costs.youPaid')} · <b style={{ color: '#F5F5F7' }}>{formatMoney(totals.myPaid, base, locale)}</b></span>
        </div>
      </div>

      {/* You owe / You're owed (spec §3.2) */}
      <div className="mt-[10px] flex gap-2">
        <div className="flex-1 rounded-2xl border border-[color:var(--m-rowbr)] bg-m-card p-[13px]">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px]" style={{ background: 'rgba(214,39,59,.12)', color: STATUS_COLOR.danger }}>
            <ArrowDown size={15} strokeWidth={2.2} />
          </span>
          <div className="mt-2 text-[0.8125rem] font-bold text-m-ink">{t('costs.youOwe')}</div>
          <div className="font-geist text-[0.59375rem] text-m-faint">{t('costs.youOweSub')}</div>
          <div className="mt-1 font-geist text-[1.1875rem] font-extrabold tabular-nums" style={{ color: totals.owe > 0.5 ? STATUS_COLOR.danger : 'var(--m-ink)' }}>
            {formatMoney(totals.owe, base, locale)}
          </div>
        </div>
        <div className="flex-1 rounded-2xl border border-[color:var(--m-rowbr)] bg-m-card p-[13px]">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px]" style={{ background: 'rgba(47,163,122,.12)', color: STATUS_COLOR.confirmed }}>
            <ArrowUp size={15} strokeWidth={2.2} />
          </span>
          <div className="mt-2 text-[0.8125rem] font-bold text-m-ink">{t('costs.youreOwed')}</div>
          <div className="font-geist text-[0.59375rem] text-m-faint">{t('costs.youreOwedSub')}</div>
          <div className="mt-1 font-geist text-[1.1875rem] font-extrabold tabular-nums" style={{ color: totals.owed > 0.5 ? STATUS_COLOR.confirmed : 'var(--m-ink)' }}>
            {formatMoney(totals.owed, base, locale)}
          </div>
        </div>
      </div>

      {/* Outstanding amount (spec §3.3) — only when unpaid expenses exist */}
      {totals.outstandingCount > 0 && (
        <div className="mt-2 flex items-center gap-[10px] rounded-2xl border border-[color:var(--m-rowbr)] bg-m-card px-[13px] py-[11px]">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[11px]" style={{ background: 'rgba(232,161,58,.14)', color: STATUS_COLOR.pending }}>
            <AlertCircle size={16} strokeWidth={2.2} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[0.78125rem] font-bold text-m-ink">{t('costs.outstanding')}</div>
            <div className="font-geist text-[0.59375rem] text-m-faint"><b>{totals.outstandingCount}</b> {t('costs.outstandingItems')}</div>
          </div>
          <div className="flex-none font-geist text-[0.9375rem] font-extrabold tabular-nums" style={{ color: STATUS_COLOR.pending }}>
            {formatMoney(totals.outstanding, base, locale)}
          </div>
        </div>
      )}

      {/* Settle up (spec §3.4) */}
      <div className="mt-2 rounded-2xl border border-[color:var(--m-rowbr)] bg-m-card p-[13px]">
        {/* Toggle and "Add payment" are siblings, not nested: a control inside a
            control reads as one element to a screen reader. */}
        <div className="flex w-full items-center gap-[7px]">
          <button
            type="button"
            aria-expanded={settleOpen}
            onClick={() => setSettleOpen(v => !v)}
            className="flex min-w-0 flex-1 items-center gap-[7px] text-left"
          >
            <span className="text-[0.875rem] font-extrabold text-m-ink">{t('costs.settleUp')}</span>
            <CountPill>{flows.length}</CountPill>
            {settleOpen ? (
              <ChevronUp size={14} strokeWidth={2} className="ml-auto flex-none text-m-faint" />
            ) : (
              <ChevronDown size={14} strokeWidth={2} className="ml-auto flex-none text-m-faint" />
            )}
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={() => setAddPaymentOpen(true)}
              className="flex flex-none items-center gap-[5px] rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-[11px] py-[6px] font-[inherit] text-[0.71875rem] font-semibold text-m-muted"
            >
              <Plus size={11} strokeWidth={2.2} />
              {t('costs.addPayment')}
            </button>
          )}
        </div>

        {settleOpen && (
          <>
            {flows.length === 0 ? (
              <div className="py-[14px] text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full" style={{ background: 'rgba(47,163,122,.14)', color: STATUS_COLOR.confirmed }}>
                  <Check size={19} strokeWidth={2.5} />
                </span>
                <div className="mt-[7px] text-[0.84375rem] font-bold text-m-ink">{t('costs.everyoneSquare')}</div>
                <div className="mt-[2px] font-geist text-[0.65625rem] text-m-faint">{t('costs.nothingOutstanding')}</div>
              </div>
            ) : (
              <div className="mt-[6px]">
                {flows.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 border-b border-[color:var(--m-rowbr)] py-2 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-[0.78125rem] font-semibold text-m-ink">{personName(f.from.user_id)}</span>
                    <ArrowRight size={12} strokeWidth={2.2} className="flex-none text-m-faint" />
                    <span className="min-w-0 flex-1 truncate text-[0.78125rem] font-semibold text-m-ink">{personName(f.to.user_id)}</span>
                    <span className="ml-auto flex-none font-geist text-[0.78125rem] font-extrabold tabular-nums text-m-ink">{formatMoney(f.amount, base, locale)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mb-[2px] mt-3 font-geist text-[0.625rem] font-bold uppercase tracking-[.09em] text-m-faint">{t('costs.balances')}</div>
            {tripMembers.map(p => {
              const balance = settlement?.balances.find(b => b.user_id === p.id)?.balance ?? 0
              const pos = balance > 0.01
              const neg = balance < -0.01
              return (
                <div key={p.id} className="flex items-center gap-[9px] border-b border-[color:var(--m-rowbr)] py-[7px] last:border-b-0">
                  <MemberAvatar name={p.username} avatarUrl={p.avatar_url} isMe={p.id === me} variant="neutral" size={24} t={t} />
                  <span className="min-w-0 flex-1 truncate text-[0.78125rem] font-semibold text-m-ink">{p.id === me ? t('costs.you') : p.username}</span>
                  <span className="ml-auto flex-none font-geist text-[0.75rem] font-extrabold tabular-nums" style={{ color: pos ? STATUS_COLOR.confirmed : neg ? STATUS_COLOR.danger : 'var(--m-faint)' }}>
                    {pos ? '+' : neg ? '−' : ''}
                    {formatMoney(Math.abs(balance), base, locale)}
                  </span>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* By category (spec §3.5) */}
      <div className="mt-2 rounded-2xl border border-[color:var(--m-rowbr)] bg-m-card p-[13px]">
        <div className="font-geist text-[0.625rem] font-bold uppercase tracking-[.09em] text-m-faint">{t('costs.byCategory')}</div>
        {catBreakdown.length === 0 ? (
          <p className="mt-2 font-geist text-[0.71875rem] text-m-faint">{t('costs.noCategories')}</p>
        ) : (
          catBreakdown.map(c => {
            const meta = COST_CAT_META[c.key]
            return (
              <div key={c.key} className="pb-[2px] pt-[6px]">
                <div className="flex items-center gap-[7px]">
                  <span className="h-2 w-2 flex-none rounded-full" style={{ background: meta.color }} />
                  <span className="min-w-0 flex-1 truncate font-geist text-[0.65625rem] font-semibold text-m-muted">{t(meta.labelKey)}</span>
                  <span className="ml-auto flex-none font-geist text-[0.65625rem] font-bold tabular-nums text-m-ink">{formatMoney(c.amount, base, locale)}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-[color:var(--m-ic)]">
                  <span className="block h-full rounded-full" style={{ width: `${c.widthPct}%`, background: meta.color }} />
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Expenses — header, search, filters (spec §3.6) */}
      <h2 className="mt-4 text-[1.0625rem] font-extrabold text-m-ink">{t('costs.expenses')}</h2>
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={t('costs.searchPlaceholder')}
        aria-label={t('costs.searchPlaceholder')}
        className="mt-2 w-full rounded-full border border-[color:var(--m-rowbr)] bg-m-card px-[13px] py-[10px] font-[inherit] text-[0.8125rem] font-medium text-m-ink outline-none placeholder:text-m-faint"
      />
      <div className="mt-2 flex rounded-full bg-m-card p-[3px]">
        {(['all', 'mine', 'owed'] as const).map(seg => (
          <button
            key={seg}
            type="button"
            aria-pressed={segment === seg}
            onClick={() => setSegment(seg)}
            className={`flex-1 rounded-full py-[7px] text-center text-[0.71875rem] font-semibold ${segment === seg ? 'bg-m-act text-m-actfg' : 'text-m-ink'}`}
          >
            {t('costs.filter.' + seg)}
          </button>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          aria-expanded={catOpen}
          onClick={() => {
            setCatOpen(v => !v)
            setDayOpen(false)
          }}
          className="flex flex-1 items-center justify-between gap-2 overflow-hidden rounded-xl border border-[color:var(--m-rowbr)] bg-m-card px-[13px] py-[9px] text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[0.75rem] font-semibold text-m-ink">
            {catFilter ? t(catMeta(catFilter).labelKey) : t('costs.filter.allCategories')}
          </span>
          <ChevronDown size={13} strokeWidth={2} className="flex-none text-m-faint" />
        </button>
        <button
          type="button"
          aria-expanded={dayOpen}
          onClick={() => {
            setDayOpen(v => !v)
            setCatOpen(false)
          }}
          className="flex flex-1 items-center justify-between gap-2 overflow-hidden rounded-xl border border-[color:var(--m-rowbr)] bg-m-card px-[13px] py-[9px] text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[0.75rem] font-semibold text-m-ink">
            {dayFilter ? dayOptionLabel(dayFilter) : t('costs.filter.allDays')}
          </span>
          <ChevronDown size={13} strokeWidth={2} className="flex-none text-m-faint" />
        </button>
      </div>

      {catOpen && (
        <div className="mt-[6px] overflow-hidden rounded-2xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-glass)]">
          <button
            type="button"
            onClick={() => {
              setCatFilter('')
              setCatOpen(false)
            }}
            className="flex w-full items-center gap-[10px] border-b border-[color:var(--m-rowbr)] px-[13px] py-[10px] text-left"
          >
            <Layers size={14} strokeWidth={2} className="flex-none text-m-muted" />
            <span className="text-[0.78125rem] font-medium text-m-ink">{t('costs.filter.allCategories')}</span>
          </button>
          {catKeys.map(k => {
            const meta = COST_CAT_META[k]
            const Icon = meta.Icon
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setCatFilter(k)
                  setCatOpen(false)
                }}
                className="flex w-full items-center gap-[10px] border-b border-[color:var(--m-rowbr)] px-[13px] py-[10px] text-left last:border-b-0"
              >
                <Icon size={14} strokeWidth={2} style={{ color: meta.color }} className="flex-none" />
                <span className="text-[0.78125rem] font-medium text-m-ink">{t(meta.labelKey)}</span>
              </button>
            )
          })}
        </div>
      )}

      {dayOpen && (
        <div className="mt-[6px] overflow-hidden rounded-2xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-glass)]">
          <button
            type="button"
            onClick={() => {
              setDayFilter('')
              setDayOpen(false)
            }}
            className="w-full border-b border-[color:var(--m-rowbr)] px-[13px] py-[10px] text-left text-[0.78125rem] font-medium text-m-ink"
          >
            {t('costs.filter.allDays')}
          </button>
          {dayKeys.map(d => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setDayFilter(d)
                setDayOpen(false)
              }}
              className="w-full border-b border-[color:var(--m-rowbr)] px-[13px] py-[10px] text-left text-[0.78125rem] font-medium text-m-ink last:border-b-0"
            >
              {dayOptionLabel(d)}
            </button>
          ))}
        </div>
      )}

      {/* Expense groups (spec §3.7) — expenses and recorded settle-up payments, day-merged */}
      {groups.map(g => {
        const groupTotal = g.entries.reduce((a, en) => en.kind === 'expense' ? a + baseTotal(en.item, ctx) : a, 0)
        return (
          <div key={g.dateKey || 'no-date'}>
            <div className="mt-[14px] flex items-baseline gap-2 px-[2px]">
              <span className="font-geist text-[0.625rem] font-bold uppercase tracking-[.09em] text-m-faint">{groupLabel(g.dateKey)}</span>
              <span className="ml-auto flex-none font-geist text-[0.59375rem] font-bold tabular-nums text-m-muted">
                {t('costs.spent', { amount: formatMoney(groupTotal, base, locale) })}
              </span>
            </div>
            {g.entries.map(en => en.kind === 'expense' ? (
              <ExpenseRow
                key={'e' + en.item.id}
                item={en.item}
                ctx={ctx}
                base={base}
                locale={locale}
                t={t}
                canEdit={canEdit}
                onEdit={() => {
                  setEditingExpense(en.item)
                  setExpenseModalOpen(true)
                }}
                onDelete={() => setConfirmDelete(en.item)}
                onTogglePaid={(userId, paid) => handleTogglePaid(en.item.id, userId, paid)}
                onPreviewReceipts={(receipts) => setPreviewReceipts({ receipts, initialIndex: 0 })}
              />
            ) : (
              <PaymentRow
                key={'s' + en.settlement.id}
                settlement={en.settlement}
                ctx={ctx}
                base={base}
                locale={locale}
                t={t}
                personName={personName}
              />
            ))}
          </div>
        )
      })}

      {groups.length === 0 && (
        budgetItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <MDancingTrek scene="costs" className="mb-2" />
            <p className="font-geist text-[0.8125rem] font-medium text-m-muted">{t('costs.emptyText')}</p>
          </div>
        ) : (
          <p className="py-6 text-center font-geist text-[0.6875rem] text-m-faint">{t('costs.noMatch')}</p>
        )
      )}

      {/* Add / edit expense — the shared desktop modal (spec §3.9); not rebuilt here. */}
      {expenseModalOpen && (
        <MCostSheet
          tripId={tripId}
          base={base}
          people={tripMembers}
          me={me}
          editing={editingExpense}
          onClose={() => setExpenseModalOpen(false)}
          onSaved={() => {
            setExpenseModalOpen(false)
            planner.tripActions.loadBudgetItems(tripId)
            loadSettlement()
          }}
        />
      )}

      <AddPaymentSheet
        open={addPaymentOpen}
        onClose={() => setAddPaymentOpen(false)}
        tripId={tripId}
        base={base}
        people={tripMembers}
        me={me}
        toast={toast}
        t={t}
        onSaved={() => {
          setAddPaymentOpen(false)
          loadSettlement()
        }}
      />

      <MConfirmSheet
        open={confirmDelete != null}
        onClose={() => setConfirmDelete(null)}
        title={t('costs.confirm.deleteTitle')}
        message={t('costs.confirm.deleteBody', { name: confirmDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          const item = confirmDelete
          setConfirmDelete(null)
          if (item) handleDeleteExpense(item)
        }}
      />

      {previewReceipts && (
        <ReceiptPreviewModal
          receipts={previewReceipts.receipts}
          initialIndex={previewReceipts.initialIndex}
          onClose={() => setPreviewReceipts(null)}
        />
      )}
    </TabScroller>
  )
}

/** One expense card (spec 03 §3.7): category ribbon, optional unfinished ribbon, member chips, total pill, edit/delete stack. */
function ExpenseRow({ item, ctx, base, locale, t, canEdit, onEdit, onDelete, onTogglePaid, onPreviewReceipts }: {
  item: BudgetItem
  ctx: CostsCtx
  base: string
  locale: string
  t: TFn
  canEdit: boolean
  onEdit: () => void
  onDelete: () => void
  onTogglePaid: (userId: number, paid: boolean) => void
  onPreviewReceipts: (receipts: BudgetItemReceipt[]) => void
}) {
  const meta = catMeta(item.category)
  const Icon = meta.Icon
  const cur = currencyOf(item, ctx)
  const total = baseTotal(item, ctx)
  const unfinished = isUnfinished(item, ctx)
  const borderColor = tint(meta.color, 0.55)
  const members = item.members || []
  const note = readUserNote(item)
  // A phone row has no width to spare for a note, so it stays folded away and
  // the card itself is the handle — no extra control, no extra height.
  const [noteOpen, setNoteOpen] = useState(false)

  return (
    <div className="mt-2 flex items-center gap-[6px]">
      <div className="relative min-w-0 flex-1 rounded-2xl bg-m-card px-3 pb-[10px] pt-[22px]" style={{ border: `1.5px solid ${borderColor}` }}>
        <span
          className="absolute -left-[1.5px] -top-[1.5px] flex items-center gap-1 rounded-bl-none rounded-br-[12px] rounded-tl-[15px] rounded-tr-none px-[11px] pb-[4px] pt-[3px] font-geist text-[0.5625rem] font-extrabold uppercase tracking-[.05em] text-white"
          style={{ background: meta.color }}
        >
          <Icon size={10} strokeWidth={2.4} />
          {t(meta.labelKey)}
        </span>
        {unfinished && (
          <span
            className="absolute -right-[1.5px] -top-[1.5px] rounded-bl-[12px] rounded-br-none rounded-tl-none rounded-tr-[15px] px-[11px] pb-[4px] pt-[3px] font-geist text-[0.53125rem] font-extrabold uppercase tracking-[.03em] text-white"
            style={{ background: 'var(--m-st-pending)' }}
          >
            {t('costs.unfinished')}
          </span>
        )}

        <div className="flex items-center gap-[10px]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-[0.8125rem] font-bold text-m-ink">{item.name}</span>
              {(item.receipts || []).length > 0 && (
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onPreviewReceipts(item.receipts!)
                  }}
                  title={t('costs.viewReceipt')}
                  className="inline-flex items-center gap-1 rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-2 py-0.5 text-[0.625rem] font-semibold text-m-muted active:scale-95 transition-all"
                >
                  <Receipt size={11} className="text-m-faint" />
                  <span>{t('costs.receipts') || 'Beleg'}{item.receipts!.length > 1 ? ` (${item.receipts!.length})` : ''}</span>
                </button>
              )}
            </div>
            {cur !== base && (
              <div className="mt-[1px] truncate font-geist text-[0.59375rem] text-m-faint">
                {formatMoney(item.total_price, cur, locale)} {'→'} {formatMoney(total, base, locale)}
              </div>
            )}
            {members.length > 0 && (
              <div className="mt-[5px] flex flex-wrap gap-1">
                {members.map(m => (
                  <button
                    key={m.user_id}
                    type="button"
                    disabled={!canEdit}
                    aria-pressed={Boolean(m.paid)}
                    onClick={() => onTogglePaid(m.user_id, !m.paid)}
                    className={`inline-flex items-center gap-1 rounded-full py-[2px] pl-[3px] pr-[7px] ${
                      m.paid ? 'border-2 border-[color:var(--m-st-confirmed)]' : 'border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)]'
                    }`}
                  >
                    <MemberAvatar name={m.username} avatarUrl={m.avatar_url} isMe={m.user_id === ctx.me} variant="accent" size={14} t={t} />
                    <span className="font-geist text-[0.5625rem] font-bold tabular-nums text-m-ink">
                      {formatMoney(memberShareOf(item, m.user_id, ctx), base, locale)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="flex-none rounded-full bg-[color:var(--m-ic)] px-[11px] py-1 font-geist text-[0.75rem] font-extrabold tabular-nums text-m-ink">
            {formatMoney(total, base, locale)}
          </span>
        </div>

        {note && (
          <button
            type="button"
            aria-expanded={noteOpen}
            onClick={() => setNoteOpen(v => !v)}
            className="mt-[7px] flex w-full items-center gap-[7px] rounded-xl bg-[color:var(--m-ic)] px-[9px] py-[6px] text-left"
          >
            <StickyNote size={11} strokeWidth={2} className="flex-none text-m-faint" />
            <span className={`min-w-0 flex-1 text-[0.6875rem] leading-[1.5] text-m-muted ${noteOpen ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'truncate'}`}>
              {note}
            </span>
            <ChevronDown
              size={12}
              strokeWidth={2}
              className={`flex-none text-m-faint transition-transform duration-200 ${noteOpen ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-none flex-col gap-1 rounded-full border border-[color:var(--m-gbr)] bg-[color:var(--m-glass)] p-[5px]">
          <button type="button" onClick={onEdit} aria-label={t('common.edit')} className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-m-muted">
            <Pencil size={12} strokeWidth={2} />
          </button>
          <button type="button" onClick={onDelete} aria-label={t('common.delete')} className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-m-muted">
            <Trash2 size={12} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * A recorded settle-up payment mixed into the day-grouped ledger (spec 03
 * §3.7 desktop parity — see `CostsPanel.tsx`'s `SettlementRow`). Read-only:
 * editing/undoing a payment stays a desktop-only action for now, this row
 * only closes the "it vanishes into thin air" gap on mobile.
 */
function PaymentRow({ settlement, ctx, base, locale, t, personName }: {
  settlement: CostsSettlement
  ctx: CostsCtx
  base: string
  locale: string
  t: TFn
  personName: (id: number) => string
}) {
  const cur = (settlement.currency || base).toUpperCase()
  const amount = ctx.convert(settlement.amount, cur)
  return (
    <div className="mt-2 flex items-center gap-[6px]">
      <div className="relative min-w-0 flex-1 rounded-2xl border border-[color:var(--m-rowbr)] bg-m-card px-3 py-[12px]">
        <div className="flex items-center gap-[10px]">
          <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[12px]" style={{ background: 'rgba(47,163,122,.12)', color: STATUS_COLOR.confirmed }}>
            <ArrowLeftRight size={17} strokeWidth={2.2} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.8125rem] font-bold text-m-ink">{t('costs.payment')}</div>
            <div className="truncate font-geist text-[0.65625rem] text-m-faint">{personName(settlement.from_user_id)} → {personName(settlement.to_user_id)}</div>
          </div>
          <span className="flex-none rounded-full bg-[color:var(--m-ic)] px-[11px] py-1 font-geist text-[0.75rem] font-extrabold tabular-nums text-m-ink">
            {formatMoney(amount, base, locale)}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Avatar or initials circle; `variant` picks the accent (member chips) or neutral (balances) tone. */
function MemberAvatar({ name, avatarUrl, isMe, variant, size, t }: {
  name: string
  avatarUrl?: string | null
  isMe: boolean
  variant: 'accent' | 'neutral'
  size: number
  t: TFn
}) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="flex-none rounded-full object-cover" style={{ width: size, height: size }} />
  }
  const initial = isMe ? t('costs.youShort') : (name || '?').charAt(0).toUpperCase()
  const toneCls = variant === 'accent' ? 'bg-m-act text-m-actfg' : 'bg-[color:var(--m-ic)] text-m-ink'
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full font-geist font-extrabold ${toneCls}`}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.42) }}
    >
      {initial}
    </span>
  )
}

/**
 * "Add payment" — records a manual settle-up transfer (`budgetApi.createSettlement`).
 * No pixel spec exists for this form (the demo only toasts "Demo: add payment",
 * 03-trip-tabs.md §3.8) and no mobile/exported-desktop sheet covers it, so this
 * is a small local sheet built from the trip form-sheet chrome, kept to the
 * fields the settle-up card itself needs: from, to, amount in the display currency.
 */
function AddPaymentSheet({ open, onClose, tripId, base, people, me, toast, t, onSaved }: {
  open: boolean
  onClose: () => void
  tripId: number
  base: string
  people: TripMember[]
  me: number
  toast: { error: (message: string) => void }
  t: TFn
  onSaved: () => void
}) {
  const [fromId, setFromId] = useState(me)
  const [toId, setToId] = useState(() => people.find(p => p.id !== me)?.id ?? me)
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setFromId(me)
    setToId(people.find(p => p.id !== me)?.id ?? me)
    setAmount('')
    setSaving(false)
  }, [open, me, people])

  const amt = Number.parseFloat(amount.replace(',', '.')) || 0
  const valid = amt > 0 && fromId !== toId

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    try {
      await budgetApi.createSettlement(tripId, { from_user_id: fromId, to_user_id: toId, amount: amt, currency: base })
      onSaved()
    } catch {
      toast.error(t('common.unknownError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <MSheet open={open} onClose={onClose} ariaLabel={t('costs.addPayment')}>
      <FormSheetHeader title={t('costs.addPayment')} onClose={onClose} closeLabel={t('common.close')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[6px] pt-1">
        <Eyebrow className="mb-[7px] uppercase">{t('costs.from')}</Eyebrow>
        <div className="flex flex-wrap gap-[6px]">
          {people.map(p => (
            <MChip key={p.id} active={fromId === p.id} onClick={() => setFromId(p.id)}>
              <MemberAvatar name={p.username} avatarUrl={p.avatar_url} isMe={p.id === me} variant={fromId === p.id ? 'accent' : 'neutral'} size={16} t={t} />
              {p.id === me ? t('costs.you') : p.username}
            </MChip>
          ))}
        </div>

        <Eyebrow className="mb-[7px] mt-[14px] uppercase">{t('costs.to')}</Eyebrow>
        <div className="flex flex-wrap gap-[6px]">
          {people.map(p => (
            <MChip key={p.id} active={toId === p.id} onClick={() => setToId(p.id)}>
              <MemberAvatar name={p.username} avatarUrl={p.avatar_url} isMe={p.id === me} variant={toId === p.id ? 'accent' : 'neutral'} size={16} t={t} />
              {p.id === me ? t('costs.you') : p.username}
            </MChip>
          ))}
        </div>

        <Eyebrow className="mb-[7px] mt-[14px] uppercase">{t('costs.amount')}</Eyebrow>
        <div className="flex items-center gap-2">
          <input type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className={FIELD_CLS} />
          <span className="flex-none font-geist text-[0.75rem] font-bold text-m-faint">{base}</span>
        </div>
      </div>
      <FormSheetFooter onCancel={onClose} cancelLabel={t('common.cancel')} onSubmit={save} submitLabel={t('costs.addPayment')} submitDisabled={!valid || saving} />
    </MSheet>
  )
}
