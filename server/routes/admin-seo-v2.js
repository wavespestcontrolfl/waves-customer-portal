const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SearchConsole = require('../services/seo/search-console');
const SEOAdvisor = require('../services/seo/seo-advisor');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// =========================================================================
// GSC DASHBOARD — sitewide metrics
// =========================================================================

// GET /api/admin/seo/dashboard?period=28&domain=bradentonflpestcontrol.com
router.get('/dashboard', async (req, res, next) => {
  try {
    const periodDays = parseInt(req.query.period || 28);
    const domain = req.query.domain || null;
    const summary = await SearchConsole.getPerformanceSummary(periodDays, domain);
    res.json(summary);
  } catch (err) { next(err); }
});

// =========================================================================
// QUERIES
// =========================================================================

// GET /api/admin/seo/queries?period=28&branded=false&service=pest&city=bradenton
router.get('/queries', async (req, res, next) => {
  try {
    const { period = 28, branded, service, city, device, sort = 'clicks', limit = 100 } = req.query;
    const since = new Date(Date.now() - parseInt(period) * 86400000).toISOString().split('T')[0];

    let query = db('gsc_queries')
      .where('date', '>=', since)
      .select('query', 'is_branded', 'service_category', 'city_target', 'intent_type')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'is_branded', 'service_category', 'city_target', 'intent_type');

    if (branded === 'true') query = query.where('is_branded', true);
    if (branded === 'false') query = query.where('is_branded', false);
    if (service) query = query.where('service_category', service);
    if (city) query = query.where('city_target', city);

    const rows = await query.orderBy(sort === 'position' ? 'avg_position' : sort, sort === 'position' ? 'asc' : 'desc').limit(parseInt(limit));

    res.json({
      queries: rows.map(r => ({
        ...r,
        clicks: parseInt(r.clicks),
        impressions: parseInt(r.impressions),
        avg_position: parseFloat(parseFloat(r.avg_position).toFixed(1)),
        ctr: parseInt(r.impressions) > 0 ? Math.round((parseInt(r.clicks) / parseInt(r.impressions)) * 10000) / 100 : 0,
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// PAGES
// =========================================================================

// GET /api/admin/seo/pages?period=28&type=city
router.get('/pages', async (req, res, next) => {
  try {
    const { period = 28, type, service, city, sort = 'clicks', limit = 50 } = req.query;
    const since = new Date(Date.now() - parseInt(period) * 86400000).toISOString().split('T')[0];

    let query = db('gsc_pages')
      .where('date', '>=', since)
      .select('page_url', 'page_type', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page_url', 'page_type', 'service_category', 'city_target');

    if (type) query = query.where('page_type', type);
    if (service) query = query.where('service_category', service);
    if (city) query = query.where('city_target', city);

    const rows = await query.orderBy(sort === 'position' ? 'avg_position' : sort, sort === 'position' ? 'asc' : 'desc').limit(parseInt(limit));

    res.json({
      pages: rows.map(r => ({
        ...r,
        clicks: parseInt(r.clicks),
        impressions: parseInt(r.impressions),
        avg_position: parseFloat(parseFloat(r.avg_position).toFixed(1)),
        ctr: parseInt(r.impressions) > 0 ? Math.round((parseInt(r.clicks) / parseInt(r.impressions)) * 10000) / 100 : 0,
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// CORE WEB VITALS
// =========================================================================

// GET /api/admin/seo/cwv
router.get('/cwv', async (req, res, next) => {
  try {
    const cwv = await db('gsc_core_web_vitals')
      .orderBy('date', 'desc')
      .limit(20);

    // Summarize by device
    const byDevice = {};
    for (const c of cwv) {
      const d = c.device || 'unknown';
      if (!byDevice[d]) byDevice[d] = [];
      byDevice[d].push(c);
    }

    res.json({ cwv, byDevice });
  } catch (err) { next(err); }
});

// =========================================================================
// INDEXING ISSUES
// =========================================================================

// GET /api/admin/seo/indexing
router.get('/indexing', async (req, res, next) => {
  try {
    const issues = await db('gsc_indexing_issues')
      .orderBy('last_seen', 'desc');

    const active = issues.filter(i => i.status === 'active');
    const resolved = issues.filter(i => i.status === 'resolved');

    res.json({ active, resolved, totalActive: active.length });
  } catch (err) { next(err); }
});

// =========================================================================
// GBP PERFORMANCE
// =========================================================================

// GET /api/admin/seo/gbp?period=28
router.get('/gbp', async (req, res, next) => {
  try {
    const period = parseInt(req.query.period || 28);
    const since = new Date(Date.now() - period * 86400000).toISOString().split('T')[0];

    const rows = await db('gbp_performance_daily').where('date', '>=', since);

    // By location
    const byLocation = {};
    for (const r of rows) {
      const loc = r.location_name || r.location_id;
      if (!byLocation[loc]) byLocation[loc] = { calls: 0, websiteClicks: 0, directionRequests: 0, bookings: 0, searchViews: 0, mapsViews: 0, photoViews: 0, days: 0 };
      byLocation[loc].calls += r.calls || 0;
      byLocation[loc].websiteClicks += r.website_clicks || 0;
      byLocation[loc].directionRequests += r.direction_requests || 0;
      byLocation[loc].bookings += r.bookings || 0;
      byLocation[loc].searchViews += r.search_views || 0;
      byLocation[loc].mapsViews += r.maps_views || 0;
      byLocation[loc].photoViews += r.photo_views || 0;
      byLocation[loc].days++;
    }

    // Daily trend
    const daily = {};
    for (const r of rows) {
      const d = typeof r.date === 'string' ? r.date.split('T')[0] : new Date(r.date).toISOString().split('T')[0];
      if (!daily[d]) daily[d] = { date: d, calls: 0, websiteClicks: 0, directionRequests: 0 };
      daily[d].calls += r.calls || 0;
      daily[d].websiteClicks += r.website_clicks || 0;
      daily[d].directionRequests += r.direction_requests || 0;
    }

    res.json({
      byLocation,
      daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)),
      totalDays: period,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// SEO ADVISOR
// =========================================================================

// GET /api/admin/seo/advisor — latest report
router.get('/advisor', async (req, res, next) => {
  try {
    const report = await db('seo_advisor_reports').orderBy('date', 'desc').first();
    if (!report) return res.json({ report: null });
    res.json({
      report: {
        ...report,
        report_data: typeof report.report_data === 'string' ? JSON.parse(report.report_data) : report.report_data,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/seo/advisor/history
router.get('/advisor/history', async (req, res, next) => {
  try {
    const reports = await db('seo_advisor_reports')
      .orderBy('date', 'desc')
      .limit(12)
      .select('id', 'date', 'grade', 'recommendation_count', 'opportunity_count', 'alert_count', 'created_at');
    res.json({ reports });
  } catch (err) { next(err); }
});

// POST /api/admin/seo/advisor/generate — manually trigger
router.post('/advisor/generate', async (req, res, next) => {
  try {
    const report = await SEOAdvisor.generateWeeklyReport();
    res.json({ report });
  } catch (err) { next(err); }
});

// =========================================================================
// SYNC
// =========================================================================

// POST /api/admin/seo/sync — manually trigger GSC data sync
router.post('/sync', async (req, res, next) => {
  try {
    const domain = req.body.domain || null;
    const result = await SearchConsole.syncDailyData(req.body.daysBack || 7, domain);
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// PAGE 2 OPPORTUNITIES — queries in positions 4–15
// =========================================================================

// GET /api/admin/seo/opportunities?period=28
router.get('/opportunities', async (req, res, next) => {
  try {
    const period = parseInt(req.query.period || 28);
    const since = new Date(Date.now() - period * 86400000).toISOString().split('T')[0];

    const rows = await db('gsc_queries')
      .where('date', '>=', since)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target')
      .havingRaw('avg(position) >= 4 AND avg(position) <= 15')
      .orderBy('impressions', 'desc')
      .limit(30);

    res.json({
      opportunities: rows.map(r => ({
        query: r.query,
        clicks: parseInt(r.clicks),
        impressions: parseInt(r.impressions),
        position: parseFloat(parseFloat(r.avg_position).toFixed(1)),
        service: r.service_category,
        city: r.city_target,
        potentialClicks: Math.round(parseInt(r.impressions) * 0.08), // ~8% CTR if on page 1
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// SEO COMMAND CENTER — Rank Tracking, SERP, Backlinks, QA, Decay, Citations
// All gated behind GATE_SEO_INTELLIGENCE
// =========================================================================

const RankTracker = require('../services/seo/rank-tracker');
const SERPAnalyzer = require('../services/seo/serp-analyzer');
const BacklinkMonitor = require('../services/seo/backlink-monitor');
const AIOverviewTracker = require('../services/seo/ai-overview-tracker');
const ContentQA = require('../services/seo/content-qa');
const CannibalizationDetector = require('../services/seo/cannibalization');
const ContentDecayDetector = require('../services/seo/content-decay');
const CitationAuditor = require('../services/seo/citation-auditor');
const ConversionFunnel = require('../services/seo/conversion-funnel');

// Rankings
router.get('/rankings', async (req, res, next) => {
  try {
    const data = await RankTracker.getDashboard(parseInt(req.query.days || 7));
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/rankings/track', async (req, res, next) => {
  try {
    const result = await RankTracker.trackRanks(req.body.priority || null);
    res.json(result);
  } catch (err) { next(err); }
});

// SERP Analysis
router.get('/serp/:keywordId', async (req, res, next) => {
  try {
    const analysis = await db('seo_serp_analyses').where('keyword_id', req.params.keywordId).orderBy('analysis_date', 'desc').first();
    res.json({ analysis });
  } catch (err) { next(err); }
});

router.post('/serp/analyze', async (req, res, next) => {
  try {
    const result = await SERPAnalyzer.analyzeKeyword(req.body.keywordId);
    res.json(result);
  } catch (err) { next(err); }
});

// Backlinks
router.get('/backlinks', async (req, res, next) => {
  try {
    const data = await BacklinkMonitor.getFullDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/backlinks/scan', async (req, res, next) => {
  try {
    const result = await BacklinkMonitor.scan();
    await BacklinkMonitor.takeSnapshot();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/backlinks/disavow', async (req, res, next) => {
  try {
    const result = await BacklinkMonitor.generateDisavow();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/backlinks/competitor-gaps', async (req, res, next) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Competitor domain required' });
    const result = await BacklinkMonitor.scanCompetitorGaps(domain);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/backlinks/llm-mentions', async (req, res, next) => {
  try {
    await BacklinkMonitor.checkLLMMentions();
    const mentions = await db('seo_llm_mentions').orderBy('check_date', 'desc').limit(20);
    res.json({ mentions });
  } catch (err) { next(err); }
});

// AI Overview
router.get('/ai-overview', async (req, res, next) => {
  try {
    const data = await AIOverviewTracker.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

// Content QA
router.get('/qa', async (req, res, next) => {
  try {
    const data = await ContentQA.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/qa/:blogPostId/score', async (req, res, next) => {
  try {
    const result = await ContentQA.scoreContent(req.params.blogPostId);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/qa/batch', async (req, res, next) => {
  try {
    const results = await ContentQA.batchScore(parseInt(req.body.limit || 50));
    res.json({ results });
  } catch (err) { next(err); }
});

// Cannibalization
router.get('/cannibalization', async (req, res, next) => {
  try {
    const data = await CannibalizationDetector.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

// Content Decay
router.get('/decay', async (req, res, next) => {
  try {
    const data = await ContentDecayDetector.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

// Citations
router.get('/citations', async (req, res, next) => {
  try {
    const data = await CitationAuditor.getDashboard();
    res.json(data);
  } catch (err) { next(err); }
});

router.put('/citations/:id', async (req, res, next) => {
  try {
    await CitationAuditor.updateCitation(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Conversion Funnel
router.get('/funnel', async (req, res, next) => {
  try {
    const data = await ConversionFunnel.getDashboard(parseInt(req.query.days || 30));
    res.json(data);
  } catch (err) { next(err); }
});

// Competitors
router.get('/competitors', async (req, res, next) => {
  try {
    const competitors = await db('seo_competitors').where('active', true);
    res.json({ competitors });
  } catch (err) { next(err); }
});

// Keywords list
router.get('/keywords', async (req, res, next) => {
  try {
    const { priority, city, service } = req.query;
    let query = db('seo_target_keywords');
    if (priority) query = query.where('priority', parseInt(priority));
    if (city) query = query.where('primary_city', city);
    if (service) query = query.where('service_category', service);
    const keywords = await query.orderBy('priority').orderBy('keyword');
    res.json({ keywords, total: keywords.length });
  } catch (err) { next(err); }
});

// =========================================================================
// SITE AUDIT
// =========================================================================
const SiteAuditor = require('../services/seo/site-auditor');

router.get('/audit', async (req, res, next) => {
  try { res.json(await SiteAuditor.getDashboard()); } catch (err) { next(err); }
});

router.get('/audit/history', async (req, res, next) => {
  try {
    const runs = await db('seo_site_audit_runs').where('status', 'completed').orderBy('run_date', 'desc').limit(20);
    res.json({ runs });
  } catch (err) { next(err); }
});

router.get('/audit/pages', async (req, res, next) => {
  try {
    const latest = await db('seo_site_audit_runs').where('status', 'completed').orderBy('run_date', 'desc').first();
    if (!latest) return res.json({ pages: [] });
    const date = latest.run_date.toISOString?.().split('T')[0] || new Date().toISOString().split('T')[0];
    const pages = await db('seo_page_audits').where('audit_date', date).orderBy('technical_health_score', 'asc');
    res.json({ pages, auditDate: date });
  } catch (err) { next(err); }
});

router.get('/audit/page-detail', async (req, res, next) => {
  try {
    const data = await SiteAuditor.getPageDetail(req.query.url);
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/audit/run', async (req, res, next) => {
  try {
    const result = await SiteAuditor.runSiteAudit();
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT QA DETAIL — deep analysis for a single blog post
// =========================================================================

// GET /api/admin/seo/qa/:blogPostId
router.get('/qa/:blogPostId', async (req, res, next) => {
  try {
    const post = await db('blog_posts').where('id', req.params.blogPostId).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const content = post.content || '';
    const html = post.content_html || content;
    const wordCount = post.word_count || content.split(/\s+/).filter(Boolean).length;
    const issues = [];

    // Word count checks
    if (wordCount < 300) {
      issues.push({ type: 'word_count', severity: 'critical', message: `Content is only ${wordCount} words (minimum 300)`, fix: 'Expand the article to at least 800 words with additional sections, examples, and local context' });
    } else if (wordCount < 500) {
      issues.push({ type: 'word_count', severity: 'warning', message: `Content is ${wordCount} words — thin content risk`, fix: 'Add 300+ more words: consider FAQ section, local tips, or seasonal notes' });
    }

    // Meta description
    const metaLen = (post.meta_description || '').length;
    if (!post.meta_description) {
      issues.push({ type: 'meta_description', severity: 'critical', message: 'No meta description set', fix: 'Write a 130-160 character meta description with the target keyword and a CTA' });
    } else if (metaLen < 130) {
      issues.push({ type: 'meta_description', severity: 'warning', message: `Meta description too short (${metaLen} chars, ideal 130-160)`, fix: 'Expand meta description to 130-160 characters' });
    } else if (metaLen > 160) {
      issues.push({ type: 'meta_description', severity: 'warning', message: `Meta description too long (${metaLen} chars, ideal 130-160)`, fix: 'Trim meta description to 160 characters to avoid truncation in SERPs' });
    }

    // Keyword
    if (!post.keyword) {
      issues.push({ type: 'keyword', severity: 'critical', message: 'No target keyword set', fix: 'Set a primary keyword for this post' });
    }

    // Heading structure
    const h2Count = (html.match(/<h2[\s>]/gi) || []).length;
    const h3Count = (html.match(/<h3[\s>]/gi) || []).length;
    if (h2Count === 0) {
      issues.push({ type: 'headings', severity: 'warning', message: 'No H2 headings found', fix: 'Add at least 2-3 H2 subheadings to structure the content' });
    }

    // Internal links
    const internalLinks = (html.match(/href=["']https?:\/\/(www\.)?wavespestcontrol\.com[^"']*/gi) || []);
    if (internalLinks.length === 0) {
      issues.push({ type: 'internal_links', severity: 'warning', message: 'No internal links to wavespestcontrol.com', fix: 'Add 2-3 internal links to relevant service or city pages' });
    }

    // External links
    const allLinks = (html.match(/href=["']https?:\/\/[^"']*/gi) || []);
    const externalLinks = allLinks.filter(l => !/wavespestcontrol\.com/i.test(l));

    // FAQ section
    const hasFAQ = /faq|frequently asked|common question/i.test(content);
    if (!hasFAQ) {
      issues.push({ type: 'faq', severity: 'warning', message: 'No FAQ section detected', fix: 'Add a FAQ section with 3-5 questions — helps win People Also Ask boxes' });
    }

    // Image alt text
    const images = html.match(/<img[^>]*>/gi) || [];
    const imagesWithoutAlt = images.filter(img => !(/alt=["'][^"']+["']/i.test(img)));
    if (imagesWithoutAlt.length > 0) {
      issues.push({ type: 'image_alt', severity: 'warning', message: `${imagesWithoutAlt.length} image(s) missing alt text`, fix: 'Add descriptive alt text to all images including the target keyword where natural' });
    }

    // Calculate score
    const maxIssues = 7; // total check categories
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    const deduction = (criticalCount * 20) + (warningCount * 8);
    const score = Math.max(0, Math.min(100, 100 - deduction));

    res.json({
      score,
      issues,
      post: {
        id: post.id,
        title: post.title,
        slug: post.slug,
        keyword: post.keyword,
        city: post.city,
        status: post.status,
        wordCount,
        metaDescriptionLength: metaLen,
        h2Count,
        h3Count,
        internalLinkCount: internalLinks.length,
        externalLinkCount: externalLinks.length,
        hasFAQ,
        imageCount: images.length,
        imagesWithoutAlt: imagesWithoutAlt.length,
      },
    });
  } catch (err) { next(err); }
});

// =========================================================================
// CORE WEB VITALS DETAIL — PageSpeed Insights for homepage + top pages
// =========================================================================

// GET /api/admin/seo/cwv/detail
router.get('/cwv/detail', async (req, res, next) => {
  try {
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });
    }

    const homepage = 'https://www.wavespestcontrol.com';
    const topPages = [];

    // Get top 5 blog posts by SEO score or most recent published
    try {
      const blogs = await db('blog_posts')
        .where('status', 'published')
        .whereNotNull('slug')
        .orderByRaw('seo_score DESC NULLS LAST')
        .limit(5);
      for (const b of blogs) {
        topPages.push(`${homepage}/${b.slug}/`);
      }
    } catch (e) {
      logger.warn('Could not fetch blog pages for CWV detail:', e.message);
    }

    const urls = [homepage, ...topPages];
    const pages = [];

    for (const url of urls) {
      try {
        const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${GOOGLE_API_KEY}&category=PERFORMANCE`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error) {
          pages.push({ url, error: data.error.message });
          continue;
        }

        const metrics = data.lighthouseResult?.audits || {};
        const categories = data.lighthouseResult?.categories || {};

        const lcp = metrics['largest-contentful-paint']?.numericValue || null;
        const fid = metrics['max-potential-fid']?.numericValue || null;
        const cls = metrics['cumulative-layout-shift']?.numericValue || null;
        const perfScore = categories.performance?.score != null ? Math.round(categories.performance.score * 100) : null;

        // Extract top opportunities
        const opportunities = [];
        const audits = data.lighthouseResult?.audits || {};
        for (const [key, audit] of Object.entries(audits)) {
          if (audit.details?.type === 'opportunity' && audit.details?.overallSavingsMs > 100) {
            opportunities.push({
              id: key,
              title: audit.title,
              savingsMs: Math.round(audit.details.overallSavingsMs),
              score: audit.score,
            });
          }
        }
        opportunities.sort((a, b) => b.savingsMs - a.savingsMs);

        pages.push({
          url,
          lcp: lcp != null ? Math.round(lcp) : null,
          fid: fid != null ? Math.round(fid) : null,
          cls: cls != null ? parseFloat(cls.toFixed(3)) : null,
          score: perfScore,
          opportunities: opportunities.slice(0, 5),
        });
      } catch (fetchErr) {
        pages.push({ url, error: fetchErr.message });
      }
    }

    res.json({ pages });
  } catch (err) { next(err); }
});

// =========================================================================
// OPPORTUNITIES — low-hanging fruit keywords + underperforming content
// =========================================================================

// Note: the basic /opportunities route already exists above (positions 4-15 from GSC).
// This enhanced version at /opportunities/detail also checks blog_posts with low seo_score.

router.get('/opportunities/detail', async (req, res, next) => {
  try {
    const opportunities = [];

    // 1) Try seo_rank_history for keywords in positions 4-20
    try {
      const rankData = await db('seo_rank_history as rh')
        .join('seo_target_keywords as kw', 'rh.keyword_id', 'kw.id')
        .whereBetween('rh.organic_position', [4, 20])
        .whereNotNull('rh.organic_position')
        .select(
          'kw.keyword', 'kw.target_url', 'kw.monthly_volume', 'kw.primary_city', 'kw.service_category',
          'rh.organic_position as position'
        )
        .orderBy('rh.organic_position', 'asc')
        .limit(30);

      for (const r of rankData) {
        let suggestedAction = 'Optimize content and build internal links';
        if (r.position <= 6) suggestedAction = 'Add FAQ schema + internal links — very close to top 3';
        else if (r.position <= 10) suggestedAction = 'Improve content depth and add supporting pages';
        else suggestedAction = 'Build topic cluster + get backlinks to push onto page 1';

        opportunities.push({
          keyword: r.keyword,
          position: r.position,
          url: r.target_url,
          searchVolume: r.monthly_volume,
          city: r.primary_city,
          service: r.service_category,
          difficulty: null,
          suggestedAction,
          source: 'rank_tracking',
        });
      }
    } catch (e) {
      logger.warn('Rank history query failed (table may not exist):', e.message);
    }

    // 2) Blog posts with keyword set but low seo_score
    try {
      const lowScorePosts = await db('blog_posts')
        .whereNotNull('keyword')
        .where(function () {
          this.where('seo_score', '<', 60).orWhereNull('seo_score');
        })
        .whereIn('status', ['published', 'draft'])
        .orderByRaw('seo_score ASC NULLS FIRST')
        .limit(20);

      for (const p of lowScorePosts) {
        opportunities.push({
          keyword: p.keyword,
          position: null,
          url: p.slug ? `https://wavespestcontrol.com/${p.slug}/` : null,
          searchVolume: null,
          difficulty: null,
          seoScore: p.seo_score,
          suggestedAction: !p.seo_score
            ? 'Run Content QA scoring — no SEO score yet'
            : p.seo_score < 30
              ? 'Major rewrite needed — thin content or missing key elements'
              : 'Improve: add FAQ, internal links, and local context',
          source: 'content_qa',
        });
      }
    } catch (e) {
      logger.warn('Blog posts opportunity query failed:', e.message);
    }

    res.json({ opportunities });
  } catch (err) { next(err); }
});

// =========================================================================
// KEYWORD MANAGEMENT — full CRUD for seo_target_keywords
// =========================================================================

// GET /api/admin/seo/keywords/manage — list all with status
router.get('/keywords/manage', async (req, res, next) => {
  try {
    const { status, priority, city, service } = req.query;
    let query = db('seo_target_keywords');
    if (status) query = query.where('status', status);
    if (priority) query = query.where('priority', parseInt(priority));
    if (city) query = query.where('primary_city', city);
    if (service) query = query.where('service_category', service);
    const keywords = await query.orderBy('priority').orderBy('keyword');

    // Enrich with latest rank data
    const enriched = [];
    for (const kw of keywords) {
      let latestRank = null;
      try {
        latestRank = await db('seo_rank_history')
          .where('keyword_id', kw.id)
          .orderBy('check_date', 'desc')
          .first();
      } catch (_) { /* rank table may not have data */ }

      enriched.push({
        ...kw,
        latestPosition: latestRank?.organic_position || kw.current_position || null,
        mapPackPosition: latestRank?.map_pack_position || null,
        lastChecked: latestRank?.check_date || null,
      });
    }

    res.json({ keywords: enriched, total: enriched.length });
  } catch (err) { next(err); }
});

// POST /api/admin/seo/keywords/manage — add new keyword
router.post('/keywords/manage', async (req, res, next) => {
  try {
    const { keyword, city, service, priority = 2, search_volume, difficulty, notes } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const [created] = await db('seo_target_keywords').insert({
      keyword: keyword.trim(),
      primary_city: city || null,
      service_category: service || null,
      priority: Math.max(1, Math.min(3, parseInt(priority))),
      monthly_volume: search_volume || null,
      search_volume: search_volume || null,
      difficulty: difficulty != null ? Math.max(0, Math.min(100, parseInt(difficulty))) : null,
      status: 'new',
      has_content: false,
      notes: notes || null,
    }).returning('*');

    res.json({ keyword: created });
  } catch (err) { next(err); }
});

// PUT /api/admin/seo/keywords/manage/:id — update keyword
router.put('/keywords/manage/:id', async (req, res, next) => {
  try {
    const { keyword, city, service, priority, search_volume, difficulty, status, notes, content_url, has_content, current_position, best_position, target_url } = req.body;

    const updates = {};
    if (keyword !== undefined) updates.keyword = keyword.trim();
    if (city !== undefined) updates.primary_city = city;
    if (service !== undefined) updates.service_category = service;
    if (priority !== undefined) updates.priority = Math.max(1, Math.min(3, parseInt(priority)));
    if (search_volume !== undefined) { updates.monthly_volume = search_volume; updates.search_volume = search_volume; }
    if (difficulty !== undefined) updates.difficulty = Math.max(0, Math.min(100, parseInt(difficulty)));
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (content_url !== undefined) updates.content_url = content_url;
    if (has_content !== undefined) updates.has_content = has_content;
    if (current_position !== undefined) updates.current_position = current_position;
    if (best_position !== undefined) updates.best_position = best_position;
    if (target_url !== undefined) updates.target_url = target_url;
    updates.updated_at = db.fn.now();

    const [updated] = await db('seo_target_keywords').where('id', req.params.id).update(updates).returning('*');
    if (!updated) return res.status(404).json({ error: 'Keyword not found' });

    res.json({ keyword: updated });
  } catch (err) { next(err); }
});

// DELETE /api/admin/seo/keywords/manage/:id — delete keyword
router.delete('/keywords/manage/:id', async (req, res, next) => {
  try {
    const deleted = await db('seo_target_keywords').where('id', req.params.id).del();
    if (!deleted) return res.status(404).json({ error: 'Keyword not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
