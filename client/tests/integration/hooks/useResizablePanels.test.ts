import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { useResizablePanels } from '../../../src/hooks/useResizablePanels';

/**
 * The suite's jsdom stub answers `matches: false` to everything, so the hook is
 * in its wide layout unless a test says otherwise. `narrow()` puts it in the
 * 768-1023 band the foldable lands in (#2247).
 */
function setViewport(width: number, narrow: boolean) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('min-width: 768px') ? narrow : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('useResizablePanels', () => {
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('FE-HOOK-PANELS-001: default leftWidth is 340 when localStorage is empty', () => {
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.leftWidth).toBe(340);
  });

  it('FE-HOOK-PANELS-002: default rightWidth is 300 when localStorage is empty', () => {
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.rightWidth).toBe(300);
  });

  it('FE-HOOK-PANELS-003: leftWidth loaded from localStorage when set', () => {
    localStorage.setItem('sidebarLeftWidth', '400');
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.leftWidth).toBe(400);
  });

  it('FE-HOOK-PANELS-004: rightWidth loaded from localStorage when set', () => {
    localStorage.setItem('sidebarRightWidth', '350');
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.rightWidth).toBe(350);
  });

  it('FE-HOOK-PANELS-005: startResizeLeft sets body cursor to col-resize', () => {
    const { result } = renderHook(() => useResizablePanels());
    act(() => {
      result.current.startResizeLeft();
    });
    expect(document.body.style.cursor).toBe('col-resize');
  });

  it('FE-HOOK-PANELS-006: startResizeRight sets body cursor to col-resize', () => {
    const { result } = renderHook(() => useResizablePanels());
    act(() => {
      result.current.startResizeRight();
    });
    expect(document.body.style.cursor).toBe('col-resize');
  });

  it('FE-HOOK-PANELS-007: mousedown → mousemove → mouseup updates leftWidth and persists to localStorage', async () => {
    const { result } = renderHook(() => useResizablePanels());

    act(() => {
      result.current.startResizeLeft();
    });

    // mousemove with clientX=350 → w = max(200, min(520, 350-10)) = 340
    act(() => {
      fireEvent.mouseMove(document, { clientX: 350 });
    });

    expect(result.current.leftWidth).toBe(340);
    expect(localStorage.getItem('sidebarLeftWidth')).toBe('340');

    act(() => {
      fireEvent.mouseUp(document);
    });

    expect(document.body.style.cursor).toBe('');
  });

  it('FE-HOOK-PANELS-008: mousedown → mousemove → mouseup updates rightWidth and persists to localStorage', () => {
    // Set window.innerWidth for the right panel calculation
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1200 });

    const { result } = renderHook(() => useResizablePanels());

    act(() => {
      result.current.startResizeRight();
    });

    // mousemove with clientX=800 → w = max(200, min(520, 1200-800-10)) = max(200, min(520, 390)) = 390
    act(() => {
      fireEvent.mouseMove(document, { clientX: 800 });
    });

    expect(result.current.rightWidth).toBe(390);
    expect(localStorage.getItem('sidebarRightWidth')).toBe('390');

    act(() => {
      fireEvent.mouseUp(document);
    });

    expect(document.body.style.cursor).toBe('');
  });

  it('FE-HOOK-PANELS-009: min width constraint (200) is enforced for left panel', () => {
    const { result } = renderHook(() => useResizablePanels());

    act(() => {
      result.current.startResizeLeft();
    });

    // clientX=50 → w = max(200, min(520, 50-10)) = max(200, 40) = 200
    act(() => {
      fireEvent.mouseMove(document, { clientX: 50 });
    });

    expect(result.current.leftWidth).toBe(200);
  });

  it('FE-HOOK-PANELS-010: max width constraint (520) is enforced for left panel', () => {
    const { result } = renderHook(() => useResizablePanels());

    act(() => {
      result.current.startResizeLeft();
    });

    // clientX=600 → w = max(200, min(520, 600-10)) = min(520, 590) = 520
    act(() => {
      fireEvent.mouseMove(document, { clientX: 600 });
    });

    expect(result.current.leftWidth).toBe(520);
  });

  it('FE-HOOK-PANELS-011: mousemove without prior startResize does nothing', () => {
    const { result } = renderHook(() => useResizablePanels());

    const initialLeft = result.current.leftWidth;
    const initialRight = result.current.rightWidth;

    act(() => {
      fireEvent.mouseMove(document, { clientX: 400 });
    });

    expect(result.current.leftWidth).toBe(initialLeft);
    expect(result.current.rightWidth).toBe(initialRight);
  });

  it('FE-HOOK-PANELS-012: body userSelect set to none during resize, cleared on mouseup', () => {
    const { result } = renderHook(() => useResizablePanels());

    act(() => {
      result.current.startResizeLeft();
    });

    expect(document.body.style.userSelect).toBe('none');

    act(() => {
      fireEvent.mouseUp(document);
    });

    expect(document.body.style.userSelect).toBe('');
  });

  it('FE-HOOK-PANELS-013: leftCollapsed and rightCollapsed default to false', () => {
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.leftCollapsed).toBe(false);
    expect(result.current.rightCollapsed).toBe(false);
  });

  it('FE-HOOK-PANELS-014: setLeftCollapsed and setRightCollapsed are exposed', () => {
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.setLeftCollapsed).toBeTypeOf('function');
    expect(result.current.setRightCollapsed).toBeTypeOf('function');
  });

  // ── The narrow band, 768-1023px (#2247) ──────────────────────────────────

  it('FE-HOOK-PANELS-015: a wide layout shows whatever the collapse flags say', () => {
    setViewport(1440, false);
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.narrow).toBe(false);
    expect(result.current.leftHidden).toBe(false);
    expect(result.current.rightHidden).toBe(false);

    act(() => { result.current.toggleRight(); });
    expect(result.current.rightHidden).toBe(true);
    expect(result.current.leftHidden).toBe(false);
    expect(result.current.rightCollapsed).toBe(true);
  });

  it('FE-HOOK-PANELS-016: the narrow band opens the day plan and hides the places list', () => {
    setViewport(860, true);
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.narrow).toBe(true);
    expect(result.current.leftHidden).toBe(false);
    expect(result.current.rightHidden).toBe(true);
  });

  it('FE-HOOK-PANELS-017: opening one panel in the narrow band closes the other', () => {
    setViewport(860, true);
    const { result } = renderHook(() => useResizablePanels());

    act(() => { result.current.toggleRight(); });
    expect(result.current.rightHidden).toBe(false);
    expect(result.current.leftHidden).toBe(true);

    act(() => { result.current.toggleLeft(); });
    expect(result.current.leftHidden).toBe(false);
    expect(result.current.rightHidden).toBe(true);
  });

  it('FE-HOOK-PANELS-018: tapping the open panel in the narrow band leaves the map alone', () => {
    setViewport(860, true);
    const { result } = renderHook(() => useResizablePanels());

    act(() => { result.current.toggleLeft(); });
    expect(result.current.leftHidden).toBe(true);
    expect(result.current.rightHidden).toBe(true);
  });

  // A marker tap calls both setters with false; in the narrow band that used to
  // re-crowd the screen the user had just cleared.
  it('FE-HOOK-PANELS-019: reopening both panels does not re-crowd the narrow layout', () => {
    setViewport(860, true);
    const { result } = renderHook(() => useResizablePanels());

    act(() => { result.current.toggleRight(); });
    act(() => { result.current.setLeftCollapsed(false); result.current.setRightCollapsed(false); });
    expect(result.current.rightHidden).toBe(false);
    expect(result.current.leftHidden).toBe(true);
  });

  it('FE-HOOK-PANELS-020: a panel dragged wide on a desktop is clamped so the map keeps 360px', () => {
    localStorage.setItem('sidebarLeftWidth', '520');
    setViewport(800, true);
    const { result } = renderHook(() => useResizablePanels());
    // 800 - 360 map - 20 margins = 420
    expect(result.current.leftWidth).toBe(420);
    // The stored value is untouched, so a wide window gets its 520 back.
    expect(localStorage.getItem('sidebarLeftWidth')).toBe('520');
  });

  it('FE-HOOK-PANELS-021: the clamp never squeezes a panel below the drag minimum', () => {
    localStorage.setItem('sidebarLeftWidth', '520');
    setViewport(500, true);
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.leftWidth).toBe(200);
  });

  it('FE-HOOK-PANELS-022: a wide layout leaves the stored widths alone', () => {
    localStorage.setItem('sidebarLeftWidth', '520');
    setViewport(1100, false);
    const { result } = renderHook(() => useResizablePanels());
    expect(result.current.leftWidth).toBe(520);
  });
});
