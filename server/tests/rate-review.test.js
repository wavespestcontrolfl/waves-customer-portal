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
    const noList = P.computeSnapshot({ ...base(), batchKey: '2026-12', customerId: 'c1', cadence: 'quarterly', currentRateCents: 11700, listRateCents: null });
    expect(noList.status).toBe('skipped');
    expect(noList.flags).toContain('no_list_rate');
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
    const zeroWithBase = fixture.planLine('c', 'pest_control', 'quarterly', null, { priced_visits: 0, zero_priced_visits: 3, zero_with_base: true });
    const customer = fixture.customer(1, { per_application_fee: 117 });
    expect(P.resolveCurrentRate({ customer, planLine: zeroWithBase })).toMatchObject({ cents: 0, source: 'stamped_zero', stampedZeroFree: true });
    const row = P.computeSnapshot({ batchKey: '2026-12', customerId: 'c', familyKey: 'pest_control', cadence: 'quarterly', visitsPerYear: 4, billingLane: 'per_application', anniversaryDate: '2025-01-10', tenureMonths: 21, currentRateCents: 0, currentRateSource: 'stamped_zero', stampedZeroFree: true, rateUnit: 'application', listRateCents: 11700, listRateSource: 'engine', facts: fixture.facts() });
    expect(row.status).toBe('skipped');
    expect(row.flags).toEqual(expect.arrayContaining(['stamped_zero_free', 'no_current_rate']));
    // a bare stamped 0 with no base and the stamped-zero gate off is indistinguishable from never priced → fee fallback (today's billing rule)
    const bare = fixture.planLine('c', 'pest_control', 'quarterly', null, { priced_visits: 0, zero_priced_visits: 3, zero_with_base: false });
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
    const mixed = fixture.planLine('c', 'pest_control', 'quarterly', 117, { priced_visits: 2, zero_priced_visits: 1, zero_with_base: true });
    expect(P.resolveCurrentRate({ customer, planLine: mixed })).toMatchObject({ cents: 11700, source: 'visit_median' });
  });
  test('per_visit and NULL lanes read the visit stamp (the exception rule flags lane_cleanup)', () => {
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: 'per_visit' }), planLine })).toMatchObject({ cents: 10530, source: 'visit_median' });
    expect(P.resolveCurrentRate({ customer: fixture.customer(1, { billing_mode: null }), planLine })).toMatchObject({ cents: 10530, source: 'visit_median' });
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
  test('a palm rider joins the monthly list figure exactly where the ledger slice sums it, never the per-application one', () => {
    const result = { lineItems: [{ service: 'tree_shrub', annualAfterDiscount: 360, visitsPerYear: 6 }, { service: 'palm_injection', annualAfterDiscount: 150, visitsPerYear: 2 }], waveGuard: { tier: 'silver' } };
    const monthly = P.listRateFromEngineResult(result, 'tree_shrub', 'bimonthly', { includeRiders: true });
    expect(monthly).toMatchObject({ monthlyCents: 4250, perAppCents: 6000, riderServices: ['palm_injection'] });
    const perApp = P.listRateFromEngineResult(result, 'tree_shrub', 'bimonthly');
    expect(perApp).toMatchObject({ monthlyCents: 3000, perAppCents: 6000, riderServices: [] });
    // a rider that needs a custom quote is left out rather than priced at $0
    const quoteRequired = { lineItems: [result.lineItems[0], { ...result.lineItems[1], quoteRequired: true }], waveGuard: { tier: 'silver' } };
    expect(P.listRateFromEngineResult(quoteRequired, 'tree_shrub', 'bimonthly', { includeRiders: true }).monthlyCents).toBe(3000);
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
    const start = scheduler.indexOf("cron.schedule('20 6 1 * *'");
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
    expect(composed.text).toContain('Nothing has been sent to a customer and no rate has changed');
    expect(composed.text).toContain('EXCEPTIONS — held out, your call');
    expect(composed.link).toBe('/admin/pricing-logic?area=rate-review&batch=2026-12');
    expect(composed.itemKeys).toHaveLength(rows.length);
    const quiet = rateReview.composeBatchEmail({ batchKey: '2027-01', rows: [], summary: P.summarizeRows([]) });
    expect(quiet.subject).toMatch(/^OK: Rate review — January 2027: nothing to decide/);
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
  test('builds the FOLLOWING month, emails once, and never re-emails the same batch', async () => {
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

    const first = await rateReview.runMonthlyRateReview({ now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(first.batchKey).toBe('2026-12');
    expect(first.window).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(first.emailed).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const sent = sendgrid.sendOne.mock.calls[0][0];
    expect(sent.to).toBe('contact@wavespestcontrol.com');
    expect(sent.subject).toMatch(/^(ACT|OK): Rate review — December 2026/);
    expect(scripted.writes.batchUpdates.some((p) => p.email_sent_at instanceof Date)).toBe(true);

    scenario.batchRow = { batch_key: '2026-12', email_sent_at: new Date() };
    const second = await rateReview.runMonthlyRateReview({ now: NOW, deps: { pricingEngine: fixture.fakePricingEngine() } });
    expect(second.skipped).toBe('already_emailed');
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
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
