// syncVoiceMessageForCall on a call an operator explicitly UNLINKED: the
// unified voice message leaves the previous customer's thread for the
// caller's unowned thread, so the recording and transcript stop showing in
// that customer's history (codex #3764 gh-r1 P1). A plain NULL link (never
// attributed, or cleared by the processor) is left where it is.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { syncVoiceMessageForCall } = require('../services/conversations');

const SID = 'CA' + '7'.repeat(32);
const callRow = (extra) => ({
  id: 'call-1', twilio_call_sid: SID, customer_id: null, direction: 'inbound', from_phone: '+19415550111', to_phone: '+19415550122',
  transcription: 'fixture', recording_sid: null, recording_url: null, status: 'completed', created_at: new Date('2026-09-01T12:00:00Z'), ...extra,
});

// Chainable recorder; `first()` answers from a per-table queue.
function harness(firsts) {
  const builders = [];
  const make = (table) => {
    const b = { table, calls: [] };
    for (const m of ['where', 'whereNull', 'whereRaw', 'select', 'orderBy', 'limit', 'forUpdate', 'update', 'insert']) {
      b[m] = (...a) => { b.calls.push([m, ...a]); return b; };
    }
    b.first = () => Promise.resolve((firsts[table] || []).shift() ?? null);
    b.returning = () => Promise.resolve([{ id: 'm1', ...(b.calls.find((c) => c[0] === 'update')?.[1] || {}) }]);
    b.then = (res, rej) => Promise.resolve(1).then(res, rej);
    builders.push(b);
    return b;
  };
  db.mockImplementation(make);
  const trx = jest.fn(make);
  trx.raw = jest.fn(async () => ({ rows: [] }));
  db.raw = trx.raw;
  db.transaction = jest.fn(async (fn) => fn(trx));
  return { builders, trx };
}

beforeEach(() => jest.clearAllMocks());

test('an explicit unlink moves the existing message out of the old customer\'s thread into the caller\'s unowned thread', async () => {
  const { builders } = harness({
    call_log: [callRow({ metadata: { customer_link_override: { customer_id: null, previous_customer_id: 'cust-old', by: 'tech-1', at: '2026-09-02T00:00:00Z' } } })],
    messages: [{ id: 'm1', conversation_id: 'conv-old-customer' }, { message_count: 0 }, { message_count: 1 }],
    conversations: [{ id: 'conv-contact', customer_id: null, contact_phone: '+19415550111' }],
  });
  const updated = await syncVoiceMessageForCall(SID);
  expect(updated.conversation_id).toBe('conv-contact');
  // The target is the UNOWNED thread keyed on the caller's number, never a customer thread.
  const lookup = builders.find((b) => b.table === 'conversations' && b.calls.some((c) => c[0] === 'first' || c[0] === 'whereNull'));
  expect(lookup.calls).toEqual(expect.arrayContaining([['whereNull', 'customer_id']]));
  expect(JSON.stringify(lookup.calls)).toContain('+19415550111');
  // Both threads' stats are refreshed (source and target).
  const statWrites = builders.filter((b) => b.table === 'conversations' && b.calls.some((c) => c[0] === 'update'));
  expect(statWrites.map((b) => b.calls.find((c) => c[0] === 'where')[1])).toEqual([{ id: 'conv-old-customer' }, { id: 'conv-contact' }]);
});

test('a plain NULL link (no override) leaves the message where it is', async () => {
  const { builders } = harness({
    call_log: [callRow({ metadata: { source: 'voice_webhook' } })],
    messages: [{ id: 'm1', conversation_id: 'conv-old-customer' }],
  });
  const updated = await syncVoiceMessageForCall(SID);
  expect(updated.conversation_id).toBeUndefined();
  expect(builders.find((b) => b.table === 'conversations')).toBeUndefined();
});

test('a message already in the caller\'s unowned thread is not moved again', async () => {
  const { builders } = harness({
    call_log: [callRow({ metadata: { customer_link_override: { customer_id: null } } })],
    messages: [{ id: 'm1', conversation_id: 'conv-contact' }],
    conversations: [{ id: 'conv-contact', customer_id: null }],
  });
  const updated = await syncVoiceMessageForCall(SID);
  expect(updated.conversation_id).toBeUndefined();
  expect(builders.filter((b) => b.table === 'conversations' && b.calls.some((c) => c[0] === 'update'))).toHaveLength(0);
});
