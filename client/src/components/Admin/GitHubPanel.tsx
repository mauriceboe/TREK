import { useState, useEffect } from 'react'
import { Tag, Calendar, ExternalLink, ChevronDown, ChevronUp, Loader2, Heart, Coffee } from 'lucide-react'
import { getLocaleForLanguage, useTranslation } from '../../i18n'
import apiClient from '../../api/client'

const REPO = 'mauriceboe/NOMAD'
const PER_PAGE = 10

export default function GitHubPanel() {
  const { t, language } = useTranslation()
  const [releases, setReleases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState({})
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchReleases = async (pageNum = 1, append = false) => {
    try {
      const res = await apiClient.get(`/admin/github-releases`, { params: { per_page: PER_PAGE, page: pageNum } })
      const data = Array.isArray(res.data) ? res.data : []
      setReleases(prev => append ? [...prev, ...data] : data)
      setHasMore(data.length === PER_PAGE)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  useEffect(() => {
    setLoading(true)
    fetchReleases(1).finally(() => setLoading(false))
  }, [])

  const handleLoadMore = async () => {
    const next = page + 1
    setLoadingMore(true)
    await fetchReleases(next, true)
    setPage(next)
    setLoadingMore(false)
  }

  const toggleExpand = (id) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const formatDate = (dateStr) => {
    const d = new Date(dateStr)
    return d.toLocaleDateString(getLocaleForLanguage(language), { day: 'numeric', month: 'short', year: 'numeric' })
  }

  // Simple markdown-to-html for release notes (handles headers, bold, lists, links)
  const renderBody = (body) => {
    if (!body) return null
    const lines = body.split('\n')
    const elements = []
    let listItems = []

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={`ul-${elements.length}`} className="space-y-1 my-2">
            {listItems.map((item, i) => (
              <li key={i} className="flex gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                <span className="mt-1.5 w-1 h-1 rounded-full flex-shrink-0" style={{ background: 'var(--text-faint)' }} />
                <span dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />
              </li>
            ))}
          </ul>
        )
        listItems = []
      }
    }

    const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const inlineFormat = (text) => {
      return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code style="font-size:11px;padding:1px 4px;border-radius:4px;background:var(--bg-secondary)">$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
          const safeUrl = url.startsWith('http://') || url.startsWith('https://') ? url : '#'
          return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline">${label}</a>`
        })
    }

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) { flushList(); continue }

      if (trimmed.startsWith('### ')) {
        flushList()
        elements.push(
          <h4 key={elements.length} className="text-xs font-semibold mt-3 mb-1" style={{ color: 'var(--text-primary)' }}>
            {trimmed.slice(4)}
          </h4>
        )
      } else if (trimmed.startsWith('## ')) {
        flushList()
        elements.push(
          <h3 key={elements.length} className="text-sm font-semibold mt-3 mb-1" style={{ color: 'var(--text-primary)' }}>
            {trimmed.slice(3)}
          </h3>
        )
      } else if (/^[-*] /.test(trimmed)) {
        listItems.push(trimmed.slice(2))
      } else {
        flushList()
        elements.push(
          <p key={elements.length} className="text-xs my-1" style={{ color: 'var(--text-muted)' }}
            dangerouslySetInnerHTML={{ __html: inlineFormat(trimmed) }}
          />
        )
      }
    }
    flushList()
    return elements
  }

  return (
    <div className="space-y-3">
      {/* Support cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <a
          href="https://ko-fi.com/mauriceboe"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xl border overflow-hidden flex items-center gap-4 px-5 py-4 transition-all"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)', textDecoration: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#ff5e5b'; e.currentTarget.style.boxShadow = '0 0 0 1px #ff5e5b22' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ff5e5b15', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Coffee size={20} style={{ color: '#ff5e5b' }} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Ko-fi</div>
            <div className="text-xs" style={{ color: 'var(--text-faint)' }}>{t('admin.github.support')}</div>
          </div>
          <ExternalLink size={14} className="ml-auto flex-shrink-0" style={{ color: 'var(--text-faint)' }} />
        </a>
        <a
          href="https://buymeacoffee.com/mauriceboe"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xl border overflow-hidden flex items-center gap-4 px-5 py-4 transition-all"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)', textDecoration: 'none' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#ffdd00'; e.currentTarget.style.boxShadow = '0 0 0 1px #ffdd0022' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ffdd0015', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Heart size={20} style={{ color: '#ffdd00' }} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Buy Me a Coffee</div>
            <div className="text-xs" style={{ color: 'var(--text-faint)' }}>{t('admin.github.support')}</div>
          </div>
          <ExternalLink size={14} className="ml-auto flex-shrink-0" style={{ color: 'var(--text-faint)' }} />
        </a>
      </div>

      {/* Loading / Error / Releases */}
      {loading ? (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        </div>
      ) : error ? (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
          <div className="p-6 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('admin.github.error')}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-faint)' }}>{error}</p>
          </div>
        </div>
      ) : (
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-secondary)' }}>
          <div>
            <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin.github.title')}</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>{t('admin.github.subtitle').replace('{repo}', REPO)}</p>
          </div>
          <a
            href={`https://github.com/${REPO}/releases`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
          >
            <ExternalLink size={12} />
            GitHub
          </a>
        </div>

        {/* Timeline */}
        <div className="px-5 py-4">
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[11px] top-3 bottom-3 w-px" style={{ background: 'var(--border-primary)' }} />

            <div className="space-y-0">
              {releases.map((release, idx) => {
                const isLatest = idx === 0
                const isExpanded = expanded[release.id]

                return (
                  <div key={release.id} className="relative pl-8 pb-5">
                    {/* Timeline dot */}
                    <div
                      className="absolute left-0 top-1 w-[23px] h-[23px] rounded-full flex items-center justify-center border-2"
                      style={{
                        background: isLatest ? 'var(--text-primary)' : 'var(--bg-card)',
                        borderColor: isLatest ? 'var(--text-primary)' : 'var(--border-primary)',
                      }}
                    >
                      <Tag size={10} style={{ color: isLatest ? 'var(--bg-card)' : 'var(--text-faint)' }} />
                    </div>

                    {/* Release content */}
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {release.tag_name}
                        </span>
                        {isLatest && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                            style={{ background: 'rgba(34,197,94,0.12)', color: '#16a34a' }}>
                            {t('admin.github.latest')}
                          </span>
                        )}
                        {release.prerelease && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                            style={{ background: 'rgba(245,158,11,0.12)', color: '#d97706' }}>
                            {t('admin.github.prerelease')}
                          </span>
                        )}
                      </div>

                      {release.name && release.name !== release.tag_name && (
                        <p className="text-xs font-medium mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {release.name}
                        </p>
                      )}

                      <div className="flex items-center gap-3 mt-1">
                        <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                          <Calendar size={10} />
                          {formatDate(release.published_at || release.created_at)}
                        </span>
                        {release.author && (
                          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                            {t('admin.github.by')} {release.author.login}
                          </span>
                        )}
                      </div>

                      {/* Expandable body */}
                      {release.body && (
                        <div className="mt-2">
                          <button
                            onClick={() => toggleExpand(release.id)}
                            className="flex items-center gap-1 text-[11px] font-medium transition-colors"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            {isExpanded ? t('admin.github.hideDetails') : t('admin.github.showDetails')}
                          </button>

                          {isExpanded && (
                            <div className="mt-2 p-3 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                              {renderBody(release.body)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="text-center pt-2">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
              >
                {loadingMore ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} />}
                {loadingMore ? t('admin.github.loading') : t('admin.github.loadMore')}
              </button>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
