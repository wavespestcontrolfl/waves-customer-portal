const db = require('../../models/db');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

class WikiCompiler {

  async compileSource(sourceId) {
    const source = await db('knowledge_sources').where('id', sourceId).first();
    if (!source) throw new Error('Source not found');

    logger.info(`Compiling source: ${source.filename}`);

    const content = await this.readSourceFile(source.file_path, source.file_type);
    if (!content || content.length < 10) throw new Error('Source file empty or unreadable');

    const index = await db('knowledge_base')
      .where('active', true)
      .select('path', 'title', 'summary', 'category')
      .orderBy('category');

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      throw new Error('Anthropic API not configured');
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: `You are the knowledge base compiler for Waves Pest Control. Read raw source documents and compile them into structured, interlinked wiki articles in markdown.

RULES:
1. Extract ALL factual, procedural, and technical knowledge
2. One article per concept, product, protocol, or procedure
3. Use [[wikilinks]] format: [[products/celsius-wg|Celsius WG]]
4. Include specific numbers: rates, temperatures, timelines, costs, measurements
5. Flag uncertainty with ⚠️ and note the source
6. Write in clear, direct prose — not bullet-point dumps
7. Include "Sources" section referencing the raw file
8. Every article starts with a 2-3 sentence summary
9. Categories: services, products, protocols, compliance, equipment, pricing, customers, pests, turf, operations, competitive

EXISTING WIKI INDEX (for linking):
${index.map(a => `- ${a.path}: ${a.title}`).join('\n') || '(empty — this is the first compilation)'}

Return JSON array:
[{ "path": "wiki/category/article-name.md", "title": "", "summary": "", "category": "", "tags": [], "content": "full markdown", "backlinks": ["wiki/other/article.md"], "action": "create" or "update" }]`,
      messages: [{
        role: 'user',
        content: `Compile this source document into wiki articles:

SOURCE: ${source.filename}
TYPE: ${source.file_type}
DESCRIPTION: ${source.description || 'No description'}

CONTENT:
${content.substring(0, 50000)}`
      }]
    });

    let articles;
    try {
      articles = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
    } catch {
      logger.error('Failed to parse compiler output');
      throw new Error('Compiler output was not valid JSON');
    }

    let created = 0, updated = 0;

    for (const article of articles) {
      const existing = await db('knowledge_base').where('path', article.path).first();

      if (existing) {
        await db('knowledge_base').where('id', existing.id).update({
          title: article.title,
          content: article.content,
          summary: article.summary,
          category: article.category,
          tags: JSON.stringify(article.tags || []),
          backlinks: JSON.stringify(article.backlinks || []),
          source_documents: JSON.stringify([...new Set([...(typeof existing.source_documents === 'string' ? JSON.parse(existing.source_documents) : existing.source_documents || []), source.file_path])]),
          word_count: article.content.split(/\s+/).filter(Boolean).length,
          last_compiled: new Date(),
          version: existing.version + 1,
          updated_at: new Date(),
        });
        updated++;
      } else {
        await db('knowledge_base').insert({
          path: article.path,
          title: article.title,
          category: article.category,
          content: article.content,
          summary: article.summary,
          tags: JSON.stringify(article.tags || []),
          backlinks: JSON.stringify(article.backlinks || []),
          source_documents: JSON.stringify([source.file_path]),
          word_count: article.content.split(/\s+/).filter(Boolean).length,
          last_compiled: new Date(),
          version: 1,
          active: true,
        });
        created++;
      }
    }

    await db('knowledge_sources').where('id', sourceId).update({
      processed: true,
      processed_at: new Date(),
      articles_generated: JSON.stringify(articles.map(a => a.path)),
    });

    await this.rebuildIndex();

    logger.info(`Compiled ${source.filename}: ${created} created, ${updated} updated`);
    return { created, updated, articles: articles.map(a => ({ path: a.path, title: a.title })) };
  }

  async rebuildIndex() {
    const all = await db('knowledge_base').where('active', true).whereNot('path', 'like', 'wiki/_%').orderBy('category');

    const grouped = {};
    for (const a of all) {
      (grouped[a.category] = grouped[a.category] || []).push(a);
    }

    const indexContent = `# Waves Pest Control Knowledge Base\n\nLast updated: ${new Date().toISOString()}\nTotal articles: ${all.length}\n\n` +
      Object.entries(grouped).map(([cat, articles]) =>
        `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n${articles.map(a => `- [[${a.path}|${a.title}]] — ${a.summary || ''}`).join('\n')}`
      ).join('\n\n');

    await this.upsertSystemArticle('wiki/_index.md', 'Master Index', 'index', indexContent, 'Master index of all wiki articles');

    const summariesContent = all.map(a => {
      const tags = typeof a.tags === 'string' ? JSON.parse(a.tags) : (a.tags || []);
      return `${a.path}: ${a.summary || a.title} [${tags.join(', ')}]`;
    }).join('\n');

    await this.upsertSystemArticle('wiki/_summaries.md', 'Article Summaries', 'index', summariesContent, 'Compact summaries for context loading');
  }

  async upsertSystemArticle(articlePath, title, category, content, summary) {
    const existing = await db('knowledge_base').where('path', articlePath).first();
    if (existing) {
      await db('knowledge_base').where('id', existing.id).update({
        content, summary, last_compiled: new Date(), updated_at: new Date(),
        word_count: content.split(/\s+/).filter(Boolean).length,
      });
    } else {
      await db('knowledge_base').insert({
        path: articlePath, title, category, content, summary,
        tags: JSON.stringify([]), backlinks: JSON.stringify([]),
        source_documents: JSON.stringify([]),
        word_count: content.split(/\s+/).filter(Boolean).length,
        last_compiled: new Date(), version: 1, active: true,
      });
    }
  }

  async readSourceFile(filePath, fileType) {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    switch (fileType) {
      case 'md':
      case 'txt':
      case 'csv':
        return fs.readFileSync(filePath, 'utf-8');
      case 'json':
        return JSON.stringify(JSON.parse(fs.readFileSync(filePath, 'utf-8')), null, 2);
      case 'js':
        return fs.readFileSync(filePath, 'utf-8');
      case 'xlsx': {
        let XLSX;
        try { XLSX = require('xlsx'); } catch { return '[xlsx module not installed]'; }
        const workbook = XLSX.readFile(filePath);
        return workbook.SheetNames.map(name => {
          const sheet = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
          return `## Sheet: ${name}\n${sheet}`;
        }).join('\n\n');
      }
      default:
        try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
    }
  }

  /**
   * Compile raw content into wiki articles without needing a file on disk.
   * Used for batch-importing blog posts, code snippets, or any inline text.
   *
   * @param {Object} opts
   * @param {string} opts.content  — raw source text
   * @param {string} opts.filename — logical source identifier
   * @param {string} opts.fileType — "blog_post" | "code_comments" | "md" | etc.
   * @param {string} [opts.description]
   * @param {string} [opts.defaultCategory] — hint to the compiler ("pests", "turf", ...)
   * @param {string} [opts.originUrl] — e.g. WordPress URL, stored in source_documents
   */
  async compileFromContent({ content, filename, fileType, description, defaultCategory, originUrl }) {
    if (!content || content.length < 10) throw new Error('Content too short to compile');
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) throw new Error('Anthropic API not configured');

    // Register a source row so we have traceability
    const [source] = await db('knowledge_sources').insert({
      filename,
      file_path: originUrl || `inline:${filename}`,
      file_type: fileType,
      description: description || null,
      processed: false,
    }).returning('*');

    const index = await db('knowledge_base')
      .where('active', true)
      .select('path', 'title', 'summary', 'category')
      .orderBy('category');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const categoryHint = defaultCategory
      ? `\n\nDEFAULT CATEGORY HINT: prefer category "${defaultCategory}" unless the content clearly belongs elsewhere.`
      : '';

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: `You are the knowledge base compiler for Waves Pest Control. Read raw source documents and compile them into structured, interlinked wiki articles in markdown.

RULES:
1. Extract ALL factual, procedural, and technical knowledge
2. One article per concept, product, protocol, or procedure
3. Use [[wikilinks]] format: [[products/celsius-wg|Celsius WG]]
4. Include specific numbers: rates, temperatures, timelines, costs, measurements
5. Flag uncertainty with ⚠️ and note the source
6. Write in clear, direct prose — not bullet-point dumps
7. Include "Sources" section referencing the raw file
8. Every article starts with a 2-3 sentence summary
9. Categories: services, products, protocols, compliance, equipment, pricing, customers, pests, turf, operations, competitive, business-strategy${categoryHint}

EXISTING WIKI INDEX (for linking):
${index.map(a => `- ${a.path}: ${a.title}`).join('\n') || '(empty — this is the first compilation)'}

Return JSON array:
[{ "path": "wiki/category/article-name.md", "title": "", "summary": "", "category": "", "tags": [], "content": "full markdown", "backlinks": ["wiki/other/article.md"], "action": "create" or "update" }]`,
      messages: [{
        role: 'user',
        content: `Compile this source document into wiki articles:

SOURCE: ${filename}
TYPE: ${fileType}
DESCRIPTION: ${description || 'No description'}

CONTENT:
${content.substring(0, 50000)}`
      }]
    });

    let articles;
    try {
      articles = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
    } catch {
      await db('knowledge_sources').where('id', source.id).update({ processed: true, processed_at: new Date(), articles_generated: JSON.stringify([]) });
      throw new Error('Compiler output was not valid JSON');
    }

    let created = 0, updated = 0;
    const sourceTag = originUrl || `inline:${filename}`;

    for (const article of articles) {
      const existing = await db('knowledge_base').where('path', article.path).first();

      if (existing) {
        const existingSources = typeof existing.source_documents === 'string'
          ? JSON.parse(existing.source_documents)
          : existing.source_documents || [];
        await db('knowledge_base').where('id', existing.id).update({
          title: article.title,
          content: article.content,
          summary: article.summary,
          category: article.category,
          tags: JSON.stringify(article.tags || []),
          backlinks: JSON.stringify(article.backlinks || []),
          source_documents: JSON.stringify([...new Set([...existingSources, sourceTag])]),
          word_count: article.content.split(/\s+/).filter(Boolean).length,
          last_compiled: new Date(),
          version: existing.version + 1,
          updated_at: new Date(),
        });
        updated++;
      } else {
        await db('knowledge_base').insert({
          path: article.path,
          title: article.title,
          category: article.category,
          content: article.content,
          summary: article.summary,
          tags: JSON.stringify(article.tags || []),
          backlinks: JSON.stringify(article.backlinks || []),
          source_documents: JSON.stringify([sourceTag]),
          word_count: article.content.split(/\s+/).filter(Boolean).length,
          last_compiled: new Date(),
          version: 1,
          active: true,
        });
        created++;
      }
    }

    await db('knowledge_sources').where('id', source.id).update({
      processed: true,
      processed_at: new Date(),
      articles_generated: JSON.stringify(articles.map(a => a.path)),
    });

    return { created, updated, sourceId: source.id, articles: articles.map(a => ({ path: a.path, title: a.title })) };
  }

  /**
   * Batch-compile all published blog posts into the KB.
   * Groups posts by tag so we produce compact article clusters rather than 157 tiny stubs.
   */
  async importBlogPosts({ tagFilter, limit } = {}) {
    let query = db('blog_posts').whereIn('status', ['published', 'scheduled', 'wp_draft', 'draft']).whereNotNull('content');
    if (tagFilter) query = query.where('tag', tagFilter);
    if (limit) query = query.limit(limit);

    const posts = await query.select('id', 'title', 'tag', 'city', 'keyword', 'slug', 'content', 'meta_description');
    if (posts.length === 0) return { imported: 0, results: [], reason: 'No eligible blog posts found' };

    // Group by tag so each compile run produces a coherent cluster.
    const byTag = {};
    for (const p of posts) {
      const key = (p.tag || 'uncategorized').toLowerCase().replace(/\s+/g, '-');
      (byTag[key] = byTag[key] || []).push(p);
    }

    const results = [];
    for (const [tag, group] of Object.entries(byTag)) {
      const bundle = group.map(p => {
        const url = p.slug ? `https://www.wavespestcontrol.com/${p.slug}/` : '';
        return `# ${p.title}\n${url ? `URL: ${url}\n` : ''}${p.keyword ? `Keyword: ${p.keyword}\n` : ''}${p.city ? `City: ${p.city}\n` : ''}${p.meta_description ? `Meta: ${p.meta_description}\n` : ''}\n${p.content}`;
      }).join('\n\n---\n\n');

      // pick a category hint from tag
      const catHint = this.tagToCategory(tag);

      try {
        const r = await this.compileFromContent({
          content: bundle,
          filename: `blog-${tag}-cluster`,
          fileType: 'blog_post',
          description: `Batch of ${group.length} blog posts tagged "${tag}"`,
          defaultCategory: catHint,
          originUrl: `blog_posts:${tag}`,
        });
        results.push({ tag, posts: group.length, ...r });
      } catch (err) {
        results.push({ tag, posts: group.length, error: err.message });
      }
    }

    await this.rebuildIndex();

    const imported = results.reduce((sum, r) => sum + (r.created || 0) + (r.updated || 0), 0);
    return { imported, results };
  }

  tagToCategory(tag) {
    const t = (tag || '').toLowerCase();
    if (t.includes('pest') || t.includes('rodent') || t.includes('termite') || t.includes('ant') || t.includes('mosquito') || t.includes('bed-bug') || t.includes('spider') || t.includes('fly')) return 'pests';
    if (t.includes('lawn') || t.includes('turf') || t.includes('weed') || t.includes('fertiliz') || t.includes('grass')) return 'turf';
    if (t.includes('tree') || t.includes('shrub') || t.includes('palm')) return 'turf';
    if (t.includes('seasonal') || t.includes('winter') || t.includes('summer') || t.includes('spring') || t.includes('fall')) return 'operations';
    return 'pests';
  }

  /**
   * Seed the KB from the flat-file wiki/ folder at repo root.
   * Registers each .md file as a knowledge_source (if not already present) and compiles them.
   */
  async seedFromWikiFolder(rootDir) {
    const wikiRoot = rootDir || path.resolve(__dirname, '../../../wiki');
    if (!fs.existsSync(wikiRoot)) return { seeded: 0, reason: `wiki folder not found: ${wikiRoot}` };

    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(full);
      }
    };
    walk(wikiRoot);

    const results = [];
    for (const filePath of files) {
      const filename = path.relative(wikiRoot, filePath);
      const existing = await db('knowledge_sources').where('file_path', filePath).first();
      let sourceId;
      if (existing) {
        sourceId = existing.id;
      } else {
        const [row] = await db('knowledge_sources').insert({
          filename, file_path: filePath, file_type: 'md',
          description: `Seeded from wiki/ folder (${filename})`,
          processed: false,
        }).returning('*');
        sourceId = row.id;
      }
      try {
        const r = await this.compileSource(sourceId);
        results.push({ filename, ...r });
      } catch (err) {
        results.push({ filename, error: err.message });
      }
    }
    return { seeded: results.length, results };
  }

  async compileAllUnprocessed() {
    const sources = await db('knowledge_sources').where('processed', false);
    const results = [];
    for (const source of sources) {
      try {
        const result = await this.compileSource(source.id);
        results.push({ source: source.filename, ...result });
      } catch (err) {
        results.push({ source: source.filename, error: err.message });
      }
    }
    return results;
  }
}

module.exports = new WikiCompiler();
