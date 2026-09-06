import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeEnvService } from '../../../src/nest/app-config/runtime-env.service';
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

vi.mock('../../../src/nest/common/demo', () => ({ isDemoEmail: vi.fn(() => false) }));

import { FilesController } from '../../../src/nest/files/files.controller';
import { FilesDownloadController } from '../../../src/nest/files/files-download.controller';
import { PhotosController } from '../../../src/nest/photos/photos.controller';
import type { FilesService } from '../../../src/nest/files/files.service';
import type { PhotosService } from '../../../src/nest/photos/photos.service';
import type { StorageService } from '../../../src/nest/storage/storage.service';
import { isDemoEmail } from '../../../src/nest/common/demo';
import type { User } from '../../../src/types';

const user = { id: 1, username: 'u', role: 'user', email: 'u@example.test' } as User;

function fsvc(o: Partial<FilesService> = {}): FilesService {
  return {
    verifyTripAccess: vi.fn().mockReturnValue({ user_id: 1 }),
    can: vi.fn().mockReturnValue(true),
    findForeignLinkTarget: vi.fn().mockReturnValue(null),
    broadcast: vi.fn(),
    ...o,
  } as unknown as FilesService;
}

const storageStub = { put: vi.fn().mockResolvedValue(undefined) } as unknown as StorageService;

/** Construct the controller with the standard env + storage stubs. */
function fc(svc: FilesService): FilesController {
  return new FilesController(svc, new RuntimeEnvService(), storageStub);
}

function thrown(fn: () => unknown): { status: number; body: unknown } {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected throw');
}

async function rejected(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected reject');
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => { delete process.env.DEMO_MODE; });

/** The trip row TripAccessGuard resolves and hands to every handler via @Trip(). */
const trip = { id: 5, user_id: 42 } as never;

// The 404 "Trip not found" cases moved to trip-access.guard.test.ts with the check.
describe('FilesController (parity with the legacy /api/trips/:tripId/files route)', () => {
  it('GET / lists with the trash flag', () => {
    const listFiles = vi.fn().mockReturnValue([{ id: 1 }]);
    expect(fc(fsvc({ listFiles } as Partial<FilesService>)).list(user, trip, '5', 'true')).toEqual({ files: [{ id: 1 }] });
    expect(listFiles).toHaveBeenCalledWith('5', true);
  });

  describe('POST / (upload)', () => {
    it('404 without trip access — upload keeps its own check so the body is read first', async () => {
      // The guard would answer before multer, and a response sent mid-upload destroys
      // the socket: the caller would see ECONNRESET rather than this 404.
      const svc = fsvc({ verifyTripAccess: vi.fn().mockReturnValue(undefined) });
      expect(await rejected(fc(svc).upload(user, '5', undefined, {}))).toEqual({
        status: 404,
        body: { error: 'Trip not found' },
      });
    });

    const file = { filename: 'a.pdf' } as Express.Multer.File;
    it('403 in demo mode for a demo email', async () => {
      process.env.DEMO_MODE = 'true';
      vi.mocked(isDemoEmail).mockReturnValue(true);
      expect(await rejected(fc(fsvc()).upload(user, '5', file, {}))).toEqual({ status: 403, body: { error: 'Uploads are disabled in demo mode. Self-host TREK for full functionality.' } });
    });
    it('403 without file_upload, 400 without a file, else commits + creates + broadcasts', async () => {
      expect(await rejected(fc(fsvc({ can: vi.fn().mockReturnValue(false) })).upload(user, '5', file, {}))).toEqual({ status: 403, body: { error: 'No permission to upload files' } });
      expect(await rejected(fc(fsvc()).upload(user, '5', undefined, {}))).toEqual({ status: 400, body: { error: 'No file uploaded' } });
      const createFile = vi.fn().mockReturnValue({ id: 9 });
      const broadcast = vi.fn();
      const s = fsvc({ createFile, broadcast } as Partial<FilesService>);
      expect(await fc(s).upload(user, '5', file, { description: 'd' }, 'sock')).toEqual({ file: { id: 9 } });
      expect(storageStub.put).toHaveBeenCalledWith('files', 'a.pdf', { tmpPath: undefined });
      expect(createFile).toHaveBeenCalledWith('5', file, 1, { place_id: undefined, description: 'd', reservation_id: undefined });
      expect(broadcast).toHaveBeenCalledWith('5', 'file:created', { file: { id: 9 } }, 'sock');
    });

    it('caps non-video by extension and accepts large video; cleans up on rejection (#823)', async () => {
      const big = { filename: 'big.pdf', originalname: 'big.pdf', size: 60 * 1024 * 1024, path: '' } as Express.Multer.File;
      expect(await rejected(fc(fsvc()).upload(user, '5', big, {}))).toEqual({ status: 400, body: { error: 'File is too large' } });

      const createFile = vi.fn().mockReturnValue({ id: 9 });
      const vid = { filename: 'v.mp4', originalname: 'clip.mp4', size: 200 * 1024 * 1024, path: '' } as Express.Multer.File;
      expect(await fc(fsvc({ createFile, broadcast: vi.fn() } as Partial<FilesService>)).upload(user, '5', vid, {})).toEqual({ file: { id: 9 } });

      // A rejected upload with a real path triggers the unlink cleanup branch
      // (the file doesn't exist, so the inner best-effort catch swallows it).
      const withPath = { filename: 'a.pdf', path: '/nonexistent/zzz.pdf' } as Express.Multer.File;
      expect(await rejected(fc(fsvc({ can: vi.fn().mockReturnValue(false) })).upload(user, '5', withPath, {}))).toEqual({ status: 403, body: { error: 'No permission to upload files' } });
    });

    it('passes budget_item_id to assertLinkTargets and createFile on upload, rejecting foreign targets', async () => {
      const file = { filename: 'a.pdf' } as Express.Multer.File;
      const rejectSvc = fsvc({ findForeignLinkTarget: vi.fn().mockReturnValue('budget_item_id') });
      expect(await rejected(fc(rejectSvc).upload(user, '5', file, { budget_item_id: '99' }))).toEqual({
        status: 400,
        body: { error: 'Linked item does not belong to this trip' },
      });

      const createFile = vi.fn().mockReturnValue({ id: 10 });
      const okSvc = fsvc({ createFile, broadcast: vi.fn() });
      await fc(okSvc).upload(user, '5', file, { budget_item_id: '12' });
      expect(createFile).toHaveBeenCalledWith('5', file, 1, {
        place_id: undefined,
        description: undefined,
        reservation_id: undefined,
        budget_item_id: '12',
      });
    });

    it('500 with cleanup when the storage commit fails', async () => {
      vi.mocked(storageStub.put).mockRejectedValueOnce(new Error('disk full'));
      const withPath = { filename: 'a.pdf', path: '/nonexistent/zzz.pdf' } as Express.Multer.File;
      await expect(fc(fsvc()).upload(user, '5', withPath, {})).rejects.toThrow('disk full');
    });
  });

  it('PUT /:id 403 without file_edit, 404 unknown, else updates + broadcasts', () => {
    expect(thrown(() => fc(fsvc({ can: vi.fn().mockReturnValue(false) })).update(user, trip, '5', '9', {}))).toEqual({ status: 403, body: { error: 'No permission to edit files' } });
    expect(thrown(() => fc(fsvc({ getFileById: vi.fn().mockReturnValue(undefined) } as Partial<FilesService>)).update(user, trip, '5', '9', {}))).toEqual({ status: 404, body: { error: 'File not found' } });
    const updateFile = vi.fn().mockReturnValue({ id: 9 });
    const s = fsvc({ getFileById: vi.fn().mockReturnValue({ id: 9, description: 'x' }), updateFile, broadcast: vi.fn() } as Partial<FilesService>);
    expect(fc(s).update(user, trip, '5', '9', { description: 'new' })).toEqual({ file: { id: 9 } });
  });

  it('passes budget_item_id to assertLinkTargets and updateFile on update, rejecting foreign targets', () => {
    const rejectSvc = fsvc({
      getFileById: vi.fn().mockReturnValue({ id: 9 }),
      findForeignLinkTarget: vi.fn().mockReturnValue('budget_item_id'),
    });
    expect(thrown(() => fc(rejectSvc).update(user, trip, '5', '9', { budget_item_id: '99' }))).toEqual({
      status: 400,
      body: { error: 'Linked item does not belong to this trip' },
    });

    const updateFile = vi.fn().mockReturnValue({ id: 9 });
    const okSvc = fsvc({
      getFileById: vi.fn().mockReturnValue({ id: 9 }),
      updateFile,
      broadcast: vi.fn(),
    });
    fc(okSvc).update(user, trip, '5', '9', { budget_item_id: '12' });
    expect(updateFile).toHaveBeenCalledWith('9', { id: 9 }, {
      description: undefined,
      place_id: undefined,
      reservation_id: undefined,
      budget_item_id: '12',
    });
  });

  it('PATCH /:id/star 403/404, else toggles', () => {
    expect(thrown(() => fc(fsvc({ can: vi.fn().mockReturnValue(false) })).star(user, trip, '5', '9'))).toEqual({ status: 403, body: { error: 'No permission' } });
    expect(thrown(() => fc(fsvc({ getFileById: vi.fn().mockReturnValue(undefined) } as Partial<FilesService>)).star(user, trip, '5', '9'))).toEqual({ status: 404, body: { error: 'File not found' } });
    const toggleStarred = vi.fn().mockReturnValue({ id: 9, starred: 1 });
    const s = fsvc({ getFileById: vi.fn().mockReturnValue({ id: 9, starred: 0 }), toggleStarred, broadcast: vi.fn() } as Partial<FilesService>);
    expect(fc(s).star(user, trip, '5', '9')).toEqual({ file: { id: 9, starred: 1 } });
    expect(toggleStarred).toHaveBeenCalledWith('9', 0);
  });

  it('DELETE /:id soft-delete 403/404, else success', () => {
    expect(thrown(() => fc(fsvc({ can: vi.fn().mockReturnValue(false) })).remove(user, trip, '5', '9'))).toEqual({ status: 403, body: { error: 'No permission to delete files' } });
    expect(thrown(() => fc(fsvc({ getFileById: vi.fn().mockReturnValue(undefined) } as Partial<FilesService>)).remove(user, trip, '5', '9'))).toEqual({ status: 404, body: { error: 'File not found' } });
    const softDeleteFile = vi.fn();
    const broadcast = vi.fn();
    const s = fsvc({ getFileById: vi.fn().mockReturnValue({ id: 9 }), softDeleteFile, broadcast } as Partial<FilesService>);
    expect(fc(s).remove(user, trip, '5', '9', 'sock')).toEqual({ success: true });
    expect(broadcast).toHaveBeenCalledWith('5', 'file:deleted', { fileId: 9 }, 'sock');
  });

  it('POST /:id/restore 404 not in trash, else restores', () => {
    expect(thrown(() => fc(fsvc({ getDeletedFile: vi.fn().mockReturnValue(undefined) } as Partial<FilesService>)).restore(user, trip, '5', '9'))).toEqual({ status: 404, body: { error: 'File not found in trash' } });
    const restoreFile = vi.fn().mockReturnValue({ id: 9 });
    const s = fsvc({ getDeletedFile: vi.fn().mockReturnValue({ id: 9 }), restoreFile, broadcast: vi.fn() } as Partial<FilesService>);
    expect(fc(s).restore(user, trip, '5', '9')).toEqual({ file: { id: 9 } });
  });

  it('DELETE /:id/permanent 404 not in trash, else deletes', async () => {
    await expect(fc(fsvc({ getDeletedFile: vi.fn().mockReturnValue(undefined) } as Partial<FilesService>)).permanent(user, trip, '5', '9')).rejects.toBeInstanceOf(HttpException);
    const permanentDeleteFile = vi.fn().mockResolvedValue(undefined);
    const s = fsvc({ getDeletedFile: vi.fn().mockReturnValue({ id: 9 }), permanentDeleteFile, broadcast: vi.fn() } as Partial<FilesService>);
    expect(await fc(s).permanent(user, trip, '5', '9')).toEqual({ success: true });
  });

  it('DELETE /trash/empty 403, else returns the count', async () => {
    await expect(fc(fsvc({ can: vi.fn().mockReturnValue(false) })).emptyTrash(user, trip, '5')).rejects.toBeInstanceOf(HttpException);
    const s = fsvc({ emptyTrash: vi.fn().mockResolvedValue(3) } as Partial<FilesService>);
    expect(await fc(s).emptyTrash(user, trip, '5')).toEqual({ success: true, deleted: 3 });
  });

  it('POST /:id/link 404 unknown file, else links', () => {
    expect(thrown(() => fc(fsvc({ getFileById: vi.fn().mockReturnValue(undefined) } as Partial<FilesService>)).link(user, trip, '5', '9', {}))).toEqual({ status: 404, body: { error: 'File not found' } });
    const createFileLink = vi.fn().mockReturnValue([{ id: 1 }]);
    const s = fsvc({ getFileById: vi.fn().mockReturnValue({ id: 9 }), createFileLink } as Partial<FilesService>);
    expect(fc(s).link(user, trip, '5', '9', { reservation_id: 2 })).toEqual({ success: true, links: [{ id: 1 }] });
  });

  it('DELETE /:id/link/:linkId removes the link; GET /:id/links lists', () => {
    const deleteFileLink = vi.fn();
    expect(fc(fsvc({ getFileById: vi.fn().mockReturnValue({ id: 9 }), deleteFileLink } as Partial<FilesService>)).unlink(user, trip, '5', '9', '3')).toEqual({ success: true });
    expect(deleteFileLink).toHaveBeenCalledWith('3', '9');
    const s = fsvc({ getFileById: vi.fn().mockReturnValue({ id: 9 }), getFileLinks: vi.fn().mockReturnValue([{ id: 1 }]) } as Partial<FilesService>);
    expect(fc(s).links(user, trip, '5', '9')).toEqual({ links: [{ id: 1 }] });
  });

  it('the link routes resolve the file against :tripId, so a foreign file is 404', () => {
    const foreign = () => fsvc({ getFileById: vi.fn().mockReturnValue(undefined), deleteFileLink: vi.fn(), getFileLinks: vi.fn() } as Partial<FilesService>);
    const unlinkSvc = foreign();
    expect(thrown(() => fc(unlinkSvc).unlink(user, trip, '5', '9', '3'))).toEqual({ status: 404, body: { error: 'File not found' } });
    expect(unlinkSvc.deleteFileLink).not.toHaveBeenCalled();
    const listSvc = foreign();
    expect(thrown(() => fc(listSvc).links(user, trip, '5', '9'))).toEqual({ status: 404, body: { error: 'File not found' } });
    expect(listSvc.getFileLinks).not.toHaveBeenCalled();
  });

  it('the trash + link routes all reject without file_delete / file_edit', async () => {
    const denied = () => fsvc({ can: vi.fn().mockReturnValue(false) });
    await expect(fc(denied()).permanent(user, trip, '5', '9')).rejects.toMatchObject({ status: 403 });
    expect(thrown(() => fc(denied()).restore(user, trip, '5', '9'))).toEqual({ status: 403, body: { error: 'No permission' } });
    expect(thrown(() => fc(denied()).link(user, trip, '5', '9', {}))).toEqual({ status: 403, body: { error: 'No permission' } });
    expect(thrown(() => fc(denied()).unlink(user, trip, '5', '9', '3'))).toEqual({ status: 403, body: { error: 'No permission' } });
  });

});

describe('FilesDownloadController', () => {
  function dsvc(o: Partial<FilesService> = {}): FilesService {
    return {
      authenticateDownload: vi.fn().mockReturnValue({ userId: 1 }),
      verifyTripAccess: vi.fn().mockReturnValue({ user_id: 1 }),
      getFileById: vi.fn().mockReturnValue({ filename: 'x.pdf', original_name: 'x.pdf' }),
      ...o,
    } as unknown as FilesService;
  }
  function dstor(o: Record<string, unknown> = {}): StorageService {
    return {
      exists: vi.fn().mockResolvedValue(true),
      sendToResponse: vi.fn().mockResolvedValue(undefined),
      ...o,
    } as unknown as StorageService;
  }
  const req = { headers: {}, query: {} } as Request;
  const res = {} as Response;

  it('maps the auth error from authenticateDownload', async () => {
    const s = dsvc({ authenticateDownload: vi.fn().mockReturnValue({ error: 'Authentication required', status: 401 }) });
    expect(await rejected(new FilesDownloadController(s, dstor()).download(req, res, '5', '9'))).toEqual({ status: 401, body: { error: 'Authentication required' } });
  });

  it('404 without trip access and 404 for an unknown file', async () => {
    expect(await rejected(new FilesDownloadController(dsvc({ verifyTripAccess: vi.fn().mockReturnValue(undefined) }), dstor()).download(req, res, '5', '9'))).toEqual({ status: 404, body: { error: 'Trip not found' } });
    expect(await rejected(new FilesDownloadController(dsvc({ getFileById: vi.fn().mockReturnValue(undefined) }), dstor()).download(req, res, '5', '9'))).toEqual({ status: 404, body: { error: 'File not found' } });
  });

  it('404 when the object is gone from storage', async () => {
    const storage = dstor({ exists: vi.fn().mockResolvedValue(false) });
    expect(await rejected(new FilesDownloadController(dsvc(), storage).download(req, res, '5', '9'))).toEqual({ status: 404, body: { error: 'File not found' } });
  });

  it('404 when the stored name is an invalid key (exists rejects)', async () => {
    const storage = dstor({ exists: vi.fn().mockRejectedValue(new Error('invalid storage key')) });
    expect(await rejected(new FilesDownloadController(dsvc(), storage).download(req, res, '5', '9'))).toEqual({ status: 404, body: { error: 'File not found' } });
  });

  it('streams a regular file through storage with no wallet headers', async () => {
    const storage = dstor();
    await new FilesDownloadController(dsvc(), storage).download(req, res, '5', '9');
    expect(storage.exists).toHaveBeenCalledWith('files', 'x.pdf');
    expect(storage.sendToResponse).toHaveBeenCalledWith('files', 'x.pdf', res, undefined);
  });

  it('tolerates a stray prefixed row via basename(), same as the download controller', async () => {
    const storage = dstor();
    const s = dsvc({ getFileById: vi.fn().mockReturnValue({ filename: 'files/x.pdf', original_name: 'x.pdf' }) });
    await new FilesDownloadController(s, storage).download(req, res, '5', '9');
    expect(storage.sendToResponse).toHaveBeenCalledWith('files', 'x.pdf', res, undefined);
  });

  it('serves a .pkpass inline with the Wallet MIME type and the original name', async () => {
    const storage = dstor();
    const s = dsvc({ getFileById: vi.fn().mockReturnValue({ filename: 'pass.pkpass', original_name: 'BoardingPass.pkpass' }) });
    await new FilesDownloadController(s, storage).download(req, res, '5', '9');
    expect(storage.sendToResponse).toHaveBeenCalledWith('files', 'pass.pkpass', res, {
      contentType: 'application/vnd.apple.pkpass',
      disposition: 'inline; filename="BoardingPass.pkpass"',
    });
  });

  it('serves a .pkpasses bundle inline with its own Wallet MIME type', async () => {
    const storage = dstor();
    const s = dsvc({ getFileById: vi.fn().mockReturnValue({ filename: 'passes.pkpasses', original_name: 'BoardingPasses.pkpasses' }) });
    await new FilesDownloadController(s, storage).download(req, res, '5', '9');
    expect(storage.sendToResponse).toHaveBeenCalledWith('files', 'passes.pkpasses', res, {
      contentType: 'application/vnd.apple.pkpasses',
      disposition: 'inline; filename="BoardingPasses.pkpasses"',
    });
  });

  it('falls back to the stored basename when a .pkpass has no original name', async () => {
    const storage = dstor();
    const s = dsvc({ getFileById: vi.fn().mockReturnValue({ filename: 'pass.pkpass', original_name: null }) });
    await new FilesDownloadController(s, storage).download(req, res, '5', '9');
    expect(storage.sendToResponse).toHaveBeenCalledWith('files', 'pass.pkpass', res, {
      contentType: 'application/vnd.apple.pkpass',
      disposition: 'inline; filename="pass.pkpass"',
    });
  });

  // Uploads store original_name raw, so a Japanese boarding pass used to hand
  // setHeader a value it throws on (#2165) — storage.service.ts documents the
  // throw as reachable; now the header is ASCII with the real name in filename*.
  it('folds a non-ASCII original name to ASCII + filename* instead of crashing setHeader (#2165)', async () => {
    const storage = dstor();
    const s = dsvc({ getFileById: vi.fn().mockReturnValue({ filename: 'pass.pkpass', original_name: '搭乗券.pkpass' }) });
    await new FilesDownloadController(s, storage).download(req, res, '5', '9');
    expect(storage.sendToResponse).toHaveBeenCalledWith('files', 'pass.pkpass', res, {
      contentType: 'application/vnd.apple.pkpass',
      disposition: 'inline; filename="download.pkpass"; filename*=UTF-8\'\'%E6%90%AD%E4%B9%97%E5%88%B8.pkpass',
    });
  });
});

describe('PhotosController', () => {
  const user2 = { id: 1 } as User;
  function psvc(o: Partial<PhotosService> = {}): PhotosService {
    return { canAccess: vi.fn().mockReturnValue(true), stream: vi.fn().mockResolvedValue(undefined), info: vi.fn(), ...o } as unknown as PhotosService;
  }
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;

  it('400 on a non-finite id, 403 without access', async () => {
    await expect(new PhotosController(psvc()).thumbnail(user2, 'abc', res)).rejects.toMatchObject({ status: 400 });
    await expect(new PhotosController(psvc({ canAccess: vi.fn().mockReturnValue(false) })).original(user2, '5', res)).rejects.toMatchObject({ status: 403 });
  });

  it('streams thumbnail/original', async () => {
    const stream = vi.fn().mockResolvedValue(undefined);
    const c = new PhotosController(psvc({ stream }));
    await c.thumbnail(user2, '5', res);
    expect(stream).toHaveBeenCalledWith(res, 1, 5, 'thumbnail');
    await c.original(user2, '5', res);
    expect(stream).toHaveBeenCalledWith(res, 1, 5, 'original', undefined);
  });

  it('info writes the data, maps a service error', async () => {
    const okRes = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    await new PhotosController(psvc({ info: vi.fn().mockResolvedValue({ data: { id: '5' } }) })).info(user2, '5', okRes);
    expect(okRes.json).toHaveBeenCalledWith({ id: '5' });
    const errRes = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    await new PhotosController(psvc({ info: vi.fn().mockResolvedValue({ error: { status: 404, message: 'Photo not found' } }) })).info(user2, '5', errRes);
    expect(errRes.status).toHaveBeenCalledWith(404);
    expect(errRes.json).toHaveBeenCalledWith({ error: 'Photo not found' });
  });
});
