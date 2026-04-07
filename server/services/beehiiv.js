/**
 * Beehiiv API Service — manages newsletter subscribers, tags, and automations.
 *
 * Replaces 7 Zapier zaps that handled:
 *   - New recurring customer email (#3)
 *   - Cold lead email (#4)
 *   - Lawn care onboarding (#10)
 *   - New appointment email (#11)
 *   - Review thank-you email (#17)
 *   - Bed bug treatment email (#18)
 *   - Cockroach control email (#19)
 *
 * Env vars:
 *   BEEHIIV_API_KEY     — API key from beehiiv.com/settings/api
 *   BEEHIIV_PUB_ID      — Publication ID (pub_xxx)
 */

const logger = require('./logger');

const API_BASE = 'https://api.beehiiv.com/v2';
const PUB_ID = (process.env.BEEHIIV_PUB_ID || 'pub_dac693f8-2507-4213-9987-e9d6a2a90374').trim();

function getHeaders() {
  const key = process.env.BEEHIIV_API_KEY;
  if (!key) throw new Error('BEEHIIV_API_KEY not configured');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function apiCall(method, path, body) {
  const url = `${API_BASE}${path}`;
  const options = { method, headers: getHeaders() };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    logger.error(`[beehiiv] ${method} ${path} failed: ${res.status} ${text}`);
    throw new Error(`Beehiiv API ${res.status}: ${text}`);
  }
  // Some endpoints return 204 No Content
  if (res.status === 204) return {};
  return res.json();
}

const BeehiivService = {
  configured: !!process.env.BEEHIIV_API_KEY,

  /**
   * Create or find a subscriber by email.
   * If they exist, returns the existing subscriber.
   * If not, creates a new one.
   */
  async upsertSubscriber(email, { firstName, lastName, utmSource, utmMedium, customFields } = {}) {
    try {
      const body = {
        email,
        reactivate_existing: true,
        send_welcome_email: false,
        utm_source: utmSource || 'waves_portal',
        utm_medium: utmMedium || 'automation',
      };
      if (customFields) body.custom_fields = customFields;

      const data = await apiCall('POST', `/publications/${PUB_ID}/subscriptions`, body);
      logger.info(`[beehiiv] Upserted subscriber: ${email} (id: ${data.data?.id})`);
      return data.data;
    } catch (err) {
      // If subscriber already exists, try to find them
      if (err.message.includes('409') || err.message.includes('already')) {
        return this.findSubscriber(email);
      }
      throw err;
    }
  },

  /**
   * Find a subscriber by email.
   */
  async findSubscriber(email) {
    const data = await apiCall('GET', `/publications/${PUB_ID}/subscriptions?email=${encodeURIComponent(email)}`);
    const sub = data.data?.[0];
    if (!sub) {
      logger.warn(`[beehiiv] Subscriber not found: ${email}`);
      return null;
    }
    return sub;
  },

  /**
   * Get subscriber by ID.
   */
  async getSubscriber(subscriptionId) {
    const data = await apiCall('GET', `/publications/${PUB_ID}/subscriptions/${subscriptionId}`);
    return data.data;
  },

  /**
   * Add tags to a subscriber.
   */
  async addTags(subscriptionId, tags) {
    if (!subscriptionId || !tags?.length) return;
    await apiCall('POST', `/publications/${PUB_ID}/subscriptions/${subscriptionId}/tags`, { tags });
    logger.info(`[beehiiv] Added tags [${tags.join(', ')}] to subscriber ${subscriptionId}`);
  },

  /**
   * Remove tags from a subscriber.
   */
  async removeTags(subscriptionId, tags) {
    if (!subscriptionId || !tags?.length) return;
    await apiCall('DELETE', `/publications/${PUB_ID}/subscriptions/${subscriptionId}/tags`, { tags });
  },

  /**
   * Enroll a subscriber in a Beehiiv automation.
   */
  async enrollInAutomation(automationId, { email, subscriptionId }) {
    if (!automationId) throw new Error('automationId required');
    const body = {};
    if (subscriptionId) body.subscription_id = subscriptionId;
    if (email) body.email = email;

    await apiCall('POST', `/publications/${PUB_ID}/automations/${automationId}/subscriptions`, body);
    logger.info(`[beehiiv] Enrolled ${email || subscriptionId} in automation ${automationId}`);
  },

  /**
   * List all automations for the publication.
   */
  async listAutomations() {
    const data = await apiCall('GET', `/publications/${PUB_ID}/automations`);
    return data.data || [];
  },

  /**
   * List all subscribers (paginated).
   */
  async listSubscribers({ page = 1, limit = 50, status = 'active' } = {}) {
    const data = await apiCall('GET', `/publications/${PUB_ID}/subscriptions?status=${status}&page=${page}&limit=${limit}`);
    return { subscribers: data.data || [], total: data.total_results || 0 };
  },
};

module.exports = BeehiivService;
