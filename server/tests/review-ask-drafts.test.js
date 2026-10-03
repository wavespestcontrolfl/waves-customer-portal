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
      review_requests: [{ sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', custom_body: 'Hi', template_key: 'friendly_ask_tech_voice', created_at: new Date('2026-10-02T15:01:00Z'), sms_sent_at: new Date('2026-10-02T15:05:00Z'), sent_at: null }],
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
    expect(out.paymentHolds[0]).toMatchObject({ sequenceId: 'seq-2', customerName: 'Lee', step: 1, reason: 'payment_hold', detail: { hold: 'overdue_invoice' } });
    expect(calls).toContainEqual(['review_sequences', 'whereRaw', "s.decision->>'reason' = ANY(?)", [['payment_hold', 'ask_dropped_payment_hold']]]);
  });
});

describe('listRecent: whether THIS outcome went out', () => {
  const draftRow = (over) => ({
    customer_id: 'c', sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', evidence: null, created_at: new Date('2026-10-02T15:00:00Z'), ...over,
  });
  const listWith = (drafts, requests) => {
    const database = jest.fn((table) => {
      const name = String(table).split(' ')[0];
      const q = {};
      for (const m of ['leftJoin', 'where', 'whereIn', 'whereRaw', 'orWhereNotNull', 'whereNotNull', 'orderBy', 'limit']) {
        q[m] = (...args) => { if (typeof args[0] === 'function') args[0](q); return q; };
      }
      q.select = async () => ({ review_ask_drafts: drafts, review_requests: requests, review_sequences: [] }[name] || []);
      return q;
    });
    return Drafts.listRecent({ database });
  };

  test('a draft is sent only when the sent request carries its exact text; an earlier draft for the same step is not', async () => {
    const out = await listWith([
      draftRow({ id: 1, outcome: 'drafted', body: 'Monday draft' }),
      draftRow({ id: 2, outcome: 'drafted', body: 'Tuesday draft', created_at: new Date('2026-10-03T15:00:00Z') }),
    ], [{ sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', custom_body: 'Tuesday draft', template_key: 'soft_reminder_tech_voice', created_at: new Date('2026-10-03T15:01:00Z'), sms_sent_at: new Date('2026-10-03T15:02:00Z') }]);
    expect(out.drafts.find((d) => d.id === 1).sentAt).toBeNull();
    expect(out.drafts.find((d) => d.id === 2).sentAt).toEqual(new Date('2026-10-03T15:02:00Z'));
    // a retry that drafts the same words as an EARLIER sent request is not sent by that older request
    const again = await listWith(
      [draftRow({ id: 6, outcome: 'drafted', body: 'Same words', created_at: new Date('2026-10-04T15:00:00Z') })],
      [{ sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', custom_body: 'Same words', template_key: 'soft_reminder_tech_voice', created_at: new Date('2026-10-03T15:01:00Z'), sms_sent_at: new Date('2026-10-03T15:02:00Z') }],
    );
    expect(again.drafts[0].sentAt).toBeNull();
  });

  test('a fallback is sent once a fixed-text request of its step goes out after it; a held repeat never is', async () => {
    const requests = [{ sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', custom_body: null, template_key: 'soft_reminder', created_at: new Date('2026-10-02T15:01:00Z'), sms_sent_at: new Date('2026-10-02T15:03:00Z') }];
    const out = await listWith([
      draftRow({ id: 3, outcome: 'fallback', reason: 'fact_check_unavailable', body: null }),
      draftRow({ id: 4, outcome: 'held', reason: 'repeat', body: 'How are the ants?' }),
    ], requests);
    expect(out.drafts.find((d) => d.id === 3).sentAt).toEqual(new Date('2026-10-02T15:03:00Z'));
    expect(out.drafts.find((d) => d.id === 4).sentAt).toBeNull();
    expect((await listWith([draftRow({ id: 5, outcome: 'fallback', reason: 'x' })], [])).drafts[0].sentAt).toBeNull();
    // a first fallback whose request never sent is not credited with the retry's send
    const retried = await listWith([
      draftRow({ id: 7, outcome: 'fallback', reason: 'out_of_time' }),
      draftRow({ id: 8, outcome: 'fallback', reason: 'out_of_time', created_at: new Date('2026-10-02T15:30:00Z') }),
    ], [{ sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', custom_body: null, template_key: 'soft_reminder', created_at: new Date('2026-10-02T15:31:00Z'), sms_sent_at: new Date('2026-10-02T15:32:00Z') }]);
    expect(retried.drafts.find((d) => d.id === 7).sentAt).toBeNull();
    expect(retried.drafts.find((d) => d.id === 8).sentAt).toEqual(new Date('2026-10-02T15:32:00Z'));
    // a later PERSONALIZED request (the switch turned off meanwhile) is not the fixed text going out
    const personalized = await listWith([draftRow({ id: 9, outcome: 'fallback', reason: 'out_of_time' })],
      [{ sequence_id: 'seq-1', sequence_step: 1, channel: 'sms', custom_body: 'A personalized ask', template_key: 'soft_reminder_personalized', created_at: new Date('2026-10-02T15:31:00Z'), sms_sent_at: new Date('2026-10-02T15:32:00Z') }]);
    expect(personalized.drafts[0].sentAt).toBeNull();
  });
});

test('a dropped payment hold names the step it held, not the step the cadence moved on to', async () => {
  const database = jest.fn((table) => {
    const name = String(table).split(' ')[0];
    const q = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereRaw', 'orWhereNotNull', 'whereNotNull', 'orderBy', 'limit']) q[m] = () => q;
    q.select = async () => (name === 'review_sequences'
      ? [
        { id: 's-1', customer_id: 'c', status: 'completed', current_step: 1, plan: JSON.stringify([{ day: 0, channel: 'sms' }]), updated_at: new Date(), decision: { reason: 'ask_dropped_payment_hold', detail: { step: 0, hold: 'overdue_invoice' } } },
        { id: 's-3', customer_id: 'c', status: 'completed', current_step: 3, plan: [], updated_at: new Date(), decision: { reason: 'payment_hold', detail: { step: 2, hold: 'overdue_invoice' } } },
        { id: 's-2', customer_id: 'c', status: 'active', current_step: 2, plan: [{ day: 0, channel: 'sms' }, { day: 4, channel: 'sms' }, { day: 7, channel: 'email' }], updated_at: new Date(), decision: { reason: 'payment_hold', detail: { step: 2, hold: 'overdue_invoice' } } },
      ]
      : []);
    return q;
  });
  const holds = (await Drafts.listRecent({ database })).paymentHolds;
  expect(holds[0]).toMatchObject({ step: 0, channel: 'sms', reason: 'ask_dropped_payment_hold' });
  // an email step held for payment is labelled an email
  expect(holds[1]).toMatchObject({ step: 2, channel: 'email' });
  // a completed cadence still carrying an old payment_hold decision is not waiting
  expect(holds.map((h) => h.sequenceId)).toEqual(['s-1', 's-2']);
});
