/**
 * "How did you hear about us?" on the online quote wizard (owner-approved
 * 2026-10-30, "count customers from AI"). The shared sanitizer module is the
 * single allowlist for the web form (lead-webhook.js) and the wizard
 * (public-property-lookup.js intake + public-quote.js /calculate); the wizard
 * stores the answer on insert and fills it on an update only while empty.
 *
 * Real-PostgreSQL case is skipped without DATABASE_URL, like the other
 * *-postgres suites (it runs in CI).
 */
const fs = require('fs');
const path = require('path');
const {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_PROMPT_MAX,
  sanitizeHeardAbout,
  sanitizeHeardAboutPrompt,
  heardAboutFromBody,
  heardAboutFillIfEmpty,
} = require('../services/heard-about');

describe('shared heard-about module', () => {
  test('the allowlist is the ten Astro select ids', () => {
    expect([...HEARD_ABOUT_OPTIONS].sort()).toEqual([
      'chatgpt', 'facebook_instagram', 'friend_neighbor', 'google_maps', 'google_search',
      'nextdoor', 'other', 'other_ai', 'truck_yard_sign', 'yelp',
    ]);
  });

  test('lead-webhook uses the very same functions (no behavior change)', () => {
    const { _test } = require('../routes/lead-webhook');
    expect(_test.sanitizeHeardAbout).toBe(sanitizeHeardAbout);
    expect(_test.sanitizeHeardAboutPrompt).toBe(sanitizeHeardAboutPrompt);
  });

  test('sanitizeHeardAbout trims, lowercases and drops unknown values', () => {
    expect(sanitizeHeardAbout(' ChatGPT ')).toBe('chatgpt');
    expect(sanitizeHeardAbout('tiktok')).toBeNull();
    expect(sanitizeHeardAbout('a friend told me')).toBeNull();
    expect(sanitizeHeardAbout(undefined)).toBeNull();
    expect(sanitizeHeardAbout({ toString: () => 'yelp' })).toBe('yelp');
  });

  test('sanitizeHeardAboutPrompt keeps the prompt only for AI answers, one line, capped', () => {
    expect(sanitizeHeardAboutPrompt('best  pest\ncontrol', 'chatgpt')).toBe('best pest control');
    expect(sanitizeHeardAboutPrompt('best pest control', 'other_ai')).toBe('best pest control');
    expect(sanitizeHeardAboutPrompt('best pest control', 'google_search')).toBeNull();
    expect(sanitizeHeardAboutPrompt('best pest control', null)).toBeNull();
    expect(sanitizeHeardAboutPrompt(42, 'chatgpt')).toBeNull();
    expect(sanitizeHeardAboutPrompt('   ', 'chatgpt')).toBeNull();
    expect(sanitizeHeardAboutPrompt('x'.repeat(900), 'chatgpt')).toHaveLength(HEARD_ABOUT_PROMPT_MAX);
  });

  test('heardAboutFromBody resolves the prompt against the SANITIZED answer', () => {
    expect(heardAboutFromBody({ heard_about: 'ChatGPT', heard_about_prompt: ' ants in Parrish ' }))
      .toEqual({ heardAbout: 'chatgpt', heardAboutPrompt: 'ants in Parrish' });
    // unknown answer: both dropped, even though the prompt looks fine
    expect(heardAboutFromBody({ heard_about: 'tiktok', heard_about_prompt: 'ants' }))
      .toEqual({ heardAbout: null, heardAboutPrompt: null });
    // non-AI answer: answer kept, prompt dropped
    expect(heardAboutFromBody({ heard_about: 'nextdoor', heard_about_prompt: 'ants' }))
      .toEqual({ heardAbout: 'nextdoor', heardAboutPrompt: null });
    // skipped question / missing or odd bodies never throw
    expect(heardAboutFromBody({})).toEqual({ heardAbout: null, heardAboutPrompt: null });
    expect(heardAboutFromBody(undefined)).toEqual({ heardAbout: null, heardAboutPrompt: null });
    expect(heardAboutFromBody(null)).toEqual({ heardAbout: null, heardAboutPrompt: null });
    expect(heardAboutFromBody('chatgpt')).toEqual({ heardAbout: null, heardAboutPrompt: null });
  });

  test('heardAboutFillIfEmpty writes nothing when there is no answer', () => {
    const fakeDb = { raw: jest.fn() };
    expect(heardAboutFillIfEmpty(fakeDb, { heardAbout: null, heardAboutPrompt: null })).toEqual({});
    expect(heardAboutFillIfEmpty(fakeDb)).toEqual({});
    expect(fakeDb.raw).not.toHaveBeenCalled();
  });

  test('heardAboutFillIfEmpty builds an old-value-conditional update for both columns', () => {
    const fakeDb = { raw: jest.fn((sql, bindings) => ({ sql, bindings })) };
    const out = heardAboutFillIfEmpty(fakeDb, { heardAbout: 'chatgpt', heardAboutPrompt: 'ants' });
    expect(Object.keys(out).sort()).toEqual(['heard_about', 'heard_about_prompt']);
    expect(out.heard_about.sql).toMatch(/WHEN COALESCE\(heard_about, ''\) = '' THEN \?::text ELSE heard_about END/);
    expect(out.heard_about.bindings).toEqual(['chatgpt']);
    expect(out.heard_about_prompt.sql).toMatch(/WHEN COALESCE\(heard_about, ''\) = '' THEN \?::text ELSE heard_about_prompt END/);
    expect(out.heard_about_prompt.bindings).toEqual(['ants']);
    expect(heardAboutFillIfEmpty(fakeDb, { heardAbout: 'yelp', heardAboutPrompt: null }).heard_about_prompt.bindings).toEqual([null]);
  });
});

describe('wizard routes wire the answer into the lead writes (source pins)', () => {
  const quote = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
  const lookup = fs.readFileSync(path.join(__dirname, '../routes/public-property-lookup.js'), 'utf8');

  test('/calculate: reads the body once, stores on insert, fills-if-empty on the token update', () => {
    expect(quote).toMatch(/const wizardHeardAbout = heardAboutFromBody\(req\.body\);/);
    expect(quote).toMatch(/Object\.assign\(updateFields, heardAboutFillIfEmpty\(db, wizardHeardAbout\)\);/);
    expect(quote).toMatch(/heard_about: wizardHeardAbout\.heardAbout,\s+heard_about_prompt: wizardHeardAbout\.heardAboutPrompt,/);
  });

  test('property-lookup intake: stores on insert, fills-if-empty on the prefill attach', () => {
    expect(lookup).toMatch(/const wizardHeardAbout = heardAboutFromBody\(req\.body\);/);
    expect(lookup).toMatch(/\.\.\.heardAboutFillIfEmpty\(db, wizardHeardAbout\),/);
    expect(lookup).toMatch(/heard_about: wizardHeardAbout\.heardAbout,\s+heard_about_prompt: wizardHeardAbout\.heardAboutPrompt,/);
  });
});

const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

(SKIP ? describe.skip : describe)('heardAboutFillIfEmpty against real PostgreSQL', () => {
  const schema = `heard_about_${randomUUID().replaceAll('-', '')}`;
  let database;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.leads (id serial PRIMARY KEY, first_name text, heard_about varchar(40), heard_about_prompt varchar(500))', [schema]);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });
  beforeEach(() => database('leads').del());

  const seed = async (over = {}) => (await database('leads').insert({ first_name: 'Pat', ...over }).returning('*'))[0];
  const apply = (id, heard) => database('leads').where({ id }).update({ first_name: 'Pat Two', ...heardAboutFillIfEmpty(database, heard) }).returning('*');

  test('an empty row takes the answer and its prompt', async () => {
    const row = await seed();
    const [out] = await apply(row.id, { heardAbout: 'chatgpt', heardAboutPrompt: 'best pest control' });
    expect(out).toMatchObject({ first_name: 'Pat Two', heard_about: 'chatgpt', heard_about_prompt: 'best pest control' });
  });

  test('an empty-string answer counts as empty', async () => {
    const row = await seed({ heard_about: '' });
    const [out] = await apply(row.id, { heardAbout: 'yelp', heardAboutPrompt: null });
    expect(out).toMatchObject({ heard_about: 'yelp', heard_about_prompt: null });
  });

  test('a recorded answer and its prompt are never overwritten', async () => {
    const row = await seed({ heard_about: 'nextdoor' });
    const [out] = await apply(row.id, { heardAbout: 'chatgpt', heardAboutPrompt: 'ants' });
    expect(out).toMatchObject({ first_name: 'Pat Two', heard_about: 'nextdoor', heard_about_prompt: null });
    const kept = await seed({ heard_about: 'other_ai', heard_about_prompt: 'first prompt' });
    const [out2] = await apply(kept.id, { heardAbout: 'chatgpt', heardAboutPrompt: 'second prompt' });
    expect(out2).toMatchObject({ heard_about: 'other_ai', heard_about_prompt: 'first prompt' });
  });

  test('no answer leaves both columns alone', async () => {
    const row = await seed({ heard_about: 'yelp' });
    const [out] = await apply(row.id, { heardAbout: null, heardAboutPrompt: null });
    expect(out).toMatchObject({ first_name: 'Pat Two', heard_about: 'yelp' });
  });
});
