const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const topicGate = require('./topic-targeting-gate');
const { isFaqBlockedService } = require('./content-guardrails');
const { dispatchWithFallback } = require('../llm/call');

// ── blog tag taxonomy ─────────────────────────────────────────────────
//
// The closed tag set. Free-form labels ("Fleas & Ticks" vs "Fleas",
// "Stinging Insects" vs "Flying Insects") fragment tag pages and the admin
// filter. normalizeTag() collapses the known variants back into the
// canonical label; anything unrecognized falls back to 'Pest Control'.
const BLOG_TAGS = [
  'Roaches', 'Ants', 'Rodents', 'Termites', 'Mosquitoes',
  'Fleas & Ticks', 'Stinging Insects', 'Spiders', 'Bed Bugs',
  'Lawn Disease', 'Lawn Pests', 'Lawn Care', 'Pest Control',
];

// Row → canonical blog category (explicit category first, then tag), so the
// topic-targeting gate judges entity ownership within the same category the
// publisher will use. Single source: the publisher's own frontmatter mapping
// (lazy — the publisher is a heavy module).
function categoryForRow({ category = null, tag = null } = {}) {
  const { normalizeCategory } = require('../content-astro/astro-publisher');
  return normalizeCategory(category, tag) || null;
}

const TAG_ALIASES = new Map([
  ['cockroach', 'Roaches'], ['cockroaches', 'Roaches'], ['roach', 'Roaches'],
  ['palmetto bug', 'Roaches'], ['german roach', 'Roaches'],
  ['flea', 'Fleas & Ticks'], ['fleas', 'Fleas & Ticks'], ['tick', 'Fleas & Ticks'],
  ['ticks', 'Fleas & Ticks'], ['fleas and ticks', 'Fleas & Ticks'],
  ['wasp', 'Stinging Insects'], ['wasps', 'Stinging Insects'], ['bee', 'Stinging Insects'],
  ['bees', 'Stinging Insects'], ['hornet', 'Stinging Insects'], ['hornets', 'Stinging Insects'],
  ['yellow jacket', 'Stinging Insects'], ['yellow jackets', 'Stinging Insects'],
  ['flying insects', 'Stinging Insects'], ['stinging insects', 'Stinging Insects'],
  ['rodent', 'Rodents'], ['rat', 'Rodents'], ['rats', 'Rodents'], ['mouse', 'Rodents'], ['mice', 'Rodents'],
  ['termite', 'Termites'], ['termites', 'Termites'], ['wdo', 'Termites'],
  ['mosquito', 'Mosquitoes'], ['mosquitos', 'Mosquitoes'],
  ['ant', 'Ants'], ['spider', 'Spiders'], ['bed bug', 'Bed Bugs'], ['bedbug', 'Bed Bugs'],
  ['lawn fungus', 'Lawn Disease'], ['lawn pest', 'Lawn Pests'], ['lawn care', 'Lawn Care'],
]);

// Word-boundary matchers for the fuzzy alias pass. Substring matching wrongly
// mapped out-of-taxonomy labels to the wrong tag (e.g. "Plant Health" and
// "important info" both became Ants via the "ant" alias); \b...\b prevents
// that — a near-miss that doesn't match a whole alias token falls back to the
// documented 'Pest Control'.
const TAG_ALIAS_PATTERNS = [...TAG_ALIASES].map(([alias, canon]) => [
  new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  canon,
]);

// Case-insensitive lookup of the canonical labels, so model output like
// "roaches", "ants", or "LAWN DISEASE" resolves to its canonical tag instead
// of falling through to Pest Control (which would flatten the taxonomy this
// change is meant to enforce).
const BLOG_TAG_BY_LOWER = new Map(BLOG_TAGS.map((t) => [t.toLowerCase(), t]));

function normalizeTag(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (BLOG_TAG_BY_LOWER.has(key)) return BLOG_TAG_BY_LOWER.get(key);
  if (TAG_ALIASES.has(key)) return TAG_ALIASES.get(key);
  for (const [pattern, canon] of TAG_ALIAS_PATTERNS) {
    if (pattern.test(key)) return canon;
  }
  return 'Pest Control';
}

// ── FAQ-section policy (must mirror content-guardrails) ───────────────
//
// publishAstro runs content-guardrails with service: [post.category,
// post.tag]; any FAQ section on a FAQ-blocked topic ("Rodents", "Termites",
// "Spiders", "Bed Bugs", …) is a P0 → BLOG_GUARDRAILS_FAILED →
// publish_failed. An unconditional "include an FAQ section" prompt therefore
// made every generated post in those tags deterministically unpublishable.
// The guardrail is the policy (those services must never get FAQ sections),
// so the GENERATOR conditions on the same imported isFaqBlockedService —
// single source of truth, the two can never drift.
const FAQ_SECTION_INSTRUCTION = '- Include a final "Frequently Asked Questions" section with 2-3 question-style H3s and direct answers';
const NO_FAQ_SECTION_INSTRUCTION = '- Do NOT include any FAQ section. No "Frequently Asked Questions", "FAQ", or "Common Questions" heading or Q&A block anywhere in the post — this topic is on the FAQ-blocked services list and the publish guardrail hard-fails any FAQ section on it. Cover reader questions inline as regular prose/H2 sections instead';

function faqFormatInstruction(serviceFields) {
  return isFaqBlockedService(serviceFields) ? NO_FAQ_SECTION_INSTRUCTION : FAQ_SECTION_INSTRUCTION;
}

// A blog_posts row is writable by the generator only while it is OUTSIDE the
// publish pipeline. publish_status='publishing' (scheduler) and a live
// publish_claimed_at (manual /publish-astro) both mean a publisher owns the
// row while publishAstro runs — the branch/PR markers don't exist yet, but the
// publisher already captured the row's content; overwriting now would ship a
// PR whose source differs from the database. Used as the CAS predicate on
// every generator write (generated content, topic-gate de-queue).
// The columns the topic gate reads from a row. The block de-queue is fenced
// on them: an operator fix that lands while the live corpus loads must not be
// reset to idea with a verdict about the OLD targeting.
const TARGETING_COLUMNS = ['title', 'keyword', 'slug', 'tag', 'category', 'city', 'meta_description', 'content'];
// Compared by value, fenced through updated_at (every admin edit bumps it)
// rather than bound in SQL.
const TARGETING_VALUE_FIELDS = ['secondary_keywords'];
function whereTargetingUnchanged(query, snapshot) {
  for (const col of TARGETING_COLUMNS) {
    query = snapshot[col] === null || snapshot[col] === undefined ? query.whereNull(col) : query.where(col, snapshot[col]);
  }
  // pg materializes timestamps as ms-precision Dates while Postgres keeps
  // microseconds — compare at the DB side truncated to ms, or an untouched
  // row would never match.
  if (snapshot.updated_at instanceof Date && !Number.isNaN(snapshot.updated_at.getTime())) {
    query = query.whereRaw("date_trunc('milliseconds', updated_at) = ?", [snapshot.updated_at]);
  }
  return query;
}
function targetingChanged(before, after) {
  return TARGETING_COLUMNS.some((col) => (before[col] ?? null) !== (after[col] ?? null))
    || TARGETING_VALUE_FIELDS.some((col) => JSON.stringify(before[col] ?? null) !== JSON.stringify(after[col] ?? null));
}

function whereOutsideAstroPipeline(query) {
  return query
    .whereNot('status', 'published')
    .where((q) => q.whereNull('publish_status').orWhereNot('publish_status', 'publishing'))
    .where((q) => q.whereNull('publish_claimed_at')
      .orWhere('publish_claimed_at', '<', new Date(Date.now() - 30 * 60 * 1000)))
    .whereNull('astro_pr_number')
    .whereNull('astro_branch_name')
    .where((q) => q.whereNull('astro_status')
      .orWhereNotIn('astro_status', ['pr_open', 'build_failed', 'merged', 'live', 'unpublish_pending']));
}

class BlogWriter {
  async getVoiceConfig() {
    const config = await db('blog_voice_config').where('active', true).first();
    if (!config) return null;
    return {
      ...config,
      sample_titles: typeof config.sample_titles === 'string' ? JSON.parse(config.sample_titles) : config.sample_titles,
      sample_metas: typeof config.sample_metas === 'string' ? JSON.parse(config.sample_metas) : config.sample_metas,
      tone_rules: typeof config.tone_rules === 'string' ? JSON.parse(config.tone_rules) : config.tone_rules,
      swfl_knowledge: typeof config.swfl_knowledge === 'string' ? JSON.parse(config.swfl_knowledge) : config.swfl_knowledge,
    };
  }

  // `index`: a live topic index the caller already loaded (bulk generation
  // loads it once per batch); omitted → the gate loads it itself.
  async generatePost(blogPostId, { index = null } = {}) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');

    // Owner rulings 2026-08-27 — every persisted row (idea lane, admin
    // generator, operator-edited, the 5 a.m. queue) passes the topic-
    // targeting gate BEFORE any writer spend. No verifiable live corpus →
    // throw (fail closed; the caller logs and the row stays queued). A
    // block de-queues the row (status → idea, reason recorded) so the 5 a.m.
    // picker never wedges on it.
    const topic = await topicGate.evaluateBlogPostRow(post, { category: categoryForRow(post), index });
    if (!topic.ok) {
      const summary = topic.findings.map((f) => `${f.severity} ${f.code} — ${f.message}`).join('; ');
      // Same CAS as the generated-content write below (the corpus load was
      // async): a row that entered the publish pipeline meanwhile must not be
      // yanked back to idea, and a row whose targeting an operator fixed
      // meanwhile must not be stamped with a verdict about the old fields.
      const dequeued = await whereTargetingUnchanged(whereOutsideAstroPipeline(db('blog_posts').where('id', blogPostId)), post).update({
        status: 'idea',
        astro_publish_error: `BLOG_TOPIC_TARGETING_BLOCKED: ${summary}`.slice(0, 1000),
        updated_at: new Date(),
      });
      if (!dequeued) {
        const now = await db('blog_posts').where('id', blogPostId).first();
        const edited = now && targetingChanged(post, now);
        const err = new Error(edited
          ? 'Post targeting was edited while the topic gate ran — nothing was changed; re-run generation on the edited row'
          : 'Post was published or entered the Astro pipeline while the topic gate ran — nothing was changed');
        err.isOperational = true;
        err.statusCode = 409;
        throw err;
      }
      const e = new Error(`topic-targeting gate blocked "${post.title}": ${summary}`);
      e.code = 'BLOG_TOPIC_TARGETING_BLOCKED';
      e.details = topic.findings;
      // Author-correctable (the row is back at idea with the reason): an
      // operational 400 like publish-astro, not a generic 500.
      e.isOperational = true;
      e.statusCode = 400;
      throw e;
    }

    const voice = await this.getVoiceConfig();

    // Get similar published posts for tone reference
    const similarPosts = await db('blog_posts')
      .where('tag', post.tag)
      .where('status', 'published')
      .whereNotNull('content')
      .where('word_count', '>', 200)
      .orderBy('seo_score', 'desc')
      .limit(3)
      .select('title', 'meta_description', 'content');

    // Get all titles for tone calibration
    const allTitles = await db('blog_posts')
      .whereNotNull('meta_description')
      .orderBy('seo_score', 'desc')
      .limit(30)
      .select('title', 'meta_description');

    // Check for existing published content on this topic (overlap check)
    const existingOnTopic = await db('blog_posts')
      .where('status', 'published')
      .where(function () {
        const kw = (post.keyword || '').toLowerCase();
        if (kw.length > 3) {
          this.whereRaw('LOWER(keyword) LIKE ?', [`%${kw}%`]);
        }
      })
      .select('title', 'keyword', 'city', 'slug');

    let differentiationNote = '';
    if (existingOnTopic.length > 0) {
      differentiationNote = `\n\nIMPORTANT: We already have published content on similar topics:\n${existingOnTopic.map(e => `- "${e.title}" (${e.city}) targeting "${e.keyword}"`).join('\n')}\n\nYour post MUST differentiate by:\n- Focusing specifically on ${post.city} (not the cities above)\n- Taking a different angle or subtopic\n- Covering aspects the existing posts don't\n- DO NOT repeat the same core advice — add new value`;
    }

    const { HUMAN_PROSE_RULES } = require('../llm/human-prose-rules');
    const systemPrompt = `You write blog posts for Waves Pest Control, a pest control and lawn care company in Southwest Florida.

${HUMAN_PROSE_RULES}


YOUR VOICE — study these real Waves blog titles and match the tone EXACTLY:
${(voice?.sample_titles || allTitles.map(t => t.title)).map(t => `• "${t}"`).join('\n')}

TONE RULES:
${(voice?.tone_rules || []).map(r => `- ${r}`).join('\n')}

SWFL-SPECIFIC KNOWLEDGE:
${voice?.swfl_knowledge ? Object.entries(voice.swfl_knowledge).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') : '- Sandy soil, afternoon thunderstorms, St. Augustine grass, nitrogen blackout June-Sept'}

CLAIMS RULES (the publish guardrail hard-fails violations):
- Never name a professional pesticide product or active ingredient (Advion,
  Termidor, indoxacarb, fipronil, …) and never claim what Waves technicians
  carry or use — describe the product class generically and defer to the
  label. Consumer brands only in cautionary "don't do this" context.
- Never promise prevention or elimination ("prevents them from coming back",
  "pest-free for good", "100% effective"). The offer is reduced recurrence
  plus free re-treatment between visits — always conditional.
- Any DIY pesticide instruction must say: follow the label, keep it off
  food-contact surfaces, keep it away from children and pets. Species-dependent
  treatment advice must make identification a prerequisite.

FORMAT:
- 800-1200 words
- H2 subheadings every 200-300 words (casual, not keyword-stuffed)
- Short paragraphs (2-4 sentences max)
- Include 1-2 "pro tip" callouts
${faqFormatInstruction([post.category, post.tag])}
- Include the target keyword naturally 3-5 times
- End with a practical takeaway + soft Waves mention`;

    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.websiteContent, {
      laneId: 'blog_draft',
      maxTokens: 3000,
      jsonMode: false,
      system: systemPrompt,
      text: `Write the full blog post for:

Title: ${post.title}
Target keyword: ${post.keyword}
Topic tag: ${post.tag}
City: ${post.city}
Meta description: ${post.meta_description}
Slug: ${post.slug}
${differentiationNote}
${similarPosts.length > 0 ? `\nHere are similar published posts for tone reference:\n${similarPosts.map(p => `---\nTitle: ${p.title}\n${(p.content || '').substring(0, 400)}...`).join('\n')}` : ''}

Write the full post in the Waves voice. Return ONLY the blog post content (no JSON wrapper). Use markdown formatting for headers.`,
    });
    if (!response.ok) return { content: null, error: 'AI content providers unavailable' };

    const content = response.text;
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    // CAS'd write: the AI call above is long, and a post can be published or
    // enter the Astro pipeline (PR opened, merged, gone live) while it runs.
    // Overwriting then would destroy the live article's source text and
    // force a live post back to draft — so the overwrite only lands while
    // the row is still outside the pipeline. Callers on the queued lane
    // (scheduler 5am, bulk-generate, content-agent) are unaffected.
    // …and on the SAME targeting snapshot the gate and the LLM used: content
    // approved and written for the old title/keyword/slug/city/category must
    // not land on a row an operator re-targeted meanwhile.
    const updated = await whereTargetingUnchanged(whereOutsideAstroPipeline(db('blog_posts').where('id', blogPostId)), post)
      .update({
        content,
        word_count: wordCount,
        status: 'draft',
        updated_at: new Date(),
      });
    if (!updated) {
      const now = await db('blog_posts').where('id', blogPostId).first();
      const edited = now && targetingChanged(post, now);
      const err = new Error(edited
        ? 'Post targeting was edited while content was generating — nothing was overwritten; re-run generation on the edited row'
        : 'Post was published or entered the Astro pipeline while content was generating — nothing was overwritten');
      err.isOperational = true;
      err.statusCode = 409;
      throw err;
    }

    logger.info(`Blog post generated: "${post.title}" (${wordCount} words)`);
    return { content, wordCount };
  }

  async optimizeExistingPost(blogPostId) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');

    const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.deepAnalysis, {
      laneId: 'blog_optimize',
      // Documented DEEP floor — MODEL_DEEP may point at a thinking model
      // (fable line) where thinking spends from the same token budget, so a
      // sub-4096 cap can starve the visible JSON.
      maxTokens: 4096,
      jsonMode: true,
      system: 'You optimize existing blog posts for Waves Pest Control. Improve SEO without changing core content. Match the Waves voice: snarky, casual, Florida-specific, technically knowledgeable. If you rewrite the meta_description (owner rule 2026-07-29): 115-160 characters, informational, NO phone number, nothing salesy ("free estimate", "call now", "book today"), and it must END with a soft CTA like "Learn more on the Waves blog."',
      text: `Optimize this published blog post. Current SEO score: ${post.seo_score || 'unknown'}/100.

TITLE: ${post.title}
KEYWORD: ${post.keyword || 'NOT SET — suggest one'}
META: ${post.meta_description || 'MISSING — write one'}
CITY: ${post.city || 'NOT SET — detect from content'}
WORD COUNT: ${post.word_count}

CONTENT (first 5000 chars):
${(post.content || '').substring(0, 5000)}

EXISTING INTERNAL LINKS: ${(post.content_html || '').match(/href="https?:\/\/wavespestcontrol\.com/g)?.length || 0}

Available internal link targets (ONLY link to URLs that actually exist — match the post's city when possible):

Hubs:
- wavespestcontrol.com/pest-control-services/
- wavespestcontrol.com/service-areas/
- wavespestcontrol.com/waveguard-memberships/
- wavespestcontrol.com/pest-library/
- wavespestcontrol.com/pest-control-deals/
- wavespestcontrol.com/pest-control-quote/
- wavespestcontrol.com/pest-inspection/
- wavespestcontrol.com/termite-inspection/
- wavespestcontrol.com/waves-guarantee/
- wavespestcontrol.com/faqs/

City service pages — pattern: /{service}-{city}-fl/
- Cities: bradenton, lakewood-ranch, sarasota, venice, north-port, parrish, palmetto, port-charlotte
- Services: pest-control, lawn-care, mosquito-control, termite-control, rodent-control, bed-bug-control, termite-inspection, commercial-pest-control, pest-control-services, pest-control-quote
- Examples: /lawn-care-bradenton-fl/, /mosquito-control-sarasota-fl/, /termite-control-venice-fl/, /rodent-control-parrish-fl/

Lawn/tree specialty (Bradenton only for these exact slugs):
- /tree-and-shrub-care-bradenton-fl/
- /palm-tree-injections-bradenton-fl/
- /lawn-aeration-bradenton-fl/, /lawn-aeration-lakewood-ranch-fl/

Rules: Never invent URLs. Never link to bare categories like /lawn-care/ or /termite-control/ — they do not exist. Always use the city-suffixed slug matching the post's target city.

Return JSON: {
  "suggested_title": "better title in Waves voice (or null if good)",
  "suggested_keyword": "focus keyword if missing",
  "suggested_meta": "meta description under 160 chars with personality",
  "missing_internal_links": [{"anchor_text": "", "url": "", "insert_near": "context"}],
  "faq_to_add": [{"question": "", "answer": ""}],
  "seo_improvements": ["specific fix"],
  "estimated_new_score": 0
}`,
    });
    if (!response.ok) return { error: 'AI optimization providers unavailable' };

    const optimization = response.json;

    await db('blog_posts').where('id', blogPostId).update({
      optimization_suggestions: JSON.stringify(optimization),
      updated_at: new Date(),
    });

    return optimization;
  }
}

const blogWriter = new BlogWriter();

// Pure helpers exposed for unit testing.
blogWriter._internals = {
  BLOG_TAGS,
  faqFormatInstruction,
  FAQ_SECTION_INSTRUCTION,
  NO_FAQ_SECTION_INSTRUCTION,
  normalizeTag,
  categoryForRow,
};

module.exports = blogWriter;
