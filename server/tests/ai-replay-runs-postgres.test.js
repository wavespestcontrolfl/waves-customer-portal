/**
 * ai_replay_runs on real Postgres — the replay step of the correction loop,
 * with no provider call anywhere (owner ruling 2026-10-02): a run's status
 * rules, the dev-before-holdout rule, the proposal stamps, carrying a
 * proposal across a prompt-version bump only when the replay still
 * reproduces, the frozen-case export, and the read-only brief.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Nothing in this lane may reach a provider.
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(() => { throw new Error('no provider calls in replays'); }) }));

const SKIP = !process.env.DATABASE_URL;
const fs = require('fs');
const os = require('os');
const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');
const incidentsMigration = require('../models/migrations/20261002170000_ai_incidents');
const proposalsMigration = require('../models/migrations/20261002190000_ai_fix_proposals');
const migration = require('../models/migrations/20261002210000_ai_replay_runs');
const { proposeFromIncidents, transitionProposal } = require('../services/ai-incidents/fix-proposals');
const replay = require('../services/ai-incidents/replay-runs');
const cli = require('../../ops/agents/correction-replay');
const report = require('../../ops/agents/correction-loop-report');

jest.setTimeout(60000);

const V12 = 'house_voice_v12_real_answers3_cfl';
const V13 = 'house_voice_v13';
const CELL = { surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta' };
const SHA = 'e25e9cfabc';
// Distinct 8-character prefixes; the hash split of these 12 is 10 dev / 2 holdout.
const KEYS = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`);

test('the service and the migration name the same closed lists', () => {
  expect(migration.SPLITS).toEqual([...replay.SPLITS]);
  expect(migration.METHODS).toEqual([...replay.METHODS]);
  expect(migration.PURPOSES).toEqual([...replay.PURPOSES]);
  expect(migration.RUN_STATUSES).toEqual([...replay.RUN_STATUSES]);
  expect(migration.VERDICTS).toEqual([...replay.VERDICTS]);
});

test('run status: a reproduction fails, an unjudged case is inconclusive, a small clean holdout is underpowered', () => {
  expect(replay.runStatus({ split: 'dev', fixed: 9, reproduces: 1, inconclusive: 0 })).toBe('failed');
  expect(replay.runStatus({ split: 'dev', fixed: 9, reproduces: 0, inconclusive: 1 })).toBe('inconclusive');
  expect(replay.runStatus({ split: 'dev', fixed: 0, reproduces: 0, inconclusive: 0 })).toBe('inconclusive');
  expect(replay.runStatus({ split: 'holdout', fixed: 4, reproduces: 0, inconclusive: 0 })).toBe('underpowered');
  expect(replay.runStatus({ split: 'holdout', fixed: 5, reproduces: 0, inconclusive: 0 })).toBe('passed');
  expect(replay.runStatus({ split: 'dev', fixed: 1, reproduces: 0, inconclusive: 0 })).toBe('passed');
});

test('export refuses a directory inside the repository, however it is spelled', () => {
  expect(() => cli.assertOutsideRepo(path.join(__dirname, 'replay-out'))).toThrow(/outside the repository/);
  expect(() => cli.assertOutsideRepo(path.join(__dirname, '..replay'))).toThrow(/outside the repository/);
  expect(() => cli.assertOutsideRepo(path.join(__dirname, '..', '..'))).toThrow(/outside the repository/);
  // A symlink outside the repo that points into it.
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-link-')), 'into-repo');
  fs.symlinkSync(__dirname, link);
  expect(() => cli.assertOutsideRepo(path.join(link, 'out'))).toThrow(/outside the repository/);
  expect(cli.assertOutsideRepo(path.join(os.tmpdir(), 'replay-out'))).toBe(path.join(os.tmpdir(), 'replay-out'));
  expect(() => cli.parseArgs(['record', '--file=x', '--execute=false'])).toThrow(/takes no value/);
});

(SKIP ? describe.skip : describe)('ai_replay_runs on PostgreSQL', () => {
  const schema = `ai_replay_runs_${randomUUID().replaceAll('-', '')}`;
  let database;
  let proposal;

  const results = (keys, verdict = 'fixed') => keys.map((k) => ({ incident_key: k, verdict, reason: verdict === 'fixed' ? 'no unsupported time' : 'still gives a time' }));
  const record = (over = {}) => replay.recordReplayRun({
    dbi: database, proposalId: proposal.id, split: 'dev', method: 'subagent', codeRef: SHA, promptVersion: V12,
    drafterModel: 'claude-sonnet-5-5 (subagent)', results: results(proposal.dev_incident_keys), by: 'lane:test', ...over,
  });

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await incidentsMigration.up(database);
    await proposalsMigration.up(database);
    await migration.up(database);
    await database.raw(`CREATE TABLE ??.message_drafts (id uuid PRIMARY KEY, inbound_message text, draft_response text,
      facts_block text, prompt_version varchar(40), created_at timestamptz, campaign_type varchar(30), intent varchar(50),
      scheduling_intent boolean, intended_actions text)`, [schema]);
    await database.raw('CREATE TABLE ??.voice_profiles (version integer PRIMARY KEY, profile_text text)', [schema]);
    await database('voice_profiles').insert({ version: 7, profile_text: 'PROFILE SEVEN' });
    await database.raw(`CREATE TABLE ??.shadow_draft_judgments (id uuid PRIMARY KEY, draft_id uuid UNIQUE, verdict varchar(20),
      human_replied boolean, human_reply_text text, intent varchar(50))`, [schema]);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });
  beforeEach(async () => {
    await database('ai_replay_results').del();
    await database('ai_replay_runs').del();
    await database('ai_fix_proposals').update({ supersedes: null });
    await database('ai_fix_proposals').del();
    await database('ai_incidents').del();
    await database('shadow_draft_judgments').del();
    await database('message_drafts').del();
    for (const [i, key] of KEYS.entries()) {
      const judgmentId = randomUUID();
      await database('message_drafts').insert({
        id: key, inbound_message: 'when are you coming?', draft_response: `See you Wednesday at ${i + 1}pm!`,
        facts_block: 'UPCOMING: Quarterly Pest 2026-10-06 (Tue) window 14:00-16:00', prompt_version: V12, created_at: new Date('2026-10-01T15:00:00Z'),
        intent: 'SCHEDULING', scheduling_intent: i % 2 === 0,
        // Drafts under profile 7, one under a profile no longer stored, the rest profile-free.
        intended_actions: JSON.stringify({ voice_profile_version: i < 6 ? 7 : i === 6 ? 99 : null }),
      });
      await database('shadow_draft_judgments').insert({ id: judgmentId, draft_id: key, verdict: 'human_better', human_replied: true, human_reply_text: 'Tuesday 2-4.', intent: 'scheduling' });
      await database('ai_incidents').insert({
        area: 'sms', evidence_type: 'judgment', evidence_id: judgmentId, incident_key: key, disposition: 'confirmed_mistake', ...CELL,
        prompt_version: V12, produced_at: new Date('2026-10-01T15:00:00Z'), summary: `summary-${i}`, adjudicated_at: new Date('2026-10-02T08:30:00Z'),
        adjudication: JSON.stringify({ readers: [{ answer: { quote: `Wednesday at ${i + 1}pm` } }, { answer: { quote: `Wednesday at ${i + 1}pm` } }] }),
      });
    }
    await proposeFromIncidents({ dbi: database, area: 'sms', promptVersion: V12, minEvidence: 5, now: new Date('2026-10-04T08:45:00Z') });
    proposal = await database('ai_fix_proposals').first();
  });

  test('a dev run is stored with its results and stamped on the proposal; a missing case is inconclusive, never a pass', async () => {
    const { run } = await record();
    expect(run).toMatchObject({ status: 'passed', case_count: 10, fixed_count: 10, exact_production_model: false, method: 'subagent' });
    expect((await database('ai_fix_proposals').where({ id: proposal.id }).first()).dev_run_id).toBe(run.id);
    expect(await database('ai_replay_results').where({ run_id: run.id })).toHaveLength(10);

    const partial = await record({ results: results(proposal.dev_incident_keys.slice(1)) });
    expect(partial.run).toMatchObject({ status: 'inconclusive', inconclusive_count: 1 });
    expect(await database('ai_replay_results').where({ run_id: partial.run.id, reason: 'not_run' })).toHaveLength(1);
  });

  test('a case outside the split, a duplicate, or an unknown verdict is refused before anything is written', async () => {
    await expect(record({ results: results([proposal.holdout_incident_keys[0]]) })).rejects.toMatchObject({ code: 'not_in_split' });
    const k = proposal.dev_incident_keys[0];
    await expect(record({ results: [{ incident_key: k, verdict: 'fixed' }, { incident_key: k, verdict: 'fixed' }] })).rejects.toMatchObject({ code: 'duplicate_result' });
    await expect(record({ results: [{ incident_key: k, verdict: 'probably' }] })).rejects.toMatchObject({ code: 'bad_verdict' });
    await expect(record({ codeRef: 'main' })).rejects.toMatchObject({ code: 'bad_code_ref' });
    expect(await database('ai_replay_runs').count('* as n').first()).toEqual({ n: '0' });
  });

  test('the holdout runs only after a passed dev run on the same code', async () => {
    const holdout = (over = {}) => record({ split: 'holdout', results: results(proposal.holdout_incident_keys), ...over });
    await expect(holdout()).rejects.toMatchObject({ code: 'dev_not_passed' });
    await record({ results: results(proposal.dev_incident_keys, 'reproduces') });
    await expect(holdout()).rejects.toMatchObject({ code: 'dev_not_passed' });
    await record();
    await expect(holdout({ codeRef: 'abcdef1234' })).rejects.toMatchObject({ code: 'dev_not_passed' });
    // Same commit, different gates: a different prompt version is a different candidate.
    await expect(holdout({ promptVersion: V13 })).rejects.toMatchObject({ code: 'dev_not_passed' });
    // A later failing dev run on the same code replaces the pass.
    await record({ results: results(proposal.dev_incident_keys, 'reproduces') });
    await expect(holdout()).rejects.toMatchObject({ code: 'dev_not_passed' });
    await record();
    // A closed PR clears the dev run with the rest of its evidence.
    await transitionProposal({ dbi: database, id: proposal.id, to: 'pr_open', fields: { pr_number: 7001 }, by: 'test' });
    await transitionProposal({ dbi: database, id: proposal.id, to: 'accepted', by: 'test' });
    await expect(holdout()).rejects.toMatchObject({ code: 'dev_not_passed' });
    await record();
    const { run } = await holdout();
    // Two clean holdout cases are not enough to call it proof.
    expect(run).toMatchObject({ status: 'underpowered', case_count: 2 });
    expect((await database('ai_fix_proposals').where({ id: proposal.id }).first()).holdout_run_id).toBe(run.id);
    // A run that is not this proposal's own dev fix run never authorizes its holdout.
    const recurrence = await record({ purpose: 'recurrence', split: 'holdout', results: results(proposal.holdout_incident_keys) });
    await database('ai_fix_proposals').where({ id: proposal.id }).update({ dev_run_id: recurrence.run.id });
    await expect(holdout()).rejects.toMatchObject({ code: 'dev_not_passed' });
    const otherId = randomUUID();
    await database('ai_fix_proposals').insert({ ...(await database('ai_fix_proposals').where({ id: proposal.id }).first()), id: otherId, failure_mode: 'invented_billing', supersedes: null, history: '[]', incident_keys: '[]', dev_incident_keys: JSON.stringify(proposal.dev_incident_keys), holdout_incident_keys: '[]' });
    const foreign = await record({ proposalId: otherId });
    await database('ai_fix_proposals').where({ id: proposal.id }).update({ dev_run_id: foreign.run.id });
    await expect(holdout()).rejects.toMatchObject({ code: 'dev_not_passed' });
    // A new candidate's dev run takes the old candidate's holdout proof off the proposal.
    const next = await record({ codeRef: 'abcdef1234' });
    expect(await database('ai_fix_proposals').where({ id: proposal.id }).first()).toMatchObject({ dev_run_id: next.run.id, holdout_run_id: null });
  });

  test('a version bump carries the proposal only when a recurrence check on the new version still reproduces', async () => {
    // The mistake still reproduces in dev too: a recurrence check needs no dev pass.
    await record({ promptVersion: V13, results: results(proposal.dev_incident_keys, 'reproduces') });
    const fixRun = (await database('ai_fix_proposals').where({ id: proposal.id }).first()).dev_run_id;
    await expect(record({ purpose: 'recurrence', split: 'dev', promptVersion: V13 })).rejects.toMatchObject({ code: 'needs_holdout' });
    const repro = await record({ purpose: 'recurrence', split: 'holdout', promptVersion: V13, results: results(proposal.holdout_incident_keys, 'reproduces') });
    expect(repro.run).toMatchObject({ purpose: 'recurrence', status: 'failed' });
    // A recurrence check is not the proposal's proof.
    expect(await database('ai_fix_proposals').where({ id: proposal.id }).first()).toMatchObject({ dev_run_id: fixRun, holdout_run_id: null });
    await expect(replay.carryForward({ dbi: database, proposalId: proposal.id, runId: repro.run.id, promptVersion: 'house_voice_v14', by: 'lane:test' }))
      .rejects.toMatchObject({ code: 'wrong_version' });
    const { superseded, carried } = await replay.carryForward({ dbi: database, proposalId: proposal.id, runId: repro.run.id, promptVersion: V13, by: 'lane:test' });
    expect(superseded.status).toBe('superseded');
    expect(carried).toMatchObject({ status: 'pending', prompt_version: V13, supersedes: proposal.id, evidence_count: 12 });
    expect(carried.holdout_incident_keys).toEqual(proposal.holdout_incident_keys);
  });

  test('a replay that no longer reproduces, or a fix run, is never carried', async () => {
    await record({ promptVersion: V13 });
    const fixHoldout = await record({ split: 'holdout', promptVersion: V13, results: results(proposal.holdout_incident_keys, 'reproduces') });
    await expect(replay.carryForward({ dbi: database, proposalId: proposal.id, runId: fixHoldout.run.id, promptVersion: V13, by: 'lane:test' }))
      .rejects.toMatchObject({ code: 'needs_recurrence_run' });
    const clean = await record({ purpose: 'recurrence', split: 'holdout', promptVersion: V13, results: results(proposal.holdout_incident_keys) });
    await expect(replay.carryForward({ dbi: database, proposalId: proposal.id, runId: clean.run.id, promptVersion: V13, by: 'lane:test' }))
      .rejects.toMatchObject({ code: 'no_longer_reproduces' });
    expect((await database('ai_fix_proposals').where({ id: proposal.id }).first()).status).toBe('pending');
  });

  test('the table keeps counts honest and the split closed', async () => {
    const base = { area: 'sms', proposal_id: proposal.id, split: 'dev', method: 'subagent', purpose: 'fix', code_ref: SHA, status: 'passed', created_by: 't' };
    await expect(database('ai_replay_runs').insert({ ...base, case_count: 3, fixed_count: 1, reproduces_count: 0, inconclusive_count: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(database('ai_replay_runs').insert({ ...base, split: 'test', case_count: 1, fixed_count: 1, reproduces_count: 0, inconclusive_count: 0 })).rejects.toMatchObject({ code: '23514' });
  });

  test('export writes the frozen dev cases, the system prompt and a results template outside the repo; record dry-runs by default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
    const drafter = {
      buildUserPromptFromFacts: (facts, inbound, intent, scheduling) => `${facts}\n\nCUSTOMER: ${inbound}\nINTENT: ${intent.intent}${scheduling ? ' (scheduling)' : ''}`,
      buildSystemPromptWithProfile: (text) => ({ system: `SYSTEM PROMPT${text ? ` + ${text}` : ''}` }),
      currentPromptVersion: () => V12,
    };
    const lines = [];
    await cli.run({ dbi: database, argv: ['export', `--proposal=${String(proposal.id).slice(0, 8)}`, '--split=dev', `--out=${dir}`], log: (l) => lines.push(l), drafter });
    const cases = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(cases).toHaveLength(10);
    expect(cases.map((c) => c.incident_key).sort()).toEqual([...proposal.dev_incident_keys].sort());
    expect(cases[0]).toMatchObject({ split: 'dev', human_reply: 'Tuesday 2-4.', intent: 'SCHEDULING', cell: CELL });
    // The stored scheduling-intent flag reaches the replayed prompt, case by case.
    for (const c of cases) expect(c.user_prompt.endsWith('(scheduling)')).toBe(c.scheduling_intent);
    expect(new Set(cases.map((c) => c.scheduling_intent)).size).toBe(2);
    expect(cases[0].unsupported_quotes).toHaveLength(2);
    expect(cases[0].user_prompt).toContain('CUSTOMER: when are you coming?');
    // Each case points at the system prompt for the voice profile it was drafted under.
    expect(fs.readFileSync(path.join(dir, 'system-prompt-v7.txt'), 'utf8')).toBe('SYSTEM PROMPT + PROFILE SEVEN');
    expect(fs.readFileSync(path.join(dir, 'system-prompt-base.txt'), 'utf8')).toBe('SYSTEM PROMPT');
    const byKey = new Map(cases.map((c) => [c.incident_key, c]));
    for (const [i, key] of KEYS.entries()) {
      const c = byKey.get(key);
      if (!c) continue;
      if (i < 6) expect(c).toMatchObject({ system_prompt_file: 'system-prompt-v7.txt', replay_omits: ['few_shot_exemplars', 'verify_revise_loop', 'thread_mixed_hint'] });
      else if (i === 6) expect(c).toMatchObject({ system_prompt_file: 'system-prompt-base.txt', replay_omits: ['few_shot_exemplars', 'verify_revise_loop', 'thread_mixed_hint', 'voice_profile'] });
      else expect(c.system_prompt_file).toBe('system-prompt-base.txt');
    }
    // No line the CLI prints carries customer text.
    expect(lines.join('\n')).not.toMatch(/when are you coming|Wednesday/);

    const template = JSON.parse(fs.readFileSync(path.join(dir, 'results-template.json'), 'utf8'));
    template.code_ref = SHA;
    template.results = template.results.map((r) => ({ ...r, verdict: 'fixed', reason: 'ok' }));
    const file = path.join(dir, 'results.json');
    fs.writeFileSync(file, JSON.stringify(template));
    const dry = await cli.run({ dbi: database, argv: ['record', `--file=${file}`], log: () => {} });
    expect(dry.recorded).toBe(false);
    expect(await database('ai_replay_runs').count('* as n').first()).toEqual({ n: '0' });
    const done = await cli.run({ dbi: database, argv: ['record', `--file=${file}`, '--execute'], log: () => {} });
    expect(done.run).toMatchObject({ status: 'passed', case_count: 10 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a few-shot leak or verifier miss is refused: a single re-draft cannot reproduce it', async () => {
    for (const surface of ['few_shot_leak', 'verifier_miss']) {
      await database('ai_fix_proposals').where({ id: proposal.id }).update({ surface });
      await expect(replay.exportCases({ dbi: database, proposalId: proposal.id, split: 'dev' })).rejects.toMatchObject({ code: 'unsupported_surface' });
    }
  });

  test('an empty split exports nothing and writes no files', async () => {
    await database('ai_fix_proposals').where({ id: proposal.id }).update({ holdout_incident_keys: JSON.stringify([]) });
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-')), 'out');
    await expect(cli.run({ dbi: database, argv: ['export', `--proposal=${proposal.id}`, '--split=holdout', `--out=${dir}`], log: () => {}, drafter: {} }))
      .rejects.toMatchObject({ exitCode: 1 });
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('the brief reads incidents, proposals, runs and recurrence without message text', async () => {
    await record();
    const r = await report.buildReport({ dbi: database, now: new Date('2026-10-05T12:00:00Z'), days: 30, liveVersion: V12 });
    expect(r.week).toEqual([{ disposition: 'confirmed_mistake', cell: `${CELL.surface}/${CELL.failure_mode}`, n: 12 }]);
    expect(r.proposals[0]).toMatchObject({ status: 'pending', incidents: 12, dev: 10, holdout: 2, devRun: expect.objectContaining({ status: 'passed' }) });
    // 12 drafts is under the 20-draft floor: the rate is printed but labelled inconclusive.
    expect(r.versions).toEqual([expect.objectContaining({ version: V12, drafts: 12, judgedShare: '100%', verdict: expect.stringMatching(/^inconclusive/) })]);
    expect(r.versions[0].cells).toEqual([{ cell: `${CELL.surface}/${CELL.failure_mode}`, confirmed: 12, per100: 100 }]);
    const text = report.formatReport(r);
    expect(text).toContain('never the exact production model');
    expect(text).not.toMatch(/when are you coming|Wednesday|summary-/);
  });

  test('down drops both tables and up restores them', async () => {
    await migration.down(database);
    expect(await database.schema.hasTable('ai_replay_runs')).toBe(false);
    await migration.up(database);
    expect(await database.schema.hasTable('ai_replay_results')).toBe(true);
  });
});
