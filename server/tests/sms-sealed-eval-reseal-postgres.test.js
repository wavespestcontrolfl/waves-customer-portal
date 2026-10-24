/**
 * The sealed exam's freezer against a real Postgres: recent judged drafts reach the pool when they carry
 * the facts the CURRENT drafter needs, a known earlier render of the static COMPANY FACTS section is
 * rebased (not a reason to wait a week), incompatible drafts stay out, and the pool rotates toward the
 * compatible items by retiring (never deleting) the oldest incompatible ones.
 *
 * Facts blocks come from the real buildFactsBlock, so the contract markers are checked against what the
 * drafter really writes. Synthetic text only.
 */
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

jest.setTimeout(180000);

(SKIP ? describe.skip : describe)('sealEvalItems on PostgreSQL', () => {
  const schema = `sealed_reseal_${randomUUID().replaceAll('-', '')}`;
  const VERSION = 'house_voice_v12_real_answers25_n';
  const GATE = 'GATE_SMS_REAL_ANSWERS';
  const DAY = 86400 * 1000;
  let database;
  let sealedEval;
  let companyFacts;
  let drafter;
  let versionSpy;
  const ctx = { summary: 'Test customer', upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19', window: '8-10am' }] };

  beforeAll(async () => {
    process.env[GATE] = 'true';
    jest.spyOn(require('../services/logger'), 'info').mockImplementation(() => {});
    drafter = require('../services/sms-shadow-drafter');
    versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue(VERSION);
    sealedEval = require('../services/sms-sealed-eval');
    companyFacts = require('../services/sms-company-facts');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE sms_log (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
    await database.raw(`CREATE TABLE message_drafts (
      id uuid PRIMARY KEY, customer_id uuid, intent text, inbound_message text, facts_block text, context_summary text,
      scheduling_intent boolean DEFAULT false, created_at timestamptz NOT NULL, prompt_version varchar(40), sms_log_id uuid)`);
    await database.raw(`CREATE TABLE shadow_draft_judgments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL, human_replied boolean, human_reply_text text, human_reply_sms_id uuid)`);
    await database.raw(`CREATE TABLE sms_sealed_eval_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_draft_id uuid NOT NULL UNIQUE REFERENCES message_drafts(id),
      customer_id uuid, intent varchar(50), inbound_message text NOT NULL, facts_block text NOT NULL, context_summary text,
      human_reply_text text NOT NULL, human_reply_sms_id uuid, scheduling_intent boolean NOT NULL DEFAULT false,
      inbound_at timestamptz, active boolean NOT NULL DEFAULT true, schema_version varchar(40) NOT NULL DEFAULT 'sms-sealed-eval.v1',
      sealed_at timestamptz NOT NULL DEFAULT now())`);
  });
  afterAll(async () => {
    delete process.env[GATE];
    if (versionSpy) versionSpy.mockRestore();
    jest.restoreAllMocks();
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });
  afterEach(async () => {
    await database.raw('TRUNCATE sms_sealed_eval_items, shadow_draft_judgments, message_drafts, sms_log CASCADE');
  });

  // ---- facts blocks as the drafter writes them ----
  const currentBlock = () => drafter.buildFactsBlock(ctx, { now: new Date('2026-10-20T15:00:00Z') });
  // a block with a confirmed missed visit: three of these satisfy the exam's missed-visit minimum
  const missedBlock = () => drafter.buildFactsBlock(
    { ...ctx, visitLoops: { missedVisit: { logId: 'rl-1', type: 'Pest Control', date: '2026-10-18', windowStart: '09:00:00', windowDisplay: '9-11am' } } },
    { now: new Date('2026-10-20T15:00:00Z') },
  );
  // the block an earlier identity drafted: the same day-of facts, the earlier static company section
  const priorRenderBlock = () => {
    const now = currentBlock();
    const section = companyFacts.renderCompanyFactsSection();
    expect(now).toContain(section);
    return now.replace(section, companyFacts.knownCompanyFactsRenders()[1]);
  };
  // frozen before the PORTAL SELF-CANCEL line existed (2026-10-09): not recoverable
  const prePortalBlock = () => currentBlock().replace(/^PORTAL SELF-CANCEL:.*\n/m, '');

  const addDraft = async ({
    facts, ageDays = 12, inbound = 'when is my next visit?', reply = 'Thursday morning.', replied = true,
    promptVersion = 'house_voice_v12_real_answers14_n', intent = 'SCHEDULING',
  }) => {
    const id = randomUUID();
    const smsId = randomUUID();
    const at = new Date(Date.now() - ageDays * DAY);
    await database('sms_log').insert({ id: smsId, created_at: at });
    await database('message_drafts').insert({
      id, customer_id: randomUUID(), intent, inbound_message: inbound, facts_block: facts, context_summary: 'summary',
      created_at: at, prompt_version: promptVersion, sms_log_id: smsId,
    });
    await database('shadow_draft_judgments').insert({
      draft_id: id, human_replied: replied, human_reply_text: reply, human_reply_sms_id: randomUUID(),
    });
    return id;
  };
  const addSealed = async ({ facts, sealedDaysAgo, active = true }) => {
    const sourceId = await addDraft({ facts, ageDays: sealedDaysAgo + 8 });
    const [row] = await database('sms_sealed_eval_items').insert({
      source_draft_id: sourceId, intent: 'GENERAL', inbound_message: 'old question', facts_block: facts, human_reply_text: 'old reply',
      active, sealed_at: new Date(Date.now() - sealedDaysAgo * DAY),
    }).returning('id');
    return row.id || row;
  };
  const items = () => database('sms_sealed_eval_items').select('*');

  test('seals recent drafts that carry the current facts - as drafted, or rebased from a known earlier company render', async () => {
    const asDrafted = await addDraft({ facts: currentBlock() });
    const rebased = await addDraft({ facts: priorRenderBlock(), ageDays: 9 });

    const out = await sealedEval.sealEvalItems({ target: 100, dbi: database });

    expect(out).toMatchObject({ sealed: 2, rebased: 1 });
    const rows = await items();
    const byDraft = Object.fromEntries(rows.map((r) => [r.source_draft_id, r]));
    expect(byDraft[asDrafted].facts_block).toBe(currentBlock());
    expect(byDraft[asDrafted].schema_version).toBe('sms-sealed-eval.v1');
    // the rebased row is today's block, byte for byte, and says it was rebased
    expect(byDraft[rebased].facts_block).toBe(currentBlock());
    expect(byDraft[rebased].schema_version).toBe('sms-sealed-eval.v1+rebased');
    for (const r of rows) expect(sealedEval.itemCompatibleWith(r.facts_block, VERSION)).toBe(true);
    // the human reply and the inbound are frozen verbatim
    expect(byDraft[rebased]).toMatchObject({ inbound_message: 'when is my next visit?', human_reply_text: 'Thursday morning.', active: true });
  });

  test('does not seal what the current contract cannot grade, or what the freezer never takes', async () => {
    await addDraft({ facts: prePortalBlock() }); // lacks a fact the current identity requires
    await addDraft({ facts: currentBlock(), promptVersion: 'house_voice_v12_real_answers14_backfill' }); // backfill drift
    await addDraft({ facts: currentBlock(), ageDays: 2 }); // too recent: the human reply may not have matured
    await addDraft({ facts: currentBlock(), replied: false }); // no ground truth
    await addDraft({ facts: '' }); // no frozen facts
    // no company section at all
    await addDraft({ facts: currentBlock().replace(companyFacts.renderCompanyFactsSection(), '') });
    // an earlier render whose reworded line the reply may restate: not rebased
    await addDraft({ facts: priorRenderBlock(), inbound: 'Do you take cash?', reply: 'We take cards, never cash.' });
    await addDraft({ facts: priorRenderBlock(), reply: 'We spray the inside on the first visit.' });

    const out = await sealedEval.sealEvalItems({ target: 100, dbi: database });

    expect(out.sealed).toBe(0);
    expect(await items()).toHaveLength(0);
  });

  test('a second pass seals nothing, and a sealed row is never edited', async () => {
    await addDraft({ facts: priorRenderBlock() });
    await sealedEval.sealEvalItems({ target: 100, dbi: database });
    const before = await items();
    const again = await sealedEval.sealEvalItems({ target: 100, dbi: database });
    expect(again.sealed).toBe(0);
    expect(await items()).toEqual(before);
  });

  test('rotation: the oldest incompatible items are retired (never deleted) once the new items can carry an exam', async () => {
    // 14 items frozen before the PORTAL SELF-CANCEL line existed, sealed 31..44 days ago
    const old = [];
    for (let i = 0; i < 14; i += 1) old.push(await addSealed({ facts: prePortalBlock(), sealedDaysAgo: 31 + i }));
    for (let i = 0; i < 10; i += 1) await addDraft({ facts: i % 2 ? currentBlock() : priorRenderBlock(), ageDays: 9 + i });

    const out = await sealedEval.sealEvalItems({ target: 100, dbi: database });

    expect(out).toMatchObject({ sealed: 10, retired: 4, activeCount: 20 });
    const rows = await items();
    expect(rows).toHaveLength(24); // nothing deleted
    const active = rows.filter((r) => r.active);
    expect(active).toHaveLength(20);
    expect(active.filter((r) => sealedEval.itemCompatibleWith(r.facts_block, VERSION))).toHaveLength(10);
    // the 4 retired are the 4 OLDEST incompatible ones
    const retired = rows.filter((r) => !r.active);
    expect(retired).toHaveLength(4);
    const keptIncompatible = active.filter((r) => !sealedEval.itemCompatibleWith(r.facts_block, VERSION));
    const newestRetired = Math.max(...retired.map((r) => +r.sealed_at));
    expect(Math.min(...keptIncompatible.map((r) => +r.sealed_at))).toBeGreaterThan(newestRetired);
    // and the exam can start again: at least half the active pool is compatible
    expect(active.filter((r) => sealedEval.itemCompatibleWith(r.facts_block, VERSION)).length).toBeGreaterThanOrEqual(Math.ceil(active.length / 2));
  });

  test('rotation waits until the compatible items could run an exam of their own', async () => {
    for (let i = 0; i < 14; i += 1) await addSealed({ facts: prePortalBlock(), sealedDaysAgo: 31 + i });
    for (let i = 0; i < 3; i += 1) await addDraft({ facts: currentBlock(), ageDays: 9 + i });

    const out = await sealedEval.sealEvalItems({ target: 100, dbi: database });

    expect(out).toMatchObject({ sealed: 3, retired: 0 });
    expect((await items()).filter((r) => r.active)).toHaveLength(17);
  });

  test('a dry run writes nothing and reports what the real pass then does', async () => {
    for (let i = 0; i < 14; i += 1) await addSealed({ facts: prePortalBlock(), sealedDaysAgo: 31 + i });
    for (let i = 0; i < 10; i += 1) await addDraft({ facts: priorRenderBlock(), ageDays: 9 + i });
    const before = await items();

    const plan = await sealedEval.sealEvalItems({ target: 100, dbi: database, dryRun: true });

    expect(await items()).toEqual(before);
    expect(plan).toMatchObject({ dryRun: true, sealed: 10, rebased: 10, retired: 4, activeCount: 20 });
    expect(JSON.stringify(plan)).not.toMatch(/when is my next visit/);
    const real = await sealedEval.sealEvalItems({ target: 100, dbi: database });
    expect(real).toMatchObject({ sealed: plan.sealed, rebased: plan.rebased, retired: plan.retired, activeCount: plan.activeCount });
  });

  // a dry run plans every branch on the counts the real pass would leave, never on a database it did not change
  const parity = async (opts) => {
    const before = await items();
    const plan = await sealedEval.sealEvalItems({ ...opts, dbi: database, dryRun: true });
    expect(await items()).toEqual(before);
    const real = await sealedEval.sealEvalItems({ ...opts, dbi: database });
    expect(plan).toMatchObject({ sealed: real.sealed, retired: real.retired, activeCount: real.activeCount });
    expect(plan.reactivated || 0).toBe(real.reactivated || 0);
    return real;
  };

  test('dry run and real pass agree when the pool is over target and nothing is sealed', async () => {
    for (let i = 0; i < 12; i += 1) await addSealed({ facts: i < 3 ? missedBlock() : currentBlock(), sealedDaysAgo: 5 + i });
    for (let i = 0; i < 8; i += 1) await addSealed({ facts: prePortalBlock(), sealedDaysAgo: 31 + i });
    const real = await parity({ target: 12 });
    expect(real).toMatchObject({ sealed: 0, retired: 8, activeCount: 12 });
  });

  test('dry run and real pass agree when no candidate is left but the pool must rotate', async () => {
    for (let i = 0; i < 12; i += 1) await addSealed({ facts: currentBlock(), sealedDaysAgo: 5 + i });
    for (let i = 0; i < 16; i += 1) await addSealed({ facts: prePortalBlock(), sealedDaysAgo: 31 + i });
    const real = await parity({ target: 100 });
    expect(real).toMatchObject({ sealed: 0, retired: 4, activeCount: 24 });
  });

  test('dry run and real pass agree when retired compatible items come back', async () => {
    for (let i = 0; i < 10; i += 1) await addSealed({ facts: currentBlock(), sealedDaysAgo: 5 + i });
    for (let i = 0; i < 5; i += 1) await addSealed({ facts: currentBlock(), sealedDaysAgo: 20 + i, active: false });
    for (let i = 0; i < 17; i += 1) await addSealed({ facts: prePortalBlock(), sealedDaysAgo: 31 + i });
    const real = await parity({ target: 100 });
    expect(real).toMatchObject({ reactivated: 5, retired: 2, activeCount: 30 });
  });

  test('the minimum age can be lowered for one pass', async () => {
    await addDraft({ facts: currentBlock(), ageDays: 3 });
    expect((await sealedEval.sealEvalItems({ target: 100, dbi: database })).sealed).toBe(0);
    expect((await sealedEval.sealEvalItems({ target: 100, dbi: database, minAgeDays: 2 })).sealed).toBe(1);
  });
});
