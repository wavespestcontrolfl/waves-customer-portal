// Owner ruling 2026-09-30 (split from #5377, codex r8 P1 "Bind auto-routed verdicts
// to the displayed decision"): a review verdict attaches to the decision the
// reviewer was LOOKING at. The auto-routed review sends that decision's id; the
// verdict writers lock the call's decision rows and reject (409
// STALE_ROUTE_DECISION) a submission whose displayed row is no longer the newest
// decision (a reprocess since the page loaded) or is not one of the call's
// decisions. No id (an older client): today's behavior, the newest row.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../middleware/auth', () => ({ authenticate: (req, res, next) => next() }));
jest.mock('../services/ai-assistant/assistant', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { resolveDisplayedRouteDecision, STALE_ROUTE_DECISION } = require('../services/call-routing-gates');
const { preferredRouteDecisionForFeedback } = require('../services/call-route-decisions');

const CALL = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const NEW = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const decisionRows = () => [
  { id: OLD, call_log_id: CALL, mode: 'enforce', decision_version: 'v2-1.49.0', created_at: '2026-01-01T00:00:00Z', revision: '1001', final_action_taken: 'auto_route' },
  { id: NEW, call_log_id: CALL, mode: 'enforce', decision_version: 'v2-1.50.0', created_at: '2026-01-02T00:00:00Z', revision: '2002', final_action_taken: 'auto_route' },
];
const newestByCreatedAt = (list) => [...list].sort((x, y) => new Date(y.created_at) - new Date(x.created_at))[0];

describe('resolveDisplayedRouteDecision', () => {
  test('no displayed id (an older client): the newest decision, as before', () => {
    expect(resolveDisplayedRouteDecision(decisionRows(), null, newestByCreatedAt).decision.id).toBe(NEW);
    expect(resolveDisplayedRouteDecision([], null, newestByCreatedAt).decision).toBeNull();
  });
  test('the displayed row is the newest: it is the decision', () => {
    expect(resolveDisplayedRouteDecision(decisionRows(), NEW, newestByCreatedAt)).toMatchObject({ decision: { id: NEW } });
  });
  test('the displayed row is no longer the newest: stale', () => {
    expect(resolveDisplayedRouteDecision(decisionRows(), OLD, newestByCreatedAt)).toMatchObject({ stale: true, decision: { id: NEW } });
  });
  test('an IN-PLACE update (same id, new revision) is stale; the revision the reviewer saw still passes', () => {
    const rows = decisionRows();
    expect(resolveDisplayedRouteDecision(rows, NEW, newestByCreatedAt, '2002')).toMatchObject({ decision: { id: NEW } });
    expect(resolveDisplayedRouteDecision(rows, NEW, newestByCreatedAt, 2002)).toMatchObject({ decision: { id: NEW } });
    expect(resolveDisplayedRouteDecision(rows, NEW, newestByCreatedAt, '2001')).toMatchObject({ stale: true });
    // an older client sends no revision: the id check alone
    expect(resolveDisplayedRouteDecision(rows, NEW, newestByCreatedAt, null)).toMatchObject({ decision: { id: NEW } });
  });
  test('the displayed row is not one of the call\'s decisions: missing', () => {
    expect(resolveDisplayedRouteDecision(decisionRows(), OTHER, newestByCreatedAt)).toEqual({ missing: true });
  });
});

// A fake transaction over an in-memory set of route_decisions rows.
function fakeDb({ rows = decisionRows() } = {}) {
  const state = { locked: 0, feedback: [], order: [] };
  const trx = (table) => {
    if (table === 'call_log') {
      // the call row lock (codex #5446 r1 P1): where({ id }).forUpdate().first('id')
      const chain = {
        where() { return chain; },
        forUpdate() { state.order.push('call_log'); return chain; },
        first() { return Promise.resolve({ id: CALL }); },
      };
      return chain;
    }
    if (table === 'route_decisions') {
      const conds = {};
      const chain = {
        where(c) { Object.assign(conds, c); return chain; },
        forUpdate() { state.locked += 1; state.order.push('route_decisions'); return chain; },
        select() { return Promise.resolve(rows.filter((r) => Object.entries(conds).every(([k, v]) => r[k] === v))); },
      };
      return chain;
    }
    if (table === 'route_feedback') {
      let payload;
      const chain = {
        insert(p) { payload = p; return chain; },
        onConflict() { return chain; },
        merge() { state.feedback.push(payload); return Object.assign(Promise.resolve(), { returning: () => Promise.resolve([{ id: 'fb-1', ...payload }]) }); },
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  };
  trx.raw = (sql) => ({ raw: sql }); // the revision (xmin) column rides the locked read
  db.mockImplementation((table) => {
    if (table === 'call_log') return { where: () => ({ first: () => Promise.resolve({ id: CALL }) }) };
    return trx(table);
  });
  db.schema = { hasTable: () => Promise.resolve(true) };
  db.transaction = async (fn) => fn(trx);
  return state;
}
const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const lastHandler = (router, p, method) => {
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

describe('POST /api/admin/triage/auto-routed/:callLogId/verdict', () => {
  const router = require('../routes/admin-triage');
  const post = async (body) => {
    const res = makeRes();
    await lastHandler(router, '/auto-routed/:callLogId/verdict', 'post')({ params: { callLogId: CALL }, body: { verdict: 'accept', ...body }, technicianId: 't1' }, res);
    return res;
  };

  test('the displayed decision is still the newest: the verdict lands on THAT row, under the row lock', async () => {
    const state = fakeDb();
    const res = await post({ route_decision_id: NEW });
    expect(res.statusCode).toBe(200);
    expect(state.locked).toBe(1);
    expect(state.feedback).toHaveLength(1);
    expect(state.feedback[0]).toMatchObject({ call_log_id: CALL, route_decision_id: NEW, decision_kind: 'auto_routed', verdict: 'accept' });
  });

  test('the CALL row is locked before the decision rows, the same order as the fenced upsertRouteDecision (codex #5446 r1 P1)', async () => {
    const state = fakeDb();
    await post({ route_decision_id: NEW });
    expect(state.order).toEqual(['call_log', 'route_decisions']);
  });

  test('a STALE view (a reprocess wrote a newer decision since it loaded): 409, nothing written', async () => {
    const state = fakeDb();
    const res = await post({ route_decision_id: OLD });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: STALE_ROUTE_DECISION });
    expect(state.feedback).toHaveLength(0);
  });

  test('a decision that is not one of the call\'s: 409, nothing written', async () => {
    const state = fakeDb();
    const res = await post({ route_decision_id: OTHER });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe(STALE_ROUTE_DECISION);
    expect(state.feedback).toHaveLength(0);
  });

  test('the SAME row updated in place since the page loaded (a refresh OR the outcome update: same id, new revision): 409, nothing written', async () => {
    const state = fakeDb();
    const res = await post({ route_decision_id: NEW, route_decision_revision: '2001' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe(STALE_ROUTE_DECISION);
    expect(state.feedback).toHaveLength(0);
    // the revision the reviewer saw still passes
    const ok = await post({ route_decision_id: NEW, route_decision_revision: '2002' });
    expect(ok.statusCode).toBe(200);
    expect(state.feedback[0].route_decision_id).toBe(NEW);
  });

  test('a malformed revision is a 400', async () => {
    fakeDb();
    expect((await post({ route_decision_id: NEW, route_decision_revision: 'yesterday-ish' })).statusCode).toBe(400);
  });

  test('the current decision is picked from the SAME set the list shows (codex #5446 r2 P2): a newer enforce row the list excludes does not make the displayed one stale', async () => {
    const rows = [...decisionRows(), { id: OTHER, call_log_id: CALL, mode: 'enforce', decision_version: 'legacy-call-v1', created_at: '2026-01-03T00:00:00Z', revision: '3003', final_action_taken: 'x' }];
    const state = fakeDb({ rows });
    const res = await post({ route_decision_id: NEW });
    expect(res.statusCode).toBe(200);
    expect(state.feedback[0].route_decision_id).toBe(NEW);
    // and the no-id fallback attaches to the listed decision too, never the unlisted one
    const fallback = fakeDb({ rows });
    await post({});
    expect(fallback.feedback[0].route_decision_id).toBe(NEW);
  });

  test('no id (an older client) falls back to today\'s behavior: the newest decision', async () => {
    const state = fakeDb();
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(state.feedback[0].route_decision_id).toBe(NEW);
  });

  test('a malformed id is a 400, never silently ignored', async () => {
    const state = fakeDb();
    const res = await post({ route_decision_id: 'not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(state.feedback).toHaveLength(0);
  });

  test('a call with no decision row at all and no id still records the verdict unlinked (as before)', async () => {
    const state = fakeDb({ rows: [] });
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(state.feedback[0].route_decision_id).toBeNull();
  });
});

describe('POST /api/ai/admin/calls/:id/route-feedback', () => {
  const router = require('../routes/ai-assistant');
  const post = async (body) => {
    const res = makeRes();
    const next = jest.fn();
    await lastHandler(router, '/admin/calls/:id/route-feedback', 'post')({ params: { id: CALL }, body: { verdict: 'accept', ...body }, technician: { first_name: 'T', last_name: 'One' } }, res, next);
    expect(next).not.toHaveBeenCalled();
    return res;
  };
  const rowsFor = () => decisionRows();

  test('locks the call\'s decision rows whole and writes the displayed, still-newest decision', async () => {
    const state = fakeDb({ rows: rowsFor() });
    const res = await post({ routeDecisionId: NEW });
    expect(res.statusCode).toBe(200);
    expect(state.locked).toBe(1);
    expect(state.feedback[0].route_decision_id).toBe(NEW);
  });

  test('the CALL row is locked before the decision rows here too (codex #5446 r1 P1)', async () => {
    const state = fakeDb({ rows: rowsFor() });
    await post({ routeDecisionId: NEW });
    expect(state.order).toEqual(['call_log', 'route_decisions']);
  });

  test('a stale displayed decision: 409 STALE_ROUTE_DECISION, nothing written', async () => {
    const state = fakeDb({ rows: rowsFor() });
    const res = await post({ routeDecisionId: OLD });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe(STALE_ROUTE_DECISION);
    expect(state.feedback).toHaveLength(0);
  });

  test('an in-place update of the displayed row (same id, new revision): 409, nothing written', async () => {
    const state = fakeDb({ rows: rowsFor() });
    const res = await post({ routeDecisionId: NEW, routeDecisionRevision: '2001' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe(STALE_ROUTE_DECISION);
    expect(state.feedback).toHaveLength(0);
    expect((await post({ routeDecisionId: NEW, routeDecisionRevision: '2002' })).statusCode).toBe(200);
  });

  test('an id that is not this call\'s decision keeps its existing 400', async () => {
    const state = fakeDb({ rows: rowsFor() });
    const res = await post({ routeDecisionId: OTHER });
    expect(res.statusCode).toBe(400);
    expect(state.feedback).toHaveLength(0);
  });

  test('no id (an older client): the preferred (newest enforce) decision, as before', async () => {
    const state = fakeDb({ rows: rowsFor() });
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(state.feedback[0].route_decision_id).toBe(preferredRouteDecisionForFeedback(rowsFor()).id);
  });
});

describe('the auto-routed review client', () => {
  test('sends the displayed route_decision_id and reloads on STALE_ROUTE_DECISION', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/TriageInboxTabV2.jsx'), 'utf8');
    expect(src).toMatch(/kind === "auto_routed" && item\.route_decision_id\s*\?/);
    expect(src).toMatch(/route_decision_id: item\.route_decision_id, route_decision_revision: item\.route_decision_revision \|\| null/);
    const log = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/CallLogTabV2.jsx'), 'utf8');
    expect(log).toMatch(/routeDecisionRevision: call\.routeDecision\?\.revision \|\| null/);
    expect(src).toMatch(/err\?\.code === 'STALE_ROUTE_DECISION'[\s\S]{0,200}load\(mode, status, autoOnly\)/);
  });
});

// Every route_decisions writer takes the call row lock first (codex #5446 r2 P1), and the
// auto-routed list and the verdict writer pick the current decision from one shared
// definition (r2 P2).
describe('route_decisions writers and the shared listed-decision predicate', () => {
  const root = path.join(__dirname, '..');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', 'models', '__tests__'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out); else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  test('the ONLY code that inserts into route_decisions is call-routing-gates (upsertRouteDecision, insertRouteDecisionLocked)', () => {
    const inserters = walk(root)
      .filter((f) => /route_decisions'\)\s*\.insert\(|into\s+route_decisions/i.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f));
    expect(inserters).toEqual(['services/call-routing-gates.js']);
    const gates = fs.readFileSync(path.join(root, 'services/call-routing-gates.js'), 'utf8');
    // each of the gate's writers locks the call row first
    expect(gates).toMatch(/async function insertRouteDecisionLocked[\s\S]*?await lockCallRow\(trx, payload\.call_log_id\);[\s\S]*?\.insert\(payload\)/);
    expect(gates).toMatch(/const write = async \(c\) => \{[\s\S]*?await lockCallRow\(c, decision\.call_log_id\);[\s\S]*?c\('route_decisions'\)\.insert\(decision\)/);
    expect(gates).toMatch(/async function updateUnreviewedRouteDecisions\(trx, scope, patch\) \{[\s\S]*?await lockCallRow\(trx, scope\.call_log_id\)/);
    expect(gates).toMatch(/async function withLockedRouteDecisions[\s\S]*?await lockCallRow\(trx, callLogId\);/);
  });

  test('the legacy shadow decision writer (processor x2 + the backfill) goes through the shared locked insert', () => {
    const src = fs.readFileSync(path.join(root, 'services/call-route-decisions.js'), 'utf8');
    expect(src).toMatch(/insertRouteDecisionLocked\(db, payload, \{ returning: \['id'\] \}\)/);
    expect(src).not.toMatch(/db\('route_decisions'\)/);
  });

  test('the list and the verdict writer share one definition of the listed decision', () => {
    const { isListedRouteDecision, routeDecisionsListedScope, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');
    expect(isListedRouteDecision({ mode: 'enforce', decision_version: 'v2-1.50.0' })).toBe(true);
    expect(isListedRouteDecision({ mode: 'shadow', decision_version: 'v2-1.50.0' })).toBe(false);
    expect(isListedRouteDecision({ mode: 'enforce', decision_version: 'legacy-call-v1' })).toBe(false);
    const knex = require('knex')({ client: 'pg' });
    const q = routeDecisionsListedScope(knex('route_decisions')).toSQL();
    expect(q.bindings).toEqual([...V2_DECISION_VERSIONS, 'enforce']);
    const triage = fs.readFileSync(path.join(root, 'routes/admin-triage.js'), 'utf8');
    expect(triage).toMatch(/routeDecisionsListedScope\(db\('route_decisions'\)/);
    expect(triage).toMatch(/filter\(isListedRouteDecision\)/);
    expect(triage).not.toMatch(/whereIn\('decision_version', V2_DECISION_VERSIONS\)/);
  });

  test('the list returns the revision (xmin) and the calls list maps it', () => {
    expect(fs.readFileSync(path.join(root, 'routes/admin-triage.js'), 'utf8')).toMatch(/\$\{ROUTE_DECISION_XMIN_TEXT\} AS route_decision_revision/);
    const ai = fs.readFileSync(path.join(root, 'routes/ai-assistant.js'), 'utf8');
    expect(ai).toMatch(/select\('route_decisions\.\*', db\.raw\(ROUTE_DECISION_REVISION_SQL\)\)/);
    expect(ai).toMatch(/revision: row\.revision == null \? null : String\(row\.revision\)/);
  });
});
