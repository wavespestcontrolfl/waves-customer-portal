const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { etDateString } = require('../../utils/datetime-et');
const { dispatchWithFallback } = require('../llm/call');
const { isEnabled, kbSpeciesQaLive, kbCustomerAudienceLive } = require('../../config/feature-gates');
const { KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES } = require('./customer-safe-categories');

// Callers whose answer goes to staff, never to a customer. Every other
// source (ai_assistant, lead_agent, content_agent, unknown) is treated as
// customer-facing and never sees species tech notes.
const STAFF_SOURCES = new Set(['tech_field', 'admin_manual']);
const MAX_SPECIES = 3;

const runRead = (context, query, stage) => context?.read ? context.read(query, stage) : query;
const runWrite = (context, work, stage) => context?.write ? context.write(work, stage) : work(db);
const modelBudget = (context) => context?.remainingMs
  ? { timeoutMs: Math.max(1, context.remainingMs()), signal: context.signal }
  : (context?.signal ? { signal: context.signal } : {});

// The answer model ends with one coverage line (stripped before anyone sees
// the answer) so the weekly knowledge-gaps email can list what the
// knowledge base could not answer. A missing or malformed line records NULL.
const COVERAGE_RULE = ' After your answer, add one final line exactly "COVERAGE: full", "COVERAGE: partial" or "COVERAGE: none" — full when the articles fully answer the question, partial when they answer only part of it, none when they do not answer it.';
// Only the END of the answer is read: the upper-case COVERAGE token, any
// markdown around it, the value, and anything after it on that line (a
// trailing explanation). Ordinary text such as a "Coverage: none" row in a
// warranty table is never touched.
const COVERAGE_TAIL = /(^|[\s.;)])[>*_`\s-]*COVERAGE[*_`]*[ \t]*[:=][ \t*_`]*([A-Za-z]+)[^\n]*\s*$/;
const COVERAGE_VALUES = new Set(['full', 'partial', 'none']);

function splitCoverage(text) {
  const raw = String(text || '');
  const m = raw.match(COVERAGE_TAIL);
  const coverage = m ? m[2].toLowerCase() : null;
  if (!m || !COVERAGE_VALUES.has(coverage)) return { answer: raw.trimEnd(), coverage: null };
  return { answer: raw.slice(0, m.index + m[1].length).trimEnd(), coverage };
}
const CATALOG_FILE_BACK_REASON = 'Answer drew on the species catalog; it is not filed back into the knowledge base';

// Structured-output contract for the routing step (llm/call.js jsonSchema).
// The path list is still capped to 8 and resolved against knowledge_base.
const ROUTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paths'],
  properties: {
    paths: { type: 'array', items: { type: 'string', description: 'wiki article file path from the index' } },
  },
};

// Appended to the answer prompt only when species entries were supplied, so
// with GATE_KB_SPECIES_QA off the prompt is byte-identical to before.
const SPECIES_RULE = ' Articles titled "SPECIES CATALOG" are the owner-approved species catalog: where they disagree with another article about what an organism is, how serious it is, or its safety, the catalog wins.';

// NOTE: WikiQA.query stays on FLAGSHIP, not DEEP — it serves interactive
// surfaces (tech field lookup, admin Q&A, assistant tools) where a
// minutes-long DEEP turn is unacceptable. The DEEP tier writes/audits the
// wiki content offline; this path just reads it back fast.

// Every read here uses `active IS NOT FALSE`: an admin's active=false hides
// the article, and a legacy row with no flag (NULL) counts as on.
class WikiQA {

  /**
   * True when GATE_KB_CUSTOMER_AUDIENCE is on and the caller is customer-
   * facing (any source outside STAFF_SOURCES; a missing source counts), so
   * every knowledge_base read is limited to the customer-safe categories.
   * Gate off, or a staff caller: false, reads are unchanged.
   */
  customerAudienceOnly(source) {
    return kbCustomerAudienceLive() && !STAFF_SOURCES.has(source);
  }

  /**
   * Answer a question using the knowledge base.
   * Two-step: route to relevant articles, then answer with full context.
   */
  // Execution hooks are private caller options, separate from the context JSON
  // accepted by the authenticated knowledge route.
  async query(question, context = {}, execution = {}) {
    // GATE_KB_CUSTOMER_AUDIENCE: a customer-facing caller reads only the
    // customer-safe categories, on every knowledge_base read below.
    const customerOnly = this.customerAudienceOnly(context.source);

    // Build live index directly from knowledge_base (not the compiled _summaries.md)
    const indexQuery = db('knowledge_base')
      .whereRaw('active IS NOT FALSE') // NULL counts as on, the same rule as the article load below
      .whereNot('path', 'like', 'wiki/_%');
    if (customerOnly) indexQuery.whereIn('category', KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES);
    const indexRows = await runRead(execution, indexQuery
      .select('path', 'title', 'summary', 'category')
      .orderBy('category'), 'knowledge index');

    // An empty index is "the wiki is empty" for staff. A customer caller with
    // an empty allowlist falls through so the species catalog can still answer.
    if (indexRows.length === 0 && !customerOnly) {
      const answer = 'The knowledge base is empty. Add articles via the compiler before asking questions.';
      await this.logQuery(question, answer, [], context.source, 'none', execution);
      return { answer, articlesUsed: [] };
    }

    const liveIndex = indexRows
      .map(r => `${r.path} [${r.category}]: ${r.title} — ${r.summary || ''}`)
      .join('\n');

    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      // Fallback: keyword search
      return this.keywordSearch(question, context, execution);
    }

    // Owner-approved species-catalog entries for this question
    // (GATE_KB_SPECIES_QA; [] when off).
    const species = await this.speciesContext(question, context.source, execution);

    // Step 1: Route to relevant articles (FLAGSHIP first, Sol on a miss)
    const knownPaths = new Set(indexRows.map((r) => r.path));
    let paths = [];
    // Nothing to route over (customer caller, empty allowlist): skip the call.
    const routable = indexRows.length > 0;
    try {
      if (!routable) throw new Error('empty_index');
      const routing = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
        laneId: 'wiki_qa',
        text: `Given this question about Waves Pest Control, which wiki articles should I read? List the file paths (max 8).

Question: ${question}

Available articles:
${liveIndex}`,
        jsonMode: true,
        jsonSchema: ROUTING_SCHEMA,
        maxTokens: 500,
        ...modelBudget(execution),
      }, {
        // Every routed path must be an article from the index the model was
        // shown: an invented one used to be cited back as a source and stored
        // as referenced while nothing loaded (Codex-class gap on #4884). An
        // empty list stays a valid "nothing relevant".
        validate: (result) => {
          const listed = result.json?.paths;
          if (!Array.isArray(listed)) return 'invalid_output';
          return listed.every((p) => typeof p === 'string' && knownPaths.has(p)) ? null : 'invalid_output';
        },
      });
      execution.assertActive?.('knowledge routing');
      if (!routing.ok || !Array.isArray(routing.json?.paths)) throw new Error(routing.reason || 'no_paths');
      paths = routing.json.paths.slice(0, 8);
    } catch (err) {
      if (execution.signal?.aborted || err?.code === 'PORTAL_CHAT_DEADLINE'
        || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') throw err;
      // Fallback: search by keywords (nothing to search when the index was empty)
      const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const fallbackQuery = !routable ? null : db('knowledge_base')
        .whereRaw('active IS NOT FALSE')
        .where(function () {
          for (const kw of keywords.slice(0, 5)) {
            this.orWhere('content', 'ilike', `%${kw}%`)
              .orWhere('title', 'ilike', `%${kw}%`);
          }
        });
      if (fallbackQuery && customerOnly) fallbackQuery.whereIn('category', KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES);
      const fallbackArticles = fallbackQuery ? await runRead(execution, fallbackQuery
        .limit(5)
        .select('path'), 'knowledge fallback') : [];
      paths = fallbackArticles.map(a => a.path);
    }

    if (paths.length === 0 && species.length === 0) {
      const answer = "I couldn't find relevant articles in the knowledge base for this question. The topic may not be documented yet.";
      await this.logQuery(question, answer, [], context.source, 'none', execution);
      return { answer, articlesUsed: [] };
    }

    // Step 2: Load articles. Knowledge-base paths stay first in the refs so
    // fileBack (which appends to refs[0]) never targets a species entry.
    let kbArticles = [];
    if (paths.length) {
      const articleQuery = db('knowledge_base')
        .whereIn('path', paths)
        .whereRaw('active IS NOT FALSE'); // an admin's active=false hides the row (NULL counts as on), as in every other reader
      // A routed path outside the allowlist can never load for a customer caller.
      if (customerOnly) articleQuery.whereIn('category', KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES);
      kbArticles = await runRead(execution, articleQuery.select('path', 'title', 'content'), 'knowledge articles');
    }
    const articles = [...kbArticles, ...species];
    const refs = [...paths, ...species.map((a) => a.path)];

    // Step 3: Answer with full context (FLAGSHIP first, Sol on a miss; a
    // two-leg miss throws like the SDK path did)
    const answered = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
      laneId: 'wiki_qa',
      system: `You are the Waves Pest Control knowledge base assistant. Answer questions using ONLY the provided wiki articles. Be specific — include exact numbers, rates, products, and procedures. If the wiki doesn't contain the answer, say so clearly. Keep answers concise and actionable.${species.length ? SPECIES_RULE : ''}${COVERAGE_RULE}`,
      text: `Question: ${question}

Wiki articles:
${articles.map(a => `\n--- ${a.title} (${a.path}) ---\n${a.content}`).join('\n\n')}`,
      jsonMode: false,
      maxTokens: 2000,
      ...modelBudget(execution),
    });
    execution.assertActive?.('knowledge answer');
    if (!answered.ok) throw new Error(`wiki answer failed: ${answered.reason}`);

    const { answer, coverage } = splitCoverage(answered.text);
    await this.logQuery(question, answer, refs, context.source, coverage, execution);

    return { answer, articlesUsed: refs, articleTitles: articles.map(a => ({ path: a.path, title: a.title })) };
  }

  /**
   * Species-catalog entries relevant to the question, as answer articles
   * (`path: species:<slug>`). Approved entries only. Customer-facing callers
   * get the customer copy; staff callers also get the tech notes. Hybrid
   * search (species sources only) when GATE_HYBRID_KNOWLEDGE is on, else the
   * catalog's own name match. Never throws: a failure is no species context.
   */
  async speciesContext(question, source, context = null) {
    if (!kbSpeciesQaLive()) return [];
    try {
      const catalog = require('../species-catalog');
      const { isApproved } = require('../species-catalog-approval');
      const { speciesTitle, renderSpeciesCustomer, renderSpeciesTech } = require('../knowledge-index/connectors');
      // A caller that names no source is treated as customer-facing.
      const staff = STAFF_SOURCES.has(source);

      // The entry the question names, if exactly one; always relevant.
      const resolved = catalog.resolveName(question);
      const named = resolved?.node?.slug && catalog.getEntry(resolved.node.slug) ? resolved.node.slug : null;

      // Relevance floor: a hybrid hit counts only when at least two ranked
      // lists agree on it (vector + full text). Most entries share phrases
      // like "General Pest Control", so a lone full-text match is noise.
      let slugs = named ? [named] : [];
      if (isEnabled('hybridKnowledge') && !context?.bounded) {
        const { hybridKnowledgeSearch } = require('../knowledge-index/hybrid-search');
        const hits = await hybridKnowledgeSearch(question, { limit: 8, sources: staff ? ['species', 'species_tech'] : ['species'] });
        slugs.push(...(hits?.results || []).filter((r) => r.lists >= 2).map((r) => r.sourceId));
      }

      const entries = [...new Set(slugs)]
        .map((slug) => catalog.getEntry(slug))
        .filter((e) => e && isApproved(e))
        .slice(0, MAX_SPECIES);
      return entries.map((e) => ({
        path: `species:${e.slug}`,
        title: `${speciesTitle(e)} — SPECIES CATALOG`,
        content: staff && String(e.tech_notes || '').trim()
          ? `${renderSpeciesCustomer(e)}\n\n${renderSpeciesTech(e)}`
          : renderSpeciesCustomer(e),
      }));
    } catch (err) {
      logger.warn(`[wiki-qa] species context skipped: ${err.message}`);
      return [];
    }
  }

  /**
   * Quick lookup by topic — used by other services for fast retrieval.
   */
  async lookup(topic) {
    const article = await db('knowledge_base')
      .whereRaw('active IS NOT FALSE')
      .where(function () {
        this.where('title', 'ilike', `%${topic}%`)
          .orWhereRaw("tags::text ILIKE ?", [`%${topic.toLowerCase()}%`]);
      })
      .first();

    return article?.content || null;
  }

  /**
   * Search articles by text content, title, or tags.
   */
  async search(query, limit = 20, context = null, execution = {}) {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return [];

    const searchQuery = db('knowledge_base')
      .whereRaw('active IS NOT FALSE')
      .where(function () {
        for (const kw of keywords) {
          this.orWhere('title', 'ilike', `%${kw}%`)
            .orWhere('summary', 'ilike', `%${kw}%`)
            .orWhere('content', 'ilike', `%${kw}%`)
            .orWhereRaw("tags::text ILIKE ?", [`%${kw}%`]);
        }
      });
    // Callers that pass no context object (admin lists, dispatch) are
    // unchanged; a context object with a customer-facing or missing source
    // is filtered when GATE_KB_CUSTOMER_AUDIENCE is on.
    if (context && this.customerAudienceOnly(context.source)) {
      searchQuery.whereIn('category', KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES);
    }
    const results = await runRead(execution, searchQuery
      .select('id', 'path', 'title', 'summary', 'category', 'tags', 'word_count', 'last_compiled')
      .limit(limit), 'knowledge search');

    return results;
  }

  /**
   * Keyword-based fallback when AI is unavailable.
   */
  async keywordSearch(question, context, execution = {}) {
    const results = await this.search(question, 5, context, execution);
    if (results.length === 0) {
      const answer = 'No matching articles found. Try different keywords.';
      await this.logQuery(question, answer, [], context?.source || 'keyword_fallback', 'none', execution);
      return { answer, articlesUsed: [] };
    }

    const articleQuery = db('knowledge_base')
      .whereIn('path', results.map(r => r.path));
    if (this.customerAudienceOnly(context?.source)) {
      articleQuery.whereIn('category', KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES);
    }
    const articles = await runRead(execution, articleQuery.select('path', 'title', 'content'), 'knowledge articles');

    const answer = `Found ${results.length} relevant article(s):\n\n` +
      articles.map(a => `**${a.title}**\n${(a.content || '').substring(0, 500)}...`).join('\n\n---\n\n');

    await this.logQuery(question, answer, results.map(r => r.path), context?.source || 'keyword_fallback', null, execution);
    return { answer, articlesUsed: results.map(r => r.path) };
  }

  /**
   * File an answer back into the wiki to enrich existing articles.
   */
  async fileBack(queryId) {
    const q = await db('knowledge_queries').where('id', queryId).first();
    if (!q) throw new Error('Query not found');

    const refs = typeof q.articles_referenced === 'string' ? JSON.parse(q.articles_referenced) : (q.articles_referenced || []);
    if (refs.length === 0) return { filed: false, reason: 'No articles referenced' };
    if (this.drewOnCatalog(refs)) return { filed: false, reason: CATALOG_FILE_BACK_REASON };

    // Append Q&A to the first referenced article
    const article = await db('knowledge_base').where('path', refs[0]).first();
    if (!article) return { filed: false, reason: 'Referenced article not found' };

    const enrichment = `\n\n---\n\n### Q&A Addition (${etDateString()})\n\n**Q:** ${q.query}\n\n**A:** ${q.answer}\n`;

    await db('knowledge_base').where('id', article.id).update({
      content: article.content + enrichment,
      word_count: (article.word_count || 0) + q.answer.split(/\s+/).length,
      updated_at: new Date(),
    });

    await db('knowledge_queries').where('id', queryId).update({ filed_back: true });

    return { filed: true, article: article.path };
  }

  /**
   * True when an answer drew on species-catalog entries. Such an answer is
   * never filed back into knowledge_base: a staff answer may quote tech
   * notes, and knowledge_base is read by customer-facing callers. The
   * catalog itself stays the source of truth for those facts.
   */
  drewOnCatalog(articlesReferenced) {
    const refs = typeof articlesReferenced === 'string' ? JSON.parse(articlesReferenced) : (articlesReferenced || []);
    return refs.some((ref) => String(ref).startsWith('species:'));
  }

  async logQuery(query, answer, articlesReferenced, askedBy, coverage = null, execution = {}) {
    try {
      await runWrite(execution, (database) => database('knowledge_queries').insert({
        query, answer,
        articles_referenced: JSON.stringify(articlesReferenced),
        asked_by: askedBy || 'admin_manual',
        ...(coverage ? { coverage } : {}),
      }), 'knowledge query log');
    } catch (err) {
      if (typeof execution.write === 'function' && (execution.signal?.aborted
        || ['PORTAL_CHAT_DEADLINE', 'ABORT_ERR', '57014'].includes(err?.code)
        || ['AbortError', 'KnexTimeoutError'].includes(err?.name))) throw err;
      logger.error(`Log knowledge query failed: ${err.message}`);
    }
  }

  /**
   * Get all articles in a specific category.
   */
  async getCategory(category) {
    return db('knowledge_base').where({ category }).whereRaw('active IS NOT FALSE').select('path', 'title', 'summary', 'content', 'tags');
  }

  /**
   * List all active articles (used by dispatch module).
   */
  async listAll() {
    return db('knowledge_base').whereRaw('active IS NOT FALSE')
      .select('path', 'title', 'category', 'summary', 'tags', 'word_count', 'last_compiled')
      .orderBy('category');
  }
}

module.exports = new WikiQA();
module.exports.CATALOG_FILE_BACK_REASON = CATALOG_FILE_BACK_REASON;
module.exports.splitCoverage = splitCoverage;
