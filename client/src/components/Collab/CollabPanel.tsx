import { useState, useEffect } from 'react'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { MessageCircle, StickyNote, BarChart3, Sparkles } from 'lucide-react'
import CollabChat from './CollabChat'
import ConvexCollabChat from './ConvexCollabChat'
import CollabNotes from './CollabNotes'
import CollabPolls from './CollabPolls'
import WhatsNextWidget from './WhatsNextWidget'

function useIsDesktop(breakpoint = 1024) {
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= breakpoint)
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= breakpoint)
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [breakpoint])
  return isDesktop
}

const card = {
  display: 'flex', flexDirection: 'column' as const,
  background: 'var(--bg-card)', borderRadius: 16, border: '1px solid var(--border-faint)',
  overflow: 'hidden', minHeight: 0,
}

interface TripMember {
  id: number
  username: string
  avatar_url?: string | null
}

interface CollabPanelProps {
  tripId: number | string
  tripMembers?: TripMember[]
  useConvex?: boolean
}

export default function CollabPanel({ tripId, tripMembers = [], useConvex = false }: CollabPanelProps) {
  const { user } = useAuthStore()
  const { t } = useTranslation()
  const [mobileTab, setMobileTab] = useState('chat')
  const isDesktop = useIsDesktop()
  const ChatComponent = useConvex ? ConvexCollabChat : CollabChat

  const tabs = [
    { id: 'chat', label: t('collab.tabs.chat') || 'Chat', icon: MessageCircle },
    { id: 'notes', label: t('collab.tabs.notes') || 'Notes', icon: StickyNote },
    { id: 'polls', label: t('collab.tabs.polls') || 'Polls', icon: BarChart3 },
    { id: 'next', label: t('collab.whatsNext.title') || "What's Next", icon: Sparkles },
  ]

  if (isDesktop) {
    return (
      <div style={{ height: '100%', display: 'flex', gap: 12, padding: 12, overflow: 'hidden', minHeight: 0 }}>
        {/* Chat — left, fixed width */}
        <div style={{ ...card, flex: '0 0 380px' }}>
          <ChatComponent tripId={Number(tripId)} currentUser={user} />
        </div>

        {/* Right column: Notes top, Polls + What's Next bottom */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden', minHeight: 0 }}>
          {/* Notes — top */}
          <div style={{ ...card, flex: 1 }}>
            <CollabNotes tripId={Number(tripId)} currentUser={user} />
          </div>

          {/* Polls + What's Next — bottom row */}
          <div style={{ flex: 1, display: 'flex', gap: 12, overflow: 'hidden', minHeight: 0 }}>
            <div style={{ ...card, flex: 1 }}>
              <CollabPolls tripId={Number(tripId)} currentUser={user} />
            </div>
            <div style={{ ...card, flex: 1 }}>
              <WhatsNextWidget tripMembers={tripMembers} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Mobile: tab bar + single panel
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'absolute', inset: 0 }}>
      <div style={{
        display: 'flex', gap: 2, padding: '8px 12px', borderBottom: '1px solid var(--border-faint)',
        background: 'var(--bg-card)', flexShrink: 0,
      }}>
        {tabs.map(tab => {
          const Icon = tab.icon
          const active = mobileTab === tab.id
          return (
            <button key={tab.id} onClick={() => setMobileTab(tab.id)} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '8px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--accent-text)' : 'var(--text-muted)',
              fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}>
              {tab.label}
            </button>
          )
        })}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {mobileTab === 'chat' && <ChatComponent tripId={Number(tripId)} currentUser={user} />}
        {mobileTab === 'notes' && <CollabNotes tripId={Number(tripId)} currentUser={user} />}
        {mobileTab === 'polls' && <CollabPolls tripId={Number(tripId)} currentUser={user} />}
        {mobileTab === 'next' && <WhatsNextWidget tripMembers={tripMembers} />}
      </div>
    </div>
  )
}
