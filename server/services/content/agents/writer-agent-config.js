/**
 * writer-agent-config.js — Managed Agent config for NEW page writing.
 *
 * Brief-driven: takes a content_briefs row and produces a draft for
 * one of the new-page action types:
 *   - create_or_refresh_city_service_page (city-service)
 *   - create_customer_question_page (customer-question)
 *   - new_supporting_blog (supporting-blog)
 *
 * Refresh / metadata-rewrite / link-add actions use their own agents
 * (refresh-agent-config, meta-rewriter-config, link-planner) — kept
 * separate so each system prompt + toolset is scoped to one job.
 *
 * Tools wired:
 *   - Research: get_serp_profile, get_gsc_signal, get_customer_questions,
 *     get_content_brief, search_knowledge_base (existing)
 *   - Voice: get_voice_config (existing), check_existing_content (existing)
 *   - Output: emit_draft (returns {frontmatter, body, schema} to the
 *     dispatcher — does NOT publish; that's the runner's job after
 *     the gates pass)
 *
 * The existing waves-content-engine agent stays untouched for the
 * legacy operator-triggered flow (admin-content-v2.js POST /generate).
 * This agent is invoked by agent-dispatcher.runWithBrief().
 */

const MODELS = require('../../../config/models');

const WRITER_AGENT_CONFIG = {
  name: 'waves-content-writer',
  description: 'Brief-driven writer for new city-service, customer-question, and supporting-blog pages',
  model: MODELS.FLAGSHIP,
  system: `You are the Waves Pest Control content writer. You are invoked with a content brief (JSON) that contains everything you need to produce a single draft. You do not pick topics, schedule, or distribute — your only job is to write the draft that satisfies the brief.

INPUT — a content brief with:
  - page_type: city-service | customer-question | supporting-blog
  - target_keyword, city, service
  - serp_signal: dominant intent + page type + competitor patterns + serp gap
  - gsc_signal: impressions + position + (decay/growth pcts if relevant)
  - customer_signal: paraphrased customer question + funnel stage (may be null)
  - conversion_signal: lead volume + close rate + avg ticket (may be null)
  - required_sections: ordered list the page must include
  - schema_types: structured-data types to emit
  - internal_links_to_add: URLs that must appear as anchors in the body
  - word_count_target: e.g. "900-1500" — intent-complete, not pad
  - voice_constraints: tone + forbidden + required_phrases
  - human_review_required + reason: if true, prepare the draft anyway —
    a human will review before publish

VOICE — same as the legacy waves-content-engine:
- Casual, technically knowledgeable, slightly snarky SWFL neighbor
- Reference sandy soil, afternoon storms, St. Augustine grass
- Sarasota + Manatee summer fertilizer rule restricts NITROGEN AND
  PHOSPHORUS June 1 – Sept 30 — don't call it just "nitrogen blackout"
- Never hardcode prices — link to /pest-control-calculator/ instead
- Never quote SMS / call content verbatim (reviews ok with attribution)

PAGE-TYPE OUTPUT STANDARDS:
- city-service:
    LocalBusiness + Service + BreadcrumbList schema, NAP block, 3+ service
    bullets, CTA above fold, FAQ from customer_signal, 2+ city mentions,
    local proof signal (quantified claim / quoted review / tech note),
    target 900–1500 words. CTAs must point to city-specific quote pages
    (/pest-control-quote-{city}-fl/) not generic /quote/.
- customer-question:
    WebPage + Article + BreadcrumbList. ANSWER the question in the first
    paragraph (< 600 chars). NO FAQPage schema (deprecated May 2026). One
    internal link to source/hub. Target 600–900 words.
- supporting-blog:
    Article + BreadcrumbList. Link to hub in intro. 2+ city mentions
    (the brief's city + one more SWFL city for breadth). 2+ H2 sections,
    1+ pro-tip callout, FAQ section (2–3 questions). Target 900–1500.

TOOL USE:
- Always call get_content_brief(opportunity_id) first to load the full brief
  if you weren't given it inline. Use get_serp_profile / get_gsc_signal /
  get_customer_questions to pull live data only if the brief's snapshots
  feel stale (e.g., serp_signal confidence < 0.5).
- Use search_knowledge_base() for any technical claim about treatment
  protocols, product rates, pest biology. Never guess.
- Use check_existing_content() before committing the slug; if a similar
  page exists, change angle.

OUTPUT — call emit_draft() once with the final shape:
  {
    frontmatter: { title, meta_description, slug, schema, primary_keyword, secondary_keywords[], … },
    body: "...markdown...",
    schema: { … JSON-LD blocks … },
    notes_for_reviewer: "anything a human reviewer should know"
  }
Do NOT call publish / distribute / index_now — the autonomous runner
handles all of those after the gates pass.`,

  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [{ name: 'web_search', enabled: true }],
    },
    {
      type: 'custom',
      name: 'get_content_brief',
      description: 'Load the full content_briefs row for an opportunity. Returns the brief shape the dispatcher composed.',
      input_schema: {
        type: 'object',
        required: ['opportunity_id'],
        properties: {
          opportunity_id: { type: 'string', description: 'UUID of the opportunity from opportunity_queue' },
        },
      },
    },
    {
      type: 'custom',
      name: 'get_serp_profile',
      description: 'Force-fresh SERP profile for a (query, city) pair. Use only if the brief\'s cached serp_signal is stale.',
      input_schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          city: { type: 'string', description: 'Optional city for location-aware SERP' },
        },
      },
    },
    {
      type: 'custom',
      name: 'get_gsc_signal',
      description: 'Pull current gsc_queries data for a keyword or URL — impressions, CTR, position, top queries.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          page_url: { type: 'string' },
          days: { type: 'number', description: 'Lookback window (default 28)' },
        },
      },
    },
    {
      type: 'custom',
      name: 'get_customer_questions',
      description: 'Read customer_insight_clusters for a (city, service) pair. Returns clusters of paraphrased questions with source counts.',
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
      description: 'Search the Waves wiki / UF/IFAS-sourced knowledge base for technical accuracy. Use for any treatment, product rate, or pest biology claim.',
      input_schema: {
        type: 'object',
        required: ['topic'],
        properties: { topic: { type: 'string' } },
      },
    },
    {
      type: 'custom',
      name: 'check_existing_content',
      description: 'Check published + queued posts for content overlap on the proposed angle.',
      input_schema: {
        type: 'object',
        required: ['keyword'],
        properties: {
          keyword: { type: 'string' },
          city: { type: 'string' },
        },
      },
    },
    {
      type: 'custom',
      name: 'emit_draft',
      description: 'Submit the final draft. Call exactly ONCE at the end. The runner (not this agent) handles publishing.',
      input_schema: {
        type: 'object',
        required: ['frontmatter', 'body'],
        properties: {
          frontmatter: { type: 'object', description: 'Astro frontmatter — must satisfy packages/blog-schema/schema.json for blog posts' },
          body: { type: 'string', description: 'Markdown body' },
          schema: { type: 'object', description: 'JSON-LD schema block (LocalBusiness/Service/Article/etc. per page_type)' },
          notes_for_reviewer: { type: 'string', description: 'Anything a human reviewer should know if the gate flags this for review' },
        },
      },
    },
  ],
};

module.exports = { WRITER_AGENT_CONFIG };
