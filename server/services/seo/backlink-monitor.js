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
}

module.exports = new BacklinkMonitor();
