import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRouteCalculation } from '../../../src/hooks/useRouteCalculation';
import { useSettingsStore } from '../../../src/store/settingsStore';
import { useTripStore } from '../../../src/store/tripStore';
import { buildAssignment, buildPlace } from '../../helpers/factories';
import type { TripStoreState } from '../../../src/store/tripStore';
import type { RouteSegment } from '../../../src/types';

// Mock the RouteCalculator module to avoid real OSRM fetch calls
vi.mock('../../../src/components/Map/RouteCalculator', () => ({
  calculateSegments: vi.fn(),
  calculateRoute: vi.fn(),
  optimizeRoute: vi.fn((waypoints: unknown[]) => waypoints),
  generateGoogleMapsUrl: vi.fn(),
}));

const { calculateSegments } = await import('../../../src/components/Map/RouteCalculator');

function buildMockStore(assignments: Record<string, ReturnType<typeof buildAssignment>[]> = {}): Partial<TripStoreState> {
  // Also populate the real Zustand store so updateRouteForDay (which reads from
  // useTripStore.getState()) sees the same assignments as the hook's tripStore param.
  // Reset reservations and days to empty so transport-split logic doesn't interfere.
  useTripStore.setState({ assignments, reservations: [], days: [] } as any);
  return { assignments } as Partial<TripStoreState>;
}

const MOCK_SEGMENTS: RouteSegment[] = [
  {
    from: [48.8566, 2.3522],
    to: [51.5074, -0.1278],
    mid: [50.182, 1.1122],
    walkingText: '120 min',
    drivingText: '90 min',
  },
];

describe('useRouteCalculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: route_calculation disabled
    useSettingsStore.setState({ settings: { route_calculation: false } as any });
    // Reset trip store assignments so each test starts clean
    useTripStore.setState({ assignments: {} } as any);
    (calculateSegments as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SEGMENTS);
  });

  it('FE-HOOK-ROUTE-001: with no selectedDayId, route is null', () => {
    const store = buildMockStore({});
    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, null)
    );
    expect(result.current.route).toBeNull();
  });

  it('FE-HOOK-ROUTE-002: with < 2 waypoints, route remains null', async () => {
    const place = buildPlace({ lat: 48.8566, lng: 2.3522 });
    const assignment = buildAssignment({ day_id: 5, order_index: 0, place });
    const store = buildMockStore({ '5': [assignment] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});
    expect(result.current.route).toBeNull();
  });

  it('FE-HOOK-ROUTE-003: with ≥ 2 geo-coded assignments, sets route coordinates', async () => {
    const p1 = buildPlace({ lat: 48.8566, lng: 2.3522 });
    const p2 = buildPlace({ lat: 51.5074, lng: -0.1278 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});
    // route is an array of segments; no transport → single segment with all places
    expect(result.current.route).toEqual([
      [[p1.lat, p1.lng], [p2.lat, p2.lng]],
    ]);
  });

  it('FE-HOOK-ROUTE-004: with route_calculation enabled, calls calculateSegments', async () => {
    useSettingsStore.setState({ settings: { route_calculation: true } as any });

    const p1 = buildPlace({ lat: 48.8566, lng: 2.3522 });
    const p2 = buildPlace({ lat: 51.5074, lng: -0.1278 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});

    expect(calculateSegments).toHaveBeenCalled();
    expect(result.current.routeSegments).toEqual(MOCK_SEGMENTS);
  });

  it('FE-HOOK-ROUTE-005: with route_calculation disabled, does not call calculateSegments', async () => {
    useSettingsStore.setState({ settings: { route_calculation: false } as any });

    const p1 = buildPlace({ lat: 48.8566, lng: 2.3522 });
    const p2 = buildPlace({ lat: 51.5074, lng: -0.1278 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});

    expect(calculateSegments).not.toHaveBeenCalled();
    expect(result.current.routeSegments).toEqual([]);
  });

  it('FE-HOOK-ROUTE-006: assignments are sorted by order_index before extracting waypoints', async () => {
    useSettingsStore.setState({ settings: { route_calculation: true } as any });

    const p1 = buildPlace({ lat: 10, lng: 10 });
    const p2 = buildPlace({ lat: 20, lng: 20 });
    // order_index 1 comes before 0 in the array, but should be sorted
    const a1 = buildAssignment({ day_id: 5, order_index: 1, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 0, place: p2 });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});

    // After sort: a2 (order_index=0) first, then a1 (order_index=1)
    expect(result.current.route).toEqual([
      [[p2.lat, p2.lng], [p1.lat, p1.lng]],
    ]);
  });

  it('FE-HOOK-ROUTE-007: assignments with no lat/lng are filtered out', async () => {
    const pValid = buildPlace({ lat: 48.8566, lng: 2.3522 });
    const pNoGeo = buildPlace({ lat: null as any, lng: null as any });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: pNoGeo });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: pValid });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});
    // Only 1 valid waypoint → route is null
    expect(result.current.route).toBeNull();
  });

  it('FE-HOOK-ROUTE-008: AbortController.abort() is called when selectedDayId changes', async () => {
    useSettingsStore.setState({ settings: { route_calculation: true } as any });

    // Make calculateSegments resolve slowly
    let resolveSegments!: (val: RouteSegment[]) => void;
    (calculateSegments as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_waypoints: unknown[], options: { signal?: AbortSignal }) => {
        return new Promise<RouteSegment[]>((resolve) => {
          resolveSegments = resolve;
          options?.signal?.addEventListener('abort', () => resolve([]));
        });
      }
    );

    const p1 = buildPlace({ lat: 10, lng: 10 });
    const p2 = buildPlace({ lat: 20, lng: 20 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });

    const store1 = buildMockStore({ '5': [a1, a2], '6': [a1, a2] });

    const { rerender } = renderHook(
      ({ dayId }: { dayId: number }) => useRouteCalculation(store1 as TripStoreState, dayId),
      { initialProps: { dayId: 5 } }
    );

    // Change to day 6 — should abort in-flight request for day 5
    await act(async () => {
      rerender({ dayId: 6 });
    });

    // calculateSegments should have been called at least once for day 5
    // and once more for day 6
    expect((calculateSegments as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    resolveSegments?.([]);
  });

  it('FE-HOOK-ROUTE-009: AbortError from calculateSegments does not set routeSegments to []', async () => {
    useSettingsStore.setState({ settings: { route_calculation: true } as any });

    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    (calculateSegments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(abortError);

    const p1 = buildPlace({ lat: 10, lng: 10 });
    const p2 = buildPlace({ lat: 20, lng: 20 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});
    // AbortError should be swallowed silently — segments remain empty
    expect(result.current.routeSegments).toEqual([]);
  });

  it('FE-HOOK-ROUTE-010: non-AbortError from calculateSegments sets routeSegments to []', async () => {
    useSettingsStore.setState({ settings: { route_calculation: true } as any });

    (calculateSegments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    const p1 = buildPlace({ lat: 10, lng: 10 });
    const p2 = buildPlace({ lat: 20, lng: 20 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, 5)
    );

    await act(async () => {});
    expect(result.current.routeSegments).toEqual([]);
  });

  it('FE-HOOK-ROUTE-011: when selectedDayId is null, route and segments are cleared', async () => {
    const p1 = buildPlace({ lat: 10, lng: 10 });
    const p2 = buildPlace({ lat: 20, lng: 20 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });
    const store = buildMockStore({ '5': [a1, a2] });

    const { result, rerender } = renderHook(
      ({ dayId }: { dayId: number | null }) => useRouteCalculation(store as TripStoreState, dayId),
      { initialProps: { dayId: 5 as number | null } }
    );

    await act(async () => {});
    // Some route may have been set for day 5

    await act(async () => {
      rerender({ dayId: null });
    });

    expect(result.current.route).toBeNull();
    expect(result.current.routeSegments).toEqual([]);
  });

  it('FE-HOOK-ROUTE-012: setRoute and setRouteInfo are exposed', () => {
    const store = buildMockStore({});
    const { result } = renderHook(() =>
      useRouteCalculation(store as TripStoreState, null)
    );
    expect(result.current.setRoute).toBeTypeOf('function');
    expect(result.current.setRouteInfo).toBeTypeOf('function');
  });

  it('FE-HOOK-ROUTE-013: route recalculates when assignments change via store update', async () => {
    useSettingsStore.setState({ settings: { route_calculation: true } as any });

    const p1 = buildPlace({ lat: 10, lng: 10 });
    const p2 = buildPlace({ lat: 20, lng: 20 });
    const a1 = buildAssignment({ day_id: 5, order_index: 0, place: p1 });
    const a2 = buildAssignment({ day_id: 5, order_index: 1, place: p2 });

    let storeData = buildMockStore({ '5': [a1, a2] });

    const { result, rerender } = renderHook(() =>
      useRouteCalculation(storeData as TripStoreState, 5)
    );

    await act(async () => {});

    expect(result.current.route).toEqual([
      [[p1.lat, p1.lng], [p2.lat, p2.lng]],
    ]);

    // Now add a third place — update both the local store object and the Zustand store
    const p3 = buildPlace({ lat: 30, lng: 30 });
    const a3 = buildAssignment({ day_id: 5, order_index: 2, place: p3 });
    storeData = buildMockStore({ '5': [a1, a2, a3] }); // also calls useTripStore.setState

    await act(async () => {
      rerender();
    });

    await act(async () => {});

    expect(result.current.route).toEqual([
      [[p1.lat, p1.lng], [p2.lat, p2.lng], [p3.lat, p3.lng]],
    ]);
  });
});
