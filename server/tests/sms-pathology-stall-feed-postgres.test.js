/**
 * Stall feed on real Postgres (GATE_SMS_LEDGER_STALL_FEED, owner 2026-11-01): the nightly selection (only judge-v2
 * + human_better + could_send no), its idempotency under its own evidence type, and the proposer's base-identity
 * count. Stand-ins for the two tables the feed reads sit in a private schema next to the real ledger migrations;
 * the model and the DEEP call are scripted. All text is synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({})));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const llmCall = require('../services/llm/call');
const { createDeepMessage } = require('../services/llm/deep');
const patchLib = require('../services/sms-prompt-patch');
const drafter = require('../services/sms-shadow-drafter');
const { classifyStallFeed, classifyPathologies, proposePatches } = require('../services/sms-pathology-ledger');
const ledgerMigration = require('../models/migrations/20260718110000_sms_pathology_ledger');
const versionMigration = require('../models/migrations/20260928040000_sms_patch_proposals_prompt_version');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('stall feed on PostgreSQL', () => {
  const schema = `stall_feed_${randomUUID().replaceAll('-', '')}`;
  let database;
  const saved = {};
  const ENV = ['GATE_SMS_LEDGER_STALL_FEED', 'GATE_SMS_REAL_ANSWERS'];

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    ENV.forEach((name) => { saved[name] = process.env[name]; });
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await ledgerMigration.up(database);
    await versionMigration.up(database);
    await database.raw(`CREATE TABLE ??.message_drafts (id uuid PRIMARY KEY, inbound_message text, draft_response text,
      facts_block text, prompt_version varchar(40), intended_actions jsonb, created_at timestamptz)`, [schema]);
    await database.raw(`CREATE TABLE ??.shadow_draft_judgments (id uuid PRIMARY KEY, draft_id uuid, verdict varchar(20),
      human_replied boolean, human_reply_text text, intent varchar(50), notes text, judge_version varchar(8),
      could_send varchar(16), judged_at timestamptz)`, [schema]);
  });
  afterAll(async () => {
    ENV.forEach((name) => {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });

  beforeEach(async () => {
    ENV.forEach((name) => delete process.env[name]);
    process.env.GATE_SMS_LEDGER_STALL_FEED = 'true';
    await database('sms_pathology_entries').del();
    await database('sms_patch_proposals').del();
    await database('shadow_draft_judgments').del();
    await database('message_drafts').del();
    llmCall.dispatchWithFallback.mockReset();
    llmCall.dispatchWithFallback.mockImplementation(async (_policy, payload) => ({
      ok: true,
      model: 'scripted',
      // The scripted model answers from the draft text in the prompt.
      text: JSON.stringify({ failure_mode: /STALLED/.test(payload.text) ? 'stalled_deferred' : 'knew_more', summary: 'Synthetic summary.' }),
    }));
    createDeepMessage.mockReset();
    createDeepMessage.mockResolvedValue({ model: 'deep-test', content: [{ text: '## Pattern\nSynthetic.\n## Proposed change\nSynthetic.\n## Validation\nSynthetic.' }] });
  });

  const draft = async (over = {}) => {
    const id = randomUUID();
    await database('message_drafts').insert({
      id, inbound_message: 'when are you coming?', draft_response: 'STALLED: let me confirm and get back to you.',
      facts_block: 'UPCOMING SERVICES: Quarterly Pest Control, Tuesday, window 2-4 PM',
      prompt_version: 'house_voice_v12_real_answers26_n', intended_actions: JSON.stringify({ verify: { converged: false } }),
      created_at: new Date('2026-10-30T15:00:00Z'), ...over,
    });
    return id;
  };
  const judgment = async (draftId, over = {}) => {
    const id = randomUUID();
    await database('shadow_draft_judgments').insert({
      id, draft_id: draftId, verdict: 'human_better', human_replied: true, human_reply_text: 'You are on for Tuesday, 2 to 4.',
      intent: 'general', notes: 'n', judge_version: 'j2', could_send: 'no', judged_at: new Date('2026-10-31T07:55:00Z'), ...over,
    });
    return id;
  };

  test('only judge-v2 human_better rows with could_send no are read; a second run finds nothing', async () => {
    const wanted = await judgment(await draft());
    await judgment(await draft(), { could_send: 'yes' });
    await judgment(await draft(), { could_send: 'yes_with_edit' });
    await judgment(await draft(), { judge_version: null }); // the old judge
    await judgment(await draft(), { could_send: null, judge_version: 'j2' });
    await judgment(await draft(), { verdict: 'equivalent' });
    await judgment(await draft(), { verdict: 'draft_unsafe' });
    await judgment(await draft({ prompt_version: 'house_voice_v2_backfill' }));
    const second = await judgment(await draft({ draft_response: 'KNEW: sure.', prompt_version: null })); // a null version is not a backfill

    const first = await classifyStallFeed({ dbi: database, anthropicClient: {} });
    expect(first.classified).toBe(2);
    const stored = await database('sms_pathology_entries').orderBy('evidence_id');
    expect(stored.map((r) => r.evidence_id).sort()).toEqual([wanted, second].sort());
    const row = stored.find((r) => r.evidence_id === wanted);
    expect(row).toMatchObject({
      evidence_type: 'judgment_stall', surface: 'prompt_discipline', failure_mode: 'stalled_deferred',
      prompt_version: 'house_voice_v12_real_answers26_n', verifier_missed: false, model: 'scripted',
    });
    expect(stored.find((r) => r.evidence_id === second)).toMatchObject({ surface: 'facts_block_gap', failure_mode: 'knew_more', prompt_version: null });

    expect(await classifyStallFeed({ dbi: database, anthropicClient: {} })).toMatchObject({ classified: 0 });
    expect(llmCall.dispatchWithFallback).toHaveBeenCalledTimes(2); // none on the second run
    expect(await database('sms_pathology_entries')).toHaveLength(2);
  });

  test('gate off: the feed reads and writes nothing', async () => {
    delete process.env.GATE_SMS_LEDGER_STALL_FEED;
    await judgment(await draft());
    expect(await classifyStallFeed({ dbi: database, anthropicClient: {} })).toMatchObject({ classified: 0, skipped: 'gate_off' });
    expect(await database('sms_pathology_entries')).toHaveLength(0);
    expect(llmCall.dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the draft_unsafe feed and the stall feed keep apart: same judgment, two evidence types, no clash', async () => {
    const unsafeId = await judgment(await draft(), { verdict: 'draft_unsafe' });
    const stallId = await judgment(await draft());
    llmCall.dispatchWithFallback.mockResolvedValue({ ok: true, model: 'scripted', text: JSON.stringify({ surface: 'prompt_discipline', failure_mode: 'over_completion', summary: 's' }) });
    expect(await classifyPathologies({ dbi: database, anthropicClient: {} })).toMatchObject({ classified: 1 });
    llmCall.dispatchWithFallback.mockResolvedValue({ ok: true, model: 'scripted', text: JSON.stringify({ failure_mode: 'knew_more', summary: 's' }) });
    expect(await classifyStallFeed({ dbi: database, anthropicClient: {} })).toMatchObject({ classified: 1 });
    const rows = await database('sms_pathology_entries').orderBy('evidence_type');
    expect(rows.map((r) => [r.evidence_type, r.evidence_id])).toEqual([['judgment', unsafeId], ['judgment_stall', stallId]]);
  });

  describe('the proposer counts by the base prompt identity', () => {
    const BASE = 'house_voice_v12_real_answers26_n';
    const entry = (version, i, over = {}) => ({
      evidence_type: 'judgment_stall', evidence_id: randomUUID(), surface: 'prompt_discipline', failure_mode: 'stalled_deferred',
      prompt_version: version, summary: `Synthetic stall ${i}.`, classified_at: new Date('2026-10-30T12:00:00Z'), ...over,
    });
    let spies;
    const liveAs = (version) => {
      spies = [
        jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue(version),
        jest.spyOn(drafter, 'currentPromptVersionBase').mockReturnValue(BASE),
      ];
    };
    afterEach(() => { (spies || []).forEach((s) => s.mockRestore()); });

    test('gate off: only the exact live version counts (a patch letter resets the cell, as before)', async () => {
      delete process.env.GATE_SMS_LEDGER_STALL_FEED;
      liveAs(patchLib.stampPatchVersion(BASE, 'B'));
      await database('sms_pathology_entries').insert([
        ...[0, 1, 2].map((i) => entry(BASE, i)),
        ...[3, 4, 5].map((i) => entry(patchLib.stampPatchVersion(BASE, 'A'), i)),
        ...[6, 7].map((i) => entry(patchLib.stampPatchVersion(BASE, 'B'), i)),
      ]);
      expect(await proposePatches({ dbi: database, anthropicClient: {}, minEvidence: 5 })).toMatchObject({ proposed: 0 });
      expect(createDeepMessage).not.toHaveBeenCalled();
    });

    test('gate on: the base and every letter of it count; another base does not; the watermark keeps the old proposal', async () => {
      liveAs(patchLib.stampPatchVersion(BASE, 'B'));
      await database('sms_pathology_entries').insert([
        ...[0, 1, 2].map((i) => entry(BASE, i)),
        ...[3, 4, 5].map((i) => entry(patchLib.stampPatchVersion(BASE, 'A'), i)),
        ...[6, 7].map((i) => entry(patchLib.stampPatchVersion(BASE, 'B'), i)),
        ...[8, 9, 10].map((i) => entry('house_voice_v11', i)), // another base identity
      ]);
      const out = await proposePatches({ dbi: database, anthropicClient: {}, minEvidence: 5 });
      expect(out).toMatchObject({ proposed: 1 });
      const [proposal] = await database('sms_patch_proposals');
      expect(proposal).toMatchObject({ surface: 'prompt_discipline', failure_mode: 'stalled_deferred', evidence_count: 8, status: 'pending' });
      expect(proposal.prompt_version).toBe(patchLib.stampPatchVersion(BASE, 'B'));
      expect(proposal.evidence_ids).toHaveLength(8);
      expect(proposal.evidence_cutoff_at).toBeInstanceOf(Date);

      // A promotion moves the live letter to C: the old proposal is still this cell's watermark, so the
      // same eight entries are not counted again, and only entries classified after it are fresh.
      liveAs(patchLib.stampPatchVersion(BASE, 'C'));
      createDeepMessage.mockClear();
      expect(await proposePatches({ dbi: database, anthropicClient: {}, minEvidence: 5 })).toMatchObject({ proposed: 0 });
      await new Promise((resolve) => setTimeout(resolve, 25)); // strictly after the first run's evidence cutoff
      await database('sms_pathology_entries').insert([0, 1, 2, 3, 4].map((i) => entry(patchLib.stampPatchVersion(BASE, 'C'), 20 + i, { classified_at: new Date() })));
      const again = await proposePatches({ dbi: database, anthropicClient: {}, minEvidence: 5 });
      expect(again).toMatchObject({ proposed: 1 });
      const pending = await database('sms_patch_proposals').where({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].evidence_count).toBe(5);
    });
  });
});
