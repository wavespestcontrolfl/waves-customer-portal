const { rowToCase, parseArgs, exportCases, COLUMNS } = require('../scripts/export-decision-review-fixtures');
const { PACKAGES, packageHash } = require('../services/typed-decisions/packages');
const CALL_JUDGE_HASH = packageHash(PACKAGES['call_judge.v2']);

const ROW = {
  id: 'ignored-id',
  capability: 'call_judge',
  package_id: 'call_judge.v2',
  package_hash: CALL_JUDGE_HASH,
  served_model: 'jev-1.13.0',
  subject_type: 'call_log',
  subject_id: '11111111-1111-4111-8111-111111111111',
  question_id: 'is_lead',
  jev_answer: { p: 0.9, yes: true, confident: true },
  baseline_answers: { rules: false, production: true },
  outcome_evidence: { source: 'leads_customers', window: '7d', value: true, observed_at: '2026-09-30T00:00:00.000Z' },
  sampled_for: 'disagreement',
  label: { verdict: 'jev_wrong', correct_value: false, note: 'Customer Jane Doe at 123 Main St said no' },
  label_status: 'confirmed_error',
  labeled_by: 'someone@example.com',
  labeled_at: '2026-09-30T00:00:00.000Z',
  created_at: '2026-09-29T00:00:00.000Z',
  transcript: 'must never be exported',
};

describe('rowToCase', () => {
  test('keeps only ids, typed answers, labels, baselines and evidence; never text', () => {
    const c = rowToCase(ROW);
    expect(c).toEqual({
      provider: 'typesafe',
      subject_type: 'call_log',
      subject_id: '11111111-1111-4111-8111-111111111111',
      subject_version: null,
      package_id: 'call_judge.v2',
      package_hash: CALL_JUDGE_HASH,
      question_id: 'is_lead',
      question_type: 'noul',
      jev_answer: { p: 0.9, yes: true, confident: true },
      expected: false,
      label: { verdict: 'jev_wrong', correct_value: false },
      label_status: 'confirmed_error',
      baseline_answers: { rules: false, production: true },
      outcome_evidence: { source: 'leads_customers', window: '7d', value: true, observed_at: '2026-09-30T00:00:00.000Z' },
    });
    expect(JSON.stringify(c)).not.toMatch(/transcript|someone@example|labeled_by|Jane Doe|123 Main|note/);
  });

  test('provider is a closed registry value: a second provider exports as itself, a stored string outside the registry is not exported', () => {
    expect(rowToCase({ ...ROW, provider: 'cloudflare' }).provider).toBe('cloudflare');
    expect(rowToCase({ ...ROW, provider: null }).provider).toBe('typesafe'); // a row from before the column
    expect(rowToCase({ ...ROW, provider: 'Jane Doe at 123 Main' })).toBeNull();
    expect(COLUMNS).toContain('provider');
  });
  test('carries the stored subject version so the eval can drop a reprocessed subject; never a non-digest', () => {
    expect(rowToCase({ ...ROW, subject_hash: 'b'.repeat(64) }).subject_version).toBe('b'.repeat(64));
    expect(rowToCase({ ...ROW, subject_hash: 'Caller: hi' }).subject_version).toBeNull();
    expect(COLUMNS).toContain('subject_hash');
  });
  test('never selects a text column', () => {
    expect(COLUMNS).not.toEqual(expect.arrayContaining(['transcript', 'body', 'message']));
  });
  test('values are validated against the package question domain, not a token shape', () => {
    const c = rowToCase({ ...ROW,
      label: { verdict: 'jev_wrong', correct_value: 'Jane_Doe' },
      baseline_answers: { rules: 'Jane', production: true, excerpt: 'Caller: hi this is Jane at 123 Main' },
      outcome_evidence: { source: 'Jane_Doe', window: '7d', value: 'yes', observed_at: 'yesterday', transcript: 'leak' },
      jev_answer: { p: 0.2, yes: false, confident: true, note: 'free text', probabilities: { x: 1 } } });
    // jev_wrong with an out-of-domain correct_value is not scorable → excluded
    expect(c).toBeNull();
    const ok = rowToCase({ ...ROW, label: { verdict: 'jev_right' }, label_status: 'confirmed_correct',
      baseline_answers: { rules: 'Jane', production: true, excerpt: 'x' },
      outcome_evidence: { source: 'Jane_Doe', window: '7d', value: 'yes', observed_at: 'yesterday', transcript: 'leak' },
      jev_answer: { p: 0.1, yes: false, confident: true, note: 'free text' } });
    expect(JSON.stringify(ok)).not.toMatch(/Jane|Main|transcript|free text|yesterday/);
    expect(ok.baseline_answers).toEqual({ production: true });
    expect(ok.outcome_evidence).toBeNull();
    expect(ok.jev_answer).toEqual({ p: 0.1, yes: false, confident: true });
    expect(ok.expected).toBe(false);
  });
  test('choice questions accept only the question\'s own criteria keys', () => {
    const pkgRow = { ...ROW, package_id: 'call_judge.v2', question_id: 'is_lead' };
    // is_lead is a noul: a string correct_value is out of domain
    expect(rowToCase({ ...pkgRow, label: { verdict: 'jev_wrong', correct_value: 'single_family' } })).toBeNull();
    // unknown package or question → nothing to validate against → excluded
    expect(rowToCase({ ...ROW, package_id: 'nope.v9' })).toBeNull();
    expect(rowToCase({ ...ROW, question_id: 'not_a_question' })).toBeNull();
  });
});

describe('provenance and status/verdict pairing', () => {
  test('a row whose hash is not the registered package\'s current hash is excluded', () => {
    expect(rowToCase({ ...ROW, package_hash: 'a'.repeat(64) })).toBeNull();
  });
  test('confirmed_correct needs jev_right and confirmed_error needs jev_wrong', () => {
    expect(rowToCase({ ...ROW, label_status: 'confirmed_correct', label: { verdict: 'jev_wrong', correct_value: false } })).toBeNull();
    expect(rowToCase({ ...ROW, label_status: 'confirmed_error', label: { verdict: 'jev_right' } })).toBeNull();
    expect(rowToCase({ ...ROW, label_status: 'confirmed_correct', label: { verdict: 'jev_right' } })).toMatchObject({ expected: true });
  });
});

describe('expected answer', () => {
  test('jev_right preserves the confirmed answer for both boolean outcomes', () => {
    const yes = rowToCase({ ...ROW, label: { verdict: 'jev_right' }, label_status: 'confirmed_correct', jev_answer: { p: 0.9, yes: true, confident: true } });
    const no = rowToCase({ ...ROW, label: { verdict: 'jev_right' }, label_status: 'confirmed_correct', jev_answer: { p: 0.1, yes: false, confident: true } });
    expect(yes.expected).toBe(true);
    expect(no.expected).toBe(false);
  });
  test('non-scorable confirmed rows are excluded: unclear, jev_wrong with null/missing correct_value', () => {
    expect(rowToCase({ ...ROW, label: { verdict: 'unclear' } })).toBeNull();
    expect(rowToCase({ ...ROW, label: { verdict: 'jev_wrong', correct_value: null } })).toBeNull();
    expect(rowToCase({ ...ROW, label: { verdict: 'jev_wrong' } })).toBeNull();
    // an unreviewed row (dev set export) is kept, with expected null
    expect(rowToCase({ ...ROW, label: null, label_status: 'unreviewed' })).toMatchObject({ expected: null, label: null });
  });
});

describe('parseArgs', () => {
  test('requires a capability and defaults the statuses to the two confirmed ones', () => {
    expect(() => parseArgs([])).toThrow(/--capability/);
    expect(parseArgs(['--capability', 'call_judge'])).toEqual({ capability: 'call_judge', statuses: ['confirmed_error', 'confirmed_correct'], out: null });
  });
  test('accepts --status and --out, and rejects unknown values', () => {
    expect(parseArgs(['--capability=sms_courtesy', '--status=confirmed_error', '--out', 'x.json'])).toEqual({ capability: 'sms_courtesy', statuses: ['confirmed_error'], out: 'x.json' });
    expect(() => parseArgs(['--capability', 'a', '--status', 'bogus'])).toThrow(/--status/);
    expect(() => parseArgs(['--capability', 'a', '--nope'])).toThrow(/unknown argument/);
  });
});

describe('closed-world checks (Codex #5476 r10)', () => {
  const RIGHT = { ...ROW, label: { verdict: 'jev_right' }, label_status: 'confirmed_correct' };
  test('evidence source must be a registered machine source with its own window', () => {
    expect(rowToCase({ ...RIGHT, outcome_evidence: { source: 'jane_doe', window: '7d', value: true } }).outcome_evidence).toBeNull();
    expect(rowToCase({ ...RIGHT, outcome_evidence: { source: 'leads_customers', window: '24h', value: true } }).outcome_evidence).toBeNull();
    expect(rowToCase({ ...RIGHT, outcome_evidence: { source: 'sms_log', window: '24h', value: null } }).outcome_evidence)
      .toEqual({ source: 'sms_log', window: '24h', value: null });
  });
  test('the package must belong to the row and the exported capability', () => {
    const sms = PACKAGES['sms_courtesy.v1'];
    const smsRow = { ...RIGHT, package_id: sms.id, package_hash: packageHash(sms), question_id: Object.keys(sms.questions)[0] };
    expect(rowToCase(smsRow)).toBeNull(); // row says call_judge, package is sms_courtesy
    expect(rowToCase({ ...smsRow, capability: 'sms_courtesy' }, 'call_judge')).toBeNull();
    expect(rowToCase({ ...smsRow, capability: 'sms_courtesy' }, 'sms_courtesy')).not.toBeNull();
    expect(rowToCase(RIGHT, 'sms_courtesy')).toBeNull();
  });
  test('yes and confident are derived from p; a contradiction is not exported', () => {
    expect(rowToCase({ ...RIGHT, jev_answer: { p: 0.9, yes: false, confident: true } })).toBeNull();
    expect(rowToCase({ ...RIGHT, jev_answer: { p: 0.6, yes: true, confident: true } })).toBeNull();
    expect(rowToCase({ ...RIGHT, jev_answer: { p: 0.6 } }).jev_answer).toEqual({ p: 0.6, yes: true, confident: false });
  });
});

describe('exportCases (stubbed db)', () => {
  test('filters by capability and status and maps rows', async () => {
    const calls = {};
    const query = {
      where: jest.fn((w) => { calls.where = w; return query; }),
      whereIn: jest.fn((c, v) => { calls.whereIn = [c, v]; return query; }),
      whereRaw: jest.fn((sql) => { calls.whereRaw = sql; return query; }),
      select: jest.fn((cols) => { calls.select = cols; return query; }),
      orderBy: jest.fn(async () => [ROW]),
    };
    const db = jest.fn((table) => { calls.table = table; return query; });
    const result = await exportCases({ db, capability: 'call_judge', now: () => new Date('2026-10-01T00:00:00Z') });
    expect(calls).toMatchObject({ table: 'decision_reviews', where: { capability: 'call_judge' }, whereIn: ['label_status', ['confirmed_error', 'confirmed_correct']], whereRaw: expect.stringMatching(/package_hash ~ '\^\[0-9a-f\]\{64\}\$'.*label->>'verdict' IN \('jev_right','jev_wrong','unclear'\).*jsonb_exists\(label, 'correct_value'\).*btrim\(labeled_by\) <> ''.*confirmed_correct' AND label->>'verdict' = 'jev_right'/), select: COLUMNS });
    expect(calls.whereRaw).not.toMatch(/\?/);
    expect(rowToCase(ROW).package_hash).toBe(CALL_JUDGE_HASH);
    expect(result).toEqual({ capability: 'call_judge', exported_at: '2026-10-01T00:00:00.000Z', cases: [rowToCase(ROW)] });
  });
});
