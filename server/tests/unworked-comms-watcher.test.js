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
  recommended_action: 'Call back about flea/tick rental inspection', customer_name: 'Test Customertwo', ...over,
});
const thread = (over = {}) => ({
  peer: '9415558360', message_body: 'Do you plan to swing by next week?', created_at: '2026-08-05T14:00:00Z',
  customer_name: 'Test Customerthree', customer_id: 'cu-1', ...over,
});
const request = (over = {}) => ({
  id: 'r1', category: 'pest_issue', subject: 'Bees making nests all over the house',
  urgency: 'routine', status: 'new', created_at: '2026-08-04T12:00:00Z',
  customer_name: 'Test Customerfour', customer_id: 'cu-2', ...over,
});

describe('composeUnworkedCommsDigest', () => {
  test('a zero-delivery click-to-estimate mint never fulfills a send_estimate task (source contract, #3391)', () => {
    // Those mints stamp sent_at without delivering anything — they must not
    // clear a send obligation owed from a call.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../services/unworked-comms-watcher.js'), 'utf8',
    );
    const block = src.split('fe.sent_at > t.created_at')[1].slice(0, 800);
    expect(block).toMatch(/COALESCE\(fe\.source, ''\) <> 'service_report_cta'/);
    // …but a mint an operator LATER actually delivered fulfills the task
    // (GitHub #3391 round P2). REAL delivery only — sentChannels also
    // carries SMS suppression sentinels (uncapped audit on 528b1aad7 P1).
    expect(block).toMatch(/fe\.estimate_data #>> '\{deliveryState,channels,email,ok\}' = 'true'/);
    expect(block).toMatch(/fe\.estimate_data #>> '\{deliveryState,channels,sms,real\}' = 'true'/);
    expect(block).not.toMatch(/sentChannels/);
  });

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
    expect(composed.subject).toBe('ACT: 4 unworked comms at end of day — 1 callback, 2 follow-ups, 1 unanswered text, 0 open requests');
    expect(composed.total).toBe(4);
  });

  test('single lane composes with only that section', () => {
    const composed = composeUnworkedCommsDigest({ unanswered: [thread()] });
    expect(composed.subject).toBe('ACT: 1 unworked comm at end of day — 0 callbacks, 0 follow-ups, 1 unanswered text, 0 open requests');
    expect(composed.text).toContain('Test Customerthree');
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

  test('open service requests compose their own section with age and urgency', () => {
    const composed = composeUnworkedCommsDigest({ requests: [request({ urgency: 'urgent' })] });
    expect(composed.subject).toBe('ACT: 1 unworked comm at end of day — 0 callbacks, 0 follow-ups, 0 unanswered texts, 1 open request');
    expect(composed.requests).toBe(1);
    expect(composed.text).toContain('Service requests still open');
    expect(composed.text).toContain('Test Customerfour');
    expect(composed.text).toContain('pest issue');
    expect(composed.text).toContain('URGENT');
    expect(composed.text).toContain('Bees making nests');
    // Deep-links the customer profile — the only remaining resolve surface.
    expect(composed.html).toContain('/admin/customers?customerId=cu-2');
  });

  test('request-lane overflow reports the full backlog via total_count', () => {
    const composed = composeUnworkedCommsDigest({
      requests: [request({ total_count: 14 })],
    });
    expect(composed.subject).toContain('14 open requests');
    expect(composed.text).toContain('…and 13 more not shown');
  });
});

describe('runUnworkedCommsWatcher', () => {
  const never = async () => false;
  const noop = async () => {};
  const loaders = (over = {}) => ({
    loadCallbackCalls: async () => [],
    loadDroppedFollowUps: async () => [],
    loadUnansweredThreads: async () => [],
    loadOpenServiceRequests: async () => [],
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

  test('one lane failing still sends the surviving lanes and NAMES the failed lane', async () => {
    const stamp = jest.fn(async () => {});
    const result = await runUnworkedCommsWatcher(loaders({
      loadDroppedFollowUps: async () => { throw new Error('syntax error at or near "ORDER"'); },
      loadCallbackCalls: async () => [callback()],
      stampSendMarker: stamp,
    }));
    expect(result.sent).toBe(true);
    expect(result.failedLanes).toEqual(['follow-ups']);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.subject).toMatch(/^FIX: /);
    expect(mail.subject).toContain('follow-ups');
    expect(mail.subject).toContain('1 unworked comm in surviving lanes');
    expect(mail.text).toContain('LANE FAILURE');
    expect(mail.text).toContain('follow-ups: syntax error at or near "ORDER"');
    // Surviving lane content still rides along.
    expect(mail.text).toContain('Callbacks requested');
    expect(stamp).toHaveBeenCalledTimes(1);
  });

  test('one lane failing with quiet surviving lanes still sends — a crashed lane must not look like a worked day', async () => {
    const result = await runUnworkedCommsWatcher(loaders({
      loadUnansweredThreads: async () => { throw new Error('boom'); },
    }));
    expect(result.sent).toBe(true);
    expect(result.failedLanes).toEqual(['unanswered texts']);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.subject).toMatch(/^FIX: /);
    expect(mail.subject).toContain('unanswered texts');
    expect(mail.subject).toContain('surviving lanes clear');
  });

  test('all lanes failing is query_failed (job_health must record the failed run), no send', async () => {
    const boom = async () => { throw new Error('boom'); };
    const result = await runUnworkedCommsWatcher(loaders({
      loadCallbackCalls: boom,
      loadDroppedFollowUps: boom,
      loadUnansweredThreads: boom,
      loadOpenServiceRequests: boom,
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

describe('lane SQL binding integrity', () => {
  // The unanswered-texts lane shipped a regex whose bare ? quantifiers knex
  // consumed as positional bindings ($2..$5, "could not determine data type
  // of parameter $2") — the lane failed every run until escaped. Compile
  // every lane's real SQL through knex's pg dialect and require each emitted
  // $n placeholder to have a bound value.
  test('every lane compiles with fully-resolved bindings — no bare ? swallowed by knex', async () => {
    const captured = [];
    jest.resetModules();
    jest.doMock('../models/db', () => {
      const qb = () => { throw new Error('unexpected query-builder use'); };
      qb.raw = (sql, bindings) => { captured.push({ sql, bindings }); return Promise.resolve({ rows: [] }); };
      return qb;
    });
    let loaders;
    jest.isolateModules(() => {
      ({ _private: loaders } = require('../services/unworked-comms-watcher'));
    });
    jest.dontMock('../models/db');
    await loaders.loadCallbackCalls(new Date('2026-08-08T00:00:00Z'));
    await loaders.loadDroppedFollowUps(new Date('2026-08-08T00:00:00Z'));
    await loaders.loadUnansweredThreads(new Date('2026-08-08T00:00:00Z'));
    await loaders.loadOpenServiceRequests(new Date('2026-08-08T00:00:00Z'));
    expect(captured.length).toBe(4);

    const knexPg = require('knex')({ client: 'pg' });
    for (const { sql, bindings } of captured) {
      const native = knexPg.raw(sql, bindings).toSQL().toNative();
      const maxPlaceholder = (native.sql.match(/\$\d+/g) || [])
        .reduce((max, p) => Math.max(max, Number(p.slice(1))), 0);
      expect(maxPlaceholder).toBe(native.bindings.length);
      for (const value of native.bindings) expect(value).toBeDefined();
    }
  });
});
