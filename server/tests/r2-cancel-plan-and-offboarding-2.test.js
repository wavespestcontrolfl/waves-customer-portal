/**
 * AUDIT REPRO r2-cancel-plan-and-offboarding-2 — setting a customer's Stage to
 * "Churned" (PUT /admin/customers/:id/stage and the Customer 360 general edit
 * PUT /admin/customers/:id { pipelineStage }) records churned_at but leaves the
 * account billable: active stays true, autopay stays armed, monthly_rate and
 * next_charge_date survive, and the future recurring visit stays live. The
 * monthly dues cron (billing-cron.js processMonthlyBilling) selects
 * `active=true AND monthly_rate>0 AND service_paused_at IS NULL AND deleted_at IS NULL`,
 * so the churned row keeps being charged.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Written to assert
 * the EXPECTED behaviour (the stage write either refuses because billing is
 * live, or winds billing down the way cancellation-processor.js does), so it
 * FAILS on current code if the bug is real.
 */
const { randomUUID } = require('crypto');
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-customers');

jest.setTimeout(30000);

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

const isoDaysAhead = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

// Mirror of billing-cron.js:161-166 (processMonthlyBilling candidate select).
function billingCronSelectsRow(customerId) {
  return db('customers')
    .where({ active: true })
    .where('monthly_rate', '>', 0)
    .whereNull('service_paused_at')
    .whereNull('deleted_at')
    .where({ id: customerId })
    .first('id');
}

async function seedMonthlyMember(tag) {
  const customerId = randomUUID();
  const visitId = randomUUID();
  await db('customers').insert({
    id: customerId,
    first_name: `ChurnRepro${tag}`, last_name: 'Member',
    phone: `94155501${String(Math.floor(Math.random() * 90) + 10)}`,
    email: `churn-repro-${customerId}@example.com`,
    pipeline_stage: 'active_customer',
    active: true,
    autopay_enabled: true,
    monthly_rate: 89,
    waveguard_tier: 'Silver',
    billing_mode: 'monthly_membership',
    billing_day: 15,
    next_charge_date: isoDaysAhead(10),
  });
  await db('scheduled_services').insert({
    id: visitId, customer_id: customerId, scheduled_date: isoDaysAhead(20),
    service_type: 'pest_control', status: 'pending', recurring_ongoing: true,
  });
  return { customerId, visitId };
}

async function snapshot({ customerId, visitId }) {
  const c = await db('customers').where({ id: customerId })
    .first('pipeline_stage', 'churned_at', 'active', 'autopay_enabled', 'monthly_rate', 'next_charge_date', 'waveguard_tier');
  const v = await db('scheduled_services').where({ id: visitId }).first('status', 'recurring_ongoing');
  const billable = await billingCronSelectsRow(customerId);
  return { customer: c, visit: v, stillSelectedByDuesCron: !!billable };
}

function assertRefusedOrWoundDown(label, status, snap) {
   
  console.log(`[repro r2-cancel-plan-and-offboarding-2] ${label} status=%s snapshot=%j`, status, snap);
  const refused = status === 400 || status === 409;
  const woundDown = status === 200
    && snap.customer.pipeline_stage === 'churned'
    && snap.stillSelectedByDuesCron === false
    && snap.customer.autopay_enabled === false
    && snap.customer.next_charge_date == null;
  expect(refused || woundDown).toBe(true);
}

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('Stage = Churned on a live monthly member (real PG)', () => {
  const seeds = {};
  beforeAll(async () => {
    seeds.stageRoute = await seedMonthlyMember('A');
    seeds.generalEdit = await seedMonthlyMember('B');
  });
  afterAll(async () => { await db.destroy(); });

  test('PUT /:id/stage { stage: churned } refuses or winds down billing', async () => {
    const seed = seeds.stageRoute;
    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/${seed.customerId}/stage`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'churned', churnReason: 'moved' }),
      });
      return res.status;
    });
    assertRefusedOrWoundDown('PUT /:id/stage', status, await snapshot(seed));
  });

  test('PUT /:id { pipelineStage: churned } (Customer 360 edit) refuses or winds down billing', async () => {
    const seed = seeds.generalEdit;
    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/${seed.customerId}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelineStage: 'churned', churnReason: 'moved' }),
      });
      if (res.status !== 200) console.log('[repro] body', await res.text());
      return res.status;
    });
    assertRefusedOrWoundDown('PUT /:id', status, await snapshot(seed));
  });
});
