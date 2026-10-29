/**
 * The Intelligence Bar's general read admits GET /api/admin/health/scores/:customerId only because a read no longer
 * creates or alters a table. The health router used to run ensureHealthTables (CREATE TABLE and ALTER TABLE, once per
 * process) as router-level middleware in front of every route; it now sits only in front of the four write routes.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: function adminAuthenticate(req, res, next) { next(); }, requireAdmin: function requireAdmin(req, res, next) { next(); } }));
const mockSchema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true), createTable: jest.fn(), alterTable: jest.fn() };
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const q = {};
    for (const method of ['join', 'where', 'whereIn', 'orderBy', 'limit', 'select']) q[method] = () => q;
    q.first = async () => ({ customer_id: 'c1', overall_score: 61, payment_details: '{}', churn_signals: '[]' });
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  });
  db.schema = mockSchema;
  db.raw = jest.fn((sql) => sql);
  return db;
});
const router = require('../routes/admin-health');

const route = (method, path) => router.stack.find((layer) => layer.route && layer.route.path === path && layer.route.methods[method]).route;
const middlewareNames = (r) => r.stack.map((layer) => layer.handle.name);

describe('the health router never runs DDL in front of a read', () => {
  test('router-level middleware is the two auth guards only', () => {
    expect(router.stack.filter((layer) => !layer.route).map((layer) => layer.handle.name)).toEqual(['adminAuthenticate', 'requireAdmin']);
  });

  test('no GET route has the table safety net in front of it', () => {
    const reads = router.stack.filter((layer) => layer.route && layer.route.methods.get);
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const layer of reads) expect(middlewareNames(layer.route)).not.toContain('ensureHealthTablesOnce');
  });

  test('the four write routes keep it', () => {
    for (const [method, path] of [['post', '/rescore/:customerId'], ['post', '/rescore-all'], ['put', '/alerts/:id'], ['post', '/alerts/:id/action']]) {
      expect(middlewareNames(route(method, path))).toContain('ensureHealthTablesOnce');
    }
  });

  test('GET /scores/:customerId answers without touching the schema builder', async () => {
    const handler = route('get', '/scores/:customerId').stack.at(-1).handle;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler({ params: { customerId: 'c1' } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ score: expect.objectContaining({ overall_score: 61 }) }));
    for (const method of Object.keys(mockSchema)) expect(mockSchema[method]).not.toHaveBeenCalled();
  });
});
