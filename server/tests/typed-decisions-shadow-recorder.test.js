// Shadow recorder: one decision_reviews row per question, upsert that never
// touches a label, sampling (disagreement / random audit), gate off = no write.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { recordDecisions, sampleFor, stableDraw, RANDOM_AUDIT_RATE, MERGE_COLUMNS, CONFLICT_KEY } = require('../services/typed-decisions/shadow-recorder');
const { packageFor, packageHash } = require('../services/typed-decisions/packages');

const pkg = packageFor('call_judge.v2');
const noul = (p) => ({ p, yes: p >= 0.5, confident: p <= 0.15 || p >= 0.85 });
const ok = (p = 0.9) => ({
  ok: true,
  packageId: pkg.id,
  packageHash: packageHash(pkg),
  servedModel: 'jev-1.13.0',
  answers: Object.fromEntries(Object.keys(pkg.questions).map((id) => [id, noul(p)])),
});

function stubConn() {
  const calls = { inserted: null, conflict: null, merge: null, where: null, table: null };
  const builder = {
    insert(rows) { calls.inserted = rows; return builder; },
    onConflict(key) { calls.conflict = key; return builder; },
    merge(cols) { calls.merge = cols; return builder; },
    where(...args) { calls.where = args; return builder; },
    whereRaw(sql) { calls.whereRaw = sql; return Promise.resolve([]); },
  };
  const conn = (table) => { calls.table = table; return builder; };
  return { conn, calls };
}

const original = process.env.GATE_TYPED_DECISIONS;
beforeEach(() => { process.env.GATE_TYPED_DECISIONS = 'true'; });
afterAll(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });

describe('sampleFor', () => {
  test('a yes/no that differs from ANY present baseline is a disagreement', () => {
    expect(sampleFor(noul(0.9), { production: true, deep_judge: false }, 0.99)).toBe('disagreement');
    expect(sampleFor(noul(0.1), { rules: true }, 0.99)).toBe('disagreement');
  });
  test('agreeing with every baseline falls to the random audit draw', () => {
    expect(sampleFor(noul(0.9), { production: true, deep_judge: true }, 0.05)).toBe('random_audit');
    expect(sampleFor(noul(0.9), { production: true, deep_judge: true }, RANDOM_AUDIT_RATE)).toBeNull();
    expect(sampleFor(noul(0.9), { production: true }, 0.5)).toBeNull();
  });
  test('absent baselines never disagree', () => {
    expect(sampleFor(noul(0.9), { production: null, deep_judge: undefined }, 0.99)).toBeNull();
    expect(sampleFor(noul(0.9), undefined, 0.99)).toBeNull();
    expect(sampleFor(noul(0.9), {}, 0.01)).toBe('random_audit');
  });
  test('a choice compares by value; a score has nothing to disagree about', () => {
    expect(sampleFor({ choice: 'a', confidence: 0.9 }, { rules: 'b' }, 0.99)).toBe('disagreement');
    expect(sampleFor({ choice: 'a', confidence: 0.9 }, { rules: 'a' }, 0.99)).toBeNull();
    expect(sampleFor({ score: 3 }, { rules: true }, 0.99)).toBeNull();
  });
  test('rand may be a function and is not drawn when there is a disagreement', () => {
    const rand = jest.fn(() => 0.01);
    expect(sampleFor(noul(0.9), { production: false }, rand)).toBe('disagreement');
    expect(rand).not.toHaveBeenCalled();
    expect(sampleFor(noul(0.9), { production: true }, rand)).toBe('random_audit');
    expect(rand).toHaveBeenCalledTimes(1);
  });
});

describe('recordDecisions', () => {
  test('writes one row per question with ids, answers, baselines and evidence only', async () => {
    const { conn, calls } = stubConn();
    const evidence = { source: 'estimates', window: '48h', value: true, observed_at: '2026-10-01T12:00:00.000Z', transcript: 'must not survive' };
    const out = await recordDecisions({
      capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: '11111111-1111-4111-8111-111111111111', result: ok(0.9),
      baselines: { is_spam: { production: false, deep_judge: false, note: undefined }, quote_promised: { production: true } },
      outcomeEvidence: { quote_promised: evidence },
      random: () => 0.99,
      conn,
    });
    expect(out.recorded).toBe(Object.keys(pkg.questions).length);
    expect(calls.table).toBe('decision_reviews');
    expect(calls.inserted).toHaveLength(6);
    const row = calls.inserted.find((r) => r.question_id === 'is_spam');
    expect(Object.keys(row).sort()).toEqual([
      'baseline_answers', 'capability', 'jev_answer', 'outcome_evidence', 'package_hash', 'package_id', 'question_id', 'sampled_for', 'served_model', 'subject_id', 'subject_type',
    ]);
    expect(row).toMatchObject({ capability: 'call_judge', package_id: 'call_judge.v2', package_hash: packageHash(pkg), served_model: 'jev-1.13.0', subject_type: 'call_log', subject_id: '11111111-1111-4111-8111-111111111111' });
    expect(JSON.parse(row.jev_answer)).toEqual(noul(0.9));
    expect(JSON.parse(row.baseline_answers)).toEqual({ production: false, deep_judge: false });
    expect(row.sampled_for).toBe('disagreement'); // Jev yes vs production no
    const quote = calls.inserted.find((r) => r.question_id === 'quote_promised');
    expect(JSON.parse(quote.outcome_evidence)).toEqual({ source: 'estimates', window: '48h', value: true, observed_at: '2026-10-01T12:00:00.000Z' });
    expect(quote.sampled_for).toBeNull(); // agrees, draw 0.99
    const bare = calls.inserted.find((r) => r.question_id === 'complaint');
    expect(bare.baseline_answers).toBeNull();
    expect(bare.outcome_evidence).toBeNull();
    expect(out.sampled).toEqual({ disagreement: 1 });
    expect(JSON.stringify(calls.inserted)).not.toMatch(/must not survive/);
  });

  test('upserts on the unique key and merges only answer columns, only onto unlabeled rows', async () => {
    const { conn, calls } = stubConn();
    await recordDecisions({ capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: 'c1', result: ok(), conn });
    expect(calls.conflict).toEqual(['capability', 'package_id', 'subject_type', 'subject_id', 'question_id']);
    expect(CONFLICT_KEY).toEqual(calls.conflict);
    expect(calls.merge).toEqual(['jev_answer', 'baseline_answers', 'outcome_evidence', 'served_model', 'package_hash', 'sampled_for']);
    expect(MERGE_COLUMNS).toEqual(calls.merge);
    for (const forbidden of ['label', 'label_status', 'labeled_by', 'labeled_at', 'created_at']) expect(calls.merge).not.toContain(forbidden);
    expect(calls.whereRaw).toMatch(/sampled_for IS DISTINCT FROM 'heldout'/);
    expect(calls.where).toEqual(['decision_reviews.label_status', 'unreviewed']);
  });

  test('a single-question sms package records its question with the rules baseline', async () => {
    const { conn, calls } = stubConn();
    const sms = packageFor('sms_courtesy.v1');
    const result = { ok: true, packageHash: packageHash(sms), servedModel: null, answers: { is_courtesy_only: noul(0.95) } };
    const out = await recordDecisions({ capability: 'sms_courtesy', pkg: sms, subjectType: 'sms_log', subjectId: 's1', result, baselines: { is_courtesy_only: { rules: false } }, random: () => 0.5, conn });
    expect(out.recorded).toBe(1);
    expect(calls.inserted[0]).toMatchObject({ question_id: 'is_courtesy_only', served_model: null, sampled_for: 'disagreement' });
  });

  test('without a test draw, the random audit is a stable per-row hash: re-recording never re-rolls it', async () => {
    const run = async (p, production) => {
      const { conn, calls } = stubConn();
      await recordDecisions({ capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: 'c-stable', result: ok(p),
        baselines: { is_lead: { production } }, conn });
      return calls.inserted.find((r) => r.question_id === 'is_lead');
    };
    const first = await run(0.9, true);
    const again = await run(0.9, true);
    expect(again.sampled_for).toBe(first.sampled_for);
    const draw = stableDraw(first);
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(draw).toBeLessThan(1);
    expect(first.sampled_for).toBe(draw < RANDOM_AUDIT_RATE ? 'random_audit' : null);
    // the answer changed to disagree: sampled_for moves with it (and merges, see above)
    expect((await run(0.2, true)).sampled_for).toBe('disagreement');
  });

  test('gate off: nothing written', async () => {
    delete process.env.GATE_TYPED_DECISIONS;
    const { conn, calls } = stubConn();
    expect(await recordDecisions({ capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: 'c1', result: ok(), conn })).toEqual({ recorded: 0, skipped: 'gate_off' });
    expect(calls.table).toBeNull();
  });

  test.each([
    ['a failed ask', { ok: false, reason: 'error' }, 'call_log', 'c1'],
    ['no result', undefined, 'call_log', 'c1'],
    ['an unknown subject type', ok(), 'customer', 'c1'],
    ['no subject id', ok(), 'call_log', ''],
  ])('%s: nothing written', async (_name, result, subjectType, subjectId) => {
    const { conn, calls } = stubConn();
    const out = await recordDecisions({ capability: 'call_judge', pkg, subjectType, subjectId, result, conn });
    expect(out.recorded).toBe(0);
    expect(calls.table).toBeNull();
  });
});
