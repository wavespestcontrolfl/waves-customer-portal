const db = require('../../models/db');
const logger = require('../logger');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

class WikiQA {

  /**
   * Answer a question using the knowledge base.
   * Two-step: route to relevant articles, then answer with full context.
   */
  async query(question, context = {}) {
    // Load summaries for routing
    const summaries = await db('knowledge_base').where('path', 'wiki/_summaries.md').first();

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      // Fallback: keyword search
      return this.keywordSearch(question, context);
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Step 1: Route to relevant articles
    let paths = [];
    try {
      const routingResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Given this question about Waves Pest Control, which wiki articles should I read? Return ONLY a JSON array of file paths (max 8).

Question: ${question}

Available articles:
${summaries?.content || '(no articles yet)'}`
        }]
      });

      paths = JSON.parse(routingResponse.content[0].text.replace(/```json|```/g, '').trim());
    } catch {
      // Fallback: search by keywords
      const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const fallbackArticles = await db('knowledge_base')
        .where('active', true)
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

    if (paths.length === 0) {
      const answer = "I couldn't find relevant articles in the knowledge base for this question. The topic may not be documented yet.";
      await this.logQuery(question, answer, [], context.source);
      return { answer, articlesUsed: [] };
    }

    // Step 2: Load articles
    const articles = await db('knowledge_base')
      .whereIn('path', paths.slice(0, 8))
      .select('path', 'title', 'content');

    // Step 3: Answer with full context
    const answerResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are the Waves Pest Control knowledge base assistant. Answer questions using ONLY the provided wiki articles. Be specific — include exact numbers, rates, products, and procedures. If the wiki doesn't contain the answer, say so clearly. Keep answers concise and actionable.`,
      messages: [{
        role: 'user',
        content: `Question: ${question}

Wiki articles:
${articles.map(a => `\n--- ${a.title} (${a.path}) ---\n${a.content}`).join('\n\n')}`
      }]
    });

    const answer = answerResponse.content[0].text;
    await this.logQuery(question, answer, paths, context.source);

    return { answer, articlesUsed: paths, articleTitles: articles.map(a => ({ path: a.path, title: a.title })) };
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
      return { answer: 'No matching articles found. Try different keywords.', articlesUsed: [] };
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

    // Append Q&A to the first referenced article
    const article = await db('knowledge_base').where('path', refs[0]).first();
    if (!article) return { filed: false, reason: 'Referenced article not found' };

    const enrichment = `\n\n---\n\n### Q&A Addition (${new Date().toISOString().split('T')[0]})\n\n**Q:** ${q.query}\n\n**A:** ${q.answer}\n`;

    await db('knowledge_base').where('id', article.id).update({
      content: article.content + enrichment,
      word_count: (article.word_count || 0) + q.answer.split(/\s+/).length,
      updated_at: new Date(),
    });

    await db('knowledge_queries').where('id', queryId).update({ filed_back: true });

    return { filed: true, article: article.path };
  }

  async logQuery(query, answer, articlesReferenced, askedBy) {
    try {
      await db('knowledge_queries').insert({
        query, answer,
        articles_referenced: JSON.stringify(articlesReferenced),
        asked_by: askedBy || 'admin_manual',
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
