// The model-judged close of Waves "other" call promises (PROMISE_CONTACT_CHECK,
// owner ruling 2026-09-29): the kill switch, what may ground a "fulfilled"
// verdict, and that the tick is inert unless every gate is live. The provider
// is mocked at dispatchWithFallback; the witness loaders, the close and the
// re-judge run against Postgres in call-commitment-contact-check-db.test.js.
// Fixtures fictitious.
process.env.GATE_CALL_COMMITMENTS = 'true';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { dispatchWithFallback } = require('../services/llm/call');
const { promiseContactCheckLive, promiseEvidenceCloseLive } = require('../config/feature-gates');
const check = require('../services/call-commitment-contact-check');

const ID = '11111111-1111-4111-8111-111111111111';
const evidenceOf = (over = {}) => ({
  records: [
    { ref: `sms:${ID}`, type: 'sms', id: ID, at: '2026-09-01T15:00:00.000Z', text: 'Good news: your warranty covers the retreatment, we will schedule it.' },
    { ref: 'call:22222222-2222-4222-8222-222222222222', type: 'call', id: '22222222-2222-4222-8222-222222222222', at: '2026-09-02T15:00:00.000Z',
      text: 'Agent: Hi, calling back about the gate code.\nCustomer: Thanks!' },
  ],
  failures: [],
  ...over,
});

describe('PROMISE_CONTACT_CHECK switch', () => {
  const original = process.env.PROMISE_CONTACT_CHECK;
  afterEach(() => { if (original === undefined) delete process.env.PROMISE_CONTACT_CHECK; else process.env.PROMISE_CONTACT_CHECK = original; });

  test.each([
    [undefined, true], ['', true], ['on', true], ['true', true], ['1', true], ['anything', true],
    ['off', false], ['OFF', false], [' Off ', false], ['false', false], ['FALSE', false], ['0', false],
  ])('%p reads as live=%p — default on, off only for off / false / 0', (value, live) => {
    if (value === undefined) delete process.env.PROMISE_CONTACT_CHECK; else process.env.PROMISE_CONTACT_CHECK = value;
    expect(promiseContactCheckLive()).toBe(live);
  });
});

describe('the tick is inert unless every gate is live', () => {
  const gates = require('../config/feature-gates').gates;
  const saved = { close: process.env.PROMISE_EVIDENCE_CLOSE, check: process.env.PROMISE_CONTACT_CHECK, ledger: gates.callCommitments };
  const conn = () => { throw new Error('the database must not be touched'); };
  afterEach(() => {
    if (saved.close === undefined) delete process.env.PROMISE_EVIDENCE_CLOSE; else process.env.PROMISE_EVIDENCE_CLOSE = saved.close;
    if (saved.check === undefined) delete process.env.PROMISE_CONTACT_CHECK; else process.env.PROMISE_CONTACT_CHECK = saved.check;
    gates.callCommitments = saved.ledger;
    dispatchWithFallback.mockReset();
  });

  test.each([
    ['the kill switch is off', () => { process.env.PROMISE_CONTACT_CHECK = 'off'; }],
    ['PROMISE_EVIDENCE_CLOSE is off', () => { process.env.PROMISE_EVIDENCE_CLOSE = 'off'; }],
    ['GATE_CALL_COMMITMENTS is off', () => { gates.callCommitments = false; }],
  ])('%s: nothing is read, nothing is asked', async (_name, turnOff) => {
    turnOff();
    expect(await check.runPromiseContactCheck({ conn })).toEqual({ skipped: true, reason: 'gated_off' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a run in which every candidate check threw is a failed run for job health', async () => {
    delete process.env.PROMISE_CONTACT_CHECK; delete process.env.PROMISE_EVIDENCE_CLOSE; gates.callCommitments = true;
    // Candidates read fine; every later read fails (a malformed row, a broken query).
    const candidate = (id) => ({ id, call_log_id: `call-${id}`, party: 'waves', kind: 'other', description: 'Check the warranty', evidence: [],
      due_at: null, due_type: null, updated_at: new Date(), call_customer_id: 'cust-1', call_created_at: new Date(Date.now() - 86400000),
      call_duration_seconds: 60, call_direction: 'inbound', call_metadata: {}, cursor_at: new Date().toISOString() });
    const broken = (table) => {
      const chain = new Proxy({}, { get: (_t, prop) => (prop === 'then'
        ? (res, rej) => (table === 'call_commitments as cc' ? Promise.resolve([candidate('a'), candidate('b')]) : Promise.reject(new Error('boom'))).then(res, rej)
        : () => chain) });
      return chain;
    };
    broken.raw = (sql) => sql;
    await expect(check.runPromiseContactCheck({ conn: broken })).rejects.toThrow('all 2 candidate check(s) failed');
  });

  test('all three live: the tick starts reading', async () => {
    delete process.env.PROMISE_CONTACT_CHECK; delete process.env.PROMISE_EVIDENCE_CLOSE; gates.callCommitments = true;
    expect(promiseEvidenceCloseLive()).toBe(true);
    await expect(check.runPromiseContactCheck({ conn })).rejects.toThrow('the database must not be touched');
  });
});

describe('groundVerdict: only what the records support can close a promise', () => {
  const fulfilled = (over = {}) => ({ verdict: 'fulfilled', record_ref: `sms:${ID}`, quote: 'your warranty covers the retreatment', ...over });

  test('a quote found in the cited witness grounds a fulfilled verdict, whatever its case or spacing', () => {
    expect(check.groundVerdict(fulfilled({ quote: 'Your  WARRANTY covers the retreatment' }), evidenceOf())).toEqual({
      verdict: 'fulfilled', record_type: 'sms_log', record_id: ID, matched_at: '2026-09-01T15:00:00.000Z', quote: 'Your  WARRANTY covers the retreatment' });
    expect(check.groundVerdict(fulfilled({ record_ref: 'call:22222222-2222-4222-8222-222222222222', quote: 'calling back about the gate code' }), evidenceOf()))
      .toMatchObject({ verdict: 'fulfilled', record_type: 'call_log', record_id: '22222222-2222-4222-8222-222222222222' });
  });

  test.each([
    ['a quote that is not in the witness', fulfilled({ quote: 'we sent the technician out today' }), 'ungrounded_witness'],
    ['a quote from a DIFFERENT record than the one cited', fulfilled({ quote: 'calling back about the gate code' }), 'ungrounded_witness'],
    ['a quote under three characters', fulfilled({ quote: 'ok' }), 'ungrounded_witness'],
    ['a null quote', fulfilled({ quote: null }), 'ungrounded_witness'],
    ['a record ref that was never offered', fulfilled({ record_ref: 'sms:33333333-3333-4333-8333-333333333333' }), 'invalid_witness'],
    ['a null record ref', fulfilled({ record_ref: null }), 'invalid_witness'],
    ['an output that breaks the schema', { verdict: 'yes', record_ref: null, quote: null }, 'invalid_model_output'],
    ['an output with an extra field', { ...fulfilled(), why: 'because' }, 'invalid_model_output'],
    ['a quote carrying a card number', fulfilled({ quote: 'your warranty covers 4111 1111 1111 1111' }), 'sensitive_model_output'],
  ])('%s is uncertain, never fulfilled', (_name, parsed, reason) => {
    expect(check.groundVerdict(parsed, evidenceOf())).toEqual({ verdict: 'uncertain', reason });
  });

  test('open and uncertain verdicts pass through', () => {
    expect(check.groundVerdict({ verdict: 'open', record_ref: null, quote: null }, evidenceOf())).toEqual({ verdict: 'open' });
    expect(check.groundVerdict({ verdict: 'uncertain', record_ref: null, quote: null }, evidenceOf())).toEqual({ verdict: 'uncertain' });
  });

  test('a source that failed or was truncated makes every verdict uncertain, fulfilled included', () => {
    const failed = evidenceOf({ failures: ['sms_truncated'] });
    expect(check.groundVerdict(fulfilled(), failed)).toEqual({ verdict: 'uncertain', reason: 'incomplete_sources', failures: ['sms_truncated'] });
    expect(check.groundVerdict({ verdict: 'open', record_ref: null, quote: null }, failed).verdict).toBe('uncertain');
  });
});

describe('judgeWithModel', () => {
  const obligation = { party: 'waves', kind: 'other', description: 'Check on the warranty and let the caller know' };
  afterEach(() => dispatchWithFallback.mockReset());

  test('asks the fastStructured policy (a verifier code consumes) under its own lane with a hard deadline, offering exactly the loaded witnesses', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${ID}`, quote: 'your warranty covers the retreatment' } });
    const verdict = await check.judgeWithModel(obligation, evidenceOf());
    expect(verdict).toMatchObject({ verdict: 'fulfilled', record_type: 'sms_log', record_id: ID });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(require('../config/models').TEXT_POLICIES.fastStructured);
    expect(payload).toMatchObject({ laneId: 'call-commitment-contact-check', promptVersion: check.VERSION, maxTokens: 2048, timeoutMs: 60000 });
    // Both providers share the one minute, enforced from the chain's side.
    expect(options).toEqual({ reserveFallbackBudget: true, hardDeadline: true });
    expect(payload.jsonSchema.required).toEqual(['verdict', 'record_ref', 'quote']);
    expect(payload.text).toContain(`"witness_refs":["sms:${ID}","call:22222222-2222-4222-8222-222222222222"]`);
    // The promise is judged as one made on a call: delivery, not restating it or a thank-you.
    expect(payload.text).toMatch(/does not deliver it/);
    expect(payload.text).toMatch(/thanks/);
  });

  test.each([
    ['a provider failure', { ok: false, reason: 'openai_timeout' }, 'provider_failed'],
    ['an ungrounded quote', { ok: true, json: { verdict: 'fulfilled', record_ref: `sms:${ID}`, quote: 'a made up sentence' } }, 'ungrounded_witness'],
    ['an unknown ref', { ok: true, json: { verdict: 'fulfilled', record_ref: 'sms:nope', quote: 'your warranty covers the retreatment' } }, 'invalid_witness'],
    ['malformed output', { ok: true, json: { nope: true } }, 'invalid_model_output'],
  ])('%s never closes: uncertain with its reason', async (_name, response, reason) => {
    dispatchWithFallback.mockResolvedValue(response);
    expect(await check.judgeWithModel(obligation, evidenceOf())).toEqual({ verdict: 'uncertain', reason });
  });

  test('open and uncertain answers stand as given', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    expect(await check.judgeWithModel(obligation, evidenceOf())).toEqual({ verdict: 'open' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { verdict: 'uncertain', record_ref: null, quote: null } });
    expect(await check.judgeWithModel(obligation, evidenceOf())).toEqual({ verdict: 'uncertain' });
  });

  test('a source that failed settles the verdict before any provider is asked', async () => {
    const verdict = await check.judgeWithModel(obligation, evidenceOf({ failures: ['call_body_truncated'] }));
    expect(verdict).toMatchObject({ verdict: 'uncertain', reason: 'incomplete_sources' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('one contract with the texting lane, and the lane is registered', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the model call goes through the shared policy and dispatcher with no model id of its own', () => {
    const source = read('services/call-commitment-contact-check.js');
    expect(source).toMatch(/dispatchWithFallback\(MODELS\.TEXT_POLICIES\.fastStructured/);
    expect(source).not.toMatch(/claude-|gpt-|gemini-/i);
    expect(source).toMatch(/require\('\.\/staff-contact'\)/);
    for (const name of ['operatorReply', 'personCallBack', 'smsDelivered']) expect(source).not.toMatch(new RegExp(`(const|function|let|var)\\s+${name}\\b`));
  });

  test('the lane is in the switchboard and the lane policies, like the texting lane', () => {
    const board = read('services/model-switchboard.js');
    // The texting lane stays on highStakes; this verifier runs on the fast tier.
    for (const [lane, policy] of [['sms-commitment-fulfillment', 'highStakes'], ['call-commitment-contact-check', 'fastStructured']]) {
      expect(board).toMatch(new RegExp(`L\\('${lane}',[^\\n]*P\\('${policy}', 'primary'\\), P\\('${policy}', 'fallback'\\)`));
      expect(board).toMatch(new RegExp(`'${lane}': '[a-z]+',`));
      expect(board).toMatch(new RegExp(`'${lane}': '[^']+`));
    }
    const { LANE_RUNTIME } = require('../services/agent-control/lane-policies');
    expect(LANE_RUNTIME['call-commitment-contact-check']).toMatchObject({ side_effect_class: 'internal_write', ledger: 'call', workflow_id: 'call-commitment-contact-check' });
  });

  test('the scheduler runs it on its own lock, every fifteen minutes, behind the three gates', () => {
    const scheduler = read('services/scheduler.js');
    expect(scheduler).toMatch(/cron\.schedule\('0 \*\/15 \* \* \* \*'[\s\S]{0,400}promiseContactCheckLive\(\)[\s\S]{0,200}runExclusive\('call-commitment-contact-check'/);
  });

  test('the re-judge asks the module that owns the deterministic keep check', () => {
    expect(read('services/call-commitments.js')).toMatch(/PERSON_CONTACT_BASIS[\s\S]{0,300}require\("\.\/call-commitment-contact-check"\)\.contactCloseStands/);
  });
});
