const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL (skips without DATABASE_URL). The tables live in a unique schema with
// minimal ad_campaigns / ad_search_terms / audit_log, dropped after the suite. It covers the PR 2 migrations (new table,
// new columns, up / down / up; the audited starter words with a no-op down) and the parts mocks cannot prove: the row lock on a decision, the per-word advisory lock on a
// sync, the daily bell cap by Eastern date, and the unique key an advisor insert runs into. Google and the bell are stubs.
const knex = require('knex');
const { randomUUID } = require('crypto');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ adsNegativesLive: jest.fn(() => true) }));
let mockPg;
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  return db;
});
jest.mock('../services/ads/google-ads', () => ({
  addCampaignNegativeKeyword: jest.fn(), removeCampaignNegativeKeyword: jest.fn(), convertingSearchTerms: jest.fn(),
}));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'n-1' })),
}));

const google = require('../services/ads/google-ads');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const gates = require('../config/feature-gates');
const frozen = require('../models/migrations/20261102110000_ad_negative_keywords');
const migration = require('../models/migrations/20261102120000_ad_negative_words');
const starter = require('../models/migrations/20261102120100_ad_negative_words_starter');
const actions = require('../services/ads/negative-keyword-actions');

jest.setTimeout(60000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(SKIP ? describe.skip : describe)('negative words migration and row locks on PostgreSQL', () => {
  let database;
  const schema = `ad_neg_words_${randomUUID().replaceAll('-', '')}`;
  let c1;
  let seq;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 8 } });
    mockPg = database;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`CREATE TABLE ??.ad_campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_name text, platform text, platform_campaign_id text, status text)`, [schema]);
    await database.raw(`CREATE TABLE ??.ad_search_terms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid, search_term text, clicks int, cost numeric, conversions numeric)`, [schema]);
    await database.raw(`CREATE TABLE ??.audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type varchar(32), actor_id uuid, action varchar(96),
      resource_type text, resource_id text, metadata jsonb, ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now())`, [schema]);
    await frozen.up(database);
    await migration.up(database);
    await starter.up(database);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    gates.adsNegativesLive.mockReturnValue(true);
    seq = 0;
    await database('ad_negative_keywords').del();
    await database('ad_search_terms').del();
    await database('ad_campaigns').del();
    await database('ad_negative_words').del();
    [{ id: c1 }] = await database('ad_campaigns').insert([
      { campaign_name: 'Synthetic Search One', platform: 'google_ads', platform_campaign_id: '9000000001', status: 'active' },
      { campaign_name: 'Synthetic Search Two', platform: 'google_ads', platform_campaign_id: '9000000002', status: 'active' },
    ]).returning('id');
    google.convertingSearchTerms.mockResolvedValue([]);
    google.addCampaignNegativeKeyword.mockImplementation(async () => { seq += 1; await sleep(60); return { success: true, resourceName: `customers/1/campaignCriteria/${seq}~1` }; });
    google.removeCampaignNegativeKeyword.mockImplementation(async (resourceName) => ({ success: true, resourceName }));
  });

  const advisorWord = (text, extra = {}) => database('ad_negative_keywords').insert({
    campaign_id: c1, text, source: 'advisor', state: 'pending', ...extra,
  }).returning('*').then(([r]) => r);

  describe('the migration', () => {
    const STARTER_ACTION = 'migration:20261102120100_ad_negative_words_starter:insert';

    test('the starter list is the approved 16 words, added by starter-list, and not free / diy / how to', async () => {
      await database('ad_negative_words').del();
      await database('audit_log').del();
      await starter.up(database);
      const rows = await database('ad_negative_words').orderBy('text');
      expect(rows.map((r) => r.text)).toEqual([...starter.STARTER_WORDS].sort());
      expect(rows).toHaveLength(16);
      expect(rows.every((r) => r.added_by === 'starter-list' && r.match_type === 'phrase' && r.removed_at === null)).toBe(true);
      for (const word of ['free', 'diy', 'how to']) expect(rows.map((r) => r.text)).not.toContain(word);
    });

    test('the seed writes one audit row per word it adds, and none for a word already on the list', async () => {
      await database('ad_negative_words').del();
      await database('audit_log').del();
      await database('ad_negative_words').insert({ text: 'jobs', added_by: 'someone', removed_at: new Date() });
      await starter.up(database);
      const audits = await database('audit_log').where({ action: STARTER_ACTION });
      expect(audits).toHaveLength(15);
      const words = await database('ad_negative_words').whereNot({ text: 'jobs' }).select('id', 'text');
      expect(audits.map((a) => a.resource_id).sort()).toEqual(words.map((w) => String(w.id)).sort());
      expect(audits.every((a) => a.actor_type === 'system' && a.resource_type === 'ad_negative_words')).toBe(true);
      expect(audits.find((a) => a.resource_id === String(words[0].id)).metadata).toMatchObject({
        migration: '20261102120100_ad_negative_words_starter', text: words[0].text, before: null,
      });
      // The owner's own state for a word wins: still removed, still his.
      const jobs = await database('ad_negative_words').where({ text: 'jobs' }).first();
      expect(jobs).toMatchObject({ added_by: 'someone' });
      expect(jobs.removed_at).not.toBeNull();
    });

    test('the seed is safe to run twice and its down changes nothing', async () => {
      await database('ad_negative_words').del();
      await database('audit_log').del();
      await starter.up(database);
      await starter.up(database);
      expect(await database('ad_negative_words').count({ n: '*' }).then(([r]) => Number(r.n))).toBe(16);
      expect(await database('audit_log').where({ action: STARTER_ACTION }).count({ n: '*' }).then(([r]) => Number(r.n))).toBe(16);
      await starter.down(database);
      expect(await database('ad_negative_words').count({ n: '*' }).then(([r]) => Number(r.n))).toBe(16);
    });

    test('a row gets its defaults and the text is unique', async () => {
      const [row] = await database('ad_negative_words').insert({ text: 'zzz test word' }).returning('*');
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row).toMatchObject({ match_type: 'phrase', added_by: null, removed_by: null, removed_at: null });
      expect(row.created_at).toBeInstanceOf(Date);
      await expect(database('ad_negative_words').insert({ text: 'zzz test word' })).rejects.toMatchObject({ code: '23505' });
      await expect(database('ad_negative_words').insert({ text: 'a'.repeat(81) })).rejects.toMatchObject({ code: '22001' });
    });

    test('ad_negative_keywords gains notified_at and last_error', async () => {
      const row = await advisorWord('squirrel');
      expect(row.notified_at).toBeNull();
      expect(row.last_error).toBeNull();
      const [after] = await database('ad_negative_keywords').where({ id: row.id }).update({ notified_at: new Date(), last_error: 'x' }).returning('*');
      expect(after.notified_at).toBeInstanceOf(Date);
      expect(after.last_error).toBe('x');
    });

    test('the schema up is safe to run twice, keeps the list rows, and down drops the table and the two columns', async () => {
      await starter.up(database); // the starter list was cleared by beforeEach: seeds it again
      await database('ad_negative_words').where({ text: 'jobs' }).update({ removed_at: new Date() });
      await migration.up(database);
      expect((await database('ad_negative_words').where({ text: 'jobs' }).first()).removed_at).not.toBeNull();
      await migration.down(database);
      expect(await database.schema.hasTable('ad_negative_words')).toBe(false);
      expect(await database.schema.hasColumn('ad_negative_keywords', 'notified_at')).toBe(false);
      expect(await database.schema.hasColumn('ad_negative_keywords', 'last_error')).toBe(false);
      expect(await database.schema.hasTable('ad_negative_keywords')).toBe(true);
      await migration.down(database); // down twice is safe too
      await migration.up(database);
      expect(await database.schema.hasTable('ad_negative_words')).toBe(true);
      expect(await database.schema.hasColumn('ad_negative_keywords', 'notified_at')).toBe(true);
    });
  });

  describe('row locks', () => {
    test('two Adds at once on one word: one writes to Google, the other is told it was decided', async () => {
      const row = await advisorWord('squirrel');
      const [a, b] = await Promise.all([
        actions.decideSuggestion(row.id, 'add', { by: 'a' }),
        actions.decideSuggestion(row.id, 'add', { by: 'b' }),
      ]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect([a, b].find((r) => !r.ok).code).toBe('decided');
      expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(1);
      expect(await database('ad_negative_keywords').where({ id: row.id }).first()).toMatchObject({ state: 'active' });
    });

    test('Add and Decline at once: exactly one wins and the final state matches the winner', async () => {
      const row = await advisorWord('squirrel');
      const [add, decline] = await Promise.all([actions.decideSuggestion(row.id, 'add'), actions.decideSuggestion(row.id, 'decline')]);
      expect([add.ok, decline.ok].filter(Boolean)).toHaveLength(1);
      const state = (await database('ad_negative_keywords').where({ id: row.id }).first()).state;
      expect(state).toBe(add.ok ? 'active' : 'declined');
      expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(add.ok ? 1 : 0);
    });

    test('Undo and a second Undo at once: one Google remove', async () => {
      const row = await advisorWord('squirrel', { state: 'active', google_resource_name: 'customers/1/campaignCriteria/1~1' });
      google.removeCampaignNegativeKeyword.mockImplementation(async (n) => { await sleep(60); return { success: true, resourceName: n }; });
      const [a, b] = await Promise.all([actions.undoNegative(row.id), actions.undoNegative(row.id)]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect(google.removeCampaignNegativeKeyword).toHaveBeenCalledTimes(1);
    });

    test('a failed Google write rolls nothing forward: the row stays pending with last_error', async () => {
      const row = await advisorWord('squirrel');
      google.addCampaignNegativeKeyword.mockResolvedValue(null);
      expect(await actions.decideSuggestion(row.id, 'add')).toMatchObject({ ok: false, code: 'google_error' });
      expect(await database('ad_negative_keywords').where({ id: row.id }).first()).toMatchObject({ state: 'pending', google_resource_name: null, last_error: expect.stringContaining('Google') });
    });

    test('two syncs at once of the same word push each campaign once (the word\'s advisory lock)', async () => {
      await database('ad_negative_words').insert({ text: 'zzz sync word' });
      await Promise.all([actions.syncOwnerWords({ texts: ['zzz sync word'] }), actions.syncOwnerWords({ texts: ['zzz sync word'] })]);
      expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(2);
      const rows = await database('ad_negative_keywords').where({ text: 'zzz sync word' });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.state === 'active' && r.source === 'owner_list' && r.google_resource_name)).toBe(true);
    });

    test('a save and the 6 AM run at once for one word push it once', async () => {
      const [saved] = await Promise.all([actions.addOwnerWord('zzz both words'), actions.syncOwnerWords()]);
      expect(saved.ok).toBe(true);
      const rows = await database('ad_negative_keywords').where({ text: 'zzz both words' });
      expect(rows).toHaveLength(2);
      expect(google.addCampaignNegativeKeyword.mock.calls.filter((c) => c[1] === 'zzz both words')).toHaveLength(2);
    });

    test('adding the same word twice at once makes one list row', async () => {
      await Promise.all([actions.addOwnerWord('zzz twice', { by: 'a' }), actions.addOwnerWord('zzz twice', { by: 'b' })]);
      expect(await database('ad_negative_words').where({ text: 'zzz twice' })).toHaveLength(1);
      expect(await database('ad_negative_keywords').where({ text: 'zzz twice' })).toHaveLength(2);
    });

    test('removing a word while its sync runs ends with the word removed everywhere', async () => {
      const [{ id }] = await database('ad_negative_words').insert({ text: 'zzz racing' }).returning('id');
      await Promise.all([actions.syncOwnerWords({ texts: ['zzz racing'] }), sleep(20).then(() => actions.removeOwnerWord(id))]);
      await actions.syncOwnerWords({ texts: ['zzz racing'] });
      const rows = await database('ad_negative_keywords').where({ text: 'zzz racing' });
      expect(rows.every((r) => r.state === 'removed')).toBe(true);
      expect((await database('ad_negative_words').where({ id }).first()).removed_at).not.toBeNull();
    });

    test('the owner\'s list takes over a declined advisor row on the same campaign (one row per campaign, word and match type)', async () => {
      const row = await advisorWord('zzz taken over', { state: 'declined' });
      await actions.addOwnerWord('zzz taken over');
      const rows = await database('ad_negative_keywords').where({ text: 'zzz taken over' });
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === row.id)).toMatchObject({ source: 'owner_list', state: 'active' });
    });

    test('an advisor insert for a word already on file is ignored by the unique key', async () => {
      await advisorWord('squirrel', { state: 'declined' });
      const out = await actions.queueAdvisorNegatives({ recommendations: [{ apply_action: 'add_negative', apply_value: 'squirrel', campaign_id: c1, reasoning: 'r' }] });
      expect(out.queued).toBe(0);
      expect(await database('ad_negative_keywords').where({ text: 'squirrel' })).toHaveLength(1);
    });
  });

  describe('the daily bell cap by Eastern date', () => {
    beforeEach(async () => {
      for (let n = 1; n <= 5; n += 1) await advisorWord(`zzz bell ${n}`, { created_at: new Date(Date.UTC(2026, 10, 1, 12, n)) });
    });
    const rung = () => database('ad_negative_keywords').whereNotNull('notified_at').orderBy('created_at').pluck('text');

    test('3 on the first day, the leftovers on the next, oldest first', async () => {
      expect(await actions.ringNegativeBells({ now: new Date('2026-11-03T12:30:00Z') })).toBe(3);
      expect(await rung()).toEqual(['zzz bell 1', 'zzz bell 2', 'zzz bell 3']);
      expect(await actions.ringNegativeBells({ now: new Date('2026-11-03T20:00:00Z') })).toBe(0);
      expect(await actions.ringNegativeBells({ now: new Date('2026-11-04T12:30:00Z') })).toBe(2);
      expect(await rung()).toHaveLength(5);
      expect(raiseAdminAlert).toHaveBeenCalledTimes(5);
    });

    test('a bell at 11:30 PM Eastern counts for that Eastern day, not the next UTC day', async () => {
      await database('ad_negative_keywords').where({ text: 'zzz bell 1' }).update({ notified_at: new Date('2026-11-04T04:30:00Z') });
      expect(await actions.ringNegativeBells({ now: new Date('2026-11-04T03:00:00Z') })).toBe(2);
    });

    test('two runs at once ring 3 in all', async () => {
      const [a, b] = await Promise.all([
        actions.ringNegativeBells({ now: new Date('2026-11-03T12:30:00Z') }),
        actions.ringNegativeBells({ now: new Date('2026-11-03T12:30:01Z') }),
      ]);
      expect(a + b).toBe(3);
      expect(await rung()).toHaveLength(3);
    });

    test('a bell that fails to raise is undone by its savepoint and rung on the next run; the others stay', async () => {
      raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
      expect(await actions.ringNegativeBells({ now: new Date('2026-11-03T12:30:00Z') })).toBe(2);
      expect(await rung()).toEqual(['zzz bell 2', 'zzz bell 3']);
      expect(await actions.ringNegativeBells({ now: new Date('2026-11-04T12:30:00Z') })).toBe(3);
    });
  });

  describe('listNegatives on real rows', () => {
    test('shapes: words with campaign states, pending oldest first, a log newest first', async () => {
      await database('ad_negative_words').insert({ text: 'zzz listed' });
      await actions.syncOwnerWords({ texts: ['zzz listed'] });
      await advisorWord('zzz waiting', { reason: 'r', metrics: JSON.stringify({ term: 't', clicks: 1, cost: 2, conversions: 0 }) });
      await advisorWord('zzz done', { state: 'active', google_resource_name: 'customers/1/campaignCriteria/9~9' });
      const out = await actions.listNegatives();
      const word = out.words.find((w) => w.text === 'zzz listed');
      expect(word.campaigns.map((c) => c.state)).toEqual(['active', 'active']);
      expect(out.pending.map((p) => p.text)).toEqual(['zzz waiting']);
      expect(out.pending[0].metrics).toEqual({ term: 't', clicks: 1, cost: 2, conversions: 0 });
      expect(out.log.find((l) => l.text === 'zzz done')).toMatchObject({ canUndo: true, state: 'active' });
      expect(out.log.filter((l) => l.text === 'zzz listed').every((l) => l.canUndo === false)).toBe(true);
    });
  });
});
