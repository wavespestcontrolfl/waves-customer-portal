/**
 * Annual rate review — ranking backend (services/rate-review.js).
 *
 * Pure math first (bands, caps, min delta, the one-band $/hr nudge, trimmed
 * median, the interaction-based treatment minutes), then each exception
 * rule, the lane handling, the anniversary choice, the gate-off no-ops and
 * one end-to-end batch over the synthetic December book in
 * helpers/rate-review-fixture.js (every number there is invented).
 */
process.env.GATE_RATE_REVIEW = 'true';
// The plan-rate ledger is ON in prod (pre-read 2026-09-30); the monthly lane
// reads family slices through it, so the suite pins that posture.
process.env.GATE_PLAN_RATE_LEDGER = 'true';

const mockFacts = jest.fn();
const mockCoveredTerms = jest.fn();

jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('rate-review tests must inject a scripted db'); });
  fn.raw = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/cancellation-resolution/facts', () => ({ loadCancellationFacts: (...args) => mockFacts(...args) }));
jest.mock('../services/annual-prepay-renewals', () => ({ coveredTermsAsOf: (...args) => mockCoveredTerms(...args) }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => true, sendOne: jest.fn(async () => ({ ok: true })) }));

const db = require('../models/db');
const fixture = require('./helpers/rate-review-fixture');
const rateReview = require('../services/rate-review');

const { DEFAULT_CONFIG, _private: P } = rateReview;
const { NOW } = fixture;

afterEach(() => {
  process.env.GATE_RATE_REVIEW = 'true';
  jest.clearAllMocks();
});

// ── band math ───────────────────────────────────────────────────────────

describe('classifyBand — whole dollars per application, never a cut', () => {
  const cases = [
    // [label, current, list, expectBand, expectProposed, expectDelta, noChange, flags]
    ['A: at or above list → $0', 12500, 11700, 'A', 12500, 0, true, []],
    ['A: exactly at list → $0', 11700, 11700, 'A', 11700, 0, true, []],
    ['B: 3.4% under → 3.5% pass-through, rounded to whole dollars', 11300, 11700, 'B', 11700, 400, false, []],
    ['B: 5% under is still B (boundary)', 11115, 11700, 'B', 11500, 385, false, []],
    ['C: 9.8% under → to list', 5500, 6100, 'C', 6100, 600, false, []],
    ['C: list with cents rounds to whole dollars', 10800, 11733, 'C', 11700, 900, false, []],
    ['D: 11.1% under → capped step of min(12%, $15), floored to whole dollars', 10400, 11700, 'D', 11600, 1200, false, ['capped']],
    ['D: big-ticket account hits the $15 cap, not 12%', 30000, 40000, 'D', 31500, 1500, false, ['capped']],
    ['min delta: a $2 pass-through on a $70 line is no change', 7000, 7200, 'B', 7000, 0, true, ['below_min_delta']],
  ];
  test.each(cases)('%s', (_label, current, list, band, proposed, delta, noChange, flags) => {
    const out = P.classifyBand({ currentCents: current, listCents: list });
    expect(out.band).toBe(band);
    expect(out.proposedCents).toBe(proposed);
    expect(out.deltaCents).toBe(delta);
    expect(out.noChange).toBe(noChange);
    for (const flag of flags) expect(out.flags).toContain(flag);
    expect(out.proposedCents).toBeGreaterThanOrEqual(current);
    expect(out.proposedCents % 100).toBe(0);
  });

  test('a B pass-through that rounds past the cap is capped and flagged', () => {
    const out = P.classifyBand({ currentCents: 11300, listCents: 11700, config: { ...DEFAULT_CONFIG, pass_through_pct: 15 } });
    // 15% of $113 = $16.95 → cap min(12% = $13.56, $15) = $13.56 → floor → $126
    expect(out.proposedCents).toBe(12600);
    expect(out.flags).toContain('capped');
  });

  test('no list rate → no band, no change, flagged', () => {
    const out = P.classifyBand({ currentCents: 11700, listCents: null });
    expect(out).toMatchObject({ band: null, proposedCents: 11700, deltaCents: 0, noChange: true, flags: ['no_list_rate'] });
  });

  test('config caps and tolerances are honoured', () => {
    const config = { ...DEFAULT_CONFIG, band_b_tolerance_pct: 2, band_c_max_pct: 6, cap_pct: 5, cap_cents: 400 };
    // 3.4% under: beyond a 2% tolerance → C → to list $117, but cap = min(5% × 113 = 5.65, $4) = $4 → $117 exceeds → $117? floor(113 + 4) = $117
    expect(P.classifyBand({ currentCents: 11300, listCents: 11700, config })).toMatchObject({ band: 'C', proposedCents: 11700, deltaCents: 400 });
    // 11.1% under with a 6% C ceiling → D → floor(104 + min(5.2, 4)) = $108
    expect(P.classifyBand({ currentCents: 10400, listCents: 11700, config })).toMatchObject({ band: 'D', proposedCents: 10800, deltaCents: 400 });
  });
});

describe('revenue per hour moves an account ONE band and never sets D', () => {
  const lineRph = { q1: 10000, median: 15000, q3: 20000, n: 8 };
  test('A → B when $/hr is below the line median (the A definition)', () => {
    const out = P.classifyBand({ currentCents: 12500, listCents: 11700, rph: 14000, lineRph, usableVisits: 3 });
    expect(out.band).toBe('B');
    expect(out.flags).toContain('rph_below_line_median');
    expect(out.deltaCents).toBe(400); // round(125 × 1.035 = 129.375) = $129
  });
  test('A stays A at or above the line median', () => {
    expect(P.classifyBand({ currentCents: 12500, listCents: 11700, rph: 15000, lineRph, usableVisits: 3 }).band).toBe('A');
  });
  test('B → C on bottom-quartile $/hr', () => {
    const out = P.classifyBand({ currentCents: 11300, listCents: 11700, rph: 9000, lineRph, usableVisits: 4 });
    expect(out.band).toBe('C');
    expect(out.flags).toContain('rph_bottom_quartile');
    expect(out.proposedCents).toBe(11700);
  });
  test('C never becomes D on $/hr alone', () => {
    const out = P.classifyBand({ currentCents: 10800, listCents: 11700, rph: 5000, lineRph, usableVisits: 5 });
    expect(out.band).toBe('C');
  });
  test('C → B on top-quartile $/hr', () => {
    const out = P.classifyBand({ currentCents: 10800, listCents: 11700, rph: 22000, lineRph, usableVisits: 3 });
    expect(out.band).toBe('B');
    expect(out.flags).toContain('rph_top_quartile');
  });
  test('fewer than min_usable_visits → no nudge at all', () => {
    expect(P.classifyBand({ currentCents: 12500, listCents: 11700, rph: 5000, lineRph, usableVisits: 2 }).band).toBe('A');
  });
  test('a line with fewer than 4 accounts carrying $/hr has no quartiles → no nudge', () => {
    expect(P.classifyBand({ currentCents: 12500, listCents: 11700, rph: 5000, lineRph: { ...lineRph, n: 3 }, usableVisits: 5 }).band).toBe('A');
    expect(P.MIN_LINE_RPH_SAMPLE).toBe(4);
  });
  test('a null $/hr never nudges', () => {
    expect(P.classifyBand({ currentCents: 12500, listCents: 11700, rph: null, lineRph, usableVisits: 9 }).band).toBe('A');
  });
});

// ── minutes ─────────────────────────────────────────────────────────────

describe('trimmed median and the usable-visit floor', () => {
  test('median of fewer than 4 keeps every value', () => {
    expect(P.trimmedMedian([30, 50, 40])).toBe(40);
    expect(P.trimmedMedian([30, 50])).toBe(40);
    expect(P.trimmedMedian([])).toBeNull();
  });
  test('drops the single longest visit once there are 4 or more', () => {
    expect(P.trimmedMedian([30, 35, 40, 120])).toBe(35); // 120 dropped → median of 30/35/40
    expect(P.trimmedMedian([30, 35, 40, 45, 120])).toBe(37.5); // 120 dropped → median of 30/35/40/45
  });
  test('wall minutes exclude ≤ 0 and > 240', () => {
    const base = fixture.visit('c', 'pest_control', { minutes: 45 });
    expect(P.wallMinutesFor(base)).toBe(45);
    expect(P.wallMinutesFor(fixture.visit('c', 'pest_control', { minutes: 0 }))).toBeNull();
    expect(P.wallMinutesFor(fixture.visit('c', 'pest_control', { minutes: -20 }))).toBeNull();
    expect(P.wallMinutesFor(fixture.visit('c', 'pest_control', { minutes: 241 }))).toBeNull();
    expect(P.wallMinutesFor(fixture.visit('c', 'pest_control', { minutes: 240 }))).toBe(240);
  });
  test('revenue per hour needs min_usable_visits usable AND paired visits', () => {
    const two = [fixture.visit('c', 'pest_control', { minutes: 40, revenue: 117 }), fixture.visit('c', 'pest_control', { minutes: 50, revenue: 117 })];
    expect(P.lineDurationStats(two).revenuePerHourCents).toBeNull();
    expect(P.lineDurationStats(two).usableVisits).toBe(2);
    const three = [...two, fixture.visit('c', 'pest_control', { minutes: 60, revenue: 117 })];
    expect(P.lineDurationStats(three).revenuePerHourCents).toBe(Math.round((351 * 100) / (150 / 60)));
    const unpaid = [...two, fixture.visit('c', 'pest_control', { minutes: 60, revenue: null })];
    expect(P.lineDurationStats(unpaid).usableVisits).toBe(3);
    expect(P.lineDurationStats(unpaid).revenuePerHourCents).toBeNull();
  });
  test('a prepay-covered visit earns the term\'s SETTLED share; a refunded, unpaid or invoice-less term earns nothing', () => {
    // $404 term, 4 covered visits, fully settled → $101 per visit
    expect(P.visitRevenueCents(fixture.visit('c', 'pest_control', { minutes: 40, prepay: { id: 't1', settled: 404, visits: 4 } }))).toBe(10100);
    // $100 refunded off the same term → $76 per visit
    expect(P.visitRevenueCents(fixture.visit('c', 'pest_control', { minutes: 40, prepay: { id: 't1', settled: 304, visits: 4 } }))).toBe(7600);
    // reversed / unpaid / no prepay invoice → settlement unknown → no revenue, never the charged amount
    expect(P.visitRevenueCents(fixture.visit('c', 'pest_control', { minutes: 40, prepay: { id: 't1', settled: null, visits: 4 } }))).toBeNull();
    expect(P.visitRevenueCents(fixture.visit('c', 'pest_control', { minutes: 40, prepay: { id: 't1', settled: 0, visits: 4 } }))).toBeNull();
    // a paid visit invoice still wins over the term share
    const both = fixture.visit('c', 'pest_control', { minutes: 40, revenue: 117, prepay: { id: 't1', settled: 404, visits: 4 } });
    expect(P.visitRevenueCents(both)).toBe(11700);
    // a term from before coverage_visit_count existed infers the count from the line's cadence / catalog count, as resolveCurrentRate does
    const legacy = fixture.visit('c', 'pest_control', { minutes: 40, prepay: { id: 't0', settled: 404, visits: null } });
    expect(P.visitRevenueCents(legacy)).toBeNull();
    expect(P.visitRevenueCents(legacy, { termVisitsFallback: 4 })).toBe(10100);
    expect(P.lineDurationStats([40, 42, 44].map((m) => fixture.visit('c', 'pest_control', { minutes: m, interaction: 'not_home_full_access', prepay: { id: 't0', settled: 404, visits: null } })), { termVisitsFallback: 4 }).revenuePerHourCents).toBe(P.lineDurationStats([40, 42, 44].map((m) => fixture.visit('c', 'pest_control', { minutes: m, interaction: 'not_home_full_access', revenue: 101 }))).revenuePerHourCents);
    // the SQL never reads the charged stamps
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    const q = src.slice(src.indexOf('async function loadCompletedVisitRows'), src.indexOf('async function loadEstimates'));
    expect(q).toMatch(/AS term_settled_amount/);
    expect(q).toMatch(/pi\.id = apt\.prepay_invoice_id/);
    expect(q).not.toMatch(/prepaid_amount|term_prepay_amount/);
    // the settled share is COVERAGE money (the term's prepay_amount), capped by what settled — a setup line on the prepay invoice never counts
    expect(q).toMatch(/LEAST\(apt\.prepay_amount, pi\.total - COALESCE/);
    // a combined setup + application invoice keeps its application lines; a pure setup invoice contributes nothing
    expect(q).toMatch(/jsonb_array_elements\(i\.line_items::jsonb\) li/);
    expect(q).toMatch(/COALESCE\(li ->> 'name', li ->> 'description', ''\) ILIKE '%setup%'/);
    expect(q).toMatch(/jsonb_typeof\(COALESCE\(i\.line_items::jsonb, 'null'::jsonb\)\) = 'array'/);
    expect(q).not.toMatch(/AND NOT \(COALESCE\(i\.title, ''\) ILIKE '%setup%'/);
    // and $/hr follows: three settled prepay visits rank, three refunded ones leave $/hr unavailable
    const settled = [40, 42, 44].map((m) => fixture.visit('c', 'pest_control', { minutes: m, interaction: 'not_home_full_access', prepay: { id: 't1', settled: 404, visits: 4 } }));
    expect(P.lineDurationStats(settled).revenuePerHourCents).toBe(Math.round((303 * 100) / (126 / 60)));
    const refunded = settled.map((v) => ({ ...v, term_settled_amount: null }));
    expect(P.lineDurationStats(refunded).revenuePerHourCents).toBeNull();
    expect(P.lineDurationStats(refunded).usableVisits).toBe(3);
  });
  test('the longest paired visit is dropped from $/hr once ≥ 4 are usable', () => {
    const rows = [40, 45, 50, 200].map((m) => fixture.visit('c', 'pest_control', { minutes: m, revenue: 100 }));
    const stats = P.lineDurationStats(rows);
    expect(stats.treatmentMinutesMedian).toBe(45);
    expect(stats.revenuePerHourCents).toBe(Math.round((300 * 100) / (135 / 60)));
  });
});

describe('treatment minutes from the customer_interaction flag', () => {
  test('line allowance = median home wall − median not-home wall, floored at 0 and capped at 25', () => {
    const home = (m) => fixture.visit('x', 'pest_control', { minutes: m, interaction: 'tech_home_spoke_with_them' });
    const away = (m) => fixture.visit('x', 'pest_control', { minutes: m, interaction: 'not_home_full_access' });
    const rows = [home(50), home(55), home(60), away(35), away(38), away(40)];
    const allowances = P.computeLineAllowances(rows);
    expect(allowances.pest_control).toMatchObject({ allowance_minutes: 17, home_median: 55, not_home_median: 38, home_n: 3, not_home_n: 3, source: 'line' });
    // floor at 0 when home visits are shorter
    const floored = P.computeLineAllowances([home(30), home(31), home(32), away(40), away(41), away(42)]);
    expect(floored.pest_control.allowance_minutes).toBe(0);
    // cap at 25
    const capped = P.computeLineAllowances([home(90), home(95), home(100), away(30), away(31), away(32)]);
    expect(capped.pest_control.allowance_minutes).toBe(25);
  });
  test('a line without enough visits on both sides takes the pooled allowance, else 0', () => {
    const home = (line, m) => fixture.visit('x', line, { minutes: m, interaction: 'tech_home_spoke_with_them' });
    const away = (line, m) => fixture.visit('x', line, { minutes: m, interaction: 'not_home_full_access' });
    const rows = [home('pest_control', 50), home('pest_control', 55), home('pest_control', 60), away('pest_control', 35), away('pest_control', 38), away('pest_control', 40), home('lawn_care', 52)];
    const allowances = P.computeLineAllowances(rows);
    expect(allowances.pest_control).toMatchObject({ allowance_minutes: 17, source: 'line' });
    // pooled: home 50/55/60/52 (median 53.5) − not-home 35/38/40 (median 38) = 15.5
    expect(allowances.lawn_care).toMatchObject({ allowance_minutes: 15.5, source: 'pooled' });
    expect(allowances.tree_shrub).toMatchObject({ allowance_minutes: 15.5, source: 'pooled' });
    expect(P.computeLineAllowances([]).mosquito).toMatchObject({ allowance_minutes: 0, source: 'none' });
    expect(P.allowanceFor(allowances, 'tree_shrub')).toBe(15.5);
    expect(P.allowanceFor(allowances, 'pest_control')).toBe(17);
    expect(P.allowanceFor(null, 'pest_control')).toBe(0);
  });
  test('per-visit adjustment by interaction value', () => {
    const allowance = 19.5;
    const away = fixture.visit('x', 'pest_control', { minutes: 35, interaction: 'not_home_full_access' });
    expect(P.treatmentMinutesFor(away, allowance)).toMatchObject({ wall: 35, treatment: 35, interaction: 'not_home', adjustment: 'none' });
    const home = fixture.visit('x', 'pest_control', { minutes: 54, interaction: 'tech_home_spoke_with_them' });
    expect(P.treatmentMinutesFor(home, allowance)).toMatchObject({ wall: 54, treatment: 34.5, interaction: 'home', adjustment: 'allowance', subtracted: 19.5 });
    const shortHome = fixture.visit('x', 'pest_control', { minutes: 20, interaction: 'tech_home_spoke_with_them' });
    expect(P.treatmentMinutesFor(shortHome, allowance).treatment).toBe(P.MIN_TREATMENT_MINUTES); // floored at 10
    const unknown = fixture.visit('x', 'pest_control', { minutes: 45, interaction: null });
    expect(P.treatmentMinutesFor(unknown, allowance)).toMatchObject({ treatment: 45, interaction: 'unknown', lowConfidence: true });
    expect(P.treatmentMinutesFor(fixture.visit('x', 'pest_control', { minutes: 0 }), allowance)).toBeNull();
  });
  test('an account with ≥ min_usable_visits not-home visits gets $/hr from those alone', () => {
    const away = (m) => fixture.visit('x', 'pest_control', { minutes: m, interaction: 'not_home_full_access', revenue: 117 });
    const home = (m) => fixture.visit('x', 'pest_control', { minutes: m, interaction: 'tech_home_spoke_with_them', revenue: 117 });
    const stats = P.lineDurationStats([away(40), away(42), away(44), home(70)], { allowanceMinutes: 19.5 });
    expect(stats.rphFromNotHome).toBe(true);
    expect(stats.notHomeVisits).toBe(3);
    expect(stats.homeVisits).toBe(1);
    expect(stats.revenuePerHourCents).toBe(Math.round((351 * 100) / (126 / 60)));
    // median still describes every usable visit (home one at 70 − 19.5 = 50.5; 4 usable → longest dropped)
    expect(stats.treatmentMinutesMedian).toBe(42);
    expect(stats.allowanceMinutesApplied).toBe(19.5);
    // with only 2 not-home visits, every paired visit counts (allowance applied to the home ones)
    const mixed = P.lineDurationStats([away(40), away(42), home(70)], { allowanceMinutes: 19.5 });
    expect(mixed.rphFromNotHome).toBe(false);
    expect(mixed.revenuePerHourCents).toBe(Math.round((351 * 100) / ((40 + 42 + 50.5) / 60)));
  });
  test('settled dues per application: the customer\'s settled dues × the family\'s ledger share ÷ completed visits, never today\'s rate', () => {
    const ledger = new Map([['c|pest_control', { family_key: 'pest_control', monthly_rate: 40 }], ['c|lawn_care', { family_key: 'lawn_care', monthly_rate: 60 }]]);
    // $1,000 settled over the lookback, pest is 40% of the dues, 4 completed pest visits → $100 per application
    expect(P.duesPerVisitCents({ settledCents: 100000, ledger, customerId: 'c', familyKey: 'pest_control', accountLines: 2, completedVisits: 4 })).toBe(10000);
    // single-line account with no ledger row → the whole settled amount is the line's
    expect(P.duesPerVisitCents({ settledCents: 46800, ledger: new Map(), customerId: 'c', familyKey: 'pest_control', accountLines: 1, completedVisits: 4 })).toBe(11700);
    // multi-line account with no attribution, nothing settled, or nothing completed → unavailable
    expect(P.duesPerVisitCents({ settledCents: 46800, ledger: new Map(), customerId: 'c', familyKey: 'pest_control', accountLines: 2, completedVisits: 4 })).toBeNull();
    expect(P.duesPerVisitCents({ settledCents: 0, ledger, customerId: 'c', familyKey: 'pest_control', accountLines: 2, completedVisits: 4 })).toBeNull();
    expect(P.duesPerVisitCents({ settledCents: 100000, ledger, customerId: 'c', familyKey: 'pest_control', accountLines: 2, completedVisits: 0 })).toBeNull();
  });
  test('a monthly member\'s visits carry no invoice: settled dues are attributed per application for $/hr', () => {
    const away = (m) => fixture.visit('x', 'pest_control', { minutes: m, interaction: 'not_home_full_access', revenue: null });
    const noDues = P.lineDurationStats([away(40), away(42), away(44)]);
    expect(noDues.revenuePerHourCents).toBeNull();
    // $39/mo quarterly → $117 per application
    const dues = P.lineDurationStats([away(40), away(42), away(44)], { duesRevenueCents: 11700 });
    expect(dues.revenuePerHourCents).toBe(Math.round((351 * 100) / (126 / 60)));
    expect(dues.rphFromNotHome).toBe(true);
    expect(dues.duesAttributedVisits).toBe(3);
    // a visit with its own paid invoice keeps it; dues fill only the gaps
    const mixed = P.lineDurationStats([away(40), away(42), fixture.visit('x', 'pest_control', { minutes: 44, interaction: 'not_home_full_access', revenue: 150 })], { duesRevenueCents: 11700 });
    expect(mixed.revenuePerHourCents).toBe(Math.round(((117 + 117 + 150) * 100) / (126 / 60)));
    expect(mixed.duesAttributedVisits).toBe(2);
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'pest_control', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'monthly_membership', anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 3900, rateUnit: 'month', listRateCents: 3900, usableVisits: 3, revenuePerHourCents: dues.revenuePerHourCents, duesAttributedVisits: 3, facts: fixture.facts() });
    expect(row.flags).toContain('rph_from_dues');
  });
  test('captured conversation minutes (future Fast Complete field) replace the allowance', () => {
    const row = fixture.visit('x', 'pest_control', { minutes: 54, interaction: 'tech_home_spoke_with_them' });
    row.service_record_structured_notes = JSON.stringify({ conversationMinutes: 8 });
    expect(P.conversationMinutesFor(row)).toBe(8);
    expect(P.treatmentMinutesFor(row, 19.5)).toMatchObject({ treatment: 46, adjustment: 'captured', subtracted: 8 });
    const snake = fixture.visit('x', 'pest_control', { minutes: 54, interaction: null });
    snake.service_record_structured_notes = { conversation_minutes: 50 };
    expect(P.treatmentMinutesFor(snake, 19.5).treatment).toBe(P.MIN_TREATMENT_MINUTES);
    const stats = P.lineDurationStats([row], { allowanceMinutes: 19.5 });
    expect(stats.capturedConversationVisits).toBe(1);
    expect(stats.allowanceMinutesApplied).toBeNull();
    expect(P.conversationMinutesFor(fixture.visit('x', 'pest_control', { minutes: 30 }))).toBeNull();
  });
  test('the wall-clock ladder is reused as-is: an admin correction outranks the span, a grouped allocation of 0 is unusable', () => {
    const corrected = fixture.visit('x', 'pest_control', { minutes: 80, interaction: 'not_home_full_access' });
    corrected.service_time_minutes = 35;
    expect(P.wallMinutesFor(corrected)).toBe(35);
    const allocated = fixture.visit('x', 'pest_control', { minutes: 80 });
    allocated.service_record_structured_notes = JSON.stringify({ visitDurationAllocation: { version: 1, allocatedMinutes: 0 } });
    expect(P.wallMinutesFor(allocated)).toBeNull();
  });
});

// ── exceptions ──────────────────────────────────────────────────────────

describe('exception rules', () => {
  const base = () => ({
    familyKey: 'pest_control', billingLane: 'per_application', anniversaryDate: '2025-01-10', tenureMonths: 21,
    facts: fixture.facts(),
  });
  const cases = [
    ['tenure under the lock', { tenureMonths: 11 }, 'tenure_under_lock'],
    ['no anniversary at all', { anniversaryDate: null }, 'no_anniversary'],
    ['prepay mid-term', { prepayMidTerm: true }, 'prepay_mid_term'],
    ['annual_prepay lane with no live term', { prepayTermMissing: true }, 'prepay_term_missing'],
    ['reviewed within 12 months', { reviewedWithin12mo: true }, 'reviewed_within_12mo'],
    ['manual rate edit inside the window', { manualRateEditRecent: true }, 'manual_rate_edit_recent'],
    ['active retention offer', { retentionOfferActive: true }, 'retention_offer_active'],
    ['plan hold / tier protection', { planHoldActive: true }, 'plan_hold_active'],
    ['callback or re-service in the window', { callbackRecent: true }, 'callback_recent'],
    ['cancellation case open or recent', { cancellationCaseRecent: true }, 'cancellation_case_recent'],
    ['open complaint', { facts: fixture.facts({ openComplaint: true }) }, 'complaint_open'],
    ['past-due balance', { facts: fixture.facts({ accountCurrent: false }) }, 'past_due'],
    ['hand-picked WaveGuard tier', { handPickedTier: true }, 'hand_picked_tier'],
    ['commercial account', { commercial: true }, 'commercial'],
    ['termite line', { familyKey: 'termite' }, 'termite_program'],
    ['termite station rental on the account', { facts: fixture.facts({ termiteRental: true }) }, 'termite_program'],
    ['multi-property account', { facts: fixture.facts({ multiProperty: true }) }, 'multi_property'],
    ['per_visit lane', { billingLane: 'per_visit' }, 'lane_cleanup'],
    ['NULL lane', { billingLane: null }, 'lane_cleanup'],
    ['two cadences open in one family', { cadenceConflict: true }, 'cadence_conflict'],
    ['one_time lane on a recurring series', { billingLane: 'one_time' }, 'lane_cleanup'],
    ['engine replay needs a human (manual review / heuristic turf / LOW confidence)', { listLowConfidence: true }, 'list_low_confidence'],
    ['unclassified service family', { familyKey: 'other' }, 'unsupported_family'],
    ['a ledger component the engine replay did not price (palm sold on a separate estimate)', { listBundleIncomplete: true }, 'list_bundle_incomplete'],
    ['a per-application tree/shrub line carrying both the bed program and palm injections (blended median)', { multiProgramLine: true }, 'multi_program_line'],
    ['two live prepay terms could cover the line', { prepayTermAmbiguous: true }, 'prepay_term_ambiguous'],
    ['monthly dues with no per-family attribution', { rateUnattributed: true }, 'rate_unattributed'],
    ['facts loader failed (fail closed)', { facts: null }, 'facts_unavailable'],
    ['money facts degraded (fail closed)', { facts: fixture.facts({ moneyFactsDegraded: true }) }, 'facts_degraded'],
  ];
  test.each(cases)('%s → %s', (_label, overrides, flag) => {
    expect(P.evaluateExceptions({ ...base(), ...overrides })).toContain(flag);
  });
  test('a clean account has no exception flags', () => {
    expect(P.evaluateExceptions(base())).toEqual([]);
  });
  test('every documented exception flag is reachable', () => {
    const seen = new Set(cases.map((c) => c[2]));
    for (const flag of rateReview.EXCEPTION_FLAGS) {
      if (flag === 'no_current_rate') continue; // assigned by computeSnapshot, below
      expect(seen.has(flag)).toBe(true);
    }
  });
  test('an open re-service callback holds only its own family; an unknown lane holds every family', () => {
    const lawnOpen = fixture.facts({ openCallbackLanes: ['lawn'] });
    expect(P.CALLBACK_LANE_FOR_FAMILY).toEqual({ pest_control: 'pest', lawn_care: 'lawn' });
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    expect(src).toMatch(/openLanes\.includes\('unknown'\)/);
    expect(src).toMatch(/familyLane != null && openLanes\.includes\(familyLane\)/);
    expect(src).not.toMatch(/facts\.openCallbackLanes\.length\)/);
    void lawnOpen;
  });
  test('computeSnapshot: exception rows keep their band and proposal but hold status exception', () => {
    const row = P.computeSnapshot({
      ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', visitsPerYear: 4, tenureMonths: 6,
      currentRateCents: 10400, currentRateSource: 'visit_median', rateUnit: 'application', listRateCents: 11700, listRateSource: 'engine',
    });
    expect(row.status).toBe('exception');
    expect(row.flags).toContain('tenure_under_lock');
    expect(row.band).toBe('D');
    expect(row.proposed_rate_cents).toBe(11600);
    expect(row.annual_delta_cents).toBe(4800);
  });
  test('computeSnapshot: no current rate → skipped; no list and no exception → skipped', () => {
    const noRate = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', currentRateCents: 0, listRateCents: 11700 });
    expect(noRate.status).toBe('skipped');
    expect(noRate.flags).toContain('no_current_rate');
    const noList = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', visitsPerYear: 4, currentRateCents: 11700, listRateCents: null });
    expect(noList.status).toBe('skipped');
    expect(noList.flags).toContain('no_list_rate');
    // an application-unit line with no annual visit count is skipped, never green with annual_delta_cents 0
    const noVpy = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'other', visitsPerYear: null, currentRateCents: 10400, listRateCents: 11700 });
    expect(noVpy.status).toBe('skipped');
    expect(noVpy.flags).toContain('no_visits_per_year');
    expect(noVpy.delta_cents).toBe(0);
  });
  test('computeSnapshot: monthly dues are normalized to per-application dollars before the bands, cap and minimum apply', () => {
    // 12 visits/yr billed monthly: $55/mo = $55/application; list $60 → C → to list $60/application = $60/mo
    const monthly = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'monthly', visitsPerYear: 12, billingLane: 'monthly_membership', currentRateCents: 5500, rateUnit: 'month', listRateCents: 6000 });
    expect(monthly.band).toBe('C');
    expect(monthly.delta_cents).toBe(500);
    expect(monthly.annual_delta_cents).toBe(6000);
    // quarterly service billed monthly: $100/mo = $300/application vs $150/mo = $450/application → D →
    // per-application step min(12% × 300 = 36, $15) = $15 → $315/application → $105/mo (+$5/mo, +$60/yr), never +$12/mo
    const quarterlyDues = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'monthly_membership', currentRateCents: 10000, rateUnit: 'month', listRateCents: 15000 });
    expect(quarterlyDues).toMatchObject({ band: 'D', proposed_rate_cents: 10500, delta_cents: 500, annual_delta_cents: 6000, status: 'green' });
    expect(quarterlyDues.flags).toContain('capped');
    // the $3 per-application minimum: $38.67/mo quarterly = $116/application vs list $117 → B → $120/app → $40/mo (+$1.33/mo = +$4/app) is a change …
    const smallB = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'monthly_membership', currentRateCents: 3867, rateUnit: 'month', listRateCents: 3900 });
    expect(smallB).toMatchObject({ band: 'B', proposed_rate_cents: 4000, delta_cents: 133, status: 'green' });
    // … while a $70/application line (pass-through $2) is not
    const tiny = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'monthly_membership', currentRateCents: 2333, rateUnit: 'month', listRateCents: 2400 });
    expect(tiny.status).toBe('no_change');
    expect(tiny.flags).toContain('below_min_delta');
    // a monthly line with an unknown cadence cannot be normalized → skipped, flagged
    const unknown = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'other', visitsPerYear: null, billingLane: 'monthly_membership', currentRateCents: 5500, rateUnit: 'month', listRateCents: 6000 });
    expect(unknown.status).toBe('skipped');
    expect(unknown.flags).toContain('no_visits_per_year');
    const quarterly = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', visitsPerYear: 4, currentRateCents: 11300, rateUnit: 'application', listRateCents: 11700 });
    expect(quarterly.annual_delta_cents).toBe(1600);
    expect(quarterly.status).toBe('green');
  });
});

// ── lanes ───────────────────────────────────────────────────────────────

describe('current rate per billing lane', () => {
  const planLine = fixture.planLine('c', 'pest_control', 'quarterly', 105.3);
  test('per_application: median of the open visits, else per_application_fee', () => {
    expect(P.resolveCurrentRate({ customer: fixture.customer(1), planLine })).toMatchObject({ cents: 10530, source: 'visit_median', unit: 'application' });
    const noVisitPrice = fixture.planLine('c', 'pest_control', 'quarterly', null);
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { per_application_fee: 98 }), planLine: noVisitPrice })).toMatchObject({ cents: 9800, source: 'per_application_fee' });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1), planLine: noVisitPrice })).toMatchObject({ cents: 0, source: 'none' });
  });
  test('monthly_membership: the ledger family slice (ledger gate on), else monthly_rate on a single-line account', () => {
    const customer = fixture.customer(1, { billing_mode: 'monthly_membership', monthly_rate: 55 });
    expect(P.resolveCurrentRate({ customer, planLine, ledgerSlice: { monthly_rate: 40 } })).toMatchObject({ cents: 4000, source: 'ledger_slice', unit: 'month' });
    expect(P.resolveCurrentRate({ customer, planLine })).toMatchObject({ cents: 5500, source: 'monthly_rate', unit: 'month' });
  });
  test('annual_prepay: the live term per covered visit, flagged mid-term', () => {
    const customer = fixture.customer(1, { billing_mode: 'annual_prepay' });
    const terms = [{ prepay_amount: 404, coverage_visit_count: 4 }];
    expect(P.resolveCurrentRate({ customer, planLine, liveTerms: terms })).toMatchObject({ cents: 10100, source: 'prepay_term', unit: 'application', prepayMidTerm: true });
    // a prepay-linked line on a per_application scalar is still prepaid (term authority wins)
    const linked = fixture.planLine('c', 'pest_control', 'quarterly', 110, { prepay_linked: true });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1), planLine: linked, liveTerms: terms })).toMatchObject({ source: 'prepay_term', prepayMidTerm: true });
    // annual_prepay scalar with no live term → visit fallback, flagged for cleanup
    expect(P.resolveCurrentRate({ customer, planLine, liveTerms: [] })).toMatchObject({ cents: 10530, source: 'visit_median', prepayTermMissing: true });
  });
  test('ledger slices are looked up under the ledger\'s own family keys and summed per line', () => {
    const ledger = new Map([
      ['c|pest_control', { family_key: 'pest_control', monthly_rate: 40 }],
      ['c|rodent_bait', { family_key: 'rodent_bait', monthly_rate: 25 }],
      ['c|tree_shrub', { family_key: 'tree_shrub', monthly_rate: 30 }],
      ['c|palm_injection', { family_key: 'palm_injection', monthly_rate: 12.5 }],
      ['c|termite_bait', { family_key: 'termite_bait', monthly_rate: 20 }],
    ]);
    expect(P.ledgerSliceForLine(ledger, 'c', 'rodent')).toMatchObject({ monthly_rate: 25, family_keys: ['rodent_bait'] });
    expect(P.ledgerSliceForLine(ledger, 'c', 'tree_shrub')).toMatchObject({ monthly_rate: 42.5, family_keys: ['tree_shrub', 'palm_injection'] });
    expect(P.ledgerSliceForLine(ledger, 'c', 'termite')).toMatchObject({ monthly_rate: 20 });
    expect(P.ledgerSliceForLine(ledger, 'c', 'pest_control')).toMatchObject({ monthly_rate: 40 });
    expect(P.ledgerSliceForLine(ledger, 'c', 'mosquito')).toBeNull();
    expect(P.ledgerSliceForLine(ledger, 'other', 'pest_control')).toBeNull();
    // a monthly pest + rodent account prices its rodent line off the rodent_bait slice, not the whole-account scalar
    const customer = fixture.customer(1, { billing_mode: 'monthly_membership', monthly_rate: 65 });
    const rodent = fixture.planLine('c', 'rodent', 'quarterly', null, { account_lines: 2 });
    expect(P.resolveCurrentRate({ customer, planLine: rodent, ledgerSlice: P.ledgerSliceForLine(ledger, 'c', 'rodent') })).toMatchObject({ cents: 2500, source: 'ledger_slice', unit: 'month' });
    expect(P.resolveCurrentRate({ customer, planLine: fixture.planLine('c', 'tree_shrub', 'bimonthly', null, { account_lines: 2 }), ledgerSlice: P.ledgerSliceForLine(ledger, 'c', 'tree_shrub') })).toMatchObject({ cents: 4250, source: 'ledger_slice' });
  });
  test('monthly_membership: the whole-account scalar never stands in for a slice on a multi-line account', () => {
    const customer = fixture.customer(1, { billing_mode: 'monthly_membership', monthly_rate: 95 });
    const multi = fixture.planLine('c', 'pest_control', 'quarterly', null, { account_lines: 2 });
    const out = P.resolveCurrentRate({ customer, planLine: multi });
    expect(out).toMatchObject({ cents: 0, source: 'none', unit: 'month', rateUnattributed: true });
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'pest_control', cadence: 'quarterly', billingLane: 'monthly_membership', anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 0, rateUnit: 'month', rateUnattributed: true, facts: fixture.facts() });
    expect(row.status).toBe('skipped');
    expect(row.flags).toEqual(expect.arrayContaining(['rate_unattributed', 'no_current_rate']));
    // a ledger slice prices the line even on a multi-line account
    expect(P.resolveCurrentRate({ customer, planLine: multi, ledgerSlice: { monthly_rate: 40 } })).toMatchObject({ cents: 4000, source: 'ledger_slice' });
  });
  test('annual_prepay: the term is matched to the line — linked visits first, then coverage family; two candidates are ambiguous', () => {
    const pest = { id: 't-pest', prepay_amount: 404, coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control' };
    const lawn = { id: 't-lawn', prepay_amount: 780, coverage_visit_count: 12, coverage_service_type: 'Lawn Care Monthly' };
    const lawnLine = fixture.planLine('c', 'lawn_care', 'monthly', null, { prepay_linked: true, prepay_term_ids: ['t-lawn'], account_lines: 2 });
    expect(P.matchPrepayTerm([pest, lawn], lawnLine, 'lawn_care')).toMatchObject({ term: { id: 't-lawn' }, ambiguous: false });
    const unlinkedPest = fixture.planLine('c', 'pest_control', 'quarterly', null, { prepay_linked: true, prepay_term_ids: [], account_lines: 2 });
    expect(P.matchPrepayTerm([pest, lawn], unlinkedPest, 'pest_control')).toMatchObject({ term: { id: 't-pest' } });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'annual_prepay' }), planLine: unlinkedPest, liveTerms: [pest, lawn] })).toMatchObject({ cents: 10100, source: 'prepay_term', prepayTermId: 't-pest' });
    // two pest terms, neither linked → ambiguous → held, priced off the visits
    const pest2 = { ...pest, id: 't-pest-2', prepay_amount: 440 };
    expect(P.matchPrepayTerm([pest, pest2], unlinkedPest, 'pest_control')).toEqual({ term: null, ambiguous: true });
    const held = P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'annual_prepay', per_application_fee: 100 }), planLine: unlinkedPest, liveTerms: [pest, pest2] });
    expect(held).toMatchObject({ cents: 10000, source: 'per_application_fee', prepayTermMissing: true, prepayTermAmbiguous: true });
    expect(P.evaluateExceptions({ familyKey: 'pest_control', billingLane: 'annual_prepay', anniversaryDate: '2025-01-10', tenureMonths: 21, facts: fixture.facts(), prepayTermMissing: true, prepayTermAmbiguous: true })).toEqual(expect.arrayContaining(['prepay_term_missing', 'prepay_term_ambiguous']));
    // a lone unlabeled term on a single-line account is that line's; on a multi-line account it is not
    const blank = { id: 't-blank', prepay_amount: 404, coverage_visit_count: 4, coverage_service_type: null };
    expect(P.matchPrepayTerm([blank], fixture.planLine('c', 'pest_control', 'quarterly', null, { account_lines: 1 }), 'pest_control').term).toEqual(blank);
    expect(P.matchPrepayTerm([blank], fixture.planLine('c', 'pest_control', 'quarterly', null, { account_lines: 2 }), 'pest_control')).toEqual({ term: null, ambiguous: true });
    expect(P.familyOfCoverage('Tree & Shrub Program')).toBe('tree_shrub');
    expect(P.familyOfCoverage(null)).toBeNull();
  });
  test('a live term covering the line is prepay mid-term whatever the scalar or the visit links say', () => {
    const pest = { id: 't-pest', prepay_amount: 404, coverage_visit_count: 4, coverage_service_type: 'Quarterly Pest Control' };
    // per_application scalar, open visits not linked to the term → still the term's line
    const perApp = fixture.planLine('c', 'pest_control', 'quarterly', 117, { prepay_linked: false, prepay_term_ids: [], account_lines: 2 });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_application' }), planLine: perApp, liveTerms: [pest] })).toMatchObject({ cents: 10100, source: 'prepay_term', prepayMidTerm: true, prepayTermId: 't-pest' });
    // monthly scalar on a single-line account with a live term → prepay, not dues
    const monthly = fixture.planLine('c', 'pest_control', 'quarterly', null, { account_lines: 1 });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'monthly_membership', monthly_rate: 55 }), planLine: monthly, liveTerms: [pest] })).toMatchObject({ source: 'prepay_term', prepayMidTerm: true });
    // the OTHER line of that account is not covered by the pest term
    const lawn = fixture.planLine('c', 'lawn_care', 'every_6_weeks', 61, { account_lines: 2 });
    const lawnOut = P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_application' }), planLine: lawn, liveTerms: [pest] });
    expect(lawnOut).toMatchObject({ cents: 6100, source: 'visit_median' });
    expect(lawnOut.prepayMidTerm).toBeFalsy();
    expect(lawnOut.prepayTermAmbiguous).toBeFalsy();
    // two unlabeled live terms on a per_application account → ambiguous, held
    const blankA = { id: 'a', prepay_amount: 404, coverage_visit_count: 4, coverage_service_type: null };
    const blankB = { id: 'b', prepay_amount: 500, coverage_visit_count: 4, coverage_service_type: null };
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_application' }), planLine: perApp, liveTerms: [blankA, blankB] })).toMatchObject({ cents: 11700, source: 'visit_median', prepayTermAmbiguous: true, prepayTermMissing: false });
  });
  test('open visits all stamped $0 are a free line when the zero is authoritative — never a fee-fallback increase', () => {
    const zeroWithBase = fixture.planLine('c', 'pest_control', 'quarterly', null, { priced_visits: 0, zero_priced_visits: 3, zero_with_base_visits: 3 });
    const customer = fixture.customer(1, { per_application_fee: 117 });
    expect(P.resolveCurrentRate({ customer, planLine: zeroWithBase })).toMatchObject({ cents: 0, source: 'stamped_zero', stampedZeroFree: true });
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'pest_control', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'per_application', anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 0, currentRateSource: 'stamped_zero', stampedZeroFree: true, rateUnit: 'application', listRateCents: 11700, listRateSource: 'engine', facts: fixture.facts() });
    expect(row.status).toBe('skipped');
    expect(row.flags).toEqual(expect.arrayContaining(['stamped_zero_free', 'no_current_rate']));
    // a bare stamped 0 with no base and the stamped-zero gate off is indistinguishable from never priced → fee fallback (today's billing rule)
    const bare = fixture.planLine('c', 'pest_control', 'quarterly', null, { priced_visits: 0, zero_priced_visits: 3, zero_with_base_visits: 0 });
    // the authority is counted PER VISIT: three $0 visits with one base are not a free line while the gate is off
    const partialBase = fixture.planLine('c', 'pest_control', 'quarterly', null, { priced_visits: 0, zero_priced_visits: 3, zero_with_base_visits: 1 });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_application', per_application_fee: 117 }), planLine: partialBase })).toMatchObject({ cents: 11700, source: 'per_application_fee' });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_application', per_application_fee: null }), planLine: partialBase }).stampedZeroFree).toBeUndefined();
    const src0 = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    expect(src0).toMatch(/count\(\*\) FILTER \(WHERE estimated_price = 0 AND primary_line_price > 0\)::int AS zero_with_base_visits/);
    expect(src0).not.toMatch(/bool_or\(estimated_price = 0/);
    const prior = process.env.GATE_STAMPED_ZERO_FREE;
    process.env.GATE_STAMPED_ZERO_FREE = 'false';
    try {
      expect(P.resolveCurrentRate({ customer, planLine: bare })).toMatchObject({ cents: 11700, source: 'per_application_fee' });
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      expect(P.resolveCurrentRate({ customer, planLine: bare })).toMatchObject({ cents: 0, source: 'stamped_zero', stampedZeroFree: true });
    } finally {
      if (prior === undefined) delete process.env.GATE_STAMPED_ZERO_FREE; else process.env.GATE_STAMPED_ZERO_FREE = prior;
    }
    // a priced median always wins over zero-stamped siblings
    // one discounted-to-zero visit beside NULL-priced ones is not a free line: the NULL-priced visits bill the per-application fee
    const oneZero = fixture.planLine('c', 'pest_control', 'quarterly', null, { open_visits: 3, priced_visits: 0, zero_priced_visits: 1, zero_with_base_visits: 1 });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_application', per_application_fee: 117 }), planLine: oneZero })).toMatchObject({ cents: 11700, source: 'per_application_fee' });
    const noFee = fixture.customer(1, { billing_mode: 'per_application', per_application_fee: null });
    expect(P.resolveCurrentRate({ customer: noFee, planLine: oneZero })).toMatchObject({ cents: 0, source: 'none' });
    expect(P.resolveCurrentRate({ customer: noFee, planLine: oneZero }).stampedZeroFree).toBeUndefined();
    const mixed = fixture.planLine('c', 'pest_control', 'quarterly', 117, { priced_visits: 2, zero_priced_visits: 1, zero_with_base_visits: 1 });
    expect(P.resolveCurrentRate({ customer, planLine: mixed })).toMatchObject({ cents: 11700, source: 'visit_median' });
  });
  test('per_visit and NULL lanes read the visit stamp (the exception rule flags lane_cleanup)', () => {
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_visit' }), planLine })).toMatchObject({ cents: 10530, source: 'visit_median' });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: null, waveguard_tier: null, monthly_rate: null }), planLine })).toMatchObject({ cents: 10530, source: 'visit_median' });
  });
  test('a legacy NULL billing_mode resolves through billing-lane.js: a real tier with dues is a monthly member, not a cleanup lane', () => {
    const { resolveBillingLane } = require('../services/billing-lane');
    const legacy = fixture.customer(1, { billing_mode: null, waveguard_tier: 'Silver', monthly_rate: 55 });
    expect(resolveBillingLane(legacy)).toEqual({ mode: 'monthly_membership', source: 'inferred' });
    expect(P.resolveCurrentRate({ customer: legacy, planLine: fixture.planLine('c', 'pest_control', 'quarterly', 117, { account_lines: 1 }) })).toMatchObject({ cents: 5500, source: 'monthly_rate', unit: 'month' });
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'pest_control', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'monthly_membership', laneInferred: true, anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 5500, rateUnit: 'month', listRateCents: 5500, facts: fixture.facts() });
    expect(row.flags).toContain('lane_inferred');
    expect(row.flags).not.toContain('lane_cleanup');
    // informational only — the lane rule itself decides any hold; an inferred monthly member ranks normally
    expect(row.status).not.toBe('exception');
    expect(row.flags.filter((f) => rateReview.EXCEPTION_FLAGS.includes(f))).toEqual([]);
    expect(P.evaluateExceptions({ familyKey: 'pest_control', billingLane: 'monthly_membership', laneInferred: true, anniversaryDate: '2025-01-10', tenureMonths: 21, facts: fixture.facts() })).toEqual([]);
    // a NULL mode with no tier / dues infers per_visit → cleanup, as before
    const bare = fixture.customer(1, { billing_mode: null, waveguard_tier: null, monthly_rate: null });
    expect(resolveBillingLane(bare).mode).toBe('per_visit');
  });
});

// ── plan-line consolidation + engine cadence ────────────────────────────

describe('one snapshot per customer × family', () => {
  test('a family with open visits at two cadences keeps the dominant cadence and is flagged cadence_conflict', () => {
    const rows = [
      fixture.planLine('c1', 'pest_control', 'quarterly', 117, { open_visits: 3, next_visit: '2026-12-10', source_estimate_ids: ['e1'] }),
      fixture.planLine('c1', 'pest_control', 'bimonthly', 95, { open_visits: 1, next_visit: '2026-11-20', source_estimate_ids: ['e2'] }),
      fixture.planLine('c1', 'lawn_care', 'every_6_weeks', 61, { open_visits: 2 }),
      fixture.planLine('c2', 'pest_control', 'quarterly', 117, { open_visits: 2 }),
    ];
    const lines = P.consolidatePlanLines(rows);
    expect(lines).toHaveLength(3);
    const pest = lines.find((l) => l.customer_id === 'c1' && l.family_key === 'pest_control');
    expect(pest).toMatchObject({ cadence: 'quarterly', median_price: 117, cadence_conflict: true, other_cadences: ['bimonthly'], account_lines: 2 });
    expect(pest.source_estimate_ids).toEqual(['e1', 'e2']);
    expect(lines.find((l) => l.customer_id === 'c2')).toMatchObject({ cadence_conflict: false, account_lines: 1 });
    // ties on open visits go to the sooner next visit
    const tied = P.consolidatePlanLines([
      fixture.planLine('c3', 'pest_control', 'quarterly', 117, { open_visits: 2, next_visit: '2026-12-10' }),
      fixture.planLine('c3', 'pest_control', 'monthly', 90, { open_visits: 2, next_visit: '2026-11-02' }),
    ]);
    expect(tied[0].cadence).toBe('monthly');
    expect(P.evaluateExceptions({ familyKey: 'pest_control', billingLane: 'per_application', anniversaryDate: '2025-01-10', tenureMonths: 21, facts: fixture.facts(), cadenceConflict: true })).toContain('cadence_conflict');
  });
});

describe('engine replay runs at the line\'s own cadence', () => {
  test('pest frequency and lawn tier follow the schedule, quote-time concessions come off', () => {
    const inputs = { homeSqFt: 2100, manualDiscount: { type: 'PERCENT', value: 10 }, services: { pest: { frequency: 'quarterly', roachType: 'none' }, lawn: { track: 'st_augustine', tier: 'enhanced' } }, lawnFreq: 9 };
    const pest = P.listReplayInputs(inputs, { familyKey: 'pest_control', cadence: 'bimonthly' });
    expect(pest.services.pest).toEqual({ frequency: 'bimonthly', roachType: 'none' });
    expect(pest.manualDiscount).toBeUndefined();
    expect(pest.services.lawn.tier).toBe('enhanced');
    const lawn = P.listReplayInputs(inputs, { familyKey: 'lawn_care', cadence: 'monthly' });
    expect(lawn.services.lawn).toMatchObject({ tier: 'premium', lawnFreq: 12 });
    expect(lawn.lawnFreq).toBeUndefined();
    expect(P.listReplayInputs(inputs, { familyKey: 'mosquito', cadence: 'monthly' }).services.pest.frequency).toBe('quarterly');
    expect(inputs.services.pest.frequency).toBe('quarterly'); // never mutates the stored inputs
  });
  test('the replay bundle is the customer\'s CURRENT plan: cancelled programs come out, later additions go in as prior qualifying services', () => {
    const sold = { homeSqFt: 2100, lotSqFt: 8000, services: { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' }, mosquito: { tier: 'seasonal' } } };
    // lawn cancelled since, rodent bait added since (on another estimate)
    const clean = P.listReplayInputs(sold, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: ['pest_control', 'mosquito', 'rodent'] });
    expect(Object.keys(clean.services).sort()).toEqual(['mosquito', 'pest']);
    expect(clean.priorQualifyingServices).toEqual(['rodent_bait']);
    expect(clean.recurringCustomer).toBe(true);
    // nothing added → no priors, flag untouched; a single-line account drops every other service
    const solo = P.listReplayInputs(sold, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: ['pest_control'] });
    expect(Object.keys(solo.services)).toEqual(['pest']);
    expect(solo.priorQualifyingServices).toEqual([]);
    expect(solo.recurringCustomer).toBeUndefined();
    // without plan evidence the saved mix is left alone
    expect(Object.keys(P.listReplayInputs(sold, { familyKey: 'pest_control', cadence: 'quarterly' }).services).sort()).toEqual(['lawn', 'mosquito', 'pest']);
    expect(sold.services.lawn).toBeDefined();
  });
  test('a standalone palm program never injects tree_shrub as a prior qualifying service (pest + palm stays Bronze, as the engine prices it)', () => {
    expect(P.qualifyingKeyForLine({ familyKey: 'tree_shrub', serviceKeys: ['palm_injection_semiannual'] })).toBeNull();
    expect(P.qualifyingKeyForLine({ familyKey: 'tree_shrub', serviceKeys: ['tree_shrub_program'] })).toBe('tree_shrub');
    expect(P.qualifyingKeyForLine({ familyKey: 'tree_shrub', serviceKeys: ['tree_shrub_program', 'palm_injection_semiannual'] })).toBe('tree_shrub');
    expect(P.qualifyingKeyForLine({ familyKey: 'tree_shrub', serviceKeys: [] })).toBe('tree_shrub'); // unknown keys: a real program
    expect(P.qualifyingKeyForLine({ familyKey: 'rodent', serviceKeys: ['rodent_bait'] })).toBe('rodent_bait');
    expect(P.qualifyingKeyForLine({ familyKey: 'other', serviceKeys: ['x'] })).toBeNull();
    const sold = { homeSqFt: 2100, services: { pest: { frequency: 'quarterly' } } };
    const pestPlusPalm = P.listReplayInputs(sold, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: [{ familyKey: 'pest_control', serviceKeys: ['pest_control_quarterly'] }, { familyKey: 'tree_shrub', serviceKeys: ['palm_injection_semiannual'] }] });
    expect(pestPlusPalm.services.pest).toBeDefined();
    expect(pestPlusPalm.priorQualifyingServices).toEqual([]);
    expect(pestPlusPalm.recurringCustomer).toBeUndefined();
    const pestPlusTrees = P.listReplayInputs(sold, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: [{ familyKey: 'pest_control', serviceKeys: ['pest_control_quarterly'] }, { familyKey: 'tree_shrub', serviceKeys: ['tree_shrub_program'] }] });
    expect(pestPlusTrees.priorQualifyingServices).toEqual(['tree_shrub']);
    // bare family strings still work as before
    expect(P.listReplayInputs(sold, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: ['pest_control', 'rodent'] }).priorQualifyingServices).toEqual(['rodent_bait']);
  });
  test('tree/shrub and palm are reconciled as separate programs: a cancelled tree/shrub program never survives on a palm rider', () => {
    const pestLine = { familyKey: 'pest_control', serviceKeys: ['pest_control_quarterly'] };
    // sold pest + tree/shrub; the tree/shrub program was cancelled since, palm injections remain
    const sold = { homeSqFt: 2100, services: { pest: { frequency: 'quarterly' }, treeShrub: { tier: 'enhanced' } } };
    const out = P.listReplayInputs(sold, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: [pestLine, { familyKey: 'tree_shrub', serviceKeys: ['palm_injection_semiannual'] }] });
    expect(out.services.treeShrub).toBeUndefined();
    expect(out.priorQualifyingServices).toEqual([]); // palm qualifies for nothing → pest replays at Bronze
    expect(out.recurringCustomer).toBeUndefined();
    // sold pest + palm; palm cancelled since, a real tree/shrub program added
    const soldPalm = { homeSqFt: 2100, palmCount: 6, services: { pest: { frequency: 'quarterly' }, palmInjection: { count: 6 } } };
    const out2 = P.listReplayInputs(soldPalm, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: [pestLine, { familyKey: 'tree_shrub', serviceKeys: ['tree_shrub_program'] }] });
    expect(out2.services.palmInjection).toBeUndefined();
    expect(out2.priorQualifyingServices).toEqual(['tree_shrub']);
    // both programs active (one consolidated family line) → both saved services survive, nothing is a prior
    const out3 = P.listReplayInputs({ homeSqFt: 2100, services: { treeShrub: { tier: 'enhanced' }, palm: { count: 2 } } }, { familyKey: 'tree_shrub', cadence: 'bimonthly', activeFamilies: [{ familyKey: 'tree_shrub', serviceKeys: ['tree_shrub_program', 'palm_injection_semiannual'] }] });
    expect(out3.services.treeShrub).toBeDefined();
    expect(out3.services.palm).toBeDefined();
    expect(out3.priorQualifyingServices).toEqual([]);
    // sold pest + palm; a bed program added later (same consolidated line) counts as a prior even though the palm rider survived
    const out5 = P.listReplayInputs(soldPalm, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: [pestLine, { familyKey: 'tree_shrub', serviceKeys: ['tree_shrub_program', 'palm_injection_semiannual'] }] });
    expect(out5.services.palmInjection).toBeDefined();
    expect(out5.priorQualifyingServices).toEqual(['tree_shrub']);
    // a tree_shrub line without catalog keys is of unknown composition: it keeps whatever was sold
    const out4 = P.listReplayInputs({ homeSqFt: 2100, services: { pest: { frequency: 'quarterly' }, treeShrub: { tier: 'enhanced' }, palm: { count: 2 } } }, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: ['pest_control', 'tree_shrub'] });
    expect(out4.services.treeShrub).toBeDefined();
    expect(out4.services.palm).toBeDefined();
    expect(out4.priorQualifyingServices).toEqual([]);
  });
  test('the ORIGINAL-mix replay restores the server-stamped prior qualifying services; the client-posted copy never survives', () => {
    const inputs = { lotSqFt: 8000, priorQualifyingServices: ['pest_control', 'mosquito'], recurringCustomer: true, services: { lawn: { track: 'st_augustine', tier: 'enhanced' } } };
    // original mix with the server-stamped evidence → priors restored (sold as a Silver add-on)
    const original = P.listReplayInputs(inputs, { familyKey: null, cadence: null, activeFamilies: null, savedPriorQualifying: ['pest_control'] });
    expect(original.priorQualifyingServices).toEqual(['pest_control']);
    expect(original.recurringCustomer).toBe(true);
    // no server stamp → the client-posted list is gone
    const bare = P.listReplayInputs(inputs, { familyKey: null, cadence: null, activeFamilies: null, savedPriorQualifying: null });
    expect(bare.priorQualifyingServices).toBeUndefined();
    expect(bare.recurringCustomer).toBeUndefined();
    // the current-bundle replay derives priors from today's plan lines, not the stamp
    const current = P.listReplayInputs(inputs, { familyKey: 'lawn_care', cadence: 'every_6_weeks', activeFamilies: ['lawn_care', 'pest_control', 'rodent'], savedPriorQualifying: ['pest_control'] });
    expect(current.priorQualifyingServices).toEqual(['pest_control', 'rodent_bait']);
  });
  test('every server-owned replay stamp comes off through the shared client-identity sanitizer', () => {
    const { CLIENT_IDENTITY_FIELDS } = require('../services/estimate-client-identity-fields');
    for (const stamp of ['treeShrubPricingKnobs', 'palmAnnualRounding', 'catalogPricing', 'termitePricingKnobs', 'rodentWaveguardPostureReplay']) expect(CLIENT_IDENTITY_FIELDS).toContain(stamp);
    const saved = { homeSqFt: 2100, treeShrubPricingKnobs: { x: 1 }, palmAnnualRounding: { y: 2 }, catalogPricing: { z: 3 }, services: { pest: { frequency: 'quarterly' } } };
    const clean = P.listReplayInputs(saved, { familyKey: 'pest_control', cadence: 'quarterly' });
    for (const stamp of CLIENT_IDENTITY_FIELDS) expect(clean[stamp]).toBeUndefined();
    expect(clean.homeSqFt).toBe(2100);
    expect(saved.catalogPricing).toEqual({ z: 3 }); // never mutates the stored inputs
  });
  test('historical pins come off: a v1-pinned pest quote, frozen floors and minimums reprice at today\'s list', () => {
    const saved = {
      homeSqFt: 2100, pestProgramFloorArmed: true, pestProgramFloorPerVisit: 89, lawnProgramMinimumMonthly: 45, useLawnCostFloor: true,
      commercialFloorsArmedServices: ['pest_control'], rodentWaveguardPostureReplay: { tierQualifier: false }, termitePricingKnobs: { x: 1 },
      services: { pest: { frequency: 'quarterly', version: 'v1', pricingVersion: 'v1' }, lawn: { track: 'st_augustine', tier: 'enhanced', programMinimumMonthly: 45, useLawnCostFloor: true } },
    };
    const clean = P.listReplayInputs(saved, { familyKey: 'pest_control', cadence: 'quarterly' });
    expect(clean.services.pest).toEqual({ frequency: 'quarterly' });
    expect(clean.services.lawn).toEqual({ track: 'st_augustine', tier: 'enhanced' });
    for (const key of ['pestProgramFloorArmed', 'pestProgramFloorPerVisit', 'lawnProgramMinimumMonthly', 'useLawnCostFloor', 'commercialFloorsArmedServices', 'rodentWaveguardPostureReplay', 'termitePricingKnobs']) {
      expect(clean[key]).toBeUndefined();
    }
    expect(clean.homeSqFt).toBe(2100);
    expect(saved.services.pest.version).toBe('v1');
  });
  test('engine inputs come from the admin V2 engineRequest (translated), then engineInputs, then a public `inputs` with a services map', () => {
    const translate = jest.fn((profile, selected, options) => ({ homeSqFt: profile.squareFootage, lotSqFt: profile.lotSqFt, services: { pest: { frequency: options.pestFrequency || 'quarterly' } }, selected }));
    const admin = { id: 'e-admin', estimate_data: { engineRequest: { profile: { squareFootage: 2400, lotSqFt: 9000 }, selectedServices: ['pest_control'], options: { pestFrequency: 'bimonthly' } }, inputs: { squareFootage: '2400', frequency: 'Bi-monthly' } } };
    const out = P.engineInputsFromEstimate(admin, { translateV2CallToV1Input: translate });
    expect(translate).toHaveBeenCalledWith({ squareFootage: 2400, lotSqFt: 9000 }, ['pest_control'], { pestFrequency: 'bimonthly' });
    expect(out).toMatchObject({ homeSqFt: 2400, services: { pest: { frequency: 'bimonthly' } } });
    expect(P.hasSizeInput(out, 'pest_control')).toBe(true);
    // an admin save whose UI-form `inputs` has no services map is not an engine input on its own
    expect(P.engineInputsFromEstimate({ id: 'e-ui', estimate_data: { inputs: { squareFootage: '2400', frequency: 'Quarterly' } } }, { translateV2CallToV1Input: translate })).toBeNull();
    // engineInputs wins over the UI form; the public wizard's `inputs` (engine shape) still replays
    expect(P.engineInputsFromEstimate({ id: 'e-ei', estimate_data: { engineInputs: { homeSqFt: 1800, services: { pest: {} } }, inputs: { squareFootage: '1800' } } }, { translateV2CallToV1Input: translate })).toMatchObject({ homeSqFt: 1800 });
    expect(P.engineInputsFromEstimate({ id: 'e-pub', estimate_data: { inputs: { homeSqFt: 2100, services: { pest: { frequency: 'quarterly' } } } } }, { translateV2CallToV1Input: translate })).toMatchObject({ homeSqFt: 2100 });
    // a translator that throws falls through to the stored shapes, never aborts the batch
    const throwing = jest.fn(() => { throw new Error('gated add-on'); });
    expect(P.engineInputsFromEstimate(admin, { translateV2CallToV1Input: throwing })).toBeNull();
    expect(P.engineInputsFromEstimate({ id: 'e-str', estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 1500, services: { pest: {} } } }) }, { translateV2CallToV1Input: null })).toMatchObject({ homeSqFt: 1500 });
  });
  test('a replay whose cadence still does not match the line is not a list rate', () => {
    const result = { lineItems: [{ service: 'pest_control', annualAfterDiscount: 468, visitsPerYear: 4 }], waveGuard: { tier: 'bronze' } };
    expect(P.listRateFromEngineResult(result, 'pest_control', 'quarterly')).toMatchObject({ perAppCents: 11700, cadenceMismatch: false });
    expect(P.listRateFromEngineResult(result, 'pest_control', 'bimonthly')).toMatchObject({ cadenceMismatch: true });
  });
  test('a seasonal mosquito program replays at its 9 applications (the engine\'s `visits` field), not the 12 its monthly pattern suggests', () => {
    expect(P.visitsPerYearFor('seasonal', 9)).toBe(9);
    expect(P.visitsPerYearFor('seasonal', null)).toBeNull();
    expect(P.visitsPerYearFor('monthly', 9)).toBe(12);
    const result = { lineItems: [{ service: 'mosquito', annualAfterDiscount: 720, visits: 9 }], waveGuard: { tier: 'bronze' } };
    expect(P.listRateFromEngineResult(result, 'mosquito', 'seasonal', { expectedVisits: 9 })).toMatchObject({ perAppCents: 8000, cadenceMismatch: false });
    expect(P.listRateFromEngineResult(result, 'mosquito', 'monthly', { expectedVisits: 12 })).toMatchObject({ cadenceMismatch: true });
    expect(P.listReplayInputs({ lotSqFt: 9000, services: { mosquito: { tier: 'monthly' } } }, { familyKey: 'mosquito', cadence: 'seasonal' }).services.mosquito.tier).toBe('seasonal');
    // the SQL classifies a seasonal catalog row (or pattern) as 'seasonal' before the monthly pattern rule
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    expect(src.indexOf("sv.frequency LIKE 'seasonal%'")).toBeLessThan(src.indexOf("s.recurring_pattern IN ('monthly','monthly_nth_weekday') THEN 'monthly'"));
  });
  test('an engine item\'s application count comes through the converter\'s alias vocabulary — the palm engine says appsPerYear', () => {
    expect(P.engineItemVisits({ visitsPerYear: 4 })).toBe(4);
    expect(P.engineItemVisits({ appsPerYear: 2 })).toBe(2); // pricePalmInjection's field
    expect(P.engineItemVisits({ treatmentsPerYear: 2 })).toBe(2);
    expect(P.engineItemVisits({ apps: 3 })).toBe(3);
    expect(P.engineItemVisits({ visits: 9 })).toBe(9);
    expect(P.engineItemVisits({ frequency: 6 })).toBe(6); // lawn's field, outside the converter list
    expect(P.engineItemVisits({})).toBeNull();
    const palm = { lineItems: [{ service: 'palm_injection', annualAfterDiscount: 300, appsPerYear: 2 }], waveGuard: { tier: 'bronze' } };
    expect(P.listRateFromEngineResult(palm, 'tree_shrub', 'semiannual')).toMatchObject({ perAppCents: 15000, cadenceMismatch: false });
  });
  test('a standalone palm program is the tree/shrub family\'s primary item, never a rider of a missing line', () => {
    const palmOnly = { lineItems: [{ service: 'palm_injection', annualAfterDiscount: 300, visitsPerYear: 2 }], waveGuard: { tier: 'bronze' } };
    expect(P.listRateFromEngineResult(palmOnly, 'tree_shrub', 'semiannual', { includeRiders: true, riderAllow: ['palm_injection'] })).toMatchObject({ perAppCents: 15000, monthlyCents: 2500, riderServices: [], cadenceMismatch: false });
    expect(P.listRateFromEngineResult(palmOnly, 'tree_shrub', 'semiannual')).toMatchObject({ perAppCents: 15000 });
    // with a tree_shrub line present it stays the primary and palm is the rider
    const both = { lineItems: [{ service: 'palm_injection', annualAfterDiscount: 150, visitsPerYear: 2 }, { service: 'tree_shrub', annualAfterDiscount: 360, visitsPerYear: 6 }], waveGuard: { tier: 'silver' } };
    expect(P.listRateFromEngineResult(both, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: ['tree_shrub', 'palm_injection'] })).toMatchObject({ perAppCents: 6000, monthlyCents: 4250, riderServices: ['palm_injection'] });
  });
  test('a palm rider joins the monthly list figure exactly where the ledger slice sums it, never the per-application one', () => {
    const result = { lineItems: [{ service: 'tree_shrub', annualAfterDiscount: 360, visitsPerYear: 6 }, { service: 'palm_injection', annualAfterDiscount: 150, visitsPerYear: 2 }], waveGuard: { tier: 'silver' } };
    const monthly = P.listRateFromEngineResult(result, 'tree_shrub', 'bimonthly', { includeRiders: true });
    expect(monthly).toMatchObject({ monthlyCents: 4250, perAppCents: 6000, riderServices: ['palm_injection'] });
    const perApp = P.listRateFromEngineResult(result, 'tree_shrub', 'bimonthly');
    expect(perApp).toMatchObject({ monthlyCents: 3000, perAppCents: 6000, riderServices: [] });
    // a rider the slice carries that needs a human holds the WHOLE line (the current rate includes the rider; a rider-free list would compare mismatched bundles)
    const quoteRequired = { lineItems: [result.lineItems[0], { ...result.lineItems[1], quoteRequired: true }], waveGuard: { tier: 'silver' } };
    expect(P.listRateFromEngineResult(quoteRequired, 'tree_shrub', 'bimonthly', { includeRiders: true })).toMatchObject({ lowConfidence: true });
    // … but a rider the slice does NOT carry is ignored entirely, confident or not
    expect(P.listRateFromEngineResult(quoteRequired, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: ['tree_shrub'] })).toMatchObject({ monthlyCents: 3000, riderServices: [] });
    expect(P.listRateFromEngineResult(quoteRequired, 'tree_shrub', 'bimonthly')).toMatchObject({ monthlyCents: 3000 });
    // a rider on the saved estimate that the ledger no longer carries (cancelled since) stays out of the list
    expect(P.listRateFromEngineResult(result, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: ['tree_shrub'] })).toMatchObject({ monthlyCents: 3000, riderServices: [] });
    expect(P.listRateFromEngineResult(result, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: ['tree_shrub', 'palm_injection'] })).toMatchObject({ monthlyCents: 4250, riderServices: ['palm_injection'] });
  });
});

// ── anniversary ─────────────────────────────────────────────────────────

describe('anniversary and tenure', () => {
  test('portal-sold line: first completed visit, else the accept date', () => {
    expect(P.resolveAnniversary({ firstCompletedVisit: '2026-06-10', acceptedAt: '2026-06-01T15:00:00Z', memberSince: '2026-06-01' })).toMatchObject({ date: '2026-06-10', source: 'first_visit', conflict: false });
    expect(P.resolveAnniversary({ firstCompletedVisit: null, acceptedAt: '2026-06-01T15:00:00Z', memberSince: '2026-06-01' })).toMatchObject({ date: '2026-06-01', source: 'estimate_accept' });
  });
  test('imported line: member_since when it predates the portal\'s first visit', () => {
    expect(P.resolveAnniversary({ firstCompletedVisit: '2026-05-20', acceptedAt: null, memberSince: '2024-05-11' })).toMatchObject({ date: '2024-05-11', source: 'member_since', conflict: false });
    expect(P.resolveAnniversary({ firstCompletedVisit: '2026-05-20', acceptedAt: null, memberSince: null })).toMatchObject({ date: '2026-05-20', source: 'first_visit' });
    expect(P.resolveAnniversary({ firstCompletedVisit: null, acceptedAt: null, memberSince: null })).toMatchObject({ date: null, source: null });
  });
  test('a portal-sold line on an account that predates it by > 90 days is flagged, not held', () => {
    const out = P.resolveAnniversary({ firstCompletedVisit: '2026-09-05', acceptedAt: '2026-09-01T15:00:00Z', memberSince: '2024-05-11' });
    expect(out).toMatchObject({ date: '2026-09-05', source: 'first_visit', conflict: true });
  });
  test('DATE columns read back as their calendar day on a UTC host and an ET host; instants read on the ET calendar', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const script = "const { _private: P } = require(process.argv[1]); const parse = require('pg').types.getTypeParser(1082); process.stdout.write(JSON.stringify({ date: P.dateColumn(parse('2026-06-15')), str: P.dateColumn('2026-06-15'), nul: P.dateColumn(null), instant: P.etDay('2026-06-16T02:30:00Z'), anniversary: P.resolveAnniversary({ firstCompletedVisit: parse('2025-12-05'), acceptedAt: '2025-12-01T16:00:00Z', memberSince: parse('2025-12-01') }) }));";
    for (const TZ of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      const out = JSON.parse(execFileSync(process.execPath, ['-e', script, path.resolve(__dirname, '../services/rate-review.js')], { env: { ...process.env, TZ, GATE_RATE_REVIEW: 'true' }, encoding: 'utf8' }));
      expect(out).toMatchObject({ date: '2026-06-15', str: '2026-06-15', nul: null, instant: '2026-06-15', anniversary: { date: '2025-12-05', source: 'first_visit' } });
    }
  });
  test('"reviewed within 12 months" is judged on batch months with an exclusive boundary', () => {
    expect(P.monthKeyMinus('2027-11', 12)).toBe('2026-11');
    expect(P.monthKeyMinus('2027-01', 12)).toBe('2026-01');
    expect(P.monthKeyMinus('2026-12', 1)).toBe('2026-11');
    // the query: batch_key > (batch − 12 months) AND batch_key <> batch → 2026-11 does NOT block 2027-11; 2027-03 does
    const cutoff = P.monthKeyMinus('2027-11', 12);
    expect('2026-11' > cutoff).toBe(false);
    expect('2026-12' > cutoff).toBe(true);
    expect('2027-03' > cutoff).toBe(true);
  });
  test('tenure in whole ET months', () => {
    expect(P.monthsBetween('2025-12-05', '2026-11-01')).toBe(10);
    expect(P.monthsBetween('2025-12-05', '2026-12-05')).toBe(12);
    expect(P.monthsBetween('2025-12-05', '2026-12-04')).toBe(11);
    expect(P.monthsBetween('2027-01-01', '2026-12-01')).toBe(0);
    // a Feb 29 start observed on Feb 28 (common year) is a full year; Jan 31 → Feb 28 is one month
    expect(P.monthsBetween('2028-02-29', '2029-02-28')).toBe(12);
    expect(P.monthsBetween('2028-02-29', P.anniversaryInWindow('2028-02-29', '2029-02-01', '2029-02-28'))).toBe(12);
    expect(P.monthsBetween('2026-01-31', '2026-02-28')).toBe(1);
    expect(P.monthsBetween('2026-01-31', '2026-02-27')).toBe(0);
    expect(P.monthsBetween('2026-01-30', '2026-03-29')).toBe(1);
  });
  test('the review date is the anniversary\'s occurrence inside the window; a year-long window holds everyone', () => {
    expect(P.anniversaryInWindow('2024-12-11', '2026-12-01', '2026-12-31')).toBe('2026-12-11');
    expect(P.anniversaryInWindow('2025-06-20', '2026-12-01', '2026-12-31')).toBeNull();
    expect(P.anniversaryInWindow('2025-06-20', '2026-01-01', '2026-12-31')).toBe('2026-06-20');
    expect(P.anniversaryInWindow('2024-02-29', '2027-02-01', '2027-02-28')).toBe('2027-02-28'); // observed Feb 28
    expect(P.anniversaryInWindow('2025-01-03', '2026-12-20', '2027-01-10')).toBe('2027-01-03'); // straddles the year end
    expect(P.anniversaryInWindow(null, '2026-12-01', '2026-12-31')).toBeNull();
    // tenure at the review date: a line started 2025-12-05 is 12 months old in the December 2026 batch
    expect(P.monthsBetween('2025-12-05', P.anniversaryInWindow('2025-12-05', '2026-12-01', '2026-12-31'))).toBe(12);
  });
});

// ── review window, carry-forward, replay guards ─────────────────────────

describe('the review window: anniversaries 35–65 days out from the build date', () => {
  test('crosses month and year boundaries; a Feb 1 build still leaves 30+ days before every anniversary it reviews', () => {
    expect(P.REVIEW_WINDOW_FROM_DAYS).toBe(35);
    expect(P.REVIEW_WINDOW_TO_DAYS).toBe(65);
    expect(P.reviewWindowFor(new Date('2027-02-01T11:20:00Z'))).toEqual({ from: '2027-03-08', to: '2027-04-07' });
    expect(P.reviewWindowFor(new Date('2026-11-01T11:20:00Z'))).toEqual({ from: '2026-12-06', to: '2027-01-05' });
    // a late-evening ET build still counts from the ET calendar day
    expect(P.reviewWindowFor(new Date('2026-12-01T03:30:00Z'))).toEqual({ from: '2027-01-04', to: '2027-02-03' }); // 2026-11-30 22:30 ET
    // the monthly job anchors on the FIRST of the build month: a day-2 retry covers the same window as day 1
    expect(P.reviewWindowFor(new Date('2026-11-02T11:20:00Z'), { anchor: '2026-11-01' })).toEqual({ from: '2026-12-06', to: '2027-01-05' });
    expect(P.reviewWindowFor(new Date('2026-11-07T11:20:00Z'), { anchor: '2026-11-01' })).toEqual({ from: '2026-12-06', to: '2027-01-05' });
  });
  test('a retry after a day-1 build that never persisted still anchors on the first of the month — no anniversary falls through', async () => {
    const scripted = fixture.scriptedDb({ planLines: [], customers: [], firstVisits: [], completedVisits: [], estimates: [], terms: [], ledger: [], priorReviews: [], sentRowCount: 0, batchRow: null });
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    const retry = await rateReview.runMonthlyRateReview({ now: new Date('2026-11-02T11:20:00Z'), deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(retry.batchKey).toBe('2026-11');
    expect(retry.window).toEqual({ from: '2026-12-06', to: '2027-01-05' }); // not Dec 7 – Jan 6
    // an ad-hoc admin build with no window still anchors on the build date
    const adhoc = await rateReview.buildBatch({ batchKey: '2026-11', now: new Date('2026-11-02T11:20:00Z') });
    expect(adhoc.window).toEqual({ from: '2026-12-07', to: '2027-01-06' });
  });
  test('buildBatch defaults to that window when no explicit from/to is given, and an explicit window wins', async () => {
    const scripted = fixture.scriptedDb({ planLines: [], customers: [], firstVisits: [], completedVisits: [], estimates: [], terms: [], ledger: [], priorReviews: [], sentRowCount: 0 });
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    const out = await rateReview.buildBatch({ batchKey: '2026-11', now: NOW });
    expect(out.window).toEqual({ from: '2026-12-06', to: '2027-01-05' });
    expect(scripted.writes.batchUpserts[0]).toMatchObject({ window_from: '2026-12-06', window_to: '2027-01-05' });
    const explicit = await rateReview.buildBatch({ batchKey: '2026-11', anniversaryFrom: '2026-01-01', anniversaryTo: '2026-12-31', now: NOW });
    expect(explicit.window).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  test('a rebuild of a batch whose digest already went out resets the one-email marker and says so', async () => {
    const scenario = { planLines: [], customers: [], firstVisits: [], completedVisits: [], estimates: [], terms: [], ledger: [], priorReviews: [], sentRowCount: 0, batchRow: { batch_key: '2026-11', window_from: '2026-12-06', window_to: '2027-01-05', email_sent_at: new Date('2026-11-01T10:30:00Z') } };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    const rebuilt = await rateReview.buildBatch({ batchKey: '2026-11', now: new Date('2026-11-10T11:20:00Z') });
    expect(rebuilt.digestReset).toBe(true);
    const upsert = scripted.writes.batchUpserts[scripted.writes.batchUpserts.length - 1];
    expect(upsert.email_sent_at).toBeNull();
    expect(upsert.email_subject).toBeNull();
    const merged = scripted.mock.results.map((r) => r.value).find((q) => q && q.calls && q.calls.some(([n]) => n === 'merge'));
    expect(merged.calls.find(([n]) => n === 'merge')[1][0]).toEqual(expect.arrayContaining(['email_sent_at', 'email_subject']));
    scenario.batchRow = { batch_key: '2026-11', window_from: '2026-12-06', window_to: '2027-01-05', email_sent_at: null };
    expect((await rateReview.buildBatch({ batchKey: '2026-11', now: new Date('2026-11-10T11:20:00Z') })).digestReset).toBe(false);
  });
  test('a recompute of an EXISTING batch keeps the window it was built with — a later rebuild never slides it and drops rows', async () => {
    const scenario = { planLines: [], customers: [], firstVisits: [], completedVisits: [], estimates: [], terms: [], ledger: [], priorReviews: [], sentRowCount: 0, batchRow: { batch_key: '2026-11', window_from: '2026-12-06', window_to: '2027-01-05' } };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    // rebuilt nine days later: the rolling window would now start Dec 15
    const rebuilt = await rateReview.buildBatch({ batchKey: '2026-11', now: new Date('2026-11-10T11:20:00Z') });
    expect(rebuilt.window).toEqual({ from: '2026-12-06', to: '2027-01-05' });
    // an explicit window still wins, and a batch with no stored row takes the rolling default
    expect((await rateReview.buildBatch({ batchKey: '2026-11', anniversaryFrom: '2026-12-10', anniversaryTo: '2026-12-20', now: new Date('2026-11-10T11:20:00Z') })).window).toEqual({ from: '2026-12-10', to: '2026-12-20' });
    scenario.batchRow = null;
    expect((await rateReview.buildBatch({ batchKey: '2026-11', now: new Date('2026-11-10T11:20:00Z') })).window).toEqual({ from: '2026-12-15', to: '2027-01-14' });
  });
  test('impossible batch months and calendar dates are 400s in the service', async () => {
    await expect(rateReview.buildBatch({ batchKey: '2026-13' })).rejects.toMatchObject({ status: 400 });
    await expect(rateReview.buildBatch({ batchKey: '2026-00' })).rejects.toMatchObject({ status: 400 });
    await expect(rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-02-31', anniversaryTo: '2026-12-31' })).rejects.toMatchObject({ status: 400 });
    expect(P.isBatchKey('2026-12')).toBe(true);
    expect(P.isBatchKey('2026-13')).toBe(false);
    expect(() => P.assertYmd('2026-02-29', 'x')).toThrow(/real calendar date/);
    expect(() => P.assertYmd('2028-02-29', 'x')).not.toThrow();
  });
  test('day lookbacks walk the ET calendar: a window crossing the spring DST change never lands a day early', () => {
    // 2027-03-15 00:30 EDT (04:30Z), the day after the Mar 14 transition: 10 ET days back is Mar 5; fixed 24h ms arithmetic would say Mar 4 (23:30 EST)
    expect(P.daysAgoYmd(new Date('2027-03-15T04:30:00Z'), 10)).toBe('2027-03-05');
    expect(P.daysAgoYmd(new Date('2026-11-01T11:20:00Z'), 90)).toBe('2026-08-03');
    expect(P.daysAgoYmd(new Date('2026-11-01T11:20:00Z'), 365)).toBe('2025-11-01');
  });
  test('the manual-edit cutoff is calendar-exact (Mar 31 − 6 months = Sep 30, never Oct 1)', () => {
    expect(P.monthsAgoYmd(new Date('2027-03-31T16:00:00Z'), 6)).toBe('2026-09-30');
    expect(P.monthsAgoYmd(new Date('2026-11-01T11:20:00Z'), 12)).toBe('2025-11-01');
    expect(P.monthsAgoYmd(new Date('2027-05-31T16:00:00Z'), 3)).toBe('2027-02-28');
  });
});

describe('carry-forward: an exception or skipped line comes back next month', () => {
  const entry = (overrides = {}) => ({ customer: { id: 'c1', member_since: '2024-06-15', created_at: '2024-06-15T12:00:00Z' }, familyKey: 'pest_control', first: null, acceptedAt: null, ...overrides });
  // build 2026-11-01: window Dec 6 – Jan 5; carry floor = 2026-08-03
  const args = { from: '2026-12-06', to: '2027-01-05', now: NOW };
  test('a line whose latest earlier snapshot was an exception within 90 days is carried with its original review date', () => {
    const latest = new Map([['c1|pest_control', { status: 'exception', review_date: '2026-10-15', batch_key: '2026-09', computed_at: '2026-09-01T10:00:00Z' }]]);
    const e = entry({ customer: { id: 'c1', member_since: '2025-10-15', created_at: '2025-10-15T12:00:00Z' } }); // October anniversary, outside the window
    const selected = P.selectReviewEntries([e], { ...args, latestByLine: latest });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ reviewDate: '2026-10-15', carriedFrom: '2026-09' });
    expect(P.CARRY_FORWARD_STATUSES).toEqual(['exception', 'skipped']);
    expect(P.CARRY_FORWARD_MAX_DAYS_PAST).toBe(90);
  });
  test('skipped carries too; green / no_change / approved do not; nothing earlier → nothing carried', () => {
    const e = entry({ customer: { id: 'c1', member_since: '2025-10-15', created_at: '2025-10-15T12:00:00Z' } });
    const sel = (status) => P.selectReviewEntries([e], { ...args, latestByLine: new Map([['c1|pest_control', { status, review_date: '2026-10-15', batch_key: '2026-09', computed_at: '2026-09-01T10:00:00Z' }]]) });
    expect(sel('skipped')).toHaveLength(1);
    expect(sel('green')).toHaveLength(0);
    expect(sel('no_change')).toHaveLength(0);
    expect(sel('approved')).toHaveLength(0);
    expect(P.selectReviewEntries([e], { ...args, latestByLine: new Map() })).toHaveLength(0);
  });
  test('the carry stops once the review date is more than 90 days behind the build, and never pulls a date beyond the window', () => {
    const e = entry({ customer: { id: 'c1', member_since: '2025-07-20', created_at: '2025-07-20T12:00:00Z' } });
    const tooOld = new Map([['c1|pest_control', { status: 'exception', review_date: '2026-07-20', batch_key: '2026-06', computed_at: '2026-06-01T10:00:00Z' }]]);
    expect(P.selectReviewEntries([e], { ...args, latestByLine: tooOld })).toHaveLength(0);
    const justInside = new Map([['c1|pest_control', { status: 'exception', review_date: '2026-08-03', batch_key: '2026-07', computed_at: '2026-07-01T10:00:00Z' }]]);
    expect(P.selectReviewEntries([e], { ...args, latestByLine: justInside })).toHaveLength(1);
    const beyond = new Map([['c1|pest_control', { status: 'exception', review_date: '2027-02-10', batch_key: '2026-10', computed_at: '2026-10-01T10:00:00Z' }]]);
    expect(P.selectReviewEntries([e], { ...args, latestByLine: beyond })).toHaveLength(0);
    // a row with no review date anchors on when it was computed
    const noDate = new Map([['c1|pest_control', { status: 'skipped', review_date: null, batch_key: '2026-10', computed_at: '2026-10-01T10:00:00Z' }]]);
    expect(P.selectReviewEntries([e], { ...args, latestByLine: noDate })[0]).toMatchObject({ reviewDate: '2026-10-01', carriedFrom: '2026-10' });
  });
  test('an in-window anniversary is never a carry (its own review date wins)', () => {
    const e = entry({ customer: { id: 'c1', member_since: '2025-12-20', created_at: '2025-12-20T12:00:00Z' } });
    const latest = new Map([['c1|pest_control', { status: 'exception', review_date: '2026-10-15', batch_key: '2026-09', computed_at: '2026-09-01T10:00:00Z' }]]);
    expect(P.selectReviewEntries([e], { ...args, latestByLine: latest })[0]).toMatchObject({ reviewDate: '2026-12-20', carriedFrom: null });
  });
  test('end to end: a past-due exception from the September batch is re-ranked in the November build with carried_forward and its review_date', async () => {
    const book = fixture.decemberBook();
    const octoberAccount = fixture.customer(15, { member_since: '2024-10-20', last_name: 'Carried' }); // October anniversary
    const scenario = {
      planLines: [...book.planLines, fixture.planLine(octoberAccount.id, 'pest_control', 'quarterly', 110)],
      customers: [...book.customerRows, octoberAccount], firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms,
      ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
      latestSnapshots: [{ customer_id: octoberAccount.id, family_key: 'pest_control', status: 'exception', review_date: '2026-10-20', batch_key: '2026-09', computed_at: '2026-09-01T10:20:00Z' }],
    };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
    await rateReview.buildBatch({ batchKey: '2026-11', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === octoberAccount.id);
    expect(row).toMatchObject({ review_date: '2026-10-20', anniversary_date: '2024-10-20', tenure_months: 24, list_rate_source: 'cadence_mode' });
    expect(JSON.parse(row.flags)).toContain('carried_forward');
    // the latest-snapshot read looked only at earlier batches
    const latestRead = scripted.mock.results.map((r) => r.value).find((q) => q && q.calls && q.calls.some(([name, a]) => name === 'select' && a.includes('review_date')));
    expect(latestRead.calls).toEqual(expect.arrayContaining([['where', ['batch_key', '<', '2026-11']]]));
  });
});

describe('engine replay guards', () => {
  const book = fixture.decemberBook();
  function scenarioWith(engine) {
    const scripted = fixture.scriptedDb({ planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {} });
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
    return { scripted, run: () => rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: engine } }) };
  }
  test('syncConstantsFromDB() returning false means NO engine list — never a price off stale in-memory constants', async () => {
    const engine = { ...fixture.fakePricingEngine(), needsSync: () => true, syncConstantsFromDB: jest.fn(async () => false) };
    const { scripted, run } = scenarioWith(engine);
    await run();
    expect(engine.syncConstantsFromDB).toHaveBeenCalled();
    expect(engine.generateEstimate).not.toHaveBeenCalled();
    const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === book.customers.belowList.id);
    expect(row.list_rate_source).toBe('cadence_mode');
    expect(JSON.parse(row.flags)).toEqual(expect.arrayContaining(['engine_sync_failed', 'list_from_cadence_mode']));
  });
  test('constants are refreshed once per batch UNCONDITIONALLY — needsSync() saying "fresh" on this pod is not trusted', async () => {
    const engine = { ...fixture.fakePricingEngine(), needsSync: () => false, syncConstantsFromDB: jest.fn(async () => false) };
    const { scripted, run } = scenarioWith(engine);
    await run();
    expect(engine.syncConstantsFromDB).toHaveBeenCalledTimes(1);
    expect(engine.generateEstimate).not.toHaveBeenCalled();
    expect(JSON.parse(scripted.writes.snapshotInserts.find((r) => r.customer_id === book.customers.belowList.id).flags)).toContain('engine_sync_failed');
    const throwing = { ...fixture.fakePricingEngine(), syncConstantsFromDB: jest.fn(async () => { throw new Error('db down'); }) };
    const b = scenarioWith(throwing);
    await b.run();
    expect(throwing.generateEstimate).not.toHaveBeenCalled();
    expect(await P.syncPricingConstants({ pricingEngine: { generateEstimate: () => ({}) } })).toBe(true); // an engine with no bridge has nothing to refresh
  });
  test('a replay that throws is engine_replay_failed, and a sync that succeeds prices normally', async () => {
    const throwing = { ...fixture.fakePricingEngine(), needsSync: () => false, generateEstimate: jest.fn(() => { throw new Error('boom'); }) };
    const a = scenarioWith(throwing);
    await a.run();
    expect(JSON.parse(a.scripted.writes.snapshotInserts.find((r) => r.customer_id === book.customers.belowList.id).flags)).toContain('engine_replay_failed');
    const fine = { ...fixture.fakePricingEngine(), needsSync: () => true, syncConstantsFromDB: jest.fn(async () => true) };
    const b = scenarioWith(fine);
    await b.run();
    expect(b.scripted.writes.snapshotInserts.find((r) => r.customer_id === book.customers.belowList.id).list_rate_source).toBe('engine');
  });
  test('an engine line that needs a human is held as list_low_confidence, not ranked as a list price', async () => {
    const engine = fixture.fakePricingEngine();
    const base = engine.generateEstimate.getMockImplementation();
    engine.generateEstimate = jest.fn((inputs) => { const r = base(inputs); r.lineItems = r.lineItems.map((i) => ({ ...i, pricingConfidence: 'LOW' })); return r; });
    const { scripted, run } = scenarioWith(engine);
    await run();
    const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === book.customers.belowList.id);
    expect(row.status).toBe('exception');
    expect(row.list_rate_source).toBe('cadence_mode');
    expect(JSON.parse(row.flags)).toContain('list_low_confidence');
    // the canonical predicates: manual review, measurement, custom quote, heuristic turf, LOW confidence
    expect(P.engineItemLowConfidence({ requiresManualReview: true })).toBe(true);
    expect(P.engineItemLowConfidence({ manualReviewReasons: ['x'] })).toBe(true);
    expect(P.engineItemLowConfidence({ turfBasis: 'lotFallback' })).toBe(true);
    expect(P.engineItemLowConfidence({ turfConfidence: 'low' })).toBe(true);
    expect(P.engineItemLowConfidence({ requiresMeasurement: true })).toBe(true);
    expect(P.engineItemLowConfidence({ pricingConfidence: 'HIGH', turfBasis: 'measuredTurfSf' })).toBe(false);
    expect(P.listRateFromEngineResult({ lineItems: [{ service: 'pest_control', annualAfterDiscount: 468, visitsPerYear: 4, requiresCustomQuote: true }], waveGuard: { tier: 'bronze' } }, 'pest_control', 'quarterly')).toMatchObject({ lowConfidence: true });
  });
  test('the NEWEST accepted estimate is replayed for the list; the earliest acceptance still anchors the anniversary', async () => {
    const engine = fixture.fakePricingEngine();
    const customer = book.customers.belowList;
    const newer = fixture.estimate(9, customer.id, { homeSqFt: 3400, acceptedAt: '2026-08-01T16:00:00Z' });
    const scripted = fixture.scriptedDb({
      planLines: book.planLines.map((p) => (p.customer_id === customer.id ? { ...p, source_estimate_ids: [fixture.ESTIMATE(1), fixture.ESTIMATE(9)] } : p)),
      customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: [...book.estimates, newer], terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    });
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: engine } });
    const replayed = engine.generateEstimate.mock.calls.map(([inputs]) => inputs.homeSqFt);
    expect(replayed[0]).toBe(3400); // newest first
    const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === customer.id);
    expect(row.anniversary_date).toBe('2025-12-05'); // first completed visit after the EARLIEST acceptance (2025-11-28)
  });
  test('held lanes never feed the cadence mode: three per_visit accounts cannot become a clean account\'s list rate', async () => {
    const perVisit = [20, 21, 22].map((n) => fixture.customer(n, { member_since: '2024-11-0' + (n - 19), billing_mode: 'per_visit', last_name: 'PV ' + n }));
    const clean = fixture.customer(23, { member_since: '2024-12-09', last_name: 'Clean No Estimate' });
    const scenario = {
      // only the per_visit accounts and the clean account share pest/bimonthly — no estimate anywhere on this cadence
      planLines: [...perVisit.map((c) => fixture.planLine(c.id, 'pest_control', 'bimonthly', 95)), fixture.planLine(clean.id, 'pest_control', 'bimonthly', 90)],
      customers: [...perVisit, clean], firstVisits: [], completedVisits: [], estimates: [], terms: [], ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async () => fixture.facts());
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: [] }));
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === clean.id);
    expect(row.list_rate_source).toBe('none');
    expect(row.status).toBe('skipped');
    expect(JSON.parse(row.flags)).toContain('no_list_rate');
  });
  test('commercial accounts are no pricing reference: out of the cadence mode and the $/hr quartiles', async () => {
    // December anniversaries (imported lines: member_since 2024-12-10/11/12) so every fixture sits in the December window
    const commercial = [24, 25, 26].map((n) => fixture.customer(n, { member_since: '2024-12-1' + (n - 24), property_type: 'commercial', last_name: 'Commercial ' + n }));
    const clean = fixture.customer(27, { member_since: '2024-12-09', last_name: 'Residential No Estimate' });
    const scenario = {
      planLines: [...commercial.map((c) => fixture.planLine(c.id, 'pest_control', 'bimonthly', 250)), fixture.planLine(clean.id, 'pest_control', 'bimonthly', 90)],
      customers: [...commercial, clean], firstVisits: [], completedVisits: [], estimates: [], terms: [], ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async () => fixture.facts());
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: [] }));
    const out = await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === clean.id);
    expect(row.list_rate_source).toBe('none'); // three commercial $250 contracts never became the residential list rate
    expect(row.status).toBe('skipped');
    expect(out.lineRph.pest_control).toBeUndefined();
    for (const c of commercial) {
      const commercialRow = scripted.writes.snapshotInserts.find((r) => r.customer_id === c.id);
      expect(commercialRow).toBeDefined();
      expect(commercialRow.status).toBe('exception');
      expect(JSON.parse(commercialRow.flags)).toContain('commercial');
    }
  });
  test('a config read that FAILS fails the batch; a missing row still defaults', async () => {
    const failing = fixture.scriptedDb({ planLines: [], customers: [], configError: new Error('relation unavailable') });
    db.mockImplementation((table) => failing(table));
    db.raw.mockImplementation((...args) => failing.raw(...args));
    await expect(rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW })).rejects.toThrow('relation unavailable');
    expect(failing.writes.snapshotInserts).toHaveLength(0);
    expect(failing.writes.batchUpserts).toHaveLength(0);
    const missing = fixture.scriptedDb({ planLines: [], customers: [], config: null });
    db.mockImplementation((table) => missing(table));
    db.raw.mockImplementation((...args) => missing.raw(...args));
    db.transaction.mockImplementation((fn) => missing.transaction(fn));
    expect((await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW })).config).toMatchObject(DEFAULT_CONFIG);
  });
  test('an unclassified family never borrows a list rate from other unclassified lines and is held', async () => {
    const others = [16, 17, 18].map((n) => fixture.customer(n, { member_since: '2024-12-0' + (n - 15), last_name: 'Other ' + n }));
    const scenario = {
      planLines: [...book.planLines, ...others.map((c) => fixture.planLine(c.id, 'other', 'quarterly', 150))],
      customers: [...book.customerRows, ...others], firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms,
      ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    for (const c of others) {
      const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === c.id);
      expect(row.list_rate_source).toBe('none');
      expect(row.status).toBe('exception');
      expect(JSON.parse(row.flags)).toContain('unsupported_family');
    }
  });
  test('the book and history loaders mirror the canonical purchased-plan row predicate', () => {
    const { isPlanSeriesRow, isCountingSourceStatus, COUNTING_SOURCE_STATUSES } = require('../services/recurring-series-cancel-reseed');
    // the SQL says what isPlanSeriesRow says: recurring root or legacy child, never a booster, callback or included follow-up
    expect(P.PLAN_ROW_SQL).toMatch(/s\.is_recurring = true OR \(s\.is_recurring IS NULL AND s\.recurring_parent_id IS NOT NULL\)/);
    expect(P.PLAN_ROW_SQL).toMatch(/COALESCE\(s\.is_callback, false\) = false/);
    expect(P.PLAN_ROW_SQL).toMatch(/COALESCE\(s\.followup_included, false\) = false/);
    expect(isPlanSeriesRow({ is_recurring: false, recurring_parent_id: 'root' })).toBe(false); // booster
    expect(isPlanSeriesRow({ is_recurring: true, is_callback: true })).toBe(false);
    expect(isPlanSeriesRow({ is_recurring: null, recurring_parent_id: 'root' })).toBe(true);
    // live statuses = the reconciler's counting statuses (no 'rescheduled' placeholder)
    expect(P.LIVE_STATUS_SQL).toBe(`(s.status IS NULL OR s.status IN (${COUNTING_SOURCE_STATUSES.map((st) => `'${st}'`).join(', ')}))`);
    expect(isCountingSourceStatus('rescheduled')).toBe(false);
    expect(P.LIVE_STATUS_SQL).not.toMatch(/rescheduled/);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    const planQuery = src.slice(src.indexOf('async function loadActivePlanLines'), src.indexOf('async function loadCustomers'));
    expect(planQuery).toMatch(/\$\{LIVE_STATUS_SQL\}/);
    expect(planQuery).toMatch(/\$\{PLAN_ROW_SQL\}/);
    // the scheduled row's frozen category snapshot outranks the live (mutable) catalog category
    expect(src).toMatch(/COALESCE\(s\.service_category_snapshot, sv\.category,/);
    expect(src).not.toMatch(/COALESCE\(sv\.category, s\.service_category_snapshot/);
    for (const fn of ['loadFirstCompletedVisits', 'loadCompletedVisitRows']) {
      const body = src.slice(src.indexOf(`async function ${fn}`), src.indexOf('`, [', src.indexOf(`async function ${fn}`)));
      expect(body).toMatch(/\$\{PLAN_ROW_SQL\}/);
    }
    expect(src).not.toMatch(/RECURRING_SQL/);
    expect(planQuery).toMatch(/c\.active = true/);
    expect(planQuery).toMatch(/c\.pipeline_stage IN \('active_customer', 'won', 'at_risk'\)/);
    const revenue = src.slice(src.indexOf('(SELECT sum(LEAST('), src.indexOf('AS paid_revenue'));
    expect(revenue).toMatch(/refund_amount/);
    // linked the way invoice.js links payments to invoices — never a payments.invoice_id (there is none)
    expect(revenue).toMatch(/p\.stripe_payment_intent_id = i\.stripe_payment_intent_id/);
    expect(revenue).toMatch(/metadata::jsonb ->> 'invoice_id' = i\.id::text/);
    expect(revenue).not.toMatch(/p\.invoice_id/);
    // settled monthly dues are net of refunds on BOTH rails — netting one alone would let the other's gross figure win GREATEST
    const dues = src.slice(src.indexOf('async function loadSettledDues'), src.indexOf('function duesPerVisitCents'));
    // a partial refund returns its surcharge share too (refunded_surcharge_cents) — only the BASE refund comes off revenue, on every rail
    expect(P.REFUND_BASE_SQL).toBe('GREATEST(COALESCE(p.refund_amount, 0) - COALESCE(p.refunded_surcharge_cents, 0) / 100.0, 0)');
    expect(dues).toMatch(/sum\(amount - COALESCE\(surcharge_amount_cents, 0\) \/ 100\.0 - GREATEST\(COALESCE\(refund_amount, 0\) - COALESCE\(refunded_surcharge_cents, 0\) \/ 100\.0, 0\)\)/);
    expect(dues).toMatch(/\$\{REFUND_BASE_SQL\}/);
    expect(revenue).toMatch(/SELECT sum\(\$\{REFUND_BASE_SQL\}\) FROM payments p/);
    expect(src).not.toMatch(/sum\(COALESCE\(p\.refund_amount, 0\)\)/);
    // an invoice linked only through its service record (invoice.js linkedScheduledServiceId) still pairs its revenue
    const completed = src.slice(src.indexOf('async function loadCompletedVisitRows'), src.indexOf('async function loadEstimates'));
    expect(completed).toMatch(/SELECT DISTINCT ON \(scheduled_service_id\) scheduled_service_id, id AS service_record_id,/);
    expect(revenue).toMatch(/OR \(i\.service_record_id IS NOT NULL AND i\.service_record_id = sr\.service_record_id\)/);
    expect(dues).toMatch(/sum\(i\.total\) - COALESCE\(sum\(\(/);
    expect(dues).toMatch(/GREATEST\(COALESCE\(inv\.amount, 0\), COALESCE\(pay\.amount, 0\)\)/);
  });
  test('the current rate is the recurring application\'s own price (rowServicePrice), never a composite visit\'s appointment total', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    const planQuery = src.slice(src.indexOf('async function loadActivePlanLines'), src.indexOf('async function loadCustomers'));
    // estimate-membership-context.js rowServicePrice: no add-ons → estimated_price; composite → primary net of its line discount; appointment-level discount → withheld
    expect(planQuery).toMatch(/NOT EXISTS \(SELECT 1 FROM scheduled_service_addons a WHERE a\.scheduled_service_id = s\.id\)/);
    expect(planQuery).toMatch(/COALESCE\(s\.discount_dollars, 0\) > 0 OR s\.discount_type IS NOT NULL OR s\.discount_id IS NOT NULL THEN NULL/);
    expect(planQuery).toMatch(/s\.primary_line_price - COALESCE\(s\.line_discount_dollars, 0\) > 0/);
    expect(planQuery).toMatch(/WITHIN GROUP \(ORDER BY service_price\) FILTER \(WHERE service_price > 0\) AS median_price/);
    expect(planQuery).not.toMatch(/ORDER BY estimated_price/);
    expect(planQuery).toMatch(/count\(\*\) FILTER \(WHERE service_price IS NULL AND estimated_price > 0\)::int AS withheld_visits/);
    // every priced open visit composite with an unattributable discount → no application price → held, never the account fee
    const customer = fixture.customer(1, { billing_mode: 'per_application', per_application_fee: 95 });
    const withheld = P.resolveCurrentRate({ customer, planLine: fixture.planLine('c', 'pest_control', 'quarterly', null, { withheld_visits: 3 }), liveTerms: [], ledgerSlice: null });
    expect(withheld).toMatchObject({ cents: 0, source: 'none', unit: 'application', rateUnattributed: true, compositeWithheld: true });
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'pest_control', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'per_application', anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 0, currentRateSource: 'none', rateUnit: 'application', rateUnattributed: true, compositeWithheld: true, facts: fixture.facts() });
    expect(row.status).toBe('skipped');
    expect(row.flags).toEqual(expect.arrayContaining(['rate_unattributed', 'composite_discount_withheld', 'no_current_rate']));
    // visits that do decompose still price the line; an unpriced book still falls to the fee
    expect(P.resolveCurrentRate({ customer, planLine: fixture.planLine('c', 'pest_control', 'quarterly', 117, { withheld_visits: 1 }), liveTerms: [], ledgerSlice: null })).toMatchObject({ cents: 11700, source: 'visit_median' });
    expect(P.resolveCurrentRate({ customer, planLine: fixture.planLine('c', 'pest_control', 'quarterly', null), liveTerms: [], ledgerSlice: null })).toMatchObject({ cents: 9500, source: 'per_application_fee' });
  });
  test('a composite visit (add-ons in the same stop) is no $/hr or wall-clock evidence for the line — excluded and counted, never the whole stop\'s money over the whole stop\'s clock', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    const q = src.slice(src.indexOf('async function loadCompletedVisitRows'), src.indexOf('async function loadEstimates'));
    expect(q).toMatch(/EXISTS \(SELECT 1 FROM scheduled_service_addons a WHERE a\.scheduled_service_id = s\.id\) AS composite_visit/);
    const plain = [40, 42, 44].map((m) => fixture.visit('c', 'pest_control', { minutes: m, interaction: 'not_home_full_access', revenue: 117 }));
    const composite = [75, 80].map((m) => fixture.visit('c', 'pest_control', { minutes: m, interaction: 'not_home_full_access', revenue: 192, composite: true }));
    const stats = P.lineDurationStats([...plain, ...composite]);
    expect(stats).toMatchObject({ usableVisits: 3, notHomeVisits: 3, compositeVisits: 2, treatmentMinutesMedian: 42 });
    expect(stats.revenuePerHourCents).toBe(P.lineDurationStats(plain).revenuePerHourCents);
    // only composite visits → no evidence at all (no $/hr, so no nudge either — never a biased one)
    expect(P.lineDurationStats(composite)).toMatchObject({ usableVisits: 0, compositeVisits: 2, revenuePerHourCents: null, treatmentMinutesMedian: null });
    // the home / not-home allowance medians skip them too
    const book = [
      ...[30, 31, 32].map((m) => fixture.visit('h', 'pest_control', { minutes: m, interaction: 'tech_home_spoke_with_them' })),
      ...[20, 21, 22].map((m) => fixture.visit('n', 'pest_control', { minutes: m, interaction: 'not_home_full_access' })),
      ...[90, 95, 99].map((m) => fixture.visit('x', 'pest_control', { minutes: m, interaction: 'tech_home_spoke_with_them', composite: true })),
    ];
    expect(P.computeLineAllowances(book).pest_control).toMatchObject({ allowance_minutes: 10, home_median: 31, not_home_median: 21, home_n: 3, not_home_n: 3, source: 'line' });
    // the owner sees why the evidence is thinner
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'pest_control', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'per_application', anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 11700, rateUnit: 'application', listRateCents: 11700, usableVisits: 3, compositeVisits: 2, facts: fixture.facts() });
    expect(row.flags).toContain('composite_visits_excluded');
    expect(row.status).not.toBe('exception');
  });
  test('a combined completion-packet invoice credits each member its own settled share, never its whole total to the anchor member', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    const revenue = src.slice(src.indexOf('(SELECT sum(LEAST('), src.indexOf('AS paid_revenue'));
    // visit-completion-invoice.js mintPacketInvoice: one invoice under billed[0].member.id, members linked via visit_completion_packet_items.invoice_id
    expect(revenue).toMatch(/OR EXISTS \(SELECT 1 FROM visit_completion_packet_items pm2 WHERE pm2\.invoice_id = i\.id AND pm2\.scheduled_service_id = s\.id\)/);
    expect(revenue).toMatch(/LEFT JOIN LATERAL \(/);
    expect(revenue).toMatch(/COALESCE\(s\.estimated_price, s\.primary_line_price, 0\) \/ sum\(COALESCE\(m\.estimated_price, m\.primary_line_price\)\)/);
    expect(revenue).toMatch(/HAVING count\(\*\) > 1/);
    // a combined first-application invoice (estimate-converter stamps the anchor AND each covered sibling with its id) splits the same way; a member with no price makes the whole invoice unattributable
    expect(revenue).toMatch(/OR s\.first_application_invoice_id = i\.id/);
    expect(revenue).toMatch(/SELECT b\.id FROM scheduled_services b WHERE b\.first_application_invoice_id = i\.id/);
    expect(revenue).toMatch(/WHEN count\(\*\) FILTER \(WHERE COALESCE\(m\.estimated_price, m\.primary_line_price\) > 0\) < count\(\*\) THEN 0/);
    // the deposit paid at acceptance is consideration: total is the remaining balance, the credit survives as the negative deposit_credit line
    expect(P.depositCreditSql('i')).toMatch(/WHERE dc ->> 'category' = 'deposit_credit'/);
    expect(P.depositCreditSql('i')).toMatch(/SELECT -sum\(NULLIF\(regexp_replace\(dc ->> 'amount'/);
    expect(revenue).toMatch(/\), 0\) \+ \$\{depositCreditSql\('i'\)\},/); // net settled consideration
    expect(revenue).toMatch(/ELSE i\.total \+ \$\{depositCreditSql\('i'\)\} END/); // the plain-invoice cap
    expect(revenue).toMatch(/AND COALESCE\(li ->> 'category', ''\) <> 'deposit_credit'\)/); // never netted out of the application lines
    const q = src.slice(src.indexOf('async function loadCompletedVisitRows'), src.indexOf('async function loadEstimates'));
    expect(q).toMatch(/\), 0\) \+ \$\{depositCreditSql\('pi'\)\}\)/); // the prepay settlement too
    expect(revenue).toMatch(/\) \* COALESCE\(share\.fraction, 1\)\)/);
    expect(revenue).not.toMatch(/WHERE i\.scheduled_service_id = s\.id AND/);
  });
  test('a monthly replay must price every ledger component — a palm program sold on a separate estimate is no rider of the bed replay', () => {
    const bedOnly = { lineItems: [{ service: 'tree_shrub', annualAfterDiscount: 360, visitsPerYear: 6 }], waveGuard: { tier: 'silver' } };
    expect(P.listRateFromEngineResult(bedOnly, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: ['tree_shrub', 'palm_injection'] })).toEqual({ bundleIncomplete: true, missingServices: ['palm_injection'], tier: 'silver' });
    // the reverse: a palm-only replay cannot stand in for a slice that also pays for the bed program
    const palmOnly = { lineItems: [{ service: 'palm_injection', annualAfterDiscount: 300, visitsPerYear: 2 }], waveGuard: { tier: 'bronze' } };
    expect(P.listRateFromEngineResult(palmOnly, 'tree_shrub', 'semiannual', { includeRiders: true, riderAllow: ['tree_shrub', 'palm_injection'] })).toMatchObject({ bundleIncomplete: true, missingServices: ['tree_shrub'] });
    // a slice that carries only what the replay priced is complete; the per-application lane never needs riders
    expect(P.listRateFromEngineResult(bedOnly, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: ['tree_shrub'] })).toMatchObject({ monthlyCents: 3000, riderServices: [] });
    expect(P.listRateFromEngineResult(bedOnly, 'tree_shrub', 'bimonthly', { riderAllow: ['tree_shrub', 'palm_injection'] })).toMatchObject({ perAppCents: 6000 });
    // ledger keys outside this line's engine programs (an unrelated family in the slice) are not required of the replay
    expect(P.listRateFromEngineResult(bedOnly, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: ['tree_shrub', 'unattributed'] })).toMatchObject({ monthlyCents: 3000 });
    // and the held line is an exception, not a silent one-program comparison
    expect(rateReview.EXCEPTION_FLAGS).toContain('list_bundle_incomplete');
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'tree_shrub', cadence: 'bimonthly', visitsPerYear: 6, billingLane: 'monthly_membership', anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 4250, rateUnit: 'month', listRateCents: null, listBundleIncomplete: true, facts: fixture.facts() });
    expect(row.status).toBe('exception');
    expect(row.flags).toContain('list_bundle_incomplete');
  });
  test('a downward-performance nudge (B → C on bottom-quartile $/hr) never proposes less than the pass-through', () => {
    const lineRph = { q1: 8000, median: 9000, q3: 10000, n: 4 };
    const unnudged = P.classifyBand({ currentCents: 11500, listCents: 11700, config: DEFAULT_CONFIG });
    expect(unnudged).toMatchObject({ band: 'B', proposedCents: 11900, deltaCents: 400, noChange: false });
    const nudged = P.classifyBand({ currentCents: 11500, listCents: 11700, rph: 7000, lineRph, usableVisits: 4, config: DEFAULT_CONFIG });
    expect(nudged.flags).toContain('rph_bottom_quartile');
    expect(nudged).toMatchObject({ band: 'C', proposedCents: 11900, deltaCents: 400, noChange: false }); // list ($117) sits under the pass-through — never no_change
    // when list is the bigger ask, C still goes to list
    const wideGap = P.classifyBand({ currentCents: 11000, listCents: 11500, rph: 7000, lineRph, usableVisits: 4, config: DEFAULT_CONFIG });
    expect(wideGap).toMatchObject({ band: 'C', proposedCents: 11500 });
  });
  test('a no-estimate line backdates to member_since only when it was running at import; a program first seen later starts at its first visit', () => {
    // the account reached the portal with a pest program (first visit Apr 5); lawn was first seen Aug 20
    const pest = P.resolveAnniversary({ firstCompletedVisit: '2026-04-05', acceptedAt: null, memberSince: '2024-12-10', accountFirstVisit: '2026-04-05', presenceWindowDays: P.presenceWindowFor(4) });
    expect(pest).toMatchObject({ date: '2024-12-10', source: 'member_since', conflict: false });
    const lawn = P.resolveAnniversary({ firstCompletedVisit: '2026-08-20', acceptedAt: null, memberSince: '2024-12-10', accountFirstVisit: '2026-04-05', presenceWindowDays: P.presenceWindowFor(9) });
    expect(lawn).toMatchObject({ date: '2026-08-20', source: 'first_visit', conflict: true }); // informational: member_since predates it
    // a semiannual program's first visit may trail the account's by its own interval — still present at import
    expect(P.presenceWindowFor(2)).toBe(213);
    expect(P.resolveAnniversary({ firstCompletedVisit: '2026-10-01', acceptedAt: null, memberSince: '2024-12-10', accountFirstVisit: '2026-04-05', presenceWindowDays: P.presenceWindowFor(2) }).source).toBe('member_since');
    expect(P.presenceWindowFor(4)).toBe(121);
    expect(P.presenceWindowFor(null)).toBe(90);
    // no account-level evidence keeps the old rule
    expect(P.resolveAnniversary({ firstCompletedVisit: '2026-08-20', acceptedAt: null, memberSince: '2024-12-10' }).source).toBe('member_since');
    // the batch passes the account's earliest visit and the line's cadence window
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    expect(src).toMatch(/accountFirstVisit: accountFirst\.get\(entry\.customer\.id\) \|\| null,\n\s+presenceWindowDays: presenceWindowFor\(entry\.visitsPerYear\),/);
  });
  test('the sold-mix replay (hand-picked-tier evidence) keeps the stamped rodent posture; the current-list replay strips it', async () => {
    const engine = { generateEstimate: jest.fn(() => ({ lineItems: [], waveGuard: { tier: 'bronze' } })) };
    const estimate = { id: 'e-rodent', estimate_data: { engineInputs: { homeSqFt: 2000, rodentBaitLegacyReplay: { qualifies: false }, rodentWaveguardPostureReplay: { posture: 'legacy' }, services: { pest: { frequency: 'quarterly' }, rodentBait: {} } } } };
    await P.replayEstimate(estimate, { familyKey: null, cadence: null, activeFamilies: null, soldMix: true }, { pricingEngine: engine, engineSynced: true, translateV2CallToV1Input: null });
    expect(engine.generateEstimate.mock.calls[0][0]).toMatchObject({ rodentBaitLegacyReplay: { qualifies: false }, rodentWaveguardPostureReplay: { posture: 'legacy' } });
    await P.replayEstimate(estimate, { familyKey: 'pest_control', cadence: 'quarterly', activeFamilies: ['pest_control', 'rodent'] }, { pricingEngine: engine, engineSynced: true, translateV2CallToV1Input: null });
    expect(engine.generateEstimate.mock.calls[1][0].rodentBaitLegacyReplay).toBeUndefined();
    expect(engine.generateEstimate.mock.calls[1][0].rodentWaveguardPostureReplay).toBeUndefined();
    expect(P.SOLD_POSTURE_KEYS).toEqual(['rodentBaitLegacyReplay', 'rodentWaveguardPostureReplay']);
  });
  test('the whole-account dues fallback compares against every program the line carries', () => {
    expect(P.engineKeysForLine('tree_shrub', ['tree_shrub_program', 'palm_injection_semiannual'])).toEqual(['tree_shrub', 'palm_injection']);
    expect(P.engineKeysForLine('tree_shrub', ['palm_injection_semiannual'])).toEqual(['palm_injection']);
    expect(P.engineKeysForLine('pest_control', ['pest_control_quarterly'])).toEqual(['pest_control']);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/rate-review.js'), 'utf8');
    expect(src).toMatch(/const bundledDues = monthly && \['ledger_slice', 'monthly_rate'\]\.includes\(current\.source\);/);
    expect(src).toMatch(/riderAllow: current\.source === 'ledger_slice' && ledgerSlice \? ledgerSlice\.family_keys : engineKeysForLine\(familyKey, serviceKeys\)/);
    // a $45 combined dues rate beside a bed-only replay is held, never a false no-change
    const bedOnly = { lineItems: [{ service: 'tree_shrub', annualAfterDiscount: 540, visitsPerYear: 6 }], waveGuard: { tier: 'silver' } };
    expect(P.listRateFromEngineResult(bedOnly, 'tree_shrub', 'bimonthly', { includeRiders: true, riderAllow: P.engineKeysForLine('tree_shrub', ['tree_shrub_program', 'palm_injection_semiannual']) })).toMatchObject({ bundleIncomplete: true, missingServices: ['palm_injection'] });
  });
  test('a family restarted on a new estimate takes the first completed visit of the current series', () => {
    const first = { first_visit: '2024-03-10', completed_dates: ['2024-03-10', '2024-06-10', '2026-07-02', '2026-10-02'] };
    expect(P.firstCompletedVisitFor(first, '2026-06-20T15:00:00Z')).toBe('2026-07-02');
    expect(P.firstCompletedVisitFor(first, null)).toBe('2024-03-10');
    expect(P.firstCompletedVisitFor({ first_visit: '2024-03-10', completed_dates: [] }, '2026-06-20T15:00:00Z')).toBe('2024-03-10');
    expect(P.firstCompletedVisitFor({ first_visit: '2026-05-05' }, null)).toBe('2026-05-05');
    expect(P.firstCompletedVisitFor(null, null)).toBeNull();
    // no completion yet on the current series → the accept date anchors the anniversary
    expect(P.resolveAnniversary({ firstCompletedVisit: P.firstCompletedVisitFor(first, '2026-11-20T15:00:00Z'), acceptedAt: '2026-11-20T15:00:00Z', memberSince: '2024-03-01' })).toMatchObject({ date: '2026-11-20', source: 'estimate_accept' });
  });
});

// ── gate off ────────────────────────────────────────────────────────────

describe('gate off is a no-op', () => {
  test('buildBatch and the monthly job return before any query', async () => {
    process.env.GATE_RATE_REVIEW = 'false';
    expect(await rateReview.buildBatch({ batchKey: '2026-12' })).toEqual({ ok: false, reason: 'gate_off' });
    expect(await rateReview.runMonthlyRateReview({ now: NOW })).toEqual({ skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    expect(mockFacts).not.toHaveBeenCalled();
  });
  test('"TRUE" / "1" / unset are off (strict === "true")', async () => {
    for (const value of ['TRUE', '1', 'on', '']) {
      process.env.GATE_RATE_REVIEW = value;
      expect(await rateReview.buildBatch({ batchKey: '2026-12' })).toEqual({ ok: false, reason: 'gate_off' });
    }
    delete process.env.GATE_RATE_REVIEW;
    expect(await rateReview.buildBatch({ batchKey: '2026-12' })).toEqual({ ok: false, reason: 'gate_off' });
  });
  test('the scheduler reads the gate before the cron lock and the route reads it per request', () => {
    const fs = require('fs');
    const path = require('path');
    const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    const start = scheduler.indexOf("cron.schedule('20 6 1-7 * *'");
    expect(start).toBeGreaterThan(0);
    const tick = scheduler.slice(start, scheduler.indexOf('cron.schedule(', start + 10));
    expect(tick).toMatch(/rateReviewLive\(\)\) return;/);
    expect(tick.indexOf('rateReviewLive()')).toBeLessThan(tick.indexOf("runExclusive('rate-review-monthly'"));
    expect(tick).toMatch(/\}, \{ timezone: 'America\/New_York' \}\);/);
    const route = fs.readFileSync(path.join(__dirname, '../routes/admin-rate-review.js'), 'utf8');
    expect(route).toMatch(/router\.use\(adminAuthenticate, requireAdmin\)/);
    expect(route).toMatch(/if \(!rateReviewLive\(\)\) return res\.status\(404\)/);
    const gates = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(gates).toMatch(/rateReview: process\.env\.GATE_RATE_REVIEW === 'true'/);
    expect(gates).toMatch(/function rateReviewLive\(\) \{\n  return process\.env\.GATE_RATE_REVIEW === 'true';/);
  });
});

// ── end to end over the synthetic December book ─────────────────────────

describe('buildBatch over the synthetic December book', () => {
  let book;
  let scripted;
  let result;
  beforeAll(async () => {
    book = fixture.decemberBook();
    scripted = fixture.scriptedDb({
      planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits,
      estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    });
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (customerId) => book.factsByCustomer[customerId] || null);
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
    result = await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    factsCallsAtBuild = mockFacts.mock.calls.map((c) => c[0]);
  });
  let factsCallsAtBuild;

  const rowFor = (id, family = 'pest_control') => scripted.writes.snapshotInserts.find((r) => r.customer_id === id && r.family_key === family);

  test('builds one row per plan line with a December anniversary, nothing for the other months', () => {
    expect(result.ok).toBe(true);
    expect(result.window).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(scripted.writes.snapshotDeletes).toBe(1);
    expect(scripted.writes.snapshotInserts).toHaveLength(6);
    expect(rowFor(book.customers.offWindow.id)).toBeUndefined();
    expect(rowFor(book.customers.locked.id)).toBeUndefined();
    expect(rowFor(book.customers.lawnAt1.id, 'lawn_care')).toBeUndefined();
    for (const row of scripted.writes.snapshotInserts) {
      expect(row.batch_key).toBe('2026-12');
      expect(typeof row.flags).toBe('string'); // jsonb payload
      expect(['green', 'exception', 'no_change', 'skipped']).toContain(row.status);
    }
  });

  test('stores the batch references (allowances, config, line $/hr) so rows are reproducible', () => {
    expect(scripted.writes.batchUpserts).toHaveLength(1);
    const batchRow = scripted.writes.batchUpserts[0];
    expect(batchRow.batch_key).toBe('2026-12');
    const allowances = JSON.parse(batchRow.allowances);
    // pest home 55/60/70/50/58/62/45 (median 58) − not-home 35/38/40/42/44/40/36/33 (median 39) = 19
    expect(allowances.pest_control).toMatchObject({ allowance_minutes: 19, source: 'line' });
    // lawn home 50/52/48 (median 50) − not-home 38/39/40 (median 39) = 11
    expect(allowances.lawn_care).toMatchObject({ allowance_minutes: 11, source: 'line' });
    expect(JSON.parse(batchRow.config)).toMatchObject(DEFAULT_CONFIG);
    expect(JSON.parse(batchRow.line_rph).pest_control.n).toBeGreaterThanOrEqual(3);
    expect(result.allowances.pest_control.allowance_minutes).toBe(19);
  });

  test('band D: 11.1% under the engine list → capped +$12 step, green at exactly 12 months', () => {
    const row = rowFor(book.customers.belowList.id);
    expect(row).toMatchObject({
      status: 'green', band: 'D', current_rate_cents: 10400, current_rate_source: 'visit_median', rate_unit: 'application',
      list_rate_cents: 11700, list_rate_source: 'engine', proposed_rate_cents: 11600, delta_cents: 1200, annual_delta_cents: 4800,
      visits_per_year: 4, anniversary_date: '2025-12-05', anniversary_source: 'first_visit', tenure_months: 12, billing_lane: 'per_application',
    });
    const flags = JSON.parse(row.flags);
    expect(flags).toContain('capped');
    // member_since 2025-01-10 predates the portal-sold line by > 90 days → surfaced, never a hold
    expect(flags).toContain('anniversary_predates_portal');
    expect(flags).not.toContain('tenure_under_lock');
    // $/hr: home 55→36, 60→41 (allowance 19), not-home 35, 38 → 4 paired, longest dropped → $312 over 109 min
    expect(row.revenue_per_hour_cents).toBe(Math.round((312 * 100) / (109 / 60)));
    expect(row.rph_from_not_home).toBe(false);
    expect(row.treatment_minutes_median).toBe(36);
    expect(row.home_visits).toBe(2);
    expect(row.not_home_visits).toBe(2);
  });

  test('band B: 3.4% under list, $/hr from the account\'s own not-home visits', () => {
    const row = rowFor(book.customers.atList.id);
    expect(row.band).toBe('B');
    expect(row.proposed_rate_cents).toBe(11700);
    expect(row.rph_from_not_home).toBe(true);
    expect(row.not_home_visits).toBe(3);
    expect(row.home_visits).toBe(1);
    expect(row.usable_visits).toBe(4);
    expect(row.allowance_minutes_applied).toBe(19);
    expect(row.revenue_per_hour_cents).toBe(Math.round((339 * 100) / (126 / 60)));
    expect(JSON.parse(row.flags)).toContain('rph_from_not_home_visits');
  });

  test('band A: above list with healthy $/hr → no change', () => {
    const row = rowFor(book.customers.wellPriced.id);
    expect(row.band).toBe('A');
    expect(row.delta_cents).toBe(0);
    expect(['no_change', 'exception']).toContain(row.status);
  });

  test('prepay mid-term: the term\'s per-visit share is the current rate and the row is held', () => {
    const row = rowFor(book.customers.prepaid.id);
    expect(row).toMatchObject({ status: 'exception', current_rate_cents: 10100, current_rate_source: 'prepay_term', billing_lane: 'annual_prepay', anniversary_source: 'member_since', tenure_months: 24 });
    expect(JSON.parse(row.flags)).toContain('prepay_mid_term');
    // still ranked so the renewal decision has numbers: $101 vs the $117 mode → D
    expect(row.band).toBe('D');
    expect(row.proposed_rate_cents).toBe(11300);
  });

  test('per_visit lane → lane_cleanup exception, still priced off the visit stamp', () => {
    const row = rowFor(book.customers.perVisit.id);
    expect(row.status).toBe('exception');
    expect(JSON.parse(row.flags)).toContain('lane_cleanup');
    expect(row.current_rate_cents).toBe(9500);
    expect(row.list_rate_source).toBe('cadence_mode'); // no estimate on file → quarterly pest mode of the book
  });

  test('lawn with no estimate: list = the every-6-weeks mode ($61), band C → to list, unknown-interaction visit flagged', () => {
    const row = rowFor(book.customers.lawnUnder.id, 'lawn_care');
    expect(row).toMatchObject({ list_rate_cents: 6100, list_rate_source: 'cadence_mode', band: 'C', proposed_rate_cents: 6100, delta_cents: 600, annual_delta_cents: 5400, visits_per_year: 9 });
    const flags = JSON.parse(row.flags);
    expect(flags).toContain('list_from_cadence_mode');
    expect(flags).toContain('interaction_unknown');
  });

  test('the summary counts every status and adds up green dollars', () => {
    const inserted = scripted.writes.snapshotInserts;
    const green = inserted.filter((r) => r.status === 'green');
    expect(result.summary.rows).toBe(6);
    expect(result.summary.green).toBe(3); // belowList (D), atList (B), lawnUnder (C)
    expect(result.summary.exception).toBe(2); // prepaid, perVisit
    expect(result.summary.no_change).toBe(1); // wellPriced (A)
    expect(result.summary.green_annual_delta_cents).toBe(4800 + 1600 + 5400);
    expect(result.summary.green).toBe(green.length);
    expect(result.summary.exception).toBe(inserted.filter((r) => r.status === 'exception').length);
    expect(result.summary.green_annual_delta_cents).toBe(green.reduce((s, r) => s + r.annual_delta_cents, 0));
    expect(P.summarizeRows(inserted)).toEqual(result.summary);
  });

  test('a tier that moved because the customer added a program is not a hand-picked tier; a saved tier the sold mix cannot explain is', async () => {
    const grew = fixture.customer(13, { member_since: '2025-03-01', waveguard_tier: 'Silver', last_name: 'Grew' });
    const picked = fixture.customer(14, { member_since: '2025-03-02', waveguard_tier: 'Gold', last_name: 'Picked' });
    const lines = [
      ...book.planLines,
      fixture.planLine(grew.id, 'pest_control', 'quarterly', 110, { source_estimate_ids: [fixture.ESTIMATE(7)], account_lines: 2 }),
      fixture.planLine(grew.id, 'lawn_care', 'every_6_weeks', 61, { account_lines: 2 }),
      fixture.planLine(picked.id, 'pest_control', 'quarterly', 110, { source_estimate_ids: [fixture.ESTIMATE(8)] }),
    ];
    const scenario = {
      planLines: lines, customers: [...book.customerRows, grew, picked],
      firstVisits: [...book.firstVisits,
        { customer_id: grew.id, line: 'pest_control', first_visit: '2025-12-03', completed_visits: 4 }, { customer_id: grew.id, line: 'lawn_care', first_visit: '2026-06-03', completed_visits: 2 },
        { customer_id: picked.id, line: 'pest_control', first_visit: '2025-12-04', completed_visits: 4 }],
      completedVisits: book.completedVisits,
      estimates: [...book.estimates,
        // sold as a single pest line at Bronze; lawn added later on another estimate
        fixture.estimate(7, grew.id, { tier: 'Bronze', acceptedAt: '2025-11-20T16:00:00Z' }),
        // sold as a single pest line but saved as Gold — the engine would derive Bronze
        fixture.estimate(8, picked.id, { tier: 'Gold', acceptedAt: '2025-11-21T16:00:00Z' })],
      terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    };
    const db4 = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => db4(table));
    db.raw.mockImplementation((...args) => db4.raw(...args));
    db.transaction.mockImplementation((fn) => db4.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    const engine = fixture.fakePricingEngine({ tier: 'derive' });
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: engine } });
    const grewRow = db4.writes.snapshotInserts.find((r) => r.customer_id === grew.id && r.family_key === 'pest_control');
    expect(JSON.parse(grewRow.flags)).not.toContain('hand_picked_tier');
    expect(grewRow.list_rate_source).toBe('engine');
    // the list replay priced the CURRENT bundle (pest + lawn as a prior) …
    expect(engine.generateEstimate.mock.calls.some(([inputs]) => Array.isArray(inputs.priorQualifyingServices) && inputs.priorQualifyingServices.includes('lawn_care'))).toBe(true);
    const pickedRow = db4.writes.snapshotInserts.find((r) => r.customer_id === picked.id);
    expect(JSON.parse(pickedRow.flags)).toContain('hand_picked_tier');
    expect(pickedRow.status).toBe('exception');
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
  });

  test('an existing-member add-on estimate sold at Silver is not a hand-picked tier', async () => {
    const member = fixture.customer(19, { member_since: '2025-02-01', waveguard_tier: 'Silver', last_name: 'Member Add-on' });
    const addon = { id: fixture.ESTIMATE(10), customer_id: member.id, accepted_at: '2025-11-26T16:00:00Z', waveguard_tier: 'Silver',
      // server-stamped evidence at the top level: the customer already had pest when lawn was sold
      estimate_data: { inputs: { lotSqFt: 8000, services: { lawn: { track: 'st_augustine', tier: 'enhanced' } } }, priorQualifyingServices: ['pest_control'] } };
    const lines = [...book.planLines,
      fixture.planLine(member.id, 'pest_control', 'quarterly', 117, { account_lines: 2 }),
      fixture.planLine(member.id, 'lawn_care', 'every_6_weeks', 61, { source_estimate_ids: [addon.id], account_lines: 2 })];
    const scenario = {
      planLines: lines, customers: [...book.customerRows, member],
      firstVisits: [...book.firstVisits, { customer_id: member.id, line: 'pest_control', first_visit: '2025-03-01', completed_visits: 6 }, { customer_id: member.id, line: 'lawn_care', first_visit: '2025-12-03', completed_visits: 5 }],
      completedVisits: book.completedVisits, estimates: [...book.estimates, addon], terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    };
    const db5 = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => db5(table));
    db.raw.mockImplementation((...args) => db5.raw(...args));
    db.transaction.mockImplementation((fn) => db5.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    const engine = fixture.fakePricingEngine({ tier: 'derive' });
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: engine } });
    const row = db5.writes.snapshotInserts.find((r) => r.customer_id === member.id && r.family_key === 'lawn_care');
    expect(row.list_rate_source).toBe('engine');
    expect(JSON.parse(row.flags)).not.toContain('hand_picked_tier');
    // the original-mix replay carried the stamped prior (lawn + pest → silver); the client-posted copy is never what decides it
    expect(engine.generateEstimate.mock.calls.some(([inputs]) => Array.isArray(inputs.priorQualifyingServices) && inputs.priorQualifyingServices.length === 1 && inputs.priorQualifyingServices[0] === 'pest_control')).toBe(true);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
  });

  test('a line sold quarterly but now running bimonthly is listed at the bimonthly engine price', async () => {
    const bimonthly = fixture.customer(11, { member_since: '2025-02-01', last_name: 'Bimonthly' });
    const lines = [...book.planLines, fixture.planLine(bimonthly.id, 'pest_control', 'bimonthly', 100, { source_estimate_ids: [fixture.ESTIMATE(6)] })];
    const scenario = {
      planLines: lines, customers: [...book.customerRows, bimonthly], firstVisits: [...book.firstVisits, { customer_id: bimonthly.id, line: 'pest_control', first_visit: '2025-12-02', completed_visits: 5 }],
      completedVisits: book.completedVisits, estimates: [...book.estimates, fixture.estimate(6, bimonthly.id, { acceptedAt: '2025-11-25T16:00:00Z' })],
      terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    };
    const db2 = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => db2(table));
    db.raw.mockImplementation((...args) => db2.raw(...args));
    db.transaction.mockImplementation((fn) => db2.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    const engine = fixture.fakePricingEngine();
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: engine } });
    const row = db2.writes.snapshotInserts.find((r) => r.customer_id === bimonthly.id);
    // the engine was asked for bimonthly (6 visits × $117) and the line compares against $117/application, not the quarterly quote
    expect(engine.generateEstimate.mock.calls.some(([inputs]) => inputs.services.pest.frequency === 'bimonthly')).toBe(true);
    expect(row).toMatchObject({ cadence: 'bimonthly', visits_per_year: 6, list_rate_cents: 11700, list_rate_source: 'engine', band: 'D', annual_delta_cents: 7200 });
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
  });

  test('a monthly-billed line with no estimate takes the cadence mode spread over 12 months', async () => {
    const dues = fixture.customer(12, { member_since: '2024-12-15', billing_mode: 'monthly_membership', monthly_rate: 30, last_name: 'Dues' });
    const lines = [...book.planLines, fixture.planLine(dues.id, 'pest_control', 'quarterly', null, { priced_visits: 0 })];
    const duesVisits = [40, 42, 44].map((m, i) => fixture.visit(dues.id, 'pest_control', { minutes: m, interaction: 'not_home_full_access', revenue: null, date: `2026-0${i + 3}-10` }));
    const scenario = {
      planLines: lines, customers: [...book.customerRows, dues], firstVisits: [...book.firstVisits, { customer_id: dues.id, line: 'pest_control', first_visit: '2026-05-05', completed_visits: 2 }],
      completedVisits: [...book.completedVisits, ...duesVisits], estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
      // $270 of dues settled over the lookback (9 × $30) → $90 per completed application
      settledDues: { [dues.id]: 270 },
    };
    const db3 = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => db3(table));
    db.raw.mockImplementation((...args) => db3.raw(...args));
    db.transaction.mockImplementation((fn) => db3.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    const row = db3.writes.snapshotInserts.find((r) => r.customer_id === dues.id);
    // quarterly pest mode $117/application → $39/mo; $30/mo = $90/application → 23% under → D →
    // per-application step min(12% × 90 = 10.80, 15) → floor($100.80) = $100/application → $33.33/mo (+$3.33/mo, +$39.96/yr)
    expect(row).toMatchObject({ rate_unit: 'month', current_rate_cents: 3000, current_rate_source: 'monthly_rate', list_rate_cents: 3900, list_rate_source: 'cadence_mode', band: 'D', proposed_rate_cents: 3333, delta_cents: 333, annual_delta_cents: 3996, status: 'green' });
    expect(JSON.parse(row.flags)).toEqual(expect.arrayContaining(['list_from_cadence_mode', 'rph_from_dues', 'rph_from_not_home_visits']));
    // $90 × 3 applications over 126 treatment minutes
    expect(row.revenue_per_hour_cents).toBe(Math.round((270 * 100) / (126 / 60)));
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
  });

  test('a year-long catch-up window holds everyone and the 12-month lock holds the young lines out', async () => {
    const catchUp = fixture.scriptedDb({
      planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits,
      estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {},
    });
    db.mockImplementation((table) => catchUp(table));
    db.raw.mockImplementation((...args) => catchUp.raw(...args));
    db.transaction.mockImplementation((fn) => catchUp.transaction(fn));
    const out = await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-01-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(out.rows).toBe(10);
    const find = (id, family = 'pest_control') => catchUp.writes.snapshotInserts.find((r) => r.customer_id === id && r.family_key === family);
    expect(find(book.customers.locked.id)).toMatchObject({ status: 'exception', tenure_months: 0, anniversary_date: '2026-05-03' });
    expect(JSON.parse(find(book.customers.locked.id).flags)).toContain('tenure_under_lock');
    expect(JSON.parse(find(book.customers.offWindow.id).flags)).toContain('tenure_under_lock');
    expect(find(book.customers.lawnAt1.id, 'lawn_care')).toMatchObject({ band: 'A', status: 'no_change', tenure_months: 12 });
    // restore the December scripted db for the remaining assertions
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
  });

  test('the prior-review lookup excludes this batch and anything 12+ months back, by batch month', () => {
    const reviewed = fixture.scriptedDb({
      planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits,
      estimates: book.estimates, terms: book.terms, ledger: [], sentRowCount: 0, signals: {},
      // the scripted snapshots table answers the prior-review read with belowList's pest line
      priorReviews: [{ customer_id: book.customers.belowList.id, family_key: 'pest_control' }],
    });
    db.mockImplementation((table) => reviewed(table));
    db.raw.mockImplementation((...args) => reviewed.raw(...args));
    db.transaction.mockImplementation((fn) => reviewed.transaction(fn));
    return rateReview.buildBatch({ batchKey: '2027-12', anniversaryFrom: '2027-12-01', anniversaryTo: '2027-12-31', now: new Date('2027-11-01T11:20:00Z'), deps: { pricingEngine: fixture.fakePricingEngine() } }).then(() => {
      const row = reviewed.writes.snapshotInserts.find((r) => r.customer_id === book.customers.belowList.id);
      expect(row.status).toBe('exception');
      expect(JSON.parse(row.flags)).toContain('reviewed_within_12mo');
      // the read itself is keyed on batch months, exclusive at 12 back
      const snapshotReads = db.mock.calls.filter(([t]) => t === 'rate_review_snapshots');
      expect(snapshotReads.length).toBeGreaterThan(0);
      const priorCall = reviewed.mock.results.map((r) => r.value).find((q) => q && q.calls && q.calls.some(([name, args]) => name === 'where' && args[0] === 'batch_key' && args[1] === '>'));
      expect(priorCall).toBeDefined();
      expect(priorCall.calls).toEqual(expect.arrayContaining([['where', ['batch_key', '<', '2027-12']], ['where', ['batch_key', '>', '2026-12']]]));
      db.mockImplementation((table) => scripted(table));
      db.raw.mockImplementation((...args) => scripted.raw(...args));
      db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    });
  });

  test('the facts loader ran once per customer in the window, never for the other months', () => {
    const ids = factsCallsAtBuild;
    expect(ids).toContain(book.customers.belowList.id);
    expect(ids).not.toContain(book.customers.offWindow.id);
    expect(ids).not.toContain(book.customers.locked.id);
    expect(ids).not.toContain(book.customers.lawnAt1.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  test('the ops email: ACT subject with the counts, every row named, nothing customer-facing', () => {
    const rows = scripted.writes.snapshotInserts.map((r) => ({ ...r, flags: JSON.parse(r.flags), customer_name: `Fixture ${r.customer_id.slice(-1)}` }));
    const composed = rateReview.composeBatchEmail({ batchKey: '2026-12', rows, summary: P.summarizeRows(rows) });
    expect(composed.subject).toMatch(/^ACT: Rate review — December 2026 batch · \d+ green · \d+ exceptions? · \+\$[\d,]+\/yr$/);
    // with the batch row the subject names the review window
    const windowed = rateReview.composeBatchEmail({ batchKey: '2026-11', rows, summary: P.summarizeRows(rows), batch: { window_from: '2026-12-06', window_to: '2027-01-05' } });
    expect(windowed.subject).toMatch(/^ACT: Rate review — November 2026 batch \(anniversaries Dec 6 – Jan 5\) · /);
    // every row carries its review date at the source
    for (const r of scripted.writes.snapshotInserts) expect(r.review_date).toMatch(/^2026-12-\d{2}$/);
    expect(composed.text).toContain('Nothing has been sent to a customer and no rate has changed');
    expect(composed.text).toContain('EXCEPTIONS — held out, your call');
    expect(composed.link).toBe('/admin/pricing-logic?area=rate-review&batch=2026-12');
    expect(composed.itemKeys).toHaveLength(rows.length);
    const quiet = rateReview.composeBatchEmail({ batchKey: '2027-01', rows: [], summary: P.summarizeRows([]) });
    expect(quiet.subject).toMatch(/^OK: Rate review — January 2027 batch: nothing to decide/);
  });
});

describe('buildBatch refusals', () => {
  test('a batch with sent rows is never rebuilt', async () => {
    const scripted = fixture.scriptedDb({ sentRowCount: 2 });
    db.mockImplementation((table) => scripted(table));
    expect(await rateReview.buildBatch({ batchKey: '2026-12', now: NOW })).toEqual({ ok: false, reason: 'batch_has_sent_rows', batchKey: '2026-12' });
    expect(scripted.raw).not.toHaveBeenCalled();
    expect(scripted.writes.snapshotInserts).toHaveLength(0);
  });
  test('malformed keys and windows are 400s', async () => {
    await expect(rateReview.buildBatch({ batchKey: 'dec-2026' })).rejects.toMatchObject({ status: 400 });
    await expect(rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '12/01/2026' })).rejects.toMatchObject({ status: 400 });
    await expect(rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-31', anniversaryTo: '2026-12-01' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('runMonthlyRateReview', () => {
  test('builds the BUILD month with the 35–65 day window, emails once, and never re-emails the same batch', async () => {
    const book = fixture.decemberBook();
    const scenario = {
      planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits,
      estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {}, batchRow: null,
    };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (customerId) => book.factsByCustomer[customerId] || null);
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
    const sendgrid = require('../services/sendgrid-mail');

    // NOW = 2026-11-01 06:20 ET → window Dec 6 … Jan 5 (crossing the year end), batch_key = the build month
    const first = await rateReview.runMonthlyRateReview({ now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(first.batchKey).toBe('2026-11');
    expect(first.window).toEqual({ from: '2026-12-06', to: '2027-01-05' });
    // Dec 2 and Dec 5 anniversaries belong to the October build; Dec 11/12/19/20 are in
    expect(first.rows).toBe(4);
    expect(first.emailed).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const sent = sendgrid.sendOne.mock.calls[0][0];
    expect(sent.to).toBe('contact@wavespestcontrol.com');
    expect(sent.subject).toMatch(/^(ACT|OK): Rate review — November 2026/);
    expect(scripted.writes.batchUpdates.some((p) => p.email_sent_at instanceof Date)).toBe(true);

    // a retried tick on an emailed batch neither rebuilds (no window slide, no row loss) nor re-sends
    scenario.batchRow = { batch_key: '2026-11', email_sent_at: new Date(), window_from: '2026-12-06', window_to: '2027-01-05' };
    const upsertsBefore = scripted.writes.batchUpserts.length;
    const second = await rateReview.runMonthlyRateReview({ now: new Date('2026-11-10T11:20:00Z'), deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(second).toEqual({ skipped: 'already_emailed', batchKey: '2026-11', emailed: false });
    expect(scripted.writes.batchUpserts).toHaveLength(upsertsBefore);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    // a retried tick on an UNSENT existing batch rebuilds inside the stored window, then emails
    scenario.batchRow = { batch_key: '2026-11', email_sent_at: null, window_from: '2026-12-06', window_to: '2027-01-05' };
    const retry = await rateReview.runMonthlyRateReview({ now: new Date('2026-11-10T11:20:00Z'), deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(retry.window).toEqual({ from: '2026-12-06', to: '2027-01-05' });
    expect(retry.emailed).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(2);
  });
  test('a digest delivery failure is thrown to the cron runner after the batch is persisted (job_health records it; the day 2–7 tick retries)', async () => {
    const book = fixture.decemberBook();
    const scenario = { planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {}, batchRow: null };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
    const sendgrid = require('../services/sendgrid-mail');
    // the provider's message carries its raw response body — an address must never ride the re-thrown error into the scheduler's log line
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('sendgrid 503: {"errors":[{"message":"bounced: someone@example.com"}]}'), { status: 503 }));
    const failure = await rateReview.runMonthlyRateReview({ now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } }).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('rate review digest delivery failed for 2026-11 (status 503)');
    expect(failure.message).not.toMatch(/@|bounced/);
    expect(failure).toMatchObject({ status: 503, code: 'RATE_REVIEW_DIGEST_DELIVERY_FAILED' });
    expect(scripted.writes.batchUpserts).toHaveLength(1); // the batch itself landed
    expect(scripted.writes.batchUpdates.some((p) => p.email_sent_at)).toBe(false); // nothing stamped → the next tick retries
    const scheduler = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(scheduler).toMatch(/cron\.schedule\('20 6 1-7 \* \*'/);
  });
  test('the delivery stamp names the batch version it described: a rebuild that lands mid-send leaves email_sent_at unset for the next delivery', async () => {
    const book = fixture.decemberBook();
    const scenario = { planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {}, batchRow: null, batchStampRows: 0 };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
    const out = await rateReview.runMonthlyRateReview({ now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(out.emailed).toBe(true);
    expect(out.email.stamped).toBe(false);
    // the stamp was conditioned on the version the digest was composed from (buildBatch's computed_at)
    const stamp = db.mock.results.map((r) => r.value).find((q) => q && Array.isArray(q.calls) && q.calls.some(([n]) => n === 'update') && q.calls.some(([n, a]) => n === 'where' && a[0] === 'computed_at'));
    expect(stamp).toBeDefined();
    expect(stamp.calls.find(([n, a]) => n === 'where' && a[0] === 'computed_at')[1][1]).toEqual(NOW);
    expect(stamp.calls.find(([n]) => n === 'update')[1][0].email_sent_at).toBeInstanceOf(Date);
    // with the version intact the stamp lands
    scenario.batchStampRows = 1;
    scenario.batchRow = { batch_key: '2026-11', email_sent_at: null, window_from: '2026-12-06', window_to: '2027-01-05' };
    const again = await rateReview.runMonthlyRateReview({ now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(again.email.stamped).toBe(true);
    // no batch row at all → nothing to describe, nothing sent
    const empty = fixture.scriptedDb({ priorReviews: [], batchRow: null });
    db.mockImplementation((table) => empty(table));
    expect(await rateReview.sendBatchEmail({ batchKey: '2026-11' })).toEqual({ sent: false, skipped: 'no_batch' });
  });
  test('a tick whose digest was not delivered (mailer unconfigured, external recipient) is a FAILED tick, not a healthy one', async () => {
    const book = fixture.decemberBook();
    const make = () => {
      const scenario = { planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {}, batchRow: null };
      const scripted = fixture.scriptedDb(scenario);
      db.mockImplementation((table) => scripted(table));
      db.raw.mockImplementation((...args) => scripted.raw(...args));
      db.transaction.mockImplementation((fn) => scripted.transaction(fn));
      mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
      mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
      return scripted;
    };
    const unconfigured = { isConfigured: () => false, sendOne: jest.fn() };
    let scripted = make();
    const failure = await rateReview.runMonthlyRateReview({ now: NOW, mailer: unconfigured, deps: { pricingEngine: fixture.fakePricingEngine() } }).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'RATE_REVIEW_DIGEST_NOT_DELIVERED', skipped: 'unconfigured' });
    expect(failure.message).toBe('rate review digest not delivered for 2026-11 (unconfigured)');
    expect(unconfigured.sendOne).not.toHaveBeenCalled();
    expect(scripted.writes.batchUpserts).toHaveLength(1); // the batch landed
    expect(scripted.writes.batchUpdates.some((p) => p.email_sent_at)).toBe(false); // nothing stamped → the next tick retries
    // an external recipient: the same failed tick, and the address never rides the error
    scripted = make();
    process.env.RATE_REVIEW_DIGEST_EMAIL = 'someone@example.com';
    try {
      const external = await rateReview.runMonthlyRateReview({ now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } }).catch((e) => e);
      expect(external).toMatchObject({ code: 'RATE_REVIEW_DIGEST_NOT_DELIVERED', skipped: 'recipient' });
      expect(external.message).not.toMatch(/@/);
      expect(require('../services/sendgrid-mail').sendOne).not.toHaveBeenCalled();
    } finally {
      delete process.env.RATE_REVIEW_DIGEST_EMAIL;
    }
  });
  test('a granted retention offer or an active plan hold holds only its own family; a failed read or an unknown family holds every line', async () => {
    expect(P.familySignalTouchesLine(['lawn_care'], 'pest_control')).toBe(false);
    expect(P.familySignalTouchesLine(['pest_control'], 'pest_control')).toBe(true);
    expect(P.familySignalTouchesLine(['palm_injection'], 'tree_shrub')).toBe(true); // the ledger's vocabulary for the family
    expect(P.familySignalTouchesLine(['termite_bait'], 'termite')).toBe(true);
    expect(P.familySignalTouchesLine([], 'pest_control')).toBe(false);
    expect(P.familySignalTouchesLine('error', 'pest_control')).toBe(true);
    expect(P.familySignalTouchesLine(['something_new'], 'pest_control')).toBe(true); // fail closed
    // the loader reads the offers' families (never a customer-wide count)
    const book = fixture.decemberBook();
    const target = book.customers.belowList.id;
    const run = async (signals) => {
      const scenario = { planLines: book.planLines, customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals, batchRow: null };
      const scripted = fixture.scriptedDb(scenario);
      db.mockImplementation((table) => scripted(table));
      db.raw.mockImplementation((...args) => scripted.raw(...args));
      db.transaction.mockImplementation((fn) => scripted.transaction(fn));
      mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
      mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
      const signalsRead = await P.loadExceptionSignals(db, target, { now: NOW, config: DEFAULT_CONFIG });
      await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-12-01', anniversaryTo: '2026-12-31', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
      const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === target && r.family_key === 'pest_control');
      return { signalsRead, flags: JSON.parse(row.flags) };
    };
    const lawnOnly = await run({ [target]: { retentionOfferFamilies: ['lawn_care'], holds: ['lawn_care'] } });
    expect(lawnOnly.signalsRead.retentionOfferFamilies).toEqual(['lawn_care']);
    expect(lawnOnly.flags).not.toContain('retention_offer_active');
    expect(lawnOnly.flags).not.toContain('plan_hold_active');
    const own = await run({ [target]: { retentionOfferFamilies: ['pest_control'], holds: ['pest_control'] } });
    expect(own.flags).toEqual(expect.arrayContaining(['retention_offer_active', 'plan_hold_active']));
    // a cancellation case holds the families it names (scope; [] = the whole account)
    expect(P.cancellationCaseTouchesLine([['lawn_care']], 'pest_control')).toBe(false);
    expect(P.cancellationCaseTouchesLine([['lawn_care'], []], 'pest_control')).toBe(true);
    expect(P.cancellationCaseTouchesLine([['palm_injection']], 'tree_shrub')).toBe(true);
    expect(P.cancellationCaseTouchesLine([], 'pest_control')).toBe(false);
    expect(P.cancellationCaseTouchesLine('error', 'pest_control')).toBe(true);
    const lawnCase = await run({ [target]: { cancellationCaseScopes: [['lawn_care']] } });
    expect(lawnCase.signalsRead.cancellationCaseScopes).toEqual([['lawn_care']]);
    expect(lawnCase.flags).not.toContain('cancellation_case_recent');
    expect((await run({ [target]: { cancellationCaseScopes: [[]] } })).flags).toContain('cancellation_case_recent');
    expect((await run({ [target]: { cancellationCaseScopes: [['pest_control']] } })).flags).toContain('cancellation_case_recent');
  });
  test('only ORDINARY lines are references — the cadence mode and the $/hr quartiles share one population', () => {
    const ordinary = (n, rph = 9000) => ({ customer: fixture.customer(n, { billing_mode: 'per_application' }), serviceKeys: ['pest_control_quarterly'], familyKey: 'pest_control', cadence: 'quarterly', current: { cents: 11700 + n, unit: 'application', source: 'visit_median' }, stats: { revenuePerHourCents: rph }, planLine: { cadence_conflict: false }, multiProgram: false });
    const book = [ordinary(1), ordinary(2), ordinary(3), ordinary(4),
      { ...ordinary(5, 30000), multiProgram: true },                       // blended tree/shrub + palm median
      { ...ordinary(6, 30000), planLine: { cadence_conflict: true } },     // two cadences open
      { ...ordinary(7, 30000), current: { cents: 4000, unit: 'month', source: 'ledger_slice' } }, // dues, not a per-application price
      { ...ordinary(8, 30000), current: { cents: 11700, unit: 'application', source: 'visit_median', prepayMidTerm: true } },
      { ...ordinary(9, 30000), customer: fixture.customer(9, { billing_mode: 'per_application', waveguard_tier: 'Commercial' }) },
    ];
    expect(book.slice(4).map(P.isOrdinaryReference)).toEqual([false, false, false, false, false]);
    const refs = P.computeLineReferences(book);
    expect(refs.lineRphStats.get('pest_control')).toMatchObject({ n: 4, median: 9000 });
    expect(refs.cadenceModes.get('pest_control|quarterly')).toBeDefined();
    // the four ordinary accounts are the only samples: the 30000 $/hr held rows never set a quartile
    expect(refs.lineRphStats.get('pest_control').q3).toBeLessThanOrEqual(9000);
  });
  test('a per-application tree/shrub line carrying both programs is held as multi_program_line, never a blended green', async () => {
    expect(P.isMultiProgramLine('tree_shrub', ['tree_shrub_program', 'palm_injection_semiannual'])).toBe(true);
    expect(P.isMultiProgramLine('tree_shrub', ['palm_injection_semiannual'])).toBe(false);
    expect(P.isMultiProgramLine('tree_shrub', ['tree_shrub_program'])).toBe(false);
    expect(P.isMultiProgramLine('tree_shrub', [])).toBe(false);
    expect(P.isMultiProgramLine('pest_control', ['pest_control_quarterly', 'palm_injection_semiannual'])).toBe(false);
    const book = fixture.decemberBook();
    const target = book.customers.belowList.id;
    const extra = fixture.planLine(target, 'tree_shrub', 'bimonthly', 80, { service_keys: ['tree_shrub_program', 'palm_injection_semiannual'] });
    const scenario = { planLines: [...book.planLines, extra], customers: book.customerRows, firstVisits: book.firstVisits, completedVisits: book.completedVisits, estimates: book.estimates, terms: book.terms, ledger: [], priorReviews: [], sentRowCount: 0, signals: {}, batchRow: null };
    const scripted = fixture.scriptedDb(scenario);
    db.mockImplementation((table) => scripted(table));
    db.raw.mockImplementation((...args) => scripted.raw(...args));
    db.transaction.mockImplementation((fn) => scripted.transaction(fn));
    mockFacts.mockImplementation(async (id) => book.factsByCustomer[id] || fixture.facts());
    mockCoveredTerms.mockImplementation(fixture.coveredTermsStub({ terms: book.terms }));
    // an explicit window that covers the imported line's member_since anniversary
    await rateReview.buildBatch({ batchKey: '2026-12', anniversaryFrom: '2026-11-15', anniversaryTo: '2027-01-15', now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    const row = scripted.writes.snapshotInserts.find((r) => r.customer_id === target && r.family_key === 'tree_shrub');
    expect(row).toBeDefined();
    expect(JSON.parse(row.flags)).toContain('multi_program_line');
    expect(row.status).toBe('exception');
  });
  test('an external recipient fails closed — the body names customers', async () => {
    const scripted = fixture.scriptedDb({ priorReviews: [], batchRow: { batch_key: '2026-12' } });
    db.mockImplementation((table) => scripted(table));
    process.env.RATE_REVIEW_DIGEST_EMAIL = 'someone@example.com';
    try {
      const out = await rateReview.sendBatchEmail({ batchKey: '2026-12' });
      expect(out).toMatchObject({ sent: false, skipped: 'recipient' });
      expect(require('../services/sendgrid-mail').sendOne).not.toHaveBeenCalled();
    } finally {
      delete process.env.RATE_REVIEW_DIGEST_EMAIL;
    }
  });
});
