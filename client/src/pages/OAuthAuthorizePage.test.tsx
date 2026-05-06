// FE-PAGE-OAUTH-001 to FE-PAGE-OAUTH-012
import { render, screen, waitFor } from '../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { useAuthStore } from '../store/authStore';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import { buildUser } from '../../tests/helpers/factories';
import OAuthAuthorizePage from './OAuthAuthorizePage';

// Default OAuth query params
const DEFAULT_SEARCH = '?client_id=test-client&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fcallback&scope=trips%3Aread&state=abc&code_challenge=challenge&code_challenge_method=S256';

function setSearchParams(search: string) {
  window.history.pushState({}, '', '/oauth/consent' + search);
}

const VALIDATE_OK = {
  valid: true,
  client: { name: 'Test App', allowed_scopes: ['trips:read'] },
  scopes: ['trips:read'],
  consentRequired: true,
  loginRequired: false,
  scopeSelectable: false,
};

beforeEach(() => {
  resetAllStores();
  setSearchParams(DEFAULT_SEARCH);
  server.resetHandlers();
  // Default: authenticated user
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, isLoading: false });
  // Default validate: consent required
  server.use(
    http.get('/api/oauth/authorize/validate', () => HttpResponse.json(VALIDATE_OK)),
    http.post('/api/oauth/authorize', () =>
      HttpResponse.json({ redirect: 'http://localhost:4000/callback?code=abc' })
    ),
  );
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('OAuthAuthorizePage', () => {
  it('FE-PAGE-OAUTH-001: shows loading spinner initially', () => {
    server.use(
      http.get('/api/oauth/authorize/validate', async () => {
        await new Promise(() => {}); // never resolves
        return HttpResponse.json(VALIDATE_OK);
      })
    );
    render(<OAuthAuthorizePage />);
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('FE-PAGE-OAUTH-002: shows error state when validation fails', async () => {
    server.use(
      http.get('/api/oauth/authorize/validate', () =>
        HttpResponse.json({
          valid: false,
          error: 'invalid_client',
          error_description: 'Unknown client ID',
        })
      )
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Authorization Error');
    expect(screen.getByText('Unknown client ID')).toBeInTheDocument();
  });

  it('FE-PAGE-OAUTH-003: shows error state on network error', async () => {
    server.use(
      http.get('/api/oauth/authorize/validate', () =>
        HttpResponse.json({ error: 'server error' }, { status: 500 })
      )
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Authorization Error');
    expect(screen.getByText(/Failed to validate/i)).toBeInTheDocument();
  });

  it('FE-PAGE-OAUTH-004: shows login_required state', async () => {
    server.use(
      http.get('/api/oauth/authorize/validate', () =>
        HttpResponse.json({ ...VALIDATE_OK, loginRequired: true, consentRequired: true })
      )
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Sign in to continue');
    expect(screen.getByText('Sign in to TREK')).toBeInTheDocument();
  });

  it('FE-PAGE-OAUTH-005: shows client name in login_required state', async () => {
    server.use(
      http.get('/api/oauth/authorize/validate', () =>
        HttpResponse.json({ ...VALIDATE_OK, loginRequired: true })
      )
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Sign in to continue');
    expect(screen.getByText(/Test App/)).toBeInTheDocument();
  });

  it('FE-PAGE-OAUTH-006: shows consent form with client name and scope list', async () => {
    render(<OAuthAuthorizePage />);
    await screen.findByText('Test App');
    expect(screen.getByText('Authorization Request')).toBeInTheDocument();
    expect(screen.getByText('Approve Access')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
  });

  it('FE-PAGE-OAUTH-007: auto-approves when consentRequired is false', async () => {
    let authorizeCalled = false;
    server.use(
      http.get('/api/oauth/authorize/validate', () =>
        HttpResponse.json({ ...VALIDATE_OK, consentRequired: false })
      ),
      http.post('/api/oauth/authorize', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        authorizeCalled = true;
        expect(body.approved).toBe(true);
        return HttpResponse.json({ redirect: 'http://localhost:4000/callback?code=xyz' });
      })
    );
    render(<OAuthAuthorizePage />);
    // Shows auto-approving spinner
    await waitFor(() => {
      expect(authorizeCalled).toBe(true);
    });
  });

  it('FE-PAGE-OAUTH-008: clicking Deny sends approved=false to authorize', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> = {};
    server.use(
      http.post('/api/oauth/authorize', async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ redirect: 'http://localhost:4000/callback?error=access_denied' });
      })
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Deny');
    await user.click(screen.getByText('Deny'));
    await waitFor(() => {
      expect(body.approved).toBe(false);
    });
  });

  it('FE-PAGE-OAUTH-009: clicking Approve sends approved=true with selected scopes', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> = {};
    server.use(
      http.post('/api/oauth/authorize', async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ redirect: 'http://localhost:4000/callback?code=ok' });
      })
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Approve Access');
    await user.click(screen.getByText('Approve Access'));
    await waitFor(() => {
      expect(body.approved).toBe(true);
    });
  });

  it('FE-PAGE-OAUTH-010: shows error when authorize call fails', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/oauth/authorize', () =>
        HttpResponse.json({ error: 'server error' }, { status: 500 })
      )
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Approve Access');
    await user.click(screen.getByText('Approve Access'));
    await screen.findByText('Authorization Error');
    expect(screen.getByText(/Authorization failed/i)).toBeInTheDocument();
  });

  it('FE-PAGE-OAUTH-011: scopeSelectable=true renders checkboxes for scopes', async () => {
    server.use(
      http.get('/api/oauth/authorize/validate', () =>
        HttpResponse.json({ ...VALIDATE_OK, scopeSelectable: true, scopes: ['trips:read', 'places:read'] })
      )
    );
    render(<OAuthAuthorizePage />);
    await screen.findByText('Choose which permissions to grant');
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
  });

  it('FE-PAGE-OAUTH-012: scopeSelectable=false renders read-only scope list', async () => {
    render(<OAuthAuthorizePage />);
    await screen.findByText('Permissions requested');
    // No checkboxes in read-only mode
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
