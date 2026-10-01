// Daily owner item: no rows -> nothing; rows -> ONE alert with the counts,
// a per-day dedupe key, brevity-guard-safe copy, ids and answers only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockRefresh = jest.fn();
jest.mock('../services/typed-decisions/outcome-evidence', () => ({ refreshOutcomeEvidence: (...a) => mockRefresh(...a) }));
const mockNotify = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

const { runDailyReviewItem, describeRow, LINK } = require('../services/typed-decisions/daily-review-item');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const original = process.env.GATE_TYPED_DECISIONS;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TYPED_DECISIONS = 'true';
  mockRefresh.mockResolvedValue({ checked: 0, updated: 0 });
  mockNotify.mockResolvedValue({ id: 'n1' });
});
afterAll(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });

const review = (over = {}) => ({
  id: 'r', capability: 'call_judge', question_id: 'is_spam', created_at: new Date('2026-09-30T20:00:00Z'),
  jev_answer: JSON.stringify({ p: 0.93, yes: true, confident: true }),
  baseline_answers: JSON.stringify({ production: false, deep_judge: false }),
  outcome_evidence: JSON.stringify({ source: 'estimates', window: '48h', value: false, observed_at: 'x' }),
  ...over,
});

// A conn that answers by the sampled_for the query asked for.
function conn({ disagreements = [], audits = [] } = {}) {
  const seen = [];
  const make = () => {
    const state = { where: [], limit: null, calls: [] };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(state.where.some((w) => w.sampled_for === 'disagreement') ? disagreements : audits).then(res, rej);
        return (...args) => {
          state.calls.push([prop, args]);
          if (prop === 'where') state.where.push(...args.filter((a) => a && typeof a === 'object'), ...(typeof args[0] === 'string' ? [{ [args[0]]: args[args.length - 1] }] : []));
          if (prop === 'limit') state.limit = args[0];
          if (prop === 'select') seen.push(state);
          return b;
        };
      },
    });
    return b;
  };
  const c = () => make();
  c.seen = seen;
  return c;
}

test('gate off: nothing read, nothing raised', async () => {
  delete process.env.GATE_TYPED_DECISIONS;
  const c = jest.fn();
  expect(await runDailyReviewItem({ conn: c })).toEqual({ raised: false, reason: 'gate_off' });
  expect(c).not.toHaveBeenCalled();
  expect(mockRefresh).not.toHaveBeenCalled();
});

test('no rows: refreshes evidence, raises nothing', async () => {
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn() });
  expect(out).toEqual({ raised: false, reason: 'no_rows' });
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(mockNotify).not.toHaveBeenCalled();
});

test('rows: ONE alert with the counts, the review link and per-row detail', async () => {
  const c = conn({ disagreements: [review(), review({ question_id: 'quote_promised' })], audits: [review({ question_id: 'complaint' })] });
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c });
  expect(out).toMatchObject({ raised: true, disagreements: 2, spotChecks: 1 });
  expect(mockNotify).toHaveBeenCalledTimes(1);
  const [category, title, body, opts] = mockNotify.mock.calls[0];
  expect(category).toBe('typed_decisions');
  expect(title).toBe('System — review 3 AI decisions');
  expect(body).toBe('2 disagreements, 1 spot check · Jev vs rules/judge');
  expect(body.length).toBeLessThanOrEqual(110);
  expect(opts.link).toBe(LINK);
  expect(LINK).toBe('/admin/agents?tab=typed');
  expect(opts.metadata).toMatchObject({ area: 'System', severity: 'needs-you', doneWhen: 'reviews_labeled', who: 'person', subject: { type: 'check', id: 'typed-decisions-review' } });
  expect(opts.detail).toContain('call_judge is_spam: Jev yes (p 0.93) vs production no, deep judge no; estimates 48h: no');
  expect(opts.detail.split('\n').filter((l) => l.startsWith('Disagreement'))).toHaveLength(2);
  expect(opts.detail.split('\n').filter((l) => l.startsWith('Spot check'))).toHaveLength(1);
  expect(opts.detail).toContain(LINK);
});

test('caps: 8 disagreements and 2 spot checks, yesterday (ET) only, unreviewed only', async () => {
  const c = conn({ disagreements: [review()], audits: [review()] });
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c });
  expect(c.seen.map((s) => s.limit).sort((a, b) => a - b)).toEqual([2, 8]);
  for (const state of c.seen) {
    expect(state.calls).toContainEqual(['where', [expect.objectContaining({ label_status: 'unreviewed' })]]);
    expect(state.calls).toContainEqual(['where', ['created_at', '>=', new Date('2026-09-30T04:00:00.000Z')]]);
    expect(state.calls).toContainEqual(['where', ['created_at', '<', new Date('2026-10-01T04:00:00.000Z')]]);
  }
  expect(c.seen.map((s) => s.calls.find(([m]) => m === 'where')[1][0].sampled_for).sort()).toEqual(['disagreement', 'random_audit']);
});

test('the dedupe key is per ET day, so each day raises its own item', async () => {
  const c = () => conn({ disagreements: [review()] });
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c() });
  await runDailyReviewItem({ now: new Date('2026-10-02T12:05:00Z'), conn: c() });
  expect(mockNotify.mock.calls[0][3].dedupeKey).toBe('typed-decisions-review:2026-10-01');
  expect(mockNotify.mock.calls[1][3].dedupeKey).toBe('typed-decisions-review:2026-10-02');
  expect(mockNotify.mock.calls[0][3].refreshOnDedupe).toBe(true);
});

test('a single decision reads in the singular and still passes the admin-alert rule', () => {
  expect(() => composeAdminAlert({
    area: 'System', action: 'review 1 AI decision', why: '1 disagreement, 0 spot checks · Jev vs rules/judge', severity: 'needs-you',
    link: LINK, subject: { type: 'check', id: 'typed-decisions-review' }, doneWhen: 'reviews_labeled', who: 'person',
  })).not.toThrow();
});

test('an evidence refresh failure does not stop the item', async () => {
  mockRefresh.mockRejectedValue(new Error('down'));
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({ disagreements: [review()] }) });
  expect(out.raised).toBe(true);
});

test('describeRow carries ids and answers only', () => {
  const line = describeRow(review({ outcome_evidence: null, baseline_answers: JSON.stringify({ rules: true }) }));
  expect(line).toBe('call_judge is_spam: Jev yes (p 0.93) vs rules yes');
});
