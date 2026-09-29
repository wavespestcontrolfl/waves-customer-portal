/**
 * markEventsFeatured stamps last_featured_occurrence_at from the occurrence
 * locked into the draft (send.event_occurrences), not the row's live
 * start_at: an RSS/iCal row can be advanced in place between drafting and
 * delivery while the email still shows the drafted date.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  return fn;
});
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const db = require('../models/db');
const { markEventsFeatured } = require('../services/newsletter-sender');

function wireRow(row) {
  const updates = [];
  db.transaction.mockImplementation(async (fn) => {
    const trx = () => {
      const q = {};
      q.where = jest.fn(() => q);
      q.forUpdate = jest.fn(() => q);
      q.first = jest.fn(async () => row);
      q.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
      return q;
    };
    return fn(trx);
  });
  return updates;
}

const ROW = {
  id: 'evt-1', title: 'Harbor Lights Walk', description: '', event_type: 'annual',
  recurrence_type: 'annual', times_featured: 0,
  start_at: new Date('2027-01-08T23:00:00Z'), // advanced in place after drafting
  end_at: null,
};

describe('markEventsFeatured occurrence stamp', () => {
  test('uses the occurrence locked into the draft when present', async () => {
    const updates = wireRow(ROW);
    await markEventsFeatured({
      event_ids: JSON.stringify(['evt-1']),
      event_occurrences: JSON.stringify({ 'evt-1': '2026-12-31T23:00:00.000Z' }),
    });
    expect(updates[0].last_featured_occurrence_at).toBe('2026-12-31T23:00:00.000Z');
  });

  test('falls back to the row start_at for sends without locked occurrences', async () => {
    const updates = wireRow(ROW);
    await markEventsFeatured({ event_ids: JSON.stringify(['evt-1']), event_occurrences: null });
    expect(updates[0].last_featured_occurrence_at).toEqual(ROW.start_at);
  });
});

describe('occurrence map saved with a send', () => {
  const { lockedEventOccurrences, resolveEventOccurrences } = jest.requireActual('../services/newsletter-draft');

  test('lockedEventOccurrences maps drafted events to their locked start', () => {
    expect(lockedEventOccurrences([
      { eventId: 'a', startAt: new Date('2026-12-31T23:00:00Z') },
      { eventId: 'b', startAt: null },
      { eventId: null, startAt: '2026-12-31T23:00:00Z' },
    ])).toEqual({ a: '2026-12-31T23:00:00.000Z' });
  });

  test('resolveEventOccurrences keeps the drafted dates, drops unlisted or invalid ones, and fills the rest from rows', async () => {
    const knex = jest.fn(() => {
      const q = {};
      q.whereIn = jest.fn(() => q);
      q.select = jest.fn(async () => [{ id: 'c', start_at: new Date('2027-01-05T15:00:00Z') }]);
      return q;
    });
    const json = await resolveEventOccurrences(knex, ['a', 'c'], {
      a: '2026-12-31T23:00:00.000Z', // drafted date wins over the live row
      c: 'not-a-date',
      z: '2026-12-31T23:00:00.000Z', // not in the saved list
    }, new Date('2026-12-28T12:00:00Z'));
    expect(JSON.parse(json)).toEqual({ a: '2026-12-31T23:00:00.000Z', c: '2027-01-05T15:00:00.000Z' });
  });

  test('resolveEventOccurrences falls back to the row for a drafted date that is stale or implausibly far out', async () => {
    const knex = jest.fn(() => {
      const q = {};
      q.whereIn = jest.fn(() => q);
      q.select = jest.fn(async () => [
        { id: 'stale', start_at: new Date('2027-01-05T15:00:00Z') },
        { id: 'far', start_at: new Date('2027-01-06T15:00:00Z') },
      ]);
      return q;
    });
    const json = await resolveEventOccurrences(knex, ['stale', 'far', 'yesterday'], {
      stale: '2026-11-01T23:00:00.000Z', // a tab left open for weeks
      far: '2028-01-01T23:00:00.000Z',
      yesterday: '2026-12-27T23:00:00.000Z', // still within the window
    }, new Date('2026-12-28T12:00:00Z'));
    expect(JSON.parse(json)).toEqual({
      yesterday: '2026-12-27T23:00:00.000Z',
      stale: '2027-01-05T15:00:00.000Z',
      far: '2027-01-06T15:00:00.000Z',
    });
  });
});
