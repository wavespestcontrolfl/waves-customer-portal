const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

class ConversionFunnel {
  async aggregate(days = 30) {
    const since = etDateString(addETDays(new Date(), -days));

    // GSC clicks by landing page
    const gscPages = await db('gsc_pages')
      .where('date', '>=', since)
      .select('page_url')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .groupBy('page_url');

    // Match to keywords
    const keywords = await db('seo_target_keywords');
    const kwByUrl = {};
    keywords.forEach(kw => { if (kw.target_url) kwByUrl[kw.target_url] = kw; });

    // Estimates by landing page (approximate via date correlation)
    const estimates = await db('estimates')
      .where('created_at', '>=', since)
      .select('id', 'customer_id', 'status', 'monthly_total', 'created_at');

    // Service records for revenue
    const services = await db('service_records')
      .where('service_date', '>=', since)
      .where('status', 'completed')
      .select('customer_id', 'revenue');

    const revenueByCustomer = {};
    services.forEach(s => {
      revenueByCustomer[s.customer_id] = (revenueByCustomer[s.customer_id] || 0) + parseFloat(s.revenue || 0);
    });

    // Build funnel per landing page
    const funnel = gscPages.map(page => {
      const kw = kwByUrl[page.page_url];

      // Rough estimate matching — by day, not by referrer (we don't have referrer tracking)
      const pageEstimates = estimates.length; // simplified — would need referrer tracking for accuracy
      const booked = estimates.filter(e => e.status === 'accepted' || e.status === 'won').length;
      const revenue = Object.values(revenueByCustomer).reduce((s, r) => s + r, 0);

      return {
        landingPage: page.page_url,
        keyword: kw?.keyword || null,
        keywordId: kw?.id || null,
        city: kw?.primary_city || null,
        impressions: parseInt(page.impressions),
        clicks: parseInt(page.clicks),
        ctr: parseInt(page.impressions) > 0 ? Math.round(parseInt(page.clicks) / parseInt(page.impressions) * 10000) / 100 : 0,
      };
    }).sort((a, b) => b.clicks - a.clicks);

    // Overall organic metrics
    const totalClicks = funnel.reduce((s, f) => s + f.clicks, 0);
    const totalImpressions = funnel.reduce((s, f) => s + f.impressions, 0);
    const totalEstimates = estimates.length;
    const totalBooked = estimates.filter(e => ['accepted', 'won'].includes(e.status)).length;
    const totalRevenue = Math.round(Object.values(revenueByCustomer).reduce((s, r) => s + r, 0));

    return {
      period: `${days}d`,
      organic: { impressions: totalImpressions, clicks: totalClicks, ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 100 : 0 },
      estimates: { total: totalEstimates, booked: totalBooked, conversionRate: totalEstimates > 0 ? Math.round(totalBooked / totalEstimates * 100) : 0 },
      revenue: totalRevenue,
      funnelByPage: funnel.slice(0, 30),
    };
  }

  async getDashboard(days = 30) {
    return this.aggregate(days);
  }
}

module.exports = new ConversionFunnel();
