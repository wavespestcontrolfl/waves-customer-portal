/**
 * SEO Site-Wide Technical Audit Engine
 *
 * Crawls every page on wavespestcontrol.com, extracts full HTML/meta/schema/
 * technical signals, detects regressions, and surfaces site-wide issues.
 */
const db = require('../../models/db');
const logger = require('../logger');
const crypto = require('crypto');
const { etDateString } = require('../../utils/datetime-et');

const SITE_URL = process.env.WAVES_SITE_URL || 'https://wavespestcontrol.com';
const CITIES = ['Bradenton', 'Sarasota', 'Lakewood Ranch', 'Venice', 'Parrish', 'North Port', 'Port Charlotte'];
const CTA_PATTERNS = /free estimate|call|schedule|get a quote|contact|book|text us/i;
const FL_PESTS = /palmetto bug|fire ant|chinch bug|ghost ant|german roach|subterranean termite|whitefly|mole cricket|no-see-um|love bug/i;
const FL_CONTEXT = /southwest florida|swfl|gulf coast|rainy season|hurricane season|fdacs|florida department/i;
const NAP_PHONE = /(941).*318.*7612|9413187612/;
const NAP_NAME = /waves pest control/i;

class SiteAuditor {

  /**
   * Full site audit — crawl all known pages, audit each, aggregate.
   */
  async runSiteAudit() {
    logger.info('Site audit starting...');
    const startTime = Date.now();

    const [auditRun] = await db('seo_site_audit_runs').insert({
      run_date: new Date(), status: 'running',
    }).returning('*');

    try {
      // Get pages — from blog_posts + known service pages
      const blogPages = await db('blog_posts').whereIn('status', ['published']).select('id', 'title', 'slug', 'content', 'content_html', 'keyword', 'city');
      const servicePages = [
        '/pest-control-bradenton-fl/', '/pest-control-sarasota-fl/', '/lawn-care/', '/mosquito-control/',
        '/termite-control/', '/rodent-control/', '/tree-and-shrub/', '/',
      ];

      const allPages = [
        ...servicePages.map(p => ({ url: `${SITE_URL}${p}`, type: 'service_page', keyword: null, city: null })),
        ...blogPages.map(p => ({ url: `${SITE_URL}/${p.slug}/`, type: 'blog', keyword: p.keyword, city: p.city, content: p.content, html: p.content_html, blogPostId: p.id })),
      ];

      const auditResults = [];

      for (const page of allPages) {
        try {
          let html = page.html || page.content || '';
          let statusCode = 200;
          let responseTime = 0;

          // Fetch live page for service pages (blog content already available)
          if (page.type === 'service_page' || !html) {
            try {
              const start = Date.now();
              const res = await fetch(page.url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
              responseTime = Date.now() - start;
              statusCode = res.status;
              html = await res.text();
            } catch (fetchErr) {
              statusCode = 0;
              html = '';
              logger.warn(`Fetch failed for ${page.url}: ${fetchErr.message}`);
            }
          }

          const audit = await this.auditPage(page.url, html, statusCode, responseTime, page.keyword, page.city, page.type);

          await db('seo_page_audits').insert({
            ...audit, audit_date: etDateString(),
          }).onConflict(['url', 'audit_date']).merge();

          auditResults.push(audit);
        } catch (err) {
          logger.error(`Audit failed for ${page.url}: ${err.message}`);
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 300));
      }

      // Cross-page checks
      const duplicateTitles = this.findDuplicates(auditResults, 'meta_title');
      const duplicateContent = this.findDuplicates(auditResults, 'content_hash');

      // Aggregate
      const healthy = auditResults.filter(r => r.technical_health_score >= 80).length;
      const warning = auditResults.filter(r => r.technical_health_score >= 50 && r.technical_health_score < 80).length;
      const critical = auditResults.filter(r => r.technical_health_score < 50).length;
      const avgScore = auditResults.length > 0 ? Math.round(auditResults.reduce((s, r) => s + r.technical_health_score, 0) / auditResults.length) : 0;

      // Get previous run for delta
      const prevRun = await db('seo_site_audit_runs').where('id', '!=', auditRun.id).where('status', 'completed').orderBy('run_date', 'desc').first();
      const scoreDelta = prevRun?.avg_health_score ? avgScore - parseFloat(prevRun.avg_health_score) : 0;

      await db('seo_site_audit_runs').where('id', auditRun.id).update({
        pages_crawled: auditResults.length,
        pages_healthy: healthy,
        pages_warning: warning,
        pages_critical: critical,
        total_critical_issues: auditResults.reduce((s, r) => s + r.issue_count_critical, 0),
        total_warning_issues: auditResults.reduce((s, r) => s + r.issue_count_warning, 0),
        avg_health_score: avgScore,
        pages_with_broken_links: auditResults.filter(r => r.broken_links_count > 0).length,
        pages_missing_schema: auditResults.filter(r => !r.has_local_business_schema && r.url.includes('pest-control')).length,
        pages_thin_content: auditResults.filter(r => r.thin_content_flag).length,
        pages_missing_meta_description: auditResults.filter(r => !r.meta_description).length,
        pages_with_duplicate_titles: duplicateTitles.reduce((s, g) => s + g.urls.length, 0),
        pages_failing_cwv: auditResults.filter(r => r.cwv_pass === false).length,
        duplicate_title_groups: JSON.stringify(duplicateTitles),
        duplicate_content_groups: JSON.stringify(duplicateContent),
        score_delta: scoreDelta,
        status: 'completed',
        duration_seconds: Math.round((Date.now() - startTime) / 1000),
      });

      // Store issue trends
      const issuesByCategory = {};
      for (const r of auditResults) {
        for (const issue of (r.issues || [])) {
          const key = `${issue.category}:${issue.type}`;
          if (!issuesByCategory[key]) issuesByCategory[key] = { category: issue.category, type: issue.type, severity: issue.severity, urls: [], recommendation: issue.recommendation };
          issuesByCategory[key].urls.push(r.url);
        }
      }

      for (const [, trend] of Object.entries(issuesByCategory)) {
        await db('seo_audit_issue_trends').insert({
          audit_run_id: auditRun.id,
          issue_category: trend.category,
          issue_type: trend.type,
          severity: trend.severity,
          affected_urls: JSON.stringify(trend.urls),
          affected_count: trend.urls.length,
          recommendation: trend.recommendation,
          first_detected: etDateString(),
        });
      }

      logger.info(`Site audit complete: ${auditResults.length} pages, avg score ${avgScore}, ${critical} critical`);
      return { pages: auditResults.length, avgScore, healthy, warning, critical, duration: Math.round((Date.now() - startTime) / 1000) };

    } catch (err) {
      await db('seo_site_audit_runs').where('id', auditRun.id).update({ status: 'failed' });
      logger.error(`Site audit failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Audit a single page — returns full audit object.
   */
  async auditPage(url, html, statusCode, responseTime, keyword, city, pageType) {
    const lower = (html || '').toLowerCase();
    const issues = [];

    // Meta
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const metaTitle = titleMatch?.[1]?.trim() || '';
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    const metaDesc = descMatch?.[1]?.trim() || '';
    const ogImage = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] || null;

    if (!metaTitle) issues.push({ category: 'meta', type: 'missing_title', severity: 'critical', recommendation: 'Add a title tag' });
    else if (metaTitle.length > 60) issues.push({ category: 'meta', type: 'title_too_long', severity: 'warning', recommendation: `Title is ${metaTitle.length} chars, keep under 60` });
    if (!metaDesc) issues.push({ category: 'meta', type: 'missing_description', severity: 'warning', recommendation: 'Add a meta description' });

    // Headings
    const h1s = html.match(/<h1[^>]*>([^<]+)<\/h1>/gi) || [];
    const h1Text = h1s[0]?.replace(/<[^>]+>/g, '').trim() || '';
    const h2s = html.match(/<h2[^>]*>([^<]+)<\/h2>/gi) || [];

    if (h1s.length === 0) issues.push({ category: 'meta', type: 'missing_h1', severity: 'critical', recommendation: 'Add an H1 heading' });
    else if (h1s.length > 1) issues.push({ category: 'meta', type: 'multiple_h1', severity: 'warning', recommendation: `${h1s.length} H1 tags found, use only 1` });

    // Content
    const bodyText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
    const contentHash = crypto.createHash('md5').update(bodyText.substring(0, 5000)).digest('hex');
    const thinContent = wordCount < 300;
    if (thinContent && pageType === 'service_page') issues.push({ category: 'content', type: 'thin_content', severity: 'critical', recommendation: `Only ${wordCount} words — service pages need 800+` });

    // Images
    const imgs = html.match(/<img[^>]+>/gi) || [];
    const missingAlt = imgs.filter(i => !i.includes('alt=')).length;
    if (missingAlt > 3) issues.push({ category: 'images', type: 'missing_alt', severity: 'warning', recommendation: `${missingAlt} images missing alt text` });

    // Schema
    const schemaBlocks = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    const schemaTypes = [];
    let schemaValid = true;
    for (const block of schemaBlocks) {
      try {
        const json = JSON.parse(block.replace(/<[^>]+>/g, ''));
        const types = Array.isArray(json['@type']) ? json['@type'] : [json['@type']];
        schemaTypes.push(...types.filter(Boolean));
      } catch { schemaValid = false; }
    }

    const hasLB = schemaTypes.some(t => /LocalBusiness|PestControl/i.test(t));
    const hasFAQ = schemaTypes.some(t => /FAQPage/i.test(t));
    const hasSvc = schemaTypes.some(t => /Service/i.test(t));
    const schemaMissing = [];
    if (!hasLB && pageType === 'service_page') { schemaMissing.push('LocalBusiness'); issues.push({ category: 'schema', type: 'missing_localbusiness', severity: 'critical', recommendation: 'Add LocalBusiness schema' }); }
    if (!hasFAQ && pageType === 'service_page') { schemaMissing.push('FAQPage'); issues.push({ category: 'schema', type: 'missing_faqpage', severity: 'warning', recommendation: 'Add FAQPage schema' }); }

    // Local
    const napPresent = NAP_NAME.test(html) && NAP_PHONE.test(html);
    const napConsistent = napPresent;
    const cityMentions = {};
    for (const c of CITIES) {
      const count = (bodyText.match(new RegExp(c, 'gi')) || []).length;
      if (count > 0) cityMentions[c] = count;
    }
    const flSpecific = FL_PESTS.test(bodyText) || FL_CONTEXT.test(bodyText);

    // Canonical
    const canonicalMatch = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
    const canonicalUrl = canonicalMatch?.[1] || null;
    const canonicalSelf = canonicalUrl ? canonicalUrl.replace(/\/$/, '') === url.replace(/\/$/, '') : false;

    // Score
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    const infoCount = issues.filter(i => i.severity === 'info').length;
    const score = Math.max(0, Math.min(100, 100 - (criticalCount * 15) - (warningCount * 5) - (infoCount * 1)));

    // Fetch PageSpeed scores (async, outside object literal)
    const psScores = await this.getPageSpeedScores(url);

    return {
      url,
      status_code: statusCode,
      response_time_ms: responseTime,
      robots_meta: html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i)?.[1] || null,
      canonical_url: canonicalUrl,
      canonical_self_referencing: canonicalSelf,
      canonical_mismatch: canonicalUrl && !canonicalSelf,
      meta_title: metaTitle,
      meta_title_length: metaTitle.length,
      meta_title_has_keyword: keyword ? metaTitle.toLowerCase().includes(keyword.toLowerCase()) : null,
      meta_title_has_city: city ? metaTitle.toLowerCase().includes(city.toLowerCase()) : CITIES.some(c => metaTitle.toLowerCase().includes(c.toLowerCase())),
      meta_description: metaDesc || null,
      meta_description_length: metaDesc.length,
      meta_description_has_keyword: keyword ? metaDesc.toLowerCase().includes(keyword.toLowerCase()) : null,
      meta_description_has_cta: CTA_PATTERNS.test(metaDesc),
      og_image: ogImage,
      h1_text: h1Text,
      h1_count: h1s.length,
      h1_has_keyword: keyword ? h1Text.toLowerCase().includes(keyword.toLowerCase()) : null,
      h2_texts: JSON.stringify(h2s.map(h => h.replace(/<[^>]+>/g, '').trim())),
      h2_count: h2s.length,
      heading_hierarchy_valid: h1s.length === 1 && h2s.length >= 1,
      word_count: wordCount,
      keyword_in_first_100_words: keyword ? bodyText.substring(0, 600).toLowerCase().includes(keyword.toLowerCase()) : null,
      content_hash: contentHash,
      thin_content_flag: thinContent,
      total_images: imgs.length,
      images_missing_alt: missingAlt,
      images_over_200kb: 0, // Would need image size checking
      internal_links_count: (html.match(/href=["']https?:\/\/wavespestcontrol\.com/gi) || []).length,
      external_links_count: (html.match(/href=["']https?:\/\/(?!wavespestcontrol)/gi) || []).length,
      broken_links: JSON.stringify([]),
      broken_links_count: 0,
      schema_types_found: JSON.stringify(schemaTypes),
      schema_valid: schemaValid,
      schema_missing: JSON.stringify(schemaMissing),
      has_local_business_schema: hasLB,
      has_faq_schema: hasFAQ,
      has_service_schema: hasSvc,
      pagespeed_mobile_score: psScores.pagespeed_mobile_score,
      lcp_ms: psScores.lcp_ms,
      inp_ms: psScores.inp_ms,
      cls_numeric: psScores.cls_numeric,
      cwv_pass: psScores.cwv_pass,
      nap_present: napPresent,
      nap_consistent: napConsistent,
      city_mentions: JSON.stringify(cityMentions),
      florida_specific_content: flSpecific,
      technical_health_score: score,
      issues: JSON.stringify(issues),
      issue_count_critical: criticalCount,
      issue_count_warning: warningCount,
      issue_count_info: infoCount,
    };
  }

  async getPageSpeedScores(url) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const defaults = { pagespeed_mobile_score: null, lcp_ms: null, inp_ms: null, cls_numeric: null, cwv_pass: null };
    if (!apiKey) return defaults;
    try {
      const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${apiKey}`);
      if (!res.ok) return defaults;
      const data = await res.json();
      const lhr = data.lighthouseResult;
      if (!lhr) return defaults;
      const score = Math.round((lhr.categories?.performance?.score || 0) * 100);
      const lcp = lhr.audits?.['largest-contentful-paint']?.numericValue || null;
      const cls = lhr.audits?.['cumulative-layout-shift']?.numericValue || null;
      const inp = lhr.audits?.['interaction-to-next-paint']?.numericValue || lhr.audits?.['total-blocking-time']?.numericValue || null;
      return {
        pagespeed_mobile_score: score,
        lcp_ms: lcp ? Math.round(lcp) : null,
        inp_ms: inp ? Math.round(inp) : null,
        cls_numeric: cls ? parseFloat(cls.toFixed(3)) : null,
        cwv_pass: (lcp && lcp <= 2500 && cls != null && cls <= 0.1) ? true : false,
      };
    } catch (err) {
      logger.warn(`[site-audit] PageSpeed failed for ${url}: ${err.message}`);
      return defaults;
    }
  }

  findDuplicates(results, field) {
    const groups = {};
    for (const r of results) {
      const val = r[field];
      if (!val) continue;
      if (!groups[val]) groups[val] = [];
      groups[val].push(r.url);
    }
    return Object.entries(groups).filter(([, urls]) => urls.length > 1).map(([value, urls]) => ({ value: value.substring(0, 100), urls }));
  }

  async getDashboard() {
    const latestRun = await db('seo_site_audit_runs').where('status', 'completed').orderBy('run_date', 'desc').first();
    if (!latestRun) return { hasData: false };

    const pages = await db('seo_page_audits')
      .where('audit_date', latestRun.run_date.toISOString?.().split('T')[0] || etDateString())
      .orderBy('technical_health_score', 'asc');

    const issues = await db('seo_audit_issue_trends')
      .where('audit_run_id', latestRun.id)
      .orderByRaw("CASE WHEN severity = 'critical' THEN 0 WHEN severity = 'warning' THEN 1 ELSE 2 END")
      .orderBy('affected_count', 'desc');

    const history = await db('seo_site_audit_runs').where('status', 'completed').orderBy('run_date', 'desc').limit(12);

    return {
      hasData: true,
      latestRun,
      pages,
      issues,
      history: history.map(h => ({ date: h.run_date, score: parseFloat(h.avg_health_score), pages: h.pages_crawled, critical: h.total_critical_issues })),
    };
  }

  async getPageDetail(url) {
    const audits = await db('seo_page_audits').where('url', url).orderBy('audit_date', 'desc').limit(10);
    return { audits, latest: audits[0] };
  }
}

module.exports = new SiteAuditor();
