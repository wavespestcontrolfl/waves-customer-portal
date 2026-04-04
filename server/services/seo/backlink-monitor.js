const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');

const TOXIC_DOMAINS = /casino|poker|pharma|pills|crypto|bitcoin|adult|xxx|gambling|cheap-/i;
const SPAM_TLDS = /\.xyz$|\.top$|\.buzz$|\.click$|\.site$|\.online$/i;

class BacklinkMonitor {
  async scan() {
    logger.info('Backlink scan starting...');
    const data = await dataforseo.getBacklinks('wavespestcontrol.com', 2000);

    if (!data?.tasks?.[0]?.result?.[0]?.items) {
      logger.warn('No backlink data returned');
      return { scanned: 0 };
    }

    const links = data.tasks[0].result[0].items;
    let newCritical = 0, scanned = 0;

    for (const link of links) {
      const toxicity = this.scoreToxicity(link);

      const existing = await db('seo_backlinks').where('source_url', link.url_from).where('target_url', link.url_to).first();
      const record = {
        source_url: link.url_from, source_domain: link.domain_from, target_url: link.url_to,
        anchor_text: link.anchor, domain_rating: link.domain_from_rank,
        toxicity_score: toxicity.score, toxicity_reasons: JSON.stringify(toxicity.reasons),
        severity: toxicity.severity, last_checked: new Date().toISOString().split('T')[0],
      };

      if (existing) {
        await db('seo_backlinks').where('id', existing.id).update({ ...record, updated_at: new Date() });
      } else {
        record.first_seen = new Date().toISOString().split('T')[0];
        record.status = 'active';
        await db('seo_backlinks').insert(record);
        if (toxicity.severity === 'critical') newCritical++;
      }
      scanned++;
    }

    // Alert on new critical links
    if (newCritical > 0) {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `🔗 ${newCritical} new toxic backlink(s) detected for wavespestcontrol.com. Review in /admin/ads → SEO → Backlinks`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* best effort */ }
    }

    logger.info(`Backlink scan: ${scanned} checked, ${newCritical} new critical`);
    return { scanned, newCritical };
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
    const today = new Date().toISOString().split('T')[0];
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
      lost_backlinks_since_last: 0,
      avg_domain_rating: all.length > 0 ? Math.round(all.reduce((s, b) => s + (b.domain_rating || 0), 0) / all.length) : 0,
      dofollow_count: all.filter(b => b.is_dofollow !== false).length,
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

    for (const link of links) {
      const existing = await db('seo_competitor_backlinks')
        .where({ competitor_domain: competitorDomain, source_domain: link.domain_from })
        .first();

      const hasWavesLink = wavesDomains.has(link.domain_from);

      if (existing) {
        await db('seo_competitor_backlinks').where('id', existing.id).update({
          last_checked: new Date().toISOString().split('T')[0],
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
          first_seen: link.first_seen || new Date().toISOString().split('T')[0],
          last_checked: new Date().toISOString().split('T')[0],
          waves_has_link: hasWavesLink,
          prospect_priority: !hasWavesLink && (link.domain_from_rank || 0) > 30 ? 'high' : 'medium',
        });
        if (!hasWavesLink) gaps++;
      }
    }

    logger.info(`Competitor gap scan ${competitorDomain}: ${links.length} links, ${gaps} new gap opportunities`);
    return { scanned: links.length, gaps };
  }

  /**
   * Check LLM mentions of Waves Pest Control.
   */
  async checkLLMMentions() {
    const queries = [
      'best pest control bradenton florida',
      'pest control sarasota fl reviews',
      'lawn care service lakewood ranch',
      'termite inspection bradenton',
      'mosquito control southwest florida',
    ];

    // Use DataForSEO LLM Mentions API if available
    for (const query of queries) {
      try {
        const data = await dataforseo.request('/serp/google/ai_overview/live/advanced', [{
          keyword: query,
          location_name: 'Bradenton,Florida,United States',
          language_name: 'English',
        }]);

        const items = data?.tasks?.[0]?.result?.[0]?.items || [];
        const aio = items.find(i => i.type === 'ai_overview');

        if (aio) {
          const text = JSON.stringify(aio).toLowerCase();
          const wavesMentioned = text.includes('waves pest') || text.includes('wavespestcontrol');
          const competitors = [];
          ['turner pest', 'hoskins', 'orkin', 'terminix', 'truly nolen', 'hometeam'].forEach(c => {
            if (text.includes(c)) competitors.push({ name: c });
          });

          await db('seo_llm_mentions').insert({
            llm_platform: 'google_ai_overview',
            query,
            mention_context: wavesMentioned ? text.substring(0, 500) : null,
            waves_mentioned: wavesMentioned,
            competitors_mentioned: JSON.stringify(competitors),
            sentiment: wavesMentioned ? 'positive' : 'neutral',
            check_date: new Date().toISOString().split('T')[0],
          });
        }
      } catch { /* non-critical */ }
    }

    logger.info('LLM mentions check complete');
  }

  /**
   * Get full backlink dashboard with trends.
   */
  async getFullDashboard() {
    const basic = await this.getDashboard();
    const snapshots = await db('seo_backlink_snapshots').orderBy('snapshot_date', 'desc').limit(12);
    const competitorGaps = await db('seo_competitor_backlinks')
      .where('waves_has_link', false)
      .where('prospect_status', 'unreviewed')
      .orderBy('source_domain_rating', 'desc')
      .limit(20);
    const llmMentions = await db('seo_llm_mentions').orderBy('check_date', 'desc').limit(20);
    const citations = await db('seo_citations').orderBy('priority', 'asc');

    return {
      ...basic,
      snapshots,
      competitorGaps,
      llmMentions,
      citations,
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
