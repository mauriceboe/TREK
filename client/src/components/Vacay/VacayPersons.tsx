import ReactDOM from 'react-dom'
import { useState } from 'react'
import { UserPlus, Check, Loader2, Clock, X, Eye, EyeOff } from 'lucide-react'
import { useVacayStore } from '../../store/vacayStore'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { getApiErrorMessage } from '../../types'
import { useToast } from '../shared/Toast'
import CustomSelect from '../shared/CustomSelect'
import apiClient from '../../api/client'

const PRESET_COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444',
  '#3b82f6', '#22c55e', '#06b6d4', '#f43f5e', '#a855f7',
  '#10b981', '#0ea5e9', '#64748b', '#be185d', '#0d9488',
]

export default function VacayPersons() {
  const { t } = useTranslation()
  const toast = useToast()
  const { connectedUsers, pendingIncoming, pendingOutgoing, visibleGranterIds, toggleGranterVisibility, grantAccess, acceptAccess, declineAccess, cancelAccess, revokeAccess, updateColor, myColor } = useVacayStore()
  const { user: currentUser } = useAuthStore()

  const [showInvite, setShowInvite] = useState(false)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [availableUsers, setAvailableUsers] = useState([])
  const [selectedInviteUser, setSelectedInviteUser] = useState(null)
  const [inviting, setInviting] = useState(false)

  const loadAvailable = async () => {
    try {
      const data = await apiClient.get('/addons/vacay/access/available-users').then(r => r.data)
      setAvailableUsers(data.users)
    } catch { /* */ }
  }

  const handleGrant = async () => {
    if (!selectedInviteUser) return
    setInviting(true)
    try {
      await grantAccess(selectedInviteUser)
      toast.success(t('vacay.inviteSent'))
      setShowInvite(false)
      setSelectedInviteUser(null)
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('vacay.inviteError')))
    } finally {
      setInviting(false)
    }
  }

  const hasOthers = connectedUsers.length > 0 || pendingIncoming.length > 0 || pendingOutgoing.length > 0

  return (
    <div className="rounded-xl border p-3" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>{t('vacay.persons')}</span>
        <button
          onClick={() => { setShowInvite(true); loadAvailable() }}
          className="p-0.5 rounded transition-colors"
          style={{ color: 'var(--text-faint)' }}
          title={t('vacay.grantAccess')}
        >
          <UserPlus size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-0.5">
        {/* Myself — always visible, color picker */}
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
          style={{ background: 'var(--bg-secondary)' }}
        >
          <button
            onClick={() => setShowColorPicker(true)}
            className="w-3.5 h-3.5 rounded-full shrink-0 transition-transform hover:scale-125"
            style={{ backgroundColor: myColor, cursor: 'pointer' }}
            title={t('vacay.changeColor')}
          />
          <span className="text-xs font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
            {currentUser?.username}
            <span style={{ color: 'var(--text-faint)' }}> ({t('vacay.you')})</span>
          </span>
        </div>

        {hasOthers && <div className="my-1 border-t" style={{ borderColor: 'var(--border-secondary)' }} />}

        {/* Connected users — bidirectional (toggle visibility + disconnect on hover) */}
        {connectedUsers.map(u => {
          const isVisible = visibleGranterIds.includes(u.id)
          return (
            <div
              key={u.id}
              onClick={() => toggleGranterVisibility(u.id)}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-all group"
              style={{
                background: isVisible ? 'var(--bg-hover)' : 'transparent',
                border: isVisible ? '1px solid var(--border-primary)' : '1px solid transparent',
              }}
            >
              <span
                className="w-3.5 h-3.5 rounded-full shrink-0 transition-opacity"
                style={{ backgroundColor: u.color, opacity: isVisible ? 1 : 0.35 }}
              />
              <span
                className="text-xs font-medium flex-1 truncate transition-opacity"
                style={{ color: 'var(--text-primary)', opacity: isVisible ? 1 : 0.5 }}
              >
                {u.username}
              </span>
              <button
                onClick={e => { e.stopPropagation(); revokeAccess(u.id) }}
                className="opacity-0 group-hover:opacity-100 text-[10px] px-1.5 py-0.5 rounded transition-all"
                style={{ color: 'var(--text-faint)' }}
                title={t('vacay.revoke')}
              >
                <X size={10} />
              </button>
              {isVisible
                ? <Eye size={11} style={{ color: 'var(--text-faint)' }} />
                : <EyeOff size={11} style={{ color: 'var(--text-faint)', opacity: 0.5 }} />
              }
            </div>
          )
        })}

        {/* Pending incoming invites */}
        {pendingIncoming.map(inv => (
          <div
            key={inv.id}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
            style={{ background: 'var(--bg-secondary)' }}
          >
            <Clock size={12} style={{ color: 'var(--text-faint)' }} />
            <span className="text-xs flex-1 truncate" style={{ color: 'var(--text-muted)' }}>
              {inv.granter_username}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => declineAccess(inv.granter_id)}
                className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
                style={{ color: 'var(--text-faint)' }}
                title={t('vacay.decline')}
              >
                <X size={10} />
              </button>
              <button
                onClick={() => acceptAccess(inv.granter_id)}
                className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
                style={{ color: 'var(--text-primary)', fontWeight: 600 }}
                title={t('vacay.accept')}
              >
                <Check size={10} />
              </button>
            </div>
          </div>
        ))}

        {/* Pending outgoing (I invited someone, waiting) */}
        {pendingOutgoing.map(inv => (
          <div
            key={inv.id}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg group"
            style={{ opacity: 0.7 }}
          >
            <Clock size={12} style={{ color: 'var(--text-faint)' }} />
            <span className="text-xs flex-1 truncate" style={{ color: 'var(--text-muted)' }}>
              {inv.viewer_username}
              <span className="ml-1 text-[10px]" style={{ color: 'var(--text-faint)' }}>({t('vacay.pending')})</span>
            </span>
            <button
              onClick={() => cancelAccess(inv.viewer_id)}
              className="opacity-0 group-hover:opacity-100 text-[10px] px-1.5 py-0.5 rounded transition-all"
              style={{ color: 'var(--text-faint)' }}
            >
              {t('common.cancel')}
            </button>
          </div>
        ))}
      </div>

      {/* Grant-access Invite Modal */}
      {showInvite && ReactDOM.createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center px-4"
          style={{ zIndex: 99990, backgroundColor: 'rgba(15,23,42,0.5)', paddingTop: 70 }}
          onClick={() => setShowInvite(false)}
        >
          <div
            className="rounded-2xl shadow-2xl w-full max-w-sm"
            style={{ background: 'var(--bg-card)', animation: 'modalIn 0.2s ease-out' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('vacay.grantAccess')}</h2>
              <button onClick={() => setShowInvite(false)} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-faint)' }}>
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('vacay.grantAccessHint')}</p>
              {availableUsers.length === 0 ? (
                <p className="text-xs text-center py-4" style={{ color: 'var(--text-faint)' }}>{t('vacay.noUsersAvailable')}</p>
              ) : (
                <CustomSelect
                  value={selectedInviteUser}
                  onChange={setSelectedInviteUser}
                  options={availableUsers.map(u => ({ value: u.id, label: `${u.username} (${u.email})` }))}
                  placeholder={t('vacay.selectUser')}
                  searchable
                />
              )}
              <div className="flex gap-3 justify-end pt-2">
                <button
                  onClick={() => setShowInvite(false)}
                  className="px-4 py-2 text-sm rounded-lg"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleGrant}
                  disabled={!selectedInviteUser || inviting}
                  className="px-4 py-2 text-sm rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-40"
                  style={{ background: 'var(--text-primary)', color: 'var(--bg-card)' }}
                >
                  {inviting && <Loader2 size={13} className="animate-spin" />}
                  {t('vacay.sendInvite')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Color Picker Modal */}
      {showColorPicker && ReactDOM.createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center px-4"
          style={{ zIndex: 99990, backgroundColor: 'rgba(15,23,42,0.5)', paddingTop: 70 }}
          onClick={() => setShowColorPicker(false)}
        >
          <div
            className="rounded-2xl shadow-2xl w-full max-w-xs"
            style={{ background: 'var(--bg-card)', animation: 'modalIn 0.2s ease-out' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('vacay.changeColor')}</h2>
              <button onClick={() => setShowColorPicker(false)} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-faint)' }}>
                <X size={16} />
              </button>
            </div>
            <div className="p-5">
              <div className="flex flex-wrap gap-2 justify-center">
                {PRESET_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={async () => { await updateColor(c); setShowColorPicker(false) }}
                    className={`w-8 h-8 rounded-full transition-all ${myColor === c ? 'ring-2 ring-offset-2 scale-110' : 'hover:scale-110'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  )
}
