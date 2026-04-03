const db = require('../../models/db');
const logger = require('../logger');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

class WikiLinter {

  async runHealthCheck() {
    logger.info('Running wiki health check...');
    const articles = await db('knowledge_base').where('active', true);

    if (articles.length === 0) {
      return { totalArticles: 0, issues: [], healthScore: 100, note: 'Knowledge base is empty — add sources and compile.' };
    }

    const issues = [];

    // Check 1: Broken backlinks
    const allPaths = new Set(articles.map(a => a.path));
    for (const article of articles) {
      const links = typeof article.backlinks === 'string' ? JSON.parse(article.backlinks) : (article.backlinks || []);
      for (const link of links) {
        if (!allPaths.has(link)) {
          issues.push({ type: 'broken_link', article: article.path, title: article.title, detail: `Links to "${link}" which doesn't exist`, severity: 'medium' });
        }
      }
    }

    // Check 2: Orphaned articles (nothing links to them)
    const linkedTo = new Set();
    for (const a of articles) {
      const links = typeof a.backlinks === 'string' ? JSON.parse(a.backlinks) : (a.backlinks || []);
      links.forEach(l => linkedTo.add(l));
    }
    for (const a of articles) {
      if (!linkedTo.has(a.path) && !a.path.startsWith('wiki/_')) {
        issues.push({ type: 'orphaned', article: a.path, title: a.title, detail: 'No other articles link to this one', severity: 'low' });
      }
    }

    // Check 3: Stale articles (>90 days since compilation)
    const staleDate = new Date(Date.now() - 90 * 86400000);
    for (const a of articles) {
      if (a.last_compiled && new Date(a.last_compiled) < staleDate && !a.path.startsWith('wiki/_')) {
        const daysSince = Math.round((Date.now() - new Date(a.last_compiled).getTime()) / 86400000);
        issues.push({ type: 'stale', article: a.path, title: a.title, detail: `Last compiled ${daysSince} days ago`, severity: 'medium' });
      }
    }

    // Check 4: Thin articles (<100 words)
    for (const a of articles) {
      if (a.word_count && a.word_count < 100 && !a.path.startsWith('wiki/_')) {
        issues.push({ type: 'thin', article: a.path, title: a.title, detail: `Only ${a.word_count} words`, severity: 'low' });
      }
    }

    // Check 5: Missing summaries
    for (const a of articles) {
      if (!a.summary && !a.path.startsWith('wiki/_')) {
        issues.push({ type: 'no_summary', article: a.path, title: a.title, detail: 'Missing summary', severity: 'low' });
      }
    }

    // Check 6: Empty tags
    for (const a of articles) {
      const tags = typeof a.tags === 'string' ? JSON.parse(a.tags) : (a.tags || []);
      if (tags.length === 0 && !a.path.startsWith('wiki/_')) {
        issues.push({ type: 'no_tags', article: a.path, title: a.title, detail: 'No tags assigned', severity: 'low' });
      }
    }

    // Check 7: Category coverage gaps
    const categories = {};
    for (const a of articles) {
      if (a.category && a.category !== 'index') {
        categories[a.category] = (categories[a.category] || 0) + 1;
      }
    }
    const expectedCategories = ['services', 'products', 'protocols', 'compliance', 'equipment', 'pricing', 'customers', 'pests', 'turf', 'operations'];
    for (const cat of expectedCategories) {
      if (!categories[cat]) {
        issues.push({ type: 'missing_category', article: cat, title: cat, detail: `No articles in "${cat}" category`, severity: 'medium' });
      }
    }

    const healthScore = Math.max(0, Math.min(100, 100 - issues.filter(i => i.severity === 'high').length * 10 - issues.filter(i => i.severity === 'medium').length * 5 - issues.filter(i => i.severity === 'low').length * 2));

    const result = {
      totalArticles: articles.length,
      categoryCounts: categories,
      issues,
      issueCounts: {
        broken_link: issues.filter(i => i.type === 'broken_link').length,
        orphaned: issues.filter(i => i.type === 'orphaned').length,
        stale: issues.filter(i => i.type === 'stale').length,
        thin: issues.filter(i => i.type === 'thin').length,
        missing_category: issues.filter(i => i.type === 'missing_category').length,
      },
      healthScore,
    };

    logger.info(`Wiki health check: ${articles.length} articles, score ${healthScore}/100, ${issues.length} issues`);
    return result;
  }
}

module.exports = new WikiLinter();
