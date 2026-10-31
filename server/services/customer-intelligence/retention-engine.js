const db = require('../../models/db');

class RetentionEngine {

  /**
   * Get retention metrics for the dashboard.
   */
  async getMetrics(days = 30) {
    const since = new Date(Date.now() - days * 86400000);

    const outreach = await db('retention_outreach').where('created_at', '>', since);
    const sent = outreach.filter(o => ['sent', 'completed', 'customer_responded', 'save_successful', 'save_failed'].includes(o.status));
    const saved = outreach.filter(o => o.outcome === 'retained' || o.status === 'save_successful');
    const lost = outreach.filter(o => o.outcome === 'cancelled' || o.status === 'save_failed');
    const revenueSaved = saved.reduce((s, o) => s + parseFloat(o.revenue_saved || 0), 0);

    const upsells = await db('upsell_opportunities').where('created_at', '>', since);
    const pitched = upsells.filter(u => ['pitched', 'accepted', 'declined'].includes(u.status));
    const accepted = upsells.filter(u => u.status === 'accepted');
    const upsellRevenue = accepted.reduce((s, u) => s + parseFloat(u.estimated_monthly_value || 0), 0);

    return {
      outreachSent: sent.length,
      customersSaved: saved.length,
      saveRate: sent.length > 0 ? Math.round(saved.length / sent.length * 100) : 0,
      revenueSaved: Math.round(revenueSaved * 100) / 100,
      revenueSavedAnnual: Math.round(revenueSaved * 12 * 100) / 100,
      customersLost: lost.length,
      upsellsPitched: pitched.length,
      upsellsAccepted: accepted.length,
      upsellRevenue: Math.round(upsellRevenue * 100) / 100,
      period: `${days}d`,
    };
  }
}

module.exports = new RetentionEngine();
