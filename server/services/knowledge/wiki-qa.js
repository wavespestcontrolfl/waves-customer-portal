const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { etDateString } = require('../../utils/datetime-et');
const { dispatchWithFallback } = require('../llm/call');
const { isEnabled, kbSpeciesQaLive } = require('../../config/feature-gates');

// Callers whose answer goes to staff, never to a customer. Every other
// source (ai_assistant, lead_agent, content_agent, unknown) is treated as
// customer-facing and never sees species tech notes.
const STAFF_SOURCES = new Set(['tech_field', 'admin_manual']);
const MAX_SPECIES = 3;

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

class WikiQA {

  /**
   * Answer a question using the knowledge base.
   * Two-step: route to relevant articles, then answer with full context.
   */
  async query(question, context = {}) {
    // Build live index directly from knowledge_base (not the compiled _summaries.md)
    const indexRows = await db('knowledge_base')
      .whereRaw('active IS NOT FALSE') // NULL counts as on, the same rule as the article load below
      .whereNot('path', 'like', 'wiki/_%')
      .select('path', 'title', 'summary', 'category')
      .orderBy('category');

    if (indexRows.length === 0) {
      const answer = 'The knowledge base is empty. Add articles via the compiler before asking questions.';
      await this.logQuery(question, answer, [], context.source, 'none');
      return { answer, articlesUsed: [] };
    }

    const liveIndex = indexRows
      .map(r => `${r.path} [${r.category}]: ${r.title} — ${r.summary || ''}`)
      .join('\n');

    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      // Fallback: keyword search
      return this.keywordSearch(question, context);
    }

    // Owner-approved species-catalog entries for this question
    // (GATE_KB_SPECIES_QA; [] when off).
    const species = await this.speciesContext(question, context.source);

    // Step 1: Route to relevant articles (FLAGSHIP first, Sol on a miss)
    const knownPaths = new Set(indexRows.map((r) => r.path));
    let paths = [];
    try {
      const routing = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
        laneId: 'wiki_qa',
        text: `Given this question about Waves Pest Control, which wiki articles should I read? List the file paths (max 8).

Question: ${question}

Available articles:
${liveIndex}`,
        jsonMode: true,
        jsonSchema: ROUTING_SCHEMA,
        maxTokens: 500,
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
      if (!routing.ok || !Array.isArray(routing.json?.paths)) throw new Error(routing.reason || 'no_paths');
      paths = routing.json.paths.slice(0, 8);
    } catch {
      // Fallback: search by keywords
      const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const fallbackArticles = await db('knowledge_base')
        .whereRaw('active IS NOT FALSE')
        .where(function () {
          for (const kw of keywords.slice(0, 5)) {
            this.orWhere('content', 'ilike', `%${kw}%`)
              .orWhere('title', 'ilike', `%${kw}%`);
          }
        })
        .limit(5)
        .select('path');
      paths = fallbackArticles.map(a => a.path);
    }

    if (paths.length === 0 && species.length === 0) {
      const answer = "I couldn't find relevant articles in the knowledge base for this question. The topic may not be documented yet.";
      await this.logQuery(question, answer, [], context.source, 'none');
      return { answer, articlesUsed: [] };
    }

    // Step 2: Load articles. Knowledge-base paths stay first in the refs so
    // fileBack (which appends to refs[0]) never targets a species entry.
    const kbArticles = paths.length
      ? await db('knowledge_base')
        .whereIn('path', paths)
        .whereRaw('active IS NOT FALSE') // an admin's active=false hides the row (NULL counts as on), as in every other reader
        .select('path', 'title', 'content')
      : [];
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
    });
    if (!answered.ok) throw new Error(`wiki answer failed: ${answered.reason}`);

    const { answer, coverage } = splitCoverage(answered.text);
    await this.logQuery(question, answer, refs, context.source, coverage);

    return { answer, articlesUsed: refs, articleTitles: articles.map(a => ({ path: a.path, title: a.title })) };
  }

  /**
   * Species-catalog entries relevant to the question, as answer articles
   * (`path: species:<slug>`). Approved entries only. Customer-facing callers
   * get the customer copy; staff callers also get the tech notes. Hybrid
   * search (species sources only) when GATE_HYBRID_KNOWLEDGE is on, else the
   * catalog's own name match. Never throws: a failure is no species context.
   */
  async speciesContext(question, source) {
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
      if (isEnabled('hybridKnowledge')) {
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
      .where('active', true)
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
  async search(query, limit = 20) {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return [];

    const results = await db('knowledge_base')
      .where('active', true)
      .where(function () {
        for (const kw of keywords) {
          this.orWhere('title', 'ilike', `%${kw}%`)
            .orWhere('summary', 'ilike', `%${kw}%`)
            .orWhere('content', 'ilike', `%${kw}%`)
            .orWhereRaw("tags::text ILIKE ?", [`%${kw}%`]);
        }
      })
      .select('id', 'path', 'title', 'summary', 'category', 'tags', 'word_count', 'last_compiled')
      .limit(limit);

    return results;
  }

  /**
   * Keyword-based fallback when AI is unavailable.
   */
  async keywordSearch(question, context) {
    const results = await this.search(question, 5);
    if (results.length === 0) {
      const answer = 'No matching articles found. Try different keywords.';
      await this.logQuery(question, answer, [], context?.source || 'keyword_fallback', 'none');
      return { answer, articlesUsed: [] };
    }

    const articles = await db('knowledge_base')
      .whereIn('path', results.map(r => r.path))
      .select('path', 'title', 'content');

    const answer = `Found ${results.length} relevant article(s):\n\n` +
      articles.map(a => `**${a.title}**\n${(a.content || '').substring(0, 500)}...`).join('\n\n---\n\n');

    await this.logQuery(question, answer, results.map(r => r.path), context?.source || 'keyword_fallback');
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

  async logQuery(query, answer, articlesReferenced, askedBy, coverage = null) {
    try {
      await db('knowledge_queries').insert({
        query, answer,
        articles_referenced: JSON.stringify(articlesReferenced),
        asked_by: askedBy || 'admin_manual',
        ...(coverage ? { coverage } : {}),
      });
    } catch (err) {
      logger.error(`Log knowledge query failed: ${err.message}`);
    }
  }

  /**
   * Get all articles in a specific category.
   */
  async getCategory(category) {
    return db('knowledge_base').where({ category, active: true }).select('path', 'title', 'summary', 'content', 'tags');
  }

  /**
   * List all active articles (used by dispatch module).
   */
  async listAll() {
    return db('knowledge_base').where('active', true)
      .select('path', 'title', 'category', 'summary', 'tags', 'word_count', 'last_compiled')
      .orderBy('category');
  }
}

module.exports = new WikiQA();
module.exports.CATALOG_FILE_BACK_REASON = CATALOG_FILE_BACK_REASON;
module.exports.splitCoverage = splitCoverage;
