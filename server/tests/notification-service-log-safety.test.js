// The notification writers' failure logs must never carry the bell body: a Knex
// error message echoes the SQL and its bound values (customer names, addresses).
// Owner rule: PII stays out of logs. Synthetic data only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');

const BODY = 'Form Lead, 1234 Sample Newbuild Trl, Parrish, FL, 34219, 2026-10-05 13:00. Google matched the street only.';
const knexLikeError = () => Object.assign(
  new Error(`insert into "notifications" ("body", "title") values ('${BODY}', 't') - duplicate key value violates unique constraint "x_idx"`),
  { code: '23505', constraint: 'x_idx' },
);
const allLogged = () => [logger.info, logger.warn, logger.error].flatMap((f) => f.mock.calls.map((c) => c.join(' '))).join('\n');

beforeEach(() => { jest.clearAllMocks(); });

describe('NotificationService failure logs', () => {
  test('a failing bell insert returns null (unchanged) and logs only the code and constraint, no body text', async () => {
    db.mockImplementation(() => ({ insert: () => ({ returning: async () => { throw knexLikeError(); } }) }));
    const out = await NotificationService.create({ recipientType: 'admin', category: 'schedule', title: 't', body: BODY });
    expect(out).toBeNull();
    const logged = allLogged();
    expect(logged).toContain('[notifications] Create failed: 23505 constraint=x_idx');
    expect(logged).not.toContain('Sample Newbuild');
    expect(logged).not.toContain('Form Lead');
    expect(logged).not.toContain('insert into');
  });

  test('the summary is code / name / constraint only', () => {
    expect(NotificationService.safeErrorSummary(knexLikeError())).toBe('23505 constraint=x_idx');
    expect(NotificationService.safeErrorSummary(new TypeError('boom with secret'))).toBe('TypeError');
    expect(NotificationService.safeErrorSummary(null)).toBe('error');
  });

  test('no notification writer logs err.message (bell, policy and dedupe failure paths)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/notification-service.js'), 'utf8');
    for (const label of ['bell policy check failed', 'Create failed', 'Admin notification dedupe failed', 'Customer notification dedupe failed']) {
      const line = src.split('\n').find((l) => l.includes(label));
      expect(line).toContain('safeErrorSummary(err)');
      expect(line).not.toContain('err.message');
    }
  });
});

describe('the street-level bell', () => {
  test('a failing notifyAdmin logs no message text from the error (code or name only)', async () => {
    const { ringStreetLevelHoldBell } = require('../services/call-recording-processor')._test;
    const svc = require('../services/notification-service');
    jest.spyOn(svc, 'notifyAdmin').mockRejectedValue(knexLikeError());
    db.mockImplementation(() => { throw new Error('no db in this test'); });
    // The live check fails open on a lookup error, so it reaches notifyAdmin.
    const rang = await ringStreetLevelHoldBell({
      hold: { address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219', customer_name: 'Form Lead' },
      visit: { id: 'v1', scheduled_date: '2026-10-05', window_start: '13:00:00' }, callSid: 'CA123',
    });
    expect(rang).toBe(false);
    const logged = allLogged();
    expect(logged).toContain('admin bell failed');
    expect(logged).not.toContain('Sample Newbuild');
    expect(logged).not.toContain('insert into');
  });
});
