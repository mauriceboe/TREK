// FE-COMP-JOURNEYMAP-001 to FE-COMP-JOURNEYMAP-050

vi.mock('../../api/websocket', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getSocketId: vi.fn(() => null),
  setRefetchCallback: vi.fn(),
  setPreReconnectHook: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

// Leaflet does not work in jsdom — mock the entire library
vi.mock('leaflet', () => {
  const mockMarker = {
    addTo: vi.fn().mockReturnThis(),
    bindTooltip: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    setIcon: vi.fn(),
    setZIndexOffset: vi.fn(),
    getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })),
  };
  const mockMap = {
    remove: vi.fn(),
    invalidateSize: vi.fn(),
    fitBounds: vi.fn(),
    setView: vi.fn(),
    flyTo: vi.fn(),
    getZoom: vi.fn(() => 10),
    // Leaflet throws "Set map center and zoom first." out of these until the map
    // has a view; the loaded map is the default here, FE-COMP-JOURNEYMAP-050
    // takes it away for the window that #2254 fell into.
    getCenter: vi.fn(() => ({ lat: 0, lng: 0 })),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    // The photo layer subscribes to zoom/pan and clusters in screen space (#1614).
    on: vi.fn(),
    off: vi.fn(),
    latLngToContainerPoint: vi.fn(() => ({ x: 0, y: 0 })),
  };
  return {
    default: {
      map: vi.fn(() => mockMap),
      tileLayer: vi.fn(() => ({ addTo: vi.fn(), setUrl: vi.fn() })),
      marker: vi.fn(() => mockMarker),
      polyline: vi.fn(() => { const line: any = { addTo: vi.fn(() => line), bindTooltip: vi.fn(() => line) }; return line }),
      divIcon: vi.fn(() => ({})),
      latLngBounds: vi.fn(() => ({})),
      layerGroup: vi.fn(() => ({ addLayer: vi.fn(), addTo: vi.fn(), remove: vi.fn() })),
    },
    map: vi.fn(() => mockMap),
    tileLayer: vi.fn(() => ({ addTo: vi.fn(), setUrl: vi.fn() })),
    marker: vi.fn(() => mockMarker),
    polyline: vi.fn(() => { const line: any = { addTo: vi.fn(() => line), bindTooltip: vi.fn(() => line) }; return line }),
    divIcon: vi.fn(() => ({})),
    latLngBounds: vi.fn(() => ({})),
  };
});

import React from 'react';
import { render, act, fireEvent, waitFor } from '../../../tests/helpers/render';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { useSettingsStore } from '../../store/settingsStore';
import { buildSettings } from '../../../tests/helpers/factories';
import type { Mock } from 'vitest';
import L from 'leaflet';
import JourneyMap from './JourneyMap';
import type { JourneyMapHandle } from './JourneyMap';

// maplibre-gl-leaflet hangs the vector basemap into Leaflet's tile pane. The mock
// only has to be callable and hand back a layer with the three methods the callers
// use, since nothing here renders WebGL.
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';

vi.mock('@maplibre/maplibre-gl-leaflet', () => ({
  maplibreGL: vi.fn(() => {
    // One GL map per layer, kept stable: a fresh object per call would hand the
    // assertions a different spy than the code just used.
    const gl = {
      setStyle: vi.fn(), on: vi.fn(), isStyleLoaded: () => false,
      getStyle: () => ({ layers: [] }), setLayoutProperty: vi.fn(),
    }
    const layer: Record<string, unknown> = { remove: vi.fn(), getMaplibreMap: vi.fn(() => gl) }
    layer.addTo = vi.fn(() => layer)
    return layer
  }),
}));
vi.mock('../Map/engines/maplibre', () => ({ default: {} }));

const entriesWithCoords = [
  { id: 'e1', lat: 48.8566, lng: 2.3522, title: 'Paris', mood: null, entry_date: '2025-06-01' },
  { id: 'e2', lat: 52.52, lng: 13.405, title: 'Berlin', mood: null, entry_date: '2025-06-02' },
];

const entriesWithoutCoords = [
  { id: 'e3', lat: 0, lng: 0, title: 'Unknown Place', mood: null, entry_date: '2025-06-03' },
];

const mixedEntries = [
  ...entriesWithCoords,
  ...entriesWithoutCoords,
];

// The leaflet mock hands out one shared map/marker instance, so every render
// resolves to the same spy object.
const mockedMap = () => vi.mocked(L.map).mock.results[0].value;
const mockedMarker = (i = 0) => vi.mocked(L.marker).mock.results[i].value;
const divIconHtml = (i: number) => String(vi.mocked(L.divIcon).mock.calls[i][0].html);

beforeEach(() => {
  resetAllStores();
  seedStore(useSettingsStore, { settings: buildSettings() });
  vi.clearAllMocks();
});

describe('JourneyMap', () => {
  it('FE-COMP-JOURNEYMAP-001: renders map container', () => {
    const { container } = render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} />
    );
    // The component renders a div with a child div ref for the Leaflet map
    expect(container.firstChild).toBeInTheDocument();
    expect(L.map).toHaveBeenCalled();
  });

  it('FE-COMP-JOURNEYMAP-002: renders markers for entries with coordinates', () => {
    render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} />
    );
    // Two entries with valid lat/lng should produce two markers
    expect(L.marker).toHaveBeenCalledTimes(2);
  });

  it('FE-COMP-JOURNEYMAP-003: does not render markers for entries without coordinates', () => {
    render(
      <JourneyMap checkins={[]} entries={entriesWithoutCoords} />
    );
    // Entry with lat=0 and lng=0 is filtered out by buildMarkerItems (if (e.lat && e.lng))
    expect(L.marker).not.toHaveBeenCalled();
  });

  it('FE-COMP-JOURNEYMAP-004: renders polyline connecting entries', () => {
    render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} />
    );
    // With 2+ marker items, a route polyline is drawn
    expect(L.polyline).toHaveBeenCalled();
  });

  it('FE-COMP-JOURNEYMAP-005: shows entry title in marker tooltip', () => {
    render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} />
    );
    // Each marker calls bindTooltip with the entry label
    const mockMarkerInstance = (L.marker as any).mock.results[0].value;
    expect(mockMarkerInstance.bindTooltip).toHaveBeenCalledWith(
      'Paris',
      expect.objectContaining({ direction: 'top' }),
    );
  });

  it('FE-COMP-JOURNEYMAP-006: exposes imperative handle (focusMarker)', () => {
    const ref = React.createRef<JourneyMapHandle>();
    render(
      <JourneyMap ref={ref} checkins={[]} entries={entriesWithCoords} />
    );
    expect(ref.current).not.toBeNull();
    expect(typeof ref.current!.focusMarker).toBe('function');
    expect(typeof ref.current!.highlightMarker).toBe('function');
  });

  it('FE-COMP-JOURNEYMAP-007: renders SVG pin markers via divIcon', () => {
    render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} />
    );
    // Each marker is created with L.divIcon containing SVG html
    expect(L.divIcon).toHaveBeenCalledTimes(2);
    const firstCall = (L.divIcon as any).mock.calls[0][0];
    expect(firstCall.html).toContain('<svg');
    expect(firstCall.html).toContain('</svg>');
    // Marker index label "1" for first entry
    expect(firstCall.html).toContain('>1<');
  });

  it('FE-COMP-JOURNEYMAP-008: renders markers with mood-based entry labels', () => {
    const entriesWithMood = [
      { id: 'e1', lat: 48.8566, lng: 2.3522, title: 'Happy Paris', mood: 'happy', entry_date: '2025-06-01' },
      { id: 'e2', lat: 52.52, lng: 13.405, title: 'Sad Berlin', mood: 'sad', entry_date: '2025-06-02' },
    ];
    render(
      <JourneyMap checkins={[]} entries={entriesWithMood} />
    );
    // Markers are still created (mood does not prevent rendering)
    expect(L.marker).toHaveBeenCalledTimes(2);
    // Tooltips use the entry titles
    const mockMarker1 = (L.marker as any).mock.results[0].value;
    expect(mockMarker1.bindTooltip).toHaveBeenCalledWith(
      'Happy Paris',
      expect.objectContaining({ direction: 'top' }),
    );
    const mockMarker2 = (L.marker as any).mock.results[1].value;
    expect(mockMarker2.bindTooltip).toHaveBeenCalledWith(
      'Sad Berlin',
      expect.objectContaining({ direction: 'top' }),
    );
  });

  it('FE-COMP-JOURNEYMAP-009: draws route polyline connecting multiple markers', () => {
    const threeEntries = [
      { id: 'e1', lat: 48.8566, lng: 2.3522, title: 'Paris', mood: null, entry_date: '2025-06-01' },
      { id: 'e2', lat: 52.52, lng: 13.405, title: 'Berlin', mood: null, entry_date: '2025-06-02' },
      { id: 'e3', lat: 41.9028, lng: 12.4964, title: 'Rome', mood: null, entry_date: '2025-06-03' },
    ];
    render(
      <JourneyMap checkins={[]} entries={threeEntries} />
    );
    // Route polyline is drawn for items.length > 1
    expect(L.polyline).toHaveBeenCalled();
    const polylineCall = (L.polyline as any).mock.calls[0];
    // Should contain coordinates for all three entries
    expect(polylineCall[0].length).toBe(3);
    // Verify dashed style
    expect(polylineCall[1]).toMatchObject({ dashArray: '4 6' });
  });

  it('FE-COMP-JOURNEYMAP-010: fitBounds is called for auto-zoom', () => {
    // Trigger requestAnimationFrame synchronously
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };

    render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} />
    );

    const mockMap = (L.map as any).mock.results[0].value;
    // fitBounds is called inside requestAnimationFrame with the collected coordinates
    expect(mockMap.fitBounds).toHaveBeenCalled();
    expect(L.latLngBounds).toHaveBeenCalled();

    globalThis.requestAnimationFrame = origRAF;
  });

  it('FE-COMP-JOURNEYMAP-011: single entry creates marker but no polyline', () => {
    const singleEntry = [
      { id: 'e1', lat: 48.8566, lng: 2.3522, title: 'Solo Paris', mood: null, entry_date: '2025-06-01' },
    ];
    render(
      <JourneyMap checkins={[]} entries={singleEntry} />
    );
    // One marker created
    expect(L.marker).toHaveBeenCalledTimes(1);
    // No route polyline — polyline is only drawn when items.length > 1
    expect(L.polyline).not.toHaveBeenCalled();
  });

  it('FE-COMP-JOURNEYMAP-012: renders zoom control buttons', () => {
    const { container } = render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} />
    );
    // The component renders zoom in (+) and zoom out (−) buttons
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe('+');
    expect(buttons[1].textContent).toBe('−');
  });

  it('FE-COMP-JOURNEYMAP-013: skips entries without coordinates but keeps the rest', () => {
    render(
      <JourneyMap checkins={[]} entries={mixedEntries} />
    );
    // Only the two entries with real lat/lng become markers
    expect(L.marker).toHaveBeenCalledTimes(2);
  });

  it('FE-COMP-JOURNEYMAP-014: highlightMarker scales the pin up and lifts its z-index', () => {
    const ref = React.createRef<JourneyMapHandle>();
    render(<JourneyMap ref={ref} checkins={[]} entries={entriesWithCoords} />);
    const iconsBefore = vi.mocked(L.divIcon).mock.calls.length;

    act(() => { ref.current!.highlightMarker('e1'); });

    expect(divIconHtml(iconsBefore)).toContain('scale(1.2)');
    expect(mockedMarker().setZIndexOffset).toHaveBeenCalledWith(1000);
  });

  it('FE-COMP-JOURNEYMAP-015: highlighting a second marker resets the previous one', () => {
    const ref = React.createRef<JourneyMapHandle>();
    render(<JourneyMap ref={ref} checkins={[]} entries={entriesWithCoords} />);
    act(() => { ref.current!.highlightMarker('e1'); });
    const iconsBefore = vi.mocked(L.divIcon).mock.calls.length;

    act(() => { ref.current!.highlightMarker('e2'); });

    // First the old pin is redrawn unhighlighted, then the new one highlighted
    expect(divIconHtml(iconsBefore)).toContain('scale(1)');
    expect(divIconHtml(iconsBefore + 1)).toContain('scale(1.2)');
    expect(mockedMarker().setZIndexOffset).toHaveBeenCalledWith(0);
  });

  it('FE-COMP-JOURNEYMAP-016: highlightMarker ignores ids that have no marker', () => {
    const ref = React.createRef<JourneyMapHandle>();
    render(<JourneyMap ref={ref} checkins={[]} entries={entriesWithCoords} />);
    const iconsBefore = vi.mocked(L.divIcon).mock.calls.length;

    act(() => { ref.current!.highlightMarker('does-not-exist'); });

    expect(vi.mocked(L.divIcon).mock.calls.length).toBe(iconsBefore);
  });

  it('FE-COMP-JOURNEYMAP-017: focusMarker flies to the pin, never below zoom 12', () => {
    const ref = React.createRef<JourneyMapHandle>();
    render(<JourneyMap ref={ref} checkins={[]} entries={entriesWithCoords} />);

    act(() => { ref.current!.focusMarker('e2'); });

    // getZoom() is stubbed at 10, so the floor of 12 wins
    expect(mockedMap().flyTo).toHaveBeenCalledWith({ lat: 0, lng: 0 }, 12, { duration: 0.5 });
  });

  it('FE-COMP-JOURNEYMAP-018: focusMarker swallows leaflet errors when the map has no view yet', () => {
    const ref = React.createRef<JourneyMapHandle>();
    render(<JourneyMap ref={ref} checkins={[]} entries={entriesWithCoords} />);
    vi.mocked(mockedMap().getZoom).mockImplementationOnce(() => { throw new Error('Set map center and zoom first'); });

    expect(() => act(() => { ref.current!.focusMarker('e1'); })).not.toThrow();
    expect(mockedMap().flyTo).not.toHaveBeenCalled();
  });

  it('FE-COMP-JOURNEYMAP-019: invalidateSize forwards to the leaflet map', () => {
    const ref = React.createRef<JourneyMapHandle>();
    render(<JourneyMap ref={ref} checkins={[]} entries={entriesWithCoords} />);
    const before = vi.mocked(mockedMap().invalidateSize).mock.calls.length;

    act(() => { ref.current!.invalidateSize(); });

    expect(vi.mocked(mockedMap().invalidateSize).mock.calls.length).toBe(before + 1);
  });

  it('FE-COMP-JOURNEYMAP-020: a trail draws its own dashed polyline', () => {
    render(
      <JourneyMap
        checkins={[]}
        entries={entriesWithCoords}
        trail={[{ lat: 48.85, lng: 2.35 }, { lat: 50.0, lng: 8.0 }, { lat: 52.52, lng: 13.4 }]}
      />
    );
    // trail polyline first, route polyline second
    const trailCall = vi.mocked(L.polyline).mock.calls[0];
    expect(trailCall[0]).toEqual([[48.85, 2.35], [50.0, 8.0], [52.52, 13.4]]);
    expect(trailCall[1]).toMatchObject({ dashArray: '6 4', color: '#6366f1' });
  });

  it('FE-COMP-JOURNEYMAP-021: a single-point trail is not drawn', () => {
    render(
      <JourneyMap checkins={[]} entries={entriesWithoutCoords} trail={[{ lat: 1, lng: 2 }]} />
    );
    expect(L.polyline).not.toHaveBeenCalled();
  });

  it('FE-COMP-JOURNEYMAP-022: fullScreen enables wheel zoom and drops the route polyline', () => {
    render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} fullScreen />
    );
    expect(vi.mocked(L.map).mock.calls[0][1]).toMatchObject({ scrollWheelZoom: true });
    // The connecting route line is a sidebar-only decoration
    expect(L.polyline).not.toHaveBeenCalled();
  });

  it('FE-COMP-JOURNEYMAP-023: clicking a marker reports the entry id', () => {
    const onMarkerClick = vi.fn();
    render(
      <JourneyMap checkins={[]} entries={entriesWithCoords} onMarkerClick={onMarkerClick} />
    );
    const handler = vi.mocked(mockedMarker().on).mock.calls.find(c => c[0] === 'click')?.[1] as () => void;
    act(() => { handler(); });
    expect(onMarkerClick).toHaveBeenCalledWith('e1');
  });

  it('FE-COMP-JOURNEYMAP-024: without any coordinates the map falls back to the world view', () => {
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    try {
      render(<JourneyMap checkins={[]} entries={entriesWithoutCoords} />);
      expect(mockedMap().setView).toHaveBeenCalledWith([30, 0], 2);
      expect(mockedMap().fitBounds).not.toHaveBeenCalled();
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
  });

  it('FE-COMP-JOURNEYMAP-025: paddingBottom widens the bottom fit padding', () => {
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    try {
      render(<JourneyMap checkins={[]} entries={entriesWithCoords} paddingBottom={200} />);
      expect(mockedMap().fitBounds).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ paddingBottomRight: [50, 200] }),
      );
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
  });

  it('FE-COMP-JOURNEYMAP-026: dark mode picks the dark basemap', async () => {
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} dark />);
    // The default basemap is a vector style now, so it arrives as a style option
    // rather than as a tile template, and it attaches after a dynamic import.
    await waitFor(() => {
      const calls = vi.mocked(maplibreGL).mock.calls;
      const call = calls[calls.length - 1]?.[0] as { style: string } | undefined;
      expect(call?.style).toContain('openfreemap.org/styles/dark');
    });
  });

  it('FE-COMP-JOURNEYMAP-027: a configured tile url overrides the default basemap', () => {
    seedStore(useSettingsStore, { settings: buildSettings({ map_tile_url: 'https://tiles.test/{z}/{x}/{y}.png' }) });
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} />);
    expect(vi.mocked(L.tileLayer).mock.calls[0][0]).toBe('https://tiles.test/{z}/{x}/{y}.png');
  });

  it('FE-COMP-JOURNEYMAP-041: a basemap change restyles in place instead of rebuilding the map (#2097)', async () => {
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} />);
    const layer = await waitFor(() => {
      const results = vi.mocked(maplibreGL).mock.results;
      const made = results[results.length - 1];
      expect(made).toBeTruthy();
      return made!.value as { getMaplibreMap: () => { setStyle: ReturnType<typeof vi.fn> } };
    });
    const mapsBefore = vi.mocked(L.map).mock.calls.length;

    // A raster template the user configured replaces the vector basemap. The
    // markers and tracks the map already carries are drawn by the effect that
    // builds it, so a rebuild here would tear them down mid-flight.
    act(() => {
      seedStore(useSettingsStore, { settings: buildSettings({ map_tile_url: 'https://tiles.test/{z}/{x}/{y}.png' }) });
    });

    expect(vi.mocked(L.map).mock.calls.length).toBe(mapsBefore);
    expect(mockedMap().remove).not.toHaveBeenCalled();
    expect(layer.getMaplibreMap().setStyle).not.toHaveBeenCalledWith(expect.stringContaining('tiles.test'));
  });

  it('FE-COMP-JOURNEYMAP-028: the activeMarkerId prop flies to that marker after the settle delay', () => {
    vi.useFakeTimers();
    try {
      render(<JourneyMap checkins={[]} entries={entriesWithCoords} activeMarkerId="e2" />);
      expect(mockedMap().flyTo).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(60); });
      expect(mockedMap().flyTo).toHaveBeenCalledWith({ lat: 0, lng: 0 }, 12, { duration: 0.5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('FE-COMP-JOURNEYMAP-029: activeMarkerId falls back to setView while the map has no view yet', () => {
    vi.useFakeTimers();
    try {
      render(<JourneyMap checkins={[]} entries={entriesWithCoords} activeMarkerId="e1" />);
      vi.mocked(mockedMap().getZoom).mockImplementationOnce(() => { throw new Error('Set map center and zoom first'); });
      act(() => { vi.advanceTimersByTime(60); });
      expect(mockedMap().setView).toHaveBeenCalledWith({ lat: 0, lng: 0 }, 12);
      expect(mockedMap().flyTo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('FE-COMP-JOURNEYMAP-030: an activeMarkerId with no marker does not move the camera', () => {
    vi.useFakeTimers();
    try {
      render(<JourneyMap checkins={[]} entries={entriesWithCoords} activeMarkerId="ghost" />);
      act(() => { vi.advanceTimersByTime(60); });
      expect(mockedMap().flyTo).not.toHaveBeenCalled();
      expect(mockedMap().setView).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('FE-COMP-JOURNEYMAP-031: the deferred resize fires 200ms after mount', () => {
    vi.useFakeTimers();
    try {
      render(<JourneyMap checkins={[]} entries={entriesWithCoords} />);
      const before = vi.mocked(mockedMap().invalidateSize).mock.calls.length;
      act(() => { vi.advanceTimersByTime(250); });
      expect(vi.mocked(mockedMap().invalidateSize).mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FE-COMP-JOURNEYMAP-032: the zoom buttons drive the leaflet map', () => {
    const { container } = render(<JourneyMap checkins={[]} entries={entriesWithCoords} />);
    const buttons = container.querySelectorAll('button');
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(mockedMap().zoomIn).toHaveBeenCalledTimes(1);
    expect(mockedMap().zoomOut).toHaveBeenCalledTimes(1);
  });

  it('FE-COMP-JOURNEYMAP-033: height 9999 stretches the wrapper to the full container', () => {
    const { container } = render(<JourneyMap checkins={[]} entries={entriesWithCoords} height={9999} />);
    expect((container.firstChild as HTMLElement).style.height).toBe('100%');
  });

  it('FE-COMP-JOURNEYMAP-034: per-day colours and labels reach the pin svg', () => {
    render(
      <JourneyMap
        checkins={[]}
        entries={[{ id: 'e9', lat: 40.4, lng: -3.7, title: 'Madrid', mood: null, entry_date: '2025-06-04', dayColor: '#ff0055', dayLabel: 4 }]}
      />
    );
    const html = divIconHtml(0);
    expect(html).toContain('#ff0055');
    expect(html).toContain('>4<');
  });

  it('FE-COMP-JOURNEYMAP-035: entries are ordered by date, not by array position', () => {
    render(
      <JourneyMap
        checkins={[]}
        entries={[
          { id: 'late', lat: 52.52, lng: 13.405, title: 'Berlin', mood: null, entry_date: '2025-06-09' },
          { id: 'early', lat: 48.8566, lng: 2.3522, title: 'Paris', mood: null, entry_date: '2025-06-01' },
        ]}
      />
    );
    const tooltipTitles = vi.mocked(mockedMarker().bindTooltip).mock.calls.map(c => c[0]);
    expect(tooltipTitles).toEqual(['Paris', 'Berlin']);
  });

  it('FE-COMP-JOURNEYMAP-036: an untitled entry still gets a tooltip label', () => {
    render(
      <JourneyMap
        checkins={[]}
        entries={[{ id: 'e0', lat: 1, lng: 2, title: null, mood: null, entry_date: '2025-06-01' }]}
      />
    );
    expect(mockedMarker().bindTooltip).toHaveBeenCalledWith('Entry', expect.objectContaining({ direction: 'top' }));
  });

  it('FE-COMP-JOURNEYMAP-037: unmounting tears the leaflet map down', () => {
    const { unmount } = render(<JourneyMap checkins={[]} entries={entriesWithCoords} />);
    const map = mockedMap();
    const before = vi.mocked(map.remove).mock.calls.length;
    unmount();
    expect(vi.mocked(map.remove).mock.calls.length).toBe(before + 1);
  });
  // ── GPX tracks (#1260) ──────────────────────────────────────────────────────
  const track = (over: Partial<{ place_id: number; trip_id: number; name: string; color: string | null; points: [number, number][] }> = {}) => ({
    place_id: 1, trip_id: 1, name: 'Morning hike', color: '#ff0000',
    points: [[47.1, 11.2], [47.2, 11.3]] as [number, number][], ...over,
  });

  it('FE-COMP-JOURNEYMAP-040: draws a track as a casing plus a coloured line', () => {
    vi.mocked(L.polyline).mockClear();
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} tracks={[track()]} />);

    const calls = vi.mocked(L.polyline).mock.calls;
    const casing = calls.find(c => (c[1] as any)?.color === '#ffffff');
    const line = calls.find(c => (c[1] as any)?.color === '#ff0000');
    expect(casing).toBeDefined();
    expect(line).toBeDefined();
    // Leaflet wants [lat, lng], which is the order the geometry is stored in.
    expect(line![0]).toEqual([[47.1, 11.2], [47.2, 11.3]]);
    // Solid, unlike the dashed line that merely connects entries in time order.
    expect((line![1] as any).dashArray).toBeUndefined();
  });

  it('FE-COMP-JOURNEYMAP-043: labels a track with the map tooltip the markers use', () => {
    vi.mocked(L.polyline).mockClear();
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} tracks={[track({ name: 'Morning hike' })]} />);

    const line = vi.mocked(L.polyline).mock.results
      .map(r => r.value as any)
      .find(v => v.bindTooltip.mock.calls.length > 0);
    expect(line).toBeDefined();
    const [label, opts] = line.bindTooltip.mock.calls[0];
    expect(label).toBe('Morning hike');
    // The house tooltip, not Leaflet's default box: it reads the appearance tokens.
    expect(opts.className).toBe('map-tooltip');
  });

  it('FE-COMP-JOURNEYMAP-044: an unnamed track gets no empty tooltip', () => {
    vi.mocked(L.polyline).mockClear();
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} tracks={[track({ name: '' })]} />);

    const tooltipped = vi.mocked(L.polyline).mock.results
      .map(r => r.value as any)
      .filter(v => v.bindTooltip.mock.calls.length > 0);
    expect(tooltipped).toHaveLength(0);
  });

  it('FE-COMP-JOURNEYMAP-041: a track without its own colour falls back rather than vanishing', () => {
    vi.mocked(L.polyline).mockClear();
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} tracks={[track({ color: null })]} />);

    const colors = vi.mocked(L.polyline).mock.calls.map(c => (c[1] as any)?.color);
    expect(colors).toContain('#4f46e5');
  });

  it('FE-COMP-JOURNEYMAP-042: a track with fewer than two points draws nothing', () => {
    vi.mocked(L.polyline).mockClear();
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} tracks={[track({ points: [[47.1, 11.2]] })]} />);

    const colors = vi.mocked(L.polyline).mock.calls.map(c => (c[1] as any)?.color);
    expect(colors).not.toContain('#ff0000');
    expect(colors).not.toContain('#ffffff');
  });

  /** The opening viewport is the assertion here, so the frame gets read out of the bounds call. */
  const fitCoords = () => vi.mocked(L.latLngBounds).mock.calls[0][0] as [number, number][];

  // #2194: a recorded drive across the country used to pull the opening view out to
  // the whole trip, leaving the journey's own entries as a speck.
  it('FE-COMP-JOURNEYMAP-048: frames the entries, not the tracks, when the journey has both', () => {
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    try {
      render(
        <JourneyMap checkins={[]} entries={entriesWithCoords} tracks={[track({ points: [[10, 10], [11, 11]] })]} />
      );

      expect(mockedMap().fitBounds).toHaveBeenCalled();
      expect(fitCoords()).toEqual([[48.8566, 2.3522], [52.52, 13.405]]);
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
  });

  it('FE-COMP-JOURNEYMAP-049: with nothing else on the map the tracks are framed instead of the world', () => {
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    try {
      render(<JourneyMap checkins={[]} entries={entriesWithoutCoords} tracks={[track()]} />);

      expect(fitCoords()).toEqual([[47.1, 11.2], [47.2, 11.3]]);
      expect(mockedMap().setView).not.toHaveBeenCalledWith([30, 0], 2);
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
  });

  // A string handed to bindTooltip becomes innerHTML. A track name is a place
  // name off a shared trip and an entry label is a journey title, so both are
  // written by someone who is not necessarily the person reading the map — and
  // this component is what the public journey page renders.
  it('FE-COMP-JOURNEYMAP-044: escapes a track name before it becomes tooltip markup', () => {
    vi.mocked(L.polyline).mockClear();
    render(<JourneyMap checkins={[]} entries={entriesWithCoords} tracks={[track({ name: '<img src=x onerror="alert(1)">' })]} />);

    const line = vi.mocked(L.polyline).mock.results
      .map(r => r.value as any)
      .find(v => v.bindTooltip.mock.calls.length > 0);
    const [label] = line.bindTooltip.mock.calls[0];
    expect(label).not.toContain('<img');
    expect(label).not.toContain('onerror="');
    expect(label).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('FE-COMP-JOURNEYMAP-045: escapes an entry title before it becomes tooltip markup', () => {
    const hostile = [{ id: 'e9', lat: 48.1, lng: 2.1, title: '<img src=x onerror="alert(1)">', mood: null, entry_date: '2025-06-04' }];
    render(<JourneyMap checkins={[]} entries={hostile} />);

    const labels = vi.mocked(mockedMarker().bindTooltip).mock.calls.map(c => c[0]);
    expect(labels.some(l => typeof l === 'string' && l.includes('<img'))).toBe(false);
    expect(labels).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });
  // #1614 — photos placed by their own capture coordinates, collapsed by proximity.
  it('FE-COMP-JOURNEYMAP-046: draws one thumbnail per cluster and counts the rest', () => {
    render(
      <JourneyMap
        checkins={[]}
        entries={[]}
        photos={[
          { id: 'p1', lat: 48.85, lng: 2.29, thumbUrl: '/uploads/a.jpg' },
          { id: 'p2', lat: 48.85, lng: 2.29, thumbUrl: '/uploads/b.jpg' },
          { id: 'p3', lat: 48.85, lng: 2.29, thumbUrl: '/uploads/c.jpg' },
        ]}
      />,
    );

    // The mock projects every photo to the same point, so all three land in one
    // bucket: one marker, and its badge says 3.
    const html = vi.mocked(L.divIcon).mock.calls.map(c => String(c[0]?.html)).filter(h => h.includes('/uploads/'));
    expect(html).toHaveLength(1);
    expect(html[0]).toContain('/uploads/a.jpg');
    expect(html[0]).toContain('>3<');
  });

  it('FE-COMP-JOURNEYMAP-047: a lone photo gets no count badge', () => {
    render(
      <JourneyMap checkins={[]} entries={[]} photos={[{ id: 'p1', lat: 1, lng: 2, thumbUrl: '/uploads/only.jpg' }]} />,
    );

    const html = vi.mocked(L.divIcon).mock.calls.map(c => String(c[0]?.html)).filter(h => h.includes('/uploads/'));
    expect(html).toHaveLength(1);
    expect(html[0]).not.toMatch(/>\d+</);
  });

  // #2254 — the map effect defers its opening fitBounds/setView to a rAF, so this
  // effect can draw while the map still has no center or zoom. Clustering
  // projects to container pixels, which throws in that window and took the whole
  // public journey page down with it.
  it('FE-COMP-JOURNEYMAP-050: waits out a map that has no view yet, then draws on moveend', () => {
    const noView = () => { throw new Error('Set map center and zoom first.'); };
    let hasView = false;
    const photoHtml = () =>
      vi.mocked(L.divIcon).mock.calls.map(c => String(c[0]?.html)).filter(h => h.includes('/uploads/'));

    // The mock hands out one shared map instance, so it can be reached — and
    // stripped of its view — before the component ever builds one. Typed down to
    // the three spies this needs: L.map's signature promises a real Leaflet map.
    type MapProbe = { getCenter: Mock; latLngToContainerPoint: Mock; on: Mock };
    L.map(document.createElement('div'));
    const map = mockedMap() as MapProbe;
    vi.mocked(L.map).mockClear();
    map.getCenter.mockImplementation(() => (hasView ? { lat: 0, lng: 0 } : noView()));
    map.latLngToContainerPoint.mockImplementation(() => (hasView ? { x: 0, y: 0 } : noView()));

    try {
      // Rendering must survive the viewless window, and draw nothing in it.
      expect(() =>
        render(
          <JourneyMap checkins={[]} entries={[]} photos={[{ id: 'p1', lat: 1, lng: 2, thumbUrl: '/uploads/late.jpg' }]} />,
        ),
      ).not.toThrow();
      expect(photoHtml()).toHaveLength(0);

      // The deferred fitBounds lands: the listener this effect registered redraws.
      hasView = true;
      const redraw = map.on.mock.calls.find(c => c[0] === 'moveend')?.[1] as () => void;
      expect(redraw).toBeTypeOf('function');
      act(() => { redraw(); });

      expect(photoHtml()).toHaveLength(1);
      expect(photoHtml()[0]).toContain('/uploads/late.jpg');
    } finally {
      map.getCenter.mockImplementation(() => ({ lat: 0, lng: 0 }));
      map.latLngToContainerPoint.mockImplementation(() => ({ x: 0, y: 0 }));
    }
  });
});
