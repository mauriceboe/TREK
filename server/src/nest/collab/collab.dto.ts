import { createZodDto } from 'nestjs-zod';
import {
  collabNoteCreateRequestSchema,
  collabNoteUpdateRequestSchema,
  collabPollCreateRequestSchema,
  collabPollVoteRequestSchema,
  collabLinkCreateRequestSchema,
  collabLinkUpdateRequestSchema,
  collabMessageCreateRequestSchema,
  collabReactionRequestSchema,
} from '@trek/shared';

/**
 * Body DTOs for the collab controller. The global ZodValidationPipe (APP_PIPE
 * in app.module.ts) validates any @Body() typed with these by metatype; the
 * shared Zod schemas remain the single source of truth for the wire contract.
 */
export class CollabNoteCreateDto extends createZodDto(collabNoteCreateRequestSchema) {}
export class CollabNoteUpdateDto extends createZodDto(collabNoteUpdateRequestSchema) {}
export class CollabPollCreateDto extends createZodDto(collabPollCreateRequestSchema) {}
export class CollabPollVoteDto extends createZodDto(collabPollVoteRequestSchema) {}
export class CollabLinkCreateDto extends createZodDto(collabLinkCreateRequestSchema) {}
export class CollabLinkUpdateDto extends createZodDto(collabLinkUpdateRequestSchema) {}
export class CollabMessageCreateDto extends createZodDto(collabMessageCreateRequestSchema) {}
export class CollabReactionDto extends createZodDto(collabReactionRequestSchema) {}
