/**
 * AUDIT REPRO r1-customers-2 — DELETE /admin/customers/:id (archive) leaves the
 * customer's FUTURE scheduled_services and active annual_prepay_terms live, and
 * the schedule day-view predicate (admin-schedule.js GET /, which has no
 * customers.deleted_at filter) still surfaces the visit with the customer name.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Written to assert
 * the EXPECTED (archive cascades or refuses) behaviour, so it FAILS on current
 * code if the handler only stamps customers.deleted_at.
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

const etTomorrow = () => {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('archive customer with live future visit + prepay term (real PG)', () => {
  const customerId = randomUUID();
  const visitId = randomUUID();
  const termId = randomUUID();
  const tomorrow = etTomorrow();

  beforeAll(async () => {
    await db('customers').insert({ id: customerId, first_name: 'ArchiveRepro', last_name: 'Customer', phone: '9415550100', email: `archive-repro-${customerId}@example.com` });
    await db('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: tomorrow, service_type: 'pest_control', status: 'pending' });
    await db('annual_prepay_terms').insert({ id: termId, customer_id: customerId, term_start: tomorrow, term_end: tomorrow.replace(/^\d{4}/, (y) => String(Number(y) + 1)), status: 'active' });
  });
  afterAll(async () => { await db.destroy(); });

  test('archive cascades to (or refuses on) live future visits and prepay terms', async () => {
    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/${customerId}`, { method: 'DELETE' });
      return res.status;
    });
    const customer = await db('customers').where({ id: customerId }).first('deleted_at');
    const visit = await db('scheduled_services').where({ id: visitId }).first('status');
    const term = await db('annual_prepay_terms').where({ id: termId }).first('status');

    // Mirror of admin-schedule.js GET / (day view) — same predicate, no customers.deleted_at filter.
    const dayView = await db('scheduled_services')
      .where({ 'scheduled_services.scheduled_date': tomorrow })
      .whereNotIn('scheduled_services.status', ['cancelled', 'rescheduled'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .where('scheduled_services.id', visitId)
      .select('scheduled_services.id', 'scheduled_services.status', 'customers.first_name', 'customers.deleted_at as customer_deleted_at');

     
    console.log('[repro r1-customers-2] DELETE status=%s customer.deleted_at=%s visit.status=%s term.status=%s dayView=%j', status, customer?.deleted_at, visit?.status, term?.status, dayView);

    const refused = status === 409;
    const cascaded = status === 200 && !!customer.deleted_at && ['cancelled', 'canceled'].includes(visit.status) && term.status !== 'active';
    expect(refused || cascaded).toBe(true);
  });
});
