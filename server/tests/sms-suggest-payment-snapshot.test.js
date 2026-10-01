/**
 * publishSuggestion persists the drafter's payment_status_snapshot on the review card's input_snapshot (PR #5331), where every
 * send seam (agent-decision-send-checks, the scheduler's fire-time recheck) reads it back.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const inserts = [];
  const chainFor = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'leftJoin', 'select', 'orderBy', 'limit', 'update', 'forUpdate', 'modify', 'groupBy', 'andWhere', 'orWhere']) q[m] = jest.fn(() => q);
    // only publishSuggestion's own inbound read gets a row; every guard query (newer inbound, live answer, ...) finds nothing
    q.first = jest.fn(async (...cols) => (table === 'sms_log' && cols.includes('created_at') && cols.includes('from_phone') ? { created_at: new Date('2026-09-30T12:00:00Z'), from_phone: '+19415550100' } : null));
    q.insert = jest.fn((row) => { inserts.push({ table, row }); return q; });
    q.returning = jest.fn(async () => [{ id: 'decision-1' }]);
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  };
  const trx = jest.fn((table) => chainFor(table));
  trx.raw = jest.fn(async () => ({ rows: [] }));
  const db = jest.fn((table) => chainFor(table));
  db.raw = trx.raw;
  db.transaction = jest.fn(async (work) => work(trx));
  db.__inserts = inserts;
  return db;
});

const db = require('../models/db');
const { publishSuggestion } = require('../services/sms-suggest-mode');

const base = {
  draftId: 'draft-1', customerId: 'cust-1', smsLogId: 'sms-1', inboundMessage: 'Did you get my payment?', reply: 'Your account has no balance due.',
  intent: 'general_customer_sms_needs_review', confidence: 0.9, model: 'm', promptVersion: 'house_voice_v12_real_answers5_cfl_p', lintFailures: [],
};
const lastSnapshot = () => JSON.parse(db.__inserts.filter((i) => i.table === 'agent_decisions').pop().row.input_snapshot);

beforeEach(() => { db.__inserts.length = 0; });

test('the copied sentences ride the card\'s input_snapshot', async () => {
  const snap = { customer_id: 'cust-1', sentences: ['Your account has no balance due.'] };
  await publishSuggestion({ ...base, paymentStatusSnapshot: snap });
  expect(lastSnapshot().payment_status_snapshot).toEqual(snap);
});

test('a card that copied no sentence carries none', async () => {
  await publishSuggestion({ ...base, paymentStatusSnapshot: null });
  expect(lastSnapshot()).not.toHaveProperty('payment_status_snapshot');
});
