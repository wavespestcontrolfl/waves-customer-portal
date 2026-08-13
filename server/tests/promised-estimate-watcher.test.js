jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  // Marker reads/writes are try/caught in the service; loaders are injected.
  const qb = () => { throw new Error('db must not be touched when loadRows is injected'); };
  qb.raw = () => { throw new Error('db.raw must not be touched when loadRows is injected'); };
  return qb;
});

const sendgrid = require('../services/sendgrid-mail');
const {
  runPromisedEstimateWatcher,
  _private: { composePromisedEstimateDigest },
} = require('../services/promised-estimate-watcher');

const DAY_MS = 24 * 60 * 60 * 1000;
function row(ageDays, overrides = {}) {
  return {
    id: `call-${ageDays}`,
    created_at: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    from_phone: '+19415551234',
    customer_id: null,
    customer_name: null,
    disposition: 'estimate_send',
    duration_seconds: 300,
    summary: 'Caller asked for a lawn quote; agent promised to send it.',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.PROMISED_ESTIMATE_WATCHER_DISABLED;
  delete process.env.PROMISED_ESTIMATE_WATCHER_EMAIL;
});

describe('composePromisedEstimateDigest', () => {
  test('no rows composes nothing (quiet day)', () => {
    expect(composePromisedEstimateDigest([])).toBeNull();
    expect(composePromisedEstimateDigest(null)).toBeNull();
  });

  test('ACT subject carries count and oldest age', () => {
    const composed = composePromisedEstimateDigest([row(6), row(2)]);
    expect(composed.subject).toBe('ACT: 2 promised quotes never went out — oldest 6d');
    expect(composed.count).toBe(2);
    expect(composed.oldestDays).toBe(6);
  });

  test('masks phone when no customer name and includes summary', () => {
    const composed = composePromisedEstimateDigest([row(3)]);
    expect(composed.text).toContain('…1234');
    expect(composed.text).toContain('lawn quote');
    expect(composed.text).not.toContain('+19415551234');
  });

  test('uses customer name when present', () => {
    const composed = composePromisedEstimateDigest([row(3, { customer_name: 'Test Customerfour' })]);
    expect(composed.text).toContain('Test Customerfour');
  });

  test('html escapes the summary', () => {
    const composed = composePromisedEstimateDigest([row(2, { summary: 'quote <script> & stuff' })]);
    expect(composed.html).toContain('&lt;script&gt;');
    expect(composed.html).not.toContain('<script>');
  });
});

describe('runPromisedEstimateWatcher', () => {
  const never = async () => false;
  const noop = async () => {};

  test('sends and stamps on findings', async () => {
    const stamp = jest.fn(async () => {});
    const result = await runPromisedEstimateWatcher({
      loadRows: async () => [row(4)],
      sentRecently: never,
      stampSendMarker: stamp,
    });
    expect(result.sent).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne.mock.calls[0][0].subject).toMatch(/^ACT: 1 promised quote never went out/);
    expect(stamp).toHaveBeenCalledTimes(1);
  });

  test('a zero-delivery click-to-estimate mint never counts as a kept promise (source contract, #3391)', () => {
    // Those mints stamp sent_at for the publish-without-delivery shape but
    // nothing was DELIVERED — a report tap after a promised-quote call must
    // not erase the obligation.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../services/promised-estimate-watcher.js'), 'utf8',
    );
    const block = src.split('e.sent_at IS NOT NULL')[1].slice(0, 1200);
    expect(block).toMatch(/COALESCE\(e\.source, ''\) <> 'service_report_cta'/);
    // …but a mint an operator LATER actually delivered keeps the promise
    // (GitHub #3391 round P2). REAL delivery only — sentChannels also
    // carries SMS suppression sentinels (uncapped audit on 528b1aad7 P1),
    // so the predicate keys on channels.email.ok / channels.sms.real, the
    // same line stampChannels draws, never on sentChannels length.
    expect(block).toMatch(/e\.estimate_data #>> '\{deliveryState,channels,email,ok\}' = 'true'/);
    expect(block).toMatch(/e\.estimate_data #>> '\{deliveryState,channels,sms,real\}' = 'true'/);
    expect(block).not.toMatch(/sentChannels\}'\) = 'array'/);
  });

  test('quiet day skips without sending or stamping', async () => {
    const stamp = jest.fn(async () => {});
    const result = await runPromisedEstimateWatcher({
      loadRows: async () => [],
      sentRecently: never,
      stampSendMarker: stamp,
    });
    expect(result).toEqual({ skipped: 'nothing_found' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  });

  test('recent send short-circuits before the query', async () => {
    const loadRows = jest.fn();
    const result = await runPromisedEstimateWatcher({ loadRows, sentRecently: async () => true });
    expect(result).toEqual({ skipped: 'recent_send' });
    expect(loadRows).not.toHaveBeenCalled();
  });

  test('query failure is a distinct skip (never a false clean)', async () => {
    const result = await runPromisedEstimateWatcher({
      loadRows: async () => { throw new Error('boom'); },
      sentRecently: never,
      stampSendMarker: noop,
    });
    expect(result).toEqual({ skipped: 'query_failed' });
  });

  test('kill switch suppresses the send but reports what it would do', async () => {
    process.env.PROMISED_ESTIMATE_WATCHER_DISABLED = '1';
    const result = await runPromisedEstimateWatcher({
      loadRows: async () => [row(4)],
      sentRecently: never,
      stampSendMarker: noop,
    });
    expect(result.skipped).toBe('disabled');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('non-internal recipient fails closed', async () => {
    process.env.PROMISED_ESTIMATE_WATCHER_EMAIL = 'stranger@example.com';
    const result = await runPromisedEstimateWatcher({
      loadRows: async () => [row(4)],
      sentRecently: never,
      stampSendMarker: noop,
    });
    expect(result.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('send failure does not stamp the marker', async () => {
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 500 }));
    const stamp = jest.fn(async () => {});
    const result = await runPromisedEstimateWatcher({
      loadRows: async () => [row(4)],
      sentRecently: never,
      stampSendMarker: stamp,
    });
    expect(result.error).toBe(true);
    expect(stamp).not.toHaveBeenCalled();
  });
});
