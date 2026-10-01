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
  isOverdueReminderRow, countsAsSent, spacingHeldUntil, collapseDunningReminderEvents,
  summarizeDunningSpacingReplay, lastOverdueReminderWithin7d,
} = require('../services/collections/dunning-spacing');

const NOW = new Date('2026-09-28T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function row(overrides = {}) {
  return {
    id: 'ledger-1',
    customer_id: 'cust-1',
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
  q.wheres = [];
  q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
  ['whereIn', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => rows);
  return jest.fn(() => q);
}

describe('constants', () => {
  test('SPACING_DAYS is 7', () => {
    expect(SPACING_DAYS).toBe(7);
  });

  test('OVERDUE_SOURCES is exactly the five dunning rails, the follow-up rail\'s deferred replay and the customer-level schedule', () => {
    expect([...OVERDUE_SOURCES].sort()).toEqual([
      'balance_reminder_late_payment_check',
      'balance_reminder_workflow',
      'invoice_followup_replay',
      'invoice_followups',
      'invoice_followups_customer',
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

describe('dunning spacing replay event reduction', () => {
  const windowStart = new Date('2026-09-20T12:00:00.000Z');
  const at = (hoursAfterWindow) => new Date(windowStart.getTime() + hoursAfterWindow * HOUR_MS).toISOString();
  const event = (id, hoursAfterWindow, overrides = {}) => row({
    id,
    occurred_at: at(hoursAfterWindow),
    metadata: { notificationEventKey: `event-${id}` },
    ...overrides,
  });

  test('SMS and email rows for one event collapse to one candidate with no self-spacing', () => {
    const rows = [
      event('sms', 1, { channel: 'sms', metadata: { notificationEventKey: 'event-one' } }),
      event('email', 1 + 1 / 3600, { channel: 'email', metadata: { notificationEventKey: 'event-one' } }),
    ];
    const result = summarizeDunningSpacingReplay(rows, { windowStart });
    expect(result.events).toEqual([expect.objectContaining({ id: 'email', channel: 'email' })]);
    expect(result).toMatchObject({ candidatesInWindow: 1, spacedWithin7d: 0, customersAffected: 0 });
  });

  test('distinct event keys 6d23h apart remain separate and produce one spacing hit', () => {
    const result = summarizeDunningSpacingReplay([
      event('first', -1),
      event('second', 6 * 24 + 22),
    ], { windowStart });
    expect(result).toMatchObject({ candidatesInWindow: 1, spacedWithin7d: 1, customersAffected: 1 });
    expect(result.spacingHits[0]).toMatchObject({
      previous: expect.objectContaining({ id: 'first' }),
      current: expect.objectContaining({ id: 'second' }),
      hoursApart: 6 * 24 + 23,
    });
  });

  test('event keys are customer-scoped while keyless and blank-key rows stay independent', () => {
    const collapsed = collapseDunningReminderEvents([
      event('customer-a', 1, { customer_id: 'cust-a', metadata: { notificationEventKey: 'shared' } }),
      event('customer-b', 1, { customer_id: 'cust-b', metadata: { notificationEventKey: 'shared' } }),
      event('keyless-1', 2, { metadata: {} }),
      event('keyless-2', 3, { metadata: { notificationEventKey: '   ' } }),
    ]);
    expect(collapsed.map(({ id }) => id)).toEqual(['keyless-1', 'keyless-2', 'customer-a', 'customer-b']);
    const result = summarizeDunningSpacingReplay(collapsed, { windowStart });
    expect(result).toMatchObject({ candidatesInWindow: 4, spacedWithin7d: 1, customersAffected: 1 });
  });

  test('historical keyless follow-up legs of one step collapse by invoice + step; other steps and rails stay separate', () => {
    const legacy = (id, hours, overrides = {}) => event(id, hours, {
      source: 'invoice_followups', invoice_ids: ['inv-1'], metadata: { step_id: 'd3_friendly' }, ...overrides,
    });
    const collapsed = collapseDunningReminderEvents([
      legacy('fu-email', 1, { channel: 'email' }),
      legacy('fu-sms', 1 + 1 / 3600, { channel: 'sms', invoice_ids: '["inv-1"]' }),
      legacy('fu-next-step', 24 * 7 + 2, { metadata: { step_id: 'd10_reminder' } }),
      legacy('other-invoice', 3, { invoice_ids: ['inv-2'] }),
      event('checker-keyless', 4, { source: 'late_payment_checker', invoice_ids: ['inv-1'], metadata: { step_id: 'd3_friendly' } }),
    ]);
    expect(collapsed.map(({ id }) => id)).toEqual(['fu-sms', 'other-invoice', 'checker-keyless', 'fu-next-step']);
  });

  test('keyless legs of every rail collapse by customer + source + invoice set within 15 minutes (Codex r3)', () => {
    const leg = (id, minutes, overrides = {}) => event(id, minutes / 60, { metadata: {}, invoice_ids: ['inv-1'], ...overrides });
    const collapsed = collapseDunningReminderEvents([
      leg('checker-sms', 0, { source: 'late_payment_checker', channel: 'sms' }),
      leg('checker-email', 1, { source: 'late_payment_checker', channel: 'email' }),
      leg('balance-sms', 0, { source: 'balance_reminder_late_payment_check', channel: 'sms' }),
      leg('balance-email', 2, { source: 'balance_reminder_late_payment_check', channel: 'email', invoice_ids: '["inv-1"]' }),
      leg('checker-later', 60, { source: 'late_payment_checker' }),
      leg('checker-other-invoice', 1, { source: 'late_payment_checker', invoice_ids: ['inv-2'] }),
    ]);
    expect(collapsed.map(({ id }) => id).sort()).toEqual(['balance-email', 'checker-email', 'checker-later', 'checker-other-invoice']);
  });

  test('a customer-level schedule touch (dunning consolidation) is an overdue reminder, and its legs collapse into ONE event', () => {
    const { SOURCE, eventKey } = require('../services/customer-dunning/constants');
    const key = eventKey({ id: 'sched-1', episode: 1 }, 'd30_final');
    const leg = (id, channel, minutes) => event(id, minutes / 60, {
      source: SOURCE, purpose: 'late_payment', channel, invoice_ids: ['inv-1', 'inv-2'], metadata: { notificationEventKey: key },
    });
    const legs = [leg('cust-sms', 'sms', 0), leg('cust-push', 'push', 0.5), leg('cust-email', 'email', 2)];
    expect(legs.every(isOverdueReminderRow)).toBe(true);
    expect(collapseDunningReminderEvents(legs).map(({ id }) => id)).toEqual(['cust-email']);
    // The next step is its own event (a different key), 7 days on: one spacing candidate each, no self-hit.
    const next = event('cust-next', 7 * 24 + 1, {
      source: SOURCE, purpose: 'late_payment', metadata: { notificationEventKey: eventKey({ id: 'sched-1', episode: 1 }, 'd60_reminder') },
    });
    expect(summarizeDunningSpacingReplay([...legs, next], { windowStart })).toMatchObject({ candidatesInWindow: 2, spacedWithin7d: 0 });
  });

  test('JSON metadata dedupes and the latest sent retry wins with an id-stable timestamp tie', () => {
    const events = collapseDunningReminderEvents([
      event('first', 1, { source: 'invoice_followups', metadata: JSON.stringify({ notificationEventKey: 'retry' }) }),
      event('latest-z', 2, { source: 'balance_reminder_workflow', metadata: { notificationEventKey: 'retry' } }),
      event('latest-a', 2, { source: 'previsit_balance_reminder', metadata: { notificationEventKey: 'retry' } }),
    ]);
    expect(events).toEqual([expect.objectContaining({ id: 'latest-a', source: 'previsit_balance_reminder' })]);
  });

  test('a failed latest retry is removed before the delivered representative is picked', () => {
    const events = collapseDunningReminderEvents([
      event('delivered', 1, { metadata: { notificationEventKey: 'retry', delivered: true } }),
      event('failed', 2, { metadata: { notificationEventKey: 'retry', send_failed: true } }),
    ]);
    expect(events).toEqual([expect.objectContaining({ id: 'delivered' })]);
  });

  test('the lookback event participates, while an exact 7×24h gap does not hit', () => {
    const inside = summarizeDunningSpacingReplay([
      event('lookback', -1),
      event('inside', 6 * 24 + 22),
    ], { windowStart });
    expect(inside).toMatchObject({ candidatesInWindow: 1, spacedWithin7d: 1 });

    const boundary = summarizeDunningSpacingReplay([
      event('boundary-prev', -1),
      event('boundary-current', 7 * 24 - 1),
    ], { windowStart });
    expect(boundary).toMatchObject({ candidatesInWindow: 1, spacedWithin7d: 0 });
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

  test('the query is closed at now, so a row committed after the evaluation time never holds (Codex r3)', async () => {
    const database = fakeDatabase([]);
    await lastOverdueReminderWithin7d('cust-1', { now: NOW, database });
    const q = database.mock.results[0].value;
    expect(q.wheres).toContainEqual(['occurred_at', '<=', NOW]);
  });

  test('excludeIdempotencyKey drops a retry\'s own standing reservation (Codex r3)', async () => {
    const own = row({ id: 'ledger-own', source: 'invoice_followup_replay', idempotency_key: 'followup-replay:abc', metadata: { notificationEventKey: 'invoice-followup:seq-1:d3' }, occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    const other = row({ id: 'ledger-other', source: 'invoice_followup_replay', idempotency_key: 'followup-replay:xyz', metadata: { notificationEventKey: 'invoice-followup:seq-2:d3' }, occurred_at: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString() });
    const database = fakeDatabase([own, other]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database, excludeIdempotencyKey: 'followup-replay:abc' });
    expect(result).toEqual(other);
  });

  test('excludeEventKey drops the rest of the caller\'s own touch, e.g. a replay\'s delivered email leg (Codex r6)', async () => {
    const sibling = row({ id: 'email-leg', metadata: { notificationEventKey: 'invoice-followup:seq-1:d3' }, occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    const earlier = row({ id: 'earlier', metadata: { notificationEventKey: 'invoice-followup:seq-9:d3' }, occurred_at: new Date(NOW.getTime() - 3 * HOUR_MS).toISOString() });
    const database = fakeDatabase([sibling, earlier]);
    const result = await lastOverdueReminderWithin7d('cust-1', { now: NOW, database, excludeEventKey: 'invoice-followup:seq-1:d3' });
    expect(result).toEqual(earlier);
  });

  test('a deferred verification re-nudge flagged verification_renudge never holds, and replay drops it (Codex r7)', async () => {
    const renudge = row({ source: 'invoice_followup_replay', metadata: { verification_renudge: true }, occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    const database = fakeDatabase([renudge]);
    expect(await lastOverdueReminderWithin7d('cust-1', { now: NOW, database })).toBeNull();
    expect(collapseDunningReminderEvents([renudge])).toEqual([]);
  });

  test('a replay row from before replays carried their touch key is left out of live and replay evidence (Codex r8)', async () => {
    const legacy = row({ source: 'invoice_followup_replay', metadata: { replay: true }, occurred_at: new Date(NOW.getTime() - HOUR_MS).toISOString() });
    const keyed = row({ id: 'keyed', source: 'invoice_followup_replay', metadata: { replay: true, notificationEventKey: 'invoice-followup:seq-1:d3' }, occurred_at: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString() });
    const database = fakeDatabase([legacy, keyed]);
    expect(await lastOverdueReminderWithin7d('cust-1', { now: NOW, database })).toEqual(keyed);
    expect(collapseDunningReminderEvents([legacy, keyed]).map(({ id }) => id)).toEqual(['keyed']);
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
