/**
 * ops/agents/call-promise-ai-close-dryrun.js — the read-only self-check, the
 * model-call cap parser and how a judgment prints. Pure: a mocked `db.raw`, no
 * connection (the live self-check is the same function run against the real
 * pool before the script does anything else).
 */
const { assertReadOnly, describeJudgment, parseLimit } = require('../../ops/agents/call-promise-ai-close-dryrun');

describe('assertReadOnly', () => {
  test('a zero-row write rejected as read-only is the passing case', async () => {
    const db = { raw: jest.fn(async () => { throw new Error('cannot execute UPDATE in a read-only transaction'); }) };
    await expect(assertReadOnly(db)).resolves.toBeUndefined();
    expect(db.raw.mock.calls[0][0]).toMatch(/^UPDATE call_commitments SET id = id WHERE false$/);
  });
  test('a write that succeeds, or fails for another reason, refuses to run', async () => {
    await expect(assertReadOnly({ raw: jest.fn(async () => ({})) })).rejects.toThrow(/READ-ONLY SELF-CHECK FAILED/);
    await expect(assertReadOnly({ raw: jest.fn(async () => { throw new Error('connection refused'); }) })).rejects.toThrow(/refusing to run: connection refused/);
  });
});

test('--limit is a whole number of model calls, 150 when absent', () => {
  expect(parseLimit(null)).toBe(150);
  expect(parseLimit('0')).toBe(0);
  expect(parseLimit('60')).toBe(60);
  expect(() => parseLimit('6O')).toThrow(/not a whole number/);
});

describe('describeJudgment', () => {
  const judged = (verdict) => ({ outcome: 'judged', verdict });
  test('a record close names the proof type and a short quote; a thread close says so', () => {
    expect(describeJudgment(judged({ verdict: 'fulfilled', record_type: 'visit', quote: 'x'.repeat(200) })))
      .toMatchObject({ verdict: 'WOULD CLOSE', proof: 'visit', thread: false, quote: 'x'.repeat(90) });
    expect(describeJudgment(judged({ verdict: 'fulfilled', record_type: 'sms', basis: 'thread_confirmation', witness: 'customer', quote: 'Got it' })))
      .toMatchObject({ verdict: 'WOULD CLOSE', proof: 'customer text (thread)', thread: true });
    expect(describeJudgment(judged({ verdict: 'fulfilled', record_type: 'sms', basis: 'thread_confirmation', witness: 'waves_staff', quote: 'Sent' })))
      .toMatchObject({ proof: 'staff text (thread)' });
  });
  test('everything else stays open, with the reason', () => {
    expect(describeJudgment(judged({ verdict: 'open', reason: 'no_witness' }))).toEqual({ verdict: 'open', reason: 'no later record' });
    expect(describeJudgment(judged({ verdict: 'uncertain', reason: 'ungrounded_witness' }))).toEqual({ verdict: 'uncertain', reason: 'ungrounded_witness' });
    expect(describeJudgment(judged({ verdict: 'open' }))).toMatchObject({ verdict: 'open', reason: 'nothing shows it was kept' });
    expect(describeJudgment({ outcome: 'deferred' })).toMatchObject({ verdict: 'deferred' });
    expect(describeJudgment({ outcome: 'skipped', reason: 'not_yet' })).toEqual({ verdict: 'skipped', reason: 'not_yet' });
  });
});
