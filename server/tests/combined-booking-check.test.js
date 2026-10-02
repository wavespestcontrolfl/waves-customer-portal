const check = require('../services/combined-booking-check');
const { evaluateCombinedBooking, composeAlert, postAlert, ringOnNewProblem, problemKeys, outcomeOf, acceptedFamilies } = check;
const { composeAdminAlert } = require('../services/admin-alert-compose');

const DAY0 = '2026-10-04';
const TECH = 'tech-1';
const ALERT_IDS = { customerName: 'J. Sample', customerId: 'customer-1', estimateId: 'estimate-1' };
const PEST = { service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly', annual: 600, mo: 50 };
const LAWN = { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6, frequency: 'bimonthly', annual: 600, mo: 50 };
const TREE = { service: 'tree_shrub', name: 'Tree & Shrub', visitsPerYear: 9, frequency: 'every_6_weeks', annual: 540, mo: 45 };
const MOSQ = { service: 'mosquito', name: 'Mosquito Control', visitsPerYear: 9, frequency: 'every_6_weeks', annual: 540, mo: 45 };

function estimate(lines, overrides = {}) {
  return {
    id: 'estimate-1', customer_id: 'customer-1', accepted_service_mode: 'recurring',
    monthly_total: lines.reduce((sum, l) => sum + l.mo, 0), annual_total: lines.reduce((sum, l) => sum + l.annual, 0),
    estimate_data: { customerSelection: { frequency: 'quarterly' }, result: { recurring: { services: lines } } },
    ...overrides,
  };
}
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// One series: a parent on day 0 plus (visits - 1) children spaced across the year.
function series({ key, type, visits, spacing, childOverrides = {}, parentOverrides = {} }) {
  const parentId = `parent-${key}`;
  const base = { catalog_service_key: key, service_type: type, status: 'pending', window_start: '10:00:00', technician_id: TECH, is_recurring: true };
  const rows = [{ ...base, id: parentId, scheduled_date: DAY0, recurring_parent_id: null, ...parentOverrides }];
  for (let i = 1; i < visits; i += 1) {
    rows.push({ ...base, id: `${parentId}-c${i}`, scheduled_date: addDays(DAY0, spacing * i), recurring_parent_id: parentId, ...childOverrides });
  }
  return rows;
}
const pestRows = (o = {}) => series({ key: 'pest_general_quarterly', type: 'Quarterly Pest Control', visits: 4, spacing: 91, ...o });
const lawnRows = (o = {}) => series({ key: 'lawn_care_recurring', type: 'Lawn Care', visits: 6, spacing: 61, ...o });
const treeRows = (o = {}) => series({ key: 'tree_shrub_6week', type: 'Tree & Shrub', visits: 9, spacing: 42, ...o });
const untimed = { window_start: null, technician_id: null };

function run(lines, rows, extra = {}) {
  return evaluateCombinedBooking({
    estimate: extra.estimate || estimate(lines), rows,
    excludedFamilies: extra.excludedFamilies, scheduleGaps: extra.scheduleGaps,
    scheduleSkippedFamilies: extra.scheduleSkippedFamilies, scheduleOnHoldFamilies: extra.scheduleOnHoldFamilies,
    scheduleUnjudged: extra.scheduleUnjudged,
  });
}
const codes = (verdict) => verdict.problems.map((problem) => problem.code);
const texts = (verdict) => verdict.problems.map((problem) => problem.text);

describe('evaluateCombinedBooking', () => {
  test('a pest + lawn accept with a time and technician on every visit is OK', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()]);
    expect(verdict).toMatchObject({ ok: true, deferred: false, problems: [] });
    expect(verdict.labels).toEqual(['Pest', 'Lawn']);
  });

  test('the 09-28 defect: companion visits with no time or technician are reported per service', () => {
    const verdict = run([PEST, LAWN, TREE], [...pestRows(), ...lawnRows({ childOverrides: untimed }), ...treeRows({ parentOverrides: untimed })]);
    expect(verdict.ok).toBe(false);
    expect(texts(verdict)).toEqual(['5 lawn visits missing time/tech', '1 T&S visits missing time/tech']);
    expect(verdict.problems.map((problem) => problem.families)).toEqual([['lawn_care'], ['tree_shrub']]);
  });

  test('only upcoming visits are judged: a past visit with no time or technician is history', () => {
    const lawn = lawnRows({ parentOverrides: untimed });
    const rows = [...pestRows(), ...lawn];
    expect(codes(run([PEST, LAWN], rows))).toEqual(['missing_time_tech']);
    const later = evaluateCombinedBooking({ estimate: estimate([PEST, LAWN]), rows, todayET: addDays(DAY0, 1) });
    expect(later.ok).toBe(true);
  });

  test('a time without a technician (or the reverse) still fails', () => {
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawnRows({ childOverrides: { technician_id: null } })]))).toEqual(['missing_time_tech']);
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawnRows({ childOverrides: { window_start: null } })]))).toEqual(['missing_time_tech']);
  });

  test('prices are not this check\'s (the unpriced-series alert and others own them)', () => {
    const lawn = lawnRows({ childOverrides: { estimated_price: 0 } });
    expect(run([PEST, LAWN], [...pestRows(), ...lawn]).ok).toBe(true);
  });

  test('a completed visit is finished work, never a repair alert, even with no technician recorded', () => {
    const lawn = lawnRows({ parentOverrides: { ...untimed, status: 'completed' } });
    expect(run([PEST, LAWN], [...pestRows(), ...lawn]).ok).toBe(true);
  });

  test('cancelled, rescheduled, callback, follow-up and booster rows are not judged', () => {
    const lawn = lawnRows().map((row, i) => {
      if (i === 1) return { ...row, ...untimed, status: 'cancelled' };
      if (i === 2) return { ...row, ...untimed, status: 'rescheduled' };
      if (i === 3) return { ...row, ...untimed, is_callback: true };
      if (i === 4) return { ...row, ...untimed, followup_included: true };
      if (i === 5) return { ...row, ...untimed, is_recurring: false };
      return row;
    });
    expect(run([PEST, LAWN], [...pestRows(), ...lawn]).ok).toBe(true);
  });

  test('a single-service or one-time accept is not checked at all', () => {
    expect(run([PEST], pestRows())).toBeNull();
    expect(evaluateCombinedBooking({ estimate: estimate([PEST, LAWN], { accepted_service_mode: 'one_time' }), rows: [] })).toBeNull();
  });

  test('a plan whose every visit was cancelled is not judged', () => {
    const cancelled = [...pestRows(), ...lawnRows()].map((row) => ({ ...row, ...untimed, status: 'cancelled' }));
    expect(run([PEST, LAWN], cancelled)).toBeNull();
  });

  test('nothing live (parked) or no rows at all is left to the accepted-plan alert, never OK', () => {
    const parked = [...pestRows(), ...lawnRows()].map((row, i) => ({ ...row, status: i % 2 ? 'cancelled' : 'rescheduled' }));
    for (const rows of [parked, []]) expect(run([PEST, LAWN], rows)).toMatchObject({ ok: false, deferred: true, problems: [] });
  });

  test('a schedule gap or an unjudged estimate is never OK, but its own problems still report', () => {
    const gap = { estimateId: 'estimate-1', serviceFamily: 'lawn_care', issues: ['missing_applications'] };
    expect(run([PEST, LAWN], [...pestRows(), ...lawnRows().slice(0, 3)], { scheduleGaps: [gap] })).toMatchObject({ ok: false, deferred: true, problems: [] });
    expect(run([PEST, LAWN], [...pestRows(), ...lawnRows()], { scheduleUnjudged: true })).toMatchObject({ ok: false, deferred: true });
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawnRows({ childOverrides: untimed })], { scheduleGaps: [gap] }))).toEqual(['missing_time_tech']);
  });

  test('a family on hold or kept on an older series leaves the check; the rest are still checked', () => {
    const verdict = run([PEST, LAWN, TREE], [...pestRows(), ...lawnRows(), ...treeRows({ childOverrides: untimed })],
      { scheduleSkippedFamilies: new Set(['tree_shrub']) });
    expect(verdict).toMatchObject({ ok: true, labels: ['Pest', 'Lawn'] });
    const pestOnly = run([PEST, LAWN], [...pestRows({ childOverrides: untimed }), ...lawnRows()], { excludedFamilies: new Set(['lawn_care']) });
    expect(pestOnly.labels).toEqual(['Pest']);
    expect(codes(pestOnly)).toEqual(['missing_time_tech']);
  });

  test('the seasonal exemption reads the booking\'s real first day, even when that day\'s service is on hold', () => {
    const later = '2027-02-01';
    const mosq = series({ key: 'mosquito_seasonal', type: 'Mosquito Control', visits: 3, spacing: 42, parentOverrides: { scheduled_date: later, ...untimed }, childOverrides: untimed })
      .map((row) => (row.recurring_parent_id ? { ...row, scheduled_date: later } : row));
    const verdict = run([PEST, LAWN, MOSQ], [...pestRows(), ...lawnRows(), ...mosq], { scheduleSkippedFamilies: new Set(['pest_control', 'lawn_care']) });
    expect(verdict.ok).toBe(true);
  });

  test('only an active plan hold keeps findings; a stopped series (even with completed visits) does not', () => {
    const lawnOpen = { code: 'missing_time_tech', families: ['lawn_care'], text: '5 lawn visits missing time/tech' };
    const lawnStopped = lawnRows().map((row, i) => ({ ...row, status: i === 0 ? 'completed' : 'cancelled' }));
    const stopped = run([PEST, LAWN], [...pestRows(), ...lawnStopped], { scheduleSkippedFamilies: new Set(['lawn_care']) });
    expect(stopped.heldFamilies).toEqual([]);
    expect(outcomeOf(stopped, [lawnOpen]).outcome).toBe('ok');
    const held = run([PEST, LAWN], [...pestRows(), ...lawnRows()],
      { scheduleSkippedFamilies: new Set(['lawn_care']), scheduleOnHoldFamilies: new Set(['lawn_care']) });
    expect(held.heldFamilies).toEqual(['lawn_care']);
    expect(outcomeOf(held, [lawnOpen]).outcome).toBe('problems');
    // Every series stopped and cancelled: a cancelled plan (no verdict).
    const allCancelled = [...pestRows(), ...lawnRows()].map((row) => ({ ...row, status: 'cancelled' }));
    expect(run([PEST, LAWN], allCancelled, { scheduleSkippedFamilies: new Set(['pest_control', 'lawn_care']) })).toBeNull();
  });

  test('the seasonal exemption ends once a visit is within the routing horizon (it should be routed by then)', () => {
    const later = '2027-02-01';
    const mosq = series({ key: 'mosquito_seasonal', type: 'Mosquito Control', visits: 3, spacing: 42, parentOverrides: { scheduled_date: later, ...untimed }, childOverrides: untimed })
      .map((row) => (row.recurring_parent_id ? { ...row, scheduled_date: later } : row));
    const at = (todayET) => evaluateCombinedBooking({ estimate: estimate([PEST, MOSQ]), rows: [...pestRows(), ...mosq], todayET });
    expect(at('2026-10-04').ok).toBe(true); // months out: still waiting for routing
    const near = at('2027-01-25'); // a week out: should have been routed
    expect(codes(near)).toEqual(['missing_time_tech']);
    expect(near.problems[0].earliest).toBe(later);
  });

  test('every family skipped: nothing judged, and only on-hold findings survive (a stopped one\'s close)', () => {
    const both = new Set(['pest_control', 'lawn_care']);
    // Pest on hold, lawn stopped for good (its visits cancelled after one completed).
    const lawnStopped = lawnRows().map((row, i) => ({ ...row, status: i === 0 ? 'completed' : 'cancelled' }));
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnStopped], { scheduleSkippedFamilies: both, scheduleOnHoldFamilies: new Set(['pest_control']) });
    expect(verdict).toMatchObject({ deferred: true, heldFamilies: ['pest_control'], problems: [] });
    const pestOpen = { code: 'missing_time_tech', families: ['pest_control'], text: '2 pest visits missing time/tech' };
    const lawnOpen = { code: 'missing_time_tech', families: ['lawn_care'], text: '5 lawn visits missing time/tech' };
    expect(outcomeOf(verdict, [pestOpen, lawnOpen])).toEqual({ outcome: 'problems', problems: [{ ...pestOpen, held: 'hold' }] });
    expect(outcomeOf(verdict, [lawnOpen])).toMatchObject({ outcome: 'deferred' });
  });

  test('a seasonal mosquito series rolled past the first day is unslotted on purpose; same-day or monthly is still checked', () => {
    const later = '2027-02-01';
    const mosq = series({ key: 'mosquito_seasonal', type: 'Mosquito Control', visits: 3, spacing: 42, parentOverrides: { scheduled_date: later, ...untimed }, childOverrides: untimed })
      .map((row) => (row.recurring_parent_id ? { ...row, scheduled_date: later } : row));
    expect(run([PEST, MOSQ], [...pestRows(), ...mosq]).ok).toBe(true);
    expect(codes(run([PEST, MOSQ], [...pestRows(), ...mosq.map((row) => ({ ...row, scheduled_date: DAY0 }))]))).toEqual(['missing_time_tech']);
    expect(codes(run([PEST, MOSQ], [...pestRows(), ...mosq.map((row) => ({ ...row, catalog_service_key: 'mosquito_monthly' }))]))).toEqual(['missing_time_tech']);
  });
});

describe('visit prices', () => {
  // PEST: $600/yr over 4 = $150 a visit; LAWN: $600/yr over 6 = $100 a visit.
  const priced = (rows, price) => rows.map((row) => (row.recurring_parent_id ? { ...row, estimated_price: price } : row));
  const verdictFor = (pest, lawn, opts = {}) => evaluateCombinedBooking({ estimate: opts.estimate || estimate([PEST, LAWN]), rows: [...pest, ...lawn] });

  test('upcoming series visits at the accepted per-visit price pass, within two cents either way (compared in cents)', () => {
    for (const [pest, lawn] of [[150.02, 100.02], [149.98, 99.98], [150, 100]]) {
      expect(verdictFor(priced(pestRows(), pest), priced(lawnRows(), lawn)).ok).toBe(true);
    }
    expect(codes(verdictFor(priced(pestRows(), 150.03), priced(lawnRows(), 100)))).toEqual(['price_mismatch']);
    expect(codes(verdictFor(priced(pestRows(), 149.97), priced(lawnRows(), 100)))).toEqual(['price_mismatch']);
  });

  test('a visit priced off the accepted price is reported per service, with the soonest affected day', () => {
    const verdict = verdictFor(priced(pestRows(), 150), priced(lawnRows(), 90));
    expect(codes(verdict)).toEqual(['price_mismatch']);
    expect(texts(verdict)).toEqual(['5 lawn visits priced $90.00, accepted $100.00']);
    expect(verdict.problems[0]).toMatchObject({ families: ['lawn_care'], earliest: addDays(DAY0, 61) });
  });

  test('first visits, prepaid visits and unpriced visits are never price-checked', () => {
    const lawn = lawnRows({ parentOverrides: { estimated_price: 999 } }).map((row, i) => {
      if (i === 1) return { ...row, estimated_price: 90, prepaid_amount: 90 };
      if (i === 2) return { ...row, estimated_price: 90, prepaid_amount: 100, annual_prepay_term_id: 'term-1' };
      if (i === 3) return { ...row, estimated_price: null };
      return row.recurring_parent_id ? { ...row, estimated_price: 100 } : row;
    });
    expect(verdictFor(priced(pestRows(), 150), lawn).ok).toBe(true);
  });

  test('a plan whose lines do not add up to the accepted total (a discount or credit) is not price-checked', () => {
    const verdict = verdictFor(priced(pestRows(), 150), priced(lawnRows(), 90), { estimate: estimate([PEST, LAWN], { annual_total: 1100 }) });
    expect(verdict.problems).toEqual([]);
    expect(verdict.unpricedFamilies).toEqual(['pest_control', 'lawn_care']);
  });

  test('a legacy monthly-dues rodent program has no per-visit price, but its dues count, so pest is still checked', () => {
    // Pest $600/yr + rodent dues $40/mo = $1,080 accepted.
    const est = estimate([PEST], { monthly_total: 90, annual_total: 1080 });
    est.estimate_data.result.recurring.rodentBaitMo = 40;
    const rodent = priced(series({ key: 'rodent_bait_quarterly', type: 'Rodent Bait Stations', visits: 4, spacing: 91 }), 33);
    const ok = evaluateCombinedBooking({ estimate: est, rows: [...priced(pestRows(), 150), ...rodent] });
    expect(ok.problems).toEqual([]);
    expect(ok.unpricedFamilies).toEqual(['rodent_bait']);
    const wrongPest = evaluateCombinedBooking({ estimate: est, rows: [...priced(pestRows(), 140), ...rodent] });
    expect(texts(wrongPest)).toEqual(['3 pest visits priced $140.00, accepted $150.00']);
  });

  test('the accepted total must match the lines exactly: even a few cents off means a credit, so prices are not known', () => {
    const verdict = verdictFor(priced(pestRows(), 150), priced(lawnRows(), 90), { estimate: estimate([PEST, LAWN], { annual_total: 1199.98 }) });
    expect(verdict.problems).toEqual([]);
    expect(verdict.unpricedFamilies).toEqual(['pest_control', 'lawn_care']);
  });

  test('different wrong prices on one service are each named', () => {
    const lawn = priced(lawnRows(), 90).map((row, i) => (i === 2 ? { ...row, estimated_price: 80 } : row));
    expect(texts(verdictFor(priced(pestRows(), 150), lawn))).toEqual(['5 lawn visits priced $90.00 x4, $80.00 x1, accepted $100.00']);
  });

  test('a prepay term link with no live prepaid amount (a voided term keeps the link) is still price-checked', () => {
    const lawn = priced(lawnRows(), 90).map((row) => (row.recurring_parent_id ? { ...row, annual_prepay_term_id: 'term-voided' } : row));
    expect(codes(verdictFor(priced(pestRows(), 150), lawn))).toEqual(['price_mismatch']);
  });

  test('a price finding whose accepted price can no longer be confirmed stays on the bell, marked', () => {
    const lawnOff = { code: 'price_mismatch', families: ['lawn_care'], text: '5 lawn visits priced $90.00, accepted $100.00' };
    const verdict = { ok: true, deferred: false, heldFamilies: [], unpricedFamilies: ['lawn_care'], problems: [] };
    const { outcome, problems } = outcomeOf(verdict, [lawnOff]);
    expect(outcome).toBe('problems');
    expect(composeAdminAlert(composeAlert({ labels: ['Pest', 'Lawn'], problems }, ALERT_IDS)).why)
      .toBe('5 lawn visits priced $90.00, accepted $100.00 (not re-checked).');
    // A missing time/tech finding is not held for an unknown price.
    expect(outcomeOf(verdict, [{ code: 'missing_time_tech', families: ['lawn_care'], text: 'x' }]).outcome).toBe('ok');
  });
});

describe('acceptedFamilies', () => {
  test('a legacy rodent supplement is one of the booking\'s programs (it schedules as its own unit)', () => {
    const est = estimate([PEST], { monthly_total: 90, annual_total: 1080 });
    est.estimate_data.result.recurring.rodentBaitMo = 40;
    expect([...acceptedFamilies(est)]).toEqual(['pest_control', 'rodent_bait']);
  });

  test('the termite station-rental rider is folded into bait, not a program of its own', () => {
    const bait = { service: 'termite_bait', name: 'Termite Bait Stations', visitsPerYear: 4, frequency: 'quarterly', annual: 480, mo: 40 };
    const rental = { service: 'termite_station_rental', name: 'Station Rental', annual: 120, mo: 10 };
    expect([...acceptedFamilies(estimate([PEST, bait, rental]))].sort()).toEqual(['pest_control', 'termite_bait']);
  });
});

describe('composeAlert', () => {
  test('every problem shape composes under the notification rule', () => {
    const verdict = run([PEST, LAWN, TREE], [...pestRows({ childOverrides: untimed }), ...lawnRows({ childOverrides: untimed }), ...treeRows({ childOverrides: untimed })]);
    const spec = composeAlert(verdict, { ...ALERT_IDS, customerName: 'A. Very-Long-Hyphenated-Surname-Indeed' });
    const composed = composeAdminAlert(spec);
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(composed.why).toBe('3 pest visits missing time/tech; 5 lawn visits missing time/tech (+1 more).');
    expect(spec.detail).toContain('- 8 T&S visits missing time/tech');
  });

  test('a single problem reads as one sentence with the customer in the headline', () => {
    const composed = composeAdminAlert(composeAlert(run([PEST, LAWN], [...pestRows(), ...lawnRows({ childOverrides: untimed })]), ALERT_IDS));
    expect(composed.headline).toBe("Schedule — fix J. Sample's combined booking");
    expect(composed.why).toBe('5 lawn visits missing time/tech.');
  });
});

describe('postAlert', () => {
  const verdict = { ok: false, labels: ['Pest', 'Lawn'], problems: [{ code: 'missing_time_tech', families: ['lawn_care'], text: '3 lawn visits missing time/tech' }] };

  test('a problem is a needs-you Schedule bell on the estimate, tagged for the bell policy, deduped per estimate', async () => {
    const raise = jest.fn(async () => ({ id: 'n1', deduped: false }));
    await postAlert({ id: 'estimate-1', customer_id: 'customer-1' }, verdict, { customerName: 'J. Sample' }, { raise });
    const [category, spec, opts] = raise.mock.calls[0];
    expect(category).toBe('alert');
    expect(spec).toMatchObject({
      area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'combined_booking_verified',
      subject: { type: 'estimate', id: 'estimate-1' }, link: '/admin/customers?customerId=customer-1',
    });
    expect(spec.detail).toBeUndefined();
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'combined-booking-check:estimate-1', refreshOnDedupe: true });
    expect(opts.metadata).toMatchObject({ estimateId: 'estimate-1', itemKeys: ['lawn_care'] });
  });

  test('a standing bell re-rings only for a service family it did not carry', () => {
    const lawn = { code: 'missing_time_tech', families: ['lawn_care'] };
    const pest = { code: 'missing_time_tech', families: ['pest_control'] };
    const lawnPrice = { code: 'price_mismatch', families: ['lawn_care'] };
    const meta = { itemKeys: problemKeys(lawn) };
    expect(ringOnNewProblem(problemKeys(lawn))({}, meta)).toBe(false);
    expect(ringOnNewProblem(problemKeys(pest))({}, meta)).toBe(true);
    // A second kind of problem on a family the bell already carries does not ring again.
    expect(ringOnNewProblem([...problemKeys(lawn), ...problemKeys(lawnPrice)])({}, meta)).toBe(false);
  });
});

describe('outcomeOf', () => {
  const lawnOpen = { code: 'missing_time_tech', families: ['lawn_care'], text: '5 lawn visits missing time/tech' };
  test('maps every verdict to what the sweep does', () => {
    expect(outcomeOf(null).outcome).toBe('skipped');
    expect(outcomeOf({ heldFamilies: [], problems: [{ code: 'missing_time_tech', families: ['pest_control'] }] }).outcome).toBe('problems');
    expect(outcomeOf({ ok: true, heldFamilies: [], problems: [] }).outcome).toBe('ok');
    expect(outcomeOf({ ok: false, deferred: true, heldFamilies: [], problems: [] }).outcome).toBe('deferred');
  });

  test('a finding about a service that went on hold stays on the bell, marked, instead of closing as fixed', () => {
    const clean = { ok: true, deferred: false, heldFamilies: ['lawn_care'], problems: [] };
    expect(outcomeOf(clean, [lawnOpen])).toEqual({ outcome: 'problems', problems: [{ ...lawnOpen, held: 'hold' }] });
    // Not on hold: a clean verdict closes it.
    expect(outcomeOf({ ...clean, heldFamilies: [] }, [lawnOpen]).outcome).toBe('ok');
    const why = composeAdminAlert(composeAlert({ labels: ['Pest'], problems: [{ ...lawnOpen, held: 'hold' }] }, ALERT_IDS)).why;
    expect(why).toBe('5 lawn visits missing time/tech (on hold).');
  });
});
