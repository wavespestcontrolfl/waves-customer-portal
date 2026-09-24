/**
 * ADMIN-BUG-R14 follow-up (Codex review, round 2 on PR #4684) — archiving a
 * monthly member with NO scheduled visit and NO prepay term (so neither of
 * the archive guard's two checks fires) used to leave active/autopay_enabled/
 * next_charge_date untouched: the row was excluded from processMonthlyBilling
 * only by deleted_at, and PATCH /:id/restore clears ONLY deleted_at — so
 * restoring the row put it straight back into the billing candidate set with
 * autopay still armed, exactly reproducing the original ADMIN-BUG-R10/R14
 * money leak on any restore.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Written to
 * assert the EXPECTED behaviour (archive winds billing down, or refuses; a
 * later restore never re-arms it), so it FAILS on the code this fixes.
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

// Mirror of billing-cron.js processMonthlyBilling's candidate select.
function billingCronSelectsRow(customerId) {
  return db('customers')
    .where({ active: true })
    .where('monthly_rate', '>', 0)
    .whereNull('service_paused_at')
    .whereNull('deleted_at')
    .where({ id: customerId })
    .first('id');
}

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('archive a monthly member with no visit/term but live billing (real PG)', () => {
  const customerId = randomUUID();

  beforeAll(async () => {
    await db('customers').insert({
      id: customerId, first_name: 'ArchiveBillingRepro', last_name: 'Customer',
      phone: '9415550199', email: `archive-billing-repro-${customerId}@example.com`,
      pipeline_stage: 'active_customer', active: true, autopay_enabled: true,
      monthly_rate: 89, waveguard_tier: 'Silver', billing_mode: 'monthly_membership',
      next_charge_date: isoDaysAhead(10),
    });
    // Deliberately NO scheduled_services row and NO annual_prepay_terms row —
    // the two existing archive guards must not be what's covering this case.
  });
  afterAll(async () => { await db.destroy(); });

  test('archive winds billing down (or refuses), and a later restore never re-arms it', async () => {
    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/${customerId}`, { method: 'DELETE' });
      return res.status;
    });
    const afterArchive = await db('customers').where({ id: customerId })
      .first('deleted_at', 'active', 'autopay_enabled', 'next_charge_date');


    console.log('[repro archive-billing-winddown] DELETE status=%s afterArchive=%j', status, afterArchive);

    const refused = status === 409;
    const woundDown = status === 200
      && !!afterArchive.deleted_at
      && afterArchive.active === false
      && afterArchive.autopay_enabled === false
      && afterArchive.next_charge_date == null;
    expect(refused || woundDown).toBe(true);

    if (woundDown) {
      // Restore only clears deleted_at — confirm the billing fields this fix
      // wound down stay wound down, so the row does not silently re-arm.
      const restoreStatus = await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/customers/${customerId}/restore`, { method: 'PATCH' });
        return res.status;
      });
      expect(restoreStatus).toBe(200);
      const afterRestore = await db('customers').where({ id: customerId })
        .first('deleted_at', 'active', 'autopay_enabled', 'next_charge_date');
      const stillSelectedByDuesCron = !!(await billingCronSelectsRow(customerId));

      console.log('[repro archive-billing-winddown] afterRestore=%j stillSelectedByDuesCron=%s', afterRestore, stillSelectedByDuesCron);
      expect(afterRestore.deleted_at).toBeNull();
      expect(stillSelectedByDuesCron).toBe(false);
    }
  });
});
