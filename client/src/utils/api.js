const API_BASE = import.meta.env.VITE_API_URL || '/api';

class ApiClient {
  constructor() {
    this.token = localStorage.getItem('waves_token');
    this.refreshToken = localStorage.getItem('waves_refresh_token');
  }

  setTokens(token, refreshToken) {
    this.token = token;
    this.refreshToken = refreshToken;
    localStorage.setItem('waves_token', token);
    if (refreshToken) localStorage.setItem('waves_refresh_token', refreshToken);
  }

  clearTokens() {
    this.token = null;
    this.refreshToken = null;
    localStorage.removeItem('waves_token');
    localStorage.removeItem('waves_refresh_token');
  }

  async request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this.token && { Authorization: `Bearer ${this.token}` }),
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    // Handle token expiry — attempt refresh
    if (response.status === 401 && this.refreshToken) {
      const refreshed = await this.attemptRefresh();
      if (refreshed) {
        headers.Authorization = `Bearer ${this.token}`;
        return fetch(url, { ...options, headers });
      }
      // Refresh failed — force logout
      this.clearTokens();
      window.location.href = '/login';
      return;
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async attemptRefresh() {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json();
      this.setTokens(data.token, this.refreshToken);
      return true;
    } catch {
      return false;
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

  saveStripeCard(paymentMethodId) {
    return this.request('/billing/cards', {
      method: 'POST',
      body: JSON.stringify({ paymentMethodId }),
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

  advanceTrackerDemo() {
    return this.request('/tracking/demo/advance', { method: 'POST' });
  }

  addTrackerNote(trackerId, note) {
    return this.request(`/tracking/${trackerId}/note`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
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
