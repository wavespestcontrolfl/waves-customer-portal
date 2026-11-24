/**
 * First-visit request (GATE_ESTIMATE_APPROVE_PREFERRED_TIME), no database.
 *
 * Pins: the body is validated and normalized (unknown days refused, week order, note cut); the one office bell obeys the
 * admin-notification rules, names the customer and the days, carries "Book it from the estimate so it counts as accepted.",
 * and is written on the caller's transaction (errors propagate so the request rolls back with it); storing is idempotent
 * (a pending request writes nothing and rings nothing, a settled one counts as absent); the request never touches the
 * estimate's expiry (the bell shows it); and /data's state is gated and eligibility-limited (gate off = the acceptance
 * contract is byte-identical, a pending request reads as pending, a settled one does not).
 * The route itself (one transaction, no acceptance, locked re-check, expiry sweep) is in
 * estimate-first-visit-request.postgres.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockNotifyAdmin = jest.fn(async () => ({ id: 7 }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const {
  normalizeFirstVisitRequest, describeRequest, storedRequest, storeFirstVisitRequest, MAX_NOTE_CHARS,
} = require('../services/estimate-first-visit-request');
const { composeAdminAlert } = require('../services/admin-alert-compose');

describe('normalizeFirstVisitRequest', () => {
  test('keeps the days in week order, deduped, with the window and a collapsed note', () => {
    const out = normalizeFirstVisitRequest({ days: ['Fri', 'mon', 'MON', 'wed'], window: 'Morning', note: '  after   school\n pickup ' });
    expect(out).toEqual({ ok: true, value: { days: ['mon', 'wed', 'fri'], window: 'morning', note: 'after school pickup' } });
  });

  test('the note is optional and is cut at the limit', () => {
    expect(normalizeFirstVisitRequest({ days: ['sat'], window: 'either' }).value).toEqual({ days: ['sat'], window: 'either' });
    expect(normalizeFirstVisitRequest({ days: ['sat'], window: 'either', note: 'x'.repeat(1000) }).value.note).toHaveLength(MAX_NOTE_CHARS);
  });

  test.each([
    ['no body', undefined],
    ['an array', ['mon']],
    ['no days', { days: [], window: 'morning' }],
    ['Sunday is not offered', { days: ['sun'], window: 'morning' }],
    ['one bad day among good ones', { days: ['mon', 'someday'], window: 'morning' }],
    ['days that are not a list', { days: 'mon', window: 'morning' }],
    ['no window', { days: ['mon'] }],
    ['an unknown window', { days: ['mon'], window: 'evening' }],
  ])('refuses %s', (_name, body) => {
    const out = normalizeFirstVisitRequest(body);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pick at least one day/);
  });
});

describe('describeRequest / storedRequest', () => {
  test('reads for the office', () => {
    expect(describeRequest({ days: ['mon', 'wed', 'fri'], window: 'morning' })).toBe('Mon, Wed, Fri, mornings');
    expect(describeRequest({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], window: 'either' })).toBe('Any day Mon to Sat, mornings or afternoons');
  });
  test('only a stored request with days counts', () => {
    expect(storedRequest({ firstVisitRequest: { days: ['mon'], window: 'either' } })).toBeTruthy();
    expect(storedRequest({ firstVisitRequest: { days: [] } })).toBeNull();
    // A settled request (its bell closed with the estimate) counts as absent.
    expect(storedRequest({ firstVisitRequest: { days: ['mon'], window: 'either', settledAt: '2026-12-02T00:00:00.000Z' } })).toBeNull();
    expect(storedRequest({})).toBeNull();
    expect(storedRequest(null)).toBeNull();
  });
});

// A transaction double: records the update, so the order (request, hold, bell) and the SQL are visible.
function fakeTrx() {
  const updates = [];
  const trx = (table) => ({ where: () => ({ update: async (patch) => { updates.push({ table, patch }); return 1; } }) });
  trx.raw = (sql, bindings) => ({ sql, bindings });
  trx.fn = { now: () => 'NOW' };
  trx.updates = updates;
  return trx;
}

describe('storeFirstVisitRequest', () => {
  const locked = { id: 'est-1', customer_name: 'Synthetic Person', estimate_data: {}, expires_at: new Date('2026-12-09T17:00:00Z') };
  const request = { days: ['tue', 'thu'], window: 'afternoon', note: 'Gate is on the left. Call 941-555-0100 first.' };
  beforeEach(() => mockNotifyAdmin.mockClear());

  test('writes the request and the hold, then ONE needs-you bell on the SAME transaction', async () => {
    const trx = fakeTrx();
    const out = await storeFirstVisitRequest({ trx, locked, request, now: new Date('2026-12-01T15:00:00Z') });
    expect(out.deduped).toBe(false);
    expect(trx.updates).toHaveLength(1);
    const { patch } = trx.updates[0];
    expect(patch.estimate_data.sql).toMatch(/jsonb_set\(COALESCE\(estimate_data, '\{\}'::jsonb\), '\{firstVisitRequest\}'/);
    expect(JSON.parse(patch.estimate_data.bindings[0])).toMatchObject({ days: ['tue', 'thu'], window: 'afternoon', at: '2026-12-01T15:00:00.000Z' });
    // The request does NOT extend the estimate: its expiry is not written.
    expect(patch).not.toHaveProperty('expires_at');

    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('estimate');
    expect(title).toBe("Schedule — book Synthetic Person's first visit");
    expect(why).toMatch(/not accepted yet/);
    expect(why).toMatch(/Tue, Thu, afternoons/);
    expect(opts.trx).toBe(trx);
    expect(opts.bell).toBe(true);
    expect(opts.dedupeKey).toBe(`estimate-first-visit-request:est-1:${Date.parse('2026-12-01T15:00:00Z')}`);
    expect(opts.link).toBe('/admin/estimates?estimateId=est-1');
    expect(opts.metadata).toMatchObject({ estimateId: 'est-1', source: 'estimate_first_visit_request', severity: 'needs-you', doneWhen: 'visit_booked', contact: true });
    expect(opts.detail).toMatch(/has NOT accepted/);
    expect(opts.detail).toMatch(/Estimate expires Dec 9; book before then or extend it from the estimate\./);
    expect(opts.detail).toMatch(/Book it from the estimate so it counts as accepted\./);
    expect(opts.detail).toMatch(/Gate is on the left/);
    expect(opts.detail).not.toMatch(/941-555-0100/);
  });

  test('the bell obeys the admin-notification rules (headline, why, link, subject)', async () => {
    await storeFirstVisitRequest({ trx: fakeTrx(), locked, request });
    const [, title, why, opts] = mockNotifyAdmin.mock.calls[0];
    const composed = composeAdminAlert({
      area: 'Schedule', action: title.replace('Schedule — ', ''), why, severity: 'needs-you', link: opts.link,
      subject: { type: 'estimate', id: 'est-1' }, doneWhen: 'visit_booked', who: 'person', contact: true,
    });
    expect(composed.headline).toBe(title);
  });

  test('a long name keeps the headline inside the limit', async () => {
    await storeFirstVisitRequest({ trx: fakeTrx(), locked: { ...locked, customer_name: 'A Very Long Customer Name That Goes On And On Forever' }, request });
    expect(mockNotifyAdmin.mock.calls[0][1].length).toBeLessThanOrEqual(60);
  });

  test('a settled request counts as absent: a new one is stored with a NEW bell key', async () => {
    const trx = fakeTrx();
    const settled = { days: ['sat'], window: 'either', at: '2026-11-30T10:00:00.000Z', settledAt: '2026-12-02T00:00:00.000Z' };
    const out = await storeFirstVisitRequest({ trx, locked: { ...locked, estimate_data: { firstVisitRequest: settled } }, request, now: new Date('2026-12-05T15:00:00Z') });
    expect(out.deduped).toBe(false);
    expect(trx.updates).toHaveLength(1);
    expect(mockNotifyAdmin.mock.calls[0][3].dedupeKey).toBe(`estimate-first-visit-request:est-1:${Date.parse('2026-12-05T15:00:00Z')}`);
  });

  test('a pending request is returned as it is: nothing written, no second bell', async () => {
    const trx = fakeTrx();
    const stored = { days: ['sat'], window: 'either', at: '2026-11-30T10:00:00.000Z' };
    const out = await storeFirstVisitRequest({ trx, locked: { ...locked, estimate_data: JSON.stringify({ firstVisitRequest: stored }) }, request });
    expect(out).toEqual({ deduped: true, request: stored });
    expect(trx.updates).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a bell that fails propagates, so the caller rolls the request back with it', async () => {
    mockNotifyAdmin.mockRejectedValueOnce(new Error('db down'));
    await expect(storeFirstVisitRequest({ trx: fakeTrx(), locked, request })).rejects.toThrow('db down');
  });

  test('a bell that wrote no row also fails the request (it must not be silently lost)', async () => {
    mockNotifyAdmin.mockResolvedValueOnce(null);
    await expect(storeFirstVisitRequest({ trx: fakeTrx(), locked, request })).rejects.toThrow(/bell was not written/);
  });
});

describe('what /data tells the page', () => {
  const OLD_ENV = process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME;
    else process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = OLD_ENV;
  });
  const route = () => require('../routes/estimate-public');
  const recurringData = { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', monthly: 15, visitsPerYear: 4 }] } } };
  const sent = (extra = {}, data = recurringData) => ({ id: 'e1', status: 'sent', source: null, bill_by_invoice: false, expires_at: new Date(Date.now() + 86400000), estimate_data: data, ...extra });

  test('gate off: nothing, and the acceptance contract is byte-identical', () => {
    delete process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME;
    const { firstVisitRequestState, buildEstimateAcceptanceContract } = route();
    expect(firstVisitRequestState(sent(), recurringData)).toBeNull();
    expect(buildEstimateAcceptanceContract({ preferredTime: null })).toEqual({ mode: 'standard_slot_pick', ctaLabel: 'Pick appointment', reason: null });
  });

  test('gate on: offered on an open standard recurring estimate', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { firstVisitRequestState, buildEstimateAcceptanceContract } = route();
    const state = firstVisitRequestState(sent(), recurringData);
    expect(state).toEqual({ offered: true });
    expect(buildEstimateAcceptanceContract({ preferredTime: state })).toEqual({
      mode: 'standard_slot_pick', ctaLabel: 'Pick appointment', reason: null, preferredTime: { offered: true },
    });
  });

  test('gate on: a stored request reads as pending (for a reopened link), with only days and window', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { firstVisitRequestState } = route();
    const data = { ...recurringData, firstVisitRequest: { days: ['mon', 'wed'], window: 'morning', note: 'private note', at: '2026-12-01T00:00:00.000Z' } };
    expect(firstVisitRequestState(sent({}, data), data)).toEqual({ offered: true, requestPending: true, days: ['mon', 'wed'], window: 'morning' });
  });

  test('gate on: a settled request is not shown as pending (the page offers a fresh one)', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { firstVisitRequestState } = route();
    const data = { ...recurringData, firstVisitRequest: { days: ['mon'], window: 'morning', at: '2026-12-01T00:00:00.000Z', settledAt: '2026-12-02T00:00:00.000Z' } };
    expect(firstVisitRequestState(sent({}, data), data)).toEqual({ offered: true });
  });

  test.each([
    ['accepted', { status: 'accepted' }],
    ['expired', { status: 'expired' }],
    ['a draft', { status: 'draft' }],
    ['past due', { expires_at: new Date(Date.now() - 1000) }],
    ['archived', { archived_at: new Date() }],
    ['plan_start', { source: 'plan_start' }],
    ['plan_restart', { source: 'plan_restart' }],
    ['invoice-mode', { bill_by_invoice: true }],
  ])('gate on: not offered for %s', (_name, extra) => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { firstVisitRequestState } = route();
    expect(firstVisitRequestState(sent(extra), recurringData)).toBeNull();
  });

  test('gate on: not offered for a one-time-only estimate', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { firstVisitRequestState } = route();
    const oneTimeData = { result: { recurring: { services: [] }, oneTime: { items: [{ name: 'Wasp Nest Removal', price: 85 }] } } };
    expect(firstVisitRequestState(sent({}, oneTimeData), oneTimeData)).toBeNull();
  });

  test('a booked or special acceptance mode never carries the option', () => {
    const { buildEstimateAcceptanceContract } = route();
    const preferredTime = { offered: true };
    expect(buildEstimateAcceptanceContract({ commercialNoSlotAccept: true, preferredTime })).not.toHaveProperty('preferredTime');
    expect(buildEstimateAcceptanceContract({ invoiceOnly: true, preferredTime })).not.toHaveProperty('preferredTime');
    expect(buildEstimateAcceptanceContract({ quoteRequirement: { quoteRequired: true }, preferredTime })).not.toHaveProperty('preferredTime');
    expect(buildEstimateAcceptanceContract({ existingAppointment: { id: 'v1', scheduled_date: '2026-12-02', window_start: '09:00:00' }, preferredTime })).not.toHaveProperty('preferredTime');
  });
});
