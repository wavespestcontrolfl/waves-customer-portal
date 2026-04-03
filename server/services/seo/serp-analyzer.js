const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');

class SERPAnalyzer {
  async analyzeKeyword(keywordId) {
    const kw = await db('seo_target_keywords').where('id', keywordId).first();
    if (!kw) throw new Error('Keyword not found');

    const location = kw.primary_city ? `${kw.primary_city},Florida,United States` : 'Bradenton,Florida,United States';
    const serpData = await dataforseo.serpOrganic(kw.keyword, location);

    if (!serpData?.tasks?.[0]?.result?.[0]) {
      return { keyword: kw.keyword, error: 'No SERP data available' };
    }

    const result = serpData.tasks[0].result[0];
    const items = (result.items || []).filter(i => i.type === 'organic');

    const top10 = items.slice(0, 10).map(i => ({
      url: i.url, domain: i.domain, title: i.title,
      type: this.classifyResult(i.domain, i.url),
      description: i.description?.substring(0, 200),
    }));

    const mapData = await dataforseo.serpMaps(kw.keyword, location);
    const mapResults = (mapData?.tasks?.[0]?.result?.[0]?.items || []).slice(0, 5).map(m => ({
      business: m.title, reviews: m.reviews_count, rating: m.rating, categories: m.category,
    }));

    const features = {
      faq: items.some(i => i.type === 'faq'),
      paa: (result.items || []).some(i => i.type === 'people_also_ask'),
      ai_overview: (result.items || []).some(i => i.type === 'ai_overview'),
      local_pack: (result.items || []).some(i => i.type === 'maps'),
      featured_snippet: (result.items || []).some(i => i.type === 'featured_snippet'),
    };

    const difficulty = this.scoreDifficulty(top10);

    const analysis = {
      keyword_id: keywordId,
      analysis_date: new Date().toISOString().split('T')[0],
      top_10_results: JSON.stringify(top10),
      map_pack_results: JSON.stringify(mapResults),
      dominant_page_type: this.getDominantType(top10),
      content_length_consensus: JSON.stringify({ median: 1500, note: 'estimated' }),
      required_schema: JSON.stringify(['LocalBusiness', 'Service', 'FAQPage']),
      serp_features_present: JSON.stringify(features),
      difficulty_score: difficulty,
      recommendation: this.getRecommendation(kw, top10, difficulty),
    };

    await db('seo_serp_analyses').insert(analysis);
    return { ...analysis, top_10_results: top10, map_pack_results: mapResults };
  }

  classifyResult(domain, url) {
    if (['yelp.com', 'angi.com', 'homeadvisor.com', 'thumbtack.com', 'bbb.org'].some(d => (domain || '').includes(d))) return 'directory';
    if (['orkin.com', 'terminix.com', 'trulynolen.com'].some(d => (domain || '').includes(d))) return 'national_brand';
    if ((url || '').includes('/blog') || (url || '').includes('/article')) return 'blog';
    return 'local_service_page';
  }

  getDominantType(results) {
    const types = results.map(r => r.type);
    const counts = {};
    types.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  }

  scoreDifficulty(results) {
    const nationals = results.filter(r => r.type === 'national_brand').length;
    const directories = results.filter(r => r.type === 'directory').length;
    return Math.min(10, 3 + nationals * 2 + Math.max(0, directories - 2));
  }

  getRecommendation(kw, results, difficulty) {
    const wavesPresent = results.some(r => (r.domain || '').includes('wavespestcontrol'));
    if (wavesPresent) return `Already ranking — optimize existing page for better position`;
    if (difficulty <= 4) return `Low competition — create targeted ${kw.primary_city} landing page`;
    if (difficulty <= 7) return `Moderate — build authoritative guide with local signals + schema`;
    return `High difficulty — focus on long-tail variations and build supporting content first`;
  }
}

module.exports = new SERPAnalyzer();
