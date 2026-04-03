import { describe, it, expect, vi } from 'vitest';

// Mock database — permissions module queries app_settings at runtime
vi.mock('../../../src/db/database', () => ({
  db: {
    prepare: () => ({
      all: () => [], // no custom permissions → fall back to defaults
      run: vi.fn(),
    }),
  },
}));

import { checkPermission, getPermissionLevel, PERMISSION_ACTIONS } from '../../../src/services/permissions';

describe('permissions', () => {
  describe('checkPermission — admin bypass', () => {
    it('admin always passes regardless of permission level', () => {
      for (const action of PERMISSION_ACTIONS) {
        expect(checkPermission(action.key, 'admin', 1, 1, false)).toBe(true);
        expect(checkPermission(action.key, 'admin', 99, 1, false)).toBe(true);
      }
    });
  });

  describe('checkPermission — everybody level', () => {
    it('trip_create (everybody) allows any authenticated user', () => {
      expect(checkPermission('trip_create', 'user', null, 42, false)).toBe(true);
    });
  });

  describe('checkPermission — trip_owner level', () => {
    const ownerId = 10;
    const memberId = 20;

    it('trip owner passes trip_owner check', () => {
      expect(checkPermission('trip_delete', 'user', ownerId, ownerId, false)).toBe(true);
    });

    it('member fails trip_owner check', () => {
      expect(checkPermission('trip_delete', 'user', ownerId, memberId, true)).toBe(false);
    });

    it('non-member non-owner fails trip_owner check', () => {
      expect(checkPermission('trip_delete', 'user', ownerId, memberId, false)).toBe(false);
    });
  });

  describe('checkPermission — trip_member level', () => {
    const ownerId = 10;
    const memberId = 20;
    const outsiderId = 30;

    it('trip owner passes trip_member check', () => {
      expect(checkPermission('day_edit', 'user', ownerId, ownerId, false)).toBe(true);
    });

    it('trip member passes trip_member check', () => {
      expect(checkPermission('day_edit', 'user', ownerId, memberId, true)).toBe(true);
    });

    it('outsider fails trip_member check', () => {
      expect(checkPermission('day_edit', 'user', ownerId, outsiderId, false)).toBe(false);
    });
  });

  describe('getPermissionLevel — defaults', () => {
    it('returns default level for known actions (no DB overrides)', () => {
      const defaults: Record<string, string> = {
        trip_create: 'everybody',
        trip_delete: 'trip_owner',
        day_edit: 'trip_member',
        budget_edit: 'trip_member',
      };
      for (const [key, expected] of Object.entries(defaults)) {
        expect(getPermissionLevel(key)).toBe(expected);
      }
    });

    it('returns trip_owner for unknown action key', () => {
      expect(getPermissionLevel('nonexistent_action')).toBe('trip_owner');
    });
  });
});
