import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../../tests/helpers/render';
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { resetAllStores } from '../../tests/helpers/store';
import LoginPage from './LoginPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('LoginPage — OIDC redirect preservation', () => {
  let savedLocation: Location;

  beforeEach(() => {
    resetAllStores();
    mockNavigate.mockClear();
    sessionStorage.clear();
    savedLocation = window.location;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: savedLocation,
    });
  });

  function setSearch(search: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...window.location, search },
    });
  }

  describe('FE-PAGE-LOGIN-022: redirect param stashed in sessionStorage on mount', () => {
    it('saves decoded redirect to sessionStorage when ?redirect= is present', async () => {
      setSearch('?redirect=%2Foauth%2Fconsent%3Fclient_id%3Dfoo');
      render(<LoginPage />);

      await waitFor(() => {
        expect(sessionStorage.getItem('oidc_redirect')).toBe('/oauth/consent?client_id=foo');
      });
    });

    it('does not write to sessionStorage when no redirect param is present', async () => {
      render(<LoginPage />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('your@email.com')).toBeInTheDocument();
      });

      expect(sessionStorage.getItem('oidc_redirect')).toBeNull();
    });
  });

  describe('FE-PAGE-LOGIN-023: OIDC code exchange navigates to sessionStorage redirect', () => {
    beforeEach(() => {
      server.use(
          http.get('/api/auth/oidc/exchange', () =>
              HttpResponse.json({ token: 'mock-oidc-token' })
          ),
      );
    });

    it('navigates to the saved sessionStorage redirect after successful OIDC exchange', async () => {
      sessionStorage.setItem('oidc_redirect', '/oauth/consent?client_id=foo&state=xyz');
      setSearch('?oidc_code=testcode123');
      render(<LoginPage />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(
            '/oauth/consent?client_id=foo&state=xyz',
            { replace: true },
        );
      });

      expect(sessionStorage.getItem('oidc_redirect')).toBeNull();
    });

    it('falls back to /dashboard when no sessionStorage redirect is set', async () => {
      setSearch('?oidc_code=testcode123');
      render(<LoginPage />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true });
      });
    });
  });

  describe('FE-PAGE-LOGIN-024: OIDC error clears sessionStorage redirect', () => {
    it('removes oidc_redirect from sessionStorage on OIDC error', async () => {
      sessionStorage.setItem('oidc_redirect', '/oauth/consent?client_id=foo');
      setSearch('?oidc_error=token_failed');
      render(<LoginPage />);

      await waitFor(() => {
        expect(sessionStorage.getItem('oidc_redirect')).toBeNull();
      });
    });
  });
});