import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../helpers/msw/server';
import { useAuthStore } from '../../../src/store/authStore';
import { authApi } from '../../../src/api/client';
import { resetAllStores } from '../../helpers/store';
import { buildUser } from '../../helpers/factories';

// The websocket module is already mocked globally in tests/setup.ts
import { connect, disconnect } from '../../../src/api/websocket';

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
});

describe('authStore', () => {
  describe('FE-AUTH-001: Successful login', () => {
    it('sets user, isAuthenticated: true, isLoading: false', async () => {
      const user = buildUser();
      server.use(
        http.post('/api/auth/login', () =>
          HttpResponse.json({ user, token: 'tok' })
        )
      );

      await useAuthStore.getState().login(user.email, 'password');
      const state = useAuthStore.getState();

      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe('FE-AUTH-002: Login failure', () => {
    it('sets error and isAuthenticated: false', async () => {
      server.use(
        http.post('/api/auth/login', () =>
          HttpResponse.json({ error: 'Bad credentials' }, { status: 401 })
        )
      );

      await expect(
        useAuthStore.getState().login('bad@example.com', 'wrong')
      ).rejects.toThrow();

      const state = useAuthStore.getState();
      expect(state.error).toBe('Bad credentials');
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-AUTH-003: Login calls connect()', () => {
    it('calls connect from websocket module after successful login', async () => {
      const user = buildUser();
      server.use(
        http.post('/api/auth/login', () =>
          HttpResponse.json({ user, token: 'tok' })
        )
      );

      await useAuthStore.getState().login(user.email, 'password');

      expect(connect).toHaveBeenCalledOnce();
    });
  });

  describe('FE-AUTH-004: loadUser with valid session', () => {
    it('sets user state from /auth/me', async () => {
      const user = buildUser();
      server.use(
        http.get('/api/auth/me', () => HttpResponse.json({ user }))
      );

      await useAuthStore.getState().loadUser();
      const state = useAuthStore.getState();

      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-AUTH-005: loadUser with 401', () => {
    it('clears auth state on 401', async () => {
      server.use(
        http.get('/api/auth/me', () =>
          HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
        )
      );

      // Pre-seed as authenticated
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      await useAuthStore.getState().loadUser();
      const state = useAuthStore.getState();

      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-AUTH-006: logout', () => {
    it('calls disconnect() and clears user state', () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      useAuthStore.getState().logout();
      const state = useAuthStore.getState();

      expect(disconnect).toHaveBeenCalledOnce();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });
  });

  describe('FE-AUTH-007: Register success', () => {
    it('sets user and authenticates', async () => {
      const user = buildUser();
      server.use(
        http.post('/api/auth/register', () =>
          HttpResponse.json({ user, token: 'tok' })
        )
      );

      await useAuthStore.getState().register(user.username, user.email, 'password');
      const state = useAuthStore.getState();

      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-AUTH-008: authSequence guard', () => {
    it('stale loadUser does not overwrite fresh login state', async () => {
      let resolveStale!: (v: Response) => void;
      const stalePromise = new Promise<Response>((res) => { resolveStale = res; });

      // First call to /auth/me will hang until we resolve it manually
      let callCount = 0;
      server.use(
        http.get('/api/auth/me', async () => {
          callCount++;
          if (callCount === 1) {
            // Stale request — wait
            await stalePromise;
            return HttpResponse.json({ user: buildUser({ username: 'stale' }) });
          }
          // Should not be called a second time in this test
          return HttpResponse.json({ user: buildUser({ username: 'fresh' }) });
        })
      );

      // Start loadUser but don't await yet
      const staleLoad = useAuthStore.getState().loadUser();

      // Meanwhile, perform a login (bumps authSequence)
      const freshUser = buildUser({ username: 'freshlogin' });
      server.use(
        http.post('/api/auth/login', () =>
          HttpResponse.json({ user: freshUser, token: 'tok' })
        )
      );
      await useAuthStore.getState().login(freshUser.email, 'password');

      // Now resolve the stale loadUser response
      resolveStale(new Response());
      await staleLoad;

      // The fresh login state must be preserved
      const state = useAuthStore.getState();
      expect(state.user?.username).toBe('freshlogin');
      expect(state.isAuthenticated).toBe(true);
    });
  });

  describe('FE-AUTH-009: MFA-required state handling', () => {
    it('returns mfa_required flag and does not set user as authenticated', async () => {
      server.use(
        http.post('/api/auth/login', () =>
          HttpResponse.json({ mfa_required: true, mfa_token: 'mfa-tok-123' })
        )
      );

      const result = await useAuthStore.getState().login('user@example.com', 'password');

      expect(result).toMatchObject({ mfa_required: true, mfa_token: 'mfa-tok-123' });
      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeNull();
    });
  });

  describe('FE-STORE-AUTH-010: completeMfaLogin success', () => {
    it('sets user, isAuthenticated, and calls connect', async () => {
      const user = buildUser();
      server.use(
        http.post('/api/auth/mfa/verify-login', () =>
          HttpResponse.json({ user, token: 'mfa-session-tok' })
        )
      );

      await useAuthStore.getState().completeMfaLogin('mfa-tok', '123456');
      const state = useAuthStore.getState();

      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(connect).toHaveBeenCalledOnce();
    });
  });

  describe('FE-STORE-AUTH-011: completeMfaLogin failure', () => {
    it('sets error and remains unauthenticated', async () => {
      server.use(
        http.post('/api/auth/mfa/verify-login', () =>
          HttpResponse.json({ error: 'Invalid code' }, { status: 401 })
        )
      );

      await expect(
        useAuthStore.getState().completeMfaLogin('mfa-tok', '000000')
      ).rejects.toThrow();

      const state = useAuthStore.getState();
      expect(state.error).toBeTruthy();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-STORE-AUTH-012: register failure', () => {
    it('sets error on registration failure', async () => {
      server.use(
        http.post('/api/auth/register', () =>
          HttpResponse.json({ error: 'Email taken' }, { status: 400 })
        )
      );

      await expect(
        useAuthStore.getState().register('u', 'e@e.com', 'pw')
      ).rejects.toThrow();

      const state = useAuthStore.getState();
      expect(state.error).toBe('Email taken');
      expect(state.isAuthenticated).toBe(false);
    });
  });

  describe('FE-STORE-AUTH-013: loadUser silent mode', () => {
    it('does not toggle isLoading when silent: true', async () => {
      const user = buildUser();
      server.use(
        http.get('/api/auth/me', () => HttpResponse.json({ user }))
      );

      useAuthStore.setState({ isLoading: false });

      // isLoading should remain false immediately after calling (silent mode)
      const loadPromise = useAuthStore.getState().loadUser({ silent: true });
      expect(useAuthStore.getState().isLoading).toBe(false);

      await loadPromise;
      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-STORE-AUTH-014: loadUser network error (non-401)', () => {
    it('preserves auth state on network error', async () => {
      server.use(
        http.get('/api/auth/me', () =>
          HttpResponse.json({ error: 'Server error' }, { status: 500 })
        )
      );

      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      await useAuthStore.getState().loadUser();
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-STORE-AUTH-015: updateMapsKey', () => {
    it('updates user maps_api_key', async () => {
      server.use(
        http.put('/api/auth/me/maps-key', () =>
          HttpResponse.json({ success: true })
        )
      );

      useAuthStore.setState({ user: buildUser() });

      await useAuthStore.getState().updateMapsKey('my-key');
      expect(useAuthStore.getState().user?.maps_api_key).toBe('my-key');
    });
  });

  describe('FE-STORE-AUTH-016: updateMapsKey with null clears key', () => {
    it('sets maps_api_key to null', async () => {
      server.use(
        http.put('/api/auth/me/maps-key', () =>
          HttpResponse.json({ success: true })
        )
      );

      useAuthStore.setState({ user: buildUser({ maps_api_key: 'old-key' }) });

      await useAuthStore.getState().updateMapsKey(null);
      expect(useAuthStore.getState().user?.maps_api_key).toBeNull();
    });
  });

  describe('FE-STORE-AUTH-017: updateApiKeys', () => {
    it('updates user with returned data', async () => {
      const updatedUser = buildUser({ username: 'apiuser' });
      server.use(
        http.put('/api/auth/me/api-keys', () =>
          HttpResponse.json({ user: updatedUser })
        )
      );

      useAuthStore.setState({ user: buildUser() });

      await useAuthStore.getState().updateApiKeys({ some_api_key: 'val' });
      expect(useAuthStore.getState().user).toEqual(updatedUser);
    });
  });

  describe('FE-STORE-AUTH-018: updateProfile', () => {
    it('updates user profile', async () => {
      const updatedUser = buildUser({ username: 'updated' });
      server.use(
        http.put('/api/auth/me/settings', () =>
          HttpResponse.json({ user: updatedUser })
        )
      );

      useAuthStore.setState({ user: buildUser() });

      await useAuthStore.getState().updateProfile({ username: 'updated' });
      expect(useAuthStore.getState().user?.username).toBe('updated');
    });
  });

  describe('FE-STORE-AUTH-019: setDemoMode(true)', () => {
    it('sets demoMode and localStorage', () => {
      useAuthStore.getState().setDemoMode(true);
      expect(useAuthStore.getState().demoMode).toBe(true);
      expect(localStorage.getItem('demo_mode')).toBe('true');
    });
  });

  describe('FE-STORE-AUTH-020: setDemoMode(false)', () => {
    it('clears demoMode and localStorage', () => {
      localStorage.setItem('demo_mode', 'true');
      useAuthStore.getState().setDemoMode(false);
      expect(useAuthStore.getState().demoMode).toBe(false);
      expect(localStorage.getItem('demo_mode')).toBeNull();
    });
  });

  describe('FE-STORE-AUTH-021: demoLogin success', () => {
    it('authenticates and sets demoMode', async () => {
      const user = buildUser();
      server.use(
        http.post('/api/auth/demo-login', () =>
          HttpResponse.json({ user, token: 'tok' })
        )
      );

      await useAuthStore.getState().demoLogin();
      const state = useAuthStore.getState();

      expect(state.isAuthenticated).toBe(true);
      expect(state.demoMode).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(connect).toHaveBeenCalled();
    });
  });

  describe('FE-STORE-AUTH-022: simple setters', () => {
    it('updates devMode, hasMapsKey, serverTimezone, appRequireMfa, tripRemindersEnabled', () => {
      const { setDevMode, setHasMapsKey, setServerTimezone, setAppRequireMfa, setTripRemindersEnabled } =
        useAuthStore.getState();

      setDevMode(true);
      expect(useAuthStore.getState().devMode).toBe(true);

      setHasMapsKey(true);
      expect(useAuthStore.getState().hasMapsKey).toBe(true);

      setServerTimezone('Europe/Berlin');
      expect(useAuthStore.getState().serverTimezone).toBe('Europe/Berlin');

      setAppRequireMfa(true);
      expect(useAuthStore.getState().appRequireMfa).toBe(true);

      setTripRemindersEnabled(true);
      expect(useAuthStore.getState().tripRemindersEnabled).toBe(true);
    });
  });

  describe('FE-STORE-AUTH-023: deleteAvatar', () => {
    it('sets avatar_url to null', async () => {
      server.use(
        http.delete('/api/auth/avatar', () =>
          HttpResponse.json({ success: true })
        )
      );

      useAuthStore.setState({ user: buildUser({ avatar_url: '/uploads/avatar.png' }) });

      await useAuthStore.getState().deleteAvatar();
      expect(useAuthStore.getState().user?.avatar_url).toBeNull();
    });
  });

  describe('FE-STORE-AUTH-UPLOAD: uploadAvatar', () => {
    it('updates avatar_url from response', async () => {
      // FormData POST hangs on CI — mock at the API boundary instead of MSW.
      const uploadSpy = vi.spyOn(authApi, 'uploadAvatar').mockResolvedValueOnce({ avatar_url: '/uploads/avatar-new.png' });

      useAuthStore.setState({ user: buildUser() });

      const file = new File(['x'], 'avatar.png', { type: 'image/png' });
      const result = await useAuthStore.getState().uploadAvatar(file);

      expect(result.avatar_url).toBe('/uploads/avatar-new.png');
      expect(useAuthStore.getState().user?.avatar_url).toBe('/uploads/avatar-new.png');
      uploadSpy.mockRestore();
    });
  });

  describe('FE-STORE-AUTH-PERSIST-001: logout resets persisted snapshot', () => {
    it('snapshot has isAuthenticated:false after logout (PWA offline will redirect to login)', () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      useAuthStore.getState().logout();

      const snapshot = JSON.parse(localStorage.getItem('trek_auth_snapshot') ?? '{}');
      expect(snapshot?.state?.isAuthenticated).toBe(false);
      expect(snapshot?.state?.user).toBeNull();
    });
  });

  describe('FE-STORE-AUTH-PERSIST-002: 401 resets persisted snapshot', () => {
    it('snapshot has isAuthenticated:false after 401 (expired session clears offline access)', async () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      server.use(
        http.get('/api/auth/me', () =>
          HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
        )
      );

      await useAuthStore.getState().loadUser();

      const snapshot = JSON.parse(localStorage.getItem('trek_auth_snapshot') ?? '{}');
      expect(snapshot?.state?.isAuthenticated).toBe(false);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('FE-STORE-AUTH-PERSIST-003: network error preserves snapshot', () => {
    it('snapshot retains isAuthenticated:true on network error (offline PWA skips login screen)', async () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      server.use(
        http.get('/api/auth/me', () =>
          HttpResponse.json({ error: 'Server error' }, { status: 500 })
        )
      );

      await useAuthStore.getState().loadUser();

      // Persist middleware writes the state; isAuthenticated must stay true
      const snapshot = JSON.parse(localStorage.getItem('trek_auth_snapshot') ?? '{}');
      expect(snapshot?.state?.isAuthenticated).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });
  });
});
