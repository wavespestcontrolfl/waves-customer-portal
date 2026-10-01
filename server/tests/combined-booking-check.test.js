const check = require('../services/combined-booking-check');
const { evaluateCombinedBooking, composeAlert, postAlert, ringOnNewProblem, markPrepaidCoverage } = check;

const DAY0 = '2026-10-04';
const { composeAdminAlert } = require('../services/admin-alert-compose');
const ALERT_IDS = { customerName: 'J. Sample', customerId: 'customer-1', estimateId: 'estimate-1' };
const TECH = 'tech-1';
const PEST = { service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly', annual: 600, mo: 50 };
const LAWN = { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6, frequency: 'bimonthly', annual: 600, mo: 50 };
const TREE = { service: 'tree_shrub', name: 'Tree & Shrub', visitsPerYear: 9, frequency: 'every_6_weeks', annual: 540, mo: 45 };

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
function series({ key, type, visits, price, spacing, invoiceId = 'inv-1', childOverrides = {}, parentOverrides = {} }) {
  const parentId = `parent-${key}`;
  const base = { catalog_service_key: key, service_type: type, status: 'pending', window_start: '10:00:00', technician_id: TECH, is_recurring: true };
  const rows = [{ ...base, id: parentId, scheduled_date: DAY0, recurring_parent_id: null, estimated_price: null,
    first_application_invoice_id: invoiceId, ...parentOverrides }];
  for (let i = 1; i < visits; i += 1) {
    rows.push({ ...base, id: `${parentId}-c${i}`, scheduled_date: addDays(DAY0, spacing * i), recurring_parent_id: parentId,
      estimated_price: price, first_application_invoice_id: null, ...childOverrides });
  }
  return rows;
}
const pestRows = (o = {}) => series({ key: 'pest_general_quarterly', type: 'Quarterly Pest Control', visits: 4, price: 150, spacing: 91, ...o });
const lawnRows = (o = {}) => series({ key: 'lawn_care_recurring', type: 'Lawn Care', visits: 6, price: 100, spacing: 61, ...o });
const treeRows = (o = {}) => series({ key: 'tree_shrub_6week', type: 'Tree & Shrub', visits: 9, price: 60, spacing: 42, ...o });
const invoice = (items, status = 'sent') => ({ id: 'inv-1', status, line_items: items });
const setupFee = { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 49, amount: 49 };
const firstApp = (amount, description = 'First service application') => ({
  description, quantity: 1, unit_price: amount, amount, client_id: `scheduled_${description.replace(/\W+/g, '_')}_primary`,
});
const goodInvoice = () => invoice([setupFee, firstApp(150, 'Quarterly Pest Control'), firstApp(100, 'Lawn Care')]);

function run(lines, rows, extra = {}) {
  return evaluateCombinedBooking({
    estimate: estimate(lines), rows,
    invoices: new Map([['inv-1', extra.invoice || goodInvoice()]]),
    customerName: 'J. Sample', excludedFamilies: extra.excludedFamilies, scheduleGaps: extra.scheduleGaps,
    scheduleSkippedFamilies: extra.scheduleSkippedFamilies, scheduleUnjudged: extra.scheduleUnjudged,
  });
}
const codes = (verdict) => verdict.problems.map((problem) => problem.code);

describe('evaluateCombinedBooking', () => {
  test('a clean pest + lawn accept is OK', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()]);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.labels).toEqual(['Pest', 'Lawn']);
  });

  test('a clean pest + lawn + tree & shrub accept is OK', () => {
    const treeInvoice = invoice([setupFee, firstApp(150), firstApp(100), firstApp(60)]);
    const verdict = run([PEST, LAWN, { ...TREE }], [...pestRows(), ...lawnRows(), ...treeRows()], { invoice: treeInvoice });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.labels).toEqual(['Pest', 'Lawn', 'Tree & Shrub']);
  });

  test('companion visits with no time or technician are counted per service', () => {
    const lawn = lawnRows({ childOverrides: { window_start: null, technician_id: null } });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.find((p) => p.code === 'missing_time_tech').text).toBe('5 lawn visits missing time/tech');
    const spec = composeAlert(verdict, ALERT_IDS);
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe("Schedule — fix J. Sample's combined booking");
    expect(composed.why).toBe('5 lawn visits missing time/tech.');
  });

  test('a visit with a time but no technician still fails', () => {
    const lawn = lawnRows({ parentOverrides: { technician_id: null } });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(codes(verdict)).toEqual(['missing_time_tech']);
    expect(verdict.problems[0].text).toBe('1 lawn visits missing time/tech');
  });

  test('later visits priced $0 or NULL are the unpriced-series alert\'s, never a second bell here', () => {
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawnRows({ price: 0 })]))).toEqual([]);
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawnRows({ price: null })]))).toEqual([]);
  });

  test('a later visit priced off the accepted per-visit amount is reported', () => {
    const lawn = lawnRows({ price: 90 });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(codes(verdict)).toEqual(['price_mismatch']);
    expect(verdict.problems[0].text).toBe('lawn $90.00 vs $100.00 on 5 visits');
  });

  test('a price within two cents is accepted', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows({ price: 100.02 })]);
    expect(verdict.ok).toBe(true);
  });

  test('a first invoice that does not total the first-day prices is reported', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], {
      invoice: invoice([setupFee, firstApp(150), firstApp(25.4)]),
    });
    expect(codes(verdict)).toEqual(['first_invoice_mismatch']);
    expect(verdict.problems[0].text).toBe('first invoice $175.40 ≠ $250.00');
  });

  test('the setup fee line does not count toward the first-application total', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], {
      invoice: invoice([{ description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99, amount: 99 }, firstApp(250)]),
    });
    expect(verdict.ok).toBe(true);
  });

  test('first-day services with no price and no invoice are the unpriced-series alert\'s', () => {
    expect(codes(run([PEST, LAWN], [...pestRows({ invoiceId: null }), ...lawnRows({ invoiceId: null })]))).toEqual([]);
  });

  test('first-day rows priced individually need no invoice', () => {
    const verdict = run([PEST, LAWN], [
      ...pestRows({ invoiceId: null, parentOverrides: { estimated_price: 150 } }),
      ...lawnRows({ invoiceId: null, parentOverrides: { estimated_price: 100 } }),
    ]);
    expect(verdict.ok).toBe(true);
  });

  test('one row carrying the combined same-day price covers its unpriced sibling', () => {
    const verdict = run([PEST, LAWN], [
      ...pestRows({ invoiceId: null, parentOverrides: { estimated_price: 250 } }),
      ...lawnRows({ invoiceId: null }),
    ]);
    expect(verdict.ok).toBe(true);
  });

  test('first-day rows split across two invoices are reported', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows({ invoiceId: 'inv-2' })]);
    expect(codes(verdict)).toEqual(['first_invoice_split']);
  });

  test.each(['void', 'refunded'])('a %s first invoice leaves its members to the unpriced-series alert (nothing to compare)', (status) => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: invoice([firstApp(150), firstApp(100)], status) });
    expect(codes(verdict)).toEqual([]);
  });

  test('a family the classifier skipped (plan hold, stopped series) is left out, never certified', () => {
    const tree = treeRows({ invoiceId: null, parentOverrides: { estimated_price: 60 } });
    const verdict = run([PEST, LAWN, TREE], [...pestRows(), ...lawnRows(), ...tree.map((row) => ({ ...row, technician_id: null }))],
      { scheduleSkippedFamilies: new Set(['tree_shrub']) });
    expect(verdict.ok).toBe(true);
    expect(verdict.labels).toEqual(['Pest', 'Lawn']);
    // A hold that leaves one family still checks it (and keeps a standing bell alive).
    const pestOnly = run([PEST, LAWN], [...pestRows({ childOverrides: { technician_id: null } }), ...lawnRows()],
      { scheduleSkippedFamilies: new Set(['lawn_care']) });
    expect(pestOnly.labels).toEqual(['Pest']);
    expect(codes(pestOnly)).toEqual(['missing_time_tech']);
    // Every family on hold: nothing to judge, a standing bell is left frozen.
    const all = run([PEST, LAWN], [...pestRows(), ...lawnRows()], { scheduleSkippedFamilies: new Set(['pest_control', 'lawn_care']) });
    expect(all).toMatchObject({ frozen: true, problems: [] });
  });

  test('a pest + legacy rodent accept is a multi-service booking (the rodent rides as a supplement)', () => {
    const est = estimate([PEST], { monthly_total: 85, annual_total: 1020 });
    est.estimate_data.result.recurring.rodentBaitMo = 35;
    const accepted = check.acceptedPrograms(est);
    expect([...accepted.programs.keys()]).toEqual(['pest_control', 'rodent_bait']);
  });

  test('a legacy rodent program is billed as monthly dues: its visits are expected unpriced, the booking can be OK', () => {
    const est = estimate([PEST], { monthly_total: 90, annual_total: 1080 });
    est.estimate_data.result.recurring.rodentBaitMo = 40;
    const accepted = check.acceptedPrograms(est);
    expect(accepted.programs.get('pest_control').perVisit).toBe(150);
    expect(accepted.programs.get('rodent_bait')).toMatchObject({ dues: true, perVisit: 0 });
    const rodent = series({ key: 'rodent_bait_quarterly', type: 'Rodent Bait Stations', visits: 4, price: null, spacing: 91,
      invoiceId: null });
    const verdict = evaluateCombinedBooking({ estimate: est, rows: [...pestRows({ invoiceId: null,
      parentOverrides: { estimated_price: 150 } }), ...rodent], invoices: new Map() });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    // The rodent visits are judged (not dropped): one with no technician is reported.
    const untimed = rodent.map((row, i) => (i === 1 ? { ...row, technician_id: null } : row));
    const late = evaluateCombinedBooking({ estimate: est, rows: [...pestRows({ invoiceId: null,
      parentOverrides: { estimated_price: 150 } }), ...untimed], invoices: new Map() });
    expect(late.problems.map((p) => p.text)).toEqual(['1 rodent visits missing time/tech']);
  });

  test('rodent bait stored as a legacy line AND as rodentBaitMo is billed once when reconciling', () => {
    const RODENT = { service: 'rodent_bait', name: 'Rodent Bait Stations', visitsPerYear: 4, frequency: 'quarterly', annual: 600, mo: 50 };
    const est = estimate([PEST, RODENT]);
    est.estimate_data.result.recurring.rodentBaitMo = 50;
    expect(check.acceptedPrograms(est).programs.get('pest_control').perVisit).toBe(150);
  });

  test('an add-on the office put on an invoice-mode invoice is not service dollars', () => {
    const invoiceMode = { id: 'inv-1', status: 'sent',
      notes: 'Auto-generated from accepted estimate #estimate-1 (invoice-mode recurring). Monthly equivalent: $100.00/mo.',
      line_items: [{ description: 'Pest + Lawn (quarterly recurring — first quarterly visit)', quantity: 1, unit_price: 250, amount: 250 },
        { description: 'Fire ant treatment', quantity: 1, unit_price: 50, amount: 50 }] };
    expect(check.firstApplicationAmount(invoiceMode)).toBe(250);
  });

  test('an invoice whose discount lives only in discount_amount is never certified (lines cannot give its net)', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: { ...goodInvoice(), unbacked_discount: true } });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.deferred).toBe(true);
  });

  test('a discount scoped to an add-on line does not reduce the first-application total', () => {
    const items = [firstApp(150, 'Quarterly Pest Control'), firstApp(100, 'Lawn Care'),
      { description: 'Fire ant add-on', quantity: 1, unit_price: 50, amount: 50, client_id: 'addon_1' },
      { description: 'Add-on discount', quantity: 1, unit_price: -10, amount: -10, discount_for: 'addon_1' }];
    expect(check.firstApplicationAmount({ id: 'inv-1', status: 'sent', line_items: items })).toBe(250);
    const scoped = [...items.slice(0, 3), { description: 'Pest discount', quantity: 1, unit_price: -10, amount: -10,
      discount_for: items[0].client_id }];
    expect(check.firstApplicationAmount({ id: 'inv-1', status: 'sent', line_items: scoped })).toBe(240);
  });

  test('an invoice-mode combined invoice is read from its recurring first-visit line', () => {
    const invoiceMode = { id: 'inv-1', status: 'sent',
      notes: 'Auto-generated from accepted estimate #estimate-1 (invoice-mode recurring). Monthly equivalent: $100.00/mo.',
      line_items: [{ description: 'Pest + Lawn (quarterly recurring — first quarterly visit)', quantity: 1, unit_price: 250, amount: 250 },
        { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 49, amount: 49 }] };
    expect(check.firstApplicationAmount(invoiceMode)).toBe(250);
    expect(run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: invoiceMode }).ok).toBe(true);
  });

  test('a combined route row keeps a left-out family\'s share of its price', () => {
    // Lawn + tree run as one combined route row; tree is held.
    const combo = lawnRows({ key: 'lawn_tree_shrub_combo', type: 'Lawn + Tree & Shrub', price: 160, invoiceId: null,
      parentOverrides: { estimated_price: 160 } });
    const verdict = run([PEST, LAWN, { ...TREE, visitsPerYear: 6, frequency: 'bimonthly', annual: 360, mo: 30 }],
      [...pestRows({ invoiceId: null, parentOverrides: { estimated_price: 150 } }), ...combo],
      { scheduleSkippedFamilies: new Set(['tree_shrub']) });
    expect(verdict.problems).toEqual([]);
  });

  test('individually priced first visits are judged one by one, even when their sum matches', () => {
    const pest = pestRows({ invoiceId: null, parentOverrides: { estimated_price: 200 } });
    const lawn = lawnRows({ invoiceId: null, parentOverrides: { estimated_price: 50 } });
    const verdict = run([PEST, LAWN], [...pest, ...lawn]);
    expect(codes(verdict)).toEqual(['first_day_price_mismatch']);
    expect(verdict.problems[0].detail).toBe('lawn $50.00 vs $100.00; pest $200.00 vs $150.00');
  });

  test('an unpriced child under a PRICED parent is reported here (the unpriced-series alert reads it as inheriting)', () => {
    const lawn = lawnRows({ invoiceId: null, parentOverrides: { estimated_price: 100 }, childOverrides: { estimated_price: null } });
    const verdict = run([PEST, LAWN], [...pestRows({ invoiceId: null, parentOverrides: { estimated_price: 150 } }), ...lawn]);
    expect(codes(verdict)).toEqual(['child_unpriced']);
    expect(verdict.problems[0].text).toBe('5 lawn visits have no price while their series is priced');
  });

  test('a seasonal mosquito series rolled past the first day is unslotted on purpose; same-day rows still need time/tech', () => {
    const MOSQ = { service: 'mosquito', name: 'Mosquito Control', visitsPerYear: 9, frequency: 'every_6_weeks', annual: 540, mo: 45 };
    const later = '2027-02-01';
    const mosq = series({ key: 'mosquito_seasonal', type: 'Mosquito Control', visits: 3, price: 60, spacing: 42, invoiceId: null,
      parentOverrides: { scheduled_date: later, estimated_price: 60, window_start: null, technician_id: null },
      childOverrides: { window_start: null, technician_id: null } }).map((row) => (row.recurring_parent_id ? { ...row, scheduled_date: later } : row));
    const pest = pestRows({ invoiceId: null, parentOverrides: { estimated_price: 150 } });
    expect(check.acceptedPrograms(estimate([PEST, MOSQ])).programs.has('mosquito')).toBe(true);
    expect(codes(run([PEST, MOSQ], [...pest, ...mosq]))).not.toContain('missing_time_tech');
    const sameDay = mosq.map((row) => ({ ...row, scheduled_date: DAY0 }));
    expect(codes(run([PEST, MOSQ], [...pest, ...sameDay]))).toContain('missing_time_tech');
  });

  test('a primary_line_price with no estimated_price is not a price (completion bills nothing from it), so it is never compared', () => {
    const lawn = lawnRows({ childOverrides: { estimated_price: null, primary_line_price: 150 } });
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawn]))).toEqual([]);
  });

  test('a member the office split onto its own invoice is judged off the combined total', () => {
    const own = (amount, id = 'inv-2') => ({ id, status: 'sent', line_items: [firstApp(amount, 'Lawn Care')] });
    const lawn = lawnRows({ parentOverrides: { has_own_live_invoice: true, own_first_invoices: [own(100)] } });
    const pestOnly = invoice([setupFee, firstApp(150, 'Quarterly Pest Control')]);
    expect(run([PEST, LAWN], [...pestRows(), ...lawn], { invoice: pestOnly }).problems).toEqual([]);
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: pestOnly }))).toEqual(['first_invoice_mismatch']);
    const cheap = lawnRows({ parentOverrides: { has_own_live_invoice: true, own_first_invoices: [own(1)] } });
    const verdict = run([PEST, LAWN], [...pestRows(), ...cheap], { invoice: pestOnly });
    expect(codes(verdict)).toEqual(['split_invoice_mismatch']);
    expect(verdict.problems[0].text).toBe('split first invoice lawn $1.00 vs $100.00');
    // Two live first-visit invoices for one visit are two charges, whatever each one says.
    const doubled = lawnRows({ parentOverrides: { has_own_live_invoice: true, own_first_invoices: [own(100), own(100, 'inv-3')] } });
    const twice = run([PEST, LAWN], [...pestRows(), ...doubled], { invoice: pestOnly });
    expect(codes(twice)).toEqual(['split_invoice_duplicate']);
    expect(twice.problems[0].text).toBe('lawn first visit is on 2 live invoices');
  });

  test('a left-out family still on the shared first invoice keeps its share of the invoice total', () => {
    const three = invoice([setupFee, firstApp(150, 'Quarterly Pest Control'), firstApp(100, 'Lawn Care'), firstApp(60, 'Tree & Shrub')]);
    const verdict = run([PEST, LAWN, TREE], [...pestRows(), ...lawnRows(), ...treeRows()],
      { invoice: three, scheduleSkippedFamilies: new Set(['tree_shrub']) });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test('children on the earliest live date are price-checked when the first visits were cancelled', () => {
    const rows = [...pestRows(), ...lawnRows()].map((row) => (row.recurring_parent_id ? row : { ...row, status: 'cancelled' }));
    const zeroChild = rows.map((row) => (row.id === 'parent-lawn_care_recurring-c1' ? { ...row, estimated_price: 90 } : row));
    const earliest = zeroChild.filter((row) => row.status !== 'cancelled')
      .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0];
    expect(earliest.id).toBe('parent-lawn_care_recurring-c1');
    expect(codes(run([PEST, LAWN], zeroChild))).toEqual(['price_mismatch']);
  });

  test('an estimate the classifier did not judge is never OK, but its own problems still report', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], { scheduleUnjudged: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.deferred).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawnRows({ price: 90 })], { scheduleUnjudged: true }))).toEqual(['price_mismatch']);
  });

  test('the visit count is the shared accepted-plan classifier\'s call: a gap defers, never OK and never a second bell', () => {
    const lawn = lawnRows().slice(0, 3);
    const gap = { estimateId: 'estimate-1', serviceFamily: 'lawn_care', issues: ['missing_applications'] };
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn], { scheduleGaps: [gap] });
    expect(verdict.problems).toEqual([]);
    expect(verdict.deferred).toBe(true);
    expect(verdict.ok).toBe(false);
    expect(evaluateCombinedBooking({ estimate: estimate([PEST, LAWN]), rows: [...pestRows(), ...lawn], invoices: new Map([['inv-1', goodInvoice()]]) }).ok).toBe(true);
  });

  test('a gap does not hide this check\'s own problems', () => {
    const gap = { estimateId: 'estimate-1', serviceFamily: 'lawn_care', issues: ['missing_applications'] };
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows({ price: 90 })], { scheduleGaps: [gap] });
    expect(codes(verdict)).toEqual(['price_mismatch']);
  });

  test('a plan whose every visit was cancelled is not judged (customer churned)', () => {
    const cancelled = [...pestRows(), ...lawnRows()].map((row) => ({ ...row, status: 'cancelled', window_start: null, technician_id: null }));
    expect(run([PEST, LAWN], cancelled, { invoice: invoice([firstApp(250)], 'void') })).toBeNull();
  });

  test('a void first invoice is not a problem when its first-day rows were all cancelled', () => {
    const rows = [...pestRows(), ...lawnRows()].map((row) => (row.recurring_parent_id ? row : { ...row, status: 'cancelled' }));
    const verdict = run([PEST, LAWN], rows, { invoice: invoice([firstApp(250)], 'void') });
    expect(verdict.problems.map((p) => p.code)).not.toContain('first_invoice_missing');
    expect(verdict.ok).toBe(true);
  });

  test('a first visit parked as rescheduled is still billed on the shared invoice', () => {
    const rows = [...pestRows(), ...lawnRows()].map((row) => (row.id === 'parent-lawn_care_recurring' ? { ...row, status: 'rescheduled' } : row));
    expect(run([PEST, LAWN], rows).problems.map((p) => p.code)).not.toContain('first_invoice_mismatch');
  });

  test('a void first invoice with live first-day rows is the unpriced-series alert\'s', () => {
    const rows = [...pestRows(), ...lawnRows()].map((row) => (row.recurring_parent_id || /lawn/.test(row.id) ? row : { ...row, status: 'cancelled' }));
    expect(codes(run([PEST, LAWN], rows, { invoice: invoice([firstApp(250)], 'void') }))).toEqual([]);
  });

  test('nothing live (parked) or no rows at all is left to the accepted-plan alert', () => {
    const parked = [...pestRows(), ...lawnRows()].map((row, i) => ({ ...row, status: i % 2 ? 'cancelled' : 'rescheduled' }));
    for (const rows of [parked, []]) {
      const verdict = run([PEST, LAWN], rows);
      expect(verdict.problems).toEqual([]);
      expect(verdict.deferred).toBe(true);
      expect(verdict.ok).toBe(false);
    }
  });

  test('several problems fold into one short summary', () => {
    const lawn = lawnRows({ price: 90, childOverrides: { window_start: null, technician_id: null } });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(codes(verdict)).toEqual(['missing_time_tech', 'price_mismatch']);
    const spec = composeAlert(verdict, ALERT_IDS);
    expect(composeAdminAlert(spec).why).toBe('5 lawn visits missing time/tech; lawn $90.00 vs $100.00 on 5 visits.');
    expect(spec.detail).toContain('- 5 lawn visits missing time/tech');
  });

  test('a single-service accept is not checked at all', () => {
    expect(run([PEST], pestRows())).toBeNull();
  });

  test('a one-time accept is not checked at all', () => {
    const verdict = evaluateCombinedBooking({ estimate: estimate([PEST, LAWN], { accepted_service_mode: 'one_time' }), rows: [] });
    expect(verdict).toBeNull();
  });

  test('a family the duplicate-series guard kept on an older series is not judged; the rest still are', () => {
    const verdict = run([PEST, LAWN], pestRows(), { excludedFamilies: new Set(['lawn_care']), invoice: invoice([firstApp(150)]) });
    expect(verdict.labels).toEqual(['Pest']);
    expect(verdict.ok).toBe(true);
  });

  test('when the lines do not add up to the accepted total, nothing is certified but missing time/tech still reports', () => {
    const lines = [PEST, LAWN];
    const off = evaluateCombinedBooking({
      estimate: estimate(lines, { annual_total: 1000 }),
      rows: [...pestRows(), ...lawnRows({ price: 90 })],
      invoices: new Map([['inv-1', invoice([firstApp(999)])]]),
    });
    expect(off.ok).toBe(false);
    expect(off.deferred).toBe(true);
    expect(off.problems).toEqual([]);
    const untimed = evaluateCombinedBooking({
      estimate: estimate(lines, { annual_total: 1000 }),
      rows: [...pestRows(), ...lawnRows({ childOverrides: { technician_id: null } })],
      invoices: new Map([['inv-1', invoice([firstApp(999)])]]),
    });
    expect(codes(untimed)).toEqual(['missing_time_tech']);
  });

  test('an out-of-band payment never stands in for a visit price', () => {
    const lawn = (child) => lawnRows({ childOverrides: child });
    // Priced wrongly at $10 with $10 paid by cash: still a mismatch.
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawn({ estimated_price: 10, prepaid_amount: 10, prepaid_method: 'cash' })]))).toEqual(['price_mismatch']);
  });

  test('annual-prepaid visits are not judged on price', () => {
    const lawn = lawnRows({ price: 90, childOverrides: { prepaid_covered: true } });
    expect(run([PEST, LAWN], [...pestRows(), ...lawn]).ok).toBe(true);
  });

  test('a prepay term id or unverified stamp alone is not prepaid coverage', () => {
    const lawn = lawnRows({ price: 90, childOverrides: { prepaid_amount: 100, annual_prepay_term_id: 'term-1' } });
    expect(codes(run([PEST, LAWN], [...pestRows(), ...lawn]))).toEqual(['price_mismatch']);
  });

  test('a deposit credit line is a payment allocation, not service dollars', () => {
    const deposit = { description: 'Estimate deposit credit', category: 'deposit_credit', quantity: 1, unit_price: -50, amount: -50 };
    expect(run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: invoice([setupFee, firstApp(150), firstApp(100), deposit]) }).ok).toBe(true);
  });

  test('a real price discount line does count, so an unexplained credit is a mismatch', () => {
    const discount = { description: 'Promo', quantity: 1, unit_price: -10, amount: -10 };
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: invoice([firstApp(150), firstApp(100), discount]) });
    expect(verdict.problems[0]).toMatchObject({ code: 'first_invoice_mismatch', text: 'first invoice $240.00 \u2260 $250.00' });
  });

  test('an invoice with no readable service lines is reported, never silently OK', () => {
    for (const items of [null, [], 'not json', [setupFee]]) {
      const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: invoice(items) });
      expect(codes(verdict)).toEqual(['first_invoice_malformed']);
    }
  });

  test('a seasonal companion whose first visit is later is still covered by, and judged against, the shared invoice', () => {
    const tree = treeRows({ invoiceId: 'inv-1' }).map((row) => ({ ...row, scheduled_date: addDays(row.scheduled_date, 120) }));
    const lines = [PEST, LAWN, TREE];
    const three = invoice([setupFee, firstApp(150), firstApp(100), firstApp(60)]);
    expect(run(lines, [...pestRows(), ...lawnRows(), ...tree], { invoice: three }).ok).toBe(true);
    // Invoice that only carries the first-day pair no longer matches the three stamped rows.
    const verdict = run(lines, [...pestRows(), ...lawnRows(), ...tree], { invoice: goodInvoice() });
    expect(verdict.problems[0]).toMatchObject({ code: 'first_invoice_mismatch', text: 'first invoice $250.00 \u2260 $310.00' });
  });

  test('the termite station-rental rider is folded into the bait price before per-visit prices are derived', () => {
    const bait = { service: 'termite_bait', name: 'Termite Bait', visitsPerYear: 4, frequency: 'quarterly', annual: 480, mo: 40 };
    // The rider carries no cadence of its own; only the fold gives the bait row its full price.
    const rental = { service: 'termite_station_rental', name: 'Termite Station Rental', annual: 120, mo: 10, perTreatment: 30 };
    const termite = (price) => series({ key: 'termite_bait', type: 'Termite Bait', visits: 4, price, spacing: 91 });
    const inv = invoice([firstApp(150), firstApp(150, 'Termite')]);
    expect(run([PEST, bait, rental], [...pestRows(), ...termite(150)], { invoice: inv }).problems).toEqual([]);
    expect(codes(run([PEST, bait, rental], [...pestRows(), ...termite(120)], { invoice: inv }))).toContain('price_mismatch');
  });
});

describe('composeAlert', () => {
  test('every problem shape composes under the notification rule: headline <= 60, one-sentence why <= 110', () => {
    const verdict = {
      ok: false, labels: ['Pest', 'Lawn'],
      problems: [1, 2, 3].map((n) => ({ code: `c${n}`, text: `a fairly long problem statement number ${n} about lawn visits` })),
    };
    const composed = composeAdminAlert(composeAlert(verdict, { ...ALERT_IDS, customerName: 'A. Very-Long-Hyphenated-Surname-Indeed' }));
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(composed.why.length).toBeLessThanOrEqual(110);
    for (const text of ['first invoice $250.00 \u2260 $310.00', 'split first invoice lawn $1.00 vs $100.00',
      'first invoice is missing, void or refunded', 'T&S priced $0 on 8 visits', 'first visit lawn $50.00 vs $100.00']) {
      expect(() => composeAdminAlert(composeAlert({ ok: false, labels: ['Pest'], problems: [{ code: 'x', text }] }, ALERT_IDS))).not.toThrow();
    }
  });
});

describe('postAlert', () => {
  const estimateRow = { id: 'estimate-1', customer_id: 'customer-1' };
  const badVerdict = { ok: false, labels: ['Pest', 'Lawn'], problems: [{ code: 'price_missing', text: 'lawn priced $0 on 3 visits' }] };

  test('a problem is a needs-you Schedule bell on the estimate, deduped per estimate, linked to the customer', async () => {
    const raise = jest.fn(async () => ({ id: 'n1', deduped: false }));
    await postAlert(estimateRow, badVerdict, { customerName: 'J. Sample' }, { raise });
    const [category, spec, opts] = raise.mock.calls[0];
    expect(category).toBe('alert');
    expect(spec).toMatchObject({
      area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'combined_booking_verified',
      subject: { type: 'estimate', id: 'estimate-1' }, link: '/admin/customers?customerId=customer-1',
      why: 'Lawn priced $0 on 3 visits.',
    });
    expect(spec.detail).toBeUndefined();
    expect(opts).toMatchObject({ dedupeKey: 'combined-booking-check:estimate-1', refreshOnDedupe: true, bell: true });
    expect(opts.detail).toContain('- lawn priced $0 on 3 visits');
    expect(opts.metadata).toMatchObject({ estimateId: 'estimate-1', problemCodes: ['price_missing'] });
  });

  test('a standing problem row re-rings only for a problem it did not carry', () => {
    const meta = { problemCodes: ['price_missing'] };
    expect(ringOnNewProblem(['price_missing', 'missing_time_tech'])({}, meta)).toBe(true); // a new code appeared
    expect(ringOnNewProblem(['price_missing'])({}, meta)).toBe(false); // same problem, refreshed quietly
  });
});

describe('outcomeOf', () => {
  const { outcomeOf } = check;
  const mismatch = { code: 'first_invoice_mismatch', text: 'first invoice $250.00 \u2260 $150.00' };
  test('a price finding a verdict could not re-judge stays on the bell, visibly; any other closes as fixed', () => {
    const hidden = { ok: false, deferred: true, pricesHidden: true, problems: [] };
    expect(outcomeOf(null).outcome).toBe('skipped');
    expect(outcomeOf({ ...hidden, frozen: true }, [mismatch]).outcome).toBe('frozen');
    expect(outcomeOf({ ok: true, deferred: false, pricesHidden: false, problems: [] }, [mismatch]).outcome).toBe('ok');
    // A schedule-gap deferral looks at every price: a standing price finding it no longer sees is fixed.
    expect(outcomeOf({ ...hidden, pricesHidden: false }, [mismatch]).outcome).toBe('deferred');
    expect(outcomeOf(hidden, [{ code: 'missing_time_tech', text: 'x' }]).outcome).toBe('deferred');
    expect(outcomeOf(hidden, [mismatch])).toEqual({ outcome: 'problems', problems: [{ ...mismatch, held: true }] });
  });

  test('a held finding is carried, visibly, while another problem refreshes the bell', async () => {
    const verdict = { ok: false, deferred: true, pricesHidden: true, labels: ['Pest', 'Lawn'],
      problems: [{ code: 'missing_time_tech', text: '3 lawn visits missing time/tech' }] };
    const { outcome, problems } = outcomeOf(verdict, [mismatch]);
    expect(outcome).toBe('problems');
    const raise = jest.fn(async () => ({ id: 'n1' }));
    await postAlert({ id: 'estimate-1', customer_id: 'customer-1' }, { ...verdict, problems }, { customerName: 'J. Sample' }, { raise });
    const [, spec, opts] = raise.mock.calls[0];
    expect(opts.metadata.problemCodes).toEqual(['missing_time_tech', 'first_invoice_mismatch']);
    expect(opts.metadata.problems).toEqual([{ code: 'missing_time_tech', text: '3 lawn visits missing time/tech' }, mismatch]);
    expect(spec.why).toBe('3 lawn visits missing time/tech; first invoice $250.00 \u2260 $150.00 (not yet re-checked).');
    expect(opts.detail).toContain('not yet re-checked');
  });
});

describe('markPrepaidCoverage', () => {
  const renewals = require('../services/annual-prepay-renewals');
  afterEach(() => jest.restoreAllMocks());

  test('an out-of-band stamp covers nothing; an annual stamp counts only when the coverage validator says so; a bare term id never does', async () => {
    const validator = jest.spyOn(renewals, 'annualPrepayCoversVisit').mockImplementation(async (row) => row.id === 'valid');
    const rows = [
      { id: 'cash', prepaid_amount: 100, prepaid_method: 'cash' },
      { id: 'valid', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 't1' },
      { id: 'stale', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 't2' },
      { id: 'termonly', annual_prepay_term_id: 't3' },
      { id: 'none' },
    ];
    await markPrepaidCoverage({}, rows);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.prepaid_covered]))).toEqual({
      cash: false, valid: true, stale: false, termonly: false, none: false,
    });
    expect(validator).toHaveBeenCalledTimes(3);
  });

  test('a validator that throws reads as not covered', async () => {
    jest.spyOn(renewals, 'annualPrepayCoversVisit').mockRejectedValue(new Error('unverifiable'));
    const rows = [{ id: 'x', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 't1' }];
    await markPrepaidCoverage({}, rows);
    expect(rows[0].prepaid_covered).toBe(false);
  });
});
