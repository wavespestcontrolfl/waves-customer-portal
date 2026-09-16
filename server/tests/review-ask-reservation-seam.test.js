'use strict';

/**
 * reserveForRequest's age-bounded reuse (codex #4331 P1, pre-push audit on
 * the seam itself). A retry that finds an existing unresolved reservation
 * must not blindly reuse its (possibly stale) created_at: once a
 * reservation is older than its own hold window
 * (REVIEW_ASK_RESERVATION_HOLD_HOURS), reusing it as-is would compute a
 * retryAt already in the past for an uncertain outcome, read as
 * resolved-and-gone to every general reader's 72h hide, and — were some
 * future age-based cleanup ever added — could be reclaimed while this very
 * attempt still depends on it. The fix renews the SAME row in place
 * (created_at/updated_at reset to now) rather than reusing it unchanged or
 * replacing it with a second row.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  reserveForRequest,
  isUnresolvedSendReservation,
  REVIEW_ASK_RESERVATION_HOLD_HOURS,
} = require('../services/messaging/review-ask-reservation');

// A minimal fake sms_log table: real equality filtering (enough for these
// single-row fixtures), whereRaw is a no-op pass-through (same convention
// review-sequences.test.js's own mock uses) since every fixture here holds
// at most one candidate row.
function installSmsLog(initialRows) {
  const rows = initialRows.map((r) => ({ ...r }));
  let nextId = rows.length + 1;
  db.mockImplementation((table) => {
    if (table !== 'sms_log') throw new Error(`unexpected table ${table}`);
    let equals = {};
    const q = {
      where(cond) {
        if (cond && typeof cond === 'object') equals = { ...equals, ...cond };
        return q;
      },
      whereRaw() { return q; },
      first() {
        const match = rows.find((r) => Object.entries(equals).every(([k, v]) => r[k] === v));
        return Promise.resolve(match || null);
      },
      update(patch) {
        const match = rows.find((r) => Object.entries(equals).every(([k, v]) => r[k] === v));
        if (match) Object.assign(match, patch);
        return Promise.resolve(match ? 1 : 0);
      },
      insert(row) {
        const inserted = { id: `sms-${nextId++}`, ...row };
        rows.push(inserted);
        return { returning: async () => [inserted] };
      },
    };
    return q;
  });
  return rows;
}

describe('reserveForRequest — age-bounded reuse', () => {
  const request = { id: 'rr-1', customer_id: 'cust-1' };

  test('(a) an unresolved reservation 1 minute old is reused unchanged', async () => {
    const createdAt = new Date(Date.now() - 60000);
    const rows = installSmsLog([
      { id: 'res-fresh', status: 'sending', created_at: createdAt, updated_at: createdAt, metadata: { review_ask_reservation: true, review_request_id: 'rr-1' }, message_body: 'old body', to_phone: '+19410000000' },
    ]);

    const result = await reserveForRequest({ request, to: '+19410000009', body: 'new body', fromPhone: '+19415550000' });

    expect(result).toMatchObject({ id: 'res-fresh', reused: true });
    expect(result.renewed).not.toBe(true);
    expect(result.reservedAt).toEqual(createdAt);
    expect(rows).toHaveLength(1);
    // Untouched — no renewal write happened.
    expect(rows[0].created_at).toEqual(createdAt);
    expect(rows[0].message_body).toBe('old body');
    expect(rows[0].to_phone).toBe('+19410000000');
  });

  test('(b) a reservation 73 hours old is renewed to now on the next attempt, and no longer matches the hide/sweep filter', async () => {
    const staleAt = new Date(Date.now() - 73 * 3600000);
    expect(Date.now() - staleAt.getTime()).toBeGreaterThan(REVIEW_ASK_RESERVATION_HOLD_HOURS * 3600000);
    const rows = installSmsLog([
      { id: 'res-stale', status: 'sending', created_at: staleAt, updated_at: staleAt, metadata: { review_ask_reservation: true, review_request_id: 'rr-1' }, message_body: 'old body', to_phone: '+19410000000' },
    ]);
    // Before renewal, this row already reads as resolved-and-gone to every
    // general reader (the exact "sweep ignores it mid-delivery" risk).
    expect(isUnresolvedSendReservation(rows[0])).toBe(false);

    const result = await reserveForRequest({ request, to: '+19410000009', body: 'new body', fromPhone: '+19415550000' });

    expect(result).toMatchObject({ id: 'res-stale', reused: true, renewed: true });
    // Same row — never a second reservation for this request.
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at.getTime()).toBeGreaterThan(staleAt.getTime());
    expect(Date.now() - rows[0].created_at.getTime()).toBeLessThan(5000);
    expect(rows[0].updated_at.getTime()).toEqual(rows[0].created_at.getTime());
    expect(rows[0].message_body).toBe('new body');
    expect(rows[0].to_phone).toBe('+19410000009');
    // Renewed, it is live in-flight evidence again — hidden from general
    // readers exactly as a brand-new reservation would be.
    expect(isUnresolvedSendReservation(rows[0])).toBe(true);
  });

  test('a second renewal attempt on an already-fresh (just-renewed) row reuses it unchanged', async () => {
    // Guards against the renewal branch firing on every call once triggered
    // once — after renewal the row is fresh, so the very next lookup takes
    // the ordinary (a) path.
    const staleAt = new Date(Date.now() - 73 * 3600000);
    const rows = installSmsLog([
      { id: 'res-stale2', status: 'sending', created_at: staleAt, updated_at: staleAt, metadata: { review_ask_reservation: true, review_request_id: 'rr-1' }, message_body: 'old body', to_phone: '+19410000000' },
    ]);
    const first = await reserveForRequest({ request, to: '+19410000009', body: 'new body', fromPhone: '+19415550000' });
    expect(first.renewed).toBe(true);
    const renewedAt = rows[0].created_at;

    const second = await reserveForRequest({ request, to: '+19410000009', body: 'new body', fromPhone: '+19415550000' });

    expect(second).toMatchObject({ id: 'res-stale2', reused: true });
    expect(second.renewed).not.toBe(true);
    expect(rows[0].created_at).toEqual(renewedAt);
    expect(rows).toHaveLength(1);
  });
});
