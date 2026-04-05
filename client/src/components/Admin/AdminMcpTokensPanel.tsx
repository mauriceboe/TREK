import { useState, useEffect } from 'react'
import { adminApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { Key, Trash2, User, Loader2, BarChart2 } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface AdminMcpToken {
  id: number
  name: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
  user_id: number
  username: string
}

interface HourlyBucket { hour: string; count: number }
interface DailyBucket  { day: string;  count: number }
interface TokenStat    { id: number; name: string; token_prefix: string; username: string; total_30d: number; total_24h: number }

interface UsageData {
  hourly:  HourlyBucket[]
  daily:   DailyBucket[]
  byToken: TokenStat[]
  config: {
    rateLimitMax: number
    rateLimitWindowSec: number
    maxSessionsPerUser: number
    sessionTtlMin: number
  }
}

// Fill in zero-count buckets so the chart always shows a continuous timeline
function fillHourly(data: HourlyBucket[]): HourlyBucket[] {
  const map = new Map(data.map(d => [d.hour, d.count]))
  const result: HourlyBucket[] = []
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.now() - i * 3600_000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:00:00`
    result.push({ hour: key, count: map.get(key) ?? 0 })
  }
  return result
}

function fillDaily(data: DailyBucket[]): DailyBucket[] {
  const map = new Map(data.map(d => [d.day, d.count]))
  const result: DailyBucket[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    result.push({ day: key, count: map.get(key) ?? 0 })
  }
  return result
}

interface BarChartProps {
  buckets: { label: string; count: number }[]
  color?: string
}

function BarChart({ buckets, color = 'var(--accent-primary, #6366f1)' }: BarChartProps) {
  const max = Math.max(...buckets.map(b => b.count), 1)
  return (
    <div className="flex items-end gap-px" style={{ height: 80 }}>
      {buckets.map((b, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end group relative" style={{ height: '100%' }}>
          {b.count > 0 && (
            <div
              className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs px-1.5 py-0.5 rounded pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10"
              style={{ background: 'var(--bg-tooltip, #1e1e2e)', color: 'var(--text-inverse, #fff)' }}
            >
              {b.label}: {b.count}
            </div>
          )}
          <div
            className="w-full rounded-t transition-all"
            style={{
              height: `${(b.count / max) * 100}%`,
              minHeight: b.count > 0 ? 2 : 0,
              background: color,
              opacity: b.count === 0 ? 0.12 : 0.85,
            }}
          />
        </div>
      ))}
    </div>
  )
}

function UsagePanel() {
  const [data, setData] = useState<UsageData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const toast = useToast()
  const { t } = useTranslation()

  useEffect(() => {
    setIsLoading(true)
    adminApi.mcpTokenUsage()
      .then(setData)
      .catch(() => toast.error(t('admin.mcpTokens.usage.loadError')))
      .finally(() => setIsLoading(false))
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-tertiary)' }} />
      </div>
    )
  }

  if (!data) return null

  const hourlyBuckets = fillHourly(data.hourly).map(b => ({
    label: b.hour.slice(11, 16),
    count: b.count,
  }))
  const dailyBuckets = fillDaily(data.daily).map(b => ({
    label: b.day.slice(5),
    count: b.count,
  }))
  const totalRequests24h = data.byToken.reduce((s, t) => s + (t.total_24h ?? 0), 0)
  const totalRequests30d = data.byToken.reduce((s, t) => s + (t.total_30d ?? 0), 0)

  return (
    <div className="space-y-6">
      {/* Active configuration */}
      <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('admin.mcpTokens.usage.config')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            {
              label: t('admin.mcpTokens.usage.rateLimitMax'),
              value: data.config.rateLimitMax,
              unit: t('admin.mcpTokens.usage.rateLimitUnit'),
              hint: t('admin.mcpTokens.usage.envHint'),
            },
            {
              label: t('admin.mcpTokens.usage.maxSessions'),
              value: data.config.maxSessionsPerUser,
              unit: t('admin.mcpTokens.usage.sessionsUnit'),
            },
            {
              label: t('admin.mcpTokens.usage.sessionTtl'),
              value: data.config.sessionTtlMin,
              unit: t('admin.mcpTokens.usage.sessionTtlUnit'),
            },
          ].map(item => (
            <div key={item.label} className="rounded-lg px-3 py-2.5 space-y-0.5" style={{ background: 'var(--bg-secondary)' }}>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{item.label}</p>
              <p className="text-xl font-semibold font-mono" style={{ color: 'var(--text-primary)' }}>{item.value}</p>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{item.unit}</p>
              {item.hint && (
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{item.hint}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: t('admin.mcpTokens.usage.last24h'), value: totalRequests24h },
          { label: t('admin.mcpTokens.usage.last30d'), value: totalRequests30d },
        ].map(card => (
          <div key={card.label} className="rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }}>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{card.label}</p>
            <p className="text-2xl font-semibold mt-0.5" style={{ color: 'var(--text-primary)' }}>{card.value.toLocaleString()}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('admin.mcpTokens.usage.requests')}</p>
          </div>
        ))}
      </div>

      {/* Hourly chart */}
      <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('admin.mcpTokens.usage.hourlyChart')}</p>
        {totalRequests24h === 0
          ? <p className="text-sm text-center py-6" style={{ color: 'var(--text-tertiary)' }}>{t('admin.mcpTokens.usage.noData')}</p>
          : <BarChart buckets={hourlyBuckets} />
        }
      </div>

      {/* Daily chart */}
      <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }}>
        <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('admin.mcpTokens.usage.dailyChart')}</p>
        {totalRequests30d === 0
          ? <p className="text-sm text-center py-6" style={{ color: 'var(--text-tertiary)' }}>{t('admin.mcpTokens.usage.noData')}</p>
          : <BarChart buckets={dailyBuckets} color="var(--accent-secondary, #8b5cf6)" />
        }
      </div>

      {/* Per-token table */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }}>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2.5 text-xs font-medium border-b"
          style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}>
          <span>{t('admin.mcpTokens.usage.byToken')}</span>
          <span>{t('admin.mcpTokens.owner')}</span>
          <span className="text-right">{t('admin.mcpTokens.usage.last24h')}</span>
          <span className="text-right">{t('admin.mcpTokens.usage.last30d')}</span>
        </div>
        {data.byToken.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: 'var(--text-tertiary)' }}>{t('admin.mcpTokens.usage.noData')}</p>
        ) : data.byToken.map((tk, i) => {
          const max30d = Math.max(...data.byToken.map(t => t.total_30d), 1)
          return (
            <div key={tk.id}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 px-4 py-3"
              style={{ borderBottom: i < data.byToken.length - 1 ? '1px solid var(--border-primary)' : undefined }}>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{tk.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                    <div className="h-full rounded-full" style={{ width: `${(tk.total_30d / max30d) * 100}%`, background: 'var(--accent-primary, #6366f1)' }} />
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <User className="w-3 h-3" />
                <span>{tk.username}</span>
              </div>
              <span className="text-sm text-right font-mono" style={{ color: 'var(--text-secondary)' }}>{tk.total_24h}</span>
              <span className="text-sm text-right font-mono" style={{ color: 'var(--text-primary)' }}>{tk.total_30d}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function AdminMcpTokensPanel() {
  const [tokens, setTokens] = useState<AdminMcpToken[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'tokens' | 'usage'>('tokens')
  const toast = useToast()
  const { t, locale } = useTranslation()

  useEffect(() => {
    setIsLoading(true)
    adminApi.mcpTokens()
      .then(d => setTokens(d.tokens || []))
      .catch(() => toast.error(t('admin.mcpTokens.loadError')))
      .finally(() => setIsLoading(false))
  }, [])

  const handleDelete = async (id: number) => {
    try {
      await adminApi.deleteMcpToken(id)
      setTokens(prev => prev.filter(tk => tk.id !== id))
      setDeleteConfirmId(null)
      toast.success(t('admin.mcpTokens.deleteSuccess'))
    } catch {
      toast.error(t('admin.mcpTokens.deleteError'))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin.mcpTokens.title')}</h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('admin.mcpTokens.subtitle')}</p>
        </div>

        {/* Tab switcher */}
        <div className="flex rounded-lg border overflow-hidden flex-shrink-0" style={{ borderColor: 'var(--border-primary)' }}>
          {([['tokens', t('admin.mcpTokens.tokensTab'), Key], ['usage', t('admin.mcpTokens.usageTab'), BarChart2]] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors"
              style={{
                background: activeTab === id ? 'var(--accent-primary, #6366f1)' : 'var(--bg-card)',
                color: activeTab === id ? '#fff' : 'var(--text-secondary)',
              }}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'usage' ? <UsagePanel /> : (
        <>
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }}>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-tertiary)' }} />
              </div>
            ) : tokens.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2">
                <Key className="w-8 h-8" style={{ color: 'var(--text-tertiary)' }} />
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('admin.mcpTokens.empty')}</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-4 py-2.5 text-xs font-medium border-b"
                  style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}>
                  <span>{t('admin.mcpTokens.tokenName')}</span>
                  <span>{t('admin.mcpTokens.owner')}</span>
                  <span className="text-right">{t('admin.mcpTokens.created')}</span>
                  <span className="text-right">{t('admin.mcpTokens.lastUsed')}</span>
                  <span></span>
                </div>
                {tokens.map((token, i) => (
                  <div key={token.id}
                    className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 px-4 py-3"
                    style={{ borderBottom: i < tokens.length - 1 ? '1px solid var(--border-primary)' : undefined }}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{token.name}</p>
                      <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{token.token_prefix}...</p>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <User className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="whitespace-nowrap">{token.username}</span>
                    </div>
                    <span className="text-xs whitespace-nowrap text-right" style={{ color: 'var(--text-tertiary)' }}>
                      {new Date(token.created_at).toLocaleDateString(locale)}
                    </span>
                    <span className="text-xs whitespace-nowrap text-right" style={{ color: 'var(--text-tertiary)' }}>
                      {token.last_used_at ? new Date(token.last_used_at).toLocaleDateString(locale) : t('admin.mcpTokens.never')}
                    </span>
                    <button onClick={() => setDeleteConfirmId(token.id)}
                      className="p-1.5 rounded-lg transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                      style={{ color: 'var(--text-tertiary)' }} title={t('common.delete')}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>

          {deleteConfirmId !== null && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
              onClick={e => { if (e.target === e.currentTarget) setDeleteConfirmId(null) }}>
              <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
                <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin.mcpTokens.deleteTitle')}</h3>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('admin.mcpTokens.deleteMessage')}</p>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setDeleteConfirmId(null)}
                    className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={() => handleDelete(deleteConfirmId)}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700">
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
