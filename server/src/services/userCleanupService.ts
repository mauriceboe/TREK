import { db } from '../db/database';

function cleanupUserReferences(userId: number): void {
  db.prepare('UPDATE trip_members SET invited_by = NULL WHERE invited_by = ?').run(userId);
  db.prepare('UPDATE budget_items SET paid_by_user_id = NULL WHERE paid_by_user_id = ?').run(userId);
  db.prepare('DELETE FROM share_tokens WHERE created_by = ?').run(userId);
  db.prepare('DELETE FROM journey_share_tokens WHERE created_by = ?').run(userId);
  // Owned journeys cascade-delete their entries/contributors/share_tokens/photos via journey_id FKs
  db.prepare('DELETE FROM journeys WHERE user_id = ?').run(userId);
  // Entries authored on other users' journeys (not covered by the cascade above)
  db.prepare('DELETE FROM journey_entries WHERE author_id = ?').run(userId);
  db.prepare('DELETE FROM journey_contributors WHERE user_id = ?').run(userId);
}

export function deleteUserCompletely(userId: number): void {
  const tx = db.transaction((id: number) => {
    cleanupUserReferences(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  tx(userId);
}
