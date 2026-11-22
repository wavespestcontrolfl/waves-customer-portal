// Real PostgreSQL transactions (rolled back): Tech Rewards Plan D5-5, the December gift as a pay line on pay runs, behind
// GATE_TECH_REWARDS_PAY_LINES (which needs GATE_PAYROLL_PAY_LINES), and the stay bonus behind GATE_TECH_REWARDS_STAY_BONUS (the
// last describe block). The line is derived data, written and worked out again when a
// run is drafted, recomputed and finalized: one open line per technician in the first run dated on or after the gift date that is
// ready, owned by that draft run, paid with its check, and deleted when the run is voided or finalizes without paying it. A gift
// that is not ready waits and never holds the run. All names and amounts are synthetic. DATABASE_URL-gated like the other
// *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = req.headers['x-test-admin'] || null;
    req.techRole = req.headers['x-test-role'] || 'admin';
    next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-payroll');
const { syncTechRewardLines, stayBonusStatus } = require('../services/tech-rewards-pay-lines');
const { techRewardsOwnKey, techRewardsOwnedSql } = require('../services/payroll-pay-lines');
const { readGross, readStayPay } = require('../services/tech-rewards-scoreboard');
const { workedWeeks } = require('../services/payroll-runs');
const { staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

jest.setTimeout(60000);

// Staff weeks (Mondays). A pay run is chosen by the date on its checks; the default pay date is the Friday after the week ends.
const EARLY_WEEK = '2026-11-30'; // pay date Fri Dec 11, before the gift date
const GIFT_WEEK = '2026-12-07'; // pay date Fri Dec 18, the last Friday on or before Dec 20
const NEXT_WEEK = '2026-12-14'; // pay date Fri Dec 25
const NOW = Date.parse('2027-01-05T17:00:00Z'); // every week above has ended

const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_PAY_LINES', 'GATE_TECH_REWARDS_PAY_LINES', 'GATE_TECH_REWARDS_STAY_BONUS', 'GATE_PAYROLL_FORM_FIGURES',
  'GATE_PAYROLL_TIME_OFF', 'GATE_SHIFT_CLOSE_REVIEW', 'GATE_PAYROLL_COMMISSION_LEDGER', 'GATE_PAYROLL_REVIEW_BONUS_IMPORT'];
const GIFT = 30000;

postgres('tech rewards pay lines: the December gift', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const ADMIN_ID = randomUUID();

  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const readyTech = async (name, patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', field_dispatchable: true, pay_rate: '22.00', hire_date: '2024-01-10', ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const approvedWeek = (technicianId, weekStart, regular = '2400.00', overtime = '0.00') => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: regular, overtime_minutes: overtime,
  });
  // A finalized check for one earlier week, in a finalized run of that week: the week is paid.
  const paidWeek = async (technicianId, weekStart, stored = {}) => {
    let id = (await trx('payroll_runs').where({ week_start: weekStart, status: 'finalized' }).first('id'))?.id;
    if (!id) {
      [id] = (await trx('payroll_runs').insert({ week_start: weekStart, pay_date: addDays(weekStart, 11), status: 'finalized' }).returning('id')).map((r) => r.id);
    }
    await trx('payroll_checks').insert({
      run_id: id, technician_id: technicianId, employee_name: 'Sample History', week_start: weekStart, pay_date: addDays(weekStart, 11),
      hourly_rate: 22, regular_minutes: 2400, overtime_minutes: 0, gross_cents: 88000, regular_pay_cents: 88000, overtime_pay_cents: 0,
      overtime_premium_cents: 0, federal_income_tax_cents: 0, social_security_cents: 0, medicare_cents: 0, additional_medicare_cents: 0,
      net_cents: 0, employer_social_security_cents: 0, employer_medicare_cents: 0, futa_cents: 0, fl_reemployment_cents: 0,
      ytd_gross_before_cents: 0, calc_snapshot: '{}', pay_method: 'check', status: 'finalized', ...stored,
    });
    return id;
  };
  // A finalized check of the run of `runWeek` that already paid a commission line earned in `lineWeek` (45 h worked, 5 of them
  // overtime), with the premium the check stored for that week: its column and its week row. `premiumCents` is whatever that
  // check paid, by whatever rule it was priced. A finalized check cannot be edited, so it is written whole (`stored`: any
  // other column of it). { runId, lineId }
  const paidLine = async (technicianId, runWeek, cents, lineWeek, premiumCents, stored = {}) => {
    const runId = await paidWeek(technicianId, runWeek, {
      line_overtime_premium_cents: premiumCents,
      calc_snapshot: JSON.stringify({ lineOvertimeWeeks: [{ weekStart: lineWeek, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: cents, premiumCents }] }),
      ...stored,
    });
    const check = await trx('payroll_checks').where({ run_id: runId, technician_id: technicianId }).first('id');
    const [line] = await trx('payroll_pay_lines').insert({
      technician_id: technicianId, kind: 'commission', amount_cents: cents, earned_week_start: lineWeek, status: 'paid', check_id: check.id,
    }).returning('id');
    return { runId, lineId: line.id || line };
  };
  const api = async (method, path, { body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const draft = async (weekStart, payDate) => {
    const created = await api('POST', '/runs', { body: { weekStart, ...(payDate ? { payDate } : {}) } });
    expect([created.status, created.body.error]).toEqual([201, undefined]);
    return created.body.run;
  };
  const recompute = async (runId) => {
    const done = await api('POST', `/runs/${runId}/recompute`);
    expect([done.status, done.body.error]).toEqual([200, undefined]);
    return done.body.run;
  };
  const finalize = async (runId) => {
    const shown = await api('GET', `/runs/${runId}`);
    const done = await api('POST', `/runs/${runId}/finalize`, { body: { token: shown.body.run.token } });
    expect([done.status, done.body.error]).toEqual([200, undefined]);
    return done.body.run;
  };
  const voidRun = async (runId) => {
    const done = await api('POST', `/runs/${runId}/void`, { body: { reason: 'Sample correction' } });
    expect([done.status, done.body.error]).toEqual([200, undefined]);
    return done.body.run;
  };
  const linesOf = (technicianId) => trx('payroll_pay_lines').where({ technician_id: technicianId, source_type: 'tech_rewards' }).orderBy('source_id');
  const lineOf = async (technicianId) => (await linesOf(technicianId))[0];
  const dateOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
  const checkOf = (run, technicianId) => run.checks.find((c) => c.technicianId === technicianId);
  const notesOf = async (runId) => (await api('GET', `/runs/${runId}`)).body.run.techRewardsNotes || [];
  // the note for a gift of 2026 that waits: the reason, then the last pay date that can carry it (Dec 18 + 60 days)
  const waits = (name, why) => `December gift for ${name} waits: ${why}. Only a pay run dated Feb 16, 2027 or earlier can add it`;
  // why a run for a week before the last week the gift covers does not carry it
  const tooEarly = (week) => `this pay run pays an earlier week than the week of ${week}, the last week the gift covers`;
  // the same gift on a FINALIZED run: no reason (the run is never worked out again, so a reason would go out of date)
  const missed = (name) => `December gift for ${name} was not on this pay run. Only a pay run dated Feb 16, 2027 or earlier can add it`;
  // Every event of one test has the same created_at (one outer transaction), so a test picks its event by run and by key.
  const syncEvents = () => trx('audit_log').where({ action: 'payroll.tech_rewards_lines_synced' });
  const syncEventOf = async (runId, key) => (await syncEvents()).map((e) => e.metadata).filter((m) => m.run_id === runId && key in m);
  const runRow = async (runId) => {
    const row = await trx('payroll_runs').where({ id: runId }).first();
    return { id: row.id, week_start: dateOf(row.week_start), pay_date: dateOf(row.pay_date) };
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_PAY_LINES = 'true';
    process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
    delete process.env.GATE_TECH_REWARDS_STAY_BONUS;
    delete process.env.GATE_PAYROLL_FORM_FIGURES;
    delete process.env.GATE_PAYROLL_TIME_OFF;
    delete process.env.GATE_SHIFT_CLOSE_REVIEW;
    delete process.env.GATE_PAYROLL_COMMISSION_LEDGER;
    delete process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT;
    // Only the clock is faked (the pay run asks the ET date whether a week has ended); timers and I/O stay real.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    jest.useRealTimers();
    await trx.rollback();
    for (const name of GATES) {
      if (OLD[name] === undefined) delete process.env[name]; else process.env[name] = OLD[name];
    }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('the gift', () => {
    it('is $300 for each active technician in the run that holds the last Friday on or before Dec 20, covering Jan 1 to the end of that pay week', async () => {
      const alpha = await readyTech('Sample Alpha');
      const beta = await readyTech('Sample Beta', { hire_date: '2026-12-01' });
      const gone = await readyTech('Sample Gone', { employment_status: 'inactive' });
      const late = await readyTech('Sample Late', { hire_date: '2026-12-19' }); // hired after the Friday
      const office = await readyTech('Sample Office', { field_dispatchable: false }); // an office account is not a technician
      const manager = await readyTech('Sample Manager', { role: 'admin' }); // an admin account gets none, even one that takes field work
      const run = await draft(GIFT_WEEK);
      const line = await lineOf(alpha);
      expect(line).toMatchObject({ kind: 'december_gift', status: 'open', amount_cents: GIFT, source_id: `december_gift:${alpha}:2026` });
      expect([dateOf(line.earned_week_start), dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual([GIFT_WEEK, '2026-01-01', '2026-12-13']);
      expect(run.payDate).toBe('2026-12-18'); // the last Friday on or before Dec 20
      // hired during the year: the same $300, covering the weeks since the hire date
      const betaLine = await lineOf(beta);
      expect([betaLine.amount_cents, dateOf(betaLine.covers_from), dateOf(betaLine.covers_to)]).toEqual([GIFT, '2026-12-01', '2026-12-13']);
      expect(await linesOf(gone)).toHaveLength(0);
      expect(await linesOf(late)).toHaveLength(0);
      expect(await linesOf(office)).toHaveLength(0);
      expect(await linesOf(manager)).toHaveLength(0);
      expect(checkOf(run, manager)).toBeUndefined();
      // a technician with no hours that week gets a check for the gift alone; it is taxable pay
      expect(checkOf(run, alpha)).toMatchObject({ techRewardsCents: GIFT, grossCents: GIFT, medicareCents: Math.round(GIFT * 0.0145) });
      expect((await syncEvents()).flatMap((e) => e.metadata.skipped || []))
        .toContainEqual({ technician_id: late, kind: 'december_gift', reason: 'hired_after_gift_date' });
    });

    it('is not on a run dated before the gift date; the first run dated after it writes it; none writes it more than 60 days later', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, EARLY_WEEK);
      const early = await draft(EARLY_WEEK); // dated Dec 11
      expect(await linesOf(tech)).toHaveLength(0);
      await finalize(early.id);
      await approvedWeek(tech, NEXT_WEEK);
      const later = await draft(NEXT_WEEK); // dated Dec 25: no run was dated Dec 18
      expect(later.payDate).toBe('2026-12-25');
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(NEXT_WEEK);
      expect(checkOf(later, tech).techRewardsCents).toBe(GIFT);
      await voidRun(later.id);
      const tooLate = await draft(NEXT_WEEK, '2027-02-19'); // 63 days after Dec 18
      expect(tooLate.payDate).toBe('2027-02-19');
      expect(await linesOf(tech)).toHaveLength(0);
    });

    it('is not written twice: a second sync, a recompute and a finalize keep one line, and finalizing pays it with its check', async () => {
      const tech = await readyTech('Sample Alpha');
      const run = await draft(GIFT_WEEK);
      const id = (await lineOf(tech)).id;
      expect(await syncTechRewardLines(await runRow(run.id), trx)).toMatchObject({ added: 0, updated: 0, removed: 0 });
      await recompute(run.id);
      expect(await linesOf(tech)).toHaveLength(1);
      const final = await finalize(run.id);
      const paid = await lineOf(tech);
      expect(paid).toMatchObject({ id, status: 'paid', amount_cents: GIFT, check_id: checkOf(final, tech).id });
      expect((await trx('payroll_checks').where({ id: paid.check_id }).first()).tech_rewards_cents).toBe(String(GIFT));
      // The audit trail has one event for each of the four syncs, also the three that changed nothing (the direct sync, the
      // recompute and the finalize that checked the line again): a sync that ran is told from one that did not.
      const nothing = { updated_line_ids: [], removed_line_ids: [], skipped: [], waits: [] };
      const events = (await syncEventOf(run.id, 'unchanged_count')).map(({ run_id: _run, week_start: _week, ...rest }) => rest);
      expect(events).toHaveLength(4);
      expect(events.filter((e) => e.added_line_ids.length)).toEqual([{ added_line_ids: [id], unchanged_count: 0, ...nothing }]);
      expect(events.filter((e) => !e.added_line_ids.length)).toEqual(Array(3).fill({ added_line_ids: [], unchanged_count: 1, ...nothing }));
      // a paid line is evidence: a later run, and a direct sync, never write the gift again
      await approvedWeek(tech, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      expect(checkOf(next, tech)).not.toHaveProperty('techRewardsCents');
      expect(await linesOf(tech)).toHaveLength(1);
      // every gift of that run is paid: it examines nothing and writes no event
      expect(await syncEventOf(next.id, 'unchanged_count')).toEqual([]);
    });

    it('with the gate off writes no line; turning it off takes the open line off the next run and leaves a paid one', async () => {
      const tech = await readyTech('Sample Alpha');
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(tech)).toHaveLength(0);
      expect(checkOf(run, tech)).not.toHaveProperty('techRewardsCents');
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      await recompute(run.id);
      expect(await linesOf(tech)).toHaveLength(1);
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      const off = await recompute(run.id);
      expect(await linesOf(tech)).toHaveLength(0);
      expect(checkOf(off, tech).grossCents).toBe(checkOf(run, tech).grossCents);
      // paid lines stay when the gate goes off
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      await recompute(run.id);
      await finalize(run.id);
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      await approvedWeek(tech, NEXT_WEEK);
      await draft(NEXT_WEEK);
      expect((await lineOf(tech)).status).toBe('paid');
    });

    it('with pay lines off does nothing at all', async () => {
      const tech = await readyTech('Sample Alpha');
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const result = await syncTechRewardLines({ id: randomUUID(), week_start: GIFT_WEEK, pay_date: '2026-12-18' }, trx);
      expect(result).toEqual({ added: 0, updated: 0, removed: 0, skipped: [], waits: [] });
      expect(await linesOf(tech)).toHaveLength(0);
    });

    it('a week a finalized check already paid line pay for: 33 then 34, the 67 of one check with both lines', async () => {
      const tech = await readyTech('Sample Alpha');
      const WEEK = '2026-11-09'; // 45 h worked, 5 of them overtime
      await approvedWeek(tech, WEEK, '2400.00', '300.00');
      // a 6.00 commission earned that week rides on the week's own check, the first to pay for the week: 33.33 -> 33
      await trx('payroll_pay_lines').insert({ technician_id: tech, kind: 'commission', amount_cents: 600, earned_week_start: WEEK });
      const own = await draft(WEEK);
      expect(checkOf(own, tech)).toMatchObject({ commissionCents: 600, lineOvertimePremiumCents: 33 });
      const ownStored = await trx('payroll_checks').where({ id: checkOf(own, tech).id }).first();
      expect(ownStored.calc_snapshot.lineOvertimeWeeks[0]).not.toHaveProperty('earlierPremiumCents');
      await finalize(own.id);
      // the gift's share of that week is also 6.00 (30,000 over 50 workweeks). Its own floor is 33.33 up = 34, and the week's
      // shortfall is 67 (66.67 on the 12.00) less the 33 paid = 34
      await approvedWeek(tech, GIFT_WEEK);
      const giftRun = await draft(GIFT_WEEK);
      const check = checkOf(giftRun, tech);
      expect(check).toMatchObject({ techRewardsCents: GIFT, lineOvertimePremiumCents: 34 });
      const stored = await trx('payroll_checks').where({ id: check.id }).first();
      // the row also holds what the check would have paid for the week without the gift: nothing, the gift is its only line
      expect(stored.calc_snapshot.lineOvertimeWeeks.find((w) => w.weekStart === WEEK)).toMatchObject({
        allocatedCents: 600, premiumCents: 34, earlierAllocatedCents: 600, earlierPremiumCents: 33, ordinaryPremiumCents: 0,
      });
      // a week nobody paid for carries no earlier figures
      const plain = stored.calc_snapshot.lineOvertimeWeeks.find((w) => w.weekStart === '2026-11-02');
      expect([plain.earlierAllocatedCents, plain.earlierPremiumCents]).toEqual([undefined, undefined]);
      // a recompute and the finalize give the same figure (this run's own lines are open, so they are no history)
      expect(checkOf(await recompute(giftRun.id), tech).lineOvertimePremiumCents).toBe(34);
      await finalize(giftRun.id);
      const final = await trx('payroll_checks').where({ run_id: giftRun.id, technician_id: tech, status: 'finalized' }).first();
      expect(Number(final.line_overtime_premium_cents)).toBe(34);
    });

    it('works in either order: a late line on a later run first (33), then the week\'s own run with a later pay date (34)', async () => {
      delete process.env.GATE_TECH_REWARDS_PAY_LINES; // commission lines only: the rule belongs to every pay line
      const tech = await readyTech('Sample Alpha');
      const WEEK = '2026-11-09'; // 45 h worked, 5 of them overtime
      const AFTER = '2026-11-16';
      await approvedWeek(tech, WEEK, '2400.00', '300.00');
      await approvedWeek(tech, AFTER);
      // the next week's run is finalized first and carries a 6.00 line earned in WEEK: the first to pay for it, 33.33 -> 33
      const [first] = await trx('payroll_pay_lines').insert({ technician_id: tech, kind: 'commission', amount_cents: 600, earned_week_start: WEEK }).returning('id');
      const later = await draft(AFTER);
      expect(checkOf(later, tech)).toMatchObject({ commissionCents: 600, lineOvertimePremiumCents: 33 });
      await finalize(later.id);
      expect((await trx('payroll_pay_lines').where({ id: first.id || first }).first()).status).toBe('paid');
      // then WEEK's own run, dated after that check, with another 6.00 line of the same week: 33.33 -> 34
      await trx('payroll_pay_lines').insert({ technician_id: tech, kind: 'commission', amount_cents: 600, earned_week_start: WEEK });
      const own = await draft(WEEK, '2026-12-04');
      expect(checkOf(own, tech)).toMatchObject({ commissionCents: 600, lineOvertimePremiumCents: 34 });
      await finalize(own.id);
      const paid = await trx('payroll_checks').where({ technician_id: tech, status: 'finalized' }).whereIn('run_id', [later.id, own.id]);
      expect(paid.map((c) => Number(c.line_overtime_premium_cents)).sort()).toEqual([33, 34]);
      // a voided run's lines are open again and are no history: both lines on one new check, the first to pay: 66.67 -> 67
      await voidRun(own.id);
      await voidRun(later.id);
      const again = await draft(WEEK, '2026-12-04');
      expect(checkOf(again, tech)).toMatchObject({ commissionCents: 1200, lineOvertimePremiumCents: 67 });
    });

    it('never leaves a later check short when the earlier check is voided, across tax years too: the later check paid what its line earns alone', async () => {
      delete process.env.GATE_TECH_REWARDS_PAY_LINES; // commission lines only
      const tech = await readyTech('Sample Alpha');
      const WEEK = '2025-12-15'; // 45 h worked, 5 of them overtime; paid in December 2025
      const NEW_YEAR_WEEK = '2026-01-05';
      await approvedWeek(tech, WEEK, '2400.00', '300.00');
      await approvedWeek(tech, NEW_YEAR_WEEK);
      // December: the week's own check paid a 6.03 line of that week and 34 of premium for it (33.5 half up)
      const { runId: decemberRun, lineId: decemberLine } = await paidLine(tech, WEEK, 603, WEEK, 34);
      // January: another 6.03 line of that week rides on a 2026 run. Both lines earn 67 and 34 is paid, a shortfall of 33;
      // the check pays its own floor, 33.5 up = 34
      await trx('payroll_pay_lines').insert({ technician_id: tech, kind: 'commission', amount_cents: 603, earned_week_start: WEEK });
      const january = await draft(NEW_YEAR_WEEK);
      expect(checkOf(january, tech)).toMatchObject({ commissionCents: 603, lineOvertimePremiumCents: 34 });
      await finalize(january.id);
      // the December run is voided (no later check of its own tax year is final) and its reopened line is taken out
      await voidRun(decemberRun);
      expect((await trx('payroll_pay_lines').where({ id: decemberLine }).first()).status).toBe('open');
      await trx('payroll_pay_lines').where({ id: decemberLine }).del();
      // the January check is final and whole: 34 is what its 6.03 line earns alone (1/2 x 603 / 45 h x 5 h = 33.5 -> 34)
      const kept = await trx('payroll_checks').where({ run_id: january.id, technician_id: tech, status: 'finalized' }).first();
      expect(Number(kept.line_overtime_premium_cents)).toBe(34);
    });

    it('keeps a commission\'s overtime in a bonus base as the pay run priced it, when a check with a LATER pay date was finalized first', async () => {
      const tech = await readyTech('Sample Alpha');
      const WEEK = '2026-11-09'; // 45 h worked, 5 of them overtime
      await approvedWeek(tech, WEEK, '2400.00', '300.00');
      await paidWeek(tech, WEEK); // the week's own check: 880.00 of wages and no line
      // The week of Nov 16 was paid late: its check is dated Jan 4, 2027, and it was final BEFORE the gift's run. It paid a 6.00
      // commission earned in WEEK, the first check to pay line pay for that week: 33.33 -> 33.
      await trx('payroll_runs').insert({ week_start: '2026-11-16', pay_date: '2027-01-04', status: 'finalized' });
      await paidLine(tech, '2026-11-16', 600, WEEK, 33, { pay_date: '2027-01-04', gross_cents: 88000 + 600 + 33 });
      // The gift's run is dated Dec 18, 2026, EARLIER than that check, and is finalized after it. It carries another 6.00
      // commission of WEEK beside the gift, whose share of WEEK is 6.00 too.
      await trx('payroll_pay_lines').insert({ technician_id: tech, kind: 'commission', amount_cents: 600, earned_week_start: WEEK });
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(run.payDate).toBe('2026-12-18');
      // the two lines pay 67 for WEEK: their floor, 66.67 up (the shortfall, 100 on the 18.00 less the 33 paid, is 67 too)
      expect(checkOf(run, tech)).toMatchObject({ commissionCents: 600, techRewardsCents: GIFT, lineOvertimePremiumCents: 67 });
      await finalize(run.id);
      const stored = await trx('payroll_checks').where({ run_id: run.id, technician_id: tech, status: 'finalized' }).first();
      // the check keeps what its commission alone would have paid as the later check it was: its floor, 33.33 up = 34
      expect(stored.calc_snapshot.lineOvertimeWeeks.find((w) => w.weekStart === WEEK)).toMatchObject({
        premiumCents: 67, ordinaryPremiumCents: 34, earlierAllocatedCents: 600, earlierPremiumCents: 33,
      });
      // The pay earned in WEEK: its own 880.00, both commissions, and their overtime as it was PAID: 33, then 34. Put in pay
      // date order the Dec 18 check looks like the first to pay for the week, where its commission would have earned 33.
      expect(await readGross(trx, tech, WEEK, '2026-11-15')).toBe(88000 + 600 + 33 + 600 + 34);
      // the stay bonus's reader takes the same figures: three weeks of wages, the commissions, 33 and 34; no gift, none of its 33
      expect((await readStayPay(trx, tech, WEEK, '2026-12-13')).cents).toBe(3 * 88000 + 600 + 33 + 600 + 34);
    });

    it('makes a week whole that two older checks left 1 cent short: 33 + 33, then the gift\'s check pays 68 (134 on the three lines)', async () => {
      // hired the week of Jun 22: the gift covers 25 workweeks, 12.00 a week
      const tech = await readyTech('Sample Alpha', { hire_date: '2026-06-22' });
      const WEEK = '2026-11-09'; // 45 h worked, 5 of them overtime
      await approvedWeek(tech, WEEK, '2400.00', '300.00');
      // two checks priced the older way: each paid a 6.02 line of WEEK and rounded half up on its own (33.44 -> 33). Together
      // the two lines earn 66.89 -> 67, so the week is 1 cent short before the gift.
      await paidLine(tech, WEEK, 602, WEEK, 33);
      await paidLine(tech, '2026-11-16', 602, WEEK, 33);
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      const check = checkOf(run, tech);
      // the three lines earn 1/2 x 24.04 / 45 h x 5 h = 133.56 -> 134, and 66 is paid: 68 (the gift's own floor is 67)
      expect(check).toMatchObject({ techRewardsCents: GIFT, lineOvertimePremiumCents: 68 });
      const stored = await trx('payroll_checks').where({ id: check.id }).first();
      expect(stored.calc_snapshot.lineOvertimeWeeks.find((w) => w.weekStart === WEEK)).toMatchObject({
        allocatedCents: 1200, premiumCents: 68, earlierAllocatedCents: 1204, earlierPremiumCents: 66,
      });
      await finalize(run.id);
      const paid = await trx('payroll_checks').where({ technician_id: tech, status: 'finalized' });
      expect(paid.reduce((total, c) => total + Number(c.line_overtime_premium_cents), 0)).toBe(134);
    });

    it('adds the half-time premium of the overtime weeks it covers', async () => {
      const tech = await readyTech('Sample Alpha');
      // one paid week of the year with 50 h worked, 10 h of them overtime; every other covered week had no hours
      await approvedWeek(tech, '2026-06-01', '2400.00', '600.00');
      await paidWeek(tech, '2026-06-01');
      const run = await draft(GIFT_WEEK);
      const check = checkOf(run, tech);
      // 30,000 over the 50 workweeks Dec 29 2025 .. Dec 7 2026 = 600 a week; 1/2 x 600 / 50 h x 10 h = 60
      expect(check).toMatchObject({ techRewardsCents: GIFT, lineOvertimePremiumCents: 60, grossCents: GIFT + 60 });
      const stored = await trx('payroll_checks').where({ id: check.id }).first();
      expect(stored.calc_snapshot.lineOvertimeWeeks.find((w) => w.weekStart === '2026-06-01').premiumCents).toBe(60);
    });

    it('covers a technician hired during the year from the hire date, so weeks before they started take no share of the gift', async () => {
      // hired Mon Dec 7; 50 h that week, 10 h of them overtime
      const tech = await readyTech('Sample Alpha', { hire_date: GIFT_WEEK });
      await approvedWeek(tech, GIFT_WEEK, '2400.00', '600.00');
      const run = await draft(GIFT_WEEK);
      const line = await lineOf(tech);
      expect([dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual([GIFT_WEEK, '2026-12-13']);
      // the whole 30,000 is in their one week: 1/2 x 30,000 / 50 h x 10 h = 3,000 (a span from Jan 1 would give it 1/50: 60)
      expect(checkOf(run, tech)).toMatchObject({ techRewardsCents: GIFT, lineOvertimePremiumCents: 3000 });
    });

    it('waits on a run whose pay week ended before the technician was hired; the next week\'s run writes it from the hire date', async () => {
      const tech = await readyTech('Sample Alpha', { hire_date: '2026-12-15' }); // after the week of Dec 7, and by the gift date
      const other = await readyTech('Sample Bravo');
      await approvedWeek(other, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(tech)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', tooEarly('Dec 14, 2026'))]);
      await finalize(run.id);
      await approvedWeek(tech, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      const line = await lineOf(tech);
      expect([dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual(['2026-12-15', '2026-12-20']);
      expect(checkOf(next, tech).techRewardsCents).toBe(GIFT);
    });

    it('writes no gift for 2025: a run for an old week, dated in the 60 days after the 2025 gift date, examines none', async () => {
      const tech = await readyTech('Sample Alpha'); // hired 2024, so a 2025 gift would have had a recipient
      await approvedWeek(tech, '2025-12-29');
      const run = await draft('2025-12-29'); // dated Fri Jan 9, 2026: 21 days after Fri Dec 19, 2025
      expect(run.payDate).toBe('2026-01-09');
      expect(run.checks).toHaveLength(1);
      expect(checkOf(run, tech)).not.toHaveProperty('techRewardsCents');
      expect(await linesOf(tech)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([]);
      expect(await syncEvents()).toEqual([]);
    });

    it('takes an open line off when its technician has left before it was paid', async () => {
      const alpha = await readyTech('Sample Alpha');
      const bravo = await readyTech('Sample Bravo');
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(1);
      await trx('technicians').where({ id: alpha }).update({ employment_status: 'inactive' });
      await recompute(run.id);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(await linesOf(bravo)).toHaveLength(1);
      // the audit event says the technician is not active, not that the run is no longer dated for the gift
      expect((await syncEvents()).flatMap((e) => e.metadata.skipped || []))
        .toContainEqual({ technician_id: alpha, kind: 'december_gift', reason: 'not_active' });
      // a run that is no longer dated for the gift says that instead
      await trx('payroll_runs').where({ id: run.id }).update({ pay_date: '2026-12-17' });
      await recompute(run.id);
      expect(await linesOf(bravo)).toHaveLength(0);
      expect((await syncEvents()).flatMap((e) => e.metadata.skipped || []))
        .toContainEqual({ technician_id: bravo, kind: 'december_gift', reason: 'not_due_in_this_run' });
    });

    it.each([
      ['from before the gift year', '2025-12-15'],
      ['of the gift year', '2026-11-30'],
    ])('writes no gift, and still drafts the run, when an old week %s is paid on the gift date: the gift waits for a later week\'s run', async (_label, week) => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, week);
      const run = await draft(week, '2026-12-18');
      expect(run.payDate).toBe('2026-12-18');
      expect(await linesOf(tech)).toHaveLength(0);
      expect(checkOf(run, tech)).not.toHaveProperty('techRewardsCents');
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', tooEarly('Dec 7, 2026'))]);
      expect((await syncEventOf(run.id, 'waits')).flatMap((m) => m.waits))
        .toContainEqual(expect.objectContaining({ technician_id: tech, reason: 'pay_week_too_early', week: GIFT_WEEK }));
    });
  });

  describe('under the pay run lock', () => {
    it('reads worked weeks, not days, from PostgreSQL: one Monday for each week, by the ET work date', async () => {
      const tech = await readyTech('Sample Alpha');
      const shift = (clockIn, clockOut, status = 'completed') => ({ technician_id: tech, entry_type: 'shift', status, clock_in: clockIn, clock_out: clockOut });
      await trx('time_entries').insert([
        shift('2026-06-02T13:00:00Z', '2026-06-02T21:00:00Z'), // Tue Jun 2
        shift('2026-06-03T13:00:00Z', '2026-06-03T21:00:00Z'), // Wed Jun 3, the same week
        shift('2026-06-08T01:00:00Z', '2026-06-08T03:00:00Z'), // 9 PM ET on Sun Jun 7: still the week of Jun 1
        shift('2026-06-15T13:00:00Z', '2026-06-15T21:00:00Z'), // Mon Jun 15
        shift('2026-06-23T13:00:00Z', '2026-06-23T21:00:00Z', 'voided'), // voided: not work
      ]);
      const statements = [];
      const listen = (query) => statements.push(String(query.sql));
      database.on('query', listen);
      let weeks;
      try {
        weeks = await workedWeeks(trx, tech, '2025-12-29', '2026-12-13');
      } finally {
        database.removeListener('query', listen);
      }
      expect(weeks).toEqual(['2026-06-01', '2026-06-15']);
      // the weeks the JS helper gives for the same ET days
      expect(['2026-06-02', '2026-06-03', '2026-06-07', '2026-06-15'].map(staffWeekStartForWorkDate))
        .toEqual(['2026-06-01', '2026-06-01', '2026-06-01', '2026-06-15']);
      // two queries, and each asks for distinct technician and week pairs
      expect(statements).toHaveLength(2);
      expect(statements.every((sql) => /^select distinct /i.test(sql) && /ISODOW/.test(sql))).toBe(true);
    });

    it('reads and locks no technician row for the gift on a run that is dated for none', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, '2026-06-01');
      const statements = [];
      const listen = (query) => statements.push(String(query.sql));
      database.on('query', listen);
      let run;
      try {
        run = await draft('2026-06-01'); // dated Jun 12: no gift is due
      } finally {
        database.removeListener('query', listen);
      }
      expect(run.checks).toHaveLength(1);
      // the sync ran (it looks for open lines of its week), and asked nothing of the technicians
      expect(statements.some((sql) => /from "payroll_pay_lines" where .*"source_type" = /is.test(sql))).toBe(true);
      expect(statements.filter((sql) => /from "technicians" where .*"employment_status" = .* for share/is.test(sql))).toEqual([]);
      // it examined no gift, so it wrote no audit event
      expect(await syncEvents()).toEqual([]);
    });

    it('reads the technicians FOR SHARE and asks a bounded number of questions for a year of covered weeks', async () => {
      // hired before the year: the gift covers every week of it, and almost none has an approved timesheet
      const alpha = await readyTech('Sample Alpha');
      const bravo = await readyTech('Sample Bravo');
      await approvedWeek(alpha, GIFT_WEEK);
      const statements = [];
      const listen = (query) => statements.push(String(query.sql));
      database.on('query', listen);
      let run;
      try {
        run = await draft(GIFT_WEEK);
      } finally {
        database.removeListener('query', listen);
      }
      expect(checkOf(run, alpha).techRewardsCents).toBe(GIFT);
      expect(checkOf(run, bravo).techRewardsCents).toBe(GIFT);
      // a status, field work or hire date change waits for the pay run instead of slipping past a finalize
      expect(statements.some((sql) => /from "technicians" where .*"employment_status" = .* for share/is.test(sql))).toBe(true);
      // the covered-week guards read each technician's year at once, not one week at a time
      const worked = statements.filter((sql) => /from "time_entry_daily_summary"/i.test(sql));
      expect(worked.length).toBeLessThan(12);
    });
  });

  describe('a gift that is not ready waits and never holds the run', () => {
    it('waits, with a note, while an earlier week of the year is approved and has no finalized check; the catch-up run for that week never carries it, the next weekly run does, for the whole period', async () => {
      const alpha = await readyTech('Sample Alpha');
      const bravo = await readyTech('Sample Bravo');
      await approvedWeek(alpha, '2026-11-02'); // approved, never paid
      // a paid week between the catch-up week and the gift date: 50 h worked, 10 h of them overtime
      await approvedWeek(alpha, '2026-11-23', '2400.00', '600.00');
      await paidWeek(alpha, '2026-11-23');
      await approvedWeek(alpha, GIFT_WEEK);
      await approvedWeek(bravo, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect((await lineOf(bravo)).amount_cents).toBe(GIFT);
      expect([run.waiting, run.blocked]).toEqual([[], []]); // no gift line, so the pay run's covered-week guard has nothing to hold
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Nov 2, 2026 is not paid yet')]);
      // the wait does not stop the run: both checks finalize, Bravo's with the gift and Alpha's without
      const final = await finalize(run.id);
      expect(checkOf(final, bravo).techRewardsCents).toBe(GIFT);
      expect(checkOf(final, alpha)).not.toHaveProperty('techRewardsCents');
      // The office pays the November week on a catch-up run dated after Dec 18 (an earlier date is refused: Alpha's Dec 18 check
      // is final). That run is dated for the gift, but it pays a week before the gift week: a line on it could cover Jan 1 to
      // Nov 8 only, and the overtime of Nov 23 would get no share of the gift. It writes none.
      const catchUp = await draft('2026-11-02', '2026-12-22');
      expect(catchUp.payDate).toBe('2026-12-22');
      expect(checkOf(catchUp, alpha)).not.toHaveProperty('techRewardsCents');
      expect(await linesOf(alpha)).toHaveLength(0);
      expect([catchUp.waiting, catchUp.blocked]).toEqual([[], []]);
      expect(await notesOf(catchUp.id)).toEqual([waits('Sample Alpha', tooEarly('Dec 7, 2026'))]);
      await finalize(catchUp.id);
      // Every covered week is paid now. The next weekly run carries the gift, for the same period the Dec 18 run would have
      // written, and the overtime week between the catch-up week and the gift date gets its premium.
      await approvedWeek(alpha, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      const check = checkOf(next, alpha);
      // 30,000 over the 50 workweeks Dec 29 2025 .. Dec 7 2026 = 600 a week; 1/2 x 600 / 50 h x 10 h = 60
      expect(check).toMatchObject({ techRewardsCents: GIFT, lineOvertimePremiumCents: 60 });
      const stored = await trx('payroll_checks').where({ id: check.id }).first();
      expect(stored.calc_snapshot.lineOvertimeWeeks.find((w) => w.weekStart === '2026-11-23').premiumCents).toBe(60);
      const line = await lineOf(alpha);
      expect([dateOf(line.earned_week_start), dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual([NEXT_WEEK, '2026-01-01', '2026-12-13']);
      expect(checkOf(next, bravo)).toBeUndefined(); // Bravo's gift is paid and they have no hours this week
      await finalize(next.id);
      expect((await lineOf(alpha)).status).toBe('paid');
      // no finalized run says the gift was not on it any more: it is paid
      expect(await notesOf(run.id)).toEqual([]);
      expect(await notesOf(catchUp.id)).toEqual([]);
      expect(await notesOf(next.id)).toEqual([]);
      expect(await linesOf(alpha)).toHaveLength(1);
      expect(await linesOf(bravo)).toHaveLength(1);
    });

    it('waits for a shift that has no daily summary yet (a recorded shift is work)', async () => {
      const tech = await readyTech('Sample Alpha');
      await trx('time_entries').insert({ technician_id: tech, entry_type: 'shift', status: 'completed', clock_in: '2026-06-02T13:00:00Z', clock_out: '2026-06-02T21:00:00Z' });
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(tech)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Jun 1, 2026 is not paid yet')]);
      // the shift was a mistake and is voided: the next sync writes the line and the note goes
      await trx('time_entries').where({ technician_id: tech }).update({ status: 'voided' });
      const again = await recompute(run.id);
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('waits while a paid earlier week has an automatic clock-out nobody reviewed', async () => {
      process.env.GATE_SHIFT_CLOSE_REVIEW = 'true';
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, '2026-05-04');
      await paidWeek(tech, '2026-05-04');
      await trx('time_entries').insert({
        technician_id: tech, entry_type: 'shift', status: 'completed', clock_in: '2026-05-05T13:00:00Z', clock_out: '2026-05-06T03:00:00Z', auto_closed_at: '2026-05-06T03:00:00Z',
      });
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(tech)).toHaveLength(0);
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of May 4, 2026 has a timesheet to approve or an automatic clock-out to review')]);
      await trx('time_entries').where({ technician_id: tech }).update({ auto_close_reviewed_at: trx.fn.now() });
      const again = await recompute(run.id);
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('waits when the run would hold the check for its own week: no hours, and an automatic clock-out nobody reviewed', async () => {
      process.env.GATE_SHIFT_CLOSE_REVIEW = 'true';
      const alpha = await readyTech('Sample Alpha');
      const bravo = await readyTech('Sample Bravo');
      // Alpha's week is approved with no minutes (no check of their own) and holds a shift the system closed
      await approvedWeek(alpha, GIFT_WEEK, '0.00', '0.00');
      await trx('time_entries').insert({
        technician_id: alpha, entry_type: 'shift', status: 'completed', clock_in: '2026-12-08T13:00:00Z', clock_out: '2026-12-09T03:00:00Z', auto_closed_at: '2026-12-09T03:00:00Z',
      });
      await approvedWeek(bravo, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect([run.waiting, run.blocked]).toEqual([[], []]); // a gift line here would be a check the run must hold
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Dec 7, 2026 has a timesheet to approve or an automatic clock-out to review')]);
      const final = await finalize(run.id);
      expect(checkOf(final, bravo).techRewardsCents).toBe(GIFT);
      // reviewed: the next run writes the gift
      await trx('time_entries').where({ technician_id: alpha }).update({ auto_close_reviewed_at: trx.fn.now() });
      await approvedWeek(bravo, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      expect(checkOf(next, alpha)).toMatchObject({ techRewardsCents: GIFT, grossCents: GIFT });
    });

    it('waits on a later run while a week between the gift\'s period and that run is worked and has no check', async () => {
      const tech = await readyTech('Sample Alpha');
      const LATER = '2026-12-21';
      // the gift week was paid by a check with no gift on it, so a later run carries the gift
      await approvedWeek(tech, GIFT_WEEK);
      await paidWeek(tech, GIFT_WEEK);
      await approvedWeek(tech, NEXT_WEEK); // worked; its own run, dated Dec 25, is not final
      await approvedWeek(tech, LATER);
      const run = await draft(LATER, '2026-12-30');
      // A gift on this run could leave a check of theirs dated Dec 30 while the week of Dec 14 has none: that week's own run
      // (dated Dec 25) would then refuse to finalize. The gift waits for the week, though it covers no day of it.
      expect(await linesOf(tech)).toHaveLength(0);
      expect(checkOf(run, tech)).not.toHaveProperty('techRewardsCents');
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Dec 14, 2026 is not paid yet')]);
      // the week is paid: the run carries the gift, with the period it always had
      await paidWeek(tech, NEXT_WEEK);
      expect(checkOf(await recompute(run.id), tech).techRewardsCents).toBe(GIFT);
      const line = await lineOf(tech);
      expect([dateOf(line.earned_week_start), dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual([LATER, '2026-01-01', '2026-12-13']);
    });

    it('waits on a January run whose own week has work to approve, though the gift covers no day of that week', async () => {
      const tech = await readyTech('Sample Alpha');
      // the technician worked in the January pay week and the timesheet is not approved yet
      await trx('time_entries').insert({
        technician_id: tech, entry_type: 'shift', status: 'completed', clock_in: '2027-01-05T14:00:00Z', clock_out: '2027-01-05T22:00:00Z',
      });
      jest.setSystemTime(Date.parse('2027-01-12T17:00:00Z')); // the week of Jan 4 has ended
      const run = await draft('2027-01-04'); // dated Jan 15, 2027: it carries the 2026 gift, whose span ended Dec 13
      expect(run.payDate).toBe('2027-01-15');
      expect(run.waiting.map((w) => w.technicianId)).toEqual([tech]); // the run itself holds their check for that week
      expect(await linesOf(tech)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Jan 4, 2027 has a timesheet to approve or an automatic clock-out to review')]);
    });

    it('states the last pay date by the date on the checks, not by today: a run dated inside it still pays the gift months later', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, '2026-11-02'); // approved, never paid
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Nov 2, 2026 is not paid yet')]);
      // months later the note says the same thing, and a catch-up run dated inside the 60 days still carries the gift
      jest.setSystemTime(Date.parse('2027-04-06T17:00:00Z'));
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Nov 2, 2026 is not paid yet')]);
      const catchUp = await draft('2026-11-02', '2026-12-16'); // dated before the gift date: no gift
      expect(checkOf(catchUp, tech)).not.toHaveProperty('techRewardsCents');
      await finalize(catchUp.id);
      const again = await recompute(run.id); // the Dec 18 draft: the November week is paid now
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('does not wait for time off the pay run does not pay: with GATE_PAYROLL_TIME_OFF off a time-off week needs no check', async () => {
      const tech = await readyTech('Sample Alpha');
      await trx('payroll_time_off').insert({ technician_id: tech, work_date: '2026-07-03', kind: 'holiday', minutes: '480.00' });
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK); // the gate is off: no run pays that day, so nothing is owed for the week
      expect(checkOf(run, tech).techRewardsCents).toBe(GIFT);
      expect(await notesOf(run.id)).toEqual([]);
      // with the gate on, the pay run pays time off: the week of Jun 29 needs its check first
      process.env.GATE_PAYROLL_TIME_OFF = 'true';
      const again = await recompute(run.id);
      expect(checkOf(again, tech)).not.toHaveProperty('techRewardsCents');
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Jun 29, 2026 is not paid yet')]);
    });

    it('waits when no paycheck can be worked out for the technician, so a gift alone never blocks the run', async () => {
      const alpha = await readyTech('Sample Alpha', { pay_rate: null }); // no pay rate, and no hours this week
      const bravo = await readyTech('Sample Bravo');
      await approvedWeek(bravo, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'no paycheck can be worked out for them on this pay run (check their pay rate, and the tax tables for the pay date)')]);
      const final = await finalize(run.id);
      expect(checkOf(final, bravo).techRewardsCents).toBe(GIFT);
      expect(checkOf(final, alpha)).toBeUndefined();
      // the pay rate is set: the next run writes the gift
      await trx('technicians').where({ id: alpha }).update({ pay_rate: '22.00' });
      await approvedWeek(bravo, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      expect(checkOf(next, alpha)).toMatchObject({ techRewardsCents: GIFT, grossCents: GIFT });
    });

    it('waits when a later paycheck of the technician is already final, so a backdated run still finalizes for the others', async () => {
      const alpha = await readyTech('Sample Alpha'); // no hours in the gift week
      const bravo = await readyTech('Sample Bravo');
      // the Dec 25 run went final for Alpha before the gate was turned on: no gift on it
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      await approvedWeek(alpha, NEXT_WEEK);
      await finalize((await draft(NEXT_WEEK)).id);
      expect(await linesOf(alpha)).toHaveLength(0);
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      await approvedWeek(bravo, GIFT_WEEK);
      const run = await draft(GIFT_WEEK); // dated Dec 18, drafted after the Dec 25 run went final
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, alpha)).toBeUndefined();
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'a later paycheck of theirs is already final, so this pay run cannot hold one for them')]);
      const final = await finalize(run.id); // a gift-only check for Alpha would make finalize refuse the whole run
      expect(checkOf(final, bravo).techRewardsCents).toBe(GIFT);
      // a run dated after that paycheck writes the gift
      const next = await draft('2026-12-21', '2026-12-30');
      expect(next.payDate).toBe('2026-12-30');
      expect(checkOf(next, alpha)).toMatchObject({ techRewardsCents: GIFT, grossCents: GIFT });
      // the Dec 18 run, now final, says the gift was not on it until it is paid, then no longer
      expect(await notesOf(run.id)).toEqual([missed('Sample Alpha')]);
      await finalize(next.id);
      expect((await lineOf(alpha)).status).toBe('paid');
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('waits while the technician has no hire date on file: no gift on a guess, and it is written once the date is entered', async () => {
      const tech = await readyTech('Sample Alpha', { hire_date: null });
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(tech)).toHaveLength(0);
      expect(checkOf(run, tech)).not.toHaveProperty('techRewardsCents');
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha',
        'their hire date is not on file, so the pay run cannot tell whether they were hired by the gift date')]);
      // hired after the gift date: no gift, and nothing waits
      await trx('technicians').where({ id: tech }).update({ hire_date: '2026-12-19' });
      await recompute(run.id);
      expect(await linesOf(tech)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([]);
      // hired by the gift date, in the week this run pays: the gift is on the check, covering the days since
      await trx('technicians').where({ id: tech }).update({ hire_date: '2026-12-10' });
      const again = await recompute(run.id);
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
      expect(dateOf((await lineOf(tech)).covers_from)).toBe('2026-12-10');
    });

    it('says what waits when a week has nothing else to pay: no run is kept, and the message carries the note', async () => {
      const tech = await readyTech('Sample Alpha'); // no hours in the gift week
      await approvedWeek(tech, '2026-11-02'); // approved, never paid
      const refused = await api('POST', '/runs', { body: { weekStart: GIFT_WEEK } });
      expect([refused.status, refused.body.error]).toEqual([409,
        `No W-2 hours to pay for that week. ${waits('Sample Alpha', 'the week of Nov 2, 2026 is not paid yet')}.`]);
      expect(await trx('payroll_runs').where({ week_start: GIFT_WEEK })).toHaveLength(0);
      expect(await linesOf(tech)).toHaveLength(0);
      // with nothing waiting the message is the one it was
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      const plain = await api('POST', '/runs', { body: { weekStart: GIFT_WEEK } });
      expect([plain.status, plain.body.error]).toEqual([409, 'No W-2 hours to pay for that week.']);
    });

    it('keeps ids, a reason code and a week on the run row, never an amount, and shows no note while the gate is off', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, '2026-11-02');
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      const stored = await trx('payroll_runs').where({ id: run.id }).first('tech_rewards_waits');
      expect(stored.tech_rewards_waits).toEqual([{ technician_id: tech, kind: 'december_gift', source_id: `december_gift:${tech}:2026`, reason: 'week_not_paid', week: '2026-11-02' }]);
      // the audit event holds the same rows and line ids, and no key for an amount
      expect(await syncEventOf(run.id, 'waits')).toEqual([{
        run_id: run.id, week_start: GIFT_WEEK, added_line_ids: [], updated_line_ids: [], removed_line_ids: [], unchanged_count: 0,
        skipped: [], waits: stored.tech_rewards_waits,
      }]);
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('gives no reason on a finalized run, and no note once a hire date on file rules the gift out', async () => {
      const tech = await readyTech('Sample Alpha', { hire_date: null });
      const other = await readyTech('Sample Bravo');
      await approvedWeek(other, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha',
        'their hire date is not on file, so the pay run cannot tell whether they were hired by the gift date')]);
      await finalize(run.id);
      // final: the run is never worked out again, so it does not keep saying why
      expect(await notesOf(run.id)).toEqual([missed('Sample Alpha')]);
      // a hire date by the gift date is entered: the gift can still be added by a later run, and this run says so
      await trx('technicians').where({ id: tech }).update({ hire_date: '2026-03-02' });
      expect(await notesOf(run.id)).toEqual([missed('Sample Alpha')]);
      // the date is corrected to one after the gift date: no run pays this gift, so nothing is said
      await trx('technicians').where({ id: tech }).update({ hire_date: '2026-12-19' });
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('shows no note for a technician who left since: no run pays that gift', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, '2026-11-02'); // approved, never paid
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', 'the week of Nov 2, 2026 is not paid yet')]);
      await trx('technicians').where({ id: tech }).update({ employment_status: 'inactive' });
      expect(await notesOf(run.id)).toEqual([]);
    });

    it.each([
      ['the rewards gate', 'GATE_TECH_REWARDS_PAY_LINES'],
      ['pay lines', 'GATE_PAYROLL_PAY_LINES'],
    ])('keeps no stored wait from a run worked out with %s off: a finalized run never shows a wait whose cause is gone', async (_what, gate) => {
      const tech = await readyTech('Sample Alpha', { pay_rate: null }); // no pay rate: no paycheck can be worked out
      const other = await readyTech('Sample Bravo');
      await approvedWeek(other, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha',
        'no paycheck can be worked out for them on this pay run (check their pay rate, and the tax tables for the pay date)')]);
      // the gate goes off, the pay rate is corrected, and the run is worked out again and finalized (Bravo's gift comes off it)
      delete process.env[gate];
      await trx('technicians').where({ id: tech }).update({ pay_rate: '22.00' });
      const plain = await recompute(run.id);
      expect(checkOf(plain, other)).not.toHaveProperty('techRewardsCents');
      await finalize(run.id);
      expect((await trx('payroll_runs').where({ id: run.id }).first('tech_rewards_waits')).tech_rewards_waits).toBeNull();
      process.env[gate] = 'true';
      expect(await notesOf(run.id)).toEqual([]);
    });
  });

  describe('an open line sits in one pay week, and only that week\'s run pays it', () => {
    it('holds the automatic gift for review when a December gift line the pay run did not write is on file, open or paid', async () => {
      const alpha = await readyTech('Sample Alpha'); // an open hand-made line
      const bravo = await readyTech('Sample Bravo'); // a paid hand-made line
      await approvedWeek(alpha, GIFT_WEEK);
      await approvedWeek(bravo, GIFT_WEEK);
      const [open] = await trx('payroll_pay_lines').insert({
        technician_id: alpha, kind: 'december_gift', amount_cents: 12345, earned_week_start: EARLY_WEEK, covers_from: EARLY_WEEK, covers_to: '2026-12-06',
      }).returning('id');
      const paidRun = await paidWeek(bravo, EARLY_WEEK);
      const paidCheck = await trx('payroll_checks').where({ run_id: paidRun, technician_id: bravo }).first('id');
      await trx('payroll_pay_lines').insert({
        technician_id: bravo, kind: 'december_gift', amount_cents: 12345, earned_week_start: EARLY_WEEK, covers_from: EARLY_WEEK, covers_to: '2026-12-06',
        status: 'paid', check_id: paidCheck.id,
      });
      const run = await draft(GIFT_WEEK);
      // no second gift: the hand-made open line rides on Alpha's check as before, and Bravo's check has none
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(await linesOf(bravo)).toHaveLength(0);
      expect(checkOf(run, alpha).techRewardsCents).toBe(12345);
      expect(checkOf(run, bravo)).not.toHaveProperty('techRewardsCents');
      const held = 'a December gift line that the pay run did not write is already on file for them, so check that line first';
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', held), waits('Sample Bravo', held)]);
      // the hand-made open line is taken out: the next sync writes Alpha's gift, once
      await trx('payroll_pay_lines').where({ id: open.id || open }).del();
      const again = await recompute(run.id);
      expect(checkOf(again, alpha).techRewardsCents).toBe(GIFT);
      expect(await linesOf(alpha)).toHaveLength(1);
      expect(await notesOf(run.id)).toEqual([waits('Sample Bravo', held)]);
    });

    it('holds the gift when a gift line carries the Tech Rewards source type with a source key that is not the sync\'s own', async () => {
      const alpha = await readyTech('Sample Alpha'); // holds an open row keyed with no year
      const bravo = await readyTech('Sample Bravo'); // holds a paid row keyed with Charlie's id
      const charlie = await readyTech('Sample Charlie'); // has no row, but Bravo's row holds the key of Charlie's gift
      const delta = await readyTech('Sample Delta'); // nothing in the way
      for (const tech of [alpha, bravo, charlie, delta]) await approvedWeek(tech, GIFT_WEEK);
      const row = { kind: 'december_gift', amount_cents: 12345, source_type: 'tech_rewards', covers_from: '2026-01-01', covers_to: '2026-12-13' };
      // open in the gift week: the gift week's run pays an open Tech Rewards line of its own week
      await trx('payroll_pay_lines').insert({ ...row, technician_id: alpha, earned_week_start: GIFT_WEEK, source_id: `december_gift:${alpha}:gift` });
      const paidRun = await paidWeek(bravo, EARLY_WEEK);
      const paidCheck = await trx('payroll_checks').where({ run_id: paidRun, technician_id: bravo }).first('id');
      await trx('payroll_pay_lines').insert({
        ...row, technician_id: bravo, earned_week_start: EARLY_WEEK, covers_from: EARLY_WEEK, covers_to: '2026-12-06',
        source_id: `december_gift:${charlie}:2026`, status: 'paid', check_id: paidCheck.id,
      });
      const run = await draft(GIFT_WEEK);
      const held = 'a December gift line that the pay run did not write is already on file for them, so check that line first';
      // Alpha: the row rides on the check alone, no 300.00 beside it. Bravo: no second gift. Charlie: the key of their gift
      // is taken, so their gift waits (the unique source key never fails the run). Delta: the gift, as always.
      expect(checkOf(run, alpha).techRewardsCents).toBe(12345);
      expect(checkOf(run, bravo)).not.toHaveProperty('techRewardsCents');
      expect(checkOf(run, charlie)).not.toHaveProperty('techRewardsCents');
      expect(checkOf(run, delta).techRewardsCents).toBe(GIFT);
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', held), waits('Sample Bravo', held), waits('Sample Charlie', held)]);
      // three rows, in no stated order: the two hand-made rows as they were, and Delta's gift
      const rows = await trx('payroll_pay_lines').where({ kind: 'december_gift' });
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => `${r.technician_id} ${Number(r.amount_cents)} ${r.status}`).sort())
        .toEqual([`${alpha} 12345 open`, `${bravo} 12345 paid`, `${delta} ${GIFT} open`].sort());
      // a recompute changes nothing: the hand-made rows are never matched, moved or changed
      await recompute(run.id);
      expect((await trx('payroll_pay_lines').where({ kind: 'december_gift' })).map((r) => Number(r.amount_cents)).sort()).toEqual([12345, 12345, GIFT]);
      expect((await syncEventOf(run.id, 'waits')).flatMap((m) => m.waits).filter((w) => w.reason !== 'other_gift_line')).toEqual([]);
    });

    it('has one ownership rule: the SQL form and the JS form pick the same rows, the sync\'s own keys only', async () => {
      const tech = await readyTech('Sample Alpha');
      const other = await readyTech('Sample Bravo');
      const base = {
        technician_id: tech, kind: 'december_gift', amount_cents: 100, earned_week_start: GIFT_WEEK, covers_from: GIFT_WEEK, covers_to: '2026-12-13',
        source_type: 'tech_rewards',
      };
      const own = [`december_gift:${tech}:2026`, `december_gift:${tech}:2031`];
      const rows = [
        ...own.map((source_id) => ({ source_id })),
        { source_id: `december_gift:${tech.toUpperCase()}:2027` }, // the id in capitals
        { source_id: `DECEMBER_GIFT:${tech}:2028` },
        { source_id: `december_gift:${other}:2026` }, // another technician's key
        { source_id: `december_gift:${tech}:gift` },
        { source_id: `december_gift:${tech}:12026` },
        { source_id: `december_gift:${tech}:2026 ` },
        { source_id: ` december_gift:${tech}:2026` },
        { source_id: 'x' },
        { source_id: `stay_bonus:${tech}:2026`, kind: 'stay_bonus' }, // a kind the sync does not write
        { source_id: `commission:${tech}:2026`, kind: 'commission' },
        { source_id: `december_gift:${tech}:2026`, source_type: 'commission_payment' }, // another source type
        { source_id: null, source_type: null }, // no source
      ];
      expect(tech.toUpperCase()).not.toBe(tech);
      await trx('payroll_pay_lines').insert(rows.map((row) => ({ ...base, ...row })));
      const lines = () => trx('payroll_pay_lines').where({ technician_id: tech });
      const all = await lines().select('technician_id', 'kind', 'source_type', 'source_id');
      const bySql = (await lines().whereRaw(techRewardsOwnedSql()).select('source_id')).map((row) => row.source_id).sort();
      const notBySql = await lines().whereRaw(`NOT ${techRewardsOwnedSql()}`).select('source_id'); // never null: the row with no source too
      expect(all).toHaveLength(rows.length);
      expect(bySql).toEqual(own);
      expect(all.filter((row) => techRewardsOwnKey(row)).map((row) => row.source_id).sort()).toEqual(own);
      expect(notBySql).toHaveLength(rows.length - own.length);
      // and with a table alias, as the pay run reads it
      const aliased = await trx('payroll_pay_lines as l').where('l.technician_id', tech).whereRaw(techRewardsOwnedSql('l')).select('l.source_id');
      expect(aliased.map((row) => row.source_id).sort()).toEqual(own);
    });

    it('never removes or strands a hand-made row with the Tech Rewards source type: it carries forward, and a gate off, a finalize and a void all leave it', async () => {
      const alpha = await readyTech('Sample Alpha'); // W-2: the row is paid like any manual line
      const bravo = await readyTech('Sample Bravo'); // W-2, nothing in the way: gets the sync's own line
      const zulu = await readyTech('Sample Zulu', { employment_type: '1099' }); // no pay run pays a contractor's line
      await approvedWeek(alpha, GIFT_WEEK);
      await approvedWeek(bravo, GIFT_WEEK);
      const row = { kind: 'december_gift', amount_cents: 12345, source_type: 'tech_rewards' };
      // Alpha's row was earned in an earlier week that no run paid; Zulu's sits in the gift week and no run pays it
      const [a] = await trx('payroll_pay_lines').insert({
        ...row, technician_id: alpha, earned_week_start: EARLY_WEEK, covers_from: EARLY_WEEK, covers_to: '2026-12-06', source_id: `december_gift:${alpha}:gift`,
      }).returning('id');
      const [z] = await trx('payroll_pay_lines').insert({
        ...row, technician_id: zulu, earned_week_start: GIFT_WEEK, covers_from: GIFT_WEEK, covers_to: '2026-12-13', source_id: `december_gift:${zulu}:gift`,
      }).returning('id');
      const handMade = async () => (await trx('payroll_pay_lines').whereIn('id', [a.id || a, z.id || z]))
        .map((line) => [line.technician_id, line.status, dateOf(line.earned_week_start), Number(line.amount_cents)]).sort();
      const before = await handMade();
      const ownOf = async (technicianId) => (await linesOf(technicianId)).filter((line) => techRewardsOwnKey(line));

      // carried forward to the first run that can pay it, as a manual line is; the sync's own line is on the same run
      const run = await draft(GIFT_WEEK);
      expect(checkOf(run, alpha).techRewardsCents).toBe(12345);
      expect(checkOf(run, bravo).techRewardsCents).toBe(GIFT);
      expect(await ownOf(alpha)).toHaveLength(0); // no 300.00 beside the hand-made row
      expect(await ownOf(bravo)).toHaveLength(1);
      expect(await handMade()).toEqual(before);

      // gate off: the sync's own open line comes off, the hand-made rows stay and Alpha's still rides on the check
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      const off = await recompute(run.id);
      expect(await ownOf(bravo)).toHaveLength(0);
      expect(checkOf(off, alpha).techRewardsCents).toBe(12345);
      expect(await handMade()).toEqual(before);
      expect((await syncEventOf(run.id, 'gate'))[0]).toMatchObject({ gate: 'off', removed_count: 1 });

      // finalize: Alpha's row is paid with the check; Zulu's row, open in that week and not paid, is not removed
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      await recompute(run.id);
      await finalize(run.id);
      expect(await handMade()).toEqual([[alpha, 'paid', EARLY_WEEK, 12345], [zulu, 'open', GIFT_WEEK, 12345]].sort());
      expect((await ownOf(bravo)).map((line) => line.status)).toEqual(['paid']);

      // void: the run takes the sync's own line with it; the hand-made rows are open again, where they were
      await voidRun(run.id);
      expect(await ownOf(bravo)).toHaveLength(0);
      expect(await handMade()).toEqual(before);
    });

    it('holds the gift when a paid gift row holds the same key in another letter case: no second 300.00', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, GIFT_WEEK);
      const paidRun = await paidWeek(tech, EARLY_WEEK);
      const paidCheck = await trx('payroll_checks').where({ run_id: paidRun, technician_id: tech }).first('id');
      const capitals = `december_gift:${tech.toUpperCase()}:2026`;
      expect(capitals).not.toBe(`december_gift:${tech}:2026`);
      await trx('payroll_pay_lines').insert({
        technician_id: tech, kind: 'december_gift', amount_cents: GIFT, earned_week_start: EARLY_WEEK, covers_from: EARLY_WEEK, covers_to: '2026-12-06',
        source_type: 'tech_rewards', source_id: capitals, status: 'paid', check_id: paidCheck.id,
      });
      const run = await draft(GIFT_WEEK);
      const held = 'a December gift line that the pay run did not write is already on file for them, so check that line first';
      expect(checkOf(run, tech)).not.toHaveProperty('techRewardsCents');
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', held)]);
      await recompute(run.id);
      await finalize(run.id);
      // still the one paid row: nothing was written in the other letter case
      expect((await trx('payroll_pay_lines').where({ technician_id: tech, kind: 'december_gift' })).map((line) => [line.source_id, line.status]))
        .toEqual([[capitals, 'paid']]);
    });

    it('leaves every line the sync did not write to carry forward as before, also a reward kind with no source', async () => {
      const tech = await readyTech('Sample Alpha');
      delete process.env.GATE_TECH_REWARDS_PAY_LINES; // the sync writes nothing, so the check shows the hand-made row alone
      // a row with no source, earned in an earlier week that no run paid
      await trx('payroll_pay_lines').insert({
        technician_id: tech, kind: 'december_gift', amount_cents: 12345, earned_week_start: EARLY_WEEK, covers_from: EARLY_WEEK, covers_to: '2026-12-06',
      });
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(checkOf(run, tech).techRewardsCents).toBe(12345); // carried forward to the first run that can pay it
      await finalize(run.id);
      expect((await trx('payroll_pay_lines').where({ technician_id: tech }).first()).status).toBe('paid');
    });

    it('is on one draft at a time and paid once: a later draft that must wait does not pick it up, and a void takes it off', async () => {
      const tech = await readyTech('Sample Alpha'); // hours in both weeks
      await approvedWeek(tech, GIFT_WEEK);
      await approvedWeek(tech, NEXT_WEEK);
      const giftRun = await draft(GIFT_WEEK);
      const gift = await lineOf(tech);
      const next = await draft(NEXT_WEEK); // dated Dec 25: the week of Dec 7 is not paid yet, so the gift stays where it is
      expect(checkOf(next, tech)).not.toHaveProperty('techRewardsCents');
      expect(await lineOf(tech)).toMatchObject({ id: gift.id, status: 'open', check_id: null });
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(GIFT_WEEK);
      // the later draft says what the gift waits for there, until the gift is paid
      expect(await notesOf(next.id)).toEqual([waits('Sample Alpha', 'the week of Dec 7, 2026 is not paid yet')]);
      // void the run that holds it: the line goes with it
      await voidRun(giftRun.id);
      expect(await linesOf(tech)).toHaveLength(0);
      // the week of Dec 7 is drafted again and finalized: the gift is paid there, once
      const again = await draft(GIFT_WEEK);
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
      await finalize(again.id);
      expect((await linesOf(tech)).map((l) => l.status)).toEqual(['paid']);
      expect(await notesOf(next.id)).toEqual([]);
      const rebuilt = await recompute(next.id);
      expect(checkOf(rebuilt, tech)).not.toHaveProperty('techRewardsCents');
      await finalize(next.id);
      expect((await linesOf(tech)).map((l) => l.status)).toEqual(['paid']);
    });

    it('goes with its run when a paid run is voided, and the next run dated for it writes it again', async () => {
      const tech = await readyTech('Sample Alpha');
      const run = await draft(GIFT_WEEK);
      await finalize(run.id);
      const paid = await lineOf(tech);
      expect(paid.status).toBe('paid');
      await voidRun(run.id);
      expect(await linesOf(tech)).toHaveLength(0);
      // the void's own audit row names the line it took off, and the voided check keeps the figure it paid
      const voided = await trx('audit_log').where({ action: 'payroll.run_voided', resource_id: run.id }).first();
      expect(voided.metadata.tech_rewards_line_ids_removed).toEqual([paid.id]);
      expect((await trx('payroll_checks').where({ id: paid.check_id }).first()).tech_rewards_cents).toBe(String(GIFT));
      const again = await draft(GIFT_WEEK);
      expect(await linesOf(tech)).toHaveLength(1);
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
    });

    it('is not written in a run dated before the gift date, also for a week drafted again after a void', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, GIFT_WEEK);
      const first = await draft(GIFT_WEEK); // dated Dec 18
      expect((await lineOf(tech)).status).toBe('open');
      await voidRun(first.id);
      expect(await linesOf(tech)).toHaveLength(0); // the line went with its run
      const again = await draft(GIFT_WEEK, '2026-12-17');
      expect(again.payDate).toBe('2026-12-17');
      expect(await linesOf(tech)).toHaveLength(0);
      expect(checkOf(again, tech)).not.toHaveProperty('techRewardsCents');
    });

    it('goes to the run that is worked out last and is ready for it; the first one finalized pays it, and the other asks for a review', async () => {
      const alpha = await readyTech('Sample Alpha'); // no hours in either week: the gift is the whole check
      const bravo = await readyTech('Sample Bravo'); // hours in the later week only
      await approvedWeek(bravo, NEXT_WEEK);
      const earlier = await draft(GIFT_WEEK); // dated Dec 18: both gifts
      expect(dateOf((await lineOf(alpha)).earned_week_start)).toBe(GIFT_WEEK);
      const later = await draft(NEXT_WEEK); // dated Dec 25 and ready for both: the lines move to it
      expect(dateOf((await lineOf(alpha)).earned_week_start)).toBe(NEXT_WEEK);
      expect(dateOf((await lineOf(bravo)).earned_week_start)).toBe(NEXT_WEEK);
      expect(checkOf(later, alpha).techRewardsCents).toBe(GIFT);
      expect(await linesOf(alpha)).toHaveLength(1);
      const laterToken = (await api('GET', `/runs/${later.id}`)).body.run.token;
      // The office finalizes the Dec 18 run first. Its sync takes the lines back, the numbers are the ones it showed, and it pays.
      const final = await finalize(earlier.id);
      expect(checkOf(final, alpha).techRewardsCents).toBe(GIFT);
      expect((await linesOf(alpha)).map((l) => [l.status, dateOf(l.earned_week_start)])).toEqual([['paid', GIFT_WEEK]]);
      expect((await linesOf(bravo)).map((l) => [l.status, dateOf(l.earned_week_start)])).toEqual([['paid', GIFT_WEEK]]);
      // The Dec 25 draft still shows the gifts. Finalizing it with that token is refused, and it is rebuilt without them.
      const stale = await api('POST', `/runs/${later.id}/finalize`, { body: { token: laterToken } });
      expect([stale.status, stale.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const rebuilt = (await api('GET', `/runs/${later.id}`)).body.run;
      expect(checkOf(rebuilt, alpha)).toBeUndefined();
      expect(checkOf(rebuilt, bravo)).not.toHaveProperty('techRewardsCents');
      await finalize(later.id);
      // each gift is paid once
      expect((await linesOf(alpha)).map((l) => l.status)).toEqual(['paid']);
      expect((await linesOf(bravo)).map((l) => l.status)).toEqual(['paid']);
    });

    it('is not held back for a draft that can no longer pay it: the later run takes it and the earlier draft rebuilds', async () => {
      const alpha = await readyTech('Sample Alpha'); // no hours in either week: the gift is the whole check
      const bravo = await readyTech('Sample Bravo');
      await approvedWeek(bravo, GIFT_WEEK);
      const earlier = await draft(GIFT_WEEK); // dated Dec 18: both gifts
      expect(dateOf((await lineOf(alpha)).earned_week_start)).toBe(GIFT_WEEK);
      // a pay rate correction: Alpha's rate starts the week of Dec 14, and the weeks before it have none. The Dec 18 draft
      // (the week of Dec 7) can no longer work out a check for Alpha; the next week's run can.
      await trx('payroll_rate_steps').insert({
        technician_id: alpha, effective_on: NEXT_WEEK, hourly_rate: '22.00', previous_rate: null, applied_at: trx.fn.now(), created_by: ADMIN_ID,
      });
      const later = await draft(NEXT_WEEK); // dated Dec 25
      expect(dateOf((await lineOf(alpha)).earned_week_start)).toBe(NEXT_WEEK);
      expect(checkOf(later, alpha)).toMatchObject({ techRewardsCents: GIFT, grossCents: GIFT });
      // Bravo's gift stays with the earlier draft: the later run must wait for the week of Dec 7, which that draft pays
      expect(dateOf((await lineOf(bravo)).earned_week_start)).toBe(GIFT_WEEK);
      expect(checkOf(later, bravo)).toBeUndefined();
      // the earlier draft rebuilds without Alpha, says why Alpha's gift is not on it, and finalizes
      const rebuilt = await recompute(earlier.id);
      expect(checkOf(rebuilt, alpha)).toBeUndefined();
      expect(await notesOf(earlier.id)).toEqual([waits('Sample Alpha',
        'no paycheck can be worked out for them on this pay run (check their pay rate, and the tax tables for the pay date)')]);
      expect(dateOf((await lineOf(alpha)).earned_week_start)).toBe(NEXT_WEEK);
      await finalize(earlier.id);
      expect((await lineOf(bravo)).status).toBe('paid');
      await finalize(later.id);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', amount_cents: GIFT });
      expect(await notesOf(earlier.id)).toEqual([]); // paid: the earlier run no longer says it waits
    });

    it('is taken at finalize by a run whose draft did not show it: the finalize asks for a review once, then pays it', async () => {
      const alpha = await readyTech('Sample Alpha'); // no hours in the gift week, hours the week after
      const bravo = await readyTech('Sample Bravo');
      await approvedWeek(bravo, GIFT_WEEK);
      await approvedWeek(alpha, NEXT_WEEK);
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      const later = await draft(NEXT_WEEK); // dated Dec 25, drafted before the gate went on: Alpha's wages, no gift
      expect(checkOf(later, alpha)).not.toHaveProperty('techRewardsCents');
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      const earlier = await draft(GIFT_WEEK); // dated Dec 18: Alpha's check is the gift alone
      expect(dateOf((await lineOf(alpha)).earned_week_start)).toBe(GIFT_WEEK);
      // The office finalizes the Dec 25 run first. Its sync takes Alpha's gift (it is ready for it), so the numbers are not the
      // ones the office saw: the finalize sends them back for review, and nothing is paid yet.
      const token = (await api('GET', `/runs/${later.id}`)).body.run.token;
      const first = await api('POST', `/runs/${later.id}/finalize`, { body: { token } });
      expect([first.status, first.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      expect(await lineOf(alpha)).toMatchObject({ status: 'open', amount_cents: GIFT });
      expect(dateOf((await lineOf(alpha)).earned_week_start)).toBe(NEXT_WEEK);
      const reviewed = (await api('GET', `/runs/${later.id}`)).body.run;
      expect([reviewed.status, checkOf(reviewed, alpha).techRewardsCents]).toEqual(['draft', GIFT]);
      // Bravo's gift stays with the Dec 18 draft: this run must wait for the week of Dec 7, and says so
      expect(dateOf((await lineOf(bravo)).earned_week_start)).toBe(GIFT_WEEK);
      expect(await notesOf(later.id)).toEqual([waits('Sample Bravo', 'the week of Dec 7, 2026 is not paid yet')]);
      const final = await finalize(later.id);
      expect(checkOf(final, alpha).techRewardsCents).toBe(GIFT);
      expect((await lineOf(alpha)).status).toBe('paid');
      // the Dec 18 draft rebuilds without Alpha and pays Bravo; each gift is paid once
      const rebuilt = await recompute(earlier.id);
      expect(checkOf(rebuilt, alpha)).toBeUndefined();
      await finalize(earlier.id);
      expect((await linesOf(alpha)).map((l) => l.status)).toEqual(['paid']);
      expect((await linesOf(bravo)).map((l) => l.status)).toEqual(['paid']);
      expect(await notesOf(later.id)).toEqual([]);
    });

    it('stays on the earlier draft when a later run is finalized first and must wait for that week; the later run says so', async () => {
      const tech = await readyTech('Sample Alpha'); // hours in both weeks
      await approvedWeek(tech, GIFT_WEEK);
      await approvedWeek(tech, NEXT_WEEK);
      const earlier = await draft(GIFT_WEEK); // dated Dec 18: wages and the gift
      const gift = await lineOf(tech);
      const later = await draft(NEXT_WEEK); // dated Dec 25: wages, no gift (the week of Dec 7 is not paid)
      expect(await notesOf(later.id)).toEqual([waits('Sample Alpha', 'the week of Dec 7, 2026 is not paid yet')]);
      // The office finalizes the Dec 25 run first. The gift stays on the Dec 18 draft, and this run says what it waits for.
      const final = await finalize(later.id);
      expect(checkOf(final, tech)).not.toHaveProperty('techRewardsCents');
      expect(await lineOf(tech)).toMatchObject({ id: gift.id, status: 'open' });
      expect(await notesOf(later.id)).toEqual([missed('Sample Alpha')]);
      // the earlier draft cannot be finalized with this technician's check while the later run is final (the pay run's own rule)
      const token = (await api('GET', `/runs/${earlier.id}`)).body.run.token;
      const refused = await api('POST', `/runs/${earlier.id}/finalize`, { body: { token } });
      expect([refused.status, refused.body.error]).toEqual([409, 'A later pay run is already final. Void it first, then finalize this one.']);
      expect(await lineOf(tech)).toMatchObject({ id: gift.id, status: 'open' });
      // the office voids the later run and pays in order: the gift is on the Dec 18 check, once
      await voidRun(later.id);
      const paid = await finalize(earlier.id);
      expect(checkOf(paid, tech).techRewardsCents).toBe(GIFT);
      expect((await linesOf(tech)).map((l) => l.status)).toEqual(['paid']);
    });

    it('leaves a draft whose only checks were gifts with no check once another run paid them: its finalize shows the empty draft', async () => {
      const alpha = await readyTech('Sample Alpha'); // no hours in either week
      const bravo = await readyTech('Sample Bravo'); // hours in the later week only
      await approvedWeek(bravo, NEXT_WEEK);
      const earlier = await draft(GIFT_WEEK); // dated Dec 18: two checks, each a gift alone
      expect(earlier.checks.map((c) => c.grossCents)).toEqual([GIFT, GIFT]);
      const later = await draft(NEXT_WEEK); // dated Dec 25 and ready for both: the lines move to it
      await finalize(later.id);
      expect((await linesOf(alpha)).map((l) => l.status)).toEqual(['paid']);
      expect((await linesOf(bravo)).map((l) => l.status)).toEqual(['paid']);
      // The Dec 18 draft still shows the two checks. Its finalize is refused, and the draft is kept as it is now: no check.
      const token = (await api('GET', `/runs/${earlier.id}`)).body.run.token;
      const stale = await api('POST', `/runs/${earlier.id}/finalize`, { body: { token } });
      expect([stale.status, stale.body.error]).toEqual([409, 'Hours or settings changed. Review the new numbers.']);
      const shown = (await api('GET', `/runs/${earlier.id}`)).body.run;
      expect([shown.status, shown.checks]).toEqual(['draft', []]);
      const empty = await api('POST', `/runs/${earlier.id}/finalize`, { body: { token: shown.token } });
      expect([empty.status, empty.body.error]).toEqual([409, 'There are no paychecks to finalize.']);
      await voidRun(earlier.id);
      expect(await linesOf(alpha)).toHaveLength(1); // the void of an empty draft takes no paid line
    });

    it('never stays with a finalized run: pay lines turned off before the finalize, the line comes off and the next run writes it', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, GIFT_WEEK);
      await approvedWeek(tech, NEXT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect((await lineOf(tech)).status).toBe('open');
      delete process.env.GATE_PAYROLL_PAY_LINES; // the run is worked out again and finalized without its pay lines
      const plain = await recompute(run.id);
      expect(checkOf(plain, tech)).not.toHaveProperty('techRewardsCents');
      const line = await lineOf(tech);
      await finalize(run.id);
      expect(await linesOf(tech)).toHaveLength(0); // the finalized run did not pay it and does not keep it
      const finalized = await trx('audit_log').where({ action: 'payroll.run_finalized', resource_id: run.id }).first();
      expect(finalized.metadata.tech_rewards_line_ids_removed).toEqual([line.id]);
      process.env.GATE_PAYROLL_PAY_LINES = 'true';
      const next = await draft(NEXT_WEEK);
      expect(checkOf(next, tech).techRewardsCents).toBe(GIFT);
      await finalize(next.id);
      expect(await lineOf(tech)).toMatchObject({ status: 'paid', amount_cents: GIFT });
    });

    it('is taken from a week that has no draft run: an open line left in a finalized week moves to the next ready run', async () => {
      const tech = await readyTech('Sample Alpha');
      await paidWeek(tech, GIFT_WEEK); // a finalized run of the gift week
      // an open line left in that week (no pay run leaves one; this is the state the rule must still handle)
      await trx('payroll_pay_lines').insert({
        technician_id: tech, kind: 'december_gift', amount_cents: GIFT, earned_week_start: GIFT_WEEK, covers_from: '2026-01-01', covers_to: '2026-12-13',
        source_type: 'tech_rewards', source_id: `december_gift:${tech}:2026`,
      });
      await approvedWeek(tech, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      const line = await lineOf(tech);
      // the line moves to the week that pays it; what it covers does not change with the run
      expect([dateOf(line.earned_week_start), dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual([NEXT_WEEK, '2026-01-01', '2026-12-13']);
      expect(checkOf(next, tech).techRewardsCents).toBe(GIFT);
      expect(await linesOf(tech)).toHaveLength(1);
    });
  });
  // Hired Nov 24, 2025: 1 year of service on Tue Nov 24, 2026. The 12 months are Nov 24, 2025 to Nov 23, 2026 and their last
  // pay week is the week of Nov 23. So EARLY_WEEK (Nov 30, pay date Dec 11) is the first run that can carry the bonus, and
  // Jan 23, 2027 (60 days after the anniversary) is the last pay date that can.
  describe('the stay bonus', () => {
    const HIRED = '2025-11-24';
    const LAST_WEEK = '2026-11-23';
    const STAY_GATE = 'GATE_TECH_REWARDS_STAY_BONUS';
    const stayTech = (name, patch = {}) => readyTech(name, { hire_date: HIRED, ...patch });
    // three paid weeks inside the 12 months: 3 x 880.00 = 2,640.00, and 2% of it is 52.80
    const paidWeeks = async (technicianId) => {
      for (const week of ['2026-11-02', '2026-11-09', '2026-11-16']) await paidWeek(technicianId, week);
    };
    const PERIOD = 'the pay earned Nov 24, 2025 to Nov 23, 2026';
    const stayWaits = (name, why, years = '1 year') => `Stay bonus (${years}) for ${name} waits: ${why}. Only a pay run dated Jan 23, 2027 or earlier can add it`;
    const refusedVoid = async (runId) => {
      const done = await api('POST', `/runs/${runId}/void`, { body: { reason: 'Sample correction' } });
      return [done.status, done.body.error];
    };
    const HELD = [409, 'A stay bonus on another paycheck was worked out from this pay run. Void the pay run that paid the bonus first.'];
    const checkIdsOf = async (technicianId) => (await trx('payroll_checks').where({ technician_id: technicianId, status: 'finalized' }).select('id'))
      .map((row) => row.id).sort();

    beforeEach(() => {
      process.env[STAY_GATE] = 'true';
      delete process.env.GATE_TECH_REWARDS_PAY_LINES; // the stay bonus does not need the gift's gate
    });

    it('is 2% of the pay earned in the 12 months before the 1 year anniversary, on the first run for a week after them', async () => {
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      await approvedWeek(alpha, EARLY_WEEK);
      const other = await readyTech('Sample Other'); // hired Jan 10, 2024: 3 years on Jan 10, 2027, after this run's pay date
      const noDate = await readyTech('Sample Nodate', { hire_date: null });
      const gone = await stayTech('Sample Gone', { employment_status: 'inactive' });
      const manager = await stayTech('Sample Manager', { role: 'admin' });
      for (const id of [gone, manager]) await paidWeeks(id);
      const run = await draft(EARLY_WEEK);
      expect(run.payDate).toBe('2026-12-11');
      const line = await lineOf(alpha);
      expect(line).toMatchObject({
        kind: 'stay_bonus', status: 'open', amount_cents: 5280, source_id: `stay_bonus:${alpha}:1`, note: `2% of $2,640.00, ${PERIOD}`,
      });
      expect([dateOf(line.earned_week_start), dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual([EARLY_WEEK, '2025-11-24', '2026-11-23']);
      // the line keeps the three checks it was worked out from
      expect(line.counted_check_ids).toEqual(await checkIdsOf(alpha));
      expect(line.counted_check_ids).toHaveLength(3);
      expect(checkOf(run, alpha)).toMatchObject({ techRewardsCents: 5280, grossCents: 88000 + 5280 });
      for (const id of [other, noDate, gone, manager]) expect(await linesOf(id)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([]);
      // what the scoreboard asks of payroll: a run dated today could still write the bonus for Alpha, and for nobody the
      // sync writes no line for (left, an office account), on the same dates; not after the 60 days (Jan 23)
      const payable = async (id, today) => (await stayBonusStatus(trx, id, HIRED, today)).payableKeys;
      expect([await payable(alpha, run.payDate), await payable(gone, run.payDate), await payable(manager, run.payDate), await payable(alpha, '2027-01-24')])
        .toEqual([['1'], [], [], []]);
      // the audit event names the line and holds no amount: ids, kinds, reason codes and counts only
      const [event] = await syncEventOf(run.id, 'added_line_ids');
      expect(event.added_line_ids).toEqual([line.id]);
      const amounts = [5280, 264000, '5280', '264000', '52.80', '2640.00', '$52.80', '$2,640.00'];
      const valuesOf = (value) => (value && typeof value === 'object' ? Object.values(value).flatMap(valuesOf) : [value]);
      expect(valuesOf(event).filter((value) => amounts.includes(value))).toEqual([]);
      expect(Object.keys(event).filter((key) => /cents|amount|base|note/i.test(key))).toEqual([]);
      // finalize pays it with its check, and no later run writes the milestone again
      await finalize(run.id);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', amount_cents: 5280 });
      await approvedWeek(alpha, GIFT_WEEK);
      const next = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(1);
      expect(checkOf(next, alpha)).not.toHaveProperty('techRewardsCents');
    });

    it.each([
      [3, '2023-11-24', 10560, '4%'],
      [5, '2021-11-24', 21120, '8%'],
    ])('is the rate of the milestone: %s years of service', async (years, hired, cents, rate) => {
      const alpha = await stayTech('Sample Alpha', { hire_date: hired });
      await paidWeeks(alpha);
      const run = await draft(EARLY_WEEK);
      expect(await lineOf(alpha)).toMatchObject({
        kind: 'stay_bonus', amount_cents: cents, source_id: `stay_bonus:${alpha}:${years}`, note: `${rate} of $2,640.00, ${PERIOD}`,
      });
      expect(checkOf(run, alpha)).toMatchObject({ techRewardsCents: cents, grossCents: cents });
    });

    it('waits on the run of the last week of the 12 months: that week\'s pay is not final yet, and the next week\'s run counts it', async () => {
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      await approvedWeek(alpha, LAST_WEEK);
      const run = await draft(LAST_WEEK);
      expect(run.payDate).toBe('2026-12-04'); // after the anniversary, and still too early
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, alpha)).not.toHaveProperty('techRewardsCents');
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      const tooSoon = 'the 12 months it is worked out from end in the week of Nov 23, 2026, and only a pay run for a later week can add it';
      expect(await notesOf(run.id)).toEqual([stayWaits('Sample Alpha', tooSoon)]);
      expect((await syncEventOf(run.id, 'waits')).flatMap((m) => m.waits)).toContainEqual({
        technician_id: alpha, kind: 'stay_bonus', source_id: `stay_bonus:${alpha}:1`, reason: 'pay_week_too_early', week: LAST_WEEK,
      });
      await finalize(run.id);
      // a finalized run gives no reason
      expect(await notesOf(run.id)).toEqual(['Stay bonus (1 year) for Sample Alpha was not on this pay run. Only a pay run dated Jan 23, 2027 or earlier can add it']);
      // Mon Nov 23 is the one day of that week in the 12 months: 1/7 of its 880.00 counts (no day records), so 2% of 2,765.71
      const next = await draft(EARLY_WEEK);
      expect(await lineOf(alpha)).toMatchObject({ amount_cents: 5531, note: `2% of $2,765.71, ${PERIOD}` });
      expect(checkOf(next, alpha).techRewardsCents).toBe(5531);
      await finalize(next.id);
      expect(await notesOf(run.id)).toEqual([]); // paid: nothing waits
    });

    it('waits, with a note, while a week of the 12 months is approved and has no finalized check', async () => {
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      await approvedWeek(alpha, '2026-10-05'); // approved, never paid
      await approvedWeek(alpha, EARLY_WEEK);
      const run = await draft(EARLY_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await notesOf(run.id)).toEqual([stayWaits('Sample Alpha', 'the week of Oct 5, 2026 is not paid yet')]);
      // the wait does not stop the run: the check finalizes without the bonus
      const final = await finalize(run.id);
      expect(checkOf(final, alpha)).not.toHaveProperty('techRewardsCents');
    });

    it('counts the paychecks of the 12 months\' pay weeks only: a pay line that a later check pays is no part of it and never holds the bonus', async () => {
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      await approvedWeek(alpha, EARLY_WEEK);
      await approvedWeek(alpha, GIFT_WEEK);
      // Two open lines this run pays. A commission for the week of Nov 16, entered late. And one for Tue Nov 24 to Fri Nov 27,
      // days after the 12 months (they end Mon Nov 23) in their last week. Both land on the check of the week of Nov 30.
      await trx('payroll_pay_lines').insert([
        { technician_id: alpha, kind: 'commission', amount_cents: 10000, earned_week_start: '2026-11-16' },
        { technician_id: alpha, kind: 'commission', amount_cents: 4000, earned_week_start: EARLY_WEEK, covers_from: '2026-11-24', covers_to: '2026-11-27' },
      ]);
      const run = await draft(EARLY_WEEK);
      expect(checkOf(run, alpha)).toMatchObject({ commissionCents: 14000, techRewardsCents: 5280 });
      expect(await lineOf(alpha)).toMatchObject({ amount_cents: 5280, note: `2% of $2,640.00, ${PERIOD}` });
      expect(await notesOf(run.id)).toEqual([]);
      const counted = (await lineOf(alpha)).counted_check_ids;
      expect(counted).toHaveLength(3);
      await finalize(run.id);
      // the same answer on every later sync: the check that paid the two lines is for a later pay week, so it never counts
      await voidRun(run.id);
      expect(await linesOf(alpha)).toHaveLength(0);
      const next = await finalize((await draft(EARLY_WEEK)).id);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', amount_cents: 5280, counted_check_ids: counted });
      expect(counted).not.toContain(checkOf(next, alpha).id);
      // a commission for a week of the 12 months that the NEXT run pays changes nothing, and that run is voided freely
      await trx('payroll_pay_lines').insert({ technician_id: alpha, kind: 'commission', amount_cents: 2000, earned_week_start: '2026-11-09' });
      const later = await finalize((await draft(GIFT_WEEK)).id);
      expect(checkOf(later, alpha)).toMatchObject({ commissionCents: 2000 });
      expect(checkOf(later, alpha)).not.toHaveProperty('techRewardsCents');
      expect(await linesOf(alpha)).toHaveLength(1);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', amount_cents: 5280, counted_check_ids: counted });
      await voidRun(later.id);
    });

    it('waits, with a note, when no finalized paycheck holds pay for the 12 months: no bonus on a base of nothing', async () => {
      const alpha = await stayTech('Sample Alpha');
      await approvedWeek(alpha, EARLY_WEEK);
      const run = await draft(EARLY_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, alpha)).not.toHaveProperty('techRewardsCents');
      expect(await notesOf(run.id)).toEqual([stayWaits('Sample Alpha', 'no finalized paycheck holds pay of theirs for the 12 months it is worked out from')]);
    });

    it('never pays from an overtime split it cannot prove: an older paycheck with a bonus line, other line pay and earlier pay for the week makes the bonus wait for review; one with no earlier pay, or with the bonus line alone, is read from its own row', async () => {
      const WEEK = '2026-11-09';
      // An older check, for the week of Nov 16, with no stored split: it paid a 6.00 commission and a 6.00 gift line for WEEK
      // (45 h worked, 5 of them overtime) and 67 of premium for the two. `earlier`: what its week row says earlier checks paid.
      const mixedCheck = async (technicianId, earlier) => {
        const { runId } = await paidLine(technicianId, '2026-11-16', 600, WEEK, 67, {
          gross_cents: 88000 + 600 + 600 + 67,
          tech_rewards_cents: 600,
          calc_snapshot: JSON.stringify({ lineOvertimeWeeks: [{ weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 1200, premiumCents: 67, ...earlier }] }),
        });
        const check = await trx('payroll_checks').where({ run_id: runId, technician_id: technicianId }).first('id');
        await trx('payroll_pay_lines').insert({
          technician_id: technicianId, kind: 'december_gift', amount_cents: 600, earned_week_start: '2026-11-16', covers_from: WEEK, covers_to: '2026-11-15', status: 'paid', check_id: check.id,
        });
      };
      const alpha = await stayTech('Sample Alpha');
      const bravo = await stayTech('Sample Bravo');
      for (const id of [alpha, bravo]) {
        for (const week of ['2026-11-02', WEEK]) await paidWeek(id, week);
        await approvedWeek(id, EARLY_WEEK);
      }
      // Alpha's row shows earlier pay for the week (6.00 of line pay, 33 of premium): the commission's part of the 67 depends on
      // the exact earlier pay, which the row holds rounded. Not proven.
      await mixedCheck(alpha, { earlierAllocatedCents: 600, earlierPremiumCents: 33 });
      // Bravo's row shows none: the check priced its lines for the week alone, so the commission alone earned 33.33 -> 33
      await mixedCheck(bravo, {});
      // Charlie: WEEK's own check paid the 6.00 commission and its 33. The older check that followed holds ONLY the gift line
      // for WEEK, with that earlier pay on its row and 34 of premium. Without the gift it would have paid nothing for the
      // week, so there is nothing to split and nothing to review.
      const charlie = await stayTech('Sample Charlie');
      await paidWeek(charlie, '2026-11-02');
      await paidLine(charlie, WEEK, 600, WEEK, 33, { gross_cents: 88000 + 600 + 33 });
      await approvedWeek(charlie, EARLY_WEEK);
      const giftRun = await paidWeek(charlie, '2026-11-16', {
        gross_cents: 88000 + 600 + 34,
        tech_rewards_cents: 600,
        line_overtime_premium_cents: 34,
        calc_snapshot: JSON.stringify({ lineOvertimeWeeks: [{ weekStart: WEEK, workedMinutes: 2700, overtimeMinutes: 300, allocatedCents: 600, premiumCents: 34, earlierAllocatedCents: 600, earlierPremiumCents: 33 }] }),
      });
      const giftCheck = await trx('payroll_checks').where({ run_id: giftRun, technician_id: charlie }).first('id');
      await trx('payroll_pay_lines').insert({
        technician_id: charlie, kind: 'december_gift', amount_cents: 600, earned_week_start: '2026-11-16', covers_from: WEEK, covers_to: '2026-11-15', status: 'paid', check_id: giftCheck.id,
      });
      const run = await draft(EARLY_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, alpha)).not.toHaveProperty('techRewardsCents');
      expect(await notesOf(run.id)).toEqual([stayWaits('Sample Alpha',
        'an older paycheck paid a bonus line and other line pay for the week of Nov 9, 2026 and kept no split of that week\'s overtime between them, so work this bonus out by hand')]);
      // Bravo: three weeks of wages, the 6.00 commission and its 33; not the gift line and not its 34. 2% of 2,646.33 = 52.93
      expect(await lineOf(bravo)).toMatchObject({ status: 'open', amount_cents: 5293, note: `2% of $2,646.33, ${PERIOD}` });
      // Charlie: three weeks of wages, the commission and its 33 from WEEK's own check; none of the gift's 34. The same base.
      expect(await lineOf(charlie)).toMatchObject({ status: 'open', amount_cents: 5293, note: `2% of $2,646.33, ${PERIOD}` });
      // the bonus that waits never holds the run
      await finalize(run.id);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(await lineOf(bravo)).toMatchObject({ status: 'paid', amount_cents: 5293 });
    });

    it('shows no stale wait: a hire date corrected since the run\'s last sync, to one this run is not dated for, takes the note off', async () => {
      const alpha = await stayTech('Sample Alpha');
      await approvedWeek(alpha, EARLY_WEEK);
      const run = await draft(EARLY_WEEK); // dated Dec 11, 2026
      const note = stayWaits('Sample Alpha', 'no finalized paycheck holds pay of theirs for the 12 months it is worked out from');
      expect(await notesOf(run.id)).toEqual([note]);
      // Corrected to a date whose 1 year anniversary (Dec 20, 2026) is after this run's pay date. A run dated Dec 11 does not
      // write that bonus, so the reason saved at its sync is not shown beside the new date's deadline.
      await trx('technicians').where({ id: alpha }).update({ hire_date: '2025-12-20' });
      expect(await notesOf(run.id)).toEqual([]);
      // a date this run is still dated for (anniversary Dec 1) keeps the note, with that date's deadline
      await trx('technicians').where({ id: alpha }).update({ hire_date: '2025-12-01' });
      expect(await notesOf(run.id)).toEqual([note.replace('Jan 23, 2027', 'Jan 30, 2027')]);
    });

    it('waits when no paycheck can be worked out for the technician, so a bonus alone never blocks the run', async () => {
      const alpha = await stayTech('Sample Alpha', { pay_rate: null });
      const bravo = await stayTech('Sample Bravo');
      for (const id of [alpha, bravo]) await paidWeeks(id);
      const run = await draft(EARLY_WEEK);
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, bravo).techRewardsCents).toBe(5280);
      expect(await notesOf(run.id)).toEqual([stayWaits('Sample Alpha',
        'no paycheck can be worked out for them on this pay run (check their pay rate, and the tax tables for the pay date)')]);
    });

    it('follows the pay on file while it is open: a recompute works the amount out again, and finalize pays that amount', async () => {
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      const run = await draft(EARLY_WEEK);
      const first = await lineOf(alpha);
      expect(first.amount_cents).toBe(5280);
      await paidWeek(alpha, '2026-10-26'); // one more paid week of the 12 months
      const again = await recompute(run.id);
      const second = await lineOf(alpha);
      expect([second.id, second.amount_cents, second.note]).toEqual([first.id, 7040, `2% of $3,520.00, ${PERIOD}`]);
      expect(checkOf(again, alpha).techRewardsCents).toBe(7040);
      await finalize(run.id);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', amount_cents: 7040 });
    });

    it('is keyed by the milestone, not by its date: a hire date corrected while the line is open moves it, and one corrected after it is paid never pays the milestone again', async () => {
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      const run = await draft(EARLY_WEEK);
      const first = await lineOf(alpha);
      await trx('technicians').where({ id: alpha }).update({ hire_date: '2025-11-26' });
      await recompute(run.id);
      const moved = await lineOf(alpha);
      expect([moved.id, moved.source_id, dateOf(moved.covers_from), dateOf(moved.covers_to), moved.note])
        .toEqual([first.id, `stay_bonus:${alpha}:1`, '2025-11-26', '2026-11-25', '2% of $2,640.00, the pay earned Nov 26, 2025 to Nov 25, 2026']);
      await finalize(run.id);
      // paid. The hire date is corrected again, to one whose anniversary (Dec 10) the next run is dated for.
      await trx('technicians').where({ id: alpha }).update({ hire_date: '2025-12-10' });
      await approvedWeek(alpha, GIFT_WEEK);
      const next = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(1);
      expect(await lineOf(alpha)).toMatchObject({ id: first.id, status: 'paid', amount_cents: 5280 });
      expect(checkOf(next, alpha)).not.toHaveProperty('techRewardsCents');
      expect(await notesOf(next.id)).toEqual([]);
      // what the scoreboard asks of payroll (its own suite covers what it shows): the 1 year milestone is settled, so no run
      // dated inside the new anniversary's 60 days can write it
      expect(await stayBonusStatus(trx, alpha, '2025-12-10', '2026-12-20')).toEqual({ settledKeys: ['1'], payableKeys: [] });
    });

    // PostgreSQL's date type holds the year 20251 (one key too many in a date box), infinity, and a date BC, which prints in
    // YYYY-MM-DD with no era: '2025-11-24 BC' would read as the day Alpha's 1 year bonus is worked out from.
    it.each(['20251-11-24', '2025-11-24 BC', '0099-11-24', 'infinity'])('reads a hire date the calendar cannot read (%s) as none: the rest of the run goes on, and every run says so until it is corrected', async (unreadable) => {
      const alpha = await stayTech('Sample Alpha', { hire_date: unreadable });
      const bravo = await stayTech('Sample Bravo');
      for (const id of [alpha, bravo]) {
        await paidWeeks(id);
        await approvedWeek(id, EARLY_WEEK);
      }
      const run = await draft(EARLY_WEEK);
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, alpha)).toMatchObject({ grossCents: 88000 });
      expect(checkOf(run, bravo).techRewardsCents).toBe(5280);
      const unread = 'Stay bonus for Sample Alpha waits: their hire date on file is not a date the pay run can read, so correct it on their staff profile';
      expect(await notesOf(run.id)).toEqual([unread]);
      expect((await syncEventOf(run.id, 'waits')).flatMap((m) => m.waits)).toContainEqual({
        technician_id: alpha, kind: 'stay_bonus', source_id: null, reason: 'hire_date_invalid', week: null,
      });
      // corrected: the note goes with the date, and the next sync writes the bonus
      await trx('technicians').where({ id: alpha }).update({ hire_date: HIRED });
      expect(await notesOf(run.id)).toEqual([]);
      const again = await recompute(run.id);
      expect(checkOf(again, alpha).techRewardsCents).toBe(5280);
      expect(await notesOf(run.id)).toEqual([]);
      // a line that is open when the date turns unreadable comes off, and the run is finalized with the others' lines
      await trx('technicians').where({ id: alpha }).update({ hire_date: unreadable });
      await recompute(run.id);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([unread]);
      await finalize(run.id);
      expect(await lineOf(bravo)).toMatchObject({ status: 'paid', amount_cents: 5280 });
      // a finalized run is never worked out again, and this wait has no last pay date to state: it shows no note
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('holds the gift of a technician whose hire date is not a calendar date too, with its own note and last pay date', async () => {
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      const alpha = await readyTech('Sample Alpha', { hire_date: '20240-01-10' });
      const bravo = await readyTech('Sample Bravo'); // hired Jan 10, 2024: no stay bonus is dated for this run
      for (const id of [alpha, bravo]) await approvedWeek(id, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, bravo).techRewardsCents).toBe(GIFT);
      const why = 'their hire date on file is not a date the pay run can read, so correct it on their staff profile';
      expect(await notesOf(run.id)).toEqual([waits('Sample Alpha', why), `Stay bonus for Sample Alpha waits: ${why}`]);
      await finalize(run.id);
      expect(await notesOf(run.id)).toEqual([missed('Sample Alpha')]);
    });

    it('takes an open line off when its technician has left, or has no hire date on file any more', async () => {
      const alpha = await stayTech('Sample Alpha');
      const bravo = await stayTech('Sample Bravo');
      for (const id of [alpha, bravo]) await paidWeeks(id);
      const run = await draft(EARLY_WEEK);
      expect([await linesOf(alpha), await linesOf(bravo)].map((lines) => lines.length)).toEqual([1, 1]);
      await trx('technicians').where({ id: alpha }).update({ employment_status: 'inactive' });
      await trx('technicians').where({ id: bravo }).update({ hire_date: null });
      await recompute(run.id);
      expect([await linesOf(alpha), await linesOf(bravo)].map((lines) => lines.length)).toEqual([0, 0]);
      const skipped = (await syncEvents()).flatMap((e) => e.metadata.skipped || []);
      expect(skipped).toContainEqual({ technician_id: alpha, kind: 'stay_bonus', reason: 'not_active' });
      expect(skipped).toContainEqual({ technician_id: bravo, kind: 'stay_bonus', reason: 'not_due_in_this_run' });
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('holds the automatic bonus for review when a stay bonus line the pay run did not write is on file', async () => {
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      const [made] = await trx('payroll_pay_lines').insert({
        technician_id: alpha, kind: 'stay_bonus', amount_cents: 12345, earned_week_start: EARLY_WEEK,
      }).returning('id');
      const run = await draft(EARLY_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(checkOf(run, alpha).techRewardsCents).toBe(12345); // the hand-made line rides on the check as before
      expect(await notesOf(run.id)).toEqual([stayWaits('Sample Alpha',
        'a stay bonus line that the pay run did not write is already on file for them, so check that line first')]);
      await trx('payroll_pay_lines').where({ id: made.id || made }).del();
      const again = await recompute(run.id);
      expect(checkOf(again, alpha).techRewardsCents).toBe(5280);
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('has its own gate: off takes only the open stay bonus line off, and the December gift follows its own gate', async () => {
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      const kinds = async () => (await linesOf(alpha)).map((line) => [line.kind, line.status, line.amount_cents]);
      // dated Dec 18: the gift date, and inside the 60 days of the stay bonus. The gift is no part of the bonus's base.
      const run = await draft(GIFT_WEEK);
      expect(await kinds()).toEqual([['december_gift', 'open', GIFT], ['stay_bonus', 'open', 5280]]);
      expect(checkOf(run, alpha).techRewardsCents).toBe(GIFT + 5280);
      const stayLine = (await linesOf(alpha))[1];
      delete process.env[STAY_GATE];
      const off = await recompute(run.id);
      expect(await kinds()).toEqual([['december_gift', 'open', GIFT]]);
      expect(checkOf(off, alpha).techRewardsCents).toBe(GIFT);
      expect((await syncEventOf(run.id, 'gate')).map((m) => m.removed_line_ids)).toEqual([[stayLine.id]]);
      process.env[STAY_GATE] = 'true';
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      await recompute(run.id);
      expect(await kinds()).toEqual([['stay_bonus', 'open', 5280]]);
      process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
      await recompute(run.id);
      await finalize(run.id);
      expect(await kinds()).toEqual([['december_gift', 'paid', GIFT], ['stay_bonus', 'paid', 5280]]);
      // paid lines stay with both gates off
      delete process.env[STAY_GATE];
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      await approvedWeek(alpha, NEXT_WEEK);
      await draft(NEXT_WEEK);
      expect(await kinds()).toEqual([['december_gift', 'paid', GIFT], ['stay_bonus', 'paid', 5280]]);
    });

    it('with its gate off writes no line and shows no note', async () => {
      delete process.env[STAY_GATE];
      const alpha = await stayTech('Sample Alpha');
      await approvedWeek(alpha, EARLY_WEEK);
      const run = await draft(EARLY_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual([]);
      expect(await syncEvents()).toEqual([]);
    });

    it('reads and locks only the technicians a stay bonus is dated for', async () => {
      const alpha = await stayTech('Sample Alpha');
      const other = await readyTech('Sample Other');
      await paidWeeks(alpha);
      await approvedWeek(other, '2026-06-01');
      const watch = async (work) => {
        const statements = [];
        const listen = (query) => statements.push({ sql: String(query.sql), bindings: query.bindings || [] });
        database.on('query', listen);
        try {
          await work();
        } finally {
          database.removeListener('query', listen);
        }
        return statements.filter(({ sql }) => /from "technicians" where .*"employment_status" = .* for share/is.test(sql));
      };
      // a run dated Jun 12: no stay bonus is due, and no technician row is locked
      expect(await watch(() => draft('2026-06-01'))).toEqual([]);
      // a run dated Dec 11: only the technician with the anniversary is read FOR SHARE
      const locked = await watch(() => draft(EARLY_WEEK));
      expect(locked).toHaveLength(1);
      expect(locked[0].bindings).toContain(alpha);
      expect(locked[0].bindings).not.toContain(other);
    });

    it('holds the pay runs it counted: a run of an earlier tax year in the 12 months is not voided before the run that paid the bonus', async () => {
      const alpha = await stayTech('Sample Alpha');
      const bravo = await stayTech('Sample Bravo', { hire_date: '2023-11-24' }); // 3 years: the same 12 months
      for (const id of [alpha, bravo]) await paidWeeks(id);
      const inside = await paidWeek(alpha, '2025-12-01'); // a 2025 run in the 12 months (pay date Dec 12, 2025)
      const before = await paidWeek(bravo, '2025-11-10'); // a 2025 run before them (pay date Nov 21, 2025)
      const run = await draft(EARLY_WEEK);
      expect(checkOf(run, alpha).techRewardsCents).toBe(7040); // 2% of 4 x 880.00
      await finalize(run.id);
      // the run before the 12 months was not counted: it is voided as before
      await voidRun(before);
      // the run inside them was. The tax year's own order does not hold it (no later 2025 check), the bonus does: gate on or off
      expect(await refusedVoid(inside)).toEqual(HELD);
      delete process.env[STAY_GATE];
      expect(await refusedVoid(inside)).toEqual(HELD);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', amount_cents: 7040 });
      // the run that paid the bonus goes first and takes the bonus line with it; then the earlier run goes
      await voidRun(run.id);
      expect(await linesOf(alpha)).toHaveLength(0);
      await voidRun(inside);
      // the week is drafted again: the bonus is worked out from the pay that is left
      process.env[STAY_GATE] = 'true';
      const again = await draft(EARLY_WEEK);
      expect(checkOf(again, alpha).techRewardsCents).toBe(5280);
    });

    it('holds only the paychecks that put pay into the bonus: one of an edge week whose paid days all fall before the 12 months is voided freely', async () => {
      // 3 years on Sat Nov 28, 2026: the 12 months run Fri Nov 28, 2025 to Fri Nov 27, 2026, and the week of Nov 24, 2025 holds
      // their first three days
      const alpha = await stayTech('Sample Alpha', { hire_date: '2023-11-28' });
      await paidWeeks(alpha);
      // that week's check (a 2025 run): 880.00, all of it worked Monday to Thursday, before the 12 months
      await approvedWeek(alpha, '2025-11-24');
      await trx('time_entry_daily_summary').insert(['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27']
        .map((workDate) => ({ technician_id: alpha, work_date: workDate, total_shift_minutes: 600, unpaid_meal_minutes: 0, status: 'approved' })));
      const edge = await paidWeek(alpha, '2025-11-24');
      const edgeCheck = await trx('payroll_checks').where({ run_id: edge, technician_id: alpha }).first('id');
      await approvedWeek(alpha, EARLY_WEEK);
      const run = await draft(EARLY_WEEK);
      // 4% of 3 x 880.00: the edge week adds nothing (3 of its 7 days with no day records would add 377.14)
      expect(checkOf(run, alpha).techRewardsCents).toBe(10560);
      await finalize(run.id);
      const line = await lineOf(alpha);
      expect(line).toMatchObject({ status: 'paid', amount_cents: 10560 });
      expect(line.counted_check_ids).toHaveLength(3);
      expect(line.counted_check_ids).not.toContain(edgeCheck.id);
      // the edge run was read and put nothing into the bonus: no later 2025 check holds it, and the paid bonus does not either
      await voidRun(edge);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', amount_cents: 10560 });
    });

    it('holds a counted run whatever the pay dates: a week of the 12 months whose check is dated in the next tax year, finalized before a December bonus', async () => {
      const alpha = await stayTech('Sample Alpha');
      // the week of Nov 16 was paid late: its check is dated Jan 4, 2027, and it was final before the bonus's run
      await trx('payroll_runs').insert({ week_start: '2026-11-16', pay_date: '2027-01-04', status: 'finalized' });
      for (const week of ['2026-11-02', '2026-11-09']) await paidWeek(alpha, week);
      const lateRun = await paidWeek(alpha, '2026-11-16', { pay_date: '2027-01-04' });
      const counted = await checkIdsOf(alpha);
      const run = await draft(EARLY_WEEK); // dated Dec 11, 2026: the tax year's order does not link it to a 2027 check
      expect(checkOf(run, alpha).techRewardsCents).toBe(5280);
      await finalize(run.id);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid', counted_check_ids: counted });
      // the bonus's check has the EARLIER pay date, and the run it counted is still held
      expect(await refusedVoid(lateRun)).toEqual(HELD);
      await voidRun(run.id);
      await voidRun(lateRun);
    });

    it('keeps the record of a stay bonus: the migration is not rolled back while a line, open or paid, holds its counted checks', async () => {
      const migration = require('../models/migrations/20261121180000_pay_line_counted_checks');
      const refused = 'This migration is not rolled back while one does';
      const alpha = await stayTech('Sample Alpha');
      await paidWeeks(alpha);
      const run = await draft(EARLY_WEEK);
      // an OPEN line: the release before the column would carry it forward as a hand-made line and pay its old amount
      expect(await lineOf(alpha)).toMatchObject({ status: 'open' });
      const statements = [];
      const listen = (query) => statements.push(String(query.sql));
      database.on('query', listen);
      try {
        await expect(migration.down(trx)).rejects.toThrow(refused);
      } finally {
        database.removeListener('query', listen);
      }
      // the payroll lock is taken before the lines are read, so no pay run write slips in between the read and the drop
      const lockAt = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock('));
      const readAt = statements.findIndex((sql) => sql.includes('from "payroll_pay_lines"'));
      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(readAt).toBeGreaterThan(lockAt);
      expect(statements.some((sql) => /drop column/i.test(sql))).toBe(false);
      // a PAID line: its list is the evidence the void guard reads
      await finalize(run.id);
      expect(await lineOf(alpha)).toMatchObject({ status: 'paid' });
      expect((await lineOf(alpha)).counted_check_ids).toHaveLength(3);
      await expect(migration.down(trx)).rejects.toThrow(refused);
      expect(await trx.schema.hasColumn('payroll_pay_lines', 'counted_check_ids')).toBe(true);
    });
  });
});
