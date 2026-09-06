import { describe, it, expect, vi } from 'vitest';
import { PlaceShadowController } from '../../../src/nest/place-shadow/place-shadow.controller';
import type { PlaceShadowService } from '../../../src/nest/place-shadow/place-shadow.service';
import type { PlaceShadowPickDto } from '../../../src/nest/place-shadow/place-shadow.dto';

function makeController(svc: Partial<PlaceShadowService>) {
  return new PlaceShadowController(svc as PlaceShadowService);
}

const BODY = {
  query: 'ecklife rostock',
  source: 'search:nominatim',
  liveRank: 2,
  liveCount: 6,
  pickedName: 'Ecklife',
  pickedLat: 54.083,
  pickedLng: 12.132,
} as PlaceShadowPickDto;

describe('PlaceShadowController', () => {
  describe('POST /api/place-shadow/pick', () => {
    it('answers 200 { recorded: false } when the log is off, never an error', () => {
      const record = vi.fn().mockReturnValue(false);
      expect(makeController({ record }).pick(BODY)).toEqual({ recorded: false });
      expect(record).toHaveBeenCalledWith(BODY);
    });

    it('reports a written row', () => {
      expect(makeController({ record: vi.fn().mockReturnValue(true) }).pick(BODY)).toEqual({ recorded: true });
    });
  });

  describe('GET /api/place-shadow/export', () => {
    const page = { version: 1 as const, generatedAt: 'now', rows: [], nextAfter: null };

    it('passes a positive cursor through', () => {
      const exp = vi.fn().mockReturnValue(page);
      makeController({ export: exp }).export('42');
      expect(exp).toHaveBeenCalledWith(42);
    });

    it('starts from the beginning for anything that is not a positive integer', () => {
      const exp = vi.fn().mockReturnValue(page);
      const c = makeController({ export: exp });
      for (const bad of [undefined, '', 'abc', '0', '-5', '1.5', '1e400']) {
        c.export(bad);
      }
      expect(exp.mock.calls.every(([arg]) => arg === undefined)).toBe(true);
    });
  });

  describe('DELETE /api/place-shadow', () => {
    it('reports how many rows went', () => {
      expect(makeController({ clear: vi.fn().mockReturnValue(17) }).clear()).toEqual({ removed: 17 });
    });
  });

  describe('GET /api/place-shadow/summary', () => {
    it('hands the service summary straight back', () => {
      const summary = { enabled: true, total: 3 };
      expect(makeController({ summary: vi.fn().mockReturnValue(summary) }).summary()).toBe(summary);
    });
  });
});
