import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The two lines this fix actually adds. Everything else is a helper: the guard in
 * rtlText.ts has its own tests, but a guard nobody calls looks exactly like a
 * working fix from the outside. Deleting either registration, swapping an
 * argument or dropping the deferred flag left the whole suite green.
 *
 * The engines are mocked because importing them for real builds a worker pool
 * under jsdom, and the plugin URL is mocked so the 133 KB payload never loads.
 */
const { mapboxSet, maplibreSet } = vi.hoisted(() => ({
  mapboxSet: vi.fn(),
  maplibreSet: vi.fn(),
}));

vi.mock('mapbox-gl', () => ({ default: { setRTLTextPlugin: mapboxSet } }));
vi.mock('maplibre-gl', () => ({ default: { setRTLTextPlugin: maplibreSet } }));
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url', () => ({ default: '/assets/rtl-plugin.js' }));

beforeEach(() => {
  vi.resetModules();
  mapboxSet.mockReset();
  maplibreSet.mockReset();
});

describe('the GL engines register the RTL text plugin (#2235)', () => {
  it('FE-MAP-RTL-001: importing the mapbox engine registers it deferred, with a null callback', async () => {
    await import('./mapbox');

    expect(mapboxSet).toHaveBeenCalledTimes(1);
    // Mapbox GL 3 takes (url, callback, deferred). The third argument is what
    // keeps the payload off the wire until a map paints RTL text; dropping it
    // would fetch 133 KB for every user on every map.
    expect(mapboxSet).toHaveBeenCalledWith(expect.stringContaining('rtl'), null, true);
  });

  it('FE-MAP-RTL-002: importing the maplibre engine registers it lazily', async () => {
    await import('./maplibre');

    expect(maplibreSet).toHaveBeenCalledTimes(1);
    // MapLibre 5 takes (url, lazy) and returns a promise, which is the reason
    // the call stays with each engine instead of going through one wrapper.
    expect(maplibreSet).toHaveBeenCalledWith(expect.stringContaining('rtl'), true);
  });

  it('FE-MAP-RTL-003: an engine still loads when its registration throws', async () => {
    mapboxSet.mockImplementation(() => { throw new Error('already registered'); });

    const engine = await import('./mapbox');

    expect(engine.default).toBeDefined();
  });

  it('FE-MAP-RTL-004: a rejected registration promise does not surface as an unhandled rejection', async () => {
    maplibreSet.mockReturnValue(Promise.reject(new Error('already registered')));

    const engine = await import('./maplibre');

    expect(engine.default).toBeDefined();
    // Give the rejection a tick to go unhandled if nothing caught it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
