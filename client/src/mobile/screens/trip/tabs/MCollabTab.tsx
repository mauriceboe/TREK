import type { LucideIcon } from 'lucide-react'
import { BarChart3, Link2, MessageCircle, StickyNote } from 'lucide-react'
import type { MTabScreenProps } from './tabModel'
import { TabScroller } from './tabChrome'
import MCollabChat from './MCollabChat'
import MCollabNotes from './MCollabNotes'
import MCollabPolls from './MCollabPolls'
import CollabLinks from '../../../../components/Collab/CollabLinks'

/**
 * Tab 6 — Collab. Routes `shell.collabTab` ('chat' | 'notes' | 'polls', the
 * header segmented switcher already wired in MTripShell) to its sub-panel.
 *
 * Each sub-panel is fully self-contained (own state, own `collabApi` calls,
 * own WebSocket listener) per the architecture note in
 * analysis/10-tab-databindings.md §8.2 — none of them touch
 * `planner.tripActions` or `useTripStore`.
 *
 * `planner.collabFeatures` gates the three sub-tabs a second time, inside
 * this tab: the header's chat/notes/polls chips render unconditionally
 * (MTripShell.tsx does not filter them), so a trip with e.g. notes disabled
 * can still land here with `shell.collabTab === 'notes'` — the fallback below
 * covers that case instead of rendering a broken/empty panel.
 *
 * `collabFeatures.whatsnext` (a 4th desktop panel, `WhatsNextWidget`) is
 * deliberately not handled here — see the task report for why.
 */
export default function MCollabTab({ planner, shell }: MTabScreenProps) {
  const { t } = planner
  const label = t('mobileTrip.collabFeatureDisabled')

  if (shell.collabTab === 'chat') {
    if (!planner.collabFeatures.chat) {
      return (
        <div className="flex h-full flex-col px-4 pb-[var(--bottom-nav-h,84px)] pt-[calc(var(--m-safe-top,12px)+58px)]">
          <CollabDisabledNotice icon={MessageCircle} label={label} />
        </div>
      )
    }
    return <MCollabChat planner={planner} />
  }

  if (shell.collabTab === 'notes') {
    if (!planner.collabFeatures.notes) {
      return (
        <TabScroller>
          <CollabDisabledNotice icon={StickyNote} label={label} />
        </TabScroller>
      )
    }
    return <MCollabNotes planner={planner} />
  }

  if (shell.collabTab === 'links') {
    if (planner.collabFeatures.links === false) {
      return (
        <TabScroller>
          <CollabDisabledNotice icon={Link2} label={label} />
        </TabScroller>
      )
    }
    return (
      <TabScroller>
        <div className="min-h-[70vh] overflow-hidden rounded-[18px] bg-[color:var(--m-card)]">
          <CollabLinks tripId={planner.tripId} />
        </div>
      </TabScroller>
    )
  }

  if (shell.collabTab === 'polls') {
    if (!planner.collabFeatures.polls) {
      return (
        <TabScroller>
          <CollabDisabledNotice icon={BarChart3} label={label} />
        </TabScroller>
      )
    }
    return <MCollabPolls planner={planner} />
  }

  return null
}

function CollabDisabledNotice({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--m-ic)] text-m-faint">
        <Icon size={24} strokeWidth={1.8} />
      </span>
      <p className="font-geist text-[0.8125rem] font-medium text-m-muted">{label}</p>
    </div>
  )
}
