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
