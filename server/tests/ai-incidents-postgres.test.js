/**
 * ai_incidents on real Postgres — the two keys the adjudicator leans on only
 * mean something in the database: the evidence key (idempotent nightly run)
 * and the partial one-confirmed-per-cell index (one incident never counts
 * twice, while leads and duplicates about it are still storable).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The model is scripted: this suite is about the SQL, and a DB-gated run must
// never reach a provider or the shared LLM ledger.
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const llmCall = require('../services/llm/call');
const { adjudicateHumanBetter, getIncidentSummary } = require('../services/sms-pathology-ledger');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261002170000_ai_incidents');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('ai_incidents on PostgreSQL', () => {
  const schema = `ai_incidents_${randomUUID().replaceAll('-', '')}`;
  let database;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await migration.up(database);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });

  const row = (over = {}) => ({
    area: 'sms', evidence_type: 'judgment', evidence_id: randomUUID(), incident_key: randomUUID(),
    disposition: 'confirmed_mistake', surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta',
    adjudication: JSON.stringify({ rule: 'two_models' }), ...over,
  });

  test('up is re-runnable and the defaults land', async () => {
    await migration.up(database);
    const [stored] = await database('ai_incidents').insert({
      area: 'sms', evidence_type: 'judgment', evidence_id: randomUUID(), incident_key: randomUUID(), disposition: 'lead',
    }).returning('*');
    expect(stored).toMatchObject({ surface: 'other', failure_mode: 'other', schema_version: 'ai-incidents.v1', adjudication: {} });
    expect(stored.adjudicated_at).toBeInstanceOf(Date);
  });

  test('the same evidence is stored once (onConflict ignore is a no-op the second time)', async () => {
    const evidence = row();
    await database('ai_incidents').insert(evidence);
    await database('ai_incidents').insert({ ...evidence, disposition: 'lead' }).onConflict(['area', 'evidence_type', 'evidence_id']).ignore();
    const stored = await database('ai_incidents').where({ evidence_id: evidence.evidence_id });
    expect(stored).toHaveLength(1);
    expect(stored[0].disposition).toBe('confirmed_mistake');
  });

  test('one incident confirms once per cell; a second evidence row is refused as confirmed and stored as duplicate', async () => {
    const incident = randomUUID();
    await database('ai_incidents').insert(row({ incident_key: incident }));
    await expect(database('ai_incidents').insert(row({ incident_key: incident, evidence_type: 'correction' })))
      .rejects.toMatchObject({ code: '23505' });
    await database('ai_incidents').insert(row({ incident_key: incident, evidence_type: 'correction', disposition: 'duplicate' }));
    // A different cell for the same incident, and a lead in the same cell, are both fine.
    await database('ai_incidents').insert(row({ incident_key: incident, failure_mode: 'invented_commitment' }));
    await database('ai_incidents').insert(row({ incident_key: incident, disposition: 'lead' }));
    const confirmed = await database('ai_incidents').where({ incident_key: incident, disposition: 'confirmed_mistake' });
    expect(confirmed).toHaveLength(2);
  });

  test('a disposition outside the closed list is refused', async () => {
    await expect(database('ai_incidents').insert(row({ disposition: 'probably' }))).rejects.toMatchObject({ code: '23514' });
  });

  describe('the nightly candidate query, against stand-ins for the two tables it reads', () => {
    const NOW = new Date('2026-10-02T08:30:00Z');
    const draft = async (over = {}) => {
      const id = randomUUID();
      await database('message_drafts').insert({
        id, inbound_message: 'when are you coming?', draft_response: 'See you Wednesday at 9am!',
        facts_block: 'UPCOMING: Quarterly Pest 2026-10-06 (Tue) window 14:00-16:00',
        prompt_version: 'house_voice_v12_real_answers3_cfl', created_at: new Date('2026-10-01T15:00:00Z'), ...over,
      });
      return id;
    };
    const judgment = async (draftId, over = {}) => {
      const id = randomUUID();
      await database('shadow_draft_judgments').insert({
        id, draft_id: draftId, verdict: 'human_better', human_replied: true, draft_was_empty: false,
        human_reply_text: 'Let me check with the tech.', intent: 'general', notes: 'n',
        scores: JSON.stringify({ safety: 5 }), judged_at: new Date('2026-10-02T07:55:00Z'), ...over,
      });
      return id;
    };

    beforeAll(async () => {
      await database.raw(`CREATE TABLE ??.message_drafts (id uuid PRIMARY KEY, inbound_message text, draft_response text,
        facts_block text, prompt_version varchar(40), created_at timestamptz)`, [schema]);
      await database.raw(`CREATE TABLE ??.shadow_draft_judgments (id uuid PRIMARY KEY, draft_id uuid, verdict varchar(20),
        human_replied boolean, draft_was_empty boolean, human_reply_text text, intent varchar(50), notes text, scores jsonb,
        judged_at timestamptz)`, [schema]);
    });
    beforeEach(async () => {
      await database('ai_incidents').del();
      await database('shadow_draft_judgments').del();
      await database('message_drafts').del();
      llmCall.dispatchWithFallback.mockReset();
      llmCall.dispatchWithFallback.mockResolvedValue({
        ok: true, model: 'scripted',
        text: JSON.stringify({ disposition: 'confirmed_mistake', surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta', quote: 'Wednesday at 9am', summary: 'Gave a time the facts did not carry.' }),
      });
    });

    test('only recent, non-backfill, human-replied human_better judgments are read; a second run finds nothing', async () => {
      const wanted = await judgment(await draft());
      await judgment(await draft(), { verdict: 'equivalent' });
      await judgment(await draft(), { human_replied: false });
      await judgment(await draft({ prompt_version: 'house_voice_v2_backfill' }));
      await judgment(await draft({ created_at: new Date('2026-07-01T15:00:00Z') }));
      await judgment(await draft({ prompt_version: null })); // a null version is not a backfill

      const first = await adjudicateHumanBetter({ dbi: database, anthropicClient: {}, now: NOW });
      expect(first).toMatchObject({ adjudicated: 2, byDisposition: { confirmed_mistake: 2 } });
      const stored = await database('ai_incidents').where({ evidence_id: wanted }).first();
      expect(stored).toMatchObject({
        area: 'sms', evidence_type: 'judgment', disposition: 'confirmed_mistake',
        surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta', prompt_version: 'house_voice_v12_real_answers3_cfl',
      });
      expect(stored.adjudication).toMatchObject({ rule: 'two_models', judge: { safety: 5 }, model: { quote_verified: true } });
      expect(stored.adjudication.readers).toHaveLength(2);
      expect(stored.produced_at.toISOString()).toBe('2026-10-01T15:00:00.000Z');

      const second = await adjudicateHumanBetter({ dbi: database, anthropicClient: {}, now: NOW });
      expect(second).toMatchObject({ adjudicated: 0 });
      expect(llmCall.dispatchWithFallback).toHaveBeenCalledTimes(4); // two readers per confirmed draft, none on the second run
    });

    test('the summary groups what the run stored, by when the draft was produced', async () => {
      await judgment(await draft());
      await judgment(await draft({ draft_response: '' }), { draft_was_empty: true });
      await adjudicateHumanBetter({ dbi: database, anthropicClient: {}, now: NOW });
      const summary = await getIncidentSummary({ dbi: database, days: 7, now: NOW });
      expect(summary).toEqual(expect.arrayContaining([
        { disposition: 'confirmed_mistake', surface: 'facts_block_gap', failureMode: 'invented_schedule_eta', promptVersion: 'house_voice_v12_real_answers3_cfl', n: 1 },
        { disposition: 'lead', surface: 'other', failureMode: 'other', promptVersion: 'house_voice_v12_real_answers3_cfl', n: 1 },
      ]));
      expect(await getIncidentSummary({ dbi: database, days: 7, now: new Date('2026-11-15T00:00:00Z') })).toEqual([]);
    });
  });

  test('down drops the table and up restores it', async () => {
    await migration.down(database);
    expect(await database.schema.hasTable('ai_incidents')).toBe(false);
    await migration.up(database);
    expect(await database.schema.hasTable('ai_incidents')).toBe(true);
  });
});
