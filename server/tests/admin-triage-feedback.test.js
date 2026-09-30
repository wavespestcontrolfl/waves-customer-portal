jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const { __private } = require('../routes/admin-triage');
const { sanitizeWrongFields, denyRejectsUnitEvidence, WRONG_FIELDS, VERDICTS } = __private;

describe('route-feedback wrong_fields sanitization', () => {
  test('keeps only whitelisted field keys', () => {
    expect(sanitizeWrongFields(['name', 'address', 'bogus', 'service'])).toEqual(['name', 'address', 'service']);
  });

  test('dedupes repeated keys', () => {
    expect(sanitizeWrongFields(['name', 'name', 'address'])).toEqual(['name', 'address']);
  });

  test('non-array input → []', () => {
    expect(sanitizeWrongFields(undefined)).toEqual([]);
    expect(sanitizeWrongFields(null)).toEqual([]);
    expect(sanitizeWrongFields('name')).toEqual([]);
    expect(sanitizeWrongFields({ name: true })).toEqual([]);
  });

  test('all-bogus input → []', () => {
    expect(sanitizeWrongFields(['nope', 'huh'])).toEqual([]);
  });

  test('every whitelisted key survives a round-trip', () => {
    expect(sanitizeWrongFields([...WRONG_FIELDS])).toEqual(WRONG_FIELDS);
  });

  test('verdicts whitelist is exactly accept/deny', () => {
    expect(VERDICTS).toEqual(['accept', 'deny']);
  });
});

describe('denyRejectsUnitEvidence (codex r15 P1 on #3804)', () => {
  test('a whole-call deny (no wrong_fields) rejects the unit evidence', () => {
    expect(denyRejectsUnitEvidence([])).toBe(true);
  });

  test('a deny naming the address rejects it, alone or beside other fields', () => {
    expect(denyRejectsUnitEvidence(['address'])).toBe(true);
    expect(denyRejectsUnitEvidence(['service', 'address'])).toBe(true);
  });

  test('a field-scoped deny that never names the address leaves the customer\'s accepted unit standing', () => {
    for (const field of WRONG_FIELDS.filter((f) => f !== 'address')) expect(denyRejectsUnitEvidence([field])).toBe(false);
    expect(denyRejectsUnitEvidence(['service', 'scheduling'])).toBe(false);
  });
});

// GET /auto-routed reads the newest decision per call with its verdict through the
// shared family-aware join (codex #5377 r8 P1): a verdict counts for the row it
// points at, an identical family sibling, or a legacy unlinked verdict; a DIFFERENT
// newest decision reads unreviewed.
describe('/auto-routed attaches the verdict through the shared route_feedback join (codex #5377 r8 P1)', () => {
  const knex = require('knex')({ client: 'pg' });
  const db = require('../models/db');
  const router = require('../routes/admin-triage');

  test('the query joins route_feedback with the family-aware condition and lists revision versions', async () => {
    const sqls = [];
    db.mockImplementation((table) => {
      const qb = knex(table);
      qb.then = (res, rej) => { sqls.push(qb.toSQL()); return Promise.resolve([]).then(res, rej); };
      return qb;
    });
    db.raw = (...a) => knex.raw(...a);
    const layer = router.stack.find((l) => l.route && l.route.path === '/auto-routed' && l.route.methods.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await handler({ query: { limit: '5' } }, res);
    expect(res.json).toHaveBeenCalledWith({ items: [] });
    const { sql, bindings } = sqls[0];
    const { routeFeedbackJoinCondition } = require('../services/call-routing-gates');
    expect(sql.replace(/\s+/g, ' ')).toContain(`LEFT JOIN route_feedback ON ${routeFeedbackJoinCondition().replace(/\s+/g, ' ')}`);
    // the old by-call / by-id-only join is gone
    expect(sql).not.toMatch(/left join "route_feedback"/i);
    // the newest-per-call subquery spans base and revision versions
    expect(bindings).toEqual(expect.arrayContaining(['v2-1.50.0', 'v2-1.50.0+r1']));
  });
});
