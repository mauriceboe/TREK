import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Plus, Trash2, Wallet, Receipt, Paperclip } from 'lucide-react'
import MSheet from '../../../components/MSheet'
import CustomSelect from '../../../../components/shared/CustomSelect'
import { CustomDatePicker } from '../../../../components/shared/CustomDateTimePicker'
import { NumericInput } from '../../../../components/shared/NumericInput'
import { Eyebrow, FIELD_AREA_CLS, FIELD_CLS, FormSheetFooter, FormSheetHeader } from './PlSheetChrome'
import { useTranslation } from '../../../../i18n'
import { useToast } from '../../../../components/shared/Toast'
import { useTripStore } from '../../../../store/tripStore'
import { useExchangeRates } from '../../../../hooks/useExchangeRates'
import { formatMoney, localizeAmountInput, amountToInputString } from '../../../../utils/formatters'
import { openFile } from '../../../../utils/fileDownload'
import { filesApi } from '../../../../api/client'
import { SYMBOLS, SPLIT_COLORS, currenciesWith } from '../../../../components/Budget/BudgetPanel.constants'
import { COST_CATEGORY_LIST, catMeta } from '../../../../components/Budget/costsCategories'
import { localToday } from '../../../../components/Planner/today'
import { amountPattern, calculateTicketShares, hasTicketSplit, NOTE_MAX, readTicketItems, readUserNote, splitEqualShares, writeTicketItems, type TicketItem } from '../../../../components/Budget/CostsPanel.helpers'
import type { ExpensePrefill } from '../../../../components/Budget/CostsPanel'
import { payersBalanced, rebalancePayers } from '../../../../components/Budget/CostsPanel.helpers'
import GuestBadge from '../../../../components/shared/GuestBadge'
import type { TripMember } from '../../../../components/Budget/BudgetPanelMemberChips'
import { ReceiptPreviewModal } from '../../../../components/Budget/ReceiptPreviewModal'
import type { BudgetItem, BudgetItemReceipt } from '../../../../types'

export interface MCostSheetProps {
  tripId: number
  base: string
  people: TripMember[]
  me: number
  editing: BudgetItem | null
  prefill?: ExpensePrefill
  onClose: () => void
  onSaved: () => void
}

// Nested surfaces for the split/payer rows on the opaque sheet: the row sits on
// --m-ic, the amount box drops back to the solid sheet fill so it reads as a
// distinct input in both themes.
const ROW_CLS = 'flex items-center gap-[9px] rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[9px]'
const MINI_INPUT_WRAP = 'flex items-center gap-1 rounded-[9px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] px-[10px]'

const SPLIT_MODES = [
  { id: 'equally', labelKey: 'costs.splitEqually' },
  { id: 'custom', labelKey: 'costs.splitCustom' },
  { id: 'ticket', labelKey: 'costs.splitTicket' },
] as const

/**
 * Add/edit expense sheet — the mobile counterpart of the desktop ExpenseModal
 * (CostsPanel). Drop-in with the same props: the parent mounts it only while
 * open, and it saves through the same tripStore actions (addBudgetItem /
 * updateBudgetItem / deleteBudgetItem). Ports every field and split mode:
 * multi-currency with live conversion, single/multi payer, and the Equally /
 * Custom / Ticket splits.
 */
export default function MCostSheet({ tripId, base, people, me, editing, prefill, onClose, onSaved }: MCostSheetProps) {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const { addBudgetItem, updateBudgetItem, deleteBudgetItem } = useTripStore()
  const { convert } = useExchangeRates(base)
  const sym = (c: string) => SYMBOLS[c] || (c + ' ')

  // Internal open flag so the exit animation still plays even though the parent
  // unmounts us on close.
  const [open, setOpen] = useState(true)
  const closeTimer = useRef<number | null>(null)
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current) }, [])
  const requestClose = () => {
    setOpen(false)
    closeTimer.current = window.setTimeout(onClose, 280)
  }

  const [name, setName] = useState(editing?.name || prefill?.name || '')
  const [cat, setCat] = useState<string>(editing ? catMeta(editing.category).key : (prefill?.category || 'food'))
  const [catOpen, setCatOpen] = useState(false)
  const [note, setNote] = useState(() => readUserNote(editing))
  const [currency, setCurrency] = useState((editing?.currency || base).toUpperCase())
  const [day, setDay] = useState(editing?.expense_date || localToday())
  // Edit and prefill seeds are padded to the currency's decimals (#2175), same
  // as the desktop modal: a saved 4,90 must reopen as "4,90", not "4,9". A
  // prefill has no currency of its own and is read as `base`.
  const [total, setTotal] = useState<string>(() => {
    if (editing) return editing.total_price ? amountToInputString(editing.total_price, (editing.currency || base).toUpperCase()) : ''
    if (prefill?.amount != null) return amountToInputString(prefill.amount, base)
    return ''
  })
  const [participants, setParticipants] = useState<Set<number>>(() =>
    editing ? new Set((editing.members || []).map(m => m.user_id)) : new Set(people.map(p => p.id)))

  // Payer state — same model as the desktop modal. 0 = "Nobody (planning entry)".
  // A negative payer (the recipient of a refund, #2176) must survive the reopen.
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
  const [pinnedPayers, setPinnedPayers] = useState<Set<number>>(() => new Set(initialPayers.map(p => p.user_id)))

  const [splitMode, setSplitMode] = useState<'equally' | 'custom' | 'ticket'>(() => {
    if (hasTicketSplit(editing)) return 'ticket'
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
        if (member.amount !== null && member.amount !== undefined) m[member.user_id] = amountToInputString(member.amount, currency)
      }
    }
    return m
  })

  const [receipts, setReceipts] = useState<BudgetItemReceipt[]>(() => editing?.receipts || [])
  const [pendingReceiptFiles, setPendingReceiptFiles] = useState<File[]>([])
  const [uploadingReceipt, setUploadingReceipt] = useState(false)
  const [previewReceipts, setPreviewReceipts] = useState<{ receipts: BudgetItemReceipt[]; initialIndex: number } | null>(null)

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
  const [deleteArmed, setDeleteArmed] = useState(false)

  const isTicketMode = splitMode === 'ticket'
  const ticketInfo = useMemo(() => calculateTicketShares(ticketItems), [ticketItems])

  const totalNum = isTicketMode ? ticketInfo.total : (Number.parseFloat(total) || 0)
  const splitSum = [...participants].reduce((sum, id) => sum + (Number.parseFloat(customAmounts[id]) || 0), 0)
  const customBalanced = Math.round(splitSum * 100) === Math.round(totalNum * 100)
  const each = participants.size > 0 ? totalNum / participants.size : 0
  const equalShares = useMemo(
    () => splitEqualShares(totalNum, [...participants].map(id => ({ user_id: id })), editing?.id || 0),
    [totalNum, participants, editing],
  )

  const placeholderShares = useMemo(() => {
    const emptyParts = [...participants].filter(id => !customAmounts[id])
    if (emptyParts.length === 0) return {}
    const enteredSum = [...participants]
      .filter(id => customAmounts[id])
      .reduce((sum, id) => sum + (Number.parseFloat(customAmounts[id]) || 0), 0)
    // Clamped toward zero on the total's own side so a negative total (#2176)
    // still previews its negative equal shares — same as the desktop modal.
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

  const onTotalChange = (v: string) => setTotal(v.replace(',', '.'))

  // Keep payer amounts summing to the total as it changes (also in ticket mode).
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
    const [first] = [...payerIds]
    setPayerId(first ?? me)
    setMultiPayer(false)
  }

  const togglePayer = (id: number) => {
    const nextIds = new Set(payerIds)
    const nextPinned = new Set(pinnedPayers)
    if (nextIds.has(id)) { nextIds.delete(id); nextPinned.delete(id) } else { nextIds.add(id) }
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
    if (val === '' || amountPattern(currency, true).test(val)) setCustomAmounts(prev => ({ ...prev, [id]: val }))
  }

  const handleAddEmptyItem = () => {
    setTicketItems(prev => [
      ...prev,
      { id: String(Date.now() + Math.random()), name: '', price: '', participants: new Set(people.map(p => p.id)) },
    ])
  }
  const handleUpdateItemName = (id: string, itemName: string) => setTicketItems(prev => prev.map(item => item.id === id ? { ...item, name: itemName } : item))
  const handleUpdateItemPrice = (id: string, price: string) => {
    price = price.replace(',', '.')
    if (price === '' || amountPattern(currency, false).test(price)) setTicketItems(prev => prev.map(item => item.id === id ? { ...item, price } : item))
  }
  const handleRemoveItem = (id: string) => setTicketItems(prev => prev.filter(item => item.id !== id))
  const handleToggleItemParticipant = (itemId: string, userId: number) => {
    setTicketItems(prev => prev.map(item => {
      if (item.id !== itemId) return item
      const nextParts = new Set(item.participants)
      if (nextParts.has(userId)) nextParts.delete(userId); else nextParts.add(userId)
      return { ...item, participants: nextParts }
    }))
  }

  const toggleParticipant = (id: number) => {
    const nextParts = new Set(participants)
    if (nextParts.has(id)) {
      nextParts.delete(id)
      setCustomAmounts(prev => { const copy = { ...prev }; delete copy[id]; return copy })
    } else {
      nextParts.add(id)
    }
    setParticipants(nextParts)
  }

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    // A picked payer always goes out, even when nobody shares the expense: the
    // server re-derives total_price from the payer sum (CostsPanel.helpers), so
    // dropping the payer would store the entry with a total of 0.
    const payerList = multiPayer
      ? [...payerIds].map(id => ({ user_id: id, amount: Number.parseFloat(payerAmounts[id]) || 0 })).filter(p => p.amount !== 0)
      : payerId > 0 ? [{ user_id: payerId, amount: totalNum }] : []
    const memberList = [...participants].map(id => ({
      user_id: id,
      amount: splitMode === 'custom'
        ? (Number.parseFloat(customAmounts[id]) || 0)
        : splitMode === 'ticket'
          ? (ticketInfo.shares[id] || 0)
          : null,
    }))
    const data = {
      name: name.trim(),
      category: cat,
      currency,
      payers: payerList,
      members: memberList,
      member_ids: [...participants],
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

      if (editing) {
        try {
          await updateBudgetItem(tripId, editing.id, {
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
          await addBudgetItem(tripId, {
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
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      toast.warning(t('mobileTrip.tapAgainToDelete'))
      return
    }
    try {
      await deleteBudgetItem(tripId, editing.id)
      onSaved()
    } catch {
      toast.error(t('common.unknownError'))
      setDeleteArmed(false)
    }
  }

  const initialOf = (p: TripMember) => (p.id === me ? t('costs.youShort') : (p.username || '?').charAt(0)).toUpperCase()
  const nameOf = (p: TripMember) => (p.id === me ? t('costs.you') : p.username)

  const Avatar = ({ p, idx, size = 22, dim = false }: { p: TripMember; idx: number; size?: number; dim?: boolean }) =>
    p.avatar_url
      ? <img src={p.avatar_url} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, opacity: dim ? 0.45 : 1 }} />
      : (
        <span
          style={{
            width: size, height: size, borderRadius: '50%', background: SPLIT_COLORS[idx % SPLIT_COLORS.length].gradient,
            // theme-lint-disable — white initial on the member's tint, and the glyph scales with the avatar
            color: '#fff', display: 'grid', placeItems: 'center', fontSize: size * 0.4, fontWeight: 700, flexShrink: 0, opacity: dim ? 0.45 : 1,
          }}
        >
          {initialOf(p)}
        </span>
      )

  const submitLabel = saving ? t('common.saving') : editing ? t('common.save') : t('common.add')

  return (
    <MSheet
      open={open}
      onClose={requestClose}
      material="opaque"
      ariaLabel={editing ? t('costs.editExpense') : t('costs.addExpense')}
    >
      <FormSheetHeader
        icon={Wallet}
        title={editing ? t('costs.editExpense') : t('costs.addExpense')}
        onClose={requestClose}
        closeLabel={t('common.close')}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[6px] pt-[2px]">
        {/* NAME */}
        <Eyebrow className="mb-[5px] mt-2 uppercase">{t('costs.whatFor')} *</Eyebrow>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('costs.namePlaceholder')}
          className={FIELD_CLS}
        />

        {/* TOTAL AMOUNT */}
        <Eyebrow className="mb-[5px] mt-3 uppercase">{t('costs.totalAmount')}</Eyebrow>
        <div className={`flex items-center gap-1 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[10px] ${isTicketMode ? 'opacity-60' : ''}`}>
          <span className="text-[0.84375rem] font-medium text-m-faint">{sym(currency)}</span>
          <NumericInput
            mode="signed-decimal"
            signToggleLabel={t('costs.toggleSign')}
            placeholder={localizeAmountInput('0.00', currency)}
            value={localizeAmountInput(isTicketMode ? ticketInfo.total.toFixed(2) : total, currency)}
            onValueChange={onTotalChange}
            disabled={isTicketMode}
            className="min-w-0 flex-1 border-0 bg-transparent text-[0.84375rem] font-semibold text-m-ink outline-none [font-variant-numeric:tabular-nums] placeholder:text-m-faint"
          />
        </div>

        {/* CURRENCY + DAY */}
        <div className="mt-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <Eyebrow className="mb-[5px] uppercase">{t('costs.currency')}</Eyebrow>
            <CustomSelect
              value={currency}
              onChange={v => setCurrency(String(v))}
              searchable
              size="sm"
              options={currenciesWith(currency).map(c => ({ value: c, label: SYMBOLS[c] ? `${c}  ${SYMBOLS[c]}` : c }))}
              style={{ width: '100%' }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Eyebrow className="mb-[5px] uppercase">{t('costs.day')}</Eyebrow>
            <CustomDatePicker value={day} onChange={setDay} style={{ width: '100%' }} />
          </div>
        </div>

        {/* CONVERSION HINT */}
        {currency !== base && totalNum !== 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[9px] text-[0.71875rem] text-m-muted">
            <span>{formatMoney(totalNum, currency, locale)}</span>
            <span className="text-m-faint">≈</span>
            <span className="font-semibold text-m-ink">{formatMoney(convert(totalNum, currency), base, locale)}</span>
            <span className="text-m-faint">· {t('costs.liveRate')}</span>
          </div>
        )}

        {/* CATEGORY — a dropdown rather than eleven pills, which took a third of
            the sheet and pushed the split below the fold. Same shape as the
            category filter on the tab behind it. */}
        <Eyebrow className="mb-[6px] mt-3 uppercase">{t('costs.category')}</Eyebrow>
        <button
          type="button"
          aria-expanded={catOpen}
          onClick={() => setCatOpen(v => !v)}
          className="flex w-full items-center gap-[10px] overflow-hidden rounded-xl border border-[color:var(--m-rowbr)] bg-m-card px-[13px] py-[11px] text-left"
        >
          {(() => {
            const meta = catMeta(cat)
            const Icon = meta.Icon
            return <Icon size={15} strokeWidth={2} style={{ color: meta.color }} className="flex-none" />
          })()}
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-m-ink">{t(catMeta(cat).labelKey)}</span>
          <ChevronDown size={14} strokeWidth={2} className={`flex-none text-m-faint transition-transform duration-200 ${catOpen ? 'rotate-180' : ''}`} />
        </button>
        {catOpen && (
          <div className="mt-[6px] max-h-[240px] overflow-y-auto overscroll-contain rounded-2xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-glass)]">
            {COST_CATEGORY_LIST.map(c => {
              const Icon = c.Icon
              const on = cat === c.key
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => { setCat(c.key); setCatOpen(false) }}
                  className="flex w-full items-center gap-[10px] border-b border-[color:var(--m-rowbr)] px-[13px] py-[11px] text-left last:border-b-0"
                >
                  <Icon size={14} strokeWidth={2} style={{ color: c.color }} className="flex-none" />
                  <span className={`flex-1 text-[0.78125rem] ${on ? 'font-bold text-m-ink' : 'font-medium text-m-muted'}`}>{t(c.labelKey)}</span>
                  {on && <Check size={14} strokeWidth={2.4} className="flex-none text-m-ink" />}
                </button>
              )
            })}
          </div>
        )}

        {/* WHO PAID */}
        <div className="mb-[6px] mt-3 flex items-center justify-between">
          <Eyebrow className="uppercase">{t('costs.whoPaid')}</Eyebrow>
          <button
            type="button"
            onClick={() => (multiPayer ? disableMultiPayer() : enableMultiPayer())}
            className="font-geist text-[0.625rem] font-semibold text-m-muted underline"
          >
            {multiPayer ? t('costs.singlePayer') : t('costs.multiplePayers')}
          </button>
        </div>
        {!multiPayer ? (
          <CustomSelect
            value={String(payerId)}
            onChange={v => setPayerId(Number(v))}
            size="sm"
            options={[
              { value: '0', label: t('costs.noOnePaid') },
              ...people.map(p => ({ value: String(p.id), label: nameOf(p) })),
            ]}
            style={{ width: '100%' }}
          />
        ) : (
          <>
            <div className="flex flex-col gap-[6px]">
              {people.map((p, idx) => {
                const on = payerIds.has(p.id)
                return (
                  <div key={p.id} className={`${ROW_CLS} ${on ? '' : 'opacity-60'}`}>
                    <button
                      type="button"
                      onClick={() => togglePayer(p.id)}
                      className="flex min-w-0 flex-1 items-center gap-[8px] text-left"
                    >
                      <Avatar p={p} idx={idx} dim={!on} />
                      <span className="truncate text-[0.8125rem] font-medium text-m-ink">{nameOf(p)}</span>
                    </button>
                    {on ? (
                      <div className={`${MINI_INPUT_WRAP} w-[120px] flex-none`}>
                        <span className="text-[0.75rem] text-m-faint">{sym(currency)}</span>
                        <NumericInput
                          mode="signed-decimal"
                          signToggleLabel={t('costs.toggleSign')}
                          placeholder={localizeAmountInput('0.00', currency)}
                          value={localizeAmountInput(payerAmounts[p.id] || '', currency)}
                          onValueChange={v => onPayerAmountChange(p.id, v)}
                          className="w-full border-0 bg-transparent py-[7px] text-right text-[0.8125rem] font-semibold text-m-ink outline-none"
                        />
                      </div>
                    ) : (
                      <button type="button" onClick={() => togglePayer(p.id)} className="flex-none text-[0.6875rem] text-m-faint">
                        {t('costs.tapToInclude')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {!payersOk && (
              <div className="mt-2 text-[0.6875rem] text-[color:var(--m-st-danger)]">
                {t('costs.payersUnbalanced', { amount: formatMoney(totalNum, currency, locale) })}
              </div>
            )}
          </>
        )}

        {/* SPLIT */}
        <Eyebrow className="mb-[6px] mt-3 uppercase">{t('costs.split')}</Eyebrow>
        <div className="flex rounded-full bg-[color:var(--m-ic)] p-[3px]">
          {SPLIT_MODES.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSplitMode(m.id)}
              className={`flex-1 rounded-full py-[7px] text-[0.71875rem] font-semibold ${splitMode === m.id ? 'bg-m-act text-m-actfg' : 'text-m-muted'}`}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>

        {isTicketMode ? (
          <div className="mt-2 flex flex-col gap-2">
            {ticketItems.map(item => (
              <div key={item.id} className="flex flex-col gap-2 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-[10px]">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder={t('costs.whatFor')}
                    value={item.name}
                    onChange={e => handleUpdateItemName(item.id, e.target.value)}
                    className="min-w-0 flex-[2] rounded-[9px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] px-[10px] py-[7px] text-[0.8125rem] font-medium text-m-ink outline-none placeholder:text-m-faint"
                  />
                  <div className={`${MINI_INPUT_WRAP} min-w-0 flex-1`}>
                    <span className="text-[0.75rem] text-m-faint">{sym(currency)}</span>
                    <NumericInput
                      mode="decimal"
                      placeholder={localizeAmountInput('0.00', currency)}
                      value={localizeAmountInput(item.price, currency)}
                      onValueChange={v => handleUpdateItemPrice(item.id, v)}
                      className="w-full border-0 bg-transparent py-[7px] text-right text-[0.8125rem] font-semibold text-m-ink outline-none"
                    />
                  </div>
                  <button type="button" onClick={() => handleRemoveItem(item.id)} className="flex-none text-m-muted" aria-label={t('common.delete')}>
                    <Trash2 size={15} strokeWidth={2} />
                  </button>
                </div>
                <div className="flex flex-wrap gap-[5px]">
                  {people.map((p, idx) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleToggleItemParticipant(item.id, p.id)}
                      className={`flex items-center gap-[4px] rounded-full px-[8px] py-[3px] text-[0.6875rem] font-medium ${
                        item.participants.has(p.id) ? 'bg-m-act text-m-actfg' : 'border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] text-m-muted'
                      }`}
                    >
                      <Avatar p={p} idx={idx} size={14} dim={!item.participants.has(p.id)} />
                      <span>{nameOf(p)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={handleAddEmptyItem}
              className="flex items-center justify-center gap-[6px] rounded-[12px] border border-dashed border-[color:var(--m-rowbr)] py-[10px] text-[0.78125rem] font-semibold text-m-muted"
            >
              <Plus size={14} strokeWidth={2.2} /> {t('common.add')}
            </button>
            {ticketItems.length > 0 && (
              <div className="rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-3">
                <Eyebrow className="mb-[8px] uppercase">{t('costs.split')}</Eyebrow>
                <div className="flex flex-col gap-1">
                  {people.map(p => (
                    <div key={p.id} className="flex justify-between text-[0.8125rem]">
                      <span className="text-m-muted">{nameOf(p)}</span>
                      <span className="font-semibold text-m-ink [font-variant-numeric:tabular-nums]">{sym(currency)}{(ticketInfo.shares[p.id] || 0).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="mt-2 flex flex-col gap-[6px]">
              {people.map((p, idx) => {
                const on = participants.has(p.id)
                return (
                  <div key={p.id} className={`${ROW_CLS} ${on ? '' : 'opacity-60'}`}>
                    <button
                      type="button"
                      onClick={() => toggleParticipant(p.id)}
                      className="flex min-w-0 flex-1 items-center gap-[8px] text-left"
                    >
                      <Avatar p={p} idx={idx} dim={!on} />
                      <span className="truncate text-[0.8125rem] font-medium text-m-ink">{nameOf(p)}</span>
                      {p.is_guest && <GuestBadge size="xs" />}
                    </button>
                    {splitMode === 'equally' ? (
                      on ? (
                        <span className="flex-none pr-1 text-[0.8125rem] font-semibold text-m-ink [font-variant-numeric:tabular-nums]">
                          {sym(currency)}{(equalShares[p.id] || 0).toFixed(2)}
                        </span>
                      ) : (
                        <span className="flex-none pr-1 text-[0.6875rem] text-m-faint">{t('costs.tapToInclude')}</span>
                      )
                    ) : on ? (
                      <div className={`${MINI_INPUT_WRAP} w-[120px] flex-none`}>
                        <span className="text-[0.75rem] text-m-faint">{sym(currency)}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder={localizeAmountInput((placeholderShares[p.id] || 0).toFixed(2), currency)}
                          value={localizeAmountInput(customAmounts[p.id] || '', currency)}
                          onChange={e => handleCustomAmountChange(p.id, e.target.value)}
                          className="w-full border-0 bg-transparent py-[7px] text-right text-[0.8125rem] font-semibold text-m-ink outline-none placeholder:text-m-faint"
                        />
                      </div>
                    ) : (
                      <button type="button" onClick={() => toggleParticipant(p.id)} className="flex-none text-[0.6875rem] text-m-faint">
                        {t('costs.tapToInclude')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="mt-2 text-[0.71875rem]">
              {splitMode === 'equally' ? (
                <span className="text-m-faint">
                  {participants.size > 0 && t('costs.splitSummary', { count: participants.size, amount: sym(currency) + each.toFixed(2) })}
                </span>
              ) : (
                <span className={`font-semibold ${customBalanced ? 'text-[color:var(--m-st-confirmed)]' : 'text-[color:var(--m-st-danger)]'}`}>
                  {customBalanced
                    ? t('costs.splitSummary', { count: participants.size, amount: sym(currency) + each.toFixed(2) })
                    : `${sym(currency)}${splitSum.toFixed(2)} / ${sym(currency)}${totalNum.toFixed(2)}`}
                </span>
              )}
            </div>
          </>
        )}

        {/* NOTE — last, because it is the one field that is never required. The
            room for it came from folding the category pills into a dropdown. */}
        <Eyebrow className="mb-[6px] mt-3 uppercase">{t('costs.note')}</Eyebrow>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          maxLength={NOTE_MAX}
          placeholder={t('costs.notePlaceholder')}
          className={FIELD_AREA_CLS}
        />

        {/* RECEIPTS */}
        <div className="mb-[6px] mt-4 flex items-center justify-between">
          <Eyebrow className="uppercase">{t('costs.receiptsTitle') || t('costs.receipts')}</Eyebrow>
          <label className="flex cursor-pointer items-center gap-1 text-[0.75rem] font-semibold text-m-ink">
            <input
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              onChange={e => {
                handleReceiptFileSelect(e.target.files)
                e.target.value = ''
              }}
            />
            <span className="flex items-center gap-1 rounded-full border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-2.5 py-1 text-m-muted">
              <Plus size={12} /> {t('costs.attachReceipt')}
            </span>
          </label>
        </div>

        {uploadingReceipt && (
          <div className="mb-2 text-[0.75rem] text-m-faint">
            {t('common.saving')}...
          </div>
        )}

        {receipts.length === 0 && pendingReceiptFiles.length === 0 ? (
          <div className="py-1 text-[0.75rem] text-m-faint">
            {t('costs.noReceipts')}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 pb-2">
            {receipts.map((r, rIdx) => (
              <div key={r.id} className={ROW_CLS}>
                <button
                  type="button"
                  onClick={() => setPreviewReceipts({ receipts, initialIndex: rIdx })}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Receipt size={14} className="flex-none text-m-faint" />
                  <span className="truncate text-[0.8125rem] font-medium text-m-ink">{r.original_name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveReceipt(r.id)}
                  title={t('costs.deleteReceipt')}
                  className="flex-none p-1 text-m-muted hover:text-red-500"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {pendingReceiptFiles.map((file, idx) => (
              <div key={idx} className={ROW_CLS}>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Paperclip size={14} className="flex-none text-m-faint" />
                  <span className="truncate text-[0.8125rem] font-medium text-m-ink">{file.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemovePendingReceipt(idx)}
                  title={t('costs.deleteReceipt')}
                  className="flex-none p-1 text-m-muted hover:text-red-500"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <FormSheetFooter
        onDelete={editing ? handleDelete : undefined}
        deleteLabel={t('common.delete')}
        deleteArmed={deleteArmed}
        onCancel={requestClose}
        cancelLabel={t('common.cancel')}
        onSubmit={save}
        submitLabel={submitLabel}
        submitDisabled={!valid || saving}
      />

      {previewReceipts && (
        <ReceiptPreviewModal
          receipts={previewReceipts.receipts}
          initialIndex={previewReceipts.initialIndex}
          onClose={() => setPreviewReceipts(null)}
        />
      )}
    </MSheet>
  )
}
