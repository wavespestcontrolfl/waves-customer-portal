jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  const qb = () => { throw new Error('db must not be touched when loadRows is injected'); };
  qb.raw = () => { throw new Error('db.raw must not be touched when loadRows is injected'); };
  return qb;
});

const sendgrid = require('../services/sendgrid-mail');
const {
  runRescheduleIntentWatcher,
  _private: { composeRescheduleIntentDigest },
} = require('../services/reschedule-intent-watcher');

const flag = (over = {}) => ({
  id: 'f1',
  created_at: '2026-08-05T04:30:00Z',
  input_snapshot: JSON.stringify({ body_excerpt: 'leaving for vacation tomorrow, can we reschedule?' }),
  customer_id: 'cu-1',
  first_name: 'Sharon',
  last_name: 'F',
  scheduled_date: '2026-08-05',
  window_start: '09:00:00',
  service_type: 'Quarterly Pest Control',
  visit_status: 'confirmed',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.RESCHEDULE_INTENT_WATCHER_DISABLED;
  delete process.env.RESCHEDULE_INTENT_WATCHER_EMAIL;
});

describe('composeRescheduleIntentDigest', () => {
  test('no flags composes nothing', () => {
    expect(composeRescheduleIntentDigest([])).toBeNull();
  });

  test('ACT subject and STILL ARMED marker on linked visit', () => {
    const composed = composeRescheduleIntentDigest([flag()]);
    expect(composed.subject).toBe('ACT: 1 reschedule request by text with no schedule change');
    expect(composed.text).toContain('Sharon F');
    expect(composed.text).toContain('STILL ARMED');
    expect(composed.text).toContain('can we reschedule?');
  });

  test('flag with no visit reads no-upcoming-visit', () => {
    const composed = composeRescheduleIntentDigest([flag({ scheduled_date: null, window_start: null, service_type: null })]);
    expect(composed.text).toContain('no upcoming visit on the books');
  });

  test('unparseable snapshot degrades to empty excerpt, not a throw', () => {
    const composed = composeRescheduleIntentDigest([flag({ input_snapshot: '{broken' })]);
    expect(composed.count).toBe(1);
  });
});

describe('runRescheduleIntentWatcher', () => {
  const never = async () => false;
  const noop = async () => {};

  test('sends on unactioned flags', async () => {
    const result = await runRescheduleIntentWatcher({
      loadRows: async () => [flag()],
      sentRecently: never,
      stampSendMarker: noop,
    });
    expect(result.sent).toBe(true);
    expect(sendgrid.sendOne.mock.calls[0][0].subject).toMatch(/^ACT: 1 reschedule request/);
  });

  test('quiet window sends nothing', async () => {
    const result = await runRescheduleIntentWatcher({
      loadRows: async () => [],
      sentRecently: never,
      stampSendMarker: noop,
    });
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('kill switch suppresses send', async () => {
    process.env.RESCHEDULE_INTENT_WATCHER_DISABLED = 'true';
    const result = await runRescheduleIntentWatcher({
      loadRows: async () => [flag()],
      sentRecently: never,
      stampSendMarker: noop,
    });
    expect(result.skipped).toBe('disabled');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('non-internal recipient fails closed', async () => {
    process.env.RESCHEDULE_INTENT_WATCHER_EMAIL = 'stranger@example.com';
    const result = await runRescheduleIntentWatcher({
      loadRows: async () => [flag()],
      sentRecently: never,
      stampSendMarker: noop,
    });
    expect(result.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});
