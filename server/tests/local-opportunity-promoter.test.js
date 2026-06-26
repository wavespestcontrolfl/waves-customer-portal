const promoter = require('../services/seo/local-opportunity-promoter');
const { HOME } = require('../services/seo/local-opportunity-promoter')._internals;

// Minimal knex-like fake supporting exactly what promoter.run touches:
//   db('seo_backlinks').where({status}).select('source_domain')
//   db('seo_link_prospects').where({target_domain,target_page}).first()
//   db('seo_link_prospects').insert(row)
function fakeDb({ ownActive = [], existing = [] } = {}) {
  const inserts = [];
  const fn = (table) => {
    if (table === 'seo_backlinks') {
      return { where: () => ({ select: async () => ownActive.map((d) => ({ source_domain: d })) }) };
    }
    if (table === 'seo_link_prospects') {
      let w = null;
      const chain = {
        where: (args) => { w = args; return chain; },
        first: async () => existing.find((p) => p.target_domain === w.target_domain && p.target_page === w.target_page) || undefined,
        insert: async (row) => { inserts.push(row); },
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  };
  fn._inserts = inserts;
  return fn;
}

const cand = (domain, type = 'sponsorship', extra = {}) => ({
  domain, opportunity_type: type, opportunity_types: [type], source_url: `https://${domain}/x`, title: 't',
  appearances: 1, bestPosition: 1, markets: ['Venice'], queries: [`Venice ${type}`], ...extra,
});

// A scoreCandidates-shaped result keyed for the test scenarios.
const scoredFor = (domain) => {
  const M = {
    'sponsora.org': { score: 70, lane: 'outreach', ok: true, intent: 'resource', reason: 'llm', email: 'a@sponsora.org' },
    'chamber.com': { score: 50, lane: 'signup', ok: true, intent: 'directory', reason: 'llm', email: null },     // no contact OK for signup
    'heuristic.com': { score: 60, lane: 'outreach', ok: true, intent: 'resource', reason: 'heuristic', email: 'h@heuristic.com' },
    'dup.com': { score: 65, lane: 'outreach', ok: true, intent: 'resource', reason: 'llm', email: 'd@dup.com' },
    'lowscore.com': { score: 20, lane: 'outreach', ok: true, intent: 'resource', reason: 'llm', email: 'l@lowscore.com' },
    'nocontact.com': { score: 66, lane: 'outreach', ok: false, intent: 'resource', reason: 'llm', email: null }, // gate fails
    'haro.com': { score: 80, lane: 'haro_platform', ok: true, intent: 'haro', reason: 'llm', email: null },
  }[domain];
  return {
    score: M.score, tier: 3, priority: 'high', intent_class: M.intent, suggested_anchor: null,
    relevance_0_100: 60, lead_value_tier: 3, is_local_swfl: true,
    contact: M.email ? { contact_email: M.email, contact_url: null, has_contact_path: true } : null,
    gate: { ok: M.ok, lane: M.lane },
    classification: { reason: M.reason },
  };
};

const ALL = ['sponsora.org', 'chamber.com', 'owned.com', 'heuristic.com', 'dup.com', 'lowscore.com', 'nocontact.com', 'haro.com'];
const discoverFn = async () => ALL.map((d) => cand(d, d === 'chamber.com' ? 'chamber' : 'sponsorship'));
// scoreFn receives the post-exclude candidates; key by domain so it's filter-order-robust.
const scoreFn = async (input) => input.map((c) => scoredFor(c.domain));

describe('local-opportunity-promoter.run', () => {
  test('excludes owned, gates/scores, holds heuristic, dedupes, and promotes the rest', async () => {
    const db = fakeDb({ ownActive: ['owned.com'], existing: [{ target_domain: 'dup.com', target_page: HOME }] });
    const r = await promoter.run({ db, discoverFn, scoreFn, promoteMin: 35 });

    expect(r.discovered).toBe(8);
    expect(r.excludedOwned).toBe(1);                 // owned.com dropped before scoring
    expect(r.heldBack).toBe(1);                       // heuristic.com held back
    expect(r.dupes).toBe(1);                          // dup.com already on the board
    // promoted = sponsora.org (outreach) + chamber.com (signup). NOT: owned(excluded),
    // heuristic(held), dup(skip), lowscore(<35), nocontact(gate !ok), haro(platform).
    expect(r.promoted).toBe(2);
    const domains = db._inserts.map((i) => i.target_domain).sort();
    expect(domains).toEqual(['chamber.com', 'sponsora.org']);
    // byLane reflects the writable set (sponsora + dup are outreach, chamber is signup);
    // dup is only dropped at the insert step, so it still counts toward "would-promote".
    expect(r.byLane).toEqual({ outreach: 2, signup: 1 });
  });

  test('insert payload is board-shaped (source tag, claimable link_type, dedupe page, signals)', async () => {
    const db = fakeDb({ ownActive: ['owned.com'] });
    await promoter.run({ db, discoverFn, scoreFn });
    const row = db._inserts.find((i) => i.target_domain === 'sponsora.org');
    expect(row.target_page).toBe(HOME);
    expect(row.link_type).toBe('resource');
    expect(row.source).toMatch(/^local_opportunity_\d{8}$/);
    expect(row.owner).toBe('strategy_agent');
    expect(row.contact_email).toBe('a@sponsora.org');
    expect(JSON.parse(row.quality_signals).scored_by).toBe('local_opportunity');
    // chamber promoted to the signup lane with NO contact (exempt from the contact gate)
    const chamber = db._inserts.find((i) => i.target_domain === 'chamber.com');
    expect(chamber.link_type).toBe('directory');
    expect(chamber.contact_email).toBeNull();
  });

  test('dryRun writes nothing but still reports what it would promote', async () => {
    const db = fakeDb({ ownActive: ['owned.com'] });
    const r = await promoter.run({ db, discoverFn, scoreFn, dryRun: true });
    expect(db._inserts).toHaveLength(0);
    expect(r.promoted).toBe(0);
    // promotable = gate-passing + score>=35 (incl. heuristic): sponsora, chamber, heuristic, dup.
    expect(r.promotable).toBe(4);
    expect(r.heldBack).toBe(1);       // heuristic held out of the writable/items set
    // items = writable (LLM-classified); dedupe runs only on a live write, so dup is still listed.
    expect(r.items.map((i) => i.domain).sort()).toEqual(['chamber.com', 'dup.com', 'sponsora.org']);
  });
});
