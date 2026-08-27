const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const TOXIC_DOMAINS = /casino|poker|pharma|pills|crypto|bitcoin|adult|xxx|gambling|cheap-/i;
const SPAM_TLDS = /\.xyz$|\.top$|\.buzz$|\.click$|\.site$|\.online$/i;

// Loss verification knobs. A link must be absent from MISS_THRESHOLD consecutive
// complete scans AND fail an HTTP re-verify before it is marked lost; a source
// page that returns no HTTP status at all gets UNREACHABLE_THRESHOLD misses.
const MISS_THRESHOLD = 2;
const UNREACHABLE_THRESHOLD = 4;
const VERIFY_CAP = 300;
const VERIFY_CONCURRENCY = 5;
// Link types that never earn a bell or a recovery prospect when they drop.
const NON_EDITORIAL_TYPES = new Set(['directory', 'citation', 'social', 'comment', 'forum']);
// Waves-owned properties — losing a self-link is not a loss to chase. Seeded from
// the canonical marketing fleet (hub + spokes); BACKLINK_OWNED_DOMAINS extends it
// with comma-separated bare hosts (e.g. a newsletter host).
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');
const OWNED_DOMAINS = new Set([
  ...SPOKE_SITE_KEYS,
  ...String(process.env.BACKLINK_OWNED_DOMAINS || '').split(','),
].map(d => String(d || '').trim().toLowerCase().replace(/^www\./, '')).filter(Boolean));

function comparableDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|mail)\./, '').replace(/[/:].*$/, '');
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const cur = idx++; out[cur] = await fn(items[cur], cur); }
  });
  await Promise.all(workers);
  return out;
}

class BacklinkMonitor {
  /**
   * Weekly inbound scan.
   *
   * Loss is a VERIFIED state, not "DataForSEO didn't list it this week":
   *   1. a link absent from a complete scan gets miss_count += 1;
   *   2. at MISS_THRESHOLD consecutive misses the source page is fetched and
   *      parsed (same crawler the outbound verifier uses);
   *   3. only a crawl that finds no dofollow/nofollow link at all flips the row
   *      to lost, stamped with lost_at + lost_reason (page_gone|link_removed|
   *      unreachable). A crawl that still finds the link resets the miss
   *      counter (DataForSEO index churn — the Aug 2026 audit found ~half of
   *      all "lost" rows were still live).
   *
   * rel changes (dofollow → nofollow/sponsored and back) are recorded as
   * seo_backlink_events, never as a loss: the fetch is no longer dofollow-only,
   * so a flipped link keeps its row instead of vanishing from the scan.
   */
  async scan(opts = {}) {
    // Single-flight: the weekly cron, the admin Scan button and the strategist's
    // scan_backlinks tool can overlap; two concurrent scans would each count a
    // miss, verify and alert on the same rows. Postgres advisory lock via the
    // shared cron-lock helper — a skipped caller gets { skipped, reason }.
    const exclusive = opts.exclusive || require('../../utils/cron-lock').runExclusive;
    return exclusive('backlink-scan', () => this.scanExclusive(opts), { recordHealth: false });
  }

  async scanExclusive({ crawlFn, recoveryFn, snapshot = false, now = new Date(), pageSize = 1000 } = {}) {
    logger.info('Backlink scan starting...');
    const PAGE = pageSize;
    // Page until DataForSEO's total_count is reached. The cap is a runaway
    // guard only (50k links ≈ 50× the current profile); hitting it is logged and
    // leaves scanComplete=false so loss detection is skipped, never guessed.
    const MAX_PAGES = 50;
    const links = [];
    let totalCount = 0;
    let pagesOk = true;

    let gotResult = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await dataforseo.getBacklinks('wavespestcontrol.com', PAGE, { dofollowOnly: false, offset: page * PAGE });
      const result = data?.tasks?.[0]?.result?.[0];
      // A missing/invalid result (API error, null) is NOT the same as a valid
      // empty page: the former aborts, the latter is a complete scan.
      if (!Array.isArray(result?.items)) { pagesOk = false; break; }
      gotResult = true;
      links.push(...result.items);
      totalCount = Number(result.total_count) || links.length;
      if (result.items.length < PAGE || links.length >= totalCount) break;
      if (page === MAX_PAGES - 1) logger.warn(`Backlink scan: page cap ${MAX_PAGES} reached at ${links.length}/${totalCount} — loss detection will be skipped`);
    }

    if (!gotResult) {
      logger.warn('No backlink data returned');
      return { scanned: 0, scanComplete: false };
    }
    const scanComplete = pagesOk && links.length >= totalCount;
    const today = etDateString(now);

    // Build active link map with composite keys BEFORE processing
    const activeLinks = await db('seo_backlinks')
      .where('status', 'active')
      .where((qb) => qb.whereNull('discovery_source').orWhere('discovery_source', 'dataforseo'))
      .select('id', 'source_url', 'target_url', 'source_domain', 'domain_rating', 'anchor_text', 'miss_count', 'is_dofollow', 'severity', 'link_type');
    const activeMap = new Map(activeLinks.map(l => [`${l.source_url}::${l.target_url}`, l]));
    const seenKeys = new Set();

    let newCritical = 0, scanned = 0, relChanges = 0, recovered = 0;

    for (const link of links) {
      const toxicity = this.scoreToxicity(link);
      seenKeys.add(`${link.url_from}::${link.url_to}`);
      const isDofollow = link.dofollow !== false;

      const existing = await db('seo_backlinks').where('source_url', link.url_from).where('target_url', link.url_to).first();
      const record = {
        source_url: link.url_from, source_domain: link.domain_from, target_url: link.url_to,
        anchor_text: link.anchor, domain_rating: link.domain_from_rank,
        toxicity_score: toxicity.score, toxicity_reasons: JSON.stringify(toxicity.reasons),
        severity: toxicity.severity, last_checked: today, last_seen: today,
        is_dofollow: isDofollow, miss_count: 0,
        discovery_source: 'dataforseo',
      };

      if (existing) {
        const newStatus = existing.status === 'disavowed' ? 'disavowed' : 'active';
        const patch = { ...record, status: newStatus, updated_at: now };
        if (existing.status === 'lost') {
          patch.lost_at = null; patch.lost_reason = null;
          recovered++;
          await this.recordEvent(existing.id, 'recovered', { previous_lost_reason: existing.lost_reason || null });
          // A recovery prospect queued for this link (still un-pitched) is now
          // moot — resolve it so the drafter never asks for a link that is live.
          try {
            const { resolveRecoveredLink } = require('./lost-link-recovery');
            await resolveRecoveredLink({ ...existing, source_url: link.url_from, source_domain: link.domain_from, target_url: link.url_to }, now);
          } catch (err) { logger.warn(`Backlink scan: recovery prospect resolve failed for ${link.domain_from}: ${err.message}`); }
        }
        if (existing.is_dofollow != null && existing.is_dofollow !== isDofollow) {
          relChanges++;
          await this.recordEvent(existing.id, 'rel_changed', { from: existing.is_dofollow ? 'dofollow' : 'nofollow', to: isDofollow ? 'dofollow' : 'nofollow', source: 'dataforseo' });
        }
        await db('seo_backlinks').where('id', existing.id).update(patch);
      } else {
        record.first_seen = today;
        record.status = 'active';
        await db('seo_backlinks').insert(record);
        if (toxicity.severity === 'critical') newCritical++;
      }
      scanned++;
    }

    // Loss detection — ONLY when scan is complete (fetched < limit)
    let lostLinks = [];
    let missed = 0, verifiedLive = 0, unverified = 0;
    let lostDomains = [];

    if (scanComplete) {
      const missing = [...activeMap.keys()].filter(k => !seenKeys.has(k)).map(k => activeMap.get(k)).filter(Boolean);
      missed = missing.length;
      const firstMiss = missing.filter(l => (l.miss_count || 0) + 1 < MISS_THRESHOLD);
      const candidates = missing.filter(l => (l.miss_count || 0) + 1 >= MISS_THRESHOLD);

      if (firstMiss.length) {
        await db('seo_backlinks').whereIn('id', firstMiss.map(l => l.id)).increment('miss_count', 1);
      }
      if (candidates.length > VERIFY_CAP) {
        logger.warn(`Backlink scan: ${candidates.length} loss candidates, verifying first ${VERIFY_CAP} (rest carried to next scan)`);
      }
      const toVerify = candidates.slice(0, VERIFY_CAP);
      const carried = candidates.slice(VERIFY_CAP);
      if (carried.length) {
        await db('seo_backlinks').whereIn('id', carried.map(l => l.id)).increment('miss_count', 1);
      }

      const verdicts = await mapPool(toVerify, VERIFY_CONCURRENCY, (l) => this.verifyLoss(l, { crawlFn }));
      for (let i = 0; i < toVerify.length; i++) {
        const l = toVerify[i];
        const v = verdicts[i];
        if (v.outcome === 'live') {
          verifiedLive++;
          const patch = { miss_count: 0, last_seen: today, updated_at: now };
          if (l.is_dofollow != null && l.is_dofollow !== v.isDofollow) {
            relChanges++;
            patch.is_dofollow = v.isDofollow;
            await this.recordEvent(l.id, 'rel_changed', { from: l.is_dofollow ? 'dofollow' : 'nofollow', to: v.isDofollow ? 'dofollow' : 'nofollow', source: 'crawl' });
          }
          await db('seo_backlinks').where('id', l.id).update(patch);
          await this.recordEvent(l.id, 'verify_survived', { misses: (l.miss_count || 0) + 1, status: v.status || null });
        } else if (v.outcome === 'lost') {
          lostLinks.push({ ...l, lost_reason: v.reason });
          await db('seo_backlinks').where('id', l.id).update({
            status: 'lost', lost_at: now, lost_reason: v.reason, miss_count: (l.miss_count || 0) + 1, updated_at: now,
          });
          await this.recordEvent(l.id, 'lost', { reason: v.reason, status: v.status || null, error: v.error || null, misses: (l.miss_count || 0) + 1 });
        } else {
          // unreachable but not yet past the patience window — keep counting
          unverified++;
          await db('seo_backlinks').where('id', l.id).increment('miss_count', 1);
        }
      }

      lostDomains = await this.domainLevelLosses(lostLinks);
    } else {
      logger.info(`Backlink scan partial (${links.length}/${totalCount}) — loss detection skipped`);
    }

    // Alert on new critical toxic links
    if (newCritical > 0 && process.env.NODE_ENV === 'production') {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `🔗 ${newCritical} new toxic backlink(s) detected for wavespestcontrol.com. Review in /admin/seo → Backlinks`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* best effort */ }
    }

    // Alert on VERIFIED referring-domain losses only (DR>=30, non-directory) —
    // a rotated directory page or an index-churn miss is not worth a bell.
    const alertable = lostDomains.filter(d => d.alertable);
    if (scanComplete && alertable.length > 0 && process.env.NODE_ENV === 'production') {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          const names = alertable.slice(0, 3).map(d => `${d.domain} DR${d.domain_rating} (${d.lost_reason})`).join(', ');
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `⚠️ ${alertable.length} referring domain(s) lost — verified by crawl: ${names}. Review in /admin/seo → Backlinks`,
            { messageType: 'internal_alert', link: '/admin/seo' }
          );
        }
      } catch { /* best effort */ }
    }

    // Reacquisition: a verified domain-level loss worth having back goes onto the
    // Link Building board so the outreach drafter picks it up.
    let recoveryQueued = 0;
    if (alertable.length) {
      try {
        const recovery = recoveryFn || require('./lost-link-recovery').queueLostDomains;
        const r = await recovery(alertable);
        recoveryQueued = r?.queued || 0;
      } catch (err) {
        logger.warn(`Backlink scan: lost-link recovery failed: ${err.message}`);
      }
    }

    // Trend snapshot only after a COMPLETE scan, inside the same exclusive
    // section — never stamp a partial or overlapping scan as the day's numbers.
    if (snapshot && scanComplete) {
      try { await this.takeSnapshot(); }
      catch (err) { logger.error(`Backlink snapshot failed: ${err.message}`); }
    }

    logger.info(`Backlink scan: ${scanned} checked, ${newCritical} new critical, ${missed} missing, ${lostLinks.length} lost (verified), ${verifiedLive} survived crawl, ${unverified} unreachable, ${relChanges} rel changes, ${recovered} recovered, ${lostDomains.length} domains lost, ${recoveryQueued} queued for recovery (scanComplete: ${scanComplete})`);
    return {
      scanned, newCritical, scanComplete, missed,
      lostCount: lostLinks.length, verifiedLive, unverified, relChanges, recovered,
      lostDomains: lostDomains.length, highValueLost: alertable.length, recoveryQueued,
    };
  }

  /**
   * Fetch the source page and decide whether a twice-missed link is really gone.
   * Returns { outcome: 'live'|'lost'|'unverified', reason?, isDofollow?, status?, error? }.
   */
  async verifyLoss(link, { crawlFn } = {}) {
    const crawl = crawlFn || require('./link-prospect-verifier').crawlForLink;
    const target = String(link.target_url || '').split('#')[0].split('?')[0];
    let res;
    // exact: the lost link's own page must be present — a surviving link to a
    // descendant path (/service/article for a lost /service) does not count.
    try { res = await crawl(link.source_url, target, { exact: true }); }
    catch (err) { res = { found: false, error: err.message }; }

    if (res?.found) return { outcome: 'live', isDofollow: res.isDofollow !== false, status: res.status };
    const status = Number(res?.status) || 0;
    // Only definitive answers verify a loss: the page is gone (404/410) or the
    // page rendered fine without our link (2xx, COMPLETE body). 403/429/5xx,
    // redirect loops, truncated bodies, DNS/TLS/timeouts and SSRF-blocked hosts
    // prove nothing — keep counting and call it 'unreachable' only after a
    // longer patience window.
    if (status === 404 || status === 410) return { outcome: 'lost', reason: 'page_gone', status };
    if (status >= 200 && status < 300 && !res?.truncated) return { outcome: 'lost', reason: 'link_removed', status };
    const error = res?.error || (res?.truncated ? 'truncated_body' : status ? `http_${status}` : null);
    if ((link.miss_count || 0) + 1 >= UNREACHABLE_THRESHOLD) return { outcome: 'lost', reason: 'unreachable', status: status || null, error };
    return { outcome: 'unverified', status: status || null, error };
  }

  /**
   * Roll verified link losses up to referring domains that now have NO active
   * link left, and flag the ones worth a bell / a recovery prospect.
   */
  async domainLevelLosses(lostLinks) {
    if (!lostLinks.length) return [];
    // Representative per domain: prefer the row that can make the domain
    // alertable (verified reason + editorial-ish type), then DR. domain_rating is
    // domain-level so ties are the norm — picking "first row" would let a
    // rotated directory page or an unreachable row mask a real editorial loss.
    const rank = (l) => {
      const type = l.link_type || this.classifyLinkType(l);
      return (['page_gone', 'link_removed'].includes(l.lost_reason) ? 2 : 0)
        + (NON_EDITORIAL_TYPES.has(type) ? 0 : 1)
        + (l.domain_rating || 0) / 1000;
    };
    const byDomain = new Map();
    for (const l of lostLinks) {
      const domain = comparableDomain(l.source_domain);
      if (!domain) continue;
      const cur = byDomain.get(domain);
      if (!cur || rank(l) > rank(cur)) byDomain.set(domain, { ...l, domain });
    }
    const out = [];
    for (const [domain, best] of byDomain) {
      // Only scan-tracked rows count as survival: a GSC-export row is excluded
      // from loss detection by design, so it can never go lost and must not
      // stand as permanent proof the domain still links us.
      const stillActive = await db('seo_backlinks')
        .where('status', 'active')
        .where((qb) => qb.whereNull('discovery_source').orWhere('discovery_source', 'dataforseo'))
        .whereRaw("regexp_replace(lower(source_domain), '^(www|mail)\\.', '') = ?", [domain])
        .first('id');
      if (stillActive) continue;
      const linkType = best.link_type || this.classifyLinkType(best);
      const owned = OWNED_DOMAINS.has(domain);
      const toxic = ['critical', 'warning'].includes(best.severity);
      const alertable = !owned && !toxic && (best.domain_rating || 0) >= 30 && !NON_EDITORIAL_TYPES.has(linkType)
        && ['page_gone', 'link_removed'].includes(best.lost_reason);
      out.push({
        domain, backlink_id: best.id, source_url: best.source_url, target_url: best.target_url,
        domain_rating: best.domain_rating || 0, anchor_text: best.anchor_text || null,
        link_type: linkType, lost_reason: best.lost_reason, alertable,
      });
    }
    return out;
  }

  async recordEvent(backlinkId, eventType, detail) {
    try {
      await db('seo_backlink_events').insert({ backlink_id: backlinkId, event_type: eventType, detail: detail ? JSON.stringify(detail) : null });
    } catch (err) {
      logger.warn(`Backlink event ${eventType} for ${backlinkId} not recorded: ${err.message}`);
    }
  }

  scoreToxicity(link) {
    const reasons = [];
    let score = 0;
    const domain = link.domain_from || '';
    const anchor = (link.anchor || '').toLowerCase();

    if (TOXIC_DOMAINS.test(domain)) { score += 40; reasons.push('toxic_niche'); }
    if (SPAM_TLDS.test(domain)) { score += 25; reasons.push('spam_tld'); }
    if ((link.domain_from_rank || 0) < 5 && (link.external_links_count || 0) > 500) { score += 30; reasons.push('link_farm'); }
    if (anchor.includes('pest control') && score > 0) { score += 20; reasons.push('exact_match_anchor_from_spam'); }
    if (/[\u0400-\u04FF\u4E00-\u9FFF\u0600-\u06FF]/.test(link.url_from || '')) { score += 25; reasons.push('foreign_language'); }

    score = Math.min(100, score);
    const severity = score >= 70 ? 'critical' : score >= 40 ? 'warning' : score >= 15 ? 'watch' : 'clean';
    return { score, severity, reasons };
  }

  async generateDisavow() {
    const toxic = await db('seo_backlinks').whereIn('severity', ['critical', 'warning']).where('status', 'active');
    const domains = [...new Set(toxic.filter(l => l.toxicity_score >= 60).map(l => l.source_domain))];
    const urls = toxic.filter(l => l.toxicity_score >= 40 && l.toxicity_score < 60).map(l => l.source_url);

    const content = `# Disavow file for wavespestcontrol.com\n# Generated ${new Date().toISOString()}\n# ${domains.length} domains, ${urls.length} URLs\n\n` +
      domains.map(d => `domain:${d}`).join('\n') + '\n\n' +
      urls.join('\n');

    await db('seo_disavow_history').insert({
      domains_disavowed: domains.length, urls_disavowed: urls.length, file_content: content,
    });

    return { content, domains: domains.length, urls: urls.length };
  }

  async getDashboard() {
    const all = await db('seo_backlinks').where('status', 'active');
    const anchors = {};
    all.forEach(l => {
      const type = this.classifyAnchor(l.anchor_text);
      anchors[type] = (anchors[type] || 0) + 1;
    });

    return {
      total: all.length,
      critical: all.filter(l => l.severity === 'critical').length,
      warning: all.filter(l => l.severity === 'warning').length,
      watch: all.filter(l => l.severity === 'watch').length,
      clean: all.filter(l => l.severity === 'clean').length,
      anchorDistribution: anchors,
      recentToxic: all.filter(l => l.severity === 'critical').slice(0, 10),
    };
  }

  classifyAnchor(text) {
    const t = (text || '').toLowerCase();
    if (t.includes('waves') || t.includes('wavespest')) return 'branded';
    if (t.includes('http') || t.includes('wavespestcontrol.com')) return 'naked_url';
    if (t.includes('click here') || t.includes('learn more') || t.includes('visit')) return 'generic';
    if (t.includes('pest') || t.includes('lawn') || t.includes('termite') || t.includes('mosquito')) return 'keyword_rich';
    return 'other';
  }

  /**
   * Take a snapshot of current backlink profile for trend tracking.
   */
  async takeSnapshot() {
    const today = etDateString();
    const all = await db('seo_backlinks').where('status', 'active');
    const domains = new Set(all.map(b => b.source_domain));
    const anchors = { branded: 0, keyword_rich: 0, naked_url: 0, generic: 0, other: 0 };
    all.forEach(l => { const t = this.classifyAnchor(l.anchor_text); anchors[t] = (anchors[t] || 0) + 1; });
    const total = all.length || 1;

    // "Since last" means since the previous DAY's snapshot — a same-day re-take
    // (cron, then a GSC import or manual Scan) must not treat the row it is about
    // to overwrite as the baseline, or the day's losses collapse to 0.
    const prev = await db('seo_backlink_snapshots').where('snapshot_date', '<', today).orderBy('snapshot_date', 'desc').first();
    const prevDomains = prev ? new Set() : new Set(); // simplified

    await db('seo_backlink_snapshots').insert({
      snapshot_date: today,
      total_backlinks: all.length,
      total_referring_domains: domains.size,
      new_backlinks_since_last: prev ? all.filter(b => b.first_seen && b.first_seen >= (prev.snapshot_date || today)).length : all.length,
      lost_backlinks_since_last: prev
        ? await db('seo_backlinks').where('status', 'lost')
            .where('lost_at', '>=', prev.created_at || prev.snapshot_date)
            .count('id as count').first().then(r => parseInt(r?.count) || 0)
        : 0,
      avg_domain_rating: all.length > 0 ? Math.round(all.reduce((s, b) => s + (b.domain_rating || 0), 0) / all.length) : 0,
      dofollow_count: all.filter(b => b.is_dofollow === true).length,
      nofollow_count: all.filter(b => b.is_dofollow === false).length,
      critical_count: all.filter(b => b.severity === 'critical').length,
      warning_count: all.filter(b => b.severity === 'warning').length,
      watch_count: all.filter(b => b.severity === 'watch').length,
      clean_count: all.filter(b => b.severity === 'clean').length,
      anchor_branded_pct: Math.round(anchors.branded / total * 100),
      anchor_keyword_pct: Math.round(anchors.keyword_rich / total * 100),
      anchor_naked_url_pct: Math.round(anchors.naked_url / total * 100),
      anchor_generic_pct: Math.round(anchors.generic / total * 100),
    }).onConflict('snapshot_date').merge();

    logger.info(`Backlink snapshot: ${all.length} links, ${domains.size} domains`);
  }

  /**
   * Classify link type based on source domain/URL patterns.
   */
  classifyLinkType(link) {
    const domain = (link.source_domain || '').toLowerCase();
    const url = (link.source_url || '').toLowerCase();

    const directories = ['yelp.com', 'bbb.org', 'angi.com', 'thumbtack.com', 'yellowpages.com', 'mapquest.com', 'manta.com', 'hotfrog.com', 'homeadvisor.com'];
    const citations = ['fpma.org', 'npma.org', 'qualitypro.org', 'pestworld.org'];
    const social = ['facebook.com', 'linkedin.com', 'nextdoor.com', 'alignable.com', 'instagram.com'];

    if (directories.some(d => domain.includes(d)) || /\/directory|\/listing|\/business/i.test(url)) return 'directory';
    if (citations.some(d => domain.includes(d))) return 'citation';
    if (social.some(d => domain.includes(d))) return 'social';
    if (domain.includes('reddit.com') || /\/forum|\/thread|\/discussion/i.test(url)) return 'forum';
    if (/\/comment/i.test(url)) return 'comment';
    if (/\/resources|\/partners|\/links/i.test(url)) return 'resource';
    if (/herald|tribune|patch\.com|news/i.test(domain)) return 'editorial';
    if (/blog/i.test(url)) return 'editorial';
    return 'unknown';
  }

  /**
   * Classify which Waves page type is being linked to.
   */
  classifyTargetPage(targetUrl) {
    const path = (targetUrl || '').toLowerCase();
    if (path === 'https://wavespestcontrol.com/' || path === 'https://www.wavespestcontrol.com/') return 'homepage';
    if (/\/pest-control|\/lawn-care|\/mosquito|\/termite|\/rodent|\/tree/i.test(path)) return 'service';
    if (/bradenton|sarasota|venice|parrish|lakewood|north-port|port-charlotte/i.test(path)) return 'city';
    if (/\/blog|\/post/i.test(path)) return 'blog';
    return 'other';
  }

  /**
   * Scan competitor backlinks and find gap opportunities.
   */
  async scanCompetitorGaps(competitorDomain) {
    const data = await dataforseo.getBacklinks(competitorDomain, 500);
    if (!data?.tasks?.[0]?.result?.[0]?.items) return { scanned: 0 };

    const links = data.tasks[0].result[0].items;
    const wavesLinks = await db('seo_backlinks').where('status', 'active').select('source_domain');
    const wavesDomains = new Set(wavesLinks.map(l => l.source_domain));
    let gaps = 0;
    const newHighValueGaps = [];

    for (const link of links) {
      const existing = await db('seo_competitor_backlinks')
        .where({ competitor_domain: competitorDomain, source_domain: link.domain_from })
        .first();

      const hasWavesLink = wavesDomains.has(link.domain_from);

      if (existing) {
        await db('seo_competitor_backlinks').where('id', existing.id).update({
          last_checked: etDateString(),
          waves_has_link: hasWavesLink,
          updated_at: new Date(),
        });
      } else {
        await db('seo_competitor_backlinks').insert({
          competitor_domain: competitorDomain,
          source_url: link.url_from,
          source_domain: link.domain_from,
          source_domain_rating: link.domain_from_rank,
          anchor_text: link.anchor,
          target_url: link.url_to,
          link_type: this.classifyLinkType({ source_domain: link.domain_from, source_url: link.url_from }),
          is_dofollow: link.dofollow !== false,
          first_seen: link.first_seen || etDateString(),
          last_checked: etDateString(),
          waves_has_link: hasWavesLink,
          // Relevance + lead-value aware priority (not raw DR>30), contact-agnostic
          // for cost — see prospect-scorer.heuristicPriority.
          prospect_priority: hasWavesLink ? 'medium' : require('./prospect-scorer').heuristicPriority({
            domain: link.domain_from,
            source_url: link.url_from,
            domain_rating: link.domain_from_rank,
            sample_anchors: link.anchor ? [link.anchor] : [],
          }),
        });
        if (!hasWavesLink) {
          gaps++;
          if ((link.domain_from_rank || 0) >= 40) {
            newHighValueGaps.push({
              source_domain: link.domain_from,
              domain_rating: link.domain_from_rank,
              competitor: competitorDomain,
              anchor: link.anchor,
            });
          }
        }
      }
    }

    if (newHighValueGaps.length > 0 && process.env.NODE_ENV === 'production') {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          const top = newHighValueGaps.slice(0, 3);
          const names = top.map(g => `${g.source_domain} DR${g.domain_rating} (${g.competitor})`).join(', ');
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `🔗 ${newHighValueGaps.length} new competitor gap(s): ${names}. Review in /admin/seo → Backlinks`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* best effort */ }
    }

    logger.info(`Competitor gap scan ${competitorDomain}: ${links.length} links, ${gaps} new gaps, ${newHighValueGaps.length} high-value`);
    return { scanned: links.length, gaps, newHighValueGaps: newHighValueGaps.length };
  }

  /**
   * Check LLM mentions of Waves across all answer engines.
   * Delegates to the multi-platform prober (ChatGPT/Gemini/Claude/AI Overview);
   * kept here so the existing /backlinks/llm-mentions button stays wired.
   */
  async checkLLMMentions() {
    const prober = require('./llm-mention-prober');
    const result = await prober.runDaily();
    logger.info('LLM mentions check complete');
    return result;
  }

  /**
   * Get full backlink dashboard with trends.
   */
  async getFullDashboard() {
    const basic = await this.getDashboard();
    const snapshots = await db('seo_backlink_snapshots').orderBy('snapshot_date', 'desc').limit(60);
    const competitorGaps = await db('seo_competitor_backlinks')
      .where('waves_has_link', false)
      .where('prospect_status', 'unreviewed')
      .orderBy('source_domain_rating', 'desc')
      .limit(20);
    const llmMentions = await db('seo_llm_mentions').orderBy('check_date', 'desc').limit(20);
    const citations = await db('seo_citations').orderBy('priority', 'asc');

    const recentlyLost = await db('seo_backlinks')
      .where('status', 'lost')
      .orderByRaw('lost_at DESC NULLS LAST, updated_at DESC')
      .limit(10);

    // Velocity — ET-aware day boundaries
    const todayStr = etDateString();
    const sevenDaysAgoStr = etDateString(addETDays(new Date(), -7));
    const twentyEightDaysAgoStr = etDateString(addETDays(new Date(), -28));
    const toDateStr = (d) => d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
    const s7 = snapshots.filter(s => toDateStr(s.snapshot_date) > sevenDaysAgoStr);
    const s28 = snapshots.filter(s => toDateStr(s.snapshot_date) > twentyEightDaysAgoStr);
    const sum = (arr, key) => arr.reduce((t, s) => t + Number(s[key] || 0), 0);
    const new7 = sum(s7, 'new_backlinks_since_last');
    const lost7 = sum(s7, 'lost_backlinks_since_last');
    const new28 = sum(s28, 'new_backlinks_since_last');
    const lost28 = sum(s28, 'lost_backlinks_since_last');
    const net7 = new7 - lost7;
    const velocity = {
      new_7d: new7, lost_7d: lost7, net_7d: net7,
      new_28d: new28, lost_28d: lost28, net_28d: new28 - lost28,
      trend: net7 > 0 ? 'growing' : net7 < 0 ? 'shrinking' : 'flat',
    };

    // New competitor gaps in last 7 days — use Postgres interval for timestamptz comparison
    const newGapsSince7d = await db('seo_competitor_backlinks')
      .where('waves_has_link', false)
      .where('prospect_status', 'unreviewed')
      .whereRaw("created_at > now() - interval '7 days'")
      .count('id as count').first().then(r => parseInt(r?.count) || 0);
    const newHighValueGapsSince7d = await db('seo_competitor_backlinks')
      .where('waves_has_link', false)
      .where('prospect_status', 'unreviewed')
      .whereRaw("created_at > now() - interval '7 days'")
      .where('source_domain_rating', '>=', 40)
      .count('id as count').first().then(r => parseInt(r?.count) || 0);

    return {
      ...basic,
      snapshots: snapshots.slice(0, 12),
      competitorGaps,
      llmMentions,
      citations,
      recentlyLost,
      velocity,
      newGapsSince7d,
      newHighValueGapsSince7d,
      llmStats: {
        total: llmMentions.length,
        wavesMentioned: llmMentions.filter(m => m.waves_mentioned).length,
      },
      citationStats: {
        total: citations.length,
        active: citations.filter(c => c.status === 'active').length,
        inconsistent: citations.filter(c => c.status === 'inconsistent').length,
        unchecked: citations.filter(c => c.status === 'unchecked').length,
      },
    };
  }
}

module.exports = new BacklinkMonitor();
