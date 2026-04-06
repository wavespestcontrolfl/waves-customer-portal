/**
 * Google Analytics 4 (GA4) Data API Service
 *
 * Fetches website analytics data using the GA4 Data API.
 * Requires a Google service account with Viewer access in GA4.
 *
 * ENV:
 *   GA4_PROPERTY_ID — the GA4 property ID (numeric, e.g. "123456789")
 *   GOOGLE_SERVICE_ACCOUNT_JSON — JSON string of service account credentials
 */

const logger = require('../logger');

let BetaAnalyticsDataClient;
try {
  BetaAnalyticsDataClient = require('@google-analytics/data').BetaAnalyticsDataClient;
} catch {
  BetaAnalyticsDataClient = null;
}

class GA4Service {
  constructor() {
    this.client = null;
    this.propertyId = process.env.GA4_PROPERTY_ID || null;
    this._initAttempted = false;
  }

  /**
   * Lazily initialize the GA4 client.
   * Returns true if ready, false if not configured.
   */
  init() {
    if (this.client) return true;
    if (this._initAttempted) return false;
    this._initAttempted = true;

    if (!BetaAnalyticsDataClient) {
      logger.warn('@google-analytics/data not installed — GA4 disabled');
      return false;
    }

    if (!this.propertyId) {
      logger.warn('GA4_PROPERTY_ID not set — GA4 disabled');
      return false;
    }

    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!saJson) {
      logger.warn('GOOGLE_SERVICE_ACCOUNT_JSON not set — GA4 disabled');
      return false;
    }

    try {
      const credentials = JSON.parse(saJson);
      this.client = new BetaAnalyticsDataClient({
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key,
        },
        projectId: credentials.project_id,
      });
      logger.info(`GA4 service initialized for property ${this.propertyId}`);
      return true;
    } catch (err) {
      logger.error(`GA4 init failed: ${err.message}`);
      return false;
    }
  }

  /** Helper: format property string for API calls */
  get property() {
    return `properties/${this.propertyId}`;
  }

  /** Helper: build a date range starting `days` ago through yesterday */
  _dateRange(days) {
    return [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];
  }

  /**
   * Site overview — sessions, users, newUsers, bounceRate, avgSessionDuration, pageviewsPerSession
   */
  async getOverview(days = 30) {
    if (!this.init()) return { configured: false, data: null };

    try {
      const [response] = await this.client.runReport({
        property: this.property,
        dateRanges: this._dateRange(days),
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'newUsers' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'screenPageViewsPerSession' },
        ],
      });

      const row = response.rows && response.rows[0];
      if (!row) return { configured: true, data: null };

      const vals = row.metricValues;
      return {
        configured: true,
        data: {
          sessions: parseInt(vals[0].value),
          users: parseInt(vals[1].value),
          newUsers: parseInt(vals[2].value),
          bounceRate: parseFloat(vals[3].value),
          avgSessionDuration: parseFloat(vals[4].value),
          pageviewsPerSession: parseFloat(vals[5].value),
          period: { days },
        },
      };
    } catch (err) {
      logger.error(`GA4 getOverview failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Traffic sources — sessions grouped by sessionSource / sessionMedium
   */
  async getTrafficSources(days = 30) {
    if (!this.init()) return { configured: false, data: null };

    try {
      const [response] = await this.client.runReport({
        property: this.property,
        dateRanges: this._dateRange(days),
        dimensions: [
          { name: 'sessionSource' },
          { name: 'sessionMedium' },
        ],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 50,
      });

      const rows = (response.rows || []).map(row => ({
        source: row.dimensionValues[0].value,
        medium: row.dimensionValues[1].value,
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value),
        bounceRate: parseFloat(row.metricValues[2].value),
        avgSessionDuration: parseFloat(row.metricValues[3].value),
      }));

      return { configured: true, data: rows, period: { days } };
    } catch (err) {
      logger.error(`GA4 getTrafficSources failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Top landing pages by sessions, with bounce rate and avg duration
   */
  async getTopPages(days = 30, limit = 20) {
    if (!this.init()) return { configured: false, data: null };

    try {
      const [response] = await this.client.runReport({
        property: this.property,
        dateRanges: this._dateRange(days),
        dimensions: [{ name: 'landingPagePlusQueryString' }],
        metrics: [
          { name: 'sessions' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'totalUsers' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit,
      });

      const rows = (response.rows || []).map(row => ({
        page: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value),
        bounceRate: parseFloat(row.metricValues[1].value),
        avgSessionDuration: parseFloat(row.metricValues[2].value),
        users: parseInt(row.metricValues[3].value),
      }));

      return { configured: true, data: rows, period: { days } };
    } catch (err) {
      logger.error(`GA4 getTopPages failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Conversions — event counts for key conversion events
   */
  async getConversions(days = 30) {
    if (!this.init()) return { configured: false, data: null };

    try {
      const [response] = await this.client.runReport({
        property: this.property,
        dateRanges: this._dateRange(days),
        dimensions: [{ name: 'eventName' }],
        metrics: [
          { name: 'eventCount' },
          { name: 'totalUsers' },
        ],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            inListFilter: {
              values: [
                'form_submit',
                'phone_click',
                'generate_lead',
                'purchase',
                'sign_up',
                'contact_form',
                'request_quote',
                'schedule_service',
                'click_to_call',
                'begin_checkout',
              ],
            },
          },
        },
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      });

      const rows = (response.rows || []).map(row => ({
        event: row.dimensionValues[0].value,
        count: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value),
      }));

      return { configured: true, data: rows, period: { days } };
    } catch (err) {
      logger.error(`GA4 getConversions failed: ${err.message}`);
      throw err;
    }
  }
}

module.exports = new GA4Service();
