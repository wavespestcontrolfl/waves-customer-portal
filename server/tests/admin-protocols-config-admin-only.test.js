/**
 * P1-5 (07-19 admin audit): admin-protocols.js is requireTechOrAdmin at the
 * router level, so a technician token can reach it — intended, because the
 * tech portal reads protocol scripts/equipment/photos for field reference. But
 * a technician must NOT author or publish the global lawn protocol. The
 * global-config authoring/publishing routes carry their own requireAdmin;
 * field readiness/stock ops stay tech-accessible.
 *
 * Pins the wiring by inspecting the router's layer stack (no service/db boot).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = () => ({});
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const protocolsRouter = require('../routes/admin-protocols');

const chainFor = (path, method) => {
  const layer = protocolsRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle.name);
};

describe('protocol global-config writes are admin-gated (P1-5)', () => {
  test.each([
    ['/lawn/drafts', 'post'],
    ['/lawn/drafts/:id/publish', 'post'],
    ['/lawn/products/:id', 'put'],
    ['/lawn/windows/:windowKey', 'put'],
    ['/lawn/windows/:windowKey/wiki-sync', 'post'],
    ['/lawn/gates/:id', 'put'],
  ])('requireAdmin gates %s [%s]', (path, method) => {
    expect(chainFor(path, method)).toContain('requireAdmin');
  });

  test('field readiness ops stay tech-accessible (no requireAdmin)', () => {
    expect(chainFor('/lawn/readiness/:serviceId/assign', 'post')).not.toContain('requireAdmin');
    expect(chainFor('/lawn/readiness/:serviceId/restock-requests', 'post')).not.toContain('requireAdmin');
  });
});
