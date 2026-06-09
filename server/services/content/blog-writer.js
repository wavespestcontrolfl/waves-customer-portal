const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { CITIES } = require('./scoring-config');
const { _internals: uniq } = require('./uniqueness-gate');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ── idea-generation taxonomy & weighting ──────────────────────────────
//
// The model MUST pick a tag from this closed set. Before this constraint
// existed the generator invented its own labels run-to-run ("Fleas &
// Ticks" vs "Fleas", "Stinging Insects" vs "Flying Insects"), which
// fragments tag pages and the admin filter. normalizeTag() collapses the
// known variants back into the canonical label; anything unrecognized
// falls back to 'Pest Control'.
const BLOG_TAGS = [
  'Roaches', 'Ants', 'Rodents', 'Termites', 'Mosquitoes',
  'Fleas & Ticks', 'Stinging Insects', 'Spiders', 'Bed Bugs',
  'Lawn Disease', 'Lawn Pests', 'Lawn Care', 'Pest Control',
];

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

// Real Waves offices vs service-area-only markets. Idea volume should lean
// toward the staffed-office cities (they have spoke domains / GBP and
// convert), while still covering demand-driven service-area cities.
const STAFFED_CITIES = ['Bradenton', 'Lakewood Ranch', 'Sarasota', 'Venice', 'Parrish'];
const SERVICE_AREA_CITIES = (CITIES || []).filter((c) => !STAFFED_CITIES.includes(c));

// SWFL seasonal pest emphasis by month (0 = Jan). Keeps idea generation
// timely instead of pushing wasp content in December. Caller passes the
// current month so the engine biases toward what's actually active.
const SEASONAL_PESTS = {
  0: ['Rodents', 'Roaches', 'Termites (drywood)'],            // Jan
  1: ['Rodents', 'Ants', 'Termites (drywood)'],               // Feb
  2: ['Stinging Insects', 'Ants', 'Termites (subterranean swarms)'], // Mar
  3: ['Stinging Insects', 'Fleas & Ticks', 'Ants'],           // Apr
  4: ['Stinging Insects', 'Fleas & Ticks', 'Mosquitoes'],     // May
  5: ['Mosquitoes', 'Fleas & Ticks', 'Lawn Disease'],         // Jun
  6: ['Mosquitoes', 'Lawn Disease', 'Roaches'],               // Jul
  7: ['Mosquitoes', 'Lawn Disease', 'Roaches'],               // Aug
  8: ['Lawn Disease', 'Rodents', 'Stinging Insects'],         // Sep
  9: ['Rodents', 'Lawn Disease', 'Roaches'],                  // Oct
  10: ['Rodents', 'Roaches', 'Ants'],                         // Nov
  11: ['Rodents', 'Roaches', 'Termites (drywood)'],           // Dec
};

// Novelty gate — reject a candidate idea whose title+keyword 3-gram
// shingles overlap an existing post/idea (or an already-accepted sibling
// in the same batch) above this Jaccard threshold. Reuses the same
// shingle/jaccard primitives the autonomous publisher's uniqueness gate
// uses, so "German roaches Palmetto" and "German roach infestation
// Palmetto" collapse instead of both landing in the queue.
const IDEA_NOVELTY_JACCARD_MAX = 0.5;

function ideaCorpusText(row) {
  return `${row.title || ''} ${row.keyword || ''}`.trim();
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// City-stripped "concept key" — the dominant sprawl in the backlog is the
// SAME idea swapped across all 8 cities ("indoor cat fleas Port Charlotte"
// / "...North Port" / ...). Those read as near-zero shingle overlap because
// the city tokens differ, so the jaccard gate can't see them. Stripping the
// city + state tokens and keying on tag+concept lets us cap how many cities
// a single concept may fan across per batch.
const CITY_STRIP_RE = new RegExp(
  `\\b(${(CITIES || []).map((c) => c.toLowerCase()).join('|')}|fl|florida)\\b`,
  'g'
);

function conceptKey(idea) {
  const base = String(idea.keyword || idea.title || '').toLowerCase();
  const stripped = base.replace(CITY_STRIP_RE, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${normalizeTag(idea.tag)}::${stripped}`;
}

// Max cities a single concept may fan across (counting what's already in the
// library). Tiered so a strong concept CAN cover the priority/staffed-office
// markets, while service-area cities don't get the same idea spun into them
// unless a demand signal points there — that's what kills the "wall of
// identical roach posts" without starving legitimate local coverage.
const PRIORITY_CONCEPT_CITY_CAP = 3;
const SERVICE_AREA_CONCEPT_CITY_CAP = 1;

function conceptCapForCity(city) {
  return STAFFED_CITIES.includes(city)
    ? PRIORITY_CONCEPT_CITY_CAP
    : SERVICE_AREA_CONCEPT_CITY_CAP;
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

  async generatePost(blogPostId) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');

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

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { content: null, error: 'Anthropic API not configured' };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You write blog posts for Waves Pest Control, a pest control and lawn care company in Southwest Florida.

YOUR VOICE — study these real Waves blog titles and match the tone EXACTLY:
${(voice?.sample_titles || allTitles.map(t => t.title)).map(t => `• "${t}"`).join('\n')}

TONE RULES:
${(voice?.tone_rules || []).map(r => `- ${r}`).join('\n')}

SWFL-SPECIFIC KNOWLEDGE:
${voice?.swfl_knowledge ? Object.entries(voice.swfl_knowledge).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') : '- Sandy soil, afternoon thunderstorms, St. Augustine grass, nitrogen blackout June-Sept'}

FORMAT:
- 800-1200 words
- H2 subheadings every 200-300 words (casual, not keyword-stuffed)
- Short paragraphs (2-4 sentences max)
- Include 1-2 "pro tip" callouts
- Include a final "Frequently Asked Questions" section with 2-3 question-style H3s and direct answers
- Include the target keyword naturally 3-5 times
- End with a practical takeaway + soft Waves mention`;

    const response = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Write the full blog post for:

Title: ${post.title}
Target keyword: ${post.keyword}
Topic tag: ${post.tag}
City: ${post.city}
Meta description: ${post.meta_description}
Slug: ${post.slug}
${differentiationNote}
${similarPosts.length > 0 ? `\nHere are similar published posts for tone reference:\n${similarPosts.map(p => `---\nTitle: ${p.title}\n${(p.content || '').substring(0, 400)}...`).join('\n')}` : ''}

Write the full post in the Waves voice. Return ONLY the blog post content (no JSON wrapper). Use markdown formatting for headers.`
      }]
    });

    const content = response.content[0].text;
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    await db('blog_posts').where('id', blogPostId).update({
      content,
      word_count: wordCount,
      status: 'draft',
      updated_at: new Date(),
    });

    logger.info(`Blog post generated: "${post.title}" (${wordCount} words)`);
    return { content, wordCount };
  }

  async optimizeExistingPost(blogPostId) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { error: 'Anthropic API not configured' };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 3000,
      system: 'You optimize existing blog posts for Waves Pest Control. Improve SEO without changing core content. Match the Waves voice: snarky, casual, Florida-specific, technically knowledgeable.',
      messages: [{
        role: 'user',
        content: `Optimize this published blog post. Current SEO score: ${post.seo_score || 'unknown'}/100.

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
}`
      }]
    });

    let optimization;
    try {
      optimization = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
    } catch {
      optimization = { raw: response.content[0].text, parse_error: true };
    }

    await db('blog_posts').where('id', blogPostId).update({
      optimization_suggestions: JSON.stringify(optimization),
      updated_at: new Date(),
    });

    return optimization;
  }

  /**
   * Pull real demand signals from the autonomous content engine's scored
   * opportunity queue (GSC-mined queries + AEO gaps). This is what makes
   * idea generation demand-aware instead of "fill the coverage grid":
   * we ground new ideas in queries people actually search where Waves is
   * weak, rather than spinning the same pest concept across all 8 cities.
   * Degrades to [] if the table is absent (older deploys) or empty.
   */
  async getDemandSignals(limit = 25) {
    try {
      const hasTable = await db.schema.hasTable('opportunity_queue');
      if (!hasTable) return [];
      // Live, un-actioned opportunities. The queue's actionable states are
      // 'pending' (freshly mined) and 'pending_review' (awaiting human
      // triage); 'claimed'/'done'/'skipped' are out of play.
      //
      // Filter on action_type, NOT bucket. action_type is the queue's final
      // decision about what to DO: a content/AEO gap with no good existing
      // page is classified 'new_supporting_blog', while the same bucket on an
      // existing page becomes 'refresh_existing_page'. Keying off the bucket
      // would pull those refresh-only rows into idea generation and spawn new
      // posts the queue already says should refresh an existing page.
      // A query string is the strongest signal but isn't required — a
      // blog-shaped gap on a city+service is still one.
      return await db('opportunity_queue')
        .whereIn('status', ['pending', 'pending_review'])
        .whereIn('action_type', ['new_supporting_blog', 'create_customer_question_page'])
        .orderBy('score', 'desc')
        .limit(limit)
        .select('query', 'city', 'service', 'score', 'action_type', 'bucket');
    } catch (err) {
      logger.warn(`Blog idea demand-signal lookup failed: ${err.message}`);
      return [];
    }
  }

  async generateNewIdeas(count = 20) {
    count = Math.min(Math.max(Number.parseInt(count, 10) || 20, 1), 50);

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return [];
    }

    const existing = await db('blog_posts').select('title', 'keyword', 'tag', 'slug', 'city');
    const voice = await this.getVoiceConfig().catch(() => null);
    const demand = await this.getDemandSignals(25);

    // Coverage gaps (volume heuristic — kept as a SECONDARY priority,
    // below real demand).
    const tagCounts = {};
    const cityCounts = {};
    for (const p of existing) {
      if (p.tag) tagCounts[p.tag] = (tagCounts[p.tag] || 0) + 1;
      if (p.city) cityCounts[p.city] = (cityCounts[p.city] || 0) + 1;
    }
    const underrepTags = BLOG_TAGS.filter((t) => (tagCounts[t] || 0) < 8);
    const underrepCities = (CITIES || []).filter((c) => (cityCounts[c] || 0) < 19);

    const month = new Date().getMonth();
    const seasonal = SEASONAL_PESTS[month] || [];

    // Pre-build the existing-corpus shingle sets ONCE for the novelty gate.
    const existingShingles = existing.map((p) => uniq.shingles(ideaCorpusText(p)));
    const existingKeywords = new Set(
      existing.map((p) => String(p.keyword || '').toLowerCase().trim()).filter(Boolean)
    );
    const existingSlugs = new Set(
      existing.map((p) => String(p.slug || '').toLowerCase().trim()).filter(Boolean)
    );

    // Voice reference: a SMALL curated sample from voice config — NOT the
    // last 20 generated titles. Feeding generated titles back as the style
    // target is what amplified the one clickbait formula run-over-run.
    const voiceSamples = Array.isArray(voice?.sample_titles) ? voice.sample_titles.slice(0, 4) : [];
    const voiceBlock = voiceSamples.length
      ? `VOICE REFERENCE (for tone only — do NOT reuse their structure or topics):\n${voiceSamples.map((t) => `• "${t}"`).join('\n')}`
      : '';

    const demandBlock = demand.length
      ? `PRIORITY — REAL SEARCH DEMAND (ground ideas in these where they fit an educational blog; these are scored GSC/answer-engine gaps where Waves is weak):\n${demand
          .slice(0, 18)
          .map((d) => {
            const core = d.query ? `"${d.query}"` : `${d.service || 'pest'} content gap (${d.bucket})`;
            const loc = d.city ? ` — ${d.city}` : '';
            return `• ${core}${loc} (score ${d.score})`;
          })
          .join('\n')}`
      : 'No live demand signals available this run — lead with seasonality and coverage gaps below.';

    // Over-request so the novelty gate can reject near-dupes and still hit
    // the target count.
    const requestCount = Math.min(Math.ceil(count * 1.4), 60);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 6000,
      system: `You are the editorial planner for Waves Pest Control's local blog in Southwest Florida. Generate ${requestCount} genuinely distinct blog post ideas.

${voiceBlock}

${demandBlock}

EDITORIAL BRIEF — every idea must be a real, specific local problem, structured as: a concrete homeowner symptom → why it happens in THIS SWFL city/conditions → what actually fixes it. Not generic SEO filler.

ANTI-SAMENESS RULES (critical — the current backlog is a wall of near-identical titles):
- Do NOT open every title with "Your [City]…". No more than ${Math.max(2, Math.round(requestCount * 0.25))} titles may share the same opening structure. Vary it: questions, surprising claims, a number, a myth-bust, a "here's what's actually happening".
- A strong concept may cover up to 3 of the priority cities (${STAFFED_CITIES.join(', ')}) — but do NOT spin the same concept into a service-area city (${SERVICE_AREA_CITIES.join(', ')}) unless a demand signal above points there.
- Most ideas should still be a distinct angle, not just the same idea re-aimed at another city.

TARGETING:
- City must be one of: ${(CITIES || []).join(', ')}.
- Lean toward staffed-office cities (${STAFFED_CITIES.join(', ')}) unless a demand signal points at a service-area city (${SERVICE_AREA_CITIES.join(', ')}).
- Seasonal emphasis for this month: ${seasonal.length ? seasonal.join(', ') : 'no strong seasonal bias'}. Bias topic mix toward these unless a demand signal overrides.
- tag MUST be exactly one of this closed set (no new labels): ${BLOG_TAGS.join(', ')}.
- Secondary coverage gaps to help fill if nothing better: tags [${underrepTags.join(', ') || 'none'}], cities [${underrepCities.join(', ') || 'none'}].
- keyword = a specific local-intent search phrase. Avoid any of these existing keywords: ${[...existingKeywords].slice(0, 40).join('; ') || '(none yet)'}.

Return ONLY a JSON array, no prose: [{ "title": "", "keyword": "", "tag": "", "slug": "", "meta_description": "", "city": "" }]`,
      messages: [{
        role: 'user',
        content: `Generate ${requestCount} distinct, demand-aware, seasonally-relevant blog ideas. Reject your own duplicates before returning.`
      }]
    });

    let candidates;
    try {
      candidates = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
    } catch (err) {
      logger.error(`Blog idea generation: failed to parse model output: ${err.message}`);
      return [];
    }
    if (!Array.isArray(candidates)) return [];

    // Concept saturation — count how many cities each concept already
    // covers in the library, so we can cap cross-city fan-out per batch.
    const conceptCount = new Map();
    for (const p of existing) {
      const k = conceptKey(p);
      conceptCount.set(k, (conceptCount.get(k) || 0) + 1);
    }

    // ── novelty gate + normalization + insert ───────────────────────────
    const acceptedShingles = [];
    const accepted = [];
    let rejected = 0;

    for (const raw of candidates) {
      if (accepted.length >= count) break;
      if (!raw || !raw.title) { rejected++; continue; }

      const city = (CITIES || []).includes(raw.city) ? raw.city : null;
      const tag = normalizeTag(raw.tag);
      const keyword = String(raw.keyword || '').trim();
      const slug = slugify(raw.slug || raw.title);

      // Exact-dupe guards (covers short titles the shingle test can't).
      if (keyword && existingKeywords.has(keyword.toLowerCase())) { rejected++; continue; }
      if (slug && (existingSlugs.has(slug) || accepted.some((a) => a.slug === slug))) { rejected++; continue; }

      // Near-dupe guard via shared shingle/jaccard primitives.
      const sh = uniq.shingles(`${raw.title} ${keyword}`);
      const tooSimilar = [...existingShingles, ...acceptedShingles].some(
        (other) => uniq.jaccard(sh, other) > IDEA_NOVELTY_JACCARD_MAX
      );
      if (tooSimilar) { rejected++; continue; }

      // Concept-fan-out cap — a concept may cover up to 3 priority cities
      // but only 1 service-area city (existing library + this batch).
      const ckey = conceptKey({ tag, keyword, title: raw.title });
      if ((conceptCount.get(ckey) || 0) >= conceptCapForCity(city)) { rejected++; continue; }

      const row = {
        title: String(raw.title).trim(),
        keyword: keyword || null,
        tag,
        slug: slug || null,
        meta_description: raw.meta_description ? String(raw.meta_description).trim() : null,
        city,
        status: 'idea',
        source: demand.length ? 'demand_mined' : 'ai_generated',
      };

      await db('blog_posts').insert(row);
      accepted.push(row);
      acceptedShingles.push(sh);
      conceptCount.set(ckey, (conceptCount.get(ckey) || 0) + 1);
      if (keyword) existingKeywords.add(keyword.toLowerCase());
      if (slug) existingSlugs.add(slug);
    }

    logger.info(
      `Blog idea generation: ${accepted.length} inserted, ${rejected} rejected as near-duplicate/invalid ` +
      `(${candidates.length} candidates, ${demand.length} demand signals, season=[${seasonal.join(',')}])`
    );

    return accepted;
  }
}

const blogWriter = new BlogWriter();

// Pure helpers exposed for unit testing the idea-generation gate.
blogWriter._internals = {
  BLOG_TAGS,
  normalizeTag,
  conceptKey,
  slugify,
  SEASONAL_PESTS,
  STAFFED_CITIES,
  IDEA_NOVELTY_JACCARD_MAX,
  conceptCapForCity,
  PRIORITY_CONCEPT_CITY_CAP,
  SERVICE_AREA_CONCEPT_CITY_CAP,
};

module.exports = blogWriter;
