import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { canAccessTrip } from '../../db/database';
import { isDemoUser } from '../../services/authService';
import {
  createItem as createPackingItem, updateItem as updatePackingItem,
  toggleCheck as togglePackingCheck,
  deleteItem as deletePackingItem,
  reorderItems as reorderPackingItems,
  listBags, createBag, updateBag, deleteBag, setBagMembers,
  getCategoryAssignees as getPackingCategoryAssignees,
  updateCategoryAssignees as updatePackingCategoryAssignees,
  listCategories as listPackingCategories,
  createCategory as createPackingCategory,
  updateCategory as updatePackingCategory,
  deleteCategory as deletePackingCategory,
  applyTemplate, saveAsTemplate, bulkImport,
} from '../../services/packingService';
import { db } from '../../db/database';

// Adapts MCP's free-text `category` argument to the FK storage model.
function resolvePackingCategoryId(tripId: number, name: string | undefined): number | null {
  if (!name?.trim()) return null;
  const trimmed = name.trim();
  const existing = db.prepare(
    `SELECT id FROM packing_categories WHERE trip_id = ? AND name = ? AND type = 'shared'`
  ).get(tripId, trimmed) as { id: number } | undefined;
  if (existing) return existing.id;
  const maxOrder = db.prepare(
    `SELECT MAX(sort_order) as max FROM packing_categories WHERE trip_id = ?`
  ).get(tripId) as { max: number | null };
  const result = db.prepare(
    `INSERT INTO packing_categories (trip_id, name, type, owner_user_id, sort_order) VALUES (?, ?, 'shared', NULL, ?)`
  ).run(tripId, trimmed, (maxOrder.max ?? -1) + 1);
  return result.lastInsertRowid as number;
}
import {
  safeBroadcast, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE, TOOL_ANNOTATIONS_DELETE,
  TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, noAccess, ok,
} from './_shared';
import { canRead, canWrite } from '../scopes';
import { isAddonEnabled } from '../../services/adminService';
import { ADDON_IDS } from '../../addons';

export function registerPackingTools(server: McpServer, userId: number, scopes: string[] | null): void {
  const R = canRead(scopes, 'packing');
  const W = canWrite(scopes, 'packing');

  if (!isAddonEnabled(ADDON_IDS.PACKING)) return;

  // --- PACKING ---

  if (W) server.registerTool(
    'create_packing_item',
    {
      description: 'Add an item to the packing checklist for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(200),
        category: z.string().max(100).optional().describe('Packing category (e.g. Clothes, Electronics)'),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const category_id = resolvePackingCategoryId(tripId, category || 'General');
      const item = createPackingItem(tripId, { name, category_id }, userId);
      safeBroadcast(tripId, 'packing:created', { item });
      return ok({ item });
    }
  );

  if (W) server.registerTool(
    'toggle_packing_item',
    {
      description: 'Check or uncheck a packing item.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        checked: z.boolean(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, checked }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const item = togglePackingCheck(tripId, itemId, userId, checked);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      // Per-user check state on personal/private categories shouldn't broadcast.
      if (!(item as any).category_type || (item as any).category_type === 'shared') {
        safeBroadcast(tripId, 'packing:updated', { item });
      }
      return ok({ item });
    }
  );

  if (W) server.registerTool(
    'delete_packing_item',
    {
      description: 'Remove an item from the packing checklist.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, itemId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const deleted = deletePackingItem(tripId, itemId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:deleted', { itemId });
      return ok({ success: true });
    }
  );

  // --- PACKING (update) ---

  if (W) server.registerTool(
    'update_packing_item',
    {
      description: 'Rename a packing item or change its category.',
      inputSchema: {
        tripId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        category: z.string().max(100).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, itemId, name, category }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bodyKeys: string[] = [];
      if (name !== undefined) bodyKeys.push('name');
      let category_id: number | null | undefined;
      if (category !== undefined) {
        category_id = resolvePackingCategoryId(tripId, category);
        bodyKeys.push('category_id');
      }
      const item = updatePackingItem(tripId, itemId, { name, category_id }, bodyKeys, userId);
      if (!item) return { content: [{ type: 'text' as const, text: 'Packing item not found.' }], isError: true };
      if (!(item as any).category_type || (item as any).category_type === 'shared') {
        safeBroadcast(tripId, 'packing:updated', { item });
      }
      return ok({ item });
    }
  );

  // --- PACKING ADVANCED ---

  if (W) server.registerTool(
    'reorder_packing_items',
    {
      description: 'Set the display order of packing items within a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        orderedIds: z.array(z.number().int().positive()).describe('Packing item IDs in desired order'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, orderedIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      reorderPackingItems(tripId, orderedIds);
      safeBroadcast(tripId, 'packing:reordered', { orderedIds });
      return ok({ success: true });
    }
  );

  if (R) server.registerTool(
    'list_packing_bags',
    {
      description: 'List all packing bags for a trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bags = listBags(tripId);
      return ok({ bags });
    }
  );

  if (W) server.registerTool(
    'create_packing_bag',
    {
      description: 'Create a new packing bag (e.g. "Carry-on", "Checked bag").',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(100),
        color: z.string().optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, color }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const bag = createBag(tripId, { name, color });
      safeBroadcast(tripId, 'packing:bag-created', { bag });
      return ok({ bag });
    }
  );

  if (W) server.registerTool(
    'update_packing_bag',
    {
      description: 'Rename or recolor a packing bag.',
      inputSchema: {
        tripId: z.number().int().positive(),
        bagId: z.number().int().positive(),
        name: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, bagId, name, color }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const fields: Record<string, unknown> = {};
      const bodyKeys: string[] = [];
      if (name !== undefined) { fields.name = name; bodyKeys.push('name'); }
      if (color !== undefined) { fields.color = color; bodyKeys.push('color'); }
      const bag = updateBag(tripId, bagId, fields, bodyKeys);
      safeBroadcast(tripId, 'packing:bag-updated', { bag });
      return ok({ bag });
    }
  );

  if (W) server.registerTool(
    'delete_packing_bag',
    {
      description: 'Delete a packing bag (items in the bag are unassigned, not deleted).',
      inputSchema: {
        tripId: z.number().int().positive(),
        bagId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, bagId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      deleteBag(tripId, bagId);
      safeBroadcast(tripId, 'packing:bag-deleted', { id: bagId });
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'set_bag_members',
    {
      description: 'Assign trip members to a packing bag (determines who packs what bag).',
      inputSchema: {
        tripId: z.number().int().positive(),
        bagId: z.number().int().positive(),
        userIds: z.array(z.number().int().positive()),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, bagId, userIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      setBagMembers(tripId, bagId, userIds);
      safeBroadcast(tripId, 'packing:bag-members-updated', { bagId, userIds });
      return ok({ success: true });
    }
  );

  if (R) server.registerTool(
    'get_packing_category_assignees',
    {
      description: 'Get which trip members are assigned to each packing category.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const assignees = getPackingCategoryAssignees(tripId);
      return ok({ assignees });
    }
  );

  if (W) server.registerTool(
    'set_packing_category_assignees',
    {
      description: 'Assign trip members to a shared packing category. Resolves the category by name (case-sensitive) within the trip.',
      inputSchema: {
        tripId: z.number().int().positive(),
        categoryName: z.string().min(1).max(100),
        userIds: z.array(z.number().int().positive()),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, categoryName, userIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const cat = db.prepare(
        `SELECT id FROM packing_categories WHERE trip_id = ? AND name = ? AND type = 'shared'`
      ).get(tripId, categoryName) as { id: number } | undefined;
      if (!cat) return { content: [{ type: 'text' as const, text: 'Shared packing category not found.' }], isError: true };
      const result = updatePackingCategoryAssignees(tripId, cat.id, userIds);
      if (result === null) return { content: [{ type: 'text' as const, text: 'Assignees only apply to shared categories.' }], isError: true };
      safeBroadcast(tripId, 'packing:assignees', { categoryId: cat.id, userIds });
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'apply_packing_template',
    {
      description: 'Apply a packing template to a trip (adds items from the template).',
      inputSchema: {
        tripId: z.number().int().positive(),
        templateId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, templateId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const applied = applyTemplate(tripId, templateId);
      if (applied === null) return { content: [{ type: 'text' as const, text: 'Template not found.' }], isError: true };
      safeBroadcast(tripId, 'packing:template-applied', { templateId });
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'save_packing_template',
    {
      description: 'Save the current packing list as a reusable template.',
      inputSchema: {
        tripId: z.number().int().positive(),
        templateName: z.string().min(1).max(100),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, templateName }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      saveAsTemplate(tripId, userId, templateName);
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'bulk_import_packing',
    {
      description: 'Import multiple packing items at once from a list.',
      inputSchema: {
        tripId: z.number().int().positive(),
        items: z.array(z.object({
          name: z.string().min(1).max(200),
          category: z.string().optional(),
          quantity: z.number().int().positive().optional(),
        })).min(1),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, items }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      bulkImport(tripId, items);
      safeBroadcast(tripId, 'packing:updated', {});
      return ok({ success: true, count: items.length });
    }
  );

  // --- PACKING CATEGORIES (shared / personal / private) ---

  if (R) server.registerTool(
    'list_packing_categories',
    {
      description: 'List packing categories for a trip. Other users\' private categories are hidden.',
      inputSchema: {
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ tripId }) => {
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const categories = listPackingCategories(tripId, userId);
      return ok({ categories });
    }
  );

  if (W) server.registerTool(
    'create_packing_category',
    {
      description: 'Create a packing category. shared = visible to everyone with shared checks; personal = visible to everyone but each person tracks their own checks; private = visible only to you.',
      inputSchema: {
        tripId: z.number().int().positive(),
        name: z.string().min(1).max(100),
        type: z.enum(['shared', 'personal', 'private']),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ tripId, name, type }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const result = createPackingCategory(tripId, userId, { name, type });
      if (result && (result as any).error === 'duplicate') {
        return { content: [{ type: 'text' as const, text: 'A category with that name and type already exists.' }], isError: true };
      }
      if (type === 'shared') safeBroadcast(tripId, 'packing:category-created', { category: result });
      return ok({ category: result });
    }
  );

  if (W) server.registerTool(
    'update_packing_category',
    {
      description: 'Rename a packing category or change its visibility type. Converting shared → personal moves the current global checked state into your own per-user checks; the reverse discards per-user state.',
      inputSchema: {
        tripId: z.number().int().positive(),
        categoryId: z.number().int().positive(),
        name: z.string().min(1).max(100).optional(),
        type: z.enum(['shared', 'personal', 'private']).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ tripId, categoryId, name, type }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const updated = updatePackingCategory(tripId, categoryId, userId, { name, type });
      if (!updated) return { content: [{ type: 'text' as const, text: 'Packing category not found or not owned by you.' }], isError: true };
      if ((updated as any).type === 'shared') safeBroadcast(tripId, 'packing:category-updated', { category: updated });
      return ok({ category: updated });
    }
  );

  if (W) server.registerTool(
    'delete_packing_category',
    {
      description: 'Delete a packing category and all of its items. Personal/private categories can only be deleted by their owner.',
      inputSchema: {
        tripId: z.number().int().positive(),
        categoryId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ tripId, categoryId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessTrip(tripId, userId)) return noAccess();
      const cat = db.prepare('SELECT type FROM packing_categories WHERE id = ? AND trip_id = ?').get(categoryId, tripId) as { type: string } | undefined;
      const deleted = deletePackingCategory(tripId, categoryId, userId);
      if (!deleted) return { content: [{ type: 'text' as const, text: 'Packing category not found or not owned by you.' }], isError: true };
      if (!cat || cat.type === 'shared') safeBroadcast(tripId, 'packing:category-deleted', { catId: Number(categoryId) });
      return ok({ success: true });
    }
  );
}
