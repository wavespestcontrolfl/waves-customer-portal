'use strict';

const mockEvidence = jest.fn(async () => null);

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/review-request', () => ({ reviewAskDeliveryEvidence: (...a) => mockEvidence(...a) }));

const Drafts = require('../services/review-ask-drafts');
const logger = require('../services/logger');

const ARGS = {
  customer: { id: 'cust-1' }, sequenceId: 'seq-1', sequenceStep: 1, channel: 'sms',
  techName: 'Adam', serviceType: 'Pest Control', serviceDate: new Date('2026-10-01T14:00:00Z'),
};

function insertDb() {
  const inserts = [];
  const database = jest.fn(() => ({ insert: async (row) => { inserts.push(row); return [1]; } }));
  return { database, inserts };
}

beforeEach(() => {
  mockEvidence.mockReset().mockResolvedValue(null);
  logger.warn.mockClear();
});

describe('recordDraft', () => {
  test('a drafted touch keeps its text and the record lines cited per sentence', async () => {
    const { database, inserts } = insertDb();
    const sentences = [{ sentence: 'I flagged moisture under the sink.', quotes: ['Moisture under the sink'], ask_only: false, greeting_only: false }];
    await Drafts.recordDraft(ARGS, { outcome: 'drafted', body: 'Hi {review_url}', sentences }, database);
    expect(database).toHaveBeenCalledWith('review_ask_drafts');
    expect(inserts[0]).toMatchObject({
      customer_id: 'cust-1', sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', outcome: 'drafted', reason: null,
      body: 'Hi {review_url}', technician_name: 'Adam', service_type: 'Pest Control', service_date: '2026-10-01',
    });
    expect(JSON.parse(inserts[0].evidence)).toEqual({ sentences });
  });

  test('a held repeat records the earlier quote; a fallback records only its reason', async () => {
    const { database, inserts } = insertDb();
    const repeat = { sentence: 'How are the ants?', earlierQuote: 'How are the ants doing', earlierStep: 0 };
    await Drafts.recordDraft(ARGS, { outcome: 'held', body: 'How are the ants? {review_url}', repeat, sentences: [] }, database);
    expect(inserts[0]).toMatchObject({ outcome: 'held', reason: 'repeat' });
    expect(JSON.parse(inserts[0].evidence).repeat).toEqual(repeat);
    await Drafts.recordDraft(ARGS, { outcome: 'fallback', reason: 'fact_check_unavailable' }, database);
    expect(inserts[1]).toMatchObject({ outcome: 'fallback', reason: 'fact_check_unavailable', body: null, evidence: null });
  });

  test('a failed write is logged without the error message (it can carry the insert\'s values), never thrown', async () => {
    const database = jest.fn(() => ({ insert: async () => { throw Object.assign(new Error('insert into review_ask_drafts values (the customer said ...)'), { code: '42P01' }); } }));
    await expect(Drafts.recordDraft(ARGS, { outcome: 'fallback', reason: 'x' }, database)).resolves.toBeUndefined();
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain('code=42P01');
    expect(line).not.toContain('the customer said');
  });
});

describe('recordPaymentDrop', () => {
  test('a dropped payment hold is kept as a held row for its own step and channel (the sequence decision is overwritten by the next step)', async () => {
    const { database, inserts } = insertDb();
    const seq = { id: 'seq-9', customer_id: 'cust-9', current_step: 3, service_type: 'Lawn', plan: JSON.stringify([{ day: 0, channel: 'sms' }, { day: 4, channel: 'sms' }, { day: 7, channel: 'email' }]) };
    await Drafts.recordPaymentDrop(seq, { step: 2, hold: 'overdue_invoice', heldSince: '2026-10-01T14:00:00.000Z' }, database);
    expect(inserts[0]).toMatchObject({ customer_id: 'cust-9', sequence_id: 'seq-9', sequence_step: 2, channel: 'email', outcome: 'held', reason: 'payment_hold_dropped', body: null });
    expect(JSON.parse(inserts[0].evidence)).toEqual({ hold: { step: 2, hold: 'overdue_invoice', heldSince: '2026-10-01T14:00:00.000Z' } });
    const failing = jest.fn(() => ({ insert: async () => { throw new Error('down'); } }));
    await expect(Drafts.recordPaymentDrop(seq, { step: 2 }, failing)).resolves.toBeUndefined();
  });
});

// A read double: each table answers its rows; calls are kept for assertions.
function readDb(tables) {
  const calls = [];
  const database = jest.fn((table) => {
    const name = String(table).split(' ')[0];
    const q = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereRaw', 'orderBy', 'limit']) {
      q[m] = (...args) => { calls.push([name, m, ...args]); return q; };
    }
    q.select = async () => tables[name] || [];
    return q;
  });
  return { database, calls };
}
const draftRow = (over) => ({
  customer_id: 'c', sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', evidence: null, created_at: new Date('2026-10-02T15:00:00Z'), ...over,
});
const request = (over) => ({
  id: 'rr-1', customer_id: 'c', sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', custom_body: null,
  created_at: new Date('2026-10-02T15:01:00Z'), sms_sent_at: null, sent_at: null, ...over,
});
const listWith = (drafts, requests, sequences = []) => Drafts.listRecent({
  database: readDb({ review_ask_drafts: drafts, review_requests: requests, review_sequences: sequences }).database,
});

describe('listRecent', () => {
  test('maps a draft with its evidence and the cadences waiting on a payment hold (active ones only, by the query)', async () => {
    const { database, calls } = readDb({
      review_ask_drafts: [draftRow({
        id: 7, customer_id: 'cust-1', first_name: 'Marta', last_name: 'R', outcome: 'drafted', body: 'Hi',
        evidence: { sentences: [{ sentence: 'Hi.', quotes: [], ask_only: false, greeting_only: true }] },
        technician_name: 'Adam', service_type: 'Pest', service_date: '2026-10-01',
      })],
      review_requests: [request({ custom_body: 'Hi', sms_sent_at: new Date('2026-10-02T15:05:00Z') })],
      review_sequences: [{
        id: 'seq-2', customer_id: 'cust-2', first_name: 'Lee', last_name: null, current_step: 2, updated_at: new Date(),
        plan: [{ day: 0, channel: 'sms' }, { day: 4, channel: 'sms' }, { day: 7, channel: 'email' }],
        decision: { reason: 'payment_hold', nextEvalAt: '2026-10-03T14:00:00Z', detail: { step: 2, hold: 'overdue_invoice', heldSince: '2026-10-02T14:00:00Z' } },
      }],
    });
    const out = await Drafts.listRecent({ days: '500', database });
    expect(out.days).toBe(Drafts.MAX_DAYS);
    expect(out.truncated).toBe(false);
    expect(out.drafts[0]).toMatchObject({
      id: 7, customerName: 'Marta R', step: 1, outcome: 'drafted', technicianName: 'Adam', serviceDate: '2026-10-01',
      sentences: [{ sentence: 'Hi.', greeting_only: true }], sentAt: new Date('2026-10-02T15:05:00Z'),
    });
    // an email step held for payment is labelled an email
    expect(out.paymentHolds[0]).toMatchObject({ sequenceId: 'seq-2', customerName: 'Lee', step: 2, channel: 'email', detail: { hold: 'overdue_invoice' } });
    // only cadences still running wait on a hold (a finished one can keep an old decision)
    expect(calls).toContainEqual(['review_sequences', 'where', 's.status', 'active']);
    expect(calls).toContainEqual(['review_sequences', 'whereRaw', "s.decision->>'reason' = ?", ['payment_hold']]);
  });

  test('a dropped payment hold is a durable row with what it saw; it sends nothing', async () => {
    const out = await listWith([draftRow({ id: 4, outcome: 'held', reason: 'payment_hold_dropped', evidence: { hold: { step: 1, hold: 'overdue_invoice' } } })], [request({ sms_sent_at: new Date() })]);
    expect(out.drafts[0]).toMatchObject({ outcome: 'held', reason: 'payment_hold_dropped', hold: { hold: 'overdue_invoice' }, sentAt: null });
  });

  test('more outcomes than are returned is said so, never passed off as the whole window', async () => {
    const many = Array.from({ length: Drafts.MAX_ROWS + 1 }, (_, i) => draftRow({ id: i, outcome: 'fallback', reason: 'x', sequence_id: `s-${i}` }));
    const out = await listWith(many, []);
    expect(out.truncated).toBe(true);
    expect(out.drafts).toHaveLength(Drafts.MAX_ROWS);
  });
});

describe('listRecent: whether THIS outcome went out', () => {
  test('a draft is sent only by the request carrying its exact text, made after it; an earlier draft of the step is not', async () => {
    const out = await listWith([
      draftRow({ id: 1, outcome: 'drafted', body: 'Monday draft' }),
      draftRow({ id: 2, outcome: 'drafted', body: 'Tuesday draft', created_at: new Date('2026-10-03T15:00:00Z') }),
    ], [request({ custom_body: 'Tuesday draft', created_at: new Date('2026-10-03T15:01:00Z'), sms_sent_at: new Date('2026-10-03T15:02:00Z') })]);
    expect(out.drafts.find((d) => d.id === 1).sentAt).toBeNull();
    expect(out.drafts.find((d) => d.id === 2).sentAt).toEqual(new Date('2026-10-03T15:02:00Z'));
    // a retry that drafts the same words as an EARLIER sent request is not sent by that older request
    const again = await listWith(
      [draftRow({ id: 6, outcome: 'drafted', body: 'Same words', created_at: new Date('2026-10-04T15:00:00Z') })],
      [request({ custom_body: 'Same words', created_at: new Date('2026-10-03T15:01:00Z'), sms_sent_at: new Date('2026-10-03T15:02:00Z') })],
    );
    expect(again.drafts[0].sentAt).toBeNull();
  });

  test('a fallback is sent by the first fixed-text request of its step in its own window; a held repeat never is', async () => {
    const out = await listWith([
      draftRow({ id: 3, outcome: 'fallback', reason: 'fact_check_unavailable' }),
      draftRow({ id: 4, outcome: 'held', reason: 'repeat', body: 'How are the ants?' }),
    ], [request({ sms_sent_at: new Date('2026-10-02T15:03:00Z') })]);
    expect(out.drafts.find((d) => d.id === 3).sentAt).toEqual(new Date('2026-10-02T15:03:00Z'));
    expect(out.drafts.find((d) => d.id === 4).sentAt).toBeNull();
    expect((await listWith([draftRow({ id: 5, outcome: 'fallback', reason: 'x' })], [])).drafts[0].sentAt).toBeNull();
    // a first fallback whose request never sent is not credited with the retry's send
    const retried = await listWith([
      draftRow({ id: 7, outcome: 'fallback', reason: 'out_of_time' }),
      draftRow({ id: 8, outcome: 'fallback', reason: 'out_of_time', created_at: new Date('2026-10-02T15:30:00Z') }),
    ], [request({ created_at: new Date('2026-10-02T15:31:00Z'), sms_sent_at: new Date('2026-10-02T15:32:00Z') })]);
    expect(retried.drafts.find((d) => d.id === 7).sentAt).toBeNull();
    expect(retried.drafts.find((d) => d.id === 8).sentAt).toEqual(new Date('2026-10-02T15:32:00Z'));
    // a later PERSONALIZED request (the switch turned off meanwhile) is not the fixed text going out
    const personalized = await listWith([draftRow({ id: 9, outcome: 'fallback', reason: 'out_of_time' })],
      [request({ custom_body: 'A personalized ask', sms_sent_at: new Date('2026-10-02T15:32:00Z') })]);
    expect(personalized.drafts[0].sentAt).toBeNull();
  });

  test('a text the provider accepted whose stamp write failed is sent by the sender\'s own delivery evidence', async () => {
    mockEvidence.mockResolvedValueOnce({ id: 'sms-1', created_at: new Date('2026-10-02T15:04:00Z') });
    const out = await listWith([draftRow({ id: 10, outcome: 'drafted', body: 'Hi there' })], [request({ id: 'rr-9', customer_id: 'cust-9', custom_body: 'Hi there' })]);
    expect(out.drafts[0].sentAt).toEqual(new Date('2026-10-02T15:04:00Z'));
    expect(mockEvidence).toHaveBeenCalledWith('rr-9', 'cust-9');
    // no evidence and no stamp: not sent
    expect((await listWith([draftRow({ id: 11, outcome: 'drafted', body: 'Hi there' })], [request({ custom_body: 'Hi there' })])).drafts[0].sentAt).toBeNull();
  });
});
