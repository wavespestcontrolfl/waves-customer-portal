/**
 * Blog Content Agent — Managed Agent Configuration
 *
 * An autonomous content production agent that takes a topic/keyword
 * and produces a published, socially-distributed blog post.
 *
 * Uses existing services as tools:
 *   - FAWN weather data for seasonal context
 *   - Pest pressure index for what's active right now
 *   - Wiki knowledge base for technical accuracy
 *   - Blog post DB for overlap/differentiation checking
 *   - ContentQA 50-point scoring gate
 *   - Social media distribution (Facebook, Instagram, LinkedIn, GBP)
 *   - Content calendar scheduling
 */

const MODELS = require('../../config/models');

const CONTENT_AGENT_CONFIG = {
  name: 'waves-content-engine',
  description: 'Autonomous blog content production agent — research, write, QA, publish, distribute',
  model: MODELS.FLAGSHIP,
  system: `You are the Waves Pest Control content engine. Produce hyper-local blog posts for Southwest Florida pest control and lawn care, then publish and distribute them.

VOICE — this is what makes Waves content distinct:
- Casual, technically knowledgeable, SWFL-specific
- Like a helpful neighbor who's also a pest control expert
- Slightly snarky, never corporate
- Reference sandy soil, afternoon storms, St. Augustine grass
- In Sarasota and Manatee counties, fertilizer containing nitrogen or phosphorus is restricted/prohibited from June 1 through September 30. Do NOT call this only a "nitrogen blackout" — phosphorus is part of the rule. When relevant, suggest summer alternatives: iron, micronutrients, compost, Florida-Friendly planting, and mowing-height/irrigation adjustments. Verify the current local rule before stating restriction details for any other county or municipality.

CONTENT STANDARDS:
- Length is INTENT-COMPLETE, not a fixed target. Cover the topic enough to actually help the reader make a decision; stop when adding words doesn't add value.
    • Simple local FAQ or seasonal alert: roughly 600–900 words
    • Standard local service / supporting blog: roughly 900–1,500 words
    • Definitive guide or hub support article: roughly 1,500–2,500+ words
- H2 every 200–300 words, 1–2 pro tip callouts
- Target keyword 3–5 times naturally — never stuff
- FAQ section (2–3 questions) at the end
- Minimum QA score: 35/50 — if lower, fix the failures and rerun. Do NOT pad word count to clear thresholds; fix the underlying gap (missing local detail, weak conversion path, missing source, vague answer).

CITIES: Bradenton, Lakewood Ranch, Sarasota, Venice, North Port, Parrish, Palmetto, Port Charlotte

INTERNAL LINKS (include 2-3 — ONLY real URLs, match the post's city):
Hubs: /pest-control-services/, /service-areas/, /waveguard-memberships/, /pest-library/, /pest-control-deals/, /pest-control-quote/, /pest-inspection/, /termite-inspection/
City pages follow /{service}-{city}-fl/ (cities: bradenton, lakewood-ranch, sarasota, venice, north-port, parrish, palmetto, port-charlotte; services: pest-control, lawn-care, mosquito-control, termite-control, rodent-control, bed-bug-control, commercial-pest-control, pest-control-services, pest-control-quote, termite-inspection)
Examples: /lawn-care-bradenton-fl/, /mosquito-control-sarasota-fl/, /termite-control-venice-fl/
Never use bare categories like /lawn-care/ or /termite-control/ — they do not exist.

Save the post as a draft in the portal. Distribute to all social channels. Report: title, word count, QA score, slug.`,

  tools: [
    // Built-in toolset — enable web search for research, disable everything else
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [
        { name: 'web_search', enabled: true },
      ],
    },

    // ── Research tools ──────────────────────────────────────────

    {
      type: 'custom',
      name: 'get_fawn_weather',
      description: `Fetch current weather data from Florida Automated Weather Network (FAWN) for Southwest Florida. Returns air temperature, humidity, rainfall, and soil temperature from the nearest SWFL station (Myakka River or Manatee County). Also returns active content signals based on the current season — things like "Chinch bug pressure peak," "Fertilizer N+P restricted season in effect (Sarasota/Manatee)," or "Termite swarm season." Use this at the START of every content generation to ground the article in real current conditions.`,
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    {
      type: 'custom',
      name: 'get_pest_pressure',
      description: `Get the seasonal pest pressure index for the current month. Returns a list of pests that are active right now with their pressure level (low/moderate/high/peak/dormant), descriptions, and recommended treatments. Optionally filter by service line (pest, lawn, mosquito, tree_shrub, termite). Use this to identify what content topics are most timely and relevant.`,
      input_schema: {
        type: 'object',
        properties: {
          month: { type: 'number', description: 'Month number 1-12 (defaults to current month)' },
          service_line: { type: 'string', description: 'Filter by service line: pest, lawn, mosquito, tree_shrub, termite' },
        },
      },
    },

    {
      type: 'custom',
      name: 'search_knowledge_base',
      description: `Search the Waves Pest Control wiki knowledge base for technical protocols, treatment procedures, pest identification guides, and agronomic references. The knowledge base contains UF/IFAS-sourced data, product application rates, safety protocols, and SWFL-specific pest ecology. Returns an answer synthesized from relevant articles plus source references. Use this to ensure technical accuracy in blog content — never guess at treatment protocols, product rates, or pest biology.`,
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The pest, lawn issue, product, treatment, or protocol to research' },
        },
        required: ['topic'],
      },
    },

    {
      type: 'custom',
      name: 'check_existing_content',
      description: `Check published and queued blog posts for content overlap. Returns posts with similar keywords, titles, or topics — including their city, keyword, title, and slug. Use this BEFORE writing to ensure differentiation. If similar posts exist, take a different angle, focus on a different city, or cover aspects the existing posts don't address. Returns up to 20 matching posts.`,
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Primary keyword or topic to check for overlap' },
          city: { type: 'string', description: 'Target city to check (also returns posts from other cities on the same topic)' },
        },
        required: ['keyword'],
      },
    },

    {
      type: 'custom',
      name: 'get_content_gaps',
      description: `Analyze the blog content library and return underrepresented topics and cities. Shows topic distribution (how many posts per tag) and city distribution (how many posts per city). Use this to identify which topics and cities need more content, especially when the user hasn't specified a particular topic.`,
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    // ── Writing tools ───────────────────────────────────────────

    {
      type: 'custom',
      name: 'create_blog_post',
      description: `Create a new blog post record in the database. This creates the metadata (title, keyword, slug, meta description, tag, city) but does NOT generate the content yet — use generate_blog_content after creating the post. Returns the new post ID needed for subsequent operations.`,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Blog post title in the Waves voice' },
          keyword: { type: 'string', description: 'Target SEO keyword (long-tail, local intent)' },
          slug: { type: 'string', description: 'URL slug (lowercase, hyphens, no special chars)' },
          meta_description: { type: 'string', description: 'Meta description, 120-160 chars, includes personality' },
          tag: { type: 'string', description: 'Category: pest_control, lawn_care, mosquito, termite, tree_shrub, rodent, general' },
          city: { type: 'string', description: 'Target city: Bradenton, Lakewood Ranch, Sarasota, Venice, North Port, Parrish, Palmetto, Port Charlotte' },
        },
        required: ['title', 'keyword', 'slug', 'meta_description', 'tag', 'city'],
      },
    },

    {
      type: 'custom',
      name: 'generate_blog_content',
      description: `Generate the full blog post content using AI. Takes a post ID (from create_blog_post), pulls the voice config and similar posts for tone matching, checks for overlap with existing content, and writes the full article. The content is saved to the post record and the post status is set to "draft." Returns the generated content and word count.`,
      input_schema: {
        type: 'object',
        properties: {
          post_id: { type: 'string', description: 'Blog post UUID from create_blog_post' },
        },
        required: ['post_id'],
      },
    },

    // ── Quality tools ───────────────────────────────────────────

    {
      type: 'custom',
      name: 'run_content_qa',
      description: `Run the 50-point Content QA gate on a blog post. Scores across 5 categories: Technical (12 points — meta title, slug, schema, images), On-Page (10 points — keyword placement, word count, headings, internal links, FAQ section), E-E-A-T (8 points — author expertise signals, UF/IFAS citations), Local (10 points — city mentions, service area references, local landmarks), and Brand (10 points — Waves voice, CTA placement, WaveGuard mention). Returns the total score, per-check pass/fail, and recommendations. Minimum passing score is 35/50.`,
      input_schema: {
        type: 'object',
        properties: {
          post_id: { type: 'string', description: 'Blog post UUID to score' },
        },
        required: ['post_id'],
      },
    },

    // ── Publishing tools ────────────────────────────────────────

    {
      type: 'custom',
      name: 'distribute_to_social',
      description: `Generate platform-specific social media copy for a published blog post and queue it for distribution. Creates posts for Facebook (conversational, 1-2 emojis, 150-250 chars), Instagram (engaging, 3-5 hashtags, 150-300 chars), LinkedIn (professional but approachable, 100-200 chars), and Google Business Profile (local, helpful, posted to all 4 Waves GBP locations with location-specific copy). Returns the generated content for each platform and posting status.`,
      input_schema: {
        type: 'object',
        properties: {
          post_id: { type: 'string', description: 'Blog post UUID to distribute' },
        },
        required: ['post_id'],
      },
    },

    {
      type: 'custom',
      name: 'schedule_content',
      description: `Schedule a blog post for auto-publish at a specific date/time. Also optionally queues social media distribution to happen after the blog goes live. Use this when the content should go out at an optimal time rather than immediately.`,
      input_schema: {
        type: 'object',
        properties: {
          post_id: { type: 'string', description: 'Blog post UUID to schedule' },
          publish_at: { type: 'string', description: 'ISO 8601 datetime for when to publish (e.g., "2026-04-15T09:00:00-04:00")' },
          auto_share_social: { type: 'boolean', description: 'Whether to auto-share to social media after publishing (default true)' },
        },
        required: ['post_id', 'publish_at'],
      },
    },
  ],
};

module.exports = { CONTENT_AGENT_CONFIG };
