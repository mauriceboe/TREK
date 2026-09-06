import { z } from 'zod';

/**
 * Collab API contract — single source of truth for the /api/trips/:tripId/collab
 * endpoints (shared notes + file attachments, decision polls, group chat with
 * reactions, link previews).
 *
 * Trip-scoped; mutations use 'collab_edit' (file uploads use 'file_upload'). The
 * legacy route (server/src/routes/collab.ts) wraps collabService and broadcasts
 * over WebSocket + fires chat/note notifications. Rows are wide and kept open;
 * the request schemas + the bespoke 400/403/404 controller messages pin the rest.
 */

export const collabNoteCreateRequestSchema = z.object({
  title: z.string().min(1),
  // The desktop notes form clears optional fields by sending explicit null
  // (the service coerces falsy to its defaults), so they are all nullable.
  content: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
});
export type CollabNoteCreateRequest = z.infer<typeof collabNoteCreateRequestSchema>;

export const collabNoteUpdateRequestSchema = z.object({
  title: z.string().optional(),
  // Same null-clearing protocol as create (the desktop form resends the whole
  // note object, with cleared fields as explicit null).
  content: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  pinned: z.union([z.boolean(), z.number()]).optional(),
  website: z.string().nullable().optional(),
});
export type CollabNoteUpdateRequest = z.infer<typeof collabNoteUpdateRequestSchema>;

export const collabPollCreateRequestSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.unknown()).min(2),
  multiple: z.boolean().optional(),
  multiple_choice: z.boolean().optional(),
  deadline: z.string().optional(),
});
export type CollabPollCreateRequest = z.infer<typeof collabPollCreateRequestSchema>;

export const collabPollVoteRequestSchema = z.object({
  option_index: z.number(),
});
export type CollabPollVoteRequest = z.infer<typeof collabPollVoteRequestSchema>;

const httpUrl = z.string().trim().min(1).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}, 'A valid http(s) URL is required');

export const collabLinkCreateRequestSchema = z.object({
  title: z.string().trim().min(1),
  url: httpUrl,
  pinned: z.union([z.boolean(), z.number()]).optional(),
});
export type CollabLinkCreateRequest = z.infer<typeof collabLinkCreateRequestSchema>;

export const collabLinkUpdateRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  url: httpUrl.optional(),
  pinned: z.union([z.boolean(), z.number()]).optional(),
});
export type CollabLinkUpdateRequest = z.infer<typeof collabLinkUpdateRequestSchema>;

// text may be empty when the chat message is image-only (multipart). The
// controller still rejects a request with neither text nor files.
export const collabMessageCreateRequestSchema = z.object({
  text: z.string().max(5000).optional(),
  // Multipart fields arrive as strings; JSON chat still sends a number/null.
  reply_to: z.union([z.number(), z.string(), z.null()]).optional(),
});
export type CollabMessageCreateRequest = z.infer<typeof collabMessageCreateRequestSchema>;

export const collabReactionRequestSchema = z.object({
  emoji: z.string().min(1),
});
export type CollabReactionRequest = z.infer<typeof collabReactionRequestSchema>;
