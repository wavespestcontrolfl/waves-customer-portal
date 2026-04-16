/**
 * Intelligence Bar — SEO & Content Tools
 * server/services/intelligence-bar/seo-tools.js
 *
 * Gives Claude access to GSC data, rank tracking,
 * blog content pipeline, and site health metrics for wavespestcontrol.com.
 */

const db = require('../../models/db');
const logger = require('../logger');

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
  const since = new Date(Date.now() - period_days * 86400000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

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
    const prevEnd = new Date(Date.now() - period_days * 86400000);
    const prevStart = new Date(prevEnd.getTime() - period_days * 86400000).toISOString().split('T')[0];
    previous = await fetchPeriod(prevStart, prevEnd.toISOString().split('T')[0], group_by);
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
  const since = new Date(Date.now() - period_days * 86400000).toISOString().split('T')[0];

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
  const since = new Date(Date.now() - period_days * 86400000).toISOString().split('T')[0];

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
  const compareDate = new Date(Date.now() - days_back * 86400000).toISOString().split('T')[0];

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
  const today = new Date().toISOString().split('T')[0];
  const futureDate = new Date(Date.now() + weeks_ahead * 7 * 86400000).toISOString().split('T')[0];

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
  const since = new Date(Date.now() - period_days * 86400000).toISOString().split('T')[0];
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


module.exports = { SEO_TOOLS, executeSeoTool };
