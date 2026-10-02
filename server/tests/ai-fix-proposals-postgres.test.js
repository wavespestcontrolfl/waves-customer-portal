/**
 * ai_fix_proposals on real Postgres — the proposer's watermark, version scope
 * and one-open-per-cell index, and one proposal followed pending → pr_open →
 * shipped → reverted with the stamps each step requires (correction-loop
 * scope piece 2, "done when").
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
const incidentsMigration = require('../models/migrations/20261002170000_ai_incidents');
const migration = require('../models/migrations/20261002190000_ai_fix_proposals');
const { proposeFromIncidents, transitionProposal, splitDevHoldout, STATUSES, FIX_KINDS, OPEN_STATUSES } = require('../services/ai-incidents/fix-proposals');
const link = require('../../ops/agents/fix-proposal-link');

jest.setTimeout(60000);

const V12 = 'house_voice_v12_real_answers3_cfl';
const CELL = { surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta' };

test('the service and the migration name the same statuses, fix kinds and open set', () => {
  expect(migration.STATUSES).toEqual([...STATUSES]);
  expect(migration.FIX_KINDS).toEqual([...FIX_KINDS]);
  expect(migration.OPEN_STATUSES).toEqual([...OPEN_STATUSES]);
});

(SKIP ? describe.skip : describe)('ai_fix_proposals on PostgreSQL', () => {
  const schema = `ai_fix_proposals_${randomUUID().replaceAll('-', '')}`;
  let database;

  const incident = (over = {}) => ({
    area: 'sms', evidence_type: 'judgment', evidence_id: randomUUID(), incident_key: randomUUID(),
    disposition: 'confirmed_mistake', ...CELL, prompt_version: V12,
    summary: 'Gave an arrival time the facts did not carry.', adjudicated_at: new Date('2026-10-03T08:30:00Z'), ...over,
  });
  const seed = async (n, over = {}) => {
    const rows = Array.from({ length: n }, () => incident(over));
    await database('ai_incidents').insert(rows);
    return rows;
  };

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await incidentsMigration.up(database);
    await migration.up(database);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });
  beforeEach(async () => {
    await database('ai_fix_proposals').update({ supersedes: null });
    await database('ai_fix_proposals').del();
    await database('ai_incidents').del();
  });

  const propose = (over = {}) => proposeFromIncidents({ dbi: database, area: 'sms', promptVersion: V12, minEvidence: 5, now: new Date('2026-10-04T08:45:00Z'), ...over });

  test('a cell at the threshold of DISTINCT confirmed incidents gets one pending proposal with a fixed split', async () => {
    const rows = await seed(5);
    // A second evidence row about one of those incidents is a duplicate, and a lead never counts.
    await database('ai_incidents').insert(incident({ incident_key: rows[0].incident_key, disposition: 'duplicate' }));
    await seed(3, { disposition: 'lead' });

    expect(await propose()).toMatchObject({ proposed: 1, eligibleCells: 1 });
    const [p] = await database('ai_fix_proposals');
    expect(p).toMatchObject({ area: 'sms', ...CELL, fix_kind: 'facts', prompt_version: V12, status: 'pending', evidence_count: 5, supersedes: null });
    expect([...p.incident_keys].sort()).toEqual(rows.map((r) => r.incident_key).sort());
    expect([...p.dev_incident_keys, ...p.holdout_incident_keys].sort()).toEqual([...p.incident_keys].sort());
    expect(splitDevHoldout('sms', p.incident_keys)).toEqual({ dev: p.dev_incident_keys, holdout: p.holdout_incident_keys });
    expect(p.history).toEqual([expect.objectContaining({ by: 'auto:proposer', from: null, to: 'pending' })]);
    expect(p.proposal).not.toMatch(/\$\d/);
  });

  test('the proposal describes dev incidents only; a held-out incident is counted, never summarized', async () => {
    const rows = await seed(12);
    rows.forEach((r, i) => { r.summary = `incident number ${i}`; });
    await database('ai_incidents').del();
    await database('ai_incidents').insert(rows);
    await propose();
    const p = await database('ai_fix_proposals').first();
    expect(p.holdout_incident_keys.length).toBeGreaterThan(0);
    const summaryOf = new Map(rows.map((r) => [r.incident_key, r.summary]));
    for (const key of p.holdout_incident_keys) expect(p.proposal).not.toContain(`${summaryOf.get(key)}\n`);
    for (const key of p.holdout_incident_keys) expect(p.proposal).not.toContain(String(key).slice(0, 8));
    for (const key of p.dev_incident_keys.slice(0, 10)) expect(p.proposal).toContain(summaryOf.get(key));
    expect(p.proposal).toContain(`${p.holdout_incident_keys.length} held out`);
  });

  test('cells with a fix in progress never take the weekly slots from a ready cell', async () => {
    const busy = ['invented_billing', 'invented_commitment'];
    for (const mode of busy) {
      await seed(5, { failure_mode: mode });
      await propose({ maxCells: 3 });
    }
    for (const p of await database('ai_fix_proposals')) {
      await transitionProposal({ dbi: database, id: p.id, to: 'pr_open', fields: { pr_number: 1 }, by: 'test' });
    }
    // The busy cells have MORE fresh evidence than the ready one.
    for (const mode of busy) await seed(9, { failure_mode: mode, adjudicated_at: new Date('2026-10-10T08:30:00Z') });
    await seed(5, { adjudicated_at: new Date('2026-10-10T08:30:00Z') });
    const out = await propose({ maxCells: 1, now: new Date('2026-10-11T08:45:00Z') });
    expect(out).toMatchObject({ proposed: 1, skippedOpen: 2 });
    expect(await database('ai_fix_proposals').where({ status: 'pending' }).select('failure_mode')).toEqual([{ failure_mode: CELL.failure_mode }]);
  });

  test('below the threshold, on another version, or after the watermark nothing is proposed', async () => {
    await seed(4);
    await seed(5, { prompt_version: 'house_voice_v11' });
    expect(await propose()).toMatchObject({ proposed: 0 });

    await seed(1);
    expect(await propose()).toMatchObject({ proposed: 1 });
    // The same evidence a second week: the watermark has moved past it.
    expect(await propose({ now: new Date('2026-10-11T08:45:00Z') })).toMatchObject({ proposed: 0, eligibleCells: 0 });
    // An incident adjudicated after the run's cutoff waits for the next window.
    await seed(5, { adjudicated_at: new Date('2026-10-05T08:30:00Z') });
    expect(await propose()).toMatchObject({ proposed: 0 });
  });

  test('fresh evidence on a pending proposal supersedes it and carries its incidents; a fix in progress is left alone', async () => {
    const first = await seed(5);
    await propose();
    const fresh = await seed(5, { adjudicated_at: new Date('2026-10-10T08:30:00Z') });
    expect(await propose({ now: new Date('2026-10-11T08:45:00Z') })).toMatchObject({ proposed: 1 });

    const rows = await database('ai_fix_proposals').orderBy('created_at');
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'pending']);
    expect(rows[1].supersedes).toBe(rows[0].id);
    expect(rows[1].evidence_count).toBe(10);
    expect([...rows[1].incident_keys].sort()).toEqual([...first, ...fresh].map((r) => r.incident_key).sort());

    await transitionProposal({ dbi: database, id: rows[1].id, to: 'pr_open', fields: { pr_number: 5601 }, by: 'test' });
    await seed(5, { adjudicated_at: new Date('2026-10-17T08:30:00Z') });
    expect(await propose({ now: new Date('2026-10-18T08:45:00Z') })).toMatchObject({ proposed: 0, skippedOpen: 1 });
    expect(await database('ai_fix_proposals').count('* as n').first()).toEqual({ n: '2' });
  });

  test('a pending proposal from an older version is closed, never counted forward', async () => {
    await seed(5, { prompt_version: 'house_voice_v11' });
    await propose({ promptVersion: 'house_voice_v11' });
    await seed(5);
    await propose();
    const rows = await database('ai_fix_proposals').orderBy('created_at');
    expect(rows.map((r) => [r.prompt_version, r.status])).toEqual([['house_voice_v11', 'superseded'], [V12, 'pending']]);
    expect(rows[1].evidence_count).toBe(5);
  });

  test('one proposal followed pending → pr_open → shipped → reverted', async () => {
    await seed(5);
    await propose();
    const { id } = await database('ai_fix_proposals').first();
    const step = (to, fields = {}) => transitionProposal({ dbi: database, id, to, fields, by: 'lane:test' });

    await expect(step('shipped', { pr_number: 5601, reviewed_commit: 'abc1234', shipped_version: 'v13' })).rejects.toMatchObject({ code: 'illegal_transition' });
    await expect(step('pr_open')).rejects.toMatchObject({ code: 'missing_stamp' });
    await step('pr_open', { pr_number: 5601, pr_url: 'https://github.com/example/repo/pull/5601' });
    await step(undefined, { dev_run_id: randomUUID(), holdout_run_id: randomUUID() });
    await expect(step('shipped', { shipped_version: 'v13' })).rejects.toMatchObject({ code: 'missing_stamp' });
    const shipped = await step('shipped', { reviewed_commit: 'e25e9cfabc', shipped_version: 'house_voice_v13' });
    expect(shipped).toMatchObject({ status: 'shipped', pr_number: 5601, reviewed_commit: 'e25e9cfabc', shipped_version: 'house_voice_v13' });
    expect(shipped.shipped_at).toBeInstanceOf(Date);
    await expect(step('reverted')).rejects.toMatchObject({ code: 'missing_stamp' });
    const reverted = await step('reverted', { revert_pr_number: 5620 });
    expect(reverted.reverted_at).toBeInstanceOf(Date);
    expect(reverted.history.map((h) => `${h.from}->${h.to}`)).toEqual(['null->pending', 'pending->pr_open', 'pr_open->pr_open', 'pr_open->shipped', 'shipped->reverted']);
    await expect(step('pending')).rejects.toMatchObject({ code: 'illegal_transition' });
    await expect(step('shipped')).rejects.toMatchObject({ code: 'illegal_transition' });
  });

  test('a closed or replaced PR takes its review and replay evidence with it', async () => {
    await seed(5);
    await propose();
    const { id } = await database('ai_fix_proposals').first();
    const step = (to, fields = {}) => transitionProposal({ dbi: database, id, to, fields, by: 'lane:test' });
    const evidence = { reviewed_commit: 'abc1234', dev_run_id: randomUUID(), holdout_run_id: randomUUID() };

    await step('pr_open', { pr_number: 5601, pr_url: 'https://github.com/example/repo/pull/5601', ...evidence });
    // Naming a different PR clears the old one's evidence…
    const replaced = await step(undefined, { pr_number: 5602 });
    expect(replaced).toMatchObject({ pr_number: 5602, pr_url: null, reviewed_commit: null, dev_run_id: null, holdout_run_id: null });
    await expect(step('shipped', { shipped_version: 'v13' })).rejects.toMatchObject({ code: 'missing_stamp' });

    // …and closing the PR clears the PR too; the next PR starts from nothing.
    await step(undefined, evidence);
    await expect(step('accepted', { reviewed_commit: 'abc1234' })).rejects.toMatchObject({ code: 'illegal_transition' });
    const closed = await step('accepted');
    expect(closed).toMatchObject({ status: 'accepted', pr_number: null, reviewed_commit: null, dev_run_id: null, holdout_run_id: null });
    expect(closed.history.at(-1).cleared).toEqual(expect.arrayContaining(['pr_number', 'reviewed_commit']));
    await step('pr_open', { pr_number: 5610 });
    await expect(step('shipped', { shipped_version: 'v13' })).rejects.toMatchObject({ code: 'missing_stamp' });
  });

  test('dev summaries come from the proposal\'s own cell, never another cell of the same draft', async () => {
    const rows = await seed(12, { summary: 'schedule claim' });
    // Every one of those drafts is also confirmed in a billing cell.
    await database('ai_incidents').insert(rows.map((r) => incident({ incident_key: r.incident_key, failure_mode: 'invented_billing', summary: 'BILLING TEXT', adjudicated_at: new Date('2026-10-01T08:30:00Z') })));
    await propose({ maxCells: 3 });
    const schedule = await database('ai_fix_proposals').where({ failure_mode: CELL.failure_mode }).first();
    expect(schedule.proposal).toContain('schedule claim');
    expect(schedule.proposal).not.toContain('BILLING TEXT');
  });

  test('the table refuses what the service would: stamps per status, closed lists, two open fixes in one cell', async () => {
    const base = { area: 'sms', ...CELL, fix_kind: 'facts', evidence_count: 5, evidence_cutoff_at: new Date(), proposal: 'p' };
    await expect(database('ai_fix_proposals').insert({ ...base, status: 'pr_open' })).rejects.toMatchObject({ code: '23514' });
    await expect(database('ai_fix_proposals').insert({ ...base, status: 'shipped', pr_number: 1, shipped_version: 'v', shipped_at: new Date() })).rejects.toMatchObject({ code: '23514' });
    await expect(database('ai_fix_proposals').insert({ ...base, status: 'later' })).rejects.toMatchObject({ code: '23514' });
    await expect(database('ai_fix_proposals').insert({ ...base, fix_kind: 'vibes' })).rejects.toMatchObject({ code: '23514' });
    await database('ai_fix_proposals').insert(base);
    await expect(database('ai_fix_proposals').insert({ ...base, status: 'accepted' })).rejects.toMatchObject({ code: '23505' });
    await database('ai_fix_proposals').insert({ ...base, status: 'dismissed' });
    await database('ai_fix_proposals').insert({ ...base, failure_mode: 'invented_billing' });
  });

  test('the link tool dry-runs by default and writes only with --execute', async () => {
    await seed(5);
    await propose();
    const { id } = await database('ai_fix_proposals').first();
    const lines = [];
    const log = (l) => lines.push(l);
    const dry = await link.run({ dbi: database, argv: [`--id=${String(id).slice(0, 8)}`, '--status=pr_open', '--pr=5601'], log });
    expect(dry.updated).toBe(false);
    expect((await database('ai_fix_proposals').where({ id }).first()).status).toBe('pending');
    expect(lines[0]).toMatch(/^DRY RUN/);
    await link.run({ dbi: database, argv: [`--id=${id}`, '--status=pr_open', '--pr=5601', '--execute'], log });
    const row = await database('ai_fix_proposals').where({ id }).first();
    expect(row).toMatchObject({ status: 'pr_open', pr_number: 5601 });
    expect(row.history.at(-1)).toMatchObject({ by: 'lane:correction-loop', from: 'pending', to: 'pr_open' });
    await expect(link.run({ dbi: database, argv: ['--id=zzzzzzzz', '--status=dismissed'], log })).rejects.toMatchObject({ exitCode: 2 });
  });

  test('down drops the table and up restores it', async () => {
    await migration.down(database);
    expect(await database.schema.hasTable('ai_fix_proposals')).toBe(false);
    await migration.up(database);
    expect(await database.schema.hasTable('ai_fix_proposals')).toBe(true);
  });
});
