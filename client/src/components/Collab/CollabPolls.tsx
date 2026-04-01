import React, { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, X, Check, BarChart3, Lock, Clock } from 'lucide-react'
import { collabApi } from '../../api/client'
import { addListener, removeListener } from '../../api/websocket'
import { useTranslation } from '../../i18n'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import ReactDOM from 'react-dom'
import type { User } from '../../types'

interface PollVoter {
  user_id: number
  username: string
  avatar_url: string | null
}

interface PollOption {
  id: number
  text: string
  voters: PollVoter[]
}

interface Poll {
  id: number
  question: string
  options: PollOption[]
  multi_choice: boolean
  is_closed: boolean
  deadline: string | null
  created_by: number
  created_at: string
}

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"

function timeRemaining(deadline) {
  if (!deadline) return null
  const diff = new Date(deadline).getTime() - Date.now()
  if (diff <= 0) return null
  const mins = Math.floor(diff / 60000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  if (days > 0) return `${days}d ${hrs % 24}h`
  if (hrs > 0) return `${hrs}h ${mins % 60}m`
  return `${mins}m`
}

function isExpired(deadline) {
  if (!deadline) return false
  return new Date(deadline).getTime() <= Date.now()
}

function totalVotes(poll) {
  return (poll.options || []).reduce((s, o) => s + (o.voters?.length || 0), 0)
}

// ── Create Poll Modal ────────────────────────────────────────────────────────
interface CreatePollModalProps {
  onClose: () => void
  onCreate: (data: { question: string; options: string[]; multi_choice: boolean }) => Promise<void>
  t: (key: string) => string
}

function CreatePollModal({ onClose, onCreate, t }: CreatePollModalProps) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multiChoice, setMultiChoice] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const addOption = () => setOptions(prev => [...prev, ''])
  const removeOption = (i) => setOptions(prev => prev.filter((_, j) => j !== i))
  const updateOption = (i, v) => setOptions(prev => prev.map((o, j) => j === i ? v : o))

  const canSubmit = question.trim() && options.filter(o => o.trim()).length >= 2 && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await onCreate({ question: question.trim(), options: options.filter(o => o.trim()), multiple_choice: multiChoice })
      onClose()
    } catch {} finally { setSubmitting(false) }
  }

  return ReactDOM.createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg, rgba(0,0,0,0.35))', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16, fontFamily: FONT }} onClick={onClose}>
      <form style={{ background: 'var(--bg-card)', borderRadius: 16, width: '100%', maxWidth: 400, maxHeight: '90vh', overflow: 'auto', border: '1px solid var(--border-faint)' }} onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 12px', borderBottom: '1px solid var(--border-faint)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{t('collab.polls.new')}</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 2, display: 'flex' }}><X size={16} /></button>
        </div>
        <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Question */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('collab.polls.question')}</div>
            <input autoFocus value={question} onChange={e => setQuestion(e.target.value)} placeholder={t('collab.polls.questionPlaceholder') || 'Ask a question...'} style={{ width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10, padding: '8px 12px', fontSize: 13, background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
          </div>

          {/* Options */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('collab.polls.options')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {options.map((opt, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input value={opt} onChange={e => updateOption(i, e.target.value)} placeholder={`${t('collab.polls.option')} ${i + 1}`}
                    style={{ flex: 1, border: '1px solid var(--border-primary)', borderRadius: 10, padding: '8px 12px', fontSize: 13, background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none' }} />
                  {options.length > 2 && (
                    <button type="button" onClick={() => removeOption(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 2 }}><X size={14} /></button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addOption} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 10, border: '1px dashed var(--border-faint)', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 12, fontFamily: FONT }}>
                <Plus size={12} /> {t('collab.polls.addOption')}
              </button>
            </div>
          </div>

          {/* Multi choice toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <div onClick={() => setMultiChoice(!multiChoice)} style={{
              width: 36, height: 20, borderRadius: 10, padding: 2, cursor: 'pointer',
              background: multiChoice ? '#007AFF' : 'var(--border-primary)', transition: 'background 0.2s',
              display: 'flex', alignItems: 'center',
            }}>
              <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'transform 0.2s', transform: multiChoice ? 'translateX(16px)' : 'translateX(0)' }} />
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: FONT }}>{t('collab.polls.multiChoice')}</span>
          </label>

          {/* Submit */}
          <button type="submit" disabled={!canSubmit} style={{
            width: '100%', borderRadius: 99, padding: '9px 14px', background: canSubmit ? 'var(--accent)' : 'var(--border-primary)',
            color: canSubmit ? 'var(--accent-text)' : 'var(--text-faint)', fontSize: 13, fontWeight: 600, border: 'none', cursor: canSubmit ? 'pointer' : 'default', fontFamily: FONT,
          }}>
            {submitting ? '...' : t('collab.polls.create')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Voter Chip with custom tooltip ────────────────────────────────────────────
interface VoterChipProps {
  voter: PollVoter
  offset: boolean
}

function VoterChip({ voter, offset }: VoterChipProps) {
  const [hover, setHover] = useState(false)
  const ref = React.useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  return (
    <>
      <div ref={ref}
        onMouseEnter={() => {
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect()
            setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 })
          }
          setHover(true)
        }}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-tertiary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 7, fontWeight: 700, color: 'var(--text-muted)', overflow: 'hidden',
          border: '1.5px solid var(--bg-card)', marginLeft: offset ? -5 : 0, flexShrink: 0,
        }}>
        {voter.avatar_url ? <img src={voter.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (voter.username || '?')[0].toUpperCase()}
      </div>
      {hover && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)',
          pointerEvents: 'none', zIndex: 10000, whiteSpace: 'nowrap',
          background: 'var(--bg-card)', color: 'var(--text-primary)',
          fontSize: 11, fontWeight: 500, padding: '5px 10px', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid var(--border-faint)',
        }}>
          {voter.username}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Poll Card ────────────────────────────────────────────────────────────────
interface PollCardProps {
  poll: Poll
  currentUser: User
  canEdit: boolean
  onVote: (pollId: number, optionId: number) => Promise<void>
  onClose: (pollId: number) => Promise<void>
  onDelete: (pollId: number) => Promise<void>
  t: (key: string) => string
}

function PollCard({ poll, currentUser, canEdit, onVote, onClose, onDelete, t }: PollCardProps) {
  const total = totalVotes(poll)
  const isClosed = poll.is_closed || isExpired(poll.deadline)
  const remaining = timeRemaining(poll.deadline)
  const hasVoted = (poll.options || []).some(o => (o.voters || []).some(v => String(v.user_id) === String(currentUser.id)))

  return (
    <div style={{
      borderRadius: 14, border: '1px solid var(--border-faint)', overflow: 'hidden',
      background: 'var(--bg-card)', fontFamily: FONT,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 8,
        background: isClosed ? 'var(--bg-secondary)' : 'transparent',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.35, wordBreak: 'break-word' }}>
            {poll.question}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {isClosed && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', background: 'var(--bg-tertiary)', padding: '2px 7px', borderRadius: 99 }}>
                <Lock size={8} /> {t('collab.polls.closed')}
              </span>
            )}
            {remaining && !isClosed && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 600, color: '#f59e0b', background: '#f59e0b18', padding: '2px 7px', borderRadius: 99 }}>
                <Clock size={8} /> {remaining}
              </span>
            )}
            {poll.multiple_choice && (
              <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', background: 'var(--bg-tertiary)', padding: '2px 7px', borderRadius: 99 }}>
                {t('collab.polls.multiChoice')}
              </span>
            )}
            <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>
              {total} {total === 1 ? 'vote' : 'votes'}
            </span>
          </div>
        </div>
        {/* Actions */}
        {canEdit && (
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            {!isClosed && (
              <button onClick={() => onClose(poll.id)} title={t('collab.polls.close')}
                style={{ padding: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', borderRadius: 6 }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                <Lock size={12} />
              </button>
            )}
            <button onClick={() => onDelete(poll.id)} title={t('collab.polls.delete')}
              style={{ padding: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', borderRadius: 6 }}
              onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Options */}
      <div style={{ padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(poll.options || []).map((opt, idx) => {
          const count = opt.voters?.length || 0
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const myVote = (opt.voters || []).some(v => String(v.user_id) === String(currentUser.id))
          const isWinner = isClosed && count === Math.max(...(poll.options || []).map(o => o.voters?.length || 0)) && count > 0

          return (
            <button key={idx} onClick={() => !isClosed && onVote(poll.id, idx)}
              disabled={isClosed}
              style={{
                position: 'relative', display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 12px', borderRadius: 10, border: 'none', cursor: isClosed ? 'default' : 'pointer',
                background: 'var(--bg-secondary)', fontFamily: FONT, textAlign: 'left', width: '100%',
                overflow: 'hidden', transition: 'transform 0.1s',
              }}
              onMouseEnter={e => { if (!isClosed) e.currentTarget.style.transform = 'scale(1.01)' }}
              onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
            >
              {/* Progress bar background */}
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${pct}%`, borderRadius: 10,
                background: myVote ? '#007AFF20' : isWinner ? '#10b98118' : 'var(--bg-tertiary)',
                transition: 'width 0.4s ease',
              }} />

              {/* Check circle */}
              <div style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0, position: 'relative',
                border: myVote ? '2px solid #007AFF' : '2px solid var(--border-primary)',
                background: myVote ? '#007AFF' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.2s',
              }}>
                {myVote && <Check size={11} color="#fff" strokeWidth={3} />}
              </div>

              {/* Label */}
              <span style={{
                flex: 1, fontSize: 13, fontWeight: myVote || isWinner ? 600 : 400,
                color: 'var(--text-primary)', position: 'relative', zIndex: 1,
              }}>
                {typeof opt === 'string' ? opt : opt.label || opt}
              </span>

              {/* Voter avatars */}
              {(opt.voters || []).length > 0 && (hasVoted || isClosed) && (
                <div style={{ display: 'flex', position: 'relative', zIndex: 1 }}>
                  {(opt.voters || []).slice(0, 3).map((v, vi) => (
                    <VoterChip key={v.user_id || vi} voter={v} offset={vi > 0} />
                  ))}
                </div>
              )}

              {/* Percentage */}
              {(hasVoted || isClosed) && (
                <span style={{
                  fontSize: 12, fontWeight: 700, color: myVote ? '#007AFF' : 'var(--text-muted)',
                  position: 'relative', zIndex: 1, minWidth: 32, textAlign: 'right',
                }}>
                  {pct}%
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────
interface CollabPollsProps {
  tripId: number
  currentUser: User
}

export default function CollabPolls({ tripId, currentUser }: CollabPollsProps) {
  const { t } = useTranslation()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const canEdit = can('collab_edit', trip)
  const [polls, setPolls] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    collabApi.getPolls(tripId).then(data => {
      setPolls(Array.isArray(data) ? data : data.polls || [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [tripId])

  // WebSocket
  useEffect(() => {
    const handler = (msg) => {
      if (!msg?.type) return
      if (msg.type === 'collab:poll:created' && msg.poll) {
        setPolls(prev => prev.some(p => p.id === msg.poll.id) ? prev : [msg.poll, ...prev])
      }
      if (msg.type === 'collab:poll:voted' && msg.poll) {
        setPolls(prev => prev.map(p => p.id === msg.poll.id ? msg.poll : p))
      }
      if (msg.type === 'collab:poll:closed' && msg.poll) {
        setPolls(prev => prev.map(p => p.id === msg.poll.id ? { ...p, ...msg.poll, is_closed: true } : p))
      }
      if (msg.type === 'collab:poll:deleted') {
        const id = msg.pollId || msg.poll?.id
        if (id) setPolls(prev => prev.filter(p => p.id !== id))
      }
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [])

  const handleCreate = useCallback(async (data) => {
    const result = await collabApi.createPoll(tripId, data)
    const created = result.poll || result
    setPolls(prev => prev.some(p => p.id === created.id) ? prev : [created, ...prev])
    setShowForm(false)
  }, [tripId])

  const handleVote = useCallback(async (pollId, optionIndex) => {
    try {
      const result = await collabApi.votePoll(tripId, pollId, optionIndex)
      const updated = result.poll || result
      setPolls(prev => prev.map(p => p.id === updated.id ? updated : p))
    } catch {}
  }, [tripId])

  const handleClose = useCallback(async (pollId) => {
    try {
      await collabApi.closePoll(tripId, pollId)
      setPolls(prev => prev.map(p => p.id === pollId ? { ...p, is_closed: true } : p))
    } catch {}
  }, [tripId])

  const handleDelete = useCallback(async (pollId) => {
    try {
      await collabApi.deletePoll(tripId, pollId)
      setPolls(prev => prev.filter(p => p.id !== pollId))
    } catch {}
  }, [tripId])

  const activePolls = polls.filter(p => !p.is_closed && !isExpired(p.deadline))
  const closedPolls = polls.filter(p => p.is_closed || isExpired(p.deadline))

  // Deadline ticker
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!polls.some(p => p.deadline && !p.is_closed)) return
    const iv = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(iv)
  }, [polls])

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
        <div style={{ width: 20, height: 20, border: '2px solid var(--border-primary)', borderTopColor: 'var(--text-primary)', borderRadius: '50%', animation: 'collab-poll-spin 0.7s linear infinite' }} />
        <style>{`@keyframes collab-poll-spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: FONT }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', flexShrink: 0 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 7, letterSpacing: 0.3, textTransform: 'uppercase' }}>
          <BarChart3 size={14} color="var(--text-faint)" />
          {t('collab.polls.title')}
        </h3>
        {canEdit && (
          <button onClick={() => setShowForm(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 99, padding: '6px 12px',
            background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600,
            fontFamily: FONT, border: 'none', cursor: 'pointer',
          }}>
            <Plus size={12} /> {t('collab.polls.new')}
          </button>
        )}
      </div>

      {/* Content */}
      <div className="chat-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
        {polls.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', textAlign: 'center', height: '100%' }}>
            <BarChart3 size={36} color="var(--text-faint)" strokeWidth={1.3} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('collab.polls.empty')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('collab.polls.emptyHint')}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {activePolls.length > 0 && activePolls.map(poll => (
              <PollCard key={poll.id} poll={poll} currentUser={currentUser} canEdit={canEdit} onVote={handleVote} onClose={handleClose} onDelete={handleDelete} t={t} />
            ))}
            {closedPolls.length > 0 && (
              <>
                {activePolls.length > 0 && (
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.3, padding: '8px 0 2px' }}>
                    {t('collab.polls.closedSection') || 'Closed'}
                  </div>
                )}
                {closedPolls.map(poll => (
                  <PollCard key={poll.id} poll={poll} currentUser={currentUser} canEdit={canEdit} onVote={handleVote} onClose={handleClose} onDelete={handleDelete} t={t} />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showForm && <CreatePollModal onClose={() => setShowForm(false)} onCreate={handleCreate} t={t} />}
    </div>
  )
}
