// A REVIEWED route_decisions row is never mutated (route_feedback links to it
// by id), yet every pass needs ONE writable row for its decision and its later
// outcome (codex #5377 r4 / r7 / r8 P1). A decision's family is its base row plus
// a '+r1' revision; the pass always writes the family's UNREVIEWED member,
// whatever its verdict, and readers attach a verdict to an identical sibling
// through one shared join. Gate-agnostic: it lives in the write chokepoint. The
// PostgreSQL behavior is in route-decision-upsert-postgres.test.js; this file pins
// the statement shapes and the wiring without a database.
const fs = require('fs');
const path = require('path');
const knex = require('knex')({ client: 'pg' });
const {
  buildRouteDecision, upsertRouteDecision, V2_DECISION_VERSION, V2_DECISION_VERSIONS,
  V2_DECISION_VERSIONS_WITH_REVISIONS, ROUTE_DECISION_MAX_REVISIONS, routeDecisionRevisionVersion, routeDecisionFamilyVersions,
  routeFeedbackJoinCondition, leftJoinRouteFeedback, innerJoinRouteFeedback,
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

  test('reviewed BASE, the SAME verdict: the pass STILL writes its own row (+r1), so it has a row for its outcome', async () => {
    const r = await run(family({ members: { [V2_DECISION_VERSION]: row(booked, V2_DECISION_VERSION) }, reviewed: V2_DECISION_VERSION }), booked);
    expect(r).toMatchObject({ n: 1, out: { decisionVersion: REV } });
    expect(r.ins).toHaveLength(2);
    expect(r.ins[1].bindings).toContain(REV);
    expect(r.upd).toHaveLength(0); // the reviewed base is never touched
  });

  test('reviewed +r1 (a re-review repointed the verdict), the SAME verdict: the unreviewed BASE is refreshed (the pass\'s writable row); the reviewed +r1 is never touched (codex r8 P1)', async () => {
    const members = { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION), [REV]: row(booked, REV) };
    const r = await run(family({ members, reviewed: REV }), booked);
    expect(r).toMatchObject({ n: 1, out: { decisionVersion: V2_DECISION_VERSION } });
    expect(r.upd).toHaveLength(1);
    expect(r.upd[0].bindings).toContain('id-v2-1.50.0');
    for (const q of [...r.upd, ...r.ins]) expect(q.bindings).not.toContain(`id-${REV}`);
    expect(r.ins).toHaveLength(1);
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

  test('decisionVersion is ALWAYS the row written; null only on a lost fence', async () => {
    for (const reviewed of [null, V2_DECISION_VERSION, REV]) {
      const members = { [V2_DECISION_VERSION]: row(held, V2_DECISION_VERSION), [REV]: row(booked, REV) };
      for (const d of [held, booked]) {
        const { out } = await run(family({ members, reviewed }), d);
        expect(out.decisionVersion).toBe(reviewed === V2_DECISION_VERSION ? REV : V2_DECISION_VERSION);
      }
    }
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

  test('the auto-routed queue lists every revision version and joins a verdict through the ONE shared family-aware join', () => {
    const src = read('../routes/admin-triage.js');
    expect(src).toMatch(/whereIn\('decision_version', V2_DECISION_VERSIONS_WITH_REVISIONS\)/);
    expect(src).toMatch(/leftJoinRouteFeedback\(db\('route_decisions'\)/);
    expect(src).not.toMatch(/route_feedback\.route_decision_id', 'route_decisions\.id'/);
  });

  test('the calls list (ai-assistant) uses the same join for the verdict beside the chosen decision', () => {
    const src = read('../routes/ai-assistant.js');
    expect(src).toMatch(/innerJoinRouteFeedback\(db\('route_decisions'\)\.whereIn\('route_decisions\.id', chosenIds\)\)/);
  });

  test('no reader joins route_feedback to route_decisions by hand: calibration keys on the pointed-at row, everything else uses the shared join', () => {
    const glob = (dir) => fs.readdirSync(path.join(__dirname, dir)).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, dir, f));
    const offenders = [...glob('../routes'), ...glob('../services'), ...glob('../scripts')]
      .filter((f) => !/call-routing-gates\.js$/.test(f))
      .filter((f) => /route_feedback/.test(fs.readFileSync(f, 'utf8')) && /route_decisions/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));
    // admin-triage (auto-routed queue: shared join; upsertFeedback: writer),
    // ai-assistant (calls list: shared join; route-calibration: by pointed-at id; writer)
    expect(offenders.sort()).toEqual(['admin-triage.js', 'ai-assistant.js']);
  });

  test('the shared join compares the exact columns that define the decision the reviewer saw, within one call/mode/recording/base version', () => {
    const sql = routeFeedbackJoinCondition();
    for (const col of ['validator_recommendation', 'final_action_taken', 'blocked_reasons', 'allowed_reasons']) {
      expect(sql).toContain(`reviewed_rd.${col} IS NOT DISTINCT FROM route_decisions.${col}`);
    }
    expect(sql).toContain("split_part(reviewed_rd.decision_version, '+', 1) = split_part(route_decisions.decision_version, '+', 1)");
    for (const col of ['call_log_id', 'mode', 'recording_sid']) expect(sql).toContain(`reviewed_rd.${col} = route_decisions.${col}`);
    expect(sql).toContain('route_feedback.route_decision_id IS NULL');
    expect(sql).toContain('route_feedback.route_decision_id = route_decisions.id');
    const q = leftJoinRouteFeedback(knex('route_decisions').leftJoin('call_log', 'route_decisions.call_log_id', 'call_log.id')).toSQL().sql;
    expect(q).toMatch(/left join "call_log".* LEFT JOIN route_feedback ON route_feedback\.call_log_id = route_decisions\.call_log_id/s);
    expect(innerJoinRouteFeedback(knex('route_decisions')).toSQL().sql).toMatch(/ JOIN route_feedback ON /);
  });
});
