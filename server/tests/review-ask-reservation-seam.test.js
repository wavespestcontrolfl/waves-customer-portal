'use strict';

/**
 * reserveForRequest's age-bounded REUSE-VS-RENEW decision (codex #4331 P1,
 * pre-push audit on the seam itself).
 *
 * This is a SPACING-correctness fix, not a general-reader visibility one:
 * general readers hide an unresolved review-ask reservation unconditionally
 * regardless of age (see review-ask-reservation-general-readers.test.js — a
 * separate, later pre-push audit REBUTTED giving review-ask reservations a
 * 72h age bound mirroring the reply reservation's 24h one). What DOES still
 * need an age bound here is reuse: a retry that finds an existing
 * unresolved reservation must not blindly reuse its (possibly long-stale)
 * created_at — an uncertain outcome would compute a retryAt already in the
 * past, and lastManualAskAt/_askSpacingHold would anchor the next hold on a
 * timestamp from an attempt that ended long ago. The fix renews the SAME
 * row in place (created_at/updated_at reset to now) once it is older than
 * REVIEW_ASK_RESERVATION_HOLD_HOURS, rather than reusing it unchanged or
 * replacing it with a second row.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  reserveForRequest,
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

  test('(b) a reservation 73 hours old is renewed to now on the next attempt', async () => {
    const staleAt = new Date(Date.now() - 73 * 3600000);
    expect(Date.now() - staleAt.getTime()).toBeGreaterThan(REVIEW_ASK_RESERVATION_HOLD_HOURS * 3600000);
    const rows = installSmsLog([
      { id: 'res-stale', status: 'sending', created_at: staleAt, updated_at: staleAt, metadata: { review_ask_reservation: true, review_request_id: 'rr-1' }, message_body: 'old body', to_phone: '+19410000000' },
    ]);
    // Note: general-reader visibility (isUnresolvedSendReservation) is
    // UNCONDITIONAL for a review-ask marker regardless of age (see
    // review-ask-reservation-general-readers.test.js) — this test is about
    // spacing correctness (retryAt / lastManualAskAt), not hiding.

    const result = await reserveForRequest({ request, to: '+19410000009', body: 'new body', fromPhone: '+19415550000' });

    expect(result).toMatchObject({ id: 'res-stale', reused: true, renewed: true });
    // Same row — never a second reservation for this request.
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at.getTime()).toBeGreaterThan(staleAt.getTime());
    expect(Date.now() - rows[0].created_at.getTime()).toBeLessThan(5000);
    expect(rows[0].updated_at.getTime()).toEqual(rows[0].created_at.getTime());
    expect(rows[0].message_body).toBe('new body');
    expect(rows[0].to_phone).toBe('+19410000009');
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

describe('countStaleUnresolved — operator-facing visibility (pre-push audit: "the smallest honest exposure")', () => {
  test('counts only unresolved review-ask reservations older than the spacing window', async () => {
    const { countStaleUnresolved } = require('../services/messaging/review-ask-reservation');
    const stale = new Date(Date.now() - 73 * 3600000);
    const fresh = new Date(Date.now() - 3600000);
    const rows = [
      { id: 'stale-1', status: 'sending', created_at: stale, metadata: { review_ask_reservation: true, review_request_id: 'rr-a' } },
      { id: 'stale-2', status: 'sending', created_at: stale, metadata: { review_ask_reservation: true, review_request_id: 'rr-b' } },
      { id: 'fresh-1', status: 'sending', created_at: fresh, metadata: { review_ask_reservation: true, review_request_id: 'rr-c' } },
      // Resolved — not counted regardless of age.
      { id: 'resolved-1', status: 'sent', created_at: stale, metadata: { review_ask_reservation: true, review_request_id: 'rr-d' } },
    ];
    db.mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table ${table}`);
      let equals = {};
      let beforeCutoff = null;
      const q = {
        where(cond, op, val) {
          if (cond && typeof cond === 'object') { equals = { ...equals, ...cond }; return q; }
          if (op === '<') { beforeCutoff = val; return q; }
          return q;
        },
        whereRaw() { return q; },
        count() {
          const matched = rows.filter((r) => Object.entries(equals).every(([k, v]) => r[k] === v))
            .filter((r) => r.status === 'sending')
            .filter((r) => !beforeCutoff || new Date(r.created_at).getTime() < beforeCutoff.getTime());
          return { first: async () => ({ c: String(matched.length) }) };
        },
      };
      return q;
    });

    const count = await countStaleUnresolved();

    expect(count).toBe(2);
  });
});

describe('promote — deduplicated against the real provider log (codex #4333 P1, seam pre-push audit)', () => {
  // A fuller fake sms_log table: real filtering across where/whereIn/
  // whereNot/whereRaw(metadata correlation modeled in JS, not parsed) so
  // the realEvidence lookup, the dedup release, and the ordinary promote
  // UPDATE all resolve against the same fixture correctly.
  function installFullSmsLog(initialRows) {
    const rows = initialRows.map((r) => ({ ...r }));
    db.mockImplementation((table) => {
      if (table !== 'sms_log') throw new Error(`unexpected table ${table}`);
      let equals = {};
      let notEquals = {};
      let ins = {};
      let metaRequestId = null;
      const q = {
        where(cond) {
          if (cond && typeof cond === 'object') equals = { ...equals, ...cond };
          return q;
        },
        whereNot(col, val) { notEquals[col] = val; return q; },
        whereIn(col, vals) { ins[col] = vals; return q; },
        whereRaw(sql, bindings) {
          if (/review_request_id/.test(sql)) metaRequestId = bindings[0];
          return q;
        },
        matches(r) {
          if (!Object.entries(equals).every(([k, v]) => r[k] === v)) return false;
          if (!Object.entries(notEquals).every(([k, v]) => r[k] !== v)) return false;
          if (!Object.entries(ins).every(([k, vs]) => vs.includes(r[k]))) return false;
          if (metaRequestId != null && String(r.metadata?.review_request_id) !== String(metaRequestId)) return false;
          return true;
        },
        first() {
          return Promise.resolve(rows.find((r) => q.matches(r)) || null);
        },
        update(patch) {
          const match = rows.find((r) => q.matches(r));
          if (match) Object.assign(match, patch);
          return Promise.resolve(match ? 1 : 0);
        },
        del() {
          const before = rows.length;
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (q.matches(rows[i])) rows.splice(i, 1);
          }
          return Promise.resolve(before - rows.length);
        },
      };
      return q;
    });
    return rows;
  }

  test('releases the placeholder instead of promoting it when a real provider row already exists', async () => {
    const { promote } = require('../services/messaging/review-ask-reservation');
    const rows = installFullSmsLog([
      { id: 'res-1', status: 'sending', direction: 'outbound', metadata: { review_ask_reservation: true, review_request_id: 'rr-1' } },
      { id: 'real-1', status: 'sent', direction: 'outbound', twilio_sid: 'SM-real', metadata: { review_request_id: 'rr-1' } },
    ]);

    const result = await promote({ reservation: { id: 'res-1', requestId: 'rr-1' } });

    expect(result).toBe(true);
    // The placeholder is GONE — released, not promoted — leaving exactly
    // the one real provider row.
    expect(rows.find((r) => r.id === 'res-1')).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('real-1');
    expect(rows[0].status).toBe('sent');
  });

  test('promotes normally when no separately-logged provider row exists for the request', async () => {
    const { promote } = require('../services/messaging/review-ask-reservation');
    const rows = installFullSmsLog([
      { id: 'res-2', status: 'sending', direction: 'outbound', metadata: { review_ask_reservation: true, review_request_id: 'rr-2' } },
    ]);

    const result = await promote({ reservation: { id: 'res-2', requestId: 'rr-2' } });

    expect(result).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('res-2');
    expect(rows[0].status).toBe('sent');
  });

  test('a resolved row for a DIFFERENT request never blocks promotion (correlation is exact, not "any other row exists")', async () => {
    const { promote } = require('../services/messaging/review-ask-reservation');
    const rows = installFullSmsLog([
      { id: 'res-3', status: 'sending', direction: 'outbound', metadata: { review_ask_reservation: true, review_request_id: 'rr-3' } },
      { id: 'unrelated-1', status: 'sent', direction: 'outbound', metadata: { review_request_id: 'rr-other' } },
    ]);

    const result = await promote({ reservation: { id: 'res-3', requestId: 'rr-3' } });

    expect(result).toBe(true);
    expect(rows.find((r) => r.id === 'res-3').status).toBe('sent');
    expect(rows).toHaveLength(2);
  });
});
