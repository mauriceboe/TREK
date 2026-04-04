import { db } from '../db/database';

export function listTags(userId: number) {
  return db.prepare('SELECT * FROM tags WHERE user_id = ? ORDER BY name ASC').all(userId);
}

export function createTag(userId: number, name: string, color?: string) {
  const result = db.prepare(
    'INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)'
  ).run(userId, name, color || '#10b981');
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid);
}

export function getTagByIdAndUser(tagId: number | string, userId: number) {
  return db.prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?').get(tagId, userId);
}

export function updateTag(tagId: number | string, name?: string, color?: string) {
  db.prepare('UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?')
    .run(name || null, color || null, tagId);
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId);
}

export function deleteTag(tagId: number | string) {
  db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
}
