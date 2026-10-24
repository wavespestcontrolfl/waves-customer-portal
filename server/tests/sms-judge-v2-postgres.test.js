/**
 * GATE_SMS_JUDGE_V2 on a real Postgres (owner 2026-10-24). Measurement only.
 *  - the real migration adds judge_version + could_send with the CHECK;
 *  - the nightly writer persists judge_version/could_send gate on and leaves both NULL gate off;
 *  - the autonomy safety backstop counts only j2 rows gate on, every row gate off.
 * Synthetic names only; the Anthropic SDK is mocked, nothing is sent.
 */
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } })));

let mockDb;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockDb(...args);
  proxy.raw = (...args) => mockDb.raw(...args);
  proxy.fn = { now: () => mockDb.fn.now() };
  return proxy;
});

jest.setTimeout(120000);

(SKIP ? describe.skip : describe)('GATE_SMS_JUDGE_V2 on PostgreSQL', () => {
  const schema = `judge_v2_${randomUUID().replaceAll('-', '')}`;
  const GATE = 'GATE_SMS_JUDGE_V2';
  const HOUR = 3600 * 1000;
  let database;

  beforeAll(async () => {
    jest.spyOn(require('../services/logger'), 'info').mockImplementation(() => {});
    jest.spyOn(require('../services/logger'), 'warn').mockImplementation(() => {});
    jest.spyOn(require('../services/logger'), 'error').mockImplementation(() => {});
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    mockDb = database;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE sms_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, direction text, message_type text, status text,
      message_body text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
    await database.raw(`CREATE TABLE message_drafts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, inbound_message text, draft_response text, intent text,
      context_summary text, facts_block text, created_at timestamptz NOT NULL DEFAULT now(), sms_log_id uuid, status text,
      prompt_version varchar(40), intended_actions text)`);
    await database.raw('CREATE TABLE agent_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid, entity_type text, workflow text, status text)');
    // the table as the original migration (20260612000030) made it, minus the foreign keys to tables this test does not build
    await database.raw(`CREATE TABLE shadow_draft_judgments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL UNIQUE, customer_id uuid, intent varchar(50),
      human_reply_sms_id uuid, human_reply_text text, human_replied boolean NOT NULL DEFAULT false,
      draft_was_empty boolean NOT NULL DEFAULT false, verdict varchar(20) NOT NULL, scores jsonb, notes text,
      model varchar(80), prompt_version varchar(40), judged_at timestamptz DEFAULT now())`);
    await require('../models/migrations/20261025000000_shadow_judgments_judge_v2').up(database);
  });
  afterAll(async () => {
    delete process.env[GATE];
    jest.restoreAllMocks();
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });
  afterEach(async () => {
    delete process.env[GATE];
    mockAnthropicCreate.mockReset();
    await database.raw('TRUNCATE shadow_draft_judgments, message_drafts, sms_log, agent_decisions');
  });

  const judgeReply = (extra) => ({ content: [{ type: 'text', text: JSON.stringify({ voice: 7, safety: 8, actions: 7, overall: 7, verdict: 'equivalent', notes: 'ok', ...extra }) }] });

  // One shadow draft old enough to judge, plus the human reply that paired with it.
  async function seedPair() {
    const customerId = randomUUID();
    const t0 = new Date(Date.now() - 30 * HOUR);
    const [inbound] = await database('sms_log').insert({ customer_id: customerId, direction: 'inbound', message_type: 'inbound', status: 'received', message_body: 'Hi', created_at: t0 }).returning('id');
    const [draft] = await database('message_drafts').insert({
      customer_id: customerId, inbound_message: 'Can you confirm Friday?', draft_response: 'Friday works.', intent: 'GENERAL',
      status: 'shadow', sms_log_id: inbound.id, created_at: new Date(t0.getTime() + 60000), prompt_version: 'house_voice_v12',
    }).returning('id');
    await database('sms_log').insert({ customer_id: customerId, direction: 'outbound', message_type: 'manual', status: 'sent', message_body: 'Yes, Friday.', created_at: new Date(t0.getTime() + 600000) });
    return draft.id;
  }

  test('migration: columns exist, NULL by default, CHECK rejects any other could_send', async () => {
    const draftId = await seedPair();
    await database('shadow_draft_judgments').insert({ draft_id: draftId, verdict: 'equivalent' });
    const row = await database('shadow_draft_judgments').where({ draft_id: draftId }).first();
    expect(row.judge_version).toBeNull();
    expect(row.could_send).toBeNull();
    await expect(database('shadow_draft_judgments').where({ draft_id: draftId }).update({ could_send: 'maybe' })).rejects.toMatchObject({ code: '23514' });
    await database('shadow_draft_judgments').where({ draft_id: draftId }).update({ could_send: 'yes_with_edit', judge_version: 'j2' });
    expect((await database('shadow_draft_judgments').where({ draft_id: draftId }).first()).could_send).toBe('yes_with_edit');
  });

  test('writer, gate on: persists judge_version j2 and could_send; prompt_version unchanged', async () => {
    process.env[GATE] = 'true';
    const draftId = await seedPair();
    mockAnthropicCreate.mockResolvedValue(judgeReply({ could_send_instead: 'yes_with_edit' }));
    const { judgeShadowDrafts } = require('../services/sms-shadow-judge');
    expect((await judgeShadowDrafts({ batchLimit: 5 })).judged).toBe(1);
    const row = await database('shadow_draft_judgments').where({ draft_id: draftId }).first();
    expect(row).toMatchObject({ judge_version: 'j2', could_send: 'yes_with_edit', verdict: 'equivalent', prompt_version: 'shadow_judge_v1' });
    expect(row.scores).toEqual({ voice: 7, safety: 8, actions: 7, overall: 7 });
  });

  test('writer, gate off: both columns stay NULL even if the model sent the key', async () => {
    const draftId = await seedPair();
    mockAnthropicCreate.mockResolvedValue(judgeReply({ could_send_instead: 'no' }));
    const { judgeShadowDrafts } = require('../services/sms-shadow-judge');
    expect((await judgeShadowDrafts({ batchLimit: 5 })).judged).toBe(1);
    const row = await database('shadow_draft_judgments').where({ draft_id: draftId }).first();
    expect(row.judge_version).toBeNull();
    expect(row.could_send).toBeNull();
    expect(row.scores).toEqual({ voice: 7, safety: 8, actions: 7, overall: 7 });
  });

  describe('safety backstop filter (fetchLiveJudgeSignals)', () => {
    const VERSION = 'house_voice_test';
    async function addJudged({ judgeVersion, verdict = 'equivalent', ageMin }) {
      const [d] = await database('message_drafts').insert({ intent: 'GENERAL', status: 'shadow', prompt_version: VERSION }).returning('id');
      await database('shadow_draft_judgments').insert({
        draft_id: d.id, intent: 'GENERAL', verdict, scores: JSON.stringify({ voice: 8, safety: 9, actions: 8, overall: 8 }),
        judge_version: judgeVersion, judged_at: new Date(Date.now() - ageMin * 60000),
      });
    }
    const signals = async () => (await require('../services/sms-graduation').fetchLiveJudgeSignals(database, { cohortVersions: [VERSION], voiceProfileVersion: null })).get('GENERAL');

    test('gate off: every scored row counts, old and new', async () => {
      await addJudged({ judgeVersion: null, ageMin: 5 });
      await addJudged({ judgeVersion: 'j2', verdict: 'draft_unsafe', ageMin: 4 });
      expect(await signals()).toMatchObject({ judged: 2, unsafe: 1, recentUnsafe: 1 });
    });

    test('gate on: only j2 rows count; old-judge rows are left out of totals and the recent window', async () => {
      process.env[GATE] = 'true';
      await addJudged({ judgeVersion: null, verdict: 'draft_unsafe', ageMin: 5 });
      await addJudged({ judgeVersion: null, ageMin: 4 });
      await addJudged({ judgeVersion: 'j2', ageMin: 3 });
      expect(await signals()).toMatchObject({ judged: 1, unsafe: 0, recentUnsafe: 0, gradedAccepted: 1 });
    });
  });
});
