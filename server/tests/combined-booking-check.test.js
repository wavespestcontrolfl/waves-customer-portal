const check = require('../services/combined-booking-check');
const { evaluateCombinedBooking, composeAlert, postAlert, ringOnNewProblem } = check;

const DAY0 = '2026-10-04';
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
const firstApp = (amount, description = 'First service application') => ({ description, quantity: 1, unit_price: amount, amount });
const goodInvoice = () => invoice([setupFee, firstApp(150, 'Quarterly Pest Control'), firstApp(100, 'Lawn Care')]);

function run(lines, rows, extra = {}) {
  return evaluateCombinedBooking({
    estimate: estimate(lines), rows,
    invoices: new Map([['inv-1', extra.invoice || goodInvoice()]]),
    technicians: new Map([[TECH, 'Casey Synthetic']]),
    customerName: 'J. Sample', excludedFamilies: extra.excludedFamilies,
  });
}
const codes = (verdict) => verdict.problems.map((problem) => problem.code);

describe('evaluateCombinedBooking', () => {
  test('a clean pest + lawn accept is OK and reads like the house format', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()]);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
    const text = composeAlert(verdict, { customerName: 'J. Sample' });
    expect(text.headline).toBe('Combined booking OK');
    expect(text.summary).toBe('J. Sample — Pest + Lawn · Sun Oct 4 10:00 · Casey · $250.00 first visit');
    expect(text.summary.length).toBeLessThanOrEqual(110);
  });

  test('a clean pest + lawn + tree & shrub accept is OK', () => {
    const treeInvoice = invoice([setupFee, firstApp(150), firstApp(100), firstApp(60)]);
    const verdict = run([PEST, LAWN, { ...TREE }], [...pestRows(), ...lawnRows(), ...treeRows()], { invoice: treeInvoice });
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.facts.labels).toEqual(['Pest', 'Lawn', 'Tree & Shrub']);
  });

  test('companion visits with no time or technician are counted per service', () => {
    const lawn = lawnRows({ childOverrides: { window_start: null, technician_id: null } });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.find((p) => p.code === 'missing_time_tech').text).toBe('5 lawn visits missing time/tech');
    const text = composeAlert(verdict, { customerName: 'J. Sample' });
    expect(text.headline).toBe('Combined booking needs a look');
    expect(text.summary).toBe('J. Sample — 5 lawn visits missing time/tech');
  });

  test('a visit with a time but no technician still fails', () => {
    const lawn = lawnRows({ parentOverrides: { technician_id: null } });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(codes(verdict)).toEqual(['missing_time_tech']);
    expect(verdict.problems[0].text).toBe('1 lawn visits missing time/tech');
  });

  test('later visits priced $0 or NULL are reported by service', () => {
    const lawn = lawnRows({ price: 0 });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(codes(verdict)).toEqual(['price_missing']);
    expect(verdict.problems[0].text).toBe('lawn priced $0 on 5 visits');
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

  test('first-day services with no price and no invoice are reported', () => {
    const verdict = run([PEST, LAWN], [...pestRows({ invoiceId: null }), ...lawnRows({ invoiceId: null })]);
    expect(codes(verdict)).toEqual(['first_day_uncovered']);
    expect(verdict.problems[0].text).toBe('pest + lawn first visit has no price or invoice');
  });

  test('first-day rows priced individually need no invoice', () => {
    const verdict = run([PEST, LAWN], [
      ...pestRows({ invoiceId: null, parentOverrides: { estimated_price: 150 } }),
      ...lawnRows({ invoiceId: null, parentOverrides: { estimated_price: 100 } }),
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.facts.firstVisitTotal).toBe(250);
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

  test('a void first invoice is reported', () => {
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawnRows()], { invoice: invoice([firstApp(250)], 'void') });
    expect(codes(verdict)).toEqual(['first_invoice_missing']);
  });

  test('visit counts more than one off the plan are reported', () => {
    const lawn = lawnRows().slice(0, 3);
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(codes(verdict)).toEqual(['visit_count']);
    expect(verdict.problems[0].text).toBe('visits off plan: lawn 3 of 6');
  });

  test('a count one off the plan is tolerated; cancelled visits do not count', () => {
    const lawn = lawnRows();
    lawn[lawn.length - 1] = { ...lawn[lawn.length - 1], status: 'cancelled' };
    expect(run([PEST, LAWN], [...pestRows(), ...lawn]).ok).toBe(true);
  });

  test('no scheduled visits at all is a problem', () => {
    const verdict = run([PEST, LAWN], []);
    expect(codes(verdict)).toEqual(['no_visits']);
  });

  test('several problems fold into one short summary', () => {
    const lawn = lawnRows({ price: 0, childOverrides: { window_start: null, technician_id: null, estimated_price: 0 } });
    const verdict = run([PEST, LAWN], [...pestRows(), ...lawn]);
    expect(codes(verdict)).toEqual(['missing_time_tech', 'price_missing']);
    const text = composeAlert(verdict, { customerName: 'J. Sample' });
    expect(text.summary).toBe('J. Sample — 5 lawn visits missing time/tech; lawn priced $0 on 5 visits');
    expect(text.detail).toContain('- 5 lawn visits missing time/tech');
  });

  test('a single-service accept is not checked at all', () => {
    expect(run([PEST], pestRows())).toBeNull();
  });

  test('a one-time accept is not checked at all', () => {
    const verdict = evaluateCombinedBooking({ estimate: estimate([PEST, LAWN], { accepted_service_mode: 'one_time' }), rows: [] });
    expect(verdict).toBeNull();
  });

  test('a family the duplicate-series guard kept on an older series is not judged', () => {
    const verdict = run([PEST, LAWN], pestRows(), { excludedFamilies: new Set(['lawn_care']) });
    expect(verdict).toBeNull();
  });

  test('when the lines do not add up to the accepted total, dollars are not compared but $0 still is', () => {
    const lines = [PEST, LAWN];
    const off = evaluateCombinedBooking({
      estimate: estimate(lines, { annual_total: 1000 }),
      rows: [...pestRows(), ...lawnRows({ price: 90 })],
      invoices: new Map([['inv-1', invoice([firstApp(999)])]]), technicians: new Map(),
    });
    expect(off.ok).toBe(true);
    const zero = evaluateCombinedBooking({
      estimate: estimate(lines, { annual_total: 1000 }),
      rows: [...pestRows(), ...lawnRows({ price: 0 })],
      invoices: new Map([['inv-1', invoice([firstApp(999)])]]), technicians: new Map(),
    });
    expect(codes(zero)).toEqual(['price_missing']);
  });

  test('prepaid visits are not judged on price', () => {
    const lawn = lawnRows({ price: 0, childOverrides: { prepaid_amount: 100, estimated_price: null } });
    expect(run([PEST, LAWN], [...pestRows(), ...lawn]).ok).toBe(true);
  });
});

describe('composeAlert length', () => {
  test('headline stays within 60 and summary within 110 characters', () => {
    const verdict = {
      ok: false, facts: { labels: ['Pest', 'Lawn'] },
      problems: [1, 2, 3].map((n) => ({ code: `c${n}`, text: `a fairly long problem statement number ${n} about lawn visits` })),
    };
    const text = composeAlert(verdict, { customerName: 'J. Sample' });
    expect(text.headline.length).toBeLessThanOrEqual(60);
    expect(text.summary.length).toBeLessThanOrEqual(110);
  });
});

describe('postAlert', () => {
  const estimateRow = { id: 'estimate-1', customer_id: 'customer-1' };
  const ctx = { customerName: 'J. Sample' };
  const okVerdict = { ok: true, problems: [], facts: { labels: ['Pest', 'Lawn'], firstDate: DAY0, firstTime: '10:00', tech: 'Casey', firstVisitTotal: 250 } };
  const badVerdict = { ok: false, problems: [{ code: 'price_missing', text: 'lawn priced $0 on 3 visits' }], facts: { labels: ['Pest', 'Lawn'] } };

  async function post(verdict) {
    const notifyAdmin = jest.fn(async () => ({ id: 'n1', deduped: false }));
    await postAlert({}, estimateRow, verdict, ctx, { notifier: { notifyAdmin } });
    return notifyAdmin.mock.calls[0];
  }

  test('a problem is an ACT row that always rings, deduped per estimate, linked to the customer', async () => {
    const [category, title, body, opts] = await post(badVerdict);
    expect(category).toBe('ops_digest');
    expect(title).toBe('Combined booking needs a look');
    expect(body).toBe('J. Sample — lawn priced $0 on 3 visits');
    expect(opts).toMatchObject({
      link: '/admin/customers?customerId=customer-1', dedupeKey: 'combined-booking-check:estimate-1', refreshOnDedupe: true, bell: true,
    });
    expect(opts.metadata).toMatchObject({ checkResult: 'problem', kind: 'ACT', audience: 'owner', feed: null, quiet: false, problemCodes: ['price_missing'] });
    expect(await opts.ringGate({})).toBe(true);
  });

  test('a standing problem row re-rings only for a problem it did not carry', () => {
    const ring = ringOnNewProblem(['price_missing', 'missing_time_tech']);
    const meta = (extra) => ({ checkResult: 'problem', problemCodes: ['price_missing'], ...extra });
    expect(ring({}, meta())).toBe(true); // a new code appeared
    expect(ringOnNewProblem(['price_missing'])({}, meta())).toBe(false); // same problem, refreshed quietly
    expect(ringOnNewProblem(['price_missing'])({}, meta({ resolved: true }))).toBe(true); // came back after clearing
    expect(ringOnNewProblem(['price_missing'])({}, { checkResult: 'ok' })).toBe(true);
  });

  test('an OK row is an FYI whose first ring is decided against prior OK rows only', async () => {
    const [, title, body, opts] = await post(okVerdict);
    expect(title).toBe('Combined booking OK');
    expect(body).toBe('J. Sample — Pest + Lawn · Sun Oct 4 10:00 · Casey · $250.00 first visit');
    expect(opts.metadata).toMatchObject({ checkResult: 'ok', kind: 'FYI', problemCodes: [] });
    expect(opts.ringOnRefresh()).toBe(false);
    const conn = (found) => () => ({ where: () => ({ whereRaw: () => ({ whereRaw: () => ({ first: async () => found }) }) }) });
    expect(await opts.ringGate(conn({ id: 'earlier' }))).toBe(false); // an OK already exists: quiet
    expect(await opts.ringGate(conn(undefined))).toBe(true); // the first OK ever rings once
  });
});
