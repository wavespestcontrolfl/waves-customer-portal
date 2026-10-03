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

describe('technician restock requests stay deduplicated (codex #5683 r3)', () => {
  test('allowDuplicate is honoured for an admin only', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes/admin-inventory.js'), 'utf8');
    const handler = src.slice(src.indexOf("router.post('/waveguard-forecast/:productId/restock-request'"));
    expect(handler.slice(0, 1200)).toMatch(/allowDuplicate: req\.techRole === 'admin' \? body\.allowDuplicate : false,/);
    expect(handler.slice(0, 1200)).not.toMatch(/allowDuplicate: body\.allowDuplicate,/);
  });
});
