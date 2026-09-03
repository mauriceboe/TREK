import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { server } from '../../../tests/helpers/msw/server'
import { fireEvent, render, screen, waitFor, within } from '../../../tests/helpers/render'
import { resetAllStores } from '../../../tests/helpers/store'
import { ToastContainer } from '../shared/Toast'
import AdminPluginsPanel from './AdminPluginsPanel'

/**
 * The "allowed hosts" chip. A plugin that talks to a SELF-HOSTED service (a Gotify) can't
 * name the operator's host in its manifest, so the admin adds it — but they'd never know
 * that unless the card says so. Until a host exists the plugin can reach NOTHING and looks
 * silently broken, which is why the chip is warning-toned and actionable in that state.
 */
function plugin(over: Record<string, unknown> = {}) {
  return {
    id: 'trek-gotify', name: 'Gotify', description: 'Push notifications', type: 'integration',
    icon: 'Bell', version: '1.0.0', status: 'active', enabled: 1,
    last_error: null, reviewed_at: null, source_repo: null,
    permissions: JSON.stringify(['hook:notification-channel', 'http:outbound:gotify.net']),
    capabilities: '{}',
    operatorEgress: true,
    egressHostCount: 0,
    dependencyStatus: 'ok',
    dependencyIssues: { disabledAddons: [], missing: [], versionMismatch: [] },
    ...over,
  }
}

function mockList(p: Record<string, unknown>) {
  server.use(
    http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [p] })),
    http.get('*/api/admin/plugins/registry', () => HttpResponse.json({ plugins: [] })),
  )
}

beforeEach(() => resetAllStores())

describe('AdminPluginsPanel — allowed-hosts chip', () => {
  it('FE-COMP-PLUGINS-EGRESS-001: invites the admin to add a host when none is set', async () => {
    mockList(plugin({ egressHostCount: 0 }))
    render(<AdminPluginsPanel />)
    // The plugin can't reach anything yet — the card must say so, not stay silent.
    expect(await screen.findByRole('button', { name: /add allowed host/i })).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-EGRESS-002: shows the count once hosts exist', async () => {
    mockList(plugin({ egressHostCount: 2 }))
    render(<AdminPluginsPanel />)
    expect(await screen.findByRole('button', { name: /2 allowed host/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add allowed host/i })).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-EGRESS-003: a plugin that never declared operatorEgress gets NO chip', async () => {
    mockList(plugin({ operatorEgress: false }))
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')
    // An admin must never be invited to widen egress for a plugin that didn't ask for it.
    expect(screen.queryByRole('button', { name: /allowed host/i })).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-EGRESS-004: clicking the chip opens the allowed-hosts dialog', async () => {
    mockList(plugin({ egressHostCount: 1 }))
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
        HttpResponse.json({ supported: true, hosts: ['gotify.mydomain.com'] })),
    )
    render(<AdminPluginsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /1 allowed host/i }))
    await waitFor(() => expect(screen.getByText('gotify.mydomain.com')).toBeInTheDocument())
  })
})

/**
 * The Discover (pre-install) modal. Its "Connects to" list is what a reviewer reads to
 * judge a plugin's network reach — so for an operatorEgress plugin that list is NOT the
 * whole story, and saying nothing would actively mislead them.
 */
function mockDetail(manifest: Record<string, unknown> | null) {
  server.use(
    http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [] })),
    // pluginBrowse returns the ARRAY itself, not { plugins: [...] }.
    http.get('*/api/admin/plugins/registry', () =>
      HttpResponse.json([{ id: 'trek-gotify', name: 'Gotify', author: 'jubnl', description: 'Push', repo: 'jubnl/trek-gotify', type: 'integration', tags: [] }])),
    http.get('*/api/admin/plugins/registry/trek-gotify', () =>
      HttpResponse.json({
        id: 'trek-gotify', name: 'Gotify', author: 'jubnl', description: 'Push', repo: 'jubnl/trek-gotify',
        type: 'integration', tags: [], size: 1024, publishedAt: null, latest: '1.0.0', manifest,
      })),
  )
}

describe('AdminPluginsPanel — Discover modal, operator-egress pill', () => {
  const base = { permissions: ['hook:notification-channel', 'http:outbound:gotify.net'], egress: ['gotify.net'], settings: [], license: 'MIT', icon: null }

  /** The panel opens on Installed — switch to Discover, then open the plugin's card. */
  async function openDetail() {
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /discover/i }))
    fireEvent.click(await screen.findByText('Gotify'))
  }

  it('FE-COMP-PLUGINS-EGRESS-005: warns that the host list is not the whole story', async () => {
    mockDetail({ ...base, operatorEgress: true })
    await openDetail()

    // The declared host is still listed…
    expect(await screen.findByText('gotify.net')).toBeInTheDocument()
    // …alongside the pill saying an admin adds more.
    expect(screen.getByText(/hosts you add/i)).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-EGRESS-006: an ordinary plugin gets NO such pill', async () => {
    mockDetail({ ...base, operatorEgress: false })
    await openDetail()

    expect(await screen.findByText('gotify.net')).toBeInTheDocument()
    // Its egress list IS the whole story — claiming otherwise would be a lie.
    expect(screen.queryByText(/hosts you add/i)).not.toBeInTheDocument()
  })
})

/**
 * #1523. The row's ⋯ menu used to be an in-flow `absolute` div, and PageSidebar — the
 * panel's ancestor — is `overflow-hidden`. On the lower rows of a long plugin list the
 * menu was clipped mid-way, taking Delete with it: the plugin became uninstallable from
 * the UI. It must escape every overflow ancestor, and flip up when the bottom is tight.
 */
describe('AdminPluginsPanel — row ⋯ menu is never clipped (#1523)', () => {
  // operatorEgress so the menu shows every action, Allowed hosts included (it is
  // gated on the declaration, like the row chip).
  const withRepo = plugin({ source_repo: 'trek/gotify', operatorEgress: true })
  const realRect = HTMLButtonElement.prototype.getBoundingClientRect
  afterEach(() => { HTMLButtonElement.prototype.getBoundingClientRect = realRect })

  /** Put the ⋯ button wherever we want in an 800px-tall viewport. */
  function stubTriggerAt(top: number) {
    window.innerHeight = 800
    window.innerWidth = 1200
    HTMLButtonElement.prototype.getBoundingClientRect = function () {
      return { top, bottom: top + 34, left: 1100, right: 1134, width: 34, height: 34, x: 1100, y: top, toJSON: () => ({}) } as DOMRect
    }
  }

  async function openRowMenu() {
    mockList(withRepo)
    const { container } = render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'))
    return { container, menu: screen.getByTestId('plugin-row-menu-trek-gotify') }
  }

  it('FE-COMP-PLUGINS-MENU-001: renders every action, including Delete', async () => {
    stubTriggerAt(100)
    await openRowMenu()

    for (const label of [/restart/i, /error log/i, /allowed hosts/i, /source repository/i, /report an issue/i, /delete/i]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('FE-COMP-PLUGINS-MENU-002: is portaled out of the panel, so no overflow ancestor can clip it', async () => {
    stubTriggerAt(100)
    const { container, menu } = await openRowMenu()

    // THE regression guard: living inside the panel is exactly what got it clipped.
    expect(container.contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.position).toBe('fixed')
  })

  it('FE-COMP-PLUGINS-MENU-003: hangs below the ⋯ when there is room', async () => {
    stubTriggerAt(100)
    const { menu } = await openRowMenu()

    expect(menu.style.top).toBe('138px')   // trigger bottom (134) + 4
    expect(menu.style.bottom).toBe('')
    expect(menu.style.right).toBe('66px')  // viewport (1200) - trigger right (1134)
  })

  it('FE-COMP-PLUGINS-MENU-004: flips upward for a row near the bottom — the #1523 case', async () => {
    stubTriggerAt(700) // 66px of room below: the six-item menu would run off-screen
    const { menu } = await openRowMenu()

    expect(menu.style.bottom).toBe('104px') // viewport (800) - trigger top (700) + 4
    expect(menu.style.top).toBe('')
  })
})

/**
 * Signature status (#plugins). TREK has always verified author signatures and TOFU-pinned
 * the key — and never showed any of it, so a successfully-installed UNSIGNED plugin looked
 * identical to a signed one, forever.
 *
 * The two tests that matter most here are the ones guarding the override: a re-trust is
 * offered for a ROTATED key (benign explanation) and for NOTHING else. A signature that
 * doesn't verify means the bytes are not what the author signed, and there is no story
 * where the right answer is letting the admin wave it through.
 */
function registryEntry(over: Record<string, unknown> = {}) {
  return {
    id: 'trek-gotify', name: 'Gotify', author: 'Acme', description: 'Push', repo: 'acme/gotify',
    type: 'integration', latest: '2.0.0', minTrekVersion: null, reviewedAt: null,
    screenshotUrl: null, signed: true, authorPublicKey: 'NEWKEYbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    // The real browse response always carries latestCompatible (server-side hostCompat);
    // mirror `latest` by default, exactly like a fully-compatible entry.
    latestCompatible: (over.latest as string | undefined) ?? '2.0.0',
    ...over,
  }
}

function mockPanel(p: Record<string, unknown>, entry: Record<string, unknown> | null = registryEntry()) {
  server.use(
    http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [p] })),
    http.get('*/api/admin/plugins/registry', () => HttpResponse.json(entry ? [entry] : [])),
  )
}

describe('AdminPluginsPanel — signature badges', () => {
  it('FE-COMP-PLUGINS-SIG-001: a registry plugin with a pinned key reads as Signed', async () => {
    mockPanel(plugin({ source_repo: 'acme/gotify', signed: true, keyFingerprint: 'AAAAAAAA…BBBBBBBB' }))
    render(<AdminPluginsPanel />)
    expect(await screen.findByText('Signed')).toBeInTheDocument()
    expect(screen.queryByText('Unsigned')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-SIG-002: a registry plugin with no key reads as Unsigned', async () => {
    mockPanel(plugin({ source_repo: 'acme/gotify', signed: false, keyFingerprint: null }))
    render(<AdminPluginsPanel />)
    expect(await screen.findByText('Unsigned')).toBeInTheDocument()
  })

  // The precedence rule. `signed` derives from the pinned key, sideloaded from source_repo
  // — so they are NOT mutually exclusive in the data, and a sideloaded plugin genuinely has
  // no key. Rendering "Unsigned" NEXT TO "Sideloaded" would double up on a plugin whose
  // badge already says something strictly stronger, diluting the amber into wallpaper.
  it('FE-COMP-PLUGINS-SIG-003: a sideloaded plugin shows Sideloaded and NO trust badge', async () => {
    mockPanel(plugin({ source_repo: 'local:upload', signed: false }))
    render(<AdminPluginsPanel />)
    expect(await screen.findByText('Sideloaded')).toBeInTheDocument()
    expect(screen.queryByText('Unsigned')).not.toBeInTheDocument()
    expect(screen.queryByText('Signed')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-SIG-004: a dev-linked plugin shows Dev-Link and NO trust badge', async () => {
    mockPanel(plugin({ source_repo: 'local:link', signed: false }))
    render(<AdminPluginsPanel />)
    expect(await screen.findByText('Dev-Link')).toBeInTheDocument()
    expect(screen.queryByText('Unsigned')).not.toBeInTheDocument()
  })
})

describe('AdminPluginsPanel — a refused update', () => {
  const blocked = (code: string) =>
    plugin({
      source_repo: 'acme/gotify', signed: true, keyFingerprint: 'OLDKEYaa…aaaaaaaa',
      updateBlock: { code, detail: 'the signing key changed', version: '2.0.0' },
    })

  it('FE-COMP-PLUGINS-SIG-005: the row keeps showing WHY, instead of the reason dying with a toast', async () => {
    mockPanel(blocked('SIGNATURE_KEY_CHANGED'))
    render(<AdminPluginsPanel />)
    expect(await screen.findByText(/update blocked/i)).toBeInTheDocument()
  })

  // The block describes the version that was REFUSED. Once the registry offers a newer one,
  // it describes an artifact nobody is being offered anymore — so it reads as stale and the
  // admin can simply re-attempt.
  it('FE-COMP-PLUGINS-SIG-006: the block goes quiet once a NEWER version is on offer', async () => {
    mockPanel(blocked('SIGNATURE_KEY_CHANGED'), registryEntry({ latest: '3.0.0' }))
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')
    await waitFor(() => expect(screen.queryByText(/update blocked/i)).not.toBeInTheDocument())
  })

  it('FE-COMP-PLUGINS-SIG-007: Review opens the re-trust dialog for a ROTATED key', async () => {
    mockPanel(blocked('SIGNATURE_KEY_CHANGED'))
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /review/i }))

    // Both fingerprints, so the admin can compare them against what the author tells them.
    expect(await screen.findByText(/key it was installed with/i)).toBeInTheDocument()
    expect(screen.getByText(/key it is offering now/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /trust the new key/i })).toBeInTheDocument()
    // The dialog body scrolls; the decision buttons sit outside it, so they never leave the viewport (#2159).
    const body = screen.getByText(/key it is offering now/i).closest('.overflow-y-auto')
    expect(body).not.toBeNull()
    expect(body).not.toContainElement(screen.getByRole('button', { name: /trust the new key/i }))
  })

  // D2, at the UI. An invalid signature means the bytes are not what the author signed.
  // There is no override — not a disabled button, not one behind a confirm. The ABSENCE of
  // an escape hatch is the feature. (The server refuses it too; this is belt and braces.)
  it('FE-COMP-PLUGINS-SIG-008: an INVALID signature offers NO re-trust affordance at all', async () => {
    mockPanel(blocked('SIGNATURE_INVALID'))
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /review/i }))

    await screen.findByText(/do not match the author's signature/i)
    expect(screen.queryByRole('button', { name: /trust the new key/i })).not.toBeInTheDocument()
    // ...and it does not even show the key comparison, which would imply a choice exists.
    expect(screen.queryByText(/key it is offering now/i)).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-SIG-009: an unsigned-downgrade refusal offers no override either', async () => {
    mockPanel(blocked('SIGNATURE_MISSING'))
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /review/i }))

    await screen.findByText(/ships no signature/i)
    expect(screen.queryByRole('button', { name: /trust the new key/i })).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-SIG-010: confirming a re-trust re-pins AND updates in ONE call', async () => {
    let body: unknown = null
    mockPanel(blocked('SIGNATURE_KEY_CHANGED'))
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/retrust', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] })
      }),
    )
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /review/i }))
    fireEvent.click(await screen.findByRole('button', { name: /trust the new key/i }))

    // The FULL key goes back, not the fingerprint: the server's equality check is exact, so
    // it can refuse if the entry was re-keyed again since this dialog rendered.
    await waitFor(() =>
      expect(body).toEqual({ version: '2.0.0', publicKey: 'NEWKEYbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    )
    // No follow-up /update: a re-pin that waited for a second call would leave the plugin
    // pinned to a key no install had ever verified against if that call never came.
  })
})

describe('AdminPluginsPanel — update consent', () => {
  it('FE-COMP-PLUGINS-SIG-011: says an unsigned update is untied to its author, and still activates in one click', async () => {
    let activated = false
    mockPanel(plugin({ source_repo: 'acme/gotify', signed: false }), registryEntry({ signed: false }))
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/update', () =>
        HttpResponse.json({ version: '2.0.0', activated: false, newPermissions: ['db:read:trips'], newEgress: [] }),
      ),
      http.post('*/api/admin/plugins/trek-gotify/activate', () => { activated = true; return HttpResponse.json({ status: 'active' }) }),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')
    fireEvent.click(await screen.findByRole('button', { name: /update to|2\.0\.0/i }))

    // Informs — it does not block. No checkbox, no second click.
    expect(await screen.findByText(/nothing ties this version to its author/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /approve & turn on/i }))
    await waitFor(() => expect(activated).toBe(true))
  })

  // The warning used to be read ONLY off the registry entry, so an unreachable registry left
  // it undefined and the pill silently vanished — at the exact moment the admin was widening
  // what unsigned code may do. The installed row carries an authoritative `signed` from the
  // server on every list call; degrade to that rather than to silence.
  //
  // Consent is reached here by turning a plugin back ON after an update widened its
  // permissions (409 CONSENT_REQUIRED) — which is the path that still works with the registry
  // down, precisely because it needs nothing from the registry.
  it('FE-COMP-PLUGINS-SIG-015: the unsigned warning survives an unreachable registry', async () => {
    server.use(
      http.get('*/api/admin/plugins', () =>
        HttpResponse.json({
          enabled: true, devLink: false,
          plugins: [plugin({ source_repo: 'acme/gotify', signed: false, enabled: 0, status: 'inactive', operatorEgress: false })],
        })),
      // The registry is down: `regById` stays empty, so the entry's `signed` is unknowable.
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json({ error: 'registry unreachable' }, { status: 500 })),
      http.post('*/api/admin/plugins/trek-gotify/activate', () =>
        HttpResponse.json({ error: 'consent required', code: 'CONSENT_REQUIRED', newPermissions: ['db:read:trips'], newEgress: [] }, { status: 409 })),
    )
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /enable plugin/i }))

    // Falls back to the installed row's `signed: false` rather than going quiet.
    expect(await screen.findByText(/nothing ties this version to its author/i)).toBeInTheDocument()
  })
})

/**
 * A signature refusal must reach the dialog even when the plugin has NO installed row —
 * which is every fresh install from Discover, and every dependency being downloaded.
 *
 * Routing the refusal off the installed list meant those two paths silently fell back to a
 * generic toast: the admin met SIGNATURE_INVALID for the first time on the one path where the
 * dialog explaining it never opened. A fresh install has no pinned key, so it can only ever
 * be _INVALID / _INCOMPLETE — never a rotation — and both are non-overridable, so the dialog
 * must explain and offer nothing.
 */
describe('AdminPluginsPanel — a refusal with no installed row', () => {
  it('FE-COMP-PLUGINS-SIG-013: a fresh install refused for an INVALID signature opens the dialog, not a toast', async () => {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json([registryEntry()])),
      http.post('*/api/admin/plugins/install', () =>
        HttpResponse.json({ error: 'author signature verification failed', code: 'SIGNATURE_INVALID' }, { status: 400 })),
    )
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /discover/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^install$/i }))

    // The dialog, named after the plugin — which it can only know from the REGISTRY entry,
    // there being no installed row to read a name off.
    expect(await screen.findByText(/gotify's signature could not be verified/i)).toBeInTheDocument()
    await screen.findByText(/do not match the author's signature/i)
    // Non-overridable, and no key comparison — showing one would imply a choice exists.
    expect(screen.queryByRole('button', { name: /trust the new key/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/key it is offering now/i)).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-SIG-014: a refusal while downloading a DEPENDENCY opens the dialog too', async () => {
    const parent = plugin({ id: 'trek-parent', name: 'Parent', source_repo: 'acme/parent', enabled: 0, status: 'inactive', operatorEgress: false })
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [parent] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json([registryEntry()])),
      // Turning it on reveals the missing dependency…
      http.post('*/api/admin/plugins/trek-parent/activate', () =>
        HttpResponse.json({ error: 'missing dependency', code: 'DEPENDENCY_MISSING', missing: [{ id: 'trek-gotify', version: '^1.0.0' }], versionMismatch: [] }, { status: 409 })),
      // …and downloading it is refused on its signature.
      http.post('*/api/admin/plugins/install', () =>
        HttpResponse.json({ error: 'author signature verification failed', code: 'SIGNATURE_INVALID' }, { status: 400 })),
    )
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /enable plugin/i }))
    fireEvent.click(await screen.findByRole('button', { name: /download/i }))

    // Named after the DEPENDENCY, not the parent — it is the dependency's author whose
    // signature did not verify, and saying "Parent" here would point the admin at the wrong
    // plugin entirely.
    expect(await screen.findByText(/gotify's signature could not be verified/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /trust the new key/i })).not.toBeInTheDocument()
  })
})

describe('AdminPluginsPanel — a block never outlives the registry relationship', () => {
  // The server clears the block on sideload/dev-link. This is the belt: even if a stale
  // block somehow reached the client, a plugin whose code the admin supplied by hand must
  // never claim an update was blocked over an author signing key.
  it('FE-COMP-PLUGINS-SIG-012: a sideloaded plugin never shows an update block', async () => {
    mockPanel(plugin({
      source_repo: 'local:upload', signed: false,
      updateBlock: { code: 'SIGNATURE_KEY_CHANGED', detail: 'the signing key changed', version: '2.0.0' },
    }))
    render(<AdminPluginsPanel />)
    await screen.findByText('Sideloaded')
    expect(screen.queryByText(/update blocked/i)).not.toBeInTheDocument()
  })
})

/**
 * TREK-version compatibility. The SERVER owns the semver — a second implementation in the
 * browser would eventually disagree with the install gate and offer a button that 400s —
 * so the panel only renders the verdict the API hands it (`compatible`, `latestCompatible`).
 */
describe('AdminPluginsPanel — TREK-version compatibility', () => {
  /** Discover cards for a plugin that is NOT installed — an installed one just reads "Installed". */
  async function openDiscover(entry: Record<string, unknown>) {
    mockPanel(plugin({ id: 'something-else' }), registryEntry(entry))
    render(<AdminPluginsPanel />)
    fireEvent.click(await screen.findByText('Discover'))
  }

  it('blocks Install when no published version runs on this TREK, and says why', async () => {
    await openDiscover({ trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false, latestCompatible: null })
    const btn = await screen.findByRole('button', { name: /^incompatible$/i })
    expect(btn).toBeDisabled()
  })

  it('offers the newest version that DOES run here rather than a dead button', async () => {
    await openDiscover({ latest: '2.0.0', trek: '>=3.4.0', hostVersion: '3.3.0', compatible: false, latestCompatible: '1.5.0' })
    const btn = await screen.findByRole('button', { name: /^install 1\.5\.0$/i })
    expect(btn).toBeEnabled()
  })

  it('installs normally when the latest version fits', async () => {
    await openDiscover({ trek: '>=3.2.0 <4.0.0', hostVersion: '3.3.0', compatible: true, latestCompatible: '2.0.0' })
    expect(await screen.findByRole('button', { name: /^install$/i })).toBeEnabled()
  })

  it('an installed plugin the server has outgrown shows the blocker on its card', async () => {
    // Same amber chip machinery as a disabled addon / missing dependency — the admin sees
    // one "here is why this cannot turn on" surface, not a new concept per blocker.
    mockPanel(plugin({
      dependencyStatus: 'hostIncompatible', trekRange: '>=3.2.0 <4.0.0', hostVersion: '4.0.0', enabled: 0, status: 'inactive',
    }))
    render(<AdminPluginsPanel />)
    expect(await screen.findByText(/needs trek >=3\.2\.0 <4\.0\.0/i)).toBeInTheDocument()
  })
})

/**
 * The rest of the panel: load states, the toolbar, sideloading, the row actions behind the
 * ⋯ menu, and the dialog each 409 routes to.
 */
function panelWith(
  plugins: Record<string, unknown>[],
  opts: { enabled?: boolean; devLink?: boolean; registry?: Record<string, unknown>[] } = {},
) {
  server.use(
    http.get('*/api/admin/plugins', () => HttpResponse.json({
      enabled: opts.enabled ?? true, devLink: opts.devLink ?? false, plugins,
    })),
    http.get('*/api/admin/plugins/registry', () => HttpResponse.json(opts.registry ?? [])),
  )
}

function withToast() {
  return render(<><ToastContainer /><AdminPluginsPanel /></>)
}

/** The Discover tab is a role="tab"; the empty state offers a plain button with the same label. */
async function clickDiscover() {
  const tabs = await screen.findAllByRole('tab', { name: /^discover/i })
  fireEvent.click(tabs[0])
}

/** The panel root, which owns the drag-and-drop handlers. */
function panelRoot(container: HTMLElement): HTMLElement {
  return (container.querySelector('input[type="file"]') as HTMLElement).parentElement as HTMLElement
}

/** Opens one of the toolbar dropdowns (identified by its current title) and picks an option. */
async function pickFilter(trigger: RegExp, option: RegExp) {
  fireEvent.click(await screen.findByTitle(trigger))
  fireEvent.click(await screen.findByRole('button', { name: option }))
}

/** The enable toggle of a named installed row. */
function rowToggle(name: string): HTMLElement {
  const row = screen.getByText(name).closest('.group') as HTMLElement
  return within(row).getByRole('button', { name: 'Enable plugin' })
}

describe('AdminPluginsPanel — load states and toolbar', () => {
  it('FE-COMP-PLUGINS-PANEL-001: a failing plugin list shows the load error instead of an empty list', async () => {
    server.use(http.get('*/api/admin/plugins', () => HttpResponse.error()))
    render(<AdminPluginsPanel />)

    expect(await screen.findByText('Could not load plugins.')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Search plugins…')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-002: a disabled runtime replaces the whole body with the notice', async () => {
    panelWith([plugin()], { enabled: false })
    render(<AdminPluginsPanel />)

    expect(await screen.findByText('Plugins are disabled')).toBeInTheDocument()
    expect(screen.queryByText('Gotify')).not.toBeInTheDocument()
    expect(screen.queryByText('Runtime on')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-003: with nothing installed the empty state jumps to Discover', async () => {
    panelWith([])
    render(<AdminPluginsPanel />)

    await screen.findByText('No plugins installed yet.')
    expect(screen.getByText('Runtime on')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /^discover/i }).pop()!)

    expect(await screen.findByText('No plugins available in the registry yet.')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-004: the search box filters the installed list and says when nothing matches', async () => {
    panelWith([plugin({ id: 'a', name: 'Gotify' }), plugin({ id: 'b', name: 'Ntfy', description: 'Push too' })])
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    fireEvent.change(screen.getByPlaceholderText('Search plugins…'), { target: { value: 'ntfy' } })
    expect(screen.queryByText('Gotify')).not.toBeInTheDocument()
    expect(screen.getByText('Ntfy')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search plugins…'), { target: { value: 'zzz' } })
    expect(screen.getByText('No installed plugins match your search.')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-005: the type filter narrows the list and marks itself active', async () => {
    panelWith([
      plugin({ id: 'a', name: 'Gotify', type: 'integration' }),
      plugin({ id: 'b', name: 'Countdown', type: 'widget' }),
    ])
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    await pickFilter(/^Type: All types$/, /^Widget$/)

    expect(await screen.findByTitle('Type: Widget')).toBeInTheDocument()
    expect(screen.getByText('Countdown')).toBeInTheDocument()
    expect(screen.queryByText('Gotify')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-006: the status filter separates off, error and update-available rows', async () => {
    panelWith([
      plugin({ id: 'trek-gotify', name: 'OnOne', enabled: 1, status: 'active', version: '1.0.0', source_repo: 'acme/gotify' }),
      plugin({ id: 'off-one', name: 'OffOne', enabled: 0, status: 'inactive' }),
      plugin({ id: 'bad-one', name: 'BadOne', enabled: 1, status: 'error', last_error: 'boom' }),
    ], { registry: [registryEntry({ latest: '2.0.0' })] })
    render(<AdminPluginsPanel />)
    await screen.findByText('OnOne')

    await pickFilter(/^Status: All$/, /^Off$/)
    expect(await screen.findByText('OffOne')).toBeInTheDocument()
    expect(screen.queryByText('OnOne')).not.toBeInTheDocument()

    await pickFilter(/^Status: Off$/, /^Error$/)
    expect(await screen.findByText('BadOne')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()

    await pickFilter(/^Status: Error$/, /^Update available$/)
    expect(await screen.findByText('OnOne')).toBeInTheDocument()
    expect(screen.queryByText('BadOne')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-007: an installed-only sort key snaps back to Name on the Discover tab', async () => {
    panelWith([plugin()], { registry: [registryEntry()] })
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    await pickFilter(/^Sort: Name$/, /^Updates first$/)
    expect(await screen.findByTitle('Sort: Updates first')).toBeInTheDocument()

    await clickDiscover()
    await waitFor(() => expect(screen.getByTitle('Sort: Name')).toBeInTheDocument())
  })

  it('FE-COMP-PLUGINS-PANEL-008: rescan re-pulls the registry past its cache and confirms with a toast', async () => {
    const refreshFlags: (string | null)[] = []
    panelWith([plugin()])
    server.use(
      http.post('*/api/admin/plugins/rescan', () => HttpResponse.json({ ok: true })),
      http.get('*/api/admin/plugins/registry', ({ request }) => {
        refreshFlags.push(new URL(request.url).searchParams.get('refresh'))
        return HttpResponse.json([registryEntry({ latest: '2.0.0' })])
      }),
    )
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(screen.getAllByTitle('Rescan')[0])

    expect(await screen.findByText('Rescanned the plugins folder')).toBeInTheDocument()
    expect(refreshFlags).toContain('1')
  })
})

describe('AdminPluginsPanel — sideloading', () => {
  const zip = () => new File(['zip'], 'plugin.zip', { type: 'application/zip' })

  it('FE-COMP-PLUGINS-PANEL-009: the toolbar button opens the hidden picker and uploads the pick', async () => {
    panelWith([plugin()])
    server.use(http.post('*/api/admin/plugins/upload', () => HttpResponse.json({ id: 'trek-new' })))
    const { container } = withToast()
    await screen.findByText('Gotify')

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getAllByTitle('Upload plugin')[0])
    expect(clickSpy).toHaveBeenCalled()
    clickSpy.mockRestore()

    await userEvent.upload(input, zip())
    expect(await screen.findByText(/trek-new.*uploaded/i)).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-010: a rejected upload surfaces the server message', async () => {
    panelWith([plugin()])
    server.use(http.post('*/api/admin/plugins/upload', () => HttpResponse.json({ error: 'not a plugin archive' }, { status: 400 })))
    const { container } = withToast()
    await screen.findByText('Gotify')

    await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, zip())

    expect(await screen.findByText('not a plugin archive')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-011: dragging a file over the panel offers a drop target and installs it', async () => {
    let uploaded = false
    panelWith([plugin()])
    server.use(http.post('*/api/admin/plugins/upload', () => { uploaded = true; return HttpResponse.json({ id: 'trek-dropped' }) }))
    const { container } = withToast()
    await screen.findByText('Gotify')

    const panel = panelRoot(container)
    const dataTransfer = { types: ['Files'], files: [zip()] }
    fireEvent.dragEnter(panel, { dataTransfer })
    expect(await screen.findByText('Drop a plugin .zip to install')).toBeInTheDocument()

    fireEvent.dragLeave(panel, { dataTransfer })
    await waitFor(() => expect(screen.queryByText('Drop a plugin .zip to install')).not.toBeInTheDocument())

    fireEvent.dragEnter(panel, { dataTransfer })
    fireEvent.dragOver(panel, { dataTransfer })
    fireEvent.drop(panel, { dataTransfer })

    await waitFor(() => expect(uploaded).toBe(true))
    expect(await screen.findByText(/trek-dropped.*uploaded/i)).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-012: a drag that carries no files is ignored', async () => {
    panelWith([plugin()])
    const { container } = render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    fireEvent.dragEnter(panelRoot(container), { dataTransfer: { types: ['text/plain'], files: [] } })

    expect(screen.queryByText('Drop a plugin .zip to install')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-013: the dev-link form registers a local path and reports failures', async () => {
    const paths: string[] = []
    panelWith([plugin()], { devLink: true })
    server.use(http.post('*/api/admin/plugins/link', async ({ request }) => {
      const body = await request.json() as { path: string }
      paths.push(body.path)
      return paths.length === 1
        ? HttpResponse.json({ id: 'trek-local' })
        : HttpResponse.json({ error: 'no manifest there' }, { status: 400 })
    }))
    withToast()
    const input = await screen.findByPlaceholderText('/absolute/path/to/your/plugin')

    expect(screen.getByRole('button', { name: /^link$/i })).toBeDisabled()

    fireEvent.change(input, { target: { value: '/srv/plugins/mine' } })
    fireEvent.click(screen.getByRole('button', { name: /^link$/i }))
    expect(await screen.findByText(/linked trek-local/i)).toBeInTheDocument()
    expect(paths).toEqual(['/srv/plugins/mine'])

    fireEvent.change(screen.getByPlaceholderText('/absolute/path/to/your/plugin'), { target: { value: '/nope' } })
    fireEvent.click(screen.getByRole('button', { name: /^link$/i }))
    expect(await screen.findByText('no manifest there')).toBeInTheDocument()
  })
})

describe('AdminPluginsPanel — row actions', () => {
  async function openRowMenu(p: Record<string, unknown> = plugin()) {
    panelWith([p])
    withToast()
    fireEvent.click(await screen.findByTestId(`plugin-row-menu-btn-${p.id}`))
  }

  /** Every modal in the panel closes by clicking its backdrop. */
  function closeModal() {
    fireEvent.click(document.querySelector('.fixed.inset-0.z-50') as HTMLElement)
  }

  it('FE-COMP-PLUGINS-PANEL-014: the error log lists what the runtime recorded', async () => {
    server.use(http.get('*/api/admin/plugins/trek-gotify/errors', () =>
      HttpResponse.json({ errors: [{ ts: '2026-01-01T00:00:00Z', level: 'error', message: 'connect ECONNREFUSED' }] })))
    await openRowMenu()

    fireEvent.click(screen.getByText('View error log'))
    expect(await screen.findByText('connect ECONNREFUSED')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument()

    closeModal()
    await waitFor(() => expect(screen.queryByText('connect ECONNREFUSED')).not.toBeInTheDocument())
  })

  it('FE-COMP-PLUGINS-PANEL-015: an unreachable error log still opens, empty', async () => {
    server.use(http.get('*/api/admin/plugins/trek-gotify/errors', () => HttpResponse.error()))
    await openRowMenu()

    fireEvent.click(screen.getByText('View error log'))

    expect(await screen.findByText('No errors logged.')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-016: allowed hosts can be added and removed, and a rejected save says why', async () => {
    let hosts: string[] = []
    let puts = 0
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () => HttpResponse.json({ supported: true, hosts })),
      http.put('*/api/admin/plugins/trek-gotify/egress-hosts', async ({ request }) => {
        puts += 1
        const body = await request.json() as { hosts: string[] }
        if (puts === 3) return HttpResponse.json({ error: 'not a valid host' }, { status: 400 })
        hosts = body.hosts
        return HttpResponse.json({ hosts })
      }),
    )
    await openRowMenu()

    fireEvent.click(screen.getByText('Allowed hosts'))
    expect(await screen.findByText('No hosts added yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('gotify.example.com'), { target: { value: 'gotify.lan' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText('gotify.lan')).toBeInTheDocument()

    fireEvent.click(screen.getAllByLabelText('Delete')[0])
    await waitFor(() => expect(screen.getByText('No hosts added yet.')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('gotify.example.com'), { target: { value: 'bad host' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText('not a valid host')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-017: a plugin whose hosts are fixed in its manifest says the list is unsupported', async () => {
    server.use(http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () => HttpResponse.error()))
    await openRowMenu()

    fireEvent.click(screen.getByText('Allowed hosts'))

    expect(await screen.findByText(/does not use operator-supplied hosts/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('gotify.example.com')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-018: Delete asks first, then uninstalls with its data', async () => {
    let body: unknown = null
    server.use(http.post('*/api/admin/plugins/trek-gotify/uninstall', async ({ request }) => {
      body = await request.json()
      return HttpResponse.json({ ok: true })
    }))
    await openRowMenu()

    fireEvent.click(screen.getByText('Delete'))
    expect(await screen.findByText('Uninstall plugin?')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /^delete$/i }).pop()!)

    expect(await screen.findByText('Plugin uninstalled')).toBeInTheDocument()
    expect(body).toEqual({ deleteData: true })
  })

  it('FE-COMP-PLUGINS-PANEL-019: Restart cycles the plugin off and on again', async () => {
    const seen: string[] = []
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/deactivate', () => { seen.push('deactivate'); return HttpResponse.json({ ok: true }) }),
      http.post('*/api/admin/plugins/trek-gotify/activate', () => { seen.push('activate'); return HttpResponse.json({ ok: true }) }),
    )
    await openRowMenu(plugin({ enabled: 1, status: 'active' }))

    fireEvent.click(screen.getByText('Restart'))

    expect(await screen.findByText('Plugin restarted')).toBeInTheDocument()
    expect(seen).toEqual(['deactivate', 'activate'])
  })

  it('FE-COMP-PLUGINS-PANEL-020: a disabled plugin offers no Restart', async () => {
    await openRowMenu(plugin({ enabled: 0, status: 'inactive' }))

    expect(screen.getByText('View error log')).toBeInTheDocument()
    expect(screen.queryByText('Restart')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-049: Allowed hosts is offered only to a plugin that declared operatorEgress', async () => {
    // An admin must never be invited to widen egress for a plugin that didn't ask for it
    // — same rule the row chip already follows.
    await openRowMenu(plugin({ operatorEgress: false }))

    expect(screen.getByText('View error log')).toBeInTheDocument() // menu is open
    expect(screen.queryByText('Allowed hosts')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-050: a long host list scrolls inside the dialog instead of growing past the viewport (#2159)', async () => {
    server.use(http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
      HttpResponse.json({ supported: true, hosts: ['gotify.lan', 'ntfy.lan'] })))
    await openRowMenu()

    fireEvent.click(screen.getByText('Allowed hosts'))

    // The card is capped and its body scrolls, so the input, the Add button and the
    // restart note below the list stay reachable however many hosts the admin entered.
    const body = (await screen.findByText('gotify.lan')).closest('.overflow-y-auto')
    expect(body).not.toBeNull()
    expect(body).toContainElement(screen.getByPlaceholderText('gotify.example.com'))
    expect(body!.parentElement!.className).toContain('max-h-[88vh]')
  })
})

describe('AdminPluginsPanel — enabling a plugin', () => {
  it('FE-COMP-PLUGINS-PANEL-021: turning a plugin off deactivates it', async () => {
    let called = false
    panelWith([plugin({ enabled: 1, status: 'active' })])
    server.use(http.post('*/api/admin/plugins/trek-gotify/deactivate', () => { called = true; return HttpResponse.json({ ok: true }) }))
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))

    expect(await screen.findByText('Plugin deactivated')).toBeInTheDocument()
    expect(called).toBe(true)
  })

  it('FE-COMP-PLUGINS-PANEL-022: turning one on also reports the dependencies it enabled first', async () => {
    panelWith([
      plugin({ enabled: 0, status: 'inactive', dependencies: { pluginDependencies: [{ id: 'trek-core', version: '^1.0.0' }] } }),
      plugin({ id: 'trek-core', name: 'Core', enabled: 0, status: 'inactive' }),
    ])
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () => HttpResponse.json({ ok: true })))
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))

    expect(await screen.findByText('Plugin activated')).toBeInTheDocument()
    expect(await screen.findByText(/enabled required plugin\(s\) first: core/i)).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-023: a disabled required addon is reported as a toast, not a dialog', async () => {
    panelWith([plugin({ enabled: 0, status: 'inactive' })])
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () =>
      HttpResponse.json({ code: 'ADDON_DISABLED', addons: ['journey'] }, { status: 409 })))
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))

    expect(await screen.findByText(/enable the required addon\(s\) first: journey/i)).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-024: any other activation failure surfaces the server message', async () => {
    panelWith([plugin({ enabled: 0, status: 'inactive' })])
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () =>
      HttpResponse.json({ code: 'DEPENDENCY_CYCLE', error: 'circular dependency' }, { status: 409 })))
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))

    expect(await screen.findByText('circular dependency')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-025: a missing dependency opens the resolve dialog and one click fixes it', async () => {
    let activates = 0
    let installed: unknown = null
    panelWith([plugin({ enabled: 0, status: 'inactive' })])
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/activate', () => {
        activates += 1
        return activates === 1
          ? HttpResponse.json({
            code: 'DEPENDENCY_MISSING',
            missing: [{ id: 'trek-core', version: '^1.0.0' }],
            versionMismatch: [{ id: 'trek-old', wanted: '^2.0.0', installed: '1.0.0' }],
          }, { status: 409 })
          : HttpResponse.json({ ok: true })
      }),
      http.post('*/api/admin/plugins/install', async ({ request }) => {
        installed = await request.json()
        return HttpResponse.json({ installed: ['trek-core'], requiredAddons: ['journey'] })
      }),
    )
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))
    expect(await screen.findByText('Missing dependencies')).toBeInTheDocument()
    expect(screen.getByText('Requires ^1.0.0')).toBeInTheDocument()
    expect(screen.getByText('Needs ^2.0.0 — 1.0.0 is installed')).toBeInTheDocument()
    expect(screen.getByText(/downloads the latest compatible version/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^download$/i }))

    expect(await screen.findByText('Downloaded trek-core')).toBeInTheDocument()
    expect(installed).toEqual({ id: 'trek-core', constraint: '^1.0.0', withDependencies: true })
    expect(await screen.findByText(/enable the required addon\(s\) first: journey/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Missing dependencies')).not.toBeInTheDocument())
  })

  it('FE-COMP-PLUGINS-PANEL-026: the resolve dialog can be dismissed without downloading anything', async () => {
    let installs = 0
    panelWith([plugin({ enabled: 0, status: 'inactive' })])
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/activate', () =>
        HttpResponse.json({ code: 'DEPENDENCY_MISSING', missing: [{ id: 'trek-core', version: '^1.0.0' }], versionMismatch: [] }, { status: 409 })),
      http.post('*/api/admin/plugins/install', () => { installs += 1; return HttpResponse.json({}) }),
    )
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))
    // The dependency list scrolls; Cancel sits outside it, so it never leaves the viewport (#2159).
    const body = (await screen.findByText('trek-core')).closest('.overflow-y-auto')
    expect(body).not.toBeNull()
    expect(body).not.toContainElement(screen.getByRole('button', { name: /^cancel$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    await waitFor(() => expect(screen.queryByText('Missing dependencies')).not.toBeInTheDocument())
    expect(installs).toBe(0)
  })

  it('FE-COMP-PLUGINS-PANEL-027: widened permissions route to the consent dialog, which can be deferred', async () => {
    panelWith([plugin({ enabled: 0, status: 'inactive', source_repo: 'acme/gotify', signed: false })])
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () =>
      HttpResponse.json({ code: 'CONSENT_REQUIRED', newPermissions: ['db:read:trips', 'weird:perm'], newEgress: ['api.acme.io'] }, { status: 409 })))
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))

    expect(await screen.findByText('This update needs new permissions')).toBeInTheDocument()
    expect(screen.getByText('Read trips the acting user can access')).toBeInTheDocument()
    // An unknown permission is still shown — as its raw code
    expect(screen.getByText('weird:perm')).toBeInTheDocument()
    expect(screen.getByText('api.acme.io')).toBeInTheDocument()
    // A long permission list scrolls inside the dialog; the decision buttons sit outside
    // the scroll container, so they never leave the viewport (#2159).
    const body = screen.getByText('Read trips the acting user can access').closest('.overflow-y-auto')
    expect(body).not.toBeNull()
    expect(body).not.toContainElement(screen.getByRole('button', { name: /keep off for now/i }))

    fireEvent.click(screen.getByRole('button', { name: /keep off for now/i }))
    expect(await screen.findByText(/left off until you approve/i)).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-028: approving consent re-activates with the consent flag', async () => {
    const bodies: unknown[] = []
    panelWith([plugin({ enabled: 0, status: 'inactive' })])
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', async ({ request }) => {
      bodies.push(await request.json())
      return bodies.length === 1
        ? HttpResponse.json({ code: 'CONSENT_REQUIRED', newPermissions: ['db:read:trips'], newEgress: [] }, { status: 409 })
        : HttpResponse.json({ ok: true })
    }))
    withToast()
    await screen.findByText('Gotify')

    fireEvent.click(rowToggle('Gotify'))
    fireEvent.click(await screen.findByRole('button', { name: /approve & turn on/i }))

    expect(await screen.findByText('Plugin updated')).toBeInTheDocument()
    expect(bodies[1]).toEqual({ consent: true })
  })
})

describe('AdminPluginsPanel — updates', () => {
  const outdated = plugin({ source_repo: 'acme/gotify', version: '1.0.0', operatorEgress: false })

  it('FE-COMP-PLUGINS-PANEL-029: the update banner updates every outdated plugin at once', async () => {
    const updated: string[] = []
    panelWith(
      [outdated, plugin({ id: 'trek-ntfy', name: 'Ntfy', source_repo: 'acme/ntfy', version: '1.0.0', operatorEgress: false })],
      { registry: [registryEntry({ latest: '2.0.0' }), registryEntry({ id: 'trek-ntfy', latest: '3.0.0' })] },
    )
    server.use(http.post('*/api/admin/plugins/:id/update', ({ params }) => {
      updated.push(String(params.id))
      return HttpResponse.json({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] })
    }))
    withToast()

    expect(await screen.findByText('2 updates available for your plugins.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /update all/i }))

    await waitFor(() => expect([...updated].sort()).toEqual(['trek-gotify', 'trek-ntfy']))
    expect((await screen.findAllByText('Plugin updated')).length).toBeGreaterThan(0)
  })

  it('FE-COMP-PLUGINS-PANEL-030: an update that widens permissions queues the consent dialog', async () => {
    panelWith([outdated], { registry: [registryEntry({ latest: '2.0.0', signed: false })] })
    server.use(http.post('*/api/admin/plugins/trek-gotify/update', () =>
      HttpResponse.json({ version: '2.0.0', activated: false, newPermissions: ['db:read:users'], newEgress: [] })))
    withToast()

    fireEvent.click(await screen.findByRole('button', { name: /update → v2\.0\.0/i }))

    expect(await screen.findByText('This update needs new permissions')).toBeInTheDocument()
    expect(screen.getByText(/read basic profile info/i)).toBeInTheDocument()
    // The registry says the new code is unsigned — say so where the rights get widened
    expect(screen.getByText(/nothing ties this version to its author/i)).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-031: a failed update that is not a signature refusal is a plain toast', async () => {
    panelWith([outdated], { registry: [registryEntry({ latest: '2.0.0' })] })
    server.use(http.post('*/api/admin/plugins/trek-gotify/update', () =>
      HttpResponse.json({ error: 'registry unreachable' }, { status: 502 })))
    withToast()

    fireEvent.click(await screen.findByRole('button', { name: /update → v2\.0\.0/i }))

    expect(await screen.findByText('registry unreachable')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-032: a re-trusted update that widens rights still asks for consent', async () => {
    panelWith([plugin({
      source_repo: 'acme/gotify', version: '1.0.0', keyFingerprint: 'OLDAAAAA…BBBBBBBB', operatorEgress: false,
      updateBlock: { code: 'SIGNATURE_KEY_CHANGED', version: '2.0.0', detail: 'key rotated' },
    })], { registry: [registryEntry({ latest: '2.0.0' })] })
    server.use(http.post('*/api/admin/plugins/trek-gotify/retrust', () =>
      HttpResponse.json({ version: '2.0.0', activated: false, newPermissions: ['db:read:trips'], newEgress: ['api.acme.io'] })))
    withToast()

    fireEvent.click(await screen.findByRole('button', { name: /^review$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /trust the new key/i }))

    expect(await screen.findByText('This update needs new permissions')).toBeInTheDocument()
    expect(screen.getByText('api.acme.io')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-033: a failed re-trust surfaces the server message', async () => {
    panelWith([plugin({
      source_repo: 'acme/gotify', version: '1.0.0', keyFingerprint: 'OLDAAAAA…BBBBBBBB', operatorEgress: false,
      updateBlock: { code: 'SIGNATURE_KEY_CHANGED', version: '2.0.0', detail: 'key rotated' },
    })], { registry: [registryEntry({ latest: '2.0.0' })] })
    server.use(http.post('*/api/admin/plugins/trek-gotify/retrust', () =>
      HttpResponse.json({ error: 'key does not match' }, { status: 400 })))
    withToast()

    fireEvent.click(await screen.findByRole('button', { name: /^review$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /trust the new key/i }))

    expect(await screen.findByText('key does not match')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-034a: a stable release counts as newer than the prerelease of the same version', async () => {
    panelWith([plugin({ source_repo: 'acme/gotify', version: '2.0.0-beta.1', operatorEgress: false })], {
      registry: [registryEntry({ latest: '2.0.0' })],
    })
    render(<AdminPluginsPanel />)

    expect(await screen.findByRole('button', { name: /update → v2\.0\.0/i })).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-034: a block with no recorded version stands while the registry is silent', async () => {
    panelWith([plugin({
      source_repo: 'acme/gotify', operatorEgress: false,
      updateBlock: { code: 'SIGNATURE_INVALID', version: null, detail: 'digest mismatch' },
    })], { registry: [] })
    render(<AdminPluginsPanel />)

    expect(await screen.findByText(/update blocked — digest mismatch/i)).toBeInTheDocument()
  })
})

/**
 * Update availability must follow what this TREK can actually INSTALL (latestCompatible,
 * computed server-side), never the absolute newest published version — a banner counting
 * versions the update endpoint would refuse nags the admin toward a guaranteed 400.
 */
describe('AdminPluginsPanel — compatible updates only', () => {
  const outdated = plugin({ source_repo: 'acme/gotify', version: '1.0.0', operatorEgress: false })

  it('FE-COMP-PLUGINS-UPD-001: an update this TREK cannot install is neither offered nor counted', async () => {
    panelWith([outdated], {
      registry: [registryEntry({ latest: '2.0.0', latestCompatible: null, trek: '>=4.0.0', hostVersion: '3.3.0' })],
    })
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    expect(screen.queryByRole('button', { name: /update → v2\.0\.0/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/updates available for your plugins/i)).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-UPD-002: the update offer is the newest compatible version, not the absolute latest', async () => {
    panelWith([outdated], {
      registry: [registryEntry({ latest: '3.0.0', latestCompatible: '2.0.0', trek: '>=4.0.0', hostVersion: '3.3.0' })],
    })
    render(<AdminPluginsPanel />)

    expect(await screen.findByRole('button', { name: /update → v2\.0\.0/i })).toBeInTheDocument()
    expect(screen.getByText('1 updates available for your plugins.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update → v3\.0\.0/i })).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-UPD-003: a newer version needing a newer TREK leaves a passive hint on the row', async () => {
    panelWith([outdated], {
      registry: [registryEntry({ latest: '2.0.0', latestCompatible: null, trek: '>=4.0.0', hostVersion: '3.3.0' })],
    })
    render(<AdminPluginsPanel />)

    expect(await screen.findByText('v2.0.0 available — needs TREK >=4.0.0')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-UPD-004: a legacy entry with only minTrekVersion still gets a hint range', async () => {
    panelWith([outdated], {
      registry: [registryEntry({ latest: '2.0.0', latestCompatible: null, trek: null, minTrekVersion: '4.0.0', hostVersion: '3.3.0' })],
    })
    render(<AdminPluginsPanel />)

    expect(await screen.findByText('v2.0.0 available — needs TREK >=4.0.0')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-UPD-005: no hint when the latest version is the one on offer', async () => {
    panelWith([outdated], { registry: [registryEntry({ latest: '2.0.0' })] })
    render(<AdminPluginsPanel />)

    expect(await screen.findByRole('button', { name: /update → v2\.0\.0/i })).toBeInTheDocument()
    expect(screen.queryByText(/needs TREK/i)).not.toBeInTheDocument()
  })
})

/**
 * The update hold (#plugins): a deliberate non-latest install sets updateHold on the row,
 * which takes it out of the banner count and "Update all" — a rollback the admin just
 * made must not be nagged straight back. The row says so and offers to resume.
 */
describe('AdminPluginsPanel — update hold', () => {
  const held = plugin({ source_repo: 'acme/gotify', version: '1.0.0', operatorEgress: false, updateHold: true })

  it('FE-COMP-PLUGINS-HOLD-001: a held plugin leaves the banner and loses its update button', async () => {
    panelWith([held], { registry: [registryEntry({ latest: '2.0.0' })] })
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    expect(screen.queryByText(/updates available for your plugins/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update → v2\.0\.0/i })).not.toBeInTheDocument()
    expect(screen.getByText('Updates paused at v1.0.0')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-HOLD-002: Resume updates releases the hold on the server', async () => {
    let resumed = false
    panelWith([held], { registry: [registryEntry({ latest: '2.0.0' })] })
    server.use(http.post('*/api/admin/plugins/trek-gotify/resume-updates', () => {
      resumed = true
      return HttpResponse.json({ updateHold: false })
    }))
    withToast()

    fireEvent.click(await screen.findByRole('button', { name: /resume updates/i }))

    await waitFor(() => expect(resumed).toBe(true))
    expect(await screen.findByText('Updates resumed')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-HOLD-003: Update all skips held plugins', async () => {
    const updated: string[] = []
    panelWith(
      [held, plugin({ id: 'trek-ntfy', name: 'Ntfy', source_repo: 'acme/ntfy', version: '1.0.0', operatorEgress: false })],
      { registry: [registryEntry({ latest: '2.0.0' }), registryEntry({ id: 'trek-ntfy', latest: '3.0.0' })] },
    )
    server.use(http.post('*/api/admin/plugins/:id/update', ({ params }) => {
      updated.push(String(params.id))
      return HttpResponse.json({ version: '3.0.0', activated: true, newPermissions: [], newEgress: [] })
    }))
    withToast()

    expect(await screen.findByText('1 updates available for your plugins.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /update all/i }))

    await waitFor(() => expect(updated).toEqual(['trek-ntfy']))
  })
})

/**
 * The version picker (#plugins): install any published version from the Discover detail
 * modal, and roll an installed plugin back through the update pipeline (which owns the
 * stop-child + re-consent machinery). Compat verdicts are SERVER-computed per version —
 * the picker only renders them, it never re-derives range logic.
 */
describe('AdminPluginsPanel — version picker', () => {
  const VERSIONS = [
    { version: '3.0.0', publishedAt: '2026-08-01', size: 2048, signed: true, trek: '>=4.0.0', compatible: false },
    { version: '2.0.0', publishedAt: '2026-07-01', size: 1024, signed: true, trek: '>=3.0.0 <4.0.0', compatible: true },
    { version: '1.5.0', publishedAt: '2026-06-01', size: 1000, signed: true, trek: '>=3.0.0 <4.0.0', compatible: true },
  ]
  const detailWithVersions = () => ({
    ...registryEntry({ latest: '3.0.0', latestCompatible: '2.0.0', trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false }),
    size: 1024, publishedAt: null, manifest: null, versions: VERSIONS,
  })

  function mockDiscoverDetail() {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [] })),
      http.get('*/api/admin/plugins/registry', () =>
        HttpResponse.json([registryEntry({ latest: '3.0.0', latestCompatible: '2.0.0', trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false })])),
      http.get('*/api/admin/plugins/registry/trek-gotify', () => HttpResponse.json(detailWithVersions())),
    )
  }

  it('FE-COMP-PLUGINS-VPICK-001: the detail modal lists every version and installs the picked one', async () => {
    let body: unknown = null
    mockDiscoverDetail()
    server.use(http.post('*/api/admin/plugins/install', async ({ request }) => {
      body = await request.json()
      return HttpResponse.json({ id: 'trek-gotify', version: '1.5.0' })
    }))
    withToast()
    const tabs = await screen.findAllByRole('tab', { name: /^discover/i })
    fireEvent.click(tabs[0])
    fireEvent.click(await screen.findByText('Gotify'))

    fireEvent.click(await screen.findByRole('button', { name: /^install 1\.5\.0$/i }))

    await waitFor(() => expect(body).toEqual({ id: 'trek-gotify', version: '1.5.0' }))
  })

  it('FE-COMP-PLUGINS-VPICK-002: an incompatible version is greyed with its TREK requirement, not installable', async () => {
    mockDiscoverDetail()
    render(<AdminPluginsPanel />)
    const tabs = await screen.findAllByRole('tab', { name: /^discover/i })
    fireEvent.click(tabs[0])
    fireEvent.click(await screen.findByText('Gotify'))

    expect(await screen.findByText(/^needs TREK >=4\.0\.0$/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^install 3\.0\.0$/i })).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-VPICK-003: Change version rolls back through update, after an explicit data warning', async () => {
    let body: unknown = null
    panelWith([plugin({ source_repo: 'acme/gotify', version: '2.0.0', operatorEgress: false })], {
      registry: [registryEntry({ latest: '2.0.0' })],
    })
    server.use(
      http.get('*/api/admin/plugins/registry/trek-gotify', () => HttpResponse.json(detailWithVersions())),
      http.post('*/api/admin/plugins/trek-gotify/update', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ version: '1.5.0', activated: true, newPermissions: [], newEgress: [] })
      }),
    )
    withToast()
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'))
    fireEvent.click(await screen.findByRole('button', { name: /change version/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^switch to 1\.5\.0$/i }))

    // The rollback keeps the plugin's data — the older code may not read it. Informed consent, no snapshot.
    expect(await screen.findByText(/data written by the newer version stays in place/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /roll back/i }))

    await waitFor(() => expect(body).toEqual({ version: '1.5.0' }))
  })

  it('FE-COMP-PLUGINS-VPICK-004: picking a NEWER version in the picker updates without the downgrade warning', async () => {
    let body: unknown = null
    panelWith([plugin({ source_repo: 'acme/gotify', version: '1.5.0', operatorEgress: false })], {
      registry: [registryEntry({ latest: '2.0.0' })],
    })
    server.use(
      http.get('*/api/admin/plugins/registry/trek-gotify', () => HttpResponse.json(detailWithVersions())),
      http.post('*/api/admin/plugins/trek-gotify/update', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] })
      }),
    )
    withToast()
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'))
    fireEvent.click(await screen.findByRole('button', { name: /change version/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^switch to 2\.0\.0$/i }))

    await waitFor(() => expect(body).toEqual({ version: '2.0.0' }))
    expect(screen.queryByText(/data written by the newer version stays in place/i)).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-VPICK-005: the installed version is marked and not switchable; sideloads get no picker', async () => {
    panelWith([
      plugin({ source_repo: 'acme/gotify', version: '2.0.0', operatorEgress: false }),
      plugin({ id: 'side-load', name: 'Sideload', source_repo: 'local:upload', version: '1.0.0', operatorEgress: false }),
    ], { registry: [registryEntry({ latest: '2.0.0' })] })
    server.use(http.get('*/api/admin/plugins/registry/trek-gotify', () => HttpResponse.json(detailWithVersions())))
    withToast()

    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-side-load'))
    expect(screen.queryByRole('button', { name: /change version/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('plugin-row-menu-btn-side-load')) // close

    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'))
    fireEvent.click(await screen.findByRole('button', { name: /change version/i }))

    const current = await screen.findByTestId('version-row-2.0.0')
    expect(within(current).getByText('Installed')).toBeInTheDocument()
    expect(within(current).queryByRole('button', { name: /switch/i })).not.toBeInTheDocument()
  })
})

describe('AdminPluginsPanel — capability and dependency chips', () => {
  it('FE-COMP-PLUGINS-PANEL-035: a permission-rich plugin renders one chip per capability', async () => {
    panelWith([plugin({
      operatorEgress: false,
      permissions: JSON.stringify([
        'db:read:trips', 'db:read:users', 'db:write:costs', 'db:read:packing', 'db:read:files',
        'db:write:places', 'db:write:days', 'db:write:itinerary', 'db:write:trips', 'db:meta',
        'ws:broadcast:trip', 'hook:photo-provider', 'hook:calendar-source', 'hook:place-detail-provider',
        'hook:trip-warning-provider', 'hook:map-layer-provider', 'hook:route-provider',
        'hook:day-schedule-provider', 'geolocation:read', 'events:subscribe', 'http:outbound:api.acme.io',
      ]),
      capabilities: JSON.stringify({ widget: { slot: 'hero' }, tripPage: { replaces: ['places'] } }),
    })])
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    for (const label of [
      'Reads your trips', 'Reads basic profiles', 'Adds costs', 'Reads packing lists', 'Reads trip files',
      'Edits places', 'Edits days', 'Edits itinerary', 'Edits trips', 'Adds metadata',
      'Boarding-pass widget', 'Replaces planner tabs', 'Real-time updates', 'Provides photos',
      'Provides calendar events', 'Enriches places', 'Flags issues', 'Draws on the map', 'Offers routing',
      'Adds plan times', 'Reads your position', 'Reacts to activity', 'api.acme.io',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('FE-COMP-PLUGINS-PANEL-036: read-only costs and a slotted widget each get their own wording', async () => {
    panelWith([plugin({
      operatorEgress: false,
      permissions: JSON.stringify(['db:read:costs']),
      capabilities: JSON.stringify({ widget: { slot: 'place-detail' } }),
    })])
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    expect(screen.getByText('Reads your costs')).toBeInTheDocument()
    expect(screen.getByText('Place detail')).toBeInTheDocument()
    expect(screen.queryByText('Adds costs')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-037: an unparseable capabilities blob degrades to the plain widget chip', async () => {
    panelWith([plugin({ operatorEgress: false, permissions: 'not json', capabilities: JSON.stringify({ widget: {} }) })])
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    expect(screen.getByText('Dashboard widget')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-038: dependency chips flag the addon and plugin the row is waiting on', async () => {
    panelWith([plugin({
      operatorEgress: false,
      dependencies: { requiredAddons: ['journey'], pluginDependencies: [{ id: 'trek-core', version: '^1.0.0' }] },
      dependencyIssues: { disabledAddons: ['journey'], missing: [{ id: 'trek-core', version: '^1.0.0' }], versionMismatch: [] },
    })])
    render(<AdminPluginsPanel />)

    expect(await screen.findByText('Requires journey')).toBeInTheDocument()
    expect(screen.getByText('Needs trek-core ^1.0.0')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-039: a plugin that names no TREK range says so', async () => {
    panelWith([plugin({ operatorEgress: false, dependencyStatus: 'hostIncompatible' })])
    render(<AdminPluginsPanel />)

    expect(await screen.findByText('Does not say which TREK versions it supports')).toBeInTheDocument()
  })
})

describe('AdminPluginsPanel — Discover cards and the detail modal', () => {
  function discoverWith(entry: Record<string, unknown>, detail?: Record<string, unknown>) {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json([registryEntry(entry)])),
      http.get('*/api/admin/plugins/registry/trek-gotify', () =>
        detail ? HttpResponse.json(detail) : HttpResponse.json({ error: 'gone' }, { status: 404 })),
    )
  }

  function manifestDetail(over: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}) {
    return {
      id: 'trek-gotify', name: 'Gotify', author: 'Acme', description: 'Push', repo: 'acme/gotify',
      type: 'integration', tags: [], size: 4096, publishedAt: null, latest: '2.0.0',
      manifest: { permissions: [], egress: [], settings: [], license: 'MIT', icon: null, operatorEgress: false, ...manifest },
      ...over,
    }
  }

  it('FE-COMP-PLUGINS-PANEL-040: a card shows its compact download count and falls back on a broken shot', async () => {
    discoverWith({ downloadCount: 1234, screenshotUrl: 'https://example.com/shot.png', reviewedAt: '2026-01-05T00:00:00Z' })
    const { container } = render(<AdminPluginsPanel />)
    await clickDiscover()

    expect(await screen.findByText('1.2k')).toBeInTheDocument()
    const img = container.querySelector('img') as HTMLImageElement
    expect(screen.getByText('Reviewed')).toBeInTheDocument()
    expect(img).toBeInTheDocument()
    fireEvent.error(img)
    await waitFor(() => expect(container.querySelector('img')).not.toBeInTheDocument())
  })

  it('FE-COMP-PLUGINS-PANEL-040a: a two-digit download count is printed verbatim', async () => {
    discoverWith({ downloadCount: 42 })
    render(<AdminPluginsPanel />)
    await clickDiscover()

    expect(await screen.findByText('42')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-041: opening a card by keyboard shows the modal, and a failed lookup says so', async () => {
    discoverWith({})
    render(<AdminPluginsPanel />)
    await clickDiscover()

    const card = (await screen.findByText('Gotify')).closest('[role="button"]') as HTMLElement
    fireEvent.keyDown(card, { key: 'Enter' })

    expect(await screen.findByText('Could not load plugin details.')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-041a: the card opts out of the global press-scale (#2158)', async () => {
    // jsdom cannot replay the browser mechanics behind #2158: the :active scale on
    // the card shifted the Install button out from under the pointer, so the click
    // retargeted onto the card and opened the detail modal instead of installing.
    // The data-no-press attribute is the pin.
    discoverWith({})
    render(<AdminPluginsPanel />)
    await clickDiscover()

    expect((await screen.findByText('Gotify')).closest('[role="button"]')).toHaveAttribute('data-no-press')
  })

  it('FE-COMP-PLUGINS-PANEL-042: the detail modal lists setup fields, metadata and a separate homepage', async () => {
    discoverWith(
      { downloadCount: 999_500, reviewedAt: '2026-01-05T00:00:00Z', homepage: 'https://gotify.example', trek: '>=3.2.0' },
      manifestDetail({}, {
        permissions: ['db:own'],
        settings: [{ key: 'url', label: 'Server URL', scope: 'instance', required: true }],
      }),
    )
    render(<AdminPluginsPanel />)
    await clickDiscover()
    fireEvent.click(await screen.findByText('Gotify'))

    expect(await screen.findByText('Server URL')).toBeInTheDocument()
    expect(screen.getByText('Instance-wide')).toBeInTheDocument()
    expect(screen.getByText('Required')).toBeInTheDocument()
    expect(screen.getByText('4 KB')).toBeInTheDocument()
    expect(screen.getByText('TREK >=3.2.0')).toBeInTheDocument()
    expect(screen.getByText('Store its own data in an isolated database')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /homepage/i })).toHaveAttribute('href', 'https://gotify.example')
    // 999 500 rounds to a whole megabyte on the card, never "1000k"
    expect(screen.getByText('1M')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-043: a manifest with no readable access says exactly that', async () => {
    discoverWith({ minTrekVersion: '3.2.0' }, manifestDetail({ size: 0 }))
    render(<AdminPluginsPanel />)
    await clickDiscover()
    fireEvent.click(await screen.findByText('Gotify'))

    expect(await screen.findByText('Needs no special access.')).toBeInTheDocument()
    expect(screen.getByText('TREK 3.2.0+')).toBeInTheDocument()
    expect(screen.queryByText('Connects to')).not.toBeInTheDocument()
    expect(screen.queryByText('Setup')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-043b: a manifest that omits the lists still renders the modal', async () => {
    const detail = manifestDetail({ size: 0 })
    delete (detail.manifest as Record<string, unknown>).egress
    delete (detail.manifest as Record<string, unknown>).settings
    delete (detail.manifest as Record<string, unknown>).permissions
    discoverWith({}, detail)
    render(<AdminPluginsPanel />)
    await clickDiscover()
    fireEvent.click(await screen.findByText('Gotify'))

    expect(await screen.findByText('Needs no special access.')).toBeInTheDocument()
    expect(screen.queryByText('Connects to')).not.toBeInTheDocument()
    expect(screen.queryByText('Setup')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-044: an incompatible entry explains the blocked button in the modal body', async () => {
    discoverWith({ compatible: false, latestCompatible: null, trek: '>=4.0.0', hostVersion: '3.3.0' })
    render(<AdminPluginsPanel />)
    await clickDiscover()
    fireEvent.click(await screen.findByText('Gotify'))

    const explanations = await screen.findAllByText(/needs trek >=4\.0\.0 — this server runs 3\.3\.0/i)
    expect(explanations.length).toBeGreaterThan(0)
  })

  it('FE-COMP-PLUGINS-PANEL-045: searching Discover with no hit says the registry has no match', async () => {
    discoverWith({})
    render(<AdminPluginsPanel />)
    await clickDiscover()
    await screen.findByText('Gotify')

    fireEvent.change(screen.getByPlaceholderText('Search plugins…'), { target: { value: 'nothing' } })

    expect(screen.getByText('No plugins in the registry match your search.')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-PANEL-046: installing from a card posts the offered version', async () => {
    let body: unknown = null
    discoverWith({ compatible: false, latestCompatible: '1.5.0', trek: '>=4.0.0', hostVersion: '3.3.0' })
    server.use(http.post('*/api/admin/plugins/install', async ({ request }) => {
      body = await request.json()
      return HttpResponse.json({ ok: true })
    }))
    withToast()
    await clickDiscover()

    fireEvent.click(await screen.findByRole('button', { name: /^install 1\.5\.0$/i }))

    await waitFor(() => expect(body).toEqual({ id: 'trek-gotify', version: '1.5.0' }))
  })

  it('FE-COMP-PLUGINS-PANEL-047: an unreachable registry leaves Discover empty rather than spinning', async () => {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.error()),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('No plugins installed yet.')

    await clickDiscover()

    expect(await screen.findByText('No plugins available in the registry yet.')).toBeInTheDocument()
  })
})

describe('AdminPluginsPanel — security footer', () => {
  it('FE-COMP-PLUGINS-PANEL-048: the containment note expands into its sections', async () => {
    panelWith([])
    render(<AdminPluginsPanel />)
    await screen.findByText('No plugins installed yet.')

    expect(screen.queryByText('Every plugin runs boxed in')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('How plugins are contained — and the limits'))

    expect(screen.getByText('Every plugin runs boxed in')).toBeInTheDocument()
    expect(screen.getByText('What "Reviewed" means')).toBeInTheDocument()
    expect(screen.getByText('What "Signed" means')).toBeInTheDocument()
  })
})

// FE-W5PLG-001 to FE-W5PLG-014 — toolbar filters and sorting, the error-log and
// allowed-hosts dialogs, and the drag-to-install overlay.
describe('AdminPluginsPanel toolbar and dialogs', () => {
  const row = (over: Record<string, unknown> = {}) => plugin({
    id: 'a-widget', name: 'Alpha Widget', description: 'a widget', type: 'widget',
    version: '1.0.0', status: 'active', enabled: 1, operatorEgress: false,
    ...over,
  })

  function mockPanel(rows: Record<string, unknown>[], registry: unknown = []) {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: rows })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json(registry)),
    )
  }

  const three = () => [
    row(),
    row({ id: 'b-integration', name: 'Beta Bridge', description: 'a bridge', type: 'integration', enabled: 0, status: 'inactive' }),
    row({ id: 'c-page', name: 'Gamma Page', description: 'a page', type: 'page', enabled: 1, status: 'error', last_error: 'boom' }),
  ]

  const pickFilter = async (user: ReturnType<typeof userEvent.setup>, filter: RegExp, option: RegExp) => {
    await user.click(screen.getByTitle(filter))
    await user.click(screen.getByRole('button', { name: option }))
  }

  it('FE-W5PLG-001: the search box narrows the installed list by name and description', async () => {
    const user = userEvent.setup()
    mockPanel(three())
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.type(screen.getByPlaceholderText(/search/i), 'bridge')

    await waitFor(() => expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument())
    expect(screen.getByText('Beta Bridge')).toBeInTheDocument()
  })

  it('FE-W5PLG-002: a search with no hits shows the no-match state', async () => {
    const user = userEvent.setup()
    mockPanel(three())
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.type(screen.getByPlaceholderText(/search/i), 'zzzz')

    expect(await screen.findByText(/no.*match/i)).toBeInTheDocument()
  })

  it('FE-W5PLG-003: the type filter keeps only plugins of that type', async () => {
    const user = userEvent.setup()
    mockPanel(three())
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await pickFilter(user, /^Type:/, /^Widget$/)

    await waitFor(() => expect(screen.queryByText('Beta Bridge')).not.toBeInTheDocument())
    expect(screen.getByText('Alpha Widget')).toBeInTheDocument()
  })

  it('FE-W5PLG-004: the status filter separates active, off and errored plugins', async () => {
    const user = userEvent.setup()
    mockPanel(three())
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await pickFilter(user, /^Status:/, /^Active$/)
    await waitFor(() => expect(screen.queryByText('Beta Bridge')).not.toBeInTheDocument())
    expect(screen.queryByText('Gamma Page')).not.toBeInTheDocument()

    await pickFilter(user, /^Status:/, /^Off$/)
    await waitFor(() => expect(screen.getByText('Beta Bridge')).toBeInTheDocument())
    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument()

    await pickFilter(user, /^Status:/, /^Error$/)
    await waitFor(() => expect(screen.getByText('Gamma Page')).toBeInTheDocument())
    expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument()
  })

  it('FE-W5PLG-005: the update filter and the updates-first sort both use the registry version', async () => {
    const user = userEvent.setup()
    mockPanel(three(), [{ id: 'c-page', name: 'Gamma Page', latest: '9.9.9', latestCompatible: '9.9.9' }])
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')
    await waitFor(() => expect(screen.getByText(/updates? available/i)).toBeInTheDocument())

    await pickFilter(user, /^Sort:/, /^Updates first$/)
    await waitFor(() => {
      const names = screen.getAllByText(/Alpha Widget|Beta Bridge|Gamma Page/).map(e => e.textContent)
      expect(names[0]).toBe('Gamma Page')
    })

    await pickFilter(user, /^Status:/, /^Update available$/)
    await waitFor(() => expect(screen.queryByText('Alpha Widget')).not.toBeInTheDocument())
    expect(screen.getByText('Gamma Page')).toBeInTheDocument()
  })

  it('FE-W5PLG-006: switching tabs snaps a tab-only sort key back to name', async () => {
    const user = userEvent.setup()
    mockPanel(three(), [{ id: 'c-page', name: 'Gamma Page', latest: '9.9.9', latestCompatible: '9.9.9' }])
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await pickFilter(user, /^Sort:/, /^Updates first$/)
    expect(screen.getByTitle(/^Sort: Updates first$/)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Discover/ }))
    await waitFor(() => expect(screen.getByTitle(/^Sort: Name$/)).toBeInTheDocument())
  })

  it('FE-W5PLG-007: the registry sorts by downloads and by review date', async () => {
    const user = userEvent.setup()
    const reg = [
      { id: 'r-old', name: 'Old Tool', author: 'a', description: 'd', type: 'widget', downloadCount: 10, reviewedAt: '2024-01-01T00:00:00Z' },
      { id: 'r-new', name: 'New Tool', author: 'b', description: 'd', type: 'widget', downloadCount: 999, reviewedAt: '2026-01-01T00:00:00Z' },
    ]
    mockPanel(three(), reg)
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')
    await user.click(screen.getByRole('tab', { name: /Discover/ }))
    await screen.findByText('Old Tool')

    await pickFilter(user, /^Sort:/, /^Most downloads$/)
    await waitFor(() => {
      const names = screen.getAllByText(/^(Old|New) Tool$/).map(e => e.textContent)
      expect(names[0]).toBe('New Tool')
    })

    await pickFilter(user, /^Sort:/, /^Recently updated$/)
    await waitFor(() => {
      const names = screen.getAllByText(/^(Old|New) Tool$/).map(e => e.textContent)
      expect(names[0]).toBe('New Tool')
    })

    await pickFilter(user, /^Sort:/, /^Name$/)
    await waitFor(() => {
      const names = screen.getAllByText(/^(Old|New) Tool$/).map(e => e.textContent)
      expect(names[0]).toBe('New Tool')
    })
  })

  it('FE-W5PLG-008: the registry search and type filter narrow the discover grid', async () => {
    const user = userEvent.setup()
    const reg = [
      { id: 'r-a', name: 'Mapper', author: 'ann', description: 'maps things', type: 'widget' },
      { id: 'r-b', name: 'Poster', author: 'bob', description: 'posts things', type: 'page' },
    ]
    mockPanel(three(), reg)
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')
    await user.click(screen.getByRole('tab', { name: /Discover/ }))
    await screen.findByText('Mapper')

    await pickFilter(user, /^Type:/, /^Page$/)
    await waitFor(() => expect(screen.queryByText('Mapper')).not.toBeInTheDocument())
    expect(screen.getByText('Poster')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText(/search/i), 'ann')
    await waitFor(() => expect(screen.queryByText('Poster')).not.toBeInTheDocument())
  })

  it('FE-W5PLG-009: the error log lists both levels and closes again', async () => {
    const user = userEvent.setup()
    mockPanel([row()])
    server.use(
      http.get('*/api/admin/plugins/a-widget/errors', () =>
        HttpResponse.json({ errors: [
          { level: 'error', ts: '2026-01-01 10:00', message: 'exploded' },
          { level: 'warn', ts: '2026-01-01 10:01', message: 'wobbled' },
        ] }),
      ),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.click(screen.getByTestId('plugin-row-menu-btn-a-widget'))
    await user.click(screen.getByRole('button', { name: /view error log/i }))

    expect(await screen.findByText('exploded')).toBeInTheDocument()
    expect(screen.getByText('wobbled')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument()
    expect(screen.getByText('warn')).toBeInTheDocument()

    const dialog = screen.getByText('exploded').closest('.fixed') as HTMLElement
    await user.click(within(dialog).getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByText('exploded')).not.toBeInTheDocument())
  })

  it('FE-W5PLG-010: an empty error log says so and the backdrop closes it', async () => {
    const user = userEvent.setup()
    mockPanel([row()])
    server.use(
      http.get('*/api/admin/plugins/a-widget/errors', () => HttpResponse.json({ errors: [] })),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.click(screen.getByTestId('plugin-row-menu-btn-a-widget'))
    await user.click(screen.getByRole('button', { name: /view error log/i }))

    const empty = await screen.findByText(/no errors/i)
    fireEvent.click(empty.closest('.fixed') as HTMLElement)
    await waitFor(() => expect(screen.queryByText(/no errors/i)).not.toBeInTheDocument())
  })

  it('FE-W5PLG-011: a plugin whose runtime cannot take extra hosts says so', async () => {
    const user = userEvent.setup()
    // Declares operatorEgress (so the menu item shows), but the runtime lookup
    // disagrees — the dialog's unsupported notice is the truth-teller.
    mockPanel([row({ operatorEgress: true })])
    server.use(
      http.get('*/api/admin/plugins/a-widget/egress-hosts', () => HttpResponse.json({ supported: false, hosts: [] })),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.click(screen.getByTestId('plugin-row-menu-btn-a-widget'))
    await user.click(screen.getByRole('button', { name: /allowed hosts/i }))

    expect(await screen.findByText(/does not|not supported|no outbound/i)).toBeInTheDocument()
  })

  it('FE-W5PLG-012: a failing egress lookup still opens the dialog in the unsupported state', async () => {
    const user = userEvent.setup()
    mockPanel([row({ operatorEgress: true })])
    server.use(
      http.get('*/api/admin/plugins/a-widget/egress-hosts', () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.click(screen.getByTestId('plugin-row-menu-btn-a-widget'))
    await user.click(screen.getByRole('button', { name: /allowed hosts/i }))

    expect(await screen.findByText(/a-widget —/)).toBeInTheDocument()
  })

  it('FE-W5PLG-013: dragging a file over the panel arms the drop overlay', async () => {
    mockPanel([row()])
    const { container } = render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')
    const panel = container.firstElementChild as HTMLElement

    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'] } })
    expect(await screen.findByText(/drop.*to (upload|install)/i)).toBeInTheDocument()

    // nested enter/leave pairs must not disarm it early
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'] } })
    fireEvent.dragLeave(panel)
    expect(screen.getByText(/drop.*to (upload|install)/i)).toBeInTheDocument()

    fireEvent.dragLeave(panel)
    await waitFor(() => expect(screen.queryByText(/drop.*to (upload|install)/i)).not.toBeInTheDocument())
  })

  it('FE-W5PLG-014: dropping a plugin archive uploads it', async () => {
    let uploaded = false
    mockPanel([row()])
    server.use(
      http.post('*/api/admin/plugins/upload', () => { uploaded = true; return HttpResponse.json({ id: 'a-widget' }) }),
    )
    const { container } = render(
      <>
        <AdminPluginsPanel />
        <ToastContainer />
      </>,
    )
    await screen.findByText('Alpha Widget')
    const panel = container.firstElementChild as HTMLElement

    const file = new File(['zip'], 'plugin.zip', { type: 'application/zip' })
    fireEvent.drop(panel, { dataTransfer: { files: [file] } })

    await waitFor(() => expect(uploaded).toBe(true))
  })

  it('FE-W5PLG-015: the click-away layer closes an open filter menu', async () => {
    const user = userEvent.setup()
    mockPanel([row()])
    const { container } = render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.click(screen.getByTitle(/^Type:/))
    expect(screen.getByRole('button', { name: /^Widget$/ })).toBeInTheDocument()

    const layer = container.querySelector('.fixed.inset-0.z-20') as HTMLElement
    fireEvent.click(layer)
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Widget$/ })).not.toBeInTheDocument())
  })
})

// FE-W5PLG-016 to FE-W5PLG-023 — registry cards, the detail modal and the
// dependency chips of an installed row.
describe('AdminPluginsPanel registry cards and dependency chips', () => {
  const row = (over: Record<string, unknown> = {}) => plugin({
    id: 'a-widget', name: 'Alpha Widget', description: 'a widget', type: 'widget',
    version: '1.0.0', status: 'active', enabled: 1, operatorEgress: false,
    permissions: JSON.stringify([]),
    ...over,
  })

  const regItem = (over: Record<string, unknown> = {}) => ({
    id: 'r-a', name: 'Mapper', author: 'ann', description: 'maps things', type: 'widget',
    latest: '2.0.0', repo: 'ann/mapper', signed: true, ...over,
  })

  function mockPanel(rows: Record<string, unknown>[], registry: unknown = []) {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: rows })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json(registry)),
    )
  }

  const openDiscover = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('tab', { name: /Discover/ }))
  }

  it('FE-W5PLG-016: leaving Discover snaps the downloads sort back to name', async () => {
    const user = userEvent.setup()
    mockPanel([row()], [regItem({ downloadCount: 5 })])
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await openDiscover(user)
    await user.click(screen.getByTitle(/^Sort:/))
    await user.click(screen.getByRole('button', { name: /^Most downloads$/ }))
    expect(screen.getByTitle(/^Sort: Most downloads$/)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Installed/ }))
    await waitFor(() => expect(screen.getByTitle(/^Sort: Name$/)).toBeInTheDocument())
  })

  it('FE-W5PLG-017: an outrun release offers the newest compatible version instead of a dead button', async () => {
    const user = userEvent.setup()
    mockPanel([row()], [
      regItem({ id: 'r-old', name: 'Older Fit', compatible: false, latestCompatible: '1.4.0', trek: '>=4', hostVersion: '3.5.0' }),
      regItem({ id: 'r-dead', name: 'No Fit', compatible: false, latestCompatible: null, trek: null }),
    ])
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')
    await openDiscover(user)

    const offer = await screen.findByRole('button', { name: /^Install 1\.4\.0$/ })
    expect(offer).not.toBeDisabled()
    expect(offer).toHaveAttribute('title', expect.stringContaining('3.5.0'))

    const dead = screen.getByRole('button', { name: /^Incompatible$/ })
    expect(dead).toBeDisabled()
    expect(dead.getAttribute('title')).toBeTruthy()
  })

  it('FE-W5PLG-018: an already installed registry entry cannot be installed again', async () => {
    const user = userEvent.setup()
    mockPanel([row({ id: 'r-a', name: 'Mapper' })], [regItem({ reviewedAt: '2026-01-01T00:00:00Z', downloadCount: 1234 })])
    render(<AdminPluginsPanel />)
    await screen.findByText('Mapper')
    await openDiscover(user)

    expect(await screen.findByText('1.2k')).toBeInTheDocument()
    const installBtn = screen.getAllByRole('button', { name: /^Installed$/ })[0]
    expect(installBtn).toBeDisabled()
  })

  it('FE-W5PLG-019: a registry card opens its detail modal by click and by keyboard', async () => {
    const user = userEvent.setup()
    mockPanel([row()], [regItem({ reviewedAt: '2026-01-01T00:00:00Z', homepage: 'https://mapper.example' })])
    server.use(
      http.get('*/api/admin/plugins/registry/r-a', () =>
        HttpResponse.json({ size: 4096, manifest: { icon: 'Map', permissions: ['db:read:trips'], egress: ['api.mapper.example'], operatorEgress: false, settings: [] } })),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')
    await openDiscover(user)

    const card = screen.getByText('Mapper').closest('[role="button"]') as HTMLElement
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Mapper' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('heading', { name: 'Mapper' }).closest('.fixed') as HTMLElement)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Mapper' })).not.toBeInTheDocument())

    fireEvent.keyDown(card, { key: ' ' })
    expect(await screen.findByRole('heading', { name: 'Mapper' })).toBeInTheDocument()
  })

  it('FE-W5PLG-020: a failing detail fetch still shows the modal shell', async () => {
    const user = userEvent.setup()
    mockPanel([row()], [regItem()])
    server.use(
      http.get('*/api/admin/plugins/registry/r-a', () => HttpResponse.json({ error: 'gone' }, { status: 404 })),
    )
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')
    await openDiscover(user)

    await user.click(screen.getByText('Mapper'))

    expect(await screen.findByRole('heading', { name: 'Mapper' })).toBeInTheDocument()
    expect(screen.getByText(/ann · v2\.0\.0/)).toBeInTheDocument()
  })

  it('FE-W5PLG-021: dependency chips flag a disabled addon and a missing plugin', async () => {
    mockPanel([row({
      dependencies: { requiredAddons: ['budget', 'vacay'], pluginDependencies: [{ id: 'dep-a', version: '^1' }, { id: 'dep-b', version: '^2' }] },
      dependencyStatus: 'blocked',
      dependencyIssues: { disabledAddons: ['vacay'], missing: [{ id: 'dep-a' }], versionMismatch: [{ id: 'dep-b' }] },
    })])
    render(<AdminPluginsPanel />)

    await screen.findByText('Alpha Widget')
    expect(screen.getByText(/budget/)).toBeInTheDocument()
    expect(screen.getByText(/vacay/)).toBeInTheDocument()
    expect(screen.getByText(/dep-a/)).toBeInTheDocument()
    expect(screen.getByText(/dep-b/)).toBeInTheDocument()
  })

  it('FE-W5PLG-022: a plugin whose TREK range is unknown still gets an incompatibility chip', async () => {
    mockPanel([row({ dependencyStatus: 'hostIncompatible', trekRange: null, hostVersion: null })])
    render(<AdminPluginsPanel />)

    await screen.findByText('Alpha Widget')
    expect(screen.getByText(/does not say which trek/i)).toBeInTheDocument()
  })

  it('FE-W5PLG-023: a registry-sourced row links to its repository and issue tracker', async () => {
    const user = userEvent.setup()
    mockPanel([row({ source_repo: 'ann/mapper', reviewed_at: '2026-01-01T00:00:00Z', version: null, description: null, status: 'weird' })])
    render(<AdminPluginsPanel />)
    await screen.findByText('Alpha Widget')

    await user.click(screen.getByTestId('plugin-row-menu-btn-a-widget'))
    const repo = screen.getByRole('link', { name: /source|repository/i })
    expect(repo).toHaveAttribute('href', 'https://github.com/ann/mapper')
    expect(screen.getByRole('link', { name: /issue/i })).toHaveAttribute('href', 'https://github.com/ann/mapper/issues')

    await user.click(repo)
    await waitFor(() => expect(screen.queryByRole('link', { name: /issue/i })).not.toBeInTheDocument())
  })
})

// FE-W5PLG-024 to FE-W5PLG-028 — the signature dialog's fingerprint rendering
// and the remaining dialog dismissals.
describe('AdminPluginsPanel signature fingerprints and dismissals', () => {
  const blocked = (over: Record<string, unknown> = {}) => plugin({
    source_repo: 'acme/gotify', signed: true, keyFingerprint: 'OLDKEYaa…aaaaaaaa',
    updateBlock: { code: 'SIGNATURE_KEY_CHANGED', detail: 'the signing key changed', version: '2.0.0' },
    ...over,
  })

  function mockPanel(row: Record<string, unknown>, registry: unknown[] = []) {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [row] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json(registry)),
    )
  }

  it('FE-W5PLG-024: a long new key is shown head…tail next to the pinned one', async () => {
    const key = 'untrusted comment: minisign key\nRWQf6LRCGA9iA1234567890ABCDEFGH'
    mockPanel(blocked(), [{ id: 'trek-gotify', name: 'Gotify', author: 'acme', description: 'd', type: 'integration', latest: '2.0.0', authorPublicKey: key }])
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))

    expect(await screen.findByText('OLDKEYaa…aaaaaaaa')).toBeInTheDocument()
    expect(screen.getByText('RWQf6LRC…ABCDEFGH')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /trust the new key/i })).toBeInTheDocument()
  })

  it('FE-W5PLG-025: a short key is shown in full and a missing pinned key falls back to a dash', async () => {
    mockPanel(blocked({ keyFingerprint: null }), [
      { id: 'trek-gotify', name: 'Gotify', author: 'acme', description: 'd', type: 'integration', latest: '2.0.0', authorPublicKey: 'SHORTKEY' },
    ])
    render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))

    expect(await screen.findByText('SHORTKEY')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('FE-W5PLG-026: without a registry entry there is no key to offer and no override', async () => {
    mockPanel(blocked())
    render(<AdminPluginsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))

    expect(await screen.findByText('OLDKEYaa…aaaaaaaa')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /trust the new key/i })).not.toBeInTheDocument()
  })

  it('FE-W5PLG-027: an incomplete signature gets its own explanation and closes on the backdrop', async () => {
    mockPanel(blocked({ updateBlock: { code: 'SIGNATURE_INCOMPLETE', detail: 'only half signed', version: '2.0.0' } }))
    render(<AdminPluginsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /review/i }))
    const detail = await screen.findByText('only half signed')

    fireEvent.click(detail.closest('.fixed') as HTMLElement)
    await waitFor(() => expect(screen.queryByText('only half signed')).not.toBeInTheDocument())
  })

  it('FE-W5PLG-028: the allowed-hosts dialog closes from its header button and its backdrop', async () => {
    const user = userEvent.setup()
    mockPanel(plugin({ egressHostCount: 1 }))
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
        HttpResponse.json({ supported: true, hosts: ['gotify.mydomain.com'] })),
    )
    render(<AdminPluginsPanel />)

    await user.click(await screen.findByRole('button', { name: /1 allowed host/i }))
    const host = await screen.findByText('gotify.mydomain.com')
    const dialog = host.closest('.fixed') as HTMLElement

    await user.click(within(dialog).getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByText('gotify.mydomain.com')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /1 allowed host/i }))
    const reopened = (await screen.findByText('gotify.mydomain.com')).closest('.fixed') as HTMLElement
    fireEvent.click(reopened)
    await waitFor(() => expect(screen.queryByText('gotify.mydomain.com')).not.toBeInTheDocument())
  })

  it('FE-W5PLG-029: a drop without a file is ignored', async () => {
    let uploaded = false
    mockPanel(plugin())
    server.use(
      http.post('*/api/admin/plugins/upload', () => { uploaded = true; return HttpResponse.json({ id: 'x' }) }),
    )
    const { container } = render(<AdminPluginsPanel />)
    await screen.findByText('Gotify')

    fireEvent.drop(container.firstElementChild as HTMLElement, { dataTransfer: { files: [] } })

    await waitFor(() => expect(uploaded).toBe(false))
  })
})

// FE-W5PLG-030 — Update all drives the same single-slot busy flag as a per-row update,
// so the requests have to go out one after another.
describe('AdminPluginsPanel — update all', () => {
  const updatableRow = (over: Record<string, unknown> = {}) => plugin({
    id: 'a-widget', name: 'Alpha Widget', type: 'widget', version: '1.0.0', operatorEgress: false, ...over,
  })

  it('FE-W5PLG-030: Update all sends the second update only after the first came back', async () => {
    const started: string[] = []
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({
        enabled: true, devLink: false,
        plugins: [updatableRow(), updatableRow({ id: 'b-widget', name: 'Beta Widget' })],
      })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json([
        { id: 'a-widget', name: 'Alpha Widget', author: 'acme', description: 'd', type: 'widget', latest: '2.0.0', latestCompatible: '2.0.0' },
        { id: 'b-widget', name: 'Beta Widget', author: 'acme', description: 'd', type: 'widget', latest: '2.0.0', latestCompatible: '2.0.0' },
      ])),
      http.post('*/api/admin/plugins/:id/update', async ({ params }) => {
        started.push(String(params.id))
        if (started.length === 1) await gate
        return HttpResponse.json({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] })
      }),
    )
    render(<AdminPluginsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /update all/i }))

    await waitFor(() => expect(started).toHaveLength(1))
    // Give a parallel dispatch every chance to show up before releasing the first.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toEqual(['a-widget'])

    release()
    await waitFor(() => expect(started).toEqual(['a-widget', 'b-widget']))
  })
})

/**
 * The admin-owned `scope:'instance'` settings form. The fields are declared manifest
 * data (validated at install), the values live in the plugin's instance config, and a
 * save may RESTART a running plugin — the child reads config once, at init — so the
 * admin must be told when that happened rather than wondering why the plugin blinked.
 */
describe('AdminPluginsPanel — instance settings', () => {
  const FIELDS = [
    { key: 'apiUrl', label: 'API URL', input_type: 'text', required: true, secret: false },
    { key: 'apiKey', label: 'API key', input_type: 'text', required: false, secret: true },
  ]

  async function openRowMenu(p: Record<string, unknown>) {
    mockList(p)
    render(<><ToastContainer /><AdminPluginsPanel /></>)
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'))
  }

  async function openSettings(config: Record<string, unknown> = { apiUrl: 'https://gotify.mydomain.com', apiKey: '••••••••' }) {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () => HttpResponse.json({ fields: FIELDS, config })),
    )
    await openRowMenu(plugin({ instanceSettingsCount: 2 }))
    fireEvent.click(screen.getByText('Instance settings'))
    await waitFor(() => expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument(), { timeout: 5000 })
  }

  it('FE-COMP-PLUGINS-CFG-001: a plugin with instance fields offers the menu item, opening the form', async () => {
    await openSettings()
    // Both declared fields render, the secret as a masked password input.
    expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument()
    expect(screen.getByDisplayValue('••••••••')).toHaveAttribute('type', 'password')
  })

  it('FE-COMP-PLUGINS-CFG-002: a plugin with NO instance fields gets no menu item', async () => {
    await openRowMenu(plugin({ instanceSettingsCount: 0, instanceActionsCount: 0 }))
    expect(screen.getByText('View error log')).toBeInTheDocument() // menu is open
    expect(screen.queryByText('Instance settings')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-008: a plugin with instance ACTIONS but no fields still offers the menu item', async () => {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ fields: [], config: {}, actions: [{ key: 'ping', label: 'Ping server', danger: false, scope: 'instance' }] })),
    )
    await openRowMenu(plugin({ instanceSettingsCount: 0, instanceActionsCount: 1 }))
    expect(screen.getByText('Instance settings')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Instance settings'))
    expect(await screen.findByRole('button', { name: 'Ping server' }, { timeout: 5000 })).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-003: saving sends the edits but never the untouched secret mask', async () => {
    let body: Record<string, unknown> | null = null
    server.use(
      http.put('*/api/admin/plugins/trek-gotify/config', async ({ request }) => {
        body = await request.json() as Record<string, unknown>
        return HttpResponse.json({ config: body, restarted: false })
      }),
    )
    await openSettings()

    fireEvent.change(screen.getByDisplayValue('https://gotify.mydomain.com'), { target: { value: 'https://new.example' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('Settings saved', {}, { timeout: 5000 })).toBeInTheDocument()
    // The mask is a display artifact, not a value — sending it would overwrite the stored secret.
    expect(body).toEqual({ apiUrl: 'https://new.example' })
  })

  it('FE-COMP-PLUGINS-CFG-004: a save that restarted the running plugin says so', async () => {
    server.use(
      http.put('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ config: { apiUrl: 'https://gotify.mydomain.com' }, restarted: true })),
    )
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('Settings saved — plugin restarted', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-005: renders every declared field type and saves the edited values', async () => {
    const RICH = [
      { key: 'mode', label: 'Mode', input_type: 'select', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }], hint: 'Pick one' },
      { key: 'enabled', input_type: 'checkbox' }, // no label — the key stands in
      { key: 'retries', label: 'Retries', input_type: 'number', required: true },
    ]
    let body: Record<string, unknown> | null = null
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ fields: RICH, config: { mode: 'slow', enabled: true } })),
      http.put('*/api/admin/plugins/trek-gotify/config', async ({ request }) => {
        body = await request.json() as Record<string, unknown>
        return HttpResponse.json({ config: body, restarted: false })
      }),
    )
    await openRowMenu(plugin({ instanceSettingsCount: 3 }))
    fireEvent.click(screen.getByText('Instance settings'))

    // Stored values land in the right controls; an unset value renders empty.
    const select = await screen.findByRole('combobox', {}, { timeout: 5000 })
    expect(select).toHaveValue('slow')
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('spinbutton')).toHaveValue(null)
    expect(screen.getByText('Pick one')).toBeInTheDocument() // hint
    expect(screen.getByText('enabled')).toBeInTheDocument() // label falls back to the key

    fireEvent.change(select, { target: { value: 'fast' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('Settings saved', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(body).toEqual({ mode: 'fast', enabled: false, retries: '3' })
  })

  const ACTIONS = [
    { key: 'ping', label: 'Ping server', danger: false, scope: 'instance' },
    { key: 'purge', label: 'Purge cache', hint: 'Drops every cached tile', danger: true, scope: 'instance' },
  ]

  async function openWithActions(p: Record<string, unknown> = plugin({ instanceSettingsCount: 2 })) {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ fields: FIELDS, config: { apiUrl: 'https://gotify.mydomain.com' }, actions: ACTIONS })),
    )
    await openRowMenu(p)
    fireEvent.click(screen.getByText('Instance settings'))
    await waitFor(() => expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument(), { timeout: 5000 })
  }

  it('FE-COMP-PLUGINS-ACT-010: instance actions render below the fields and run against the admin route', async () => {
    let posted = ''
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/actions/:key', ({ params }) => {
        posted = String(params.key)
        return HttpResponse.json({ ok: true, message: 'pong' })
      }),
    )
    await openWithActions()
    expect(screen.getByText('Drops every cached tile')).toBeInTheDocument() // hint
    fireEvent.click(screen.getByRole('button', { name: 'Ping server' }))
    expect(await screen.findByText('pong', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(posted).toBe('ping')
    // The dialog stays open — the admin may run another one.
    expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-ACT-011: a danger action asks first; confirming runs it', async () => {
    let posted = ''
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/actions/:key', ({ params }) => {
        posted = String(params.key)
        return HttpResponse.json({ ok: false, message: 'cache locked' })
      }),
    )
    await openWithActions()
    fireEvent.click(screen.getByRole('button', { name: 'Purge cache' }))
    expect(await screen.findByText('Run this action?')).toBeInTheDocument()
    expect(posted).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))
    expect(await screen.findByText('cache locked', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(posted).toBe('purge')
  })

  it('FE-COMP-PLUGINS-ACT-012: an inactive plugin shows the buttons disabled with the activation hint', async () => {
    await openWithActions(plugin({ instanceSettingsCount: 2, status: 'inactive', enabled: 0 }))
    expect(screen.getByRole('button', { name: 'Ping server' })).toBeDisabled()
    expect(screen.getByText('Activate the plugin to run its actions')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-ACT-013: a dirty form is saved before the action runs', async () => {
    const calls: string[] = []
    server.use(
      http.put('*/api/admin/plugins/trek-gotify/config', () => { calls.push('save'); return HttpResponse.json({ config: {}, restarted: false }) }),
      http.post('*/api/admin/plugins/trek-gotify/actions/:key', () => { calls.push('run'); return HttpResponse.json({ ok: true }) }),
    )
    await openWithActions()
    fireEvent.change(screen.getByDisplayValue('https://gotify.mydomain.com'), { target: { value: 'https://new.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ping server' }))
    await waitFor(() => expect(calls).toEqual(['save', 'run']), { timeout: 5000 })
  })

  it('FE-COMP-PLUGINS-CFG-006: a failed config fetch is a toast, not a broken dialog', async () => {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
    )
    await openRowMenu(plugin({ instanceSettingsCount: 2 }))
    fireEvent.click(screen.getByText('Instance settings'))

    expect(await screen.findByText('Error', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-007: a rejected save shows the server reason and keeps the dialog open', async () => {
    server.use(
      http.put('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ error: 'config refused' }, { status: 400 })),
    )
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('config refused', {}, { timeout: 5000 })).toBeInTheDocument()
    // Still open — the admin's edits are not thrown away on a refusal.
    expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-008: the dialog closes without saving', async () => {
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))

    expect(screen.queryByDisplayValue('https://gotify.mydomain.com')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-009: pre-fills a declared default when no value is stored', async () => {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () => HttpResponse.json({
        fields: [{ key: 'oauth_authorize_url', label: 'Authorize URL', input_type: 'text', required: true, secret: false, default: 'https://auth.openbnb.org/authorize' }],
        config: {},
      })),
    )
    await openRowMenu(plugin({ instanceSettingsCount: 1 }))
    fireEvent.click(screen.getByText('Instance settings'))

    expect(await screen.findByDisplayValue('https://auth.openbnb.org/authorize', {}, { timeout: 5000 })).toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-010: a stored value wins over the default', async () => {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () => HttpResponse.json({
        fields: [{ key: 'oauth_authorize_url', label: 'Authorize URL', input_type: 'text', required: false, secret: false, default: 'https://auth.openbnb.org/authorize' }],
        config: { oauth_authorize_url: 'https://mine.example' },
      })),
    )
    await openRowMenu(plugin({ instanceSettingsCount: 1 }))
    fireEvent.click(screen.getByText('Instance settings'))

    expect(await screen.findByDisplayValue('https://mine.example', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByDisplayValue('https://auth.openbnb.org/authorize')).not.toBeInTheDocument()
  })

  it('FE-COMP-PLUGINS-CFG-011: blocks Save while a required field is empty and names it', async () => {
    let called = false
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () => HttpResponse.json({
        fields: [{ key: 'client_id', label: 'Client ID', input_type: 'text', required: true, secret: false }],
        config: {},
      })),
      http.put('*/api/admin/plugins/trek-gotify/config', () => { called = true; return HttpResponse.json({ config: {}, restarted: false }) }),
    )
    await openRowMenu(plugin({ instanceSettingsCount: 1 }))
    fireEvent.click(screen.getByText('Instance settings'))
    await screen.findByText('Client ID', {}, { timeout: 5000 })

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText('"Client ID" is required', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('FE-COMP-PLUGINS-CFG-012: Save paints its label with the accent-text token, so a light accent stays readable', async () => {
    await openSettings()

    // `--accent-text` flips per scheme and per light/dark; a hard white label vanishes on
    // the near-white accent the dark theme uses by default.
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save.className).toContain('text-accent-text')
    expect(save.className).not.toContain('text-white')
  })
})

/**
 * TREK_PLUGINS_IGNORE_TREK_RANGE. The server turns its version gates into warnings; the
 * panel's job is to make sure the admin actually SEES the warning — before a registry
 * install, after a sideload/link that could not be asked first, and on the row for as
 * long as the plugin keeps running outside the range its author vouched for.
 */
describe('AdminPluginsPanel — TREK-range bypass (TREK_PLUGINS_IGNORE_TREK_RANGE)', () => {
  function bypassPanel(plugins: Record<string, unknown>[], entry: Record<string, unknown> | null) {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, ignoreTrekRange: true, plugins })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json(entry ? [entry] : [])),
    )
  }
  const incompatibleEntry = () => registryEntry({ trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false, latestCompatible: null })

  it('FE-PLG-BYPASS-001: says so in the header', async () => {
    bypassPanel([plugin()], null)
    render(<AdminPluginsPanel />)
    expect(await screen.findByText('Version checks off')).toBeInTheDocument()
  })

  it('FE-PLG-BYPASS-002: offers "Install anyway" for an incompatible entry and asks before installing', async () => {
    let posted: unknown = null
    bypassPanel([plugin({ id: 'something-else' })], incompatibleEntry())
    server.use(http.post('*/api/admin/plugins/install', async ({ request }) => {
      posted = await request.json()
      return HttpResponse.json({ id: 'trek-gotify', version: '2.0.0', trekRangeBypassed: { trekRange: '>=4.0.0', hostVersion: '3.3.0' } })
    }))
    withToast()
    fireEvent.click(await screen.findByText('Discover'))

    const btn = await screen.findByRole('button', { name: /^install anyway$/i })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)

    const dialog = await screen.findByRole('dialog', { name: /outside its supported trek versions/i })
    expect(within(dialog).getByText(/no guarantee/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/corrupt trek data/i)).toBeInTheDocument()
    expect(posted).toBeNull() // nothing sent until the admin accepts the risk

    fireEvent.click(within(dialog).getByRole('button', { name: /^install anyway$/i }))
    await waitFor(() => expect(posted).toEqual({ id: 'trek-gotify' }))
  })

  it('FE-PLG-BYPASS-003: cancelling the warning installs nothing', async () => {
    let posted = false
    bypassPanel([plugin({ id: 'something-else' })], incompatibleEntry())
    server.use(http.post('*/api/admin/plugins/install', () => { posted = true; return HttpResponse.json({ id: 'trek-gotify', version: '2.0.0', trekRangeBypassed: null }) }))
    withToast()
    fireEvent.click(await screen.findByText('Discover'))
    fireEvent.click(await screen.findByRole('button', { name: /^install anyway$/i }))

    const dialog = await screen.findByRole('dialog', { name: /outside its supported trek versions/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /outside its supported trek versions/i })).not.toBeInTheDocument())
    expect(posted).toBe(false)
  })

  it('FE-PLG-BYPASS-004: a sideload that landed outside its range is warned about afterwards', async () => {
    bypassPanel([plugin()], null)
    server.use(http.post('*/api/admin/plugins/upload', () =>
      HttpResponse.json({ id: 'trek-new', version: '1.0.0', replaced: false, trekRangeBypassed: { trekRange: null, hostVersion: '3.3.0' } })))
    const { container } = withToast()
    await screen.findByText('Gotify')

    await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, new File(['zip'], 'plugin.zip', { type: 'application/zip' }))

    const dialog = await screen.findByRole('dialog', { name: /installed outside its supported trek versions/i })
    expect(within(dialog).getByText(/no guarantee/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/trek-new/)).toBeInTheDocument()
  })

  it('FE-PLG-BYPASS-005: a plugin running outside its range keeps a warning chip on its row', async () => {
    bypassPanel([plugin({
      dependencyStatus: 'ok', trekRange: '>=3.2.0 <4.0.0', hostVersion: '4.0.0',
      trekRangeBypassed: { trekRange: '>=3.2.0 <4.0.0', hostVersion: '4.0.0' },
    })], null)
    render(<AdminPluginsPanel />)
    expect(await screen.findByText(/outside its trek range \(>=3\.2\.0 <4\.0\.0\)/i)).toBeInTheDocument()
  })
})
