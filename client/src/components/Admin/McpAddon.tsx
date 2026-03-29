import { useEffect, useState } from 'react'
import { adminApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { Bot, Trash2 } from 'lucide-react'

interface ServiceToken {
  id: number
  name: string
  token_prefix: string
  last_used: string | null
  expires_at: string | null
  created_at: string
  created_by_username: string
}

export default function McpAddon() {
  const toast = useToast()
  const [tokens, setTokens] = useState<ServiceToken[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadTokens() }, [])

  const loadTokens = async () => {
    setLoading(true)
    try {
      const data = await adminApi.listAllServiceTokens()
      setTokens(data.tokens)
    } catch {
      toast.error('Failed to load service tokens')
    } finally {
      setLoading(false)
    }
  }

  const handleRevoke = async (id: number) => {
    if (!confirm('Revoke this token? Any clients using it will lose access immediately.')) return
    try {
      await adminApi.revokeServiceToken(id)
      setTokens(prev => prev.filter(t => t.id !== id))
      toast.success('Token revoked')
    } catch {
      toast.error('Failed to revoke token')
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <Bot size={20} className="text-slate-600" />
        <div>
          <h2 className="font-semibold text-slate-900">MCP Server</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Model Context Protocol — lets AI assistants (Claude, Cursor, etc.) access your TREK data. Connect at <code className="bg-slate-100 px-1 rounded">/mcp</code>
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Token audit list */}
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-1">All Service Tokens</h3>
          <p className="text-xs text-slate-400 mb-3">Users create their own tokens in <strong>Settings → AI / MCP</strong>. You can revoke any token here.</p>
          {loading ? (
            <div className="py-4 flex justify-center">
              <div className="w-6 h-6 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin" />
            </div>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">No service tokens yet.</p>
          ) : (
            <div className="space-y-2">
              {tokens.map(t => (
                <div key={t.id} className="flex items-center justify-between p-3 rounded-lg border border-slate-100 bg-slate-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{t.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      <span className="font-semibold text-slate-600">{t.created_by_username}</span>
                      <span className="mx-2">·</span>
                      Prefix: <code className="font-mono">{t.token_prefix}…</code>
                      {t.last_used && <span className="ml-3">Last used: {new Date(t.last_used).toLocaleDateString()}</span>}
                      {t.expires_at && <span className="ml-3">Expires: {new Date(t.expires_at).toLocaleDateString()}</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRevoke(t.id)}
                    className="ml-3 p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Revoke token"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Connection instructions */}
        <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">How to connect</h3>
          <ol className="text-xs text-slate-600 space-y-1 list-decimal list-inside">
            <li>Enable the MCP addon in the Addons tab above</li>
            <li>Users go to <strong>Settings → AI / MCP</strong> to create their own service token</li>
            <li>In the MCP client, set the SSE URL to <code className="bg-white border border-slate-200 px-1 rounded font-mono">https://trek.yourdomain.com/api/mcp</code></li>
            <li>Set the Authorization header to <code className="bg-white border border-slate-200 px-1 rounded font-mono">Bearer {'<token>'}</code></li>
          </ol>
        </div>
      </div>
    </div>
  )
}



