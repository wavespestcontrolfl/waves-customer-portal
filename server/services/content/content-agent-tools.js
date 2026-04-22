/**
 * Content Agent — Tool Executor
 *
 * Maps each custom tool call from the Managed Agent
 * to existing service methods. No new business logic —
 * just wiring.
 */

const db = require('../../models/db');
const logger = require('../logger');

// Lazy-load services to avoid circular deps
const getService = (name) => {
  const map = {
    BlogWriter: () => require('./blog-writer'),
    ContentQA: () => require('../seo/content-qa'),
    ContentScheduler: () => require('../content-scheduler'),
    SocialMedia: () => require('../social-media'),
    WikiQA: () => require('../knowledge/wiki-qa'),
  };
  return map[name]();
};

async function executeContentTool(toolName, input) {
  switch (toolName) {

    // ── Research tools ────────────────────────────────────────

    case 'get_fawn_weather': {
      let weather = {};
      try {
        const fawnRes = await fetch('https://fawn.ifas.ufl.edu/controller.php/lastObservation/summary/');
        if (fawnRes.ok) {
          const fawnData = await fawnRes.json();
          const station = (fawnData || []).find(s =>
            (s.StationName || '').toLowerCase().includes('manatee') ||
            (s.StationName || '').toLowerCase().includes('myakka') ||
            (s.StationName || '').toLowerCase().includes('sarasota')
          ) || fawnData?.[0];
          if (station) {
            weather = {
              temp_f: station.AirTemp_Avg || station.t2m_avg,
              humidity_pct: station.RelHum_Avg || station.rh_avg,
              rainfall_in: station.Rain_Tot || station.rain_sum,
              soil_temp_f: station.SoilTemp4_Avg || station.ts4_avg,
              station: station.StationName || 'FAWN SWFL',
              timestamp: new Date().toISOString(),
            };
          }
        }
      } catch { weather = { error: 'FAWN data unavailable — use seasonal defaults' }; }

      // Content signals based on season
      const month = new Date().getMonth();
      const signals = [];
      if (month >= 3 && month <= 9) signals.push('Mosquito season active — high search volume');
      if (month >= 4 && month <= 8) signals.push('Chinch bug pressure peak in SWFL');
      if (month >= 5 && month <= 8) signals.push('Nitrogen blackout in effect (Sarasota + Manatee counties)');
      if (month >= 2 && month <= 4) signals.push('Termite swarm season — swarmer reports trending');
      if (month >= 5 && month <= 9) signals.push('Afternoon thunderstorms — reschedule content relevant');
      if (month >= 0 && month <= 2) signals.push('Pre-emergent window — lawn content peak');
      if (month >= 9 && month <= 11) signals.push('Rodent season ramping — attic entry point content');

      return { weather, signals, month: month + 1 };
    }

    case 'get_pest_pressure': {
      const month = input.month || (new Date().getMonth() + 1);
      let query = db('seasonal_pest_index').where({ month });
      if (input.service_line) query = query.where({ service_line: input.service_line });
      const pests = await query.orderBy('sort_order');
      return {
        month,
        pests: pests.map(p => ({
          pest: p.pest_name,
          service_line: p.service_line,
          pressure: p.pressure_level,
          description: p.description,
          treatment: p.treatment_if_found,
        })),
      };
    }

    case 'search_knowledge_base': {
      const WikiQA = getService('WikiQA');
      const result = await WikiQA.query(input.topic, { source: 'content_agent' });
      return { answer: result.answer, sources: result.articlesUsed || [] };
    }

    case 'check_existing_content': {
      const keyword = (input.keyword || '').toLowerCase();
      const city = input.city || null;

      const matches = await db('blog_posts')
        .where(function () {
          if (keyword.length > 3) {
            this.whereRaw('LOWER(keyword) LIKE ?', [`%${keyword}%`])
              .orWhereRaw('LOWER(title) LIKE ?', [`%${keyword}%`]);
          }
        })
        .whereIn('status', ['published', 'queued', 'draft', 'wp_draft'])
        .orderBy('publish_date', 'desc')
        .limit(20)
        .select('id', 'title', 'keyword', 'city', 'slug', 'status', 'word_count', 'seo_score', 'publish_date');

      return {
        total_matches: matches.length,
        posts: matches.map(p => ({
          title: p.title,
          keyword: p.keyword,
          city: p.city,
          slug: p.slug,
          status: p.status,
          word_count: p.word_count,
          seo_score: p.seo_score,
          published: p.publish_date,
        })),
        same_city: city ? matches.filter(m => m.city === city).length : null,
        differentiation_needed: matches.length > 0,
      };
    }

    case 'get_content_gaps': {
      const allPosts = await db('blog_posts')
        .whereIn('status', ['published', 'queued', 'draft'])
        .select('tag', 'city');

      const tagCounts = {};
      const cityCounts = {};
      for (const p of allPosts) {
        if (p.tag) tagCounts[p.tag] = (tagCounts[p.tag] || 0) + 1;
        if (p.city) cityCounts[p.city] = (cityCounts[p.city] || 0) + 1;
      }

      const targetCities = ['Bradenton', 'Lakewood Ranch', 'Sarasota', 'Venice', 'North Port', 'Parrish', 'Palmetto', 'Port Charlotte'];
      const cityGaps = targetCities
        .map(c => ({ city: c, count: cityCounts[c] || 0 }))
        .sort((a, b) => a.count - b.count);

      const tagGaps = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => a.count - b.count);

      return {
        total_posts: allPosts.length,
        by_topic: tagGaps,
        by_city: cityGaps,
        underrepresented_cities: cityGaps.filter(c => c.count < 15).map(c => c.city),
        underrepresented_topics: tagGaps.filter(t => t.count < 8).map(t => t.tag),
      };
    }

    // ── Writing tools ─────────────────────────────────────────

    case 'create_blog_post': {
      const [post] = await db('blog_posts').insert({
        title: input.title,
        keyword: input.keyword,
        slug: input.slug,
        meta_description: input.meta_description,
        tag: input.tag,
        city: input.city,
        status: 'queued',
        source: 'content_agent',
        created_at: new Date(),
        updated_at: new Date(),
      }).returning('*');

      logger.info(`[content-agent] Created blog post: "${input.title}" (${post.id})`);
      return { post_id: post.id, title: post.title, status: 'queued' };
    }

    case 'generate_blog_content': {
      const BlogWriter = getService('BlogWriter');
      const result = await BlogWriter.generatePost(input.post_id);

      if (result.error) {
        return { error: result.error };
      }

      return {
        post_id: input.post_id,
        word_count: result.wordCount,
        status: 'draft',
        preview: (result.content || '').substring(0, 500) + '...',
      };
    }

    // ── Quality tools ─────────────────────────────────────────

    case 'run_content_qa': {
      const ContentQA = getService('ContentQA');
      const score = await ContentQA.scoreContent(input.post_id);

      return {
        post_id: input.post_id,
        total_score: score.totalScore,
        max_score: score.maxScore || 50,
        passing: (score.totalScore || 0) >= 35,
        categories: score.categories || {},
        failed_checks: score.failedChecks || [],
        recommendations: score.recommendations || [],
      };
    }

    // ── Publishing tools ──────────────────────────────────────

    case 'distribute_to_social': {
      const post = await db('blog_posts').where('id', input.post_id).first();
      if (!post) return { error: 'Post not found' };

      const link = post.url || `https://www.wavespestcontrol.com/${post.slug}`;
      const description = post.meta_description || (post.content || '').replace(/[#*_\[\]]/g, '').substring(0, 300);

      const SocialMedia = getService('SocialMedia');
      const result = await SocialMedia.publishToAll({
        title: post.title,
        description,
        link,
        guid: `content_agent_${post.id}`,
        source: 'content_agent',
      });

      // Mark post as shared
      try {
        await db('blog_posts').where('id', post.id).update({
          shared_to_social: true,
          shared_at: new Date(),
        });
      } catch { /* column may not exist */ }

      return {
        post_id: input.post_id,
        platforms: result.results || [],
        success_count: (result.results || []).filter(r => r.success).length,
        total_platforms: (result.results || []).length,
      };
    }

    case 'schedule_content': {
      const ContentScheduler = getService('ContentScheduler');
      await ContentScheduler.scheduleBlogPost(
        input.post_id,
        input.publish_at,
        input.auto_share_social !== false
      );

      return {
        post_id: input.post_id,
        scheduled_for: input.publish_at,
        auto_share_social: input.auto_share_social !== false,
        status: 'scheduled',
      };
    }

    default:
      return { error: `Unknown content tool: ${toolName}` };
  }
}

module.exports = { executeContentTool };
