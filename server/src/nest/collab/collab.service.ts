import path from 'path';
import { Injectable } from '@nestjs/common';
import { DatabaseService, type TripAccess } from '../database/database.service';
import type { TrekWsPayload, TrekWsTripEventName } from '@trek/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { PermissionsService } from '../permissions/permissions.service';
import { avatarUrl } from '../common/avatarUrl';
import { checkSsrf, createPinnedDispatcher } from '../../utils/ssrfGuard';
import { discardBody, exceedsDeclaredLength, readCappedText } from '../../utils/cappedFetch';
import type { CollabNote, CollabPoll, CollabMessage, TripFile, User } from '../../types';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { RateLimitService } from '../common/rate-limit.service';

type Trip = TripAccess;

// Half a megabyte of markup is far more than any og:/<title> block needs, and
// the URL is caller-supplied, so read no further than that.
const MAX_PREVIEW_BYTES = 512 * 1024;

export interface ReactionRow {
  emoji: string;
  user_id: number;
  username: string;
  message_id?: number;
}

export interface PollVoteRow {
  option_index: number;
  user_id: number;
  username: string;
  avatar: string | null;
}

export interface NoteFileRow {
  id: number;
  filename: string;
  original_name?: string;
  file_size?: number;
  mime_type?: string;
}

export interface GroupedReaction {
  emoji: string;
  users: { user_id: number; username: string }[];
  count: number;
}

export interface LinkPreviewResult {
  title: string | null;
  description: string | null;
  image: string | null;
  site_name?: string | null;
  url: string;
  /** Set when the URL was refused; the controller turns it into a 400. */
  error?: string;
  /** Set when the caller is out of preview fetches; the controller turns it into a 429. */
  rateLimited?: boolean;
}

/**
 * Outbound fetches one user may trigger per minute. Deliberately generous: the
 * client asks for a preview per rendered message (`LIMIT 100`) and per note with
 * a website, both without debounce, so opening a link-heavy trip is a burst of
 * dozens. Cache hits are not charged, so this only ever meters *new* URLs.
 */
const PREVIEW_FETCHES_PER_MINUTE = 60;

/** How long a scraped preview stays good. og: tags are near-static. */
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;

/** Entries kept before the least recently used one is dropped. */
const PREVIEW_CACHE_MAX = 500;

/**
 * Pulls the og:/<title>/description fields out of a document.
 *
 * Every `[^>]` run is bounded. Unbounded, two of them separated by a literal make
 * the engine rescan the rest of the document from every `<meta` it passes, which
 * is quadratic: a page of `'<meta '` with no `>` in it took ~58s at 240KB on the
 * measured build, and the cap admits half a megabyte. Node runs one thread, so
 * that is the whole server — WebSocket, auth and health included — for one
 * request. No real attribute list comes close to 512 characters.
 */
function scrapeOpenGraph(html: string): Omit<LinkPreviewResult, 'url'> {
  const og = (prop: string) => {
    const m = html.match(new RegExp(`<meta[^>]{0,512}property=["']og:${prop}["'][^>]{0,512}content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]{0,512}content=["']([^"']*)["'][^>]{0,512}property=["']og:${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  const titleTag = html.match(/<title[^>]{0,512}>([^<]*)<\/title>/i);
  const descMeta = html.match(/<meta[^>]{0,512}name=["']description["'][^>]{0,512}content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]{0,512}content=["']([^"']*)["'][^>]{0,512}name=["']description["']/i);
  const image = og('image');

  return {
    title: og('title') || (titleTag ? titleTag[1].trim() : null),
    description: og('description') || (descMeta ? descMeta[1].trim() : null),
    // The client renders this straight into an <img src>, so the page being
    // previewed must not be able to point that at anything but a web address —
    // the same scheme pin placeImageUrlSchema applies to a stored place picture.
    image: image && /^https?:\/\//i.test(image) ? image : null,
    site_name: og('site_name') || null,
  };
}

/**
 * Collab domain service — owns the collab SQL (moved from the legacy
 * services/collabService.ts: the `||` falsy-coercion defaults, the mixed
 * COALESCE/CASE update, the post-write re-selects and the sentinel error
 * strings). Trip access, the 'collab_edit' / 'file_upload' permissions and the
 * WebSocket broadcast keep their legacy call paths. Post-migration hardening
 * on top of the 1:1 move: the multi-statement writes (deleteNote, votePoll)
 * run in db.transaction(), getFormattedNoteById is trip-scoped and null-safe,
 * votePoll rejects non-integer indexes, and linkPreview absorbs malformed URLs
 * instead of throwing.
 * All consumers are in-container since the trip fold (TripsService and
 * TripsMcp inject this class); collab.bridge.ts was deleted with its last
 * outside-container consumers.
 */
@Injectable()
export class CollabService {
  constructor(
    private readonly db: DatabaseService,
    private readonly permissions: PermissionsService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Scraped previews, keyed by URL and ordered least-recently-used first.
   *
   * On the service rather than at module scope so a test gets a fresh one per
   * container. What it buys: the client re-requests every preview it renders on
   * each mount, so without it a reload of a busy trip is another hundred outbound
   * fetches — the exact traffic the budget above is meant to stop the server from
   * emitting on someone else's behalf.
   */
  private readonly previewCache = new Map<string, { at: number; result: LinkPreviewResult }>();

  /** Preview fetches currently in flight, so simultaneous askers share one request. */
  private readonly inFlight = new Map<string, Promise<LinkPreviewResult>>();

  verifyTripAccess(tripId: string | number, userId: number) {
    return this.db.canAccessTrip(tripId, userId);
  }

  canEdit(trip: Trip, user: User): boolean {
    return this.permissions.checkPermission('collab_edit', user.role, trip.user_id, user.id, trip.user_id !== user.id);
  }

  canUploadFiles(trip: Trip, user: User): boolean {
    return this.permissions.checkPermission('file_upload', user.role, trip.user_id, user.id, trip.user_id !== user.id);
  }

  broadcast<E extends TrekWsTripEventName>(tripId: string, event: E, payload: TrekWsPayload<E>, socketId: string | undefined): void {
    this.realtime.broadcast(tripId, event, payload, socketId);
  }

  /* ------------------------------------------------------------------ */
  /*  Reactions                                                          */
  /* ------------------------------------------------------------------ */

  private loadReactions(messageId: number | string): ReactionRow[] {
    return this.db.all<ReactionRow>(`
    SELECT r.emoji, r.user_id, u.username
    FROM collab_message_reactions r
    JOIN users u ON r.user_id = u.id
    WHERE r.message_id = ?
  `, messageId);
  }

  private groupReactions(reactions: ReactionRow[]): GroupedReaction[] {
    const map: Record<string, { user_id: number; username: string }[]> = {};
    for (const r of reactions) {
      if (!map[r.emoji]) map[r.emoji] = [];
      map[r.emoji].push({ user_id: r.user_id, username: r.username });
    }
    return Object.entries(map).map(([emoji, users]) => ({ emoji, users, count: users.length }));
  }

  reactMessage(messageId: number | string, tripId: number | string, userId: number, emoji: string): { found: boolean; reactions: GroupedReaction[] } {
    const msg = this.db.get('SELECT id FROM collab_messages WHERE id = ? AND trip_id = ?', messageId, tripId);
    if (!msg) return { found: false, reactions: [] };

    const existing = this.db.get<{ id: number }>('SELECT id FROM collab_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
    if (existing) {
      this.db.run('DELETE FROM collab_message_reactions WHERE id = ?', existing.id);
    } else {
      this.db.run('INSERT INTO collab_message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', messageId, userId, emoji);
    }

    return { found: true, reactions: this.groupReactions(this.loadReactions(messageId)) };
  }

  /* ------------------------------------------------------------------ */
  /*  Notes                                                              */
  /* ------------------------------------------------------------------ */

  private formatNote(note: CollabNote) {
    const attachments = this.db.all<NoteFileRow>('SELECT id, filename, original_name, file_size, mime_type FROM trip_files WHERE note_id = ?', note.id);
    return {
      ...note,
      avatar_url: avatarUrl(note),
      attachments: attachments.map(a => ({ ...a, url: `/api/trips/${note.trip_id}/files/${a.id}/download` })),
    };
  }

  listNotes(tripId: string | number) {
    const notes = this.db.all<CollabNote>(`
    SELECT n.*, u.username, u.avatar
    FROM collab_notes n
    JOIN users u ON n.user_id = u.id
    WHERE n.trip_id = ?
    ORDER BY n.pinned DESC, n.updated_at DESC
  `, tripId);

    return notes.map(note => this.formatNote(note));
  }

  createNote(tripId: string | number, userId: number, data: { title: string; content?: string | null; category?: string | null; color?: string | null; website?: string | null; pinned?: boolean }) {
    const pinned = data.pinned ? 1 : 0;
    const result = this.db.run(`
    INSERT INTO collab_notes (trip_id, user_id, title, content, category, color, website, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, tripId, userId, data.title, data.content || null, data.category || 'General', data.color || '#6366f1', data.website || null, pinned);

    const note = this.db.get<CollabNote>(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `, result.lastInsertRowid)!;

    return this.formatNote(note);
  }

  updateNote(tripId: string | number, noteId: string | number, data: { title?: string; content?: string | null; category?: string | null; color?: string | null; pinned?: number | boolean; website?: string | null }): ReturnType<CollabService['formatNote']> | null {
    const existing = this.db.get('SELECT * FROM collab_notes WHERE id = ? AND trip_id = ?', noteId, tripId);
    if (!existing) return null;

    this.db.run(`
    UPDATE collab_notes SET
      title = COALESCE(?, title),
      content = CASE WHEN ? THEN ? ELSE content END,
      category = COALESCE(?, category),
      color = COALESCE(?, color),
      pinned = CASE WHEN ? IS NOT NULL THEN ? ELSE pinned END,
      website = CASE WHEN ? THEN ? ELSE website END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
      data.title || null,
      data.content !== undefined ? 1 : 0, data.content !== undefined ? data.content : null,
      data.category || null,
      data.color || null,
      data.pinned !== undefined ? 1 : null, data.pinned ? 1 : 0,
      data.website !== undefined ? 1 : 0, data.website !== undefined ? data.website : null,
      noteId
    );

    const note = this.db.get<CollabNote>(`
    SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?
  `, noteId)!;

    return this.formatNote(note);
  }

  async deleteNote(tripId: string | number, noteId: string | number): Promise<boolean> {
    const existing = this.db.get('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?', noteId, tripId);
    if (!existing) return false;

    // Clean up attached objects first (delete-first is intentional — a failed
    // row delete leaves dangling rows, never orphaned files). basename()
    // tolerates any legacy 'files/'-prefixed row the boot migration has not
    // seen.
    const noteFiles = this.db.all<NoteFileRow>('SELECT id, filename FROM trip_files WHERE note_id = ?', noteId);
    for (const f of noteFiles) {
      await this.storage.delete('files', path.basename(f.filename)).catch(() => { /* ignore */ });
    }
    this.db.transaction(() => {
      this.db.run('DELETE FROM trip_files WHERE note_id = ?', noteId);
      this.db.run('DELETE FROM collab_notes WHERE id = ?', noteId);
    });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  Note files                                                         */
  /* ------------------------------------------------------------------ */

  addNoteFile(tripId: string | number, noteId: string | number, file: { filename: string; originalname: string; size: number; mimetype: string }): { file: TripFile & { url: string } } | null {
    const note = this.db.get('SELECT id FROM collab_notes WHERE id = ? AND trip_id = ?', noteId, tripId);
    if (!note) return null;

    const result = this.db.run(
      'INSERT INTO trip_files (trip_id, note_id, filename, original_name, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)',
      tripId, noteId, file.filename, file.originalname, file.size, file.mimetype
    );

    const saved = this.db.get<TripFile>('SELECT * FROM trip_files WHERE id = ?', result.lastInsertRowid)!;
    return { file: { ...saved, url: `/api/trips/${tripId}/files/${saved.id}/download` } };
  }

  getFormattedNoteById(tripId: string | number, noteId: string | number) {
    const note = this.db.get<CollabNote>('SELECT n.*, u.username, u.avatar FROM collab_notes n JOIN users u ON n.user_id = u.id WHERE n.id = ? AND n.trip_id = ?', noteId, tripId);
    if (!note) return null;
    return this.formatNote(note);
  }

  async deleteNoteFile(tripId: string | number, noteId: string | number, fileId: string | number): Promise<boolean> {
    // Scope to the trip — like every sibling collab op — so a caller authorized for THEIR
    // trip can't delete a note-file that belongs to someone else's trip (IDOR). trip_files
    // carries trip_id, so this ties the deleted object to the URL's :tripId the controller
    // access-checked, not just to a note/file id an attacker can enumerate.
    const file = this.db.get<TripFile>('SELECT * FROM trip_files WHERE id = ? AND note_id = ? AND trip_id = ?', fileId, noteId, tripId);
    if (!file) return false;

    await this.storage.delete('files', path.basename(file.filename)).catch(() => { /* ignore */ });

    this.db.run('DELETE FROM trip_files WHERE id = ?', fileId);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  Polls                                                              */
  /* ------------------------------------------------------------------ */

  private getPollWithVotes(pollId: number | bigint | string) {
    const poll = this.db.get<CollabPoll>(`
    SELECT p.*, u.username, u.avatar
    FROM collab_polls p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `, pollId);

    if (!poll) return null;

    const options: (string | { label: string })[] = JSON.parse(poll.options);

    const votes = this.db.all<PollVoteRow>(`
    SELECT v.option_index, v.user_id, u.username, u.avatar
    FROM collab_poll_votes v
    JOIN users u ON v.user_id = u.id
    WHERE v.poll_id = ?
  `, pollId);

    const formattedOptions = options.map((label: string | { label: string }, idx: number) => {
      const text = typeof label === 'string' ? label : label.label || label;
      return {
        // The client renders `opt.text`; keep `label` too for any other consumer.
        text,
        label: text,
        voters: votes
          .filter(v => v.option_index === idx)
          .map(v => ({ id: v.user_id, user_id: v.user_id, username: v.username, avatar: v.avatar, avatar_url: avatarUrl(v) })),
      };
    });

    return {
      ...poll,
      avatar_url: avatarUrl(poll),
      options: formattedOptions,
      is_closed: !!poll.closed,
      multiple_choice: !!poll.multiple,
    };
  }

  listPolls(tripId: string | number) {
    const rows = this.db.all<{ id: number }>(`
    SELECT id FROM collab_polls WHERE trip_id = ? ORDER BY created_at DESC
  `, tripId);

    return rows.map(row => this.getPollWithVotes(row.id)).filter(Boolean);
  }

  createPoll(tripId: string | number, userId: number, data: { question: string; options: unknown[]; multiple?: boolean; multiple_choice?: boolean; deadline?: string }) {
    const isMultiple = data.multiple || data.multiple_choice;

    const result = this.db.run(`
    INSERT INTO collab_polls (trip_id, user_id, question, options, multiple, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `, tripId, userId, data.question, JSON.stringify(data.options), isMultiple ? 1 : 0, data.deadline || null);

    return this.getPollWithVotes(result.lastInsertRowid);
  }

  votePoll(tripId: string | number, pollId: string | number, userId: number, optionIndex: number): { error?: string; poll?: ReturnType<CollabService['getPollWithVotes']> } {
    const poll = this.db.get<CollabPoll>('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?', pollId, tripId);
    if (!poll) return { error: 'not_found' };
    if (poll.closed) return { error: 'closed' };

    const options = JSON.parse(poll.options);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      return { error: 'invalid_index' };
    }

    const existingVote = this.db.get<{ id: number }>(
      'SELECT id FROM collab_poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?',
      pollId, userId, optionIndex
    );

    if (existingVote) {
      this.db.run('DELETE FROM collab_poll_votes WHERE id = ?', existingVote.id);
    } else {
      this.db.transaction(() => {
        if (!poll.multiple) {
          this.db.run('DELETE FROM collab_poll_votes WHERE poll_id = ? AND user_id = ?', pollId, userId);
        }
        this.db.run('INSERT INTO collab_poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)', pollId, userId, optionIndex);
      });
    }

    return { poll: this.getPollWithVotes(pollId) };
  }

  closePoll(tripId: string | number, pollId: string | number): ReturnType<CollabService['getPollWithVotes']> | null {
    const poll = this.db.get('SELECT * FROM collab_polls WHERE id = ? AND trip_id = ?', pollId, tripId);
    if (!poll) return null;

    this.db.run('UPDATE collab_polls SET closed = 1 WHERE id = ?', pollId);
    return this.getPollWithVotes(pollId);
  }

  deletePoll(tripId: string | number, pollId: string | number): boolean {
    const poll = this.db.get('SELECT id FROM collab_polls WHERE id = ? AND trip_id = ?', pollId, tripId);
    if (!poll) return false;

    this.db.run('DELETE FROM collab_polls WHERE id = ?', pollId);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  Shared links                                                       */
  /* ------------------------------------------------------------------ */

  listLinks(tripId: string | number) {
    return this.db.all(
      `SELECT l.*, u.username FROM collab_links l JOIN users u ON u.id = l.user_id
       WHERE l.trip_id = ? ORDER BY l.pinned DESC, l.created_at DESC`,
      tripId,
    );
  }

  createLink(tripId: string | number, userId: number, data: { title: string; url: string; pinned?: boolean }) {
    const result = this.db.run(
      'INSERT INTO collab_links (trip_id,user_id,title,url,pinned) VALUES (?,?,?,?,?)',
      tripId, userId, data.title.trim(), data.url.trim(), data.pinned ? 1 : 0,
    );
    return this.db.get('SELECT l.*, u.username FROM collab_links l JOIN users u ON u.id = l.user_id WHERE l.id = ?', result.lastInsertRowid);
  }

  updateLink(tripId: string | number, linkId: string | number, data: { title?: string; url?: string; pinned?: boolean | number }) {
    const existing = this.db.get<any>('SELECT * FROM collab_links WHERE id = ? AND trip_id = ?', linkId, tripId);
    if (!existing) return null;
    this.db.run(
      'UPDATE collab_links SET title = ?, url = ?, pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ?',
      data.title?.trim() || existing.title,
      data.url?.trim() || existing.url,
      data.pinned === undefined ? existing.pinned : (data.pinned ? 1 : 0),
      linkId,
      tripId,
    );
    return this.db.get('SELECT l.*, u.username FROM collab_links l JOIN users u ON u.id = l.user_id WHERE l.id = ?', linkId);
  }

  deleteLink(tripId: string | number, linkId: string | number): boolean {
    return this.db.run('DELETE FROM collab_links WHERE id = ? AND trip_id = ?', linkId, tripId).changes > 0;
  }

  /* ------------------------------------------------------------------ */
  /*  Messages                                                           */
  /* ------------------------------------------------------------------ */

  private formatMessage(msg: CollabMessage, reactions?: GroupedReaction[]) {
    const attachments = msg.id && msg.trip_id
      ? this.db.all<any>(
        `SELECT id, trip_id, message_id, filename, original_name, file_size, mime_type
         FROM trip_files WHERE message_id = ? AND trip_id = ? AND deleted_at IS NULL
         ORDER BY id ASC`,
        msg.id, msg.trip_id,
      )
      : [];
    return {
      ...msg,
      user_avatar: avatarUrl(msg),
      avatar_url: avatarUrl(msg),
      reactions: reactions || [],
      attachments: attachments.map((a: any) => ({
        id: a.id,
        filename: a.filename,
        original_name: a.original_name,
        file_size: a.file_size,
        mime_type: a.mime_type,
        url: `/api/trips/${a.trip_id}/files/${a.id}/download`,
      })),
    };
  }

  countMessages(tripId: string | number): number {
    const row = this.db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM collab_messages WHERE trip_id = ?', tripId)!;
    return row.cnt;
  }

  listMessages(tripId: string | number, before?: string | number) {
    const query = `
    SELECT m.*, u.username, u.avatar,
      CASE WHEN rm.deleted = 1 THEN '' ELSE rm.text END AS reply_text,
      ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.trip_id = ?${before ? ' AND m.id < ?' : ''}
    ORDER BY m.id DESC
    LIMIT 100
  `;

    const messages = before
      ? this.db.all<CollabMessage>(query, tripId, before)
      : this.db.all<CollabMessage>(query, tripId);

    messages.reverse();

    // A deleted message keeps its row so the client can render the placeholder
    // off the flag, but the original text must not leave the server. REST and
    // both MCP surfaces read through this method, so blanking here covers all
    // three.
    for (const m of messages) if (m.deleted) m.text = '';

    const msgIds = messages.map(m => m.id);
    const reactionsByMsg: Record<number, ReactionRow[]> = {};
    if (msgIds.length > 0) {
      const allReactions = this.db.all<ReactionRow & { message_id: number }>(`
      SELECT r.message_id, r.emoji, r.user_id, u.username
      FROM collab_message_reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id IN (${msgIds.map(() => '?').join(',')})
    `, ...msgIds);
      for (const r of allReactions) {
        if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = [];
        reactionsByMsg[r.message_id].push(r);
      }
    }

    return messages.map(m => this.formatMessage(m, this.groupReactions(reactionsByMsg[m.id] || [])));
  }

  createMessage(
    tripId: string | number,
    userId: number,
    text: string,
    replyTo?: number | null,
    files: Array<{ filename: string; originalname: string; size: number; mimetype: string }> = [],
  ): { error?: string; message?: ReturnType<CollabService['formatMessage']> } {
    if (replyTo) {
      // A soft-deleted message is gone as far as anyone replying is concerned:
      // its row survives only so the placeholder can be drawn where it was.
      const replyMsg = this.db.get(
        'SELECT id FROM collab_messages WHERE id = ? AND trip_id = ? AND deleted = 0', replyTo, tripId,
      );
      if (!replyMsg) return { error: 'reply_not_found' };
    }

    const result = this.db.run(`
    INSERT INTO collab_messages (trip_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)
  `, tripId, userId, text.trim(), replyTo || null);

    for (const file of files) {
      this.db.run(
        `INSERT INTO trip_files (trip_id, message_id, filename, original_name, file_size, mime_type, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        tripId, result.lastInsertRowid, file.filename, file.originalname, file.size, file.mimetype, userId,
      );
    }

    const message = this.db.get<CollabMessage>(`
    SELECT m.*, u.username, u.avatar,
      CASE WHEN rm.deleted = 1 THEN '' ELSE rm.text END AS reply_text,
      ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.id = ?
  `, result.lastInsertRowid)!;

    return { message: this.formatMessage(message) };
  }

  deleteMessage(tripId: string | number, messageId: string | number, userId: number): { error?: string; username?: string } {
    const message = this.db.get<CollabMessage>('SELECT * FROM collab_messages WHERE id = ? AND trip_id = ?', messageId, tripId);
    if (!message) return { error: 'not_found' };
    if (Number(message.user_id) !== Number(userId)) return { error: 'not_owner' };

    const attachments = this.db.all<{ filename: string }>('SELECT filename FROM trip_files WHERE message_id = ? AND trip_id = ?', messageId, tripId);
    for (const file of attachments) {
      void this.storage.delete('files', path.basename(file.filename)).catch(() => { /* best effort */ });
    }
    this.db.run('DELETE FROM trip_files WHERE message_id = ? AND trip_id = ?', messageId, tripId);
    this.db.run('UPDATE collab_messages SET deleted = 1 WHERE id = ?', messageId);
    return { username: message.username };
  }

  /* ------------------------------------------------------------------ */
  /*  Link preview                                                       */
  /* ------------------------------------------------------------------ */

  async linkPreview(url: string, userId?: number): Promise<LinkPreviewResult> {
    const fallback: LinkPreviewResult = { title: null, description: null, image: null, url };

    // A malformed URL returns the fallback directly (the legacy code let
    // `new URL` throw and relied on the controller's catch for the same 200).
    try { new URL(url); } catch { return fallback; }

    // Served before the budget is charged: opening a chat re-requests every
    // preview it renders, so a reload must not cost the caller its allowance.
    const cached = this.readPreviewCache(url);
    if (cached) return cached;

    // A fetch for this URL is already on its way. The client renders one preview
    // per message and does not deduplicate, so the same link posted twenty times
    // arrives as twenty simultaneous requests — none of which would find a cache
    // entry yet, since the first has not answered. Joining the running fetch keeps
    // that a single outbound request instead of twenty.
    const running = this.inFlight.get(url);
    if (running !== undefined) return { ...(await running), url };

    // Charged per outbound fetch rather than per request, which is what the
    // budget is actually protecting. Without a user there is no one to charge —
    // no caller passes that today, and the fetch stays behind the SSRF guard.
    if (userId !== undefined && !this.rateLimit.check('collab_link_preview', String(userId), PREVIEW_FETCHES_PER_MINUTE, 60_000, Date.now())) {
      return { ...fallback, rateLimited: true };
    }

    const task = this.fetchPreview(url, fallback);
    this.inFlight.set(url, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(url);
    }
  }

  /** The outbound half of linkPreview, past the cache and the budget. */
  private async fetchPreview(url: string, fallback: LinkPreviewResult): Promise<LinkPreviewResult> {
    const ssrf = await checkSsrf(url, true);
    if (!ssrf.allowed) {
      // The caller learns that the URL was refused, never why: the three distinct
      // reasons ("could not resolve", "private address", "loopback") would together
      // map out the server's internal DNS for anyone willing to guess hostnames.
      return { ...fallback, error: 'URL not allowed' };
    }

    const dispatcher = createPinnedDispatcher(ssrf.resolvedIp!);
    try {
      // AbortSignal.timeout covers the body as well. The hand-rolled controller
      // this replaces was cleared as soon as the headers arrived, so a server that
      // answered fast and then dripped the body one byte at a time held the handler,
      // the socket and this dispatcher open indefinitely — the byte cap counts
      // bytes, and at that rate it would never reach one.
      const r = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        dispatcher,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NOMAD/1.0; +https://github.com/mauriceboe/NOMAD)' },
      } as any);
      if (!r.ok) { discardBody(r); return this.cachePreview(url, fallback); }
      // Only markup is worth scraping. A declared type that is not HTML means the
      // regexes below would comb a video or an archive for og: tags and find nothing.
      const type = r.headers?.get('content-type') ?? '';
      if (type && !/^\s*(text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(type)) {
        discardBody(r);
        return this.cachePreview(url, fallback);
      }
      // An unread body keeps its socket reserved until the garbage collector runs,
      // which is the one thing a size cap is there to prevent.
      if (exceedsDeclaredLength(r, MAX_PREVIEW_BYTES)) { discardBody(r); return this.cachePreview(url, fallback); }

      // A truncated head still carries the tags we scrape, so a page over the
      // budget degrades to fewer fields rather than to an error.
      const { text: html } = await readCappedText(r, MAX_PREVIEW_BYTES);
      return this.cachePreview(url, { ...scrapeOpenGraph(html), url });
    } catch {
      return this.cachePreview(url, fallback);
    } finally {
      // Closed rather than left to the garbage collector: one Agent is built per
      // preview, and each keeps its sockets until something releases them.
      void (dispatcher as { close?: () => Promise<void> } | undefined)?.close?.()?.catch(() => {});
    }
  }

  /** A cached preview, or undefined once its entry has expired or was never there. */
  private readPreviewCache(url: string): LinkPreviewResult | undefined {
    const hit = this.previewCache.get(url);
    if (!hit) return undefined;
    if (Date.now() - hit.at > PREVIEW_CACHE_TTL_MS) {
      this.previewCache.delete(url);
      return undefined;
    }
    // Re-insert so the eviction below drops the least recently used entry.
    this.previewCache.delete(url);
    this.previewCache.set(url, hit);
    return { ...hit.result, url };
  }

  /** Stores a preview and returns it, so call sites can `return this.cachePreview(...)`. */
  private cachePreview(url: string, result: LinkPreviewResult): LinkPreviewResult {
    if (this.previewCache.size >= PREVIEW_CACHE_MAX) {
      const oldest = this.previewCache.keys().next().value;
      if (oldest !== undefined) this.previewCache.delete(oldest);
    }
    this.previewCache.set(url, { at: Date.now(), result });
    return result;
  }

  /** Fire-and-forget collab notification (mirrors the legacy route's dynamic import). */
  notifyCollab(tripId: string, actor: User, preview?: string): void {
    // Injected, not a lazy import of the old notifications bridge. The laziness bought
    // nothing the module graph does not already give — NotificationsModule
    // reaches nothing in this direction — and it hid the edge while handing the
    // send a second NotificationsService built outside the container.
    const tripInfo = this.db.get<{ title: string }>('SELECT title FROM trips WHERE id = ?', tripId);
    const params: Record<string, string> = { trip: tripInfo?.title || 'Untitled', actor: actor.email, tripId: String(tripId) };
    if (preview !== undefined) params.preview = preview;
    this.notifications.send({ event: 'collab_message', actorId: actor.id, scope: 'trip', targetId: Number(tripId), params }).catch(() => {});
  }
}
