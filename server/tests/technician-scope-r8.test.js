// Codex #5568 r8: project creation needs a current visit; lawn confirmation
// re-checks visit ownership inside its write transaction, before any write.
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('lawn confirmation ownership fence', () => {
  test('confirmRun runs the fence first and writes nothing when it refuses', async () => {
    const visitRuns = require('../services/lawn-visit-runs');
    const tables = [];
    const trx = (table) => { tables.push(table); throw new Error(`no write expected: ${table}`); };
    const knex = { transaction: async (cb) => cb(trx) };
    const refusal = Object.assign(new Error('serviceId not found'), { status: 404 });
    await expect(visitRuns.confirmRun({ assessmentId: 'a-1', assertOwned: async () => { throw refusal; } }, knex))
      .rejects.toBe(refusal);
    expect(tables).toEqual([]);
  });

  test('both confirmation paths receive the fence, and the legacy one runs it before the baseline lock', () => {
    const src = read('routes/admin-lawn-assessment.js');
    const legacy = src.slice(src.indexOf('async function confirmLegacyAssessment('));
    expect(legacy.indexOf('if (assertOwned) await assertOwned(trx);')).toBeGreaterThan(-1);
    expect(legacy.indexOf('if (assertOwned) await assertOwned(trx);')).toBeLessThan(legacy.indexOf('lockCustomerBaseline'));
    const confirm = src.slice(src.indexOf("router.post('/confirm'"));
    expect(confirm).toMatch(/technicianId: req\.technicianId, assertOwned,/);
    expect(confirm).toMatch(/propertyHistoryEnabled, assertOwned,/);
  });

  test('the ownership refusal maps to 404 through the shared error handler too (/assess)', () => {
    const src = read('routes/admin-lawn-assessment.js');
    expect(src).toMatch(/new Error\('serviceId not found'\), \{ status: 404, statusCode: 404, isOperational: true \}/);
  });
});

describe('project creation', () => {
  test('a scheduled-visit link authorizes a technician only while the visit is current', () => {
    const src = read('routes/admin-projects.js');
    const fn = src.slice(src.indexOf('async function validateProjectCreateScope('));
    expect(fn).toMatch(/\.first\('id', 'customer_id', 'technician_id', 'status', 'scheduled_date'\)/);
    expect(fn).toMatch(/technicianVisitRowInScope\(\{ techRole: 'technician', technicianId: req\.technicianId \}, scheduled\)\) linkedAssignedToTech = true/);
  });

  test('technicianVisitRowInScope refuses cancelled and stale rows, accepts a current one', () => {
    const { technicianVisitRowInScope } = require('../services/technician-visit-scope');
    const actor = { techRole: 'technician', technicianId: 'tech-A' };
    const today = new Date().toISOString().slice(0, 10);
    expect(technicianVisitRowInScope(actor, { technician_id: 'tech-A', status: 'confirmed', scheduled_date: today })).toBe(true);
    expect(technicianVisitRowInScope(actor, { technician_id: 'tech-A', status: 'cancelled', scheduled_date: today })).toBe(false);
    expect(technicianVisitRowInScope(actor, { technician_id: 'tech-A', status: 'confirmed', scheduled_date: '2020-01-01' })).toBe(false);
  });
});

describe('legacy confirmation fence (codex #5568 r11)', () => {
  test('a row with no service_id is fenced on a locked current visit for the customer', () => {
    const src = read('routes/admin-lawn-assessment.js');
    const confirm = src.slice(src.indexOf("router.post('/confirm'"));
    expect(confirm).toMatch(/: \(trx\) => assertCustomerVisitStillOwned\(req, trx, assessment\.customer_id\);/);
    const fn = src.slice(src.indexOf('async function assertCustomerVisitStillOwned('));
    expect(fn.slice(0, 600)).toMatch(/where\('scheduled_services\.customer_id', customerId\),\s*\)\.forUpdate\(\)\.first\('scheduled_services\.id'\)/);
  });
});

describe('assess fence without a serviceId (r11 pre-push)', () => {
  test('both insert transactions fall back to the customer fence', () => {
    const src = read('routes/admin-lawn-assessment.js');
    const fence = /if \(serviceId\) await assertVisitStillOwned\(req, trx, serviceId\);\s*else await assertCustomerVisitStillOwned\(req, trx, customerId\);/g;
    expect(src.match(fence)).toHaveLength(2);
  });
});
