// Owner report 2026-10-22: a customer who confirms they got the item, or a
// person's text that says it was sent, settles a text follow-up. This file
// holds the grounding rules that need no database; the end-to-end close and
// the one-alert-per-text rule run in sms-commitments-postgres.test.js.
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { groundThreadVerdict, threadFingerprint, BASIS } = require('../services/sms-commitment-thread-close');
const { keptLate, sourceAlertVerdict } = require('../services/sms-operational-actions');
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

  test('turning GATE_SMS_FOLLOWUP_WITNESS_FIX on changes the record-check hash; off keeps today\'s hash', () => {
    const evidence = { records: [], failures: [] };
    const saved = process.env.GATE_SMS_FOLLOWUP_WITNESS_FIX;
    try {
      delete process.env.GATE_SMS_FOLLOWUP_WITNESS_FIX;
      const off = fulfillmentFingerprint(commitment, evidence).evidenceHash;
      process.env.GATE_SMS_FOLLOWUP_WITNESS_FIX = 'true';
      const on = fulfillmentFingerprint(commitment, evidence).evidenceHash;
      expect(on).not.toBe(off);
      process.env.GATE_SMS_FOLLOWUP_WITNESS_FIX = 'false';
      expect(fulfillmentFingerprint(commitment, evidence).evidenceHash).toBe(off);
    } finally {
      if (saved === undefined) delete process.env.GATE_SMS_FOLLOWUP_WITNESS_FIX;
      else process.env.GATE_SMS_FOLLOWUP_WITNESS_FIX = saved;
    }
  });

  test('a close from the thread is never a "kept late" ring', () => {
    const late = { verdict: 'fulfilled', matched_at: '2026-10-21T13:00:00Z' };
    expect(keptLate(commitment, late)).toBe(true);
    expect(keptLate(commitment, { ...late, basis: BASIS })).toBe(false);
  });
});

describe('sourceAlertVerdict: one state for the whole source text (uncertain > kept late > open)', () => {
  const due = '2026-10-20T12:00:00Z';
  const promise = (id, check) => ({ id, due_at: due, sms_context: { basis: 'promise', ...(check ? { fulfillment_check: check } : {}) } });
  const rows = {
    uncertain: promise('u', { verdict: 'uncertain' }),
    late: promise('l', { verdict: 'fulfilled', matched_at: '2026-10-20T15:00:00Z' }),
    open: promise('o', { verdict: 'open' }),
  };
  const current = { uncertain: { verdict: 'uncertain' }, late: { verdict: 'fulfilled', late: true }, open: { verdict: 'open' } };
  const stateOf = (v) => (v.late ? 'late' : v.verdict);
  const rank = { open: 0, late: 1, uncertain: 2 };

  test.each(['uncertain', 'late', 'open'].flatMap((a) => ['uncertain', 'late', 'open'].map((b) => [a, b])))(
    'scanning a %s row beside a stored %s row gives the stronger state, whichever is scanned',
    (scanned, other) => {
      const expected = rank[scanned] >= rank[other] ? scanned : other;
      const promises = [{ ...rows[scanned], id: 'scanned' }, { ...rows[other], id: 'other' }];
      expect(stateOf(sourceAlertVerdict(current[scanned], promises, 'scanned'))).toBe(expected);
      // Swapped scan order: same answer.
      const swapped = [{ ...rows[other], id: 'scanned' }, { ...rows[scanned], id: 'other' }];
      expect(stateOf(sourceAlertVerdict(current[other], swapped, 'scanned'))).toBe(expected);
    });

  test('the refresh path (no scanned row) reads only the stored states', () => {
    expect(stateOf(sourceAlertVerdict({ verdict: 'open' }, [rows.late]))).toBe('late');
    expect(stateOf(sourceAlertVerdict({ verdict: 'open' }, [rows.late, rows.uncertain]))).toBe('uncertain');
    expect(stateOf(sourceAlertVerdict({ verdict: 'open' }, [rows.open]))).toBe('open');
  });
});

// Codex r6 (#6415): the thread check calls the fast tier, so it reports under
// its own fastStructured lane, not the highStakes record-check lane.
describe('the thread check has its own model lane', () => {
  const read = (rel) => require('fs').readFileSync(require('path').join(__dirname, '..', rel), 'utf8');

  test('the call names its own lane, and the switchboard and lane policies register it', () => {
    expect(read('services/sms-commitment-thread-close.js')).toMatch(/laneId: 'sms-commitment-thread-close'/);
    const board = read('services/model-switchboard.js');
    expect(board).toMatch(/L\('sms-commitment-thread-close', [^\n]*'sms-commitment-thread-close\.js', 'fastText', P\('fastStructured', 'primary'\), P\('fastStructured', 'fallback'\)/);
    expect(board).toMatch(/L\('sms-commitment-fulfillment', [^\n]*P\('highStakes', 'primary'\), P\('highStakes', 'fallback'\)/);
    expect(board).toMatch(/'sms-commitment-thread-close': 'sms',/);
    const { LANE_RUNTIME } = require('../services/agent-control/lane-policies');
    expect(LANE_RUNTIME['sms-commitment-thread-close']).toMatchObject({ side_effect_class: 'internal_write', ledger: 'call' });
    // No job of its own: it runs inside SMS intake and the fulfillment revalidation.
    expect(LANE_RUNTIME['sms-commitment-thread-close'].workflow_id).toBeUndefined();
  });
});
