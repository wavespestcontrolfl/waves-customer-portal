const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

class ContentDecayDetector {
  async detect() {
    logger.info('Content decay detection running...');
    const now = new Date();
    const d30 = etDateString(addETDays(now, -30));
    const d60 = etDateString(addETDays(now, -60));

    // Get pages with data in both periods
    const current = await db('gsc_pages')
      .where('date', '>=', d30)
      .select('page_url')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page_url');

    const previous = await db('gsc_pages')
      .where('date', '>=', d60)
      .where('date', '<', d30)
      .select('page_url')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page_url');

    const prevMap = {};
    previous.forEach(p => { prevMap[p.page_url] = p; });

    let alerts = 0;
    for (const cur of current) {
      const prev = prevMap[cur.page_url];
      if (!prev) continue;

      const curClicks = parseInt(cur.clicks);
      const prevClicks = parseInt(prev.clicks);
      const curImpr = parseInt(cur.impressions);
      const prevImpr = parseInt(prev.impressions);

      if (prevClicks < 5) continue; // Ignore low-traffic pages

      const clickChange = prevClicks > 0 ? ((curClicks - prevClicks) / prevClicks * 100) : 0;
      const imprChange = prevImpr > 0 ? ((curImpr - prevImpr) / prevImpr * 100) : 0;

      // Flag if >20% drop in clicks or impressions
      if (clickChange < -20) {
        const existing = await db('seo_content_decay_alerts')
          .where('url', cur.page_url).where('status', 'open').where('alert_type', 'traffic_drop').first();
        if (!existing) {
          // Try to link to blog_posts
          const slug = cur.page_url.replace(/https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '');
          const blogPost = await db('blog_posts').where('slug', slug).first();

          await db('seo_content_decay_alerts').insert({
            url: cur.page_url,
            blog_post_id: blogPost?.id || null,
            alert_type: 'traffic_drop',
            metric_name: 'organic_clicks',
            previous_value: prevClicks,
            current_value: curClicks,
            change_pct: Math.round(clickChange),
            period: '30d',
          });
          alerts++;
        }
      }

      if (imprChange < -30) {
        const existing = await db('seo_content_decay_alerts')
          .where('url', cur.page_url).where('status', 'open').where('alert_type', 'impression_drop').first();
        if (!existing) {
          await db('seo_content_decay_alerts').insert({
            url: cur.page_url,
            alert_type: 'impression_drop',
            metric_name: 'impressions',
            previous_value: prevImpr,
            current_value: curImpr,
            change_pct: Math.round(imprChange),
            period: '30d',
          });
          alerts++;
        }
      }
    }

    logger.info(`Content decay: ${alerts} new alerts`);
    return { alerts };
  }

  async getDashboard() {
    const alerts = await db('seo_content_decay_alerts').orderBy('created_at', 'desc');
    return {
      total: alerts.length,
      open: alerts.filter(a => a.status === 'open').length,
      alerts: alerts.slice(0, 30),
    };
  }
}

module.exports = new ContentDecayDetector();
