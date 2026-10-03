// Shadow recorder: one decision_reviews row per question, upsert that never
// touches a label, sampling (disagreement / random audit), gate off = no write.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { recordDecisions, sampleFor, siblingDisagrees, stableDraw, RANDOM_AUDIT_RATE, MERGE_COLUMNS, CONFLICT_KEY, DRAW_KEY } = require('../services/typed-decisions/shadow-recorder');
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

// A lone write proposes its cohort as a SQL CASE (the sibling's current value,
// else the computed one, carried as the last binding); read the computed value.
const cohort = (row) => (row && row.sampled_for && typeof row.sampled_for === 'object' ? row.sampled_for.bindings.at(-1) : row?.sampled_for);
const proposesSiblingCohort = (row) => !!(row && row.sampled_for && typeof row.sampled_for === 'object' && /CASE WHEN EXISTS \(SELECT 1 FROM decision_reviews s WHERE .*s\.provider <> \?\) THEN \(SELECT s\.sampled_for FROM decision_reviews s WHERE .* ORDER BY s\.created_at LIMIT 1\) ELSE \? END/.test(row.sampled_for.sql));

function stubConn() {
  const calls = { inserted: null, conflict: null, merge: null, where: null, table: null };
  const builder = {
    insert(rows) { calls.inserted = rows; return builder; },
    onConflict(key) { calls.conflict = key; return builder; },
    merge(cols) { calls.merge = cols; return builder; },
    where(...args) { calls.where = args; return builder; },
    whereRaw(sql) { calls.whereRaw = sql; return builder; },
    returning(col) { calls.returning = col; return Promise.resolve((calls.inserted || []).map((r) => ({ sampled_for: cohort(r) }))); },
  };
  const conn = (table) => { calls.table = table; return builder; };
  conn.raw = (sql, bindings) => ({ sql, bindings });
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
  test('the audit draw comes first and is population-wide: a disagreeing row the draw picks is a random_audit (pre-push P1 on the eval PR)', () => {
    const rand = jest.fn(() => 0.01);
    expect(sampleFor(noul(0.9), { production: false }, rand)).toBe('random_audit');
    expect(rand).toHaveBeenCalledTimes(1);
    expect(sampleFor(noul(0.9), { production: true }, rand)).toBe('random_audit');
    expect(rand).toHaveBeenCalledTimes(2);
    // passed over by the draw, the disagreement still queues
    expect(sampleFor(noul(0.9), { production: false }, () => 0.5)).toBe('disagreement');
  });
});

describe('recordDecisions', () => {
  test('writes one row per question with ids, answers, baselines and the transcript digest only', async () => {
    const { conn, calls } = stubConn();
    const digest = 'a'.repeat(64);
    const out = await recordDecisions({
      capability: 'call_judge', pkg, provider: 'typesafe', subjectType: 'call_log', subjectId: '11111111-1111-4111-8111-111111111111', result: ok(0.9),
      baselines: { is_spam: { production: false, deep_judge: false, note: undefined }, quote_promised: { production: true } },
      subjectHash: digest,
      random: () => 0.99,
      conn,
    });
    expect(out.recorded).toBe(Object.keys(pkg.questions).length);
    expect(calls.table).toBe('decision_reviews');
    expect(calls.inserted).toHaveLength(6);
    const row = calls.inserted.find((r) => r.question_id === 'is_spam');
    expect(Object.keys(row).sort()).toEqual([
      'baseline_answers', 'capability', 'jev_answer', 'package_hash', 'package_id', 'provider', 'question_id', 'sampled_for', 'served_model', 'subject_hash', 'subject_id', 'subject_type',
    ]);
    expect(row.provider).toBe('typesafe'); // the provider the caller named
    expect(row).toMatchObject({ capability: 'call_judge', package_id: 'call_judge.v2', package_hash: packageHash(pkg), served_model: 'jev-1.13.0', subject_type: 'call_log', subject_id: '11111111-1111-4111-8111-111111111111' });
    expect(JSON.parse(row.jev_answer)).toEqual(noul(0.9));
    expect(JSON.parse(row.baseline_answers)).toEqual({ production: false, deep_judge: false });
    expect(cohort(row)).toBe('disagreement'); // Jev yes vs production no
    expect(row.subject_hash).toBe(digest);
    const quote = calls.inserted.find((r) => r.question_id === 'quote_promised');
    expect(cohort(quote)).toBeNull(); // agrees, draw 0.99
    const bare = calls.inserted.find((r) => r.question_id === 'complaint');
    expect(bare.baseline_answers).toBeNull();
    expect(out.sampled).toEqual({ disagreement: 1 });
  });

  test('a subject hash that is not a sha256 hex digest is stored as null', async () => {
    const { conn, calls } = stubConn();
    await recordDecisions({ provider: 'typesafe', capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: 'c1', result: ok(), subjectHash: 'Caller: hi this is text', conn });
    expect(calls.inserted.every((r) => r.subject_hash === null)).toBe(true);
  });

  test('upserts on the unique key and merges only answer columns, only onto unlabeled rows', async () => {
    const { conn, calls } = stubConn();
    await recordDecisions({ provider: 'typesafe', capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: 'c1', result: ok(), conn });
    expect(calls.conflict).toEqual(['capability', 'package_id', 'provider', 'subject_type', 'subject_id', 'question_id']);
    expect(CONFLICT_KEY).toEqual(calls.conflict);
    expect(calls.merge).toEqual(['jev_answer', 'baseline_answers', 'served_model', 'package_hash', 'sampled_for', 'subject_hash']);
    expect(MERGE_COLUMNS).toEqual(calls.merge);
    // a write for one provider alone proposes its cohort in SQL: the sibling row's current value, else the computed one
    expect(proposesSiblingCohort(calls.inserted[0])).toBe(true);
    for (const forbidden of ['label', 'label_status', 'labeled_by', 'labeled_at', 'created_at', 'outcome_evidence']) expect(calls.merge).not.toContain(forbidden);
    expect(calls.whereRaw).toMatch(/sampled_for IS DISTINCT FROM 'heldout'/);
    expect(calls.where).toEqual(['decision_reviews.label_status', 'unreviewed']);
  });

  test('a social post photo records one row per question; a yes against the publish path queues, a no does not', async () => {
    const { conn, calls } = stubConn();
    const photo = packageFor('photo_privacy.v1');
    const ids = Object.keys(photo.questions);
    const answers = Object.fromEntries(ids.map((id) => [id, noul(id === 'shows_face' ? 0.9 : 0.02)]));
    const baselines = Object.fromEntries(ids.map((id) => [id, { production: false }]));
    const out = await recordDecisions({ provider: 'cloudflare', capability: 'photo_privacy', pkg: photo, subjectType: 'social_post', subjectId: 'p1', result: { ok: true, packageHash: packageHash(photo), servedModel: 'clef-flash', answers }, baselines, random: () => 0.5, conn });
    expect(out.recorded).toBe(6);
    expect(calls.inserted.every((row) => row.subject_type === 'social_post' && row.provider === 'cloudflare')).toBe(true);
    expect(Object.fromEntries(calls.inserted.map((row) => [row.question_id, cohort(row)]))).toEqual({ shows_face: 'disagreement', shows_person: null, shows_address_text: null, shows_license_plate: null, shows_child: null, shows_pet: null });
  });

  test('a subject type the table allows but no code reads back yet is refused before any write', async () => {
    const { conn, calls } = stubConn();
    const photo = packageFor('photo_privacy.v1');
    const out = await recordDecisions({ provider: 'cloudflare', capability: 'photo_privacy', pkg: photo, subjectType: 'service_photo', subjectId: 'p1', result: { ok: true, answers: { shows_face: noul(0.9) } }, conn });
    expect(out).toEqual({ recorded: 0, skipped: 'bad_subject' });
    expect(calls.inserted).toBeNull();
  });

  test('a single-question sms package records its question with the rules baseline', async () => {
    const { conn, calls } = stubConn();
    const sms = packageFor('sms_courtesy.v1');
    const result = { ok: true, packageHash: packageHash(sms), servedModel: null, answers: { is_courtesy_only: noul(0.95) } };
    const out = await recordDecisions({ provider: 'typesafe', capability: 'sms_courtesy', pkg: sms, subjectType: 'sms_log', subjectId: 's1', result, baselines: { is_courtesy_only: { rules: false } }, random: () => 0.5, conn });
    expect(out.recorded).toBe(1);
    expect(calls.inserted[0]).toMatchObject({ question_id: 'is_courtesy_only', served_model: null });
    expect(cohort(calls.inserted[0])).toBe('disagreement');
  });

  test('without a test draw, the random audit is a stable per-row hash: re-recording never re-rolls it', async () => {
    const run = async (p, production) => {
      const { conn, calls } = stubConn();
      await recordDecisions({ provider: 'typesafe', capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: 'c-stable', result: ok(p),
        baselines: { is_lead: { production } }, conn });
      return calls.inserted.find((r) => r.question_id === 'is_lead');
    };
    const first = await run(0.9, true);
    const again = await run(0.9, true);
    expect(cohort(again)).toBe(cohort(first));
    const draw = stableDraw(first);
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(draw).toBeLessThan(1);
    expect(cohort(first)).toBe(draw < RANDOM_AUDIT_RATE ? 'random_audit' : null);
    // the answer changed to disagree: sampled_for moves with it (and merges, see
    // above) — unless the stable draw already holds this row in the audit, which
    // is drawn first and keeps it there whatever the baselines say.
    expect(cohort(await run(0.2, true))).toBe(draw < RANDOM_AUDIT_RATE ? 'random_audit' : 'disagreement');
  });

  test('gate off: nothing written', async () => {
    delete process.env.GATE_TYPED_DECISIONS;
    const { conn, calls } = stubConn();
    expect(await recordDecisions({ provider: 'typesafe', capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: 'c1', result: ok(), conn })).toEqual({ recorded: 0, skipped: 'gate_off' });
    expect(calls.table).toBeNull();
  });

  test.each([
    ['a failed ask', { ok: false, reason: 'error' }, 'call_log', 'c1'],
    ['no result', undefined, 'call_log', 'c1'],
    ['an unknown subject type', ok(), 'customer', 'c1'],
    ['no subject id', ok(), 'call_log', ''],
  ])('%s: nothing written', async (_name, result, subjectType, subjectId) => {
    const { conn, calls } = stubConn();
    const out = await recordDecisions({ provider: 'typesafe', capability: 'call_judge', pkg, subjectType, subjectId, result, conn });
    expect(out.recorded).toBe(0);
    expect(calls.table).toBeNull();
  });
});

describe('provider (one row per provider per subject and question; Codex r1 on #5546)', () => {
  test('an omitted provider is refused before any read or write: nothing is attributed to Jev by default (Codex r6, #5555)', async () => {
    const { conn, calls } = stubConn();
    const out = await recordDecisions({ capability: 'call_judge', pkg, subjectType: 'call_log', subjectId: '11111111-1111-4111-8111-111111111111', result: ok(0.9), conn });
    expect(out).toEqual({ recorded: 0, skipped: 'bad_provider' });
    expect(calls.table).toBeNull();
    expect(calls.inserted).toBeNull();
  });

  test('a named provider is written on every row and is part of the conflict key', async () => {
    const { conn, calls } = stubConn();
    const out = await recordDecisions({ capability: 'call_judge', pkg, provider: 'cloudflare', subjectType: 'call_log', subjectId: 'c1', result: { ...ok(), servedModel: 'clef-flash' }, conn });
    expect(out.recorded).toBe(6);
    expect(calls.inserted.every((r) => r.provider === 'cloudflare' && r.served_model === 'clef-flash')).toBe(true);
    expect(calls.conflict).toContain('provider');
  });

  test('a provider outside the closed set is refused before any write', async () => {
    const { conn, calls } = stubConn();
    const out = await recordDecisions({ capability: 'call_judge', pkg, provider: 'mystery', subjectType: 'call_log', subjectId: 'c1', result: ok(), conn });
    expect(out).toEqual({ recorded: 0, skipped: 'bad_provider' });
    expect(calls.inserted).toBeNull();
  });

  test('the audit draw is keyed on the subject, not the provider: both providers are sampled on the same cases', async () => {
    expect(DRAW_KEY).toEqual(['capability', 'package_id', 'subject_type', 'subject_id', 'question_id']);
    const record = async (provider) => {
      const { conn, calls } = stubConn();
      await recordDecisions({ capability: 'call_judge', pkg, provider, subjectType: 'call_log', subjectId: 'c-same', result: ok(), baselines: { is_lead: { production: true } }, conn });
      return calls.inserted;
    };
    const [jev, clef] = [await record('typesafe'), await record('cloudflare')];
    expect(clef.map((r) => stableDraw(r))).toEqual(jev.map((r) => stableDraw(r)));
    expect(clef.map(cohort)).toEqual(jev.map(cohort));
  });
});

describe('review cohort is paired across provider siblings (Codex r1 on #5555)', () => {
  test('a coordinated write proposes the computed cohort; a write for one provider alone proposes the sibling row\'s current cohort in SQL, else the computed one (Codex r7-r10, #5555)', async () => {
    const result = { ok: true, packageHash: packageHash(packageFor('sms_courtesy.v1')), servedModel: 'jev-1.13.0', answers: { is_courtesy_only: noul(0.9) } };
    const paired = stubConn();
    await recordDecisions({ capability: 'sms_courtesy', pkg: packageFor('sms_courtesy.v1'), provider: 'typesafe', subjectType: 'sms_log', subjectId: 's-coord', result, siblingAnswers: { is_courtesy_only: noul(0.1) }, random: () => 0.99, conn: paired.conn });
    expect(paired.calls.inserted[0].sampled_for).toBe('disagreement'); // a plain value: the pair's answers were in hand
    expect(paired.calls.merge).toEqual(MERGE_COLUMNS);
    const alone = stubConn();
    await recordDecisions({ capability: 'sms_courtesy', pkg: packageFor('sms_courtesy.v1'), provider: 'typesafe', subjectType: 'sms_log', subjectId: 's-coord', result, baselines: { is_courtesy_only: { rules: false } }, random: () => 0.99, conn: alone.conn });
    const proposal = alone.calls.inserted[0].sampled_for;
    expect(proposesSiblingCohort(alone.calls.inserted[0])).toBe(true);
    // bindings: the sibling key twice (capability, package, subject type, subject id, question, this provider), then the computed cohort
    expect(proposal.bindings).toEqual(['sms_courtesy', 'sms_courtesy.v1', 'sms_log', 's-coord', 'is_courtesy_only', 'typesafe', 'sms_courtesy', 'sms_courtesy.v1', 'sms_log', 's-coord', 'is_courtesy_only', 'typesafe', 'disagreement']);
    // recorded counts what the statement returned, not what was proposed
    expect(alone.calls.returning).toBe('sampled_for');
  });

  const sms = packageFor('sms_courtesy.v1');
  const result = (p, servedModel) => ({ ok: true, packageHash: packageHash(sms), servedModel, answers: { is_courtesy_only: noul(p) } });
  const record = async ({ provider, p, sibling, baselines, draw = 0.99 }) => {
    const { conn, calls } = stubConn();
    await recordDecisions({ capability: 'sms_courtesy', pkg: sms, provider, subjectType: 'sms_log', subjectId: 's-pair', result: result(p),
      baselines, siblingAnswers: sibling === undefined ? {} : { is_courtesy_only: noul(sibling) }, random: () => draw, conn });
    return cohort(calls.inserted[0]);
  };

  test('a low audit draw never splits the pair: the shared subject-keyed draw puts BOTH siblings in the audit, whatever they answered', async () => {
    const baselines = { is_courtesy_only: { rules: true } };
    expect(await record({ provider: 'typesafe', p: 0.9, sibling: 0.1, baselines, draw: 0.01 })).toBe('random_audit');
    expect(await record({ provider: 'cloudflare', p: 0.1, sibling: 0.9, baselines, draw: 0.01 })).toBe('random_audit');
    // and with no difference anywhere the low draw is an ordinary spot check for both
    expect(await record({ provider: 'typesafe', p: 0.9, sibling: 0.95, baselines, draw: 0.01 })).toBe('random_audit');
    expect(await record({ provider: 'cloudflare', p: 0.95, sibling: 0.9, baselines, draw: 0.01 })).toBe('random_audit');
  });

  test('sampleFor takes the siblings directly: the draw comes first, then a difference counts like a baseline disagreement', () => {
    expect(sampleFor(noul(0.9), { rules: true }, 0.99, noul(0.1))).toBe('disagreement');
    expect(sampleFor(noul(0.9), { rules: true }, 0.01, [noul(0.1)])).toBe('random_audit');
    expect(sampleFor(noul(0.9), { rules: true }, 0.99, noul(0.8))).toBeNull();
  });

  test('one provider disagrees with the baseline, the other agrees: BOTH rows enter the disagreement queue', async () => {
    const baselines = { is_courtesy_only: { rules: true } };
    // typesafe says yes (agrees with rules), cloudflare says no (disagrees)
    expect(await record({ provider: 'typesafe', p: 0.9, sibling: 0.1, baselines })).toBe('disagreement');
    expect(await record({ provider: 'cloudflare', p: 0.1, sibling: 0.9, baselines })).toBe('disagreement');
  });

  test('the providers differ with no baseline at all: still a disagreement for both', async () => {
    expect(await record({ provider: 'typesafe', p: 0.9, sibling: 0.1 })).toBe('disagreement');
    expect(await record({ provider: 'cloudflare', p: 0.1, sibling: 0.9 })).toBe('disagreement');
  });

  test('the providers agree with each other and the baseline: neither is queued', async () => {
    const baselines = { is_courtesy_only: { rules: true } };
    expect(await record({ provider: 'typesafe', p: 0.9, sibling: 0.95, baselines })).toBeNull();
    expect(await record({ provider: 'cloudflare', p: 0.95, sibling: 0.9, baselines })).toBeNull();
  });

  test('no sibling answers (the other provider failed, or a single-provider caller) keeps the per-row rule', async () => {
    expect(await record({ provider: 'typesafe', p: 0.9, baselines: { is_courtesy_only: { rules: true } } })).toBeNull();
    expect(await record({ provider: 'typesafe', p: 0.9, baselines: { is_courtesy_only: { rules: false } } })).toBe('disagreement');
  });

  test('siblingDisagrees compares like with like and accepts one answer or a list', () => {
    expect(siblingDisagrees(noul(0.9), noul(0.1))).toBe(true);
    expect(siblingDisagrees(noul(0.9), [noul(0.8), noul(0.2)])).toBe(true);
    expect(siblingDisagrees(noul(0.9), [noul(0.8)])).toBe(false);
    expect(siblingDisagrees({ choice: 'a' }, { choice: 'b' })).toBe(true);
    expect(siblingDisagrees({ choice: 'a' }, noul(0.1))).toBe(false); // different answer types never compare
    expect(siblingDisagrees({ score: 3 }, { score: 1 })).toBe(false); // a score has nothing to disagree about
    expect(siblingDisagrees(noul(0.9), undefined)).toBe(false);
    expect(siblingDisagrees(noul(0.9), [null, 'text', {}])).toBe(false);
  });
});
