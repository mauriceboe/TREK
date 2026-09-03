// FE-MOB-PLUGP-001 onwards
import { http, HttpResponse } from 'msw';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '../../../helpers/render';
import { resetAllStores } from '../../../helpers/store';
import { server } from '../../../helpers/msw/server';
import MAdminPluginsPanel from '../../../../src/mobile/screens/admin/MAdminPluginsPanel';

type Row = Record<string, unknown>;

function plugin(over: Row = {}): Row {
  return {
    id: 'trek-gotify',
    name: 'Gotify',
    description: 'Push notifications',
    type: 'integration',
    icon: 'Bell',
    version: '1.0.0',
    status: 'active',
    enabled: 1,
    last_error: null,
    reviewed_at: null,
    source_repo: null,
    permissions: JSON.stringify(['hook:notification-channel', 'http:outbound:gotify.net']),
    capabilities: '{}',
    operatorEgress: false,
    egressHostCount: 0,
    dependencyStatus: 'ok',
    dependencyIssues: { disabledAddons: [], missing: [], versionMismatch: [] },
    ...over,
  };
}

function registryEntry(over: Row = {}): Row {
  return {
    id: 'trek-gotify',
    name: 'Gotify',
    author: 'Acme',
    description: 'Push notifications for TREK',
    repo: 'acme/gotify',
    type: 'integration',
    latest: '2.0.0',
    // The real browse response always carries latestCompatible (server-side hostCompat);
    // mirror `latest` by default, exactly like a fully-compatible entry.
    latestCompatible: (over.latest as string | undefined) ?? '2.0.0',
    minTrekVersion: null,
    reviewedAt: null,
    screenshotUrl: null,
    downloadCount: null,
    signed: true,
    authorPublicKey: 'untrusted comment: minisign public key\nRWQ12345678MIDDLE87654321',
    ...over,
  };
}

/** The two calls every mount makes: the installed list, then (if non-empty) the registry. */
function mockPanel(plugins: Row[], registry: Row[] = [], extra: Row = {}) {
  server.use(
    http.get('*/api/admin/plugins', () =>
      HttpResponse.json({ enabled: true, devLink: false, plugins, ...extra })),
    http.get('*/api/admin/plugins/registry', () => HttpResponse.json(registry)),
  );
}

let toasts: Array<{ message: string; type: string }> = [];

beforeEach(() => {
  resetAllStores();
  toasts = [];
  // useToast is a thin wrapper around this global; the ToastContainer is never mounted here.
  window.__addToast = ((message: string, type?: string) => {
    toasts.push({ message, type: type ?? 'info' });
    return toasts.length;
  }) as Window['__addToast'];
  // refresh() also nudges the app-wide active-plugin store.
  server.use(http.get('*/api/plugins', () => HttpResponse.json({ plugins: [] })));
});

function toastMessages() {
  return toasts.map(t => t.message);
}

// MSheet binds its Escape listener in an effect, so a key fired the moment the
// sheet's content appears can land before the listener exists. Retry until the
// sheet is actually gone rather than pressing once and hoping.
const escapeUntilGone = (text: string) =>
  waitFor(() => {
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

describe('MAdminPluginsPanel — load states', () => {
  it('FE-MOB-PLUGP-001: shows the load error when the plugin list cannot be fetched', async () => {
    server.use(http.get('*/api/admin/plugins', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    render(<MAdminPluginsPanel />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(await screen.findByText('Could not load plugins.')).toBeInTheDocument();
    // No toolbar behind an error — there is nothing to filter.
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-002: explains that the runtime is off and hides the toolbar', async () => {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: false, plugins: [] })),
    );
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Plugins are disabled')).toBeInTheDocument();
    expect(screen.queryByText('Runtime on')).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-003: an empty install list offers the Discover jump', async () => {
    mockPanel([], [registryEntry()]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('No plugins installed yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Discover/ }));

    // The registry only loads once the tab is opened for an empty instance.
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });
});

describe('MAdminPluginsPanel — the installed row', () => {
  it('FE-MOB-PLUGP-004: renders name, version, runtime badge and the capability chips', async () => {
    mockPanel([plugin()]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Gotify')).toBeInTheDocument();
    expect(screen.getByText('Runtime on')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Push notifications')).toBeInTheDocument();
    // Derived from the permission list, not from a separate field.
    expect(screen.getByText('Notification channel')).toBeInTheDocument();
    expect(screen.getByText('gotify.net')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-005: covers the whole capability vocabulary, including a replaced planner tab', async () => {
    mockPanel([plugin({
      permissions: JSON.stringify([
        'db:read:trips', 'db:read:users', 'db:write:costs', 'db:read:packing', 'db:read:files',
        'db:write:places', 'db:write:days', 'db:write:itinerary', 'db:write:trips', 'db:meta',
        'ws:broadcast:trip', 'hook:photo-provider', 'hook:calendar-source', 'hook:place-detail-provider',
        'hook:trip-warning-provider', 'hook:map-layer-provider', 'hook:route-provider',
        'hook:day-schedule-provider', 'geolocation:read', 'events:subscribe',
      ]),
      capabilities: JSON.stringify({ widget: { slot: 'hero' }, tripPage: { replaces: ['costs'] } }),
    })]);
    render(<MAdminPluginsPanel />);

    await screen.findByText('Gotify');
    for (const label of [
      'Reads your trips', 'Reads basic profiles', 'Adds costs', 'Reads packing lists', 'Reads trip files',
      'Edits places', 'Edits days', 'Edits itinerary', 'Edits trips', 'Adds metadata',
      'Boarding-pass widget', 'Replaces planner tabs', 'Real-time updates', 'Provides photos',
      'Provides calendar events', 'Enriches places', 'Flags issues', 'Draws on the map',
      'Offers routing', 'Adds plan times', 'Reads your position', 'Reacts to activity',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('FE-MOB-PLUGP-006: read-only costs downgrade the costs chip and a broken permissions blob degrades to none', async () => {
    mockPanel([
      plugin({ id: 'reader', name: 'Reader', permissions: JSON.stringify(['db:read:costs']) }),
      plugin({ id: 'broken', name: 'Broken', permissions: 'not-json', capabilities: 'not-json' }),
    ]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Reads your costs')).toBeInTheDocument();
    expect(screen.queryByText('Adds costs')).not.toBeInTheDocument();
    // The unparseable row still renders — a bad blob must not take the panel down.
    expect(screen.getByText('Broken')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-007: an errored plugin shows its last error instead of the chips', async () => {
    mockPanel([plugin({ status: 'error', last_error: 'child exited with code 1' })]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('child exited with code 1')).toBeInTheDocument();
    expect(screen.queryByText('Notification channel')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-008: dependency chips name the blocker — addon, plugin and TREK range', async () => {
    mockPanel([plugin({
      enabled: 0,
      status: 'inactive',
      dependencyStatus: 'hostIncompatible',
      trekRange: '>=3.2.0 <4.0.0',
      hostVersion: '4.0.0',
      dependencies: { requiredAddons: ['budget'], pluginDependencies: [{ id: 'trek-base', version: '^1.0.0' }] },
      dependencyIssues: { disabledAddons: ['budget'], missing: [{ id: 'trek-base', version: '^1.0.0' }], versionMismatch: [] },
    })]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Needs TREK >=3.2.0 <4.0.0 — this server runs 4.0.0')).toBeInTheDocument();
    expect(screen.getByText('Requires budget')).toBeInTheDocument();
    expect(screen.getByText('Needs trek-base ^1.0.0')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-009: a plugin that never declared a TREK range says so', async () => {
    mockPanel([plugin({ dependencyStatus: 'hostIncompatible', trekRange: null })]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Does not say which TREK versions it supports')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-010: the source badge wins over the trust badge', async () => {
    mockPanel([
      plugin({ id: 'a', name: 'Registry one', source_repo: 'acme/gotify', signed: true, reviewed_at: '2026-01-01' }),
      plugin({ id: 'b', name: 'Registry two', source_repo: 'acme/other', signed: false }),
      plugin({ id: 'c', name: 'Uploaded', source_repo: 'local:upload', signed: false }),
      plugin({ id: 'd', name: 'Linked', source_repo: 'local:link', signed: false }),
    ]);
    render(<MAdminPluginsPanel />);

    await screen.findByText('Registry one');
    expect(screen.getByText('Signed')).toBeInTheDocument();
    // Exactly one Unsigned — the sideloaded and dev-linked rows say something stronger.
    expect(screen.getAllByText('Unsigned')).toHaveLength(1);
    expect(screen.getByText('Sideloaded')).toBeInTheDocument();
    expect(screen.getByText('Dev-Link')).toBeInTheDocument();
    expect(screen.getByLabelText('Reviewed')).toBeInTheDocument();
  });
});

describe('MAdminPluginsPanel — toolbar', () => {
  const rows = [
    plugin({ id: 'alpha', name: 'Alpha', description: 'the first', type: 'widget', enabled: 1, status: 'active' }),
    plugin({ id: 'beta', name: 'Beta', description: 'the second', type: 'page', enabled: 0, status: 'inactive' }),
    plugin({ id: 'gamma', name: 'Gamma', description: 'the third', type: 'integration', status: 'error', last_error: 'nope' }),
  ];

  it('FE-MOB-PLUGP-011: the search box filters on name and description', async () => {
    mockPanel(rows);
    render(<MAdminPluginsPanel />);
    await screen.findByText('Alpha');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'second' } });
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing here' } });
    expect(screen.getByText('No installed plugins match your search.')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-012: the type sheet narrows the list to one plugin type', async () => {
    mockPanel(rows);
    render(<MAdminPluginsPanel />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByTitle('Type: All types'));
    fireEvent.click(await screen.findByRole('button', { name: 'Page' }));

    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByTitle('Type: Page')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-013: the status sheet separates on, off and errored plugins', async () => {
    mockPanel(rows);
    render(<MAdminPluginsPanel />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByTitle('Status: All'));
    fireEvent.click(await screen.findByRole('button', { name: 'Off' }));
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Status: Off'));
    fireEvent.click(await screen.findByRole('button', { name: 'Error' }));
    await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument());
    expect(screen.getByText('Gamma')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Status: Error'));
    fireEvent.click(await screen.findByRole('button', { name: 'Active' }));
    await waitFor(() => expect(screen.queryByText('Gamma')).not.toBeInTheDocument());
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-014: "Updates first" ranks the updatable plugin above an alphabetically earlier one', async () => {
    mockPanel(
      [
        plugin({ id: 'alpha', name: 'Alpha', version: '1.0.0' }),
        plugin({ id: 'zulu', name: 'Zulu', version: '1.0.0' }),
      ],
      [registryEntry({ id: 'zulu', name: 'Zulu', latest: '2.0.0' }), registryEntry({ id: 'alpha', name: 'Alpha', latest: '1.0.0' })],
    );
    render(<MAdminPluginsPanel />);
    await screen.findByText('1 updates available for your plugins.');

    fireEvent.click(screen.getByTitle('Sort: Name'));
    fireEvent.click(await screen.findByRole('button', { name: 'Updates first' }));

    await waitFor(() => {
      const names = screen.getAllByText(/^(Alpha|Zulu)$/).map(n => n.textContent);
      expect(names).toEqual(['Zulu', 'Alpha']);
    });
  });

  it('FE-MOB-PLUGP-015: the "update available" status filter keeps only the plugin with an update', async () => {
    mockPanel(
      [plugin({ id: 'alpha', name: 'Alpha', version: '1.0.0' }), plugin({ id: 'zulu', name: 'Zulu', version: '9.0.0' })],
      [registryEntry({ id: 'alpha', name: 'Alpha', latest: '2.0.0' }), registryEntry({ id: 'zulu', name: 'Zulu', latest: '9.0.0' })],
    );
    render(<MAdminPluginsPanel />);
    await screen.findByText('1 updates available for your plugins.');

    fireEvent.click(screen.getByTitle('Status: All'));
    fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));

    await waitFor(() => expect(screen.queryByText('Zulu')).not.toBeInTheDocument());
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('MAdminPluginsPanel — Discover', () => {
  async function openDiscover(entries: Row[]) {
    mockPanel([], entries);
    const view = render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));
    return view;
  }

  it('FE-MOB-PLUGP-016: a registry card carries author, type, version, downloads and the reviewed ribbon', async () => {
    await openDiscover([registryEntry({ reviewedAt: '2026-01-05T00:00:00Z', downloadCount: 1234, screenshotUrl: null })]);

    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Integration')).toBeInTheDocument();
    expect(screen.getByText('v2.0.0')).toBeInTheDocument();
    expect(screen.getByText('1.2k')).toBeInTheDocument();
    expect(screen.getAllByText('Reviewed').length).toBeGreaterThan(0);
  });

  it('FE-MOB-PLUGP-017: installing from a card posts the id and reports success', async () => {
    let body: unknown = null;
    await openDiscover([registryEntry()]);
    server.use(http.post('*/api/admin/plugins/install', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ok: true });
    }));

    fireEvent.click(await screen.findByRole('button', { name: /^Install$/ }));
    await waitFor(() => expect(body).toEqual({ id: 'trek-gotify' }));
    await waitFor(() => expect(toastMessages()).toContain('Installed'));
  });

  it('FE-MOB-PLUGP-018: an entry no published version fits gets a dead, explained button', async () => {
    await openDiscover([registryEntry({ trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false, latestCompatible: null })]);

    const btn = await screen.findByRole('button', { name: 'Incompatible' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Needs TREK >=4.0.0 — this server runs 3.3.0');
  });

  it('FE-MOB-PLUGP-019: when only an older release fits, that version is offered and installed', async () => {
    let body: unknown = null;
    await openDiscover([registryEntry({ trek: '>=3.4.0', hostVersion: '3.3.0', compatible: false, latestCompatible: '1.5.0' })]);
    server.use(http.post('*/api/admin/plugins/install', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ok: true });
    }));

    fireEvent.click(await screen.findByRole('button', { name: 'Install 1.5.0' }));
    await waitFor(() => expect(body).toEqual({ id: 'trek-gotify', version: '1.5.0' }));
  });

  it('FE-MOB-PLUGP-020: an already-installed plugin cannot be installed twice', async () => {
    mockPanel([plugin()], [registryEntry()]);
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));

    const btn = await screen.findByRole('button', { name: 'Installed' });
    expect(btn).toBeDisabled();
  });

  it('FE-MOB-PLUGP-021: an empty registry and a filtered-to-nothing registry read differently', async () => {
    await openDiscover([]);
    expect(await screen.findByText('No plugins available in the registry yet.')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-022: a search with no registry hit says so', async () => {
    await openDiscover([registryEntry()]);
    await screen.findByText('Acme');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No plugins in the registry match your search.')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-023: an unreachable registry degrades to an empty list, not a crash', async () => {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json({ error: 'down' }, { status: 500 })),
    );
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Discover/ }));

    expect(await screen.findByText('No plugins available in the registry yet.')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-024: Discover sorts by downloads and by review date', async () => {
    await openDiscover([
      registryEntry({ id: 'a', name: 'Aaa', downloadCount: 5, reviewedAt: '2026-01-01T00:00:00Z' }),
      registryEntry({ id: 'z', name: 'Zzz', downloadCount: 900, reviewedAt: '2026-06-01T00:00:00Z' }),
    ]);
    await screen.findByText('Aaa');

    fireEvent.click(screen.getByTitle('Sort: Name'));
    fireEvent.click(await screen.findByRole('button', { name: 'Most downloads' }));
    await waitFor(() => {
      expect(screen.getAllByText(/^(Aaa|Zzz)$/).map(n => n.textContent)).toEqual(['Zzz', 'Aaa']);
    });

    fireEvent.click(screen.getByTitle('Sort: Most downloads'));
    fireEvent.click(await screen.findByRole('button', { name: 'Recently updated' }));
    await waitFor(() => {
      expect(screen.getAllByText(/^(Aaa|Zzz)$/).map(n => n.textContent)).toEqual(['Zzz', 'Aaa']);
    });
  });

  it('FE-MOB-PLUGP-025: switching back to Installed drops a sort key that tab cannot offer', async () => {
    await openDiscover([registryEntry()]);
    await screen.findByText('Acme');

    fireEvent.click(screen.getByTitle('Sort: Name'));
    fireEvent.click(await screen.findByRole('button', { name: 'Most downloads' }));
    await waitFor(() => expect(screen.getByTitle('Sort: Most downloads')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }));
    await waitFor(() => expect(screen.getByTitle('Sort: Name')).toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-026: a broken screenshot falls back to the placeholder tile', async () => {
    const { container } = await openDiscover([registryEntry({ screenshotUrl: 'https://example.test/shot.png' })]);

    await screen.findByText('Acme');
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', 'https://example.test/shot.png');

    fireEvent.error(img);
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
  });

  it('FE-MOB-PLUGP-027: the card opens the detail sheet from the keyboard too', async () => {
    await openDiscover([registryEntry()]);
    server.use(http.get('*/api/admin/plugins/registry/trek-gotify', () =>
      HttpResponse.json({ ...registryEntry(), size: null, publishedAt: null, manifest: null })));

    const card = (await screen.findByText('Acme')).closest('[role="button"]') as HTMLElement;
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-093: the card opts out of the global press-scale (#2158)', async () => {
    // jsdom cannot replay the browser mechanics behind #2158: the :active scale on
    // the card shifted the Install button out from under the pointer, so the tap
    // retargeted onto the card and opened the detail sheet instead of installing.
    // The data-no-press attribute is the pin.
    await openDiscover([registryEntry()]);

    expect((await screen.findByText('Acme')).closest('[role="button"]')).toHaveAttribute('data-no-press');
  });
});

describe('MAdminPluginsPanel — the registry detail sheet', () => {
  const manifest = {
    permissions: ['db:own', 'db:read:trips', 'http:outbound:gotify.net'],
    egress: ['gotify.net'],
    operatorEgress: true,
    settings: [{ key: 'token', label: 'API token', inputType: 'password', scope: 'instance', required: true }],
    license: 'MIT',
    icon: 'Bell',
  };

  async function openDetail(detail: Row, entry: Row = registryEntry()) {
    mockPanel([], [entry]);
    server.use(http.get('*/api/admin/plugins/registry/trek-gotify', () => HttpResponse.json(detail)));
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));
    fireEvent.click(await screen.findByText('Acme'));
    return screen.findByRole('dialog');
  }

  it('FE-MOB-PLUGP-028: lists access, outbound hosts, the operator caveat, setup fields and the meta grid', async () => {
    const entry = registryEntry({ reviewedAt: '2026-01-05T00:00:00Z', downloadCount: 4200, trek: '>=3.2.0 <4.0.0' });
    await openDetail({ ...entry, size: 4096, publishedAt: null, manifest }, entry);

    expect(await screen.findByText('What it can access')).toBeInTheDocument();
    expect(screen.getByText('Reads your trips')).toBeInTheDocument();
    expect(screen.getByText('Store its own data in an isolated database')).toBeInTheDocument();
    expect(screen.getByText('gotify.net')).toBeInTheDocument();
    expect(screen.getByText('+ hosts you add')).toBeInTheDocument();
    expect(screen.getByText('API token')).toBeInTheDocument();
    expect(screen.getByText('Instance-wide')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('4 KB')).toBeInTheDocument();
    expect(screen.getByText('TREK >=3.2.0 <4.0.0')).toBeInTheDocument();
    expect(screen.getByText('4,200')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-029: a plugin that needs nothing says so, and falls back to the min-version line', async () => {
    await openDetail(
      { ...registryEntry({ minTrekVersion: '3.0.0' }), size: null, publishedAt: null,
        manifest: { permissions: [], egress: [], settings: [], license: null, icon: null } },
      registryEntry({ minTrekVersion: '3.0.0' }),
    );

    expect(await screen.findByText('Needs no special access.')).toBeInTheDocument();
    expect(screen.getByText('TREK 3.0.0+')).toBeInTheDocument();
    expect(screen.queryByText('Connects to')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-092: the manifest capabilities are chipped before the install decision', async () => {
    await openDetail({
      ...registryEntry(),
      size: null,
      publishedAt: null,
      manifest: {
        ...manifest,
        capabilities: { widget: { slot: 'hero' }, tripPage: { replaces: ['places'] } },
      },
    });

    expect(await screen.findByText('Replaces planner tabs')).toBeInTheDocument();
    expect(screen.getByText('Boarding-pass widget')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-030: a failed detail fetch is reported inside the sheet', async () => {
    mockPanel([], [registryEntry()]);
    server.use(http.get('*/api/admin/plugins/registry/trek-gotify', () =>
      HttpResponse.json({ error: 'nope' }, { status: 500 })));
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Discover/ }));
    fireEvent.click(await screen.findByText('Acme'));

    expect(await screen.findByText('Could not load plugin details.')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-031: the blocked reason is spelled out in the sheet, not just as a tooltip', async () => {
    const entry = registryEntry({ trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false, latestCompatible: null });
    await openDetail({ ...entry, size: null, publishedAt: null, manifest: null }, entry);

    expect(await screen.findAllByText('Needs TREK >=4.0.0 — this server runs 3.3.0')).toHaveLength(1);
  });

  it('FE-MOB-PLUGP-032: a distinct homepage gets its own link, and the sheet closes again', async () => {
    await openDetail(
      { ...registryEntry({ homepage: 'https://gotify.example' }), size: null, publishedAt: null, manifest: null },
      registryEntry({ homepage: 'https://gotify.example' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /Homepage/ })).toHaveAttribute('href', 'https://gotify.example');
    expect(within(dialog).getByRole('link', { name: /Source repository/ })).toHaveAttribute('href', 'https://github.com/acme/gotify');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-033: installing straight from the sheet uses the offered version', async () => {
    let body: unknown = null;
    const entry = registryEntry({ trek: '>=3.4.0', hostVersion: '3.3.0', compatible: false, latestCompatible: '1.5.0' });
    await openDetail({ ...entry, size: null, publishedAt: null, manifest: null }, entry);
    server.use(http.post('*/api/admin/plugins/install', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ok: true });
    }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install 1.5.0' }));
    await waitFor(() => expect(body).toEqual({ id: 'trek-gotify', version: '1.5.0' }));
  });
});

describe('MAdminPluginsPanel — the row action sheet', () => {
  async function openRowMenu(over: Row = {}) {
    mockPanel([plugin(over)]);
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'));
    return screen.findByRole('dialog');
  }

  it('FE-MOB-PLUGP-CFG-005: Allowed hosts is offered only to a plugin that declared operatorEgress', async () => {
    // An admin must never be invited to widen egress for a plugin that didn't ask for it
    // — same rule the row's egress chip already follows. (Fixture default: operatorEgress false.)
    const dialog = await openRowMenu();

    expect(within(dialog).getByText('View error log')).toBeInTheDocument(); // sheet is open
    expect(within(dialog).queryByText('Allowed hosts')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-034: a registry plugin offers every action plus the repository links', async () => {
    const dialog = await openRowMenu({ source_repo: 'acme/gotify', operatorEgress: true });

    for (const label of ['Restart', 'View error log', 'Allowed hosts', 'Source repository', 'Report an issue', 'Delete']) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
    expect(within(dialog).getByRole('link', { name: /Report an issue/ }))
      .toHaveAttribute('href', 'https://github.com/acme/gotify/issues');
  });

  it('FE-MOB-PLUGP-035: a sideloaded, disabled plugin gets neither Restart nor repo links', async () => {
    const dialog = await openRowMenu({ source_repo: 'local:upload', enabled: 0, status: 'inactive' });

    expect(within(dialog).queryByText('Restart')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Source repository')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Delete')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-036: Restart cycles the plugin off and on', async () => {
    const calls: string[] = [];
    await openRowMenu();
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/deactivate', () => { calls.push('deactivate'); return HttpResponse.json({ ok: true }); }),
      http.post('*/api/admin/plugins/trek-gotify/activate', () => { calls.push('activate'); return HttpResponse.json({ ok: true }); }),
    );

    fireEvent.click(screen.getByText('Restart'));
    await waitFor(() => expect(calls).toEqual(['deactivate', 'activate']));
    expect(toastMessages()).toContain('Plugin restarted');
  });

  it('FE-MOB-PLUGP-037: the error log sheet lists the recorded lines', async () => {
    await openRowMenu();
    server.use(http.get('*/api/admin/plugins/trek-gotify/errors', () =>
      HttpResponse.json({ errors: [{ ts: '2026-07-01T10:00:00Z', level: 'error', message: 'ECONNREFUSED' }] })));

    fireEvent.click(screen.getByText('View error log'));
    expect(await screen.findByText('ECONNREFUSED')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-038: a failing error-log fetch still opens the sheet, empty', async () => {
    await openRowMenu();
    server.use(http.get('*/api/admin/plugins/trek-gotify/errors', () =>
      HttpResponse.json({ error: 'nope' }, { status: 500 })));

    fireEvent.click(screen.getByText('View error log'));
    expect(await screen.findByText('No errors logged.')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-039: Delete asks first, then uninstalls with its data', async () => {
    let body: unknown = null;
    await openRowMenu();
    server.use(http.post('*/api/admin/plugins/trek-gotify/uninstall', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ok: true });
    }));

    fireEvent.click(screen.getByText('Delete'));
    expect(await screen.findByText('Uninstall plugin?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(body).toEqual({ deleteData: true }));
    await waitFor(() => expect(toastMessages()).toContain('Plugin uninstalled'));
  });

  it('FE-MOB-PLUGP-040: cancelling the uninstall confirmation calls nothing', async () => {
    let called = false;
    await openRowMenu();
    server.use(http.post('*/api/admin/plugins/trek-gotify/uninstall', () => { called = true; return HttpResponse.json({ ok: true }); }));

    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Uninstall plugin?')).not.toBeInTheDocument());
    expect(called).toBe(false);
  });
});

describe('MAdminPluginsPanel — operator-supplied egress hosts', () => {
  it('FE-MOB-PLUGP-041: the chip invites a first host and turns into a count once one exists', async () => {
    mockPanel([plugin({ operatorEgress: true, egressHostCount: 0 })]);
    const { unmount } = render(<MAdminPluginsPanel />);
    expect(await screen.findByRole('button', { name: 'Add allowed host' })).toBeInTheDocument();
    unmount();

    mockPanel([plugin({ operatorEgress: true, egressHostCount: 2 })]);
    render(<MAdminPluginsPanel />);
    expect(await screen.findByRole('button', { name: '2 allowed host(s)' })).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-042: the sheet adds and removes hosts through the API', async () => {
    const bodies: unknown[] = [];
    mockPanel([plugin({ operatorEgress: true, egressHostCount: 1 })]);
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
        HttpResponse.json({ supported: true, hosts: ['gotify.mydomain.test'] })),
      http.put('*/api/admin/plugins/trek-gotify/egress-hosts', async ({ request }) => {
        const body = await request.json() as { hosts: string[] };
        bodies.push(body);
        return HttpResponse.json({ hosts: body.hosts });
      }),
    );
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: '1 allowed host(s)' }));
    expect(await screen.findByText('gotify.mydomain.test')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('gotify.example.com'), { target: { value: ' ntfy.mydomain.test ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(bodies[0]).toEqual({ hosts: ['gotify.mydomain.test', 'ntfy.mydomain.test'] }));

    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]);
    await waitFor(() => expect(bodies[1]).toEqual({ hosts: ['ntfy.mydomain.test'] }));
  });

  it('FE-MOB-PLUGP-043: a rejected save surfaces the server message and keeps the sheet open', async () => {
    mockPanel([plugin({ operatorEgress: true, egressHostCount: 0 })]);
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () => HttpResponse.json({ supported: true, hosts: [] })),
      http.put('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
        HttpResponse.json({ error: 'not a hostname' }, { status: 400 })),
    );
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add allowed host' }));
    expect(await screen.findByText('No hosts added yet.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('gotify.example.com'), { target: { value: 'not a host' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('not a hostname')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-044: a plugin with fixed manifest hosts says the sheet does not apply', async () => {
    // Declares operatorEgress (so the menu item shows), but the runtime lookup
    // disagrees — the sheet's unsupported notice is the truth-teller.
    mockPanel([plugin({ source_repo: 'acme/gotify', operatorEgress: true })]);
    server.use(http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
      HttpResponse.json({ supported: false, hosts: [] })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'));
    fireEvent.click(screen.getByText('Allowed hosts'));
    expect(await screen.findByText(/does not use operator-supplied hosts/i)).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-045: a failing hosts fetch degrades to the unsupported notice', async () => {
    mockPanel([plugin({ operatorEgress: true, egressHostCount: 0 })]);
    server.use(http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
      HttpResponse.json({ error: 'nope' }, { status: 500 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add allowed host' }));
    expect(await screen.findByText(/does not use operator-supplied hosts/i)).toBeInTheDocument();
  });
});

describe('MAdminPluginsPanel — updates and consent', () => {
  it('FE-MOB-PLUGP-046: the updates bar updates every outdated plugin at once', async () => {
    const updated: string[] = [];
    mockPanel(
      [plugin({ id: 'a', name: 'Aaa', version: '1.0.0' }), plugin({ id: 'b', name: 'Bbb', version: '1.0.0' })],
      [registryEntry({ id: 'a', name: 'Aaa', latest: '2.0.0' }), registryEntry({ id: 'b', name: 'Bbb', latest: '1.1.0' })],
    );
    server.use(http.post('*/api/admin/plugins/:id/update', ({ params }) => {
      updated.push(String(params.id));
      return HttpResponse.json({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] });
    }));
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('2 updates available for your plugins.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
    await waitFor(() => expect(updated.sort()).toEqual(['a', 'b']));
    await waitFor(() => expect(toastMessages()).toContain('Plugin updated'));
  });

  it('FE-MOB-PLUGP-046a: an update this TREK cannot install is neither offered nor counted', async () => {
    mockPanel(
      [plugin({ source_repo: 'acme/gotify', version: '1.0.0' })],
      [registryEntry({ latest: '2.0.0', latestCompatible: null, trek: '>=4.0.0', hostVersion: '3.3.0' })],
    );
    render(<MAdminPluginsPanel />);
    await screen.findByText('Gotify');

    expect(screen.queryByText(/updates available for your plugins/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update → v2\.0\.0/i })).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-046b: a newer version needing a newer TREK leaves a passive hint on the row', async () => {
    mockPanel(
      [plugin({ source_repo: 'acme/gotify', version: '1.0.0' })],
      [registryEntry({ latest: '2.0.0', latestCompatible: null, trek: '>=4.0.0', hostVersion: '3.3.0' })],
    );
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('v2.0.0 available — needs TREK >=4.0.0')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-046f: a held plugin leaves the banner and offers Resume updates instead', async () => {
    let resumed = false;
    mockPanel(
      [plugin({ source_repo: 'acme/gotify', version: '1.0.0', updateHold: true })],
      [registryEntry({ latest: '2.0.0' })],
    );
    server.use(http.post('*/api/admin/plugins/trek-gotify/resume-updates', () => {
      resumed = true;
      return HttpResponse.json({ updateHold: false });
    }));
    render(<MAdminPluginsPanel />);
    await screen.findByText('Gotify');

    expect(screen.queryByText(/updates available for your plugins/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update → v2\.0\.0/i })).not.toBeInTheDocument();
    expect(screen.getByText('Updates paused at v1.0.0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /resume updates/i }));
    await waitFor(() => expect(resumed).toBe(true));
  });

  it('FE-MOB-PLUGP-046d: the detail sheet lists every version and installs the picked one', async () => {
    const bodies: unknown[] = [];
    mockPanel([], [registryEntry({ latest: '3.0.0', latestCompatible: '2.0.0', trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false })]);
    server.use(
      http.get('*/api/admin/plugins/registry/trek-gotify', () => HttpResponse.json({
        ...registryEntry({ latest: '3.0.0', latestCompatible: '2.0.0', trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false }),
        size: 1024, publishedAt: null, manifest: null,
        versions: [
          { version: '3.0.0', publishedAt: '2026-08-01', size: 2048, signed: true, trek: '>=4.0.0', compatible: false },
          { version: '2.0.0', publishedAt: '2026-07-01', size: 1024, signed: true, trek: '>=3.0.0 <4.0.0', compatible: true },
          { version: '1.5.0', publishedAt: '2026-06-01', size: 1000, signed: true, trek: '>=3.0.0 <4.0.0', compatible: true },
        ],
      })),
      http.post('*/api/admin/plugins/install', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 'trek-gotify', version: '1.5.0' });
      }),
    );
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));
    fireEvent.click(await screen.findByText('Acme'));

    // The incompatible latest is explained, never offered.
    expect(await screen.findByText(/^needs TREK >=4\.0\.0$/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install 3\.0\.0$/i })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /^install 1\.5\.0$/i }));
    await waitFor(() => expect(bodies).toEqual([{ id: 'trek-gotify', version: '1.5.0' }]));
  });

  it('FE-MOB-PLUGP-046e: Change version rolls back through update, after an explicit data warning', async () => {
    let body: unknown = null;
    mockPanel(
      [plugin({ source_repo: 'acme/gotify', version: '2.0.0' })],
      [registryEntry()],
    );
    server.use(
      http.get('*/api/admin/plugins/registry/trek-gotify', () => HttpResponse.json({
        ...registryEntry(), size: 1024, publishedAt: null, manifest: null,
        versions: [
          { version: '2.0.0', publishedAt: '2026-07-01', size: 1024, signed: true, trek: '>=3.0.0 <4.0.0', compatible: true },
          { version: '1.5.0', publishedAt: '2026-06-01', size: 1000, signed: true, trek: '>=3.0.0 <4.0.0', compatible: true },
        ],
      })),
      http.post('*/api/admin/plugins/trek-gotify/update', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ version: '1.5.0', activated: true, newPermissions: [], newEgress: [] });
      }),
    );
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'));
    fireEvent.click(await screen.findByRole('button', { name: /change version/i }));

    // The installed version is marked, not switchable.
    const current = await screen.findByTestId('version-row-2.0.0');
    expect(within(current).getByText('Installed')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /^switch to 1\.5\.0$/i }));
    expect(await screen.findByText(/data written by the newer version stays in place/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /roll back/i }));

    await waitFor(() => expect(body).toEqual({ version: '1.5.0' }));
  });

  it('FE-MOB-PLUGP-046c: the update offer is the newest compatible version, not the absolute latest', async () => {
    mockPanel(
      [plugin({ source_repo: 'acme/gotify', version: '1.0.0' })],
      [registryEntry({ latest: '3.0.0', latestCompatible: '2.0.0', trek: '>=4.0.0', hostVersion: '3.3.0' })],
    );
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('1 updates available for your plugins.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update → v2\.0\.0/i })).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-047: a per-row update that widens rights opens the consent sheet and approving activates with consent', async () => {
    let consentBody: unknown = null;
    mockPanel([plugin({ source_repo: 'acme/gotify', signed: true, version: '1.0.0' })], [registryEntry()]);
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/update', () =>
        HttpResponse.json({ version: '2.0.0', activated: false, newPermissions: ['db:read:trips', 'x:unknown'], newEgress: ['api.acme.test'] })),
      http.post('*/api/admin/plugins/trek-gotify/activate', async ({ request }) => {
        consentBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update → v2.0.0' }));
    expect(await screen.findByText('This update needs new permissions')).toBeInTheDocument();
    // A known permission reads as prose, an unknown one as its raw code.
    expect(screen.getByText('Read trips the acting user can access')).toBeInTheDocument();
    expect(screen.getByText('x:unknown')).toBeInTheDocument();
    expect(screen.getByText('api.acme.test')).toBeInTheDocument();
    // The registry entry is signed, so no unsigned caveat.
    expect(screen.queryByText(/Nothing ties this version to its author/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve & turn on' }));
    await waitFor(() => expect(consentBody).toEqual({ consent: true }));
  });

  it('FE-MOB-PLUGP-048: "Keep off for now" drops the prompt and says the update stays off', async () => {
    mockPanel([plugin({ source_repo: 'acme/gotify', version: '1.0.0' })], [registryEntry()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/update', () =>
      HttpResponse.json({ version: '2.0.0', activated: false, newPermissions: ['db:read:trips'], newEgress: [] })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update → v2.0.0' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep off for now' }));

    await waitFor(() => expect(toastMessages()).toContain('Update installed — left off until you approve the new permissions'));
    await waitFor(() => expect(screen.queryByText('This update needs new permissions')).not.toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-049: an unsigned update says nothing ties it to its author', async () => {
    mockPanel([plugin({ source_repo: 'acme/gotify', signed: false, version: '1.0.0' })], [registryEntry({ signed: false })]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/update', () =>
      HttpResponse.json({ version: '2.0.0', activated: false, newPermissions: ['db:read:trips'], newEgress: [] })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update → v2.0.0' }));
    expect(await screen.findByText(/Nothing ties this version to its author/)).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-050: a failed update reports the server message', async () => {
    mockPanel([plugin({ source_repo: 'acme/gotify', version: '1.0.0' })], [registryEntry()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/update', () =>
      HttpResponse.json({ error: 'registry unreachable' }, { status: 502 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update → v2.0.0' }));
    await waitFor(() => expect(toastMessages()).toContain('registry unreachable'));
  });
});

describe('MAdminPluginsPanel — signature refusals', () => {
  const blocked = (code: string) => plugin({
    source_repo: 'acme/gotify', signed: true, keyFingerprint: 'OLDKEYaa…aaaaaaaa', version: '1.0.0',
    updateBlock: { code, detail: 'the signing key changed', version: '2.0.0' },
  });

  it('FE-MOB-PLUGP-051: the row keeps showing why the update was refused', async () => {
    mockPanel([blocked('SIGNATURE_KEY_CHANGED')], [registryEntry()]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Update blocked — the signing key changed')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-052: the block goes quiet once the registry offers a newer version', async () => {
    mockPanel([blocked('SIGNATURE_KEY_CHANGED')], [registryEntry({ latest: '3.0.0' })]);
    render(<MAdminPluginsPanel />);

    await screen.findByText('Gotify');
    await waitFor(() => expect(screen.queryByText(/Update blocked/)).not.toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-053: a sideloaded plugin never shows an update block', async () => {
    mockPanel([plugin({ source_repo: 'local:upload', updateBlock: { code: 'SIGNATURE_KEY_CHANGED', detail: 'x', version: '2.0.0' } })]);
    render(<MAdminPluginsPanel />);

    await screen.findByText('Sideloaded');
    expect(screen.queryByText(/Update blocked/)).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-054: Review compares both fingerprints and the confirmation re-pins and updates in one call', async () => {
    let body: unknown = null;
    mockPanel([blocked('SIGNATURE_KEY_CHANGED')], [registryEntry()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/retrust', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] });
    }));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Key it was installed with')).toBeInTheDocument();
    expect(screen.getByText('OLDKEYaa…aaaaaaaa')).toBeInTheDocument();
    // Fingerprint of the registry's new key: head…tail of the base64 payload.
    expect(screen.getByText('RWQ12345…87654321')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Trust the new key & update' }));
    await waitFor(() => expect(body).toEqual({
      version: '2.0.0',
      publicKey: 'untrusted comment: minisign public key\nRWQ12345678MIDDLE87654321',
    }));
    await waitFor(() => expect(toastMessages()).toContain('New signing key trusted — the plugin is updated'));
  });

  it('FE-MOB-PLUGP-055: a re-trust whose update widens rights still asks for consent', async () => {
    mockPanel([blocked('SIGNATURE_KEY_CHANGED')], [registryEntry()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/retrust', () =>
      HttpResponse.json({ version: '2.0.0', activated: false, newPermissions: ['db:read:trips'], newEgress: [] })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trust the new key & update' }));

    expect(await screen.findByText('This update needs new permissions')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-056: a rejected re-trust reports the server message', async () => {
    mockPanel([blocked('SIGNATURE_KEY_CHANGED')], [registryEntry()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/retrust', () =>
      HttpResponse.json({ error: 'key changed again' }, { status: 409 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trust the new key & update' }));
    await waitFor(() => expect(toastMessages()).toContain('key changed again'));
  });

  it('FE-MOB-PLUGP-057: an invalid signature is explained and offers no override at all', async () => {
    mockPanel([blocked('SIGNATURE_INVALID')], [registryEntry()]);
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/do not match the author's signature/i)).toBeInTheDocument();
    // The raw server detail is shown instead of a key comparison that would imply a choice.
    expect(screen.getByText('the signing key changed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trust the new key & update' })).not.toBeInTheDocument();
    expect(screen.queryByText('Key it is offering now')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-058: a missing and a half-signed signature each get their own explanation', async () => {
    mockPanel([blocked('SIGNATURE_MISSING')], [registryEntry()]);
    const { unmount } = render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/ships no signature/i)).toBeInTheDocument();
    unmount();

    mockPanel([blocked('SIGNATURE_INCOMPLETE')], [registryEntry()]);
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/half-signed/i)).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-059: an update refused on its signature opens the dialog instead of a toast', async () => {
    mockPanel([plugin({ source_repo: 'acme/gotify', version: '1.0.0', keyFingerprint: 'OLDKEYaa…aaaaaaaa' })], [registryEntry()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/update', () =>
      HttpResponse.json({ error: 'signing key changed', code: 'SIGNATURE_KEY_CHANGED' }, { status: 409 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update → v2.0.0' }));
    expect(await screen.findByText("Gotify's signature could not be verified")).toBeInTheDocument();
    expect(toastMessages()).not.toContain('signing key changed');
  });

  it('FE-MOB-PLUGP-060: a fresh install refused for an invalid signature names the plugin from the registry entry', async () => {
    mockPanel([], [registryEntry()]);
    server.use(http.post('*/api/admin/plugins/install', () =>
      HttpResponse.json({ error: 'author signature verification failed', code: 'SIGNATURE_INVALID' }, { status: 400 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Install$/ }));

    expect(await screen.findByText("Gotify's signature could not be verified")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trust the new key & update' })).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-061: the dialog closes again without re-trusting', async () => {
    mockPanel([blocked('SIGNATURE_KEY_CHANGED')], [registryEntry()]);
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Do not trust it' }));
    await waitFor(() => expect(screen.queryByText('Key it was installed with')).not.toBeInTheDocument());
  });
});

describe('MAdminPluginsPanel — enabling a plugin', () => {
  const off = (over: Row = {}) => plugin({ enabled: 0, status: 'inactive', ...over });

  it('FE-MOB-PLUGP-062: the toggle turns an active plugin off', async () => {
    let called = false;
    mockPanel([plugin()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/deactivate', () => { called = true; return HttpResponse.json({ ok: true }); }));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    await waitFor(() => expect(called).toBe(true));
    expect(toastMessages()).toContain('Plugin deactivated');
  });

  it('FE-MOB-PLUGP-063: enabling a plugin also reports the dependencies it switched on for you', async () => {
    // Named so the parent sorts first — the rows are ordered by name, and the toggle is picked by position.
    mockPanel([
      off({ dependencies: { requiredAddons: [], pluginDependencies: [{ id: 'trek-base', version: '^1.0.0' }] } }),
      plugin({ id: 'trek-base', name: 'Zzz Base', enabled: 0, status: 'inactive' }),
    ]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () => HttpResponse.json({ ok: true })));
    render(<MAdminPluginsPanel />);

    await screen.findByText('Gotify');
    fireEvent.click(screen.getAllByRole('switch', { name: 'Enable plugin' })[0]);
    await waitFor(() => expect(toastMessages()).toContain('Enabled required plugin(s) first: Zzz Base'));
    expect(toastMessages()).toContain('Plugin activated');
  });

  it('FE-MOB-PLUGP-064: a 409 CONSENT_REQUIRED routes to the consent sheet', async () => {
    mockPanel([off({ source_repo: 'acme/gotify', signed: false })], []);
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () =>
      HttpResponse.json({ error: 'consent required', code: 'CONSENT_REQUIRED', newPermissions: ['db:read:trips'], newEgress: [] }, { status: 409 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    expect(await screen.findByText('This update needs new permissions')).toBeInTheDocument();
    // The registry is empty here, so the caveat falls back to the installed row's own flag.
    expect(screen.getByText(/Nothing ties this version to its author/)).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-065: a 409 ADDON_DISABLED names the addons to switch on first', async () => {
    mockPanel([off()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () =>
      HttpResponse.json({ error: 'addon disabled', code: 'ADDON_DISABLED', addons: ['budget', 'vacay'] }, { status: 409 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    await waitFor(() => expect(toastMessages()).toContain('Enable the required addon(s) first: budget, vacay'));
  });

  it('FE-MOB-PLUGP-066: any other activation failure surfaces the server message', async () => {
    mockPanel([off()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () =>
      HttpResponse.json({ error: 'dependency cycle', code: 'DEPENDENCY_CYCLE' }, { status: 409 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    await waitFor(() => expect(toastMessages()).toContain('dependency cycle'));
  });

  it('FE-MOB-PLUGP-067: a 409 DEPENDENCY_MISSING opens the resolve sheet, downloads and retries', async () => {
    let installBody: unknown = null;
    let activateCalls = 0;
    mockPanel([off()]);
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/activate', () => {
        activateCalls += 1;
        if (activateCalls === 1) {
          return HttpResponse.json({
            error: 'missing dependency', code: 'DEPENDENCY_MISSING',
            missing: [{ id: 'trek-base', version: '^1.0.0' }],
            versionMismatch: [{ id: 'trek-old', wanted: '^2.0.0', installed: '1.0.0' }],
          }, { status: 409 });
        }
        return HttpResponse.json({ ok: true });
      }),
      http.post('*/api/admin/plugins/install', async ({ request }) => {
        installBody = await request.json();
        return HttpResponse.json({ installed: ['trek-base'], requiredAddons: ['budget'] });
      }),
    );
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    expect(await screen.findByText('Missing dependencies')).toBeInTheDocument();
    expect(screen.getByText('Requires ^1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Needs ^2.0.0 — 1.0.0 is installed')).toBeInTheDocument();
    expect(screen.getByText('Downloads the latest compatible version, including its own dependencies.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    await waitFor(() => expect(installBody).toEqual({ id: 'trek-base', constraint: '^1.0.0', withDependencies: true }));
    await waitFor(() => expect(toastMessages()).toContain('Downloaded trek-base'));
    // The dependency install revealed a disabled addon on top.
    expect(toastMessages()).toContain('Enable the required addon(s) first: budget');
    await waitFor(() => expect(activateCalls).toBe(2));
  });

  it('FE-MOB-PLUGP-068: a signature refusal while downloading a dependency names the dependency', async () => {
    mockPanel([off()]);
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/activate', () =>
        HttpResponse.json({ error: 'missing dependency', code: 'DEPENDENCY_MISSING', missing: [{ id: 'trek-base', version: '^1.0.0' }], versionMismatch: [] }, { status: 409 })),
      http.post('*/api/admin/plugins/install', () =>
        HttpResponse.json({ error: 'author signature verification failed', code: 'SIGNATURE_INVALID' }, { status: 400 })),
    );
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    fireEvent.click(await screen.findByRole('button', { name: /Download/ }));

    expect(await screen.findByText("trek-base's signature could not be verified")).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-069: the resolve sheet can be dismissed without downloading', async () => {
    mockPanel([off()]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', () =>
      HttpResponse.json({ error: 'missing dependency', code: 'DEPENDENCY_MISSING', missing: [{ id: 'trek-base', version: '^1.0.0' }], versionMismatch: [] }, { status: 409 })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Missing dependencies')).not.toBeInTheDocument());
  });
});

describe('MAdminPluginsPanel — sideloading, dev-link and rescan', () => {
  it('FE-MOB-PLUGP-070: the toolbar upload button installs the picked archive', async () => {
    let uploaded = false;
    mockPanel([]);
    server.use(http.post('*/api/admin/plugins/upload', () => { uploaded = true; return HttpResponse.json({ id: 'trek-new' }); }));
    const { container } = render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Upload plugin' }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['zip'], 'plugin.zip', { type: 'application/zip' })] } });

    await waitFor(() => expect(uploaded).toBe(true));
    await waitFor(() => expect(toastMessages()).toContain('Plugin “trek-new” uploaded — activate it to run'));
  });

  it('FE-MOB-PLUGP-071: a rejected upload reports the server message', async () => {
    mockPanel([]);
    server.use(http.post('*/api/admin/plugins/upload', () =>
      HttpResponse.json({ error: 'manifest missing' }, { status: 400 })));
    const { container } = render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['zip'], 'plugin.zip')] } });
    await waitFor(() => expect(toastMessages()).toContain('manifest missing'));
  });

  it('FE-MOB-PLUGP-072: dragging an archive over the panel offers to install it, and dropping does', async () => {
    let uploaded = false;
    mockPanel([]);
    server.use(http.post('*/api/admin/plugins/upload', () => { uploaded = true; return HttpResponse.json({ id: 'dropped' }); }));
    const { container } = render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    const panel = container.firstElementChild as HTMLElement;
    const file = new File(['zip'], 'plugin.zip');
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(await screen.findByText('Drop a plugin .zip to install')).toBeInTheDocument();

    fireEvent.drop(panel, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(uploaded).toBe(true));
    await waitFor(() => expect(screen.queryByText('Drop a plugin .zip to install')).not.toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-073: dragging something that is not a file never arms the overlay', async () => {
    mockPanel([]);
    const { container } = render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    const panel = container.firstElementChild as HTMLElement;
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(screen.queryByText('Drop a plugin .zip to install')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-074: leaving the panel again disarms the overlay', async () => {
    mockPanel([]);
    const { container } = render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    const panel = container.firstElementChild as HTMLElement;
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'], files: [] } });
    await screen.findByText('Drop a plugin .zip to install');
    fireEvent.dragOver(panel, { dataTransfer: { types: ['Files'], files: [] } });
    fireEvent.dragLeave(panel);
    await waitFor(() => expect(screen.queryByText('Drop a plugin .zip to install')).not.toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-075: the dev-link form registers a local build directory', async () => {
    let body: unknown = null;
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: true, plugins: [] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json([])),
      http.post('*/api/admin/plugins/link', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'local-plugin' });
      }),
    );
    render(<MAdminPluginsPanel />);

    const input = await screen.findByPlaceholderText('/absolute/path/to/your/plugin');
    // An empty path is a no-op, not a request.
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(body).toBeNull();

    fireEvent.change(input, { target: { value: '/srv/plugins/local' } });
    fireEvent.click(screen.getByRole('button', { name: /^Link$/ }));

    await waitFor(() => expect(body).toEqual({ path: '/srv/plugins/local' }));
    await waitFor(() => expect(toastMessages()).toContain('Linked local-plugin — activate it to run'));
  });

  it('FE-MOB-PLUGP-076: a rejected dev-link reports the server message', async () => {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: true, plugins: [] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json([])),
      http.post('*/api/admin/plugins/link', () => HttpResponse.json({ error: 'no manifest there' }, { status: 400 })),
    );
    render(<MAdminPluginsPanel />);

    const input = await screen.findByPlaceholderText('/absolute/path/to/your/plugin');
    fireEvent.change(input, { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^Link$/ }));
    await waitFor(() => expect(toastMessages()).toContain('no manifest there'));
  });

  it('FE-MOB-PLUGP-077: Rescan rediscovers local plugins and force-pulls the registry', async () => {
    let rescanned = false;
    let refreshParam: string | null = null;
    mockPanel([]);
    server.use(
      http.post('*/api/admin/plugins/rescan', () => { rescanned = true; return HttpResponse.json({ ok: true }); }),
      http.get('*/api/admin/plugins/registry', ({ request }) => {
        refreshParam = new URL(request.url).searchParams.get('refresh');
        return HttpResponse.json([registryEntry()]);
      }),
    );
    render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(rescanned).toBe(true));
    await waitFor(() => expect(refreshParam).toBe('1'));
    expect(toastMessages()).toContain('Rescanned the plugins folder');
  });

  it('FE-MOB-PLUGP-078: a failed rescan falls back to the generic action error', async () => {
    mockPanel([]);
    server.use(http.post('*/api/admin/plugins/rescan', () => HttpResponse.json({}, { status: 500 })));
    render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(toastMessages()).toContain('Action failed'));
  });
});

describe('MAdminPluginsPanel — edge paths', () => {
  it('FE-MOB-PLUGP-080: a block stands while the registry is unreachable, and offers no override without the new key', async () => {
    mockPanel([plugin({
      source_repo: 'acme/gotify', signed: true, keyFingerprint: null, version: '1.0.0',
      updateBlock: { code: 'SIGNATURE_KEY_CHANGED', detail: 'the signing key changed', version: '2.0.0' },
    })], []);
    render(<MAdminPluginsPanel />);

    // Nothing proves the block stale, so it must not be dropped.
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    // Neither fingerprint is knowable: no pinned key, and no registry entry to read the new one from.
    expect(await screen.findAllByText('—')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Trust the new key & update' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-081: a key with no payload line has no fingerprint to show', async () => {
    mockPanel([plugin({
      source_repo: 'acme/gotify', keyFingerprint: 'OLDKEYaa…aaaaaaaa', version: '1.0.0',
      updateBlock: { code: 'SIGNATURE_KEY_CHANGED', detail: 'x', version: '2.0.0' },
    })], [registryEntry({ authorPublicKey: 'untrusted comment: minisign public key' })]);
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.getByText('OLDKEYaa…aaaaaaaa')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-082: an outdated dependency is flagged amber just like a missing one', async () => {
    mockPanel([plugin({
      dependencies: { requiredAddons: [], pluginDependencies: [{ id: 'trek-base', version: '^2.0.0' }] },
      dependencyIssues: { disabledAddons: [], missing: [], versionMismatch: [{ id: 'trek-base', wanted: '^2.0.0', installed: '1.0.0' }] },
    })]);
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Needs trek-base ^2.0.0')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-083: switching to Discover drops the installed-only sort key', async () => {
    mockPanel([plugin()], [registryEntry()]);
    render(<MAdminPluginsPanel />);
    await screen.findByText('Gotify');

    fireEvent.click(screen.getByTitle('Sort: Name'));
    fireEvent.click(await screen.findByRole('button', { name: 'Updates first' }));
    await waitFor(() => expect(screen.getByTitle('Sort: Updates first')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Discover/ }));
    await waitFor(() => expect(screen.getByTitle('Sort: Name')).toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-084: dropping an archive while the runtime is off installs nothing', async () => {
    let uploaded = false;
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: false, plugins: [] })),
      http.post('*/api/admin/plugins/upload', () => { uploaded = true; return HttpResponse.json({ id: 'x' }); }),
    );
    const { container } = render(<MAdminPluginsPanel />);
    await screen.findByText('Plugins are disabled');

    const panel = container.firstElementChild as HTMLElement;
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.queryByText('Drop a plugin .zip to install')).not.toBeInTheDocument();

    fireEvent.drop(panel, { dataTransfer: { types: ['Files'], files: [new File(['zip'], 'p.zip')] } });
    await waitFor(() => expect(screen.getByText('Plugins are disabled')).toBeInTheDocument());
    expect(uploaded).toBe(false);
  });

  it('FE-MOB-PLUGP-085: an ordinary failure downloading a dependency falls back to the activation error', async () => {
    mockPanel([plugin({ enabled: 0, status: 'inactive' })]);
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/activate', () =>
        HttpResponse.json({ error: 'missing dependency', code: 'DEPENDENCY_MISSING', missing: [{ id: 'trek-base', version: '^1.0.0' }], versionMismatch: [] }, { status: 409 })),
      http.post('*/api/admin/plugins/install', () => HttpResponse.json({ error: 'registry unreachable' }, { status: 502 })),
    );
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Enable plugin' }));
    fireEvent.click(await screen.findByRole('button', { name: /Download/ }));
    await waitFor(() => expect(toastMessages()).toContain('registry unreachable'));
  });

  it('FE-MOB-PLUGP-086: every sheet closes from its own close button and from Escape', async () => {
    mockPanel([plugin({ source_repo: 'acme/gotify', operatorEgress: true, egressHostCount: 1 })]);
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/errors', () => HttpResponse.json({ errors: [] })),
      http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () => HttpResponse.json({ supported: true, hosts: [] })),
    );
    render(<MAdminPluginsPanel />);

    // Row action sheet → its own close button.
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('View error log')).not.toBeInTheDocument());

    // Error log → Escape, then the close button.
    fireEvent.click(screen.getByTestId('plugin-row-menu-btn-trek-gotify'));
    fireEvent.click(screen.getByText('View error log'));
    await screen.findByText('No errors logged.');
    await escapeUntilGone('No errors logged.');

    // Allowed hosts → Escape, from the row chip.
    fireEvent.click(screen.getByRole('button', { name: '1 allowed host(s)' }));
    await screen.findByText('No hosts added yet.');
    await escapeUntilGone('No hosts added yet.');
  });

  it('FE-MOB-PLUGP-087: the hosts sheet closes from its own close button too', async () => {
    mockPanel([plugin({ operatorEgress: true, egressHostCount: 0 })]);
    server.use(http.get('*/api/admin/plugins/trek-gotify/egress-hosts', () =>
      HttpResponse.json({ supported: true, hosts: [] })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add allowed host' }));
    await screen.findByText('No hosts added yet.');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('No hosts added yet.')).not.toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-088: the error log sheet closes from its own close button too', async () => {
    mockPanel([plugin()]);
    server.use(http.get('*/api/admin/plugins/trek-gotify/errors', () => HttpResponse.json({ errors: [] })));
    render(<MAdminPluginsPanel />);

    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'));
    fireEvent.click(screen.getByText('View error log'));
    await screen.findByText('No errors logged.');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('No errors logged.')).not.toBeInTheDocument());
  });

  it('FE-MOB-PLUGP-090: an unreachable registry behind an installed list costs only the update badges', async () => {
    server.use(
      http.get('*/api/admin/plugins', () => HttpResponse.json({ enabled: true, devLink: false, plugins: [plugin({ version: '1.0.0' })] })),
      http.get('*/api/admin/plugins/registry', () => HttpResponse.json({ error: 'down' }, { status: 500 })),
    );
    render(<MAdminPluginsPanel />);

    expect(await screen.findByText('Gotify')).toBeInTheDocument();
    expect(screen.queryByText(/updates available/)).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-091: a second tap on the toggle while the first is in flight is ignored', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    mockPanel([plugin({ enabled: 0, status: 'inactive' })]);
    server.use(http.post('*/api/admin/plugins/trek-gotify/activate', async () => {
      calls += 1;
      await gate;
      return HttpResponse.json({ ok: true });
    }));
    render(<MAdminPluginsPanel />);

    const toggle = await screen.findByRole('switch', { name: 'Enable plugin' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    release();

    await waitFor(() => expect(toastMessages()).toContain('Plugin activated'));
    expect(calls).toBe(1);
  });

  it('FE-MOB-PLUGP-089: six-figure download counts round into millions', async () => {
    mockPanel([], [registryEntry({ downloadCount: 1_200_000 })]);
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));

    expect(await screen.findByText('1.2M')).toBeInTheDocument();
  });
});

describe('MAdminPluginsPanel — the security footer', () => {
  it('FE-MOB-PLUGP-079: expands the containment explainer on demand', async () => {
    mockPanel([]);
    render(<MAdminPluginsPanel />);
    await screen.findByText('No plugins installed yet.');

    expect(screen.queryByText('Every plugin runs boxed in')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('How plugins are contained — and the limits'));

    expect(screen.getByText('Every plugin runs boxed in')).toBeInTheDocument();
    expect(screen.getByText('The worst case')).toBeInTheDocument();
    expect(screen.getByText('What "Signed" means')).toBeInTheDocument();

    fireEvent.click(screen.getByText('How plugins are contained — and the limits'));
    expect(screen.queryByText('Every plugin runs boxed in')).not.toBeInTheDocument();
  });
});

/**
 * The admin-owned `scope:'instance'` settings sheet — the phone counterpart of the
 * desktop modal. Same contract: gated on declared instance fields, secrets stay
 * write-only (an untouched mask is never sent), and a save that restarted the
 * running plugin must say so.
 */
describe('MAdminPluginsPanel — instance settings', () => {
  const FIELDS = [
    { key: 'apiUrl', label: 'API URL', input_type: 'text', required: true, secret: false },
    { key: 'apiKey', label: 'API key', input_type: 'text', required: false, secret: true },
  ];

  async function openRowSheet(p: Row) {
    mockPanel([p]);
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByTestId('plugin-row-menu-btn-trek-gotify'));
  }

  async function openSettings() {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ fields: FIELDS, config: { apiUrl: 'https://gotify.mydomain.com', apiKey: '••••••••' } })),
    );
    await openRowSheet(plugin({ instanceSettingsCount: 2 }));
    fireEvent.click(screen.getByText('Instance settings'));
    await waitFor(() => expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument(), { timeout: 5000 });
  }

  it('FE-MOB-PLUGP-CFG-001: a plugin with instance fields offers the sheet action, opening the form', async () => {
    await openSettings();
    expect(screen.getByDisplayValue('••••••••')).toHaveAttribute('type', 'password');
  });

  it('FE-MOB-PLUGP-CFG-002: a plugin with NO instance fields gets no action', async () => {
    await openRowSheet(plugin({ instanceSettingsCount: 0 }));
    expect(screen.getByText('View error log')).toBeInTheDocument(); // the sheet is open
    expect(screen.queryByText('Instance settings')).not.toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-CFG-003: saving sends the edits but never the untouched secret mask', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('*/api/admin/plugins/trek-gotify/config', async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ config: body, restarted: false });
      }),
    );
    await openSettings();

    fireEvent.change(screen.getByDisplayValue('https://gotify.mydomain.com'), { target: { value: 'https://new.example' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(toastMessages()).toContain('Settings saved'), { timeout: 5000 });
    expect(body).toEqual({ apiUrl: 'https://new.example' });
  });

  it('FE-MOB-PLUGP-CFG-004: a save that restarted the running plugin says so', async () => {
    server.use(
      http.put('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ config: { apiUrl: 'https://gotify.mydomain.com' }, restarted: true })),
    );
    await openSettings();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(toastMessages()).toContain('Settings saved — plugin restarted'), { timeout: 5000 });
  });

  it('FE-MOB-PLUGP-CFG-006: renders every declared field type and saves the edited values', async () => {
    const RICH = [
      { key: 'mode', label: 'Mode', input_type: 'select', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }], hint: 'Pick one' },
      { key: 'enabled', input_type: 'checkbox' }, // no label — the key stands in
      { key: 'retries', label: 'Retries', input_type: 'number', required: true },
    ];
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ fields: RICH, config: { mode: 'slow', enabled: true } })),
      http.put('*/api/admin/plugins/trek-gotify/config', async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ config: body, restarted: false });
      }),
    );
    await openRowSheet(plugin({ instanceSettingsCount: 3 }));
    fireEvent.click(screen.getByText('Instance settings'));

    const select = await screen.findByRole('combobox', {}, { timeout: 5000 });
    expect(select).toHaveValue('slow');
    expect(screen.getByRole('switch', { name: 'enabled' })).toBeInTheDocument(); // label falls back to the key
    expect(screen.getByRole('spinbutton')).toHaveValue(null);
    expect(screen.getByText('Pick one')).toBeInTheDocument(); // hint

    fireEvent.change(select, { target: { value: 'fast' } });
    fireEvent.click(screen.getByRole('switch', { name: 'enabled' }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(toastMessages()).toContain('Settings saved'), { timeout: 5000 });
    expect(body).toEqual({ mode: 'fast', enabled: false, retries: '3' });
  });

  it('FE-MOB-PLUGP-CFG-007: a failed config fetch is a toast, not a broken sheet', async () => {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
    );
    await openRowSheet(plugin({ instanceSettingsCount: 2 }));
    fireEvent.click(screen.getByText('Instance settings'));

    await waitFor(() => expect(toastMessages()).toContain('Error'), { timeout: 5000 });
  });

  it('FE-MOB-PLUGP-CFG-008: a rejected save shows the server reason and keeps the sheet open', async () => {
    server.use(
      http.put('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ error: 'config refused' }, { status: 400 })),
    );
    await openSettings();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('config refused', {}, { timeout: 5000 })).toBeInTheDocument();
    // Still open — the admin's edits are not thrown away on a refusal.
    expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-CFG-009: the sheet closes without saving', async () => {
    await openSettings();

    // Same retry shape as escapeUntilGone, but on the input value — an input's
    // value is not text content, so the text-based helper would pass vacuously.
    await waitFor(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByDisplayValue('https://gotify.mydomain.com')).not.toBeInTheDocument();
    });
  });

  const ACTIONS = [
    { key: 'ping', label: 'Ping server', danger: false, scope: 'instance' },
    { key: 'purge', label: 'Purge cache', hint: 'Drops every cached tile', danger: true, scope: 'instance' },
  ];

  async function openWithActions(p: Row = plugin({ instanceSettingsCount: 2 })) {
    server.use(
      http.get('*/api/admin/plugins/trek-gotify/config', () =>
        HttpResponse.json({ fields: FIELDS, config: { apiUrl: 'https://gotify.mydomain.com' }, actions: ACTIONS })),
    );
    await openRowSheet(p);
    fireEvent.click(screen.getByText('Instance settings'));
    await waitFor(() => expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument(), { timeout: 5000 });
  }

  it('FE-MOB-PLUGP-ACT-010: instance actions render from the config response and post to the admin action route', async () => {
    let posted = '';
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/actions/:key', ({ params }) => {
        posted = String(params.key);
        return HttpResponse.json({ ok: true, message: 'pong' });
      }),
    );
    await openWithActions();
    expect(screen.getByText('Drops every cached tile')).toBeInTheDocument(); // hint
    fireEvent.click(screen.getByRole('button', { name: 'Ping server' }));
    expect(await screen.findByText('pong', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(posted).toBe('ping');
    // The sheet stays open — the admin may run another one.
    expect(screen.getByDisplayValue('https://gotify.mydomain.com')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-ACT-011: a danger action opens the MConfirmSheet first; confirming posts', async () => {
    let posted = '';
    server.use(
      http.post('*/api/admin/plugins/trek-gotify/actions/:key', ({ params }) => {
        posted = String(params.key);
        return HttpResponse.json({ ok: false, message: 'cache locked' });
      }),
    );
    await openWithActions();
    fireEvent.click(screen.getByRole('button', { name: 'Purge cache' }));
    const dialog = await screen.findByRole('dialog', { name: 'Purge cache' });
    expect(within(dialog).getByText('Run this action?')).toBeInTheDocument();
    expect(posted).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Purge cache' }));
    expect(await screen.findByText('cache locked', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(posted).toBe('purge');
  });

  it('FE-MOB-PLUGP-ACT-012: an inactive plugin renders the action buttons disabled with the activation hint', async () => {
    await openWithActions(plugin({ instanceSettingsCount: 2, status: 'inactive', enabled: 0 }));
    expect(screen.getByRole('button', { name: 'Ping server' })).toBeDisabled();
    expect(screen.getByText('Activate the plugin to run its actions')).toBeInTheDocument();
  });
});

/**
 * TREK_PLUGINS_IGNORE_TREK_RANGE on the phone shell — the same three surfaces as the
 * desktop panel: the header pill, the confirm-before-install sheet, and the notice after a
 * sideload that could not ask first, plus the persistent warning chip on the row.
 */
describe('MAdminPluginsPanel — TREK-range bypass (TREK_PLUGINS_IGNORE_TREK_RANGE)', () => {
  const incompatibleEntry = () => registryEntry({ trek: '>=4.0.0', hostVersion: '3.3.0', compatible: false, latestCompatible: null });

  it('FE-MOB-PLUGP-BYPASS-001: says so in the header', async () => {
    mockPanel([plugin()], [], { ignoreTrekRange: true });
    render(<MAdminPluginsPanel />);
    expect(await screen.findByText('Version checks off')).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-BYPASS-002: offers "Install anyway" and asks before installing', async () => {
    let body: unknown = null;
    mockPanel([], [incompatibleEntry()], { ignoreTrekRange: true });
    server.use(http.post('*/api/admin/plugins/install', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ id: 'trek-gotify', version: '2.0.0', trekRangeBypassed: { trekRange: '>=4.0.0', hostVersion: '3.3.0' } });
    }));
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));

    const btn = await screen.findByRole('button', { name: 'Install anyway' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);

    const sheet = await screen.findByRole('dialog', { name: 'Outside its supported TREK versions' });
    expect(within(sheet).getByText(/no guarantee/i)).toBeInTheDocument();
    expect(body).toBeNull();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Install anyway' }));
    await waitFor(() => expect(body).toEqual({ id: 'trek-gotify' }));
  });

  it('FE-MOB-PLUGP-BYPASS-003: cancelling the warning installs nothing', async () => {
    let posted = false;
    mockPanel([], [incompatibleEntry()], { ignoreTrekRange: true });
    server.use(http.post('*/api/admin/plugins/install', () => { posted = true; return HttpResponse.json({ id: 'trek-gotify', version: '2.0.0', trekRangeBypassed: null }); }));
    render(<MAdminPluginsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install anyway' }));

    const sheet = await screen.findByRole('dialog', { name: 'Outside its supported TREK versions' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Outside its supported TREK versions' })).not.toBeInTheDocument());
    expect(posted).toBe(false);
  });

  it('FE-MOB-PLUGP-BYPASS-004: a sideload that landed outside its range is warned about afterwards', async () => {
    mockPanel([plugin()], [], { ignoreTrekRange: true });
    server.use(http.post('*/api/admin/plugins/upload', () =>
      HttpResponse.json({ id: 'trek-new', version: '1.0.0', replaced: false, trekRangeBypassed: { trekRange: null, hostVersion: '3.3.0' } })));
    const { container } = render(<MAdminPluginsPanel />);
    await screen.findByText('Gotify');

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['zip'], 'plugin.zip', { type: 'application/zip' })] } });

    const sheet = await screen.findByRole('dialog', { name: 'Installed outside its supported TREK versions' });
    expect(within(sheet).getByText(/no guarantee/i)).toBeInTheDocument();
    expect(within(sheet).getByText(/trek-new/)).toBeInTheDocument();
  });

  it('FE-MOB-PLUGP-BYPASS-005: a plugin running outside its range keeps a warning chip on its row', async () => {
    mockPanel([plugin({
      dependencyStatus: 'ok', trekRange: '>=3.2.0 <4.0.0', hostVersion: '4.0.0',
      trekRangeBypassed: { trekRange: '>=3.2.0 <4.0.0', hostVersion: '4.0.0' },
    })], [], { ignoreTrekRange: true });
    render(<MAdminPluginsPanel />);
    expect(await screen.findByText('Outside its TREK range (>=3.2.0 <4.0.0) — version checks off')).toBeInTheDocument();
  });
});
