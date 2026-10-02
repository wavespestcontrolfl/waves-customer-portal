// Codex #5568 r14 (three P1 write-boundary findings):
//  1. POST /communications/schedule-sms is office-only (the scheduler replays a
//     queued row later with no re-check of the sender's route).
//  2. POST /projects re-validates the linked visit under a row lock inside the
//     insert transaction.
//  3. POST /stripe/terminal/handoff re-validates the technician's assignment
//     under a row lock inside the token-mint transaction, reversing the credit
//     the seam applied when the assignment is gone.
// Plus: portal usage routes are reachable for a technician (scope=me only).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const { technicianMayReach } = require('../middleware/technician-scope');
const { addETDays, etDateString } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const STALE = etDateString(addETDays(new Date(), -30));

// Fake transaction handle: records the chain per table and the rows each table
// hands back from first().
function fakeTrx(rows) {
  const calls = [];
  const trx = (table) => {
    const c = { table, ops: [] };
    for (const m of ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereNull', 'forUpdate']) {
      c[m] = (...a) => { c.ops.push([m, ...a]); return c; };
    }
    c.first = async () => { c.ops.push(['first']); return rows[table] || null; };
    c.insert = (row) => { calls.push(['insert', table, row]); return { returning: async () => [{ id: 'new', ...row }] }; };
    calls.push(['query', table, c]);
    return c;
  };
  trx.calls = calls;
  return trx;
}
const lockedOn = (trx, table) => trx.calls.some(([k, t, c]) => k === 'query' && t === table && c.ops.some(([m]) => m === 'forUpdate'));

describe('finding 1: schedule-sms is office-only', () => {
  const src = read('routes/admin-communications.js');
  const handler = src.slice(src.indexOf("router.post('/schedule-sms'"), src.indexOf("router.get('/scheduled'"));

  test('the route refuses any non-admin before it reads, validates or enqueues', () => {
    const guard = handler.indexOf("if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(handler.indexOf('recruitingReplyContext('));
    expect(guard).toBeLessThan(handler.indexOf("trx('sms_log')"));
  });

  test('the technician allow-list no longer reaches schedule-sms, other texts stay', () => {
    expect(technicianMayReach('POST', '/api/admin/communications/schedule-sms')).toBe(false);
    expect(technicianMayReach('POST', '/api/admin/communications/sms')).toBe(true);
    expect(technicianMayReach('POST', '/api/admin/communications/rewrite-sms')).toBe(true);
  });

  test('the composer hides deferred timing from a technician and refuses a stale one', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'client/src/pages/admin/CommunicationsPageV2.jsx'), 'utf8');
    expect(ui).toMatch(/const smsIsTechnicianRole = smsOutletContext\?\.user\?\.role === "technician";/);
    expect(ui).toMatch(/if \(smsIsTechnicianRole\) return \{ value: null, error: /);
    expect(ui).toMatch(/\{!smsIsTechnicianRole && <Field label="Send"/);
  });
});

describe('finding 2: project create re-validates the visit under a row lock', () => {
  const { assertTechnicianProjectLinkStillAssigned } = require('../routes/admin-projects')._private;
  const tech = { techRole: 'technician', technicianId: 'tech-A' };
  const visit = (over = {}) => ({ id: 'v1', customer_id: 'c1', technician_id: 'tech-A', status: 'confirmed', scheduled_date: TODAY, ...over });

  test('an admin is unscoped and takes no lock', async () => {
    const trx = fakeTrx({});
    await expect(assertTechnicianProjectLinkStillAssigned(trx, { techRole: 'admin', technicianId: 'a' }, { scheduled_service_id: 'v1' })).resolves.toBeUndefined();
    expect(trx.calls).toEqual([]);
  });

  test('an assigned, in-window visit passes and the row is locked FOR UPDATE', async () => {
    const trx = fakeTrx({ scheduled_services: visit() });
    await expect(assertTechnicianProjectLinkStillAssigned(trx, tech, { scheduled_service_id: 'v1' })).resolves.toBeUndefined();
    expect(lockedOn(trx, 'scheduled_services')).toBe(true);
  });

  test.each([
    ['reassigned to someone else', { technician_id: 'tech-B' }],
    ['cancelled', { status: 'cancelled' }],
    ['rescheduled', { status: 'rescheduled' }],
    ['outside the access window', { scheduled_date: STALE }],
  ])('a visit that is %s is refused 403 with the existing message', async (_label, over) => {
    const trx = fakeTrx({ scheduled_services: visit(over) });
    await expect(assertTechnicianProjectLinkStillAssigned(trx, tech, { scheduled_service_id: 'v1' }))
      .rejects.toMatchObject({ status: 403, message: 'Technician projects must be linked to an assigned visit' });
  });

  test('a vanished visit is refused', async () => {
    const trx = fakeTrx({});
    await expect(assertTechnicianProjectLinkStillAssigned(trx, tech, { scheduled_service_id: 'v1' }))
      .rejects.toMatchObject({ status: 403 });
  });

  test('any non-admin role is judged as a technician', async () => {
    const trx = fakeTrx({ scheduled_services: visit({ technician_id: 'tech-B' }) });
    await expect(assertTechnicianProjectLinkStillAssigned(trx, { techRole: 'office', technicianId: 'tech-A' }, { scheduled_service_id: 'v1' }))
      .rejects.toMatchObject({ status: 403 });
  });

  test('a service record assigned to the technician still authorizes (unchanged path)', async () => {
    const trx = fakeTrx({ scheduled_services: visit({ technician_id: 'tech-B' }), service_records: { id: 'r1', technician_id: 'tech-A' } });
    await expect(assertTechnicianProjectLinkStillAssigned(trx, tech, { service_record_id: 'r1', scheduled_service_id: 'v1' })).resolves.toBeUndefined();
    await expect(assertTechnicianProjectLinkStillAssigned(fakeTrx({ service_records: { id: 'r1', technician_id: 'tech-B' } }), tech, { service_record_id: 'r1' }))
      .rejects.toMatchObject({ status: 403 });
  });

  test('the create handler runs the re-validation and the insert in ONE transaction, check first', () => {
    const src = read('routes/admin-projects.js');
    const create = src.slice(src.indexOf("router.post('/', async"), src.indexOf("router.post('/ai-write-preview'"));
    const txn = create.indexOf('db.transaction(async (trx) => {');
    const check = create.indexOf('await assertTechnicianProjectLinkStillAssigned(trx, req,');
    const insert = create.indexOf("trx('projects').insert(");
    expect(txn).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(txn);
    expect(insert).toBeGreaterThan(check);
    expect(create).not.toMatch(/db\('projects'\)\.insert\(/);
    // the unique-violation winner lookup stays outside the aborted transaction
    expect(create.indexOf('} catch (insertErr) {')).toBeGreaterThan(insert);
  });
});

describe('finding 3: handoff mint re-validates assignment under a row lock', () => {
  jest.doMock('../config', () => ({ jwt: { secret: 'staff-jwt-secret' } }));
  jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_placeholder' }));
  jest.doMock('../services/audit-log', () => ({
    auditTerminalHandoffMint: jest.fn(), auditTerminalHandoffRateLimited: jest.fn(), auditTerminalHandoffValidate: jest.fn(), ipFromReq: jest.fn(), uaFromReq: jest.fn(),
  }));
  const { _test } = require('../routes/stripe-terminal');
  const tech = { techRole: 'technician', technicianId: 'tech-A' };
  const invoice = { id: 'inv1', customer_id: 'c1' };

  test('an admin passes without a lookup', async () => {
    const trx = fakeTrx({});
    await expect(_test.technicianMayCollectInvoiceLocked(trx, { techRole: 'admin' }, invoice)).resolves.toBe(true);
    expect(trx.calls).toEqual([]);
  });

  test('a technician with a qualifying visit passes; the visit row is locked FOR UPDATE with the shared predicate', async () => {
    const trx = fakeTrx({ scheduled_services: { id: 'v1' } });
    await expect(_test.technicianMayCollectInvoiceLocked(trx, tech, invoice)).resolves.toBe(true);
    expect(lockedOn(trx, 'scheduled_services')).toBe(true);
    const ops = trx.calls.find(([k, t]) => k === 'query' && t === 'scheduled_services')[2].ops;
    expect(ops).toEqual(expect.arrayContaining([
      ['where', { customer_id: 'c1' }],
      ['where', 'scheduled_services.technician_id', 'tech-A'],
      ['whereNotIn', 'scheduled_services.status', expect.arrayContaining(['cancelled', 'rescheduled'])],
    ]));
  });

  test('a technician with no qualifying visit is refused; no customer is refused', async () => {
    await expect(_test.technicianMayCollectInvoiceLocked(fakeTrx({}), tech, invoice)).resolves.toBe(false);
    await expect(_test.technicianMayCollectInvoiceLocked(fakeTrx({}), tech, { id: 'inv', customer_id: null })).resolves.toBe(false);
  });

  test('the mint transaction checks first, then the miss reverses the seam credit and answers like the pre-check', () => {
    const src = read('routes/stripe-terminal.js');
    const handler = src.slice(src.indexOf("router.post('/handoff'"), src.indexOf("router.post('/validate-handoff'"));
    const txn = handler.indexOf('await db.transaction(async (trx) => {');
    const lock = handler.indexOf('await technicianMayCollectInvoiceLocked(trx, req, invoice)');
    const advisory = handler.indexOf('pg_advisory_xact_lock');
    const tokenRow = handler.indexOf("trx('terminal_handoff_tokens').insert(");
    const sign = handler.indexOf('jwt.sign(');
    expect(txn).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(txn);
    expect(lock).toBeLessThan(advisory);
    expect(lock).toBeLessThan(tokenRow);
    const miss = handler.indexOf('if (ownershipLostAtMint) {');
    expect(miss).toBeGreaterThan(txn);
    expect(miss).toBeLessThan(sign);
    const missBlock = handler.slice(miss, handler.indexOf('if (rateLimited) {'));
    expect(missBlock).toMatch(/reverseAppliedCredit\(\{ invoiceId: invoice_id, amount: handoffCreditResult\.applied, createdBy: 'system:handoff_not_assigned' \}\)/);
    expect(missBlock).toMatch(/res\.status\(404\)\.json\(\{ error: 'Invoice not found' \}\)/);
  });
});

describe('portal usage for a technician', () => {
  test('track and the own-scope summary are reachable; nothing else under usage', () => {
    expect(technicianMayReach('POST', '/api/admin/usage/track')).toBe(true);
    expect(technicianMayReach('GET', '/api/admin/usage/summary')).toBe(true);
    expect(technicianMayReach('POST', '/api/admin/usage/summary')).toBe(false);
    expect(technicianMayReach('GET', '/api/admin/usage/track')).toBe(false);
    expect(technicianMayReach('GET', '/api/admin/usage')).toBe(false);
  });

  test('the router keeps scope=all admin-only and defaults a technician to their own rows', () => {
    const src = read('routes/admin-usage.js');
    expect(src).toMatch(/if \(scope === 'all' && req\.techRole !== 'admin'\) \{\s*return res\.status\(403\)/);
    expect(src).toMatch(/if \(scope === 'me'\) q\.where\('technician_id', req\.technicianId\);/);
  });
});
