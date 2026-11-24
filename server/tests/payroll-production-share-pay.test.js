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
    expect(check).not.toHaveProperty('qualified_overtime_cents');
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

describe('the credit ledger (applyLedger)', () => {
  const productionShare = require('../services/production-share');
  const invoice = (invoiceId, totalCents, members, shareCents) => ({ invoiceId, totalCents, members: members.map(([id, weight]) => ({ id, weight })), shareCents });
  const plain = (visitId, invoices) => ({
    visitId, workDate: '2026-09-21', kind: 'priced', creditCents: invoices.reduce((sum, inv) => sum + inv.shareCents, 0), needsReview: false, ledger: { invoices },
  });
  const job = (visitId, nth, { price = 200000, sold = 2, rootId = 'root' } = {}) => ({
    visitId, workDate: '2026-09-21', kind: 'multi_visit_job', creditCents: productionShare.jobPartCents(price, sold, nth), needsReview: false,
    ledger: { job: { rootId, price, sold, nth } },
  });
  // what finalized pay runs paid: byBasis = { 'invoice:inv-1': [cents, ['visit-1']] }, visits = { visitId: week }
  const paidOf = (byBasis = {}, visits = {}) => ({
    visits: new Map(Object.entries(visits)),
    byBasis: new Map(Object.entries(byBasis).map(([key, [cents, who]]) => [key, { cents, visits: new Set(who) }])),
  });
  const MEMBERS = [['visit-1', 100000], ['visit-2', 100000]];
  const one = (rows, paid = paidOf()) => productionShare.applyLedger(rows, paid)[0];

  test('nothing paid from a basis: exactly the live credit, with what it drew from each basis, and no ledger left on the row', () => {
    const out = one([plain('visit-2', [invoice('inv-1', 200000, MEMBERS, 100000)])]);
    expect(out).toMatchObject({ kind: 'priced', creditCents: 100000, needsReview: false, bases: [{ basisType: 'invoice', basisId: 'inv-1', cents: 100000 }] });
    expect(out).not.toHaveProperty('ledger');
    const rootJob = one([job('root', 1)]);
    expect(rootJob).toMatchObject({ creditCents: 100000, bases: [{ basisType: 'job', basisId: 'root', cents: 100000 }] });
  });

  test('an invoice credits REMAINING (live total less what was paid), whatever its split is now', () => {
    const paid = paidOf({ 'invoice:inv-1': [100000, ['visit-1']] });
    // the split moved to $1,500 / $500 after visit-1 was paid $1,000: visit-2 is the last open member and takes the $1,000 remaining
    for (const live of [150000, 50000]) {
      expect(one([plain('visit-2', [invoice('inv-1', 200000, MEMBERS, live)])], paid)).toMatchObject({ creditCents: 100000, bases: [{ cents: 100000 }] });
    }
    // reprice the whole invoice to $1,200 after $1,000 was paid: $200 remain
    expect(one([plain('visit-2', [invoice('inv-1', 120000, MEMBERS, 60000)])], paid).creditCents).toBe(20000);
  });

  test('REMAINING is shared by the live weights of the member visits not paid yet, never more than REMAINING', () => {
    const members = [['visit-1', 100000], ['visit-2', 300000], ['visit-3', 100000]];
    const paid = paidOf({ 'invoice:inv-1': [100000, ['visit-1']] });
    const rows = productionShare.applyLedger([plain('visit-2', [invoice('inv-1', 300000, members, 180000)])], paid);
    // $2,000.00 remain over visit-2 (3 parts) and visit-3 (1 part): visit-2 gets $1,500.00 now and visit-3 keeps its part for later
    expect(rows[0].creditCents).toBe(150000);
  });

  test('an invoice credited in full: a visit that joins it later, or a second visit of it, is $0 and needs review', () => {
    const paid = paidOf({ 'invoice:inv-1': [200000, ['visit-1']] });
    const out = one([plain('visit-2', [invoice('inv-1', 200000, MEMBERS, 100000)])], paid);
    expect(out).toMatchObject({ kind: 'basis_exhausted', creditCents: 0, needsReview: true, bases: [] });
    expect(out.reason).toContain('already credited in full');
    // credited above the live total (the invoice was reduced after): nothing remains either
    expect(one([plain('visit-2', [invoice('inv-1', 150000, MEMBERS, 75000)])], paid).kind).toBe('basis_exhausted');
  });

  test('PER INVOICE: what is left of a shared invoice plus the visit\'s own separate invoice', () => {
    const paid = paidOf({ 'invoice:inv-1': [10000, ['visit-1']] });
    const out = one([plain('visit-2', [invoice('inv-1', 20000, [['visit-1', 15000], ['visit-2', 5000]], 5000), invoice('inv-own', 5000, [['visit-2', 5000]], 5000)])], paid);
    expect(out.creditCents).toBe(15000); // $100.00 remaining of the shared invoice + $50.00 of its own
    expect(out.bases).toEqual([{ basisType: 'invoice', basisId: 'inv-1', cents: 10000 }, { basisType: 'invoice', basisId: 'inv-own', cents: 5000 }]);
  });

  test('a visit already credited on a finalized check is already_paid, before anything else', () => {
    const out = one([plain('visit-2', [invoice('inv-1', 200000, MEMBERS, 100000)])], paidOf({}, { 'visit-2': '2026-09-14' }));
    expect(out).toMatchObject({ kind: 'already_paid', creditCents: 0, needsReview: true, bases: [] });
  });

  test('a package: its follow-up credits the job price less what was paid (reprice $2,000 -> $1,200 after $1,000 was paid: $200)', () => {
    const paid = paidOf({ 'job:root': [100000, ['root']] });
    expect(one([job('followup', 2, { price: 120000 })], paid)).toMatchObject({ kind: 'multi_visit_job', creditCents: 20000, bases: [{ basisType: 'job', basisId: 'root', cents: 20000 }] });
    expect(one([job('followup', 2, { price: 200000 })], paid).creditCents).toBe(100000);
    // the price went UP after: it takes the rest, never a fixed half
    expect(one([job('followup', 2, { price: 300000 })], paid).creditCents).toBe(200000);
  });

  test('THREE CREDITS: a two-visit package paid for both visits earns a replacement nothing', () => {
    const paid = paidOf({ 'job:root': [200000, ['root', 'followup']] });
    const out = one([job('replacement', 2)], paid);
    expect(out).toMatchObject({ kind: 'basis_exhausted', creditCents: 0, needsReview: true });
    expect(out.reason).toContain('package');
  });

  test('more visits than sold slots left: the first ones credit, the rest are $0 and need review', () => {
    const paid = paidOf({ 'job:root': [100000, ['root']] });
    const rows = productionShare.applyLedger([job('a', 2), job('b', 3)], paid);
    expect(rows.map((row) => [row.kind, row.creditCents])).toEqual([['multi_visit_job', 100000], ['basis_exhausted', 0]]);
  });

  test('AUDIT :708: a live share that rounds to $0 still takes what is left of the invoice (classified priced after)', () => {
    const paid = paidOf({ 'invoice:inv-1': [99999, ['visit-1']] });
    // visit-2 weighs one cent against $1,000.00: its live share is $0 ('free_visit'), but the invoice was raised to $2,000.00 since
    const members = [['visit-1', 10000000], ['visit-2', 1]];
    const row = { visitId: 'visit-2', workDate: '2026-09-21', kind: 'free_visit', creditCents: 0, needsReview: false, ledger: { invoices: [invoice('inv-1', 200000, members, 0)] } };
    const out = one([row], paid);
    expect(out).toMatchObject({ kind: 'priced', creditCents: 100001, needsReview: false, bases: [{ basisType: 'invoice', basisId: 'inv-1', cents: 100001 }] });
    // nothing paid from the invoice: the $0 share stays $0 and stays what it was
    expect(one([row])).toMatchObject({ kind: 'free_visit', creditCents: 0, bases: [] });
  });

  test('a row that is already $0 and needs review, and a credit no invoice or job priced, are left alone', () => {
    for (const kind of ['prepaid_plan', 'callback_other', 'free_visit', 'not_performed', 'unverified', 'multi_visit_job']) {
      const row = { visitId: 'visit-2', workDate: '2026-09-21', kind, creditCents: kind === 'prepaid_plan' ? 40000 : 0, needsReview: kind === 'unverified' || kind === 'multi_visit_job', ledger: null };
      const out = one([row], paidOf({ 'invoice:inv-1': [200000, ['visit-1']], 'job:root': [200000, ['root']] }));
      expect(out).toMatchObject({ kind, creditCents: row.creditCents, needsReview: row.needsReview });
    }
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

describe('the credit bases are in both finalize comparisons', () => {
  const split = (a, b) => [{ basisType: 'invoice', basisId: 'inv-1', cents: a }, { basisType: 'invoice', basisId: 'inv-2', cents: b }];
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
