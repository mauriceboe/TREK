import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/db/database', () => ({
  db: { prepare: () => ({ all: () => [], get: vi.fn() }) },
}));

import { formatAssignmentWithPlace } from '../../../src/services/queryHelpers';
import type { AssignmentRow, Tag, Participant } from '../../../src/types';

function makeRow(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    id: 1,
    day_id: 10,
    place_id: 100,
    order_index: 0,
    notes: 'assignment note',
    created_at: '2024-01-01T00:00:00Z',
    place_name: 'Eiffel Tower',
    place_description: 'Famous landmark',
    lat: 48.8584,
    lng: 2.2945,
    address: 'Champ de Mars, Paris',
    category_id: 5,
    category_name: 'Sightseeing',
    category_color: '#3b82f6',
    category_icon: 'landmark',
    price: 25.0,
    place_currency: 'EUR',
    place_time: '10:00',
    end_time: '12:00',
    duration_minutes: 120,
    place_notes: 'Bring tickets',
    image_url: 'https://example.com/img.jpg',
    transport_mode: 'walk',
    google_place_id: 'ChIJLU7jZClu5kcR4PcOOO6p3I0',
    website: 'https://eiffel-tower.com',
    phone: '+33 1 2345 6789',
    ...overrides,
  } as AssignmentRow;
}

const sampleTags: Partial<Tag>[] = [
  { id: 1, name: 'Must-see', color: '#ef4444' },
];

const sampleParticipants: Participant[] = [
  { user_id: 42, username: 'alice', avatar: null },
];

describe('formatAssignmentWithPlace', () => {
  it('returns correct top-level shape', () => {
    const result = formatAssignmentWithPlace(makeRow(), sampleTags, sampleParticipants);
    expect(result).toHaveProperty('id', 1);
    expect(result).toHaveProperty('day_id', 10);
    expect(result).toHaveProperty('order_index', 0);
    expect(result).toHaveProperty('notes', 'assignment note');
    expect(result).toHaveProperty('created_at');
    expect(result).toHaveProperty('place');
    expect(result).toHaveProperty('participants');
  });

  it('nests place fields correctly from flat row', () => {
    const result = formatAssignmentWithPlace(makeRow(), [], []);
    const { place } = result;
    expect(place.id).toBe(100);
    expect(place.name).toBe('Eiffel Tower');
    expect(place.description).toBe('Famous landmark');
    expect(place.lat).toBe(48.8584);
    expect(place.lng).toBe(2.2945);
    expect(place.address).toBe('Champ de Mars, Paris');
    expect(place.price).toBe(25.0);
    expect(place.currency).toBe('EUR');
    expect(place.place_time).toBe('10:00');
    expect(place.end_time).toBe('12:00');
    expect(place.duration_minutes).toBe(120);
    expect(place.notes).toBe('Bring tickets');
    expect(place.image_url).toBe('https://example.com/img.jpg');
    expect(place.transport_mode).toBe('walk');
    expect(place.google_place_id).toBe('ChIJLU7jZClu5kcR4PcOOO6p3I0');
    expect(place.website).toBe('https://eiffel-tower.com');
    expect(place.phone).toBe('+33 1 2345 6789');
  });

  it('constructs place.category object when category_id is present', () => {
    const result = formatAssignmentWithPlace(makeRow(), [], []);
    expect(result.place.category).toEqual({
      id: 5,
      name: 'Sightseeing',
      color: '#3b82f6',
      icon: 'landmark',
    });
  });

  it('sets place.category to null when category_id is null', () => {
    const result = formatAssignmentWithPlace(makeRow({ category_id: null as any }), [], []);
    expect(result.place.category).toBeNull();
  });

  it('sets place.category to null when category_id is 0 (falsy)', () => {
    const result = formatAssignmentWithPlace(makeRow({ category_id: 0 as any }), [], []);
    expect(result.place.category).toBeNull();
  });

  it('includes provided tags in place.tags', () => {
    const result = formatAssignmentWithPlace(makeRow(), sampleTags, []);
    expect(result.place.tags).toEqual(sampleTags);
  });

  it('defaults place.tags to [] when empty array provided', () => {
    const result = formatAssignmentWithPlace(makeRow(), [], []);
    expect(result.place.tags).toEqual([]);
  });

  it('includes provided participants', () => {
    const result = formatAssignmentWithPlace(makeRow(), [], sampleParticipants);
    expect(result.participants).toEqual(sampleParticipants);
  });

  it('defaults participants to [] when empty array provided', () => {
    const result = formatAssignmentWithPlace(makeRow(), [], []);
    expect(result.participants).toEqual([]);
  });
});
