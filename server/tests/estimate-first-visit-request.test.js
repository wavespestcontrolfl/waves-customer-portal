/**
 * First-visit request (GATE_ESTIMATE_APPROVE_PREFERRED_TIME), no database.
 *
 * Pins: the body is validated and normalized (unknown days refused, week order, note cut); the ONE office bell obeys the
 * admin-notification rules, names the customer, the days, the masked note and the estimate's expiry date, carries "Book it from
 * the estimate so it counts as accepted.", is written on the caller's transaction with an OPEN-ONLY dedupe (a repeat while it is
 * open answers deduped and rings nothing; errors propagate), and the request is stateless; the settle pass's reason for an
 * estimate that is no longer open; and /data's state ({ offered: true } or nothing; gate off = byte-identical contract).
 * The route itself (no estimate write, locked recheck, settle pass) is in estimate-first-visit-request.postgres.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockNotifyAdmin = jest.fn(async () => ({ id: 7 }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const {
  normalizeFirstVisitRequest, describeRequest, raiseFirstVisitRequestBell, settledReason, MAX_NOTE_CHARS,
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

describe('describeRequest', () => {
  test('reads for the office', () => {
    expect(describeRequest({ days: ['mon', 'wed', 'fri'], window: 'morning' })).toBe('Mon, Wed, Fri, mornings');
    expect(describeRequest({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], window: 'either' })).toBe('Any day Mon to Sat, mornings or afternoons');
  });
});

describe('raiseFirstVisitRequestBell', () => {
  const estimate = { id: 'est-1', customer_name: 'Synthetic Person', expires_at: new Date('2026-12-09T17:00:00Z') };
  const request = { days: ['tue', 'thu'], window: 'afternoon', note: 'Gate is on the left. Call 941-555-0100 first.' };
  const trx = { marker: 'trx' };
  beforeEach(() => mockNotifyAdmin.mockClear());

  test('files ONE needs-you row on the caller\'s transaction with an OPEN-ONLY dedupe on the estimate', async () => {
    const out = await raiseFirstVisitRequestBell({ estimate, request, trx });
    expect(out).toEqual({ deduped: false });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('estimate');
    expect(title).toBe("Schedule — book Synthetic Person's first visit");
    expect(why).toMatch(/not accepted yet/);
    expect(why).toMatch(/Tue, Thu, afternoons/);
    expect(opts.trx).toBe(trx);
    expect(opts.bell).toBe(true);
    expect(opts.dedupeKey).toBe('estimate-first-visit-request:est-1');
    expect(opts.dedupeOpenOnly).toBe(true);
    expect(opts.link).toBe('/admin/estimates?estimateId=est-1');
    expect(opts.metadata).toMatchObject({ estimateId: 'est-1', source: 'estimate_first_visit_request', severity: 'needs-you', doneWhen: 'visit_booked', contact: true });
    expect(opts.detail).toMatch(/has NOT accepted/);
    expect(opts.detail).toMatch(/Estimate expires Dec 9; book before then or extend it from the estimate\./);
    expect(opts.detail).toMatch(/Book it from the estimate so it counts as accepted\./);
    expect(opts.detail).toMatch(/Gate is on the left/);
    expect(opts.detail).not.toMatch(/941-555-0100/);
  });

  test('a repeat while the bell is open comes back deduped (the route answers 200 and nothing rings)', async () => {
    mockNotifyAdmin.mockResolvedValueOnce({ id: 7, deduped: true });
    expect(await raiseFirstVisitRequestBell({ estimate, request, trx })).toEqual({ deduped: true });
  });

  test('an estimate with no expiry date says nothing about one', async () => {
    await raiseFirstVisitRequestBell({ estimate: { ...estimate, expires_at: null }, request, trx });
    expect(mockNotifyAdmin.mock.calls[0][3].detail).not.toMatch(/expires/);
  });

  test('the bell obeys the admin-notification rules (headline, why, link, subject)', async () => {
    await raiseFirstVisitRequestBell({ estimate, request, trx });
    const [, title, why, opts] = mockNotifyAdmin.mock.calls[0];
    const composed = composeAdminAlert({
      area: 'Schedule', action: title.replace('Schedule — ', ''), why, severity: 'needs-you', link: opts.link,
      subject: { type: 'estimate', id: 'est-1' }, doneWhen: 'visit_booked', who: 'person', contact: true,
    });
    expect(composed.headline).toBe(title);
  });

  test('a long name keeps the headline inside the limit', async () => {
    await raiseFirstVisitRequestBell({ estimate: { ...estimate, customer_name: 'A Very Long Customer Name That Goes On And On Forever' }, request, trx });
    expect(mockNotifyAdmin.mock.calls[0][1].length).toBeLessThanOrEqual(60);
  });

  test('a bell that fails propagates, so the caller rolls back and the customer can retry', async () => {
    mockNotifyAdmin.mockRejectedValueOnce(new Error('db down'));
    await expect(raiseFirstVisitRequestBell({ estimate, request, trx })).rejects.toThrow('db down');
  });

  test('a bell that wrote no row is a failure too (the request must not be silently lost)', async () => {
    mockNotifyAdmin.mockResolvedValueOnce(null);
    await expect(raiseFirstVisitRequestBell({ estimate, request, trx })).rejects.toThrow(/bell was not written/);
  });
});

describe('settledReason (when the open bell is done)', () => {
  const now = new Date('2026-12-05T12:00:00Z');
  const open = { status: 'sent', archived_at: null, expires_at: new Date('2026-12-09T00:00:00Z') };
  test('an open estimate keeps its bell', () => {
    expect(settledReason(open, now)).toBeNull();
    expect(settledReason({ ...open, status: 'viewed', expires_at: null }, now)).toBeNull();
  });
  test.each([
    ['gone', null, 'estimate gone'],
    ['archived', { ...open, archived_at: new Date() }, 'estimate archived'],
    ['accepted', { ...open, status: 'accepted' }, 'estimate accepted'],
    ['declined', { ...open, status: 'declined' }, 'estimate declined'],
    ['expired by status', { ...open, status: 'expired' }, 'estimate expired'],
    ['expired by date', { ...open, expires_at: new Date('2026-12-04T00:00:00Z') }, 'estimate expired'],
  ])('%s closes it', (_n, row, why) => {
    expect(settledReason(row, now)).toBe(why);
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

  test('gate on: only { offered: true } is ever served (no request state: nothing is stored)', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { firstVisitRequestState } = route();
    const data = { ...recurringData, firstVisitRequest: { days: ['mon', 'wed'], window: 'morning', note: 'private note' } };
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
