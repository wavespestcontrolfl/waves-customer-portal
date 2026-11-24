// The production share PAY LINE, no database (PR 2): the line math in the paycheck, the overtime it causes in the federal
// regular rate for its own week (worked example below), the frozen snapshot and the review token, the stub, run CSV and run
// totals, the gate, and the Tech Rewards dating. All names and figures are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { computePaycheck } = require('../services/payroll-calc');
const { lineOvertimePremium } = require('../services/payroll-regular-rate');
const { priceCheckLines } = require('../services/payroll-pay-lines');
const share = require('../services/payroll-production-share');
const { shareForWeek } = require('../services/production-share');
const { buildCheck, tokenOf, checksToCsv } = require('../services/payroll-runs');
const { checkComponents, earnedGrossCents } = require('../services/tech-rewards-scoreboard');

const WEEK = '2026-09-14'; // Monday; pay Friday 2026-09-25
const PAY_DATE = '2026-09-25';
const W4 = { id: null, formYear: 2026, filingStatus: 'single', step2Checkbox: false, exempt: false };
const SETTINGS = { id: 7, fromWeek: '2026-09-07', rateBps: 1500, barType: 'per_shift', barCents: 90000 };

const stops = (rows) => rows.map(([visitId, workDate, creditCents, needsReview = false]) => ({
  visitId, workDate, kind: 'priced', creditCents, needsReview,
}));
// A week of 4 shifts: credited $4,120.00 against a $3,600.00 bar (4 x $900) = $520.00 above; 15% = $78.00.
const WEEK_STOPS = stops([
  ['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 110000], ['v3', '2026-09-16', 100000], ['v4', '2026-09-17', 102000],
]);
const workedOut = (rows = WEEK_STOPS, settings = SETTINGS) => {
  const days = [...new Set(rows.map((row) => row.workDate))].length;
  const result = shareForWeek({ credits: rows, shifts: days, settings });
  return { shareCents: result.shareCents, snapshot: share.snapshotOf({ weekStart: WEEK, settings, result, stops: rows }) };
};

const tech = (patch = {}) => ({
  technician_id: 'tech-1', name: 'Sample Alpha', pay_rate: '20.00', pay_method: 'check', flsa_overtime_covered: true,
  regular_minutes: '2400.00', overtime_minutes: '0.00', ...patch,
});
const build = (patch, extra = {}) => buildCheck({
  tech: tech(patch), payDate: PAY_DATE, weekStart: WEEK, w4: null, ytdGrossCents: 0, ...extra,
});

describe('the share line in the paycheck', () => {
  test('the week works out to the cent: 15% of what is above the per-shift bar', () => {
    expect(shareForWeek({ credits: WEEK_STOPS, shifts: 4, settings: SETTINGS })).toMatchObject({
      creditedCents: 412000, barCents: 360000, aboveBarCents: 52000, shareCents: 7800, configured: true,
    });
  });

  test('computePaycheck adds the share to gross and to every tax base, and names it in the output only when above $0', () => {
    const base = { payDate: PAY_DATE, hourlyRate: '20.00', regularMinutes: '2400.00', overtimeMinutes: '0.00', w4: W4, payLines: {} };
    const without = computePaycheck(base);
    const withShare = computePaycheck({ ...base, payLines: { productionShareCents: 7800 } });
    expect(without.grossPayCents).toBe(80000);
    expect(without).not.toHaveProperty('productionShareCents');
    expect(withShare.productionShareCents).toBe(7800);
    expect(withShare.grossPayCents).toBe(87800);
    expect(withShare.incomeTaxWagesCents).toBe(87800);
    expect(withShare.taxableWages.medicareCents).toBe(87800);
    expect(withShare.socialSecurityEmployeeCents).toBe(Math.round(87800 * 0.062));
    expect(withShare.netPayCents).toBe(87800 - withShare.federalIncomeTaxCents - withShare.socialSecurityEmployeeCents - withShare.medicareEmployeeCents - withShare.additionalMedicareCents);
  });

  test('a negative or fractional share is refused', () => {
    const base = { payDate: PAY_DATE, hourlyRate: '20.00', regularMinutes: '2400.00', w4: W4 };
    expect(() => computePaycheck({ ...base, payLines: { productionShareCents: -1 } })).toThrow();
    expect(() => computePaycheck({ ...base, payLines: { productionShareCents: 1.5 } })).toThrow();
  });
});

describe('the share in the federal regular rate, for its own week', () => {
  // WORKED EXAMPLE. A technician at $20.00 an hour works 45 hours in the week (40 regular, 5 overtime) and earns a $162.00
  // production share for that week.
  //   hourly pay      40 x $20.00 + 5 x $30.00                          = $950.00 (straight time for all 45 hours is already in it)
  //   share per hour  $162.00 / 45 hours                                = $3.60
  //   premium         1/2 x $3.60 x 5 overtime hours                    = $9.00   (29 CFR 778.109, 778.209)
  //   check           $950.00 + $162.00 + $9.00                         = $1,121.00
  // A week with no overtime pays no premium.
  const hours = (regular, overtime) => [{ weekStart: WEEK, regularMinutes: String(regular * 60), overtimeMinutes: String(overtime * 60) }];
  // the line as lineOvertimePremium reads it (priceLines turns priceableLine's earnedWeekStart into weekStart)
  const line = (cents) => ({ kind: share.KIND, amountCents: cents, weekStart: WEEK });

  test('45 hours and a $162.00 share: the premium is $9.00', () => {
    const priced = lineOvertimePremium({ weeks: hours(40, 5), lines: [line(16200)] });
    expect(priced.extraPremiumCents).toBe(900);
    expect(priced.weeks).toEqual([expect.objectContaining({ weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 16200, premiumCents: 900 })]);
  });

  test('the whole check: hourly $950.00 + share $162.00 + premium $9.00 = $1,121.00 gross', () => {
    const premium = lineOvertimePremium({ weeks: hours(40, 5), lines: [line(16200)] }).extraPremiumCents;
    const pay = computePaycheck({
      payDate: PAY_DATE, hourlyRate: '20.00', regularMinutes: '2400.00', overtimeMinutes: '300.00', w4: W4, flsaCovered: true,
      payLines: { productionShareCents: 16200, lineOvertimePremiumCents: premium },
    });
    expect(pay.regularPayCents + pay.overtimePayCents).toBe(95000);
    expect(pay.grossPayCents).toBe(112100);
    // Box 12 code TT counts the overtime premium on the hourly pay and the premium the share caused.
    expect(pay.qualifiedOvertimeCents).toBe(pay.overtimePremiumCents + 900);
  });

  test('a week with no overtime, or no hours, pays no premium', () => {
    expect(lineOvertimePremium({ weeks: hours(38, 0), lines: [line(16200)] }).extraPremiumCents).toBe(0);
    expect(lineOvertimePremium({ weeks: [], lines: [line(16200)] }).extraPremiumCents).toBe(0);
  });

  test('the share and a commission over the same week share one regular rate (one rounding)', () => {
    // $162.00 share + $100.01 commission = $262.01 over 45 h, 5 overtime hours: 26201 x 5 / (2 x 45) = 1455.6 cents -> 1456
    const both = lineOvertimePremium({
      weeks: hours(40, 5),
      lines: [line(16200), { amountCents: 10001, weekStart: WEEK }],
    });
    expect(both.extraPremiumCents).toBe(1456);
  });

  test('a share a finalized check already paid for the week counts as earlier line pay for a later check of that week', () => {
    // The share check priced $9.00 on the $162.00. A later $100.00 commission for the same week is priced as the whole week
    // less what was paid: (16200 + 10000) x 5 / 90 = 1455.6 -> 1456 whole, less 900 paid = 556, never below its own rounded-up 556.
    const later = lineOvertimePremium({
      weeks: hours(40, 5),
      lines: [{ amountCents: 10000, weekStart: WEEK }],
      earlierLines: [{ amountCents: 16200, weekStart: WEEK }],
      earlierPremiums: [{ weekStart: WEEK, premiumCents: 900 }],
    });
    expect(later.extraPremiumCents).toBe(556);
  });

  test('priceCheckLines keeps the share in the ordinary part of a week a Tech Rewards line also covers', () => {
    const priced = priceCheckLines({
      weeks: hours(40, 5),
      lines: [line(16200), { kind: 'december_gift', amountCents: 30000, weekStart: WEEK }],
    });
    // whole week: (16200 + 30000) x 5 / 90 = 2566.7 -> 2567; without the gift: 900
    expect(priced.weeks[0]).toMatchObject({ premiumCents: 2567, ordinaryPremiumCents: 900 });
  });
});

describe('buildCheck with a share', () => {
  const lineGates = () => { delete process.env.GATE_PAYROLL_PAY_LINES; delete process.env.GATE_PAYROLL_TIME_OFF; };
  beforeEach(lineGates);
  afterAll(lineGates);

  test('the share is a line of the check: stored cents, frozen snapshot, gross, even with the pay lines gate off', () => {
    const made = workedOut();
    expect(made.shareCents).toBe(7800);
    const { check } = build({ production_share: made, line_premium: { extraPremiumCents: 0, weeks: [{ weekStart: WEEK, premiumCents: 0 }] } });
    expect(check.production_share_cents).toBe(7800);
    expect(check.gross_cents).toBe(80000 + 7800);
    expect(check.qualified_overtime_cents).toBe(0);
    const snapshot = JSON.parse(check.calc_snapshot);
    expect(snapshot.productionShare).toMatchObject({
      weekStart: WEEK, creditedCents: 412000, barCents: 360000, aboveBarCents: 52000, rateBps: 1500, barType: 'per_shift', shifts: 4, shareCents: 7800,
    });
    expect(snapshot.productionShare.stops).toEqual([
      { visitId: 'v1', workDate: '2026-09-14', kind: 'priced', creditCents: 100000, needsReview: false },
      { visitId: 'v2', workDate: '2026-09-15', kind: 'priced', creditCents: 110000, needsReview: false },
      { visitId: 'v3', workDate: '2026-09-16', kind: 'priced', creditCents: 100000, needsReview: false },
      { visitId: 'v4', workDate: '2026-09-17', kind: 'priced', creditCents: 102000, needsReview: false },
    ]);
    // the overtime premium weeks are kept with the check, as for any pay line
    expect(snapshot.lineOvertimeWeeks).toEqual([{ weekStart: WEEK, premiumCents: 0 }]);
  });

  test('the overtime the share causes is on the check, and is stored with the line overtime figure', () => {
    const made = workedOut(stops([['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 100000], ['v3', '2026-09-16', 100000]]));
    // 3 shifts: $3,000 credited, $2,700 bar, $300 above, share $45.00
    expect(made.shareCents).toBe(4500);
    const premium = lineOvertimePremium({ weeks: [{ weekStart: WEEK, regularMinutes: '2400', overtimeMinutes: '300' }], lines: [{ amountCents: 4500, weekStart: WEEK }] });
    const { check } = build({ regular_minutes: '2400.00', overtime_minutes: '300.00', production_share: made, line_premium: premium });
    // 4500 x 5 / (2 x 45) = 250
    expect(check.line_overtime_premium_cents).toBe(250);
    expect(check.gross_cents).toBe(95000 + 4500 + 250);
    expect(check.qualified_overtime_cents).toBe(check.overtime_premium_cents + 250);
  });

  test('a $0 share (at or under the bar) stores 0 and the snapshot, and leaves the check as it was', () => {
    const made = workedOut(stops([['v1', '2026-09-14', 50000]]));
    expect(made.shareCents).toBe(0);
    const { check } = build({ production_share: made });
    const { check: plain } = build({});
    expect(check.production_share_cents).toBe(0);
    expect(JSON.parse(check.calc_snapshot).productionShare.creditedCents).toBe(50000);
    expect(check.gross_cents).toBe(plain.gross_cents);
    // the qualified overtime is stored as a figure, as in a week with a share: 0 here (no overtime hours)
    expect(check.qualified_overtime_cents).toBe(0);
  });

  test('AUDIT P1 :311: every check of an employee with share settings and a set coverage stores qualified overtime, a week under the bar too', () => {
    const under = workedOut(stops([['v1', '2026-09-14', 50000]]));
    const overtime = { regular_minutes: '2400.00', overtime_minutes: '300.00' };
    const covered = build({ production_share: under, flsa_overtime_covered: true, ...overtime }).check;
    const uncovered = build({ production_share: under, flsa_overtime_covered: false, ...overtime }).check;
    expect(covered.production_share_cents).toBe(0);
    expect(covered.qualified_overtime_cents).toBeGreaterThan(0); // the half-time premium of the overtime hours
    expect(uncovered.qualified_overtime_cents).toBe(0); // 0, not NULL
    expect(uncovered).toHaveProperty('qualified_overtime_cents', 0);
    expect(covered.gross_cents).toBe(uncovered.gross_cents);
    // coverage not set: with overtime hours (or a share above $0) the check waits for it; with neither, nothing is guessed and the check is as it was
    expect(build({ production_share: under, flsa_overtime_covered: null, ...overtime }).blocked).toContain('Set the overtime coverage first');
    expect(build({ production_share: under, flsa_overtime_covered: null }).check).not.toHaveProperty('qualified_overtime_cents');
    // no settings in force (no share): untouched
    expect(build({ flsa_overtime_covered: true, ...overtime }).check).not.toHaveProperty('qualified_overtime_cents');
  });

  test('no settings, or the gate off: no column, no snapshot key, the check is what it was', () => {
    const { check } = build({});
    expect(check).not.toHaveProperty('production_share_cents');
    expect(JSON.parse(check.calc_snapshot)).not.toHaveProperty('productionShare');
  });

  test('the gate off: readInputs opens no transaction and reads nothing', async () => {
    delete process.env.GATE_PAYROLL_PRODUCTION_SHARE;
    const conn = { transaction: jest.fn(() => { throw new Error('read'); }) };
    expect((await share.readInputs(conn, WEEK)).size).toBe(0);
    expect(conn.transaction).not.toHaveBeenCalled();
    expect(share.sharesFor(new Map(), ['tech-1'], WEEK).size).toBe(0);
  });
});

describe('one snapshot for the whole run', () => {
  const productionShare = require('../services/production-share');
  const calls = [];
  // A stand-in connection: transaction() hands its handler one fake trx (which also hands out savepoints) and records the options.
  const fakeConn = () => {
    const trx = () => ({ where: () => ({ orderBy: () => ({ pluck: async () => ['tech-a', 'tech-b', 'tech-c'] }) }) });
    trx.transaction = jest.fn(async (handler) => handler(Object.assign(() => {}, { parent: trx })));
    const conn = { transaction: jest.fn(async (handler, options) => { conn.options = options; return handler(trx); }), trx };
    return conn;
  };
  beforeEach(() => {
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
    calls.length = 0;
    jest.spyOn(productionShare, 'settingsFor').mockImplementation(async (c, id) => (id === 'tech-c' ? null : SETTINGS));
    jest.spyOn(productionShare, 'weekCreditsFor').mockImplementation(async (c, settingsById, week) => {
      calls.push([c, [...settingsById.keys()], week]);
      return new Map([...settingsById.keys()].map((id) => [id, { rows: id === 'tech-a' ? WEEK_STOPS : stops([['v9', '2026-09-14', 1000]]) }]));
    });
  });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.GATE_PAYROLL_PRODUCTION_SHARE; });

  test('every technician is worked out TOGETHER (one grouped call) on the one REPEATABLE READ read-only transaction', async () => {
    const conn = fakeConn();
    const inputs = await share.readInputs(conn, WEEK);
    expect(conn.transaction).toHaveBeenCalledTimes(1);
    expect(conn.options).toEqual({ isolationLevel: 'repeatable read', readOnly: true });
    // one call for everyone with numbers in force, on the transaction itself (never on the pool), the same function the read under the lock uses
    expect(calls).toEqual([[conn.trx, ['tech-a', 'tech-b'], WEEK]]);
    expect([...inputs.keys()].sort()).toEqual(['tech-a', 'tech-b']);
    expect(inputs.get('tech-a').settings).toBe(SETTINGS);
    expect(share.revisionOf(inputs)).toBe(share.revisionOf(await share.readInputsUnderLock(conn.trx, WEEK)));
  });

  test('the shares are worked out from those inputs alone: a visit credited to one technician is not credited to another', () => {
    const inputs = new Map([['tech-a', { settings: SETTINGS, stops: WEEK_STOPS }], ['tech-b', { settings: SETTINGS, stops: stops([['v9', '2026-09-14', 1000]]) }]]);
    const shares = share.sharesFor(inputs, ['tech-a', 'tech-b', 'tech-c'], WEEK);
    expect(shares.get('tech-a').shareCents).toBe(7800);
    expect(shares.get('tech-b').shareCents).toBe(0);
    expect(shares.has('tech-c')).toBe(false);
    const credited = [...shares.values()].flatMap((one) => one.snapshot.stops.map((stop) => stop.visitId));
    expect(new Set(credited).size).toBe(credited.length);
  });

  test('a technician whose read fails is an error row for that technician only', async () => {
    productionShare.weekCreditsFor.mockImplementation(async () => new Map([['tech-a', { rows: WEEK_STOPS }], ['tech-b', { error: 'boom' }]]));
    const inputs = await share.readInputs(fakeConn(), WEEK);
    const shares = share.sharesFor(inputs, ['tech-a', 'tech-b'], WEEK);
    expect(shares.get('tech-a').shareCents).toBe(7800);
    expect(shares.get('tech-b')).toEqual({ error: 'The production share could not be worked out: boom' });
  });
});

describe('the revision of the inputs', () => {
  const inputs = (stopRows, settings = SETTINGS) => new Map([['tech-a', { settings, stops: stopRows }]]);

  test('the same credits give the same revision in any order; a changed credit, review mark or setting changes it', () => {
    const base = share.revisionOf(inputs(WEEK_STOPS));
    expect(share.revisionOf(inputs([...WEEK_STOPS].reverse()))).toBe(base);
    expect(share.revisionOf(inputs(stops([['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 110000], ['v3', '2026-09-16', 100000], ['v4', '2026-09-17', 102001]])))).not.toBe(base);
    expect(share.revisionOf(inputs(stops([['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 110000], ['v3', '2026-09-16', 100000], ['v4', '2026-09-17', 102000, true]])))).not.toBe(base);
    expect(share.revisionOf(inputs(WEEK_STOPS, { ...SETTINGS, id: 8, rateBps: 1600 }))).not.toBe(base);
    expect(share.revisionOf(new Map([['tech-a', { error: 'x' }]]))).not.toBe(base);
  });
});

describe('the read under the payroll lock', () => {
  const productionShare = require('../services/production-share');
  afterEach(() => { jest.restoreAllMocks(); delete process.env.GATE_PAYROLL_PRODUCTION_SHARE; });

  test('runs on the connection it is given (the finalize transaction), lists every technician at once, and opens no other connection', async () => {
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
    const calls = [];
    const trx = () => ({ where: () => ({ orderBy: () => ({ pluck: async () => ['tech-a', 'tech-b', 'tech-c'] }) }) });
    trx.transaction = jest.fn(async (handler) => handler(Object.assign(() => {}, { parent: trx })));
    jest.spyOn(productionShare, 'settingsFor').mockImplementation(async (_c, id) => (id === 'tech-c' ? null : SETTINGS));
    jest.spyOn(productionShare, 'weekCreditsFor').mockImplementation(async (conn, settingsById, week) => {
      calls.push([conn, [...settingsById.keys()], week]);
      return new Map([['tech-a', { rows: WEEK_STOPS }], ['tech-b', { error: 'boom' }]]);
    });
    const inputs = await share.readInputsUnderLock(trx, WEEK);
    // ONE call of the list-all-technicians read, on the trx itself, for the technicians that have settings
    expect(calls).toEqual([[trx, ['tech-a', 'tech-b'], WEEK]]);
    expect(inputs.get('tech-a').stops).toBe(WEEK_STOPS);
    expect(inputs.get('tech-b')).toEqual({ error: 'The production share could not be worked out: boom' });
    expect(inputs.has('tech-c')).toBe(false);
  });

  test('the gate off reads nothing', async () => {
    const trx = jest.fn(() => { throw new Error('read'); });
    expect((await share.readInputsUnderLock(trx, WEEK)).size).toBe(0);
    expect(trx).not.toHaveBeenCalled();
  });
});

describe('the credit rules (applyLedger)', () => {
  const productionShare = require('../services/production-share');
  const members = (...ids) => ids.map((id) => ({ id, weight: 100000 }));
  // an invoice-priced credit; linked = the invoice ids linked to the visit
  const plain = (visitId, invoiceIds, cents = 100000, extra = {}) => ({
    visitId, workDate: '2026-09-21', kind: 'priced', creditCents: cents, needsReview: false,
    ledger: { invoices: invoiceIds.map((invoiceId) => ({ invoiceId, members: members('visit-1', 'visit-2') })) }, linkedInvoices: invoiceIds,
    // what a paid row elsewhere could touch it through: itself, its invoices and their visits
    related: [visitId, ...invoiceIds, 'visit-1', 'visit-2'], ...extra,
  });
  const job = (visitId, nth, { price = 200000, sold = 2, rootId = 'root', linked = [], visits = [rootId, 'followup'] } = {}) => ({
    visitId, workDate: '2026-09-21', kind: 'multi_visit_job', creditCents: productionShare.jobPartCents(price, sold, nth), needsReview: false,
    ledger: { job: { rootId, price, sold, nth, visits } }, linkedInvoices: linked, related: [visitId, rootId, ...visits, ...linked],
  });
  // what finalized pay runs paid: visits {visitId: week | [week, package root]}, invoices {invoiceId: week | [week, package root]},
  // jobs {rootId: [total, sold, [slots]]}. A bare week is a row paid on its own (no package basis).
  const asRow = (value) => (Array.isArray(value) ? { weekStart: value[0], root: value[1], runId: `run-${value[0]}` } : { weekStart: value, root: null, runId: `run-${value}` });
  const paidOf = ({ visits = {}, invoices = {}, jobs = {} } = {}) => ({
    visits: new Map(Object.entries(visits).map(([id, value]) => [id, asRow(value)])),
    invoices: new Map(Object.entries(invoices).map(([id, value]) => [id, [asRow(value)]])),
    jobs: new Map(Object.entries(jobs).map(([root, [totalCents, sold, slots]]) => [root, {
      totalCents, sold, weekStart: '2026-09-14', slots: new Map(slots.map((slot) => [slot, `v${slot}`])),
      slotRuns: new Map(slots.map((slot) => [slot, 'run-2026-09-14'])), totalRunId: totalCents == null ? null : 'run-2026-09-14',
    }])),
    // every paid stop row, whole (what the conflict state hashes)
    rows: [
      ...Object.entries(visits).map(([id, value]) => ({ runId: `run-${asRow(value).weekStart}`, weekStart: asRow(value).weekStart, visitId: id, invoices: [],
        bases: asRow(value).root ? [{ basisType: 'job', basisId: asRow(value).root, slot: 0 }] : [] })),
      ...Object.entries(invoices).map(([id, value]) => ({ runId: `run-${asRow(value).weekStart}`, weekStart: asRow(value).weekStart, visitId: `paid-${id}`, invoices: [id],
        bases: asRow(value).root ? [{ basisType: 'job', basisId: asRow(value).root, slot: 0 }] : [] })),
      ...Object.entries(jobs).flatMap(([root, [, , slots]]) => slots.map((slot) => ({ runId: 'run-2026-09-14', weekStart: '2026-09-14', visitId: `v${slot}`, invoices: [],
        bases: [{ basisType: 'job', basisId: root, slot }] }))),
    ],
  });
  const one = (row, paid = paidOf()) => productionShare.applyLedger([row], paid)[0];

  test('nothing paid: exactly the live credit; a paid stop would record the invoices linked to its visit and its package slot', () => {
    const out = one(plain('visit-2', ['inv-1']));
    expect(out).toMatchObject({ kind: 'priced', creditCents: 100000, needsReview: false, invoices: ['inv-1'], bases: [] });
    expect(out).not.toHaveProperty('ledger');
    expect(out).not.toHaveProperty('linkedInvoices');
    // a stop paid from its own price records the invoices linked to it too (a late invoice or a relink is caught later)
    expect(one({ visitId: 'v', workDate: '2026-09-21', kind: 'priced', creditCents: 5000, needsReview: false, ledger: null, linkedInvoices: ['inv-late'] }).invoices).toEqual(['inv-late']);
    // a $0 stop records none
    expect(one({ visitId: 'v', workDate: '2026-09-21', kind: 'free_visit', creditCents: 0, needsReview: false, ledger: null, linkedInvoices: ['inv-1'] }).invoices).toEqual([]);
    expect(one(job('root', 1))).toMatchObject({ creditCents: 100000, bases: [{ basisType: 'job', basisId: 'root', totalCents: 200000, sold: 2, slot: 1 }] });
  });

  test('INVOICE: an invoice that a paid row recorded (a relink, a second visit of it) makes the stop $0 + review', () => {
    const out = one(plain('visit-2', ['inv-1']), paidOf({ invoices: { 'inv-1': '2026-09-14' } }));
    expect(out).toMatchObject({ kind: 'invoice_paid_elsewhere', creditCents: 0, needsReview: true, invoices: [], bases: [] });
    expect(out.reason).toBe('This invoice also covers a visit paid in the week of 2026-09-14: set its credit in the production share preview.');
  });

  test('AUDIT :854 INVOICE: a LATE invoice covering a visit already credited from its own price is caught by that member visit', () => {
    // visit-1 was credited on a finalized check from its estimate (no invoice then); the invoice came after and covers visit-1 and visit-2
    const out = one(plain('visit-2', ['inv-late']), paidOf({ visits: { 'visit-1': '2026-09-14' } }));
    expect(out).toMatchObject({ kind: 'invoice_paid_elsewhere', creditCents: 0, needsReview: true });
  });

  test('INVOICE: an invoice whose members are all in this week, or that nothing paid touched, splits live as always', () => {
    expect(one(plain('visit-2', ['inv-1']), paidOf({ invoices: { 'inv-other': '2026-09-14' }, visits: { 'visit-9': '2026-09-14' } }))).toMatchObject({ kind: 'priced', creditCents: 100000 });
  });

  test('a visit already credited on a finalized check is already_paid, before anything else', () => {
    expect(one(plain('visit-2', ['inv-1']), paidOf({ visits: { 'visit-2': '2026-09-14' } }))).toMatchObject({ kind: 'already_paid', creditCents: 0, needsReview: true, invoices: [] });
  });

  test('PACKAGE: the total is fixed at the first paid row; a follow-up credits its slot of THAT total, whatever the live price is now', () => {
    const paid = paidOf({ jobs: { root: [200000, 2, [1]] } });
    for (const livePrice of [120000, 200000, 300000]) {
      expect(one(job('followup', 2, { price: livePrice }), paid)).toMatchObject({
        kind: 'multi_visit_job', creditCents: 100000, bases: [{ basisType: 'job', basisId: 'root', totalCents: 200000, sold: 2, slot: 2 }],
      });
    }
  });

  test('PACKAGE: a slot already paid (a replacement follow-up) or one past the sold count is $0 + review', () => {
    const paid = paidOf({ jobs: { root: [200000, 2, [1, 2]] } });
    const out = one(job('replacement', 2), paid);
    expect(out).toMatchObject({ kind: 'basis_exhausted', creditCents: 0, needsReview: true });
    expect(out.reason).toContain('set its credit in the production share preview');
    expect(one(job('third', 3), paidOf({ jobs: { root: [200000, 2, [1]] } })).kind).toBe('basis_exhausted');
  });

  test('PACKAGE: visits of one package in the same week, nothing paid, credit their live parts', () => {
    const rows = productionShare.applyLedger([job('root', 1), job('followup', 2)], paidOf());
    expect(rows.map((row) => [row.creditCents, row.bases[0].slot])).toEqual([[100000, 1], [100000, 2]]);
  });

  test('AUDIT :904 INVOICE: a package invoice relinked to another visit is caught by the paid package row that recorded it', () => {
    // the root was paid with invoice inv-9 linked to it; the invoice now belongs to visit-2 (a plain visit): its credit is review
    expect(one(plain('visit-2', ['inv-9']), paidOf({ invoices: { 'inv-9': '2026-09-14' } })).kind).toBe('invoice_paid_elsewhere');
  });

  test('AUDIT :726 PACKAGE: a pricing invoice that a paid row OUTSIDE the package recorded makes the package review; the same package may reuse it', () => {
    const linked = { linked: ['inv-9'] };
    // inv-9 was recorded on a visit paid on its own (no package basis), and on another package's row
    for (const outside of ['2026-09-14', ['2026-09-14', 'other-root']]) {
      const out = one(job('root', 1, linked), paidOf({ invoices: { 'inv-9': outside } }));
      expect(out).toMatchObject({ kind: 'package_paid_elsewhere', creditCents: 0, needsReview: true, bases: [], invoices: [] });
      expect(out.reason).toContain('already credited outside the package in the week of 2026-09-14');
    }
    // a visit of the package that is linked to a paid row outside it: same
    expect(one(job('followup', 2, { visits: ['root', 'followup'] }), paidOf({ visits: { root: '2026-09-14' } })).kind).toBe('package_paid_elsewhere');
    // the same package's own earlier row recorded the invoice: a remaining slot reuses it
    const own = paidOf({ invoices: { 'inv-9': ['2026-09-14', 'root'] }, visits: { root: ['2026-09-14', 'root'] }, jobs: { root: [200000, 2, [1]] } });
    expect(one(job('followup', 2, linked), own)).toMatchObject({ kind: 'multi_visit_job', creditCents: 100000, needsReview: false });
  });

  test('AUDIT :876 PACKAGE: no job basis yet, but the root or a planned visit was credited on its own in another week: the whole package is review', () => {
    for (const visits of [{ root: '2026-09-14' }, { followup: '2026-09-14' }]) {
      const rows = productionShare.applyLedger([job('root', 1), job('followup', 2)].filter((row) => !visits[row.visitId]), paidOf({ visits }));
      for (const row of rows) expect(row).toMatchObject({ kind: 'package_paid_elsewhere', creditCents: 0, needsReview: true, bases: [] });
    }
    // a visit of another package in the way does not matter
    expect(one(job('root', 1), paidOf({ visits: { unrelated: '2026-09-14' } })).creditCents).toBe(100000);
  });

  test('AUDIT :616 PACKAGE: with a job basis paid, a follow-up credits from the fixed total even when the live root price is $0', () => {
    const paid = paidOf({ jobs: { root: [200000, 2, [1]] }, visits: { root: ['2026-09-14', 'root'] } });
    expect(one(job('followup', 2, { price: 0 }), paid)).toMatchObject({
      kind: 'multi_visit_job', creditCents: 100000, needsReview: false, bases: [{ basisType: 'job', basisId: 'root', totalCents: 200000, sold: 2, slot: 2 }],
    });
    // the slot is still checked: a taken slot stays review at a $0 live price
    expect(one(job('followup', 2, { price: 0 }), paidOf({ jobs: { root: [200000, 2, [1, 2]] }, visits: { root: ['2026-09-14', 'root'] } })).kind).toBe('basis_exhausted');
    // with nothing fixed, no price is still review
    expect(one(job('root', 1, { price: 0 }))).toMatchObject({ kind: 'multi_visit_job', creditCents: 0, needsReview: true });
  });

  test('AUDIT :874 PACKAGE: a visit that was the root of a package a pay run fixed cannot take a standalone credit', () => {
    const paid = paidOf({ jobs: { 'visit-7': [200000, 2, [2]] } }); // the follow-up was paid first; the root never was
    const standalone = { visitId: 'visit-7', workDate: '2026-09-21', kind: 'priced', creditCents: 80000, needsReview: false, ledger: null, linkedInvoices: [] };
    expect(one(standalone, paid)).toMatchObject({ kind: 'package_paid_elsewhere', creditCents: 0, needsReview: true });
    // an invoice-priced one too
    expect(one(plain('visit-7', ['inv-1']), paid).kind).toBe('package_paid_elsewhere');
    // still a package: the package rule credits slot 1 of the fixed total
    expect(one(job('visit-7', 1, { rootId: 'visit-7', visits: ['visit-7', 'followup'] }), paid)).toMatchObject({ kind: 'multi_visit_job', creditCents: 100000, needsReview: false });
    // a $0 or review row is left alone, and a visit that is nobody's root is not touched
    expect(one({ ...standalone, creditCents: 0 }, paid).kind).toBe('priced');
    expect(one({ ...standalone, visitId: 'visit-8' }, paid)).toMatchObject({ kind: 'priced', creditCents: 80000 });
  });

  test('STOP OVERRIDE: the credit the owner set replaces the computed or review row, records the visit invoices, and never beats already paid', () => {
    const set = new Map([['visit-2', { creditCents: 45000, reason: 'Checked the invoice' }]]);
    const run = (row, paid = paidOf()) => productionShare.applyLedger([row], paid, set)[0];
    // a review row (an invoice paid elsewhere) takes the owner's credit, set against the conflict it had
    const elsewhere = paidOf({ invoices: { 'inv-1': '2026-09-14' } });
    const basis = productionShare.applyLedger([plain('visit-2', ['inv-1'])], elsewhere)[0].conflictTuples;
    expect(basis).toHaveLength(1);
    set.set('visit-2', { ...set.get('visit-2'), conflictTuples: basis });
    expect(run(plain('visit-2', ['inv-1']), elsewhere)).toMatchObject({
      kind: 'owner_set', creditCents: 45000, needsReview: false, reason: 'Set by the owner: Checked the invoice', invoices: ['inv-1'], bases: [],
    });
    // a computed credit too (the conflict the credit was set against has gone: no NEW conflict), and $0 records no invoice
    expect(run(plain('visit-2', ['inv-1']))).toMatchObject({ kind: 'owner_set', creditCents: 45000 });
    expect(productionShare.applyLedger([plain('visit-2', ['inv-1'])], paidOf(), new Map([['visit-2', { creditCents: 0, reason: 'none' }]]))[0])
      .toMatchObject({ kind: 'owner_set', creditCents: 0, invoices: [] });
    // another visit is untouched
    expect(run(plain('visit-3', ['inv-1']))).toMatchObject({ kind: 'priced', creditCents: 100000 });
    // a visit a pay run already paid stays already paid
    expect(run(plain('visit-2', ['inv-1']), paidOf({ visits: { 'visit-2': '2026-09-14' } }))).toMatchObject({ kind: 'already_paid', creditCents: 0, needsReview: true });
  });

  test('AUDIT :913 STOP OVERRIDE: a paid row NOT in the stored conflict tuples (paid elsewhere since it was set) ignores the credit as review', () => {
    const credit = (conflictTuples) => new Map([['visit-2', { creditCents: 45000, reason: 'Checked', technicianId: undefined, conflictTuples, revision: 'rev' }]]);
    const run = (row, paid, stored) => productionShare.applyLedger([row], paid, credit(stored))[0];
    const tuplesOf = (row, paid) => productionShare.applyLedger([row], paid)[0].conflictTuples;
    const row = plain('visit-2', ['inv-1']);
    // set with no conflict: nothing stored and nothing current, the credit is used
    expect(tuplesOf(row, paidOf())).toEqual([]);
    expect(run(row, paidOf(), [])).toMatchObject({ kind: 'owner_set', creditCents: 45000 });
    // the invoice is paid elsewhere afterwards: review, $0, the revision kept so the owner can clear it
    const later = paidOf({ invoices: { 'inv-1': '2026-09-14' } });
    const out = run(row, later, []);
    expect(out).toMatchObject({ kind: 'owner_override_conflict_changed', creditCents: 0, needsReview: true, overrideRevision: 'rev', invoices: [] });
    expect(out.reason).toContain('paid elsewhere since the owner set its credit');
    // set against that same conflict: the owner's knowing choice, the credit is used
    expect(run(row, later, tuplesOf(row, later))).toMatchObject({ kind: 'owner_set', creditCents: 45000 });
    // a paid row that is not in the stored list is new, however the stored list looks
    const other = paidOf({ invoices: { 'inv-1': '2026-09-07' } });
    expect(run(row, other, tuplesOf(row, later)).kind).toBe('owner_override_conflict_changed');
    // ONE tuple added to what was stored is new; the stored list being a SUPERSET of the current (a paid run was voided) is fine
    const both = { ...later, rows: [...later.rows, ...other.rows] };
    expect(run(row, both, tuplesOf(row, later)).kind).toBe('owner_override_conflict_changed');
    expect(run(row, later, tuplesOf(row, both))).toMatchObject({ kind: 'owner_set' });
    expect(run(row, paidOf(), tuplesOf(row, both))).toMatchObject({ kind: 'owner_set' });
    // a package slot taken since, and a package root fixed since
    const slotRow = { visitId: 'visit-2', workDate: '2026-09-21', kind: 'multi_visit_job', creditCents: 0, needsReview: true, ledger: null, linkedInvoices: [],
      packageSlot: { rootId: 'root', slot: 2, sold: 2, price: null, visits: ['root', 'visit-2'] }, related: ['root', 'visit-2'] };
    expect(tuplesOf(slotRow, paidOf())).toEqual([]);
    expect(run(slotRow, paidOf({ jobs: { root: [200000, 2, [2]] } }), []).kind).toBe('owner_override_conflict_changed');
    expect(run({ ...plain('visit-2', []), linkedInvoices: [] }, paidOf({ jobs: { 'visit-2': [200000, 2, [2]] } }), []).kind).toBe('owner_override_conflict_changed');
    // ONE rule: the package's own earlier paid row touches the stop too, so it is part of what the credit was set against
    const own = paidOf({ jobs: { root: [200000, 2, [1]] } });
    expect(run(slotRow, own, []).kind).toBe('owner_override_conflict_changed');
    expect(run(slotRow, own, tuplesOf(slotRow, own))).toMatchObject({ kind: 'owner_set' });
  });

  test('AUDIT :952/:973: the conflict tuples are EVERY paid stop row that touches the stop, sorted, run and week included', () => {
    const row = plain('visit-2', ['inv-1']);
    const paidRow = (weekStart, visitId, extra = {}) => ({ runId: `run-${weekStart}`, weekStart, visitId, invoices: [], bases: [], ...extra });
    const tuples = (rows, which = row) => productionShare.applyLedger([which], { visits: new Map(), invoices: new Map(), jobs: new Map(), rows })[0].conflictTuples;
    const first = paidRow('2026-09-14', 'visit-1', { invoices: ['inv-1'] });
    const later = paidRow('2026-09-21', 'visit-3', { invoices: ['inv-1'] });
    expect(tuples([])).toEqual([]);
    expect(tuples([first])).toHaveLength(1);
    expect(tuples([first, later])).toHaveLength(2); // a later payment of the same invoice, the earliest week unchanged
    expect(tuples([later, first])).toEqual(tuples([first, later])); // stable under the order read
    expect(tuples([paidRow('2026-09-14', 'visit-4', { invoices: ['inv-1'] })])).not.toEqual(tuples([first]));
    expect(tuples([{ ...first, runId: 'run-other' }])).not.toEqual(tuples([first])); // a voided and redrafted run is another run
    expect(tuples([paidRow('2026-09-14', 'visit-1')])).toHaveLength(1); // a visit on one of the stop's invoices, no invoice recorded
    expect(tuples([paidRow('2026-09-14', 'visit-77', { invoices: ['inv-77'] })])).toEqual([]);
    const slotRow = { visitId: 'visit-2', workDate: '2026-09-21', kind: 'multi_visit_job', creditCents: 0, needsReview: true, ledger: null, linkedInvoices: [], related: ['root', 'visit-2'] };
    const slot = (weekStart) => paidRow(weekStart, 'visit-5', { bases: [{ basisType: 'job', basisId: 'root', slot: 2 }] });
    expect(tuples([slot('2026-09-14'), slot('2026-09-21')], slotRow)).toHaveLength(2);
  });

  test('AUDIT :1210: the stop revision covers the kind the rules gave it, its pricing facts, its invoices, its package slot and its conflict tuples', () => {
    const revision = (row, rows = []) => productionShare.applyLedger([row], { visits: new Map(), invoices: new Map(), jobs: new Map(), rows })[0].stopRevision;
    const base = { ...plain('visit-2', ['inv-1']), pricing: { serviceType: 'General Pest Control', originalId: null } };
    expect(revision(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(revision(base)).toBe(revision({ ...base }));
    expect(revision({ ...base, kind: 'priced' })).toBe(revision(base)); // a field the rules do not read is not part of it
    // reclassified (a callback of earlier work, another service type, other invoices, another package slot): another revision
    expect(revision({ ...base, pricing: { serviceType: 'Pest Control Re-Service', originalId: 'orig-1' } })).not.toBe(revision(base));
    expect(revision({ ...base, pricing: { serviceType: 'General Pest Control', originalId: 'orig-1' } })).not.toBe(revision(base));
    expect(revision({ ...base, linkedInvoices: ['inv-1', 'inv-2'] })).not.toBe(revision(base));
    expect(revision({ ...base, packageSlot: { rootId: 'root', slot: 2, visits: [] } })).not.toBe(revision(base));
    // the kind the RULES gave: not the owner's credit on top of it
    const withCredit = productionShare.applyLedger([base], { visits: new Map(), invoices: new Map(), jobs: new Map(), rows: [] },
      new Map([['visit-2', { creditCents: 100, reason: 'x', conflictTuples: [] }]]))[0];
    expect(withCredit.kind).toBe('owner_set');
    expect(withCredit.stopRevision).toBe(revision(base));
    // a paid row that touches the stop
    expect(revision(base, [{ runId: 'run-1', weekStart: '2026-09-14', visitId: 'visit-1', invoices: ['inv-1'], bases: [] }])).not.toBe(revision(base));
  });

  test('AUDIT :861: dependsOnRuns names only the runs whose paid row DETERMINED the credit; the snapshot, revision and token carry them', () => {
    const row = plain('visit-2', ['inv-1']);
    // an invoice of the stop recorded by a paid row, and a visit of that invoice already paid: those paid rows decided it
    const elsewhere = paidOf({ invoices: { 'inv-1': '2026-09-21' }, visits: { 'visit-1': '2026-09-14' } });
    expect(productionShare.applyLedger([row], elsewhere)[0]).toMatchObject({ kind: 'invoice_paid_elsewhere', dependsOnRuns: ['run-2026-09-14', 'run-2026-09-21'] });
    // already paid: the run that paid the visit
    expect(productionShare.applyLedger([row], paidOf({ visits: { 'visit-2': '2026-09-14' } }))[0]).toMatchObject({ kind: 'already_paid', dependsOnRuns: ['run-2026-09-14'] });
    // a package follow-up credited from the total a run fixed; a slot that run paid is exhausted
    const fixed = paidOf({ jobs: { root: [200000, 2, [1]] } });
    expect(productionShare.applyLedger([job('followup', 2)], fixed)[0]).toMatchObject({ kind: 'multi_visit_job', creditCents: 100000, dependsOnRuns: ['run-2026-09-14'] });
    expect(productionShare.applyLedger([job('replacement', 1)], fixed)[0]).toMatchObject({ kind: 'basis_exhausted', dependsOnRuns: ['run-2026-09-14'] });
    // no paid row decided it: none, even when a paid row TOUCHES the stop (a prepaid or own-price stop whose related ids include a paid invoice)
    const own = { visitId: 'visit-2', workDate: '2026-09-21', kind: 'prepaid_plan', creditCents: 40000, needsReview: false, ledger: null, linkedInvoices: ['inv-1'], related: ['visit-2', 'inv-1'] };
    expect(productionShare.applyLedger([own], elsewhere)[0]).toMatchObject({ kind: 'prepaid_plan', creditCents: 40000, dependsOnRuns: [] });
    expect(productionShare.applyLedger([own], elsewhere)[0].conflictTuples.length).toBeGreaterThan(0); // touched, but it did not decide
    expect(productionShare.applyLedger([row], paidOf())[0].dependsOnRuns).toEqual([]);
    // an owner credit depends on the paid rows that touch it (the conflict tuples)
    const credit = new Map([['visit-2', { creditCents: 100, reason: 'x', conflictTuples: productionShare.applyLedger([own], elsewhere)[0].conflictTuples }]]);
    expect(productionShare.applyLedger([own], elsewhere, credit)[0]).toMatchObject({ kind: 'owner_set', dependsOnRuns: ['run-2026-09-21'] }); // the paid rows that touch IT
    const input = (dependsOnRuns) => new Map([['tech-a', { settings: SETTINGS, stops: [{ ...stops([['v1', '2026-09-14', 100000]])[0], dependsOnRuns }] }]]);
    const snap = (dependsOnRuns) => share.sharesFor(input(dependsOnRuns), ['tech-a'], WEEK).get('tech-a').snapshot;
    expect(snap(['run-b', 'run-a']).stops[0].dependsOnRuns).toEqual(['run-a', 'run-b']);
    expect(snap([]).stops[0]).not.toHaveProperty('dependsOnRuns');
    expect(share.revisionOf(input(['run-a']))).not.toBe(share.revisionOf(input([])));
    expect(share.signature({ production_share: snap(['run-a']) })).not.toEqual(share.signature({ production_share: snap([]) }));
  });

  test('AUDIT :996: the stop revision hashes the invoice totals, members and weights, and the package pricing inputs', () => {
    const revision = (pricing) => productionShare.applyLedger([{ ...plain('visit-2', ['inv-1']), pricing }], paidOf())[0].stopRevision;
    const facts = (extra = {}) => ({ serviceType: 'General Pest Control', originalId: null, facts: ['100.00', '', '', [100000, 0, [['inv-1', 200000, 100000, [['visit-1', 100000], ['visit-2', 100000]]]], []], null], ...extra });
    expect(revision(facts())).toBe(revision(facts()));
    const edited = (patch) => { const base = facts(); const copy = JSON.parse(JSON.stringify(base.facts)); patch(copy); return { ...base, facts: copy }; };
    expect(revision(edited((f) => { f[3][2][0][1] = 210000; }))).not.toBe(revision(facts())); // the invoice total
    expect(revision(edited((f) => { f[3][2][0][3][1][1] = 90000; }))).not.toBe(revision(facts())); // a member's weight
    expect(revision(edited((f) => { f[3][2][0][3].push(['visit-5', 100000]); }))).not.toBe(revision(facts())); // a member visit
    expect(revision(edited((f) => { f[0] = '120.00'; }))).not.toBe(revision(facts())); // the visit's own price
    expect(revision(edited((f) => { f[4] = ['root', '2000.00', 2, ['root', 'visit-2'], null]; }))).not.toBe(revision(facts())); // package pricing inputs
  });

  test('AUDIT :306: a check with a share above $0 and the overtime coverage not set is blocked, not stored with zero qualified overtime', () => {
    const withShare = { production_share: workedOut() };
    expect(build({ ...withShare, flsa_overtime_covered: null }).blocked).toContain('Set the overtime coverage first');
    expect(build({ ...withShare, flsa_overtime_covered: undefined }).blocked).toContain('Set the overtime coverage first');
    // set either way (covered or not), or no share above $0: a check
    expect(build({ ...withShare, flsa_overtime_covered: false }).check).toBeTruthy();
    expect(build({ ...withShare, flsa_overtime_covered: true }).check).toBeTruthy();
    expect(build({ production_share: workedOut(stops([['v1', '2026-09-14', 50000]])), flsa_overtime_covered: null }).blocked).toBeUndefined();
  });

  test('AUDIT :1007 STOP OVERRIDE: it belongs to the technician who held the stop; a stop reassigned since is review and shows no technician id', () => {
    const credit = { creditCents: 45000, reason: 'Checked', technicianId: 'tech-a' };
    const row = (technicianId) => ({ ...plain('visit-2', ['inv-1']), technicianId });
    const run = (technicianId) => productionShare.applyLedger([row(technicianId)], paidOf(), new Map([['visit-2', credit]]))[0];
    expect(run('tech-a')).toMatchObject({ kind: 'owner_set', creditCents: 45000, needsReview: false });
    const moved = run('tech-b');
    expect(moved).toMatchObject({ kind: 'owner_override_reassigned', creditCents: 0, needsReview: true, invoices: [], bases: [] });
    expect(moved.reason).toContain('reassigned since the owner set its credit');
    expect(moved).not.toHaveProperty('technicianId');
    expect(run('tech-a')).not.toHaveProperty('technicianId');
  });

  test('AUDIT :884 STOP OVERRIDE: a stop whose closeout changed to not performed or unconfirmed ignores the owner credit and is review', () => {
    const set = new Map([['visit-2', { creditCents: 45000, reason: 'Checked' }]]);
    for (const kind of ['not_performed', 'unverified']) {
      const row = { visitId: 'visit-2', workDate: '2026-09-21', kind, creditCents: 0, needsReview: kind === 'unverified', ledger: null, linkedInvoices: ['inv-1'] };
      const out = productionShare.applyLedger([row], paidOf(), set)[0];
      expect(out).toMatchObject({ kind: 'owner_override_closeout_changed', creditCents: 0, needsReview: true, invoices: [] });
      expect(out.reason).toContain('closeout of this stop changed since the owner set its credit');
    }
  });

  test('AUDIT :894 INVOICE: an invoice whose member is the root of a package a pay run fixed, shared with a stop outside it, is review', () => {
    // visit-1 (a member of the invoice) was never paid itself, but a follow-up was paid with package basis root = visit-1
    const out = one(plain('visit-2', ['inv-1']), paidOf({ jobs: { 'visit-1': [200000, 2, [2]] } }));
    expect(out).toMatchObject({ kind: 'package_paid_elsewhere', creditCents: 0, needsReview: true, invoices: [] });
    expect(out.reason).toContain('first visit of a package credited in the week of 2026-09-14');
    // another package's root that is not on the invoice is no obstacle
    expect(one(plain('visit-2', ['inv-1']), paidOf({ jobs: { 'visit-9': [200000, 2, [2]] } }))).toMatchObject({ kind: 'priced', creditCents: 100000 });
  });

  test('AUDIT :902 STOP OVERRIDE: an owner-set credit on a package visit keeps a job basis with the root and the slot, so the slot cannot be taken again', () => {
    const set = new Map([['followup', { creditCents: 100000, reason: 'Checked' }]]);
    // a package visit that needed review (no total known): the basis has the slot and no total
    const review = { visitId: 'followup', workDate: '2026-09-21', kind: 'multi_visit_job', creditCents: 0, needsReview: true, ledger: null, linkedInvoices: [],
      packageSlot: { rootId: 'root', slot: 2, sold: 2, price: null } };
    const out = productionShare.applyLedger([review], paidOf(), set)[0];
    expect(out).toMatchObject({ kind: 'owner_set', creditCents: 100000, bases: [{ basisType: 'job', basisId: 'root', totalCents: null, sold: 2, slot: 2 }] });
    expect(out).not.toHaveProperty('packageSlot');
    // a fixed package total is kept when one exists
    expect(productionShare.applyLedger([review], paidOf({ jobs: { root: [200000, 2, [1]] } }), set)[0].bases)
      .toEqual([{ basisType: 'job', basisId: 'root', totalCents: 200000, sold: 2, slot: 2 }]);
    // a visit that is no package visit records nothing
    expect(productionShare.applyLedger([{ ...review, packageSlot: null }], paidOf(), set)[0].bases).toEqual([]);
    // what later weeks read: a paid slot with no total. The same slot again is exhausted; another slot credits from the live price
    const slotOnly = { totalCents: null, sold: null, weekStart: '2026-09-14', slots: new Map([[2, 'followup']]), slotRuns: new Map([[2, 'run-1']]), totalRunId: null };
    const paid = { ...paidOf(), jobs: new Map([['root', slotOnly]]) };
    expect(one(job('replacement', 2), paid).kind).toBe('basis_exhausted');
    expect(one(job('first', 1), paid)).toMatchObject({ kind: 'multi_visit_job', creditCents: 100000, bases: [{ totalCents: 200000, slot: 1 }] });
  });

  test('AUDIT :1046: the retry mark is in the revision, the snapshot and the review token', () => {
    const input = (degraded) => new Map([['tech-a', { settings: SETTINGS, stops: stops([['v1', '2026-09-14', 100000]]), ...(degraded ? { degraded: true } : {}) }]]);
    expect(share.revisionOf(input(true))).not.toBe(share.revisionOf(input(false)));
    const snap = (degraded) => share.sharesFor(input(degraded), ['tech-a'], WEEK).get('tech-a').snapshot;
    expect(snap(true)).toMatchObject({ degraded: true });
    expect(snap(false)).not.toHaveProperty('degraded');
    expect(share.signature({ production_share: snap(true) })).not.toEqual(share.signature({ production_share: snap(false) }));
  });

  test('STOP OVERRIDE: the revision and the review token change with the credit the owner set, and with its kind alone', () => {
    const base = (stop) => share.revisionOf(new Map([['tech-a', { settings: SETTINGS, stops: [{ ...stops([['v1', '2026-09-14', 100000]])[0], ...stop }] }]]));
    expect(base({})).not.toBe(base({ kind: 'owner_set' }));
    expect(base({ kind: 'owner_set' })).not.toBe(base({ kind: 'owner_set', creditCents: 90000 }));
  });

  test('a row that is already $0 and needs review, and a credit no invoice or job priced, are left alone', () => {
    for (const kind of ['prepaid_plan', 'callback_other', 'free_visit', 'not_performed', 'unverified', 'multi_visit_job']) {
      const row = { visitId: 'visit-2', workDate: '2026-09-21', kind, creditCents: kind === 'prepaid_plan' ? 40000 : 0, needsReview: kind === 'unverified' || kind === 'multi_visit_job', ledger: null, linkedInvoices: [] };
      const out = one(row, paidOf({ invoices: { 'inv-1': '2026-09-14' }, jobs: { root: [200000, 2, [1, 2]] } }));
      expect(out).toMatchObject({ kind, creditCents: row.creditCents, needsReview: row.needsReview });
    }
  });
});

describe('the recorded invoice ids are in both finalize comparisons too', () => {
  const rows = (invoices) => stops([['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 110000]]).map((stop, i) => (i === 1 ? { ...stop, invoices } : stop));
  const rev = (invoices) => share.revisionOf(new Map([['tech-a', { settings: SETTINGS, stops: rows(invoices) }]]));

  test('the revision changes when only the invoices linked to a stop change', () => {
    expect(rev(['inv-1'])).toBe(rev(['inv-1']));
    expect(rev(['inv-2', 'inv-1'])).toBe(rev(['inv-1', 'inv-2']));
    expect(rev(['inv-1'])).not.toBe(rev(['inv-9']));
    expect(rev([])).not.toBe(rev(['inv-1']));
  });

  test('the snapshot stores the invoices and the package basis on the stop, and only when it has them', () => {
    const made = share.snapshotOf({
      weekStart: WEEK, settings: SETTINGS, result: shareForWeek({ credits: rows(['inv-1']), shifts: 2, settings: SETTINGS }),
      stops: rows(['inv-1']).map((stop, i) => (i === 0 ? { ...stop, bases: [{ basisType: 'job', basisId: 'root', totalCents: 200000, sold: 2, slot: 1 }] } : stop)),
    });
    expect(made.stops[0].bases).toEqual([{ basisType: 'job', basisId: 'root', totalCents: 200000, sold: 2, slot: 1 }]);
    expect(made.stops[0]).not.toHaveProperty('invoices');
    expect(made.stops[1].invoices).toEqual(['inv-1']);
  });
});

describe('the run CSV header of the overtime column', () => {
  const rowOf = (made) => {
    const { check } = build(made ? { production_share: made } : {});
    const { calc_snapshot: text, ...rest } = check;
    return { ...rest, id: 'c1', employee_name: 'Sample Alpha', ...(made ? { production_share: JSON.parse(text).productionShare } : {}) };
  };
  afterEach(() => { delete process.env.GATE_PAYROLL_PAY_LINES; });

  test('a run that paid a share says Overtime On Additional Earnings; an older run keeps the old header', () => {
    process.env.GATE_PAYROLL_PAY_LINES = 'true';
    const paid = checksToCsv([rowOf(workedOut())]).split('\n')[0].split(',');
    expect(paid).toContain('Overtime On Additional Earnings');
    expect(paid).not.toContain('Overtime On Bonus And Allowance');
    const older = checksToCsv([rowOf(null)]).split('\n')[0].split(',');
    expect(older).toContain('Overtime On Bonus And Allowance');
    expect(older).not.toContain('Overtime On Additional Earnings');
  });
});

describe('the down guard migration', () => {
  const migration = require('../models/migrations/20261124130000_payroll_production_share_down_guard');
  const fakeKnex = (stored) => {
    const calls = [];
    const knex = (table) => ({ whereNotNull: () => ({ first: async () => { calls.push(`read ${table}`); return stored ? { id: 1 } : undefined; } }) });
    knex.raw = async (sql) => { calls.push(sql.trim()); };
    knex.schema = { hasColumn: async () => true };
    return { knex, calls };
  };

  test('sorts after the migration that adds the column, and its up adds what is missing and nothing more', async () => {
    expect('20261124130000_payroll_production_share_down_guard' > '20261124070000_payroll_production_share').toBe(true);
    const missing = fakeKnex(false);
    missing.knex.schema.hasColumn = async () => false;
    await migration.up(missing.knex);
    expect(missing.calls.map((sql) => sql.replace(/\s+/g, ' '))).toEqual([
      'ALTER TABLE payroll_checks ADD COLUMN production_share_cents bigint NULL',
      'ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_production_share_check',
      'ALTER TABLE payroll_checks ADD CONSTRAINT payroll_checks_production_share_check CHECK (production_share_cents IS NULL OR production_share_cents >= 0)',
    ]);
    const present = fakeKnex(false);
    await migration.up(present.knex);
    expect(present.calls.some((sql) => /ADD COLUMN/.test(sql))).toBe(false);
  });

  test('takes the table lock BEFORE it looks for a stored share, and refuses when one is there', async () => {
    const { knex, calls } = fakeKnex(true);
    await expect(migration.down(knex)).rejects.toThrow(/production share figures/);
    expect(calls).toEqual(['LOCK TABLE payroll_checks IN ACCESS EXCLUSIVE MODE', 'read payroll_checks']);
  });

  test('with nothing stored it drops the constraint and the column after the lock', async () => {
    const { knex, calls } = fakeKnex(false);
    await migration.down(knex);
    expect(calls[0]).toBe('LOCK TABLE payroll_checks IN ACCESS EXCLUSIVE MODE');
    expect(calls.slice(-2).map((sql) => sql.replace(/\s+/g, ' '))).toEqual([
      'ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_production_share_check',
      'ALTER TABLE payroll_checks DROP COLUMN IF EXISTS production_share_cents',
    ]);
  });
});

describe('the stop override migration down', () => {
  const migration = require('../models/migrations/20261124170000_production_share_stop_overrides');
  const fakeKnex = (stored) => {
    const calls = [];
    const knex = (table) => ({ first: async () => { calls.push(`read ${table}`); return stored ? { id: 1 } : undefined; } });
    knex.raw = async (sql) => { calls.push(sql.trim()); };
    knex.schema = { hasTable: async () => true };
    return { knex, calls };
  };

  test('sorts after the newest migration of origin/main at the time of writing (20261124160100)', () => {
    expect('20261124170000_production_share_stop_overrides' > '20261124160100_mail_prospects_keep_typed_views').toBe(true);
  });

  test('takes the table lock BEFORE it looks for a stored credit, and refuses when one is there', async () => {
    const { knex, calls } = fakeKnex(true);
    await expect(migration.down(knex)).rejects.toThrow(/credits the owner set/);
    expect(calls).toEqual(['LOCK TABLE production_share_stop_overrides IN ACCESS EXCLUSIVE MODE', 'read production_share_stop_overrides']);
  });

  test('with nothing stored it drops the table after the lock', async () => {
    const { knex, calls } = fakeKnex(false);
    await migration.down(knex);
    expect(calls).toEqual(['LOCK TABLE production_share_stop_overrides IN ACCESS EXCLUSIVE MODE', 'read production_share_stop_overrides', 'DROP TABLE IF EXISTS production_share_stop_overrides']);
  });
});

describe('the credit bases are in both finalize comparisons', () => {
  const split = (a, b) => [{ basisType: 'job', basisId: 'root', totalCents: a, sold: 2, slot: 1 }, { basisType: 'job', basisId: 'root-2', totalCents: b, sold: 2, slot: 1 }];
  const withInvoices = (bases) => stops([['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 110000], ['v3', '2026-09-16', 100000], ['v4', '2026-09-17', 102000]])
    .map((stop, i) => (i === 1 ? { ...stop, bases } : stop));

  test('the revision changes when only a split changes (the credits stay the same)', () => {
    const rev = (invoices) => share.revisionOf(new Map([['tech-a', { settings: SETTINGS, stops: withInvoices(invoices) }]]));
    expect(rev(split(100000, 100000))).toBe(rev(split(100000, 100000)));
    expect(rev([...split(100000, 100000)].reverse())).toBe(rev(split(100000, 100000)));
    expect(rev(split(150000, 50000))).not.toBe(rev(split(100000, 100000)));
    expect(rev([])).not.toBe(rev(split(100000, 100000)));
  });

  test('the review token changes when only a split changes', () => {
    const row = (invoices) => {
      const made = workedOut(withInvoices(invoices));
      return { technician_id: 'tech-1', hourly_rate: '20.00', regular_minutes: '2400.00', overtime_minutes: '0.00', pay_method: 'check',
        w4_election_id: null, ytd_gross_before_cents: 0, ...build({ production_share: made }).check };
    };
    const run = { week_start: WEEK, pay_date: PAY_DATE };
    expect(tokenOf(run, [row(split(100000, 100000))])).toBe(tokenOf(run, [row(split(100000, 100000))]));
    expect(tokenOf(run, [row(split(150000, 50000))])).not.toBe(tokenOf(run, [row(split(100000, 100000))]));
  });
});

describe('the review token', () => {
  const row = (made, extra = {}) => ({
    technician_id: 'tech-1', hourly_rate: '20.00', regular_minutes: '2400.00', overtime_minutes: '0.00', pay_method: 'check',
    w4_election_id: null, ytd_gross_before_cents: 0, ...build({ production_share: made }).check, ...extra,
  });
  const run = { week_start: WEEK, pay_date: PAY_DATE };

  test('the same credit gives the same token, from a row about to be stored or one read back', () => {
    const made = workedOut();
    const built = row(made);
    // a stored row carries the snapshot as production_share (calc_snapshot->'productionShare'), as jsonb returns it
    const { calc_snapshot: text, ...rest } = built;
    const stored = { ...rest, production_share: JSON.parse(text).productionShare };
    expect(tokenOf(run, [stored])).toBe(tokenOf(run, [built]));
  });

  test('a changed credit makes the token change, even when the share cents stay the same', () => {
    const base = row(workedOut());
    // one stop moves $10 to another stop: credited and share are the same, the rows are not
    const moved = row(workedOut(stops([
      ['v1', '2026-09-14', 101000], ['v2', '2026-09-15', 109000], ['v3', '2026-09-16', 100000], ['v4', '2026-09-17', 102000],
    ])));
    expect(moved.production_share_cents).toBe(base.production_share_cents);
    expect(tokenOf(run, [moved])).not.toBe(tokenOf(run, [base]));
  });

  test('a stop that starts to need review, or a changed share, changes the token', () => {
    const base = row(workedOut());
    const review = row(workedOut(stops([
      ['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 110000], ['v3', '2026-09-16', 100000], ['v4', '2026-09-17', 0, true],
    ])));
    expect(tokenOf(run, [review])).not.toBe(tokenOf(run, [base]));
    expect(tokenOf(run, [row(workedOut(), { production_share_cents: 7801 })])).not.toBe(tokenOf(run, [base]));
  });

  test('a check with no share keeps the token it always had', () => {
    const plain = { ...row(workedOut()) };
    delete plain.production_share_cents;
    const other = { ...plain };
    expect(tokenOf(run, [plain])).toBe(tokenOf(run, [other]));
  });
});

describe('what the check shows', () => {
  const made = workedOut(stops([
    ['v1', '2026-09-14', 100000], ['v2', '2026-09-15', 0, true], ['v3', '2026-09-16', 0, true], ['v4', '2026-09-17', 90000],
  ]));
  const stored = () => {
    const { check } = build({ production_share: made });
    const { calc_snapshot: text, ...rest } = check;
    return { ...rest, id: 'c1', status: 'draft', production_share: JSON.parse(text).productionShare };
  };

  test('viewOf gives the figures and the stops to review, with no stop rows and no customer data', () => {
    const view = share.viewOf(stored());
    expect(view.productionShareCents).toBe(made.shareCents);
    expect(view.productionShare).toMatchObject({ creditedCents: 190000, shifts: 4, stopCount: 4, needsReviewCount: 2, rateBps: 1500, barType: 'per_shift' });
    expect(view.productionShare.needsReview).toEqual([{ visitId: 'v2', workDate: '2026-09-15' }, { visitId: 'v3', workDate: '2026-09-16' }]);
    expect(view.productionShare).not.toHaveProperty('stops');
    expect(share.viewOf({})).toEqual({});
    expect(share.viewOf({ production_share_cents: null })).toEqual({});
  });

  test('the draft note says how many stops need review, in plain words', () => {
    expect(share.reviewNote('Sample Alpha', 2)).toMatch(/^Sample Alpha: 2 stops need review for the production share\. They pay \$0/);
    expect(share.reviewNote('Sample Alpha', 1)).toMatch(/1 stop needs review/);
    expect(share.reviewNote('Sample Alpha', 0)).toBeNull();
  });

  test('the run CSV adds a Production Share column only when a check paid one, and the gross includes it', () => {
    const paid = workedOut();
    const { check } = build({ production_share: paid });
    const { calc_snapshot: text, ...rest } = check;
    const row = { ...rest, id: 'c1', employee_name: 'Sample Alpha', production_share: JSON.parse(text).productionShare };
    const csv = checksToCsv([row]).split('\n');
    expect(csv[0]).toMatch(/Production Share$/);
    const cells = csv[1].split(',');
    expect(cells[cells.length - 1]).toBe('78.00');
    expect(cells[4]).toBe('878.00');
    const zero = { ...row, production_share_cents: 0 };
    expect(checksToCsv([zero]).split('\n')[0]).not.toMatch(/Production Share/);
  });
});

describe('Tech Rewards pay dating', () => {
  const check = (patch = {}) => ({
    weekStart: WEEK, grossCents: 87800, regularPayCents: 80000, overtimePayCents: 0, overtimeMinutes: 0, ptoPayCents: 0, holidayPayCents: 0,
    techRewardsCents: 0, lines: [], lineOvertimeWeeks: [], productionShareCents: 7800,
    productionShareDays: ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'], dayMinutes: [], ...patch,
  });
  const sum = (components) => components.reduce((total, c) => total + c.cents, 0);

  test('the components of a check with a share still add up to its gross', () => {
    expect(sum(checkComponents(check()))).toBe(87800);
  });

  test('the share is earned evenly over the shift days of its week', () => {
    // 7800 over 4 shift days = 1950 each; the window Mon 09-14 to Tue 09-15 counts two of them
    expect(earnedGrossCents([check()], '2026-09-14', '2026-09-15') - earnedGrossCents([check({ productionShareCents: 0, grossCents: 80000 })], '2026-09-14', '2026-09-15')).toBe(3900);
    // a window that holds only the days after the shifts counts none of it
    expect(earnedGrossCents([check()], '2026-09-18', '2026-09-20') - earnedGrossCents([check({ productionShareCents: 0, grossCents: 80000 })], '2026-09-18', '2026-09-20')).toBe(0);
  });

  test('a check with no stop days (an older snapshot) falls back to its week, in-window days / 7', () => {
    const older = check({ productionShareDays: [] });
    const on = earnedGrossCents([older], '2026-09-14', '2026-09-20') - earnedGrossCents([check({ productionShareCents: 0, productionShareDays: [], grossCents: 80000 })], '2026-09-14', '2026-09-20');
    expect(on).toBe(7800);
  });

  test('a check with no share keeps its components', () => {
    const plain = check({ productionShareCents: 0, productionShareDays: undefined, grossCents: 80000 });
    expect(sum(checkComponents(plain))).toBe(80000);
  });
});
