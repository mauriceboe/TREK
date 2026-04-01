import { db } from '../db/database';

/**
 * Permission levels (hierarchical, higher includes lower):
 *   admin > trip_owner > trip_member > everybody
 *
 * "everybody" means any authenticated user with trip access.
 * For trip_create, "everybody" means any authenticated user (no trip context).
 */
export type PermissionLevel = 'admin' | 'trip_owner' | 'trip_member' | 'everybody';

export interface PermissionAction {
  key: string;
  defaultLevel: PermissionLevel;
  allowedLevels: PermissionLevel[];
}

// All configurable actions with their defaults matching upstream behavior
export const PERMISSION_ACTIONS: PermissionAction[] = [
  // Trip management
  { key: 'trip_create',        defaultLevel: 'everybody',   allowedLevels: ['admin', 'everybody'] },
  { key: 'trip_edit',          defaultLevel: 'trip_owner',   allowedLevels: ['trip_owner', 'trip_member'] },
  { key: 'trip_delete',        defaultLevel: 'trip_owner',   allowedLevels: ['admin', 'trip_owner'] },
  { key: 'trip_archive',       defaultLevel: 'trip_owner',   allowedLevels: ['trip_owner', 'trip_member'] },
  { key: 'trip_cover_upload',  defaultLevel: 'trip_owner',   allowedLevels: ['trip_owner', 'trip_member'] },

  // Member management
  { key: 'member_manage',      defaultLevel: 'trip_owner',   allowedLevels: ['admin', 'trip_owner', 'trip_member'] },

  // Files
  { key: 'file_upload',        defaultLevel: 'trip_member',  allowedLevels: ['admin', 'trip_owner', 'trip_member'] },
  { key: 'file_edit',          defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },
  { key: 'file_delete',        defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },

  // Places
  { key: 'place_edit',         defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },

  // Budget
  { key: 'budget_edit',        defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },

  // Packing
  { key: 'packing_edit',       defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },

  // Reservations
  { key: 'reservation_edit',   defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },

  // Day notes & schedule
  { key: 'day_edit',           defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },

  // Collaboration (notes, polls, messages)
  { key: 'collab_edit',        defaultLevel: 'trip_member',  allowedLevels: ['trip_owner', 'trip_member'] },

  // Share link management
  { key: 'share_manage',       defaultLevel: 'trip_owner',   allowedLevels: ['trip_owner', 'trip_member'] },
];

const ACTIONS_MAP = new Map(PERMISSION_ACTIONS.map(a => [a.key, a]));

// In-memory cache, invalidated on save
let cache: Map<string, PermissionLevel> | null = null;

function loadPermissions(): Map<string, PermissionLevel> {
  if (cache) return cache;
  cache = new Map<string, PermissionLevel>();
  try {
    const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'perm_%'").all() as { key: string; value: string }[];
    for (const row of rows) {
      const actionKey = row.key.replace('perm_', '');
      if (ACTIONS_MAP.has(actionKey)) {
        cache.set(actionKey, row.value as PermissionLevel);
      }
    }
  } catch { /* table might not exist yet during init */ }
  return cache;
}

export function invalidatePermissionsCache(): void {
  cache = null;
}

export function getPermissionLevel(actionKey: string): PermissionLevel {
  const perms = loadPermissions();
  const stored = perms.get(actionKey);
  if (stored) return stored;
  const action = ACTIONS_MAP.get(actionKey);
  return action?.defaultLevel ?? 'trip_owner';
}

export function getAllPermissions(): Record<string, PermissionLevel> {
  const perms = loadPermissions();
  const result: Record<string, PermissionLevel> = {};
  for (const action of PERMISSION_ACTIONS) {
    result[action.key] = perms.get(action.key) ?? action.defaultLevel;
  }
  return result;
}

export function savePermissions(settings: Record<string, string>): { skipped: string[] } {
  const skipped: string[] = [];
  const upsert = db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
  const txn = db.transaction(() => {
    for (const [actionKey, level] of Object.entries(settings)) {
      const action = ACTIONS_MAP.get(actionKey);
      if (!action || !action.allowedLevels.includes(level as PermissionLevel)) {
        skipped.push(actionKey);
        continue;
      }
      upsert.run(`perm_${actionKey}`, level);
    }
  });
  txn();
  invalidatePermissionsCache();
  return { skipped };
}

/**
 * Check if a user passes the permission check for a given action.
 *
 * @param actionKey - The permission action key
 * @param userRole - 'admin' | 'user'
 * @param tripUserId - The trip owner's user ID (null for non-trip actions like trip_create)
 * @param userId - The requesting user's ID
 * @param isMember - Whether the user is a trip member (not owner)
 */
export function checkPermission(
  actionKey: string,
  userRole: string,
  tripUserId: number | null,
  userId: number,
  isMember: boolean
): boolean {
  // Admins always pass
  if (userRole === 'admin') return true;

  const required = getPermissionLevel(actionKey);

  switch (required) {
    case 'admin':
      return false; // already checked above
    case 'trip_owner':
      return tripUserId !== null && tripUserId === userId;
    case 'trip_member':
      return (tripUserId !== null && tripUserId === userId) || isMember;
    case 'everybody':
      return true;
    default:
      return false;
  }
}
