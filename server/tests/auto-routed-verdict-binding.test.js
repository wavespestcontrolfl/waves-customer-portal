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
  { id: OLD, call_log_id: CALL, mode: 'enforce', decision_version: 'v2-1.50.0', created_at: '2026-01-01T00:00:00Z', final_action_taken: 'auto_route' },
  { id: NEW, call_log_id: CALL, mode: 'enforce', decision_version: 'v2-1.50.0+r1', created_at: '2026-01-02T00:00:00Z', final_action_taken: 'auto_route' },
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
  test('the displayed row is not one of the call\'s decisions: missing', () => {
    expect(resolveDisplayedRouteDecision(decisionRows(), OTHER, newestByCreatedAt)).toEqual({ missing: true });
  });
});

// A fake transaction over an in-memory set of route_decisions rows.
function fakeDb({ rows = decisionRows() } = {}) {
  const state = { locked: 0, feedback: [] };
  const trx = (table) => {
    if (table === 'route_decisions') {
      const conds = {};
      const chain = {
        where(c) { Object.assign(conds, c); return chain; },
        forUpdate() { state.locked += 1; return chain; },
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

  test('a stale displayed decision: 409 STALE_ROUTE_DECISION, nothing written', async () => {
    const state = fakeDb({ rows: rowsFor() });
    const res = await post({ routeDecisionId: OLD });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe(STALE_ROUTE_DECISION);
    expect(state.feedback).toHaveLength(0);
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
    expect(src).toMatch(/kind === "auto_routed" && item\.route_decision_id \? \{ route_decision_id: item\.route_decision_id \} : \{\}/);
    expect(src).toMatch(/err\?\.code === 'STALE_ROUTE_DECISION'[\s\S]{0,200}load\(mode, status, autoOnly\)/);
  });
});
