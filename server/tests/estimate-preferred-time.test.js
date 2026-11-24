/**
 * Approve with preferred days instead of a time slot (GATE_ESTIMATE_APPROVE_PREFERRED_TIME).
 *
 * Pins, with no database: the request body is validated and normalized (unknown days refused, week order, note cut);
 * the office bell is ONE row per estimate that passes the repo's admin-notification rules and names the customer, the
 * days and the dedupe key; the page is offered the option only for a standard recurring estimate and only with the gate
 * on (gate off = the acceptance contract is byte-identical); the onboarding email's visit line promises no date.
 * The accept route itself (storage, no auto-scheduled visit, 400s, one bell) is pinned against real Postgres in
 * estimate-preferred-time.postgres.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockNotifyAdmin = jest.fn(async () => ({ id: 7 }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const {
  normalizePreferredTime, describePreferredTime, raisePreferredTimeAlert, MAX_NOTE_CHARS,
} = require('../services/estimate-preferred-time');
const { composeAdminAlert } = require('../services/admin-alert-compose');

describe('normalizePreferredTime', () => {
  test('keeps the days in week order, deduped, with the window and a collapsed note', () => {
    const out = normalizePreferredTime({ days: ['Fri', 'mon', 'MON', 'wed'], window: 'Morning', note: '  after   school\n pickup ' });
    expect(out).toEqual({ ok: true, value: { days: ['mon', 'wed', 'fri'], window: 'morning', note: 'after school pickup' } });
  });

  test('the note is optional and is cut at the limit', () => {
    expect(normalizePreferredTime({ days: ['sat'], window: 'either' }).value).toEqual({ days: ['sat'], window: 'either' });
    expect(normalizePreferredTime({ days: ['sat'], window: 'either', note: 'x'.repeat(1000) }).value.note).toHaveLength(MAX_NOTE_CHARS);
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
    const out = normalizePreferredTime(body);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pick at least one day/);
  });
});

describe('describePreferredTime', () => {
  test('reads for the office', () => {
    expect(describePreferredTime({ days: ['mon', 'wed', 'fri'], window: 'morning' })).toBe('Mon, Wed, Fri, mornings');
    expect(describePreferredTime({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], window: 'either' })).toBe('Any day Mon to Sat, mornings or afternoons');
  });
});

describe('raisePreferredTimeAlert', () => {
  const estimate = { id: 'est-1', customer_name: 'Synthetic Person' };
  const preferredTime = { days: ['tue', 'thu'], window: 'afternoon', note: 'Gate is on the left. Call 941-555-0100 first.' };

  beforeEach(() => mockNotifyAdmin.mockClear());

  test('files ONE needs-you row that names the customer, the days and a per-estimate dedupe key', async () => {
    const filed = await raisePreferredTimeAlert({ estimate, customerId: 'cust-9', preferredTime, serviceLabel: 'Pest Control' });
    expect(filed).toBe(true);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, why, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('estimate');
    expect(title).toBe("Schedule — book Synthetic Person's first visit");
    expect(why).toMatch(/Tue, Thu, afternoons/);
    expect(opts.dedupeKey).toBe('estimate-preferred-time:est-1');
    expect(opts.bell).toBe(true);
    expect(opts.link).toBe('/admin/customers?customerId=cust-9');
    expect(opts.metadata).toMatchObject({ estimateId: 'est-1', customerId: 'cust-9', source: 'estimate_preferred_time', severity: 'needs-you', doneWhen: 'visit_booked', contact: true });
    // The note and the estimate link ride the detail; a phone number in the customer's words is masked.
    expect(opts.detail).toMatch(/Pest Control/);
    expect(opts.detail).toMatch(/\/admin\/estimates\?estimateId=est-1/);
    expect(opts.detail).toMatch(/Gate is on the left/);
    expect(opts.detail).not.toMatch(/941-555-0100/);
  });

  test('the row obeys the admin-notification rules (headline, why, link, subject)', async () => {
    await raisePreferredTimeAlert({ estimate, customerId: null, preferredTime });
    const [, title, why, opts] = mockNotifyAdmin.mock.calls[0];
    const composed = composeAdminAlert({
      area: 'Schedule', action: title.replace('Schedule — ', ''), why, severity: 'needs-you', link: opts.link,
      subject: { type: 'estimate', id: 'est-1' }, doneWhen: 'visit_booked', who: 'person', contact: true,
    });
    expect(composed.headline).toBe(title);
    // No customer on file yet: the link opens the estimate.
    expect(opts.link).toBe('/admin/estimates?estimateId=est-1');
  });

  test('a long name keeps the headline inside the limit', async () => {
    await raisePreferredTimeAlert({ estimate: { id: 'est-2', customer_name: 'A Very Long Customer Name That Goes On And On Forever' }, preferredTime });
    expect(mockNotifyAdmin.mock.calls[0][1].length).toBeLessThanOrEqual(60);
  });

  test('never throws: a failed write answers false and the accept stands', async () => {
    mockNotifyAdmin.mockRejectedValueOnce(new Error('db down'));
    await expect(raisePreferredTimeAlert({ estimate, preferredTime })).resolves.toBe(false);
  });
});

describe('the acceptance contract offers the option only where the accept takes it', () => {
  const OLD_ENV = process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME;
    else process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = OLD_ENV;
  });
  const route = () => require('../routes/estimate-public');
  const recurring = { id: 'e1', source: null, estimate_data: { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', monthly: 15, visitsPerYear: 4 }] } } } };

  test('gate off: the contract is byte-identical (no preferredTime key)', () => {
    delete process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME;
    const { buildEstimateAcceptanceContract, preferredTimeOfferedFor } = route();
    expect(preferredTimeOfferedFor(recurring, recurring.estimate_data)).toBe(false);
    expect(buildEstimateAcceptanceContract({ preferredTimeOffered: false })).toEqual({ mode: 'standard_slot_pick', ctaLabel: 'Pick appointment', reason: null });
  });

  test('gate on: a standard recurring estimate is offered; the slot picker mode is unchanged', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { buildEstimateAcceptanceContract, preferredTimeOfferedFor } = route();
    expect(preferredTimeOfferedFor(recurring, recurring.estimate_data)).toBe(true);
    expect(buildEstimateAcceptanceContract({ preferredTimeOffered: true })).toEqual({
      mode: 'standard_slot_pick', ctaLabel: 'Pick appointment', reason: null, preferredTime: { offered: true },
    });
  });

  test('gate on: plan-start and plan-restart quotes are never offered', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { preferredTimeOfferedFor } = route();
    expect(preferredTimeOfferedFor({ ...recurring, source: 'plan_start' }, recurring.estimate_data)).toBe(false);
    expect(preferredTimeOfferedFor({ ...recurring, source: 'plan_restart' }, recurring.estimate_data)).toBe(false);
  });

  test('gate on: a one-time-only estimate is not offered', () => {
    process.env.GATE_ESTIMATE_APPROVE_PREFERRED_TIME = 'true';
    const { preferredTimeOfferedFor } = route();
    const oneTimeData = { result: { recurring: { services: [] }, oneTime: { items: [{ name: 'Wasp Nest Removal', price: 85 }] } } };
    expect(preferredTimeOfferedFor({ id: 'e2', estimate_data: oneTimeData }, oneTimeData)).toBe(false);
  });

  test('a booked or special acceptance mode never carries the option', () => {
    const { buildEstimateAcceptanceContract } = route();
    expect(buildEstimateAcceptanceContract({ commercialNoSlotAccept: true, preferredTimeOffered: true })).not.toHaveProperty('preferredTime');
    expect(buildEstimateAcceptanceContract({ invoiceOnly: true, preferredTimeOffered: true })).not.toHaveProperty('preferredTime');
    expect(buildEstimateAcceptanceContract({ quoteRequirement: { quoteRequired: true }, preferredTimeOffered: true })).not.toHaveProperty('preferredTime');
  });
});

describe('the onboarding email visit line promises no date', () => {
  test('firstVisitPending says the office confirms; a booked visit keeps its own line', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'estimate-accepted-email.js'), 'utf8');
    expect(src).toMatch(/FIRST_VISIT_PENDING_LINE = 'We will contact you to confirm your first visit, using the days you gave us\.'/);
    expect(src).toMatch(/appointmentLineFor\(ctx\.appointment\) \|\| \(ctx\.firstVisitPending \? FIRST_VISIT_PENDING_LINE : ''\)/);
  });
});
