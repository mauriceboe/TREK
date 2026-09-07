// FE-MOB-ASET-001 to FE-MOB-ASET-023
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '../../../helpers/render';
import { server } from '../../../helpers/msw/server';
import { resetAllStores } from '../../../helpers/store';
import { buildAdminHook, type AdminHook } from '../../../helpers/mobileAdmin';
import { useTranslation } from '../../../../src/i18n';
import MAdminSettingsSection from '../../../../src/mobile/screens/admin/MAdminSettingsSection';

function Harness({ admin }: { admin: AdminHook }) {
  const { t } = useTranslation();
  return <MAdminSettingsSection admin={admin} t={t} />;
}

type Spy = ReturnType<typeof vi.fn>;
type Spies = Record<string, Spy> & { toast: Record<string, Spy> };

function renderSettings(overrides: Record<string, unknown> = {}) {
  const admin = buildAdminHook(overrides);
  render(<Harness admin={admin} />);
  return admin as unknown as Spies;
}

function toggle(label: string): HTMLElement {
  return screen.getByRole('switch', { name: label });
}

/** Client ID / Client Secret are the only inputs of their type without a placeholder. */
function unlabelledInput(type: 'text' | 'password'): HTMLInputElement {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`));
  const match = inputs.find((i) => !i.placeholder);
  if (!match) throw new Error(`no ${type} input without a placeholder`);
  return match;
}

/**
 * setOidcConfig receives an updater that reads e.target.value lazily, so the
 * spy fixture can't be replayed after the event — this harness holds the config
 * in real state instead.
 */
function OidcHarness() {
  const { t } = useTranslation();
  const [oidcConfig, setOidcConfig] = React.useState({
    issuer: '',
    client_id: '',
    client_secret: '',
    client_secret_set: false,
    display_name: '',
    discovery_url: '',
  });
  const admin = buildAdminHook({ oidcConfig, setOidcConfig });
  return <MAdminSettingsSection admin={admin} t={t} />;
}

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  server.resetHandlers();
});

describe('MAdminSettingsSection', () => {
  it('FE-MOB-ASET-001: renders every card of the settings tab', () => {
    renderSettings();

    expect(screen.getByText('Authentication Methods')).toBeInTheDocument();
    expect(screen.getByText('Passkey login')).toBeInTheDocument();
    expect(screen.getByText('Require two-factor authentication (2FA)')).toBeInTheDocument();
    // Card head and field label share the copy
    expect(screen.getAllByText('Allowed File Types')).toHaveLength(2);
    expect(screen.getByText('API Keys')).toBeInTheDocument();
    expect(screen.getByText('Single Sign-On (OIDC)')).toBeInTheDocument();
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
  });

  it('FE-MOB-ASET-002: the OIDC toggles only appear once OIDC is configured', () => {
    renderSettings({ oidcConfigured: false });

    expect(screen.queryByRole('switch', { name: 'SSO Login' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'SSO Auto-Provisioning' })).not.toBeInTheDocument();
  });

  it('FE-MOB-ASET-003: an env override disables the password toggles and shows the hint', () => {
    renderSettings({ envOverrideOidcOnly: true, oidcConfigured: true });

    expect(
      screen.getByText(
        'Password login settings are controlled by the OIDC_ONLY environment variable and cannot be changed here.',
      ),
    ).toBeInTheDocument();
    expect(toggle('Password Login')).toBeDisabled();
    expect(toggle('Password Registration')).toBeDisabled();
    expect(toggle('SSO Login')).not.toBeDisabled();
  });

  it('FE-MOB-ASET-004: the last remaining login method cannot be switched off', () => {
    renderSettings({ passwordLogin: false, oidcLogin: false, oidcConfigured: true });

    expect(toggle('Password Login')).toBeDisabled();
    expect(toggle('SSO Login')).not.toBeDisabled();
  });

  it('FE-MOB-ASET-005: each auth toggle reports its own key and the new value', async () => {
    const user = userEvent.setup();
    const admin = renderSettings({ oidcConfigured: true, oidcLogin: true, oidcRegistration: false });

    await user.click(toggle('Password Login'));
    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith(
      'password_login', false, admin.setPasswordLogin,
    );

    await user.click(toggle('Password Registration'));
    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith(
      'password_registration', false, admin.setPasswordRegistration,
    );

    await user.click(toggle('SSO Login'));
    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith('oidc_login', false, admin.setOidcLogin);

    await user.click(toggle('SSO Auto-Provisioning'));
    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith(
      'oidc_registration', true, admin.setOidcRegistration,
    );

    await user.click(toggle('Enable passkey login'));
    expect(admin.handleToggleAuthSetting).toHaveBeenCalledWith('passkey_login', true, admin.setPasskeyLogin);
  });

  it('FE-MOB-ASET-006: the require-MFA toggle calls its dedicated handler', async () => {
    const user = userEvent.setup();
    const admin = renderSettings({ requireMfa: false });

    await user.click(toggle('Require two-factor authentication (2FA)'));

    expect(admin.handleToggleRequireMfa).toHaveBeenCalledWith(true);
  });

  it('FE-MOB-ASET-007: the passkey warning shows only when enabled but unconfigured', () => {
    const { unmount } = render(
      <Harness admin={buildAdminHook({ passkeyLogin: true, passkeyConfigured: false })} />,
    );
    expect(
      screen.getByText(
        'No WebAuthn domain resolves for this deployment yet. Set APP_URL or the Relying Party ID below — passkeys stay hidden until then.',
      ),
    ).toBeInTheDocument();
    unmount();

    render(<Harness admin={buildAdminHook({ passkeyLogin: true, passkeyConfigured: true })} />);
    expect(screen.queryByText(/No WebAuthn domain resolves/)).not.toBeInTheDocument();
  });

  it('FE-MOB-ASET-008: the WebAuthn fields render their values and save through the hook', async () => {
    const user = userEvent.setup();
    const admin = renderSettings({
      webauthnRpId: 'trek.example.org',
      webauthnOrigins: 'https://trek.example.org',
    });

    expect(screen.getByPlaceholderText('trek.example.org')).toHaveValue('trek.example.org');
    expect(screen.getByPlaceholderText('https://trek.example.org')).toHaveValue('https://trek.example.org');

    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    expect(admin.handleSaveWebauthn).toHaveBeenCalled();
  });

  it('FE-MOB-ASET-009: editing the RP ID and origins goes through their setters', async () => {
    const user = userEvent.setup();
    const admin = renderSettings();

    await user.type(screen.getByPlaceholderText('trek.example.org'), 'a');
    expect(admin.setWebauthnRpId).toHaveBeenCalledWith('a');

    await user.type(screen.getByPlaceholderText('https://trek.example.org'), 'b');
    expect(admin.setWebauthnOrigins).toHaveBeenCalledWith('b');
  });

  it('FE-MOB-ASET-010: saving the allowed file types PUTs them and reports success', async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> = {};
    server.use(
      http.put('/api/auth/app-settings', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sent);
      }),
    );
    const admin = renderSettings({ allowedFileTypes: 'jpg,png' });

    await user.click(screen.getAllByRole('button', { name: 'Save' })[1]);

    await waitFor(() => expect(admin.toast.success).toHaveBeenCalledWith('File type settings saved'));
    expect(sent).toEqual({ allowed_file_types: 'jpg,png' });
    expect(admin.setSavingFileTypes).toHaveBeenNthCalledWith(1, true);
    expect(admin.setSavingFileTypes).toHaveBeenLastCalledWith(false);
  });

  it('FE-MOB-ASET-011: a failing file-types save toasts the generic error', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/auth/app-settings', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );
    const admin = renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Save' })[1]);

    await waitFor(() => expect(admin.toast.error).toHaveBeenCalledWith('Error'));
    expect(admin.setSavingFileTypes).toHaveBeenLastCalledWith(false);
  });

  it('FE-MOB-ASET-012: the file-types input writes back through its setter', async () => {
    const user = userEvent.setup();
    const admin = renderSettings({ allowedFileTypes: '' });

    await user.type(screen.getByPlaceholderText('jpg,png,pdf,doc,docx,xls,xlsx,txt,csv'), 'p');
    expect(admin.setAllowedFileTypes).toHaveBeenCalledWith('p');
  });

  it('FE-MOB-ASET-013: the maps key validate button is disabled without a key', () => {
    renderSettings({ mapsKey: '' });

    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
  });

  it('FE-MOB-ASET-014: validating a maps key calls the handler for that key type', async () => {
    const user = userEvent.setup();
    const admin = renderSettings({ mapsKey: 'AIza-test' });

    await user.click(screen.getByRole('button', { name: 'Test' }));

    expect(admin.handleValidateKey).toHaveBeenCalledWith('maps');
  });

  it('FE-MOB-ASET-015: the validation result renders as a valid or invalid line', () => {
    const { unmount } = render(
      <Harness admin={buildAdminHook({ mapsKey: 'k', validation: { maps: true } })} />,
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument();
    unmount();

    render(<Harness admin={buildAdminHook({ mapsKey: 'k', validation: { maps: false } })} />);
    expect(screen.getByText('Invalid')).toBeInTheDocument();
  });

  it('FE-MOB-ASET-016: the API keys card saves through the hook', async () => {
    const user = userEvent.setup();
    const admin = renderSettings();

    // By accessible name rather than by position: the card gained an Amap field
    // between Maps and Unsplash, and an index quietly starts asserting about a
    // different input when that happens.
    await user.type(screen.getByLabelText('Google Maps API Key'), 'm');
    expect(admin.setMapsKey).toHaveBeenCalledWith('m');

    await user.type(screen.getByLabelText('Unsplash API Key'), 'u');
    expect(admin.setUnsplashKey).toHaveBeenCalledWith('u');

    await user.type(screen.getByLabelText(/Amap/), 'a');
    expect(admin.setAmapKey).toHaveBeenCalledWith('a');

    await user.click(screen.getAllByRole('button', { name: 'Save' })[2]);
    expect(admin.handleSaveApiKeys).toHaveBeenCalled();
  });

  it('FE-MOB-ASET-017: the Google Places toggles persist optimistically', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    server.use(
      http.put('/api/admin/places-photos', () => {
        seen.push('photos');
        return HttpResponse.json({ enabled: true });
      }),
      http.put('/api/admin/places-autocomplete', () => {
        seen.push('autocomplete');
        return HttpResponse.json({ enabled: true });
      }),
      http.put('/api/admin/places-details', () => {
        seen.push('details');
        return HttpResponse.json({ enabled: true });
      }),
    );
    const admin = renderSettings();

    await user.click(toggle('Place Photos'));
    await user.click(toggle('Place Autocomplete'));
    await user.click(toggle('Place Details'));

    await waitFor(() => expect(seen).toEqual(['photos', 'autocomplete', 'details']));
    expect(admin.setPlacesPhotosEnabledState).toHaveBeenCalledWith(true);
    expect(admin.setPlacesPhotosEnabled).toHaveBeenCalledWith(true);
    expect(admin.setPlacesAutocompleteEnabled).toHaveBeenCalledWith(true);
    expect(admin.setPlacesDetailsEnabled).toHaveBeenCalledWith(true);
  });

  it('FE-MOB-ASET-018: a rejected Places update rolls the toggle back', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/admin/places-photos', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      http.put('/api/admin/places-autocomplete', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      http.put('/api/admin/places-details', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );
    const admin = renderSettings({
      placesPhotosEnabled: true,
      placesAutocompleteEnabled: true,
      placesDetailsEnabled: true,
    });

    await user.click(toggle('Place Photos'));
    await user.click(toggle('Place Autocomplete'));
    await user.click(toggle('Place Details'));

    await waitFor(() => expect(admin.setPlacesPhotosEnabledState).toHaveBeenLastCalledWith(true));
    expect(admin.setPlacesPhotosEnabled).toHaveBeenLastCalledWith(true);
    expect(admin.setPlacesAutocompleteEnabledState).toHaveBeenLastCalledWith(true);
    expect(admin.setPlacesDetailsEnabledState).toHaveBeenLastCalledWith(true);
  });

  it('FE-MOB-ASET-019: the Open-Meteo card lists the three facts', () => {
    renderSettings();

    expect(screen.getByText('Weather Data')).toBeInTheDocument();
    expect(screen.getByText('Free, no API key required')).toBeInTheDocument();
    expect(screen.getByText('16-day forecast')).toBeInTheDocument();
    expect(screen.getByText('10,000 requests / day')).toBeInTheDocument();
  });

  it('FE-MOB-ASET-020: the OIDC form renders its values and saves a payload without an empty secret', async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> = {};
    server.use(
      http.put('/api/admin/oidc', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(sent);
      }),
    );
    const admin = renderSettings({
      oidcConfig: {
        issuer: 'https://idp.example.org',
        client_id: 'trek',
        client_secret: '',
        client_secret_set: true,
        display_name: 'Authentik',
        discovery_url: 'https://idp.example.org/.well-known/openid-configuration',
      },
    });

    expect(screen.getByDisplayValue('Authentik')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://idp.example.org')).toBeInTheDocument();
    expect(screen.getByDisplayValue('trek')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Save' })[3]);

    await waitFor(() => expect(admin.toast.success).toHaveBeenCalledWith('OIDC configuration saved'));
    expect(sent).toEqual({
      issuer: 'https://idp.example.org',
      client_id: 'trek',
      display_name: 'Authentik',
      discovery_url: 'https://idp.example.org/.well-known/openid-configuration',
    });
    expect(admin.setSavingOidc).toHaveBeenLastCalledWith(false);
  });

  it('FE-MOB-ASET-021: a filled secret is sent and a server error message is surfaced', async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> = {};
    server.use(
      http.put('/api/admin/oidc', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ error: 'Issuer unreachable' }, { status: 400 });
      }),
    );
    const admin = renderSettings({
      oidcConfig: {
        issuer: 'https://idp.example.org',
        client_id: 'trek',
        client_secret: 's3cr3t',
        client_secret_set: false,
        display_name: 'Authentik',
        discovery_url: '',
      },
    });

    await user.click(screen.getAllByRole('button', { name: 'Save' })[3]);

    await waitFor(() => expect(admin.toast.error).toHaveBeenCalledWith('Issuer unreachable'));
    expect(sent.client_secret).toBe('s3cr3t');
  });

  it('FE-MOB-ASET-022: every OIDC input patches only its own field', async () => {
    const user = userEvent.setup();
    render(<OidcHarness />);

    await user.type(screen.getByPlaceholderText('z.B. Google, Authentik, Keycloak'), 'Authentik');
    await user.type(screen.getByPlaceholderText('https://accounts.google.com'), 'https://idp');
    await user.type(
      screen.getByPlaceholderText(
        'https://auth.example.com/application/o/trek/.well-known/openid-configuration',
      ),
      'https://idp/disco',
    );
    await user.type(unlabelledInput('text'), 'trek');
    await user.type(unlabelledInput('password'), 's3cr3t');

    expect(screen.getByPlaceholderText('z.B. Google, Authentik, Keycloak')).toHaveValue('Authentik');
    expect(screen.getByPlaceholderText('https://accounts.google.com')).toHaveValue('https://idp');
    expect(
      screen.getByPlaceholderText(
        'https://auth.example.com/application/o/trek/.well-known/openid-configuration',
      ),
    ).toHaveValue('https://idp/disco');
    expect(unlabelledInput('text')).toHaveValue('trek');
    expect(unlabelledInput('password')).toHaveValue('s3cr3t');
  });

  it('FE-MOB-ASET-023: the danger zone opens the rotate-JWT confirm', async () => {
    const user = userEvent.setup();
    const admin = renderSettings();

    await user.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(admin.setShowRotateJwtModal).toHaveBeenCalledWith(true);
  });
});
