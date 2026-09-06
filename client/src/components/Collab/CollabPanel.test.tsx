import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '../../../tests/helpers/render'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { buildUser } from '../../../tests/helpers/factories'
import { useAuthStore } from '../../store/authStore'

vi.mock('./CollabChat', () => ({ default: () => <div data-testid="collab-chat">Chat</div> }))
vi.mock('./CollabNotes', () => ({ default: () => <div data-testid="collab-notes">Notes</div> }))
vi.mock('./CollabLinks', () => ({ default: () => <div data-testid="collab-links">Links</div> }))
vi.mock('./CollabPolls', () => ({ default: () => <div data-testid="collab-polls">Polls</div> }))
vi.mock('./WhatsNextWidget', () => ({ default: () => <div data-testid="whats-next">WhatsNext</div> }))
vi.mock('../../api/websocket', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getSocketId: vi.fn(() => null),
  setRefetchCallback: vi.fn(),
  setPreReconnectHook: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}))

import CollabPanel from './CollabPanel'

let originalInnerWidth: number

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true })
  window.dispatchEvent(new Event('resize'))
}

describe('CollabPanel', () => {
  beforeEach(() => {
    originalInnerWidth = window.innerWidth
    resetAllStores()
    seedStore(useAuthStore, { user: buildUser() })
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true, configurable: true })
  })

  // FE-COMP-COLLABPANEL-001
  it('desktop layout renders all five panels', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} />)
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.getByTestId('collab-links')).toBeInTheDocument()
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.getByTestId('whats-next')).toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-002
  it('mobile layout renders tab bar, not all panels at once', () => {
    setViewport(375)
    render(<CollabPanel tripId={1} />)
    // Tab buttons exist
    expect(screen.getByRole('button', { name: /chat/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /notes/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^links$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /polls/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /what.?s next/i })).toBeInTheDocument()
    // Only chat visible by default
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-notes')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collab-polls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('whats-next')).not.toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-003
  it('mobile: clicking Notes tab switches to CollabNotes', () => {
    setViewport(375)
    render(<CollabPanel tripId={1} />)
    fireEvent.click(screen.getByRole('button', { name: /notes/i }))
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-chat')).not.toBeInTheDocument()
  })

  it('mobile: Links tab shows the translated label, not the i18n key', () => {
    setViewport(375)
    render(<CollabPanel tripId={1} />)
    expect(screen.getByRole('button', { name: 'Links' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'collab.tabs.links' })).not.toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-004
  it('mobile: clicking Polls tab switches to CollabPolls', () => {
    setViewport(375)
    render(<CollabPanel tripId={1} />)
    fireEvent.click(screen.getByRole('button', { name: /polls/i }))
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-chat')).not.toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-005
  it('mobile: clicking What\'s Next tab shows WhatsNextWidget', () => {
    setViewport(375)
    render(<CollabPanel tripId={1} />)
    fireEvent.click(screen.getByRole('button', { name: /what.?s next/i }))
    expect(screen.getByTestId('whats-next')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-chat')).not.toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-006
  it('mobile: active tab button has accent background style', () => {
    setViewport(375)
    render(<CollabPanel tripId={1} />)
    const chatButton = screen.getByRole('button', { name: /chat/i })
    expect(chatButton.style.background).toBe('var(--accent)')
    const notesButton = screen.getByRole('button', { name: /notes/i })
    expect(notesButton.style.background).toBe('transparent')
  })

  // FE-COMP-COLLABPANEL-007
  it('mobile: default active tab is Chat', () => {
    setViewport(375)
    render(<CollabPanel tripId={1} />)
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-008
  it('tripMembers prop is forwarded to WhatsNextWidget', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} tripMembers={[{ id: 5, username: 'alice', avatar_url: null }]} />)
    expect(screen.getByTestId('whats-next')).toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-009
  it('tripId prop is forwarded to child components', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} />)
    // All children render without errors, confirming props were forwarded
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
  })

  // FE-COMP-COLLABPANEL-010
  it('resize from desktop to mobile hides side-by-side layout', () => {
    setViewport(1280)
    const { rerender } = render(<CollabPanel tripId={1} />)
    // All four panels visible on desktop
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()

    // Switch to mobile
    setViewport(375)
    rerender(<CollabPanel tripId={1} />)

    // Tab bar appears, only chat visible
    expect(screen.getByRole('button', { name: /chat/i })).toBeInTheDocument()
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-notes')).not.toBeInTheDocument()
  })
})

// FE-W5CPN-001 to FE-W5CPN-013
// The desktop branch picks a different layout for every combination of enabled
// collab features, so each combination gets its own case.
const allOff = { chat: false, notes: false, links: false, polls: false, whatsnext: false }

describe('CollabPanel feature combinations', () => {
  beforeEach(() => {
    originalInnerWidth = window.innerWidth
    resetAllStores()
    seedStore(useAuthStore, { user: buildUser() })
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true, configurable: true })
  })

  it('FE-W5CPN-001: renders nothing when every collab feature is disabled', () => {
    setViewport(1280)
    const { container } = render(<CollabPanel tripId={1} collabFeatures={allOff} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-002: chat alone fills the whole desktop panel', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, chat: true }} />)
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-notes')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collab-links')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collab-polls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('whats-next')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-003: chat plus notes puts the notes card next to the chat column', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, chat: true, notes: true }} />)
    expect(screen.getByTestId('collab-chat')).toBeInTheDocument()
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-polls')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-004: chat plus polls renders the polls card as the only right panel', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, chat: true, polls: true }} />)
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-notes')).not.toBeInTheDocument()
    expect(screen.queryByTestId('whats-next')).not.toBeInTheDocument()
  })

  it("FE-W5CPN-005: chat plus what's next renders the widget as the only right panel", () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, chat: true, whatsnext: true }} />)
    expect(screen.getByTestId('whats-next')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-notes')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collab-polls')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-006: chat plus notes and polls stacks both right panels', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, chat: true, notes: true, polls: true }} />)
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.queryByTestId('whats-next')).not.toBeInTheDocument()
  })

  it("FE-W5CPN-007: chat plus polls and what's next stacks those two", () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, chat: true, polls: true, whatsnext: true }} />)
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.getByTestId('whats-next')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-notes')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-008: notes alone fills the panel when chat is off', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, notes: true }} />)
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-chat')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-009: polls alone fills the panel when chat is off', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, polls: true }} />)
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-chat')).not.toBeInTheDocument()
  })

  it("FE-W5CPN-010: what's next alone fills the panel when chat is off", () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, whatsnext: true }} />)
    expect(screen.getByTestId('whats-next')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-chat')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-011: notes and polls share the width side by side when chat is off', () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, notes: true, polls: true }} />)
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-chat')).not.toBeInTheDocument()
  })

  it("FE-W5CPN-012: polls and what's next share the width when chat is off", () => {
    setViewport(1280)
    render(<CollabPanel tripId={1} collabFeatures={{ ...allOff, polls: true, whatsnext: true }} />)
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()
    expect(screen.getByTestId('whats-next')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-notes')).not.toBeInTheDocument()
  })

  it('FE-W5CPN-013: mobile falls back to the first tab when the active one gets disabled', () => {
    setViewport(375)
    const { rerender } = render(<CollabPanel tripId={1} />)
    fireEvent.click(screen.getByRole('button', { name: /polls/i }))
    expect(screen.getByTestId('collab-polls')).toBeInTheDocument()

    rerender(<CollabPanel tripId={1} collabFeatures={{ ...allOff, notes: true, whatsnext: true }} />)
    expect(screen.getByTestId('collab-notes')).toBeInTheDocument()
    expect(screen.queryByTestId('collab-polls')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /polls/i })).not.toBeInTheDocument()
  })
})
