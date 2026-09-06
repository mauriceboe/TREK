import { z } from 'zod';

/**
 * File + photo API contract.
 *
 * Files live under /api/trips/:tripId/files (upload, metadata, star, trash,
 * reservation links, authenticated download). Photos live under /api/photos
 * (thumbnail/original streaming + info) and are global, not trip-scoped.
 *
 * Uploads are multipart/form-data so the file itself isn't modelled here; these
 * schemas pin the JSON-ish metadata fields that ride along or come as request
 * bodies. The bespoke 400/403/404 controller messages pin the rest.
 */

const nullableIdField = z.union([z.string(), z.number()]).nullable().optional();

/**
 * Multipart text fields riding along with the upload — always strings on the
 * wire (multipart/form-data has no other type), so no numeric coercion here.
 */
export const fileUploadRequestSchema = z.object({
  place_id: z.string().optional(),
  description: z.string().optional(),
  reservation_id: z.string().optional(),
  budget_item_id: z.string().optional(),
});
export type FileUploadRequest = z.infer<typeof fileUploadRequestSchema>;

export const fileUpdateRequestSchema = z.object({
  description: z.string().optional(),
  place_id: nullableIdField,
  reservation_id: nullableIdField,
  budget_item_id: nullableIdField,
});
export type FileUpdateRequest = z.infer<typeof fileUpdateRequestSchema>;

export const fileLinkRequestSchema = z.object({
  reservation_id: nullableIdField,
  assignment_id: nullableIdField,
  place_id: nullableIdField,
  budget_item_id: nullableIdField,
});
export type FileLinkRequest = z.infer<typeof fileLinkRequestSchema>;

/** Variants the photo streaming endpoints accept. */
export const photoVariantSchema = z.enum(['thumbnail', 'original']);
export type PhotoVariant = z.infer<typeof photoVariantSchema>;
