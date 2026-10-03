'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Drafts = require('../services/review-ask-drafts');

const ARGS = {
  customer: { id: 'cust-1' }, sequenceId: 'seq-1', sequenceStep: 1, channel: 'sms',
  techName: 'Adam', serviceType: 'Pest Control', serviceDate: new Date('2026-10-01T14:00:00Z'),
};

function insertDb() {
  const inserts = [];
  const database = jest.fn(() => ({ insert: async (row) => { inserts.push(row); return [1]; } }));
  return { database, inserts };
}

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

  test('a failed write is logged, never thrown (the send never waits on it)', async () => {
    const database = jest.fn(() => ({ insert: async () => { throw new Error('db down'); } }));
    await expect(Drafts.recordDraft(ARGS, { outcome: 'fallback', reason: 'x' }, database)).resolves.toBeUndefined();
    expect(require('../services/logger').warn).toHaveBeenCalled();
  });
});

describe('listRecent', () => {
  function readDb(tables) {
    const calls = [];
    const database = jest.fn((table) => {
      const name = String(table).split(' ')[0];
      const q = {};
      for (const m of ['leftJoin', 'where', 'whereIn', 'whereRaw', 'orWhereNotNull', 'whereNotNull', 'orderBy', 'limit']) {
        q[m] = (...args) => { calls.push([name, m, ...args]); if (typeof args[0] === 'function') args[0](q); return q; };
      }
      q.select = async () => tables[name] || [];
      return q;
    });
    return { database, calls };
  }

  test('maps drafts with whether their touch was sent, and the cadences held or dropped for payment', async () => {
    const { database, calls } = readDb({
      review_ask_drafts: [{
        id: 7, customer_id: 'cust-1', first_name: 'Marta', last_name: 'R', sequence_id: 'seq-1', sequence_step: 1, channel: 'sms',
        outcome: 'drafted', reason: null, body: 'Hi', evidence: { sentences: [{ sentence: 'Hi.', quotes: [], ask_only: false, greeting_only: true }] },
        technician_name: 'Adam', service_type: 'Pest', service_date: '2026-10-01', created_at: new Date('2026-10-02T15:00:00Z'),
      }],
      review_requests: [{ sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', sms_sent_at: new Date('2026-10-02T15:05:00Z'), sent_at: null }],
      review_sequences: [{
        id: 'seq-2', customer_id: 'cust-2', first_name: 'Lee', last_name: null, status: 'active', current_step: 1, updated_at: new Date(),
        decision: { reason: 'payment_hold', nextEvalAt: '2026-10-03T14:00:00Z', detail: { hold: 'overdue_invoice', heldSince: '2026-10-02T14:00:00Z' } },
      }],
    });
    const out = await Drafts.listRecent({ days: '500', database });
    expect(out.days).toBe(Drafts.MAX_DAYS);
    expect(out.drafts[0]).toMatchObject({
      id: 7, customerName: 'Marta R', step: 1, outcome: 'drafted', technicianName: 'Adam', serviceDate: '2026-10-01',
      sentences: [{ sentence: 'Hi.', greeting_only: true }], sentAt: new Date('2026-10-02T15:05:00Z'),
    });
    expect(out.paymentHolds[0]).toMatchObject({ sequenceId: 'seq-2', customerName: 'Lee', reason: 'payment_hold', detail: { hold: 'overdue_invoice' } });
    expect(calls).toContainEqual(['review_sequences', 'whereRaw', "s.decision->>'reason' = ANY(?)", [['payment_hold', 'ask_dropped_payment_hold']]]);
  });
});
