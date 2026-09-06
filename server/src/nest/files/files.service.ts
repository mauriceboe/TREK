import { Injectable } from '@nestjs/common';
import path from 'path';
import type { Readable } from 'node:stream';
import type { Request } from 'express';
import type { TrekWsPayload, TrekWsTripEventName } from '@trek/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { PermissionsService } from '../permissions/permissions.service';
import { avatarUrl } from '../common/avatarUrl';
import { EphemeralTokenService } from '../auth/ephemeral-token.service';
import { verifyJwtAndLoadUser } from '../auth/jwt-verify';
import type { User, TripFile } from '../../types';
import { DatabaseService, type TripAccess } from '../database/database.service';
import { DEFAULT_ALLOWED_EXTENSIONS } from './files.constants';
import { StorageService } from '../storage/storage.service';
import { StorageNotFoundError, StorageInvalidKeyError, type ObjectStat } from '../storage/storage.types';

type Trip = TripAccess;
type FilePermission = 'file_upload' | 'file_edit' | 'file_delete';

const FILE_SELECT = `
  SELECT f.*, r.title as reservation_title, u.username as uploaded_by_name, u.avatar as uploaded_by_avatar
  FROM trip_files f
  LEFT JOIN reservations r ON f.reservation_id = r.id
  LEFT JOIN users u ON f.uploaded_by = u.id
`;

function formatFile(file: TripFile & { uploaded_by_avatar?: string | null }) {
  const tripId = file.trip_id;
  return {
    ...file,
    url: `/api/trips/${tripId}/files/${file.id}/download`,
    uploaded_by_avatar: avatarUrl({ avatar: file.uploaded_by_avatar }),
  };
}

export interface FileLink {
  file_id: number;
  reservation_id: number | null;
  place_id: number | null;
  budget_item_id: number | null;
}

/**
 * Decoded bytes one non-HTTP caller may pull out of a file in a single read.
 * The browser download streams instead and is not bound by this.
 */
export const FILE_CONTENT_MAX = 10 * 1024 * 1024;

/** Why a content read was refused. Each caller maps it onto its own error shape. */
export type FileContentRefusal = 'not-found' | 'too-large' | 'not-accessible';

export class FileContentError extends Error {
  constructor(readonly reason: FileContentRefusal, message: string) {
    super(message);
  }
}

/**
 * File domain service — owns the file SQL (moved 1:1 from the legacy
 * services/fileService.ts: identical statements, the `||` falsy-coercion
 * defaults, the post-write FILE_SELECT re-selects, the dynamic IN batches and
 * the unlink-first delete semantics). Trip access goes through the injected
 * DatabaseService's canAccessTrip (the legacy verifyTripAccess re-export was a
 * plain wrapper over the same helper); the file_* permissions, path-resolution
 * guard, download-token auth and WebSocket broadcasts are unchanged. The
 * load-time constants live in files.constants.ts; the admin allowed-types
 * live-read is AllowedFileTypesService (the single query owner since the
 * storage slice-2 consolidation).
 *
 * Two deliberate post-migration fixes over the legacy behavior: createFileLink
 * no longer swallows insert errors, and updateFile coerces an empty-string
 * description to NULL exactly like createFile does.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly permissions: PermissionsService,
    private readonly realtime: RealtimeService,
    private readonly tokens: EphemeralTokenService,
    private readonly storage: StorageService,
  ) {}

  verifyTripAccess(tripId: string | number, userId: number) {
    return this.db.canAccessTrip(tripId, userId);
  }

  can(action: FilePermission, trip: Trip, user: User): boolean {
    return this.permissions.checkPermission(action, user.role, trip.user_id, user.id, trip.user_id !== user.id);
  }

  broadcast<E extends TrekWsTripEventName>(tripId: string, event: E, payload: TrekWsPayload<E>, socketId: string | undefined): void {
    this.realtime.broadcast(tripId, event, payload, socketId);
  }

  // ---------------------------------------------------------------------------
  // Token-based download auth & safe path resolution (used by the unguarded
  // download route)
  // ---------------------------------------------------------------------------

  authenticateDownload(req: Request): { userId: number } | { error: string; status: number } {
    const cookieToken = (req as { cookies?: Record<string, string> }).cookies?.trek_session;
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader ? (authHeader.split(' ')[1] || undefined) : undefined;
    const queryToken = req.query.token as string | undefined;

    // Cookie and Bearer both carry a full JWT — try them first (cookie wins).
    const jwtToken = cookieToken || bearerToken;
    if (jwtToken) {
      // Use the shared helper so the password_version gate applies here too;
      // previously this bypassed the check and stolen download tokens stayed
      // valid across a password reset.
      const user = verifyJwtAndLoadUser(jwtToken);
      if (!user) return { error: 'Invalid or expired token', status: 401 };
      return { userId: user.id };
    }

    if (queryToken) {
      const uid = this.tokens.consume(queryToken, 'download');
      if (!uid) return { error: 'Invalid or expired token', status: 401 };
      return { userId: uid };
    }

    return { error: 'Authentication required', status: 401 };
  }

  // ---------------------------------------------------------------------------
  // Trip-scoped link validation
  // ---------------------------------------------------------------------------

  /**
   * A file, and any reservation / day-assignment / place it points at, must all
   * live in the same trip. FILE_SELECT and getFileLinks join the reservation and
   * return its title, so without this guard a member of trip A could aim a file
   * (or a file_link) at trip B's reservation id and read the title back. Returns
   * the first field that escapes `tripId`, or null when every supplied id belongs
   * to the trip. Absent / null / zero ids are ignored (they clear the link).
   */
  findForeignLinkTarget(
    tripId: string | number,
    opts: { reservation_id?: string | number | null; assignment_id?: string | number | null; place_id?: string | number | null; budget_item_id?: string | number | null }
  ): 'reservation_id' | 'assignment_id' | 'place_id' | 'budget_item_id' | null {
    if (opts.reservation_id && !this.db.get('SELECT 1 FROM reservations WHERE id = ? AND trip_id = ?', opts.reservation_id, tripId)) {
      return 'reservation_id';
    }
    if (opts.place_id && !this.db.get('SELECT 1 FROM places WHERE id = ? AND trip_id = ?', opts.place_id, tripId)) {
      return 'place_id';
    }
    if (opts.assignment_id && !this.db.get('SELECT 1 FROM day_assignments a JOIN days d ON a.day_id = d.id WHERE a.id = ? AND d.trip_id = ?', opts.assignment_id, tripId)) {
      return 'assignment_id';
    }
    if (opts.budget_item_id && !this.db.get('SELECT 1 FROM budget_items WHERE id = ? AND trip_id = ?', opts.budget_item_id, tripId)) {
      return 'budget_item_id';
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  getFileById(id: string | number, tripId: string | number): TripFile | undefined {
    return this.db.get<TripFile>('SELECT * FROM trip_files WHERE id = ? AND trip_id = ?', id, tripId);
  }

  getDeletedFile(id: string | number, tripId: string | number): TripFile | undefined {
    return this.db.get<TripFile>('SELECT * FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NOT NULL', id, tripId);
  }

  /**
   * A file's bytes for a caller that is not the browser download.
   *
   * Shared by the plugin RPC (ctx.files.getContent) and the MCP read tool so the
   * rules exist once. Three of them matter. The size is capped BEFORE the read,
   * so a 500MB video is never pulled into memory just to be refused afterwards.
   * The bytes come from the storage layer rather than from disk, so this keeps
   * working on S3 or a mirrored pair. And the read runs off the event loop:
   * 10MB of readFile on the host thread stalls every other request for its
   * duration.
   *
   * Access is the caller's job. REST-side that is trip access plus the file
   * row being on the trip, which the getFileById lookup below re-checks.
   */
  async readContent(
    tripId: string | number,
    fileId: string | number,
  ): Promise<{ name: string; mimetype: string; bytes: Buffer }> {
    const file = this.getFileById(fileId, tripId);
    if (!file || file.deleted_at) throw new FileContentError('not-found', `no file ${fileId} on trip ${tripId}`);
    if ((file.file_size ?? 0) > FILE_CONTENT_MAX) {
      throw new FileContentError('too-large', `file too large to read (>${FILE_CONTENT_MAX} bytes); use the download UI`);
    }
    let stream: Readable;
    let stat: ObjectStat;
    try {
      ({ stream, stat } = await this.storage.getStream('files', path.basename(file.filename)));
    } catch (err) {
      if (err instanceof StorageNotFoundError || err instanceof StorageInvalidKeyError) {
        throw new FileContentError('not-accessible', 'file path is not accessible');
      }
      throw err;
    }
    // Re-checked against the OBJECT, not the DB row: file_size can drift.
    if (stat.size > FILE_CONTENT_MAX) {
      stream.destroy();
      throw new FileContentError('too-large', `file too large to read (>${FILE_CONTENT_MAX} bytes); use the download UI`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += part.length;
      // A driver whose stat under-reports must not hand back an oversized
      // payload: abort as soon as the running total crosses the cap.
      if (total > FILE_CONTENT_MAX) {
        stream.destroy();
        throw new FileContentError('too-large', 'file too large to read');
      }
      chunks.push(part);
    }
    return {
      name: file.original_name,
      mimetype: file.mime_type ?? 'application/octet-stream',
      bytes: Buffer.concat(chunks),
    };
  }

  listFiles(tripId: string | number, showTrash: boolean) {
    const where = showTrash ? 'f.trip_id = ? AND f.deleted_at IS NOT NULL' : 'f.trip_id = ? AND f.deleted_at IS NULL';
    const files = this.db.all<TripFile>(`${FILE_SELECT} WHERE ${where} ORDER BY f.starred DESC, f.created_at DESC`, tripId);

    const fileIds = files.map(f => f.id);
    const linksMap: Record<number, FileLink[]> = {};
    if (fileIds.length > 0) {
      const placeholders = fileIds.map(() => '?').join(',');
      const links = this.db.all<FileLink>(`SELECT file_id, reservation_id, place_id, budget_item_id FROM file_links WHERE file_id IN (${placeholders})`, ...fileIds);
      for (const link of links) {
        if (!linksMap[link.file_id]) linksMap[link.file_id] = [];
        linksMap[link.file_id].push(link);
      }
    }

    return files.map(f => {
      const fileLinks = linksMap[f.id] || [];
      return {
        ...formatFile(f),
        linked_reservation_ids: fileLinks.filter(l => l.reservation_id).map(l => l.reservation_id),
        linked_place_ids: fileLinks.filter(l => l.place_id).map(l => l.place_id),
        linked_budget_item_ids: fileLinks.filter(l => l.budget_item_id).map(l => l.budget_item_id),
      };
    });
  }

  createFile(
    tripId: string | number,
    file: { filename: string; originalname: string; size: number; mimetype: string },
    uploadedBy: number,
    opts: { place_id?: string | number | null; reservation_id?: string | number | null; budget_item_id?: string | number | null; description?: string | null }
  ) {
    const result = this.db.run(`
      INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, description, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      tripId,
      opts.place_id || null,
      opts.reservation_id || null,
      file.filename,
      file.originalname,
      file.size,
      file.mimetype,
      opts.description || null,
      uploadedBy
    );

    if (opts.budget_item_id) {
      this.db.run('INSERT OR IGNORE INTO file_links (file_id, budget_item_id) VALUES (?, ?)', result.lastInsertRowid, opts.budget_item_id);
    }

    const created = this.db.get<TripFile>(`${FILE_SELECT} WHERE f.id = ?`, result.lastInsertRowid)!;
    return formatFile(created);
  }

  updateFile(
    id: string | number,
    current: TripFile,
    updates: { description?: string; place_id?: string | number | null; reservation_id?: string | number | null; budget_item_id?: string | number | null }
  ) {
    this.db.run(`
      UPDATE trip_files SET
        description = ?,
        place_id = ?,
        reservation_id = ?
      WHERE id = ?
    `,
      updates.description !== undefined ? (updates.description || null) : current.description,
      updates.place_id !== undefined ? (updates.place_id || null) : current.place_id,
      updates.reservation_id !== undefined ? (updates.reservation_id || null) : current.reservation_id,
      id
    );

    if (updates.budget_item_id !== undefined) {
      if (updates.budget_item_id) {
        this.db.run('INSERT OR IGNORE INTO file_links (file_id, budget_item_id) VALUES (?, ?)', id, updates.budget_item_id);
      } else {
        this.db.run('DELETE FROM file_links WHERE file_id = ? AND budget_item_id IS NOT NULL', id);
      }
    }

    const updated = this.db.get<TripFile>(`${FILE_SELECT} WHERE f.id = ?`, id)!;
    return formatFile(updated);
  }

  toggleStarred(id: string | number, currentStarred: number | undefined) {
    const newStarred = currentStarred ? 0 : 1;
    this.db.run('UPDATE trip_files SET starred = ? WHERE id = ?', newStarred, id);

    const updated = this.db.get<TripFile>(`${FILE_SELECT} WHERE f.id = ?`, id)!;
    return formatFile(updated);
  }

  softDeleteFile(id: string | number) {
    this.db.run('UPDATE trip_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', id);
  }

  restoreFile(id: string | number) {
    this.db.run('UPDATE trip_files SET deleted_at = NULL WHERE id = ?', id);
    const restored = this.db.get<TripFile>(`${FILE_SELECT} WHERE f.id = ?`, id)!;
    return formatFile(restored);
  }

  async permanentDeleteFile(file: TripFile): Promise<void> {
    // storage.delete is idempotent on a missing object (the old rm force:true
    // contract). Only drop the DB row when the delete either succeeded or the
    // object was already gone — otherwise a permission / ENOSPC failure
    // would orphan the bytes with no DB pointer left to clean them.
    try {
      await this.storage.delete('files', path.basename(file.filename));
    } catch (e) {
      console.error(`[files] unlink failed for ${file.filename}, keeping DB row:`, e);
      throw e;
    }
    this.db.run('DELETE FROM trip_files WHERE id = ?', file.id);
  }

  async emptyTrash(tripId: string | number): Promise<number> {
    const trashed = this.db.all<TripFile>('SELECT * FROM trip_files WHERE trip_id = ? AND deleted_at IS NOT NULL', tripId);
    // Collect successful IDs separately so we only DELETE rows whose disk
    // content was actually removed — failing unlinks keep their DB row
    // and a retry via the single-file delete path can try again.
    const successfullyUnlinked: number[] = [];
    await Promise.all(trashed.map(async (file) => {
      try {
        await this.storage.delete('files', path.basename(file.filename));
        successfullyUnlinked.push(Number(file.id));
      } catch (e) {
        console.error(`[files] unlink failed for ${file.filename}, keeping DB row:`, e);
      }
    }));
    if (successfullyUnlinked.length > 0) {
      const placeholders = successfullyUnlinked.map(() => '?').join(',');
      this.db.run(`DELETE FROM trip_files WHERE id IN (${placeholders})`, ...successfullyUnlinked);
    }
    return successfullyUnlinked.length;
  }

  // ---------------------------------------------------------------------------
  // File links (many-to-many)
  // ---------------------------------------------------------------------------

  // Dedupe rides INSERT OR IGNORE + the UNIQUE(file_id, <target>) constraints;
  // a genuine insert failure propagates to the global exception filter instead
  // of returning a success-shaped links list (the legacy catch swallowed it).
  createFileLink(
    fileId: string | number,
    opts: { reservation_id?: string | number | null; assignment_id?: string | number | null; place_id?: string | number | null; budget_item_id?: string | number | null }
  ) {
    this.db.run('INSERT OR IGNORE INTO file_links (file_id, reservation_id, assignment_id, place_id, budget_item_id) VALUES (?, ?, ?, ?, ?)',
      fileId, opts.reservation_id || null, opts.assignment_id || null, opts.place_id || null, opts.budget_item_id || null
    );
    return this.db.all('SELECT * FROM file_links WHERE file_id = ?', fileId);
  }

  deleteFileLink(linkId: string | number, fileId: string | number) {
    this.db.run('DELETE FROM file_links WHERE id = ? AND file_id = ?', linkId, fileId);
  }

  getFileLinks(fileId: string | number) {
    return this.db.all(`
      SELECT fl.*, r.title as reservation_title
      FROM file_links fl
      LEFT JOIN reservations r ON fl.reservation_id = r.id
      WHERE fl.file_id = ?
    `, fileId);
  }
}
