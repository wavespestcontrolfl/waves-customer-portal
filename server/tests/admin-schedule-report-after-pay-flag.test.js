/**
 * Schedule payload flag `reportAfterPayEnabled` (GATE_REPORT_AFTER_PAY, owner
 * 2026-11-19, *report after pay*): true only while the gate is exactly 'true',
 * read at call time, AND the visit's completion sends the customer a report
 * (resolveCompletionDeliveryPosture, as the completion reads it). Dispatch's
 * "Paid, report not sent" badge shows only on it (client visitInvoice.js
 * paidReportNotSent). Pre-push audit P1: without it the badge showed with the
 * gate off and on visits whose completion sends no report.
 *
 * `reportAfterPayHeld` (pre-push audit round 6): true only for a visit a
 * payment holds open for its report (invoice-issued-closeout.js
 * reportAfterPayHeldVisitIds, the held-payment rule). The badge reads it, not
 * the row's newest bill, so a bill the office adds after the payment does not
 * hide the report still owed. A failed lookup shows no badge.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockProfile = { current: null, fail: false };
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => {
    if (mockProfile.fail) throw new Error('profile lookup reset');
    return mockProfile.current;
  }),
}));

const fs = require('fs');
const path = require('path');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const ROUTINE = { serviceKey: 'pest_general_quarterly', completionMode: 'service_report', deliveryMode: 'auto_send', category: 'pest' };

const flag = async () => {
  const map = await loadProjectCompletionContextByServiceId([{ id: 'svc-1', service_type: 'Quarterly Pest Control' }]);
  return map.get('svc-1').reportAfterPayEnabled;
};

describe('reportAfterPayEnabled', () => {
  const saved = { gate: process.env.GATE_REPORT_AFTER_PAY, kill: process.env.SPECIALTY_REPORT_DELIVERY_DISABLED };
  const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  beforeEach(() => {
    mockProfile.current = ROUTINE;
    mockProfile.fail = false;
    process.env.GATE_REPORT_AFTER_PAY = 'true';
    delete process.env.SPECIALTY_REPORT_DELIVERY_DISABLED;
  });
  afterEach(() => {
    restore('GATE_REPORT_AFTER_PAY', saved.gate);
    restore('SPECIALTY_REPORT_DELIVERY_DISABLED', saved.kill);
  });

  test('gate exactly "true" and a visit whose completion sends the customer a report: on', async () => {
    expect(await flag()).toBe(true);
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: off', async (value) => {
    restore('GATE_REPORT_AFTER_PAY', value);
    expect(await flag()).toBe(false);
  });

  test('is read at call time: a flip needs no restart', async () => {
    delete process.env.GATE_REPORT_AFTER_PAY;
    expect(await flag()).toBe(false);
    process.env.GATE_REPORT_AFTER_PAY = 'true';
    expect(await flag()).toBe(true);
  });

  test.each([
    ['an internal-only consultation', { ...ROUTINE, completionMode: 'internal_only' }],
    ['a profile with delivery disabled', { ...ROUTINE, deliveryMode: 'disabled' }],
    ['a profile with internal-only delivery', { ...ROUTINE, deliveryMode: 'internal_only' }],
    ['a typed specialty report kept internal', { ...ROUTINE, findingsType: 'bed_bug', deliveryMode: 'internal_only', category: 'specialty' }],
  ])('off for %s: its completion sends the customer no report', async (_name, profile) => {
    mockProfile.current = profile;
    expect(await flag()).toBe(false);
  });

  test('off for a specialty profile while the specialty report kill is on', async () => {
    mockProfile.current = { ...ROUTINE, category: 'specialty' };
    expect(await flag()).toBe(true);
    process.env.SPECIALTY_REPORT_DELIVERY_DISABLED = 'true';
    expect(await flag()).toBe(false);
  });

  test('off when the profile lookup fails (an outage is not a report owed)', async () => {
    mockProfile.fail = true;
    expect(await flag()).toBe(false);
  });

  test('the day and the week payload both carry the context flag, strictly true', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src.match(/reportAfterPayEnabled: projectCompletionContext\.reportAfterPayEnabled === true/g)).toHaveLength(2);
  });
});

describe('reportAfterPayHeld', () => {
  const closeout = require('../services/invoice-issued-closeout');
  const logger = require('../services/logger');
  const two = [{ id: 'svc-1', service_type: 'Quarterly Pest Control' }, { id: 'svc-2', service_type: 'Quarterly Pest Control' }];
  let spy = null;
  beforeEach(() => { mockProfile.current = ROUTINE; mockProfile.fail = false; });
  afterEach(() => { if (spy) spy.mockRestore(); spy = null; });

  test('true only for the visits the held-payment rule names', async () => {
    spy = jest.spyOn(closeout, 'reportAfterPayHeldVisitIds').mockResolvedValue(new Set(['svc-1']));
    const map = await loadProjectCompletionContextByServiceId(two);
    expect(spy).toHaveBeenCalledWith(expect.anything(), ['svc-1', 'svc-2']);
    expect(map.get('svc-1').reportAfterPayHeld).toBe(true);
    expect(map.get('svc-2').reportAfterPayHeld).toBe(false);
  });

  test('a failed lookup shows no badge and does not fail the schedule', async () => {
    spy = jest.spyOn(closeout, 'reportAfterPayHeldVisitIds').mockRejectedValue(new Error('connection reset'));
    logger.warn.mockClear();
    const map = await loadProjectCompletionContextByServiceId(two);
    expect([map.get('svc-1').reportAfterPayHeld, map.get('svc-2').reportAfterPayHeld]).toEqual([false, false]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('report-after-pay hold lookup failed'));
  });

  test('the day and the week payload both carry the hold flag, strictly true', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src.match(/reportAfterPayHeld: projectCompletionContext\.reportAfterPayHeld === true/g)).toHaveLength(2);
  });
});
