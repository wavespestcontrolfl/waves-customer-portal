// Daily AI-test list: no rows -> nothing; rows -> ONE FYI row in plain words with the counts,
// a per-day dedupe key, brevity-guard-safe copy, one line per case with answers only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockNotify = jest.fn();
const mockOpenKeys = jest.fn(async () => []);
const mockCloseKeys = jest.fn(async () => 1);
jest.mock('../services/admin-alert-episodes', () => ({ openAdminAlertKeys: (...a) => mockOpenKeys(...a), closeAdminAlertKeys: (...a) => mockCloseKeys(...a) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

const { runDailyReviewItem, describeCase, LINK } = require('../services/typed-decisions/daily-review-item');

const original = process.env.GATE_TYPED_DECISIONS;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TYPED_DECISIONS = 'true';
  mockNotify.mockResolvedValue({ id: 'n1' });
});
afterAll(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });

const review = (over = {}) => ({
  id: 'r', provider: 'typesafe', capability: 'call_judge', package_id: 'call_judge.v5', subject_type: 'call', subject_id: 'call-1',
  question_id: 'is_spam', created_at: new Date('2026-09-30T20:00:00Z'),
  jev_answer: JSON.stringify({ p: 0.93, yes: true, confident: true }),
  baseline_answers: JSON.stringify({ production: false, deep_judge: false }),
  ...over,
});

// A conn that answers a cohort read by the sampled_for it asked for, and the case read
// (every test AI's answer to the listed cases) with `answers`.
function conn({ disagreements = [], audits = [], answers = [] } = {}) {
  const seen = [];
  const caseReads = [];
  const make = () => {
    const state = { where: [], limit: null, calls: [], cases: null };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          const out = state.cases ? answers : (state.where.some((w) => w.sampled_for === 'disagreement') ? disagreements : audits);
          return (res, rej) => Promise.resolve(out).then(res, rej);
        }
        return (...args) => {
          state.calls.push([prop, args]);
          if (prop === 'where' && typeof args[0] === 'function') {
            state.cases = [];
            const q = { orWhere: (match) => { state.cases.push(match); return q; } };
            args[0](q);
            caseReads.push(state);
          } else if (prop === 'where') {
            state.where.push(...args.filter((a) => a && typeof a === 'object'), ...(typeof args[0] === 'string' ? [{ [args[0]]: args[args.length - 1] }] : []));
          }
          if (prop === 'limit') state.limit = args[0];
          if (prop === 'select' && !state.cases) seen.push(state);
          return b;
        };
      },
    });
    return b;
  };
  const c = () => make();
  c.seen = seen;
  c.caseReads = caseReads;
  return c;
}

const detailLines = (opts, prefix) => opts.detail.split('\n').filter((l) => l.startsWith(prefix));

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

test('rows: ONE FYI row for Claude (never needs-you), in plain words, one line per case', async () => {
  const c = conn({
    disagreements: [review(), review({ id: 'r2', subject_id: 'call-2', question_id: 'quote_promised' })],
    audits: [review({ id: 'r3', subject_id: 'call-3', question_id: 'complaint' })],
  });
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c });
  expect(out).toMatchObject({ raised: true, disagreements: 2, spotChecks: 1 });
  expect(mockNotify).toHaveBeenCalledTimes(1);
  const [category, title, body, opts] = mockNotify.mock.calls[0];
  expect(category).toBe('typed_decisions');
  expect(title).toBe('System — check 3 cases from the AI test');
  expect(body).toBe('2 with different answers and 1 random check; nothing acts on the test answers.');
  expect(opts.link).toBe(LINK);
  expect(LINK).toBe('/admin/agents?tab=typed');
  // fyi + who claude: admin-alert-routing.js puts the row in Claude's queue; an FYI never rings on a refresh.
  expect(opts.metadata).toMatchObject({ area: 'System', severity: 'fyi', doneWhen: 'reviews_labeled', who: 'claude', subject: { type: 'check', id: 'typed-decisions-review' } });
  expect(opts.ringOnRefresh()).toBe(false);
  expect(opts.detail).toContain('Answers differ: Was the call spam, a robocall or a sales pitch? Jev yes (93% sure). Live system no, Claude\'s check no.');
  expect(detailLines(opts, 'Answers differ')).toHaveLength(2);
  expect(detailLines(opts, 'Random check')).toEqual(['Random check: Did the caller complain about our service? Jev yes (93% sure). Live system no, Claude\'s check no.']);
  // Plain words: no capability or question ids, no raw probabilities.
  expect(opts.detail).not.toMatch(/\b[a-z]+_[a-z_]+\b|p 0\./);
});

test('one case, one line: both test AIs\' answers, read for the listed cases whether labeled or not', async () => {
  // Clef matches the live answer here: the case is listed because Jev (already labeled) answered differently.
  const clef = review({ id: 'k1', provider: 'cloudflare', capability: 'call_gate_checks', package_id: 'call_gate_checks.v1', subject_id: 'call-9', question_id: 'promise_open', jev_answer: JSON.stringify({ p: 0.6, yes: true }), baseline_answers: JSON.stringify({ production: true }) });
  const jev = { ...clef, id: 'k2', provider: 'typesafe', jev_answer: JSON.stringify({ p: 0.28, yes: false }) };
  const c = conn({ disagreements: [clef, { ...clef, id: 'k1-copy' }], answers: [clef, jev] });
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c });
  expect(out).toMatchObject({ raised: true, disagreements: 1, spotChecks: 0 });
  const [, title, body, opts] = mockNotify.mock.calls[0];
  expect(title).toBe('System — check 1 case from the AI test');
  expect(body).toBe('1 with different answers; nothing acts on the test answers.');
  expect(detailLines(opts, 'Answers differ')).toEqual(['Answers differ: Did staff promise a callback, a quote or a visit time? Jev no (72% sure), Clef yes (60% sure). Live system yes.']);
  // The case read names the case by its subject key, never by one provider's row.
  expect(c.caseReads).toHaveLength(1);
  expect(c.caseReads[0].cases).toEqual([{ capability: 'call_gate_checks', package_id: 'call_gate_checks.v1', subject_type: 'call', subject_id: 'call-9', question_id: 'promise_open' }]);
});

test('caps: 8 cases with different answers and 2 random checks, still unreviewed, from the last 14 days (not one calendar day)', async () => {
  const c = conn({ disagreements: [review()], audits: [review({ subject_id: 'call-2' })] });
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c });
  // One read per capability and cohort; room for each test AI's row of every case it may list.
  expect([...new Set(c.seen.map((s) => s.limit))].sort((a, b) => a - b)).toEqual([4, 16]);
  for (const state of c.seen) {
    expect(state.calls).toContainEqual(['where', [expect.objectContaining({ label_status: 'unreviewed' })]]);
    expect(state.calls).toContainEqual(['where', ['created_at', '>=', new Date('2026-09-17T04:00:00.000Z')]]);
    // no upper bound: a failed day, or a row a later re-record made a disagreement, is still raised
    expect(state.calls.some(([m, a]) => m === 'where' && a[0] === 'created_at' && a[1] === '<')).toBe(false);
  }
  expect([...new Set(c.seen.map((s) => s.calls.find(([m]) => m === 'where')[1][0].sampled_for))].sort()).toEqual(['disagreement', 'random_audit']);
});

test('a notification that was not persisted is a failed run, not "raised"', async () => {
  mockNotify.mockResolvedValue(null);
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({ disagreements: [review()] }) });
  expect(out).toMatchObject({ raised: false, reason: 'alert_not_persisted', disagreements: 1 });
});

test('no rows: every standing review row is closed as graded', async () => {
  mockOpenKeys.mockResolvedValueOnce(['typed-decisions-review:2026-09-30']);
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({}) });
  expect(out).toEqual({ raised: false, reason: 'no_rows' });
  expect(mockCloseKeys).toHaveBeenCalledWith(expect.anything(), ['typed-decisions-review:2026-09-30'], 'reviews_labeled', expect.objectContaining({ resolution: 'Every case from the AI test is graded' }));
});

test('raising today\'s row closes earlier days\' rows, never today\'s', async () => {
  mockOpenKeys.mockResolvedValueOnce(['typed-decisions-review:2026-09-30', 'typed-decisions-review:2026-10-01']);
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({ disagreements: [review()] }) });
  expect(mockCloseKeys).toHaveBeenCalledWith(expect.anything(), ['typed-decisions-review:2026-09-30'], 'superseded', expect.objectContaining({ resolution: 'Replaced by a newer list' }));
});

test('the dedupe key is per ET day, so each day raises its own row', async () => {
  const c = () => conn({ disagreements: [review()] });
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c() });
  await runDailyReviewItem({ now: new Date('2026-10-02T12:05:00Z'), conn: c() });
  expect(mockNotify.mock.calls[0][3].dedupeKey).toBe('typed-decisions-review:2026-10-01');
  expect(mockNotify.mock.calls[1][3].dedupeKey).toBe('typed-decisions-review:2026-10-02');
  expect(mockNotify.mock.calls[0][3].refreshOnDedupe).toBe(true);
});

test('random checks alone read in the singular and still pass the admin-alert rule', async () => {
  // NODE_ENV=test: raiseAdminAlert throws on any rule violation, so a raised row passed it.
  await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: conn({ audits: [review()] }) });
  expect(mockNotify.mock.calls[0][1]).toBe('System — check 1 case from the AI test');
  expect(mockNotify.mock.calls[0][2]).toBe('1 random check; nothing acts on the test answers.');
});

test('describeCase: how sure each test AI is of the answer it gave, and the live answers by plain name', () => {
  const row = { capability: 'sms_courtesy', question_id: 'is_courtesy_only', jev_answer: JSON.stringify({ p: 0.2, yes: false, confident: false }), baseline_answers: JSON.stringify({ rules: true }) };
  expect(describeCase({ ...row, provider: 'cloudflare' })).toBe('Was the text only a thank-you or an OK? Clef no (80% sure). Live rules yes.');
  expect(describeCase({ ...row, provider: 'typesafe', baseline_answers: JSON.stringify({}) })).toBe('Was the text only a thank-you or an OK? Jev no (80% sure). No live answer.');
  // The live system is named first whatever order the row stored its answers in.
  expect(describeCase({ ...row, provider: 'typesafe', baseline_answers: JSON.stringify({ deep_judge: true, production: false }) })).toBe('Was the text only a thank-you or an OK? Jev no (80% sure). Live system no, Claude\'s check yes.');
  // A question this list does not know yet reads as its ids, never as nothing.
  expect(describeCase({ ...row, provider: 'typesafe', capability: 'new_lane', question_id: 'is_new' })).toBe('new lane: is new? Jev no (80% sure). Live rules yes.');
});

test('a row is described by the provider that answered it: a Clef row never reads as Jev (Codex r1 on #5555)', () => {
  const row = { capability: 'sms_courtesy', question_id: 'is_courtesy_only', jev_answer: JSON.stringify({ p: 0.2, yes: false, confident: false }), baseline_answers: JSON.stringify({ rules: true }) };
  expect(describeCase({ ...row, provider: 'cloudflare' })).toContain('Clef no');
  expect(describeCase({ ...row, provider: 'typesafe' })).toContain('Jev no');
  // provider is NOT NULL on the table: a row without one is malformed and is refused, never described as Jev's (Codex r8)
  expect(() => describeCase(row)).toThrow(/unknown decision provider/);
});

test('capabilities take turns: a lane with many rows never takes every slot', async () => {
  // A conn that answers by capability: twelve visit cases (newest), two call cases.
  const byCapability = {
    visit_access: Array.from({ length: 12 }, (_, i) => review({ id: `v${i}`, capability: 'visit_access', package_id: 'visit_access.v1', subject_type: 'visit', subject_id: `visit-${i}`, question_id: 'dog_on_property', created_at: new Date(Date.parse('2026-10-01T11:00:00Z') - i * 1000) })),
    call_judge: [review({ id: 'c0', created_at: new Date('2026-09-30T08:00:00Z') }), review({ id: 'c1', subject_id: 'call-2', question_id: 'complaint', created_at: new Date('2026-09-29T08:00:00Z') })],
  };
  const c = () => {
    const where = {};
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(where.sampled_for === 'disagreement' ? (byCapability[where.capability] || []).slice(0, where.limit) : []).then(res, rej);
        return (...args) => {
          if (prop === 'where' && args[0] && typeof args[0] === 'object') Object.assign(where, args[0]);
          if (prop === 'limit') where.limit = args[0];
          return b;
        };
      },
    });
    return b;
  };
  const out = await runDailyReviewItem({ now: new Date('2026-10-01T12:05:00Z'), conn: c });
  expect(out).toMatchObject({ raised: true, disagreements: 8 });
  const lines = detailLines(mockNotify.mock.calls[0][3], 'Answers differ');
  expect(lines).toHaveLength(8);
  // Both call cases are in, beside six visit cases; the newest lane leads.
  const visit = (l) => l.includes('Is there a dog');
  expect(lines.filter((l) => !visit(l))).toHaveLength(2);
  expect(lines.filter(visit)).toHaveLength(6);
  expect(visit(lines[0])).toBe(true);
  expect(lines[1]).toContain('Was the call spam');
});
