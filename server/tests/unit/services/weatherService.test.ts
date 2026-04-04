import { describe, it, expect, vi, beforeAll } from 'vitest';

// Prevent the module-level setInterval from running during tests
vi.useFakeTimers();

// Mock node-fetch to prevent real HTTP requests
vi.mock('node-fetch', () => ({ default: vi.fn() }));

import { estimateCondition, cacheKey } from '../../../src/services/weatherService';

// ── estimateCondition ────────────────────────────────────────────────────────

describe('estimateCondition', () => {
  describe('heavy precipitation (precipMm > 5)', () => {
    it('returns Snow when temp <= 0', () => {
      expect(estimateCondition(0, 6)).toBe('Snow');
      expect(estimateCondition(-5, 10)).toBe('Snow');
    });

    it('returns Rain when temp > 0', () => {
      expect(estimateCondition(1, 6)).toBe('Rain');
      expect(estimateCondition(20, 50)).toBe('Rain');
    });

    it('boundary: precipMm = 5.01 and temp = 0 -> Snow', () => {
      expect(estimateCondition(0, 5.01)).toBe('Snow');
    });

    it('boundary: precipMm = 5 is NOT heavy (exactly 5, not > 5) -> falls through', () => {
      // precipMm = 5 fails the > 5 check, falls to > 1 check -> Snow or Drizzle
      expect(estimateCondition(0, 5)).toBe('Snow'); // > 1 and temp <= 0
      expect(estimateCondition(5, 5)).toBe('Drizzle'); // > 1 and temp > 0
    });
  });

  describe('moderate precipitation (precipMm > 1)', () => {
    it('returns Snow when temp <= 0', () => {
      expect(estimateCondition(0, 2)).toBe('Snow');
      expect(estimateCondition(-10, 1.5)).toBe('Snow');
    });

    it('returns Drizzle when temp > 0', () => {
      expect(estimateCondition(5, 2)).toBe('Drizzle');
      expect(estimateCondition(15, 3)).toBe('Drizzle');
    });
  });

  describe('light precipitation (precipMm > 0.3)', () => {
    it('returns Clouds regardless of temperature', () => {
      expect(estimateCondition(-5, 0.5)).toBe('Clouds');
      expect(estimateCondition(25, 0.5)).toBe('Clouds');
    });

    it('boundary: precipMm = 0.31 -> Clouds', () => {
      expect(estimateCondition(20, 0.31)).toBe('Clouds');
    });

    it('boundary: precipMm = 0.3 is NOT light precipitation -> falls through', () => {
      // precipMm = 0.3 fails the > 0.3 check, falls to temperature check
      expect(estimateCondition(20, 0.3)).toBe('Clear'); // temp > 15
      expect(estimateCondition(10, 0.3)).toBe('Clouds'); // temp <= 15
    });
  });

  describe('dry conditions (precipMm <= 0.3)', () => {
    it('returns Clear when temp > 15', () => {
      expect(estimateCondition(16, 0)).toBe('Clear');
      expect(estimateCondition(30, 0.1)).toBe('Clear');
    });

    it('returns Clouds when temp <= 15', () => {
      expect(estimateCondition(15, 0)).toBe('Clouds');
      expect(estimateCondition(10, 0)).toBe('Clouds');
      expect(estimateCondition(-5, 0)).toBe('Clouds');
    });

    it('boundary: temp = 15 -> Clouds (not > 15)', () => {
      expect(estimateCondition(15, 0)).toBe('Clouds');
    });
  });
});

// ── cacheKey ─────────────────────────────────────────────────────────────────

describe('cacheKey', () => {
  it('rounds lat and lng to 2 decimal places', () => {
    expect(cacheKey('48.8566', '2.3522', '2024-06-15')).toBe('48.86_2.35_2024-06-15');
  });

  it('uses "current" when date is undefined', () => {
    expect(cacheKey('10.0', '20.0')).toBe('10.00_20.00_current');
  });

  it('handles negative coordinates', () => {
    expect(cacheKey('-33.8688', '151.2093', '2024-01-01')).toBe('-33.87_151.21_2024-01-01');
  });

  it('pads to 2 decimal places for round numbers', () => {
    expect(cacheKey('48', '2', '2024-01-01')).toBe('48.00_2.00_2024-01-01');
  });

  it('preserves the date string as-is', () => {
    expect(cacheKey('0', '0', 'climate')).toBe('0.00_0.00_climate');
  });
});
