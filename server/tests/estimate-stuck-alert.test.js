/**
 * The office's stuck-booking alert (estimate page audit fix 3, owner 2026-11-05 "1, 2 and 3").
 *
 * A customer who could not book left no trace and rang no bell: one found no open time, called, and only then did
 * the office learn of it. These tests hold the approved words of each reason, the one-ring-per-estimate-per-day
 * rule, the records the next booking audit reads, the requests that must never raise (bots, staff, an estimate
 * never sent, a settled one, the refusals the page walks a customer through), and that no entry point throws or
 * logs a query error's text (on these routes it can carry the link token).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'bell-1', deduped: false })),
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async () => 1),
}));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'bell-1', deduped: false })),
}));
jest.mock('../services/audit-log', () => ({ auditEstimateBookingStep: jest.fn(async () => undefined) }));
jest.mock('../services/customer-page-views', () => ({ shouldRecord: jest.fn(() => true) }));
jest.mock('../services/notification-bell-policy', () => ({
  isBellPolicyEnabled: jest.fn(() => true),
  bellAllowed: jest.fn(async () => true),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { alertEpisodesLive } = require('../config/feature-gates');
const episodes = require('../services/admin-alert-episodes');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { auditEstimateBookingStep } = require('../services/audit-log');
const { shouldRecord } = require('../services/customer-page-views');
const bellPolicy = require('../services/notification-bell-policy');
const { etDateString } = require('../utils/datetime-et');
const stuck = require('../services/estimate-stuck-alert');

const EST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REQ = { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } };
const OPEN_ROW = {
  id: EST, status: 'viewed', sent_at: '2026-10-28T15:00:00.000Z', archived_at: null,
  expires_at: '2026-11-04T15:00:00.000Z', customer_id: 'cust-1', customer_name: 'Pat Tester',
};

// A knex stand-in: every table answers from `tables`, by the where() it was asked.
let tables;
function chain(table) {
  const wheres = [];
  const q = {
    where: jest.fn((w) => { wheres.push(w); return q; }),
    whereIn: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    whereRaw: jest.fn((sql, binds) => { wheres.push({ raw: sql, binds }); return q; }),
    orderBy: jest.fn(() => q),
    limit: jest.fn(() => q),
    select: jest.fn(async () => (tables[table]?.select ? tables[table].select(wheres) : [])),
    first: jest.fn(async () => (tables[table]?.first ? tables[table].first(wheres) : undefined)),
  };
  return q;
}

const estimateRow = (row) => ({ first: () => row });
const trailOf = (rows) => ({ select: () => rows, first: () => undefined });
const search = (empty) => ({ action: 'estimate_slot_search', metadata: { via: 'date', empty } });

// The one alert raised: [headline, why, opts] from the episodes wrapper.
const raised = () => episodes.raiseAdminAlertWithReopen.mock.calls.map(([, headline, why, opts]) => ({ headline, why, opts }));

beforeEach(() => {
  jest.clearAllMocks();
  tables = { estimates: estimateRow(OPEN_ROW) };
  db.mockImplementation((table) => chain(table));
  alertEpisodesLive.mockReturnValue(true);
  shouldRecord.mockReturnValue(true);
  bellPolicy.isBellPolicyEnabled.mockReturnValue(true);
  bellPolicy.bellAllowed.mockResolvedValue(true);
});

describe('the reasons, in the approved words', () => {
  test('the 90-day look-ahead found no times: names the customer, links the estimate, one key per estimate', async () => {
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { windowDays: 90 }, { primary: [], expander: [] });
    const [alert] = raised();
    expect(alert.headline).toBe('Estimates — Pat Tester is stuck booking a visit');
    expect(alert.why).toBe('No open times in 90 days.');
    expect(alert.opts).toMatchObject({
      dedupeKey: `estimate_stuck:${EST}`,
      dedupeVersion: etDateString(new Date()),
      refreshOnDedupe: true,
      bumpOnRefresh: true,
      link: `/admin/estimates?estimateId=${EST}`,
      metadata: expect.objectContaining({
        triggerKey: 'estimate_stuck', estimateId: EST, customerId: 'cust-1', stuckReason: 'stuck',
        severity: 'needs-you', subject: { type: 'estimate', id: EST },
      }),
    });
  });

  test('the look-ahead with times, or naming a first open day its capped list left out, or the 14-day list coming back empty, raises nothing', async () => {
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { windowDays: 90 }, { primary: [{ date: '2026-12-01' }] });
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { windowDays: 90 }, { primary: [], expander: [], metadata: { firstDayAvailability: { date: '2026-12-01' } } });
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, {}, { primary: [], expander: [] });
    expect(raised()).toEqual([]);
    expect(auditEstimateBookingStep).not.toHaveBeenCalled();
  });

  test('five date searches in a row that found nothing: "Searched 5 dates, all empty."', async () => {
    tables.audit_log = trailOf([search(true), search(true), search(true), { ...search(true), metadata: '{"empty":true}' }, search(true), search(false)]);
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { date: '2026-12-01' }, { primary: [], expander: [] });
    expect(auditEstimateBookingStep).toHaveBeenCalledWith({
      action: 'estimate_slot_search', estimateId: EST, customerId: 'cust-1',
      metadata: { via: 'date', date: '2026-12-01', empty: true },
    });
    expect(raised().map((a) => a.why)).toEqual(['Searched 5 dates, all empty.']);
  });

  test('four empty searches, or a run a found time or a started hold broke, raises nothing', async () => {
    tables.audit_log = trailOf([search(true), search(true), search(true), search(true)]);
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { date: '2026-12-01' }, { primary: [] });
    tables.audit_log = trailOf([search(true), search(true), search(false), search(true), search(true), search(true)]);
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { date: '2026-12-02' }, { primary: [] });
    tables.audit_log = trailOf([search(true), search(true), { action: 'estimate_hold_started', metadata: {} }, search(true), search(true), search(true)]);
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { date: '2026-12-03' }, { primary: [] });
    expect(raised()).toEqual([]);
  });

  test('a Waves AI search is recorded as one, and counts toward the run', async () => {
    tables.audit_log = trailOf([search(true), search(true), search(true), search(true), search(true)]);
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { search: 'ai' }, { availableSlots: [] });
    expect(auditEstimateBookingStep).toHaveBeenCalledWith(expect.objectContaining({
      action: 'estimate_slot_search', metadata: { via: 'ai', date: null, empty: true },
    }));
    expect(raised()).toHaveLength(1);
  });

  test('a hold the customer picked expired unbooked: "Picked Tue 9 AM, did not finish."', async () => {
    tables.audit_log = { first: () => ({ id: 'trace-1' }) };
    tables.scheduled_services = { first: () => undefined };
    await stuck.noteExpiredHolds([
      { id: 'hold-1', source_estimate_id: EST, scheduled_date: '2026-11-10', window_start: '09:00:00', created_at: '2026-11-05T14:00:00Z' },
    ]);
    expect(auditEstimateBookingStep).toHaveBeenCalledWith({
      action: 'estimate_hold_ended', estimateId: EST, customerId: null,
      metadata: { scheduled_service_id: 'hold-1', how: 'expired', date: '2026-11-10', window_start: '09:00:00' },
    });
    expect(raised().map((a) => a.why)).toEqual(['Picked Tue 9 AM, did not finish.']);
  });

  test('the time list answered an error: "The time list did not load."; a capacity retry is not one', async () => {
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, Object.assign(new Error('capacity'), { code: 'SLOT_UNAVAILABLE' }));
    expect(raised()).toEqual([]);
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    expect(raised().map((a) => a.why)).toEqual(['The time list did not load.']);
  });

  test('Approve was refused: the server\'s own first sentence, underscores read as spaces', async () => {
    await stuck.noteAcceptRefused(REQ, EST, 409, {
      error: 'One of this estimate’s plan options is no longer offered. Call us.', code: 'service_cadence_tier_unavailable',
    });
    await stuck.noteAcceptRefused(REQ, EST, 422, { error: 'missing service_address on file' });
    expect(raised().map((a) => a.why)).toEqual([
      'Approve was refused: One of this estimate’s plan options is no longer offered.',
      'Approve was refused: missing service address on file.',
    ]);
  });

  test('a refusal whose words break the alert rules gives the plain line', async () => {
    await stuck.noteAcceptRefused(REQ, EST, 409, { error: 'Locked until 2026-11-09', code: 'some_lock' });
    await stuck.noteAcceptRefused(REQ, EST, 409, { error: '', code: 'no_words' });
    expect(raised().map((a) => a.why)).toEqual([
      'Approve was refused; the page showed them why.',
      'Approve was refused; the page showed them why.',
    ]);
  });

  test('back on an expired estimate: what the page offered them, with the day it expired', async () => {
    await stuck.noteExpiredReturn(OPEN_ROW, { offered: true, selfServe: true });
    await stuck.noteExpiredReturn(OPEN_ROW, { offered: true, selfServe: false });
    await stuck.noteExpiredReturn(OPEN_ROW, { offered: false });
    expect(raised().map((a) => a.headline)[0]).toBe('Estimates — Pat Tester came back to an expired estimate');
    expect(raised().map((a) => a.why)).toEqual([
      'It expired on Nov 4; they can reopen it for 7 days at the same price.',
      'It expired on Nov 4; they can ask you for more time.',
      'It expired on Nov 4 and the page shows it as not found.',
    ]);
    expect(raised()[0].opts.metadata.stuckReason).toBe('expired');
  });

  test('a name the alert rules refuse becomes "A customer"; a long one is cut to fit the headline', async () => {
    tables.estimates = estimateRow({ ...OPEN_ROW, customer_name: 'Pat 🐜' });
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    tables.estimates = estimateRow({ ...OPEN_ROW, customer_name: 'Bartholomew Montgomery-Fitzgerald Junior' });
    await stuck.noteExpiredReturn(OPEN_ROW, { offered: true, selfServe: true });
    const [plain, long] = raised().map((a) => a.headline);
    expect(plain).toBe('Estimates — A customer is stuck booking a visit');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(/^Estimates — Bartholomew.*estimate expired$/);
  });
});

describe('one alert per estimate per day', () => {
  test('rings on the first reason of a new Eastern day, and refreshes quietly after that', async () => {
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    const { ringOnRefresh, metadata } = raised()[0].opts;
    expect(ringOnRefresh({}, { stuckDay: metadata.stuckDay })).toBe(false);
    expect(ringOnRefresh({}, { stuckDay: '2026-11-04' })).toBe(true);
    expect(ringOnRefresh({}, {})).toBe(true);
  });

  test('with alert episodes off it raises through raiseAdminAlert with the same key, day and banner', async () => {
    alertEpisodesLive.mockReturnValue(false);
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledWith('estimate_stuck', expect.objectContaining({
      area: 'Estimates', action: 'Pat Tester is stuck booking a visit', why: 'The time list did not load.', severity: 'needs-you',
    }), expect.objectContaining({
      dedupeKey: `estimate_stuck:${EST}`, dedupeVersion: etDateString(new Date()),
      metadata: expect.objectContaining({ triggerKey: 'estimate_stuck' }),
    }));
  });
});

describe('what never raises', () => {
  test('a bot, a staff browser or the office network: no record and no alert', async () => {
    shouldRecord.mockReturnValue(false);
    tables.audit_log = trailOf([search(true), search(true), search(true), search(true), search(true)]);
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { date: '2026-12-01' }, { primary: [] });
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { windowDays: 90 }, { primary: [] });
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    await stuck.noteHoldStarted(REQ, OPEN_ROW, { scheduledServiceId: 'hold-1' });
    await stuck.noteAcceptRefused(REQ, EST, 409, { error: 'Something odd.', code: 'odd' });
    expect(auditEstimateBookingStep).not.toHaveBeenCalled();
    expect(raised()).toEqual([]);
  });

  test('an answer that books nothing by design (office review, commercial, invoice-only)', async () => {
    for (const flag of ['reviewBeforeBooking', 'commercialManualScheduling', 'invoiceOnlyAcceptance']) {
      await stuck.noteSlotAnswer(REQ, OPEN_ROW, { windowDays: 90 }, { primary: [], [flag]: true });
    }
    expect(raised()).toEqual([]);
  });

  test('an estimate never sent, or one accepted, declined or archived', async () => {
    for (const row of [
      { ...OPEN_ROW, sent_at: null },
      { ...OPEN_ROW, status: 'accepted' },
      { ...OPEN_ROW, status: 'declined' },
      { ...OPEN_ROW, archived_at: '2026-11-05T12:00:00Z' },
      undefined,
    ]) {
      tables.estimates = estimateRow(row);
      await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    }
    expect(raised()).toEqual([]);
  });

  test('a category the owner silenced in Push Settings: no raise and no refresh, though the records still land', async () => {
    bellPolicy.bellAllowed.mockResolvedValue(false);
    tables.audit_log = trailOf([search(true), search(true), search(true), search(true), search(true)]);
    await stuck.noteSlotAnswer(REQ, OPEN_ROW, { date: '2026-12-01' }, { primary: [] });
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    await stuck.noteExpiredReturn(OPEN_ROW, { offered: true, selfServe: true });
    alertEpisodesLive.mockReturnValue(false);
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    expect(raised()).toEqual([]);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(bellPolicy.bellAllowed).toHaveBeenCalledWith({ category: 'estimate_stuck' });
    expect(auditEstimateBookingStep).toHaveBeenCalledWith(expect.objectContaining({ action: 'estimate_slot_search' }));
  });

  test('with the bell policy off a saved mute is not read: the alert raises', async () => {
    bellPolicy.isBellPolicyEnabled.mockReturnValue(false);
    bellPolicy.bellAllowed.mockResolvedValue(false);
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    expect(raised()).toHaveLength(1);
    expect(bellPolicy.bellAllowed).not.toHaveBeenCalled();
  });

  test('an expired estimate still raises (the office can still help)', async () => {
    tables.estimates = estimateRow({ ...OPEN_ROW, status: 'expired' });
    await stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'));
    expect(raised()).toHaveLength(1);
  });

  test('the refusals the page recovers from: refreshed terms, a busy retry, a taken time, a no-booking reload, cards, not found, the rate limit', async () => {
    const routine = [...stuck._private.ROUTINE_ACCEPT_CODES];
    expect(routine).toEqual(expect.arrayContaining([
      'TERMS_VERSION_STALE', 'ACCEPT_INVOICE_BUSY_RETRY', 'SLOT_UNAVAILABLE', 'RESERVATION_EXPIRED', 'ACCEPT_NEEDS_OFFICE_REVIEW',
      'BERMUDA_SUPPRESSION_GATED', 'AREA_ADDON_YEARLY_LIMIT_REACHED', 'MOSQUITO_MISTING_GATED',
    ]));
    for (const code of routine) await stuck.noteAcceptRefused(REQ, EST, 409, { error: 'Please confirm again.', code });
    for (const status of [402, 404, 429]) await stuck.noteAcceptRefused(REQ, EST, status, { error: 'Card needed.', code: 'odd' });
    // The server's uncoded words the page reads the same way (EstimateViewPage performAccept).
    for (const error of [
      'slot no longer available — re-pick a slot',
      'Reservation expired — please pick a time again',
      'no active reservation for this estimate',
      'existing appointment is no longer available — re-pick a slot',
      'This estimate is no longer active',
    ]) await stuck.noteAcceptRefused(REQ, EST, 409, { error });
    await stuck.noteAcceptRefused(REQ, EST, 409, { error: 'This plan books nothing online.', code: 'odd', reviewBeforeBooking: true });
    await stuck.noteAcceptRefused(REQ, null, 409, { error: 'Something odd.', code: 'odd' });
    expect(raised()).toEqual([]);
  });

  test('a "call the office" billing refusal and an uncoded estimate refusal do raise', async () => {
    await stuck.noteAcceptRefused(REQ, EST, 409, {
      error: 'We could not confirm this plan’s pricing online — please call the office and we’ll finish it for you.',
      code: 'PER_APPLICATION_ADD_ON_UNPRICED',
    });
    await stuck.noteAcceptRefused(REQ, EST, 409, { error: 'This estimate is being re-priced — please try again in a few minutes' });
    expect(raised().map((a) => a.why)).toEqual([
      'Approve was refused: We could not confirm this plan’s pricing online — please call the office and we’ll…',
      'Approve was refused: This estimate is being re-priced — please try again in a few minutes.',
    ]);
  });

  test('an expired hold no customer started (a staff or bot hold), or one with a newer live hold', async () => {
    const hold = { id: 'hold-1', source_estimate_id: EST, scheduled_date: '2026-11-10', window_start: '09:00:00', created_at: '2026-11-05T14:00:00Z' };
    tables.audit_log = { first: () => undefined };
    tables.scheduled_services = { first: () => undefined };
    await stuck.noteExpiredHolds([hold]);
    tables.audit_log = { first: () => ({ id: 'trace-1' }) };
    tables.scheduled_services = { first: () => ({ id: 'hold-2' }) };
    await stuck.noteExpiredHolds([hold]);
    expect(raised()).toEqual([]);
    // Each end is still recorded.
    expect(auditEstimateBookingStep).toHaveBeenCalledTimes(2);
  });
});

describe('the hold records', () => {
  test('a hold start keeps the hold\'s own day and time; a release records its end', async () => {
    tables.scheduled_services = { first: () => ({ scheduled_date: '2026-11-14', window_start: '11:30:00' }) };
    await stuck.noteHoldStarted(REQ, OPEN_ROW, { scheduledServiceId: 'hold-1', expiresAt: '2026-11-06T04:15:00.000Z' });
    await stuck.noteHoldReleased(REQ, OPEN_ROW, { scheduledServiceId: 'hold-1', released: true });
    await stuck.noteHoldReleased(REQ, OPEN_ROW, { scheduledServiceId: 'hold-2', released: false });
    expect(auditEstimateBookingStep.mock.calls.map(([step]) => [step.action, step.metadata])).toEqual([
      ['estimate_hold_started', { scheduled_service_id: 'hold-1', date: '2026-11-14', window_start: '11:30:00', expires_at: '2026-11-06T04:15:00.000Z' }],
      ['estimate_hold_ended', { scheduled_service_id: 'hold-1', how: 'released' }],
    ]);
  });

  test('the sweep records every estimate hold, skips other holds, and raises once per estimate for the newest', async () => {
    tables.audit_log = { first: () => ({ id: 'trace' }) };
    tables.scheduled_services = { first: () => undefined };
    tables.estimates = { first: (wheres) => ({ ...OPEN_ROW, id: wheres[0].id }) };
    await stuck.noteExpiredHolds([
      { id: 'hold-1', source_estimate_id: EST, scheduled_date: '2026-11-10', window_start: '09:00:00', created_at: '2026-11-05T14:00:00Z' },
      { id: 'hold-2', source_estimate_id: EST, scheduled_date: '2026-11-14', window_start: '11:30:00', created_at: '2026-11-05T14:05:00Z' },
      { id: 'hold-3', source_estimate_id: null, scheduled_date: '2026-11-10', window_start: '10:00:00', created_at: '2026-11-05T14:01:00Z' },
      { id: 'hold-4', source_estimate_id: OTHER, scheduled_date: '2026-11-09', window_start: '12:00:00', created_at: '2026-11-05T14:02:00Z' },
    ]);
    expect(auditEstimateBookingStep).toHaveBeenCalledTimes(3);
    expect(raised().map((a) => [a.opts.dedupeKey, a.why])).toEqual([
      [`estimate_stuck:${EST}`, 'Picked Sat 11:30 AM, did not finish.'],
      [`estimate_stuck:${OTHER}`, 'Picked Mon 12 PM, did not finish.'],
    ]);
  });

  test('holdLabel reads the hold\'s calendar day and wall-clock start', () => {
    const { holdLabel } = stuck._private;
    expect(holdLabel('2026-11-10', '09:00:00')).toBe('Tue 9 AM');
    expect(holdLabel(new Date('2026-11-14T00:00:00Z'), '13:30')).toBe('Sat 1:30 PM');
    expect(holdLabel('2026-11-13', '00:30:00')).toBe('Fri 12:30 AM');
    expect(holdLabel(null, '09:00')).toBeNull();
    expect(holdLabel('2026-11-10', null)).toBeNull();
  });
});

describe('never throws, never logs a query error\'s words', () => {
  test('a failed read resolves null and logs the error code alone', async () => {
    db.mockImplementation(() => { throw Object.assign(new Error('select * from estimates where token = \'secret-link-token\''), { code: '57P01' }); });
    await expect(stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'))).resolves.toBeNull();
    await expect(stuck.noteExpiredHolds([{ id: 'hold-1', source_estimate_id: EST }])).resolves.toBe(1);
    await expect(stuck.noteAcceptRefused(REQ, EST, 409, { error: 'Odd.', code: 'odd' })).resolves.toBeNull();
    const lines = logger.warn.mock.calls.map(([line]) => line);
    expect(lines).toContain('[estimate-stuck] slot list failure failed: 57P01');
    expect(lines.join('\n')).not.toMatch(/secret-link-token|select/);
  });

  test('a throwing audit write or alert never reaches the route', async () => {
    auditEstimateBookingStep.mockRejectedValueOnce(new Error('down'));
    await expect(stuck.noteHoldReleased(REQ, OPEN_ROW, { scheduledServiceId: 'hold-1', released: true })).resolves.toBeNull();
    episodes.raiseAdminAlertWithReopen.mockRejectedValueOnce(new Error('down'));
    await expect(stuck.noteSlotListFailed(REQ, OPEN_ROW, new Error('boom'))).resolves.toBeNull();
  });
});

describe('closeSettledStuckAlerts', () => {
  const NOW = new Date('2026-11-05T20:00:00Z');
  const key = (id) => `estimate_stuck:${id}`;
  const ACCEPTED = '33333333-3333-4333-8333-333333333333';
  const ARCHIVED = '44444444-4444-4444-8444-444444444444';
  const GONE = '55555555-5555-4555-8555-555555555555';
  const EXPIRED = '66666666-6666-4666-8666-666666666666';
  const ROWS = {
    [EST]: { id: EST, status: 'viewed', archived_at: null },
    [ACCEPTED]: { id: ACCEPTED, status: 'accepted', archived_at: null },
    [ARCHIVED]: { id: ARCHIVED, status: 'sent', archived_at: '2026-11-05T12:00:00Z' },
    [EXPIRED]: { id: EXPIRED, status: 'expired', archived_at: null },
  };

  function fakeConn() {
    const trx = jest.fn(() => {
      let id;
      const q = { where: jest.fn((w) => { id = w.id; return q; }), first: jest.fn(async () => ROWS[id]) };
      return q;
    });
    trx.raw = jest.fn(async () => {});
    const conn = jest.fn(() => {
      const q = { whereIn: jest.fn(() => q), select: jest.fn(async () => Object.values(ROWS)) };
      return q;
    });
    conn.transaction = jest.fn(async (fn) => fn(trx));
    return { conn, trx };
  }

  test('closes the bells of accepted, archived and gone estimates under the per-key lock; open and expired stay', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue([key(EST), key(ACCEPTED), key(ARCHIVED), key(GONE), key(EXPIRED)]);
    const { conn, trx } = fakeConn();
    const out = await stuck.closeSettledStuckAlerts({ now: NOW, conn });
    expect(out).toEqual({ ran: true, open: 5, closed: 3 });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(conn, 'estimate_stuck:');
    expect(episodes.closeAdminAlertKeys.mock.calls.map(([, keys, why, opts]) => [keys, why, opts.resolution])).toEqual([
      [[key(ACCEPTED)], 'estimate accepted', 'Estimate accepted'],
      [[key(ARCHIVED)], 'estimate archived', 'Estimate archived'],
      [[key(GONE)], 'estimate gone', 'Estimate gone'],
    ]);
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${key(ACCEPTED)}`]);
  });

  test('while the owner has the category silenced, closes every open bell, open estimates too, without reading them', async () => {
    bellPolicy.bellAllowed.mockResolvedValue(false);
    episodes.openAdminAlertKeys.mockResolvedValue([key(EST), key(ACCEPTED), key(EXPIRED)]);
    const { conn, trx } = fakeConn();
    expect(await stuck.closeSettledStuckAlerts({ now: NOW, conn })).toEqual({ ran: true, open: 3, closed: 3 });
    expect(episodes.closeAdminAlertKeys.mock.calls.map(([, keys, why, opts]) => [keys, why, opts.resolution])).toEqual([
      [[key(EST)], 'silenced in Push Settings', 'Silenced in Push Settings'],
      [[key(ACCEPTED)], 'silenced in Push Settings', 'Silenced in Push Settings'],
      [[key(EXPIRED)], 'silenced in Push Settings', 'Silenced in Push Settings'],
    ]);
    expect(conn).not.toHaveBeenCalled();
    expect(trx).not.toHaveBeenCalled();
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${key(EST)}`]);
  });

  test('does nothing while alert episodes are off, and a failure only logs', async () => {
    alertEpisodesLive.mockReturnValue(false);
    expect(await stuck.closeSettledStuckAlerts({ now: NOW, conn: fakeConn().conn })).toEqual({ ran: false, open: 0, closed: 0 });
    expect(episodes.openAdminAlertKeys).not.toHaveBeenCalled();
    alertEpisodesLive.mockReturnValue(true);
    episodes.openAdminAlertKeys.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'ECONNRESET' }));
    expect(await stuck.closeSettledStuckAlerts({ now: NOW, conn: fakeConn().conn })).toEqual({ ran: true, open: 0, closed: 0 });
    expect(logger.warn).toHaveBeenCalledWith('[estimate-stuck] settle pass failed: ECONNRESET');
  });
});
