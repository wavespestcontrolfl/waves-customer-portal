// The route_decisions write chokepoint (upsertRouteDecision): a reprocess that
// decides differently REFRESHES the row for its call/mode/recording, so the
// newest decision always reflects the latest pass — whatever the version, and
// in either direction of a dark-gate flip. CI's DATABASE_URL pass runs this
// against PostgreSQL in a throwaway schema (minimal tables shaped like the real
// migrations: 20260429000012 + 20260902000001).
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const { buildRouteDecision, upsertRouteDecision, updateUnreviewedRouteDecisions, withLockedRouteDecisions, insertRouteDecisionLocked, resolveDisplayedRouteDecision, V2_DECISION_VERSION, routeDecisionFamilyVersions, leftJoinRouteFeedback, innerJoinRouteFeedback } = require('../services/call-routing-gates');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('upsertRouteDecision on PostgreSQL', () => {
  let db;
  const schema = `route_upsert_${randomUUID().replaceAll('-', '')}`;
  const callId = randomUUID();
  const extraction = { scheduling: { status: 'confirmed' }, confidence: { overall: 0.9 }, meta: {} };
  const decision = (allowed, action) => buildRouteDecision({
    callLogId: callId, extraction, finalTriageFlags: ['ambiguous_pest_or_service'],
    routingResult: allowed ? { allowed: true } : { allowed: false, reason: 'triage_flags', appointmentBlockingFlags: ['ambiguous_pest_or_service'] },
    action, mode: 'enforce', recordingSid: 'RE1',
  });
  const rows = () => db('route_decisions').where({ call_log_id: callId }).orderBy('created_at', 'desc');

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.raw('CREATE TABLE call_log (id uuid PRIMARY KEY, processing_token text)');
    await db.raw(`CREATE TABLE route_decisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_log_id uuid NOT NULL, decision_version varchar(30) NOT NULL, mode varchar(20) NOT NULL,
      recording_sid varchar(64) NOT NULL DEFAULT '',
      validator_recommendation varchar(50), final_action_taken varchar(50),
      blocked_reasons jsonb, allowed_reasons jsonb,
      created_scheduled_service_id uuid, sms_enqueued boolean DEFAULT false,
      ai_validation_model varchar(50), ai_validation_prompt_version varchar(30), ai_validation_schema_version varchar(30),
      created_at timestamptz NOT NULL DEFAULT now())`);
    await db.raw('CREATE TABLE route_feedback (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_log_id uuid NOT NULL UNIQUE, route_decision_id uuid, verdict varchar(10) NOT NULL)');
    await db.raw('CREATE UNIQUE INDEX route_decisions_call_version_mode_recording_uniq ON route_decisions (call_log_id, decision_version, mode, recording_sid)');
  });
  beforeEach(async () => {
    await db('route_feedback').del();
    await db('route_decisions').del();
    await db('call_log').del();
    await db('call_log').insert({ id: callId, processing_token: 'tok-new' });
  });
  afterAll(async () => {
    await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await db.destroy();
  });

  test('first write inserts one row', async () => {
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ decision_version: V2_DECISION_VERSION, validator_recommendation: 'auto_create_appointment', final_action_taken: 'auto_route' });
  });

  test('gate ON -> OFF: a held reprocess replaces the earlier auto_route verdict and refreshes created_at', async () => {
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    const serviceId = randomUUID();
    await db('route_decisions').where({ call_log_id: callId }).update({ created_scheduled_service_id: serviceId, created_at: new Date('2026-01-01T00:00:00Z') });
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    const r = await rows();
    expect(r).toHaveLength(1); // same key: refreshed, not duplicated
    expect(r[0]).toMatchObject({ validator_recommendation: 'needs_review', final_action_taken: 'triage_review' });
    expect(r[0].blocked_reasons).toEqual(['ambiguous_pest_or_service']);
    expect(new Date(r[0].created_at).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
    // outcome linkage from the earlier pass is NOT orphaned
    expect(r[0].created_scheduled_service_id).toBe(serviceId);
  });

  test('a decision a human already REVIEWED is never refreshed (codex r6 P1)', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    const [reviewed] = await rows();
    await db('route_feedback').insert({ call_log_id: callId, route_decision_id: reviewed.id, verdict: 'accept' });
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    const r = await rows();
    // the pass's different verdict is its own '+r1' row (codex #5377 r4 P1)...
    expect(r).toHaveLength(2);
    expect(r[0].decision_version).toBe(`${V2_DECISION_VERSION}+r1`);
    // ...and the row the human judged is exactly as judged
    const judged = r.find((x) => x.id === reviewed.id);
    expect(judged).toMatchObject({ validator_recommendation: 'needs_review', final_action_taken: 'triage_review' });
    expect(judged.blocked_reasons).toEqual(['ambiguous_pest_or_service']);
    expect(new Date(judged.created_at).getTime()).toBe(new Date(reviewed.created_at).getTime());
  });

  test('feedback on a DIFFERENT decision row does not freeze this one', async () => {
    await db('route_decisions').insert({ ...decision(true, 'auto_route'), decision_version: 'v2-1.49.0' });
    const [old] = await db('route_decisions').where({ decision_version: 'v2-1.49.0' });
    await db('route_feedback').insert({ call_log_id: callId, route_decision_id: old.id, verdict: 'deny' });
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    const cur = await db('route_decisions').where({ decision_version: V2_DECISION_VERSION });
    expect(cur[0].final_action_taken).toBe('triage_review');
  });

  test('a different-version legacy row never outranks the refreshed one', async () => {
    await db('route_decisions').insert({ ...decision(true, 'auto_route'), decision_version: 'v2-1.49.0', created_at: new Date('2026-01-01T00:00:00Z') });
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    const newest = await db('route_decisions').select(db.raw('DISTINCT ON (call_log_id) id, decision_version, final_action_taken')).where('mode', 'enforce').orderByRaw('call_log_id, created_at DESC');
    expect(newest).toHaveLength(1);
    expect(newest[0]).toMatchObject({ decision_version: V2_DECISION_VERSION, final_action_taken: 'triage_review' });
  });

  test('a superseded worker (processing token no longer held) cannot overwrite the current pass', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-stale' });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].final_action_taken).toBe('triage_review');
  });

  test('a superseded worker whose FIRST write comes late inserts nothing (codex r8 P1)', async () => {
    // tok-new owns the call; the stale worker arrives with no row yet written.
    const out = await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-stale' });
    expect(out).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  test('an incomplete fence writes nothing', async () => {
    expect(await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: null })).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  test('a different recording is its own row', async () => {
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    await upsertRouteDecision(db, { ...decision(true, 'auto_route'), recording_sid: 'RE2' }, { callLogId: callId, processingToken: 'tok-new' });
    expect(await rows()).toHaveLength(2);
  });

  // codex #5371 r9 P1: a verdict and a refresh serialize on the route_decisions
  // row lock, whichever order they arrive in.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scope = () => ({ call_log_id: callId, decision_version: V2_DECISION_VERSION, mode: 'enforce', recording_sid: 'RE1' });

  test('a verdict holding the row lock BLOCKS a concurrent refresh, and the refresh then finds the feedback and leaves the reviewed row alone', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    let release;
    const gate = new Promise((r) => { release = r; });
    let locked;
    const lockedP = new Promise((r) => { locked = r; });
    const feedback = withLockedRouteDecisions(db, { callLogId: callId, mode: 'enforce' }, async (trx, decisionRows) => {
      locked();
      await gate; // the reviewer is mid-write while the reprocess arrives
      await trx('route_feedback').insert({ call_log_id: callId, route_decision_id: decisionRows[0].id, verdict: 'accept' });
    });
    await lockedP;
    let refreshed = false;
    const refresh = upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' }).then((n) => { refreshed = true; return n; });
    await sleep(400);
    expect(refreshed).toBe(false); // serialized behind the verdict's row lock
    release();
    await Promise.all([feedback, refresh]);
    const all = await rows();
    const row = all.find((x) => x.decision_version === V2_DECISION_VERSION);
    // the row the reviewer judged is exactly as judged; the refresh became a revision row
    expect(row).toMatchObject({ validator_recommendation: 'needs_review', final_action_taken: 'triage_review' });
    expect(all.map((x) => x.decision_version)).toEqual([`${V2_DECISION_VERSION}+r1`, V2_DECISION_VERSION]);
    const [fb] = await db('route_feedback').where({ call_log_id: callId });
    expect(fb.route_decision_id).toBe(row.id);
  });

  // codex #5446 r1 P1: FOR UPDATE on the decision rows that exist when the verdict
  // reads cannot stop a reprocess INSERTING a new decision row (a new recording key)
  // after that snapshot. The verdict writer therefore locks the CALL row first, the
  // same order the fenced upsertRouteDecision takes, so such an insert waits for the
  // verdict to finish.
  test('a verdict holding its locks BLOCKS a reprocess that would INSERT a new decision row (new recording key); the verdict saw one consistent snapshot', async () => {
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    let release;
    const gate = new Promise((r) => { release = r; });
    let locked;
    const lockedP = new Promise((r) => { locked = r; });
    let seen;
    const verdict = withLockedRouteDecisions(db, { callLogId: callId, mode: 'enforce' }, async (trx, decisionRows) => {
      seen = decisionRows.map((r) => r.recording_sid);
      locked();
      await gate;
      await trx('route_feedback').insert({ call_log_id: callId, route_decision_id: decisionRows[0].id, verdict: 'accept' });
    });
    await lockedP;
    let inserted = false;
    const reprocess = upsertRouteDecision(db, { ...decision(true, 'auto_route'), recording_sid: 'RE2' }, { callLogId: callId, processingToken: 'tok-new' }).then((n) => { inserted = true; return n; });
    await sleep(400);
    expect(inserted).toBe(false); // the new row cannot appear mid-verdict
    release();
    await Promise.all([verdict, reprocess]);
    expect(seen).toEqual(['RE1']);
    expect(await rows()).toHaveLength(2);
  });

  // codex #5446 r2 P1: the displayed-revision token is the row's xmin (as text): it
  // changes on EVERY update of the row, with nobody bumping a column.
  const revisionOf = async (id) => (await db('route_decisions').where({ id }).select(db.raw('route_decisions.xmin::text AS revision')).first()).revision;

  test('the revision (xmin::text through knex) changes on the same-run OUTCOME update and on a refresh, but not on a plain row lock', async () => {
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    const [row] = await rows();
    const r0 = await revisionOf(row.id);
    expect(r0).toMatch(/^\d+$/);
    // a verdict-style FOR UPDATE does not write the tuple's xmin
    await withLockedRouteDecisions(db, { callLogId: callId, mode: 'enforce' }, async (trx, locked) => { expect(locked[0].revision).toBe(r0); });
    expect(await revisionOf(row.id)).toBe(r0);
    // the outcome update: final_action_taken / created_scheduled_service_id, NO created_at bump
    await db.transaction((trx) => updateUnreviewedRouteDecisions(trx,
      { call_log_id: callId, decision_version: V2_DECISION_VERSION, mode: 'enforce', recording_sid: 'RE1' },
      { final_action_taken: 'auto_route_skipped' }));
    const r1 = await revisionOf(row.id);
    expect(r1).not.toBe(r0);
    // the displayed-decision check under the lock: the revision the reviewer saw (r0) is now stale
    const newestOf = (list) => list[0];
    const verdictCheck = (shown) => withLockedRouteDecisions(db, { callLogId: callId, mode: 'enforce' }, async (trx, locked) => resolveDisplayedRouteDecision(locked, row.id, newestOf, shown));
    expect(await verdictCheck(r0)).toMatchObject({ stale: true });
    expect(await verdictCheck(r1)).toMatchObject({ decision: { id: row.id } });
    expect(new Date((await rows())[0].created_at).getTime()).toBe(new Date(row.created_at).getTime());
    // a reprocess refresh moves it again
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    expect(await revisionOf(row.id)).not.toBe(r1);
  });

  test('a verdict holding the call lock BLOCKS a legacy shadow decision INSERT (insertRouteDecisionLocked) until it finishes', async () => {
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    let release;
    const gate = new Promise((r) => { release = r; });
    let locked;
    const lockedP = new Promise((r) => { locked = r; });
    const verdict = withLockedRouteDecisions(db, { callLogId: callId, mode: 'enforce' }, async (trx, decisionRows) => {
      locked();
      await gate;
      await trx('route_feedback').insert({ call_log_id: callId, route_decision_id: decisionRows[0].id, verdict: 'accept' });
    });
    await lockedP;
    let inserted = false;
    const legacy = insertRouteDecisionLocked(db, { ...decision(true, 'auto_route'), decision_version: 'legacy-call-v1', mode: 'shadow', recording_sid: '' }, { returning: ['id'] })
      .then((r) => { inserted = true; return r; });
    await sleep(400);
    expect(inserted).toBe(false); // the decision row cannot appear under the verdict's snapshot
    release();
    const [out] = await Promise.all([legacy, verdict]);
    expect(out[0].id).toBeTruthy();
    expect(await rows()).toHaveLength(2);
  });

  test('a refresh holding the row lock BLOCKS a concurrent verdict, which then attaches to the REFRESHED row it reads', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    let release;
    const gate = new Promise((r) => { release = r; });
    let locked;
    const lockedP = new Promise((r) => { locked = r; });
    const refresh = db.transaction(async (trx) => {
      const n = await updateUnreviewedRouteDecisions(trx, scope(), { validator_recommendation: 'auto_create_appointment', final_action_taken: 'auto_route' });
      locked();
      await gate;
      return n;
    });
    await lockedP;
    let seen = null;
    const feedback = withLockedRouteDecisions(db, { callLogId: callId, mode: 'enforce' }, async (trx, decisionRows) => {
      seen = decisionRows[0];
      await trx('route_feedback').insert({ call_log_id: callId, route_decision_id: decisionRows[0].id, verdict: 'deny' });
    });
    await sleep(400);
    expect(seen).toBeNull(); // the verdict has not even READ the decision yet
    release();
    expect(await refresh).toBe(1);
    await feedback;
    // it read the post-refresh state, so the verdict is stored against what is on the row
    expect(seen).toMatchObject({ final_action_taken: 'auto_route', validator_recommendation: 'auto_create_appointment' });
    const [row] = await rows();
    expect(row.final_action_taken).toBe('auto_route');
    const [fb] = await db('route_feedback').where({ call_log_id: callId });
    expect(fb.route_decision_id).toBe(row.id);
  });

  test('the unfenced path also refreshes under the row lock (a reviewed row is left as judged; a different verdict is a revision)', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'));
    const [reviewed] = await rows();
    await db('route_feedback').insert({ call_log_id: callId, route_decision_id: reviewed.id, verdict: 'accept' });
    await upsertRouteDecision(db, decision(true, 'auto_route'));
    const r = await rows();
    expect(r.find((x) => x.id === reviewed.id).final_action_taken).toBe('triage_review');
    expect(r[0]).toMatchObject({ decision_version: `${V2_DECISION_VERSION}+r1`, final_action_taken: 'auto_route' });
  });

  // codex #5377 r4 P1: a REVIEWED row is never refreshed, so a pass that decides
  // differently records a '+r<n>' revision row under a distinct key — the newest
  // decision for the call is then the pass's own, whatever gate flipped.
  const review = async (row) => db('route_feedback').insert({ call_log_id: callId, route_decision_id: row.id, verdict: 'accept' });

  test('a reviewed HOLD then a booked reprocess: the reviewed row stays as judged and the booking has its OWN newest row', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    const [held] = await rows();
    await review(held);
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ decision_version: `${V2_DECISION_VERSION}+r1`, validator_recommendation: 'auto_create_appointment', final_action_taken: 'auto_route' });
    expect(r[1]).toMatchObject({ id: held.id, decision_version: V2_DECISION_VERSION, final_action_taken: 'triage_review' });
    // the verdict still points at the row it judged
    const [fb] = await db('route_feedback').where({ call_log_id: callId });
    expect(fb.route_decision_id).toBe(held.id);
  });

  test('the same-run outcome update lands on the revision (the pass\'s unreviewed row), never on the reviewed one', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'), { callLogId: callId, processingToken: 'tok-new' });
    await review((await rows())[0]);
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    const serviceId = randomUUID();
    const n = await db.transaction((trx) => updateUnreviewedRouteDecisions(trx,
      { ...scope(), decision_version: routeDecisionFamilyVersions(V2_DECISION_VERSION) },
      { final_action_taken: 'auto_route', created_scheduled_service_id: serviceId }));
    expect(n).toBe(1);
    const r = await rows();
    expect(r[0]).toMatchObject({ decision_version: `${V2_DECISION_VERSION}+r1`, created_scheduled_service_id: serviceId });
    expect(r[1].created_scheduled_service_id).toBeNull();
    expect(r[1].final_action_taken).toBe('triage_review');
  });

  // The inbox reader (/auto-routed) and the calls list: the NEWEST decision of the
  // call, with the verdict the shared family-aware join attaches to it.
  const newest = async () => leftJoinRouteFeedback(db('route_decisions').where('route_decisions.call_log_id', callId).where('route_decisions.mode', 'enforce'))
    .select('route_decisions.id', 'route_decisions.decision_version', 'route_decisions.final_action_taken', 'route_feedback.verdict')
    .orderBy('route_decisions.created_at', 'desc').first();
  const write = async (d, token = 'tok-new') => {
    const out = {};
    await upsertRouteDecision(db, d, { callLogId: callId, processingToken: token }, out);
    return out.decisionVersion;
  };

  test('reviewed base: EVERY pass writes the unreviewed member (r1) — a different verdict, then one equal to the judged verdict — and the reviewed row is never touched', async () => {
    await write(decision(false, 'triage_review'));
    const [held] = await rows();
    await review(held);
    expect(await write(decision(true, 'auto_route'))).toBe(`${V2_DECISION_VERSION}+r1`);
    expect(await write(decision(true, 'auto_route'))).toBe(`${V2_DECISION_VERSION}+r1`);
    expect(await rows()).toHaveLength(2); // r1 refreshed, no r2
    // a pass equal to the judged hold: STILL has its own row (r1 now records the hold again)
    expect(await write(decision(false, 'triage_review'))).toBe(`${V2_DECISION_VERSION}+r1`);
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ decision_version: `${V2_DECISION_VERSION}+r1`, final_action_taken: 'triage_review' });
    const judged = r.find((x) => x.id === held.id);
    expect(judged.created_at).toEqual(held.created_at);
    expect(judged).toMatchObject({ final_action_taken: 'triage_review', validator_recommendation: 'needs_review' });
    // the newest row is a new pass's decision (even though it repeats the judged
    // recommendation): the verdict points at the OLD row only, so the inbox shows it
    // UNREVIEWED — no sibling inheritance (codex #5377 r9 P1)
    expect(await newest()).toMatchObject({ decision_version: `${V2_DECISION_VERSION}+r1`, verdict: null });
    expect(await db('route_feedback').where({ call_log_id: callId, route_decision_id: held.id })).toHaveLength(1);
  });

  // codex #5377 r7 + r8 P1: a re-review repoints the one verdict to the +r1 row, so
  // the base row is the unreviewed member of the family.
  async function reviewedRevision() {
    await write(decision(false, 'triage_review'));
    await review((await rows())[0]);
    await write(decision(true, 'auto_route'));
    const r1 = (await rows()).find((x) => x.decision_version === `${V2_DECISION_VERSION}+r1`);
    await db('route_feedback').where({ call_log_id: callId }).update({ route_decision_id: r1.id });
    return r1;
  }

  test('reviewed +r1 + the SAME verdict: the pass writes the unreviewed BASE (its own row, for its outcome); the reviewed +r1 is untouched; the inbox shows the newest as UNREVIEWED (no sibling inheritance)', async () => {
    const r1 = await reviewedRevision();
    expect(await write(decision(true, 'auto_route'))).toBe(V2_DECISION_VERSION);
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ decision_version: V2_DECISION_VERSION, final_action_taken: 'auto_route' });
    expect(r[1].created_at).toEqual(r1.created_at); // reviewed row: not even created_at moved
    expect(await newest()).toMatchObject({ decision_version: V2_DECISION_VERSION, verdict: null });
    // the verdict stays on the reviewed +r1 row it points at
    expect((await db('route_feedback').where({ call_log_id: callId }))[0].route_decision_id).toBe(r1.id);
  });

  test('...and when that pass later SKIPS its booking, the outcome lands on ITS row: the reviewed row keeps what was judged and the inbox now shows the newest as unreviewed', async () => {
    const r1 = await reviewedRevision();
    const version = await write(decision(true, 'auto_route'));
    const n = await db.transaction((trx) => updateUnreviewedRouteDecisions(trx, { ...scope(), decision_version: version }, { final_action_taken: 'auto_route_skipped' }));
    expect(n).toBe(1);
    const r = await rows();
    expect(r.find((x) => x.id === r1.id)).toMatchObject({ final_action_taken: 'auto_route' }); // reviewed: untouched
    expect(r[0]).toMatchObject({ decision_version: V2_DECISION_VERSION, final_action_taken: 'auto_route_skipped' });
    // a different newest decision: nobody judged it
    expect((await newest()).verdict).toBeNull();
  });

  test('reviewed +r1 + a DIFFERENT verdict: the base is refreshed and reads UNREVIEWED; a stale worker writes nothing', async () => {
    const r1 = await reviewedRevision();
    expect(await write(decision(false, 'triage_review'), 'tok-stale')).toBeNull();
    expect((await rows())[0].id).toBe(r1.id);
    expect(await write(decision(false, 'triage_review'))).toBe(V2_DECISION_VERSION);
    const r = await rows();
    expect(r[0]).toMatchObject({ decision_version: V2_DECISION_VERSION, final_action_taken: 'triage_review' });
    expect(r[1]).toMatchObject({ id: r1.id, final_action_taken: 'auto_route' });
    expect((await newest()).verdict).toBeNull();
  });

  test('the calls-list join (inner) attaches the verdict to the row it points at ONLY — never to a newer sibling, identical or not', async () => {
    const r1 = await reviewedRevision();
    await write(decision(true, 'auto_route')); // identical recommendation, new row
    const chosen = (await rows())[0];
    expect(chosen.id).not.toBe(r1.id);
    const verdictFor = async (id) => innerJoinRouteFeedback(db('route_decisions').whereIn('route_decisions.id', [id])).select('route_feedback.verdict').first();
    expect((await verdictFor(r1.id))?.verdict).toBe('accept'); // the judged row
    expect(await verdictFor(chosen.id)).toBeUndefined(); // the new pass: unreviewed
  });

  test('a legacy verdict with no decision link still shows on the newest decision; a verdict on a different version does not', async () => {
    await write(decision(true, 'auto_route'));
    await db('route_feedback').insert({ call_log_id: callId, route_decision_id: null, verdict: 'deny' });
    expect((await newest()).verdict).toBe('deny');
    await db('route_feedback').del();
    await db('route_decisions').insert({ ...decision(true, 'auto_route'), decision_version: 'v2-1.49.0', created_at: new Date('2026-01-01T00:00:00Z') });
    const [old] = await db('route_decisions').where({ decision_version: 'v2-1.49.0' });
    await db('route_feedback').insert({ call_log_id: callId, route_decision_id: old.id, verdict: 'deny' });
    expect((await newest()).verdict).toBeNull(); // another base version is not this decision's family
  });

  test('updateUnreviewedRouteDecisions updates nothing when the scope matches no row', async () => {
    expect(await updateUnreviewedRouteDecisions(db, { call_log_id: randomUUID() }, { final_action_taken: 'x' })).toBe(0);
  });
});
