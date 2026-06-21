const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const TOXIC_DOMAINS = /casino|poker|pharma|pills|crypto|bitcoin|adult|xxx|gambling|cheap-/i;
const SPAM_TLDS = /\.xyz$|\.top$|\.buzz$|\.click$|\.site$|\.online$/i;

class BacklinkMonitor {
  async scan() {
    logger.info('Backlink scan starting...');
    const FETCH_LIMIT = 1000;
    const data = await dataforseo.getBacklinks('wavespestcontrol.com', FETCH_LIMIT);

    if (!data?.tasks?.[0]?.result?.[0]?.items) {
      logger.warn('No backlink data returned');
      return { scanned: 0, scanComplete: false };
    }

    const result = data.tasks[0].result[0];
    const links = result.items;
    const totalCount = result.total_count || links.length;
    const scanComplete = links.length >= totalCount;

    // Build active link map with composite keys BEFORE processing
    const activeLinks = await db('seo_backlinks')
      .where('status', 'active')
      .where((qb) => qb.whereNull('discovery_source').orWhere('discovery_source', 'dataforseo'))
      .select('id', 'source_url', 'target_url', 'source_domain', 'domain_rating', 'anchor_text');
    const activeMap = new Map(activeLinks.map(l => [`${l.source_url}::${l.target_url}`, l]));
    const seenKeys = new Set();

    let newCritical = 0, scanned = 0;

    for (const link of links) {
      const toxicity = this.scoreToxicity(link);
      seenKeys.add(`${link.url_from}::${link.url_to}`);

      const existing = await db('seo_backlinks').where('source_url', link.url_from).where('target_url', link.url_to).first();
      const record = {
        source_url: link.url_from, source_domain: link.domain_from, target_url: link.url_to,
        anchor_text: link.anchor, domain_rating: link.domain_from_rank,
        toxicity_score: toxicity.score, toxicity_reasons: JSON.stringify(toxicity.reasons),
        severity: toxicity.severity, last_checked: etDateString(),
        discovery_source: 'dataforseo',
      };

      if (existing) {
        const newStatus = existing.status === 'disavowed' ? 'disavowed' : 'active';
        await db('seo_backlinks').where('id', existing.id).update({ ...record, status: newStatus, updated_at: new Date() });
      } else {
        record.first_seen = etDateString();
        record.status = 'active';
        await db('seo_backlinks').insert(record);
        if (toxicity.severity === 'critical') newCritical++;
      }
      scanned++;
    }

    // Loss detection — ONLY when scan is complete (fetched < limit)
    let lostLinks = [];
    let highValueLost = 0;

    if (scanComplete) {
      const lostKeys = [...activeMap.keys()].filter(k => !seenKeys.has(k));
      lostLinks = lostKeys.map(k => activeMap.get(k)).filter(Boolean);
      const lostIds = lostLinks.map(l => l.id);

      if (lostIds.length > 0) {
        await db('seo_backlinks').whereIn('id', lostIds).update({
          status: 'lost', updated_at: new Date(),
        });
      }
      highValueLost = lostLinks.filter(l => (l.domain_rating || 0) >= 30).length;
    } else {
      logger.info(`Backlink scan partial (${links.length}/${FETCH_LIMIT}) — loss detection skipped`);
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

    // Alert on high-value lost links (separate from toxic alert)
    if (scanComplete && highValueLost > 0 && process.env.NODE_ENV === 'production') {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          const topLost = lostLinks.filter(l => (l.domain_rating || 0) >= 30).slice(0, 3);
          const names = topLost.map(l => `${l.source_domain} DR${l.domain_rating}`).join(', ');
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `⚠️ ${highValueLost} high-value backlink(s) lost: ${names}. Review in /admin/seo → Backlinks`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* best effort */ }
    }

    logger.info(`Backlink scan: ${scanned} checked, ${newCritical} new critical, ${lostLinks.length} lost (scanComplete: ${scanComplete})`);
    return { scanned, newCritical, scanComplete, lostCount: lostLinks.length, highValueLost };
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

    const prev = await db('seo_backlink_snapshots').orderBy('snapshot_date', 'desc').first();
    const prevDomains = prev ? new Set() : new Set(); // simplified

    await db('seo_backlink_snapshots').insert({
      snapshot_date: today,
      total_backlinks: all.length,
      total_referring_domains: domains.size,
      new_backlinks_since_last: prev ? all.filter(b => b.first_seen && b.first_seen >= (prev.snapshot_date || today)).length : all.length,
      lost_backlinks_since_last: prev
        ? await db('seo_backlinks').where('status', 'lost')
            .where('updated_at', '>=', prev.created_at || prev.snapshot_date)
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
      .orderBy('updated_at', 'desc')
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
