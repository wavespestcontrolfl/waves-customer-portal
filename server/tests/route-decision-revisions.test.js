// A REVIEWED route_decisions row is never refreshed (route_feedback links to it
// by id), so a force-reprocess that decides DIFFERENTLY — a dark gate flipped,
// a rule changed — records a '+r<n>' REVISION row under a distinct audit key
// instead of leaving the booking standing beside a decision row that still
// says "held" (codex #5377 r4 P1). Gate-agnostic: it lives in the write
// chokepoint. The PostgreSQL behavior is in route-decision-upsert-postgres.test.js
// (CI); this file pins the statement shapes and the wiring without a database.
const fs = require('fs');
const path = require('path');
const knex = require('knex')({ client: 'pg' });
const {
  buildRouteDecision, upsertRouteDecision, V2_DECISION_VERSION, V2_DECISION_VERSIONS,
  V2_DECISION_VERSIONS_WITH_REVISIONS, ROUTE_DECISION_MAX_REVISIONS, routeDecisionRevisionVersion, routeDecisionFamilyVersions,
} = require('../services/call-routing-gates');

const extraction = { scheduling: { status: 'confirmed' }, confidence: { overall: 0.9 }, meta: {} };
const held = buildRouteDecision({
  callLogId: 'c1', extraction, finalTriageFlags: ['commercial_requires_quote'],
  routingResult: { allowed: false, reason: 'triage_flags', appointmentBlockingFlags: ['commercial_requires_quote'] },
  action: 'triage_review', recordingSid: 'RE1',
});
const booked = buildRouteDecision({ callLogId: 'c1', extraction, routingResult: { allowed: true }, action: 'auto_route', recordingSid: 'RE1' });
const rowOf = (d, extra = {}) => ({ id: 'row', ...d, blocked_reasons: JSON.parse(d.blocked_reasons), allowed_reasons: JSON.parse(d.allowed_reasons), ...extra });

// A recording conn whose responses are chosen per statement.
function conn(respond) {
  const sqls = [];
  const c = (table) => {
    const qb = knex(table);
    qb.then = (res, rej) => {
      const q = qb.toSQL();
      sqls.push(q);
      // Real knex hands .first() a single row (or undefined), not an array.
      const out = respond(q);
      return Promise.resolve(qb._method === 'first' && Array.isArray(out) ? out[0] : out).then(res, rej);
    };
    return qb;
  };
  c.raw = (...a) => knex.raw(...a);
  c.transaction = async (fn) => fn(c);
  return { c, sqls };
}
const rd = (sqls) => sqls.filter((q) => /route_decisions/.test(q.sql));
const inserts = (sqls) => rd(sqls).filter((q) => /^insert into "route_decisions"/i.test(q.sql));
const versionOf = (q) => q.bindings.find((b) => typeof b === 'string' && /^v2-/.test(b));

describe('revision versions', () => {
  test('bounded, varchar(30) safe, enumerable for every base version', () => {
    expect(routeDecisionRevisionVersion(V2_DECISION_VERSION, 1)).toBe('v2-1.50.0+r1');
    expect(routeDecisionFamilyVersions(V2_DECISION_VERSION)).toEqual(['v2-1.50.0', 'v2-1.50.0+r1']);
    expect(ROUTE_DECISION_MAX_REVISIONS).toBe(1); // route_feedback is one verdict per call
    expect(V2_DECISION_VERSIONS_WITH_REVISIONS).toEqual(expect.arrayContaining([...V2_DECISION_VERSIONS, 'v2-1.0.0+r1']));
    expect(new Set(V2_DECISION_VERSIONS_WITH_REVISIONS).size).toBe(V2_DECISION_VERSIONS_WITH_REVISIONS.length);
    expect(V2_DECISION_VERSIONS_WITH_REVISIONS.every((v) => v.length <= 30)).toBe(true);
    // the base list is untouched: still ends with the current version, no tags
    expect(V2_DECISION_VERSIONS[V2_DECISION_VERSIONS.length - 1]).toBe(V2_DECISION_VERSION);
    expect(V2_DECISION_VERSIONS.some((v) => v.includes('+'))).toBe(false);
  });
});

describe('a reviewed base row: a different verdict gets a NEW row under a distinct key', () => {
  // Base row reviewed: the row lock finds it, the guarded UPDATE touches nothing.
  const respond = (existing) => (q) => {
    if (/^insert/i.test(q.sql)) return [];
    if (/for update/i.test(q.sql)) return [{ id: 'row' }];
    if (/^update "route_decisions"/i.test(q.sql)) return 0;
    if (/^select \* from "route_decisions"/i.test(q.sql)) {
      const v = versionOf(q);
      return existing[v] ? [existing[v]] : [];
    }
    return [];
  };

  test('booked pass over a reviewed HOLD: writes v2-1.50.0+r1 (targetless insert), never touches the reviewed row', async () => {
    const { c, sqls } = conn(respond({ [V2_DECISION_VERSION]: rowOf(held) }));
    expect(await upsertRouteDecision(c, booked)).toBe(1);
    const ins = inserts(sqls);
    expect(ins).toHaveLength(2);
    expect(ins[0].bindings).toContain(V2_DECISION_VERSION); // the ordinary insert (no-op on conflict)
    expect(ins[1].sql).toMatch(/on conflict do nothing/i);
    expect(ins[1].sql).not.toMatch(/on conflict \(/i);
    expect(ins[1].bindings).toContain('v2-1.50.0+r1');
    expect(ins[1].bindings).toContain('auto_create_appointment');
    expect(ins[1].bindings).toContain('RE1');
  });

  test('the same verdict that was already judged writes nothing more', async () => {
    const { c, sqls } = conn(respond({ [V2_DECISION_VERSION]: rowOf(booked) }));
    expect(await upsertRouteDecision(c, booked)).toBe(0);
    expect(inserts(sqls)).toHaveLength(1); // only the ordinary (conflicting) insert
  });

  test('a revision row that is still unreviewed is refreshed in place (no r2)', async () => {
    const r1 = rowOf(held, { decision_version: 'v2-1.50.0+r1', final_action_taken: 'auto_route' });
    let updates = 0;
    const { c, sqls } = conn((q) => {
      if (/^update "route_decisions"/i.test(q.sql)) { updates += 1; return updates === 1 ? 0 : 1; } // base reviewed, r1 not
      return respond({ [V2_DECISION_VERSION]: rowOf(held), 'v2-1.50.0+r1': r1 })(q);
    });
    expect(await upsertRouteDecision(c, booked)).toBe(1);
    expect(inserts(sqls)).toHaveLength(1);
    expect(sqls.filter((q) => /^update "route_decisions"/i.test(q.sql))).toHaveLength(2);
  });

  test('a revision that repeats the reviewed verdict writes nothing; the cap stops any further row', async () => {
    const r1 = rowOf(booked, { decision_version: 'v2-1.50.0+r1' });
    // both rows reviewed cannot happen today (one verdict per call) — the cap keeps it bounded anyway
    const { c, sqls } = conn((q) => (/^update "route_decisions"/i.test(q.sql) ? 0 : respond({ [V2_DECISION_VERSION]: rowOf(held), 'v2-1.50.0+r1': r1 })(q)));
    expect(await upsertRouteDecision(c, held)).toBe(0);
    expect(inserts(sqls)).toHaveLength(1);
  });

  test('the ordinary case is unchanged: an unreviewed base row is refreshed, no revision statements', async () => {
    const { c, sqls } = conn((q) => (/^update "route_decisions"/i.test(q.sql) ? 1 : respond({})(q)));
    expect(await upsertRouteDecision(c, booked)).toBe(1);
    expect(rd(sqls).map((q) => q.sql.split(' ')[0])).toEqual(['insert', 'select', 'update']);
  });

  test('a lost claim still writes nothing at all', async () => {
    const { c, sqls } = conn(() => []);
    c.transaction = async (fn) => fn((t) => {
      const qb = c(t);
      if (t === 'call_log') qb.then = (res, rej) => Promise.resolve(undefined).then(res, rej);
      return qb;
    });
    expect(await upsertRouteDecision(Object.assign(c, {}), booked, { callLogId: 'c1', processingToken: 'stale' })).toBeNull();
    expect(rd(sqls)).toHaveLength(0);
  });
});

describe('wiring', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('the same-run outcome update targets the pass\'s revision family, still through the row lock', () => {
    const src = read('../services/call-recording-processor.js');
    expect(src).toMatch(/decision_version: routeDecisionFamilyVersions\(V2_DECISION_VERSION\), mode: 'enforce'/);
    expect(src).toMatch(/db\.transaction\(\(trx\) => updateUnreviewedRouteDecisions\(trx,/);
  });

  test('the outcome update scope accepts an array as an IN list', async () => {
    const { updateUnreviewedRouteDecisions } = require('../services/call-routing-gates');
    const { c, sqls } = conn((q) => (/for update/i.test(q.sql) ? [{ id: 'a' }] : 1));
    await updateUnreviewedRouteDecisions(c, { call_log_id: 'c1', decision_version: ['v2-1.50.0', 'v2-1.50.0+r1'], mode: 'enforce' }, { final_action_taken: 'auto_route' });
    expect(sqls[0].sql).toMatch(/"decision_version" in \(\?, \?\)/i);
    expect(sqls[0].bindings).toEqual(['c1', 'v2-1.50.0', 'v2-1.50.0+r1', 'enforce']);
  });

  test('the auto-routed queue lists every revision version and joins a verdict only to the decision it judged', () => {
    const src = read('../routes/admin-triage.js');
    expect(src).toMatch(/whereIn\('decision_version', V2_DECISION_VERSIONS_WITH_REVISIONS\)/);
    expect(src).toMatch(/onNull\('route_feedback\.route_decision_id'\)\.orOn\('route_feedback\.route_decision_id', 'route_decisions\.id'\)/);
  });
});
