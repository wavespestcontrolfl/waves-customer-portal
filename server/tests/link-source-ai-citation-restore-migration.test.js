/**
 * 20260928110000 — restores `source = 'ai_citation'` on the rows
 * 20260928060000's down() relabels to legacy_unknown, identified by the
 * durable first-touch source_detail (current prefix + the feeder's earlier
 * label) and the `ai_citation:` touch_key. Source-reading + fake-knex, the
 * same convention as the 050000 / 080000 migration tests; the fake applies
 * the migration's own bound patterns as JS regexes (identical semantics to
 * Postgres `~` for these anchored ASCII/U+00B7 patterns).
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260928110000_link_source_ai_citation_restore.js');
const migration = require(MIG);
const widen = require('../models/migrations/20260928050000_link_source_ai_citation');
const rollbackSafety = require('../models/migrations/20260928060000_link_source_ai_citation_rollback_safety');
const marker = require('../models/migrations/20260928080000_link_source_ai_citation_rollback_marker');
const P = require('../services/seo/link-authority-policy');
const R = require('../services/seo/link-registry');

const src = fs.readFileSync(MIG, 'utf8');
const literal = (name) => {
  const m = src.match(new RegExp(`^const ${name} = '([^'\\n]*)';`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return m[1];
};

function fakeKnex(rows) {
  const tables = { seo_link_domains: rows.seo_link_domains, seo_link_domain_sources: rows.seo_link_domain_sources };
  const raws = [];
  const builder = (table) => {
    let whereArg = null;
    const q = {
      where(a) { whereArg = a; return q; },
      update: jest.fn(async (patch) => {
        let n = 0;
        for (const r of tables[table]) {
          if (Object.entries(whereArg).every(([k, v]) => r[k] === v)) { Object.assign(r, patch); n += 1; }
        }
        return n;
      }),
    };
    return q;
  };
  const knex = Object.assign(jest.fn(builder), {
    raw: jest.fn(async (sql, bindings = []) => {
      const text = String(sql);
      raws.push({ sql: text, bindings });
      const restore = text.match(/^UPDATE (seo_link_domains|seo_link_domain_sources) SET source = 'ai_citation' WHERE source = 'legacy_unknown' AND /);
      if (restore) {
        const col = restore[1] === 'seo_link_domains' ? 'source_detail' : 'touch_key';
        let n = 0;
        for (const r of tables[restore[1]]) {
          if (r.source === 'legacy_unknown' && bindings.some((b) => new RegExp(b).test(r[col] || ''))) { r.source = 'ai_citation'; n += 1; }
        }
        return { rowCount: n };
      }
      if (/UPDATE seo_link_domains SET enrichment/.test(text)) {
        for (const r of tables.seo_link_domains) {
          if (r.source === 'ai_citation') r.enrichment = { ...(r.enrichment || {}), ai_citation_discovered: true };
        }
      }
      return {}; // CHECK-constraint DDL: pass-through
    }),
  });
  knex._raws = raws;
  return knex;
}

// Every label format the feeder has ever written, plus rows that must never move.
const OLD_LABEL = 'ai_citation_feeder · listing · 2x · gemini/openai · Q1 · local';
const OLD_LABEL_SUBTYPE = 'ai_citation_feeder · editorial · 1x · openai · Q1 · local · listicle_candidate';
const NEW_LABEL = 'ai_citation:listing https://www.bbb.org/us/fl/sarasota/profile/pest-control/sample-co';
const seedRows = () => ({
  seo_link_domains: [
    { id: 'd1', domain: 'bbb.org', source: 'ai_citation', source_detail: NEW_LABEL, enrichment: null },
    { id: 'd2', domain: 'yelp.com', source: 'ai_citation', source_detail: OLD_LABEL, enrichment: null },
    { id: 'd3', domain: 'localdirectory.example', source: 'ai_citation', source_detail: OLD_LABEL_SUBTYPE, enrichment: null },
    // a genuine legacy row and a real feeder's row — never touched
    { id: 'd4', domain: 'legacy.example', source: 'legacy_unknown', source_detail: 'imported from backlink_agent_queue', enrichment: null },
    { id: 'd5', domain: 'competitor.example', source: 'competitor_gap', source_detail: 'competitor_gap_scan ai_citation:', enrichment: null },
    // LIKE's `_` wildcard would have matched this one; the anchored regex does not
    { id: 'd6', domain: 'lookalike.example', source: 'legacy_unknown', source_detail: 'aiXcitation:listing', enrichment: null },
  ],
  seo_link_domain_sources: [
    { id: 's1', domain_id: 'd1', source: 'ai_citation', touch_key: R.touchKey('ai_citation', null, NEW_LABEL) },
    { id: 's2', domain_id: 'd2', source: 'ai_citation', touch_key: R.touchKey('ai_citation', null, OLD_LABEL) },
    { id: 's3', domain_id: 'd4', source: 'legacy_unknown', touch_key: 'legacy_unknown:imported from backlink_agent_queue' },
    { id: 's4', domain_id: 'd5', source: 'competitor_gap', touch_key: 'competitor_gap:competitor_gap_scan ai_citation:' },
  ],
});
const sources = (rows, table) => Object.fromEntries(rows[table].map((r) => [r.id, r.source]));

describe('frozen patterns == link-authority-policy.js', () => {
  test('the current prefix and the touch_key prefix are the policy prefix, anchored', () => {
    expect(literal('DETAIL_PREFIX_RE')).toBe(`^${P.AI_CITATION_SOURCE_DETAIL_PREFIX}`);
    expect(literal('TOUCH_KEY_RE')).toBe(`^${P.AI_CITATION_SOURCE}:`);
  });
  test('the legacy-label pattern is the policy regex, character for character', () => {
    expect(literal('LEGACY_DETAIL_RE')).toBe(P.LEGACY_AI_CITATION_SOURCE_DETAIL_RE.source);
  });
  test('the migration requires no service module', () => {
    expect(src).not.toMatch(/require\(/);
  });
});

test('up() on an ordinary forward deploy changes no row', async () => {
  const rows = seedRows();
  const before = JSON.parse(JSON.stringify(rows));
  const knex = fakeKnex(rows);
  await migration.up(knex);
  expect(knex._raws).toHaveLength(2);
  expect(rows).toEqual(before);
});

test('down() is a documented no-op', async () => {
  const rows = seedRows();
  const before = JSON.parse(JSON.stringify(rows));
  const knex = fakeKnex(rows);
  await migration.down(knex);
  expect(knex.raw).not.toHaveBeenCalled();
  expect(knex).not.toHaveBeenCalled();
  expect(rows).toEqual(before);
});

// The correctness proof: a rollback reaching 060000 (knex order: 110000,
// 080000, 060000, then 050000) and a reapply (050000, 060000, 080000,
// 110000) leaves every feeder row labeled ai_citation again, and nothing else moved.
test('rollback + reapply restores ai_citation on exactly the rows 060000 relabeled — every label format', async () => {
  const rows = seedRows();
  const knex = fakeKnex(rows);

  await migration.down(knex);
  await marker.down(knex);
  await rollbackSafety.down(knex);
  await widen.down(knex);
  expect(sources(rows, 'seo_link_domains')).toMatchObject({ d1: 'legacy_unknown', d2: 'legacy_unknown', d3: 'legacy_unknown' });
  expect(sources(rows, 'seo_link_domain_sources')).toMatchObject({ s1: 'legacy_unknown', s2: 'legacy_unknown' });

  await widen.up(knex);
  await rollbackSafety.up(knex);
  await marker.up(knex);
  await migration.up(knex);

  expect(sources(rows, 'seo_link_domains')).toEqual({
    d1: 'ai_citation', d2: 'ai_citation', d3: 'ai_citation', d4: 'legacy_unknown', d5: 'competitor_gap', d6: 'legacy_unknown',
  });
  expect(sources(rows, 'seo_link_domain_sources')).toEqual({
    s1: 'ai_citation', s2: 'ai_citation', s3: 'legacy_unknown', s4: 'competitor_gap',
  });
  // the guard held throughout, and still does
  for (const d of rows.seo_link_domains.slice(0, 3)) expect(P.isDiscoveryOnlyDomain(d)).toBe(true);
  expect(P.isDiscoveryOnlyDomain(rows.seo_link_domains[3])).toBe(false);
});

test('SQL shape: Postgres regex match (never LIKE), guarded on legacy_unknown', async () => {
  const knex = fakeKnex(seedRows());
  await migration.up(knex);
  const [domains, touches] = knex._raws;
  expect(domains.sql).toMatch(/^UPDATE seo_link_domains SET source = 'ai_citation' WHERE source = 'legacy_unknown' AND \(source_detail ~ \? OR source_detail ~ \?\)$/);
  expect(domains.bindings).toEqual([literal('DETAIL_PREFIX_RE'), literal('LEGACY_DETAIL_RE')]);
  expect(touches.sql).toMatch(/^UPDATE seo_link_domain_sources SET source = 'ai_citation' WHERE source = 'legacy_unknown' AND touch_key ~ \?$/);
  expect(touches.bindings).toEqual([literal('TOUCH_KEY_RE')]);
});
