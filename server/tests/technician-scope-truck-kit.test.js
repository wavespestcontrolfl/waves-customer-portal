// The truck check is the one technician write the truck kit adds
// (docs/tool-inventory-tracker-scope.md, owner decision 4): the technician
// reads and records their own truck's check and nothing else under it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());

const { technicianMayReach, TECHNICIAN_ALLOW_LIST } = require('../middleware/technician-scope');

test('a technician reaches GET and POST /api/tech/truck-check and nothing under it', () => {
  expect(technicianMayReach('GET', '/api/tech/truck-check')).toBe(true);
  expect(technicianMayReach('POST', '/api/tech/truck-check')).toBe(true);
  expect(technicianMayReach('DELETE', '/api/tech/truck-check')).toBe(false);
  expect(technicianMayReach('GET', '/api/tech/truck-check/other')).toBe(false);
  expect(TECHNICIAN_ALLOW_LIST.find((e) => e.pattern.test('/api/tech/truck-check')).bucket).toBe('own-truck');
});

test('equipment stays read-only for a technician: alert resolution is not on the list', () => {
  expect(technicianMayReach('PUT', '/api/admin/equipment-maintenance/alerts/abc')).toBe(false);
});
