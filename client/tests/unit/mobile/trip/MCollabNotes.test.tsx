import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import MCollabNotes from '../../../../src/mobile/screens/trip/tabs/MCollabNotes'
import type { CollabNoteData } from '../../../../src/mobile/screens/trip/tabs/collabModel'
import type { TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import { addListener, removeListener } from '../../../../src/api/websocket'
import { openFile } from '../../../../src/utils/fileDownload'
import { buildPlanner } from '../../../helpers/mobileTrip'
import { resetAllStores } from '../../../helpers/store'
import { server } from '../../../helpers/msw/server'
import { act, fireEvent, render, screen, waitFor, within } from '../../../helpers/render'

// FE-MOB-CNOTE-001 to FE-MOB-CNOTE-033

// react-markdown ships as ESM-only chunks that jsdom chokes on; the note cards
// only care that the raw text reaches the renderer.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <span data-testid="md">{children}</span>,
}))
vi.mock('remark-gfm', () => ({ default: () => ({}) }))
vi.mock('remark-breaks', () => ({ default: () => ({}) }))
vi.mock('../../../../src/utils/fileDownload', () => ({
  openFile: vi.fn(),
  downloadFile: vi.fn(),
}))

function note(id: number, over: Partial<CollabNoteData> = {}): CollabNoteData {
  return {
    id,
    trip_id: 1,
    user_id: 2,
    title: `Note ${id}`,
    content: null,
    category: null,
    color: null,
    website: null,
    pinned: 0,
    username: 'Alice',
    avatar: null,
    avatar_url: null,
    created_at: '2026-06-01T10:00:00Z',
    attachments: [],
    ...over,
  }
}

let notePages: CollabNoteData[][] = []
let getCalls = 0
let createdBodies: Record<string, unknown>[] = []
let updatedBodies: { id: string; body: Record<string, unknown> }[] = []
let deletedIds: string[] = []
let deletedFiles: string[] = []
let uploadedTo: string[] = []

/** Each argument is one GET response; the last one repeats. */
function serveNotes(...pages: CollabNoteData[][]) {
  notePages = pages.length > 0 ? pages : [[]]
  server.use(
    http.get('/api/trips/:tripId/collab/notes', () => {
      getCalls++
      const page = notePages.length > 1 ? notePages.shift()! : notePages[0]
      return HttpResponse.json({ notes: page })
    }),
  )
}

function serveWrites(opts: { createFails?: boolean; updateFails?: boolean; deleteFails?: boolean; uploadFails?: boolean } = {}) {
  server.use(
    http.post('/api/trips/:tripId/collab/notes', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      createdBodies.push(body)
      if (opts.createFails) return HttpResponse.json({ error: 'x' }, { status: 500 })
      return HttpResponse.json({ note: note(99, { title: String(body.title), category: (body.category as string) ?? null }) })
    }),
    http.put('/api/trips/:tripId/collab/notes/:noteId', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>
      updatedBodies.push({ id: String(params.noteId), body })
      if (opts.updateFails) return HttpResponse.json({ error: 'x' }, { status: 500 })
      return HttpResponse.json({ note: { id: Number(params.noteId), ...body } })
    }),
    http.delete('/api/trips/:tripId/collab/notes/:noteId', ({ params }) => {
      deletedIds.push(String(params.noteId))
      if (opts.deleteFails) return HttpResponse.json({ error: 'x' }, { status: 500 })
      return HttpResponse.json({ success: true })
    }),
    http.post('/api/trips/:tripId/collab/notes/:noteId/files', ({ params }) => {
      uploadedTo.push(String(params.noteId))
      if (opts.uploadFails) return HttpResponse.json({ error: 'x' }, { status: 500 })
      return HttpResponse.json({ file: { id: 1, filename: 'f', original_name: 'f', url: '/uploads/f' } })
    }),
    http.delete('/api/trips/:tripId/collab/notes/:noteId/files/:fileId', ({ params }) => {
      deletedFiles.push(`${params.noteId}/${params.fileId}`)
      return HttpResponse.json({ success: true })
    }),
  )
}

async function renderNotes(planner: TripPlanner = buildPlanner()) {
  const view = render(<MCollabNotes planner={planner} />)
  await waitFor(() => expect(screen.queryByText('common.loading')).not.toBeInTheDocument())
  return { ...view, planner }
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

describe('MCollabNotes', () => {
  beforeEach(() => {
    resetAllStores()
    getCalls = 0
    createdBodies = []
    updatedBodies = []
    deletedIds = []
    deletedFiles = []
    uploadedTo = []
    vi.mocked(addListener).mockClear()
    vi.mocked(removeListener).mockClear()
    vi.mocked(openFile).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('FE-MOB-CNOTE-001: shows the mascot loading state until the notes arrive', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    render(<MCollabNotes planner={buildPlanner()} />)
    expect(screen.getByText('common.loading')).toBeInTheDocument()
    expect(await screen.findByText('Visa')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-002: shows the empty state with the create affordance', async () => {
    serveNotes([])
    await renderNotes()
    expect(screen.getByText('collab.notes.empty')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /collab\.notes\.new/ })).toBeInTheDocument()
    // no categories yet, so the filter row stays out
    expect(screen.queryByText('collab.notes.all')).not.toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-003: keeps an empty list when the request fails', async () => {
    server.use(http.get('/api/trips/:tripId/collab/notes', () => HttpResponse.json({ error: 'x' }, { status: 500 })))
    await renderNotes()
    expect(screen.getByText('collab.notes.empty')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-004: sorts pinned first, then by last touch', async () => {
    serveNotes([
      note(1, { title: 'Oldest', created_at: '2026-06-01T10:00:00Z' }),
      note(2, { title: 'Pinned', pinned: 1, created_at: '2026-01-01T10:00:00Z' }),
      note(3, { title: 'Freshest', created_at: '2026-06-02T10:00:00Z', updated_at: '2026-07-09T10:00:00Z' }),
    ])
    await renderNotes()
    const titles = screen.getAllByText(/^(Oldest|Pinned|Freshest)$/).map(el => el.textContent)
    expect(titles).toEqual(['Pinned', 'Freshest', 'Oldest'])
  })

  it('FE-MOB-CNOTE-005: renders body, author and attachment count on a card', async () => {
    serveNotes([note(1, {
      title: 'Packing tips',
      content: '**bring** an adapter',
      category: 'Gear',
      username: 'alice',
      attachments: [
        { id: 1, filename: 'a', original_name: 'a.pdf', url: '/uploads/a.pdf' },
        { id: 2, filename: 'b', original_name: 'b.pdf', url: '/uploads/b.pdf' },
      ],
    })])
    await renderNotes()
    expect(screen.getByTestId('md')).toHaveTextContent('**bring** an adapter')
    expect(screen.getAllByText('Gear').length).toBeGreaterThan(0)
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-006: filters by category and clears the filter on a second tap', async () => {
    serveNotes([
      note(1, { title: 'Visa', category: 'Docs', color: '#ef4444' }),
      note(2, { title: 'Tent', category: 'Gear', color: '#10b981' }),
    ])
    const { container } = await renderNotes()
    expect(screen.getByText('collab.notes.all')).toBeInTheDocument()

    const gearPill = container.querySelectorAll('button')
    const pill = Array.from(gearPill).find(b => b.textContent === 'Gear')!
    fireEvent.click(pill)
    expect(screen.getByText('Tent')).toBeInTheDocument()
    expect(screen.queryByText('Visa')).not.toBeInTheDocument()

    fireEvent.click(pill)
    expect(screen.getByText('Visa')).toBeInTheDocument()

    fireEvent.click(pill)
    fireEvent.click(screen.getByText('collab.notes.all'))
    expect(screen.getByText('Visa')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-007: pins a note and flips the affordance', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.pin' }))
    await waitFor(() => expect(updatedBodies).toEqual([{ id: '1', body: { pinned: true } }]))
    expect(await screen.findByRole('button', { name: 'collab.notes.unpin' })).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-008: deletes only after the confirm sheet is accepted', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.delete' }))
    expect(screen.getByText('collab.notes.confirmDeleteTitle')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(deletedIds).toEqual([])
    expect(screen.getByText('Visa')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))
    await waitFor(() => expect(deletedIds).toEqual(['1']))
    expect(screen.queryByText('Visa')).not.toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-009: toasts when a delete is rejected and keeps the card', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    serveWrites({ deleteFails: true })
    const { planner } = await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))
    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('common.error'))
    expect(screen.getByText('Visa')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-010: creates a note with an existing category and prepends it', async () => {
    serveNotes([note(1, { title: 'Visa', category: 'Docs', color: '#ef4444' })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.new/ }))
    const dialog = screen.getByRole('dialog', { name: 'collab.notes.new' })
    expect(screen.getByRole('button', { name: 'collab.notes.create' })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: '  Insurance  ' } })
    fireEvent.change(screen.getByPlaceholderText('collab.notes.contentPlaceholder'), { target: { value: ' call the hotline ' } })
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === 'Docs')!)
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.create' }))

    await waitFor(() => expect(createdBodies).toEqual([
      { title: 'Insurance', content: 'call the hotline', category: 'Docs', color: '#ef4444', website: null },
    ]))
    expect(await screen.findByText('Insurance')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('FE-MOB-CNOTE-011: a brand new category picks the first palette colour', async () => {
    serveNotes([])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.new/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: 'Ferry' } })
    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.newCategory/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.newCategory'), { target: { value: 'Transport' } })
    fireEvent.keyDown(screen.getByPlaceholderText('collab.notes.newCategory'), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.create' }))

    await waitFor(() => expect(createdBodies).toEqual([
      { title: 'Ferry', category: 'Transport', color: '#6366f1', website: null },
    ]))
  })

  it('FE-MOB-CNOTE-012: the inline category input can be confirmed with the button and ignores blanks', async () => {
    serveNotes([])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.new/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: 'Ferry' } })

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.newCategory/ }))
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }))
    expect(screen.queryByPlaceholderText('collab.notes.newCategory')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.newCategory/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.newCategory'), { target: { value: 'Food' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }))
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.create' }))

    await waitFor(() => expect(createdBodies).toEqual([
      { title: 'Ferry', category: 'Food', color: '#6366f1', website: null },
    ]))
  })

  it('FE-MOB-CNOTE-013: a failed create toasts and keeps the sheet open', async () => {
    serveNotes([])
    serveWrites({ createFails: true })
    const { planner } = await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.new/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: 'Ferry' } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.create' }))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('common.error'))
    expect(screen.getByRole('dialog', { name: 'collab.notes.new' })).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-014: editing prefills the sheet and saves the changed fields', async () => {
    serveNotes([note(1, { title: 'Visa', content: 'apply early', category: 'Docs', color: '#ef4444' })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    expect(screen.getByRole('dialog', { name: 'collab.notes.edit' })).toBeInTheDocument()
    const title = screen.getByPlaceholderText('collab.notes.titlePlaceholder')
    expect(title).toHaveValue('Visa')
    expect(screen.getByPlaceholderText('collab.notes.contentPlaceholder')).toHaveValue('apply early')

    fireEvent.change(title, { target: { value: 'Visa (done)' } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.save' }))

    await waitFor(() => expect(updatedBodies).toEqual([
      { id: '1', body: { title: 'Visa (done)', content: 'apply early', category: 'Docs', color: '#ef4444', website: null } },
    ]))
    expect(await screen.findByText('Visa (done)')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-015: a failed update toasts and leaves the card untouched', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    serveWrites({ updateFails: true })
    const { planner } = await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: 'Nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.save' }))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('common.error'))
    expect(screen.getByText('Visa')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-016: the cancel button closes the form without writing', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updatedBodies).toEqual([])
  })

  it('FE-MOB-CNOTE-017: queues picked files, drops one again and uploads the rest on save', async () => {
    serveNotes(
      [note(1, { title: 'Visa' })],
      [note(1, { title: 'Visa', attachments: [{ id: 5, filename: 'p', original_name: 'passport.pdf', url: '/uploads/p' }] })],
    )
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    fireEvent.change(fileInput(), {
      target: { files: [new File(['a'], 'passport.pdf'), new File(['b'], 'a-really-long-attachment-name.pdf')] },
    })
    expect(screen.getByText('passport.pdf')).toBeInTheDocument()
    // long names are shortened for the chip
    const longChip = screen.getByText('a-really-long-att...')

    fireEvent.click(within(longChip).getByRole('button'))
    expect(screen.queryByText('a-really-long-att...')).not.toBeInTheDocument()
    expect(screen.getByText('passport.pdf')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.save' }))
    await waitFor(() => expect(uploadedTo).toEqual(['1']))
    // the list is refetched so the new attachment shows up
    await waitFor(() => expect(getCalls).toBe(2))
    expect(await screen.findByText('1')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-018: a failed upload toasts but still refreshes the list', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    serveWrites({ uploadFails: true })
    const { planner } = await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    fireEvent.change(fileInput(), { target: { files: [new File(['a'], 'x.pdf')] } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.save' }))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('common.error'))
    await waitFor(() => expect(getCalls).toBe(2))
  })

  it('FE-MOB-CNOTE-019: removing an existing attachment calls the file endpoint', async () => {
    serveNotes([note(1, {
      title: 'Visa',
      attachments: [{ id: 5, filename: 'p', original_name: 'passport.pdf', url: '/uploads/p' }],
    })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    const chip = screen.getByText('passport.pdf')
    fireEvent.click(within(chip).getByRole('button'))

    await waitFor(() => expect(deletedFiles).toEqual(['1/5']))
    await waitFor(() => expect(screen.queryByText('passport.pdf')).not.toBeInTheDocument())
  })

  it('FE-MOB-CNOTE-020: a new note uploads its queued files against the created id', async () => {
    serveNotes([], [note(99, { title: 'Ferry', attachments: [{ id: 8, filename: 't', original_name: 't.pdf', url: '/uploads/t' }] })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.new/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: 'Ferry' } })
    fireEvent.change(fileInput(), { target: { files: [new File(['a'], 't.pdf')] } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.create' }))

    await waitFor(() => expect(createdBodies).toHaveLength(1))
    await waitFor(() => expect(uploadedTo).toEqual(['99']))
    await waitFor(() => expect(getCalls).toBe(2))
    expect(await screen.findByText('Ferry')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-021: keeps the chip and toasts when detaching an existing file is rejected', async () => {
    serveNotes([note(1, {
      title: 'Visa',
      attachments: [{ id: 5, filename: 'p', original_name: 'passport.pdf', url: '/uploads/p' }],
    })])
    serveWrites()
    server.use(http.delete('/api/trips/:tripId/collab/notes/:noteId/files/:fileId', () =>
      HttpResponse.json({ error: 'x' }, { status: 500 })))
    const { planner } = await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    fireEvent.click(within(screen.getByText('passport.pdf')).getByRole('button'))
    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('common.error'))
    expect(screen.getByText('passport.pdf')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-022: the attach tile opens the hidden file picker', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.attachFiles' }))
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })

  it('FE-MOB-CNOTE-023: hides the attachment section without the upload permission', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    const can = ((perm: string) => perm !== 'file_upload') as unknown as TripPlanner['can']
    await renderNotes(buildPlanner({ can }))

    fireEvent.click(screen.getByText('Visa'))
    expect(screen.queryByText('collab.notes.attachFiles')).not.toBeInTheDocument()
    expect(fileInput()).toBeNull()
  })

  it('FE-MOB-CNOTE-024: a read-only member gets the viewer sheet and can open attachments', async () => {
    serveNotes([note(1, {
      title: 'Visa',
      content: 'apply early',
      category: 'Docs',
      attachments: [{ id: 5, filename: 'p', original_name: 'passport.pdf', url: '/uploads/p' }],
    })])
    await renderNotes(buildPlanner({ can: (() => false) as TripPlanner['can'] }))

    expect(screen.queryByRole('button', { name: /collab\.notes\.new/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'collab.notes.pin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'collab.notes.delete' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Visa'))
    const viewer = screen.getByRole('dialog', { name: 'Visa' })
    expect(viewer).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /passport\.pdf/ }))
    expect(openFile).toHaveBeenCalledWith('/uploads/p', 'passport.pdf')

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('FE-MOB-CNOTE-025: applies remote create, update and delete events for this trip only', async () => {
    serveNotes([note(1, { title: 'Visa' })])
    await renderNotes()
    const handler = vi.mocked(addListener).mock.calls[0][0]

    act(() => handler({ type: 'collab:note:created', tripId: 1, note: note(2, { title: 'Remote' }) }))
    expect(screen.getByText('Remote')).toBeInTheDocument()

    act(() => handler({ type: 'collab:note:created', tripId: 1, note: note(2, { title: 'Remote' }) }))
    expect(screen.getAllByText('Remote')).toHaveLength(1)

    act(() => handler({ type: 'collab:note:updated', tripId: 1, note: note(2, { title: 'Renamed' }) }))
    expect(screen.getByText('Renamed')).toBeInTheDocument()

    act(() => handler({ type: 'collab:note:created', tripId: 42, note: note(3, { title: 'Elsewhere' }) }))
    expect(screen.queryByText('Elsewhere')).not.toBeInTheDocument()

    act(() => handler({ type: 'collab:note:deleted', tripId: 1, noteId: 2 }))
    expect(screen.queryByText('Renamed')).not.toBeInTheDocument()
    expect(screen.getByText('Visa')).toBeInTheDocument()
  })

  it('FE-MOB-CNOTE-026: detaches its websocket listener on unmount', async () => {
    serveNotes([note(1)])
    const { unmount } = await renderNotes()
    const handler = vi.mocked(addListener).mock.calls[0][0]

    unmount()
    expect(removeListener).toHaveBeenCalledWith(handler)
  })

  it('FE-MOB-CNOTE-027: creates a note with the trimmed website', async () => {
    serveNotes([])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.new/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: 'Ferry' } })
    fireEvent.change(screen.getByPlaceholderText('collab.notes.websitePlaceholder'), { target: { value: '  https://ferry.test/booking  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.create' }))

    await waitFor(() => expect(createdBodies).toEqual([
      { title: 'Ferry', color: '#6366f1', website: 'https://ferry.test/booking' },
    ]))
  })

  it('FE-MOB-CNOTE-028: a blank website is posted as null instead of an empty string', async () => {
    serveNotes([])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByRole('button', { name: /collab\.notes\.new/ }))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.titlePlaceholder'), { target: { value: 'Ferry' } })
    fireEvent.change(screen.getByPlaceholderText('collab.notes.websitePlaceholder'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.create' }))

    await waitFor(() => expect(createdBodies).toEqual([
      { title: 'Ferry', color: '#6366f1', website: null },
    ]))
  })

  it('FE-MOB-CNOTE-029: editing prefills the stored website and saves it back unchanged', async () => {
    serveNotes([note(1, { title: 'Visa', website: 'https://visa.test' })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    expect(screen.getByPlaceholderText('collab.notes.websitePlaceholder')).toHaveValue('https://visa.test')
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.save' }))

    await waitFor(() => expect(updatedBodies).toEqual([
      { id: '1', body: { title: 'Visa', color: '#6366f1', website: 'https://visa.test' } },
    ]))
  })

  it('FE-MOB-CNOTE-030: clearing the website sends an explicit null so the server drops it', async () => {
    serveNotes([note(1, { title: 'Visa', website: 'https://visa.test' })])
    serveWrites()
    await renderNotes()

    fireEvent.click(screen.getByText('Visa'))
    fireEvent.change(screen.getByPlaceholderText('collab.notes.websitePlaceholder'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'collab.notes.save' }))

    await waitFor(() => expect(updatedBodies).toEqual([
      { id: '1', body: { title: 'Visa', color: '#6366f1', website: null } },
    ]))
  })

  it('FE-MOB-CNOTE-031: the viewer sheet links a bare host out to a new tab', async () => {
    serveNotes([note(1, { title: 'Visa', website: 'www.visa.test' })])
    await renderNotes(buildPlanner({ can: (() => false) as TripPlanner['can'] }))

    fireEvent.click(screen.getByText('Visa'))
    const link = within(screen.getByRole('dialog', { name: 'Visa' })).getByRole('link')
    expect(link).toHaveAttribute('href', 'https://www.visa.test')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveTextContent('visa.test')
  })

  it('FE-MOB-CNOTE-032: a javascript: website is never turned into a link', async () => {
    serveNotes([note(1, { title: 'Visa', website: 'javascript:alert(1)' })])
    await renderNotes(buildPlanner({ can: (() => false) as TripPlanner['can'] }))

    expect(screen.queryAllByRole('link')).toHaveLength(0)
    fireEvent.click(screen.getByText('Visa'))
    expect(screen.getByRole('dialog', { name: 'Visa' })).toBeInTheDocument()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('FE-MOB-CNOTE-033: only a card with a website carries the link affordance', async () => {
    serveNotes([
      note(1, { title: 'Visa', website: 'https://visa.test' }),
      note(2, { title: 'Tent' }),
    ])
    await renderNotes()

    const links = screen.getAllByRole('link', { name: 'collab.notes.website' })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://visa.test')
  })
})
