/**
 * Correction loop for calls: self-audit disagreements become ai_incidents
 * under the two-model rule. Pure rule tests run everywhere; the candidate
 * query, idempotency, duplicate handling and the Sunday proposer run on real
 * Postgres against stand-ins for the tables they read. The second reader is
 * scripted: no provider is ever reached.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(() => { throw new Error('no provider calls in tests'); }) }));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const incidentsMigration = require('../models/migrations/20261002170000_ai_incidents');
const proposalsMigration = require('../models/migrations/20261002190000_ai_fix_proposals');
const calls = require('../services/call-incidents');
const { auditInputHash } = require('../services/call-self-audit');
// The default call's audited input (inbound, TRANSCRIPT below).
let AUDIT_INPUT_HASH;

jest.setTimeout(60000);

const TRANSCRIPT = 'Agent: Waves Pest Control, how can I help?\nCaller: My kitchen has ants again, can someone come out?\nAgent: We can be there Thursday between 2 and 4.\nCaller: Thursday at 2 works, see you then.';
const AUDITOR_EXCERPT = 'Thursday at 2 works, see you then.';
AUDIT_INPUT_HASH = auditInputHash({ direction: 'inbound', transcription: TRANSCRIPT });

describe('the two-model rule for a call finding', () => {
  const second = (over = {}) => ({ appointment_agreed: true, excerpt: 'something else', field_excerpt: 'We can be there Thursday between 2 and 4.', ...over });
  const decide = (over = {}) => calls.decideCallFinding({
    field: 'appointment_agreed', auditorValue: true, auditorExcerpt: AUDITOR_EXCERPT, second: second(), transcript: TRANSCRIPT, ...over,
  });

  test('confirmed only when the second reader reaches the auditor\'s answer and both excerpts are in the transcript', () => {
    expect(decide()).toMatchObject({ disposition: 'confirmed_mistake', rule: 'two_models' });
    expect(decide({ second: second({ appointment_agreed: false }) })).toMatchObject({ disposition: 'lead', rule: 'second_sides_with_production' });
    // The evidence is the second reader's quote FOR THIS FIELD.
    expect(decide({ second: second({ field_excerpt: 'Caller agreed to Thursday at two pm sharp.' }) })).toMatchObject({ disposition: 'lead', rule: 'excerpt_unverified' });
    expect(decide({ second: second({ field_excerpt: undefined, excerpt: 'We can be there Thursday between 2 and 4.' }) })).toMatchObject({ disposition: 'lead', rule: 'excerpt_unverified' });
    // The auditor's one excerpt backs its most important judgment, not this field: a signal only.
    expect(decide({ auditorExcerpt: 'They booked a visit for Friday.' })).toMatchObject({ disposition: 'confirmed_mistake', auditorExcerptVerified: false });
    expect(decide({ second: null })).toMatchObject({ disposition: 'lead', rule: 'second_unusable' });
    expect(decide({ second: second({ appointment_agreed: 'yes' }) })).toMatchObject({ disposition: 'lead', rule: 'second_unusable' });
  });

  test('a served model resolves to its provider through the catalog; unknown is null', () => {
    expect(calls.providerForModel('claude-opus-5-5')).toBe('anthropic');
    expect(calls.providerForModel('claude-opus-5-5-20261001')).toBe('anthropic');
    expect(calls.providerForModel('gpt-6-luna')).toBe('openai');
    expect(calls.providerForModel('mystery-model')).toBeNull();
    expect(calls.providerForModel(null)).toBeNull();
  });

  test('excerpts are matched as words of the transcript, ignoring speaker labels and case, and must be long enough', () => {
    expect(calls.excerptInTranscript('caller: thursday AT 2 works', TRANSCRIPT)).toBe(true);
    expect(calls.excerptInTranscript('Thursday', TRANSCRIPT)).toBe(false);
  });

  test('a closed failure-mode list: each field, wrongly true or wrongly false', () => {
    expect(calls.failureModeFor('appointment_agreed', false)).toBe('appointment_agreed_missed');
    expect(calls.failureModeFor('is_spam', true)).toBe('is_spam_false_positive');
    expect(calls.FAILURE_MODES).toHaveLength(calls.FIELDS.length * 2);
  });

  test('a staff tag is a correction only on the fields it states and production contradicts', () => {
    const prod = { is_lead: false, is_spam: false, is_voicemail: true, appointment_agreed: false, quote_promised: true };
    expect(calls.staffTagCorrections('new_lead_booked', prod)).toEqual([
      { field: 'is_lead', production: false, staff: true },
      { field: 'appointment_agreed', production: false, staff: true },
    ]);
    expect(calls.staffTagCorrections('new_lead_no_booking', { ...prod, is_lead: true })).toEqual([]);
    expect(calls.staffTagCorrections('new_lead_no_booking', { ...prod, is_lead: true, appointment_agreed: true })).toEqual([{ field: 'appointment_agreed', production: true, staff: false }]);
    expect(calls.staffTagCorrections('existing_complaint', { ...prod, is_lead: true, is_spam: true })).toEqual([
      { field: 'is_lead', production: true, staff: false },
      { field: 'is_spam', production: true, staff: false },
    ]);
    expect(calls.staffTagCorrections('spam', prod)).toEqual([{ field: 'is_spam', production: false, staff: true }]);
    // A tag says nothing about voicemail or quotes; an unknown tag says nothing at all.
    expect(calls.staffTagCorrections('spam', { ...prod, is_spam: true })).toEqual([]);
    expect(calls.staffTagCorrections('something_else', prod)).toEqual([]);
  });

  test('staff tag capture never throws and records nothing with the gate off', async () => {
    const saved = process.env.GATE_CALL_INCIDENTS;
    delete process.env.GATE_CALL_INCIDENTS;
    const never = () => { throw new Error('no writes with the gate off'); };
    await expect(calls.recordStaffTagCorrections({ dbi: never, call: { id: 'c1' }, tag: 'spam' })).resolves.toMatchObject({ recorded: 0 });
    process.env.GATE_CALL_INCIDENTS = 'true';
    const savedAudit = process.env.GATE_CALL_SELF_AUDIT;
    process.env.GATE_CALL_SELF_AUDIT = 'true';
    // A broken database is swallowed: the staff action must go through.
    await expect(calls.recordStaffTagCorrections({ dbi: never, call: { id: 'c1', ai_extraction: '{}' }, tag: 'spam' })).resolves.toMatchObject({ recorded: 0, error: true });
    if (saved === undefined) delete process.env.GATE_CALL_INCIDENTS; else process.env.GATE_CALL_INCIDENTS = saved;
    if (savedAudit === undefined) delete process.env.GATE_CALL_SELF_AUDIT; else process.env.GATE_CALL_SELF_AUDIT = savedAudit;
  });

  test('the gate off reads nothing', async () => {
    const saved = process.env.GATE_CALL_INCIDENTS;
    delete process.env.GATE_CALL_INCIDENTS;
    const never = () => { throw new Error('no reads with the gate off'); };
    await expect(calls.adjudicateCallFindings({ dbi: never })).resolves.toEqual({ skipped: 'gate_off' });
    await expect(calls.proposeCallFixes({ dbi: never })).resolves.toEqual({ skipped: 'gate_off' });
    if (saved !== undefined) process.env.GATE_CALL_INCIDENTS = saved;
  });
});

(SKIP ? describe.skip : describe)('call incidents on PostgreSQL', () => {
  const schema = `call_incidents_${randomUUID().replaceAll('-', '')}`;
  let database;
  const env = {};
  const NOW = new Date('2026-10-03T08:10:00Z');

  const call = async (over = {}) => {
    const id = randomUUID();
    await database('call_log').insert({
      id, direction: 'inbound', transcription: TRANSCRIPT, created_at: new Date('2026-10-02T15:00:00Z'), ai_extraction_prompt_version: 'v2-extract-abc', ...over,
    });
    return id;
  };
  const finding = async (callId, over = {}) => {
    const id = randomUUID();
    await database('call_audit_findings').insert({
      id, call_log_id: callId, audit_source: 'self_audit', category: 'field_drift', field: 'appointment_agreed',
      old_value: 'false', new_value: 'true', transcript_excerpt: AUDITOR_EXCERPT, created_at: new Date('2026-10-03T07:40:00Z'),
      // The self-audit stores the model that actually answered.
      detail: JSON.stringify({ auditor_model: 'claude-opus-5-5', auditor_provider: 'anthropic', audit_input_hash: AUDIT_INPUT_HASH, verdict: { appointment_agreed: true } }), ...over,
    });
    return id;
  };
  const byFinding = (id) => database('ai_incidents').whereRaw("split_part(evidence_id, ':', 1) = ?", [id]).first();
  const agreeing = jest.fn(async () => ({ ok: true, provider: 'openai', model: 'scripted', answer: { appointment_agreed: true, is_spam: false, excerpt: 'x', field_excerpt: 'We can be there Thursday between 2 and 4.' } }));

  beforeAll(async () => {
    for (const k of ['GATE_CALL_INCIDENTS', 'GATE_CALL_SELF_AUDIT']) env[k] = process.env[k];
    process.env.GATE_CALL_INCIDENTS = 'true';
    process.env.GATE_CALL_SELF_AUDIT = 'true';
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await incidentsMigration.up(database);
    await proposalsMigration.up(database);
    await database.raw(`CREATE TABLE ??.call_log (id uuid PRIMARY KEY, direction varchar(20), transcription text,
      created_at timestamptz, ai_extraction_prompt_version varchar(80))`, [schema]);
    await database.raw(`CREATE TABLE ??.call_audit_findings (id uuid PRIMARY KEY, call_log_id uuid, audit_source varchar(40),
      category varchar(40), field varchar(40), old_value text, new_value text, transcript_excerpt text, detail jsonb, created_at timestamptz)`, [schema]);
    await database.raw(`CREATE TABLE ??.decision_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_type varchar(30),
      subject_id uuid, question_id varchar(60), provider varchar(30), package_id varchar(80), jev_answer jsonb)`, [schema]);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });
  beforeEach(async () => {
    for (const t of ['ai_fix_proposals', 'ai_incidents', 'decision_reviews', 'call_audit_findings', 'call_log']) await database(t).del();
    agreeing.mockClear();
  });

  test('a finding becomes one confirmed incident with its signals; a second run finds nothing', async () => {
    const callId = await call();
    const findingId = await finding(callId);
    await database('decision_reviews').insert({ subject_type: 'call_log', subject_id: callId, question_id: 'appointment_agreed', provider: 'typesafe', package_id: 'call_judge.v2', jev_answer: JSON.stringify({ value: 0.9 }) });

    const out = await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    expect(out).toMatchObject({ adjudicated: 1, byDisposition: { confirmed_mistake: 1 } });
    const row = await database('ai_incidents').first();
    expect(row).toMatchObject({
      area: 'calls', evidence_type: 'call_audit_finding', evidence_id: expect.stringMatching(new RegExp(`^${findingId}:[0-9a-f]{12}$`)), incident_key: callId,
      surface: 'call_extraction', failure_mode: 'appointment_agreed_missed', disposition: 'confirmed_mistake', prompt_version: null,
    });
    expect(row.produced_at.toISOString()).toBe('2026-10-02T15:00:00.000Z');
    expect(row.adjudication).toMatchObject({ rule: 'two_models', production: false, auditor: { value: true, provider: 'anthropic', excerpt_verified: true }, second: { provider: 'openai', value: true } });
    expect(row.adjudication.typed_signals).toEqual([expect.objectContaining({ provider: 'typesafe', package: 'call_judge.v2' })]);
    // The summary names the field and the values, never the transcript.
    expect(row.summary).not.toMatch(/kitchen|Thursday/);

    expect(await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing })).toMatchObject({ adjudicated: 0, candidates: 0 });
  });

  test('a disagreeing second reader leaves a lead; an unreachable one stores nothing and is retried', async () => {
    const a = await finding(await call());
    const b = await finding(await call());
    // Answers chosen by finding, not by call order: the batch order rotates.
    const reader = jest.fn(async (row) => (row.finding_id === a
      ? { ok: true, provider: 'openai', model: 's', answer: { appointment_agreed: false, field_excerpt: 'We can be there Thursday between 2 and 4.' } }
      : { ok: false, reason: 'all_providers_failed' }));
    expect(await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader })).toMatchObject({ adjudicated: 1, byDisposition: { lead: 1 } });
    expect((await database('ai_incidents').select('evidence_id')).map((r) => r.evidence_id.split(':')[0])).toEqual([a]);
    expect(await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing })).toMatchObject({ adjudicated: 1 });
    expect((await byFinding(b)).disposition).toBe('confirmed_mistake');
  });

  test('a finding the self-audit rewrites in place is new evidence; an unchanged one is not re-read', async () => {
    const callId = await call();
    const id = await finding(callId);
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    expect(await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing })).toMatchObject({ candidates: 0 });
    // A later audit rewrites the same row (here: the deep call fell back).
    await database('call_audit_findings').where({ id }).update({
      detail: JSON.stringify({ auditor_model: 'gpt-6-luna', audit_input_hash: AUDIT_INPUT_HASH, verdict: { appointment_agreed: true } }),
    });
    const again = await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    expect(again).toMatchObject({ candidates: 1, adjudicated: 1 });
    const rows = await database('ai_incidents').orderBy('adjudicated_at');
    // Each row still describes what was adjudicated then.
    expect(rows.map((r) => r.adjudication.auditor.model)).toEqual(['claude-opus-5-5', 'gpt-6-luna']);
  });

  test('a corrected verdict or excerpt on the same model and version is new evidence too', async () => {
    const callId = await call();
    // First audit: the auditor never answered the field (stored "false" is a coercion).
    const id = await finding(callId, { old_value: 'true', new_value: 'false', detail: JSON.stringify({ auditor_model: 'claude-opus-5-5', audit_input_hash: AUDIT_INPUT_HASH, verdict: {} }) });
    const disagreeing = jest.fn(async () => ({ ok: true, provider: 'openai', model: 's', answer: { appointment_agreed: false, field_excerpt: 'We can be there Thursday between 2 and 4.' } }));
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: disagreeing });
    expect((await byFinding(id)).adjudication.rule).toBe('auditor_value_missing');
    // A re-audit answers the field explicitly, same model and version.
    await database('call_audit_findings').where({ id }).update({ detail: JSON.stringify({ auditor_model: 'claude-opus-5-5', audit_input_hash: AUDIT_INPUT_HASH, verdict: { appointment_agreed: false } }) });
    expect(await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: disagreeing })).toMatchObject({ candidates: 1, adjudicated: 1 });
    // And a replaced excerpt alone is new evidence as well.
    await database('call_audit_findings').where({ id }).update({ transcript_excerpt: 'My kitchen has ants again, can someone come out?' });
    expect(await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: disagreeing })).toMatchObject({ candidates: 1 });
  });

  test('a second finding about the same call and field is a duplicate, never counted twice', async () => {
    const callId = await call();
    await finding(callId);
    await finding(callId, { created_at: new Date('2026-10-03T07:41:00Z') });
    const out = await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    expect(out.byDisposition).toEqual({ confirmed_mistake: 1, duplicate: 1 });
  });

  test('the second reader is on the other provider; unknown provenance or a truncated call stays a lead with no call made', async () => {
    const anthropicAudit = await finding(await call());
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    expect(agreeing).toHaveBeenLastCalledWith(expect.objectContaining({ finding_id: anthropicAudit }), 'anthropic');

    // The deep call fell back to OpenAI: the reader is asked to avoid OpenAI,
    // and a reader that answers from OpenAI anyway never confirms.
    const openaiAudit = await finding(await call(), { detail: JSON.stringify({ auditor_model: 'gpt-6-luna', audit_input_hash: AUDIT_INPUT_HASH, verdict: { appointment_agreed: true } }) });
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    expect(agreeing).toHaveBeenLastCalledWith(expect.objectContaining({ finding_id: openaiAudit }), 'openai');
    expect(await byFinding(openaiAudit)).toMatchObject({ disposition: 'lead', adjudication: expect.objectContaining({ rule: 'same_provider' }) });

    agreeing.mockClear();
    const unknown = await finding(await call(), { detail: JSON.stringify({ audit_input_hash: AUDIT_INPUT_HASH, verdict: { appointment_agreed: true } }) });
    // The auditor never answered the field: its stored "false" is a coercion.
    const unanswered = await finding(await call(), { old_value: 'true', new_value: 'false', detail: JSON.stringify({ auditor_model: 'claude-opus-5-5', audit_input_hash: AUDIT_INPUT_HASH, verdict: {} }) });
    const longText = `${TRANSCRIPT}\n${'Agent: more.\n'.repeat(500)}`;
    const long = await finding(await call({ transcription: longText }), {
      detail: JSON.stringify({ auditor_model: 'claude-opus-5-5', auditor_provider: 'anthropic', audit_input_hash: auditInputHash({ direction: 'inbound', transcription: longText }), verdict: { appointment_agreed: true } }),
    });
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    expect(agreeing).not.toHaveBeenCalled();
    expect((await byFinding(unknown)).adjudication.rule).toBe('auditor_provider_unknown');
    expect((await byFinding(long)).adjudication.rule).toBe('transcript_truncated');
    expect((await byFinding(unanswered)).adjudication.rule).toBe('auditor_value_missing');
  });

  test('a second reading needs the exact input the auditor read; the provider recorded at audit time beats the catalog', async () => {
    const stale = await finding(await call(), { detail: JSON.stringify({ auditor_model: 'claude-opus-5-5', auditor_provider: 'anthropic', audit_input_hash: 'another-prompt', verdict: { appointment_agreed: true } }) });
    // Re-transcribed after the audit, and a direction that no longer matches.
    const retranscribed = await call();
    const retranscribedFinding = await finding(retranscribed);
    await database('call_log').where({ id: retranscribed }).update({ transcription: `${TRANSCRIPT}\nAgent: Anything else?` });
    const redirected = await call();
    const redirectedFinding = await finding(redirected);
    await database('call_log').where({ id: redirected }).update({ direction: 'outbound-api' });
    // A model the catalog does not know yet, with its provider recorded.
    const fresh = await finding(await call(), { detail: JSON.stringify({ auditor_model: 'claude-opus-9-preview', auditor_provider: 'anthropic', audit_input_hash: AUDIT_INPUT_HASH, verdict: { appointment_agreed: true } }) });
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    for (const id of [stale, retranscribedFinding, redirectedFinding]) expect((await byFinding(id)).adjudication.rule).toBe('audit_input_changed');
    expect((await byFinding(fresh)).disposition).toBe('confirmed_mistake');
    expect(agreeing).toHaveBeenCalledTimes(1);
  });

  test('findings whose reading keeps failing never starve newer ones: newest first', async () => {
    const old = [];
    for (let i = 0; i < 3; i++) old.push(await finding(await call(), { created_at: new Date(Date.UTC(2026, 9, 1, 7, i)) }));
    const fresh = await finding(await call(), { created_at: new Date('2026-10-03T07:40:00Z') });
    const reader = jest.fn(async (row) => (old.includes(row.finding_id) ? { ok: false, reason: 'validator_rejected' } : agreeing(row)));
    // A batch of two: the new finding is read first, whatever the old ones do.
    const out = await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader, batchLimit: 2 });
    expect(reader.mock.calls[0][0].finding_id).toBe(fresh);
    expect(out).toMatchObject({ adjudicated: 1, byDisposition: { confirmed_mistake: 1 } });
    // With room in the batch, the failing ones are still retried.
    reader.mockClear();
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader, batchLimit: 20 });
    expect(reader.mock.calls.map(([row]) => row.finding_id).sort()).toEqual([...old].sort());
  });

  test('old findings, other audit sources and unknown fields are not read', async () => {
    const callId = await call();
    await finding(callId, { created_at: new Date('2026-09-01T07:40:00Z') });
    await finding(callId, { audit_source: 'mining_2026_07' });
    await finding(callId, { field: 'complaint' });
    await finding(callId, { category: 'missed_lead' });
    expect(await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing })).toMatchObject({ candidates: 0 });
    expect(agreeing).not.toHaveBeenCalled();
  });

  test('a staff tag records one confirmed incident per contradicted field, once, in the audit\'s own cells', async () => {
    const row = { id: randomUUID(), created_at: new Date('2026-10-02T15:00:00Z'), processing_status: 'processed', ai_extraction: JSON.stringify({ is_lead: false, appointment_confirmed: false }) };
    const out = await calls.recordStaffTagCorrections({ dbi: database, call: row, tag: 'new_lead_booked', by: 'tech-1', now: NOW });
    expect(out).toEqual({ recorded: 2 });
    const rows = await database('ai_incidents').where({ incident_key: row.id }).orderBy('failure_mode');
    expect(rows.map((r) => [r.evidence_type, r.failure_mode, r.disposition, r.adjudication.rule])).toEqual([
      ['call_tab_tag', 'appointment_agreed_missed', 'confirmed_mistake', 'staff_tag'],
      ['call_tab_tag', 'is_lead_missed', 'confirmed_mistake', 'staff_tag'],
    ]);
    expect(rows[0]).toMatchObject({ area: 'calls', surface: 'call_extraction', prompt_version: null });
    expect(rows[0].adjudication.staff).toEqual({ value: true, tag: 'new_lead_booked', by: 'tech-1' });
    // A re-tag is a person correcting a person: the first tag per field stands.
    expect(await calls.recordStaffTagCorrections({ dbi: database, call: row, tag: 'existing_complaint', now: NOW })).toEqual({ recorded: 0 });
    expect(await database('ai_incidents').where({ incident_key: row.id }).count('* as n').first()).toEqual({ n: '2' });
  });

  test('a staff tag on a call the two models already confirmed in that cell is a duplicate, not a second count', async () => {
    const callId = await call();
    await finding(callId);
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    const row = { id: callId, created_at: new Date('2026-10-02T15:00:00Z'), processing_status: 'processed', ai_extraction: JSON.stringify({ is_lead: true, appointment_confirmed: false }) };
    expect(await calls.recordStaffTagCorrections({ dbi: database, call: row, tag: 'new_lead_booked', now: NOW })).toEqual({ recorded: 1 });
    const rows = await database('ai_incidents').where({ incident_key: callId, failure_mode: 'appointment_agreed_missed' }).orderBy('adjudicated_at');
    expect(rows.map((r) => r.disposition).sort()).toEqual(['confirmed_mistake', 'duplicate']);
  });

  test('the Sunday proposer counts distinct confirmed calls in the unversioned cohort', async () => {
    for (let i = 0; i < 5; i++) await finding(await call());
    await calls.adjudicateCallFindings({ dbi: database, now: NOW, reader: agreeing });
    const out = await calls.proposeCallFixes({ dbi: database, now: new Date('2026-10-04T08:50:00Z') });
    expect(out).toMatchObject({ proposed: 1 });
    expect(await database('ai_fix_proposals').first()).toMatchObject({
      area: 'calls', surface: 'call_extraction', failure_mode: 'appointment_agreed_missed', prompt_version: null, status: 'pending', evidence_count: 5,
    });
  });
});
