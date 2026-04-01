import { useState, useEffect, useCallback } from 'react'
import { ArrowRightLeft, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import CustomSelect from '../shared/CustomSelect'

const CURRENCIES = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BHD',
  'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLF', 'CLP',
  'CNH', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP', 'FOK', 'GBP', 'GEL', 'GGP', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK',
  'HTG', 'HUF', 'IDR', 'ILS', 'IMP', 'INR', 'IQD', 'ISK', 'JEP', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR',
  'KID', 'KMF', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA',
  'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK',
  'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SYP', 'SZL', 'THB',
  'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TVD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VES',
  'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XDR', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWL'
]

const CURRENCY_OPTIONS = CURRENCIES.map(c => ({ value: c, label: c }))

export default function CurrencyWidget() {
  const { t, locale } = useTranslation()
  const [from, setFrom] = useState(() => localStorage.getItem('currency_from') || 'EUR')
  const [to, setTo] = useState(() => localStorage.getItem('currency_to') || 'USD')
  const [amount, setAmount] = useState('100')
  const [rate, setRate] = useState(null)
  const [loading, setLoading] = useState(false)

  const fetchRate = useCallback(async () => {
    if (from === to) { setRate(1); return }
    setLoading(true)
    try {
      const resp = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`)
      const data = await resp.json()
      setRate(data.rates?.[to] || null)
    } catch { setRate(null) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { fetchRate() }, [fetchRate])
  useEffect(() => { localStorage.setItem('currency_from', from) }, [from])
  useEffect(() => { localStorage.setItem('currency_to', to) }, [to])

  const swap = () => { setFrom(to); setTo(from) }
  const rawResult = rate && amount ? (parseFloat(amount) * rate).toFixed(2) : null
  const formatNumber = (num) => {
    if (!num || num === '—') return '—'
    return parseFloat(num).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  const result = rawResult

  return (
    <div className="rounded-2xl border p-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>{t('dashboard.currency')}</span>
        <button onClick={fetchRate} className="p-1 rounded-md transition-colors" style={{ color: 'var(--text-faint)' }}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Amount */}
      <div className="rounded-xl px-4 py-3 mb-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="w-full text-2xl font-black tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          style={{ color: 'var(--text-primary)', background: 'transparent', border: 'none' }}
        />
      </div>

      {/* From / Swap / To */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1" style={{ '--bg-input': 'transparent', '--border-primary': 'transparent' }}>
          <CustomSelect value={from} onChange={setFrom} options={CURRENCY_OPTIONS} searchable size="sm" />
        </div>
        <button onClick={swap} className="p-1.5 rounded-lg shrink-0 transition-colors" style={{ color: 'var(--text-muted)' }}>
          <ArrowRightLeft size={13} />
        </button>
        <div className="flex-1" style={{ '--bg-input': 'transparent', '--border-primary': 'transparent' }}>
          <CustomSelect value={to} onChange={setTo} options={CURRENCY_OPTIONS} searchable size="sm" />
        </div>
      </div>

      {/* Result */}
      <div className="rounded-xl p-3" style={{ background: 'var(--bg-secondary)' }}>
        <p className="text-xl font-black tabular-nums" style={{ color: 'var(--text-primary)' }}>
          {formatNumber(result)} <span className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>{to}</span>
        </p>
        {rate && <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-faint)' }}>1 {from} = {rate.toFixed(4)} {to}</p>}
      </div>
    </div>
  )
}
