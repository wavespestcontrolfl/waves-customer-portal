/**
 * Intelligence Bar — SEO & Content Tools
 * server/services/intelligence-bar/seo-tools.js
 *
 * Gives Claude access to GSC data, rank tracking,
 * blog content pipeline, and site health metrics for wavespestcontrol.com.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const SEO_TOOLS = [
  {
    name: 'query_gsc_performance',
    description: `Get Google Search Console performance for one or all domains. Shows clicks, impressions, avg position, CTR. Supports period comparison.
Use for: "how's our SEO doing?", "which site gets the most clicks?", "compare this month to last month for bradentonflpestcontrol.com"`,
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Specific domain (e.g. bradentonflpestcontrol.com). Omit for all domains.' },
        period_days: { type: 'number', description: 'Number of days to look back (default 28)' },
        compare: { type: 'boolean', description: 'If true, also fetch the previous period for comparison' },
        group_by: { type: 'string', enum: ['domain', 'day', 'device', 'none'], description: 'How to group results (default: domain)' },
      },
    },
  },
  {
    name: 'query_top_queries',
    description: `Get top-performing search queries from GSC. Filter by domain, service category, city, branded/non-branded.
Use for: "what keywords bring the most traffic?", "top queries for the Bradenton pest site", "best non-branded keywords"`,
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        period_days: { type: 'number', description: 'Default 28' },
        branded: { type: 'boolean', description: 'true=branded only, false=non-branded only, omit=all' },
        service_category: { type: 'string', description: 'Filter: pest, lawn, mosquito, termite, rodent, tree_shrub' },
        city: { type: 'string', description: 'Filter by target city' },
        sort: { type: 'string', enum: ['clicks', 'impressions', 'position'], description: 'Sort by (default: clicks)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'query_top_pages',
    description: `Get top-performing pages from GSC. Filter by domain, page type, service category.
Use for: "which pages get the most traffic?", "best performing blog posts in GSC", "top city pages"`,
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        period_days: { type: 'number' },
        page_type: { type: 'string', enum: ['homepage', 'city', 'service', 'blog', 'landing'] },
        service_category: { type: 'string' },
        sort: { type: 'string', enum: ['clicks', 'impressions', 'position'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'query_seo_rankings',
    description: `Check keyword rank tracking positions. Shows current positions, changes over time, map pack positions, and AI overview citations.
Use for: "which keywords dropped this week?", "how do we rank for pest control bradenton?", "any ranking improvements?"`,
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search for a specific keyword' },
        service_category: { type: 'string' },
        city: { type: 'string' },
        only_drops: { type: 'boolean', description: 'Only show keywords that dropped in position' },
        only_gains: { type: 'boolean', description: 'Only show keywords that improved' },
        days_back: { type: 'number', description: 'Compare to N days ago (default 7)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'check_site_health',
    description: `Check site health: PageSpeed scores, SSL status, content status, blog counts, schema deployment, GA4 status, indexing issues.
Use for: "how's the site health?", "PageSpeed scores", "any indexing issues?", "schema status"`,
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to check (default: wavespestcontrol.com)' },
        check: { type: 'string', enum: ['all', 'pagespeed', 'content', 'ssl', 'schema', 'indexing'], description: 'What to check (default: all)' },
      },
    },
  },
  {
    name: 'query_blog_performance',
    description: `Analyze blog post performance: top posts by traffic, content pipeline status, posts per domain, word counts, SEO scores.
Use for: "what blog posts got the most traffic?", "how many posts are published vs queued?", "best performing blog content"`,
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued', 'draft', 'wp_draft', 'scheduled', 'published', 'idea', 'all'], description: 'Filter by status' },
        domain: { type: 'string', description: 'Filter by target domain' },
        tag: { type: 'string', description: 'Filter by tag (Pest Control, Lawn Care, etc.)' },
        city: { type: 'string' },
        sort: { type: 'string', enum: ['publish_date', 'word_count', 'seo_score', 'created_at'], description: 'Sort by' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_content_pipeline',
    description: `Get the content pipeline overview: posts by status, upcoming calendar, generation queue, posts per domain.
Use for: "what's in the content pipeline?", "how many posts are ready to publish?", "content calendar for next 2 weeks"`,
    input_schema: {
      type: 'object',
      properties: {
        weeks_ahead: { type: 'number', description: 'How many weeks ahead to show in calendar (default 4)' },
      },
    },
  },
  {
    name: 'get_backlink_overview',
    description: `Get backlink metrics: total backlinks, new/lost, referring domains, strategy reports, agent queue status.
Use for: "how are our backlinks?", "any new backlinks this week?", "backlink strategy report"`,
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
      },
    },
  },
  {
    name: 'compare_domains',
    description: `Compare performance metrics across tracked domains in GSC. Shows clicks, impressions, PageSpeed, blog count, content status.
Use for: "how is wavespestcontrol.com performing?", "compare traffic by section", "site performance overview"`,
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['clicks', 'impressions', 'pagespeed', 'blog_count', 'content_status'], description: 'Which metric to compare (default: clicks)' },
        period_days: { type: 'number', description: 'For GSC metrics, how many days back (default 28)' },
        site_type: { type: 'string', enum: ['pest_control', 'exterminator', 'lawn_care', 'all'], description: 'Filter by site vertical' },
      },
    },
  },
  {
    name: 'get_content_decay_alerts',
    description: `Check for content decay and keyword cannibalization. Shows pages losing traffic, keywords cannibalizing each other.
Use for: "any content decay issues?", "are any pages cannibalizing each other?", "which content needs refreshing?"`,
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
      },
    },
  },
  {
    name: 'get_semantic_concept_map',
    description: `Get the semantic concept cluster map for a service line. Returns the full concept hub: core concept, related subtopics, required entities (products, institutions, species, geography), and content architecture recommendations.
Use for: "show me the concept map for pest control", "what entities should our lawn care pages cover?", "semantic map for termite content", "what's the concept cluster for mosquito control?"`,
    input_schema: {
      type: 'object',
      properties: {
        service_line: { type: 'string', enum: ['pest_control', 'lawn_care', 'mosquito', 'termite', 'tree_shrub', 'rodent'], description: 'Which service line concept cluster to return' },
      },
      required: ['service_line'],
    },
  },
  {
    name: 'score_page_refresh_priority',
    description: `Score pages for refresh priority based on ranking drops, content age, entity coverage, FAQ completeness, and traffic potential. Returns a prioritized list of pages most likely to benefit from a semantic refresh.
Use for: "which pages should I refresh first?", "page refresh priority list", "what's the best ROI content update?", "score our service pages for refresh"`,
    input_schema: {
      type: 'object',
      properties: {
        service_category: { type: 'string', description: 'Filter by service type: pest, lawn, mosquito, termite, rodent, tree_shrub' },
        city: { type: 'string', description: 'Filter by target city' },
        limit: { type: 'number', description: 'Max results (default 15)' },
      },
    },
  },
  {
    name: 'get_content_workflow_brief',
    description: `Generate a structured content workflow brief for a target keyword/page following the semantic SEO process: SERP consensus → entity map → content blueprint → writing brief. Returns a step-by-step action plan.
Use for: "create a content brief for pest control bradenton", "workflow brief for lawn care sarasota page", "how should I refresh the termite page?", "build me a brief for mosquito control venice"`,
    input_schema: {
      type: 'object',
      properties: {
        target_keyword: { type: 'string', description: 'The primary keyword or topic to build a brief for' },
        page_url: { type: 'string', description: 'Existing page URL if this is a refresh (optional)' },
        brief_type: { type: 'string', enum: ['new_page', 'page_refresh', 'blog_post', 'concept_hub'], description: 'Type of content (default: page_refresh)' },
      },
      required: ['target_keyword'],
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeSeoTool(toolName, input) {
  try {
    switch (toolName) {
      case 'query_gsc_performance': return await queryGscPerformance(input);
      case 'query_top_queries': return await queryTopQueries(input);
      case 'query_top_pages': return await queryTopPages(input);
      case 'query_seo_rankings': return await querySeoRankings(input);
      case 'check_site_health': return await checkSiteHealth(input);
      case 'query_blog_performance': return await queryBlogPerformance(input);
      case 'get_content_pipeline': return await getContentPipeline(input);
      case 'get_backlink_overview': return await getBacklinkOverview(input);
      case 'compare_domains': return await compareDomains(input);
      case 'get_content_decay_alerts': return await getContentDecayAlerts(input);
      case 'get_semantic_concept_map': return await getSemanticConceptMap(input);
      case 'score_page_refresh_priority': return await scorePageRefreshPriority(input);
      case 'get_content_workflow_brief': return await getContentWorkflowBrief(input);
      default: return { error: `Unknown SEO tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:seo] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function queryGscPerformance(input) {
  const { domain, period_days = 28, compare = false, group_by = 'domain' } = input;
  const since = etDateString(addETDays(new Date(), -period_days));
  const today = etDateString();

  async function fetchPeriod(from, to, groupBy) {
    let query = db('gsc_performance_daily').whereBetween('date', [from, to]);
    if (domain) query = query.where('domain', domain);

    if (groupBy === 'domain') {
      return query.select('domain')
        .sum('clicks as clicks').sum('impressions as impressions')
        .avg('avg_position as avg_position')
        .groupBy('domain').orderByRaw('SUM(clicks) DESC');
    }
    if (groupBy === 'day') {
      return query.select('date')
        .sum('clicks as clicks').sum('impressions as impressions')
        .avg('avg_position as avg_position')
        .groupBy('date').orderBy('date');
    }
    // totals
    return query.select(
      db.raw('SUM(clicks) as clicks'),
      db.raw('SUM(impressions) as impressions'),
      db.raw('AVG(avg_position) as avg_position'),
    );
  }

  const current = await fetchPeriod(since, today, group_by);
  let previous = null;
  if (compare) {
    const prevEnd = etDateString(addETDays(new Date(), -period_days));
    const prevStart = etDateString(addETDays(new Date(), -period_days * 2));
    previous = await fetchPeriod(prevStart, prevEnd, group_by);
  }

  const fmt = rows => (Array.isArray(rows) ? rows : [rows]).map(r => ({
    domain: r.domain || domain || 'all',
    date: r.date || undefined,
    clicks: parseInt(r.clicks || 0),
    impressions: parseInt(r.impressions || 0),
    avg_position: parseFloat(parseFloat(r.avg_position || 0).toFixed(1)),
    ctr: parseInt(r.impressions || 0) > 0 ? Math.round(parseInt(r.clicks || 0) / parseInt(r.impressions || 0) * 10000) / 100 : 0,
  }));

  return {
    period: { from: since, to: today, days: period_days },
    current: fmt(current),
    previous: previous ? fmt(previous) : null,
    total_clicks: fmt(current).reduce((s, r) => s + r.clicks, 0),
    total_impressions: fmt(current).reduce((s, r) => s + r.impressions, 0),
  };
}


async function queryTopQueries(input) {
  const { domain, period_days = 28, branded, service_category, city, sort = 'clicks', limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);
  const since = etDateString(addETDays(new Date(), -period_days));

  let query = db('gsc_queries').where('date', '>=', since)
    .select('query', 'is_branded', 'service_category', 'city_target', 'intent_type')
    .sum('clicks as clicks').sum('impressions as impressions')
    .avg('position as avg_position')
    .groupBy('query', 'is_branded', 'service_category', 'city_target', 'intent_type');

  if (domain) query = query.where('domain', domain);
  if (branded === true) query = query.where('is_branded', true);
  if (branded === false) query = query.where('is_branded', false);
  if (service_category) query = query.where('service_category', service_category);
  if (city) query = query.where('city_target', city);

  const sortCol = sort === 'position' ? 'avg_position' : sort;
  const rows = await query.orderBy(sortCol, sort === 'position' ? 'asc' : 'desc').limit(limit);

  return {
    queries: rows.map(r => ({
      query: r.query,
      clicks: parseInt(r.clicks || 0),
      impressions: parseInt(r.impressions || 0),
      avg_position: parseFloat(parseFloat(r.avg_position || 0).toFixed(1)),
      ctr: parseInt(r.impressions || 0) > 0 ? Math.round(parseInt(r.clicks || 0) / parseInt(r.impressions || 0) * 10000) / 100 : 0,
      branded: r.is_branded,
      category: r.service_category,
      city: r.city_target,
      intent: r.intent_type,
    })),
    period_days,
    total: rows.length,
  };
}


async function queryTopPages(input) {
  const { domain, period_days = 28, page_type, service_category, sort = 'clicks', limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);
  const since = etDateString(addETDays(new Date(), -period_days));

  let query = db('gsc_pages').where('date', '>=', since)
    .select('page_url', 'page_type', 'service_category', 'city_target')
    .sum('clicks as clicks').sum('impressions as impressions')
    .avg('position as avg_position')
    .groupBy('page_url', 'page_type', 'service_category', 'city_target');

  if (domain) query = query.where('domain', domain);
  if (page_type) query = query.where('page_type', page_type);
  if (service_category) query = query.where('service_category', service_category);

  const rows = await query.orderBy(sort === 'position' ? 'avg_position' : sort, sort === 'position' ? 'asc' : 'desc').limit(limit);

  return {
    pages: rows.map(r => ({
      url: r.page_url,
      type: r.page_type,
      category: r.service_category,
      city: r.city_target,
      clicks: parseInt(r.clicks || 0),
      impressions: parseInt(r.impressions || 0),
      avg_position: parseFloat(parseFloat(r.avg_position || 0).toFixed(1)),
      ctr: parseInt(r.impressions || 0) > 0 ? Math.round(parseInt(r.clicks || 0) / parseInt(r.impressions || 0) * 10000) / 100 : 0,
    })),
    total: rows.length,
  };
}


async function querySeoRankings(input) {
  const { keyword, service_category, city, only_drops, only_gains, days_back = 7, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 30, 100);
  const compareDate = etDateString(addETDays(new Date(), -days_back));

  let kwQuery = db('seo_target_keywords as k')
    .leftJoin(db.raw(`(SELECT keyword_id, organic_position, map_pack_position, ai_overview_cited FROM seo_rank_history WHERE check_date = (SELECT MAX(check_date) FROM seo_rank_history)) as latest ON k.id = latest.keyword_id`))
    .leftJoin(db.raw(`(SELECT keyword_id, organic_position as prev_position, map_pack_position as prev_map FROM seo_rank_history WHERE check_date <= '${compareDate}' ORDER BY check_date DESC LIMIT 1) as prev ON k.id = prev.keyword_id`))
    .select(
      'k.id', 'k.keyword', 'k.primary_city', 'k.service_category', 'k.target_url', 'k.monthly_volume', 'k.priority',
      'latest.organic_position', 'latest.map_pack_position', 'latest.ai_overview_cited',
      'prev.prev_position', 'prev.prev_map',
    );

  if (keyword) kwQuery = kwQuery.whereILike('k.keyword', `%${keyword}%`);
  if (service_category) kwQuery = kwQuery.where('k.service_category', service_category);
  if (city) kwQuery = kwQuery.whereILike('k.primary_city', `%${city}%`);

  let rows = await kwQuery.limit(limit * 2); // fetch extra for filtering

  // Calculate changes
  rows = rows.map(r => {
    const current = r.organic_position;
    const prev = r.prev_position;
    const change = (current && prev) ? prev - current : null; // positive = improved
    return { ...r, position_change: change };
  });

  if (only_drops) rows = rows.filter(r => r.position_change != null && r.position_change < 0);
  if (only_gains) rows = rows.filter(r => r.position_change != null && r.position_change > 0);

  rows = rows.slice(0, limit);

  return {
    keywords: rows.map(r => ({
      keyword: r.keyword,
      city: r.primary_city,
      category: r.service_category,
      current_position: r.organic_position,
      previous_position: r.prev_position,
      change: r.position_change,
      direction: r.position_change > 0 ? 'improved' : r.position_change < 0 ? 'dropped' : 'stable',
      map_pack: r.map_pack_position,
      ai_overview: r.ai_overview_cited,
      volume: r.monthly_volume,
      target_url: r.target_url,
    })),
    compare_days: days_back,
    total: rows.length,
    drops: rows.filter(r => r.position_change < 0).length,
    gains: rows.filter(r => r.position_change > 0).length,
  };
}


async function checkSiteHealth(input) {
  const { domain, check = 'all' } = input;

  // Primary site health — wavespestcontrol.com
  let query = db('wordpress_sites').orderBy('domain');
  if (domain) query = query.whereILike('domain', `%${domain}%`);
  else query = query.whereILike('domain', '%wavespestcontrol.com%');

  const sites = await query;

  const results = sites.map(s => {
    const health = {
      domain: s.domain,
      name: s.name,
      area: s.area,
      site_type: s.site_type,
      status: s.status,
    };

    if (check === 'all' || check === 'pagespeed') {
      health.pagespeed_mobile = s.pagespeed_mobile;
      health.pagespeed_desktop = s.pagespeed_desktop;
      health.pagespeed_checked = s.pagespeed_checked_at;
      health.pagespeed_grade = s.pagespeed_mobile >= 90 ? 'good' : s.pagespeed_mobile >= 50 ? 'needs_work' : s.pagespeed_mobile ? 'poor' : 'unknown';
    }
    if (check === 'all' || check === 'content') {
      health.content_status = s.content_status;
      health.total_pages = s.total_pages;
      health.blog_post_count = s.blog_post_count;
      health.content_last_updated = s.content_last_updated;
    }
    if (check === 'all' || check === 'ssl') {
      health.ssl_expiry = s.ssl_expiry;
      health.ssl_warning = s.ssl_expiry && new Date(s.ssl_expiry) < new Date(Date.now() + 30 * 86400000);
    }
    if (check === 'all' || check === 'schema') {
      health.schema_deployed = s.schema_deployed;
      health.schema_type = s.schema_type;
      health.llms_txt_deployed = s.llms_txt_deployed;
      health.robots_ai_ok = s.robots_txt_ai_ok;
      health.ga4_active = s.ga4_active;
      health.search_console_verified = s.search_console_verified;
    }
    return health;
  });

  // Summary
  const issues = [];
  results.forEach(s => {
    if (s.pagespeed_grade === 'poor') issues.push(`${s.domain}: PageSpeed mobile ${s.pagespeed_mobile}`);
    if (s.ssl_warning) issues.push(`${s.domain}: SSL expiring soon`);
    if (s.content_status === 'needs_content' || s.content_status === 'needs_rebuild') issues.push(`${s.domain}: ${s.content_status}`);
    if (s.blog_post_count === 0) issues.push(`${s.domain}: no blog posts`);
    if (!s.schema_deployed) issues.push(`${s.domain}: schema not deployed`);
    if (!s.ga4_active) issues.push(`${s.domain}: GA4 not active`);
  });

  return {
    sites: results,
    total_sites: results.length,
    issues,
    issue_count: issues.length,
  };
}


async function queryBlogPerformance(input) {
  const { status, domain, tag, city, sort = 'publish_date', limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 30, 200);

  let query = db('blog_posts');
  if (status && status !== 'all') query = query.where('status', status);
  if (domain) query = query.where('target_domain', domain);
  if (tag) query = query.where('tag', tag);
  if (city) query = query.where('city', city);

  const posts = await query.orderBy(sort, sort === 'publish_date' ? 'desc' : 'desc').limit(limit);

  // Status counts
  const statusCounts = await db('blog_posts').select('status').count('* as count').groupBy('status');
  const counts = {};
  statusCounts.forEach(s => { counts[s.status] = parseInt(s.count); });

  // Per-domain counts
  const domainCounts = await db('blog_posts').whereNotNull('target_domain')
    .select('target_domain').count('* as count')
    .where('status', 'published')
    .groupBy('target_domain').orderByRaw('COUNT(*) DESC');

  return {
    posts: posts.map(p => ({
      id: p.id,
      title: p.title,
      keyword: p.keyword,
      tag: p.tag,
      city: p.city,
      status: p.status,
      publish_date: p.publish_date,
      word_count: p.word_count,
      seo_score: p.seo_score,
      domain: p.target_domain,
      has_content: !!p.content,
    })),
    status_counts: counts,
    total: posts.length,
    published_by_domain: domainCounts.map(d => ({ domain: d.target_domain, count: parseInt(d.count) })),
  };
}


async function getContentPipeline(input) {
  const { weeks_ahead = 4 } = input;
  const today = etDateString();
  const futureDate = etDateString(addETDays(new Date(), weeks_ahead * 7));

  const statusCounts = await db('blog_posts').select('status').count('* as count').groupBy('status');
  const counts = {};
  statusCounts.forEach(s => { counts[s.status] = parseInt(s.count); });

  const upcoming = await db('blog_posts')
    .whereBetween('publish_date', [today, futureDate])
    .orderBy('publish_date')
    .select('id', 'title', 'keyword', 'tag', 'city', 'status', 'publish_date', 'target_domain', 'word_count');

  const needsGeneration = await db('blog_posts')
    .where('status', 'queued').whereNull('content')
    .orderBy('publish_date').limit(10)
    .select('id', 'title', 'keyword', 'publish_date', 'target_domain');

  const recentlyPublished = await db('blog_posts')
    .where('status', 'published')
    .orderBy('publish_date', 'desc').limit(5)
    .select('id', 'title', 'publish_date', 'target_domain', 'word_count', 'seo_score');

  return {
    pipeline_counts: counts,
    total_posts: Object.values(counts).reduce((s, c) => s + c, 0),
    upcoming_calendar: upcoming.map(p => ({
      title: p.title,
      keyword: p.keyword,
      tag: p.tag,
      city: p.city,
      status: p.status,
      date: p.publish_date,
      domain: p.target_domain,
      has_content: !!p.word_count,
    })),
    needs_generation: needsGeneration.map(p => ({
      id: p.id, title: p.title, keyword: p.keyword, date: p.publish_date, domain: p.target_domain,
    })),
    recently_published: recentlyPublished,
  };
}


async function getBacklinkOverview(input) {
  const { domain } = input;

  let blQuery = db('seo_backlinks');
  if (domain) blQuery = blQuery.where('target_domain', domain);

  const total = await blQuery.clone().count('* as c').first();
  const byStatus = await blQuery.clone().select('status').count('* as count').groupBy('status');

  // Recent strategy reports
  const reports = await db('backlink_strategy_reports').orderBy('created_at', 'desc').limit(3)
    .select('id', 'report_type', 'status', 'summary', 'created_at');

  // Agent queue
  let queueCount = 0;
  try {
    const q = await db('backlink_agent_queue').where('status', 'pending').count('* as c').first();
    queueCount = parseInt(q?.c || 0);
  } catch { /* table may not exist */ }

  const statusMap = {};
  byStatus.forEach(s => { statusMap[s.status] = parseInt(s.count); });

  return {
    total_backlinks: parseInt(total?.c || 0),
    by_status: statusMap,
    recent_reports: reports.map(r => ({
      id: r.id, type: r.report_type, status: r.status, summary: r.summary, date: r.created_at,
    })),
    agent_queue_pending: queueCount,
  };
}


async function compareDomains(input) {
  const { metric = 'clicks', period_days = 28, site_type } = input;

  const sites = await db('wordpress_sites').orderBy('domain');
  const filteredSites = site_type && site_type !== 'all'
    ? sites.filter(s => s.site_type === site_type)
    : sites;

  if (metric === 'pagespeed') {
    return {
      metric: 'pagespeed',
      sites: filteredSites.map(s => ({
        domain: s.domain, name: s.name, area: s.area, type: s.site_type,
        mobile: s.pagespeed_mobile, desktop: s.pagespeed_desktop,
        checked: s.pagespeed_checked_at,
      })).sort((a, b) => (b.mobile || 0) - (a.mobile || 0)),
    };
  }

  if (metric === 'blog_count') {
    return {
      metric: 'blog_count',
      sites: filteredSites.map(s => ({
        domain: s.domain, name: s.name, area: s.area, type: s.site_type,
        blog_posts: s.blog_post_count || 0, total_pages: s.total_pages || 0,
        content_status: s.content_status,
      })).sort((a, b) => (b.blog_posts || 0) - (a.blog_posts || 0)),
    };
  }

  if (metric === 'content_status') {
    return {
      metric: 'content_status',
      sites: filteredSites.map(s => ({
        domain: s.domain, name: s.name, type: s.site_type,
        content_status: s.content_status, schema: s.schema_deployed, ga4: s.ga4_active,
        gsc: s.search_console_verified, llms_txt: s.llms_txt_deployed,
      })),
    };
  }

  // GSC metrics (clicks or impressions)
  const since = etDateString(addETDays(new Date(), -period_days));
  const gscData = await db('gsc_performance_daily')
    .where('date', '>=', since)
    .select('domain')
    .sum('clicks as clicks').sum('impressions as impressions')
    .avg('avg_position as avg_position')
    .groupBy('domain').orderByRaw(`SUM(${metric === 'impressions' ? 'impressions' : 'clicks'}) DESC`);

  // Merge with site info
  const siteMap = {};
  filteredSites.forEach(s => { siteMap[s.domain] = s; });

  return {
    metric,
    period_days,
    sites: gscData
      .filter(g => !site_type || site_type === 'all' || siteMap[g.domain]?.site_type === site_type)
      .map(g => ({
        domain: g.domain,
        name: siteMap[g.domain]?.name || g.domain,
        area: siteMap[g.domain]?.area,
        type: siteMap[g.domain]?.site_type,
        clicks: parseInt(g.clicks || 0),
        impressions: parseInt(g.impressions || 0),
        avg_position: parseFloat(parseFloat(g.avg_position || 0).toFixed(1)),
      })),
  };
}


async function getContentDecayAlerts(input) {
  const { domain } = input;

  let decayQuery = db('seo_content_decay_alerts').where('status', 'active');
  if (domain) decayQuery = decayQuery.whereILike('page_url', `%${domain}%`);
  const decayAlerts = await decayQuery.orderBy('created_at', 'desc').limit(20);

  let cannibQuery = db('seo_cannibalization_flags').where('status', 'active');
  if (domain) cannibQuery = cannibQuery.whereILike('page_a_url', `%${domain}%`);
  const cannibFlags = await cannibQuery.orderBy('created_at', 'desc').limit(20);

  return {
    decay_alerts: decayAlerts.map(a => ({
      page_url: a.page_url, alert_type: a.alert_type, severity: a.severity,
      clicks_before: a.clicks_before, clicks_after: a.clicks_after,
      position_before: a.position_before, position_after: a.position_after,
      detected: a.created_at,
    })),
    cannibalization_flags: cannibFlags.map(f => ({
      keyword: f.keyword, page_a: f.page_a_url, page_b: f.page_b_url,
      severity: f.severity, detected: f.created_at,
    })),
    total_decay: decayAlerts.length,
    total_cannibalization: cannibFlags.length,
  };
}


// ─── SEMANTIC CONCEPT CLUSTERS ─────────────────────────────────

const CONCEPT_CLUSTERS = {
  pest_control: {
    core_concept: 'Residential pest management in subtropical coastal environments',
    old_keyword_target: 'pest control [city] FL',
    related_concepts: [
      'Integrated pest management (IPM) principles',
      'Pest pressure seasonality in SWFL (June–October rainy season surge)',
      'Exterior perimeter defense vs interior treatment methodology',
      'Product safety around children and pets — re-entry intervals',
      'Bait rotation to prevent resistance (MOA rotation)',
      'Moisture-driven pest biology (palmetto bug population explosions after rain)',
      'Role of landscaping in pest harborage — mulch depth, ground cover, irrigation',
      'HOA common-area pest dynamics and commercial contracts',
      'Warranty and re-service expectations for recurring programs',
      'Florida building code post-Hurricane Andrew — pest entry points in modern construction',
    ],
    product_entities: ['Phantom (chlorfenapyr)', 'Alpine WSG', 'Demand CS', 'Advion', 'Syngenta', 'BASF', 'Bayer Environmental Science'],
    institutional_entities: ['Florida Department of Agriculture (FDACS)', 'EPA registration numbers', 'NPMA', 'UF/IFAS Extension'],
    species_entities: ['German cockroaches', 'American cockroaches (palmetto bugs)', 'fire ants', 'ghost ants', 'whitefoot ants', 'paper wasps', 'yellow jackets', 'bed bugs', 'fleas', 'ticks'],
    geographic_signals: ['SWFL soil types (Myakka fine sand)', 'Subtropical coastal climate Zone 9b–10a', 'Hurricane-code construction', 'Mangrove and tidal proximity'],
    hub_page: '/pest-control',
    sub_pages: ['/pests/palmetto-bugs', '/pests/german-cockroaches', '/pests/fire-ants', '/pests/ghost-ants'],
  },
  lawn_care: {
    core_concept: 'Warm-season turfgrass management in USDA Zone 9b–10a',
    old_keyword_target: 'lawn care [city] FL',
    related_concepts: [
      'St. Augustine cultivar selection (Floratam vs CitraBlue vs Palmetto vs Sapphire)',
      'Chinch bug lifecycle and threshold-based treatment',
      'Large patch (Rhizoctonia solani) — cultural vs chemical management',
      'Proper mowing height by species (3.5–4" for St. Augustine)',
      'Soil pH and micronutrient availability in Florida alkaline sandy soils',
      'Irrigation scheduling using evapotranspiration (ET) rates',
      'Pre-emergent timing windows — soil temp at 4" depth using FAWN stations',
      'Take-all root rot diagnostics and cultural management',
      'Granular vs liquid application trade-offs in FL climate',
      'Sod webworm and mole cricket pressure cycles',
    ],
    product_entities: ['Celsius WG', 'Tribute Total', 'Pillar G', 'Quali-Pro', 'LESCO', 'FMC', 'Snapshot pre-emergent'],
    institutional_entities: ['FAWN weather stations (311 Myakka River, 260 Arcadia)', 'UF/IFAS Extension', 'USDA Zone 9b–10a'],
    species_entities: ['St. Augustine (Floratam, CitraBlue, Palmetto, Sapphire)', 'Bermuda', 'Zoysia', 'Bahia', 'Chinch bugs', 'Sod webworms', 'Mole crickets'],
    disease_entities: ['Large patch (Rhizoctonia)', 'Take-all root rot', 'Gray leaf spot', 'Brown patch', 'Dollar spot'],
    geographic_signals: ['Alkaline sandy soils', 'High water table', 'Subtropical humidity', 'Rainy season June–October'],
    hub_page: '/lawn-care',
    sub_pages: ['/lawn-care/st-augustine', '/lawn-care/chinch-bugs', '/lawn-care/fertilization-program'],
  },
  mosquito: {
    core_concept: 'Residential mosquito population suppression in coastal Florida',
    old_keyword_target: 'mosquito control near me',
    related_concepts: [
      'Aedes vs Culex vs Anopheles behavior differences',
      'Breeding site elimination (standing water audit methodology)',
      'Adulticide mist application vs larvicide programs',
      'In2Care station technology — dual-action larvicide + adulticide',
      'Barrier spray residual timelines (21-day cycle)',
      'Impact of tidal marshes and mangrove proximity on mosquito pressure',
      'HOA/community-wide program economics',
      'Event-based one-time treatments (weddings, parties)',
      'CDC guidance on mosquito-borne illness in FL (Zika, Dengue, EEE, West Nile)',
    ],
    product_entities: ['In2Care', 'Onslaught FastCap', 'Mavrik Perimeter'],
    institutional_entities: ['Lee County Mosquito Control District', 'Sarasota County Mosquito Management', 'CDC', 'FL DOH'],
    species_entities: ['Aedes aegypti', 'Aedes albopictus (Asian tiger)', 'Culex quinquefasciatus'],
    geographic_signals: ['Tidal marsh proximity', 'Mangrove ecosystems', 'Standing water in FL flat terrain', 'Rainy season breeding surge'],
    hub_page: '/mosquito-control',
    sub_pages: ['/mosquito-control/barrier-spray', '/mosquito-control/in2care-stations'],
  },
  termite: {
    core_concept: 'Subterranean and drywood termite detection, treatment, and prevention in Florida construction',
    old_keyword_target: 'termite treatment [city] FL',
    related_concepts: [
      'WDO inspection process and Form 13645',
      'Mud tube identification and subterranean termite behavior',
      'Formosan vs Eastern subterranean behavioral differences',
      'Drywood termite frass patterns and identification',
      'Liquid barrier vs bait station systems — decision framework',
      'Pre-construction soil treatment methodology',
      'Bora-Care borate wood treatment for new construction',
      'Termidor SC transfer effect via trophallaxis',
      'Tent fumigation vs spot treatment decision framework',
      'Real estate transaction WDO requirements (FL statute 482)',
      'Annual renewal inspection protocols',
    ],
    product_entities: ['Termidor SC', 'Termidor Foam', 'Sentricon', 'Bora-Care', 'BASF', 'Corteva'],
    institutional_entities: ['FDACS', 'Florida statute 482', 'NPMA'],
    species_entities: ['Eastern subterranean termites', 'Formosan termites', 'Drywood termites'],
    geographic_signals: ['FL construction types (slab-on-grade vs crawlspace)', 'Post-Andrew building codes', 'High moisture + warm climate = year-round pressure', 'Sandy soil termiticide binding behavior'],
    hub_page: '/termite-treatment',
    sub_pages: ['/termite-treatment/wdo-inspection', '/termite-treatment/subterranean', '/termite-treatment/drywood'],
  },
  tree_shrub: {
    core_concept: 'Ornamental plant health management in subtropical landscapes',
    old_keyword_target: 'tree spraying service [city]',
    related_concepts: [
      'Scale insect and whitefly pressure cycles',
      'Sooty mold as a secondary indicator of sucking pest infestation',
      'Palm nutrient deficiency (manganese, potassium, boron)',
      'Trunk injection vs foliar application — when to use each',
      'FRAC rotation for fungicide resistance management',
      'Snapshot pre-emergent for ornamental bed weed control',
      'Proper pruning timing to avoid stress-induced pest invasion',
      'Spiraling whitefly on Ficus and Gumbo Limbo',
      'Rugose spiraling whitefly vs conventional whitefly',
      'Fertilization timing relative to rainy season',
    ],
    product_entities: ['Arborjet TREE-äge', 'Safari 20SG', 'Transtect', 'Snapshot'],
    institutional_entities: ['UF/IFAS Extension', 'FRAC codes'],
    species_entities: ['Scale insects', 'Spiraling whitefly', 'Rugose spiraling whitefly', 'Ficus whitefly'],
    geographic_signals: ['Subtropical landscape species', 'Salt-tolerant ornamentals near coast', 'Hurricane damage recovery'],
    hub_page: '/tree-and-shrub-care',
    sub_pages: ['/tree-and-shrub-care/palm-health', '/tree-and-shrub-care/whitefly-treatment'],
  },
  rodent: {
    core_concept: 'Rodent exclusion and population management in Florida residential structures',
    old_keyword_target: 'rodent control [city] FL',
    related_concepts: [
      'Roof rat vs Norway rat behavior in FL',
      'Exclusion-first approach — seal entry points before baiting',
      'Attic inspection methodology in FL construction',
      'Bait station placement and monitoring protocols',
      'Snap trap vs bait station decision framework',
      'Rodent-borne disease risks in subtropical climate',
      'A/C line entry points and soffit gaps as common access',
      'Signs of rodent activity: droppings, rub marks, gnaw marks, sounds',
    ],
    product_entities: ['Contrac', 'Final Blox', 'Trapper T-Rex snap traps'],
    institutional_entities: ['CDC', 'FL DOH', 'NPMA'],
    species_entities: ['Roof rats (Rattus rattus)', 'Norway rats (Rattus norvegicus)', 'House mice'],
    geographic_signals: ['Florida attic construction (truss roof, no basement)', 'Citrus/fruit tree proximity attracting rodents', 'Warm climate = year-round activity'],
    hub_page: '/rodent-control',
    sub_pages: ['/rodent-control/roof-rats', '/rodent-control/exclusion'],
  },
};

async function getSemanticConceptMap(input) {
  const { service_line } = input;
  const cluster = CONCEPT_CLUSTERS[service_line];
  if (!cluster) {
    return { error: `Unknown service line: ${service_line}. Available: ${Object.keys(CONCEPT_CLUSTERS).join(', ')}` };
  }

  // Also pull any existing pages and their GSC performance for this service line
  let gscData = [];
  try {
    const categoryMap = {
      pest_control: 'pest', lawn_care: 'lawn', mosquito: 'mosquito',
      termite: 'termite', tree_shrub: 'tree_shrub', rodent: 'rodent',
    };
    const since = etDateString(addETDays(new Date(), -28));
    gscData = await db('gsc_top_queries')
      .where('service_category', categoryMap[service_line] || service_line)
      .where('date', '>=', since)
      .select('query', 'clicks', 'impressions', 'position')
      .orderBy('clicks', 'desc')
      .limit(20);
  } catch (e) { /* table may not exist */ }

  // Pull any blog posts in this category
  let blogPosts = [];
  try {
    blogPosts = await db('blog_posts')
      .whereILike('tag', `%${service_line.replace('_', ' ')}%`)
      .select('id', 'title', 'slug', 'status', 'word_count', 'seo_score')
      .orderBy('created_at', 'desc')
      .limit(10);
  } catch (e) { /* ok */ }

  return {
    service_line,
    ...cluster,
    current_gsc_queries: gscData,
    existing_blog_content: blogPosts,
    recommendation: `Use this concept map to audit existing ${service_line.replace('_', ' ')} pages. Check each related concept, product entity, and institutional entity against your current page content. Any gap = content to add. Prioritize entities that appear in competitor top-5 SERP results but are missing from your pages.`,
  };
}


async function scorePageRefreshPriority(input) {
  const { service_category, city, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 15, 50);

  // Pull pages with ranking data
  const since = etDateString(addETDays(new Date(), -28));
  const prevSince = etDateString(addETDays(new Date(), -56));

  let currentQuery = db('gsc_top_pages')
    .where('date', '>=', since)
    .whereILike('domain', '%wavespestcontrol.com%');
  let prevQuery = db('gsc_top_pages')
    .whereBetween('date', [prevSince, since])
    .whereILike('domain', '%wavespestcontrol.com%');

  if (service_category) {
    currentQuery = currentQuery.where('service_category', service_category);
    prevQuery = prevQuery.where('service_category', service_category);
  }
  if (city) {
    currentQuery = currentQuery.whereILike('page', `%${city.toLowerCase()}%`);
    prevQuery = prevQuery.whereILike('page', `%${city.toLowerCase()}%`);
  }

  let currentPages, prevPages;
  try {
    currentPages = await currentQuery.select('page')
      .sum('clicks as clicks').sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page').orderByRaw('SUM(clicks) DESC').limit(limit * 2);
    prevPages = await prevQuery.select('page')
      .sum('clicks as clicks').sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page');
  } catch (e) {
    return { error: 'GSC page data not available. Run a GSC sync first.' };
  }

  const prevMap = {};
  prevPages.forEach(p => { prevMap[p.page] = p; });

  // Pull content decay alerts
  let decayAlerts = [];
  try {
    decayAlerts = await db('seo_content_decay_alerts')
      .where('status', 'active')
      .whereILike('page_url', '%wavespestcontrol.com%')
      .select('page_url', 'severity');
  } catch (e) { /* ok */ }
  const decayMap = {};
  decayAlerts.forEach(a => { decayMap[a.page_url] = a.severity; });

  // Score each page
  const scored = currentPages.map(p => {
    const prev = prevMap[p.page] || {};
    const clickDelta = parseInt(p.clicks || 0) - parseInt(prev.clicks || 0);
    const posDelta = parseFloat(prev.avg_position || 0) - parseFloat(p.avg_position || 0); // positive = improved
    const hasDecay = decayMap[p.page] || null;

    // Scoring: higher = more urgent refresh needed
    let score = 0;
    // Pages losing clicks get high priority
    if (clickDelta < 0) score += Math.min(Math.abs(clickDelta) * 2, 30);
    // Pages losing position
    if (posDelta < 0) score += Math.min(Math.abs(posDelta) * 5, 25);
    // Pages with decay alerts
    if (hasDecay === 'high') score += 20;
    else if (hasDecay === 'medium') score += 10;
    // Pages with high impressions but low clicks (CTR opportunity)
    const ctr = parseInt(p.impressions) > 0 ? parseInt(p.clicks) / parseInt(p.impressions) : 0;
    if (parseInt(p.impressions) > 100 && ctr < 0.03) score += 15;
    // Pages ranking 4-15 (striking distance, high refresh ROI)
    const pos = parseFloat(p.avg_position || 0);
    if (pos >= 4 && pos <= 15) score += 15;
    else if (pos >= 16 && pos <= 30) score += 8;

    return {
      page: p.page,
      clicks_current: parseInt(p.clicks || 0),
      clicks_delta: clickDelta,
      avg_position: parseFloat(parseFloat(p.avg_position || 0).toFixed(1)),
      position_delta: parseFloat(posDelta.toFixed(1)),
      impressions: parseInt(p.impressions || 0),
      ctr: parseFloat((ctr * 100).toFixed(2)),
      decay_alert: hasDecay,
      refresh_score: score,
      refresh_reason: [
        clickDelta < 0 ? `losing ${Math.abs(clickDelta)} clicks` : null,
        posDelta < 0 ? `dropped ${Math.abs(posDelta).toFixed(1)} positions` : null,
        hasDecay ? `decay alert: ${hasDecay}` : null,
        ctr < 0.03 && parseInt(p.impressions) > 100 ? `low CTR (${(ctr * 100).toFixed(1)}%) with high impressions` : null,
        pos >= 4 && pos <= 15 ? `striking distance (pos ${pos.toFixed(1)})` : null,
      ].filter(Boolean),
    };
  });

  scored.sort((a, b) => b.refresh_score - a.refresh_score);

  return {
    pages: scored.slice(0, limit),
    total_scored: scored.length,
    high_priority: scored.filter(s => s.refresh_score >= 25).length,
    medium_priority: scored.filter(s => s.refresh_score >= 10 && s.refresh_score < 25).length,
    methodology: 'Score based on: click loss (max 30), position loss (max 25), decay alerts (max 20), low CTR with high impressions (15), striking distance ranking 4-15 (15). Higher = more urgent refresh.',
  };
}


async function getContentWorkflowBrief(input) {
  const { target_keyword, page_url, brief_type = 'page_refresh' } = input;

  // Determine which service line this keyword belongs to
  const kw = target_keyword.toLowerCase();
  let service_line = 'pest_control';
  if (kw.includes('lawn') || kw.includes('turf') || kw.includes('grass') || kw.includes('mow') || kw.includes('fertiliz')) service_line = 'lawn_care';
  else if (kw.includes('mosquito')) service_line = 'mosquito';
  else if (kw.includes('termite') || kw.includes('wdo')) service_line = 'termite';
  else if (kw.includes('tree') || kw.includes('shrub') || kw.includes('palm') || kw.includes('ornamental')) service_line = 'tree_shrub';
  else if (kw.includes('rodent') || kw.includes('rat') || kw.includes('mouse') || kw.includes('mice')) service_line = 'rodent';

  const cluster = CONCEPT_CLUSTERS[service_line];

  // Pull ranking data for this keyword if we have it
  let rankingData = null;
  try {
    rankingData = await db('seo_rankings')
      .whereILike('keyword', `%${target_keyword}%`)
      .orderBy('checked_at', 'desc')
      .first();
  } catch (e) { /* ok */ }

  // Pull GSC data for this keyword
  let gscData = null;
  try {
    const since = etDateString(addETDays(new Date(), -28));
    gscData = await db('gsc_top_queries')
      .whereILike('query', `%${target_keyword}%`)
      .where('date', '>=', since)
      .select('query')
      .sum('clicks as clicks').sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query')
      .orderByRaw('SUM(clicks) DESC')
      .limit(5);
  } catch (e) { /* ok */ }

  // Pull existing blog posts that might relate
  let relatedContent = [];
  try {
    const kwWords = target_keyword.split(/\s+/).filter(w => w.length > 3);
    if (kwWords.length > 0) {
      let q = db('blog_posts');
      kwWords.forEach(w => { q = q.orWhereILike('title', `%${w}%`); });
      relatedContent = await q.select('id', 'title', 'slug', 'status', 'word_count').limit(5);
    }
  } catch (e) { /* ok */ }

  return {
    target_keyword,
    brief_type,
    detected_service_line: service_line,
    concept_cluster: {
      core_concept: cluster.core_concept,
      hub_page: cluster.hub_page,
    },
    current_data: {
      ranking: rankingData ? {
        position: rankingData.organic_position,
        map_pack: rankingData.map_pack_position,
        ai_overview: rankingData.ai_overview_cited,
        last_checked: rankingData.checked_at,
      } : null,
      gsc_queries: gscData || [],
      related_content: relatedContent,
    },
    workflow_steps: {
      step_1_serp_analysis: {
        action: `Search Google for "${target_keyword}" in the target SWFL city. Analyze top 10 results: page types, content formats, entity coverage, SERP features (local pack, PAA, featured snippet, AI overview).`,
        goal: 'Understand what Google currently rewards for this query.',
      },
      step_2_entity_map: {
        action: `Compare the target page against top-5 SERP competitors. Extract all entities (products, species, institutions, geographies) they cover.`,
        required_entities: [...(cluster.product_entities || []), ...(cluster.institutional_entities || [])],
        species_entities: cluster.species_entities || [],
        geographic_signals: cluster.geographic_signals || [],
        goal: 'Find every entity gap — if competitors mention it and we don\'t, add it.',
      },
      step_3_content_blueprint: {
        action: 'Build H2 structure based on cross-page consensus. Map required sections, entity placements, FAQ questions from People Also Ask.',
        related_concepts_to_cover: cluster.related_concepts || [],
        goal: 'Data-backed content structure, not a guess.',
      },
      step_4_write_or_refresh: {
        action: brief_type === 'page_refresh'
          ? 'Update the existing page: add missing entities, expand thin sections, update FAQ schema, add freshness signals (seasonal data, recent FAWN readings).'
          : 'Write new content following the blueprint. Lead with SWFL-specific depth. Use real product names, species, and institutional references.',
        word_count_target: brief_type === 'blog_post' ? '1,500–2,500 words' : '2,000–4,000 words for service/city pages',
        goal: 'Content that comprehensively covers the semantic concept, not just the keyword.',
      },
      step_5_schema_and_links: {
        action: 'Ensure FAQ schema matches content. Add internal links to/from concept hub page. Verify LocalBusiness and Service schema.',
        hub_page: cluster.hub_page,
        goal: 'Technical SEO alignment with content improvements.',
      },
    },
    differentiation_angles: [
      'Reference specific products by name with application methodology (not just "we use professional-grade products")',
      'Include FAWN weather station data for treatment timing',
      'Mention Florida-specific conditions: soil types, construction codes, subtropical pest pressure',
      'Reference UF/IFAS Extension research for credibility',
      'Add geographic specificity: neighborhoods, waterways, microclimates — not just city names',
    ],
  };
}


module.exports = { SEO_TOOLS, executeSeoTool };
