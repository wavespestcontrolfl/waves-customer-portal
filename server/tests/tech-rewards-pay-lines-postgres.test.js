// Real PostgreSQL transactions (rolled back): Tech Rewards Plan D5-5, the December gift as a pay line on pay runs, behind
// GATE_TECH_REWARDS_PAY_LINES (which needs GATE_PAYROLL_PAY_LINES). The line is derived data, written and worked out again when a
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
const { syncTechRewardLines } = require('../services/tech-rewards-pay-lines');
const { techRewardsOwnKey, techRewardsOwnedSql } = require('../services/payroll-pay-lines');
const { workedWeeks } = require('../services/payroll-runs');
const { staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

jest.setTimeout(60000);

// Staff weeks (Mondays). A pay run is chosen by the date on its checks; the default pay date is the Friday after the week ends.
const EARLY_WEEK = '2026-11-30'; // pay date Fri Dec 11, before the gift date
const GIFT_WEEK = '2026-12-07'; // pay date Fri Dec 18, the last Friday on or before Dec 20
const NEXT_WEEK = '2026-12-14'; // pay date Fri Dec 25
const NOW = Date.parse('2027-01-05T17:00:00Z'); // every week above has ended

const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_PAY_LINES', 'GATE_TECH_REWARDS_PAY_LINES', 'GATE_PAYROLL_FORM_FIGURES',
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
  const paidWeek = async (technicianId, weekStart) => {
    let id = (await trx('payroll_runs').where({ week_start: weekStart, status: 'finalized' }).first('id'))?.id;
    if (!id) {
      [id] = (await trx('payroll_runs').insert({ week_start: weekStart, pay_date: addDays(weekStart, 11), status: 'finalized' }).returning('id')).map((r) => r.id);
    }
    await trx('payroll_checks').insert({
      run_id: id, technician_id: technicianId, employee_name: 'Sample History', week_start: weekStart, pay_date: addDays(weekStart, 11),
      hourly_rate: 22, regular_minutes: 2400, overtime_minutes: 0, gross_cents: 88000, regular_pay_cents: 88000, overtime_pay_cents: 0,
      overtime_premium_cents: 0, federal_income_tax_cents: 0, social_security_cents: 0, medicare_cents: 0, additional_medicare_cents: 0,
      net_cents: 0, employer_social_security_cents: 0, employer_medicare_cents: 0, futa_cents: 0, fl_reemployment_cents: 0,
      ytd_gross_before_cents: 0, calc_snapshot: '{}', pay_method: 'check', status: 'finalized',
    });
    return id;
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

    it('never pays less overtime for a week than one check would: the week\'s own check rounds half up, the gift\'s check rounds up', async () => {
      const tech = await readyTech('Sample Alpha');
      const WEEK = '2026-11-09'; // 45 h worked, 5 of them overtime
      await approvedWeek(tech, WEEK, '2400.00', '300.00');
      // a 6.00 commission earned that week rides on the week's own check: 1/2 x 600 / 45 h x 5 h = 33.33 -> 33
      await trx('payroll_pay_lines').insert({ technician_id: tech, kind: 'commission', amount_cents: 600, earned_week_start: WEEK });
      const own = await draft(WEEK);
      expect(checkOf(own, tech)).toMatchObject({ commissionCents: 600, lineOvertimePremiumCents: 33 });
      await finalize(own.id);
      // the gift's share of that week is also 6.00 (30,000 over 50 workweeks). On its own check, months later: 33.33 -> 34
      await approvedWeek(tech, GIFT_WEEK);
      const giftRun = await draft(GIFT_WEEK);
      const check = checkOf(giftRun, tech);
      expect(check).toMatchObject({ techRewardsCents: GIFT, lineOvertimePremiumCents: 34 });
      const stored = await trx('payroll_checks').where({ id: check.id }).first();
      expect(stored.calc_snapshot.lineOvertimeWeeks.find((w) => w.weekStart === WEEK).premiumCents).toBe(34);
      // one check with both lines would owe 1/2 x 1,200 / 45 h x 5 h = 66.67 -> 67; the two checks pay 33 + 34
      expect(33 + check.lineOvertimePremiumCents).toBeGreaterThanOrEqual(67);
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
      const rows = await trx('payroll_pay_lines').where({ kind: 'december_gift' }).orderBy('amount_cents');
      expect(rows.map((r) => [r.technician_id, Number(r.amount_cents), r.status])).toEqual([
        [alpha, 12345, 'open'], [bravo, 12345, 'paid'], [delta, GIFT, 'open'],
      ]);
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
      const handMade = async () => (await trx('payroll_pay_lines').whereIn('id', [a.id || a, z.id || z]).orderBy('amount_cents').orderBy('technician_id'))
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
});
