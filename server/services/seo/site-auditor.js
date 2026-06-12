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
const { extractDomain, NETWORK_DOMAINS } = require('../../utils/normalize-url');

const SITE_URL = process.env.WAVES_SITE_URL || 'https://www.wavespestcontrol.com';
const CITIES = ['Bradenton', 'Sarasota', 'Lakewood Ranch', 'Venice', 'Parrish', 'North Port', 'Port Charlotte'];
const CTA_PATTERNS = /free estimate|call|schedule|get a quote|contact|book|text us/i;
const FL_PESTS = /palmetto bug|fire ant|chinch bug|ghost ant|german roach|subterranean termite|whitefly|mole cricket|no-see-um|love bug/i;
const FL_CONTEXT = /southwest florida|swfl|gulf coast|rainy season|hurricane season|fdacs|florida department/i;
const NAP_PHONE = /(941).*318.*7612|9413187612/;
const NAP_NAME = /waves pest control/i;
const EXTRA_AUDIT_DOMAINS = String(process.env.SEO_AUDIT_ALLOWED_DOMAINS || '')
  .split(',')
  .map((d) => extractDomain(d))
  .filter(Boolean);
const AUDIT_ALLOWED_DOMAINS = new Set([...NETWORK_DOMAINS, extractDomain(SITE_URL), ...EXTRA_AUDIT_DOMAINS].filter(Boolean));
const DEFAULT_PAGESPEED_TIMEOUT_MS = 15000;

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function siteUrlForAudit(target) {
  const defaultDomain = extractDomain(SITE_URL) || 'wavespestcontrol.com';
  const domain = extractDomain(target) || defaultDomain;
  if (!AUDIT_ALLOWED_DOMAINS.has(domain)) {
    const err = new Error(`Unsupported SEO audit domain: ${domain}`);
    err.status = 400;
    throw err;
  }
  const base = domain === defaultDomain ? SITE_URL : `https://${domain}`;
  return {
    domain,
    siteUrl: base.endsWith('/') ? base : `${base}/`,
    isDefaultDomain: domain === defaultDomain,
  };
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pageSpeedTimeoutMs(value = process.env.SEO_PAGESPEED_TIMEOUT_MS) {
  return positiveInt(value, DEFAULT_PAGESPEED_TIMEOUT_MS);
}

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function extractHeadingTexts(html, level) {
  const tag = `h${level}`;
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...String(html || '').matchAll(re)]
    .map((match) => match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function collectSchemaTypes(schema, out = new Set()) {
  if (Array.isArray(schema)) {
    schema.forEach((item) => collectSchemaTypes(item, out));
    return out;
  }
  if (!schema || typeof schema !== 'object') return out;

  const type = schema['@type'];
  if (Array.isArray(type)) type.forEach((item) => item && out.add(String(item)));
  else if (type) out.add(String(type));

  if (Array.isArray(schema['@graph'])) {
    schema['@graph'].forEach((item) => collectSchemaTypes(item, out));
  }
  return out;
}

class SiteAuditor {
  async discoverUrlsFromSitemaps(siteUrl) {
    const roots = [
      new URL('/sitemap.xml', siteUrl).toString(),
      new URL('/sitemap_index.xml', siteUrl).toString(),
    ];
    const visited = new Set();
    const pages = new Set();
    const maxSitemaps = 25;

    const crawlSitemap = async (url) => {
      if (visited.has(url) || visited.size >= maxSitemaps) return;
      visited.add(url);
      try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const xml = await res.text();
        const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)]
          .map(m => this.decodeXml(m[1].trim()))
          .filter(Boolean);

        for (const loc of locs) {
          if (!this.isHttpUrl(loc) || !this.isSameOrigin(loc, siteUrl)) continue;
          if (/\.xml(\?.*)?$/i.test(loc)) await crawlSitemap(loc);
          else pages.add(loc);
        }
      } catch (err) {
        logger.warn(`[site-audit] Sitemap fetch failed for ${url}: ${err.message}`);
      }
    };

    for (const root of roots) await crawlSitemap(root);
    return Array.from(pages);
  }

  decodeXml(value) {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  isSameOrigin(url, siteUrl) {
    try {
      return new URL(url).hostname.replace(/^www\./, '') === new URL(siteUrl).hostname.replace(/^www\./, '');
    } catch {
      return false;
    }
  }

  isHttpUrl(url) {
    try {
      const protocol = new URL(url).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }

  classifyUrlType(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (path === '/' || path.includes('pest-control') || path.includes('lawn-care') || path.includes('mosquito') || path.includes('termite') || path.includes('rodent') || path.includes('tree-and-shrub')) {
        return 'service_page';
      }
      if (path.includes('blog') || path.split('/').filter(Boolean).length >= 1) return 'blog';
    } catch { /* ignore */ }
    return 'landing';
  }

  getAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
    return match?.[1] || null;
  }

  getMetaContent(html, attrName, attrValue) {
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const attr = this.getAttribute(tag, attrName);
      if (attr && attr.toLowerCase() === attrValue.toLowerCase()) {
        return this.getAttribute(tag, 'content');
      }
    }
    return null;
  }

  getCanonicalUrl(html) {
    const tags = html.match(/<link\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const rel = this.getAttribute(tag, 'rel');
      if (rel && rel.toLowerCase().split(/\s+/).includes('canonical')) {
        return this.getAttribute(tag, 'href');
      }
    }
    return null;
  }

  parseIssues(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  isSoft404(html, metaTitle, statusCode) {
    if (!html || statusCode < 200 || statusCode >= 400) return false;
    const title = String(metaTitle || '').trim();
    if (/(^|[\s|\u2014-])(404|page not found)([\s|\u2014-]|$)/i.test(title)) return true;

    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const h1Text = h1Match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    if (/^(404|page not found|not found)$/i.test(h1Text)) return true;

    const visibleText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();

    return visibleText.includes('page not found') &&
      visibleText.includes('waves pest control') &&
      /(requested page|does not exist|could not find|couldn't find|go back|return home)/i.test(visibleText);
  }

  /**
   * Full site audit — crawl all known pages, audit each, aggregate.
   */
  async runSiteAudit(options = {}) {
    const target = typeof options === 'string' ? options : (options.siteUrl || options.domain);
    const { domain, siteUrl, isDefaultDomain } = siteUrlForAudit(target);

    logger.info(`Site audit starting for ${domain}...`);
    const startTime = Date.now();

    const [auditRun] = await db('seo_site_audit_runs').insert({
      run_date: new Date(), status: 'running', domain,
    }).returning('*');

    try {
      // Get pages from sitemap first, with DB/known-page fallbacks for local or
      // newly staged content not yet present in sitemap.xml.
      const blogQuery = db('blog_posts')
        .whereIn('status', ['published'])
        .where((builder) => {
          builder.where('target_domain', domain);
          if (isDefaultDomain) builder.orWhereNull('target_domain');
        })
        .select('id', 'title', 'slug', 'content', 'content_html', 'keyword', 'city');
      const blogPages = await blogQuery;
      const servicePages = isDefaultDomain ? [
        '/pest-control-bradenton-fl/', '/pest-control-sarasota-fl/', '/lawn-care/', '/mosquito-control/',
        '/termite-control/', '/rodent-control/', '/tree-and-shrub/', '/',
      ] : ['/'];

      const pageMap = new Map();
      const addPage = (page) => {
        if (!page.url || pageMap.has(page.url)) return;
        pageMap.set(page.url, page);
      };

      const sitemapUrls = await this.discoverUrlsFromSitemaps(siteUrl);
      sitemapUrls.forEach((url) => addPage({ url, type: this.classifyUrlType(url), keyword: null, city: null }));
      servicePages.forEach(p => addPage({ url: new URL(p, siteUrl).toString(), type: 'service_page', keyword: null, city: null }));
      blogPages.forEach(p => {
        if (!p.slug) return;
        addPage({ url: new URL(`/${p.slug.replace(/^\/+|\/+$/g, '')}/`, siteUrl).toString(), type: 'blog', keyword: p.keyword, city: p.city, blogPostId: p.id });
      });

      const maxPages = parseInt(process.env.SEO_SITE_AUDIT_MAX_PAGES || '250', 10);
      const allPages = Array.from(pageMap.values()).slice(0, maxPages);

      const auditResults = [];
      let pagesAttempted = 0;
      const progressEvery = Math.max(1, parseInt(options.progressEvery || process.env.SEO_SITE_AUDIT_PROGRESS_EVERY || '5', 10));
      const reportProgress = async (force = false) => {
        if (!force && pagesAttempted % progressEvery !== 0) return;
        const progress = {
          audit_run_id: auditRun.id,
          domain,
          pages_attempted: pagesAttempted,
          pages_crawled: auditResults.length,
          total_pages: allPages.length,
        };
        await db('seo_site_audit_runs')
          .where({ id: auditRun.id, status: 'running' })
          .update({
            pages_crawled: auditResults.length,
            updated_at: new Date(),
          });
        if (typeof options.onProgress === 'function') {
          try {
            await options.onProgress(progress);
          } catch (err) {
            logger.warn(`[site-audit] progress callback failed for ${domain}: ${err.message}`);
          }
        }
      };
      await reportProgress(true);

      for (const page of allPages) {
        try {
          let html = '';
          let statusCode = 200;
          let responseTime = 0;

          try {
            const start = Date.now();
            const res = await fetch(page.url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
            responseTime = Date.now() - start;
            statusCode = res.status;
            html = await res.text();
          } catch (fetchErr) {
            statusCode = 0;
            logger.warn(`Fetch failed for ${page.url}: ${fetchErr.message}`);
          }

          const audit = await this.auditPage(page.url, html, statusCode, responseTime, page.keyword, page.city, page.type, siteUrl);

          await db('seo_page_audits').insert({
            ...audit, domain, audit_date: etDateString(),
          }).onConflict(['url', 'audit_date']).merge();

          auditResults.push(audit);
        } catch (err) {
          logger.error(`Audit failed for ${page.url}: ${err.message}`);
        }

        pagesAttempted++;
        await reportProgress(pagesAttempted === allPages.length);

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
      const prevRun = await db('seo_site_audit_runs')
        .where('id', '!=', auditRun.id)
        .where('status', 'completed')
        .where('domain', domain)
        .orderBy('run_date', 'desc')
        .first();
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
        updated_at: new Date(),
      });

      // Store issue trends
      const issuesByCategory = {};
      for (const r of auditResults) {
        for (const issue of this.parseIssues(r.issues)) {
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

      logger.info(`Site audit complete for ${domain}: ${auditResults.length} pages, avg score ${avgScore}, ${critical} critical`);
      return { pages: auditResults.length, avgScore, healthy, warning, critical, duration: Math.round((Date.now() - startTime) / 1000) };

    } catch (err) {
      await db('seo_site_audit_runs').where('id', auditRun.id).update({ status: 'failed', updated_at: new Date() });
      logger.error(`Site audit failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Audit a single page — returns full audit object.
   */
  async auditPage(url, html, statusCode, responseTime, keyword, city, pageType, siteUrl = SITE_URL) {
    const lower = (html || '').toLowerCase();
    const issues = [];

    // Meta
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const metaTitle = titleMatch?.[1]?.trim() || '';
    const metaDesc = this.getMetaContent(html, 'name', 'description')?.trim() || '';
    const ogImage = this.getMetaContent(html, 'property', 'og:image') || null;
    const soft404 = this.isSoft404(html, metaTitle, statusCode);

    if (statusCode === 0 || statusCode >= 500) issues.push({ category: 'crawl', type: 'fetch_failed', severity: 'critical', recommendation: 'Page could not be fetched for audit' });
    else if (statusCode >= 400) issues.push({ category: 'crawl', type: 'http_error', severity: 'critical', recommendation: `Page returned HTTP ${statusCode}` });
    else if (soft404) issues.push({ category: 'crawl', type: 'soft_404', severity: 'critical', recommendation: 'Return HTTP 404/410 for missing pages or 301 redirect stale URLs to the closest relevant live page' });
    // Title LENGTH is intentionally NOT audited: long keyword-rich titles on
    // city/service pages are a deliberate SEO play (owner decision 2026-06-12),
    // and a length warning docked every such page 5 health points. The raw
    // meta_title_length still returns as data below.
    if (!metaTitle) issues.push({ category: 'meta', type: 'missing_title', severity: 'critical', recommendation: 'Add a title tag' });
    if (!metaDesc) issues.push({ category: 'meta', type: 'missing_description', severity: 'warning', recommendation: 'Add a meta description' });

    // Headings
    const h1s = extractHeadingTexts(html, 1);
    const h1Text = h1s[0] || '';
    const h2s = extractHeadingTexts(html, 2);

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
    const missingAlt = imgs.filter(i => !/\salt\s*=\s*["'][^"']+["']/i.test(i)).length;
    if (missingAlt > 3) issues.push({ category: 'images', type: 'missing_alt', severity: 'warning', recommendation: `${missingAlt} images missing alt text` });

    // Schema
    const schemaBlocks = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    const schemaTypes = [];
    let schemaValid = true;
    for (const block of schemaBlocks) {
      try {
        const json = JSON.parse(block.replace(/<[^>]+>/g, ''));
        schemaTypes.push(...collectSchemaTypes(json));
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
    const canonicalUrl = this.getCanonicalUrl(html);
    const canonicalSelf = canonicalUrl ? canonicalUrl.replace(/\/$/, '') === url.replace(/\/$/, '') : false;
    const siteHost = new URL(siteUrl).hostname.replace(/^www\./, '');
    const hostPattern = escapeRegExp(siteHost);
    const absoluteInternalHref = `https?:\\/\\/(?:www\\.)?${hostPattern}(?::\\d+)?`;
    const sameHostBoundary = `(?:[/?#"'\\s]|$)`;
    const sameHostHref = `(?:www\\.)?${hostPattern}(?::\\d+)?${sameHostBoundary}`;
    const internalHrefPattern = new RegExp(`href=["'](?:${absoluteInternalHref}|\\/(?!\\/))`, 'gi');
    const externalHrefPattern = new RegExp(`href=["']https?:\\/\\/(?!${sameHostHref})`, 'gi');
    const hrefTargetPattern = new RegExp(`href=["']((?:${absoluteInternalHref}|\\/(?!\\/))[^"'#?]*)`, 'gi');
    const internalLinks = (html.match(internalHrefPattern) || []);
    const externalLinks = (html.match(externalHrefPattern) || []);
    const internalLinkTargets = [];
    const hrefMatches = html.matchAll(hrefTargetPattern);
    for (const m of hrefMatches) internalLinkTargets.push(m[1]);

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
      robots_meta: this.getMetaContent(html, 'name', 'robots'),
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
      body_text_5k: bodyText.substring(0, 5000),
      thin_content_flag: thinContent,
      total_images: imgs.length,
      images_missing_alt: missingAlt,
      images_over_200kb: 0, // Would need image size checking
      internal_links_count: internalLinks.length,
      external_links_count: externalLinks.length,
      internal_link_targets: JSON.stringify(internalLinkTargets),
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
      const signal = timeoutSignal(pageSpeedTimeoutMs());
      const res = await fetch(
        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${apiKey}`,
        signal ? { signal } : undefined,
      );
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

  async getDashboard(domainInput = null) {
    const domain = extractDomain(domainInput) || 'wavespestcontrol.com';
    const latestRun = await db('seo_site_audit_runs').where('status', 'completed').where('domain', domain).orderBy('run_date', 'desc').first();
    if (!latestRun) return { hasData: false };

    const pages = await db('seo_page_audits')
      .where('audit_date', etDateString(latestRun.run_date))
      .where('domain', domain)
      .orderBy('technical_health_score', 'asc');

    const issues = await db('seo_audit_issue_trends')
      .where('audit_run_id', latestRun.id)
      .orderByRaw("CASE WHEN severity = 'critical' THEN 0 WHEN severity = 'warning' THEN 1 ELSE 2 END")
      .orderBy('affected_count', 'desc');

    const history = await db('seo_site_audit_runs').where('status', 'completed').where('domain', domain).orderBy('run_date', 'desc').limit(12);

    return {
      hasData: true,
      domain,
      latestRun,
      pages,
      issues,
      history: history.map(h => ({ date: h.run_date, score: parseFloat(h.avg_health_score), pages: h.pages_crawled, critical: h.total_critical_issues })),
    };
  }

  async getPageDetail(url, domainInput = null) {
    const domain = extractDomain(domainInput) || extractDomain(url);
    let query = db('seo_page_audits').where('url', url);
    if (domain) query = query.where('domain', domain);
    const audits = await query.orderBy('audit_date', 'desc').limit(10);
    return { audits, latest: audits[0] };
  }
}

const siteAuditor = new SiteAuditor();
siteAuditor._internals = { collectSchemaTypes, extractHeadingTexts, pageSpeedTimeoutMs, timeoutSignal };

module.exports = siteAuditor;
