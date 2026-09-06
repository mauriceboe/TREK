import { z } from 'zod';

/**
 * Budget API contract — single source of truth for the /api/trips/:tripId/budget
 * endpoints (expense items, per-member splits, paid toggles, settlement).
 *
 * Trip-scoped: every endpoint verifies trip access (404 "Trip not found") and
 * mutations check the 'budget_edit' permission (403 "No permission"). The legacy
 * route (server/src/routes/budget.ts) wraps services/budgetService.ts; rows are
 * DB-shaped and kept open. Mutations broadcast over WebSocket with the forwarded
 * X-Socket-Id. Updating a linked item's total_price also syncs the price into the
 * linked reservation's metadata (and broadcasts reservation:updated).
 */

/**
 * Budget item member as embedded on a budget item
 * (server/src/services/budgetService.ts -> loadItemMembers). `paid` is the raw
 * SQLite INTEGER (0/1); `avatar_url` is the resolved avatar (avatarUrl()).
 */
export const budgetItemMemberSchema = z.object({
  user_id: z.number(),
  paid: z.number(),
  username: z.string(),
  avatar_url: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  budget_item_id: z.number().optional(),
  amount: z.number().nullable().optional(),
});
export type BudgetItemMember = z.infer<typeof budgetItemMemberSchema>;

/**
 * The fixed "Costs" expense categories. Unlike the old budget, users cannot
 * create their own categories — every expense maps to one of these keys. The
 * label/icon/colour per key live in the client; the server only stores the key.
 * Pre-rework rows used free-text categories; those are shown as `other`.
 */
export const COST_CATEGORIES = [
  'accommodation',
  'food',
  'groceries',
  'transport',
  'flights',
  'activities',
  'sightseeing',
  'shopping',
  'fees',
  'health',
  'tips',
  'fuel',
  'parking',
  'other',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/**
 * Maps a reservation `type` (flight, train, hotel, …) to one of the fixed Costs
 * categories, so an expense created from a booking lands in the right bucket
 * instead of a free-text/localized label. Unknown types fall back to `other`.
 */
const RESERVATION_TYPE_TO_COST_CATEGORY: Record<string, CostCategory> = {
  flight: 'flights',
  plane: 'flights',
  train: 'transport',
  bus: 'transport',
  car: 'transport',
  'car-rental': 'transport',
  ferry: 'transport',
  boat: 'transport',
  taxi: 'transport',
  transfer: 'transport',
  transport: 'transport',
  hotel: 'accommodation',
  accommodation: 'accommodation',
  lodging: 'accommodation',
  parking: 'parking',
  restaurant: 'food',
  activity: 'activities',
};

export function typeToCostCategory(type: string | null | undefined): CostCategory {
  if (!type) return 'other';
  return RESERVATION_TYPE_TO_COST_CATEGORY[type.trim().toLowerCase()] || 'other';
}

/**
 * One payer of an expense — a row of budget_item_payers. `amount` is in the
 * expense's own currency (budget_items.currency). Several payers can split who
 * actually paid one bill. Username/avatar are joined for display.
 */
export const budgetItemPayerSchema = z.object({
  user_id: z.number(),
  amount: z.number(),
  username: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  budget_item_id: z.number().optional(),
});
export type BudgetItemPayer = z.infer<typeof budgetItemPayerSchema>;

export const budgetItemReceiptSchema = z.object({
  id: z.number(),
  filename: z.string(),
  original_name: z.string(),
  file_size: z.number().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  url: z.string(),
});
export type BudgetItemReceipt = z.infer<typeof budgetItemReceiptSchema>;

/**
 * Budget item entity as returned by the budget list/create/update endpoints
 * (server/src/services/budgetService.ts). Columns of the `budget_items` table
 * plus the embedded `members` (equal-split participants), `payers` and `receipts` arrays.
 * total_price is the sum of payer amounts in `currency`; `exchange_rate` converts
 * that to the trip base currency (NULL currency + rate 1 = base currency).
 */
export const budgetItemSchema = z.object({
  id: z.number(),
  trip_id: z.number(),
  category: z.string(),
  name: z.string(),
  total_price: z.number(),
  currency: z.string().nullable().optional(),
  exchange_rate: z.number().optional(),
  persons: z.number().nullable().optional(),
  days: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  /** Itemized receipt behind a per-item split, as JSON. Its own column since #1658. */
  ticket_json: z.string().nullable().optional(),
  reservation_id: z.number().nullable().optional(),
  /** Set when the expense was created from a place (#1298) — the same link
   *  reservation_id is for a booking, on the other side of the planner. */
  place_id: z.number().nullable().optional(),
  paid_by_user_id: z.number().nullable().optional(),
  expense_date: z.string().nullable().optional(),
  sort_order: z.number().optional(),
  created_at: z.string().optional(),
  members: z.array(budgetItemMemberSchema).optional(),
  payers: z.array(budgetItemPayerSchema).optional(),
  receipts: z.array(budgetItemReceiptSchema).optional(),
});
export type BudgetItem = z.infer<typeof budgetItemSchema>;

const payerInputSchema = z.object({
  user_id: z.number(),
  amount: z.number(),
});

const memberInputSchema = z.object({
  user_id: z.number(),
  amount: z.number().nullable().optional(),
});

export const budgetCreateItemRequestSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  total_price: z.number().optional(),
  currency: z.string().nullable().optional(),
  exchange_rate: z.number().optional(),
  // Multi-payer: who paid how much (in the expense currency). When omitted, the
  // server falls back to total_price with no explicit payer.
  payers: z.array(payerInputSchema).optional(),
  // Equal-split participants. When omitted, the item has no split (planning-only).
  member_ids: z.array(z.number()).optional(),
  members: z.array(memberInputSchema).optional(),
  persons: z.number().nullable().optional(),
  days: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  ticket_json: z.string().nullable().optional(),
  expense_date: z.string().nullable().optional(),
  // Link this expense to a reservation (e.g. created from a booking's
  // "add expense" flow). The server stores it on budget_items.reservation_id.
  reservation_id: z.number().optional(),
  // The same for a place: the place form's "add expense" flow saves the place
  // first, then creates the expense against it (#1298).
  place_id: z.number().optional(),
  // Receipt files to link to this expense
  receipt_file_ids: z.array(z.number()).optional(),
});
export type BudgetCreateItemRequest = z.infer<typeof budgetCreateItemRequestSchema>;

/** Update accepts the same fields plus total_price changes; all optional. */
export const budgetUpdateItemRequestSchema = z.object({
  name: z.string().optional(),
  category: z.string().optional(),
  total_price: z.number().optional(),
  currency: z.string().nullable().optional(),
  exchange_rate: z.number().optional(),
  payers: z.array(payerInputSchema).optional(),
  member_ids: z.array(z.number()).optional(),
  members: z.array(memberInputSchema).optional(),
  persons: z.number().nullable().optional(),
  days: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  ticket_json: z.string().nullable().optional(),
  expense_date: z.string().nullable().optional(),
  receipt_file_ids: z.array(z.number()).optional(),
});
export type BudgetUpdateItemRequest = z.infer<typeof budgetUpdateItemRequestSchema>;

/** Replace the explicit payers of an expense (amounts in expense currency). */
export const budgetUpdatePayersRequestSchema = z.object({
  payers: z.array(payerInputSchema),
});
export type BudgetUpdatePayersRequest = z.infer<typeof budgetUpdatePayersRequestSchema>;

/**
 * A persisted settle-up transfer (budget_settlements row): "from paid to" a
 * given amount, entered in the payer's display `currency`. `exchange_rate` is the
 * live rate frozen at settle time (units of that currency per 1 trip currency), so
 * a settled position stays balanced when live rates drift (#1445). Legacy rows
 * have currency = null / exchange_rate = 1 and convert with live rates. Creating
 * one marks a suggested flow as paid; deleting it (undo) brings the flow back.
 */
export const budgetSettlementSchema = z.object({
  id: z.number(),
  trip_id: z.number(),
  from_user_id: z.number(),
  to_user_id: z.number(),
  amount: z.number(),
  currency: z.string().nullable().optional(),
  exchange_rate: z.number().optional(),
  created_at: z.string().optional(),
  created_by_user_id: z.number().nullable().optional(),
  from_username: z.string().optional(),
  from_avatar_url: z.string().nullable().optional(),
  to_username: z.string().optional(),
  to_avatar_url: z.string().nullable().optional(),
});
export type BudgetSettlement = z.infer<typeof budgetSettlementSchema>;

export const budgetCreateSettlementRequestSchema = z.object({
  from_user_id: z.number(),
  to_user_id: z.number(),
  amount: z.number(),
  // The display currency the amount was entered in; the server freezes its FX rate.
  currency: z.string().nullable().optional(),
});
export type BudgetCreateSettlementRequest = z.infer<typeof budgetCreateSettlementRequestSchema>;

/** Edit a persisted settle-up transfer (same fields as create; full replace). */
export const budgetUpdateSettlementRequestSchema = z.object({
  from_user_id: z.number(),
  to_user_id: z.number(),
  amount: z.number(),
  currency: z.string().nullable().optional(),
});
export type BudgetUpdateSettlementRequest = z.infer<typeof budgetUpdateSettlementRequestSchema>;

export const budgetUpdateMembersRequestSchema = z.object({
  user_ids: z.array(z.number()),
});
export type BudgetUpdateMembersRequest = z.infer<typeof budgetUpdateMembersRequestSchema>;

export const budgetToggleMemberPaidRequestSchema = z.object({
  paid: z.boolean(),
});
export type BudgetToggleMemberPaidRequest = z.infer<typeof budgetToggleMemberPaidRequestSchema>;

export const budgetReorderItemsRequestSchema = z.object({
  orderedIds: z.array(z.number()),
});
export type BudgetReorderItemsRequest = z.infer<typeof budgetReorderItemsRequestSchema>;

export const budgetReorderCategoriesRequestSchema = z.object({
  orderedCategories: z.array(z.string()),
});
export type BudgetReorderCategoriesRequest = z.infer<typeof budgetReorderCategoriesRequestSchema>;
