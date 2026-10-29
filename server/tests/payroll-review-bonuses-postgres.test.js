// Real PostgreSQL transactions (rolled back): earned Google review bonuses
// (review_incentive_payouts) flow into pay runs as review bonus pay lines, behind
// GATE_PAYROLL_REVIEW_BONUS_IMPORT (which needs GATE_PAYROLL_PAY_LINES). The lines are
// derived data, re-synced when a run is drafted, recomputed and finalized: a bonus the owner
// marked paid by hand or moved to another technician is never paid by payroll too, finalize
// marks the payout paid, void puts it back, and with the gates off nothing changes.
// All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
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
const { markPaid } = require('../services/review-incentives');
const { markPayoutsPaid } = require('../services/payroll-review-bonuses');

jest.setTimeout(60000);

// Finished staff weeks in 2026 (Monday dates). Pay dates default to the Friday after.
const W1 = '2026-09-14'; // runs through Sunday 2026-09-20
const W2 = '2026-09-21';
const W3 = '2026-09-28';

const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_PAY_LINES', 'GATE_PAYROLL_REVIEW_BONUS_IMPORT', 'GATE_PAYROLL_FORM_FIGURES',
  'GATE_PAYROLL_TIME_OFF', 'GATE_SHIFT_CLOSE_REVIEW'];

postgres('payroll review bonus import', () => {
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
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '22.00', ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const approvedWeek = (technicianId, weekStart) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: '2400.00', overtime_minutes: '0.00',
  });
  const payout = async (technicianId, earnedAt, patch = {}) => {
    const [row] = await trx('review_incentive_payouts').insert({
      technician_id: technicianId, amount_cents: 500, earned_at: earnedAt, status: 'earned', source: 'google_review', ...patch,
    }).returning('id');
    return row && row.id ? row.id : row;
  };
  const payoutRow = (id) => trx('review_incentive_payouts').where({ id }).first();
  const api = async (method, path, { body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const draft = (weekStart) => api('POST', '/runs', { body: { weekStart } });
  const recompute = (runId) => api('POST', `/runs/${runId}/recompute`);
  const finalizeWith = (runId, token) => api('POST', `/runs/${runId}/finalize`, { body: { token } });
  const finalize = async (runId) => {
    const shown = await api('GET', `/runs/${runId}`);
    return finalizeWith(runId, shown.body.run.token);
  };
  const voidRun = (runId) => api('POST', `/runs/${runId}/void`, { body: { reason: 'Sample correction' } });
  const byName = (run, name) => run.checks.find((c) => c.name === name);
  const importedLines = () => trx('payroll_pay_lines').where({ source_type: 'review_incentive_payout' }).orderBy('created_at').orderBy('id');
  const syncEvents = () => trx('audit_log').where({ action: 'payroll.review_bonus_lines_synced' });

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
    process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT = 'true';
    delete process.env.GATE_PAYROLL_FORM_FIGURES;
    delete process.env.GATE_PAYROLL_TIME_OFF;
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
  });
  afterEach(async () => {
    await trx.rollback();
    for (const name of GATES) {
      if (OLD[name] === undefined) delete process.env[name]; else process.env[name] = OLD[name];
    }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('with the import gate on', () => {
    it('imports earned bonuses of a W-2 technician up to the week end, once, by Eastern date', async () => {
      const id = await readyTech('Sample Alpha');
      const contractor = await readyTech('Sample Contractor', { employment_type: '1099' });
      await approvedWeek(id, W1);
      // 2026-09-21 02:00Z is Sunday 22:00 Eastern: the week of 2026-09-14.
      const lateSunday = await payout(id, '2026-09-21T02:00:00Z');
      const midweek = await payout(id, '2026-09-16T15:00:00Z', { amount_cents: 700 });
      const nextWeek = await payout(id, '2026-09-28T12:00:00Z');
      const paidAlready = await payout(id, '2026-09-15T15:00:00Z', { status: 'paid', paid_at: new Date() });
      const contractorPayout = await payout(contractor, '2026-09-16T15:00:00Z');

      const created = await draft(W1);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(check).toMatchObject({ reviewBonusCents: 1200, regularPayCents: 88000, grossCents: 89200 });

      const lines = await importedLines();
      expect(lines.map((l) => l.source_id).sort()).toEqual([lateSunday, midweek].sort());
      for (const line of lines) {
        expect(line).toMatchObject({
          technician_id: id, kind: 'review_bonus', status: 'open', note: 'Google review bonus', created_by: null,
          source_type: 'review_incentive_payout',
        });
      }
      expect(Object.fromEntries(lines.map((l) => [l.source_id, l.amount_cents]))).toEqual({ [lateSunday]: 500, [midweek]: 700 });
      const weeks = await trx.raw("select to_char(earned_week_start, 'YYYY-MM-DD') as w from payroll_pay_lines where source_type = 'review_incentive_payout'");
      expect(weeks.rows.map((r) => r.w)).toEqual([W1, W1]);
      expect(await trx('payroll_pay_lines').whereIn('source_id', [nextWeek, paidAlready, contractorPayout]).first()).toBeUndefined();

      // The audit event holds ids and counts, never an amount.
      const events = await syncEvents();
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({ week_end: '2026-09-20', added_count: 2, removed_count: 0 });
      expect(events[0].metadata.added_payout_ids.sort()).toEqual([lateSunday, midweek].sort());
      // Payout ids are random and can hold '700' by chance (#7018 CI), so blank them first.
      const metaText = JSON.stringify(events[0].metadata)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
      expect(metaText).not.toMatch(/700|amount/);

      // A second recompute adds nothing and writes no second event.
      const again = await recompute(created.body.run.id);
      expect(again.status).toBe(200);
      expect(byName(again.body.run, 'Sample Alpha').reviewBonusCents).toBe(1200);
      expect(await importedLines()).toHaveLength(2);
      expect(await syncEvents()).toHaveLength(1);
      // Once the first run is final, the next week's run does not pay its two bonuses again,
      // and the one earned in the week of 2026-09-28 waits for its own week.
      expect((await finalize(created.body.run.id)).status).toBe(200);
      await approvedWeek(id, W2);
      const second = await draft(W2);
      expect(second.status).toBe(201);
      expect(byName(second.body.run, 'Sample Alpha').reviewBonusCents).toBe(0);
      await approvedWeek(id, W3);
      const third = await draft(W3);
      expect(byName(third.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);
    });

    it('marks the payout paid on finalize, puts it back on void, and pays it again on the next run', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      const done = await finalize(created.body.run.id);
      expect(done.status).toBe(200);
      expect(byName(done.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);

      const [line] = await importedLines();
      expect(line).toMatchObject({ status: 'paid', check_id: byName(done.body.run, 'Sample Alpha').id });
      const paid = await payoutRow(bonus);
      expect(paid).toMatchObject({ status: 'paid', paid_by: ADMIN_ID });
      expect(paid.paid_at).toBeInstanceOf(Date);

      const voided = await voidRun(created.body.run.id);
      expect(voided.status).toBe(200);
      expect((await importedLines())[0]).toMatchObject({ status: 'open', check_id: null });
      expect(await payoutRow(bonus)).toMatchObject({ status: 'earned', paid_at: null, paid_by: null });

      const next = await draft(W1);
      expect(next.status).toBe(201);
      expect(byName(next.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);
      expect(await importedLines()).toHaveLength(1);
      expect((await finalize(next.body.run.id)).status).toBe(200);
      expect((await payoutRow(bonus)).status).toBe('paid');
    });

    it('drops the line of a bonus the owner marked paid by hand, and the run does not pay it', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const kept = await payout(id, '2026-09-15T15:00:00Z');
      const byHand = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha').reviewBonusCents).toBe(1000);

      expect(await markPaid([byHand], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 1 });
      const recomputed = await recompute(created.body.run.id);
      expect(byName(recomputed.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);
      expect((await importedLines()).map((l) => l.source_id)).toEqual([kept]);
      const events = await syncEvents();
      expect(events).toHaveLength(2);
      expect(events[1].metadata).toMatchObject({ added_count: 0, removed_count: 1, removed_payout_ids: [byHand] });

      const done = await finalize(created.body.run.id);
      expect(done.status).toBe(200);
      expect(byName(done.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);
      // The hand payment is untouched: still paid by the admin who marked it, not by payroll.
      expect(await payoutRow(byHand)).toMatchObject({ status: 'paid', paid_by: ADMIN_ID });
      expect((await payoutRow(kept)).status).toBe('paid');
    });

    it('refuses to finalize a draft whose bonus was marked paid by hand since, and pays nothing', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      const reviewed = (await api('GET', `/runs/${created.body.run.id}`)).body.run.token;

      await markPaid([bonus], { conn: trx, paidBy: ADMIN_ID });
      const stale = await finalizeWith(created.body.run.id, reviewed);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/Hours or settings changed/);
      expect(await importedLines()).toHaveLength(0);
      const shown = (await api('GET', `/runs/${created.body.run.id}`)).body.run;
      expect(shown.status).toBe('draft');
      expect(byName(shown, 'Sample Alpha').reviewBonusCents).toBe(0);
      expect(await payoutRow(bonus)).toMatchObject({ status: 'paid', paid_by: ADMIN_ID });
    });

    it('refuses to finalize a draft whose bonus changed since, shows the new numbers, and pays nothing', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      const reviewed = (await api('GET', `/runs/${created.body.run.id}`)).body.run.token;

      await trx('review_incentive_payouts').where({ id: bonus }).update({ amount_cents: 900 });
      const stale = await finalizeWith(created.body.run.id, reviewed);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/Hours or settings changed/);
      const shown = (await api('GET', `/runs/${created.body.run.id}`)).body.run;
      expect(shown.status).toBe('draft');
      expect(byName(shown, 'Sample Alpha').reviewBonusCents).toBe(900);
      expect((await payoutRow(bonus)).status).toBe('earned');
      expect((await importedLines())[0]).toMatchObject({ status: 'open', amount_cents: 900 });
      // The second look is the one that can be finalized.
      expect((await finalize(created.body.run.id)).status).toBe(200);
      expect((await payoutRow(bonus)).status).toBe('paid');
    });

    it('moves the line with a bonus moved to another technician', async () => {
      const first = await readyTech('Sample Alpha');
      const second = await readyTech('Sample Bravo');
      await approvedWeek(first, W1);
      await approvedWeek(second, W1);
      const bonus = await payout(first, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);

      await trx('review_incentive_payouts').where({ id: bonus }).update({ technician_id: second });
      const recomputed = await recompute(created.body.run.id);
      expect(byName(recomputed.body.run, 'Sample Alpha').reviewBonusCents).toBe(0);
      expect(byName(recomputed.body.run, 'Sample Bravo').reviewBonusCents).toBe(500);
      expect((await importedLines()).map((l) => [l.source_id, l.technician_id])).toEqual([[bonus, second]]);
      expect((await finalize(created.body.run.id)).status).toBe(200);
      expect(await payoutRow(bonus)).toMatchObject({ status: 'paid', technician_id: second });
    });

    it('refuses a finalize whose payout is no longer earned, and rolls back', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      const check = byName(created.body.run, 'Sample Alpha');
      const [line] = await importedLines();
      await trx('payroll_pay_lines').where({ id: line.id }).update({ status: 'paid', check_id: check.id });
      await trx('review_incentive_payouts').where({ id: bonus }).update({ status: 'paid' });
      const error = await trx.transaction(async (inner) => markPayoutsPaid(inner, created.body.run.id, ADMIN_ID)).catch((err) => err);
      expect(error).toMatchObject({ status: 409, message: 'A review bonus changed while the run was finalized. Review the new numbers.' });
      expect((await payoutRow(bonus)).paid_by).toBeNull();
    });
  });

  describe('payout sources', () => {
    it('never imports a legacy review_request payout, and drops a line that points at one', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const legacy = await payout(id, '2026-09-16T15:00:00Z', { source: 'review_request' });
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha').reviewBonusCents).toBe(0);
      expect(await importedLines()).toHaveLength(0);
      // A line that points at one (written by hand) comes off at the next recompute.
      await trx('payroll_pay_lines').insert({
        technician_id: id, kind: 'review_bonus', amount_cents: 500, earned_week_start: W1,
        source_type: 'review_incentive_payout', source_id: legacy, note: 'Sample',
      });
      const recomputed = await recompute(created.body.run.id);
      expect(byName(recomputed.body.run, 'Sample Alpha').reviewBonusCents).toBe(0);
      expect(await importedLines()).toHaveLength(0);
      expect((await payoutRow(legacy)).status).toBe('earned');
    });
  });

  describe('with the import gate off', () => {
    it('imports nothing, and still drops an imported line whose payout was marked paid by hand', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const imported = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);

      delete process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT;
      const later = await payout(id, '2026-09-17T15:00:00Z');
      await markPaid([imported], { conn: trx, paidBy: ADMIN_ID });
      const recomputed = await recompute(created.body.run.id);
      expect(byName(recomputed.body.run, 'Sample Alpha').reviewBonusCents).toBe(0);
      expect(await importedLines()).toHaveLength(0);
      expect(await trx('payroll_pay_lines').where({ source_id: later }).first()).toBeUndefined();
    });

    it('takes every open imported line off the next run, even one whose payout is still earned', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect(await importedLines()).toHaveLength(1);
      delete process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT;
      // Finalizing the old numbers is refused: the line came off, so the draft is stale.
      expect((await finalize(created.body.run.id)).status).toBe(409);
      expect(await importedLines()).toHaveLength(0);
      const shown = (await api('GET', `/runs/${created.body.run.id}`)).body.run;
      expect(byName(shown, 'Sample Alpha').reviewBonusCents).toBe(0);
      expect((await payoutRow(bonus)).status).toBe('earned');
    });

    it('still reopens the payout of a line a run paid when that run is voided', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect((await finalize(created.body.run.id)).status).toBe(200);
      expect((await payoutRow(bonus)).status).toBe('paid');
      delete process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT;
      expect((await voidRun(created.body.run.id)).status).toBe(200);
      expect((await payoutRow(bonus)).status).toBe('earned');
    });
  });

  describe('with the pay lines gate off', () => {
    it('runs no sync: nothing imported, an imported line left alone, no audit event', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      delete process.env.GATE_PAYROLL_PAY_LINES;
      const created = await draft(W1);
      expect(created.status).toBe(201);
      const check = byName(created.body.run, 'Sample Alpha');
      expect(check).toMatchObject({ regularPayCents: 88000, grossCents: 88000 });
      expect(check).not.toHaveProperty('reviewBonusCents');
      expect(await importedLines()).toHaveLength(0);
      expect(await syncEvents()).toHaveLength(0);
      expect((await finalize(created.body.run.id)).status).toBe(200);
      expect((await payoutRow(bonus)).status).toBe('earned');
    });

    it('leaves an open imported line alone, whatever happened to its payout', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect(await importedLines()).toHaveLength(1);
      delete process.env.GATE_PAYROLL_PAY_LINES;
      await markPaid([bonus], { conn: trx, paidBy: ADMIN_ID });
      expect((await recompute(created.body.run.id)).status).toBe(200);
      expect(await importedLines()).toHaveLength(1);
      expect(await syncEvents()).toHaveLength(1);
    });
  });
});
