import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Options } from 'multer';
import path from 'path';
import fs from 'fs';
import type { User } from '../../types';
import { CollabService } from './collab.service';
import { StorageService } from '../storage/storage.service';
import {
  CollabNoteCreateDto,
  CollabNoteUpdateDto,
  CollabPollCreateDto,
  CollabPollVoteDto,
  CollabLinkCreateDto,
  CollabLinkUpdateDto,
  CollabMessageCreateDto,
  CollabReactionDto,
} from './collab.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission, TripAccessGuard } from '../permissions/trip-access.guard';
import { BLOCKED_EXTENSIONS } from '../files/files.constants';

export const MAX_NOTE_FILE_SIZE = 50 * 1024 * 1024;
const MAX_CHAT_IMAGES = 4;
const CHAT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const collabChatImageFilter: Options['fileFilter'] = (_req, file, cb) => {
  if (!CHAT_IMAGE_TYPES.has(file.mimetype)) {
    const err: Error & { statusCode?: number } = new Error('Only JPEG, PNG, GIF, and WebP images are allowed');
    err.statusCode = 400;
    return cb(err);
  }
  cb(null, true);
};
// Consumed by collab.module.ts's MulterModule factory; the rest of the multer
// options (spool destination, filename, limits) come from the storage upload
// factory.
export const collabNoteFileFilter: Options['fileFilter'] = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.includes(ext) || file.mimetype.includes('svg') || file.mimetype.includes('html') || file.mimetype.includes('javascript')) {
    const err: Error & { statusCode?: number } = new Error('File type not allowed');
    err.statusCode = 400;
    return cb(err);
  }
  cb(null, true);
};

/**
 * /api/trips/:tripId/collab — shared notes, polls, chat (+ reactions), link
 * previews. WebSocket-backed group collaboration.
 *
 * Byte-identical to the legacy Express route (server/src/routes/collab.ts): trip
 * access (404), 'collab_edit' (403) on mutations + 'file_upload' on note files,
 * create 201 / rest 200 (vote + react POST stay 200), the bespoke 400/403/404
 * bodies, the chat/note notifications, and all WebSocket broadcasts with the
 * forwarded X-Socket-Id. Bodies validate against the @trek/shared collab
 * schemas via the DTO classes in collab.dto.ts + the global ZodValidationPipe
 * (400 with the standard `{ error }` envelope on mismatch — this replaced the
 * legacy bespoke 'Title is required' / 'Question is required' / '... 2 options
 * ...' / 5000-char / 'Emoji is required' checks; the whitespace-only 'Message
 * text is required' check stays, since min(1) doesn't trim). One deliberate
 * deviation from the legacy route: link-preview now verifies trip access (404)
 * like every sibling handler.
 */
@Controller('api/trips/:tripId/collab')
// TripAccessGuard is applied PER HANDLER, not on the class: the note-file upload
// route keeps its own check, because guards run before interceptors and a 404 sent
// while the client is still streaming the multipart body destroys the socket (the
// caller then sees ECONNRESET instead of the 404). Same as files.controller.ts.
@UseGuards(JwtAuthGuard)
export class CollabController {
  constructor(
    private readonly collab: CollabService,
    private readonly storage: StorageService,
  ) {}

  private requireTrip(tripId: string, user: User) {
    const trip = this.collab.verifyTripAccess(tripId, user.id);
    if (!trip) {
      throw new HttpException({ error: 'Trip not found' }, 404);
    }
    return trip;
  }

  private requireEdit(trip: NonNullable<ReturnType<CollabService['verifyTripAccess']>>, user: User): void {
    if (!this.collab.canEdit(trip, user)) {
      throw new HttpException({ error: 'No permission' }, 403);
    }
  }

  // ── Notes ───────────────────────────────────────────────────────────────
  @UseGuards(TripAccessGuard)
  @Get('notes')
  listNotes(@CurrentUser() user: User, @Param('tripId') tripId: string) {
    return { notes: this.collab.listNotes(tripId) };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Post('notes')
  createNote(@CurrentUser() user: User, @Param('tripId') tripId: string, @Body() body: CollabNoteCreateDto, @Headers('x-socket-id') socketId?: string) {
    const note = this.collab.createNote(tripId, user.id, {
      title: body.title,
      content: body.content,
      category: body.category,
      color: body.color,
      website: body.website,
    });
    this.collab.broadcast(tripId, 'collab:note:created', { note }, socketId);
    this.collab.notifyCollab(tripId, user);
    return { note };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Put('notes/:id')
  updateNote(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Body() body: CollabNoteUpdateDto, @Headers('x-socket-id') socketId?: string) {
    const note = this.collab.updateNote(tripId, id, {
      title: body.title,
      content: body.content,
      category: body.category,
      color: body.color,
      pinned: body.pinned,
      website: body.website,
    });
    if (!note) {
      throw new HttpException({ error: 'Note not found' }, 404);
    }
    this.collab.broadcast(tripId, 'collab:note:updated', { note }, socketId);
    return { note };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Delete('notes/:id')
  async deleteNote(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Headers('x-socket-id') socketId?: string) {
    if (!(await this.collab.deleteNote(tripId, id))) {
      throw new HttpException({ error: 'Note not found' }, 404);
    }
    this.collab.broadcast(tripId, 'collab:note:deleted', { noteId: Number(id) }, socketId);
    return { success: true };
  }

  @Post('notes/:id/files')
  @UseInterceptors(FileInterceptor('file'))
  async addNoteFile(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined, @Headers('x-socket-id') socketId?: string) {
    // multer has already written the upload to the spool dir by the time any of
    // these checks run, and nothing sweeps orphans, so every refusal takes the
    // bytes back out, with the same closure the trip-file upload uses.
    const cleanupSpool = () => {
      if (file?.path) { try { fs.unlinkSync(file.path); } catch { /* best-effort */ } }
    };
    try {
      const trip = this.requireTrip(tripId, user);
      if (!this.collab.canUploadFiles(trip, user)) {
        throw new HttpException({ error: 'No permission to upload files' }, 403);
      }
    } catch (err) {
      cleanupSpool();
      throw err;
    }
    if (!file) {
      throw new HttpException({ error: 'No file uploaded' }, 400);
    }
    // Commit the spooled upload to its final storage location (atomic
    // same-volume rename) before the DB row references the final path.
    await this.storage.put('files', file.filename, { tmpPath: file.path });
    const result = this.collab.addNoteFile(tripId, id, file);
    if (!result) {
      // Already committed, so the spool file is gone; drop the final object.
      await this.storage.delete('files', file.filename).catch(() => {});
      throw new HttpException({ error: 'Note not found' }, 404);
    }
    this.collab.broadcast(tripId, 'collab:note:updated', { note: this.collab.getFormattedNoteById(tripId, id) }, socketId);
    return result;
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Delete('notes/:id/files/:fileId')
  async deleteNoteFile(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Param('fileId') fileId: string, @Headers('x-socket-id') socketId?: string) {
    if (!(await this.collab.deleteNoteFile(tripId, id, fileId))) {
      throw new HttpException({ error: 'File not found' }, 404);
    }
    this.collab.broadcast(tripId, 'collab:note:updated', { note: this.collab.getFormattedNoteById(tripId, id) }, socketId);
    return { success: true };
  }

  // ── Shared links ────────────────────────────────────────────────────────
  @UseGuards(TripAccessGuard)
  @Get('links')
  listLinks(@CurrentUser() user: User, @Param('tripId') tripId: string) {
    return { links: this.collab.listLinks(tripId) };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Post('links')
  createLink(@CurrentUser() user: User, @Param('tripId') tripId: string, @Body() body: CollabLinkCreateDto, @Headers('x-socket-id') socketId?: string) {
    const link = this.collab.createLink(tripId, user.id, { title: body.title, url: body.url, pinned: Boolean(body.pinned) });
    this.collab.broadcast(tripId, 'collab:link:created', { link }, socketId);
    return { link };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Put('links/:id')
  updateLink(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Body() body: CollabLinkUpdateDto, @Headers('x-socket-id') socketId?: string) {
    const link = this.collab.updateLink(tripId, id, {
      title: body.title,
      url: body.url,
      pinned: body.pinned === undefined ? undefined : Boolean(body.pinned),
    });
    if (!link) throw new HttpException({ error: 'Link not found' }, 404);
    this.collab.broadcast(tripId, 'collab:link:updated', { link }, socketId);
    return { link };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Delete('links/:id')
  deleteLink(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Headers('x-socket-id') socketId?: string) {
    if (!this.collab.deleteLink(tripId, id)) throw new HttpException({ error: 'Link not found' }, 404);
    this.collab.broadcast(tripId, 'collab:link:deleted', { linkId: Number(id) }, socketId);
    return { success: true };
  }

  // ── Polls ───────────────────────────────────────────────────────────────
  @UseGuards(TripAccessGuard)
  @Get('polls')
  listPolls(@CurrentUser() user: User, @Param('tripId') tripId: string) {
    return { polls: this.collab.listPolls(tripId) };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Post('polls')
  createPoll(@CurrentUser() user: User, @Param('tripId') tripId: string, @Body() body: CollabPollCreateDto, @Headers('x-socket-id') socketId?: string) {
    const poll = this.collab.createPoll(tripId, user.id, {
      question: body.question,
      options: body.options,
      multiple: body.multiple,
      multiple_choice: body.multiple_choice,
      deadline: body.deadline,
    });
    this.collab.broadcast(tripId, 'collab:poll:created', { poll }, socketId);
    return { poll };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Post('polls/:id/vote')
  @HttpCode(200)
  votePoll(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Body() body: CollabPollVoteDto, @Headers('x-socket-id') socketId?: string) {
    const result = this.collab.votePoll(tripId, id, user.id, body.option_index);
    if (result.error === 'not_found') throw new HttpException({ error: 'Poll not found' }, 404);
    if (result.error === 'closed') throw new HttpException({ error: 'Poll is closed' }, 400);
    if (result.error === 'invalid_index') throw new HttpException({ error: 'Invalid option index' }, 400);
    this.collab.broadcast(tripId, 'collab:poll:voted', { poll: result.poll }, socketId);
    return { poll: result.poll };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Put('polls/:id/close')
  closePoll(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Headers('x-socket-id') socketId?: string) {
    const poll = this.collab.closePoll(tripId, id);
    if (!poll) {
      throw new HttpException({ error: 'Poll not found' }, 404);
    }
    this.collab.broadcast(tripId, 'collab:poll:closed', { poll }, socketId);
    return { poll };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Delete('polls/:id')
  deletePoll(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Headers('x-socket-id') socketId?: string) {
    if (!this.collab.deletePoll(tripId, id)) {
      throw new HttpException({ error: 'Poll not found' }, 404);
    }
    this.collab.broadcast(tripId, 'collab:poll:deleted', { pollId: Number(id) }, socketId);
    return { success: true };
  }

  // ── Messages ────────────────────────────────────────────────────────────
  @UseGuards(TripAccessGuard)
  @Get('messages')
  listMessages(@CurrentUser() user: User, @Param('tripId') tripId: string, @Query('before') before?: string) {
    return { messages: this.collab.listMessages(tripId, before) };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Post('messages')
  @UseInterceptors(FilesInterceptor('images', MAX_CHAT_IMAGES, { fileFilter: collabChatImageFilter, limits: { files: MAX_CHAT_IMAGES, fileSize: 10 * 1024 * 1024 } }))
  async createMessage(@CurrentUser() user: User, @Param('tripId') tripId: string, @Body() body: CollabMessageCreateDto, @UploadedFiles() files: Express.Multer.File[] | undefined, @Headers('x-socket-id') socketId?: string) {
    const uploaded = files || [];
    const cleanupSpool = () => uploaded.forEach(file => { if (file.path) { try { fs.unlinkSync(file.path); } catch { /* best-effort */ } } });
    if (body.text && body.text.length > 5000) {
      cleanupSpool();
      throw new HttpException({ error: 'text must be 5000 characters or less' }, 400);
    }
    const trip = this.requireTrip(tripId, user);
    if (uploaded.length && !this.collab.canUploadFiles(trip, user)) {
      cleanupSpool();
      throw new HttpException({ error: 'No permission to upload files' }, 403);
    }
    const text = (body.text || '').trim();
    if (!text && !uploaded.length) {
      cleanupSpool();
      throw new HttpException({ error: 'Message text or image is required' }, 400);
    }
    const committed: string[] = [];
    try {
      for (const file of uploaded) {
        await this.storage.put('files', file.filename, { tmpPath: file.path });
        committed.push(file.filename);
      }
    } catch (err) {
      cleanupSpool();
      for (const name of committed) await this.storage.delete('files', name).catch(() => {});
      throw err;
    }
    const replyTo = body.reply_to === undefined || body.reply_to === '' || body.reply_to === null ? null : Number(body.reply_to);
    const result = this.collab.createMessage(
      tripId,
      user.id,
      text,
      Number.isFinite(replyTo as number) ? replyTo : null,
      uploaded.map(file => ({ filename: file.filename, originalname: file.originalname, size: file.size, mimetype: file.mimetype })),
    );
    if (result.error === 'reply_not_found') {
      for (const name of committed) await this.storage.delete('files', name).catch(() => {});
      throw new HttpException({ error: 'Reply target message not found' }, 400);
    }
    this.collab.broadcast(tripId, 'collab:message:created', { message: result.message }, socketId);
    const preview = text || 'sent an image';
    this.collab.notifyCollab(tripId, user, preview.length > 80 ? preview.substring(0, 80) + '...' : preview);
    return { message: result.message };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Post('messages/:id/react')
  @HttpCode(200)
  react(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Body() body: CollabReactionDto, @Headers('x-socket-id') socketId?: string) {
    const result = this.collab.reactMessage(id, tripId, user.id, body.emoji);
    if (!result.found) {
      throw new HttpException({ error: 'Message not found' }, 404);
    }
    this.collab.broadcast(tripId, 'collab:message:reacted', { messageId: Number(id), reactions: result.reactions }, socketId);
    return { reactions: result.reactions };
  }

  @UseGuards(TripAccessGuard)
  @RequirePermission('collab_edit')
  @Delete('messages/:id')
  deleteMessage(@CurrentUser() user: User, @Param('tripId') tripId: string, @Param('id') id: string, @Headers('x-socket-id') socketId?: string) {
    const result = this.collab.deleteMessage(tripId, id, user.id);
    if (result.error === 'not_found') throw new HttpException({ error: 'Message not found' }, 404);
    if (result.error === 'not_owner') throw new HttpException({ error: 'You can only delete your own messages' }, 403);
    this.collab.broadcast(tripId, 'collab:message:deleted', { messageId: Number(id), username: result.username || user.username }, socketId);
    return { success: true };
  }

  // ── Link preview ──────────────────────────────────────────────────────────
  // Deliberately no @RequirePermission: this is a read path. The client asks for
  // a preview while *rendering* a message or a note (CollabChatMessages,
  // CollabNotesCard), never while composing one, so it belongs with the GET
  // siblings above — requiring 'collab_edit' would strip every preview from a
  // trip whose owner has narrowed that right, for people who may still read the
  // chat. What keeps the fetcher from being a free outbound proxy is the budget
  // inside the service, not a write permission.
  @UseGuards(TripAccessGuard)
  @Get('link-preview')
  async linkPreview(@CurrentUser() user: User, @Param('tripId') tripId: string, @Query('url') url?: string) {
    // Unlike the legacy route, this verifies trip access — any authed user
    // could otherwise drive the SSRF-guarded fetcher through arbitrary trip URLs.
    if (!url) {
      throw new HttpException({ error: 'URL is required' }, 400);
    }
    try {
      const preview = await this.collab.linkPreview(url, user.id);
      if (preview.rateLimited) {
        throw new HttpException({ error: 'Too many requests' }, 429);
      }
      if (preview.error) {
        throw new HttpException({ error: preview.error }, 400);
      }
      return preview;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      return { title: null, description: null, image: null, url };
    }
  }
}
