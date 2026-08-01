/**
 * Knowledge Bridge Service
 *
 * Bridges Claudeopedia (knowledge_base) ↔ Agronomic Wiki (knowledge_entries).
 *
 * Claudeopedia is the general-purpose KB: products, protocols, pest IDs,
 * UF/IFAS references, business SOPs — mostly manually curated or AI-seeded.
 *
 * Agronomic Wiki is outcome-driven: auto-generated pages from real treatment
 * outcomes linked to lawn assessment before/after data.
 *
 * The bridge:
 *  1. Cross-references entries between the two systems
 *  2. Enriches wiki pages with Claudeopedia reference data (MOA, FRAC, protocols)
 *  3. Enriches Claudeopedia entries with real outcome stats from the wiki
 *  4. Provides unified search across both
 *  5. Powers contextual recommendations on lawn assessments
 */

const db = require('../models/db');
const logger = require('./logger');
const { loadCustomerGrassContext } = require('./lawn-grass-context');
const { TRUSTED_STATUSES } = require('./agronomic-wiki');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODEL = require('../config/models').FLAGSHIP;
const { ROUTES } = require('../config/models');
const { dispatch } = require('./llm/call');

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 190);
}

async function callClaude(systemPrompt, userPrompt, maxTokens = 2048) {
  // Live model — GPT-5.5 (ROUTES.knowledgeAnswer). callClaude's sole caller
  // (generateAssessmentRecommendations) strict-JSON.parses the result, so require
  // PARSEABLE JSON here: dispatch with jsonMode and return the normalized JSON string.
  // Invalid/preamble OpenAI output → { ok:false } → fall through to the Claude
  // fallback below rather than returning text the caller can't parse.
  {
    const r = await dispatch(ROUTES.knowledgeAnswer, { system: systemPrompt, text: userPrompt, jsonMode: true, maxTokens });
    if (r.ok && r.json) return JSON.stringify(r.json);
  }
  // Fallback — Claude (FLAGSHIP).
  if (!Anthropic) return null;
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return response.content?.[0]?.text || null;
  } catch (err) {
    logger.error(`[knowledge-bridge] Claude call failed: ${err.message}`);
    return null;
  }
}

// Trust gates shared by the FTS and ILIKE paths of unifiedSearch.
// Agent-facing callers pass trustedOnly so red pages awaiting review never
// feed an agent; the admin browse/review UI omits it and sees everything.
function applyKbTrustGate(queryBuilder, trustedOnly) {
  if (!trustedOnly) return queryBuilder;
  // Wiki-sync MIRRORS inherit the wiki's review gate on agent-facing
  // reads; merely-linked curated articles stay visible.
  return queryBuilder.whereNot(function untrustedWikiMirror() {
    this.where('source', 'wiki-sync').whereIn(
      'wiki_entry_id',
      db('knowledge_entries').select('id').whereNotIn('review_status', TRUSTED_STATUSES),
    );
  });
}

function applyWikiTrustGate(queryBuilder, trustedOnly) {
  if (!trustedOnly) return queryBuilder;
  return queryBuilder.whereIn('review_status', TRUSTED_STATUSES);
}

const KB_SEARCH_COLUMNS = ['id', 'slug', 'title', 'category', 'confidence', 'updated_at', 'wiki_entry_id'];
const WIKI_SEARCH_COLUMNS = ['id', 'slug', 'title', 'category', 'confidence', 'data_point_count', 'updated_at', 'kb_entry_id', 'review_tier', 'review_status'];

function kbFtsQuery(q, trustedOnly, limit) {
  return applyKbTrustGate(
    db('knowledge_base')
      .whereRaw("search_vector @@ websearch_to_tsquery('english', ?)", [q])
      .where({ status: 'active' }),
    trustedOnly,
  )
    .select(...KB_SEARCH_COLUMNS, db.raw("ts_rank(search_vector, websearch_to_tsquery('english', ?)) as rank", [q]))
    .orderBy('rank', 'desc')
    .orderBy('updated_at', 'desc')
    .limit(limit);
}

function kbIlikeQuery(term, trustedOnly, limit) {
  return applyKbTrustGate(
    db('knowledge_base')
      .where(function () {
        this.where('title', 'ilike', term)
          .orWhere('content', 'ilike', term);
      })
      .where({ status: 'active' }),
    trustedOnly,
  )
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .select(...KB_SEARCH_COLUMNS);
}

function wikiFtsQuery(q, trustedOnly, limit) {
  return applyWikiTrustGate(
    db('knowledge_entries')
      .whereRaw("search_vector @@ websearch_to_tsquery('english', ?)", [q]),
    trustedOnly,
  )
    .select(...WIKI_SEARCH_COLUMNS, db.raw("ts_rank(search_vector, websearch_to_tsquery('english', ?)) as rank", [q]))
    .orderBy('rank', 'desc')
    .orderBy('data_point_count', 'desc')
    .limit(limit);
}

function wikiIlikeQuery(term, trustedOnly, limit) {
  return applyWikiTrustGate(
    db('knowledge_entries')
      .where(function () {
        this.where('title', 'ilike', term)
          .orWhere('content', 'ilike', term)
          .orWhere('summary', 'ilike', term);
      }),
    trustedOnly,
  )
    .orderBy('data_point_count', 'desc')
    .limit(limit)
    .select(...WIKI_SEARCH_COLUMNS);
}

// ══════════════════════════════════════════════════════════════
// KNOWLEDGE BRIDGE SERVICE
// ══════════════════════════════════════════════════════════════

// Per-assessment chain of in-flight recommendation runs — see
// generateAssessmentRecommendations for why runs must be serialized.
const _recommendationRuns = new Map();

// In-flight generation fence (codex P1 r28+r29): a held email delivery must
// not treat its sanitize as final while ANY generation can still write
// different grounded copy afterwards. `_generationRuns` is a REGISTRY —
// { runId: leaseExpiresAtISO } — so concurrent runs across pods each hold
// their own entry and a finishing run removes only its own. The lease is
// short but RENEWED on a heartbeat for as long as the provider chain runs,
// so a 10-minute dispatch + fallback keeps the fence live, while a crashed
// process's entry simply expires and can never strand the email.
const GENERATION_LEASE_MS = 5 * 60 * 1000;
const GENERATION_LEASE_RENEW_MS = 90 * 1000;
function parseStoredRecommendations(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}
function activeGenerationRuns(stored) {
  const runs = stored && typeof stored._generationRuns === 'object' && stored._generationRuns
    ? stored._generationRuns : {};
  const now = Date.now();
  const live = {};
  for (const [id, until] of Object.entries(runs)) {
    const ts = Date.parse(until);
    if (Number.isFinite(ts) && ts > now) live[id] = until;
  }
  return live;
}
function generationInFlight(stored) {
  return Object.keys(activeGenerationRuns(stored)).length > 0;
}
// Locked read-modify-write of the run registry. `mutate(liveRuns)` returns
// the registry to persist; everything else in the payload is preserved.
async function updateGenerationRuns(assessmentId, mutate) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lawn_rec_${assessmentId}`]);
    const row = await trx('lawn_assessments').where({ id: assessmentId }).first('recommendations');
    const stored = parseStoredRecommendations(row?.recommendations) || {};
    const next = mutate(activeGenerationRuns(stored));
    if (next && Object.keys(next).length) stored._generationRuns = next;
    else delete stored._generationRuns;
    // Legacy scalar marker from the r28 shape — drop it on any touch.
    delete stored._generationInFlightUntil;
    delete stored._generationRunId;
    await trx('lawn_assessments').where({ id: assessmentId })
      .update({ recommendations: JSON.stringify(stored), updated_at: new Date() });
    return true;
  });
}

// Persist-time guard (codex P1 #3093 r5): the applied-today prompt rule is
// an instruction, not a guarantee. Text that advises against/defers a product
// class the technician ALREADY applied on the visit must never be stored —
// that's the exact AI-vs-technician contradiction this lane exists to kill.
// EVERY customer-visible applied class is guarded (codex P1 r19 — "hold off
// on fertilizer" is as much a contradiction as the fungicide case). Each
// entry pairs a product_category matcher with the customer-facing synonyms
// the model writes ("active disease treatment", not "fungicide" — r6),
// stored as pattern SOURCES so the governed builder can compose them.
const TREATMENT_CLASSES = {
  fungicide: {
    category: /fungicid/i,
    terms: 'fungicid\\w*|fung(?:us|al)\\s+(?:treatment|application|control|spray)|disease\\s+(?:treatment|application|control|spray)',
  },
  herbicide: {
    category: /herbicid/i,
    // Pre-emergent wording lives here TOO: Prodiamine-class rows persist
    // product_category 'herbicide' in this repo's catalog (codex P1 r22),
    // so "hold off on pre-emergent" must match the herbicide class.
    terms: 'herbicid\\w*|weed\\s+(?:treatment|control|application|killer|spray)|pre[-\\s]?emergent\\w*',
  },
  insecticide: {
    category: /insecticid/i,
    terms: 'insecticid\\w*|insect\\s+(?:treatment|control|application|spray)|(?:grub|chinch\\s*bug|webworm)\\s+(?:treatment|control|application)',
  },
  fertilizer: {
    category: /fertiliz|micronutrient/i,
    terms: 'fertiliz\\w*|fertilization|\\bfeeding\\b|micronutrient\\s+(?:application|blend|treatment)',
  },
  pre_emergent: {
    category: /pre[-\s_]?emergent/i,
    terms: 'pre[-\\s]?emergent\\w*',
  },
  // Report-visible soil products (codex P1 r20): CarbonPro-L class rows
  // persist soil_amendment/biostimulant categories; Hydretain-class rows
  // persist adjuvant/wetting-agent categories.
  // Primo Maxx-class rows persist product_category 'pgr' (codex P1 r23).
  pgr: {
    category: /\bpgr\b|growth[\s_-]?regulator/i,
    terms: '\\bpgr\\b|(?:plant\\s+)?growth\\s+regulator\\w*|growth\\s+regulation',
  },
  soil_amendment: {
    category: /soil[\s_-]?amendment|biostimulant|humic/i,
    terms: 'biostimulant\\w*|soil\\s+amendment\\w*|humic\\s+(?:acid|application)|carbon\\s+(?:application|treatment)',
  },
  adjuvant: {
    category: /adjuvant|wetting[\s_-]?agent|surfactant|moisture[\s_-]?manager/i,
    terms: 'adjuvant\\w*|wetting\\s+agent\\w*|surfactant\\w*|moisture\\s+manager\\w*',
  },
};
const TREATMENT_CLASS_TERMS = Object.fromEntries(
  Object.entries(TREATMENT_CLASSES).map(([cls, def]) => [cls, def.terms]),
);

// Defer-language must GOVERN the treatment decision itself — bare
// co-occurrence deleted legitimate aftercare like "avoid watering after the
// herbicide application" and "wait until today's fungicide has dried"
// (codex P2 r8). Each pattern binds the defer verb/negation directly to the
// class term (or the class term to a not-needed clause).
const _governedCache = new Map();
// Build the governed patterns for ANY term source — class synonyms, an
// applied product's name variants, or the generic fallback for
// unresolved-category rows (codex P1 r26).
function governedRegexForTerms(termSource) {
  if (_governedCache.has(termSource)) return _governedCache.get(termSource);
  const CLASS = `(?:${termSource})`;
  const re = new RegExp([
    // Strong defer verbs take the class through a small gap: "hold off on
    // any herbicide", "do not apply fungicide", "skip the fungicide".
    `\\b(?:defer|hold\\s+off\\s+on|skip|withhold|postpone|do\\s+not\\s+(?:apply|make|use)|don['’]t\\s+(?:apply|make|use))\\s+(?:[\\w'’-]+\\s+){0,2}${CLASS}`,
    // 'avoid'/'no' must bind to the treatment ITSELF (articles/quantifiers
    // only) — a free two-word gap deleted legitimate aftercare like "Avoid
    // watering after herbicide application" (codex P2 r22).
    `\\bavoid\\s+(?:apply(?:ing)?\\s+)?(?:an?\\s+|another\\s+|more\\s+|any\\s+)?${CLASS}`,
    `\\bno\\s+(?:additional\\s+|new\\s+|further\\s+|more\\s+)?${CLASS}`,
    // "before making a fungicide application"
    `\\bbefore\\s+(?:making|applying)\\s+(?:an?\\s+)?(?:[\\w'’-]+\\s+){0,2}${CLASS}`,
    // active wait/delay-to-apply forms — "wait to apply fungicide until
    // disease is confirmed" (codex P1 r13). Bound to the apply verb so
    // "wait until today's fungicide has dried" still passes.
    `\\b(?:wait\\s+to|hold\\s+off\\s+on|delay|postpone|refrain\\s+from)\\s+(?:apply(?:ing)?|mak(?:e|ing)|us(?:e|ing))\\s+(?:an?\\s+)?(?:[\\w'’-]+\\s+){0,2}${CLASS}`,
    // "<class> ... is not needed/warranted/required" — the gap may not
    // contain another subject, so "Fungicide was applied today, so extra
    // irrigation is not needed" stays (codex P2 r31).
    `${CLASS}(?:(?!\\b(?:irrigation|watering|water|mow\\w*|fertiliz\\w*|seed\\w*|aerat\\w*)\\b)[^.!?]){0,50}\\bnot\\s+(?:currently\\s+)?(?:needed|necessary|required|warranted|supported|recommended)\\b`,
    // passive deferrals — modal, past-tense, and progressive forms: "should
    // be deferred", "was deferred", "is being postponed" (codex P1 r10+r11)
    `${CLASS}[^.!?]{0,60}\\b(?:should|could|can|may|will|must|would|shall)\\s+(?:be\\s+)?(?:deferred|delayed|postponed|skipped|avoided|withheld|held\\s+off)\\b`,
    `${CLASS}[^.!?]{0,60}\\b(?:is|are|was|were|has\\s+been|have\\s+been|being)\\s+(?:being\\s+)?(?:deferred|delayed|postponed|skipped|withheld|held\\s+off)\\b`,
    // contracted / adverbial negations — "fungicide isn't necessary",
    // "a fungicide is never warranted right now" (codex P1 r11)
    `${CLASS}(?:(?!\\b(?:irrigation|watering|water|mow\\w*|fertiliz\\w*|seed\\w*|aerat\\w*)\\b)[^.!?]){0,50}\\b(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|never|no\\s+longer)\\s+(?:currently\\s+)?(?:needed|necessary|required|warranted|supported|recommended)\\b`,
    // modal negations — "fungicide should not be applied until disease is
    // confirmed", "shouldn't be used" (codex P1 r19)
    `${CLASS}(?:(?!\\b(?:irrigation|watering|water|mow\\w*|fertiliz\\w*|seed\\w*|aerat\\w*)\\b)[^.!?]){0,50}\\b(?:should|must|can|could|may|will|would|shall)\\s+not\\s+(?:be\\s+)?(?:applied|used|made|needed|necessary)\\b`,
    `${CLASS}[^.!?]{0,60}\\b(?:shouldn['’]t|mustn['’]t|can['’]t|cannot|won['’]t|wouldn['’]t)\\s+(?:be\\s+)?(?:applied|used|made|needed|necessary)\\b`,
    // "no <class> is needed", "confirm no fungicide is needed"
    `\\b(?:confirm|verify)\\s+(?:that\\s+)?no\\s+(?:[\\w'’-]+\\s+){0,2}${CLASS}`,
    // "do not currently support active disease treatment"
    `\\bnot\\s+(?:currently\\s+)?(?:support|warrant|recommend)\\w*[^.!?]{0,40}${CLASS}`,
  ].join('|'), 'i');
  _governedCache.set(termSource, re);
  return re;
}

// Name variants for an applied product — the model defers by NAME too
// ("Hold off on Celsius WG", "Do not apply more Artavia" — codex P1 r26):
// full name, name without parentheticals, the distinctive first token, and
// parenthesized aliases ("(Azoxy)").
function productNameTermSource(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const variants = new Set([esc(clean)]);
  const base = clean.replace(/\(([^)]*)\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (base && base !== clean) variants.add(esc(base));
  const first = base.split(/\s+/)[0] || '';
  if (/^[A-Za-z][\w-]{4,}$/.test(first)) variants.add(esc(first));
  // Catalog acronyms the model naturally shortens to — "QP MSM 60DF Turf
  // Herbicide" becomes "MSM" (codex P1 r32). Pure-alpha uppercase tokens of
  // 3+ chars only: 'QP'/'SC'/'WG' are too generic, '60DF' carries digits.
  for (const token of base.split(/\s+/)) {
    if (/^[A-Z]{3,}$/.test(token)) variants.add(esc(token));
  }
  for (const m of clean.matchAll(/\(([^)]+)\)/g)) {
    const alias = m[1].trim();
    if (/^[A-Za-z][\w-]{3,}$/.test(alias)) variants.add(esc(alias));
  }
  return [...variants].join('|');
}

// Generic fallback terms for applied rows whose category is genuinely
// unresolved (admin-inventory stores null categories as supported input) —
// class-phrased deferrals can't be matched for them, so generic
// treatment-deferral wording is governed instead of skipping the row
// entirely (codex P1 r26).
const GENERIC_TREATMENT_TERMS = '(?:today[\'’]s\\s+)?(?:treatment|application)s?\\b';

function contradictsAppliedTreatment(text, appliedClasses) {
  const t = String(text || '');
  if (!t || !appliedClasses.length) return false;
  return appliedClasses.some((cls) => TREATMENT_CLASS_TERMS[cls] && governedRegexForTerms(TREATMENT_CLASS_TERMS[cls]).test(t));
}

// Products-aware contradiction check: class synonyms + applied product
// names + (for unresolved-category rows) generic treatment terms.
function contradictsAppliedProducts(text, appliedProducts) {
  const t = String(text || '');
  const rows = Array.isArray(appliedProducts) ? appliedProducts : [];
  if (!t || !rows.length) return false;
  if (contradictsAppliedTreatment(t, appliedTreatmentClasses(rows))) return true;
  for (const row of rows) {
    const nameSource = productNameTermSource(row.product_name);
    if (nameSource && governedRegexForTerms(nameSource).test(t)) return true;
  }
  // Generic deferrals ("No additional treatment is warranted") contradict
  // ANY applied product — not just unresolved-category rows (codex P1 r27):
  // something WAS applied, so governed generic-treatment wording is checked
  // whenever any application exists.
  if (governedRegexForTerms(GENERIC_TREATMENT_TERMS).test(t)) return true;
  return false;
}

// Strip contradicting content from a parsed recommendations payload.
// Violating recommendation items are dropped; violating scalar fields fall
// back to neutral monitoring copy (nextVisitFocus) or are removed so the
// previously stored value stands (summary/customerTip).
function appliedTreatmentClasses(appliedProducts) {
  const rows = appliedProducts || [];
  const keys = Object.keys(TREATMENT_CLASSES);
  // A row whose category maps to NO governed class — blank, or an arbitrary
  // string like 'Uncategorized' that admin-inventory accepts — could BE any
  // class, and class-phrased copy ("Hold off on fungicide") is covered by
  // neither the product name nor the generic terms (codex P1 r30+r31).
  // Conservatively treat unrecognized categories as every governed class.
  const unrecognized = rows.some((p) => {
    const cat = String(p.product_category || '').trim();
    return !cat || !keys.some((cls) => TREATMENT_CLASSES[cls].category.test(cat));
  });
  if (unrecognized) return keys;
  return keys.filter((cls) => rows.some((p) => TREATMENT_CLASSES[cls].category.test(String(p.product_category || ''))));
}

// Applied-product rows with categories recovered from the catalog: legacy
// service_products rows can carry a null product_category while product_id
// still identifies a catalog fungicide/herbicide — the classifier must see
// the real class or the guard never fires for those visits (codex P2 r18;
// mirrors attachApprovedReportProductFacts in report-data).
async function loadAppliedProductsWithCategories(serviceRecordId, knexOrTrx) {
  const rows = await knexOrTrx('service_products')
    .where({ service_record_id: serviceRecordId })
    .select('product_name', 'product_category', 'product_id');
  const missingIds = [...new Set(rows.filter((r) => !r.product_category && r.product_id).map((r) => String(r.product_id)))];
  if (!missingIds.length) return rows;
  // A transient catalog failure must PROPAGATE (codex P1 r21): swallowing it
  // returns unenriched rows, the classifier misses the applied class, and
  // both generation and sanitation report success while blind to today's
  // treatments. Throwing routes the generation run to null/unverified and
  // the sanitize transaction to its { error } result.
  const catalogRows = await knexOrTrx('products_catalog').whereIn('id', missingIds).select('id', 'category');
  const categoryById = new Map(catalogRows.map((c) => [String(c.id), c.category]));
  return rows.map((r) => ((r.product_category || !r.product_id)
    ? r
    : { ...r, product_category: categoryById.get(String(r.product_id)) || r.product_category }));
}

function sanitizeRecommendationsAgainstTreatment(parsed, appliedProducts) {
  const rows = Array.isArray(appliedProducts) ? appliedProducts : [];
  const appliedClasses = appliedTreatmentClasses(rows);
  // Products-aware: any applied row (even class-less) participates via its
  // NAME and, for unresolved categories, the generic treatment terms
  // (codex P1 r26) — so the gate is "any applied products", not "any class".
  if (!rows.length || !parsed || typeof parsed !== 'object') return { parsed, dropped: 0, appliedClasses };
  const bad = (text) => contradictsAppliedProducts(text, rows);
  let dropped = 0;
  if (Array.isArray(parsed.recommendations)) {
    parsed.recommendations = parsed.recommendations.filter((rec) => {
      const hit = bad(`${rec?.action || ''} ${rec?.reason || ''}`);
      if (hit) dropped += 1;
      return !hit;
    });
  }
  for (const key of ['summary', 'customerTip']) {
    if (bad(parsed[key])) { delete parsed[key]; dropped += 1; }
  }
  if (bad(parsed.nextVisitFocus)) {
    parsed.nextVisitFocus = 'Recheck the areas treated today and confirm how the lawn is responding to the applications.';
    dropped += 1;
  }
  return { parsed, dropped, appliedClasses };
}

const KnowledgeBridge = {

  // ────────────────────────────────────────────────────────────
  // createLink — manually or programmatically link two entries
  // ────────────────────────────────────────────────────────────
  async createLink({ kbEntryId, wikiEntryId, linkType, relevanceScore, linkReason, createdBy }) {
    try {
      // Look up slugs
      const kb = kbEntryId ? await db('knowledge_base').where({ id: kbEntryId }).select('slug').first() : null;
      const wiki = wikiEntryId ? await db('knowledge_entries').where({ id: wikiEntryId }).select('slug').first() : null;

      const [link] = await db('knowledge_bridge').insert({
        kb_entry_id: kbEntryId || null,
        kb_slug: kb?.slug || null,
        wiki_entry_id: wikiEntryId || null,
        wiki_slug: wiki?.slug || null,
        link_type: linkType,
        relevance_score: relevanceScore || 0.5,
        link_reason: linkReason || null,
        created_by: createdBy || 'system',
      }).onConflict(['kb_entry_id', 'wiki_entry_id', 'link_type']).ignore().returning('*');

      // Also set direct FK pointers for fast joins
      if (kbEntryId && wikiEntryId) {
        await db('knowledge_base').where({ id: kbEntryId }).update({ wiki_entry_id: wikiEntryId });
        await db('knowledge_entries').where({ id: wikiEntryId }).update({ kb_entry_id: kbEntryId });
      }

      return link || null;
    } catch (err) {
      logger.error(`[knowledge-bridge] createLink failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // autoLink — scan for matching entries and create links
  // Runs product name matching, condition matching, seasonal matching
  // ────────────────────────────────────────────────────────────
  async autoLink() {
    const stats = { productLinks: 0, conditionLinks: 0, seasonalLinks: 0, errors: 0 };

    try {
      // 1. Product matching: KB entries with category 'product' ↔ Wiki product pages
      const kbProducts = await db('knowledge_base')
        .where({ category: 'product', status: 'active' })
        .select('id', 'title', 'slug');

      const wikiProducts = await db('knowledge_entries')
        .where({ category: 'product' })
        .select('id', 'title', 'slug');

      for (const kbProd of kbProducts) {
        const kbName = kbProd.title.replace(/^Product:\s*/i, '').toLowerCase();
        for (const wikiProd of wikiProducts) {
          const wikiName = wikiProd.title.replace(/^Product:\s*/i, '').toLowerCase();
          if (kbName === wikiName || kbName.includes(wikiName) || wikiName.includes(kbName)) {
            const link = await KnowledgeBridge.createLink({
              kbEntryId: kbProd.id,
              wikiEntryId: wikiProd.id,
              linkType: 'product_reference',
              relevanceScore: 0.95,
              linkReason: `Product name match: "${kbProd.title}" ↔ "${wikiProd.title}"`,
              createdBy: 'auto_link',
            });
            if (link) stats.productLinks++;
          }
        }
      }

      // 2. Condition matching: KB pest/disease entries ↔ Wiki condition pages
      const kbConditions = await db('knowledge_base')
        .whereIn('category', ['pest', 'disease', 'weed', 'condition', 'pest_control', 'lawn_care'])
        .where({ status: 'active' })
        .select('id', 'title', 'slug');

      const wikiConditions = await db('knowledge_entries')
        .where({ category: 'condition' })
        .select('id', 'title', 'slug');

      for (const kbCond of kbConditions) {
        const kbName = kbCond.title.replace(/^Condition:\s*/i, '').toLowerCase();
        for (const wikiCond of wikiConditions) {
          const wikiName = wikiCond.title.replace(/^Condition:\s*/i, '').toLowerCase();
          if (kbName === wikiName || kbName.includes(wikiName) || wikiName.includes(kbName)) {
            const link = await KnowledgeBridge.createLink({
              kbEntryId: kbCond.id,
              wikiEntryId: wikiCond.id,
              linkType: 'condition_treatment',
              relevanceScore: 0.90,
              linkReason: `Condition name match: "${kbCond.title}" ↔ "${wikiCond.title}"`,
              createdBy: 'auto_link',
            });
            if (link) stats.conditionLinks++;
          }
        }
      }

      // 3. Seasonal matching: KB seasonal guides ↔ Wiki seasonal intelligence pages
      const kbSeasonal = await db('knowledge_base')
        .whereIn('category', ['seasonal', 'protocol', 'schedule'])
        .where({ status: 'active' })
        .select('id', 'title', 'slug', 'content');

      const wikiSeasonal = await db('knowledge_entries')
        .where({ category: 'seasonal' })
        .select('id', 'title', 'slug');

      const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];

      for (const kbEntry of kbSeasonal) {
        const kbLower = (kbEntry.title + ' ' + kbEntry.slug).toLowerCase();
        for (const wikiEntry of wikiSeasonal) {
          const wikiMonth = wikiEntry.slug.replace('seasonal/', '').toLowerCase();
          if (months.includes(wikiMonth) && kbLower.includes(wikiMonth)) {
            const link = await KnowledgeBridge.createLink({
              kbEntryId: kbEntry.id,
              wikiEntryId: wikiEntry.id,
              linkType: 'seasonal_guide',
              relevanceScore: 0.80,
              linkReason: `Seasonal match: "${kbEntry.title}" ↔ "${wikiEntry.title}"`,
              createdBy: 'auto_link',
            });
            if (link) stats.seasonalLinks++;
          }
        }
      }

      logger.info(`[knowledge-bridge] autoLink complete: ${JSON.stringify(stats)}`);
      return stats;

    } catch (err) {
      logger.error(`[knowledge-bridge] autoLink failed: ${err.message}`);
      stats.errors++;
      return stats;
    }
  },

  // ────────────────────────────────────────────────────────────
  // unifiedSearch — search both knowledge systems at once
  // Ranked full-text first (websearch_to_tsquery + ts_rank over the
  // generated search_vector columns); each corpus INDEPENDENTLY falls
  // back to the historical ILIKE substring path when its FTS matches
  // nothing — stopword-only queries and partial tokens ("K-Fl") still
  // answer, one corpus's FTS hits never suppress the other's substring
  // matches, and a missing search_vector column degrades instead of
  // erroring.
  // ────────────────────────────────────────────────────────────
  async unifiedSearch(query, options = {}) {
    if (!query?.trim()) return { claudeopedia: [], wiki: [], bridged: [] };

    const q = query.trim();
    const term = `%${q.toLowerCase()}%`;
    const limit = Math.min(options.limit || 20, 50);

    let claudeopedia = [];
    let wiki = [];
    let kbMethod = 'fts';
    let wikiMethod = 'fts';

    try {
      claudeopedia = await kbFtsQuery(q, options.trustedOnly, limit);
    } catch (err) {
      logger.warn(`[knowledge-bridge] KB FTS search failed, falling back to ILIKE: ${err.message}`);
    }
    if (!claudeopedia.length) {
      kbMethod = 'ilike';
      claudeopedia = await kbIlikeQuery(term, options.trustedOnly, limit);
    }

    try {
      wiki = await wikiFtsQuery(q, options.trustedOnly, limit);
    } catch (err) {
      logger.warn(`[knowledge-bridge] wiki FTS search failed, falling back to ILIKE: ${err.message}`);
    }
    if (!wiki.length) {
      wikiMethod = 'ilike';
      wiki = await wikiIlikeQuery(term, options.trustedOnly, limit);
    }

    const searchMethod = kbMethod === wikiMethod ? kbMethod : 'mixed';

    // Find bridged pairs. Migration 20260718000004 reshaped knowledge_bridge
    // to the kb_entry_id/wiki_entry_id schema this service targets (000015's
    // source/target shape had shipped instead, breaking every bridge
    // read/write). The try/catch stays as defense in depth: a schema mismatch
    // must degrade to bridged:[] — never take the whole knowledge tool down,
    // which is what happened from April until lane A1's guard.
    let bridges = [];
    try {
      const allKbIds = claudeopedia.map(e => e.id).filter(Boolean);
      const allWikiIds = wiki.map(e => e.id).filter(Boolean);
      bridges = (allKbIds.length || allWikiIds.length) ? await db('knowledge_bridge')
        .where(function () {
          if (allKbIds.length) this.whereIn('kb_entry_id', allKbIds);
          if (allWikiIds.length) this.orWhereIn('wiki_entry_id', allWikiIds);
        })
        .select('*') : [];
    } catch (err) {
      logger.warn(`[knowledge-bridge] bridged-pairs lookup failed (schema drift): ${err.message}`);
    }

    return {
      claudeopedia: claudeopedia.map(e => ({ ...e, source: 'claudeopedia' })),
      wiki: wiki.map(e => ({ ...e, source: 'agronomic_wiki' })),
      bridged: bridges,
      totalResults: claudeopedia.length + wiki.length,
      searchMethod,
    };
  },

  // ────────────────────────────────────────────────────────────
  // getLinkedEntries — get all linked entries for a given entry
  // ────────────────────────────────────────────────────────────
  async getLinkedEntries(entryId, source = 'auto') {
    try {
      let bridges;
      if (source === 'claudeopedia' || source === 'auto') {
        bridges = await db('knowledge_bridge').where({ kb_entry_id: entryId });
        if (!bridges.length && source === 'auto') {
          bridges = await db('knowledge_bridge').where({ wiki_entry_id: entryId });
        }
      } else {
        bridges = await db('knowledge_bridge').where({ wiki_entry_id: entryId });
      }

      if (!bridges.length) return { links: [], wikiEntries: [], kbEntries: [] };

      const wikiIds = bridges.map(b => b.wiki_entry_id).filter(Boolean);
      const kbIds = bridges.map(b => b.kb_entry_id).filter(Boolean);

      const wikiEntries = wikiIds.length
        ? await db('knowledge_entries').whereIn('id', wikiIds).select('id', 'slug', 'title', 'category', 'summary', 'data_point_count', 'confidence')
        : [];

      const kbEntries = kbIds.length
        ? await db('knowledge_base').whereIn('id', kbIds).select('id', 'slug', 'title', 'category', 'confidence')
        : [];

      return { links: bridges, wikiEntries, kbEntries };
    } catch (err) {
      logger.error(`[knowledge-bridge] getLinkedEntries failed: ${err.message}`);
      return { links: [], wikiEntries: [], kbEntries: [] };
    }
  },

  // ────────────────────────────────────────────────────────────
  // enrichWikiPageWithKB — pull Claudeopedia data into a wiki page
  // Called during wiki page generation/update
  // ────────────────────────────────────────────────────────────
  async enrichWikiPageWithKB(wikiEntryId) {
    try {
      const { kbEntries } = await KnowledgeBridge.getLinkedEntries(wikiEntryId, 'wiki');

      if (!kbEntries.length) return null;

      // Gather full content from linked KB entries
      const fullEntries = await db('knowledge_base')
        .whereIn('id', kbEntries.map(e => e.id))
        .select('title', 'category', 'content', 'confidence');

      return {
        referenceCount: fullEntries.length,
        references: fullEntries.map(e => ({
          title: e.title,
          category: e.category,
          confidence: e.confidence,
          excerpt: (e.content || '').substring(0, 500),
        })),
      };
    } catch (err) {
      logger.error(`[knowledge-bridge] enrichWikiPageWithKB failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // enrichKBEntryWithOutcomes — pull wiki outcome stats into a KB entry
  // ────────────────────────────────────────────────────────────
  async enrichKBEntryWithOutcomes(kbEntryId) {
    try {
      const { wikiEntries } = await KnowledgeBridge.getLinkedEntries(kbEntryId, 'claudeopedia');

      if (!wikiEntries.length) return null;

      return {
        outcomePages: wikiEntries.length,
        totalDataPoints: wikiEntries.reduce((sum, e) => sum + (e.data_point_count || 0), 0),
        entries: wikiEntries.map(e => ({
          title: e.title,
          category: e.category,
          dataPoints: e.data_point_count,
          confidence: e.confidence,
          summary: e.summary,
        })),
      };
    } catch (err) {
      logger.error(`[knowledge-bridge] enrichKBEntryWithOutcomes failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // generateAssessmentRecommendations — AI-powered recommendations
  // Uses both Claudeopedia protocols + wiki outcome data
  // Called after lawn assessment is confirmed, and again after service
  // completion persists the visit's products (grounded regen).
  // ────────────────────────────────────────────────────────────
  // Deterministic (no-LLM) sanitization of the STORED recommendations
  // against the visit's applied products — the fallback when the grounded
  // regeneration fails fast: the confirm-time copy stays customer-visible
  // (portal + queued PDF) and must not keep a treatment contradiction just
  // because the replacement generation errored (codex P1 #3093 r13). Same
  // advisory lock as generation so it can never interleave with a run.
  async sanitizeStoredRecommendations(assessmentId) {
    if (!assessmentId) return { changed: false, dropped: 0 };
    return db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lawn_rec_${assessmentId}`]);
      const assessment = await trx('lawn_assessments').where({ id: assessmentId }).first();
      // An unlinked assessment is UNVERIFIED, not a clean no-op (codex P1
      // r22): without service_record_id the applied products were never
      // checked, so callers gating unrecallable sends must keep waiting/
      // retrying rather than treating this as sanitized.
      if (!assessment) return { changed: false, dropped: 0, error: 'assessment not found' };
      if (!assessment.service_record_id) return { changed: false, dropped: 0, error: 'assessment not linked to a service record' };
      // A generation that can still write AFTER this sanitize means the
      // result is not final — unverified, so held sends keep deferring
      // (codex P1 r28).
      if (generationInFlight(parseStoredRecommendations(assessment.recommendations))) {
        return { changed: false, dropped: 0, error: 'recommendation generation in flight' };
      }
      const appliedProducts = await loadAppliedProductsWithCategories(assessment.service_record_id, trx);
      let stored;
      try {
        stored = typeof assessment.recommendations === 'string'
          ? JSON.parse(assessment.recommendations)
          : (assessment.recommendations || null);
      } catch { stored = null; }
      // ai_summary is persisted independently of the recommendations payload
      // — a missing/unparseable payload must not skip the summary check
      // (codex P1 r17).
      const summaryContradicts = contradictsAppliedProducts(assessment.ai_summary, appliedProducts);
      let parsed = stored && typeof stored === 'object' ? stored : null;
      let dropped = 0;
      if (parsed) {
        ({ parsed, dropped } = sanitizeRecommendationsAgainstTreatment(parsed, appliedProducts));
      }
      if (!dropped && !summaryContradicts) return { changed: false, dropped: 0 };
      const update = { updated_at: new Date() };
      if (summaryContradicts) {
        update.ai_summary = 'Today’s applications are in place — we’ll track how the lawn responds and adjust at the next visit.';
        if (parsed) parsed.summary = update.ai_summary;
      }
      if (parsed && dropped) update.recommendations = JSON.stringify(parsed);
      await trx('lawn_assessments').where({ id: assessmentId }).update(update);
      logger.warn(`[knowledge-bridge] stored recommendations sanitized for assessment ${assessmentId} (${dropped} field(s) dropped${summaryContradicts ? ', summary neutralized' : ''})`);
      return { changed: true, dropped };
    }).catch((err) => {
      logger.error(`[knowledge-bridge] sanitizeStoredRecommendations failed: ${err.message}`);
      // error (not a clean no-op): callers gating unrecallable sends must
      // treat this as NOT-verified and defer (codex P1 r17).
      return { changed: false, dropped: 0, error: err.message };
    });
  },

  async generateAssessmentRecommendations(assessmentId) {
    // Serialize runs per assessment: the confirm-time run can still be in
    // flight when the post-completion grounded regen starts, and both write
    // lawn_assessments.recommendations unconditionally — unserialized, the
    // stale ungrounded result could land last (codex P1 #3093 r2). The
    // in-process chain orders same-instance callers; the Postgres advisory
    // lock inside the inner run orders callers ACROSS instances (rolling
    // deploys briefly run two — codex P1 r8; in-process maps alone are
    // documented as insufficient in this repo). Callers that need a bounded
    // wait race this promise themselves — the run always completes and
    // writes, so a late grounded correction still heals the stored copy.
    const prev = _recommendationRuns.get(assessmentId) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._generateAssessmentRecommendationsInner(assessmentId));
    _recommendationRuns.set(assessmentId, run);
    run.finally(() => {
      if (_recommendationRuns.get(assessmentId) === run) _recommendationRuns.delete(assessmentId);
    }).catch(() => {});
    return run;
  },

  async _generateAssessmentRecommendationsInner(assessmentId) {
    // Static context (customer, grass, Claudeopedia/wiki entries) is read
    // BEFORE the transaction on the normal pool — inside the lock every
    // query must go through trx, because pooled reads while holding the
    // transaction's connection are nested pool acquisition and can exhaust
    // the pool under bursts (codex P1 r11). These reads don't need lock
    // freshness; the assessment + product rows are re-read inside the lock.
    let context;
    try {
      const preAssessment = await db('lawn_assessments').where({ id: assessmentId }).first();
      if (!preAssessment) return null;
      const customer = await db('customers').where({ id: preAssessment.customer_id }).first();
      // Grass context lives on customer_turf_profiles, not customers.
      // track_key is the protocol track id (e.g. 'st_augustine'); it may be
      // null when the customer has no turf profile yet.
      const grassContext = await loadCustomerGrassContext(preAssessment.customer_id);
      const grassType = grassContext.grassTypeLabel || 'St. Augustine';
      const grassTrack = grassContext.trackKey || null;
      // Pull relevant Claudeopedia entries (protocols, product info).
      // Wiki-sync MIRRORS inherit the wiki's review gate (customer-visible
      // recs); merely-linked curated articles stay visible.
      const protocolEntries = await db('knowledge_base')
        .whereIn('category', ['protocol', 'product', 'lawn_care', 'seasonal'])
        .where({ status: 'active' })
        .whereNot(function untrustedWikiMirror() {
          this.where('source', 'wiki-sync').whereIn(
            'wiki_entry_id',
            db('knowledge_entries').select('id').whereNotIn('review_status', TRUSTED_STATUSES),
          );
        })
        .where(function () {
          this.where('content', 'ilike', `%${grassType}%`)
            .orWhere('category', 'seasonal');
          if (grassTrack) this.orWhere('content', 'ilike', `%track ${grassTrack}%`);
        })
        .select('title', 'content', 'category')
        .limit(10);
      // Trusted wiki outcome pages only — these feed customer-visible
      // recommendations (exception-based gate).
      const outcomeEntries = await db('knowledge_entries')
        .whereIn('review_status', TRUSTED_STATUSES)
        .where(function () {
          this.where('category', 'seasonal');
          if (grassTrack) {
            this.orWhere(function () {
              this.where('category', 'track').where('slug', 'ilike', `%${slugify(grassTrack)}%`);
            });
          }
        })
        .select('title', 'summary', 'data_point_count', 'confidence')
        .limit(5);
      context = { customer, grassType, grassTrack, protocolEntries, outcomeEntries };
    } catch (ctxErr) {
      logger.error(`[knowledge-bridge] recommendation context load failed: ${ctxErr.message}`);
      return null;
    }
    // Cross-process safety WITHOUT holding a connection across the LLM call
    // (codex P1 r8+r27): the advisory lock brackets only short DB read/write
    // transactions — a 10-minute provider wait must never occupy the
    // 20-connection pool. Ordering is enforced by GROUNDED-WRITE PRECEDENCE
    // in the write phase instead of lock order: an ungrounded (confirm-time)
    // result can never overwrite a grounded (completion-time) one, so
    // interleavings across instances are harmless.
    const runId = `${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const phaseA = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lawn_rec_${assessmentId}`]);
      const assessment = await trx('lawn_assessments').where({ id: assessmentId }).first();
      if (!assessment) return null;
      let appliedProducts = [];
      if (assessment.service_record_id) {
        appliedProducts = await loadAppliedProductsWithCategories(assessment.service_record_id, trx);
      }
      // Register THIS run in the fence before releasing the lock — other
      // pods' active runs keep their own entries.
      const stored = parseStoredRecommendations(assessment.recommendations) || {};
      const runs = activeGenerationRuns(stored);
      runs[runId] = new Date(Date.now() + GENERATION_LEASE_MS).toISOString();
      stored._generationRuns = runs;
      delete stored._generationInFlightUntil;
      delete stored._generationRunId;
      await trx('lawn_assessments').where({ id: assessmentId })
        .update({ recommendations: JSON.stringify(stored), updated_at: new Date() });
      return { assessment, appliedProducts };
    }).catch((err) => {
      // A transient read/enrichment failure FAILS the run as ungrounded —
      // proceeding blind to today's treatments would release every gate
      // (codex P1 r19/r21).
      logger.warn(`[knowledge-bridge] recommendation read phase failed for ${assessmentId}: ${err.message}`);
      return undefined;
    });
    if (!phaseA) return null;
    // Renew this run's lease while the provider chain runs — the fence must
    // outlast a 10-minute dispatch plus fallback (codex P1 r29).
    const heartbeat = setInterval(() => {
      void updateGenerationRuns(assessmentId, (runs) => ({
        ...runs,
        [runId]: new Date(Date.now() + GENERATION_LEASE_MS).toISOString(),
      })).catch((renewErr) => logger.warn(`[knowledge-bridge] generation lease renew failed for ${assessmentId}: ${renewErr.message}`));
    }, GENERATION_LEASE_RENEW_MS);
    heartbeat.unref?.();
    let result = null;
    try {
      result = await this._generateAssessmentRecommendationsUnlocked(assessmentId, phaseA, context, runId)
        .catch((err) => { logger.error(`[knowledge-bridge] recommendation generation failed: ${err.message}`); return null; });
    } finally {
      clearInterval(heartbeat);
    }
    // Failure after Phase A must LIFT this run's entry (Phase B removes it
    // on success) — concurrent runs' entries are preserved.
    if (!result) {
      await updateGenerationRuns(assessmentId, (runs) => {
        const next = { ...runs };
        delete next[runId];
        return next;
      }).catch((clearErr) => logger.warn(`[knowledge-bridge] generation fence clear failed for ${assessmentId}: ${clearErr.message}`));
    }
    return result;
  },

  async _generateAssessmentRecommendationsUnlocked(assessmentId, { assessment, appliedProducts }, context, runId) {
    try {
      const { customer, grassType, grassTrack, protocolEntries, outcomeEntries } = context;

      // Build scores context
      const scores = {
        turf_density: assessment.turf_density,
        weed_suppression: assessment.weed_suppression,
        color_health: assessment.color_health,
        fungus_control: assessment.fungus_control,
        thatch_level: assessment.thatch_level,
        // Tech-confirmed consolidated damage score (higher = healthier), folding
        // disease/thatch/insect/drought/mechanical. This is the score the tech can
        // correct on completion, so it — not the raw AI fungus/thatch sub-reads —
        // is authoritative for whether damage recommendations are warranted.
        stress_damage: assessment.stress_damage,
        observations: assessment.observations,
        season: assessment.season,
      };

      // appliedProducts came from the locked Phase A read — the visit's
      // ACTUAL applications (product rows only; raw technician notes are NOT
      // parser-approved copy and must not feed customer-facing prompts).
      const month = new Date().getMonth() + 1;
      const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][month - 1];

      const systemPrompt = `You are the agronomic intelligence engine for Waves Pest Control in Southwest Florida. You generate clear, actionable lawn care recommendations by combining protocol knowledge with real treatment outcome data. Write in a professional but warm tone suitable for both the tech and the customer. Be specific and SWFL-relevant.`;

      const userPrompt = `Generate lawn care recommendations for this assessment:

Customer: ${customer?.first_name} ${customer?.last_name}
Grass Type: ${grassType} (Track ${grassTrack || 'unspecified'})
Month: ${monthName} (Season: ${assessment.season})

Current Scores (all 0-100, higher = healthier):
- Turf Density: ${scores.turf_density}%
- Weed Suppression: ${scores.weed_suppression}%
- Color Health: ${scores.color_health}%${scores.stress_damage != null ? `
- Stress / Damage (TECH-CONFIRMED, consolidates disease, thatch, insect, drought & mechanical): ${scores.stress_damage}%
  ↳ Fungus Control ${scores.fungus_control}% and Thatch Level ${scores.thatch_level}% are the AI's raw sub-reads only. When the tech-confirmed Stress/Damage is healthy, do NOT recommend NEW fungicide/dethatch treatments those raw sub-reads might otherwise imply (but never contradict an application that already happened today — see the applied-today rule below); when it is low but fungus/thatch look fine, the damage is drought/mechanical/insect — recommend accordingly.` : `
- Fungus Control: ${scores.fungus_control}%
- Thatch Level: ${scores.thatch_level}%`}
- Observations: ${scores.observations || 'None'}
${appliedProducts.length ? `
Applied TODAY on this visit (already done — authoritative):
${appliedProducts.map((p) => `- ${p.product_name}${p.product_category ? ` (${p.product_category})` : ''}`).join('\n')}
HARD RULE: these applications have already been made. Never recommend against, question, or defer a product class applied today (no "before making a fungicide application" when a fungicide was applied) — frame follow-up as monitoring the lawn's response to today's treatment.` : ''}

Protocol References (from Claudeopedia):
${protocolEntries.map(e => `[${e.category}] ${e.title}: ${(e.content || '').substring(0, 300)}`).join('\n')}

Real Outcome Data (from Agronomic Wiki):
${outcomeEntries.map(e => `${e.title} (${e.data_point_count} data points, ${e.confidence} confidence): ${e.summary || 'No summary'}`).join('\n')}

Return a JSON object with:
{
  "summary": "<one sentence customer-friendly lawn status summary>",
  "recommendations": [
    { "priority": 1, "action": "<specific action>", "reason": "<why based on data>", "timeframe": "<when>" }
  ],
  "nextVisitFocus": "<what to prioritize on the next visit>",
  "customerTip": "<one simple thing the customer can do between visits>"
}`;

      const result = await callClaude(systemPrompt, userPrompt, 1500);
      if (!result) return null;

      try {
        const raw = JSON.parse(result.replace(/```json|```/g, '').trim());
        // A provider can return valid JSON of the WRONG shape (string,
        // array, number). The sanitizer passes non-objects through and the
        // grounded flag / neutralized summary cannot be represented on them,
        // so the completion handler would mark a garbage result grounded
        // (codex P1 r32). Treat a non-plain-object as a failed run.
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          logger.warn(`[knowledge-bridge] recommendation payload for ${assessmentId} was not a JSON object — failing run as ungrounded`);
          return null;
        }

        // Model output advising against a product class applied today must
        // never persist (codex P1 r5) — the prompt rule is not a guarantee.
        const { parsed, dropped } = sanitizeRecommendationsAgainstTreatment(raw, appliedProducts);
        if (dropped) {
          logger.warn(`[knowledge-bridge] dropped ${dropped} treatment-contradicting field(s) from recommendations for assessment ${assessmentId}`);
        }

        // Phase B — SHORT locked write with grounded precedence: an
        // ungrounded (no-applied-products) result must never overwrite a
        // grounded one, regardless of which instance's LLM call finished
        // last (codex P1 r8+r27). The stale-summary check runs against the
        // FRESH row inside the lock.
        const iAmGrounded = appliedProducts.length > 0;
        return await db.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lawn_rec_${assessmentId}`]);
          const fresh = await trx('lawn_assessments').where({ id: assessmentId }).first();
          if (!fresh) return null;
          const existing = parseStoredRecommendations(fresh.recommendations);
          const existingGrounded = !!(existing && existing._groundedInApplications);
          // Runs still active besides this one keep the fence up on the
          // payload this write produces (codex P1 r29).
          const remainingRuns = activeGenerationRuns(existing);
          delete remainingRuns[runId];
          if (existingGrounded && !iAmGrounded) {
            logger.info(`[knowledge-bridge] ungrounded recommendation result for ${assessmentId} discarded — grounded copy already stored`);
            const kept = { ...existing };
            if (Object.keys(remainingRuns).length) kept._generationRuns = remainingRuns;
            else delete kept._generationRuns;
            delete kept._generationInFlightUntil;
            delete kept._generationRunId;
            await trx('lawn_assessments').where({ id: assessmentId })
              .update({ recommendations: JSON.stringify(kept), updated_at: new Date() });
            return null;
          }
          // When the replacement summary was stripped, "keep the stored one"
          // is only safe if the STORED one doesn't contradict today's
          // treatment (codex P1 r7) — checked against the fresh row.
          if (!parsed.summary && contradictsAppliedProducts(fresh.ai_summary, appliedProducts)) {
            parsed.summary = 'Today’s applications are in place — we’ll track how the lawn responds and adjust at the next visit.';
          }
          parsed._groundedInApplications = iAmGrounded;
          if (Object.keys(remainingRuns).length) parsed._generationRuns = remainingRuns;
          await trx('lawn_assessments').where({ id: assessmentId }).update({
            ...(parsed.summary ? { ai_summary: parsed.summary } : {}),
            recommendations: JSON.stringify(parsed),
            updated_at: new Date(),
          });
          return parsed;
        }).catch((writeErr) => {
          logger.error(`[knowledge-bridge] recommendation write phase failed for ${assessmentId}: ${writeErr.message}`);
          return null;
        });
      } catch (parseErr) {
        logger.error(`[knowledge-bridge] Failed to parse recommendations: ${parseErr.message}`);
        return null;
      }

    } catch (err) {
      logger.error(`[knowledge-bridge] generateAssessmentRecommendations failed: ${err.message}`);
      return null;
    }
  },

  // ────────────────────────────────────────────────────────────
  // syncToClaudeopedia — push wiki outcome summaries into Claudeopedia
  // Creates/updates a "Living Outcomes" entry for each product/track
  // ────────────────────────────────────────────────────────────
  async syncToClaudeopedia() {
    const stats = { created: 0, updated: 0, errors: 0 };

    try {
      // Only the clean brain crosses into Claudeopedia: trusted pages
      // (auto/approved — red pages awaiting review are excluded), with real
      // content. Everything agents read from the KB side inherits this gate.
      const wikiEntries = await db('knowledge_entries')
        .where('data_point_count', '>', 0)
        .whereIn('review_status', TRUSTED_STATUSES)
        .select('id', 'slug', 'title', 'category', 'summary', 'data_point_count', 'confidence', 'content', 'review_status');

      const syncable = wikiEntries.filter((w) => !(w.content || '').includes('*Pending AI generation'));

      for (const wiki of syncable) {
        try {
          const kbSlug = `outcomes-${wiki.slug.replace(/\//g, '-')}`;

          const existing = await db('knowledge_base').where({ slug: kbSlug }).first();

          // Mirror trust follows the source page — a resync must never
          // resurrect a flagged mirror of a red/blocked page, and a brand-new
          // mirror of an untrusted page starts gated. Drives BOTH the status
          // field and the active boolean (different KB readers filter on each).
          const wikiTrusted = ['auto', 'approved'].includes(wiki.review_status);
          const kbData = {
            title: `Outcome Data: ${wiki.title}`,
            category: wiki.category === 'product' ? 'product' : wiki.category === 'track' ? 'protocol' : 'seasonal',
            content: `## Real-World Outcome Data\n\n${wiki.summary || ''}\n\n**Data Points:** ${wiki.data_point_count}\n**Confidence:** ${wiki.confidence}\n\n---\n\n${(wiki.content || '').substring(0, 3000)}`,
            source: 'wiki-sync',
            confidence: wiki.confidence,
            status: wikiTrusted ? 'active' : 'flagged',
            active: wikiTrusted,
            metadata: JSON.stringify({ wiki_slug: wiki.slug, wiki_id: wiki.id, synced_at: new Date().toISOString() }),
            wiki_entry_id: wiki.id,
          };

          if (existing) {
            await db('knowledge_base').where({ id: existing.id }).update({ ...kbData, updated_at: new Date() });
            stats.updated++;

            // Ensure bridge link exists
            await KnowledgeBridge.createLink({
              kbEntryId: existing.id,
              wikiEntryId: wiki.id,
              linkType: 'data_enrichment',
              relevanceScore: 1.0,
              linkReason: 'Wiki-to-Claudeopedia sync',
              createdBy: 'wiki_sync',
            });
          } else {
            const [newEntry] = await db('knowledge_base').insert({
              ...kbData,
              slug: kbSlug,
              path: `kb/${kbData.category}/${kbSlug}.md`,
              last_verified_at: new Date(),
              verified_by: 'wiki-sync',
            }).returning('*');

            if (newEntry) {
              stats.created++;
              await KnowledgeBridge.createLink({
                kbEntryId: newEntry.id,
                wikiEntryId: wiki.id,
                linkType: 'data_enrichment',
                relevanceScore: 1.0,
                linkReason: 'Wiki-to-Claudeopedia initial sync',
                createdBy: 'wiki_sync',
              });
            }
          }
        } catch (entryErr) {
          logger.error(`[knowledge-bridge] syncToClaudeopedia entry error: ${entryErr.message}`);
          stats.errors++;
        }
      }

      logger.info(`[knowledge-bridge] syncToClaudeopedia complete: ${JSON.stringify(stats)}`);
      // Reconcile: copies whose source page is no longer trusted get flagged.
    // Event-driven flips (syncKbCopyTrust) handle transitions in real time;
    // this weekly pass heals any missed flip so drift can't persist.
    try {
      await db('knowledge_base')
        .where({ source: 'wiki-sync' })
        .whereIn(
          'wiki_entry_id',
          db('knowledge_entries').select('id').whereNotIn('review_status', TRUSTED_STATUSES),
        )
        .update({ status: 'flagged', active: false, updated_at: new Date() });
    } catch (err) {
      logger.error(`[knowledge-bridge] Sync trust reconciliation failed: ${err.message}`);
      // Count it: a run whose healing pass failed must log kb_sync_error so
      // the six-day guard retries tomorrow instead of suppressing for a week.
      stats.errors++;
    }

    return stats;
    } catch (err) {
      logger.error(`[knowledge-bridge] syncToClaudeopedia failed: ${err.message}`);
      // A run that died before/around the loop is an ERROR run — without
      // this, syncToClaudeopediaIfDue records a kb_sync success marker and
      // the six-day guard suppresses retries for a week with nothing synced.
      stats.errors++;
      return stats;
    }
  },

  // ────────────────────────────────────────────────────────────
  // syncToClaudeopediaIfDue — daily cron entry point with a weekly guard
  // (same self-healing pattern as the wiki's weeklyRefreshIfDue: a single
  // weekly fire time misses whole weeks when the process isn't up at that
  // exact minute).
  // ────────────────────────────────────────────────────────────
  async syncToClaudeopediaIfDue() {
    try {
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const recentRun = await db('knowledge_update_log')
        .where({ trigger_type: 'kb_sync' })
        .where('created_at', '>', sixDaysAgo)
        .first('id');
      if (recentRun) return { skipped: true };
    } catch (err) {
      logger.error(`[knowledge-bridge] syncIfDue guard query failed: ${err.message}`);
    }

    const stats = await KnowledgeBridge.syncToClaudeopedia();
    try {
      await db('knowledge_update_log').insert({
        action: stats.errors ? 'error' : 'sync',
        entry_slug: null,
        description: `Wiki→KB trusted sync: ${stats.created} created, ${stats.updated} updated, ${stats.errors} errors`,
        trigger_type: stats.errors ? 'kb_sync_error' : 'kb_sync',
      });
    } catch (err) {
      logger.error(`[knowledge-bridge] Failed to log sync: ${err.message}`);
    }
    return stats;
  },

  // ────────────────────────────────────────────────────────────
  // getStats — bridge health dashboard
  // ────────────────────────────────────────────────────────────
  async getStats() {
    const [bridgeCount] = await db('knowledge_bridge').count('id as count');
    const [kbCount] = await db('knowledge_base').count('id as count');
    const [wikiCount] = await db('knowledge_entries').count('id as count');

    const [kbLinked] = await db('knowledge_base').whereNotNull('wiki_entry_id').count('id as count');
    const [wikiLinked] = await db('knowledge_entries').whereNotNull('kb_entry_id').count('id as count');

    const linkTypes = await db('knowledge_bridge')
      .select('link_type')
      .count('id as count')
      .groupBy('link_type');

    return {
      totalBridgeLinks: parseInt(bridgeCount.count),
      claudeopediaTotal: parseInt(kbCount.count),
      wikiTotal: parseInt(wikiCount.count),
      claudeopediaLinked: parseInt(kbLinked.count),
      wikiLinked: parseInt(wikiLinked.count),
      linkTypeDistribution: linkTypes.reduce((acc, r) => { acc[r.link_type] = parseInt(r.count); return acc; }, {}),
    };
  },
};

module.exports = KnowledgeBridge;
module.exports._test = { sanitizeRecommendationsAgainstTreatment, contradictsAppliedTreatment, contradictsAppliedProducts, appliedTreatmentClasses, generationInFlight, activeGenerationRuns };
// Pure render-time guard surface (no DB, no LLM) — consumed by report-data
// as the last line of defense for instantly opened report links.
module.exports.treatmentGuard = {
  sanitizeRecommendationsAgainstTreatment,
  contradictsAppliedTreatment,
  contradictsAppliedProducts,
  appliedTreatmentClasses,
  // Durable fence read for render paths (codex P1 r30) — no lock needed, a
  // stale-true only costs one extra fresh render.
  async isGenerationInFlight(assessmentId, knex = db) {
    if (!assessmentId) return false;
    try {
      const row = await knex('lawn_assessments').where({ id: assessmentId }).first('recommendations');
      return generationInFlight(parseStoredRecommendations(row?.recommendations));
    } catch (err) {
      // FAIL CLOSED (codex P1 r32): a transient read failure must not read
      // as "nothing generating" — that would let a render clear the
      // correction marker while a generator is still able to write.
      logger.warn(`[knowledge-bridge] generation-fence read failed for ${assessmentId} — assuming in flight: ${err.message}`);
      return true;
    }
  },
};
