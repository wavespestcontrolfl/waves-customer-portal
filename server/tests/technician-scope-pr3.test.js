// Technician allow-list additions, owner ruling 2026-10-03 (client-matching PR):
//  - GET  /communications/sender            (composer's server-chosen line)
//  - GET  /discounts/stacking               (discount-picker feature flag)
//  - POST /inventory/waveguard-forecast/:id/restock-request  (job-card "Order more")
// Exact paths and methods only: neighbours stay denied.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { technicianMayReach } = require('../middleware/technician-scope');

const ID = '10000000-0000-4000-8000-000000000001';

describe('technician reach added for the field client (PR 3)', () => {
  test.each([
    ['GET', '/api/admin/communications/sender'],
    ['HEAD', '/api/admin/communications/sender'],
    ['GET', '/api/admin/discounts/stacking'],
    ['HEAD', '/api/admin/discounts/stacking'],
    ['POST', `/api/admin/inventory/waveguard-forecast/${ID}/restock-request`],
  ])('%s %s is reachable', (method, path) => {
    expect(technicianMayReach(method, path)).toBe(true);
  });

  test.each([
    // sender / stacking are reads only, and exact paths.
    ['POST', '/api/admin/communications/sender'],
    ['PUT', '/api/admin/communications/sender'],
    ['GET', '/api/admin/communications/sender/extra'],
    ['POST', '/api/admin/discounts/stacking'],
    ['PUT', '/api/admin/discounts/stacking'],
    ['GET', '/api/admin/discounts/stacking/extra'],
    ['GET', '/api/admin/discounts/calculate'],
    ['GET', '/api/admin/discounts/stats'],
    ['GET', '/api/admin/communications/call'],
    ['POST', '/api/admin/communications/call'],
    // restock request only: no stock moves, queue actions or other writes.
    ['PUT', `/api/admin/inventory/waveguard-forecast/${ID}/restock-request`],
    ['DELETE', `/api/admin/inventory/waveguard-forecast/${ID}/restock-request`],
    ['POST', `/api/admin/inventory/waveguard-forecast/${ID}/restock-request/extra`],
    ['POST', '/api/admin/inventory/waveguard-forecast/restock-request'],
    ['POST', `/api/admin/inventory/${ID}/adjust`],
    ['POST', `/api/admin/inventory/restock-requests/${ID}/action`],
    ['POST', `/api/admin/inventory/unit-review/${ID}/fix`],
    ['POST', '/api/admin/inventory'],
    ['PUT', `/api/admin/inventory/${ID}`],
    // calibrations: admin-only for now (owner 2026-10-03, not set up yet).
    ['POST', `/api/admin/equipment-systems/${ID}/calibrations`],
    ['POST', `/api/admin/equipment-systems/calibrations/${ID}/verify`],
    ['PUT', `/api/admin/equipment-systems/calibrations/${ID}`],
    ['PUT', `/api/admin/equipment-systems/${ID}/assets`],
    ['PATCH', `/api/admin/equipment-systems/${ID}/calibrations`],
    ['DELETE', `/api/admin/equipment-systems/${ID}/calibrations`],
    ['PUT', `/api/admin/equipment-systems/${ID}/calibrations`],
    ['POST', `/api/admin/equipment-systems/calibrations/${ID}`],
    ['POST', `/api/admin/equipment-systems/calibrations/${ID}/verify/extra`],
    ['PATCH', `/api/admin/equipment-systems/calibrations/${ID}/verify`],
    ['POST', `/api/admin/equipment-systems/${ID}`],
    // other equipment writes stay office-only.
    ['POST', '/api/admin/equipment/equipment'],
    ['PUT', `/api/admin/equipment/equipment/${ID}`],
    ['POST', `/api/admin/equipment/tank-mixes/${ID}/recalculate`],
    ['PUT', `/api/admin/equipment-maintenance/alerts/${ID}`],
    ['POST', `/api/admin/equipment-maintenance/${ID}/records`],
    ['POST', `/api/admin/equipment-maintenance/${ID}/mileage`],
  ])('%s %s stays denied', (method, path) => {
    expect(technicianMayReach(method, path)).toBe(false);
  });
});

describe('sender-line lookup is scoped for a technician (codex #5683 r1)', () => {
  test('a technician needs their own customer and that customer\'s own number before the lookup runs', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes/admin-communications.js'), 'utf8');
    const handler = src.slice(src.indexOf("router.get('/sender'"));
    const guard = handler.indexOf('if (isTechnicianRequest(req)) {');
    const lookup = handler.indexOf("require('../services/home-line').staffTextSender(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(lookup);
    const block = handler.slice(guard, lookup);
    expect(block).toMatch(/!customerId \|\| !\(await technicianServicesCustomer\(req, customerId\)\)\) return res\.json\(\{ fromNumber: null \}\)/);
    expect(block).toMatch(/ownKey !== phoneIdentityKey\(phone\)\) return res\.json\(\{ fromNumber: null \}\)/);
    // Full-number identity for non-NANP numbers, last-10 for NANP (codex #5733 r1).
    const { phoneIdentityKey } = require('../utils/phone');
    expect(phoneIdentityKey('+447911123456')).toBe('+447911123456');
    expect(phoneIdentityKey('+447911123456')).not.toBe(phoneIdentityKey('+337911123456'));
    expect(phoneIdentityKey('(941) 555-0123')).toBe(phoneIdentityKey('+19415550123'));
  });
});

describe('technician restock requests: own visit, server-set details (codex #5683 r3, #5733 r2/r3)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes/admin-inventory.js'), 'utf8');
  const handler = src.slice(src.indexOf("router.post('/waveguard-forecast/:productId/restock-request'")).slice(0, 5600);
  const techBlock = handler.slice(handler.indexOf('if (!isAdminCaller) {'), handler.indexOf('const result = await inventoryOperations.createRestockRequest(req.params.productId, {\n      requestedQuantity: body.requestedQuantity'));

  test('a non-admin needs an owned current visit before anything is created', () => {
    expect(techBlock).toMatch(/technicianCurrentVisitFilter\(\s*\{ techRole: 'technician', technicianId: req\.technicianId \},/);
    expect(techBlock.indexOf("if (!owned) return res.status(403)")).toBeGreaterThan(-1);
    expect(techBlock.indexOf("if (!owned) return res.status(403)")).toBeLessThan(techBlock.indexOf('createRestockRequest('));
  });

  test('unit, reason, priority and dedupe are set by the server; quantity is bounded by the standard order', () => {
    expect(techBlock).toMatch(/standardOrderFor\(req\.params\.productId, \{ dbh: db \}\)/);
    expect(techBlock).toMatch(/Math\.min\(asked, standard\.quantity \* TECH_RESTOCK_MAX_PACKS\)/);
    // r4: a withheld order and a stale unit are refused, not guessed.
    expect(techBlock).toMatch(/if \(standard\.unavailable\) return res\.status\(409\)/);
    expect(techBlock).toMatch(/if \(sentUnit && sentUnit !== currentUnit\) \{\s*return res\.status\(409\)/);
    expect(techBlock).toMatch(/priority: 'high', allowDuplicate: false,/);
    expect(techBlock).toMatch(/reason: `Job card: \$\{standard\.name\} \(visit \$\{visitId\.slice\(0, 8\)\}\)`/);
    // Only the quantity reaches the technician write; the sent unit is compared, never written.
    expect(techBlock).not.toMatch(/body\.(reason|priority|allowDuplicate|neededBy|targetStock|forecastDays|committedDemand|projectedRemaining|firstShortDate)/);
    expect(techBlock).not.toMatch(/unit: body\.unit/);
  });

  test('the office path still reads its planning fields', () => {
    expect(handler).toMatch(/neededBy: body\.neededBy, targetStock: body\.targetStock,/);
    expect(handler).toMatch(/allowDuplicate: body\.allowDuplicate,/);
  });
});

describe('standardOrderFor (codex #5733 r3)', () => {
  const { standardOrderFor } = require('../services/job-card');
  const fakeDb = (product, packRows) => (table) => {
    const c = {};
    for (const m of ['where', 'whereIn', 'whereNotNull', 'orderBy', 'orWhereNull']) c[m] = (arg) => { if (typeof arg === 'function') arg.call(c); return c; };
    c.first = async () => (table === 'products_catalog' ? product : null);
    c.select = () => Object.assign(Promise.resolve(packRows), { catch: () => Promise.resolve(packRows) });
    return c;
  };

  test('an unknown or inactive product answers null', async () => {
    expect(await standardOrderFor('p-x', { dbh: fakeDb(null, []) })).toBeNull();
  });

  const PRODUCT = { id: 'p-1', name: 'Fixture Product', inventory_unit: 'gal', rate_unit: 'fl_oz' };

  test('a product with no pack mapping orders one unit, in its own inventory unit', async () => {
    expect(await standardOrderFor('p-1', { dbh: fakeDb(PRODUCT, []) })).toMatchObject({ name: 'Fixture Product', quantity: 1, unit: 'gal' });
  });

  test('a failed pack lookup withholds the order (r4)', async () => {
    expect(await standardOrderFor('p-1', { dbh: fakeDb(PRODUCT, null) })).toEqual({ name: 'Fixture Product', unavailable: true });
  });

  test('a verified pack that cannot be read withholds the order (r4)', async () => {
    const rows = [{ product_id: 'p-1', pack_size: 'one pallet of mystery' }];
    expect(await standardOrderFor('p-1', { dbh: fakeDb(PRODUCT, rows) })).toEqual({ name: 'Fixture Product', unavailable: true });
  });
});
