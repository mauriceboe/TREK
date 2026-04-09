import { broadcast } from '../../websocket';

export function safeBroadcast(tripId: number, event: string, payload: Record<string, unknown>): void {
  try {
    broadcast(tripId, event, payload);
  } catch (err) {
    console.error(`[MCP] broadcast failed for ${event}:`, err?.message ?? err);
  }
}

export const MAX_MCP_TRIP_DAYS = 90;

export const TOOL_ANNOTATIONS_READONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_ANNOTATIONS_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_ANNOTATIONS_DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_ANNOTATIONS_NON_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function demoDenied() {
  return { content: [{ type: 'text' as const, text: 'Write operations are disabled in demo mode.' }], isError: true };
}

export function noAccess() {
  return { content: [{ type: 'text' as const, text: 'Trip not found or access denied.' }], isError: true };
}

export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
