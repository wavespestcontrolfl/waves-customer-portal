/**
 * 20260928080000 — second rollback-safety follow-up (Codex P1, 2026-09-28,
 * second round): stamps an independent, durable `enrichment` marker on every
 * ai_citation-sourced domain, BEFORE 20260928060000's down() relabels
 * `source` away — so link-authority-policy.js's isDiscoveryOnlyDomain guard
 * survives a rollback + later reapply of the source-widening migration pair.
 */
const migration = require('../models/migrations/20260928080000_link_source_ai_citation_rollback_marker');
const rollbackSafety = require('../models/migrations/20260928060000_link_source_ai_citation_rollback_safety');
const earlier = require('../models/migrations/20260928050000_link_source_ai_citation');
const P = require('../services/seo/link-authority-policy');

function fakeKnex(rows) {
  const domains = rows.seo_link_domains;
  const domainSources = rows.seo_link_domain_sources;
  const builder = (table) => {
    let whereArg = null;
    const q = {
      where(a) { whereArg = a; return q; },
      update: jest.fn(async (patch) => {
        const set = table === 'seo_link_domains' ? domains : domainSources;
        let n = 0;
        for (const r of set) {
          if (Object.entries(whereArg).every(([k, v]) => r[k] === v)) { Object.assign(r, patch); n += 1; }
        }
        return n;
      }),
    };
    return q;
  };
  const knex = Object.assign(jest.fn(builder), {
    raw: jest.fn(async (sql) => {
      // Simulate ONLY this migration's marker statement; every other raw
      // call (e.g. earlier.down()'s CHECK-constraint SQL) is a pass-through
      // no-op here — this fake only models the ONE table this test cares about.
      if (/UPDATE seo_link_domains SET enrichment/.test(String(sql))) {
        for (const r of domains) {
          if (r.source === 'ai_citation') {
            r.enrichment = { ...(r.enrichment || {}), ai_citation_discovered: true };
          }
        }
      }
      return {};
    }),
  });
  return knex;
}

test('up() is a documented no-op — no writes, no schema changes', async () => {
  const raws = [];
  const knex = Object.assign(jest.fn(), { raw: jest.fn(async (sql) => { raws.push(sql); return {}; }) });
  await migration.up(knex);
  expect(raws).toEqual([]);
  expect(knex).not.toHaveBeenCalled();
});

test('down() stamps ai_citation_discovered on every ai_citation-sourced domain, merging with existing enrichment', async () => {
  const rows = {
    seo_link_domains: [
      { id: 'd1', domain: 'bbb.org', source: 'ai_citation', enrichment: null },
      { id: 'd2', domain: 'yelp.com', source: 'ai_citation', enrichment: { domain_rating: 40 } },
      { id: 'd3', domain: 'competitor.example', source: 'competitor_gap', enrichment: null },
    ],
    seo_link_domain_sources: [],
  };
  const knex = fakeKnex(rows);
  await migration.down(knex);
  expect(knex.raw).toHaveBeenCalledTimes(1);
  expect(String(knex.raw.mock.calls[0][0])).toMatch(/UPDATE seo_link_domains SET enrichment.*WHERE source = 'ai_citation'/);
  expect(rows.seo_link_domains[0].enrichment).toEqual({ ai_citation_discovered: true });
  expect(rows.seo_link_domains[1].enrichment).toEqual({ domain_rating: 40, ai_citation_discovered: true }); // merged, not replaced
  expect(rows.seo_link_domains[2].enrichment).toBeNull(); // untouched — not ai_citation
  expect(rows.seo_link_domains[2].source).toBe('competitor_gap');
});

// The actual correctness proof: run all three down()s in the ORDER knex
// would (last-applied-first: this file's, then 20260928060000's, then
// 20260928050000's), and confirm isDiscoveryOnlyDomain still refuses AUTO
// for the affected domain even though `source` no longer says 'ai_citation'.
test('the full down() sequence preserves isDiscoveryOnlyDomain through relabeling', async () => {
  const rows = {
    seo_link_domains: [{ id: 'd1', domain: 'bbb.org', source: 'ai_citation', enrichment: null }],
    seo_link_domain_sources: [{ id: 's1', domain_id: 'd1', source: 'ai_citation', touch_key: 'ai_citation:-' }],
  };
  const knex = fakeKnex(rows);

  expect(P.isDiscoveryOnlyDomain(rows.seo_link_domains[0])).toBe(true); // before any rollback

  await migration.down(knex); // THIS file's down() — stamps the marker while source still says ai_citation
  await rollbackSafety.down(knex); // 20260928060000's down() — relabels source away
  expect(rows.seo_link_domains[0].source).toBe('legacy_unknown');
  // the guard survives the relabel, via the marker alone
  expect(P.isDiscoveryOnlyDomain(rows.seo_link_domains[0])).toBe(true);

  await expect(earlier.down(knex)).resolves.toBeUndefined(); // the CHECK-narrow itself — no data left to reject
  expect(rows.seo_link_domains.every((r) => r.source !== 'ai_citation')).toBe(true);
});

test('a domain untouched by ai_citation is unaffected end-to-end', async () => {
  const rows = {
    seo_link_domains: [{ id: 'd1', domain: 'competitor.example', source: 'competitor_gap', enrichment: null }],
    seo_link_domain_sources: [],
  };
  const knex = fakeKnex(rows);
  await migration.down(knex);
  await rollbackSafety.down(knex);
  expect(rows.seo_link_domains[0]).toMatchObject({ source: 'competitor_gap', enrichment: null });
  expect(P.isDiscoveryOnlyDomain(rows.seo_link_domains[0])).toBe(false);
});
