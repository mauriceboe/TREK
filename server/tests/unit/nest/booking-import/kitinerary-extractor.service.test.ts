import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The binary probe behind `GET /api/health/features`.
 *
 * It had no test at all, which matters more than the line count suggests: this
 * one boolean is what the client reads to decide whether to offer booking import
 * at all, and every branch that resolves it is a filesystem lookup that behaves
 * differently on the three platforms TREK ships to.
 */
const { existsSync, readdirSync, readEnv, execFileSync, execFile, logDebug } = vi.hoisted(() => ({
  logDebug: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readEnv: vi.fn(),
  execFileSync: vi.fn(),
  // A plain function, because the service promisifies it at module load.
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync,
  readdirSync,
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
// The last branch of the probe runs the candidate to see whether it works.
// Unmocked, the suite spawns a real process on every machine and comes back
// green-or-red depending on whether the developer happens to have KItinerary
// installed.
vi.mock('node:child_process', () => ({ execFileSync, execFile }));
vi.mock('../../../../src/app-config', () => ({ readEnv }));
// The logger reads readEnv().app.logLevel while its module is evaluated, so it
// has to be mocked rather than imported for real.
vi.mock('../../../../src/nest/audit/audit-log.logger', () => ({
  logDebug, logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
}));

import { join } from 'node:path';
import { KitineraryExtractorService } from '../../../../src/nest/booking-import/kitinerary-extractor.service';

// The probe builds candidates with path.join, so the expectations have to as
// well — on Windows the separator is a backslash and a hardcoded '/usr/...'
// string would never match.
const onPath = (dir: string) => join(dir, 'kitinerary-extractor');

function boot(env: { kitineraryExtractorPath?: string; searchPath?: string[] } = {}) {
  readEnv.mockReturnValue({ integrations: { searchPath: [], ...env } });
  const svc = new KitineraryExtractorService();
  svc.onModuleInit();
  return svc;
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
  readdirSync.mockReturnValue([]);
  execFileSync.mockImplementation(() => { throw new Error('command not found'); });
});

describe('KitineraryExtractorService binary probe', () => {
  it('KIT-EXT-001: takes the configured path when it exists', () => {
    existsSync.mockImplementation((p: string) => p === '/opt/kitinerary-extractor');
    expect(boot({ kitineraryExtractorPath: '/opt/kitinerary-extractor' }).isAvailable()).toBe(true);
  });

  it('KIT-EXT-002: an explicitly configured path that is missing disables the feature outright', () => {
    // It deliberately does NOT fall through to the search: somebody who set the
    // variable meant that binary, and silently using another one would hide the
    // typo behind a working feature.
    const svc = boot({ kitineraryExtractorPath: '/nope/kitinerary-extractor' });
    expect(svc.isAvailable()).toBe(false);
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it('KIT-EXT-003: finds the Debian multiarch location by scanning /usr/lib', () => {
    readdirSync.mockReturnValue(['x86_64-linux-gnu'] as never);
    existsSync.mockImplementation((p: string) => p.includes('x86_64-linux-gnu'));
    expect(boot().isAvailable()).toBe(true);
  });

  it('KIT-EXT-004: survives a system with no /usr/lib at all', () => {
    readdirSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(boot().isAvailable()).toBe(false);
  });

  it('KIT-EXT-005: reports unavailable when nothing is found, rather than throwing at boot', () => {
    expect(boot().isAvailable()).toBe(false);
  });

  it('KIT-EXT-006: extracting without a binary fails loudly', async () => {
    await expect(boot().extract(Buffer.from(''), 'x.pdf')).rejects.toThrow('not available');
  });

  it('KIT-EXT-007: falls back to a binary on the search path when nothing is on disk', () => {
    existsSync.mockImplementation((p: string) => p === onPath('/usr/local/bin'));
    execFileSync.mockReturnValue(Buffer.from(''));

    expect(boot({ searchPath: ['/usr/local/bin'] }).isAvailable()).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      onPath('/usr/local/bin'), ['--version'], expect.objectContaining({ timeout: 3000 }),
    );
  });

  it('KIT-EXT-008: stores the absolute path, never the bare name', async () => {
    existsSync.mockImplementation((p: string) => p === onPath('/opt/tools'));
    execFileSync.mockReturnValue(Buffer.from(''));
    execFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: null, r: unknown) => void) =>
      cb(null, { stdout: '[]', stderr: '' }));

    // An unqualified name would be re-resolved through PATH on every extraction,
    // so what the probe stores has to be the concrete file it verified.
    await boot({ searchPath: ['/opt/tools'] }).extract(Buffer.from(''), 'x.pdf');

    expect(execFile).toHaveBeenCalledWith(
      onPath('/opt/tools'), [expect.any(String)], expect.anything(), expect.anything(),
    );
  });

  it('KIT-EXT-009: a search-path entry that exists but will not run is skipped', () => {
    existsSync.mockReturnValue(true);
    execFileSync.mockImplementation((bin: string) => {
      if (bin === onPath('/broken')) throw new Error('not executable');
      return Buffer.from('');
    });

    expect(boot({ searchPath: ['/broken', '/good'] }).isAvailable()).toBe(true);
    expect(execFileSync).toHaveBeenLastCalledWith(
      onPath('/good'), ['--version'], expect.anything(),
    );
  });
});

// #2261 — the extractor's age decides which providers parse at all, and a stale
// one is indistinguishable from an unsupported provider without this.
describe('KitineraryExtractorService diagnostics', () => {
  it('KIT-EXT-010: reports the version the binary prints', () => {
    existsSync.mockImplementation((p: string) => p === '/opt/ki');
    execFileSync.mockReturnValue(Buffer.from('kitinerary-extractor 6.3.3\n'));

    expect(boot({ kitineraryExtractorPath: '/opt/ki' }).describe()).toEqual({
      available: true, path: '/opt/ki', version: '6.3.3', configuredPath: '/opt/ki',
    });
  });

  it('KIT-EXT-011: a binary that will not answer --version stays usable', () => {
    existsSync.mockImplementation((p: string) => p === '/opt/ki');
    execFileSync.mockImplementation(() => { throw new Error('nope'); });

    const described = boot({ kitineraryExtractorPath: '/opt/ki' }).describe();
    expect(described.available).toBe(true);
    expect(described.version).toBeNull();
  });

  it('KIT-EXT-012: a configured path that does not exist is reported as such', () => {
    existsSync.mockReturnValue(false);

    expect(boot({ kitineraryExtractorPath: '/nope/ki' }).describe()).toEqual({
      available: false, path: null, version: null, configuredPath: '/nope/ki',
    });
  });

  it('KIT-EXT-013: nothing found at all reads as nothing configured', () => {
    expect(boot().describe()).toEqual({
      available: false, path: null, version: null, configuredPath: null,
    });
  });

  it('KIT-EXT-014: the version is probed for the /usr/lib branch too, not only for PATH', () => {
    const found = join('/usr/lib', 'x86_64-linux-gnu', 'libexec', 'kf6', 'kitinerary-extractor');
    readdirSync.mockReturnValue(['x86_64-linux-gnu']);
    existsSync.mockImplementation((p: string) => p === found);
    execFileSync.mockReturnValue(Buffer.from('kitinerary-extractor 6.3.3'));

    expect(boot().describe().version).toBe('6.3.3');
  });
});

describe('KitineraryExtractorService stderr handling', () => {
  /** Drive one extraction with a canned stderr. */
  async function extractWith(stderr: string) {
    existsSync.mockImplementation((p: string) => p === '/opt/ki');
    execFileSync.mockReturnValue(Buffer.from('kitinerary-extractor 6.3.3'));
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
      cb(null, { stdout: '[]', stderr });
    });
    await boot({ kitineraryExtractorPath: '/opt/ki' }).extract(Buffer.from(''), 'booking.eml');
  }

  it('KIT-EXT-015: passes every raw line to the debug log, script errors included', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await extractWith('JS ERROR: lufthansa.js failed\nInvalid result type from script\n');

    const logged = logDebug.mock.calls.map(c => String(c[0]));
    expect(logged.some(l => l.includes('JS ERROR: lufthansa.js failed'))).toBe(true);
    expect(logged.some(l => l.includes('Invalid result type from script'))).toBe(true);
    // And the default level still says nothing about them.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('KIT-EXT-016: an unexpected line still reaches console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await extractWith('JS ERROR: noise\nsomething genuinely odd\n');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('booking.eml'), 'something genuinely odd');
    warn.mockRestore();
  });

  it('KIT-EXT-017: the debug dump is capped so one document cannot flood the log', async () => {
    await extractWith(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
    expect(logDebug.mock.calls.length).toBe(200);
  });
});
