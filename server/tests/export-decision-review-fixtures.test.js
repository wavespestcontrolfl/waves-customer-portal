const { rowToCase, parseArgs, exportCases, COLUMNS } = require('../scripts/export-decision-review-fixtures');

const ROW = {
  id: 'ignored-id',
  capability: 'call_judge',
  package_id: 'call_judge.v1',
  package_hash: 'h',
  served_model: 'jev-1.13.0',
  subject_type: 'call_log',
  subject_id: '11111111-1111-4111-8111-111111111111',
  question_id: 'is_lead',
  jev_answer: { p: 0.9, yes: true, confident: true },
  baseline_answers: { rules: false, production: true },
  outcome_evidence: { source: 'lead_created', window: '7d', value: true, observed_at: '2026-09-30T00:00:00.000Z' },
  sampled_for: 'disagreement',
  label: { is_lead: true },
  label_status: 'confirmed_error',
  labeled_by: 'someone@example.com',
  labeled_at: '2026-09-30T00:00:00.000Z',
  created_at: '2026-09-29T00:00:00.000Z',
  transcript: 'must never be exported',
};

describe('rowToCase', () => {
  test('keeps only subject ids, labels, baselines and outcome evidence', () => {
    expect(rowToCase(ROW)).toEqual({
      subject_type: 'call_log',
      subject_id: '11111111-1111-4111-8111-111111111111',
      package_id: 'call_judge.v1',
      package_hash: 'h',
      question_id: 'is_lead',
      label: { is_lead: true },
      label_status: 'confirmed_error',
      baseline_answers: { rules: false, production: true },
      outcome_evidence: { source: 'lead_created', window: '7d', value: true, observed_at: '2026-09-30T00:00:00.000Z' },
    });
    const json = JSON.stringify(rowToCase(ROW));
    expect(json).not.toMatch(/transcript|someone@example|jev_answer|labeled_by/);
  });
  test('absent label / evidence become null', () => {
    expect(rowToCase({ ...ROW, label: undefined, baseline_answers: undefined, outcome_evidence: undefined })).toMatchObject({ label: null, baseline_answers: null, outcome_evidence: null });
  });
  test('never selects a text column', () => {
    expect(COLUMNS).not.toEqual(expect.arrayContaining(['transcript', 'body', 'message']));
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

describe('exportCases (stubbed db)', () => {
  test('filters by capability and status and maps rows', async () => {
    const calls = {};
    const query = {
      where: jest.fn((w) => { calls.where = w; return query; }),
      whereIn: jest.fn((c, v) => { calls.whereIn = [c, v]; return query; }),
      whereNot: jest.fn((c, op, v) => { calls.whereNot = [c, op, v]; return query; }),
      whereRaw: jest.fn((sql) => { calls.whereRaw = sql; return query; }),
      select: jest.fn((cols) => { calls.select = cols; return query; }),
      orderBy: jest.fn(async () => [ROW]),
    };
    const db = jest.fn((table) => { calls.table = table; return query; });
    const result = await exportCases({ db, capability: 'call_judge', now: () => new Date('2026-10-01T00:00:00Z') });
    expect(calls).toMatchObject({ table: 'decision_reviews', where: { capability: 'call_judge' }, whereIn: ['label_status', ['confirmed_error', 'confirmed_correct']], whereNot: ['package_hash', 'like', 'unknown-%'], whereRaw: expect.stringMatching(/label IS NULL OR labeled_by IS NULL OR labeled_at IS NULL/), select: COLUMNS });
    expect(rowToCase(ROW).package_hash).toBe('h');
    expect(result).toEqual({ capability: 'call_judge', exported_at: '2026-10-01T00:00:00.000Z', cases: [rowToCase(ROW)] });
  });
});
