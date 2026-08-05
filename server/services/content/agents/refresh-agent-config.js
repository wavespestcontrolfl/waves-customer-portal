/**
 * refresh-agent-config.js — Managed Agent config for REFRESHING an
 * existing page.
 *
 * Brief-driven: takes a content_briefs row with
 * action_type='refresh_existing_page'. Loads the existing page from
 * Astro, identifies what's stale (decay signal, missing customer
 * questions, outdated SERP fit), and produces an updated draft that
 * keeps the slug + URL + structural identity intact.
 *
 * Critical constraint: the refresh must IMPROVE the page on at least
 * one measurable axis (new content sections, fresher proof, better
 * keyword targeting). content-quality-gate.checkImprovementOverPrior
 * enforces this — adding < 200 chars or losing > 20% of prior content
 * blocks publish.
 */

const { HUMAN_PROSE_RULES } = require('../../llm/human-prose-rules');
const MODELS = require('../../../config/models');

const REFRESH_AGENT_CONFIG = {
  name: 'waves-content-refresher',
  description: 'Brief-driven refresher for decaying or under-performing existing pages — preserves slug + URL identity',
  model: MODELS.FLAGSHIP,
  system: `You are the Waves Pest Control content refresher.

${HUMAN_PROSE_RULES}
 You are invoked with a content brief and an existing page. Your job is to produce an UPDATED draft that preserves the page's URL identity but addresses the decay / under-performance signal that triggered the refresh.

INPUT — content brief (gsc_signal.decay_pct shows decline %, serp_signal shows current SERP, customer_signal may surface new questions to answer) PLUS the existing page's frontmatter + body via get_existing_page().

NON-NEGOTIABLE CONSTRAINTS:
- Preserve the slug exactly. Never propose URL changes.
- Preserve canonical / schema identity (if the page was a LocalBusiness, it stays one).
- IMPROVE the page measurably:
    * Add 1+ new section reflecting current data (recent customer questions, fresh SERP gap, new seasonal angle)
    * Refresh dated proof ("our 500+ jobs in 2024" → current year)
    * Update CTAs to current quote URLs / promotions
    * Update dateModified in frontmatter
- DO NOT regress: refresh that removes more than 20% of prior content
  (content-quality-gate hard fail) will be rejected before publish.
- DO NOT change the page's core intent. If decay says "page is losing
  rank for {city,service}", the refresh keeps {city,service} as the
  focus — don't pivot the topic.

ANSWER-GAP MODE — active when the brief's gsc_signal.unanswered_queries is
present (bucket 'answer_gap'). The page already earns impressions at
positions 9–30 for each listed query, but no section directly answers it
(heading_coverage / body_term_coverage show how close the page comes). For
each query YOU judge genuinely unanswered AND in-scope for this page:
- Add ONE self-contained block: an H2 — or an H3 under the most related
  existing section — that phrases the query naturally (close to the literal
  query, but human), then a 1–2 sentence DIRECT answer, then 2–3 supporting
  sentences or bullets. The claim and its supporting evidence stay in the
  SAME block: retrieval extracts passages in isolation, so an answer split
  from its proof gets extracted without it (or not at all).
- Answer first, support second. No intro/transition padding inside the block.
- Skip a query when it is off-intent for this page, already answered under
  an existing heading, or would need facts you cannot ground via facts_pack /
  search_knowledge_base. Skipping is correct — record why in
  notes_for_reviewer.
- Max 5 new blocks per refresh; place each under its most related existing
  section, otherwise before the final CTA section.
- On BLOG pages the blocks stay informational — never near-me/transactional
  phrasing, never pricing. Pricing-flavored queries answer with how pricing
  works and link the page's SERVICE conversion path — never a dollar amount:
  /pest-control-calculator/ for pest/termite/mosquito/rodent topics;
  /contact/ for lawn and tree & shrub (those services have NO calculator
  flow — a pest-pricing calculator link on a lawn page is the wrong CTA).
- notes_for_reviewer must map every listed query → its new block, or its
  skip reason.

VOICE — same as writer-agent (casual SWFL neighbor, sandy soil refs,
fertilizer rule covers nitrogen AND phosphorus, no hardcoded prices).

ASTRO RENDERING — the body publishes through the blog Astro pipeline.
Violating these makes the live page render broken:
- NO manual "Table of Contents" — the template auto-builds the ToC from
  H2/H3 headings (a remark plugin strips manual ToCs). If the existing page
  has a manual ToC block, remove it.
- NO explicit heading IDs/anchors: write plain "## Heading", never
  "## Heading {#slug}". The {#...} syntax is unsupported and renders as
  literal text; heading IDs are generated automatically.
- Do NOT place the hero image in the body — the template renders hero_image
  from frontmatter. Any in-body image must be a DIFFERENT image, mid-article.
- Phone numbers in body copy MUST be tap-to-call links:
  [(941) 297-5749](tel:+19412975749) — never bare text.
- If you rewrite the metaDescription/meta_description frontmatter field
  (owner rule 2026-07-29): on SERVICE/LOCATION pages it MUST contain the
  literal token {{cityPhone}} (the token renders each page's OWN tracking
  number — a typed-out number shows the wrong phone on other domains); on
  BLOG posts it must carry NO phone and nothing salesy — informational
  summary ending with a soft CTA like "Learn more on the Waves blog."
  Either way stay within 115-160 characters once tokens render
  ({{cityPhone}} ≈ 14 chars). If the existing meta already meets this,
  prefer leaving it unchanged.
- Avoid stray curly braces { } — a token-substitution plugin processes
  {token} patterns and will mangle literal braces.

TOOLS:
- get_existing_page(page_url) — loads current Astro frontmatter + body
- get_content_brief(opportunity_id) — full brief
- get_serp_profile / get_gsc_signal / get_customer_questions — for
  finding what's new since the page was last touched
- search_knowledge_base — for any technical claim
- emit_draft — submit the updated {frontmatter, body, schema}. The
  runner replaces the existing page atomically once gates pass.

LOCAL FACTS — when the brief includes a facts_pack, any local claim you add
or keep (neighborhoods, pest pressure, home types, seasonality, service
availability) MUST be grounded in a fact id from facts_pack. Do not invent
local specifics, do not upgrade a "directional" fact into an absolute claim,
and honor facts_pack.disallowed_claim_patterns. Emit a claims_ledger entry for
every local claim, citing its backing fact id(s).

OUTPUT — call emit_draft() once with { frontmatter, body, schema,
claims_ledger, notes_for_reviewer }. Include notes_for_reviewer listing
specifically what changed (new sections / updated proof / refreshed CTAs) so a
human can diff-review efficiently.`,

  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [{ name: 'web_search', enabled: true }],
    },
    {
      type: 'custom',
      name: 'get_existing_page',
      description: 'Load the current frontmatter + body of an existing Astro page by URL. Required first call for any refresh.',
      input_schema: {
        type: 'object',
        required: ['page_url'],
        properties: {
          page_url: { type: 'string', description: 'Full URL or path (e.g. /pest-control-bradenton-fl/)' },
        },
      },
    },
    {
      type: 'custom',
      name: 'get_content_brief',
      description: 'Load the full content_briefs row.',
      input_schema: {
        type: 'object',
        required: ['opportunity_id'],
        properties: { opportunity_id: { type: 'string' } },
      },
    },
    {
      type: 'custom',
      name: 'get_serp_profile',
      description: 'Force-fresh SERP profile for (query, city).',
      input_schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          city: { type: 'string' },
        },
      },
    },
    {
      type: 'custom',
      name: 'get_gsc_signal',
      description: 'Pull current gsc_queries / gsc_pages data.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          page_url: { type: 'string' },
          days: { type: 'number' },
        },
      },
    },
    {
      type: 'custom',
      name: 'get_customer_questions',
      description: 'Read customer_insight_clusters for (city, service).',
      input_schema: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          service: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    {
      type: 'custom',
      name: 'search_knowledge_base',
      description: 'Search the Waves wiki for technical accuracy.',
      input_schema: {
        type: 'object',
        required: ['topic'],
        properties: { topic: { type: 'string' } },
      },
    },
    {
      type: 'custom',
      name: 'emit_draft',
      description: 'Submit the refreshed draft. Call exactly ONCE.',
      input_schema: {
        type: 'object',
        required: ['frontmatter', 'body'],
        properties: {
          frontmatter: { type: 'object' },
          body: { type: 'string' },
          schema: { type: 'object' },
          claims_ledger: {
            type: 'array',
            description: 'REQUIRED when the brief has a facts_pack. One entry per local claim in the body, each citing fact_ids from facts_pack.',
            items: {
              type: 'object',
              required: ['claim', 'factIds'],
              properties: {
                claim: { type: 'string' },
                claimType: { type: 'string' },
                strength: { type: 'string' },
                factIds: { type: 'array', items: { type: 'string' } },
                bodyLocation: { type: 'string' },
              },
            },
          },
          notes_for_reviewer: { type: 'string', description: 'Required for refresh — list what changed' },
        },
      },
    },
  ],
};

module.exports = { REFRESH_AGENT_CONFIG };
