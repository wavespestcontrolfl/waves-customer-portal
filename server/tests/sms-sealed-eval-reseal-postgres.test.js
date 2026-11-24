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
  const VERSION = 'house_voice_v12_real_answers41_n';
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
      scheduling_intent boolean DEFAULT false, created_at timestamptz NOT NULL, prompt_version varchar(40), sms_log_id uuid,
      intended_actions jsonb)`);
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
  // An earlier render is picked by its recorded sha256 (sms-company-facts.js PRIOR_COMPANY_FACTS_RENDERS), never by its place in
  // knownCompanyFactsRenders(): a newer render shifts every index (the holidays change of 2026-11-24 did).
  const SHA_SEVEN_PLACE_HOLD = '73b8adba115c4c1eb3bd8c306a37b8ba3609f39cda15ac6aeb99e64080c9aa69'; // prompts 33 to 36
  const SHA_SIX_PLACE_HOLD = '468057aeb7bdddbca9bb3c796decc7f34f86800e6957c00a0c2e7b435356891e'; // prompts 29 to 32
  const SHA_NINETEEN_LINE = '3a72b3d4acb47ca8f95cfe6ddb9aedf65c696f6cc3f60efb5999725bf7880577'; // live 2026-10-09 to 2026-10-22
  const renderBySha = (sha256) => {
    const render = companyFacts.knownCompanyFactsRenders().find((r) => require('crypto').createHash('sha256').update(r).digest('hex') === sha256);
    expect(render).toBeTruthy();
    return render;
  };
  // the block an earlier identity drafted: the same day-of facts, the earlier static company section
  // (the seven-place hold render of 2026-11-23, prompts 33 to 36: its service-area topics are the ones the cases below skip)
  const priorRenderBlock = () => {
    const now = currentBlock();
    const section = companyFacts.renderCompanyFactsSection();
    expect(now).toContain(section);
    return now.replace(section, renderBySha(SHA_SEVEN_PLACE_HOLD));
  };
  // the six-place hold render of 2026-11-23 (prompts 29 to 32): the render before it (Charlotte County served except Punta Gorda,
  // prompts 25 to 28) is today's render again, so it needs no rebase
  const sixPlaceHoldRenderBlock = () => currentBlock().replace(companyFacts.renderCompanyFactsSection(), renderBySha(SHA_SIX_PLACE_HOLD));
  // frozen before the PORTAL SELF-CANCEL line existed (2026-10-09): not recoverable
  // a block drafted under the 19-line render (live 2026-10-09 to 2026-10-22), whose payment and inside-spray lines were reworded since
  const nineteenLineBlock = () => currentBlock().replace(companyFacts.renderCompanyFactsSection(), renderBySha(SHA_NINETEEN_LINE));
  const prePortalBlock = () => currentBlock().replace(/^PORTAL SELF-CANCEL:.*\n/m, '');

  const addDraft = async ({
    facts, ageDays = 12, inbound = 'when is my next visit?', reply = 'Thursday morning.', replied = true,
    promptVersion = 'house_voice_v12_real_answers14_n', intent = 'SCHEDULING', intendedActions = null,
  }) => {
    const id = randomUUID();
    const smsId = randomUUID();
    const at = new Date(Date.now() - ageDays * DAY);
    await database('sms_log').insert({ id: smsId, created_at: at });
    await database('message_drafts').insert({
      id, customer_id: randomUUID(), intent, inbound_message: inbound, facts_block: facts, context_summary: 'summary',
      created_at: at, prompt_version: promptVersion, sms_log_id: smsId,
      intended_actions: intendedActions ? JSON.stringify(intendedActions) : null,
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

  test('seals recent drafts that carry the current facts as drafted; a draft under an earlier render is never rebased (it carries the retired holidays line)', async () => {
    const asDrafted = await addDraft({ facts: currentBlock() });
    // every earlier render told the model Waves works every holiday: the exchange is stale whatever the messages say
    for (const render of companyFacts.knownCompanyFactsRenders().slice(1)) {
      await addDraft({ facts: currentBlock().replace(companyFacts.renderCompanyFactsSection(), render), ageDays: 9 });
      await addDraft({ facts: currentBlock().replace(companyFacts.renderCompanyFactsSection(), render), ageDays: 9, inbound: 'December 25?', reply: 'Yes' });
    }

    const out = await sealedEval.sealEvalItems({ target: 100, dbi: database });

    expect(out).toMatchObject({ sealed: 1 });
    const rows = await items();
    expect(rows).toHaveLength(1);
    expect(rows[0].source_draft_id).toBe(asDrafted);
    expect(rows[0].facts_block).toBe(currentBlock());
    expect(rows[0].schema_version).toBe('sms-sealed-eval.v1');
    expect(sealedEval.itemCompatibleWith(rows[0].facts_block, VERSION)).toBe(true);
    // the human reply and the inbound are frozen verbatim
    expect(rows[0]).toMatchObject({ inbound_message: 'when is my next visit?', human_reply_text: 'Thursday morning.', active: true });
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
    await addDraft({ facts: nineteenLineBlock(), inbound: 'Do you take cash?', reply: 'We take cards, never cash.' });
    await addDraft({ facts: nineteenLineBlock(), reply: 'We spray the inside on the first visit.' });
    // the 26-line renders (live to 2026-11-23) already had the payment and inside lines: only the service area line was reworded
    await addDraft({ facts: priorRenderBlock(), inbound: 'Do you cover 33948?', reply: 'Yes, we do.' });
    await addDraft({ facts: sixPlaceHoldRenderBlock(), inbound: 'Do you cover 33948?', reply: 'Yes, we do.' });
    // an exchange drafted under the hold line that turned Englewood or Port Charlotte away: stale now that both are served again
    await addDraft({ facts: priorRenderBlock(), inbound: 'Can you service Englewood?', reply: 'Not yet, we are not taking new customers there.' });
    await addDraft({ facts: priorRenderBlock(), inbound: 'Is Port Charlotte covered?', reply: 'Not yet.' });
    // a held place (owner ruling 2026-11-23) named only earlier in the thread, or only in the frozen OPEN TIMES lookup
    await addDraft({ facts: `${priorRenderBlock()}\nRECENT SMS THREAD:\n[CUSTOMER] I'm in Englewood\n`, inbound: 'Can I book?', reply: 'Tuesday works.' });
    await addDraft({
      facts: priorRenderBlock(), inbound: 'Can I book?', reply: 'Tuesday works.',
      intendedActions: { actions: [], open_times_snapshot: { lookup: { source: 'website_engine', city: 'Port Charlotte' } } },
    });

    const out = await sealedEval.sealEvalItems({ target: 100, dbi: database });

    expect(out.sealed).toBe(0);
    expect(await items()).toHaveLength(0);
  });

  test('a second pass seals nothing, and a sealed row is never edited', async () => {
    await addDraft({ facts: currentBlock() });
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
    for (let i = 0; i < 10; i += 1) await addDraft({ facts: currentBlock(), ageDays: 9 + i });

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
    for (let i = 0; i < 10; i += 1) await addDraft({ facts: currentBlock(), ageDays: 9 + i });
    const before = await items();

    const plan = await sealedEval.sealEvalItems({ target: 100, dbi: database, dryRun: true });

    expect(await items()).toEqual(before);
    expect(plan).toMatchObject({ dryRun: true, sealed: 10, retired: 4, activeCount: 20 });
    expect(JSON.stringify(plan)).not.toMatch(/when is my next visit/);
    const real = await sealedEval.sealEvalItems({ target: 100, dbi: database });
    expect(real).toMatchObject({ sealed: plan.sealed, retired: plan.retired, activeCount: plan.activeCount });
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

  test('dry run and real pass agree when the restored items are the missed-visit cases (none counted twice)', async () => {
    for (let i = 0; i < 3; i += 1) await addSealed({ facts: missedBlock(), sealedDaysAgo: 20 + i, active: false });
    for (let i = 0; i < 4; i += 1) await addSealed({ facts: prePortalBlock(), sealedDaysAgo: 31 + i });
    const real = await parity({ target: 100 });
    expect(real).toMatchObject({ sealed: 0, reactivated: 3, retired: 0, activeCount: 7 });
  });

  test('the minimum age can be lowered for one pass', async () => {
    await addDraft({ facts: currentBlock(), ageDays: 3 });
    expect((await sealedEval.sealEvalItems({ target: 100, dbi: database })).sealed).toBe(0);
    expect((await sealedEval.sealEvalItems({ target: 100, dbi: database, minAgeDays: 2 })).sealed).toBe(1);
  });
});
