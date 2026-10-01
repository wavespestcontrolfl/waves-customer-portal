// The route_decisions write chokepoint (upsertRouteDecision): a reprocess that
// decides differently REFRESHES the row for its call/mode/recording, so the
// newest decision always reflects the latest pass — whatever the version, and
// in either direction of a dark-gate flip. CI's DATABASE_URL pass runs this
// against PostgreSQL in a throwaway schema (minimal tables shaped like the real
// migrations: 20260429000012 + 20260902000001).
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const { buildRouteDecision, upsertRouteDecision, updateUnreviewedRouteDecisions, withLockedRouteDecisions, insertRouteDecisionLocked, resolveDisplayedRouteDecision, V2_DECISION_VERSION } = require('../services/call-routing-gates');

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
    expect(r).toHaveLength(1);
    // the row the human judged is exactly as judged
    expect(r[0]).toMatchObject({ id: reviewed.id, validator_recommendation: 'needs_review', final_action_taken: 'triage_review' });
    expect(r[0].blocked_reasons).toEqual(['ambiguous_pest_or_service']);
    expect(new Date(r[0].created_at).getTime()).toBe(new Date(reviewed.created_at).getTime());
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
    const [row] = await rows();
    // the row the reviewer judged is exactly as judged
    expect(row).toMatchObject({ validator_recommendation: 'needs_review', final_action_taken: 'triage_review' });
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

  test('the unfenced path also refreshes under the row lock (and still skips a reviewed row)', async () => {
    await upsertRouteDecision(db, decision(false, 'triage_review'));
    const [reviewed] = await rows();
    await db('route_feedback').insert({ call_log_id: callId, route_decision_id: reviewed.id, verdict: 'accept' });
    await upsertRouteDecision(db, decision(true, 'auto_route'));
    expect((await rows())[0].final_action_taken).toBe('triage_review');
  });

  test('updateUnreviewedRouteDecisions updates nothing when the scope matches no row', async () => {
    expect(await updateUnreviewedRouteDecisions(db, { call_log_id: randomUUID() }, { final_action_taken: 'x' })).toBe(0);
  });
});
