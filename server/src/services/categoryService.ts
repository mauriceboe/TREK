import { db } from '../db/database';

export function listCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
}

export function createCategory(userId: number, name: string, color?: string, icon?: string) {
  const result = db.prepare(
    'INSERT INTO categories (name, color, icon, user_id) VALUES (?, ?, ?, ?)'
  ).run(name, color || '#6366f1', icon || '\uD83D\uDCCD', userId);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
}

export function getCategoryById(categoryId: number | string) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
}

export function updateCategory(categoryId: number | string, name?: string, color?: string, icon?: string) {
  db.prepare(`
    UPDATE categories SET
      name = COALESCE(?, name),
      color = COALESCE(?, color),
      icon = COALESCE(?, icon)
    WHERE id = ?
  `).run(name || null, color || null, icon || null, categoryId);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
}

export function deleteCategory(categoryId: number | string) {
  db.prepare('DELETE FROM categories WHERE id = ?').run(categoryId);
}
