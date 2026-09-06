// FE-COMP-COSTS: settlements surfaced inline in the Costs ledger (issue #1241)
// FE-W5COSTS-001 to FE-W5COSTS-035: the rest of the Costs panel
import { render, screen, waitFor, fireEvent, within } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../../tests/helpers/msw/server'
import { useAuthStore } from '../../store/authStore'
import { useTripStore } from '../../store/tripStore'
import { useSettingsStore } from '../../store/settingsStore'
import { usePermissionsStore } from '../../store/permissionsStore'
import { clearExchangeRateCache } from '../../hooks/useExchangeRates'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { buildUser, buildTrip, buildBudgetItem, buildSettings } from '../../../tests/helpers/factories'
import type { BudgetItem } from '../../types'
import CostsPanel, { ExpenseModal } from './CostsPanel'
import { splitEqualShares, calculateTicketShares, type TicketItem } from './CostsPanel.helpers'

const tripMembers = [
  { id: 1, username: 'alice', avatar_url: null },
  { id: 2, username: 'bob', avatar_url: null },
]

beforeEach(() => {
  resetAllStores()
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true })
  seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR' }) })
})

describe('CostsPanel — settlements in the ledger', () => {
  it('renders a settle-up payment as a ledger row with an undo action', async () => {
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Dinner' }), total_price: 90, expense_date: '2025-06-15' }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () =>
        HttpResponse.json({
          balances: [],
          flows: [],
          settlements: [
            { id: 7, trip_id: 1, from_user_id: 2, to_user_id: 1, amount: 30, created_at: '2025-06-16 10:00:00', from_username: 'bob', to_username: 'alice' },
          ],
        })
      ),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    // The expense and the settlement (payment) both appear in the unified ledger.
    await screen.findByText('Dinner')
    await screen.findByText('Payment')
    // The payment row exposes an inline undo (no need to open a separate History modal).
    expect(screen.getByTitle('Undo')).toBeInTheDocument()
  })

  it('records a manual payment via the Add payment button', async () => {
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget/settlements', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ settlement: { id: 1, ...posted } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add payment' }))
    await user.type(await screen.findByPlaceholderText('0.00'), '25')
    // The footer submit is the second "Add payment" control once the modal is open.
    const addButtons = screen.getAllByRole('button', { name: 'Add payment' })
    const submit = addButtons[addButtons.length - 1]
    await user.click(submit)
    await waitFor(() => expect(posted).toMatchObject({ amount: 25 }))
  })

  it('hides payment rows while a text search is active', async () => {
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Dinner' }), total_price: 90, expense_date: '2025-06-15' }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () =>
        HttpResponse.json({
          balances: [],
          flows: [],
          settlements: [
            { id: 7, trip_id: 1, from_user_id: 2, to_user_id: 1, amount: 30, created_at: '2025-06-16 10:00:00', from_username: 'bob', to_username: 'alice' },
          ],
        })
      ),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Payment')
    await user.type(screen.getByPlaceholderText('Search expenses…'), 'Dinner')
    // Payment rows have no name, so a search hides them while the matching expense stays.
    expect(screen.queryByText('Payment')).not.toBeInTheDocument()
    expect(screen.getByText('Dinner')).toBeInTheDocument()
  })

  it('supports custom split amounts on save', async () => {
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item: { ...buildBudgetItem({ trip_id: 1, name: 'Dinner' }), id: 5 } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')
    const nums = () => screen.getAllByPlaceholderText('0,00') as HTMLInputElement[]
    await user.type(nums()[0], '100') // total = 100

    await user.click(screen.getByRole('button', { name: /Custom/i }))

    const customInputs = screen.getAllByPlaceholderText('50,00')
    await user.type(customInputs[0], '30')
    await user.type(customInputs[1], '70')

    const addBtns = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(addBtns[addBtns.length - 1]) // footer submit
    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.total_price).toBe(100)
    expect(posted!.payers).toEqual([
      expect.objectContaining({ amount: 100 })
    ])
    expect(posted!.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: 1, amount: 30 }),
      expect.objectContaining({ user_id: 2, amount: 70 }),
    ]))
  })

  it('accepts a comma as the decimal separator in the total amount (#1256)', async () => {
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item: { ...buildBudgetItem({ trip_id: 1, name: 'AirTags' }), id: 6 } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'AirTags')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '39,99') // comma → normalized to 39.99

    const addBtns = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(addBtns[addBtns.length - 1]) // footer submit
    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.total_price).toBe(39.99)
  })

  it('marks an expense with no payer as Unfinished', async () => {
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Hotel' }), total_price: 90, payers: [], members: [{ user_id: 1, username: 'alice', paid: 0 }] }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)
    await screen.findByText('Hotel')
    expect(screen.getByText('Unfinished')).toBeInTheDocument()
  })

  // ── Notes on an expense (#1658) ────────────────────────────────────────────

  it('shows a note on the row and expands it on click', async () => {
    const long = 'Bought the whole week of breakfasts here, Ben pays back his half once the card statement lands'
    const item = {
      ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Supermarket' }),
      total_price: 60,
      note: long,
      payers: [{ user_id: 1, amount: 60, username: 'alice' }],
    }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    // Re-queried after each click: the row is re-created on every render of the
    // panel, so a handle taken before the click points at a detached node.
    const noteToggle = () => screen.getByRole('button', { name: new RegExp(long.slice(0, 20)) })
    await screen.findByText('Supermarket')
    expect(noteToggle()).toHaveAttribute('aria-expanded', 'false')
    await user.click(noteToggle())
    expect(noteToggle()).toHaveAttribute('aria-expanded', 'true')
    await user.click(noteToggle())
    expect(noteToggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('never renders a receipt blob as a note', async () => {
    const item = {
      ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Market' }),
      total_price: 20,
      // How the receipt was stored before it got its own column.
      note: 'TICKETJSON:{"items":[{"name":"Cheese","price":"20","parts":[1]}]}',
      payers: [{ user_id: 1, amount: 20, username: 'alice' }],
    }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Market')
    expect(screen.queryByText(/TICKETJSON/)).toBeNull()
  })

  it('keeps an existing note when the expense is saved again', async () => {
    const item = {
      ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Lunch' }),
      total_price: 30,
      note: 'split with the neighbours',
      payers: [{ user_id: 1, amount: 30, username: 'alice' }],
    }
    let patched: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.put('/api/trips/1/budget/:id', async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ item: { ...item, ...patched } })
      }),
    )
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Lunch')
    await user.click(screen.getAllByTitle('Edit')[0])
    await user.click(await screen.findByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patched).toBeTruthy())
    expect(patched!.note).toBe('split with the neighbours')
  })

  it('shows the net hint on a settled expense row and hides it while unfinished', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
    // alice fronted the whole 90 for a two-way split, so she is 45 up.
    const lent = {
      ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Dinner' }),
      total_price: 90,
      payers: [{ user_id: 1, amount: 90, username: 'alice' }],
      members: [{ user_id: 1, username: 'alice', paid: 1 }, { user_id: 2, username: 'bob', paid: 0 }],
    }
    const unpaid = {
      ...buildBudgetItem({ trip_id: 1, category: 'lodging', name: 'Hotel' }),
      total_price: 90,
      payers: [],
      members: [{ user_id: 1, username: 'alice', paid: 0 }, { user_id: 2, username: 'bob', paid: 0 }],
    }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [lent, unpaid] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    const dinnerRow = (await screen.findByText('Dinner')).closest('.exp-row') as HTMLElement
    expect(within(dinnerRow).getByText(/you lent/)).toHaveTextContent('45')

    const hotelRow = (await screen.findByText('Hotel')).closest('.exp-row') as HTMLElement
    expect(within(hotelRow).queryByText(/you lent|you borrowed/)).toBeNull()
  })

  it('sums only unfinished expenses in the Outstanding amount card', async () => {
    // Display in the trip's own currency so FX conversion is an identity — keeps the asserted sum deterministic.
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
    const paid = { ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Dinner' }), total_price: 60, payers: [{ user_id: 1, amount: 60, username: 'alice' }], members: [{ user_id: 1, username: 'alice', paid: 1 }] }
    const unfinishedA = { ...buildBudgetItem({ trip_id: 1, category: 'lodging', name: 'Hotel' }), total_price: 90, payers: [], members: [{ user_id: 1, username: 'alice', paid: 0 }] }
    const unfinishedB = { ...buildBudgetItem({ trip_id: 1, category: 'transport', name: 'Taxi' }), total_price: 30, payers: [], members: [{ user_id: 1, username: 'alice', paid: 0 }] }
    const zero = { ...buildBudgetItem({ trip_id: 1, category: 'misc', name: 'Freebie' }), total_price: 0, payers: [], members: [{ user_id: 1, username: 'alice', paid: 0 }] }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [paid, unfinishedA, unfinishedB, zero] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    // Footer only shows the count once unfinished expenses have loaded.
    const foot = await screen.findByText('expenses need a payer')
    expect(foot).toHaveTextContent('2 expenses need a payer') // the two payer-less, non-zero expenses
    // Sum is 90 + 30 = 120 — the paid (60) and zero-total items are excluded.
    // Sum is 90 + 30 = 120 — the paid (60) and zero-total items are excluded.
    const card = screen.getByText('Outstanding amount').closest('div[style*="border-radius: 22"]')
    expect(card).toHaveTextContent('120') // 120,00 € (locale separator), i.e. 90 + 30
  })

  // #2225 follow-up — the ledger stopped charging payer-less expenses, but this
  // tile kept counting them, so it contradicted the balances right beside it.
  it('keeps a payer-less expense out of Your share, like the balances do', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    const paid = { ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Dinner' }), total_price: 60, payers: [{ user_id: 1, amount: 60, username: 'alice' }], members: [{ user_id: 1, username: 'alice', paid: 1 }] }
    const noPayer = { ...buildBudgetItem({ trip_id: 1, category: 'transport', name: 'Taxi' }), total_price: 40, payers: [], members: [{ user_id: 1, username: 'alice', paid: 0 }] }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [paid, noPayer] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Taxi')
    // "Your share" is the first of the two bold figures in the Total spend card's
    // footer; the second is "You paid". 60 from the paid expense only — the 40
    // nobody has paid for is not a share, though it still counts as spend.
    const card = screen.getByText('Total spend').closest('div[style*="border-radius: 22"]')!
    const figures = [...card.querySelectorAll('b')].map(b => b.textContent ?? '')
    expect(figures[0]).toContain('60')
    expect(figures[0]).not.toContain('100')
  })

  it('records a recorded-total expense with nobody to split with (#1286)', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item: { ...buildBudgetItem({ trip_id: 1, name: 'Hotel' }), id: 9 } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Hotel')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '120') // total only, paid on-site later

    // Deselect everyone so the cost carries no split, and mark it as unpaid: a picked
    // payer now always goes out (#1766), so "nobody paid" must be said explicitly.
    await user.click(screen.getByRole('button', { name: 'Y You' }))
    await user.click(screen.getByRole('button', { name: 'B bob' }))
    await user.click(screen.getByRole('button', { name: 'You' })) // open the Who-paid select
    pickOption('No one paid yet')

    const addBtns = screen.getAllByRole('button', { name: 'Add expense' })
    const submit = addBtns[addBtns.length - 1] // footer submit
    expect(submit).not.toBeDisabled()
    await user.click(submit)

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.total_price).toBe(120)
    expect(posted!.member_ids).toEqual([])
    expect(posted!.payers).toEqual([])
  })

  it('keeps a picked payer when nobody splits the expense (#1766)', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item: { ...buildBudgetItem({ trip_id: 1, name: 'Flight' }), id: 11 } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Flight')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '100')

    // A personal expense: alice (the default "You" payer) fronted it, but nobody shares
    // the split. The web used to drop the payer once no participants remained.
    await user.click(screen.getByRole('button', { name: 'Y You' }))
    await user.click(screen.getByRole('button', { name: 'B bob' }))

    const addBtns = screen.getAllByRole('button', { name: 'Add expense' })
    const submit = addBtns[addBtns.length - 1] // footer submit
    expect(submit).not.toBeDisabled()
    await user.click(submit)

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.member_ids).toEqual([])
    expect(posted!.payers).toEqual([{ user_id: 1, amount: 100 }])
  })

  it('keeps "no one paid yet" when reopening a payer-less expense (#1533)', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    let put: Record<string, unknown> | null = null
    const item = {
      ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Hotel' }),
      id: 5,
      total_price: 120,
      payers: [],
      members: [{ user_id: 1, username: 'alice', paid: 0 }, { user_id: 2, username: 'bob', paid: 0 }],
    }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.put('/api/trips/1/budget/5', async ({ request }) => {
        put = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Hotel')
    await user.click(screen.getByTitle('Edit'))

    // Nobody paid this expense — reopening it must not silently reselect "You".
    expect(await screen.findByRole('button', { name: 'No one paid yet' })).toBeInTheDocument()

    // …and saving an untouched edit must not assign the current user as payer.
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toBeTruthy())
    expect(put!.payers).toEqual([])
  })

  it('still defaults a brand-new expense to "You" as the payer', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    expect(await screen.findByRole('button', { name: 'You' })).toBeInTheDocument()
  })

  // ── Multi-payer (#1426 regression) ─────────────────────────────────────────
  // 3.2.0 collapsed payers[] to a single payer, so a bill fronted by two people
  // credited all of it to one and skewed settle-up. The ledger always supported N
  // payers; only the form could no longer send them.

  it('records an expense paid by two people with their own amounts', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item: { ...buildBudgetItem({ trip_id: 1, name: 'Dinner' }), id: 11 } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '90')

    await user.click(screen.getByRole('button', { name: 'Multiple people paid' }))

    // Alice (me) is seeded as the sole payer; including Bob rebalances to 45/45.
    await user.click(screen.getAllByTestId('payer-toggle')[1])
    expect(screen.getAllByTestId('payer-amount').map(i => (i as HTMLInputElement).value))
      .toEqual(['45,00', '45,00'])

    const addBtns = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(addBtns[addBtns.length - 1])

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.total_price).toBe(90)
    expect(posted!.payers).toEqual(expect.arrayContaining([
      { user_id: 1, amount: 45 },
      { user_id: 2, amount: 45 },
    ]))
    expect(posted!.payers).toHaveLength(2)
  })

  it('blocks saving when the payer amounts do not add up to the total', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item: buildBudgetItem({ trip_id: 1, name: 'Dinner' }) })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '90')
    await user.click(screen.getByRole('button', { name: 'Multiple people paid' }))
    await user.click(screen.getAllByTestId('payer-toggle')[1])

    // Pin both payers at 20 of a 90 bill, so nobody is left to absorb the rest.
    const amounts = () => screen.getAllByTestId('payer-amount') as HTMLInputElement[]
    await user.clear(amounts()[0])
    await user.type(amounts()[0], '20')
    await user.clear(amounts()[1])
    await user.type(amounts()[1], '20')

    // An unbalanced payer list would make the server re-derive total_price as 40.
    expect(screen.getByText(/must add up to/i)).toBeInTheDocument()
    const addBtns = screen.getAllByRole('button', { name: 'Add expense' })
    expect(addBtns[addBtns.length - 1]).toBeDisabled()
    expect(posted).toBeNull()
  })

  it('reopens a two-payer expense with both payers intact', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
    let put: Record<string, unknown> | null = null
    const item = {
      ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Dinner' }),
      id: 7,
      total_price: 90,
      payers: [{ user_id: 1, amount: 45, username: 'alice' }, { user_id: 2, amount: 45, username: 'bob' }],
      members: [{ user_id: 1, username: 'alice', paid: 0 }, { user_id: 2, username: 'bob', paid: 0 }],
    }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.put('/api/trips/1/budget/7', async ({ request }) => {
        put = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Dinner')
    await user.click(screen.getByTitle('Edit'))

    // Loading used to be payers.find(...), which silently dropped the second payer.
    // Seeded with two decimals since #2175, localized for EUR.
    const amounts = await screen.findAllByTestId('payer-amount')
    expect(amounts.map(i => (i as HTMLInputElement).value)).toEqual(['45,00', '45,00'])

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toBeTruthy())
    expect(put!.payers).toHaveLength(2)
  })

  it('exports the expenses as a CSV download (#1500)', async () => {
    // Display in the trip's own currency so FX conversion is an identity.
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
    let exported: Blob | null = null
    const createObjURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { exported = b as Blob; return 'blob:mock' })
    const revokeObjURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Dinner; tapas' }), total_price: 90, expense_date: '2025-06-15' }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Dinner; tapas')
    await user.click(screen.getByTitle('Export CSV'))

    expect(exported).toBeTruthy()
    const text = await exported!.text()
    expect(text).toContain('Date;Name;Category;Amount;Currency;Amount (EUR);Note')
    expect(text).toContain('"Dinner; tapas"') // separator inside the name gets quoted
    expect(text).toContain('Food & drink')    // category label, not the raw key
    expect(text).toContain('90.00;EUR')
    createObjURL.mockRestore(); revokeObjURL.mockRestore(); clickSpy.mockRestore()
  })

  it('supports itemized receipt ticket manual entry and split assignment', async () => {
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ item: { ...buildBudgetItem({ trip_id: 1, name: 'Dinner' }), id: 10 } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')

    await user.click(screen.getByRole('button', { name: 'Ticket' }))

    const addBtn = screen.getByRole('button', { name: /Add item/i })
    await user.click(addBtn)
    await user.click(addBtn)
    await user.click(addBtn)

    const itemNames = screen.getAllByPlaceholderText('Item name')
    const itemPrices = screen.getAllByPlaceholderText('0,00')
    
    await user.type(itemNames[0], 'Apples')
    await user.type(itemPrices[1], '10')

    await user.type(itemNames[1], 'chocolate cake')
    await user.type(itemPrices[2], '50')
    const bobButtons = screen.getAllByRole('button', { name: /bob/i })
    await user.click(bobButtons[1])

    await user.type(itemNames[2], 'Milk')
    await user.type(itemPrices[3], '40')

    expect(screen.getByDisplayValue('100,00')).toBeDisabled()

    expect(screen.getByText('Individual shares')).toBeInTheDocument()
    expect(screen.getByText(/75\.00/)).toBeInTheDocument()
    expect(screen.getByText(/25\.00/)).toBeInTheDocument()

    const addBtns = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(addBtns[addBtns.length - 1])

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.total_price).toBe(100)
    expect(posted!.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: 1, amount: 75 }),
      expect.objectContaining({ user_id: 2, amount: 25 }),
    ]))
    // The receipt has its own column since #1658; `note` is the user's text.
    expect(JSON.parse(posted!.ticket_json as string).items).toHaveLength(3)
    expect(posted!.note).toBeNull()
  })

  // ── Display currency ───────────────────────────────────────────────────────

  it('shows amounts in the trip currency when the user has no display currency set', async () => {
    // No personal preference → the trip's own currency wins, instead of a hardcoded one.
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: '' } })
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'JPY' }) })
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'food', name: 'Sushi' }), total_price: 3000, currency: 'JPY', payers: [], members: [{ user_id: 1, username: 'alice', paid: 0 }] }
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Sushi')
    const card = screen.getByText('Total trip spend').closest('div[style*="border-radius: 22"]')
    // Yen, unconverted and with JPY's zero decimals — not a euro/dollar default.
    expect(card).toHaveTextContent('￥3,000')
  })

  // ── Payment currency ───────────────────────────────────────────────────────
  // A transfer settling a shared bill can be made in any currency, so it carries its
  // own rather than being assumed to be in the display one.

  it('records a payment in the display currency by default', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget/settlements', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ settlement: { id: 1, ...posted } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add payment' }))
    await user.type(await screen.findByPlaceholderText('0.00'), '25')
    const addButtons = screen.getAllByRole('button', { name: 'Add payment' })
    await user.click(addButtons[addButtons.length - 1])

    await waitFor(() => expect(posted).toMatchObject({ amount: 25, currency: 'EUR' }))
  })

  it('records a payment made in another currency', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
    let posted: Record<string, unknown> | null = null
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
      http.post('/api/trips/1/budget/settlements', async ({ request }) => {
        posted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ settlement: { id: 1, ...posted } })
      }),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await user.click(await screen.findByRole('button', { name: 'Add payment' }))
    await user.type(await screen.findByPlaceholderText('0.00'), '25')
    // Bob paid me back in dollars — the server freezes the USD rate on write.
    await user.click(screen.getByText(/^EUR/))
    await user.click(await screen.findByText(/^USD/))
    const addButtons = screen.getAllByRole('button', { name: 'Add payment' })
    await user.click(addButtons[addButtons.length - 1])

    await waitFor(() => expect(posted).toMatchObject({ amount: 25, currency: 'USD' }))
  })

  it('reopens a foreign-currency payment with its own currency', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () =>
        HttpResponse.json({
          balances: [],
          flows: [],
          settlements: [
            { id: 7, trip_id: 1, from_user_id: 2, to_user_id: 1, amount: 30, currency: 'USD', exchange_rate: 1.1, created_at: '2025-06-16 10:00:00', from_username: 'bob', to_username: 'alice' },
          ],
        })
      ),
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Payment')
    await user.click(screen.getByTitle('Edit'))

    // The stored USD amount comes back as-is (padded to two decimals, #2175),
    // not silently reread as euros.
    expect((await screen.findByPlaceholderText('0.00') as HTMLInputElement).value).toBe('30.00')
    expect(screen.getByText(/^USD/)).toBeInTheDocument()
  })
})

// ── The rest of the panel ────────────────────────────────────────────────────

type Flow = { from: { user_id: number; username: string }; to: { user_id: number; username: string }; amount: number }
type Balance = { user_id: number; username: string; avatar_url: string | null; balance: number }
type Payment = { id: number; from_user_id: number; to_user_id: number; amount: number; currency?: string | null; created_at?: string }

// `members` here is the wire shape the panel reads; `paid` is only set by the server.
type MemberFixture = { user_id: number; username?: string; amount?: number; paid?: number }
const expense = (over: Partial<Omit<BudgetItem, 'members'>> & { members?: MemberFixture[] }): BudgetItem =>
  ({ ...buildBudgetItem({ trip_id: 1 }), payers: [], members: [], ...over }) as unknown as BudgetItem

function mount(
  items: BudgetItem[],
  settlement: { balances?: Balance[]; flows?: Flow[]; settlements?: Payment[] } = {},
  entries?: string[],
) {
  server.use(
    http.get('/api/trips/1/budget', () => HttpResponse.json({ items })),
    http.get('/api/trips/1/budget/settlement', () =>
      HttpResponse.json({ balances: [], flows: [], settlements: [], ...settlement })),
  )
  return render(<CostsPanel tripId={1} tripMembers={tripMembers} />, entries ? { initialEntries: entries } : undefined)
}

/** CustomSelect renders its options into a body portal. */
function pickOption(label: string | RegExp) {
  const dropdown = document.querySelector('div[style*="z-index: 99999"]') as HTMLElement
  fireEvent.click(within(dropdown).getByRole('button', { name: label }))
}

// Alice is the signed-in user throughout; the euro display currency keeps FX an identity.
function seedAlice() {
  seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'alice' }), isAuthenticated: true })
  seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'EUR' } })
}

const dinner = () => expense({
  id: 101, name: 'Dinner', category: 'food', total_price: 90, expense_date: '2025-06-15',
  payers: [{ user_id: 1, amount: 90 }],
  members: [{ user_id: 1, username: 'alice' }, { user_id: 2, username: 'bob' }],
})
const taxi = () => expense({
  id: 102, name: 'Taxi', category: 'transport', total_price: 30, expense_date: '2025-06-16',
  payers: [{ user_id: 2, amount: 30 }],
  members: [{ user_id: 1, username: 'alice' }, { user_id: 2, username: 'bob' }],
})

describe('CostsPanel — overview', () => {
  beforeEach(seedAlice)

  it('FE-W5COSTS-001: heads the panel with the trip span and the traveler chips', async () => {
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR', start_date: '2025-06-01', end_date: '2025-06-05' }) })
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={[{ id: 1, username: 'alice', avatar_url: '/uploads/avatars/a.png' }, { id: 2, username: 'bob', avatar_url: null }]} />)

    const span = await screen.findByText('5 days')
    expect(span.parentElement).toHaveTextContent('Jun 1 – Jun 5')
    expect(screen.getByText('2 travelers')).toBeInTheDocument()
    // Alice has an uploaded avatar, Bob falls back to his initial.
    expect(document.querySelectorAll('img[src="/uploads/avatars/a.png"]').length).toBeGreaterThan(0)
    expect(screen.getAllByText('B').length).toBeGreaterThan(0)
  })

  it('FE-W5COSTS-002: a trip without dates gets no span chip', async () => {
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR', start_date: null, end_date: null } as never) })
    mount([])

    expect(await screen.findByText('2 travelers')).toBeInTheDocument()
    expect(screen.queryByText(/^\d+ days$/)).toBeNull()
  })

  it('FE-W5COSTS-003: balances render credit, debt and a settled zero', async () => {
    mount([], {
      balances: [
        { user_id: 1, username: 'alice', avatar_url: null, balance: 45 },
        { user_id: 2, username: 'bob', avatar_url: null, balance: -45 },
      ],
    })

    expect(await screen.findByText('+45,00 €')).toBeInTheDocument()
    expect(screen.getByText('−45,00 €')).toBeInTheDocument()
  })

  it('FE-W5COSTS-004: a member with no balance row is shown as square', async () => {
    mount([], { balances: [{ user_id: 1, username: 'alice', avatar_url: null, balance: 0 }] })

    // Both travellers appear; neither has a signed amount.
    await screen.findByText('Balances')
    expect(screen.getAllByText('0,00 €')).toHaveLength(2)
  })

  it('FE-W5COSTS-005: the category breakdown ranks categories by spend', async () => {
    mount([dinner(), taxi()])

    await screen.findByText('Dinner')
    const breakdown = screen.getByText('By category').parentElement as HTMLElement
    const labels = within(breakdown).getAllByText(/Food & drink|Transport/).map(el => el.textContent)
    // Bars are ordered by spend, so the 90 € food row comes before the 30 € taxi.
    expect(labels).toEqual(['Food & drink', 'Transport'])
    expect(within(breakdown).getByText('90 €')).toBeInTheDocument()
    expect(within(breakdown).getByText('30 €')).toBeInTheDocument()
  })

  it('FE-W5COSTS-006: an empty trip shows the empty ledger and the empty breakdown', async () => {
    mount([])

    expect(await screen.findByText('No expenses yet. Add your first one.')).toBeInTheDocument()
    expect(screen.getByText('No expenses yet.')).toBeInTheDocument()
    expect(screen.getByText("Everyone's square")).toBeInTheDocument()
  })

  it('FE-W5COSTS-007: an unknown currency falls back to a plainly formatted amount', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: '' } })
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'XX' }) })
    mount([expense({ id: 110, name: 'Mystery', category: 'other', total_price: 90 })])

    await screen.findByText('Mystery')
    const card = screen.getByText('Total trip spend').closest('div[style*="border-radius: 22"]')
    expect(card).toHaveTextContent('90.00 XX')
  })
})

describe('CostsPanel — settle up', () => {
  beforeEach(seedAlice)

  const flows: Flow[] = [
    { from: { user_id: 2, username: 'bob' }, to: { user_id: 1, username: 'alice' }, amount: 45 },
    { from: { user_id: 3, username: 'cara' }, to: { user_id: 1, username: 'alice' }, amount: 15 },
  ]

  it('FE-W5COSTS-008: outstanding flows are listed and settling one records the transfer', async () => {
    const posted: Record<string, unknown>[] = []
    server.use(http.post('/api/trips/1/budget/settlements', async ({ request }) => {
      posted.push(await request.json() as Record<string, unknown>)
      return HttpResponse.json({ settlement: { id: 1 } })
    }))
    mount([], { flows: [flows[0]] })

    await screen.findByText('45,00 €')
    // The "you're owed" card names who still owes me.
    expect(screen.getByText("You're owed")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ from_user_id: 2, to_user_id: 1, amount: 45, currency: 'EUR' })
  })

  it('FE-W5COSTS-009: Settle up clears every outstanding flow at once', async () => {
    const posted: Record<string, unknown>[] = []
    server.use(http.post('/api/trips/1/budget/settlements', async ({ request }) => {
      posted.push(await request.json() as Record<string, unknown>)
      return HttpResponse.json({ settlement: { id: 1 } })
    }))
    mount([], { flows })

    const settleAll = await screen.findByRole('button', { name: 'Settle up' })
    await waitFor(() => expect(settleAll).not.toBeDisabled())
    fireEvent.click(settleAll)

    await waitFor(() => expect(posted).toHaveLength(2))
    expect(posted.map(p => p.amount)).toEqual([45, 15])
  })

  it('FE-W5COSTS-010: Settle up is disabled while nothing is outstanding', async () => {
    mount([])

    expect(await screen.findByRole('button', { name: 'Settle up' })).toBeDisabled()
  })

  it('FE-W5COSTS-011: a failing settle surfaces an error toast', async () => {
    const addToast = vi.fn()
    window.__addToast = addToast as unknown as typeof window.__addToast
    server.use(http.post('/api/trips/1/budget/settlements', () => HttpResponse.json({ error: 'no' }, { status: 500 })))
    mount([], { flows: [flows[0]] })

    fireEvent.click(await screen.findByRole('button', { name: 'Settle' }))
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Unknown error', 'error', undefined))

    addToast.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Settle up' }))
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Unknown error', 'error', undefined))
    delete window.__addToast
  })

  it('FE-W5COSTS-012: undoing a payment deletes it, and a failure is reported', async () => {
    const addToast = vi.fn()
    window.__addToast = addToast as unknown as typeof window.__addToast
    let deleted = 0
    server.use(http.delete('/api/trips/1/budget/settlements/7', () => {
      deleted += 1
      return deleted === 1 ? HttpResponse.json({ success: true }) : HttpResponse.json({ error: 'no' }, { status: 500 })
    }))
    mount([], { settlements: [{ id: 7, from_user_id: 2, to_user_id: 1, amount: 30, created_at: '2025-06-16 10:00:00' }] })

    fireEvent.click(await screen.findByTitle('Undo'))
    await waitFor(() => expect(deleted).toBe(1))

    fireEvent.click(screen.getByTitle('Undo'))
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Unknown error', 'error', undefined))
    delete window.__addToast
  })

  it('FE-W5COSTS-059: a settle-up that fails midway still reloads the transfers that went through', async () => {
    const addToast = vi.fn()
    window.__addToast = addToast as unknown as typeof window.__addToast
    let posted = 0
    let reads = 0
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => {
        reads += 1
        return HttpResponse.json({ balances: [], flows: posted > 0 ? [flows[1]] : flows, settlements: [] })
      }),
      http.post('/api/trips/1/budget/settlements', () => {
        posted += 1
        return posted === 1 ? HttpResponse.json({ settlement: { id: 1 } }) : HttpResponse.json({ error: 'no' }, { status: 500 })
      }),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    const settleAll = await screen.findByRole('button', { name: 'Settle up' })
    await waitFor(() => expect(settleAll).not.toBeDisabled())
    const readsBefore = reads
    fireEvent.click(settleAll)

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Unknown error', 'error', undefined))
    // The failed second transfer must not swallow the refresh: bob's 45 € was
    // recorded, and leaving it listed invites a second, doubled settle-up.
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore))
    expect(posted).toBe(2)
    delete window.__addToast
  })

  it('FE-W5COSTS-060: a settlement read that fails says so instead of claiming everyone is square', async () => {
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ error: 'no' }, { status: 500 })),
    )
    render(<CostsPanel tripId={1} tripMembers={tripMembers} />)

    await screen.findByText('Balances')
    // Settle up and Balances both hang off the one failed request.
    await waitFor(() => expect(screen.getAllByText('Unknown error')).toHaveLength(2))
    expect(screen.queryByText("Everyone's square")).toBeNull()
  })

  it('FE-W5COSTS-013: the "you owe" card lists who I still have to pay', async () => {
    mount([], { flows: [{ from: { user_id: 1, username: 'alice' }, to: { user_id: 2, username: 'bob' }, amount: 20 }] })

    await screen.findByText('You owe')
    const card = screen.getByText('You owe').closest('div[style*="border-radius: 22"]') as HTMLElement
    expect(within(card).getByText('To')).toBeInTheDocument()
    expect(within(card).getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('Nothing owed to you')).toBeInTheDocument()
  })
})

describe('CostsPanel — filtering the ledger', () => {
  beforeEach(seedAlice)

  const payment: Payment = { id: 7, from_user_id: 2, to_user_id: 1, amount: 30, created_at: '2025-06-16 10:00:00' }

  it('FE-W5COSTS-014: "Paid by me" keeps only the expenses I fronted', async () => {
    mount([dinner(), taxi()], { settlements: [payment] })

    await screen.findByText('Taxi')
    fireEvent.click(screen.getByRole('button', { name: 'Paid by me' }))

    expect(screen.getByText('Dinner')).toBeInTheDocument()
    expect(screen.queryByText('Taxi')).not.toBeInTheDocument()
    // A transfer I'm part of stays visible under "mine".
    expect(screen.getByText('Payment')).toBeInTheDocument()
  })

  it('FE-W5COSTS-015: "I\'m owed" keeps the expenses I am net positive on and drops payments', async () => {
    mount([dinner(), taxi()], { settlements: [payment] })

    await screen.findByText('Taxi')
    fireEvent.click(screen.getByRole('button', { name: "I'm owed" }))

    expect(screen.getByText('Dinner')).toBeInTheDocument()
    expect(screen.queryByText('Taxi')).not.toBeInTheDocument()
    expect(screen.queryByText('Payment')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-016: the category filter narrows the ledger and hides payments', async () => {
    mount([dinner(), taxi()], { settlements: [payment] })

    await screen.findByText('Taxi')
    fireEvent.click(screen.getByRole('button', { name: /All categories/ }))
    pickOption('Transport')

    expect(screen.getByText('Taxi')).toBeInTheDocument()
    expect(screen.queryByText('Dinner')).not.toBeInTheDocument()
    expect(screen.queryByText('Payment')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-017: picking a single day banners it with that day’s total', async () => {
    mount([dinner(), taxi()], { settlements: [payment] })

    await screen.findByText('Taxi')
    fireEvent.click(screen.getByRole('button', { name: /All days/ }))
    pickOption('Sun, Jun 15')

    expect(screen.getByText('Sunday, June 15')).toBeInTheDocument()
    expect(screen.getByText('1 expenses')).toBeInTheDocument()
    expect(screen.getByText('Dinner')).toBeInTheDocument()
    expect(screen.queryByText('Taxi')).not.toBeInTheDocument()
    // The 16th carries the payment, so it is filtered out with the day too.
    expect(screen.queryByText('Payment')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-018: expenses without a date are grouped under "No date"', async () => {
    mount([expense({ id: 120, name: 'Souvenirs', category: 'shopping', total_price: 12, expense_date: null })])

    expect(await screen.findByText('No date')).toBeInTheDocument()
  })

  it('FE-W5COSTS-019: a search with no hits shows the no-match copy', async () => {
    const user = userEvent.setup()
    mount([dinner()])

    await screen.findByText('Dinner')
    await user.type(screen.getByPlaceholderText('Search expenses…'), 'zzz')

    expect(screen.getByText('No expenses match your search.')).toBeInTheDocument()
    expect(screen.queryByText('Dinner')).not.toBeInTheDocument()
  })
})

describe('CostsPanel — expense rows', () => {
  beforeEach(() => {
    seedAlice()
    clearExchangeRateCache()
  })
  afterEach(clearExchangeRateCache)

  it('FE-W5COSTS-020: each expense row shows who fronted it and the day subtotal', async () => {
    mount([dinner(), taxi()])

    await screen.findByText('Dinner')
    // Each row carries a payer chip plus the row total, both in the base currency.
    expect(screen.getAllByText('90,00 €')).toHaveLength(2)
    expect(screen.getAllByText('30,00 €')).toHaveLength(2)
    // Days are grouped, each with its own spent line.
    expect(screen.getByText('90,00 € spent')).toBeInTheDocument()
    expect(screen.getByText('30,00 € spent')).toBeInTheDocument()
    // Same-currency rows show the category alone, with no conversion suffix.
    expect(screen.getAllByText('Food & drink')).toHaveLength(2)
  })

  it('FE-W5COSTS-021: a foreign-currency expense shows the original and the converted amount', async () => {
    localStorage.setItem('trek_fx_EUR', JSON.stringify({ rates: { EUR: 1, USD: 2 }, ts: Date.now() }))
    mount([expense({
      id: 130, name: 'Diner', category: 'food', total_price: 100, currency: 'USD', expense_date: '2025-06-15',
      payers: [{ user_id: 1, amount: 100 }],
      members: [{ user_id: 1, username: 'alice' }, { user_id: 2, username: 'bob' }],
    })], { settlements: [{ id: 8, from_user_id: 2, to_user_id: 1, amount: 20, currency: 'USD', created_at: '2025-06-15 09:00:00' }] })

    await screen.findByText('Diner')
    expect(screen.getByText(/\$100\.00 → 50,00 €/)).toBeInTheDocument()
    // The payer chip and the settlement row are converted the same way.
    expect(screen.getByText(/\$20\.00 → 10,00 €/)).toBeInTheDocument()
  })

  it('FE-W5COSTS-022: deleting an expense removes it, and a failure is reported', async () => {
    const addToast = vi.fn()
    window.__addToast = addToast as unknown as typeof window.__addToast
    server.use(http.delete('/api/trips/1/budget/101', () => HttpResponse.json({ error: 'no' }, { status: 500 })))
    mount([dinner()])

    await screen.findByText('Dinner')
    fireEvent.click(screen.getByTitle('Delete'))

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Unknown error', 'error', undefined))
    // The optimistic removal is rolled back by the store.
    expect(await screen.findByText('Dinner')).toBeInTheDocument()
    delete window.__addToast
  })

  it('FE-W5COSTS-023: ?create=expense opens the add modal straight away', async () => {
    mount([], {}, ['/trips/1?create=expense'])

    expect(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…')).toBeInTheDocument()
  })

  it('FE-W5COSTS-024: a viewer without edit rights gets no write affordances', async () => {
    seedStore(usePermissionsStore, { permissions: { budget_edit: 'admin' } })
    mount([dinner()], { flows: [{ from: { user_id: 2, username: 'bob' }, to: { user_id: 1, username: 'alice' }, amount: 45 }], settlements: [{ id: 7, from_user_id: 2, to_user_id: 1, amount: 30, created_at: '2025-06-16 10:00:00' }] })

    await screen.findByText('Dinner')
    expect(screen.queryByRole('button', { name: 'Add expense' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settle up' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add payment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settle' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Undo')).not.toBeInTheDocument()
  })
})

describe('CostsPanel — mobile layout', () => {
  const desktopMatchMedia = window.matchMedia

  beforeEach(() => {
    seedAlice()
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('1023'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  })

  afterEach(() => { window.matchMedia = desktopMatchMedia })

  it('FE-W5COSTS-025: the mobile column stacks the totals, owe/owed and outstanding cards', async () => {
    mount([dinner(), expense({ id: 140, name: 'Hotel', category: 'accommodation', total_price: 60, payers: [], members: [{ user_id: 1, username: 'alice' }] })], {
      flows: [{ from: { user_id: 2, username: 'bob' }, to: { user_id: 1, username: 'alice' }, amount: 45 }],
    })

    await screen.findByText('Hotel')
    // The desktop summary grid is replaced by the mobile stack.
    expect(document.querySelector('.costs-summary')).toBeNull()
    expect(screen.getByText('Total trip spend')).toBeInTheDocument()
    expect(screen.getByText('You owe')).toBeInTheDocument()
    expect(screen.getByText("You're owed")).toBeInTheDocument()
    expect(screen.getByText('Outstanding amount')).toBeInTheDocument()
    // The unfinished expense is flagged with a badge on its icon instead of a pill.
    expect(screen.getByTitle('Total only — not settled yet')).toHaveTextContent('!')
    expect(screen.queryByText('Unfinished')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-026: the mobile ledger keeps search, filters and the empty text', async () => {
    const user = userEvent.setup()
    mount([dinner()])

    await screen.findByText('Dinner')
    await user.type(screen.getByPlaceholderText('Search expenses…'), 'zzz')
    expect(screen.getByText('No expenses match your search.')).toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Search expenses…'))
    fireEvent.click(screen.getByRole('button', { name: /All days/ }))
    pickOption('Sun, Jun 15')
    expect(screen.getByText('Sunday, June 15')).toBeInTheDocument()
  })

  it('FE-W5COSTS-027: the mobile total card opens the add-expense modal', async () => {
    mount([])

    // isMobile settles in an effect, which swaps the whole body out.
    await waitFor(() => expect(document.querySelector('.costs-summary')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Add expense' }))

    expect(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…')).toBeInTheDocument()
  })
})

describe('CostsPanel — payment modal', () => {
  beforeEach(seedAlice)

  it('FE-W5COSTS-028: editing a payment updates it in place', async () => {
    const user = userEvent.setup()
    let put: Record<string, unknown> | null = null
    server.use(http.put('/api/trips/1/budget/settlements/7', async ({ request }) => {
      put = await request.json() as Record<string, unknown>
      return HttpResponse.json({ settlement: { id: 7 } })
    }))
    mount([], { settlements: [{ id: 7, from_user_id: 2, to_user_id: 1, amount: 30, created_at: '2025-06-16 10:00:00' }] })

    await user.click(await screen.findByTitle('Edit'))
    const amount = await screen.findByPlaceholderText('0.00')
    await user.clear(amount)
    await user.type(amount, '12,50')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(put).toBeTruthy())
    expect(put).toMatchObject({ from_user_id: 2, to_user_id: 1, amount: 12.5 })
  })

  it('FE-W5COSTS-029: a transfer to yourself cannot be saved', async () => {
    const user = userEvent.setup()
    mount([])

    await user.click(await screen.findByRole('button', { name: 'Add payment' }))
    await user.type(await screen.findByPlaceholderText('0.00'), '10')

    // Default is You → bob; pointing "to" back at me makes it a no-op transfer.
    await user.click(screen.getByRole('button', { name: 'bob' }))
    pickOption('You')

    const submits = screen.getAllByRole('button', { name: 'Add payment' })
    expect(submits[submits.length - 1]).toBeDisabled()
  })

  it('FE-W5COSTS-030: a failing payment save is reported', async () => {
    const user = userEvent.setup()
    const addToast = vi.fn()
    window.__addToast = addToast as unknown as typeof window.__addToast
    server.use(http.post('/api/trips/1/budget/settlements', () => HttpResponse.json({ error: 'no' }, { status: 500 })))
    mount([])

    await user.click(await screen.findByRole('button', { name: 'Add payment' }))
    await user.type(await screen.findByPlaceholderText('0.00'), '10')
    const submits = screen.getAllByRole('button', { name: 'Add payment' })
    await user.click(submits[submits.length - 1])

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Unknown error', 'error', undefined))
    delete window.__addToast
  })
})

describe('CostsPanel — expense modal', () => {
  beforeEach(() => {
    seedAlice()
    clearExchangeRateCache()
  })
  afterEach(clearExchangeRateCache)

  const openAdd = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…')
  }

  it('FE-W5COSTS-031: reopening a ticket expense restores its items and lets them be edited', async () => {
    const user = userEvent.setup()
    let put: Record<string, unknown> | null = null
    const note = 'TICKETJSON:' + JSON.stringify({ items: [
      { name: 'Apples', price: '10', parts: [1, 2] },
      { name: 'Cake', price: '20', parts: [2] },
    ] })
    server.use(http.put('/api/trips/1/budget/150', async ({ request }) => {
      put = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([expense({ id: 150, name: 'Market run', category: 'groceries', total_price: 30, note, payers: [{ user_id: 1, amount: 30 }], members: [{ user_id: 1, username: 'alice', amount: 15 }, { user_id: 2, username: 'bob', amount: 15 }] })])

    await screen.findByText('Market run')
    await user.click(screen.getByTitle('Edit'))

    expect(await screen.findByDisplayValue('Apples')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Cake')).toBeInTheDocument()

    // Drop the second item and take Bob off the first one.
    const rows = screen.getAllByPlaceholderText('Item name')
    await user.click(rows[1].parentElement!.parentElement!.querySelectorAll('button')[0])
    expect(screen.queryByDisplayValue('Cake')).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /bob/i })[0])

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toBeTruthy())
    expect(put!.total_price).toBe(10)
    expect(put!.members).toEqual(expect.arrayContaining([expect.objectContaining({ user_id: 1, amount: 10 })]))
  })

  it('FE-W5COSTS-032: an unparsable ticket note opens with an empty item list', async () => {
    const user = userEvent.setup()
    mount([expense({ id: 151, name: 'Market run', category: 'groceries', total_price: 30, note: 'TICKETJSON:{oops', payers: [{ user_id: 1, amount: 30 }], members: [{ user_id: 1, username: 'alice' }] })])

    await screen.findByText('Market run')
    await user.click(screen.getByTitle('Edit'))

    expect(await screen.findByRole('button', { name: /Add item/i })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Item name')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('FE-W5COSTS-033: reopening a custom split restores the per-member amounts', async () => {
    const user = userEvent.setup()
    let put: Record<string, unknown> | null = null
    server.use(http.put('/api/trips/1/budget/160', async ({ request }) => {
      put = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([expense({
      id: 160, name: 'Dinner', category: 'food', total_price: 100,
      payers: [{ user_id: 1, amount: 100 }],
      members: [{ user_id: 1, username: 'alice', amount: 70 }, { user_id: 2, username: 'bob', amount: 30 }],
    })])

    await screen.findByText('Dinner')
    await user.click(screen.getByTitle('Edit'))

    // Custom shares reopen padded to two decimals (#2175), localized for EUR.
    expect((await screen.findByDisplayValue('70,00')).tagName).toBe('INPUT')
    expect(screen.getByDisplayValue('30,00')).toBeInTheDocument()

    // Excluding Bob drops his amount; the split no longer matches the total.
    await user.click(screen.getByRole('button', { name: /bob/i }))
    expect(screen.getByText(/Sum of splits/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // Bringing him back in via the excluded-state hint restores an empty field,
    // pre-filled as a placeholder with what is still missing from the total.
    await user.click(screen.getByRole('button', { name: 'Tap to include' }))
    await user.type(screen.getByPlaceholderText('30,00'), '30')

    expect(screen.getByText('Split matches total')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toBeTruthy())
    expect(put!.members).toEqual([{ user_id: 1, amount: 70 }, { user_id: 2, amount: 30 }])
  })

  it('FE-W5COSTS-034: changing the currency previews the converted total', async () => {
    const user = userEvent.setup()
    localStorage.setItem('trek_fx_EUR', JSON.stringify({ rates: { EUR: 1, USD: 2 }, ts: Date.now() }))
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([])
    await openAdd(user)

    await user.type(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Diner')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '100')
    await user.click(screen.getByText(/^EUR/))
    await user.click(await screen.findByText(/^USD/))

    expect(screen.getByText('live rate', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('$100.00')).toBeInTheDocument()
    expect(screen.getByText('50,00 €')).toBeInTheDocument()

    // A different category than the default is carried into the payload.
    await user.click(screen.getByRole('button', { name: 'Sightseeing' }))
    const submits = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(submits[submits.length - 1])

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted).toMatchObject({ currency: 'USD', category: 'sightseeing', total_price: 100 })
  })

  it('FE-W5COSTS-035: collapsing multi-payer mode keeps the first payer for the whole bill', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([])
    await openAdd(user)

    await user.type(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '90')
    await user.click(screen.getByRole('button', { name: 'Multiple people paid' }))
    await user.click(screen.getAllByTestId('payer-toggle')[1])
    // Dropping Bob again leaves Alice absorbing the whole amount.
    await user.click(screen.getAllByTestId('payer-toggle')[1])
    expect(screen.getByRole('button', { name: 'Tap to include' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'One person paid' }))

    const submits = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(submits[submits.length - 1])

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.payers).toEqual([{ user_id: 1, amount: 90 }])
  })

  it('FE-W5COSTS-036: a nobody-paid expense can be recorded from the payer dropdown', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([])
    await openAdd(user)

    await user.type(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Hotel')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '120')
    await user.click(screen.getByRole('button', { name: 'You' }))
    pickOption('No one paid yet')

    const submits = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(submits[submits.length - 1])

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.payers).toEqual([])
    expect(posted!.member_ids).toEqual([1, 2])
  })

  it('FE-W5COSTS-037: a failing expense save is reported and the modal stays open', async () => {
    const user = userEvent.setup()
    const addToast = vi.fn()
    window.__addToast = addToast as unknown as typeof window.__addToast
    server.use(http.post('/api/trips/1/budget', () => HttpResponse.json({ error: 'no' }, { status: 500 })))
    mount([])
    await openAdd(user)

    await user.type(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '90')
    const submits = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(submits[submits.length - 1])

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Unknown error', 'error', undefined))
    expect(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…')).toBeInTheDocument()
    delete window.__addToast
  })

  it('FE-W5COSTS-038: a prefilled expense opens with the booking’s name, amount and category', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    const onSaved = vi.fn()
    render(
      <ExpenseModal tripId={1} base="EUR" people={tripMembers} me={1} editing={null}
        prefill={{ name: 'Hotel Astoria', category: 'accommodation', amount: 240, reservationId: 12 }}
        onClose={() => {}} onSaved={onSaved} />
    )

    expect(screen.getByDisplayValue('Hotel Astoria')).toBeInTheDocument()
    // The prefilled amount is padded to the base currency's decimals (#2175).
    expect(screen.getByDisplayValue('240,00')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add expense' }))

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted).toMatchObject({ name: 'Hotel Astoria', category: 'accommodation', total_price: 240, reservation_id: 12 })
    expect(onSaved).toHaveBeenCalled()
  })

  // The mobile sheet already dates a new expense by the traveller's own clock;
  // the desktop modal filed it under the UTC day, so the same expense entered
  // late in Tokyo or early in Los Angeles landed on a different day per surface.
  it('FE-W5COSTS-065: a new expense is dated by the local calendar day, not the UTC one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // A wall-clock time on whichever side of midnight puts the runner's UTC date
    // on a different day. On UTC itself the two spellings agree and there is
    // nothing here to catch.
    const behindUtc = new Date(2026, 7, 12).getTimezoneOffset() > 0
    vi.setSystemTime(new Date(2026, 7, 12, behindUtc ? 23 : 1, 30, 0))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    render(
      <ExpenseModal tripId={1} base="EUR" people={tripMembers} me={1} editing={null}
        prefill={{ name: 'Ramen', category: 'food', amount: 18 }}
        onClose={() => {}} onSaved={vi.fn()} />
    )

    await user.click(screen.getByRole('button', { name: 'Add expense' }))

    try {
      await waitFor(() => expect(posted).toBeTruthy())
      expect(posted!.expense_date).toBe('2026-08-12')
    } finally {
      vi.useRealTimers()
    }
  })

  it('FE-W5COSTS-038b: a prefill from a place links the expense to that place (#1298)', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    render(
      <ExpenseModal tripId={1} base="EUR" people={tripMembers} me={1} editing={null}
        prefill={{ name: 'Louvre', category: 'activities', amount: 34, placeId: 7 }}
        onClose={() => {}} onSaved={vi.fn()} />
    )

    await user.click(screen.getByRole('button', { name: 'Add expense' }))

    await waitFor(() => expect(posted).toBeTruthy());
    expect(posted).toMatchObject({ name: 'Louvre', category: 'activities', total_price: 34, place_id: 7 })
    expect(posted).not.toHaveProperty('reservation_id')
  })
})

describe('CostsPanel — remaining paths', () => {
  beforeEach(seedAlice)

  it('FE-W5COSTS-042: the CSV export escapes, orders and strips ticket notes', async () => {
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR', title: '///' }) })
    let exported: Blob | null = null
    let downloadName = ''
    const createObjURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { exported = b as Blob; return 'blob:mock' })
    const revokeObjURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download })
    mount([
      expense({ id: 201, name: 'Dinner "deluxe"', category: 'food', total_price: 90, expense_date: '2025-06-15', note: 'with;semicolon' }),
      expense({ id: 202, name: 'Tickets', category: 'activities', total_price: 20, expense_date: '2025-06-14', note: 'TICKETJSON:{"items":[]}' }),
      expense({ id: 203, name: 'Tip', category: 'tips', total_price: 5, expense_date: null, note: null }),
    ])

    await screen.findByText('Tip')
    fireEvent.click(screen.getByTitle('Export CSV'))

    const lines = (await exported!.text()).replace(/^\uFEFF/, '').split('\r\n')
    expect(lines[0]).toBe('Date;Name;Category;Amount;Currency;Amount (EUR);Note')
    // Oldest first, dateless rows leading.
    expect(lines[1]).toBe(';Tip;Tips;5.00;EUR;5.00;')
    // The ticket payload is machine data, so it never reaches the note column.
    expect(lines[2]).toBe('06/14/2025;Tickets;Activities;20.00;EUR;20.00;')
    expect(lines[3]).toBe('06/15/2025;"Dinner ""deluxe""";Food & drink;90.00;EUR;90.00;"with;semicolon"')
    // A title made only of illegal characters still yields a usable file name.
    expect(downloadName).toBe('costs-.csv')
    createObjURL.mockRestore(); revokeObjURL.mockRestore(); clickSpy.mockRestore()
  })

  it('FE-W5COSTS-061: the CSV export neutralises names a spreadsheet would run as a formula', async () => {
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR', title: 'Rome' }) })
    let exported: Blob | null = null
    const createObjURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { exported = b as Blob; return 'blob:mock' })
    const revokeObjURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    mount([
      expense({ id: 204, name: '=HYPERLINK("http://evil","click")', category: 'food', total_price: 12, expense_date: '2025-06-15', note: '@SUM(A1:A9)' }),
      expense({ id: 205, name: '-5 refund', category: 'misc', total_price: 5, expense_date: '2025-06-16', note: null }),
    ])

    await screen.findByText('-5 refund')
    fireEvent.click(screen.getByTitle('Export CSV'))

    const lines = (await exported!.text()).replace(/^\uFEFF/, '').split('\r\n')
    expect(lines[1]).toBe('06/15/2025;"\'=HYPERLINK(""http://evil"",""click"")";Food & drink;12.00;EUR;12.00;\'@SUM(A1:A9)')
    expect(lines[2]).toBe('06/16/2025;\'-5 refund;Other;5.00;EUR;5.00;')
    createObjURL.mockRestore(); revokeObjURL.mockRestore(); clickSpy.mockRestore()
  })

  it('FE-W5COSTS-043: deleting an expense drops it from the ledger', async () => {
    let deleted = false
    server.use(http.delete('/api/trips/1/budget/101', () => { deleted = true; return HttpResponse.json({ success: true }) }))
    mount([dinner()])

    await screen.findByText('Dinner')
    fireEvent.click(screen.getByTitle('Delete'))

    await waitFor(() => expect(deleted).toBe(true))
    expect(screen.queryByText('Dinner')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-044: both modals can be dismissed with Cancel', async () => {
    const user = userEvent.setup()
    mount([])

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('e.g. Dinner, souvenirs, gas…')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add payment' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('0.00')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-045: an explicit member amount is used as my share instead of an equal split', async () => {
    mount([expense({
      id: 210, name: 'Dinner', category: 'food', total_price: 100,
      payers: [{ user_id: 2, amount: 100 }],
      members: [{ user_id: 1, username: 'alice', amount: 80 }, { user_id: 2, username: 'bob', amount: 20 }],
    })])

    await screen.findByText('Dinner')
    const card = screen.getByText('Total trip spend').closest('div[style*="border-radius: 22"]') as HTMLElement
    // Not the 50/50 an equal split would have produced.
    expect(within(card).getByText('80 €')).toBeInTheDocument()
    expect(within(card).getByText('0 €')).toBeInTheDocument()
  })

  it('FE-W5COSTS-046: an expense I am not part of contributes nothing to my share', async () => {
    mount([expense({
      id: 211, name: 'Bob solo', category: 'food', total_price: 40,
      payers: [{ user_id: 2, amount: 40 }],
      members: [{ user_id: 2, username: 'bob' }],
    })])

    await screen.findByText('Bob solo')
    const card = screen.getByText('Total trip spend').closest('div[style*="border-radius: 22"]') as HTMLElement
    expect(within(card).getAllByText('0 €')).toHaveLength(2)
  })

  it('FE-W5COSTS-047: with no display and no trip currency the panel falls back to euro', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: '' } })
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: '' }) })
    mount([expense({ id: 220, name: 'Dinner', category: 'food', total_price: 90, currency: null })])

    await screen.findByText('Dinner')
    const card = screen.getByText('Total trip spend').closest('div[style*="border-radius: 22"]')
    expect(card).toHaveTextContent('90,00 €')
  })

  it('FE-W5COSTS-048: a payment in a currency with no symbol keeps its code, and the sender can be swapped', async () => {
    const user = userEvent.setup()
    let put: Record<string, unknown> | null = null
    server.use(http.put('/api/trips/1/budget/settlements/9', async ({ request }) => {
      put = await request.json() as Record<string, unknown>
      return HttpResponse.json({ settlement: { id: 9 } })
    }))
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({
        balances: [], flows: [],
        settlements: [{ id: 9, from_user_id: 2, to_user_id: 1, amount: 30, currency: 'XBT', created_at: '2025-06-16 10:00:00' }],
      })),
    )
    render(<CostsPanel tripId={1} tripMembers={[...tripMembers, { id: 3, username: 'cara', avatar_url: null }]} />)

    await user.click(await screen.findByTitle('Edit'))
    // No symbol is known, so the code itself prefixes the amount and labels the option.
    await screen.findByPlaceholderText('0.00')
    expect(screen.getAllByText('XBT').length).toBeGreaterThanOrEqual(2)

    await user.click(screen.getByRole('button', { name: 'bob' }))
    pickOption('cara')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(put).toBeTruthy())
    expect(put).toMatchObject({ from_user_id: 3, to_user_id: 1, amount: 30, currency: 'XBT' })
  })

  it('FE-W5COSTS-055: an expense in a currency with no symbol prefixes the code', async () => {
    const user = userEvent.setup()
    mount([expense({ id: 240, name: 'Mining rig', category: 'other', total_price: 2, currency: 'XBT', payers: [{ user_id: 1, amount: 2 }], members: [{ user_id: 1, username: 'alice' }] })])

    await screen.findByText('Mining rig')
    await user.click(screen.getByTitle('Edit'))

    // XBT is unknown to the locale map → dot separator, two decimals (#2175).
    expect(await screen.findByDisplayValue('2.00')).toBeInTheDocument()
    expect(screen.getAllByText('XBT').length).toBeGreaterThanOrEqual(2)
  })

  it('FE-W5COSTS-049: a solo trip defaults the payment counterpart to myself', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={[{ id: 1, username: 'alice', avatar_url: null }]} />)

    await user.click(await screen.findByRole('button', { name: 'Add payment' }))
    await user.type(await screen.findByPlaceholderText('0.00'), '10')

    // From and To both resolve to me, so the transfer stays unsavable.
    const submits = screen.getAllByRole('button', { name: 'Add payment' })
    expect(submits[submits.length - 1]).toBeDisabled()
  })

  it('FE-W5COSTS-050: the expense modal shows uploaded avatars and rejects over-precise input', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={[
      { id: 1, username: 'alice', avatar_url: '/uploads/avatars/a.png' },
      { id: 2, username: 'bob', avatar_url: '/uploads/avatars/b.png' },
    ]} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '100')

    // Payer rows and split rows both fall back to the uploaded picture.
    await user.click(screen.getByRole('button', { name: 'Multiple people paid' }))
    expect(document.querySelectorAll('img[src="/uploads/avatars/b.png"]').length).toBeGreaterThanOrEqual(2)

    // Excluding Bob leaves the include hint; tapping it puts him back on the bill.
    await user.click(screen.getAllByTestId('payer-toggle')[1])
    await user.click(screen.getAllByTestId('payer-toggle')[1])
    await user.click(screen.getByRole('button', { name: 'Tap to include' }))
    expect(screen.getAllByTestId('payer-amount')).toHaveLength(2)

    // Three decimals are not a valid money amount, so the field ignores them.
    await user.click(screen.getByRole('button', { name: 'Custom' }))
    const splitInput = screen.getAllByPlaceholderText('50,00')[0] as HTMLInputElement
    await user.type(splitInput, '12,345')
    expect(splitInput.value).toBe('12,34')
  })

  it('FE-W5COSTS-051: ticket prices ignore an over-precise entry and participants toggle back on', async () => {
    const user = userEvent.setup()
    mount([])

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Groceries')
    await user.click(screen.getByRole('button', { name: 'Ticket' }))
    await user.click(screen.getByRole('button', { name: /Add item/i }))

    await user.type(screen.getByPlaceholderText('Item name'), 'Apples')
    const price = screen.getAllByPlaceholderText('0,00')[1] as HTMLInputElement
    await user.type(price, '10,999')
    expect(price.value).toBe('10,99')

    // Toggling a participant off and on again leaves the shares unchanged.
    const bob = screen.getAllByRole('button', { name: /bob/i })[0]
    await user.click(bob)
    await user.click(bob)
    // 10.99 across two people leaves the odd cent with the lower user id.
    expect(screen.getByText('Individual shares')).toBeInTheDocument()
    expect(screen.getByText('€5.50')).toBeInTheDocument()
    expect(screen.getByText('€5.49')).toBeInTheDocument()
  })
})

describe('CostsPanel — split modes and guests', () => {
  beforeEach(seedAlice)

  it('FE-W5COSTS-056: switching back to an equal split restores the per-head amounts', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([])

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(screen.getByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Dinner')
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '90')

    await user.click(screen.getByRole('button', { name: 'Custom' }))
    expect(screen.getByText(/Sum of splits/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Equally' }))
    expect(screen.getByText('Split 2 ways · €45.00 each')).toBeInTheDocument()

    const submits = screen.getAllByRole('button', { name: 'Add expense' })
    await user.click(submits[submits.length - 1])
    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.members).toEqual([{ user_id: 1, amount: null }, { user_id: 2, amount: null }])
  })

  it('FE-W5COSTS-057: multi-payer on a payer-less expense seeds and collapses back to me', async () => {
    const user = userEvent.setup()
    let put: Record<string, unknown> | null = null
    server.use(http.put('/api/trips/1/budget/250', async ({ request }) => {
      put = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([expense({
      id: 250, name: 'Hotel', category: 'accommodation', total_price: 120,
      payers: [], members: [{ user_id: 1, username: 'alice' }, { user_id: 2, username: 'bob' }],
    })])

    await screen.findByText('Hotel')
    await user.click(screen.getByTitle('Edit'))

    // Nobody paid, so switching to multi-payer seeds me as the only payer.
    await user.click(await screen.findByRole('button', { name: 'Multiple people paid' }))
    expect(screen.getAllByTestId('payer-amount')).toHaveLength(1)

    // Dropping myself leaves the list empty; collapsing then falls back to me.
    await user.click(screen.getAllByTestId('payer-toggle')[0])
    expect(screen.queryAllByTestId('payer-amount')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'One person paid' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(put).toBeTruthy())
    expect(put!.payers).toEqual([{ user_id: 1, amount: 120 }])
  })

  it('FE-W5COSTS-058: a guest traveler is badged in the split list', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget/settlement', () => HttpResponse.json({ balances: [], flows: [], settlements: [] })),
    )
    render(<CostsPanel tripId={1} tripMembers={[
      { id: 1, username: 'alice', avatar_url: null },
      { id: 2, username: 'gus', avatar_url: '/uploads/avatars/g.png', is_guest: true },
    ]} />)

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.click(screen.getByRole('button', { name: 'Ticket' }))
    await user.click(screen.getByRole('button', { name: /Add item/i }))

    // The uploaded picture is reused for the per-item participant chips.
    expect(document.querySelectorAll('img[src="/uploads/avatars/g.png"]').length).toBeGreaterThanOrEqual(2)
    await user.click(screen.getByRole('button', { name: 'Equally' }))
    expect(screen.getByText('Guest')).toBeInTheDocument()
  })
})

describe('CostsPanel — mobile extras', () => {
  const desktopMatchMedia = window.matchMedia

  beforeEach(() => {
    seedAlice()
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('1023'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  })

  afterEach(() => { window.matchMedia = desktopMatchMedia })

  it('FE-W5COSTS-052: the mobile ledger filters by owner and by category', async () => {
    mount([dinner(), taxi()])

    await screen.findByText('Taxi')
    fireEvent.click(screen.getByRole('button', { name: 'Paid by me' }))
    expect(screen.queryByText('Taxi')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: /All categories/ }))
    pickOption('Transport')
    expect(screen.getByText('Taxi')).toBeInTheDocument()
    expect(screen.queryByText('Dinner')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-053: the mobile settle-up card can record a manual payment', async () => {
    mount([])

    await waitFor(() => expect(document.querySelector('.costs-summary')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Add payment' }))

    expect(await screen.findByPlaceholderText('0.00')).toBeInTheDocument()
  })

  it('FE-W5COSTS-062: the mobile search box keeps the caret across keystrokes', async () => {
    const user = userEvent.setup()
    mount([dinner(), taxi()])

    await screen.findByText('Taxi')
    const box = screen.getByPlaceholderText('Search expenses…')
    await user.type(box, 'din')

    // The whole word has to land: if the body is remounted per keystroke the input
    // loses focus and everything after the first character goes nowhere.
    expect((box as HTMLInputElement).value).toBe('din')
    expect(document.activeElement).toBe(box)
    expect(screen.queryByText('Taxi')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-054: an unknown currency degrades to a plain amount on mobile too', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: '' } })
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'XX' }) })
    mount([expense({ id: 230, name: 'Mystery', category: 'other', total_price: 90 })])

    await screen.findByText('Mystery')
    expect(screen.getByText('Total trip spend').parentElement).toHaveTextContent('90.00 XX')
  })
})

// ── #2175: edit inputs are padded to the currency's decimals ────────────────
describe('CostsPanel — decimal padding on edit (#2175)', () => {
  beforeEach(() => {
    seedAlice()
    clearExchangeRateCache()
  })
  afterEach(clearExchangeRateCache)

  it('FE-W5COSTS-066: reopens 4,90 as "4,90" and 5,00 as "5,00", not "4,9" and "5"', async () => {
    const user = userEvent.setup()
    mount([
      expense({ id: 301, name: 'Coffee', category: 'food', total_price: 4.9, payers: [{ user_id: 1, amount: 4.9 }], members: [{ user_id: 1, username: 'alice' }] }),
      expense({ id: 302, name: 'Toll', category: 'transport', total_price: 5, payers: [{ user_id: 1, amount: 5 }], members: [{ user_id: 1, username: 'alice' }] }),
    ])

    await screen.findByText('Coffee')
    await user.click(screen.getAllByTitle('Edit')[0])
    expect(await screen.findByDisplayValue('4,90')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getAllByTitle('Edit')[1])
    expect(await screen.findByDisplayValue('5,00')).toBeInTheDocument()
  })

  it('FE-W5COSTS-071: a three-decimal currency seeds three places and the split field still takes input', async () => {
    const user = userEvent.setup()
    render(<ExpenseModal tripId={1} base="KWD" people={tripMembers} me={1} onClose={() => {}} onSaved={vi.fn()}
      editing={expense({
        id: 340, name: 'Museum', category: 'activities', currency: 'KWD', total_price: 3,
        payers: [{ user_id: 1, amount: 3 }],
        members: [{ user_id: 1, username: 'alice', amount: 1.5 }, { user_id: 2, username: 'bob', amount: 1.5 }],
      })} />)

    expect(await screen.findByDisplayValue('3.000')).toBeInTheDocument()
    const shares = screen.getAllByDisplayValue('1.500') as HTMLInputElement[]

    // The seed is three decimals, so a two-decimal guard would reject every further
    // keystroke, including one typed in front of the decimal point.
    await user.type(shares[0], '2', { initialSelectionStart: 0, initialSelectionEnd: 0 })
    expect(shares[0].value).toBe('21.500')

    // A fourth decimal is still not a fils.
    await user.clear(shares[1])
    await user.type(shares[1], '1.5005')
    expect(shares[1].value).toBe('1.500')
  })
})

// ── #2176: negative amounts record partial reimbursements ───────────────────
describe('CostsPanel — negative amounts (#2176)', () => {
  beforeEach(() => {
    seedAlice()
    clearExchangeRateCache()
  })
  afterEach(clearExchangeRateCache)

  it('FE-W5COSTS-067: "-100" can be typed and saves a negative expense with its payer', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    server.use(http.post('/api/trips/1/budget', async ({ request }) => {
      posted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: { ...buildBudgetItem({ trip_id: 1, name: 'Hotel refund' }), id: 12 } })
    }))
    mount([])

    await user.click(await screen.findByRole('button', { name: 'Add expense' }))
    await user.type(await screen.findByPlaceholderText('e.g. Dinner, souvenirs, gas…'), 'Hotel refund')
    // The reported symptom: the '-' was stripped on input, so this was untypeable.
    await user.type(screen.getAllByPlaceholderText('0,00')[0], '-100')

    const submits = screen.getAllByRole('button', { name: 'Add expense' })
    expect(submits[submits.length - 1]).not.toBeDisabled()
    await user.click(submits[submits.length - 1])

    await waitFor(() => expect(posted).toBeTruthy())
    expect(posted!.total_price).toBe(-100)
    expect(posted!.payers).toEqual([{ user_id: 1, amount: -100 }])
    expect(posted!.member_ids).toEqual([1, 2])
  })

  it('FE-W5COSTS-068: a refund reopens with its negative payer intact and saves it back', async () => {
    const user = userEvent.setup()
    let put: Record<string, unknown> | null = null
    server.use(http.put('/api/trips/1/budget/310', async ({ request }) => {
      put = await request.json() as Record<string, unknown>
      return HttpResponse.json({ item: dinner() })
    }))
    mount([expense({
      id: 310, name: 'Hotel refund', category: 'lodging', total_price: -100,
      payers: [{ user_id: 1, amount: -100 }],
      members: [{ user_id: 1, username: 'alice' }, { user_id: 2, username: 'bob' }],
    })])

    // The row shows the amount twice — total pill and the payer chip, which used
    // to be filtered to positive amounts and left the refund's recipient invisible.
    const row = (await screen.findByText('Hotel refund')).closest('.exp-row') as HTMLElement
    expect(within(row).getAllByText(/100,00/).length).toBeGreaterThanOrEqual(2)
    // Not "Unfinished": the refund has its recipient recorded.
    expect(within(row).queryByText('Unfinished')).toBeNull()

    await user.click(screen.getByTitle('Edit'))
    // The negative payer reopens selected instead of resetting to "Nobody",
    // and the total is seeded signed and padded.
    expect(await screen.findByRole('button', { name: 'You' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('-100,00')).toBeInTheDocument()

    // Saving untouched must not silently drop the negative payer.
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toBeTruthy())
    expect(put!.total_price).toBe(-100)
    expect(put!.payers).toEqual([{ user_id: 1, amount: -100 }])
  })

  it('FE-W5COSTS-069: a payer-less refund is marked Unfinished like a payer-less bill', async () => {
    mount([expense({ id: 320, name: 'Pending refund', category: 'misc', total_price: -50, payers: [], members: [{ user_id: 1, username: 'alice' }] })])

    await screen.findByText('Pending refund')
    expect(screen.getByText('Unfinished')).toBeInTheDocument()
  })

  it('FE-W5COSTS-070: the category breakdown nets refunds and keeps a net-negative category listed', async () => {
    mount([
      expense({ id: 330, name: 'Dinner', category: 'food', total_price: 90, payers: [{ user_id: 1, amount: 90 }], members: [{ user_id: 1, username: 'alice' }] }),
      expense({ id: 331, name: 'Meal refund', category: 'food', total_price: -30, payers: [{ user_id: 1, amount: -30 }], members: [{ user_id: 1, username: 'alice' }] }),
      expense({ id: 332, name: 'Cancelled tour', category: 'activities', total_price: -20, payers: [{ user_id: 1, amount: -20 }], members: [{ user_id: 1, username: 'alice' }] }),
    ])

    await screen.findByText('Dinner')
    const breakdown = screen.getByText('By category').parentElement as HTMLElement
    // Food nets 90 − 30 = 60; the fully refunded tour keeps a row of its own.
    expect(within(breakdown).getByText('60 €')).toBeInTheDocument()
    expect(within(breakdown).getByText(/[-−]20\s*€/)).toBeInTheDocument()
  })

  it('FE-W5COSTS-072: the custom-split hint reads under and over the right way round on a refund', async () => {
    const user = userEvent.setup()
    render(<ExpenseModal tripId={1} base="EUR" people={tripMembers} me={1} onClose={() => {}} onSaved={vi.fn()}
      editing={expense({
        id: 341, name: 'Hotel refund', category: 'accommodation', total_price: -100,
        payers: [{ user_id: 1, amount: -100 }],
        members: [{ user_id: 1, username: 'alice', amount: -70 }, { user_id: 2, username: 'bob' }],
      })} />)

    // -70 of -100: 30 still to hand out, not 30 too much.
    expect(await screen.findByText('Sum of splits: €-70.00 of €-100.00 (under by €30.00)')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('-30,00'), '-40')
    expect(screen.getByText('Sum of splits: €-110.00 of €-100.00 (over by €10.00)')).toBeInTheDocument()
  })

  it('FE-W5COSTS-073: the total can be turned into a refund without a minus key', async () => {
    const user = userEvent.setup()
    render(<ExpenseModal tripId={1} base="EUR" people={tripMembers} me={1} editing={null}
      onClose={() => {}} onSaved={vi.fn()} />)

    const total = (await screen.findAllByPlaceholderText('0,00'))[0] as HTMLInputElement
    await user.type(total, '100')

    // The iOS decimal pad has no minus key, so the sign has to be reachable without one.
    const toggle = screen.getByRole('button', { name: 'Switch between expense and refund' })
    await user.click(toggle)

    expect(total.value).toBe('-100')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('CostsPanel — split maths', () => {
  it('FE-W5COSTS-039: an equal split with nobody to split with is empty', () => {
    expect(splitEqualShares(90, [], 1)).toEqual({})
  })

  it('FE-W5COSTS-040: the equal split spreads the remainder cents by item id', () => {
    // 10.00 over 3 people = 3.34 / 3.33 / 3.33, with the extra cent rotating per item.
    expect(splitEqualShares(10, [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }], 0)).toEqual({ 1: 3.34, 2: 3.33, 3: 3.33 })
    expect(splitEqualShares(10, [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }], 1)).toEqual({ 1: 3.33, 2: 3.34, 3: 3.33 })
  })

  it('FE-W5COSTS-041: a receipt line nobody is assigned to is carried by everyone on the receipt', () => {
    const items: TicketItem[] = [
      { id: 'a', name: 'Apples', price: '10', participants: new Set([1, 2]) },
      { id: 'b', name: 'Service', price: '5', participants: new Set() },
      { id: 'c', name: 'Cake', price: 'x', participants: new Set([2]) },
    ]

    // The service line used to count toward the total without landing on anyone,
    // so the shares stayed a permanent 5.00 short of it (#1382).
    expect(calculateTicketShares(items)).toEqual({ shares: { 1: 7.5, 2: 7.5 }, total: 15 })
  })
})

// The reworked expense modal shipped with English written straight into the JSX,
// so the receipt panel and the split summary stayed English on a German phone
// while everything around them translated.
describe('CostsPanel — expense modal in another language', () => {
  beforeEach(() => {
    seedAlice()
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'de', default_currency: 'EUR' }) })
    clearExchangeRateCache()
  })
  afterEach(clearExchangeRateCache)

  const openModal = () => render(
    <ExpenseModal tripId={1} base="EUR" people={tripMembers} me={1} editing={null}
      onClose={() => {}} onSaved={vi.fn()} />
  )

  it('FE-W5COSTS-063: the receipt panel is translated', async () => {
    const user = userEvent.setup()
    openModal()

    // The locale bundle is fetched, so the first paint is still English.
    await user.click(await screen.findByRole('button', { name: 'Beleg' }))
    await user.click(screen.getByRole('button', { name: /Artikel hinzufügen/ }))

    expect(screen.getByPlaceholderText('Artikelname')).toBeInTheDocument()
    expect(screen.getByText('Aufteilen auf:')).toBeInTheDocument()
    expect(screen.getByText('Anteil pro Person')).toBeInTheDocument()
    expect(screen.queryByText('Individual shares')).not.toBeInTheDocument()
  })

  it('FE-W5COSTS-064: the split summary and the excluded marker are translated', async () => {
    const user = userEvent.setup()
    openModal()

    await user.type(await screen.findByPlaceholderText('0,00'), '90')
    await user.click(screen.getByRole('button', { name: 'Individuell' }))

    // Nothing entered yet, so the whole 90 is still unaccounted for.
    expect(screen.getByText('Summe der Anteile: €0.00 von €90.00 (es fehlen €90.00)')).toBeInTheDocument()

    const shares = screen.getAllByPlaceholderText('45,00')
    await user.type(shares[0], '90')
    expect(screen.getByText('Aufteilung passt zur Summe')).toBeInTheDocument()

    await user.type(shares[1], '10')
    expect(screen.getByText('Summe der Anteile: €100.00 von €90.00 (€10.00 zu viel)')).toBeInTheDocument()

    // Back to the equal split: a member taken out of it is marked, not dropped.
    await user.click(screen.getByRole('button', { name: 'Gleichmäßig' }))
    await user.click(screen.getByRole('button', { name: /bob/i }))
    expect(screen.getByText('Nicht dabei')).toBeInTheDocument()
    expect(screen.queryByText('Excluded')).not.toBeInTheDocument()
  })
})
