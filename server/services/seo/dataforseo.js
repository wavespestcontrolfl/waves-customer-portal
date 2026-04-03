/**
 * DataForSEO REST API Client
 * Auth: Basic auth with login:password
 * Base URL: https://api.dataforseo.com/v3
 * Rate limiting: 2000 tasks/minute
 * Gated behind GATE_SEO_INTELLIGENCE
 */

const logger = require('../logger');

const BASE_URL = 'https://api.dataforseo.com/v3';

class DataForSEO {
  constructor() {
    this.login = process.env.DATAFORSEO_LOGIN;
    this.password = process.env.DATAFORSEO_PASSWORD;
  }

  get configured() {
    return !!(this.login && this.password);
  }

  get authHeader() {
    return 'Basic ' + Buffer.from(`${this.login}:${this.password}`).toString('base64');
  }

  async request(endpoint, body, retries = 3) {
    const { isEnabled } = require('../../config/feature-gates');
    if (!isEnabled('seoIntelligence')) {
      logger.info(`[GATE BLOCKED] DataForSEO: ${endpoint}`);
      return null;
    }

    if (!this.configured) {
      logger.warn('[dataforseo] DATAFORSEO_LOGIN/PASSWORD not set');
      return null;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${BASE_URL}${endpoint}`, {
          method: 'POST',
          headers: {
            'Authorization': this.authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
          logger.warn(`[dataforseo] Rate limited, retrying in ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        if (!res.ok) {
          logger.error(`[dataforseo] ${res.status}: ${res.statusText}`);
          return null;
        }

        const data = await res.json();

        if (data.tasks?.[0]?.result) {
          const cost = data.tasks[0].cost || 0;
          if (cost > 0) logger.info(`[dataforseo] ${endpoint} cost: $${cost}`);
        }

        return data;
      } catch (err) {
        if (attempt === retries) {
          logger.error(`[dataforseo] Failed after ${retries} attempts: ${err.message}`);
          return null;
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    return null;
  }

  // SERP — organic results
  async serpOrganic(keyword, location = 'Bradenton,Florida,United States') {
    return this.request('/serp/google/organic/live/advanced', [{
      keyword,
      location_name: location,
      language_name: 'English',
      device: 'mobile',
      os: 'iOS',
    }]);
  }

  // SERP — Map Pack
  async serpMaps(keyword, location = 'Bradenton,Florida,United States') {
    return this.request('/serp/google/maps/live/advanced', [{
      keyword,
      location_name: location,
      language_name: 'English',
    }]);
  }

  // Backlinks for domain
  async getBacklinks(target, limit = 1000) {
    return this.request('/backlinks/backlinks/live', [{
      target,
      limit,
      order_by: ['rank.desc'],
      filters: ['dofollow', '=', true],
    }]);
  }

  // Keyword search volume
  async searchVolume(keywords) {
    return this.request('/keywords_data/google_ads/search_volume/live', [{
      keywords,
      location_code: 1015116, // Sarasota-Bradenton-North Port DMA
      language_code: 'en',
    }]);
  }

  // On-page audit
  async onPageAudit(url) {
    return this.request('/on_page/instant_pages', [{
      url,
      enable_javascript: true,
    }]);
  }
}

module.exports = new DataForSEO();
