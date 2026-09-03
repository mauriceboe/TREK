/**
 * The admin plugin controller's signature surface (#plugins): the machine-readable
 * refusal code reaching the WIRE, and the re-trust endpoint.
 *
 * The code is tested through the real TrekExceptionFilter rather than on the thrown
 * object, because that filter is the one thing standing between the code and the client
 * — and the whole design rests on the client being able to distinguish "the author
 * rotated their key" (overridable) from "these bytes are not what the author signed"
 * (never overridable) WITHOUT string-matching prose. If the code silently died in the
 * envelope, every test on the thrown object would still pass and the UI would be
 * guessing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpException, type ArgumentsHost } from '@nestjs/common';

vi.mock('../../../src/db/database', () => ({ db: {}, canAccessTrip: () => undefined }));

import { PluginsController } from '../../../src/nest/plugins/plugins.controller';
import { PluginRuntimeService } from '../../../src/nest/plugins/plugin-runtime.service';
import { PluginRegistryService, RegistryError } from '../../../src/nest/plugins/registry/registry.service';
import { PluginsService } from '../../../src/nest/plugins/plugins.service';
import { TrekExceptionFilter } from '../../../src/nest/common/trek-exception.filter';
import type { RuntimeEnvService } from '../../../src/nest/app-config/runtime-env.service';

const ADMIN = { id: 1 } as { id: number };
const REQ = { headers: {}, socket: {} } as never;

/** Run an exception through the real global filter and report what the client would see. */
function throughFilter(e: unknown): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) };
  new TrekExceptionFilter().catch(e, { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost);
  return { status, body };
}

/** Drive a controller call and return the wire response of its failure. */
async function wireFailure(fn: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await fn();
    throw new Error('expected the call to fail');
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return throughFilter(e);
  }
}

let runtime: PluginRuntimeService;
let registry: PluginRegistryService;
let controller: PluginsController;

let plugins: PluginsService;

beforeEach(() => {
  process.env.TREK_PLUGINS_ENABLED = 'true';
  runtime = { update: vi.fn(), retrust: vi.fn() } as unknown as PluginRuntimeService;
  registry = { install: vi.fn(), installWithDependencies: vi.fn(), recomputeUpdateHold: vi.fn() } as unknown as PluginRegistryService;
  plugins = { resumeUpdates: vi.fn(() => true) } as unknown as PluginsService;
  controller = new PluginsController(plugins, runtime, registry, { isManaged: () => false } as unknown as RuntimeEnvService);
});

describe('signature refusal codes survive to the client', () => {
  it('POST :id/update carries { error, code } through the exception filter', async () => {
    vi.mocked(runtime.update).mockRejectedValue(
      new RegistryError("the plugin's author signing key changed since it was installed", 'SIGNATURE_KEY_CHANGED'),
    );

    const { status, body } = await wireFailure(() => controller.update('flight-tracker'));
    expect(status).toBe(400);
    expect(body).toEqual({
      error: "the plugin's author signing key changed since it was installed",
      code: 'SIGNATURE_KEY_CHANGED',
    });
  });

  it('POST install carries { error, code } through the exception filter', async () => {
    vi.mocked(registry.install).mockRejectedValue(new RegistryError('author signature verification failed', 'SIGNATURE_INVALID'));

    const { status, body } = await wireFailure(() => controller.install({ id: 'flight-tracker' }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'author signature verification failed', code: 'SIGNATURE_INVALID' });
  });

  // A SIGNATURE_INVALID reaching the client as a bare { error } would leave the UI unable
  // to tell it apart from a rotation — and a UI that guesses will eventually offer
  // "re-trust" on bytes the author never signed.
  it('an INVALID signature arrives with its own code, not the re-trustable one', async () => {
    vi.mocked(runtime.update).mockRejectedValue(new RegistryError('author signature verification failed', 'SIGNATURE_INVALID'));

    const { body } = await wireFailure(() => controller.update('flight-tracker'));
    expect((body as { code: string }).code).toBe('SIGNATURE_INVALID');
    expect((body as { code: string }).code).not.toBe('SIGNATURE_KEY_CHANGED');
  });

  it('an ordinary failure with no code still emits the plain { error } envelope', async () => {
    vi.mocked(runtime.update).mockRejectedValue(new Error('network unreachable'));

    const { status, body } = await wireFailure(() => controller.update('flight-tracker'));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'network unreachable' });
  });
});

// The rollback path: an admin picks a specific (possibly older) version, and the runtime
// must install exactly that one — the compat gate stays server-side in selectVersion.
describe('POST :id/update — explicit version', () => {
  it('forwards the requested version to the runtime', async () => {
    vi.mocked(runtime.update).mockResolvedValue({ version: '1.2.0', activated: true, newPermissions: [], newEgress: [], trekRangeBypassed: null });

    const res = await controller.update('flight-tracker', { version: '1.2.0' });

    expect(vi.mocked(runtime.update).mock.calls[0]).toEqual(['flight-tracker', { version: '1.2.0' }]);
    expect(res).toEqual({ version: '1.2.0', activated: true, newPermissions: [], newEgress: [], trekRangeBypassed: null });
  });

  it('an omitted body keeps the default newest-compatible resolution', async () => {
    vi.mocked(runtime.update).mockResolvedValue({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [], trekRangeBypassed: null });

    await controller.update('flight-tracker');

    expect(vi.mocked(runtime.update).mock.calls[0]).toEqual(['flight-tracker', { version: undefined }]);
  });
});

// The update hold: only a DELIBERATE version pick may set it, every successful
// install/update recomputes it (so landing back on the newest clears a stale one),
// and dependency resolution — which pins versions too, but never deliberately —
// must not touch it.
describe('update hold wiring', () => {
  it('an explicit-version update recomputes the hold as deliberate', async () => {
    vi.mocked(runtime.update).mockResolvedValue({ version: '1.2.0', activated: true, newPermissions: [], newEgress: [], trekRangeBypassed: null });

    await controller.update('flight-tracker', { version: '1.2.0' });

    expect(registry.recomputeUpdateHold).toHaveBeenCalledWith('flight-tracker', '1.2.0', true);
  });

  it('a default update recomputes as non-deliberate (clears a stale hold)', async () => {
    vi.mocked(runtime.update).mockResolvedValue({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [], trekRangeBypassed: null });

    await controller.update('flight-tracker');

    expect(registry.recomputeUpdateHold).toHaveBeenCalledWith('flight-tracker', '2.0.0', false);
  });

  it('an explicit-version install recomputes the hold as deliberate', async () => {
    vi.mocked(registry.install).mockResolvedValue({ id: 'flight-tracker', version: '1.2.0', trekRangeBypassed: null });

    await controller.install({ id: 'flight-tracker', version: '1.2.0' });

    expect(registry.recomputeUpdateHold).toHaveBeenCalledWith('flight-tracker', '1.2.0', true);
  });

  it('a dependency-resolution install does NOT touch the hold', async () => {
    vi.mocked(registry.installWithDependencies).mockResolvedValue({ installed: ['flight-tracker'], requiredAddons: [], trekRangeBypassed: null });

    await controller.install({ id: 'flight-tracker', withDependencies: true });

    expect(registry.recomputeUpdateHold).not.toHaveBeenCalled();
  });

  it('a failed update leaves the hold untouched', async () => {
    vi.mocked(runtime.update).mockRejectedValue(new Error('network unreachable'));

    await expect(controller.update('flight-tracker', { version: '1.2.0' })).rejects.toThrow(HttpException);

    expect(registry.recomputeUpdateHold).not.toHaveBeenCalled();
  });

  it('POST :id/resume-updates clears the hold', async () => {
    const res = await controller.resumeUpdates('flight-tracker');

    expect(plugins.resumeUpdates).toHaveBeenCalledWith('flight-tracker');
    expect(res).toEqual({ updateHold: false });
  });

  it('POST :id/resume-updates is a 404 for an unknown plugin', async () => {
    vi.mocked(plugins.resumeUpdates).mockReturnValue(false);

    const { status } = await wireFailure(async () => controller.resumeUpdates('ghost'));
    expect(status).toBe(404);
  });
});

describe('POST :id/retrust', () => {
  it('re-pins AND installs in one call, returning the update result', async () => {
    vi.mocked(runtime.retrust).mockResolvedValue({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] });

    const res = await controller.retrust('flight-tracker', { version: '2.0.0', publicKey: 'NEWKEY' }, ADMIN, REQ);

    expect(res).toEqual({ version: '2.0.0', activated: true, newPermissions: [], newEgress: [] });
    // The version + the full key the admin was SHOWN are both forwarded: the version
    // because the artifact bytes must be fetched to verify them under the new key, the
    // full key (not a fingerprint) because the server's equality check must be exact.
    expect(runtime.retrust).toHaveBeenCalledWith('flight-tracker', '2.0.0', 'NEWKEY', expect.objectContaining({ userId: 1 }));
  });

  it('requires the version and the public key', async () => {
    await expect(controller.retrust('flight-tracker', { publicKey: 'K' }, ADMIN, REQ)).rejects.toThrow(HttpException);
    await expect(controller.retrust('flight-tracker', { version: '2.0.0' }, ADMIN, REQ)).rejects.toThrow(HttpException);
    expect(runtime.retrust).not.toHaveBeenCalled();
  });

  // D2 at the HTTP boundary: the service refuses anything but a changed key, and the
  // refusal reaches the client with its code intact. Hiding the button in the UI is a
  // convenience — THIS is the control.
  it('surfaces the service refusal (with its code) when the condition is not a changed key', async () => {
    vi.mocked(runtime.retrust).mockRejectedValue(
      new RegistryError("this plugin's signing key has not changed — there is nothing to re-trust", 'RETRUST_NOT_APPLICABLE'),
    );

    const { status, body } = await wireFailure(() =>
      controller.retrust('flight-tracker', { version: '2.0.0', publicKey: 'K' }, ADMIN, REQ),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'RETRUST_NOT_APPLICABLE' });
  });

  it('surfaces a TOCTOU key mismatch (the entry was re-keyed since the dialog rendered)', async () => {
    vi.mocked(runtime.retrust).mockRejectedValue(new RegistryError('the signing key changed again', 'RETRUST_KEY_MISMATCH'));

    const { body } = await wireFailure(() => controller.retrust('flight-tracker', { version: '2.0.0', publicKey: 'STALE' }, ADMIN, REQ));
    expect(body).toMatchObject({ code: 'RETRUST_KEY_MISMATCH' });
  });

  // A plugin that isn't there is a 404, not a 400 — the request was well-formed. The code
  // still rides along, so a client that keys off it keeps working either way.
  it('answers 404 (not 400) for a plugin that does not exist', async () => {
    vi.mocked(runtime.retrust).mockRejectedValue(new RegistryError('plugin ghost not found', 'NOT_FOUND'));

    const { status, body } = await wireFailure(() => controller.retrust('ghost', { version: '2.0.0', publicKey: 'K' }, ADMIN, REQ));
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'plugin ghost not found', code: 'NOT_FOUND' });
  });

  // The 404 is scoped to NOT_FOUND alone. Every other refusal on this surface — and every
  // install/update failure, which never carries that code — stays a 400.
  it('leaves every other refusal on 400', async () => {
    vi.mocked(runtime.retrust).mockRejectedValue(new RegistryError('nothing to re-trust', 'RETRUST_NOT_APPLICABLE'));
    expect((await wireFailure(() => controller.retrust('p', { version: '1', publicKey: 'K' }, ADMIN, REQ))).status).toBe(400);

    vi.mocked(registry.install).mockRejectedValue(new RegistryError('plugin ghost not in registry'));
    expect((await wireFailure(() => controller.install({ id: 'ghost' }))).status).toBe(400);
  });

  it('is refused when the plugin runtime is disabled by server configuration', async () => {
    process.env.TREK_PLUGINS_ENABLED = 'false';
    const { status } = await wireFailure(() => controller.retrust('flight-tracker', { version: '2.0.0', publicKey: 'K' }, ADMIN, REQ));
    expect(status).toBe(503);
    expect(runtime.retrust).not.toHaveBeenCalled();
  });

  // Re-trusting a signing key is an admin act, and there is no non-admin route to it:
  // the guards sit on the CLASS, so every route on this controller — including the one
  // added here — is behind them. Asserted on the metadata rather than on one handler, so
  // it keeps holding for routes added later.
  it('is admin-only (the guards are class-level, so retrust inherits them)', () => {
    const guards = (Reflect.getMetadata('__guards__', PluginsController) ?? []) as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toEqual(['JwtAuthGuard', 'AdminGuard']);
  });
});
