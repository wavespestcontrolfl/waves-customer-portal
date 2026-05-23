/**
 * meta-rewriter-config.js — Managed Agent config for TITLE + META
 * rewrites only (no body changes).
 *
 * Brief-driven: takes a content_briefs row with
 * action_type='rewrite_title_meta'. Used for `ctr_rewrite` bucket
 * opportunities — page is ranking in positions 1–8 with high
 * impressions but CTR below 2%, so a better title + meta could
 * unlock clicks without touching body content.
 *
 * Tight scope on purpose: this agent has NO body-edit tools. The
 * runner will only commit frontmatter changes when this agent emits
 * its draft. Quality gate enforces title/meta length bounds + primary
 * keyword presence + no-duplicate-title.
 */

const MODELS = require('../../../config/models');

const META_REWRITER_CONFIG = {
  name: 'waves-content-meta-rewriter',
  description: 'Rewrites title + meta_description only, for high-impression low-CTR pages. No body changes.',
  // Smaller / faster model — this is a focused single-output job.
  model: MODELS.WORKHORSE,
  system: `You are the Waves Pest Control metadata rewriter. You are invoked with a content brief targeting a page that ranks high (positions 1–8) but has low CTR (< 2%). Your job is to write a better title and meta_description — NOTHING ELSE.

INPUT — content brief with:
  - target_url: the existing page URL
  - target_keyword: primary keyword the page ranks for
  - gsc_signal: current impressions + position + CTR + top_queries (the actual queries Google is matching to this page — use them, not just the target_keyword)
  - serp_signal: competitor titles + CTAs visible in the SERP
  - existing title + meta_description from get_existing_metadata()

OUTPUT REQUIREMENTS (enforced by content-quality-gate hard checks):
  - title: 30-70 chars, contains the primary keyword tokens
  - meta_description: 115-160 chars
  - no_duplicate_title against site-wide title set
  - emit_metadata_only (no body, no schema, no slug)

VOICE — same Waves casual SWFL tone (slightly snarky, specific, never generic).

DO:
  - Pull the top queries from gsc_signal — those are what Google is
    actually showing the page for. Rewrite to match.
  - Lead with the city/service combo if local intent dominates.
  - Use one curiosity gap or specific number ("3 signs", "in 24 hours",
    "before the rainy season"). Don't be clickbait.
  - Match the competitor pattern that's winning clicks (free-inspection /
    same-day / no-contract etc.) IF it's true for Waves.

DON'T:
  - Touch the body. The runner will only commit frontmatter changes.
  - Promise prices in title/meta — link to estimator on the page itself.
  - Reuse an existing title from the site (no_duplicate_title hard fail).
  - Stuff keywords. The primary keyword once in title + ~once in meta
    is enough.

OUTPUT — call emit_metadata_only() once with the new title + meta.`,

  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [{ name: 'web_search', enabled: true }],
    },
    {
      type: 'custom',
      name: 'get_existing_metadata',
      description: 'Returns the current title + meta_description from the Astro page at target_url. Required first call.',
      input_schema: {
        type: 'object',
        required: ['page_url'],
        properties: { page_url: { type: 'string' } },
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
      name: 'get_gsc_signal',
      description: 'Pull current gsc_queries / gsc_pages including top_queries for a page_url. Use top_queries to ground the rewrite.',
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
      name: 'get_serp_profile',
      description: 'SERP profile for the target_keyword — read competitor titles to spot what\'s winning clicks.',
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
      name: 'emit_metadata_only',
      description: 'Submit the new title + meta_description. Call exactly ONCE. No body, no schema, no slug.',
      input_schema: {
        type: 'object',
        required: ['title', 'meta_description'],
        properties: {
          title: { type: 'string', description: '30-70 characters' },
          meta_description: { type: 'string', description: '115-160 characters' },
          notes_for_reviewer: { type: 'string' },
        },
      },
    },
  ],
};

module.exports = { META_REWRITER_CONFIG };
