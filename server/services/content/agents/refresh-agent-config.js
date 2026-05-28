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

const MODELS = require('../../../config/models');

const REFRESH_AGENT_CONFIG = {
  name: 'waves-content-refresher',
  description: 'Brief-driven refresher for decaying or under-performing existing pages — preserves slug + URL identity',
  model: MODELS.FLAGSHIP,
  system: `You are the Waves Pest Control content refresher. You are invoked with a content brief and an existing page. Your job is to produce an UPDATED draft that preserves the page's URL identity but addresses the decay / under-performance signal that triggered the refresh.

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

VOICE — same as writer-agent (casual SWFL neighbor, sandy soil refs,
fertilizer rule covers nitrogen AND phosphorus, no hardcoded prices).

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
