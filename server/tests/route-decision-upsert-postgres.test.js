// The route_decisions write chokepoint (upsertRouteDecision): a reprocess that
// decides differently REFRESHES the row for its call/mode/recording, so the
// newest decision always reflects the latest pass — whatever the version, and
// in either direction of a dark-gate flip. CI's DATABASE_URL pass runs this
// against PostgreSQL in a throwaway schema (minimal tables shaped like the real
// migrations: 20260429000012 + 20260902000001).
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const { buildRouteDecision, upsertRouteDecision, V2_DECISION_VERSION } = require('../services/call-routing-gates');

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

  test('a different recording is its own row', async () => {
    await upsertRouteDecision(db, decision(true, 'auto_route'), { callLogId: callId, processingToken: 'tok-new' });
    await upsertRouteDecision(db, { ...decision(true, 'auto_route'), recording_sid: 'RE2' }, { callLogId: callId, processingToken: 'tok-new' });
    expect(await rows()).toHaveLength(2);
  });
});
