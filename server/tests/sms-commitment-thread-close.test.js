// Owner report 2026-10-22: a customer who confirms they got the item, or a
// person's text that says it was sent, settles a text follow-up. This file
// holds the grounding rules that need no database; the end-to-end close and
// the one-alert-per-text rule run in sms-commitments-postgres.test.js.
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { groundThreadVerdict, threadFingerprint, BASIS } = require('../services/sms-commitment-thread-close');
const { keptLate } = require('../services/sms-operational-actions');
const { fulfillmentFingerprint } = require('../services/sms-commitment-fulfillment');

const customerText = { ref: 'sms:in-1', id: 'in-1', who: 'customer', created_at: '2026-10-21T13:00:00Z', text: 'Got the report! Thanks for your help!' };
const staffText = { ref: 'sms:out-1', id: 'out-1', who: 'waves_staff', created_at: '2026-10-20T13:00:00Z', text: 'We sent it out this morning to the email on file' };
const records = [staffText, customerText];

describe('groundThreadVerdict', () => {
  test('a customer confirmation with an exact quote closes, and the note names the message', () => {
    const verdict = groundThreadVerdict({ verdict: 'completed', record_ref: 'sms:in-1', quote: 'got the report!' }, records);
    expect(verdict).toMatchObject({ verdict: 'fulfilled', basis: BASIS, record_type: 'sms', record_id: 'in-1', witness: 'customer' });
    expect(verdict.note).toContain('in-1');
  });

  test('a staff text that says it was sent closes', () => {
    expect(groundThreadVerdict({ verdict: 'completed', record_ref: 'sms:out-1', quote: 'We sent it out this morning' }, records))
      .toMatchObject({ verdict: 'fulfilled', witness: 'waves_staff', record_id: 'out-1' });
  });

  test.each([
    ['a quote the text does not contain', { verdict: 'completed', record_ref: 'sms:in-1', quote: 'I received the invoice' }],
    ['a record that is not in the thread', { verdict: 'completed', record_ref: 'sms:other', quote: 'Got the report' }],
    ['a quote that is too short', { verdict: 'completed', record_ref: 'sms:in-1', quote: 'ok' }],
    ['no quote', { verdict: 'completed', record_ref: 'sms:in-1', quote: null }],
  ])('%s never closes', (_name, parsed) => {
    expect(groundThreadVerdict(parsed, records)).toMatchObject({ verdict: 'uncertain' });
  });

  test('not_completed and uncertain keep the follow-up open', () => {
    expect(groundThreadVerdict({ verdict: 'not_completed', record_ref: null, quote: null }, records)).toEqual({ verdict: 'open' });
    expect(groundThreadVerdict({ verdict: 'uncertain', record_ref: null, quote: null }, records)).toMatchObject({ verdict: 'uncertain' });
  });

  test('a grounded customer complaint is a contradiction; staff text or a made-up quote is not', () => {
    const denial = { ref: 'sms:in-2', id: 'in-2', who: 'customer', created_at: '2026-10-22T13:00:00Z', text: 'I never got it' };
    expect(groundThreadVerdict({ verdict: 'contradicted', record_ref: 'sms:in-2', quote: 'never got it' }, [...records, denial]))
      .toMatchObject({ verdict: 'open', contradicted: true, record_id: 'in-2' });
    expect(groundThreadVerdict({ verdict: 'contradicted', record_ref: 'sms:out-1', quote: 'We sent it out' }, records)).toEqual({ verdict: 'open' });
    expect(groundThreadVerdict({ verdict: 'contradicted', record_ref: 'sms:in-2', quote: 'where is it' }, [...records, denial])).toEqual({ verdict: 'open' });
  });

  test('output that breaks the schema is uncertain, not a close', () => {
    expect(groundThreadVerdict({ verdict: 'fulfilled', record_ref: 'sms:in-1', quote: 'Got the report' }, records))
      .toMatchObject({ verdict: 'uncertain', reason: 'invalid_model_output' });
  });
});

describe('thread close bookkeeping', () => {
  const commitment = { kind: 'send_report', party: 'waves', description: 'send the service report', evidence: [{ quote: 'send the report' }],
    due_at: '2026-10-20T13:00:00Z', sms_context: { basis: 'promise', source_at: '2026-10-19T13:00:00Z' } };

  test('a new text changes the hash, so an old verdict is not reused', () => {
    const a = threadFingerprint(commitment, [staffText]).evidenceHash;
    expect(threadFingerprint(commitment, [staffText]).evidenceHash).toBe(a);
    expect(threadFingerprint(commitment, records).evidenceHash).not.toBe(a);
  });

  test('the stored thread verdict does not change the record-check hash (no extra model calls)', () => {
    const evidence = { records: [], failures: [] };
    const plain = fulfillmentFingerprint(commitment, evidence).evidenceHash;
    const withThread = fulfillmentFingerprint({ ...commitment, sms_context: { ...commitment.sms_context, thread_check: { verdict: 'open' } } }, evidence).evidenceHash;
    expect(withThread).toBe(plain);
  });

  test('a close from the thread is never a "kept late" ring', () => {
    const late = { verdict: 'fulfilled', matched_at: '2026-10-21T13:00:00Z' };
    expect(keptLate(commitment, late)).toBe(true);
    expect(keptLate(commitment, { ...late, basis: BASIS })).toBe(false);
  });
});
