// The 7 AM credential check's alerts (services/token-health.js). 2026-11-11 audit of the admin notifications:
// - 2026-11-10 07:00 ET OpenAI's model list answered HTTP 504 once. The check wrote "openai credential error"
//   to the bell and "System — renew an expired credential" to the owner's list for a credential that worked.
// - Neither row closed when the 11-11 check passed. No credential row ever closed on a pass: of 235 rows since
//   April, 232 were closed by the 30-day retention sweep.
// - A failure that stood wrote a new bell row every morning (one platform: 80 mornings in a row).
jest.mock('../models/db', () => {
  const query = { where: jest.fn().mockReturnThis(), first: jest.fn(async () => null), insert: jest.fn(async () => []), update: jest.fn(async () => 1), whereNotIn: jest.fn().mockReturnThis(), del: jest.fn(async () => 0), orderBy: jest.fn(async () => []) };
  const db = jest.fn(() => query); db._query = query; db.fn = { now: () => new Date() }; db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ alertEpisodesLive: jest.fn(() => true) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1' })) }));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n-1', rang: true })),
  closeAdminAlertKeys: jest.fn(async () => 0),
}));
jest.mock('../services/owner-alerts', () => ({ recordOwnerAlert: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-2' })) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 1) }));

const db = require('../models/db');
const { alertEpisodesLive } = require('../config/feature-gates');
const NotificationService = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const { recordOwnerAlert } = require('../services/owner-alerts');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const TokenHealthService = require('../services/token-health');

const { recheckErrors, settleTokenAlerts, RECHECK_DELAY_MS } = TokenHealthService._private;

const healthy = (platform) => ({ platform, status: 'healthy', lastError: null, expiresAt: null });
const failed = (platform, status, lastError) => ({ platform, status, lastError, expiresAt: null });

beforeEach(() => {
  jest.clearAllMocks();
  alertEpisodesLive.mockReturnValue(true);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('recheckErrors: one wrong answer from a provider is not a credential problem', () => {
  test('a platform that read error is checked once more, and a pass replaces the first result', async () => {
    const checkSingle = jest.spyOn(TokenHealthService, 'checkSingle').mockResolvedValue(healthy('openai'));
    const out = await recheckErrors([healthy('stripe'), failed('openai', 'error', 'HTTP 504')], 1);
    expect(checkSingle).toHaveBeenCalledTimes(1);
    expect(checkSingle).toHaveBeenCalledWith('openai');
    expect(out).toEqual([healthy('stripe'), healthy('openai')]);
  });

  test('a second error stands', async () => {
    jest.spyOn(TokenHealthService, 'checkSingle').mockResolvedValue(failed('openai', 'error', 'HTTP 503'));
    const out = await recheckErrors([failed('openai', 'error', 'HTTP 504')], 1);
    expect(out).toEqual([failed('openai', 'error', 'HTTP 503')]);
  });

  test('expired is the provider\'s own verdict: it is not checked again', async () => {
    const checkSingle = jest.spyOn(TokenHealthService, 'checkSingle');
    const results = [failed('linkedin', 'expired', 'HTTP 401'), healthy('stripe')];
    expect(await recheckErrors(results, 1)).toBe(results);
    expect(checkSingle).not.toHaveBeenCalled();
  });

  test('no wait asked (the admin "check now" button): nothing is checked again', async () => {
    const checkSingle = jest.spyOn(TokenHealthService, 'checkSingle');
    const results = [failed('openai', 'error', 'HTTP 504')];
    expect(await recheckErrors(results, 0)).toBe(results);
    expect(checkSingle).not.toHaveBeenCalled();
  });
});

describe('settleTokenAlerts: one bell row per failing platform, closed when the platform passes', () => {
  test('a failure is raised under its platform key with the text the alert always had', async () => {
    await settleTokenAlerts([failed('openai', 'error', 'HTTP 504'), failed('linkedin', 'expired', null)]);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen.mock.calls.map(([category, title, body, opts]) => [category, title, body, opts.dedupeKey, opts.refreshOnDedupe, opts.link])).toEqual([
      ['token_alert', 'openai credential error', 'HTTP 504', 'token_alert:openai', true, '/admin/social-media'],
      ['token_alert', 'linkedin credential expired', 'Check token health dashboard', 'token_alert:linkedin', true, '/admin/social-media'],
    ]);
  });

  test('the rows of the platforms that passed are closed; a failing or unconfigured platform keeps its row', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValue(1);
    await settleTokenAlerts([healthy('openai'), healthy('stripe'), failed('linkedin', 'expired', 'HTTP 401'), { platform: 'beehiiv', status: 'not_configured', lastError: 'Missing', expiresAt: null }]);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    const [conn, keys, reason, opts] = episodes.closeAdminAlertKeys.mock.calls[0];
    expect(conn).toBe(db);
    expect(keys).toEqual(['token_alert:openai', 'token_alert:stripe']);
    expect(reason).toBe('credential_check_passed');
    expect(opts.resolution).toBe('Cleared: the credential check passed');
  });

  test('ALERT_EPISODES off: the write as it was, and nothing is closed', async () => {
    alertEpisodesLive.mockReturnValue(false);
    await settleTokenAlerts([healthy('stripe'), failed('openai', 'error', 'HTTP 504')]);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect([category, title, body]).toEqual(['token_alert', 'openai credential error', 'HTTP 504']);
    expect(opts).not.toHaveProperty('dedupeKey');
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a failed alert write never fails the check', async () => {
    episodes.raiseAdminAlertWithReopen.mockRejectedValue(new Error('db down'));
    await expect(settleTokenAlerts([failed('openai', 'error', 'HTTP 504')])).resolves.toBeUndefined();
  });
});

describe('runDailyCheck: the scheduled 7 AM run and the owner\'s alert row', () => {
  test('it asks checkAll to check an error twice', async () => {
    const checkAll = jest.spyOn(TokenHealthService, 'checkAll').mockResolvedValue([healthy('openai')]);
    await TokenHealthService.runDailyCheck();
    expect(RECHECK_DELAY_MS).toBeGreaterThan(0);
    expect(checkAll).toHaveBeenCalledWith({ recheckDelayMs: RECHECK_DELAY_MS });
  });

  test('every check passed: the rows earlier mornings wrote are retired and no row is written', async () => {
    jest.spyOn(TokenHealthService, 'checkAll').mockResolvedValue([healthy('openai'), { platform: 'beehiiv', status: 'not_configured', lastError: 'Missing', expiresAt: null }]);
    expect(await TokenHealthService.runDailyCheck()).toEqual({ failures: 0, total: 2 });
    expect(retireIfClean).toHaveBeenCalledWith('owner-alert:credential-check');
    expect(recordOwnerAlert).not.toHaveBeenCalled();
  });

  test('a failure writes the day\'s row, which replaces the row of an earlier morning', async () => {
    jest.spyOn(TokenHealthService, 'checkAll').mockResolvedValue([healthy('stripe'), failed('openai', 'error', 'HTTP 503'), failed('linkedin', 'expired', 'HTTP 401')]);
    expect(await TokenHealthService.runDailyCheck()).toEqual({ failures: 2, total: 3 });
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(recordOwnerAlert).toHaveBeenCalledTimes(1);
    const [kind, fields] = recordOwnerAlert.mock.calls[0];
    expect(kind).toBe('credential-check');
    expect(fields).toMatchObject({
      action: 'renew an expired credential',
      why: '2 credentials failed the 7 AM check.',
      link: '/admin/settings?tab=integrations',
      subject: { type: 'check', id: 'credential-check' },
      itemKeys: ['linkedin', 'openai'],
      supersedePrior: true,
    });
    expect(fields.dedupeKey).toMatch(/^owner-alert:credential-check:\d{4}-\d{2}-\d{2}$/);
    expect(fields.text).toBe('Token Alert: 2 credential(s) need attention:\n- openai: error — HTTP 503\n- linkedin: expired — HTTP 401');
  });
});
