/**
 * /protocol-health template counts (no-card PR): the pest program no longer holds copies of the rodent and mosquito
 * cards (old visits 5 and 6), so every pest visit counts as a pest template.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ sql }));
  db.schema = { hasTable: jest.fn(async () => true) };
  db.transaction = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const protocols = require('../config/protocols.json');
const { _test: { protocolTemplateCounts } } = require('../routes/admin-inventory');

test('the pest template count is every pest card, and the pest program holds no rodent or mosquito copy', () => {
  const counts = protocolTemplateCounts();
  expect(counts.pest).toBe(protocols.pest.visits.length);
  expect(counts.pest).toBeGreaterThan(1);
  expect(protocols.pest.visits.map((visit) => visit.visit)).not.toEqual(expect.arrayContaining([5]));
  expect(protocols.pest.visits.map((visit) => visit.visit)).not.toEqual(expect.arrayContaining([6]));
  expect(counts.rodent).toBe(protocols.rodent.visits.length);
  expect(counts.mosquito).toBe(protocols.mosquito.visits.length);
});
