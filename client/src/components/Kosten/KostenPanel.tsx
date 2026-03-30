import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Trash2, Receipt, TrendingUp, TrendingDown, CheckCircle2, ArrowRight, FileDown, RefreshCw, Pencil } from 'lucide-react'
import { kostenApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import Modal from '../shared/Modal'
import ConfirmDialog from '../shared/ConfirmDialog'
import type { KostenExpense, KostenShare, KostenSettlement, KostenBalance, KostenDebt } from '../../types'

// ── Constants ─────────────────────────────────────────────────────────────────

const CURRENCIES = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CZK', 'PLN', 'SEK', 'NOK', 'DKK', 'TRY', 'THB', 'AUD', 'CAD']
const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', JPY: '¥', CHF: 'CHF', CZK: 'Kč', PLN: 'zł', SEK: 'kr', NOK: 'kr', DKK: 'kr', TRY: '₺', THB: '฿', AUD: 'A$', CAD: 'C$' }
const CURRENCY_DECIMALS: Record<string, number> = { JPY: 0, THB: 0, CZK: 0, HUF: 0, ISK: 0 }
const PIE_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4']

const CATEGORY_KEYS: Record<string, string> = {
  Unterkunft: 'kosten.cat.accommodation',
  Transport: 'kosten.cat.transport',
  'Essen & Trinken': 'kosten.cat.food',
  Aktivitäten: 'kosten.cat.activities',
  Einkaufen: 'kosten.cat.shopping',
  Sonstiges: 'kosten.cat.other',
}
const CATEGORIES = Object.keys(CATEGORY_KEYS)

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmt(v: number, cur: string, locale: string): string {
  const d = CURRENCY_DECIMALS[cur] ?? 2
  return Number(v).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + (SYMBOLS[cur] || cur)
}

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ── Avatar Chip ────────────────────────────────────────────────────────────────

function AvatarChip({ username, avatarUrl, size = 28 }: React.PropsWithChildren<{ username: string; avatarUrl: string | null; size?: number }>) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%',
        background: avatarUrl ? 'transparent' : 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.35, fontWeight: 600, color: 'var(--accent-text)',
        flexShrink: 0, overflow: 'hidden', border: '2px solid var(--bg-card)',
      }}
      title={username}
    >
      {avatarUrl
        ? <img src={avatarUrl} alt={username} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initials(username)
      }
    </div>
  )
}

// ── Expense Form Modal ────────────────────────────────────────────────────────

interface TripMember { id: number; username: string; avatar_url?: string | null }

interface ExpenseFormData {
  title: string
  amount: string
  currency: string
  exchange_rate: string
  paid_by: number | null
  category: string
  expense_date: string
  note: string
  split_type: 'equal' | 'unequal_amount' | 'unequal_percent'
  participant_ids: number[]
  share_values: Record<number, string>
}

function ExpenseFormModal({
  isOpen, onClose, onSave, expense, tripMembers, tripId, tripCurrency, locale, customCategories, onAddCategory,
}: {
  isOpen: boolean
  onClose: () => void
  onSave: (data: ExpenseFormData) => Promise<void>
  expense: KostenExpense | null
  tripMembers: TripMember[]
  tripId: string
  tripCurrency: string
  locale: string
  customCategories: string[]
  onAddCategory: (cat: string) => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<ExpenseFormData>({
    title: '', amount: '', currency: tripCurrency, exchange_rate: '1',
    paid_by: tripMembers[0]?.id ?? null, category: 'Sonstiges',
    expense_date: '', note: '', split_type: 'equal',
    participant_ids: tripMembers.map(m => m.id), share_values: {},
  })
  const [saving, setSaving] = useState(false)
  const [fetchingRate, setFetchingRate] = useState(false)
  const [showAddCat, setShowAddCat] = useState(false)
  const [newCatInput, setNewCatInput] = useState('')
  const allCategories = [...CATEGORIES, ...customCategories]

  // Reset when expense changes
  useEffect(() => {
    if (!isOpen) return
    if (expense) {
      setForm({
        title: expense.title,
        amount: String(expense.amount),
        currency: expense.currency,
        exchange_rate: String(expense.exchange_rate),
        paid_by: expense.paid_by,
        category: expense.category,
        expense_date: expense.expense_date || '',
        note: expense.note || '',
        split_type: expense.split_type,
        participant_ids: expense.shares.map(s => s.user_id),
        share_values: Object.fromEntries(expense.shares.map(s => [s.user_id, s.share_value != null ? String(s.share_value) : ''])),
      })
    } else {
      setForm({
        title: '', amount: '', currency: tripCurrency, exchange_rate: '1',
        paid_by: tripMembers[0]?.id ?? null, category: 'Sonstiges',
        expense_date: '', note: '', split_type: 'equal',
        participant_ids: tripMembers.map(m => m.id), share_values: {},
      })
    }
  }, [isOpen, expense, tripMembers, tripCurrency])

  const needsExchangeRate = form.currency !== tripCurrency
  const parsedAmount = parseFloat(form.amount.replace(',', '.')) || 0
  const parsedRate = parseFloat(form.exchange_rate.replace(',', '.')) || 1
  const amountInTripCurrency = parsedAmount * parsedRate

  const fetchRate = async () => {
    if (!form.currency || form.currency === tripCurrency) return
    setFetchingRate(true)
    try {
      const data = await kostenApi.getExchangeRate(tripId, form.currency, tripCurrency)
      setForm(f => ({ ...f, exchange_rate: String(data.rate) }))
    } catch { /* ignore */ }
    finally { setFetchingRate(false) }
  }

  // Auto-fetch rate when currency changes
  useEffect(() => {
    if (isOpen && form.currency !== tripCurrency) { fetchRate() }
    if (form.currency === tripCurrency) setForm(f => ({ ...f, exchange_rate: '1' }))
  }, [form.currency, tripCurrency, isOpen])

  const toggleParticipant = (id: number) => {
    setForm(f => {
      const has = f.participant_ids.includes(id)
      const newIds = has ? f.participant_ids.filter(x => x !== id) : [...f.participant_ids, id]
      return { ...f, participant_ids: newIds }
    })
  }

  // Computed equal share display
  const numParticipants = form.participant_ids.length || 1
  const equalShare = amountInTripCurrency / numParticipants

  // Percent sum validation
  const percentSum = useMemo(() => {
    if (form.split_type !== 'unequal_percent') return 0
    return form.participant_ids.reduce((s, id) => s + (parseFloat(form.share_values[id] || '0') || 0), 0)
  }, [form.split_type, form.participant_ids, form.share_values])

  const handleSave = async () => {
    if (!form.title.trim() || !form.amount || !form.paid_by) return
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  const setField = <K extends keyof ExpenseFormData>(k: K, v: ExpenseFormData[K]) => setForm(f => ({ ...f, [k]: v }))

  const inputStyle = {
    width: '100%', padding: '9px 10px', borderRadius: 8,
    border: '1px solid var(--border-primary)',
    background: 'var(--bg-input)', color: 'var(--text-primary)',
    fontSize: 13, fontFamily: 'inherit', outline: 'none',
  }
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 4 }

  const footerButtons = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 16, borderTop: '1px solid var(--border-faint)', marginTop: 4 }}>
      <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
        {t('common.cancel')}
      </button>
      <button onClick={handleSave} disabled={!form.title.trim() || !form.amount || !form.paid_by || saving} style={{
        padding: '7px 16px', borderRadius: 8, border: 'none',
        background: 'var(--accent)', color: 'var(--accent-text)',
        fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
        opacity: (!form.title.trim() || !form.amount || !form.paid_by || saving) ? 0.5 : 1,
      }}>
        {saving ? t('common.saving') : t('common.save')}
      </button>
    </div>
  )

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={expense ? t('kosten.editExpense') : t('kosten.addExpense')} size="lg" footer={footerButtons}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Title */}
        <div>
          <label style={labelStyle}>{t('kosten.expenseTitle')} *</label>
          <input style={inputStyle} value={form.title} onChange={e => setField('title', e.target.value)} placeholder="z.B. Abendessen, Hotel, Flug…" />
        </div>

        {/* Amount + Currency */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
          <div>
            <label style={labelStyle}>{t('kosten.amount')} *</label>
            <input style={inputStyle} type="text" inputMode="decimal" value={form.amount} onChange={e => setField('amount', e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label style={labelStyle}>{t('kosten.currency')}</label>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.currency} onChange={e => setField('currency', e.target.value)}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Exchange rate (shown when currency ≠ trip currency) */}
        {needsExchangeRate && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>
                {t('kosten.exchangeRate')} (1 {form.currency} = ? {tripCurrency})
              </label>
              <button
                onClick={fetchRate}
                disabled={fetchingRate}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <RefreshCw size={11} style={{ animation: fetchingRate ? 'spin 0.8s linear infinite' : 'none' }} />
                {t('kosten.fetchRate')}
              </button>
            </div>
            <input style={inputStyle} type="text" inputMode="decimal" value={form.exchange_rate} onChange={e => setField('exchange_rate', e.target.value)} />
            {parsedAmount > 0 && parsedRate > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {t('kosten.convertedAmount').replace('{amount}', fmtAmt(amountInTripCurrency, tripCurrency, locale)).replace('{currency}', '')}
              </div>
            )}
          </div>
        )}

        {/* Paid by + Category */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label style={labelStyle}>{t('kosten.paidBy')} *</label>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.paid_by ?? ''} onChange={e => setField('paid_by', Number(e.target.value))}>
              {tripMembers.map(m => <option key={m.id} value={m.id}>{m.username}</option>)}
            </select>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>{t('kosten.category')}</label>
              <button
                type="button"
                onClick={() => { setShowAddCat(s => !s); setNewCatInput('') }}
                style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}
              >{t('kosten.addCategory')}</button>
            </div>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.category} onChange={e => setField('category', e.target.value)}>
              {allCategories.map(c => <option key={c} value={c}>{CATEGORY_KEYS[c] ? t(CATEGORY_KEYS[c]) : c}</option>)}
            </select>
            {showAddCat && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input
                  style={{ ...inputStyle, flex: 1, padding: '6px 8px' }}
                  value={newCatInput}
                  onChange={e => setNewCatInput(e.target.value)}
                  placeholder={t('kosten.newCategoryPlaceholder')}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newCatInput.trim()) {
                      onAddCategory(newCatInput.trim())
                      setField('category', newCatInput.trim())
                      setNewCatInput('')
                      setShowAddCat(false)
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (newCatInput.trim()) {
                      onAddCategory(newCatInput.trim())
                      setField('category', newCatInput.trim())
                      setNewCatInput('')
                      setShowAddCat(false)
                    }
                  }}
                  style={{ padding: '6px 12px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}
                >+</button>
              </div>
            )}
          </div>
        </div>

        {/* Date + Note */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label style={labelStyle}>{t('kosten.date')}</label>
            <input style={inputStyle} type="date" value={form.expense_date} onChange={e => setField('expense_date', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>{t('kosten.note')}</label>
            <input style={inputStyle} value={form.note} onChange={e => setField('note', e.target.value)} placeholder="Optional…" />
          </div>
        </div>

        {/* Split type */}
        <div>
          <label style={labelStyle}>{t('kosten.splitType')}</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['equal', 'unequal_amount', 'unequal_percent'] as const).map(st => (
              <button key={st} onClick={() => setField('split_type', st)} style={{
                flex: 1, padding: '6px 8px', borderRadius: 8, border: '1px solid',
                borderColor: form.split_type === st ? 'var(--accent)' : 'var(--border-primary)',
                background: form.split_type === st ? 'var(--accent)' : 'var(--bg-card)',
                color: form.split_type === st ? 'var(--accent-text)' : 'var(--text-muted)',
                fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: form.split_type === st ? 600 : 400,
              }}>
                {st === 'equal' ? t('kosten.splitEqual') : st === 'unequal_amount' ? t('kosten.splitAmount') : t('kosten.splitPercent')}
              </button>
            ))}
          </div>
        </div>

        {/* Participants */}
        <div>
          <label style={labelStyle}>{t('kosten.participants')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tripMembers.map(m => {
              const active = form.participant_ids.includes(m.id)
              const share = form.share_values[m.id] || ''
              const equalShareAmt = active ? equalShare : 0

              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: active ? 'var(--bg-secondary)' : 'transparent', border: '1px solid', borderColor: active ? 'var(--border-primary)' : 'transparent' }}>
                  <button onClick={() => toggleParticipant(m.id)} style={{
                    width: 18, height: 18, borderRadius: 4, border: '2px solid',
                    borderColor: active ? 'var(--accent)' : 'var(--border-primary)',
                    background: active ? 'var(--accent)' : 'transparent',
                    cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {active && <CheckCircle2 size={12} style={{ color: 'var(--accent-text)' }} />}
                  </button>
                  <AvatarChip username={m.username} avatarUrl={m.avatar_url ?? null} size={24} />
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{m.username}</span>

                  {active && form.split_type === 'equal' && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {fmtAmt(equalShareAmt, tripCurrency, locale)}
                    </span>
                  )}
                  {active && form.split_type !== 'equal' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        type="text" inputMode="decimal"
                        value={share}
                        onChange={e => setForm(f => ({ ...f, share_values: { ...f.share_values, [m.id]: e.target.value } }))}
                        placeholder={form.split_type === 'unequal_percent' ? '%' : '0.00'}
                        style={{ width: 80, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit', textAlign: 'right', outline: 'none' }}
                      />
                      {form.split_type === 'unequal_percent' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>%</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {form.split_type === 'unequal_percent' && (
            <div style={{ fontSize: 12, marginTop: 6, color: Math.abs(percentSum - 100) < 0.5 ? '#10b981' : '#ef4444' }}>
              Summe: {percentSum.toFixed(1)}% {Math.abs(percentSum - 100) < 0.5 ? '✓' : '(muss 100% ergeben)'}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ── Settlement Form Modal ─────────────────────────────────────────────────────

interface SettlementFormData {
  from_user_id: number | null
  to_user_id: number | null
  amount: string
  currency: string
  exchange_rate: string
  note: string
}

function SettlementFormModal({
  isOpen, onClose, onSave, tripMembers, tripId, tripCurrency, prefill, locale,
}: {
  isOpen: boolean
  onClose: () => void
  onSave: (data: SettlementFormData) => Promise<void>
  tripMembers: TripMember[]
  tripId: string
  tripCurrency: string
  prefill?: { from_user_id: number; to_user_id: number; amount: number } | null
  locale: string
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<SettlementFormData>({
    from_user_id: tripMembers[0]?.id ?? null,
    to_user_id: tripMembers[1]?.id ?? null,
    amount: '', currency: tripCurrency, exchange_rate: '1', note: '',
  })
  const [saving, setSaving] = useState(false)
  const [fetchingRate, setFetchingRate] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    if (prefill) {
      setForm(f => ({
        ...f,
        from_user_id: prefill.from_user_id,
        to_user_id: prefill.to_user_id,
        amount: String(prefill.amount),
        currency: tripCurrency,
        exchange_rate: '1',
      }))
    } else {
      setForm({ from_user_id: tripMembers[0]?.id ?? null, to_user_id: tripMembers[1]?.id ?? null, amount: '', currency: tripCurrency, exchange_rate: '1', note: '' })
    }
  }, [isOpen, prefill, tripMembers, tripCurrency])

  const needsExchangeRate = form.currency !== tripCurrency

  const fetchRate = async () => {
    if (!form.currency || form.currency === tripCurrency) return
    setFetchingRate(true)
    try {
      const data = await kostenApi.getExchangeRate(tripId, form.currency, tripCurrency)
      setForm(f => ({ ...f, exchange_rate: String(data.rate) }))
    } catch { /* ignore */ }
    finally { setFetchingRate(false) }
  }

  useEffect(() => {
    if (isOpen && form.currency !== tripCurrency) fetchRate()
    if (form.currency === tripCurrency) setForm(f => ({ ...f, exchange_rate: '1' }))
  }, [form.currency, tripCurrency, isOpen])

  const handleSave = async () => {
    if (!form.from_user_id || !form.to_user_id || !form.amount) return
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  const inputStyle = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none' }
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 4 }

  const footerButtons = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 16, borderTop: '1px solid var(--border-faint)', marginTop: 4 }}>
      <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
        {t('common.cancel')}
      </button>
      <button onClick={handleSave} disabled={!form.from_user_id || !form.to_user_id || !form.amount || saving} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, opacity: (!form.from_user_id || !form.to_user_id || !form.amount || saving) ? 0.5 : 1 }}>
        {saving ? t('common.saving') : t('common.save')}
      </button>
    </div>
  )

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('kosten.addSettlement')} size="md" footer={footerButtons}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label style={labelStyle}>{t('kosten.fromUser')}</label>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.from_user_id ?? ''} onChange={e => setForm(f => ({ ...f, from_user_id: Number(e.target.value) }))}>
              {tripMembers.map(m => <option key={m.id} value={m.id}>{m.username}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>{t('kosten.toUser')}</label>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.to_user_id ?? ''} onChange={e => setForm(f => ({ ...f, to_user_id: Number(e.target.value) }))}>
              {tripMembers.map(m => <option key={m.id} value={m.id}>{m.username}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
          <div>
            <label style={labelStyle}>{t('kosten.amount')} *</label>
            <input style={inputStyle} type="text" inputMode="decimal" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
          </div>
          <div>
            <label style={labelStyle}>{t('kosten.currency')}</label>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {needsExchangeRate && (
          <div style={{ background: 'var(--bg-secondary)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>
                {t('kosten.exchangeRate')} (1 {form.currency} = ? {tripCurrency})
              </label>
              <button
                onClick={fetchRate}
                disabled={fetchingRate}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <RefreshCw size={11} style={{ animation: fetchingRate ? 'spin 0.8s linear infinite' : 'none' }} />
                {t('kosten.fetchRate')}
              </button>
            </div>
            <input style={inputStyle} type="text" inputMode="decimal" value={form.exchange_rate} onChange={e => setForm(f => ({ ...f, exchange_rate: e.target.value }))} />
          </div>
        )}

        <div>
          <label style={labelStyle}>{t('kosten.note')}</label>
          <input style={inputStyle} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Optional…" />
        </div>
      </div>
    </Modal>
  )
}

// ── PDF Export ────────────────────────────────────────────────────────────────

function exportPDF(expenses: KostenExpense[], settlements: KostenSettlement[], balances: KostenBalance[], debts: KostenDebt[], tripCurrency: string, locale: string, tripTitle: string, t: (k: string) => string) {
  const total = expenses.reduce((s, e) => s + e.amount * e.exchange_rate, 0)
  const sym = SYMBOLS[tripCurrency] || tripCurrency
  const fmt = (v: number) => fmtAmt(v, tripCurrency, locale)

  const expenseRows = expenses.map(e => {
    const participants = e.shares.map(s => s.username).join(', ')
    const amtTripCur = e.amount * e.exchange_rate
    return `
      <tr>
        <td>${e.expense_date ? new Date(e.expense_date + 'T00:00:00').toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–'}</td>
        <td>${e.title}</td>
        <td>${t(CATEGORY_KEYS[e.category] || '') || e.category}</td>
        <td>${e.paid_by_username}</td>
        <td style="text-align:right;font-weight:600">${e.currency !== tripCurrency ? `${fmtAmt(e.amount, e.currency, locale)} (${fmt(amtTripCur)})` : fmt(amtTripCur)}</td>
        <td style="font-size:11px;color:#6b7280">${participants}</td>
      </tr>`
  }).join('')

  const debtRows = debts.map(d => `
    <tr>
      <td>${d.from_username}</td>
      <td>→</td>
      <td>${d.to_username}</td>
      <td style="text-align:right;font-weight:600">${fmt(d.amount)}</td>
    </tr>`).join('')

  const settlementRows = settlements.map(s => `
    <tr>
      <td>${new Date(s.settled_at).toLocaleDateString(locale)}</td>
      <td>${s.from_username}</td>
      <td>→</td>
      <td>${s.to_username}</td>
      <td style="text-align:right">${s.currency !== tripCurrency ? `${fmtAmt(s.amount, s.currency, locale)} (${fmt(s.amount * s.exchange_rate)})` : fmt(s.amount)}</td>
      <td style="font-size:11px;color:#6b7280">${s.note || ''}</td>
    </tr>`).join('')

  const balanceRows = balances.map(b => `
    <tr>
      <td>${b.username}</td>
      <td style="text-align:right;font-weight:600;color:${b.balance >= 0 ? '#059669' : '#dc2626'}">${b.balance >= 0 ? '+' : ''}${fmt(b.balance)}</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <title>${t('kosten.pdfTitle')} – ${tripTitle}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#111;margin:32px;line-height:1.5}
    h1{font-size:20px;font-weight:700;margin-bottom:4px}
    h2{font-size:14px;font-weight:600;margin:24px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
    p{margin:0 0 16px;color:#6b7280;font-size:11px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    th{text-align:left;padding:6px 8px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;font-weight:600;color:#374151}
    td{padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top}
    .total{font-size:18px;font-weight:700;margin-bottom:4px}
    @media print{body{margin:16px}@page{margin:1.5cm}}
  </style></head><body>
  <h1>${t('kosten.pdfTitle')}: ${tripTitle}</h1>
  <p>${new Date().toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
  <div class="total">${fmt(total)} ${t('kosten.totalSpent').toLowerCase()}</div>

  <h2>${t('kosten.tabExpenses')}</h2>
  <table><thead><tr>
    <th>${t('kosten.date')}</th><th>Titel</th><th>${t('kosten.category')}</th>
    <th>${t('kosten.paidBy')}</th><th style="text-align:right">${t('kosten.amount')}</th>
    <th>${t('kosten.participants')}</th>
  </tr></thead><tbody>${expenseRows}</tbody></table>

  ${debts.length ? `<h2>${t('kosten.simplifiedDebts')}</h2>
  <table><thead><tr><th>${t('kosten.fromUser')}</th><th></th><th>${t('kosten.toUser')}</th><th style="text-align:right">${t('kosten.amount')}</th></tr></thead>
  <tbody>${debtRows}</tbody></table>` : ''}

  ${balances.length ? `<h2>${t('kosten.perPersonTitle')}</h2>
  <table><thead><tr><th>Person</th><th style="text-align:right">Saldo</th></tr></thead>
  <tbody>${balanceRows}</tbody></table>` : ''}

  ${settlements.length ? `<h2>${t('kosten.settlements')}</h2>
  <table><thead><tr><th>Datum</th><th>${t('kosten.fromUser')}</th><th></th><th>${t('kosten.toUser')}</th><th style="text-align:right">${t('kosten.amount')}</th><th>${t('kosten.note')}</th></tr></thead>
  <tbody>${settlementRows}</tbody></table>` : ''}

  </body></html>`

  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(html)
  win.document.close()
  setTimeout(() => { win.focus(); win.print() }, 400)
}

// ── Main Panel ────────────────────────────────────────────────────────────────

interface KostenPanelProps {
  tripId: string
  tripTitle?: string
  tripMembers: TripMember[]
  tripCurrency?: string
}

export default function KostenPanel({ tripId, tripTitle = '', tripMembers, tripCurrency = 'EUR' }: KostenPanelProps) {
  const { t, locale } = useTranslation()
  const [expenses, setExpenses] = useState<KostenExpense[]>([])
  const [settlements, setSettlements] = useState<KostenSettlement[]>([])
  const [balances, setBalances] = useState<KostenBalance[]>([])
  const [debts, setDebts] = useState<KostenDebt[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'expenses' | 'settlement'>('expenses')

  // Modals
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [editingExpense, setEditingExpense] = useState<KostenExpense | null>(null)
  const [deleteExpenseId, setDeleteExpenseId] = useState<number | null>(null)
  const [showSettlementForm, setShowSettlementForm] = useState(false)
  const [settlementPrefill, setSettlementPrefill] = useState<{ from_user_id: number; to_user_id: number; amount: number } | null>(null)
  const [deleteSettlementId, setDeleteSettlementId] = useState<number | null>(null)

  const [customCategories, setCustomCategories] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`kosten-custom-cats-${tripId}`) || '[]') } catch { return [] }
  })
  const handleAddCategory = useCallback((cat: string) => {
    setCustomCategories(prev => {
      const next = [...prev, cat]
      localStorage.setItem(`kosten-custom-cats-${tripId}`, JSON.stringify(next))
      return next
    })
  }, [tripId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [expData, sData, bData] = await Promise.all([
        kostenApi.list(tripId),
        kostenApi.listSettlements(tripId),
        kostenApi.getBalances(tripId),
      ])
      setExpenses(expData.expenses || [])
      setSettlements(sData.settlements || [])
      setBalances(bData.balances || [])
      setDebts(bData.debts || [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [tripId])

  useEffect(() => { load() }, [load])

  // ── Expense CRUD ─────────────────────────────────────────────────────────────

  const handleSaveExpense = async (form: ExpenseFormData) => {
    const parsedRate = parseFloat(form.exchange_rate.replace(',', '.')) || 1
    const baseData = {
      title: form.title,
      amount: parseFloat(form.amount.replace(',', '.')),
      currency: form.currency,
      exchange_rate: parsedRate,
      paid_by: form.paid_by,
      category: form.category,
      expense_date: form.expense_date || null,
      note: form.note || null,
      split_type: form.split_type,
    }

    if (editingExpense) {
      await kostenApi.update(tripId, editingExpense.id, baseData)
      // Update shares separately
      const shares = form.participant_ids.map(uid => ({
        user_id: uid,
        share_value: form.split_type !== 'equal' ? (parseFloat(form.share_values[uid] || '0').toString() !== '' ? parseFloat(form.share_values[uid] || '0') : null) : null,
      }))
      await kostenApi.setShares(tripId, editingExpense.id, shares)
    } else {
      const result = await kostenApi.create(tripId, {
        ...baseData,
        participant_ids: form.participant_ids,
      })
      // If split is unequal, update shares
      if (form.split_type !== 'equal' && result.expense) {
        const shares = form.participant_ids.map((uid: number) => ({
          user_id: uid,
          share_value: parseFloat(form.share_values[uid] || '0') || null,
        }))
        await kostenApi.setShares(tripId, result.expense.id, shares)
      }
    }

    setShowExpenseForm(false)
    setEditingExpense(null)
    await load()
  }

  const handleDeleteExpense = async () => {
    if (!deleteExpenseId) return
    await kostenApi.delete(tripId, deleteExpenseId)
    setDeleteExpenseId(null)
    await load()
  }

  const handleSaveSettlement = async (form: SettlementFormData) => {
    const parsedRate = parseFloat(form.exchange_rate.replace(',', '.')) || 1
    await kostenApi.createSettlement(tripId, {
      from_user_id: form.from_user_id,
      to_user_id: form.to_user_id,
      amount: parseFloat(form.amount.replace(',', '.')),
      currency: form.currency,
      exchange_rate: parsedRate,
      note: form.note || null,
    })
    setShowSettlementForm(false)
    setSettlementPrefill(null)
    await load()
  }

  const handleDeleteSettlement = async () => {
    if (!deleteSettlementId) return
    await kostenApi.deleteSettlement(tripId, deleteSettlementId)
    setDeleteSettlementId(null)
    await load()
  }

  // ── Derived stats ─────────────────────────────────────────────────────────────

  const totalSpent = useMemo(() => expenses.reduce((s, e) => s + e.amount * e.exchange_rate, 0), [expenses])

  const categoryTotals = useMemo(() => {
    const map: Record<string, number> = {}
    for (const e of expenses) {
      map[e.category] = (map[e.category] || 0) + e.amount * e.exchange_rate
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1])
  }, [expenses])

  // ── Pie chart (conic-gradient) ─────────────────────────────────────────────

  const pieSegments = useMemo(() => {
    if (totalSpent === 0) return null
    let start = 0
    return categoryTotals.map(([cat, val], i) => {
      const pct = (val / totalSpent) * 100
      const seg = { cat, val, color: PIE_COLORS[i % PIE_COLORS.length], start, end: start + pct }
      start += pct
      return seg
    })
  }, [categoryTotals, totalSpent])

  const pieGradient = pieSegments
    ? pieSegments.map(s => `${s.color} ${s.start.toFixed(1)}% ${s.end.toFixed(1)}%`).join(', ')
    : 'var(--border-primary) 0% 100%'

  // ── Group expenses by date ─────────────────────────────────────────────────

  const groupedExpenses = useMemo(() => {
    const groups: { date: string | null; expenses: KostenExpense[] }[] = []
    const seen: Record<string, number> = {}
    for (const e of expenses) {
      const key = e.expense_date || '__nodaate__'
      if (seen[key] === undefined) {
        seen[key] = groups.length
        groups.push({ date: e.expense_date, expenses: [e] })
      } else {
        groups[seen[key]].expenses.push(e)
      }
    }
    return groups
  }, [expenses])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-muted)', fontSize: 13 }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border-primary)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 0, height: '100%', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
      {/* ── Main content ───────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, padding: '16px 16px 16px 16px', overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Receipt size={18} style={{ color: 'var(--text-primary)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Kosten</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{t('kosten.subtitle')}</p>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              onClick={() => exportPDF(expenses, settlements, balances, debts, tripCurrency, locale, tripTitle, t)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              <FileDown size={13} /> {t('kosten.pdfExport')}
            </button>
            <button
              onClick={() => { setEditingExpense(null); setShowExpenseForm(true) }}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}
            >
              <Plus size={15} /> {t('kosten.addExpense')}
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 16, background: 'var(--bg-secondary)', borderRadius: 10, padding: 3, width: 'fit-content' }}>
          {(['expenses', 'settlement'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: '5px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 13, fontWeight: activeTab === tab ? 600 : 400,
              background: activeTab === tab ? 'var(--bg-card)' : 'transparent',
              color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: activeTab === tab ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}>
              {tab === 'expenses' ? t('kosten.tabExpenses') : t('kosten.tabSettlement')}
            </button>
          ))}
        </div>

        {/* ── Expenses tab ─────────────────────────────────────────────────── */}
        {activeTab === 'expenses' && (
          expenses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <Receipt size={40} style={{ margin: '0 auto 12px', opacity: 0.3, display: 'block' }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('kosten.noExpenses')}</div>
              <div style={{ fontSize: 12 }}>{t('kosten.noExpensesHint')}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {groupedExpenses.map(group => (
                <div key={group.date || '__nodate__'}>
                  {group.date && (
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {new Date(group.date + 'T00:00:00').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long' })}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {group.expenses.map(expense => (
                      <ExpenseCard
                        key={expense.id}
                        expense={expense}
                        tripCurrency={tripCurrency}
                        locale={locale}
                        t={t}
                        onEdit={() => { setEditingExpense(expense); setShowExpenseForm(true) }}
                        onDelete={() => setDeleteExpenseId(expense.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* ── Settlement tab ───────────────────────────────────────────────── */}
        {activeTab === 'settlement' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Balances */}
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: 'var(--text-primary)' }}>{t('kosten.balances')}</h2>
              {balances.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px', background: 'var(--bg-secondary)', borderRadius: 12, color: 'var(--text-muted)' }}>
                  <CheckCircle2 size={28} style={{ margin: '0 auto 8px', display: 'block', color: '#10b981' }} />
                  <div style={{ fontWeight: 600 }}>{t('kosten.allSettled')}</div>
                  <div style={{ fontSize: 12 }}>{t('kosten.allSettledHint')}</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                  {balances.map(b => (
                    <div key={b.user_id} style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border-faint)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <AvatarChip username={b.username} avatarUrl={b.avatar_url} size={28} />
                        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.username}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {b.balance >= 0
                          ? <TrendingUp size={14} style={{ color: '#10b981', flexShrink: 0 }} />
                          : <TrendingDown size={14} style={{ color: '#ef4444', flexShrink: 0 }} />
                        }
                        <span style={{ fontSize: 15, fontWeight: 700, color: b.balance >= 0 ? '#10b981' : '#ef4444' }}>
                          {b.balance >= 0 ? '+' : ''}{fmtAmt(b.balance, tripCurrency, locale)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Simplified debts */}
            {debts.length > 0 && (
              <div>
                <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: 'var(--text-primary)' }}>{t('kosten.simplifiedDebts')}</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {debts.map((d, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
                      <AvatarChip username={d.from_username} avatarUrl={d.from_avatar_url} size={28} />
                      <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{d.from_username}</span>
                      <ArrowRight size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <AvatarChip username={d.to_username} avatarUrl={d.to_avatar_url} size={28} />
                      <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, flex: 1 }}>{d.to_username}</span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginRight: 8 }}>{fmtAmt(d.amount, tripCurrency, locale)}</span>
                      <button
                        onClick={() => { setSettlementPrefill({ from_user_id: d.from_user_id, to_user_id: d.to_user_id, amount: d.amount }); setShowSettlementForm(true) }}
                        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                      >
                        {t('kosten.settleUp')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Settlement history */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>{t('kosten.settlements')}</h2>
                <button
                  onClick={() => { setSettlementPrefill(null); setShowSettlementForm(true) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <Plus size={13} /> {t('kosten.addSettlement')}
                </button>
              </div>
              {settlements.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-faint)', padding: '12px 0' }}>—</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {settlements.map(s => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
                      <AvatarChip username={s.from_username} avatarUrl={s.from_avatar_url} size={24} />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.from_username}</span>
                      <ArrowRight size={12} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                      <AvatarChip username={s.to_username} avatarUrl={s.to_avatar_url} size={24} />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.to_username}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, flex: 1, textAlign: 'right' }}>
                        {s.currency !== tripCurrency ? `${fmtAmt(s.amount, s.currency, locale)} (≈ ${fmtAmt(s.amount * s.exchange_rate, tripCurrency, locale)})` : fmtAmt(s.amount, tripCurrency, locale)}
                      </span>
                      {s.note && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{s.note}</span>}
                      <button onClick={() => setDeleteSettlementId(s.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 4, display: 'flex', alignItems: 'center' }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Right sidebar ─────────────────────────────────────────────────── */}
      <div style={{ width: 220, flexShrink: 0, padding: '16px 16px 16px 0', display: 'flex', flexDirection: 'column', gap: 12 }} className="hidden lg:flex">
        {/* Total */}
        <div style={{ padding: '16px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-faint)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>{t('kosten.totalSpent')}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtAmt(totalSpent, tripCurrency, locale)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{expenses.length} Ausgaben</div>
        </div>

        {/* Pie chart */}
        {pieSegments && pieSegments.length > 0 && (
          <div style={{ padding: '14px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-faint)' }}>
            <div style={{ width: 100, height: 100, borderRadius: '50%', background: `conic-gradient(${pieGradient})`, margin: '0 auto 12px', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: '25%', borderRadius: '50%', background: 'var(--bg-secondary)' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {pieSegments.slice(0, 5).map(s => (
                <div key={s.cat} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(CATEGORY_KEYS[s.cat] || '') || s.cat}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{fmtAmt(s.val, tripCurrency, locale)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per person summary */}
        {balances.length > 0 && (
          <div style={{ padding: '14px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-faint)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 8 }}>{t('kosten.perPersonTitle')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {balances.map(b => (
                <div key={b.user_id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AvatarChip username={b.username} avatarUrl={b.avatar_url} size={22} />
                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.username}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: b.balance >= 0 ? '#10b981' : '#ef4444' }}>
                    {b.balance >= 0 ? '+' : ''}{fmtAmt(b.balance, tripCurrency, locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      <ExpenseFormModal
        isOpen={showExpenseForm}
        onClose={() => { setShowExpenseForm(false); setEditingExpense(null) }}
        onSave={handleSaveExpense}
        expense={editingExpense}
        tripMembers={tripMembers}
        tripId={tripId}
        tripCurrency={tripCurrency}
        locale={locale}
        customCategories={customCategories}
        onAddCategory={handleAddCategory}
      />

      <SettlementFormModal
        isOpen={showSettlementForm}
        onClose={() => { setShowSettlementForm(false); setSettlementPrefill(null) }}
        onSave={handleSaveSettlement}
        tripMembers={tripMembers}
        tripId={tripId}
        tripCurrency={tripCurrency}
        prefill={settlementPrefill}
        locale={locale}
      />

      <ConfirmDialog
        isOpen={!!deleteExpenseId}
        onClose={() => setDeleteExpenseId(null)}
        onConfirm={handleDeleteExpense}
        title={t('common.delete')}
        message={t('kosten.deleteExpenseConfirm')}
      />

      <ConfirmDialog
        isOpen={!!deleteSettlementId}
        onClose={() => setDeleteSettlementId(null)}
        onConfirm={handleDeleteSettlement}
        title={t('common.delete')}
        message={t('kosten.deleteSettlementConfirm')}
      />
    </div>
  )
}

// ── Expense Card ──────────────────────────────────────────────────────────────

function ExpenseCard({ expense, tripCurrency, locale, t, onEdit, onDelete }: React.PropsWithChildren<{
  expense: KostenExpense
  tripCurrency: string
  locale: string
  t: (key: string, params?: Record<string, string | number>) => string
  onEdit: () => void
  onDelete: () => void
}>) {
  const amtInTripCurrency = expense.amount * expense.exchange_rate
  const numParticipants = expense.shares.length || 1

  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border-faint)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      {/* Category dot */}
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: PIE_COLORS[CATEGORIES.indexOf(expense.category) % PIE_COLORS.length] || '#6b7280', marginTop: 5, flexShrink: 0 }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{expense.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {t(CATEGORY_KEYS[expense.category] || '') || expense.category}
              {expense.note && <span> · {expense.note}</span>}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            {expense.currency !== tripCurrency ? (
              <>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtAmt(expense.amount, expense.currency, locale)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>≈ {fmtAmt(amtInTripCurrency, tripCurrency, locale)}</div>
              </>
            ) : (
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtAmt(expense.amount, expense.currency, locale)}</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          {/* Paid by */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <AvatarChip username={expense.paid_by_username} avatarUrl={expense.paid_by_avatar_url} size={20} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{expense.paid_by_username}</span>
          </div>

          {/* Separator */}
          <span style={{ color: 'var(--border-primary)', fontSize: 11 }}>·</span>

          {/* Participants */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {expense.shares.slice(0, 4).map(s => (
              <AvatarChip key={s.user_id} username={s.username} avatarUrl={s.avatar_url} size={20} />
            ))}
            {expense.shares.length > 4 && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 2 }}>+{expense.shares.length - 4}</span>}
          </div>

          {/* Equal share hint */}
          {expense.split_type === 'equal' && numParticipants > 1 && (
            <>
              <span style={{ color: 'var(--border-primary)', fontSize: 11 }}>·</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>÷{numParticipants} = {fmtAmt(amtInTripCurrency / numParticipants, tripCurrency, locale)} {t('kosten.perPerson')}</span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
        <button onClick={onEdit} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: '4px', borderRadius: 6, display: 'flex', alignItems: 'center' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
          <Pencil size={13} />
        </button>
        <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: '4px', borderRadius: 6, display: 'flex', alignItems: 'center' }} onMouseEnter={e => e.currentTarget.style.color = '#ef4444'} onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}
