/**
 * GATE_ALERT_CATALOG=watch: an admin alert the bell policy silences leaves ONE audit_log row
 * per Eastern day per distinct alert (notification.bell_policy.muted), so a muted alert can be
 * counted. Gap in notification-bell-policy.test.js: it proves the silence (no row, truthy
 * sentinel) but nothing could ever see what was muted. Off = no read, no write.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((g) => g === 'adminBellPolicy'),
  alertCatalogMode: jest.fn(() => 'watch'),
}));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: jest.fn(() => false) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { alertCatalogMode } = require('../config/feature-gates');
const NotificationService = require('../services/notification-service');
const { auditBellPolicyMuted, BELL_POLICY_MUTED_ACTION } = require('../services/audit-log');

const SILENCED = { id: null, suppressed: true, reason: 'bell_policy' };
let auditInsert;
let connection;

function chain(result) {
  const c = {};
  for (const m of ['where', 'whereNull', 'whereRaw', 'select', 'first', 'orderBy', 'limit']) c[m] = jest.fn(() => c);
  c.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return c;
}
const muted = (title, category = 'alert') => NotificationService.create({
  recipientType: 'admin', category, title, body: 'body', metadata: { triggerKey: 'some_key' }, connection,
});
const auditRows = () => auditInsert.mock.calls.map(([row]) => ({ ...row, metadata: JSON.parse(row.metadata) }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2026-10-29T15:00:00Z'));
  alertCatalogMode.mockReturnValue('watch');
  auditInsert = jest.fn(async () => []);
  connection = jest.fn(() => { throw new Error('the caller connection must not be used'); });
  db.mockImplementation((table) => {
    if (table === 'audit_log') return { insert: auditInsert };
    if (table === 'notification_preferences') return chain([]);
    throw new Error(`unexpected table: ${table}`);
  });
});
afterEach(() => { jest.useRealTimers(); });

describe('muted alert record (GATE_ALERT_CATALOG=watch)', () => {
  test('writes one row per Eastern day per distinct alert, with the digits and spacing stripped from the stem', async () => {
    // A title stem carries no digits, so "7 unsent drafts" and "9 unsent drafts" are one alert.
    expect(await muted('Review   7 unsent drafts')).toEqual(SILENCED);
    expect(await muted('Review 9 unsent drafts')).toEqual(SILENCED);
    expect(await muted('Review 9 unsent drafts', 'knowledge')).toEqual(SILENCED); // other category = other alert
    expect(auditRows()).toEqual([
      expect.objectContaining({
        actor_type: 'system', action: BELL_POLICY_MUTED_ACTION, resource_type: 'notification',
        metadata: { category: 'alert', triggerKey: 'some_key', titleStem: 'Review # unsent drafts', etDay: '2026-10-29' },
      }),
      expect.objectContaining({ metadata: expect.objectContaining({ category: 'knowledge' }) }),
    ]);
    expect(auditRows()[0]).not.toHaveProperty('resource_id');
    expect(connection).not.toHaveBeenCalled();

    // The next Eastern day writes the same alert again; 03:30Z on the 30th is still the 29th in Eastern.
    jest.setSystemTime(new Date('2026-10-30T03:30:00Z'));
    await muted('Review 9 unsent drafts');
    expect(auditInsert).toHaveBeenCalledTimes(2);
    jest.setSystemTime(new Date('2026-10-30T05:00:00Z'));
    await muted('Review 9 unsent drafts');
    expect(auditRows()[2].metadata.etDay).toBe('2026-10-30');
  });

  test('off: no audit_log read or write, and the same silence', async () => {
    alertCatalogMode.mockReturnValue('off');
    expect(await muted('Review 7 unsent drafts')).toEqual(SILENCED);
    expect(db.mock.calls.map(([t]) => t)).not.toContain('audit_log');
  });

  test('a failed write leaves create() unchanged, logs no title text, and is retried next time', async () => {
    auditInsert.mockRejectedValueOnce(Object.assign(new Error('insert into "audit_log" ... Dana Example'), { code: '57P01' }));
    expect(await muted('Dana Example texted 3 times')).toEqual(SILENCED);
    const logged = [logger.info, logger.warn, logger.error].flatMap((f) => f.mock.calls.map((c) => c.join(' '))).join('\n');
    expect(logged).toContain('[notifications] muted-alert audit failed: 57P01');
    expect(logged).not.toContain('Dana Example');
    expect(await muted('Dana Example texted 3 times')).toEqual(SILENCED);
    expect(auditInsert).toHaveBeenCalledTimes(2);
  });

  test('the stem cuts at 80 characters', async () => {
    await auditBellPolicyMuted({ category: 'alert', title: `${'word '.repeat(30)}12345` });
    expect(auditRows()[0].metadata.titleStem).toHaveLength(80);
  });
});
