/**
 * Writer-prompt / publish-gate alignment tests (prod audit 2026-08-07).
 *
 * Bug: the autonomous writer kept producing the same guardrail violations
 * (HARDCODED_PRICE, UNKNOWN_INTERNAL_ROUTE, OFF_FOOTPRINT_CITY_CLAIM,
 * invented comparison business names, …), burning the run's single redraft
 * and skipping. The rules existed but were scattered through a long prompt
 * with no single binding checklist naming the gate codes.
 *
 * Fix: writer-agent-config now carries a compact "HARD PUBLISH GATES"
 * section enumerating every frequent P0/P1 code in gate-accurate terms.
 * Dynamic lists (footprint cities, FAQ-blocked services, internal-link
 * allowlist, MDX components) stay interpolated from the SAME modules the
 * gates enforce — these tests pin both the section's presence and that
 * single-source-of-truth wiring so instruction and enforcement can never
 * drift.
 */

jest.mock('../models/db', () => jest.fn());

const guardrails = require('../services/content/content-guardrails');
const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');

describe('writer-agent-config HARD PUBLISH GATES section', () => {
  const system = WRITER_AGENT_CONFIG.system;

  test('carries the binding section header and discard framing', () => {
    expect(system).toContain('HARD PUBLISH GATES');
    expect(system).toContain('a violation discards the draft');
    expect(system).toMatch(/ONE redraft/);
  });

  test('names every frequent gate code from the prod audit', () => {
    for (const code of [
      'HARDCODED_PRICE',
      'UNKNOWN_INTERNAL_ROUTE',
      'OFF_FOOTPRINT_CITY_CLAIM',
      'FAQ_BLOCKED_SERVICE',
      'CITATION_TOKEN_RESIDUE',
      'DISALLOWED_EXTERNAL_LINK',
      'PRODUCT_CLAIM',
      'PREVENTION_PROMISE',
      'COMPARISON_UNKNOWN_COMPETITOR',
      'COMPARISON_UNCLASSIFIED_OPTION',
      'COMPARISON_RIGGED_RANKING',
      'COMPARISON_COMPETITOR_IN_PROSE',
    ]) {
      expect(system).toContain(code);
    }
  });

  test('price rule points at the calculator and scopes the competitor-price carve-out to operator briefs', () => {
    const section = system.slice(system.indexOf('HARD PUBLISH GATES'), system.indexOf('VOICE —'));
    expect(section).toContain('/pest-control-calculator/');
    expect(section).toMatch(/operator competitor-intercept briefs ONLY/);
    expect(section).toMatch(/SAME SENTENCE/);
    expect(section).toMatch(/as of/);
  });

  test('internal-route rule states the repair/kill split (near-miss normalized, unknown fatal)', () => {
    expect(system).toMatch(/near-misses[\s\S]{0,200}normalized\s+automatically/);
    expect(system).toMatch(/a route that does not exist kills the draft/);
  });

  test('comparison rule bans invented business names and rankings, and confines names to the table', () => {
    expect(system).toMatch(/NEVER invent or compose a business name/);
    expect(system).toMatch(/get_competitor_facts returns/);
    expect(system).toMatch(/No rankings,\s+winners, "#1", "best"/);
    expect(system).toMatch(/ONLY inside the <ComparisonTable>[\s\S]{0,80}never\s+in prose, title, or meta/);
  });

  test('checklist preserves the operator-brief exceptions the gates actually carry (Codex r1)', () => {
    // FAQ block: an operator faq_required mandate WINS over the blocked list
    // (writer-agent-config FAQ POLICY + intercept-brief-seeder mandate).
    expect(system).toMatch(/faq_required=true[\s\S]{0,80}WINS over the block/);
    // Comparison prose ban: operator-named competitors are authorized in
    // prose/title/meta (comparison-table-gate authorizes operatorBriefText
    // names and routes those drafts to human review).
    expect(system).toMatch(/competitor the OPERATOR brief[\s\S]{0,120}authorized in[\s\S]{0,40}prose\/title\/meta/);
    expect(system).toMatch(/never add a competitor the brief didn't name/);
  });

  test('citation rule names the exact token families the residue detector blocks', () => {
    for (const token of ['<cite', 'index="N"', '[^footnote', 'citeturn', 'oaicite', ':contentReference', '【']) {
      expect(system).toContain(token);
    }
  });
});

describe('single-source-of-truth drift guards (prompt values come from the gate modules)', () => {
  const system = WRITER_AGENT_CONFIG.system;

  test('footprint cities interpolate from config/locations CITY_TO_LOCATION — the same source the off-footprint gate filters against', () => {
    const { CITY_TO_LOCATION } = require('../config/locations');
    for (const city of Object.keys(CITY_TO_LOCATION)) {
      const titleCased = city.replace(/(^|\s)[a-z]/g, (ch) => ch.toUpperCase());
      expect(system).toContain(titleCased);
    }
  });

  test('out-of-area blocklist cities interpolate from content-guardrails outOfAreaCities()', () => {
    expect(system).toContain(guardrails.outOfAreaCities().join(', '));
  });

  test('FAQ-blocked services interpolate from content-guardrails FAQ_BLOCKED_SERVICES', () => {
    expect(system).toContain([...guardrails.FAQ_BLOCKED_SERVICES].join(', '));
  });

  test('internal-link allowlist interpolates from content-guardrails ALLOWED_INTERNAL_LINKS', () => {
    expect(system).toContain(guardrails.ALLOWED_INTERNAL_LINKS.join(', '));
  });

  test('MDX component vocabulary interpolates from content-guardrails SAFE_MDX_COMPONENTS', () => {
    expect(system).toContain(guardrails.SAFE_MDX_COMPONENTS.join(', '));
  });

  test('product-claim term lists interpolate from content-guardrails exports', () => {
    expect(system).toContain(guardrails.ACTIVE_INGREDIENT_TERMS.join(', '));
    expect(system).toContain(guardrails.PRO_PRODUCT_TERMS.join(', '));
  });
});
