// FE-ADMSET-001 to FE-ADMSET-040
import { http, HttpResponse } from 'msw';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../tests/helpers/msw/server';
import { fireEvent, render, screen, waitFor, within } from '../../../tests/helpers/render';
import { buildAdminHook, type AdminHook } from '../../../tests/helpers/mobileAdmin';
import { resetAllStores } from '../../../tests/helpers/store';
import { useTranslation } from '../../i18n';
import type { OidcConfig } from './adminModel';
import AdminSettingsTab from './AdminSettingsTab';

type Spy = ReturnType<typeof vi.fn>;
type Spies = Record<string, Spy> & { toast: Record<string, Spy> };

function Harness({ admin }: { admin: AdminHook }) {
  const { t } = useTranslation();
  return <AdminSettingsTab admin={admin} t={t} />;
}

function renderTab(overrides: Record<string, unknown> = {}) {
  const admin = buildAdminHook(overrides);
  render(<Harness admin={admin} />);
  return admin as unknown as Spies;
}

/** The card element whose <h2> matches the given heading text. */
function card(heading: string | RegExp): HTMLElement {
  return screen.getByRole('heading', { name: heading }).closest<HTMLElement>('.rounded-xl')!;
}

/** The toggle button in the row belonging to a label paragraph. */
function toggleFor(label: string): HTMLElement {
  const row = screen.getAllByText(label).map(el => el.closest<HTMLElement>('.flex.items-center.justify-between'));
  const found = row.find(Boolean)!;
  return within(found).getByRole('button');
}

const EMPTY_OIDC: OidcConfig = {
  issuer: '',
  client_id: '',
  client_secret: '',
  client_secret_set: false,
  display_name: '',
  discovery_url: '',
};

/**
 * setOidcConfig gets an updater that reads e.target.value lazily, so a spy call
 * can no longer be replayed once React has re-rendered the controlled input.
 * This harness keeps the config in real state instead.
 */
function OidcHarness() {
  const { t } = useTranslation();
  const [oidcConfig, setOidcConfig] = React.useState<OidcConfig>(EMPTY_OIDC);
  const admin = buildAdminHook({ oidcConfig, setOidcConfig });
  return <AdminSettingsTab admin={admin} t={t} />;
}

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  server.resetHandlers();
});

describe('AdminSettingsTab', () => {
  it('FE-ADMSET-001: renders every settings card', () => {
    renderTab();

    expect(screen.getByRole('heading', { name: 'Authentication Methods' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Passkey login' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /require two-factor/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Allowed File Types' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'API Keys' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /single sign-on/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /danger zone/i })).toBeInTheDocument();
  });

  it('FE-ADMSET-002: hides the env-override hint unless OIDC_ONLY is set', () => {
    renderTab();

    expect(screen.queryByText(/OIDC_ONLY environment variable/i)).not.toBeInTheDocument();
    expect(toggleFor('Password Login')).not.toBeDisabled();
  });

  it('FE-ADMSET-003: shows the env-override hint and disables the password toggles', () => {
    renderTab({ envOverrideOidcOnly: true });

    expect(screen.getByText(/OIDC_ONLY environment variable/i)).toBeInTheDocument();
    expect(toggleFor('Password Login')).toBeDisabled();
    expect(toggleFor('Password Registration')).toBeDisabled();
  });

  it('FE-ADMSET-004: password login toggle sends the inverted value', () => {
    const admin = renderTab({ passwordLogin: true, oidcLogin: true });

    fireEvent.click(toggleFor('Password Login'));

    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith('password_login', false, admin.setPasswordLogin);
  });

  it('FE-ADMSET-005: password login toggle is locked out when it is the last method', () => {
    renderTab({ passwordLogin: false, oidcLogin: false });

    const toggle = toggleFor('Password Login');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('title', 'At least one login method must remain enabled');
  });

  it('FE-ADMSET-006: password registration toggle sends the inverted value', () => {
    const admin = renderTab({ passwordRegistration: false });

    fireEvent.click(toggleFor('Password Registration'));

    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith(
      'password_registration',
      true,
      admin.setPasswordRegistration
    );
  });

  it('FE-ADMSET-007: SSO rows are hidden until OIDC is configured', () => {
    renderTab({ oidcConfigured: false });

    expect(screen.queryByText('SSO Login')).not.toBeInTheDocument();
    expect(screen.queryByText('SSO Auto-Provisioning')).not.toBeInTheDocument();
  });

  it('FE-ADMSET-008: SSO login toggle sends the inverted value', () => {
    const admin = renderTab({ oidcConfigured: true, oidcLogin: true, passwordLogin: true });

    fireEvent.click(toggleFor('SSO Login'));

    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith('oidc_login', false, admin.setOidcLogin);
  });

  it('FE-ADMSET-009: SSO login toggle is disabled when password login is already off', () => {
    renderTab({ oidcConfigured: true, oidcLogin: true, passwordLogin: false });

    expect(toggleFor('SSO Login')).toBeDisabled();
  });

  it('FE-ADMSET-010: SSO auto-provisioning toggle sends the inverted value', () => {
    const admin = renderTab({ oidcConfigured: true, oidcRegistration: false });

    fireEvent.click(toggleFor('SSO Auto-Provisioning'));

    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith('oidc_registration', true, admin.setOidcRegistration);
  });

  it('FE-ADMSET-011: passkey toggle sends the inverted value', () => {
    const admin = renderTab({ passkeyLogin: false });

    fireEvent.click(toggleFor('Enable passkey login'));

    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith('passkey_login', true, admin.setPasskeyLogin);
  });

  it('FE-ADMSET-012: warns only when passkey login is on but no RP ID resolves', () => {
    const { unmount } = render(<Harness admin={buildAdminHook({ passkeyLogin: true, passkeyConfigured: false })} />);
    expect(screen.getByText(/No WebAuthn domain resolves/)).toBeInTheDocument();
    unmount();

    render(<Harness admin={buildAdminHook({ passkeyLogin: true, passkeyConfigured: true })} />);
    expect(screen.queryByText(/No WebAuthn domain resolves/)).not.toBeInTheDocument();
  });

  it('FE-ADMSET-013: webauthn RP ID and origins inputs write through their setters', () => {
    const admin = renderTab({ webauthnRpId: 'old.example', webauthnOrigins: '' });

    expect(screen.getByPlaceholderText('trek.example.org')).toHaveValue('old.example');

    fireEvent.change(screen.getByPlaceholderText('trek.example.org'), { target: { value: 'trek.test' } });
    expect(admin.setWebauthnRpId).toHaveBeenCalledWith('trek.test');

    fireEvent.change(screen.getByPlaceholderText('https://trek.example.org'), {
      target: { value: 'https://trek.test' },
    });
    expect(admin.setWebauthnOrigins).toHaveBeenCalledWith('https://trek.test');
  });

  it('FE-ADMSET-014: passkey save button calls handleSaveWebauthn', () => {
    const admin = renderTab();

    fireEvent.click(within(card('Passkey login')).getByRole('button', { name: /save/i }));

    expect(admin.handleSaveWebauthn).toHaveBeenCalledTimes(1);
  });

  it('FE-ADMSET-015: the passkey save button is disabled while saving', () => {
    renderTab({ savingWebauthn: true });

    expect(within(card('Passkey login')).getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('FE-ADMSET-016: require-MFA toggle flips the current value', () => {
    const admin = renderTab({ requireMfa: false });

    fireEvent.click(within(card(/require two-factor/i)).getByRole('button'));

    expect(admin.handleToggleRequireMfa).toHaveBeenCalledWith(true);
  });

  it('FE-ADMSET-017: file types input writes through its setter', () => {
    const admin = renderTab({ allowedFileTypes: 'jpg,png' });

    fireEvent.change(screen.getByDisplayValue('jpg,png'), { target: { value: 'jpg,png,pdf' } });

    expect(admin.setAllowedFileTypes).toHaveBeenCalledWith('jpg,png,pdf');
  });

  it('FE-ADMSET-018: saving file types PUTs allowed_file_types and toasts', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/auth/app-settings', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      })
    );
    const admin = renderTab({ allowedFileTypes: 'jpg,png' });

    fireEvent.click(within(card('Allowed File Types')).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(admin.toast.success).toHaveBeenCalledWith('File type settings saved'));
    expect(body).toEqual({ allowed_file_types: 'jpg,png' });
    expect(admin.setSavingFileTypes).toHaveBeenNthCalledWith(1, true);
    expect(admin.setSavingFileTypes).toHaveBeenLastCalledWith(false);
  });

  it('FE-ADMSET-019: a failing file-type save shows the generic error toast', async () => {
    server.use(http.put('/api/auth/app-settings', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
    const admin = renderTab();

    fireEvent.click(within(card('Allowed File Types')).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(admin.toast.error).toHaveBeenCalledWith('Error'));
    expect(admin.toast.success).not.toHaveBeenCalled();
    expect(admin.setSavingFileTypes).toHaveBeenLastCalledWith(false);
  });

  it('FE-ADMSET-020: maps key input and its visibility toggle', () => {
    const admin = renderTab({ mapsKey: 'abc' });

    const mapsInput = within(card('API Keys')).getAllByPlaceholderText('Enter key...')[0];
    expect(mapsInput).toHaveAttribute('type', 'password');

    fireEvent.change(mapsInput, { target: { value: 'abcd' } });
    expect(admin.setMapsKey).toHaveBeenCalledWith('abcd');

    fireEvent.click(mapsInput.parentElement!.querySelector('button')!);
    expect(admin.toggleKey).toHaveBeenCalledWith('maps');
  });

  it('FE-ADMSET-021: showKeys switches both key inputs to plain text', () => {
    renderTab({ showKeys: { maps: true, unsplash: true } });

    const inputs = within(card('API Keys')).getAllByPlaceholderText('Enter key...');
    expect(inputs[0]).toHaveAttribute('type', 'text');
    expect(inputs[1]).toHaveAttribute('type', 'text');
  });

  it('FE-ADMSET-022: unsplash key input and its visibility toggle', () => {
    const admin = renderTab({ unsplashKey: '' });

    const unsplashInput = within(card('API Keys')).getAllByPlaceholderText('Enter key...')[1];
    fireEvent.change(unsplashInput, { target: { value: 'unsplash-key' } });
    expect(admin.setUnsplashKey).toHaveBeenCalledWith('unsplash-key');

    fireEvent.click(unsplashInput.parentElement!.querySelector('button')!);
    expect(admin.toggleKey).toHaveBeenCalledWith('unsplash');
  });

  it('FE-ADMSET-023: the maps Test button is disabled without a key', () => {
    renderTab({ mapsKey: '' });

    expect(within(card('API Keys')).getByRole('button', { name: /^test$/i })).toBeDisabled();
  });

  it('FE-ADMSET-024: the maps Test button validates the maps key', () => {
    const admin = renderTab({ mapsKey: 'AIza-test' });

    fireEvent.click(within(card('API Keys')).getByRole('button', { name: /^test$/i }));

    expect(admin.handleValidateKey).toHaveBeenCalledWith('maps');
  });

  it('FE-ADMSET-025: shows a spinner while the maps key is validating', () => {
    renderTab({ mapsKey: 'k', validating: { maps: true } });

    const testBtn = within(card('API Keys')).getByRole('button', { name: /^test$/i });
    expect(testBtn).toBeDisabled();
    expect(testBtn.querySelector('svg.animate-spin')).toBeInTheDocument();
  });

  it('FE-ADMSET-026: renders the validation result for the maps key', () => {
    const { unmount } = render(<Harness admin={buildAdminHook({ mapsKey: 'k', validation: { maps: true } })} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    unmount();

    render(<Harness admin={buildAdminHook({ mapsKey: 'k', validation: { maps: false } })} />);
    expect(screen.getByText('Invalid')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('FE-ADMSET-027: places photos toggle updates state, store and API', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/admin/places-photos', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ enabled: true });
      })
    );
    const admin = renderTab({ placesPhotosEnabled: false });

    fireEvent.click(toggleFor('Place Photos'));

    expect(admin.setPlacesPhotosEnabledState).toHaveBeenCalledWith(true);
    expect(admin.setPlacesPhotosEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(body).toEqual({ enabled: true }));
  });

  it('FE-ADMSET-028: a failing places-photos update rolls the toggle back', async () => {
    server.use(http.put('/api/admin/places-photos', () => HttpResponse.json({}, { status: 500 })));
    const admin = renderTab({ placesPhotosEnabled: false });

    fireEvent.click(toggleFor('Place Photos'));

    await waitFor(() => expect(admin.setPlacesPhotosEnabledState).toHaveBeenLastCalledWith(false));
    expect(admin.setPlacesPhotosEnabled).toHaveBeenLastCalledWith(false);
  });

  it('FE-ADMSET-029: places autocomplete toggle updates state and rolls back on failure', async () => {
    server.use(http.put('/api/admin/places-autocomplete', () => HttpResponse.json({}, { status: 500 })));
    const admin = renderTab({ placesAutocompleteEnabled: true });

    fireEvent.click(toggleFor('Place Autocomplete'));

    expect(admin.setPlacesAutocompleteEnabledState).toHaveBeenNthCalledWith(1, false);
    await waitFor(() => expect(admin.setPlacesAutocompleteEnabledState).toHaveBeenLastCalledWith(true));
    expect(admin.setPlacesAutocompleteEnabled).toHaveBeenLastCalledWith(true);
  });

  it('FE-ADMSET-030: places details toggle updates state and rolls back on failure', async () => {
    server.use(http.put('/api/admin/places-details', () => HttpResponse.json({}, { status: 500 })));
    const admin = renderTab({ placesDetailsEnabled: true });

    fireEvent.click(toggleFor('Place Details'));

    expect(admin.setPlacesDetailsEnabledState).toHaveBeenNthCalledWith(1, false);
    await waitFor(() => expect(admin.setPlacesDetailsEnabledState).toHaveBeenLastCalledWith(true));
    expect(admin.setPlacesDetailsEnabled).toHaveBeenLastCalledWith(true);
  });

  it('FE-ADMSET-030b: places enrichment toggle updates state and rolls back on failure', async () => {
    server.use(http.put('/api/admin/places-enrich', () => HttpResponse.json({}, { status: 500 })));
    const admin = renderTab({ placesEnrichEnabled: true });

    fireEvent.click(toggleFor('Place Enrichment'));

    expect(admin.setPlacesEnrichEnabledState).toHaveBeenNthCalledWith(1, false);
    await waitFor(() => expect(admin.setPlacesEnrichEnabledState).toHaveBeenLastCalledWith(true));
    expect(admin.setPlacesEnrichEnabled).toHaveBeenLastCalledWith(true);
  });

  it('FE-ADMSET-030c: the four places toggles expose their label to screen readers', () => {
    // They moved from hand-rolled buttons to ToggleSwitch, which is what carries
    // the aria-label and aria-pressed the bare markup never had.
    renderTab({ placesPhotosEnabled: true, placesEnrichEnabled: false });

    expect(toggleFor('Place Photos')).toHaveAttribute('aria-pressed', 'true');
    expect(toggleFor('Place Enrichment')).toHaveAttribute('aria-pressed', 'false');
    expect(toggleFor('Place Enrichment')).toHaveAttribute('aria-label', 'Place Enrichment');
  });

  it('FE-ADMSET-031: the API keys card leads with the TREK index and no weather panel', () => {
    renderTab();

    const keys = card('API Keys');
    expect(within(keys).getByRole('img', { name: 'TREK Places API' })).toBeInTheDocument();
    expect(within(keys).getByText('Recommended default')).toBeInTheDocument();
    // Weather needs no key, so it left a card about keys. The panel itself lives
    // on in the mobile section, where FE-MOB-ASET-019 asserts it.
    expect(screen.queryByText('Weather Data')).not.toBeInTheDocument();
  });

  it('FE-ADMSET-032: the API keys save button calls handleSaveApiKeys', () => {
    const admin = renderTab();

    fireEvent.click(within(card('API Keys')).getByRole('button', { name: /^save$/i }));

    expect(admin.handleSaveApiKeys).toHaveBeenCalledTimes(1);
  });

  it('FE-ADMSET-033: display name, issuer and discovery URL update the OIDC config', () => {
    render(<OidcHarness />);
    const oidc = card(/single sign-on/i);

    fireEvent.change(within(oidc).getByPlaceholderText('z.B. Google, Authentik, Keycloak'), {
      target: { value: 'Authentik' },
    });
    fireEvent.change(within(oidc).getByPlaceholderText('https://accounts.google.com'), {
      target: { value: 'https://auth.example.com' },
    });
    fireEvent.change(within(oidc).getByPlaceholderText(/openid-configuration$/), {
      target: { value: 'https://auth.example.com/.well-known/openid-configuration' },
    });

    expect(screen.getByDisplayValue('Authentik')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://auth.example.com')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('https://auth.example.com/.well-known/openid-configuration')
    ).toBeInTheDocument();
  });

  it('FE-ADMSET-034: client id and client secret update the OIDC config', () => {
    render(<OidcHarness />);
    const oidc = card(/single sign-on/i);

    const clientId = within(oidc).getByText('Client ID').parentElement!.querySelector('input')!;
    fireEvent.change(clientId, { target: { value: 'trek-client' } });

    const clientSecret = within(oidc).getByText('Client Secret').parentElement!.querySelector('input')!;
    fireEvent.change(clientSecret, { target: { value: 's3cr3t' } });

    expect(clientId).toHaveValue('trek-client');
    expect(clientSecret).toHaveValue('s3cr3t');
  });

  it('FE-ADMSET-035: masks the client secret placeholder once one is stored', () => {
    renderTab({ oidcConfig: { ...EMPTY_OIDC, client_secret_set: true } });

    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
  });

  it('FE-ADMSET-036: saving OIDC omits an empty secret and toasts on success', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/admin/oidc', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      })
    );
    const admin = renderTab({
      oidcConfig: { ...EMPTY_OIDC, issuer: 'https://idp', client_id: 'cid', display_name: 'IdP' },
    });

    fireEvent.click(within(card(/single sign-on/i)).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(admin.toast.success).toHaveBeenCalledWith('OIDC configuration saved'));
    expect(body).toEqual({ issuer: 'https://idp', client_id: 'cid', display_name: 'IdP', discovery_url: '' });
  });

  it('FE-ADMSET-037: saving OIDC includes a freshly typed secret', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/admin/oidc', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      })
    );
    renderTab({
      oidcConfig: { ...EMPTY_OIDC, issuer: 'https://idp', client_id: 'cid', client_secret: 'topsecret' },
    });

    fireEvent.click(within(card(/single sign-on/i)).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(body).toMatchObject({ client_secret: 'topsecret' }));
  });

  it('FE-ADMSET-038: a failing OIDC save surfaces the server error message', async () => {
    server.use(http.put('/api/admin/oidc', () => HttpResponse.json({ error: 'Issuer unreachable' }, { status: 400 })));
    const admin = renderTab();

    fireEvent.click(within(card(/single sign-on/i)).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(admin.toast.error).toHaveBeenCalledWith('Issuer unreachable'));
    expect(admin.setSavingOidc).toHaveBeenNthCalledWith(1, true);
    expect(admin.setSavingOidc).toHaveBeenLastCalledWith(false);
  });

  it('FE-ADMSET-039: the OIDC save button is disabled while saving', () => {
    renderTab({ savingOidc: true });

    expect(within(card(/single sign-on/i)).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('FE-ADMSET-040: the danger zone opens the rotate-JWT modal', () => {
    const admin = renderTab();

    fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }));

    expect(admin.setShowRotateJwtModal).toHaveBeenCalledWith(true);
  });
});
