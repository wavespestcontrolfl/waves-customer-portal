jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  const qb = () => { throw new Error('db must not be touched when loaders are injected'); };
  qb.raw = () => { throw new Error('db.raw must not be touched when loaders are injected'); };
  return qb;
});

const sendgrid = require('../services/sendgrid-mail');
const {
  runUnworkedCommsWatcher,
  _private: { composeUnworkedCommsDigest },
} = require('../services/unworked-comms-watcher');

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.UNWORKED_COMMS_WATCHER_DISABLED;
  delete process.env.UNWORKED_COMMS_WATCHER_EMAIL;
});

const callback = (over = {}) => ({
  id: 'c1', created_at: '2026-08-05T17:41:00Z', from_phone: '+19415555610',
  duration_seconds: 879, customer_name: null, summary: 'Existing customer, long call, asked for a callback.', ...over,
});
const followUp = (over = {}) => ({
  id: 't1', task_type: 'call_back', deadline: '2026-08-05T20:57:00Z', status: 'expired',
  recommended_action: 'Call back about flea/tick rental inspection', customer_name: 'David M', ...over,
});
const thread = (over = {}) => ({
  peer: '9415558360', message_body: 'Do you plan to swing by next week?', created_at: '2026-08-05T14:00:00Z',
  customer_name: 'Prasan C', customer_id: 'cu-1', ...over,
});

describe('composeUnworkedCommsDigest', () => {
  test('fully-worked day composes nothing', () => {
    expect(composeUnworkedCommsDigest({ callbacks: [], followUps: [], unanswered: [] })).toBeNull();
    expect(composeUnworkedCommsDigest({})).toBeNull();
  });

  test('subject carries the per-lane counts', () => {
    const composed = composeUnworkedCommsDigest({
      callbacks: [callback()],
      followUps: [followUp(), followUp({ id: 't2', status: 'pending' })],
      unanswered: [thread()],
    });
    expect(composed.subject).toBe('ACT: 4 unworked comms at end of day — 1 callback, 2 follow-ups, 1 unanswered text');
    expect(composed.total).toBe(4);
  });

  test('single lane composes with only that section', () => {
    const composed = composeUnworkedCommsDigest({ unanswered: [thread()] });
    expect(composed.subject).toBe('ACT: 1 unworked comm at end of day — 0 callbacks, 0 follow-ups, 1 unanswered text');
    expect(composed.text).toContain('Prasan C');
    expect(composed.text).not.toContain('Callbacks requested');
    expect(composed.text).not.toContain('Follow-up tasks');
  });

  test('expired follow-ups are labeled auto-expired', () => {
    const composed = composeUnworkedCommsDigest({ followUps: [followUp()] });
    expect(composed.text).toContain('auto-expired');
  });

  test('masks phone when no customer match', () => {
    const composed = composeUnworkedCommsDigest({ callbacks: [callback()] });
    expect(composed.text).toContain('…5610');
    expect(composed.text).not.toContain('+19415555610');
  });

  test('html escapes message bodies', () => {
    const composed = composeUnworkedCommsDigest({ unanswered: [thread({ message_body: 'hi <b>&' })] });
    expect(composed.html).toContain('hi &lt;b&gt;&amp;');
  });
});

describe('runUnworkedCommsWatcher', () => {
  const never = async () => false;
  const noop = async () => {};
  const loaders = (over = {}) => ({
    loadCallbackCalls: async () => [],
    loadDroppedFollowUps: async () => [],
    loadUnansweredThreads: async () => [],
    sentRecently: never,
    stampSendMarker: noop,
    ...over,
  });

  test('sends when any lane has items', async () => {
    const stamp = jest.fn(async () => {});
    const result = await runUnworkedCommsWatcher(loaders({
      loadCallbackCalls: async () => [callback()],
      stampSendMarker: stamp,
    }));
    expect(result.sent).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(stamp).toHaveBeenCalledTimes(1);
  });

  test('quiet day sends nothing', async () => {
    const result = await runUnworkedCommsWatcher(loaders());
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('one lane failing is query_failed, never a partial send', async () => {
    const result = await runUnworkedCommsWatcher(loaders({
      loadDroppedFollowUps: async () => { throw new Error('boom'); },
      loadCallbackCalls: async () => [callback()],
    }));
    expect(result).toEqual({ skipped: 'query_failed' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('recent send short-circuits', async () => {
    const result = await runUnworkedCommsWatcher(loaders({ sentRecently: async () => true }));
    expect(result).toEqual({ skipped: 'recent_send' });
  });

  test('non-internal recipient fails closed', async () => {
    process.env.UNWORKED_COMMS_WATCHER_EMAIL = 'stranger@example.com';
    const result = await runUnworkedCommsWatcher(loaders({
      loadUnansweredThreads: async () => [thread()],
    }));
    expect(result.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});
