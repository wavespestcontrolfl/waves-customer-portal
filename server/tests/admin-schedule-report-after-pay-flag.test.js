/**
 * Schedule payload flag `reportAfterPayHeld` (GATE_REPORT_AFTER_PAY, owner
 * 2026-11-19, *report after pay*): true only for a visit a payment holds open
 * for its report (invoice-issued-closeout.js reportAfterPayHeldVisitIds, the
 * recorded hold; empty with the gate off). Dispatch's "Paid, report not sent"
 * badge reads it alone (client visitInvoice.js paidReportNotSent):
 *  - not the row's newest bill, so a bill the office adds after the payment
 *    does not hide the report still owed (pre-push audit round 6);
 *  - not the visit's completion profile. The hold is recorded only for a visit
 *    whose completion sends the customer a report (reportAfterPayWouldHold),
 *    so no second reading of the profile can disagree with the hold (round
 *    12: a held visit showed no badge when the row's own profile read said no
 *    report, or failed).
 * The row still carries `reportAfterPayEnabled`, for a Dispatch bundle loaded
 * before that change (it needs both flags true). It is the same hold.
 * A failed hold lookup shows no badge.
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
    expect(map.get('svc-1')).toMatchObject({ reportAfterPayHeld: true, reportAfterPayEnabled: true });
    expect(map.get('svc-2')).toMatchObject({ reportAfterPayHeld: false, reportAfterPayEnabled: false });
  });

  test('a failed lookup shows no badge and does not fail the schedule', async () => {
    spy = jest.spyOn(closeout, 'reportAfterPayHeldVisitIds').mockRejectedValue(new Error('connection reset'));
    logger.warn.mockClear();
    const map = await loadProjectCompletionContextByServiceId(two);
    expect([map.get('svc-1').reportAfterPayHeld, map.get('svc-2').reportAfterPayHeld]).toEqual([false, false]);
    expect([map.get('svc-1').reportAfterPayEnabled, map.get('svc-2').reportAfterPayEnabled]).toEqual([false, false]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('report-after-pay hold lookup failed'));
  });

  test('the hold is the badge\'s only source: a failed profile lookup, or a profile that sends no report, does not hide a held visit', async () => {
    spy = jest.spyOn(closeout, 'reportAfterPayHeldVisitIds').mockResolvedValue(new Set(['svc-1', 'svc-2']));
    mockProfile.fail = true;
    expect((await loadProjectCompletionContextByServiceId(two)).get('svc-1'))
      .toMatchObject({ reportAfterPayHeld: true, reportAfterPayEnabled: true, completionProfileLookupFailed: true });
    mockProfile.fail = false;
    mockProfile.current = { ...ROUTINE, deliveryMode: 'disabled' };
    // The flag an older Dispatch bundle also needs follows the hold too, not the profile.
    expect((await loadProjectCompletionContextByServiceId(two)).get('svc-2')).toMatchObject({ reportAfterPayHeld: true, reportAfterPayEnabled: true });
  });

  test('the day and the week payload both carry the hold flag and the older bundle\'s flag, strictly true', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src.match(/reportAfterPayHeld: projectCompletionContext\.reportAfterPayHeld === true/g)).toHaveLength(2);
    expect(src.match(/reportAfterPayEnabled: projectCompletionContext\.reportAfterPayEnabled === true/g)).toHaveLength(2);
  });
});
