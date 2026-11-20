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
const {
  markPaid, savePolicy, getDashboard, overCapPayoutIds, getPolicyStrict, lockPayoutRows,
} = require('../services/review-incentives');
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

      expect(await markPaid([byHand], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 1, skippedOverCap: 0 });
      const recomputed = await recompute(created.body.run.id);
      expect(byName(recomputed.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);
      expect((await importedLines()).map((l) => l.source_id)).toEqual([kept]);
      const events = await syncEvents();
      expect(events).toHaveLength(2);
      // syncEvents() has no ORDER BY, so the row order is not insertion order: find the
      // recompute's event by content, never by position.
      expect(events.map((e) => e.metadata)).toContainEqual(expect.objectContaining({ added_count: 0, removed_count: 1, removed_payout_ids: [byHand] }));

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

  // Owner 2026-11-20 D4: an optional monthly cap per technician, counted by Eastern calendar
  // month and computed on read. The cap never changes a payout's status or amount.
  describe('monthly cap', () => {
    const setCap = (cap) => savePolicy({ monthlyCapCount: cap }, trx);
    const lineIds = async () => (await importedLines()).map((l) => l.source_id);

    it('adds no line past the cap, in earned order, and leaves the payouts untouched', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await setCap(2);
      const third = await payout(id, '2026-09-17T15:00:00Z');
      const first = await payout(id, '2026-09-15T15:00:00Z');
      const second = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha').reviewBonusCents).toBe(1000);
      expect((await lineIds()).sort()).toEqual([first, second].sort());
      expect(await payoutRow(third)).toMatchObject({ status: 'earned', amount_cents: 500, paid_at: null });
    });

    it('counts a paid payout first, so a late earlier-dated review cannot push it out', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await setCap(2);
      await payout(id, '2026-09-16T15:00:00Z', { status: 'paid', paid_at: new Date() });
      const earlier = await payout(id, '2026-09-15T15:00:00Z');
      const later = await payout(id, '2026-09-17T15:00:00Z');
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha').reviewBonusCents).toBe(500);
      expect(await lineIds()).toEqual([earlier]);
      expect([...(await overCapPayoutIds(trx, { cap: 2 }))]).toEqual([later]);
    });

    it('splits months by the Eastern calendar, not UTC', async () => {
      const id = await readyTech('Sample Alpha');
      await setCap(1);
      // 2027-02-01 04:30Z is Jan 31 23:30 Eastern; 05:30Z is Feb 1 00:30 Eastern.
      const januaryNight = await payout(id, '2027-02-01T04:30:00Z');
      const februaryNight = await payout(id, '2027-02-01T05:30:00Z');
      const januaryEarlier = await payout(id, '2027-01-10T15:00:00Z');
      const februaryLater = await payout(id, '2027-02-20T15:00:00Z');
      const over = await overCapPayoutIds(trx, { cap: 1 });
      expect([...over].sort()).toEqual([januaryNight, februaryLater].sort());
      expect(over.has(januaryEarlier) || over.has(februaryNight)).toBe(false);
    });

    it('ranks each technician on their own', async () => {
      const first = await readyTech('Sample Alpha');
      const second = await readyTech('Sample Bravo');
      const a1 = await payout(first, '2026-09-15T15:00:00Z');
      const a2 = await payout(first, '2026-09-16T15:00:00Z');
      const b1 = await payout(second, '2026-09-16T15:00:00Z');
      const over = await overCapPayoutIds(trx, { cap: 1 });
      expect([...over]).toEqual([a2]);
      expect(over.has(a1) || over.has(b1)).toBe(false);
    });

    it('with no cap, every payout gets a line as before', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await setCap(null);
      const ids = [await payout(id, '2026-09-15T15:00:00Z'), await payout(id, '2026-09-16T15:00:00Z'), await payout(id, '2026-09-17T15:00:00Z')];
      const created = await draft(W1);
      expect(byName(created.body.run, 'Sample Alpha').reviewBonusCents).toBe(1500);
      expect((await lineIds()).sort()).toEqual(ids.sort());
      expect((await overCapPayoutIds(trx, { cap: null })).size).toBe(0);
    });

    it('drops an open line whose payout falls over the cap after earlier reviews move into that month', async () => {
      const first = await readyTech('Sample Alpha');
      const second = await readyTech('Sample Bravo');
      await approvedWeek(first, W1);
      await setCap(2);
      const mine = await payout(first, '2026-09-17T15:00:00Z');
      const created = await draft(W1);
      expect(await lineIds()).toEqual([mine]);
      // Two earlier reviews are re-attributed to this technician: the 09-17 one is now third.
      const moved1 = await payout(second, '2026-09-15T15:00:00Z');
      const moved2 = await payout(second, '2026-09-16T15:00:00Z');
      await trx('review_incentive_payouts').whereIn('id', [moved1, moved2]).update({ technician_id: first });
      const recomputed = await recompute(created.body.run.id);
      expect(byName(recomputed.body.run, 'Sample Alpha').reviewBonusCents).toBe(1000);
      expect((await lineIds()).sort()).toEqual([moved1, moved2].sort());
      expect(await payoutRow(mine)).toMatchObject({ status: 'earned', amount_cents: 500 });
      const events = await syncEvents();
      expect(events.map((e) => e.metadata)).toContainEqual(expect.objectContaining({ added_count: 2, removed_count: 1, removed_payout_ids: [mine] }));
    });

    it('markPaid skips payouts over the cap and says how many', async () => {
      const id = await readyTech('Sample Alpha');
      await setCap(2);
      const a = await payout(id, '2026-09-15T15:00:00Z');
      const b = await payout(id, '2026-09-16T15:00:00Z');
      const c = await payout(id, '2026-09-17T15:00:00Z');
      expect(await markPaid([a, b, c], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 2, skippedOverCap: 1 });
      expect((await payoutRow(c)).status).toBe('earned');
      expect(await markPaid([c], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 0, skippedOverCap: 1 });
    });

    it('markPaid compares ids in canonical form: an uppercase over-cap id is still skipped', async () => {
      const id = await readyTech('Sample Alpha');
      await setCap(1);
      const a = await payout(id, '2026-09-15T15:00:00Z');
      const b = await payout(id, '2026-09-16T15:00:00Z');
      expect(await markPaid([b.toUpperCase()], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 0, skippedOverCap: 1 });
      expect((await payoutRow(b)).status).toBe('earned');
      expect(await markPaid([a.toUpperCase()], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 1, skippedOverCap: 0 });
    });

    it('markPaid re-ranks under the technician lock: a payout re-attributed onto a full month is not paid', async () => {
      const first = await readyTech('Sample Alpha');
      const second = await readyTech('Sample Bravo');
      await setCap(1);
      await payout(first, '2026-09-15T15:00:00Z', { status: 'paid', paid_at: new Date() });
      const moved = await payout(second, '2026-09-16T15:00:00Z');
      await trx('review_incentive_payouts').where({ id: moved }).update({ technician_id: first });
      expect(await markPaid([moved], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 0, skippedOverCap: 1 });
      expect((await payoutRow(moved)).status).toBe('earned');
    });

    it('markPaid stops when the policy cannot be read, and marks nothing', async () => {
      const id = await readyTech('Sample Alpha');
      const bonus = await payout(id, '2026-09-15T15:00:00Z');
      // The rename is inside the test transaction and rolls back with it.
      await trx.raw('alter table system_settings rename to system_settings_unreadable');
      await expect(markPaid([bonus], { conn: trx, paidBy: ADMIN_ID })).rejects.toThrow(/system_settings/);
      await trx.raw('alter table system_settings_unreadable rename to system_settings');
      expect((await payoutRow(bonus)).status).toBe('earned');
    });

    it('a payout that lands mid-sync waits for the next sync; payroll never holds both winners', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await setCap(1);
      const old = await payout(id, '2026-09-17T15:00:00Z');
      const created = await draft(W1);
      expect(await lineIds()).toEqual([old]);
      // An earlier-dated review lands after the sync read its snapshot, as the ranking query starts.
      let landed;
      const hooked = new Proxy((...args) => trx(...args), {
        get(_target, key) {
          const value = trx[key];
          if (key !== 'raw') return typeof value === 'function' ? value.bind(trx) : value;
          return (sql, ...rest) => {
            if (!landed && /row_number/.test(sql)) {
              landed = payout(id, '2026-09-15T15:00:00Z');
              landed.catch(() => {});
            }
            return trx.raw(sql, ...rest);
          };
        },
      });
      const { syncReviewBonusLines } = require('../services/payroll-review-bonuses');
      await syncReviewBonusLines(hooked, { weekEnd: '2026-09-20', lock: true });
      const early = await landed;
      // The late row is not in the snapshot and takes the only slot: the old line is dropped, none added.
      expect(await lineIds()).toEqual([]);
      await syncReviewBonusLines(trx, { weekEnd: '2026-09-20', lock: true });
      expect(await lineIds()).toEqual([early]);
      expect(created.status).toBe(201);
    });

    it('a cap that cannot be read stops the pay run sync', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      await payout(id, '2026-09-15T15:00:00Z');
      await trx.raw('alter table system_settings rename to system_settings_unreadable');
      await expect(trx.transaction((inner) => require('../services/payroll-review-bonuses')
        .syncReviewBonusLines(inner, { weekEnd: '2026-09-20', lock: true }))).rejects.toThrow(/system_settings/);
      await trx.raw('alter table system_settings_unreadable rename to system_settings');
      expect(await importedLines()).toHaveLength(0);
    });

    const POLICY_ROW = { key: 'review_incentives.policy', category: 'reviews', description: 'Sample policy' };
    const storePolicy = async (value) => {
      await trx('system_settings').where({ key: POLICY_ROW.key }).del();
      await trx('system_settings').insert({ ...POLICY_ROW, value });
    };

    it('a stored policy that cannot be decoded stops the payment; a missing row or a legacy object does not', async () => {
      const id = await readyTech('Sample Alpha');
      const a = await payout(id, '2026-09-15T15:00:00Z');
      const b = await payout(id, '2026-09-16T15:00:00Z');
      for (const bad of ['{not json', '[1,2]', '"15"', '']) {
        await storePolicy(bad);
        await expect(getPolicyStrict(trx)).rejects.toMatchObject({ code: 'review_policy_malformed' });
        await expect(markPaid([a], { conn: trx, paidBy: ADMIN_ID })).rejects.toMatchObject({ code: 'review_policy_malformed' });
        expect((await payoutRow(a)).status).toBe('earned');
      }
      await trx('system_settings').where({ key: POLICY_ROW.key }).del();
      expect((await getPolicyStrict(trx)).monthlyCapCount).toBeNull();
      await storePolicy(JSON.stringify({ enabled: true, amountCents: 500 }));
      expect((await getPolicyStrict(trx)).monthlyCapCount).toBeNull();
      expect(await markPaid([a], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 1, skippedOverCap: 0 });
      // savePolicy replaces a garbled row instead of failing, and keeps a stored cap when it can read it.
      await storePolicy('{not json');
      expect((await savePolicy({ monthlyCapCount: 1 }, trx)).monthlyCapCount).toBe(1);
      expect(await markPaid([b], { conn: trx, paidBy: ADMIN_ID })).toEqual({ updated: 0, skippedOverCap: 1 });
    });

    it('the dashboard and the CSV export fail when the policy cannot be read', async () => {
      await readyTech('Sample Alpha');
      await trx.raw('alter table system_settings rename to system_settings_unreadable');
      await expect(trx.transaction((inner) => getDashboard({ conn: inner, days: 30 }))).rejects.toThrow(/system_settings/);
      await trx.raw('alter table system_settings_unreadable rename to system_settings');
    });

    it('with the import off, payroll never reads the review policy and still drops stale lines', async () => {
      const id = await readyTech('Sample Alpha');
      await approvedWeek(id, W1);
      const bonus = await payout(id, '2026-09-16T15:00:00Z');
      const created = await draft(W1);
      expect(await lineIds()).toEqual([bonus]);
      delete process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT;
      await trx.raw('alter table system_settings rename to system_settings_unreadable');
      const recomputed = await recompute(created.body.run.id);
      await trx.raw('alter table system_settings_unreadable rename to system_settings');
      expect(recomputed.status).toBe(200);
      expect(await lineIds()).toEqual([]);
    });

    it('lockPayoutRows locks the whole id set in one statement, ordered by id', async () => {
      const id = await readyTech('Sample Alpha');
      const ids = [await payout(id, '2026-09-15T15:00:00Z'), await payout(id, '2026-09-16T15:00:00Z'), await payout(id, '2026-09-17T15:00:00Z')];
      const locked = await lockPayoutRows(trx, [...ids, ids[0]]);
      expect(locked.map((row) => row.id)).toEqual([...ids].sort());
    });

    it('the dashboard marks over-cap rows, leaves them out of pending, and reports the cap', async () => {
      const id = await readyTech('Sample Alpha');
      // savePolicy stamps programStartsAt with today when none is set, which would hide September.
      await savePolicy({ monthlyCapCount: 1, programStartsAt: '2026-01-01T00:00:00Z' }, trx);
      const a = await payout(id, '2026-09-15T15:00:00Z');
      const b = await payout(id, '2026-09-16T15:00:00Z');
      const dashboard = await getDashboard({
        conn: trx, periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-30T23:59:59Z',
      });
      expect(dashboard.policy.monthlyCapCount).toBe(1);
      expect(Object.fromEntries(dashboard.payouts.map((p) => [p.id, p.overMonthlyCap]))).toEqual({ [a]: false, [b]: true });
      expect(dashboard.summary).toMatchObject({ pendingCount: 1, pendingCents: 500, earnedCents: 1000 });
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
