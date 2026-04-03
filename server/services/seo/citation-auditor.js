const db = require('../../models/db');
const logger = require('../logger');

// Canonical NAP from locations.js
const CANONICAL_NAP = {
  name: 'Waves Pest Control',
  phone: '(941) 318-7612',
  website: 'https://wavespestcontrol.com',
};

class CitationAuditor {
  async audit() {
    logger.info('Citation audit running...');
    const citations = await db('seo_citations');

    // For now, mark all as checked (real implementation would scrape each directory)
    let consistent = 0, inconsistent = 0, missing = 0;

    for (const cit of citations) {
      if (cit.status === 'unchecked') {
        // Mark as needs manual check
        await db('seo_citations').where('id', cit.id).update({
          last_checked: new Date().toISOString().split('T')[0],
          status: 'unchecked', // stays unchecked until manually verified
        });
      } else if (cit.nap_consistent === true) {
        consistent++;
      } else if (cit.nap_consistent === false) {
        inconsistent++;
      } else {
        missing++;
      }
    }

    logger.info(`Citation audit: ${consistent} consistent, ${inconsistent} inconsistent, ${missing} unchecked`);
    return { total: citations.length, consistent, inconsistent, missing };
  }

  async getDashboard() {
    const citations = await db('seo_citations').orderBy('priority', 'asc').orderBy('directory_name');

    return {
      total: citations.length,
      byStatus: {
        active: citations.filter(c => c.status === 'active').length,
        inconsistent: citations.filter(c => c.status === 'inconsistent').length,
        missing: citations.filter(c => c.status === 'missing').length,
        claimed: citations.filter(c => c.status === 'claimed').length,
        unchecked: citations.filter(c => c.status === 'unchecked').length,
      },
      byPriority: {
        high: citations.filter(c => c.priority === 'high').length,
        medium: citations.filter(c => c.priority === 'medium').length,
      },
      citations,
      canonicalNAP: CANONICAL_NAP,
    };
  }

  async updateCitation(citationId, updates) {
    // Check NAP consistency
    if (updates.nap_name || updates.nap_phone) {
      updates.nap_consistent = (updates.nap_name || '').toLowerCase().includes('waves pest control') &&
        (updates.nap_phone || '').includes('318-7612');
      updates.status = updates.nap_consistent ? 'active' : 'inconsistent';
    }

    await db('seo_citations').where('id', citationId).update({ ...updates, last_checked: new Date().toISOString().split('T')[0], updated_at: new Date() });
  }
}

module.exports = new CitationAuditor();
