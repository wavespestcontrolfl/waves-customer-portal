/**
 * 20260928050000 — widen `source` with `ai_citation` (link-source-ai-citation
 * migration). Source-reading + fake-knex, same convention as
 * backlink-authority-policy-step4a-migration.test.js: the frozen literal
 * equals the current service enum, both source CHECKs are swapped, and
 * down() restores the step-1 set.
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260928050000_link_source_ai_citation.js');
const migration = require(MIG);
const R = require('../services/seo/link-registry');

const src = fs.readFileSync(MIG, 'utf8');
const literal = (name) => {
  const m = src.match(new RegExp(`^const ${name} = (\\[[^\\n]*\\]);`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};

function fakeKnex() {
  const raws = [];
  const knex = Object.assign(jest.fn(), {
    raw: jest.fn(async (sql) => { raws.push(String(sql)); return {}; }),
  });
  knex._raws = raws;
  return knex;
}

describe('frozen enum literal == services/seo/link-registry.js', () => {
  test('LINK_SOURCES (the full current set, ai_citation last)', () => {
    expect(literal('LINK_SOURCES')).toEqual([...R.LINK_SOURCES]);
    expect(literal('LINK_SOURCES').slice(-1)).toEqual(['ai_citation']);
  });
  test('LINK_SOURCES_STEP1 matches the frozen step-1 migration literal', () => {
    expect(literal('LINK_SOURCES_STEP1')).toEqual([...R.LINK_SOURCES].slice(0, -1));
  });
  test('the migration requires no service module', () => {
    expect(src).not.toMatch(/require\(/);
  });
});

describe('up()', () => {
  test('swaps both source CHECKs to the widened set, ai_citation included', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex._raws).toContain('ALTER TABLE seo_link_domains DROP CONSTRAINT IF EXISTS seo_link_domains_source_check');
    expect(knex._raws).toContain('ALTER TABLE seo_link_domain_sources DROP CONSTRAINT IF EXISTS seo_link_domain_sources_source_check');
    const domainsCheck = knex._raws.find((r) => r.includes('seo_link_domains_source_check CHECK'));
    const sourcesCheck = knex._raws.find((r) => r.includes('seo_link_domain_sources_source_check CHECK'));
    expect(domainsCheck).toMatch(/source IN \('owner_seed', 'list_import'.*'ai_citation'\)/);
    expect(sourcesCheck).toMatch(/source IN \('owner_seed', 'list_import'.*'ai_citation'\)/);
    // the DROP always precedes its matching ADD, for both tables
    expect(knex._raws.indexOf('ALTER TABLE seo_link_domains DROP CONSTRAINT IF EXISTS seo_link_domains_source_check'))
      .toBeLessThan(knex._raws.indexOf(domainsCheck));
    expect(knex._raws.indexOf('ALTER TABLE seo_link_domain_sources DROP CONSTRAINT IF EXISTS seo_link_domain_sources_source_check'))
      .toBeLessThan(knex._raws.indexOf(sourcesCheck));
  });
});

describe('down()', () => {
  test('restores the step-1 13-value set on both tables (ai_citation removed)', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    const domainsCheck = knex._raws.find((r) => r.includes('seo_link_domains_source_check CHECK'));
    const sourcesCheck = knex._raws.find((r) => r.includes('seo_link_domain_sources_source_check CHECK'));
    expect(domainsCheck).not.toMatch(/ai_citation/);
    expect(sourcesCheck).not.toMatch(/ai_citation/);
    expect(domainsCheck).toMatch(/'legacy_unknown'\)\)$/);
    expect(sourcesCheck).toMatch(/'legacy_unknown'\)\)$/);
  });
});
