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

describe('the family rule (codex #5377 r4 + r7 P1): read base + +r1 FOR UPDATE, find the reviewed member, then write', () => {
  const REV = `${V2_DECISION_VERSION}+r1`;
  const row = (d, version, extra = {}) => rowOf(d, { id: `id-${version}`, decision_version: version, created_at: '2026-01-01T00:00:00Z', ...extra });
  // members: { [version]: row }, reviewed: version whose row has the (one) verdict
  function family({ members, reviewed = null }) {
    return conn((q) => {
      if (/^insert/i.test(q.sql)) return [];
      if (/^select \* from "route_decisions"/i.test(q.sql)) return Object.values(members);
      if (/^select "route_decision_id" from "route_feedback"/i.test(q.sql)) {
        return reviewed ? [{ route_decision_id: members[reviewed].id }] : [];
      }
      return 1; // updates
    });
  }
  const updates = (sqls) => sqls.filter((q) => /^update "route_decisions"/i.test(q.sql));
  const run = async (fam, d, out = {}) => ({ n: await upsertRouteDecision(fam.c, d, null, out), out, upd: updates(fam.sqls), ins: inserts(fam.sqls) });

  test('none reviewed: the base row is refreshed by id (first pass: the plain insert alone)', async () => {
    const r = await run(family({ members: { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION) } }), booked);
    expect(r).toMatchObject({ n: 1, out: { decisionVersion: V2_DECISION_VERSION } });
    expect(r.ins).toHaveLength(1);
    expect(r.upd).toHaveLength(1);
    expect(r.upd[0].bindings).toContain('id-v2-1.50.0');
  });

  test('reviewed BASE, different verdict: a NEW +r1 row (targetless insert), the reviewed row untouched', async () => {
    const r = await run(family({ members: { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION) }, reviewed: V2_DECISION_VERSION }), booked);
    expect(r).toMatchObject({ n: 1, out: { decisionVersion: REV } });
    expect(r.ins).toHaveLength(2);
    expect(r.ins[1].sql).toMatch(/on conflict do nothing/i);
    expect(r.ins[1].sql).not.toMatch(/on conflict \(/i);
    expect(r.ins[1].bindings).toContain(REV);
    expect(r.ins[1].bindings).toContain('auto_create_appointment');
    expect(r.upd).toHaveLength(0);
  });

  test('reviewed BASE, different verdict, unreviewed +r1 exists: the +r1 is refreshed in place', async () => {
    const members = { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION), [REV]: row(held, REV) };
    const r = await run(family({ members, reviewed: V2_DECISION_VERSION }), booked);
    expect(r).toMatchObject({ n: 1, out: { decisionVersion: REV } });
    expect(r.ins).toHaveLength(1);
    expect(r.upd).toHaveLength(1);
    expect(r.upd[0].bindings).toContain(`id-${REV}`);
  });

  test('reviewed BASE, the SAME verdict: nothing is written and the pass reports no row', async () => {
    const r = await run(family({ members: { [V2_DECISION_VERSION]: row(booked, V2_DECISION_VERSION) }, reviewed: V2_DECISION_VERSION }), booked);
    expect(r).toMatchObject({ n: 0, out: { decisionVersion: null } });
    expect(r.ins).toHaveLength(1); // only the plain (conflicting) insert
    expect(r.upd).toHaveLength(0);
  });

  test('reviewed +r1 (a re-review repointed the verdict), the SAME verdict: nothing written, the unreviewed base is NOT refreshed (codex r7 P1)', async () => {
    const members = { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION, { created_at: '2026-01-01T00:00:00Z' }), [REV]: row(booked, REV, { created_at: '2026-01-02T00:00:00Z' }) };
    const r = await run(family({ members, reviewed: REV }), booked);
    expect(r).toMatchObject({ n: 0, out: { decisionVersion: null } });
    expect(r.upd).toHaveLength(0); // reviewed +r1 is already the newest: no write at all
    expect(r.ins).toHaveLength(1);
  });

  test('reviewed +r1, the SAME verdict, but the stale base is the NEWER row: only the reviewed row\'s created_at moves up, its verdict columns are untouched', async () => {
    const members = { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION, { created_at: '2026-01-03T00:00:00Z' }), [REV]: row(booked, REV, { created_at: '2026-01-02T00:00:00Z' }) };
    const r = await run(family({ members, reviewed: REV }), booked);
    expect(r.n).toBe(0);
    expect(r.upd).toHaveLength(1);
    expect(r.upd[0].sql).toMatch(/^update "route_decisions" set "created_at" = \? where "id" = \?/i);
    expect(r.upd[0].bindings).toContain(`id-${REV}`);
    expect(r.upd[0].bindings).not.toContain('id-v2-1.50.0');
  });

  test('reviewed +r1, a DIFFERENT verdict: the (unreviewed) BASE is refreshed', async () => {
    const members = { [V2_DECISION_VERSION]: row(booked, V2_DECISION_VERSION), [REV]: row(booked, REV) };
    const r = await run(family({ members, reviewed: REV }), held);
    expect(r).toMatchObject({ n: 1, out: { decisionVersion: V2_DECISION_VERSION } });
    expect(r.upd).toHaveLength(1);
    expect(r.upd[0].bindings).toContain('id-v2-1.50.0');
    expect(r.ins).toHaveLength(1);
  });

  test('the family is locked FOR UPDATE and the verdict is read AFTER the lock, in the same transaction', async () => {
    const fam = family({ members: { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION) } });
    await run(fam, booked);
    const at = (re) => fam.sqls.findIndex((q) => re.test(q.sql));
    expect(at(/^select \* from "route_decisions".* for update/i)).toBeGreaterThan(at(/^insert/i));
    expect(at(/^select "route_decision_id" from "route_feedback"/i)).toBeGreaterThan(at(/for update/i));
  });

  test('a lost claim writes nothing at all and reports no row', async () => {
    const { c, sqls } = conn(() => []);
    c.transaction = async (fn) => fn((t) => {
      const qb = c(t);
      if (t === 'call_log') qb.then = (res, rej) => Promise.resolve(undefined).then(res, rej);
      return qb;
    });
    const out = {};
    expect(await upsertRouteDecision(Object.assign(c, {}), booked, { callLogId: 'c1', processingToken: 'stale' }, out)).toBeNull();
    expect(out.decisionVersion).toBeNull();
    expect(rd(sqls)).toHaveLength(0);
  });
});

describe('wiring', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('the same-run outcome update targets the row THIS pass wrote (reported by the upsert), still through the row lock; a pass that wrote none updates none', () => {
    const src = read('../services/call-recording-processor.js');
    expect(src).toMatch(/upsertRouteDecision\(db, routeDecision, \{ callLogId: call\.id, processingToken: procToken \}, routeDecisionWrite\)/);
    expect(src).toMatch(/const outcomeVersion = routeDecisionWrite\.decisionVersion === undefined\s*\? routeDecisionFamilyVersions\(V2_DECISION_VERSION\)\s*: routeDecisionWrite\.decisionVersion;\s*if \(outcomeVersion\) \{\s*await db\.transaction\(\(trx\) => updateUnreviewedRouteDecisions\(trx,/);
    expect(src).toMatch(/decision_version: outcomeVersion, mode: 'enforce'/);
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
