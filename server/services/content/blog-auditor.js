const db = require('../../models/db');
const logger = require('../logger');

class BlogAuditor {
  async runFullAudit() {
    logger.info('Running blog content audit...');
    const allPosts = await db('blog_posts').orderBy('publish_date', 'desc');
    const published = allPosts.filter(p => p.status === 'published');
    const drafts = allPosts.filter(p => ['wp_draft', 'draft'].includes(p.status));
    const queued = allPosts.filter(p => p.status === 'queued');
    const ideas = allPosts.filter(p => p.status === 'idea');

    const audit = {
      total: allPosts.length,
      published: published.length,
      drafts: drafts.length,
      queued: queued.length,
      ideas: ideas.length,

      // ISSUE 1: Duplicates
      duplicates: this.findDuplicates(allPosts),

      // ISSUE 2: Low SEO scores (<70)
      lowSEO: published.filter(p => p.seo_score != null && p.seo_score < 70).map(p => ({
        id: p.id, title: p.title, score: p.seo_score, keyword: p.keyword, slug: p.slug,
      })),

      // ISSUE 3: No keyword
      noKeyword: published.filter(p => !p.keyword || p.keyword === 'Not Set').map(p => ({
        id: p.id, title: p.title,
      })),

      // ISSUE 4: No tags
      noTags: published.filter(p => !p.tag).map(p => ({ id: p.id, title: p.title })),

      // ISSUE 5: Missing meta description
      noMeta: published.filter(p => !p.meta_description).map(p => ({ id: p.id, title: p.title })),

      // ISSUE 6: Thin content (<500 words)
      thinContent: published.filter(p => p.word_count && p.word_count < 500).map(p => ({
        id: p.id, title: p.title, wordCount: p.word_count,
      })),

      // ISSUE 7: No internal links
      noInternalLinks: published.filter(p => {
        const html = p.content_html || '';
        return (html.match(/href="https?:\/\/wavespestcontrol\.com/g) || []).length === 0;
      }).map(p => ({ id: p.id, title: p.title })),

      // ISSUE 8: City distribution
      cityDistribution: this.analyzeCityDistribution(published),

      // ISSUE 9: Topic distribution
      topicDistribution: this.analyzeTopicDistribution(allPosts),

      // ISSUE 10: Stale drafts (>2 weeks old)
      staleDrafts: drafts.filter(p => {
        const age = Date.now() - new Date(p.updated_at || p.created_at).getTime();
        return age > 14 * 86400000;
      }).map(p => ({ id: p.id, title: p.title, lastModified: p.updated_at })),

      // ISSUE 11: Calendar overlap
      calendarOverlap: this.findCalendarOverlap(queued, published),

      // ISSUE 12: No featured image
      noImage: published.filter(p => !p.featured_image_url).map(p => ({ id: p.id, title: p.title })),

      // Top performers
      topPerformers: published
        .filter(p => p.seo_score != null)
        .sort((a, b) => (b.seo_score || 0) - (a.seo_score || 0))
        .slice(0, 10)
        .map(p => ({ id: p.id, title: p.title, score: p.seo_score, keyword: p.keyword })),
    };

    // Generate recommendations
    audit.recommendations = this.generateRecommendations(audit);

    logger.info(`Blog audit complete: ${audit.total} posts, ${audit.recommendations.length} recommendations`);
    return audit;
  }

  findDuplicates(posts) {
    const dupes = [];
    const seen = new Map();

    for (const p of posts) {
      const normalizedTitle = (p.title || '').toLowerCase()
        .replace(/in (bradenton|lakewood ranch|sarasota|venice|north port|parrish|palmetto|port charlotte),?\s*(fl)?/gi, '')
        .replace(/[^a-z0-9\s]/g, '').trim();

      const normalizedKeyword = (p.keyword || '').toLowerCase().trim();

      if (normalizedTitle && seen.has(normalizedTitle)) {
        const original = seen.get(normalizedTitle);
        dupes.push({
          post1: { id: original.id, title: original.title, status: original.status },
          post2: { id: p.id, title: p.title, status: p.status },
          matchType: 'title',
        });
      } else if (normalizedKeyword && normalizedKeyword.length > 5 && seen.has('kw:' + normalizedKeyword)) {
        const original = seen.get('kw:' + normalizedKeyword);
        dupes.push({
          post1: { id: original.id, title: original.title, status: original.status },
          post2: { id: p.id, title: p.title, status: p.status },
          matchType: 'keyword',
        });
      }

      if (normalizedTitle) seen.set(normalizedTitle, p);
      if (normalizedKeyword) seen.set('kw:' + normalizedKeyword, p);
    }

    return dupes;
  }

  analyzeCityDistribution(posts) {
    const cities = {};
    for (const p of posts) {
      const city = p.city || 'No City';
      cities[city] = (cities[city] || 0) + 1;
    }

    const total = posts.length;
    const targetPerCity = Math.round(total / 8);

    return {
      counts: cities,
      overrepresented: Object.entries(cities).filter(([, c]) => c > targetPerCity * 1.5).map(([city, count]) => ({ city, count, target: targetPerCity })),
      underrepresented: Object.entries(cities).filter(([city, c]) => city !== 'No City' && c < targetPerCity * 0.5).map(([city, count]) => ({ city, count, target: targetPerCity })),
    };
  }

  analyzeTopicDistribution(posts) {
    const topics = {};
    for (const p of posts) {
      const tag = p.tag || 'Uncategorized';
      topics[tag] = (topics[tag] || 0) + 1;
    }

    const expectedTopics = ['Pest Control', 'Lawn Care', 'Termites', 'Rodents', 'Mosquitoes', 'Cockroaches', 'Ants', 'Flying Insects', 'Bed Bugs', 'Spiders', 'Lawn Pests', 'Weed Control', 'Fertilization'];
    const missing = expectedTopics.filter(t => !topics[t] || topics[t] < 3);

    const gaps = [];
    if ((topics['Mosquitoes'] || 0) < 5) gaps.push('Mosquitoes: only ' + (topics['Mosquitoes'] || 0) + ' posts — core revenue service needs 8+');
    if (!topics['Bed Bugs']) gaps.push('Bed Bugs: 0 posts — high-ticket service with no content');
    if (!topics['Fire Ants']) gaps.push('Fire Ants: 0 posts — common SWFL pest');
    if (!topics['Commercial']) gaps.push('Commercial pest control: 0 posts — missing service line');
    if (!topics['WDO']) gaps.push('WDO inspections: 0 posts — high-conversion real estate topic');

    return { counts: topics, missing, gaps };
  }

  findCalendarOverlap(queued, published) {
    const overlaps = [];
    for (const q of queued) {
      const qKeyword = (q.keyword || '').toLowerCase();
      if (!qKeyword || qKeyword.length < 5) continue;

      for (const p of published) {
        const pKeyword = (p.keyword || '').toLowerCase();
        if (!pKeyword) continue;

        if (qKeyword.includes(pKeyword) || pKeyword.includes(qKeyword)) {
          overlaps.push({
            queued: { id: q.id, title: q.title, keyword: q.keyword, city: q.city },
            existing: { id: p.id, title: p.title, keyword: p.keyword, city: p.city, status: p.status },
            overlapType: 'keyword',
          });
        }
      }
    }
    return overlaps;
  }

  generateRecommendations(audit) {
    const recs = [];

    if (audit.duplicates.length > 0) {
      recs.push({ priority: 'critical', title: `${audit.duplicates.length} duplicate/overlapping posts found`, action: 'Merge, redirect, or differentiate to avoid keyword cannibalization' });
    }
    if (audit.lowSEO.length > 0) {
      recs.push({ priority: 'high', title: `${audit.lowSEO.length} published posts scoring below 70 SEO`, action: 'Optimize: add keyword to title/H1, improve meta, add internal links' });
    }
    if (audit.staleDrafts.length > 0) {
      recs.push({ priority: 'high', title: `${audit.staleDrafts.length} draft posts sitting 2+ weeks unpublished`, action: 'Publish, update, or delete these stale drafts' });
    }
    if (audit.noInternalLinks.length > 0) {
      recs.push({ priority: 'high', title: `${audit.noInternalLinks.length} published posts with zero internal links`, action: 'Add 2-4 internal links — fast SEO win' });
    }
    if (audit.noKeyword.length > 0) {
      recs.push({ priority: 'medium', title: `${audit.noKeyword.length} published posts without focus keyword`, action: 'Set focus keyword in Yoast/AIOSEO' });
    }

    const topicGaps = audit.topicDistribution.gaps || [];
    for (const gap of topicGaps) {
      recs.push({ priority: 'medium', title: gap, action: 'Generate content to fill this gap' });
    }

    if (audit.calendarOverlap.length > 0) {
      recs.push({ priority: 'medium', title: `${audit.calendarOverlap.length} queued posts overlap with published content`, action: 'Review for cannibalization — differentiate angle or replace with fresh topic' });
    }

    return recs;
  }
}

module.exports = new BlogAuditor();
