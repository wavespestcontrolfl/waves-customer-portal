/**
 * 20260929230000 — seo_citations status vocabulary. The DB-backed case runs the
 * ORIGINAL create-table migration, inserts rows in every old status, runs the
 * new migration and checks the value mapping (needs DATABASE_URL; skipped
 * locally without one, runs in CI). The fake-knex cases always run.
 */
const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20260929230000_seo_citations_audit_states');
const createTable = require('../models/migrations/20260401000045_seo_citations');
const { _internals } = require('../services/seo/citation-auditor');
const { WAVES_LOCATIONS } = require('../config/locations');

const src = fs.readFileSync(path.join(__dirname, '../models/migrations/20260929230000_seo_citations_audit_states.js'), 'utf8');

function fakeKnex() {
  const raws = [];
  return { raws, raw: async (sql) => { raws.push(String(sql)); return {}; } };
}

describe('migration shape', () => {
  test('the CHECK set is exactly the auditor state vocabulary', () => {
    const m = src.match(/^const STATES = (\[[^\n]*\]);/m);
    expect(JSON.parse(m[1].replace(/'/g, '"'))).toEqual(_internals.STATES);
  });

  test('the backfilled location ids are real config/locations.js ids', () => {
    const ids = [...src.matchAll(/SET location_id = '([a-z-]+)'/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(WAVES_LOCATIONS.map((l) => l.id).sort());
  });

  test('up() remaps rows before the CHECK is added; down() removes it first', async () => {
    const up = fakeKnex();
    await migration.up(up);
    const iCheck = up.raws.findIndex((r) => /ADD CONSTRAINT seo_citations_status_check/.test(r));
    const iMap = up.raws.findIndex((r) => /SET status = 'mismatched'/.test(r));
    expect(iMap).toBeGreaterThan(-1);
    expect(iMap).toBeLessThan(iCheck);
    const down = fakeKnex();
    await migration.down(down);
    expect(down.raws[0]).toMatch(/DROP CONSTRAINT IF EXISTS seo_citations_status_check/);
  });

  test('requires no service module', () => {
    expect(src).not.toMatch(/require\(/);
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('value mapping on a real table', () => {
  const knexLib = require('knex');
  const schema = `cit_mig_${process.pid}`;
  let knex;
  beforeAll(async () => {
    const root = knexLib({ client: 'pg', connection: process.env.DATABASE_URL });
    await root.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await root.destroy();
    knex = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 1, max: 1 } });
    await createTable.up(knex);
  });
  afterAll(async () => {
    if (!knex) return;
    await knex.raw(`DROP SCHEMA ${schema} CASCADE`);
    await knex.destroy();
  });

  test('old values map, GBP rows get their office, CHECK enforces the new set, down() restores', async () => {
    const old = ['unchecked', 'inconsistent', 'active', 'claimed', 'missing', 'something-else'];
    for (const status of old) await knex('seo_citations').insert({ directory_name: `dir-${status}`, status, nap_consistent: status === 'active' });
    await knex('seo_citations').insert([
      { directory_name: 'Google Business Profile — LWR' }, { directory_name: 'Google Business Profile — Parrish' },
      { directory_name: 'Google Business Profile — Sarasota' }, { directory_name: 'Google Business Profile — Venice' },
    ]);
    await migration.up(knex);
    const status = async (name) => (await knex('seo_citations').where({ directory_name: name }).first()).status;
    expect(await status('dir-unchecked')).toBe('unverified');
    expect(await status('dir-inconsistent')).toBe('mismatched');
    expect(await status('dir-active')).toBe('unverified');
    expect(await status('dir-claimed')).toBe('unverified');
    expect(await status('dir-missing')).toBe('missing');
    expect(await status('dir-something-else')).toBe('unverified');
    const loc = async (name) => (await knex('seo_citations').where({ directory_name: name }).first()).location_id;
    expect(await loc('Google Business Profile — LWR')).toBe('bradenton');
    expect(await loc('Google Business Profile — Venice')).toBe('venice');
    expect(await loc('dir-unchecked')).toBeNull();
    expect((await knex('seo_citations').where({ directory_name: 'Google Business Profile — Parrish' }).first()).status).toBe('unverified');
    await expect(knex('seo_citations').insert({ directory_name: 'x', status: 'active' })).rejects.toThrow(/seo_citations_status_check/);
    await knex('seo_citations').insert({ directory_name: 'ok', status: 'fetch-blocked', status_detail: JSON.stringify({ reason: 'http_403' }) });

    await migration.down(knex);
    expect(await status('dir-inconsistent')).toBe('inconsistent');
    expect(await status('ok')).toBe('unchecked');
    await knex('seo_citations').insert({ directory_name: 'old-style', status: 'active' });
  });
});
