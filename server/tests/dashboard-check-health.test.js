/**
 * dashboard-check-health: the nightly read-only check that posts one
 * engineering FIX row when a dashboard alert check fails two reads a minute
 * apart, and retires the row on a clean night. Before it, a failed check only
 * dropped its queue from the dashboard and failed the 5-minute cron tick in
 * job_health, which pushes nothing to anyone.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n1' })) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 0) }));

const sendgrid = require('../services/sendgrid-mail');
const { computeDashboardAlerts } = require('../services/dashboard-alerts');
const { deliverOpsDigest } = require('../services/ops-digest');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const {
  runDashboardCheckHealth,
  OPS_KEY,
  CONFIRM_DELAY_MS,
  _private: { composeDigest },
} = require('../services/dashboard-check-health');

const reads = (...results) => {
  const fn = jest.fn();
  for (const r of results) fn.mockResolvedValueOnce(r);
  return fn;
};
const wait = jest.fn(async () => undefined);

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
});

describe('runDashboardCheckHealth', () => {
  test('a clean read retires the standing row and posts nothing', async () => {
    const readAlerts = reads({ alerts: [], failures: [] });

    const result = await runDashboardCheckHealth({ readAlerts, wait });

    expect(result).toEqual({ failed: [] });
    expect(readAlerts).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a check that fails once and then runs posts nothing, and the row retires', async () => {
    const readAlerts = reads(
      { alerts: [], failures: [{ id: 'ar_overdue_60' }] },
      { alerts: [], failures: [] },
    );

    const result = await runDashboardCheckHealth({ readAlerts, wait });

    expect(wait).toHaveBeenCalledWith(CONFIRM_DELAY_MS);
    expect(CONFIRM_DELAY_MS).toBe(60 * 1000);
    expect(result).toEqual({ failed: [], cleared: ['ar_overdue_60'] });
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('checks that fail both reads post one FIX row that lists only those checks', async () => {
    const readAlerts = reads(
      { alerts: [], failures: [{ id: 'payments_failed_today' }, { id: 'closeout_gaps_today', alertIds: ['closeout_gaps_today', 'closeout_sweep_incomplete'] }, { id: 'ar_overdue_60' }] },
      { alerts: [], failures: [{ id: 'closeout_gaps_today', alertIds: ['closeout_gaps_today', 'closeout_sweep_incomplete'] }, { id: 'ar_overdue_60' }] },
    );

    const result = await runDashboardCheckHealth({ readAlerts, wait });

    expect(result.failed).toEqual(['ar_overdue_60', 'closeout_gaps_today']);
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent).toMatchObject({
      key: OPS_KEY,
      fallOff: true,
      dedupeKey: OPS_KEY,
      refreshOnDedupe: true,
      count: 2,
      itemKeys: ['ar_overdue_60', 'closeout_gaps_today'],
      link: '/admin/dashboard',
      subject: 'FIX: 2 dashboard alert checks failed to run',
      headline: 'System — fix 2 failing dashboard alert checks',
    });
    // A standing fall-off row takes no rolling window: its dedupeKey drops on
    // retire, so a window would only split one episode into two rows.
    expect(sent).not.toHaveProperty('dedupeWindowMs');
    expect(sent.headline.length).toBeLessThanOrEqual(60);
    expect(sent.summary.length).toBeLessThanOrEqual(110);
    expect(sent.text).toContain('- ar_overdue_60');
    expect(sent.text).toContain('- closeout_gaps_today');
    // The check that ran on the second read is not reported, and the grouped
    // check is named once, by its check id.
    expect(sent.text).not.toContain('payments_failed_today');
    expect(sent.text).not.toContain('closeout_sweep_incomplete');
    expect(result.delivery).toEqual({ ok: true, channel: 'in_app', id: 'n1' });
  });

  test('an alert read that throws fails the run and never retires the row', async () => {
    const readAlerts = jest.fn().mockRejectedValue(new Error('pool exhausted'));

    await expect(runDashboardCheckHealth({ readAlerts, wait })).rejects.toThrow('pool exhausted');
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('the default read bypasses the 30-second alert memo', async () => {
    computeDashboardAlerts.mockResolvedValue({ alerts: [], failures: [] });

    await runDashboardCheckHealth({ wait });

    expect(computeDashboardAlerts).toHaveBeenCalledWith({ fresh: true });
  });

  test('the email fallback goes only to the internal ops inbox, and fails when the mailer is not set up', async () => {
    const failing = { alerts: [], failures: [{ id: 'churn_at_risk' }] };
    await runDashboardCheckHealth({ readAlerts: reads(failing, failing), wait });
    const { sendEmail } = deliverOpsDigest.mock.calls[0][0];

    await sendEmail();
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'FIX: 1 dashboard alert check failed to run',
      categories: ['ops', OPS_KEY],
    }));

    sendgrid.sendOne.mockClear();
    sendgrid.isConfigured.mockReturnValue(false);
    await expect(sendEmail()).rejects.toThrow('mailer not configured');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('composeDigest', () => {
  test('one failed check reads in the singular', () => {
    const composed = composeDigest(['estimates_expiring']);
    expect(composed.headline).toBe('System — fix 1 failing dashboard alert check');
    expect(composed.summary).toBe('1 dashboard alert check threw twice in a row, so its queue is missing from the dashboard.');
    expect(composed.html).toContain('<li style="margin:0 0 6px 0;">estimates_expiring</li>');
  });
});

describe('scheduler wiring', () => {
  test('runs nightly at 11:21 PM ET under runExclusive, with a lazy require and a job_health rethrow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    const i = src.indexOf("cron.schedule('21 23 * * *'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('timezone', i) + 40);
    expect(block).toContain("runExclusive('dashboard-check-health'");
    expect(block).toContain("require('./dashboard-check-health')");
    expect(block).toContain('result.delivery.ok === false');
    expect(block).toContain("timezone: 'America/New_York'");
    // #3208 rule. failing-jobs-check.test.js also checks that no fixed or hourly job shares the minute.
    expect(src.match(/cron\.schedule\('21 23 \* \* \*'/g)).toHaveLength(1);
  });
});
