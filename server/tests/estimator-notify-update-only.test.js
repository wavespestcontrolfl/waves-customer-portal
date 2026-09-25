/**
 * codex #4815 r2 P2: the earlier engine run's "draft ready" notification
 * (or the deduped generic quote-promised bell it upgraded in place) must be
 * retired in place when a price_agreed_on_call invalidation archives the
 * draft it describes — otherwise staff are still told to send an amount
 * that no longer exists as a sendable draft. The engine's notify() already
 * supports forceUpdate (replace whatever the bell said); this adds
 * updateOnly (never manufacture a FRESH bell when there is nothing to
 * retire) and this test drives notify() directly — the real production
 * function — to prove both halves:
 *   1. a prior same-callSid bell IS replaced in place, with the agreed
 *      amount and no stale estimate link;
 *   2. with NO prior bell, updateOnly is a true no-op — no insert.
 *
 * Fixtures fictitious (call-1); no real customer data.
 */

let mockNotificationRow = null;
const mockNotificationUpdates = [];
const mockNotifyAdmin = jest.fn(async () => ({ id: 'bell-new' }));

jest.mock('../models/db', () => {
  const db = (table) => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'orderBy']) {
      b[m] = () => b;
    }
    b.first = async () => (table === 'notifications' ? mockNotificationRow : null);
    b.update = async (row) => {
      mockNotificationUpdates.push(row);
      return 1;
    };
    return b;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const { notify } = require('../services/estimator-engine/index');

const CALL = { twilio_call_sid: 'CA-price-agreed-1' };

function priorBellRow(overrides = {}) {
  return {
    id: 'bell-1',
    metadata: JSON.stringify({
      callSid: 'CA-price-agreed-1',
      estimator_engine: true,
      quote_promised: true,
      lane: 'yellow',
      estimateId: 'est-9',
    }),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNotificationUpdates.length = 0;
  mockNotificationRow = null;
});

describe('notify({ updateOnly: true }) — retiring a stale estimator bell (codex #4815 r2 P2)', () => {
  test('a prior estimator bell for this call IS replaced in place: new title/body, agreed-amount body, estimateId cleared (no stale link)', async () => {
    mockNotificationRow = priorBellRow();

    const result = await notify({
      call: CALL,
      title: 'Price agreed on call — draft retired',
      body: 'Jane Doe: a price ($300.00) was agreed on this call, so the AI estimate draft was retired. No quote is owed — the price is already set.',
      estimateId: null,
      quotePromised: false,
      link: '/admin/customers/cust-1',
      forceUpdate: true,
      updateOnly: true,
    });

    expect(result).toBe(true);
    expect(mockNotificationUpdates).toHaveLength(1);
    const update = mockNotificationUpdates[0];
    expect(update.title).toBe('Price agreed on call — draft retired');
    expect(update.body).toContain('$300.00');
    expect(update.link).toBe('/admin/customers/cust-1');
    expect(update.read_at).toBeNull();
    const metadata = JSON.parse(update.metadata);
    // No stale estimate link — the archived draft's id must not survive.
    expect(metadata.estimateId).toBeNull();
    expect(metadata.quote_promised).toBe(false);
    expect(metadata.callSid).toBe('CA-price-agreed-1');
    // notifyAdmin (the fresh-insert path) must never have been called.
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a prior GENERIC quote-promised bell (not yet upgraded by the engine) is ALSO matched and replaced — the same dedupe union forceUpdate already relies on', async () => {
    // A bell rung by the synchronous "quote promised — send it" path never
    // carries estimator_engine, only quote_promised — notify()'s own
    // dedupe query already unions both; updateOnly must not narrow that.
    mockNotificationRow = priorBellRow({
      metadata: JSON.stringify({ callSid: 'CA-price-agreed-1', quote_promised: true }),
    });

    const result = await notify({
      call: CALL,
      title: 'Price agreed on call — draft retired',
      body: 'retired',
      estimateId: null,
      quotePromised: false,
      forceUpdate: true,
      updateOnly: true,
    });

    expect(result).toBe(true);
    expect(mockNotificationUpdates).toHaveLength(1);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('NO prior bell for this call ⇒ true no-op, never manufactures a fresh notification', async () => {
    mockNotificationRow = null;

    const result = await notify({
      call: CALL,
      title: 'Price agreed on call — draft retired',
      body: 'retired',
      estimateId: null,
      quotePromised: false,
      forceUpdate: true,
      updateOnly: true,
    });

    expect(result).toBe(false);
    expect(mockNotificationUpdates).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a call with no twilio_call_sid at all (no dedupe key) also refuses to insert under updateOnly', async () => {
    const result = await notify({
      call: {},
      title: 'Price agreed on call — draft retired',
      body: 'retired',
      estimateId: null,
      quotePromised: false,
      forceUpdate: true,
      updateOnly: true,
    });

    expect(result).toBe(false);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('sanity: WITHOUT updateOnly, the same no-prior-bell case falls through to a fresh insert (existing behavior untouched)', async () => {
    mockNotificationRow = null;

    const result = await notify({
      call: CALL,
      title: 'AI estimate draft ready — $120/mo',
      body: 'ready',
      estimateId: 'est-1',
      quotePromised: true,
    });

    expect(result).toBe(true);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });
});
