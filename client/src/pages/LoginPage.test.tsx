import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { resetAllStores } from '../../tests/helpers/store';
import LoginPage from './LoginPage';

// The takeoff overlay renders the animated dot world, which starts three
// requestAnimationFrame loops the moment it mounts. Nothing here asserts on the
// animation (LoginWorld has its own tests), but under the load of the full suite
// those loops pushed the overlay assertions past waitFor's default timeout and
// made FE-PAGE-LOGIN-014 fail intermittently in CI while passing in isolation.
vi.mock('./login/LoginWorld', () => ({ default: () => null }));

// LoginPage uses inline styles for labels (no htmlFor/id pairing).
// We find inputs by placeholder text.
const EMAIL_PLACEHOLDER = 'your@email.com';
const PASSWORD_PLACEHOLDER = '••••••••';

beforeEach(() => {
  resetAllStores();
});

describe('LoginPage', () => {
  describe('FE-PAGE-LOGIN-001: Renders login form', () => {
    it('shows email and password inputs', async () => {
      render(<LoginPage />);
      // Wait for appConfig to load (useEffect fetches it)
      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER)).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-LOGIN-002: Submitting valid credentials triggers login', () => {
    it('shows takeoff animation on successful login', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      // On success, takeoff overlay appears
      await waitFor(() => {
        expect(document.querySelector('.takeoff-overlay')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-003: Invalid credentials shows error', () => {
    it('displays error message on login failure', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({ error: 'Invalid credentials' }, { status: 401 });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'bad@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'wrongpass');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        // authStore.login throws, LoginPage catches and sets error text from API response
        expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-004: Loading state while login in progress', () => {
    it('disables submit button and shows spinner during login', async () => {
      server.use(
        http.post('/api/auth/login', async () => {
          await new Promise(resolve => setTimeout(resolve, 150));
          return HttpResponse.json({
            user: { id: 1, username: 'test', email: 'test@example.com', role: 'user' },
          });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      // While loading, button becomes disabled with spinner text
      await waitFor(() => {
        const submitBtn = screen.getByRole('button', { name: /signing in/i });
        expect(submitBtn).toBeDisabled();
      });
    });
  });

  describe('FE-PAGE-LOGIN-007: Remember me sends remember_me to the API', () => {
    it('renders an off toggle and forwards remember_me: true when toggled on', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post('/api/auth/login', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ user: { id: 1, username: 'test', email: 'test@example.com', role: 'user' } });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      const toggle = screen.getByRole('button', { name: /remember me/i });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(capturedBody).toEqual(expect.objectContaining({ remember_me: true }));
      });
    });
  });

  describe('FE-PAGE-LOGIN-005: Registration toggle visible', () => {
    it('shows a Register button to switch to registration mode', async () => {
      // Default appConfig has allow_registration: true, has_users: true
      render(<LoginPage />);

      await waitFor(() => {
        // The register toggle link text appears
        expect(screen.getByRole('button', { name: /^register$/i })).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-006: Register creates account', () => {
    it('switches to register mode and submits registration form', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^register$/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /^register$/i }));

      // Username field appears in register mode
      await waitFor(() => {
        expect(screen.getByPlaceholderText('admin')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText('admin'), 'newuser');
      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'new@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');

      await user.click(screen.getByRole('button', { name: /create account/i }));

      // On success, takeoff animation
      await waitFor(() => {
        expect(document.querySelector('.takeoff-overlay')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-007: OIDC button shown when configured', () => {
    it('renders SSO sign-in link when oidc_configured is true', async () => {
      server.use(
        http.get('/api/auth/app-config', () => {
          return HttpResponse.json({
            has_users: true,
            allow_registration: true,
            demo_mode: false,
            oidc_configured: true,
            oidc_display_name: 'Okta',
            oidc_only_mode: false,
            oidc_login: true,
            password_login: true,
            password_registration: true,
            setup_complete: true,
          });
        }),
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByText(/sign in with okta/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-008: Demo login available in demo mode', () => {
    it('shows demo button when demo_mode is true', async () => {
      server.use(
        http.get('/api/auth/app-config', () => {
          return HttpResponse.json({
            has_users: true,
            allow_registration: false,
            demo_mode: true,
            oidc_configured: false,
            oidc_only_mode: false,
            setup_complete: true,
          });
        }),
      );

      render(<LoginPage />);

      await waitFor(() => {
        // Demo hint button appears
        expect(screen.getByText(/try the demo/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-009: MFA prompt after initial login', () => {
    it('shows MFA code input when login returns mfa_required', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({
            mfa_required: true,
            mfa_token: 'test-mfa-token-abc',
          });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      // MFA step: the title changes to "Two-factor authentication"
      await waitFor(() => {
        expect(screen.getByText(/two-factor authentication/i)).toBeInTheDocument();
      });

      // MFA code input with correct placeholder
      expect(screen.getByPlaceholderText('000000 or XXXX-XXXX')).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-LOGIN-010: Successful login triggers navigation', () => {
    it('shows takeoff overlay (navigation signal) after successful auth', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'pass1234');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      // Takeoff animation signals navigation away from login
      await waitFor(() => {
        expect(document.querySelector('.takeoff-overlay')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-011: Password change step appears when must_change_password', () => {
    it('transitions to change password form when login returns must_change_password=true', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({
            user: { id: 1, username: 'test', email: 'test@example.com', role: 'user', must_change_password: true },
          });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New password')).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText('Confirm new password')).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-LOGIN-012: Password change form validates length', () => {
    it('shows error when new password is shorter than 8 characters', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({
            user: { id: 1, username: 'test', email: 'test@example.com', role: 'user', must_change_password: true },
          });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New password')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText('New password'), 'short');
      await user.type(screen.getByPlaceholderText('Confirm new password'), 'short');
      await user.click(screen.getByRole('button', { name: /update password/i }));

      await waitFor(() => {
        expect(screen.getByText(/at least 8/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-013: Password change form validates mismatch', () => {
    it('shows error when new passwords do not match', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({
            user: { id: 1, username: 'test', email: 'test@example.com', role: 'user', must_change_password: true },
          });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New password')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText('New password'), 'newpassword123');
      await user.type(screen.getByPlaceholderText('Confirm new password'), 'differentpassword123');
      await user.click(screen.getByRole('button', { name: /update password/i }));

      await waitFor(() => {
        expect(screen.getByText(/do not match/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-014: Password change success navigates', () => {
    it('shows takeoff overlay after successful password change', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({
            user: { id: 1, username: 'test', email: 'test@example.com', role: 'user', must_change_password: true },
          });
        }),
        http.put('/api/auth/me/password', () => {
          return HttpResponse.json({ success: true });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New password')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText('New password'), 'newpassword123');
      await user.type(screen.getByPlaceholderText('Confirm new password'), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /update password/i }));

      await waitFor(() => {
        expect(document.querySelector('.takeoff-overlay')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-015: First-setup mode switches to register when has_users=false', () => {
    it('shows register form automatically when has_users is false', async () => {
      server.use(
        http.get('/api/auth/app-config', () => {
          return HttpResponse.json({
            has_users: false,
            allow_registration: true,
            demo_mode: false,
            oidc_configured: false,
            oidc_only_mode: false,
            setup_complete: true,
          });
        }),
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('admin')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-016: Registration disabled hides register option', () => {
    it('does not show register button when allow_registration is false', async () => {
      server.use(
        http.get('/api/auth/app-config', () => {
          return HttpResponse.json({
            has_users: true,
            allow_registration: false,
            demo_mode: false,
            oidc_configured: false,
            oidc_only_mode: false,
            setup_complete: true,
          });
        }),
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /^register$/i })).toBeNull();
    });
  });

  describe('FE-PAGE-LOGIN-017: OIDC-only mode hides standard login form', () => {
    it('does not render email/password inputs in oidc_only_mode', async () => {
      server.use(
        http.get('/api/auth/app-config', () => {
          return HttpResponse.json({
            has_users: true,
            allow_registration: false,
            demo_mode: false,
            oidc_configured: true,
            oidc_only_mode: true,
            password_login: false,
            oidc_login: true,
            setup_complete: true,
          });
        }),
      );

      // Pass noRedirect via location.state to prevent window.location.href redirect
      render(<LoginPage />, {
        initialEntries: [{ pathname: '/login', state: { noRedirect: true } }],
      });

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(EMAIL_PLACEHOLDER)).toBeNull();
        expect(screen.queryByPlaceholderText(PASSWORD_PLACEHOLDER)).toBeNull();
      });
    });
  });

  describe('FE-PAGE-LOGIN-018: MFA code submission completes login', () => {
    it('shows takeoff overlay after successful MFA verification', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({
            mfa_required: true,
            mfa_token: 'test-mfa-token-abc',
          });
        }),
        http.post('/api/auth/mfa/verify-login', () => {
          return HttpResponse.json({
            user: { id: 1, username: 'test', email: 'test@example.com', role: 'user' },
          });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('000000 or XXXX-XXXX')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText('000000 or XXXX-XXXX'), '123456');
      await user.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => {
        expect(document.querySelector('.takeoff-overlay')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-019: Empty MFA code shows error', () => {
    it('shows error when MFA code is empty and does not show takeoff overlay', async () => {
      server.use(
        http.post('/api/auth/login', () => {
          return HttpResponse.json({
            mfa_required: true,
            mfa_token: 'test-mfa-token-abc',
          });
        }),
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(EMAIL_PLACEHOLDER)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'user@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'password123');
      await user.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('000000 or XXXX-XXXX')).toBeInTheDocument();
      });

      // Submit the form directly (bypasses browser constraint validation on required field)
      const form = document.querySelector('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText(/enter the code from your authenticator/i)).toBeInTheDocument();
      });
      expect(document.querySelector('.takeoff-overlay')).toBeNull();
    });
  });

  describe('FE-PAGE-LOGIN-020: Register form validates password length', () => {
    it('shows error when registration password is shorter than 8 characters', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^register$/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /^register$/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('admin')).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText('admin'), 'newuser');
      await user.type(screen.getByPlaceholderText(EMAIL_PLACEHOLDER), 'new@example.com');
      await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), 'short');
      await user.click(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByText(/at least 8/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-LOGIN-021: Invite token pre-fills register mode', () => {
    it('renders register form when invite query param is present', async () => {
      server.use(
        http.get('/api/auth/invite/:token', () => {
          return HttpResponse.json({ valid: true });
        }),
      );

      // Simulate ?invite=abc123 by replacing window.location.search
      const originalSearch = window.location.search;
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: { ...window.location, search: '?invite=abc123' },
      });

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('admin')).toBeInTheDocument();
      });

      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: { ...window.location, search: originalSearch },
      });
    });
  });
});
