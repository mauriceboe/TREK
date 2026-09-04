import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../helpers/msw/server';
import { useAuthStore } from '../../../src/store/authStore';
import { useSystemNoticeStore } from '../../../src/store/systemNoticeStore';
import { authApi } from '../../../src/api/client';
import { resetAllStores } from '../../helpers/store';
import { buildUser } from '../../helpers/factories';
import { isAuthed, setAuthed } from '../../../src/sync/authGate';

// The websocket module is already mocked globally in tests/setup.ts
import { connect, disconnect } from '../../../src/api/websocket';

// authStore is the only consumer of these two, so stubbing the module keeps the
// real 30s interval and window listeners out of the suite while still letting us
// assert the register/unregister ordering around a logout.
const syncTriggers = vi.hoisted(() => ({
  registerSyncTriggers: vi.fn(),
  unregisterSyncTriggers: vi.fn(),
}));
vi.mock('../../../src/sync/syncTriggers', () => syncTriggers);

// The user-scoped offline DB is real (fake-indexeddb); only the reopen step is
// made failable so the "auth still succeeds when the DB won't open" path runs.
const dbControl = vi.hoisted(() => ({ reopenFails: false, reopenedFor: null as number | string | null }));
vi.mock('../../../src/db/offlineDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/offlineDb')>();
  return {
    ...actual,
    reopenForUser: async (userId: number | string) => {
      dbControl.reopenedFor = userId;
      if (dbControl.reopenFails) throw new Error('offline db locked');
      return actual.reopenForUser(userId);
    },
  };
});

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  dbControl.reopenFails = false;
  dbControl.reopenedFor = null;
});

afterEach(() => {
  vi.restoreAllMocks();
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
    it('calls disconnect() and clears user state', async () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      await useAuthStore.getState().logout();
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

  describe('FE-STORE-AUTH-021: a session kept without a reachable server is still live (#2228)', () => {
    afterEach(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    });

    it('marks a session that launched offline as authenticated for the sync layer', async () => {
      // onAuthSuccess is the only caller of setAuthed(true), and the mutation
      // queue's flush, syncAll and prepareForOffline are all gated on it. The
      // offline branch used to keep the session but skip it, so a PWA that
      // launched without network could never sync again for the rest of its
      // life: the settings buttons spun and returned having done nothing.
      setAuthed(false);
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      server.use(http.get('/api/auth/me', () => HttpResponse.error()));
      useAuthStore.setState({ user: buildUser({ id: 42 }), isAuthenticated: true });

      await useAuthStore.getState().loadUser();

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(isAuthed()).toBe(true);
      // …and it points the offline DB at this user's scoped database, so reads
      // come from the right one rather than the anonymous fallback.
      expect(dbControl.reopenedFor).toBe(42);
    });

    it('does the same when the server is erroring rather than absent', async () => {
      setAuthed(false);
      server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
      useAuthStore.setState({ user: buildUser({ id: 7 }), isAuthenticated: true });

      await useAuthStore.getState().loadUser();

      expect(useAuthStore.getState().authCheckFailed).toBe(true);
      expect(isAuthed()).toBe(true);
    });

    it('leaves the gate closed when the session was rejected', async () => {
      setAuthed(false);
      server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'nope' }, { status: 401 })));
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      await useAuthStore.getState().loadUser();

      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(isAuthed()).toBe(false);
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
    it('snapshot has isAuthenticated:false after logout (PWA offline will redirect to login)', async () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      await useAuthStore.getState().logout();

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

  describe('FE-STORE-AUTH-024: system notices are skipped for a forced password change', () => {
    const stubNoticeFetch = () => {
      const fetch = vi.fn(async () => {});
      useSystemNoticeStore.setState({ fetch });
      return fetch;
    };

    it('login skips the notice fetch when must_change_password is set', async () => {
      const user = buildUser({ must_change_password: true });
      server.use(http.post('/api/auth/login', () => HttpResponse.json({ user, token: 'tok' })));
      const noticeFetch = stubNoticeFetch();

      await useAuthStore.getState().login(user.email, 'password');

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(noticeFetch).not.toHaveBeenCalled();
    });

    it('completeMfaLogin skips the notice fetch when must_change_password is set', async () => {
      const user = buildUser({ must_change_password: true });
      server.use(http.post('/api/auth/mfa/verify-login', () => HttpResponse.json({ user, token: 'tok' })));
      const noticeFetch = stubNoticeFetch();

      await useAuthStore.getState().completeMfaLogin('mfa-tok', '123 456');

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(noticeFetch).not.toHaveBeenCalled();
    });
  });

  describe('FE-STORE-AUTH-025: offline DB cannot be opened', () => {
    it('login still authenticates and logs the failure', async () => {
      const user = buildUser();
      server.use(http.post('/api/auth/login', () => HttpResponse.json({ user, token: 'tok' })));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      dbControl.reopenFails = true;

      await useAuthStore.getState().login(user.email, 'password');

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(consoleError).toHaveBeenCalledWith(
        '[auth] failed to open user-scoped offline DB',
        expect.any(Error),
      );
    });
  });

  describe('FE-STORE-AUTH-026: logout hardening', () => {
    it('clears the service-worker caches and finishes even when every teardown step fails', async () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true, authCheckFailed: true });

      const cacheDelete = vi.fn(() => Promise.reject(new Error('cache api unavailable')));
      Object.defineProperty(window, 'caches', {
        value: { delete: cacheDelete },
        configurable: true,
        writable: true,
      });
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

      await useAuthStore.getState().logout();

      expect(cacheDelete).toHaveBeenCalledWith('api-data');
      expect(cacheDelete).toHaveBeenCalledWith('user-uploads');
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.authCheckFailed).toBe(false);

      delete (window as unknown as { caches?: unknown }).caches;
    });
  });

  describe('FE-STORE-AUTH-027: loadUser while genuinely offline', () => {
    it('keeps the persisted session and does not raise authCheckFailed', async () => {
      const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });
      // A transport-level failure carries no `response`, so status stays undefined.
      vi.spyOn(authApi, 'me').mockRejectedValueOnce(new Error('Network Error'));

      await useAuthStore.getState().loadUser();

      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.authCheckFailed).toBe(false);

      if (onLine) Object.defineProperty(Navigator.prototype, 'onLine', onLine);
      delete (navigator as unknown as { onLine?: boolean }).onLine;
    });

    it('flags authCheckFailed when the server is unreachable but we are online', async () => {
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });
      vi.spyOn(authApi, 'me').mockRejectedValueOnce(new Error('Network Error'));

      await useAuthStore.getState().loadUser();

      expect(useAuthStore.getState().authCheckFailed).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });
  });

  describe('FE-STORE-AUTH-028: stale loadUser rejection', () => {
    it('does not clear the session a newer login established', async () => {
      let rejectStale!: (e: Error) => void;
      const stale = new Promise((_, reject) => { rejectStale = reject; });
      vi.spyOn(authApi, 'me').mockImplementationOnce(() => stale);

      const staleLoad = useAuthStore.getState().loadUser();

      const freshUser = buildUser({ username: 'freshlogin' });
      server.use(http.post('/api/auth/login', () => HttpResponse.json({ user: freshUser, token: 'tok' })));
      await useAuthStore.getState().login(freshUser.email, 'password');

      rejectStale(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));
      await staleLoad;

      const state = useAuthStore.getState();
      expect(state.user?.username).toBe('freshlogin');
      expect(state.isAuthenticated).toBe(true);
    });
  });

  describe('FE-STORE-AUTH-029: API-key and profile error paths', () => {
    it('updateMapsKey surfaces the server message', async () => {
      server.use(http.put('/api/auth/me/maps-key', () =>
        HttpResponse.json({ error: 'Invalid key' }, { status: 400 })));

      await expect(useAuthStore.getState().updateMapsKey('bad')).rejects.toThrow('Invalid key');
    });

    it('updateMapsKey without a signed-in user leaves user null', async () => {
      server.use(http.put('/api/auth/me/maps-key', () => HttpResponse.json({ success: true })));
      useAuthStore.setState({ user: null, hasMapsKey: false });

      await useAuthStore.getState().updateMapsKey('a-key');

      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().hasMapsKey).toBe(true);
    });

    it('updateApiKeys mirrors a maps_api_key into hasMapsKey', async () => {
      const updatedUser = buildUser();
      server.use(http.put('/api/auth/me/api-keys', () => HttpResponse.json({ user: updatedUser })));

      await useAuthStore.getState().updateApiKeys({ maps_api_key: 'k' });
      expect(useAuthStore.getState().hasMapsKey).toBe(true);

      await useAuthStore.getState().updateApiKeys({ maps_api_key: null });
      expect(useAuthStore.getState().hasMapsKey).toBe(false);
    });

    it('updateApiKeys surfaces the server message', async () => {
      server.use(http.put('/api/auth/me/api-keys', () =>
        HttpResponse.json({ error: 'Rejected' }, { status: 400 })));

      await expect(useAuthStore.getState().updateApiKeys({ some_key: 'v' })).rejects.toThrow('Rejected');
    });

    it('updateProfile surfaces the server message', async () => {
      server.use(http.put('/api/auth/me/settings', () =>
        HttpResponse.json({ error: 'Username taken' }, { status: 409 })));

      await expect(useAuthStore.getState().updateProfile({ username: 'x' })).rejects.toThrow('Username taken');
    });
  });

  describe('FE-STORE-AUTH-030: avatar actions without a signed-in user', () => {
    it('uploadAvatar returns the URL but keeps user null', async () => {
      vi.spyOn(authApi, 'uploadAvatar').mockResolvedValueOnce({ avatar_url: '/uploads/a.png' });
      useAuthStore.setState({ user: null });

      const result = await useAuthStore.getState().uploadAvatar(new File(['x'], 'a.png'));

      expect(result.avatar_url).toBe('/uploads/a.png');
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('deleteAvatar keeps user null', async () => {
      server.use(http.delete('/api/auth/avatar', () => HttpResponse.json({ success: true })));
      useAuthStore.setState({ user: null });

      await useAuthStore.getState().deleteAvatar();

      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('FE-STORE-AUTH-031: demoLogin failure', () => {
    it('sets error and stays unauthenticated', async () => {
      server.use(http.post('/api/auth/demo-login', () =>
        HttpResponse.json({ error: 'Demo disabled' }, { status: 403 })));

      await expect(useAuthStore.getState().demoLogin()).rejects.toThrow('Demo disabled');

      const state = useAuthStore.getState();
      expect(state.error).toBe('Demo disabled');
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('FE-STORE-AUTH-032: remaining app-config setters', () => {
    it('updates isPrerelease, appVersion and the three places toggles', () => {
      const {
        setIsPrerelease, setAppVersion,
        setPlacesPhotosEnabled, setPlacesAutocompleteEnabled, setPlacesDetailsEnabled,
      } = useAuthStore.getState();

      setIsPrerelease(true);
      setAppVersion('3.4.0');
      setPlacesPhotosEnabled(false);
      setPlacesAutocompleteEnabled(false);
      setPlacesDetailsEnabled(false);

      const state = useAuthStore.getState();
      expect(state.isPrerelease).toBe(true);
      expect(state.appVersion).toBe('3.4.0');
      expect(state.placesPhotosEnabled).toBe(false);
      expect(state.placesAutocompleteEnabled).toBe(false);
      expect(state.placesDetailsEnabled).toBe(false);
    });
  });

  describe('FE-STORE-AUTH-033: logging in again after a logout', () => {
    it('re-registers the sync triggers logout tore down', async () => {
      const user = buildUser();
      server.use(
        http.post('/api/auth/login', () => HttpResponse.json({ user, token: 'tok' }))
      );

      useAuthStore.setState({ user, isAuthenticated: true });
      await useAuthStore.getState().logout();
      expect(syncTriggers.unregisterSyncTriggers).toHaveBeenCalled();

      syncTriggers.registerSyncTriggers.mockClear();
      await useAuthStore.getState().login(user.email, 'password');

      expect(syncTriggers.registerSyncTriggers).toHaveBeenCalled();
    });
  });

  // The mirror of the account's server-side language is a per-device copy like the
  // appearance snapshot and the startup destination, and gets dropped with them.
  // 'app_language' is not a mirror but this device's own choice, so it stays.
  describe('FE-STORE-AUTH-034: logout drops the language mirror', () => {
    it('clears the account language but keeps an explicit in-app choice', async () => {
      localStorage.setItem('app_language_server', 'ja');
      localStorage.setItem('app_language', 'de');
      useAuthStore.setState({ user: buildUser(), isAuthenticated: true });

      await useAuthStore.getState().logout();

      expect(localStorage.getItem('app_language_server')).toBeNull();
      expect(localStorage.getItem('app_language')).toBe('de');
    });
  });
});
