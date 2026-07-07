const API_BASE = import.meta.env.VITE_API_URL || '/api';

class ApiClient {
  constructor() {
    this.token = localStorage.getItem('waves_token');
    this.refreshToken = localStorage.getItem('waves_refresh_token');
    this.getCache = new Map();
    this.inflightGets = new Map();
    this.getCacheTtlMs = 60 * 1000;
  }

  setTokens(token, refreshToken) {
    this.token = token;
    this.refreshToken = refreshToken;
    this.getCache.clear();
    this.inflightGets.clear();
    localStorage.setItem('waves_token', token);
    if (refreshToken) localStorage.setItem('waves_refresh_token', refreshToken);
  }

  clearTokens() {
    this.token = null;
    this.refreshToken = null;
    this.getCache.clear();
    this.inflightGets.clear();
    localStorage.removeItem('waves_token');
    localStorage.removeItem('waves_refresh_token');
  }

  async request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const method = (options.method || 'GET').toUpperCase();
    const canCacheGet = method === 'GET' && path.startsWith('/feed/');
    const cacheKey = canCacheGet ? `${this.token || 'anon'}:${path}` : null;

    if (canCacheGet) {
      const cached = this.getCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < this.getCacheTtlMs) return cached.data;
      const pending = this.inflightGets.get(cacheKey);
      if (pending) return pending;
    }

    const headers = {
      'Content-Type': 'application/json',
      ...(this.token && { Authorization: `Bearer ${this.token}` }),
      ...options.headers,
    };

    const execute = async () => {
      let response;
      try {
        response = await fetch(url, { ...options, headers });
      } catch (err) {
        throw new Error(err?.message || 'Network request failed. Check your connection and try again.');
      }

      // Handle token expiry — attempt refresh
      if (response.status === 401 && this.refreshToken) {
        const outcome = await this.attemptRefresh();
        if (outcome === 'refreshed') {
          headers.Authorization = `Bearer ${this.token}`;
          response = await fetch(url, { ...options, headers });
        } else if (outcome === 'rejected') {
          // The server refused the refresh token — the session is really
          // over. Force logout, preserving the return path so re-login
          // lands back on this page (mirrors ProtectedRoute).
          this.clearTokens();
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.href = next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
          const sessionErr = new Error('Session expired. Please sign in again.');
          sessionErr.status = 401;
          sessionErr.sessionExpired = true;
          throw sessionErr;
        } else {
          // Transient refresh failure (offline, 5xx, 429): the 30-day
          // refresh token may still be perfectly valid — keep the tokens
          // and surface a retryable error. Deliberately NOT status 401 /
          // sessionExpired, so useAuth's pending/retry path preserves the
          // session instead of treating it as an auth rejection.
          throw new Error('Unable to reach the server. Check your connection and try again.');
        }
      }

      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        let message = '';

        if (contentType.includes('application/json')) {
          const error = await response.json().catch(() => null);
          message = error?.error || error?.message || '';
        } else {
          message = (await response.text().catch(() => '')).trim();
        }

        const requestErr = new Error(message || `Request failed (${response.status})`);
        requestErr.status = response.status;
        throw requestErr;
      }

      const data = await response.json();
      if (canCacheGet) this.getCache.set(cacheKey, { data, ts: Date.now() });
      return data;
    };

    const requestPromise = execute().finally(() => {
      if (canCacheGet) this.inflightGets.delete(cacheKey);
    });
    if (canCacheGet) this.inflightGets.set(cacheKey, requestPromise);
    if (!canCacheGet) this.getCache.clear();
    return requestPromise;
  }

  attemptRefresh() {
    // Single-flight: a tab mount fires 10-15 authed calls, and after in-
    // session token expiry every one of them 401s and used to fire its own
    // POST /auth/refresh — a parallel storm that ate the refresh rate limit
    // (30/15min) and could turn a 429 into a spurious forced logout. All
    // concurrent 401s now share one in-flight refresh.
    if (!this.refreshPromise) {
      this.refreshPromise = this._doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  // Resolves to 'refreshed' | 'rejected' | 'transient'. Only 'rejected'
  // (the server explicitly refusing the refresh token) may destroy the
  // session — a network drop or /auth/refresh 5xx/429 says nothing about
  // whether the 30-day refresh token is still valid.
  async _doRefresh() {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (res.status === 401 || res.status === 403) return 'rejected';
      if (!res.ok) return 'transient';

      const data = await res.json();
      // Server now rotates refresh tokens — use the new one if provided.
      this.setTokens(data.token, data.refreshToken || this.refreshToken);
      return 'refreshed';
    } catch {
      return 'transient';
    }
  }

  // ---- Auth ----
  sendCode(phone) {
    return this.request('/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  }

  verifyCode(phone, code) {
    return this.request('/auth/verify-code', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
  }

  getMe() {
    return this.request('/auth/me');
  }

  getAuthProperties() {
    return this.request('/auth/properties');
  }

  selectAuthProperty(customerId) {
    return this.request('/auth/select-property', {
      method: 'POST',
      body: JSON.stringify({ customerId }),
    });
  }

  deleteAccount() {
    return this.request('/auth/account', { method: 'DELETE' });
  }

  // ---- Services ----
  getServices(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/services?${query}`);
  }

  getService(id) {
    return this.request(`/services/${id}`);
  }

  getServiceStats() {
    return this.request('/services/stats/summary');
  }

  // ---- Schedule ----
  getSchedule(days = 90) {
    return this.request(`/schedule?days=${days}`);
  }

  getNextService() {
    return this.request('/schedule/next');
  }

  confirmAppointment(id) {
    return this.request(`/schedule/${id}/confirm`, { method: 'POST' });
  }

  rescheduleAppointment(id, data) {
    return this.request(`/schedule/${id}/reschedule`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ---- Billing ----
  getPayments(limit = 20) {
    return this.request(`/billing?limit=${limit}`);
  }

  getBalance() {
    return this.request('/billing/balance');
  }

  getCards() {
    return this.request('/billing/cards');
  }

  addCard(cardNonce) {
    return this.request('/billing/cards', {
      method: 'POST',
      body: JSON.stringify({ cardNonce }),
    });
  }

  getProcessor() {
    return this.request('/billing/processor');
  }

  createSetupIntent(paymentMethodType = 'card') {
    return this.request('/billing/cards/setup-intent', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodType }),
    });
  }

  saveStripeCard(paymentMethodId, setupIntentId) {
    return this.request('/billing/cards', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodId, setupIntentId }),
    });
  }

  removeCard(cardId) {
    return this.request(`/billing/cards/${cardId}`, { method: 'DELETE' });
  }

  setDefaultCard(cardId) {
    return this.request(`/billing/cards/${cardId}/default`, { method: 'PUT' });
  }

  // ---- Autopay ----
  getAutopay() {
    return this.request('/billing/autopay');
  }

  updateAutopay(patch) {
    return this.request('/billing/autopay', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  pauseAutopay(until, reason) {
    return this.request('/billing/autopay/pause', {
      method: 'POST',
      body: JSON.stringify({ until, reason }),
    });
  }

  resumeAutopay() {
    return this.request('/billing/autopay/resume', { method: 'POST' });
  }

  // ---- Notifications ----
  getNotificationPrefs() {
    return this.request('/notifications/preferences');
  }

  updateNotificationPrefs(prefs) {
    return this.request('/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    });
  }

  getPropertyNotificationPrefs() {
    return this.request('/notifications/property-preferences');
  }

  updatePropertyNotificationPrefs(customerId, prefs) {
    return this.request(`/notifications/property-preferences/${customerId}`, {
      method: 'PUT',
      body: JSON.stringify(prefs),
    });
  }

  // ---- Requests ----
  createRequest(data) {
    return this.request('/requests', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  getRequests() {
    return this.request('/requests');
  }

  queryCustomerPricing(prompt, targetTier) {
    return this.request('/customer-pricing/query', {
      method: 'POST',
      body: JSON.stringify({ prompt, targetTier }),
    });
  }

  // ---- Lawn Health ----
  getLawnHealth(customerId) {
    return this.request(`/lawn-health/${customerId}`);
  }

  getLawnHealthHistory(customerId) {
    return this.request(`/lawn-health/${customerId}/history`);
  }

  getLawnHealthPhotos(customerId, assessmentId) {
    return this.request(`/lawn-health/${customerId}/photos/${assessmentId}`);
  }


  // ---- Feed / Weather ----
  getBlogPosts() {
    return this.request('/feed/blog');
  }

  getNewsletterPosts() {
    return this.request('/feed/newsletter');
  }

  getWeather() {
    return this.request('/feed/weather');
  }

  getAlerts() {
    return this.request('/feed/alerts');
  }

  getExpertPosts() {
    return this.request('/feed/experts');
  }

  getLocalNews() {
    return this.request('/feed/local');
  }

  getFaq() {
    return this.request('/feed/faq');
  }

  getMonthlyTip() {
    return this.request('/feed/monthly-tip');
  }

  // ---- Satisfaction ----
  getPendingSatisfaction() {
    return this.request('/satisfaction/pending');
  }

  submitSatisfaction(data) {
    return this.request('/satisfaction', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ---- Property Preferences ----
  getPropertyPreferences() {
    return this.request('/property/preferences');
  }

  updatePropertyPreferences(data) {
    return this.request('/property/preferences', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // ---- Service Preferences (interior spray / exterior sweep toggles) ----
  getServicePreferences() {
    return this.request('/service-preferences');
  }

  updateServicePreferences(data) {
    return this.request('/service-preferences', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // ---- Referrals ----
  getReferrals() {
    return this.request('/referrals');
  }

  getReferralStats() {
    return this.request('/referrals/stats');
  }

  submitReferral(data) {
    return this.request('/referrals', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ---- Promotions ----
  getRelevantPromotions() {
    return this.request('/promotions/relevant');
  }

  expressPromoInterest(promoId, data) {
    return this.request(`/promotions/${promoId}/interest`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  dismissPromotion(promoId) {
    return this.request(`/promotions/${promoId}/dismiss`, { method: 'POST' });
  }

  // ---- Documents ----
  getDocuments() {
    return this.request('/documents');
  }

  getServiceReportUrl(serviceRecordId) {
    return `${API_BASE}/documents/service-report/${serviceRecordId}`;
  }

  shareDocument(docId) {
    return this.request(`/documents/share/${docId}`, { method: 'POST' });
  }

  // ---- Badges ----
  getBadges() {
    return this.request('/badges');
  }

  notifyBadge(badgeType) {
    return this.request(`/badges/${badgeType}/notify`, { method: 'POST' });
  }

  // ---- Service Tracking ----
  getActiveTracker() {
    return this.request('/tracking/active');
  }

  getTodayTracker() {
    return this.request('/tracking/today');
  }

  // ---- Bouncie GPS ----
  getVehicles() {
    return this.request('/bouncie/vehicles');
  }

  getVehicleLocation(imei) {
    return this.request(`/bouncie/location${imei ? `?imei=${imei}` : ''}`);
  }

  // ---- Health ----
  healthCheck() {
    return this.request('/health');
  }
}

export const api = new ApiClient();
export default api;
