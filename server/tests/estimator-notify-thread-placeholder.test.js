/**
 * Text-origin estimator bell: the "drafting now" placeholder is replaced in
 * place by the engine's real outcome.
 *
 * Before: for a thread key (no callSid), an existing estimator bell with no
 * estimateId plus a new call with no estimateId hit `bothOpen` and returned
 * with NO update, so every red / blocked / composer-fail / error outcome left
 * the placeholder text standing forever. Only a created draft upgraded it.
 *
 * Drives the real notify() against a one-row fake notifications table.
 * Call-origin (callSid) behavior is pinned unchanged.
 *
 * Fixtures fictitious (sms:9415550123); no real customer data.
 */

let mockRow = null;
let mockAffectedRows = 1;
const mockUpdates = [];
// Every where clause applied to the builder that ran each update, in order.
const mockUpdateWheres = [];
const mockNotifyAdmin = jest.fn(async () => ({ id: 'bell-new' }));

jest.mock('../models/db', () => {
  const db = (table) => {
    const b = {};
    const log = [];
    for (const m of ['where', 'whereRaw', 'orderBy']) {
      b[m] = (...args) => {
        log.push({ m, args });
        return b;
      };
    }
    b.first = async () => (table === 'notifications' ? mockRow : null);
    b.update = async (row) => {
      mockUpdates.push(row);
      mockUpdateWheres.push(log.slice());
      return mockAffectedRows;
    };
    return b;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
  adminBodyColumns: (_category, body) => ({ body, detail: null }),
}));

const { notify, _private } = require('../services/estimator-engine/index');

const THREAD_KEY = 'sms:9415550123';
// Links carry a customer id and the text's SID, never the phone number.
const SENDER_LINK = '/admin/communications?message=SM0abc';
const PLACEHOLDER_TITLE = 'Quote asked by text — send it';

function bellRow(meta = {}, overrides = {}) {
  return {
    id: 'bell-1',
    done_at: null,
    metadata: JSON.stringify({
      smsThreadKey: THREAD_KEY,
      estimator_engine: true,
      quote_promised: true,
      lane: 'red',
      estimateId: null,
      placeholder: true,
      ...meta,
    }),
    ...overrides,
  };
}

function placeholderCall(extra = {}) {
  return {
    call: null,
    context: null,
    lane: 'red',
    quotePromised: true,
    threadKey: THREAD_KEY,
    title: PLACEHOLDER_TITLE,
    body: 'Texter …0123 asked for a quote by text. The estimator is drafting it; if no draft comes, send one by hand.',
    link: SENDER_LINK,
    placeholder: true,
    ...extra,
  };
}

function outcomeCall(extra = {}) {
  return {
    call: null,
    context: null,
    lane: 'red',
    quotePromised: true,
    threadKey: THREAD_KEY,
    title: PLACEHOLDER_TITLE,
    body: 'Jane Doe: quote requested over SMS, no auto-draft (needs a property check). Reply with pricing manually.',
    link: SENDER_LINK,
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.length = 0;
  mockUpdateWheres.length = 0;
  mockAffectedRows = 1;
  mockRow = null;
});

describe('notify() with a thread key', () => {
  test('the first placeholder is a fresh insert carrying metadata.placeholder and the sender link', async () => {
    expect(await notify(placeholderCall())).toBe(true);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [, , , opts] = mockNotifyAdmin.mock.calls[0];
    expect(opts.link).toBe(SENDER_LINK);
    expect(opts.metadata.placeholder).toBe(true);
    expect(opts.metadata.smsThreadKey).toBe(THREAD_KEY);
  });

  test('a red outcome REPLACES the open placeholder in place (one row, new title/body/link, marker cleared)', async () => {
    mockRow = bellRow();
    const result = await notify(outcomeCall({
      title: 'Quote asked by text — send it (red)',
      link: '/admin/communications?thread=cust-1',
    }));
    expect(result).toBe(true);
    expect(mockUpdates).toHaveLength(1);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    const update = mockUpdates[0];
    expect(update.title).toBe('Quote asked by text — send it (red)');
    expect(update.body).toMatch(/^Jane Doe: quote requested over SMS/);
    expect(update.body).not.toMatch(/drafting/);
    expect(update.link).toBe('/admin/communications?thread=cust-1');
    expect(update.read_at).toBeNull();
    expect(update.done_at).toBeNull();
    const meta = JSON.parse(update.metadata);
    expect(meta.placeholder).toBe(false);
    expect(meta.smsThreadKey).toBe(THREAD_KEY);
    expect(meta.estimateId).toBeNull();
  });

  test('a blocked outcome replaces the placeholder and links to the open estimate (estimateId stays null)', async () => {
    mockRow = bellRow();
    const link = _private.blockedThreadLink(
      { threadKey: THREAD_KEY, bellLink: SENDER_LINK },
      { blocked: true, duplicateBlock: { existingEstimateId: 'est-77' } },
    );
    expect(link).toBe('/admin/estimates?estimateId=est-77');
    await notify(outcomeCall({
      title: 'Quote asked by text — estimate already open',
      body: 'Jane Doe: a text thread asked for a quote, but an automated estimate is already open for this phone number. Review and send the existing one.',
      link,
    }));
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].title).toBe('Quote asked by text — estimate already open');
    expect(mockUpdates[0].link).toBe('/admin/estimates?estimateId=est-77');
    const meta = JSON.parse(mockUpdates[0].metadata);
    expect(meta.estimateId).toBeNull();
    expect(meta.placeholder).toBe(false);
  });

  test('a created draft still upgrades the placeholder exactly as before', async () => {
    mockRow = bellRow();
    await notify(outcomeCall({
      estimateId: 'est-5',
      title: 'AI estimate draft ready — $50/mo',
      body: 'Jane Doe: pest drafted from the text thread (GREEN — ready to send).',
      link: undefined,
    }));
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].link).toBe('/admin/estimates?estimateId=est-5');
    const meta = JSON.parse(mockUpdates[0].metadata);
    expect(meta.estimateId).toBe('est-5');
    expect(meta.placeholder).toBe(false);
  });

  test('a LATER placeholder never overwrites an outcome bell', async () => {
    mockRow = bellRow({ placeholder: false });
    expect(await notify(placeholderCall())).toBe(true);
    expect(mockUpdates).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('two placeholders stand (a repeated text never rewrites the row)', async () => {
    mockRow = bellRow();
    expect(await notify(placeholderCall())).toBe(true);
    expect(mockUpdates).toHaveLength(0);
  });

  test('an outcome after an outcome (no estimate on either side) still stands', async () => {
    mockRow = bellRow({ placeholder: false });
    expect(await notify(outcomeCall())).toBe(true);
    expect(mockUpdates).toHaveLength(0);
  });

  test('a placeholder a person already closed is not rewritten by an outcome', async () => {
    mockRow = bellRow({}, { done_at: new Date('2026-11-18T12:00:00Z') });
    expect(await notify(outcomeCall())).toBe(true);
    expect(mockUpdates).toHaveLength(0);
  });

  test('a bell that tells a completed draft story still gets a FRESH insert for a new placeholder', async () => {
    mockRow = bellRow({ placeholder: false, estimateId: 'est-1' });
    await notify(placeholderCall());
    expect(mockUpdates).toHaveLength(0);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('sender identity rides on text-origin bells only', () => {
  test('a placeholder insert carries metadata.senderIdentity', async () => {
    await notify(placeholderCall({ senderIdentity: '9415550123' }));
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.senderIdentity).toBe('9415550123');
  });

  test('an international identity is stored as +digits', async () => {
    await notify(placeholderCall({ senderIdentity: '+447700900123' }));
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.senderIdentity).toBe('+447700900123');
  });

  test('the identity survives the placeholder-gives-way rewrite, even when the outcome passes none', async () => {
    mockRow = bellRow({ senderIdentity: '9415550123' });
    await notify(outcomeCall({ senderIdentity: null }));
    expect(JSON.parse(mockUpdates[0].metadata).senderIdentity).toBe('9415550123');
    mockUpdates.length = 0;
    mockRow = bellRow({ senderIdentity: '9415550123' });
    await notify(outcomeCall({ senderIdentity: '9415550123' }));
    expect(JSON.parse(mockUpdates[0].metadata).senderIdentity).toBe('9415550123');
  });

  test('the identity survives a draft upgrade', async () => {
    mockRow = bellRow({ senderIdentity: '+447700900123' });
    await notify(outcomeCall({ estimateId: 'est-5', link: undefined, senderIdentity: undefined }));
    expect(JSON.parse(mockUpdates[0].metadata).senderIdentity).toBe('+447700900123');
  });

  test('a fresh text-origin outcome insert carries it', async () => {
    mockRow = bellRow({ placeholder: false, estimateId: 'est-1' });
    await notify(outcomeCall({ estimateId: 'est-2', senderIdentity: '9415550123' }));
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.senderIdentity).toBe('9415550123');
  });

  test('call-origin bells never carry the key (no identity, null or empty)', async () => {
    for (const senderIdentity of [undefined, null, '']) {
      mockNotifyAdmin.mockClear();
      await notify({
        call: { twilio_call_sid: 'CA-id-1' }, context: null, lane: 'red', quotePromised: true,
        title: 'Quote promised on call — send it', body: 'x', senderIdentity,
      });
      expect(mockNotifyAdmin.mock.calls[0][3].metadata).not.toHaveProperty('senderIdentity');
    }
  });
});

describe('a new ask after a CLOSED thread bell gets its own row', () => {
  const CLOSED = new Date('2026-11-18T12:00:00Z');

  test('a closed newest bell plus a placeholder inserts a fresh placeholder bell and never touches the closed row', async () => {
    mockRow = bellRow({ placeholder: false }, { done_at: CLOSED });
    expect(await notify(placeholderCall({ senderIdentity: '9415550123' }))).toBe(true);
    expect(mockUpdates).toHaveLength(0);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const meta = mockNotifyAdmin.mock.calls[0][3].metadata;
    expect(meta.placeholder).toBe(true);
    expect(meta.smsThreadKey).toBe(THREAD_KEY);
    expect(meta.senderIdentity).toBe('9415550123');
  });

  test('a closed PLACEHOLDER plus a new placeholder also gets a fresh row', async () => {
    mockRow = bellRow({}, { done_at: CLOSED });
    await notify(placeholderCall());
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpdates).toHaveLength(0);
  });

  test('an OPEN bell plus a placeholder still stands: no insert, no update', async () => {
    for (const meta of [{ placeholder: false }, {}]) {
      mockRow = bellRow(meta);
      expect(await notify(placeholderCall())).toBe(true);
    }
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
  });

  test('an outcome against a closed placeholder still stands', async () => {
    mockRow = bellRow({}, { done_at: CLOSED });
    expect(await notify(outcomeCall())).toBe(true);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockUpdates).toHaveLength(0);
  });
});

describe('the placeholder rewrite is conditional in the UPDATE itself', () => {
  const rawSql = (wheres) => wheres.filter((w) => w.m === 'whereRaw').map((w) => w.args[0]).join(' | ');

  test('the placeholder-gives-way UPDATE requires: still open, still a placeholder, still no estimate', async () => {
    mockRow = bellRow();
    await notify(outcomeCall());
    expect(mockUpdates).toHaveLength(1);
    const sql = rawSql(mockUpdateWheres[0]);
    expect(sql).toMatch(/done_at IS NULL/);
    expect(sql).toMatch(/metadata->>'placeholder' = 'true'/);
    expect(sql).toMatch(/COALESCE\(metadata->>'estimateId', ''\) = ''/);
    expect(mockUpdateWheres[0].some((w) => w.m === 'where' && w.args[0]?.id === 'bell-1')).toBe(true);
  });

  test('0 rows updated (a person closed it, or a draft landed): returns true, no fresh insert, nothing further written', async () => {
    mockRow = bellRow();
    mockAffectedRows = 0;
    expect(await notify(outcomeCall())).toBe(true);
    expect(mockUpdates).toHaveLength(1);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('the draft upgrade path stays unconditional, exactly as on main', async () => {
    mockRow = bellRow();
    await notify(outcomeCall({ estimateId: 'est-5', link: undefined }));
    expect(mockUpdates).toHaveLength(1);
    expect(rawSql(mockUpdateWheres[0])).not.toMatch(/placeholder/);
  });

  test('a forceUpdate rewrite stays unconditional', async () => {
    mockRow = bellRow({ placeholder: false });
    await notify(outcomeCall({ forceUpdate: true }));
    expect(mockUpdates).toHaveLength(1);
    expect(rawSql(mockUpdateWheres[0])).not.toMatch(/placeholder/);
  });
});

describe('notify() call origin is unchanged', () => {
  const CALL = { twilio_call_sid: 'CA-thread-test-1' };

  test('a prior estimator bell with no estimate stands for a no-estimate outcome (no update)', async () => {
    mockRow = bellRow({ callSid: 'CA-thread-test-1', smsThreadKey: undefined, placeholder: undefined });
    expect(await notify({
      call: CALL, context: null, lane: 'red', quotePromised: true, title: 'Quote promised on call — send it', body: 'x',
    })).toBe(true);
    expect(mockUpdates).toHaveLength(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a call bell never carries a placeholder marker and keeps the historical default link', async () => {
    await notify({
      call: CALL, context: null, lane: 'red', quotePromised: true, title: 'Quote promised on call — send it', body: 'x',
    });
    const [, , , opts] = mockNotifyAdmin.mock.calls[0];
    expect(opts.link).toBe('/admin/communications');
    expect(opts.metadata).not.toHaveProperty('placeholder');
  });
});

describe('thread link helpers', () => {
  test('threadBellLink is the sender link for a thread origin, null for call origin or unset', () => {
    expect(_private.threadBellLink({ threadKey: THREAD_KEY, bellLink: SENDER_LINK })).toBe(SENDER_LINK);
    expect(_private.threadBellLink({ threadKey: THREAD_KEY })).toBeNull();
    expect(_private.threadBellLink(_private.CALL_ORIGIN)).toBeNull();
  });

  test('blockedThreadLink ignores the estimate for call origin and falls back to the sender link without one', () => {
    const draft = { duplicateBlock: { existingEstimateId: 'est-1' } };
    expect(_private.blockedThreadLink(_private.CALL_ORIGIN, draft)).toBeNull();
    expect(_private.blockedThreadLink({ threadKey: THREAD_KEY, bellLink: SENDER_LINK }, { duplicateBlock: {} })).toBe(SENDER_LINK);
  });
});
