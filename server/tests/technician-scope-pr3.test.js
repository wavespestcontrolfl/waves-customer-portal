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
