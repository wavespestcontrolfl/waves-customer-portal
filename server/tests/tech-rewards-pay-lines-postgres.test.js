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
  const syncEvents = () => trx('audit_log').where({ action: 'payroll.tech_rewards_lines_synced' }).orderBy('created_at');
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
      const run = await draft(GIFT_WEEK);
      const line = await lineOf(alpha);
      expect(line).toMatchObject({ kind: 'december_gift', status: 'open', amount_cents: GIFT, source_id: `december_gift:${alpha}:2026` });
      expect([dateOf(line.earned_week_start), dateOf(line.covers_from), dateOf(line.covers_to)]).toEqual([GIFT_WEEK, '2026-01-01', '2026-12-13']);
      expect(run.payDate).toBe('2026-12-18'); // the last Friday on or before Dec 20
      expect((await lineOf(beta)).amount_cents).toBe(GIFT);
      expect(await linesOf(gone)).toHaveLength(0);
      expect(await linesOf(late)).toHaveLength(0);
      expect(await linesOf(office)).toHaveLength(0);
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
      // a paid line is evidence: a later run, and a direct sync, never write the gift again
      await approvedWeek(tech, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      expect(checkOf(next, tech)).not.toHaveProperty('techRewardsCents');
      expect(await linesOf(tech)).toHaveLength(1);
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

    it('takes an open line off when its technician has left before it was paid', async () => {
      const alpha = await readyTech('Sample Alpha');
      const bravo = await readyTech('Sample Bravo');
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(1);
      await trx('technicians').where({ id: alpha }).update({ employment_status: 'inactive' });
      await recompute(run.id);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect(await linesOf(bravo)).toHaveLength(1);
    });

    it('writes no gift, and still drafts the run, when an old week from before the gift year is paid on the gift date', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, '2025-12-15');
      const run = await draft('2025-12-15', '2026-12-18');
      expect(run.payDate).toBe('2026-12-18');
      expect(await linesOf(tech)).toHaveLength(0);
      expect(checkOf(run, tech)).not.toHaveProperty('techRewardsCents');
      expect((await syncEvents()).flatMap((e) => e.metadata.skipped || []))
        .toContainEqual({ technician_id: tech, kind: 'december_gift', reason: 'pay_week_before_gift_year' });
    });
  });

  describe('a gift that is not ready waits and never holds the run', () => {
    it('waits, with a note, while an earlier week of the year is approved and has no finalized check; the next run claims it', async () => {
      const alpha = await readyTech('Sample Alpha');
      const bravo = await readyTech('Sample Bravo');
      await approvedWeek(alpha, '2026-11-02'); // approved, never paid
      await approvedWeek(alpha, GIFT_WEEK);
      await approvedWeek(bravo, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect((await lineOf(bravo)).amount_cents).toBe(GIFT);
      expect([run.waiting, run.blocked]).toEqual([[], []]); // no gift line, so the pay run's covered-week guard has nothing to hold
      expect(await notesOf(run.id)).toEqual(['December gift for Sample Alpha waits: the week of Nov 2, 2026 is not paid yet']);
      // the wait does not stop the run: both checks finalize, Bravo's with the gift and Alpha's without
      const final = await finalize(run.id);
      expect(checkOf(final, bravo).techRewardsCents).toBe(GIFT);
      expect(checkOf(final, alpha)).not.toHaveProperty('techRewardsCents');
      // the week is paid: the next run (dated Dec 25) writes Alpha's gift
      await paidWeek(alpha, '2026-11-02');
      await approvedWeek(alpha, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      expect(checkOf(next, alpha).techRewardsCents).toBe(GIFT);
      expect(await notesOf(next.id)).toEqual([]);
      expect(await notesOf(run.id)).toEqual([]); // the finalized run no longer says "waits": the gift has its line
      expect(await linesOf(bravo)).toHaveLength(1); // Bravo's paid line is not written again
    });

    it('waits for a shift that has no daily summary yet (a recorded shift is work)', async () => {
      const tech = await readyTech('Sample Alpha');
      await trx('time_entries').insert({ technician_id: tech, entry_type: 'shift', status: 'completed', clock_in: '2026-06-02T13:00:00Z', clock_out: '2026-06-02T21:00:00Z' });
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(tech)).toHaveLength(0);
      expect(await notesOf(run.id)).toEqual(['December gift for Sample Alpha waits: the week of Jun 1, 2026 is not paid yet']);
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
      expect(await notesOf(run.id)).toEqual(['December gift for Sample Alpha waits: the week of May 4, 2026 has a timesheet to approve or an automatic clock-out to review']);
      await trx('time_entries').where({ technician_id: tech }).update({ auto_close_reviewed_at: trx.fn.now() });
      const again = await recompute(run.id);
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
      expect(await notesOf(run.id)).toEqual([]);
    });

    it('waits when no paycheck can be worked out for the technician, so a gift alone never blocks the run', async () => {
      const alpha = await readyTech('Sample Alpha', { pay_rate: null }); // no pay rate, and no hours this week
      const bravo = await readyTech('Sample Bravo');
      await approvedWeek(bravo, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      expect(await linesOf(alpha)).toHaveLength(0);
      expect([run.waiting, run.blocked]).toEqual([[], []]);
      expect(await notesOf(run.id)).toEqual(['December gift for Sample Alpha waits: no paycheck can be worked out for them on this pay run (check the pay rate)']);
      const final = await finalize(run.id);
      expect(checkOf(final, bravo).techRewardsCents).toBe(GIFT);
      expect(checkOf(final, alpha)).toBeUndefined();
      // the pay rate is set: the next run writes the gift
      await trx('technicians').where({ id: alpha }).update({ pay_rate: '22.00' });
      await approvedWeek(bravo, NEXT_WEEK);
      const next = await draft(NEXT_WEEK);
      expect(checkOf(next, alpha)).toMatchObject({ techRewardsCents: GIFT, grossCents: GIFT });
    });

    it('keeps ids, a reason code and a week on the run row, never an amount, and shows no note while the gate is off', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, '2026-11-02');
      await approvedWeek(tech, GIFT_WEEK);
      const run = await draft(GIFT_WEEK);
      const stored = await trx('payroll_runs').where({ id: run.id }).first('tech_rewards_waits');
      expect(stored.tech_rewards_waits).toEqual([{ technician_id: tech, kind: 'december_gift', source_id: `december_gift:${tech}:2026`, reason: 'week_not_paid', week: '2026-11-02' }]);
      const event = (await syncEvents()).at(-1);
      expect(event.metadata.waits).toEqual(stored.tech_rewards_waits);
      expect(JSON.stringify(event.metadata)).not.toContain(String(GIFT));
      delete process.env.GATE_TECH_REWARDS_PAY_LINES;
      expect(await notesOf(run.id)).toEqual([]);
    });
  });

  describe('an open line belongs to the draft run that wrote it', () => {
    it('is paid only by that run: a later run does not pick it up, and voiding the owner frees it for the next run', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, NEXT_WEEK);
      const giftRun = await draft(GIFT_WEEK);
      const gift = await lineOf(tech);
      const next = await draft(NEXT_WEEK); // dated Dec 25, within 60 days of the gift date, but the Dec 7 draft pays first and owns it
      expect(checkOf(next, tech)).not.toHaveProperty('techRewardsCents');
      expect(await lineOf(tech)).toMatchObject({ id: gift.id, status: 'open', check_id: null });
      // void the owning run: the line goes with it and the next run writes it
      await voidRun(next.id);
      await voidRun(giftRun.id);
      expect(await linesOf(tech)).toHaveLength(0);
      const again = await draft(NEXT_WEEK);
      expect(checkOf(again, tech).techRewardsCents).toBe(GIFT);
      await finalize(again.id);
      expect((await lineOf(tech)).status).toBe('paid');
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

    it('goes to the draft that pays first: an earlier-dated run claims it from a later draft, which goes stale', async () => {
      const tech = await readyTech('Sample Alpha');
      await approvedWeek(tech, NEXT_WEEK);
      const later = await draft(NEXT_WEEK); // dated Dec 25: drafted first, it writes the line
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(NEXT_WEEK);
      const laterToken = (await api('GET', `/runs/${later.id}`)).body.run.token;
      const earlier = await draft(GIFT_WEEK); // dated Dec 18: it pays first, so it claims the line
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(GIFT_WEEK);
      expect(checkOf(earlier, tech).techRewardsCents).toBe(GIFT);
      expect(await linesOf(tech)).toHaveLength(1);
      // the later draft still shows the old numbers; finalizing it with that token is refused and it is rebuilt without the line
      const stale = await api('POST', `/runs/${later.id}/finalize`, { body: { token: laterToken } });
      expect(stale.status).toBe(409);
      expect(checkOf((await api('GET', `/runs/${later.id}`)).body.run, tech)).not.toHaveProperty('techRewardsCents');
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(GIFT_WEEK);
    });

    it('goes by pay date, not by week: the later week with the earlier pay date claims it', async () => {
      const tech = await readyTech('Sample Alpha');
      const first = await draft(GIFT_WEEK, '2026-12-31'); // the earlier week, paid late
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(GIFT_WEEK);
      await approvedWeek(tech, NEXT_WEEK);
      const second = await draft(NEXT_WEEK); // dated Dec 25: the first check that can carry the gift
      expect(second.payDate).toBe('2026-12-25');
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(NEXT_WEEK);
      expect(checkOf(second, tech).techRewardsCents).toBe(GIFT);
      expect(await linesOf(tech)).toHaveLength(1);
      // the late-paid draft does not take it back
      await api('POST', `/runs/${first.id}/recompute`);
      expect(dateOf((await lineOf(tech)).earned_week_start)).toBe(NEXT_WEEK);
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

    it('is claimed from a week whose run is final: only a draft run keeps a line from the next run', async () => {
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
      expect([dateOf(line.earned_week_start), dateOf(line.covers_to)]).toEqual([NEXT_WEEK, '2026-12-20']);
      expect(checkOf(next, tech).techRewardsCents).toBe(GIFT);
      expect(await linesOf(tech)).toHaveLength(1);
    });
  });
});
