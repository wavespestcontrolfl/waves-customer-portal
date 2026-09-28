/**
 * collections/dunning-spacing.js — the pure seven-day overdue-reminder
 * spacing rule (dunning-unification PR 1, SHADOW ONLY — see the module
 * header for what this deliberately leaves out of #5108's wide version).
 *
 * Pins: strict 7×24h from occurred_at (not calendar days) — 6d23h ago holds,
 * 7d01h ago does not; an exempt source never holds; a non-overdue-reminder
 * purpose never holds; a send_failed row with no delivered stamp is
 * ignored; a delivered:true row still counts even alongside send_failed;
 * excludeLedgerIds drops the row itself.
 */

const {
  SPACING_DAYS, OVERDUE_SOURCES, OVERDUE_PURPOSES, EXEMPT_SOURCES,
  isOverdueReminderRow, countsAsSent, spacingHeldUntil, lastOverdueReminderWithin7d,
} = require('../services/collections/dunning-spacing');

const NOW = new Date('2026-09-28T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function row(overrides = {}) {
  return {
    id: 'ledger-1',
    channel: 'sms',
    source: 'invoice_followups',
    purpose: 'invoice_followup',
    occurred_at: new Date(NOW.getTime() - 6 * 24 * HOUR_MS).toISOString(),
    metadata: {},
    ...overrides,
  };
}

// A fake knex-table function: chainable where/whereIn/where/orderBy, then a
// terminal select() resolving to the supplied rows.
function fakeDatabase(rows) {
  const q = {};
  ['where', 'whereIn', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => rows);
  return jest.fn(() => q);
}

describe('constants', () => {
  test('SPACING_DAYS is 7', () => {
    expect(SPACING_DAYS).toBe(7);
  });

  test('OVERDUE_SOURCES is exactly the five dunning-rail sources', () => {
    expect([...OVERDUE_SOURCES].sort()).toEqual([
      'balance_reminder_late_payment_check',
      'balance_reminder_workflow',
      'invoice_followups',
      'late_payment_checker',
      'previsit_balance_reminder',
    ]);
  });

  test('OVERDUE_PURPOSES is exactly the three overdue-reminder purposes', () => {
    expect([...OVERDUE_PURPOSES].sort()).toEqual(['balance_reminder', 'invoice_followup', 'late_payment']);
  });

  test('EXEMPT_SOURCES is the pay-link and prepay-reminder sources', () => {
    expect([...EXEMPT_SOURCES].sort()).toEqual(['annual_prepay_payment_reminder', 'collections_voice_paylink']);
  });
});

describe('isOverdueReminderRow', () => {
  test('a known source + known purpose row is an overdue reminder', () => {
    expect(isOverdueReminderRow(row())).toBe(true);
  });

  test('an exempt source is never an overdue reminder even with a matching purpose', () => {
    expect(isOverdueReminderRow(row({ source: 'collections_voice_paylink', purpose: 'balance_reminder' }))).toBe(false);
    expect(isOverdueReminderRow(row({ source: 'annual_prepay_payment_reminder', purpose: 'balance_reminder' }))).toBe(false);
  });

  test('a non-overdue purpose on a known source is not an overdue reminder', () => {
    expect(isOverdueReminderRow(row({ purpose: 'payment_link' }))).toBe(false);
    expect(isOverdueReminderRow(row({ source: 'late_payment_checker', purpose: 'payment_verification' }))).toBe(false);
  });

  test('an unknown source is not an overdue reminder even with a matching purpose', () => {
    expect(isOverdueReminderRow(row({ source: 'some_other_rail' }))).toBe(false);
  });
});

describe('countsAsSent', () => {
  test('a plain row with no delivered/send_failed flag counts (safe default)', () => {
    expect(countsAsSent(row({ metadata: {} }))).toBe(true);
  });

  test('send_failed without a delivered stamp is ignored', () => {
    expect(countsAsSent(row({ metadata: { send_failed: true } }))).toBe(false);
  });

  test('delivered:true counts even alongside send_failed', () => {
    expect(countsAsSent(row({ metadata: { delivered: true, send_failed: true } }))).toBe(true);
  });

  test('delivered:true alone counts', () => {
    expect(countsAsSent(row({ metadata: { delivered: true } }))).toBe(true);
  });

  test('a JSON-string metadata column parses the same way', () => {
    expect(countsAsSent(row({ metadata: JSON.stringify({ send_failed: true }) }))).toBe(false);
  });
});

describe('spacingHeldUntil', () => {
  test('is exactly 7×24h after occurred_at', () => {
    const occurredAt = '2026-09-01T00:00:00.000Z';
    expect(spacingHeldUntil(occurredAt).toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('lastOverdueReminderWithin7d', () => {
  test('a row 6d23h ago is held', async () => {
    const held = row({ occurred_at: new Date(NOW.getTime() - (6 * 24 + 23) * HOUR_MS).toISOString() });
    const database = fakeDatabase([held]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    expect(result).toEqual(held);
  });

  test('a row 7d01h ago is not held', async () => {
    const stale = row({ occurred_at: new Date(NOW.getTime() - (7 * 24 + 1) * HOUR_MS).toISOString() });
    const database = fakeDatabase([stale]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    expect(result).toBeNull();
  });

  test('an exempt source never holds even if recent', async () => {
    const paylink = row({ source: 'collections_voice_paylink', occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    const database = fakeDatabase([paylink]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    expect(result).toBeNull();
  });

  test('a non-overdue purpose never holds even if recent', async () => {
    const receipt = row({ purpose: 'payment_receipt', occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    const database = fakeDatabase([receipt]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    expect(result).toBeNull();
  });

  test('send_failed without delivered is ignored', async () => {
    const failed = row({
      metadata: { send_failed: true },
      occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    });
    const database = fakeDatabase([failed]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    expect(result).toBeNull();
  });

  test('delivered:true with send_failed still counts', async () => {
    const deliveredAnyway = row({
      metadata: { delivered: true, send_failed: true },
      occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    });
    const database = fakeDatabase([deliveredAnyway]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    expect(result).toEqual(deliveredAnyway);
  });

  test('excludeLedgerIds excludes the row itself', async () => {
    const held = row({ id: 'ledger-9', occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    const database = fakeDatabase([held]);
    const result = await lastOverdueReminderWithin7d('cust-1', {
      now: NOW, database, excludeLedgerIds: ['ledger-9'],
    });
    expect(result).toBeNull();
  });

  test('no rows at all returns null', async () => {
    const database = fakeDatabase([]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    expect(result).toBeNull();
  });

  test('missing customerId or database returns null without querying', async () => {
    const database = fakeDatabase([row()]);
    expect(await lastOverdueReminderWithin7d(null, { now: NOW, database })).toBeNull();
    expect(await lastOverdueReminderWithin7d('cust-1', { now: NOW })).toBeNull();
    expect(database).not.toHaveBeenCalled();
  });
});
