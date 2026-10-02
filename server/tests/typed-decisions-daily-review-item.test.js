// Daily owner item: no rows -> nothing; rows -> ONE alert with the counts,
// a per-day dedupe key, brevity-guard-safe copy, ids and answers only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockNotify = jest.fn();
const mockOpenKeys = jest.fn(async () => []);
const mockCloseKeys = jest.fn(async () => 1);
jest.mock('../services/admin-alert-episodes', () => ({ openAdminAlertKeys: (...a) => mockOpenKeys(...a), closeAdminAlertKeys: (...a) => mockCloseKeys(...a) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

const { runDailyReviewItem, describeRow, LINK } = require('../services/typed-decisions/daily-review-item');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const original = process.env.GATE_TYPED_DECISIONS;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TYPED_DECISIONS = 'true';
  mockNotify.mockResolvedValue({ id: 'n1' });
});
afterAll(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });

const review = (over = {}) => ({
  id: 'r', capability: 'call_judge', question_id: 'is_spam', created_at: new Date('2026-09-30T20:00:00Z'),
  jev_answer: JSON.stringify({ p: 0.93, yes: true, confident: true }),
  baseline_answers: JSON.stringify({ production: false, deep_judge: false }),
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
});

test('no rows: raises nothing', async () => {
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn() });
  expect(out).toEqual({ raised: false, reason: 'no_rows' });
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
  expect(body).toBe('2 disagreements, 1 spot check · AI vs rules/judge');
  expect(body.length).toBeLessThanOrEqual(110);
  expect(opts.link).toBe(LINK);
  expect(LINK).toBe('/admin/agents?tab=typed');
  expect(opts.metadata).toMatchObject({ area: 'System', severity: 'needs-you', doneWhen: 'reviews_labeled', who: 'person', subject: { type: 'check', id: 'typed-decisions-review' } });
  expect(opts.detail).toContain('call_judge is_spam: Jev yes (p 0.93) vs production no, deep judge no');
  expect(opts.detail.split('\n').filter((l) => l.startsWith('Disagreement'))).toHaveLength(2);
  expect(opts.detail.split('\n').filter((l) => l.startsWith('Spot check'))).toHaveLength(1);
  expect(opts.detail).toContain(LINK);
});

test('caps: 8 disagreements and 2 spot checks, still unreviewed, from the last 14 days (not one calendar day)', async () => {
  const c = conn({ disagreements: [review()], audits: [review()] });
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c });
  expect(c.seen.map((s) => s.limit).sort((a, b) => a - b)).toEqual([2, 8]);
  for (const state of c.seen) {
    expect(state.calls).toContainEqual(['where', [expect.objectContaining({ label_status: 'unreviewed' })]]);
    expect(state.calls).toContainEqual(['where', ['created_at', '>=', new Date('2026-09-17T04:00:00.000Z')]]);
    // no upper bound: a failed day, or a row a later re-record made a disagreement, is still raised
    expect(state.calls.some(([m, a]) => m === 'where' && a[0] === 'created_at' && a[1] === '<')).toBe(false);
  }
  expect(c.seen.map((s) => s.calls.find(([m]) => m === 'where')[1][0].sampled_for).sort()).toEqual(['disagreement', 'random_audit']);
});

test('a notification that was not persisted is a failed run, not "raised"', async () => {
  mockNotify.mockResolvedValue(null);
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({ disagreements: [review()] }) });
  expect(out).toMatchObject({ raised: false, reason: 'alert_not_persisted', disagreements: 1 });
});

test('no rows: every standing review item is closed as labeled', async () => {
  mockOpenKeys.mockResolvedValueOnce(['typed-decisions-review:2026-09-30']);
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({}) });
  expect(out).toEqual({ raised: false, reason: 'no_rows' });
  expect(mockCloseKeys).toHaveBeenCalledWith(expect.anything(), ['typed-decisions-review:2026-09-30'], 'reviews_labeled', expect.objectContaining({ resolution: 'All queued AI decisions are labeled' }));
});

test('raising today\'s item closes earlier days\' items, never today\'s', async () => {
  mockOpenKeys.mockResolvedValueOnce(['typed-decisions-review:2026-09-30', 'typed-decisions-review:2026-10-01']);
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({ disagreements: [review()] }) });
  expect(mockCloseKeys).toHaveBeenCalledWith(expect.anything(), ['typed-decisions-review:2026-09-30'], 'superseded', expect.anything());
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
    area: 'System', action: 'review 1 AI decision', why: '1 disagreement, 0 spot checks · AI vs rules/judge', severity: 'needs-you',
    link: LINK, subject: { type: 'check', id: 'typed-decisions-review' }, doneWhen: 'reviews_labeled', who: 'person',
  })).not.toThrow();
});

test('describeRow carries ids and answers only', () => {
  const line = describeRow(review({ baseline_answers: JSON.stringify({ rules: true }) }));
  expect(line).toBe('call_judge is_spam: Jev yes (p 0.93) vs rules yes');
});

test('a row is described by the provider that answered it: a Clef row never reads as Jev (Codex r1 on #5555)', () => {
  const { describeRow } = require('../services/typed-decisions/daily-review-item');
  const row = { capability: 'sms_courtesy', question_id: 'is_courtesy_only', jev_answer: JSON.stringify({ p: 0.2, yes: false, confident: false }), baseline_answers: JSON.stringify({ rules: true }) };
  expect(describeRow({ ...row, provider: 'cloudflare' })).toBe('sms_courtesy is_courtesy_only: Clef no (p 0.20) vs rules yes');
  expect(describeRow({ ...row, provider: 'typesafe' })).toBe('sms_courtesy is_courtesy_only: Jev no (p 0.20) vs rules yes');
  expect(describeRow(row)).toBe('sms_courtesy is_courtesy_only: Jev no (p 0.20) vs rules yes'); // rows from before the column
});

