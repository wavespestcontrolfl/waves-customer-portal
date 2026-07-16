const API_BASE = import.meta.env.VITE_API_URL || '/api';
const REFRESH_LOCK_NAME = 'waves-customer-refresh';
const REFRESH_LEASE_KEY = 'waves_refresh_lease';
const REFRESH_LEASE_MS = 15 * 1000;
const REFRESH_ACQUIRE_MS = 12 * 1000;

function tokenSessionIdentity(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    if (!payload?.customerId) return null;
    return {
      customerId: String(payload.customerId),
      sessionId: payload.sessionId == null ? null : String(payload.sessionId),
    };
  } catch {
    return null;
  }
}

function sameRequestSession(left, right) {
  return Boolean(left && right
    && left.customerId === right.customerId
    && left.sessionId === right.sessionId);
}

export class ApiClient {
  constructor() {
    this.token = localStorage.getItem('waves_token');
    this.refreshToken = localStorage.getItem('waves_refresh_token');
    this.tokenGeneration = 0;
    this.getCache = new Map();
    this.inflightGets = new Map();
    this.getCacheTtlMs = 60 * 1000;
  }

  setTokens(token, refreshToken) {
    this.tokenGeneration += 1;
    this.token = token;
    this.refreshToken = refreshToken;
    this.getCache.clear();
    this.inflightGets.clear();
    // Storage events fire once per key. Publish the refresh credential first
    // so another tab reacting to the access-token event can never pair the new
    // access token with the already-consumed refresh token.
    if (refreshToken) localStorage.setItem('waves_refresh_token', refreshToken);
    else localStorage.removeItem('waves_refresh_token');
    localStorage.setItem('waves_token', token);
  }

  clearTokens() {
    this.tokenGeneration += 1;
    this.token = null;
    this.refreshToken = null;
    this.getCache.clear();
    this.inflightGets.clear();
    localStorage.removeItem('waves_token');
    localStorage.removeItem('waves_refresh_token');
  }

  adoptTokens(token, refreshToken) {
    this.tokenGeneration += 1;
    this.token = token || null;
    this.refreshToken = refreshToken || null;
    this.getCache.clear();
    this.inflightGets.clear();
  }

  async request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const method = (options.method || 'GET').toUpperCase();
    const canCacheGet = method === 'GET' && path.startsWith('/feed/');
    const cacheKey = canCacheGet ? `${this.token || 'anon'}:${path}` : null;
    const requestSession = tokenSessionIdentity(this.token);

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
    const fetchOptions = () => {
      const { bodyFactory, ...requestOptions } = options;
      return {
        ...requestOptions,
        ...(typeof bodyFactory === 'function' ? { body: bodyFactory() } : {}),
        headers,
      };
    };

    const execute = async () => {
      let response;
      try {
        response = await fetch(url, fetchOptions());
      } catch (err) {
        throw new Error(err?.message || 'Network request failed. Check your connection and try again.');
      }

      // Handle token expiry — attempt refresh
      if (response.status === 401 && this.refreshToken) {
        const outcome = await this.attemptRefresh();
        if (outcome === 'refreshed') {
          // A different property or login can replace tokens while this
          // request is waiting on refresh. Retrying the old body under that
          // newer identity is a cross-customer write. Routine rotations keep
          // both customerId and sessionId, so only the safe case retries.
          if (!sameRequestSession(requestSession, tokenSessionIdentity(this.token))) {
            const superseded = new Error('Request canceled because the active account changed.');
            superseded.requestSuperseded = true;
            throw superseded;
          }
          headers.Authorization = `Bearer ${this.token}`;
          response = await fetch(url, fetchOptions());
        } else if (outcome === 'rejected') {
          // The server refused the refresh token — the session is really
          // over. Force logout, preserving the return path so re-login
          // lands back on this page (mirrors ProtectedRoute).
          this.clearTokens();
          // Never carry /login itself as the return target — LoginPage
          // honors `next` after verification, and bouncing back to /login
          // (which renders null once authenticated) strands the customer
          // on a blank page.
          const path = window.location.pathname;
          const next = path.startsWith('/login') ? '' : `${path}${window.location.search}`;
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
      const submittedRefreshToken = this.refreshToken;
      this.refreshPromise = this._coordinateRefresh(submittedRefreshToken).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  _adoptPublishedRotation(previousRefreshToken) {
    try {
      const storedRefresh = localStorage.getItem('waves_refresh_token');
      const storedAccess = localStorage.getItem('waves_token');
      if (!storedRefresh || !storedAccess || storedRefresh === previousRefreshToken) return false;
      this.adoptTokens(storedAccess, storedRefresh);
      return true;
    } catch {
      return false;
    }
  }

  async _waitForPublishedRotation(previousRefreshToken, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._adoptPublishedRotation(previousRefreshToken)) return 'refreshed';
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    return this._adoptPublishedRotation(previousRefreshToken) ? 'refreshed' : 'transient';
  }

  async _coordinateRefresh(previousRefreshToken) {
    const refreshUnderLock = async () => {
      if (this._adoptPublishedRotation(previousRefreshToken)) return 'refreshed';
      return this._doRefresh();
    };

    // Web Locks is a browser-wide mutex for this origin. The second tab waits,
    // then adopts the winner's refresh-first localStorage publication instead
    // of submitting the consumed credential and triggering replay defense.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      try {
        return await navigator.locks.request(REFRESH_LOCK_NAME, { mode: 'exclusive' }, refreshUnderLock);
      } catch {
        // Older embedded webviews can expose a partial/broken Locks API. The
        // storage lease below keeps them coordinated too.
      }
    }

    return this._withStorageRefreshLease(previousRefreshToken, refreshUnderLock);
  }

  async _withStorageRefreshLease(previousRefreshToken, refreshUnderLock) {
    let storageAvailable = true;
    const owner = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + REFRESH_ACQUIRE_MS;

    while (Date.now() < deadline) {
      if (this._adoptPublishedRotation(previousRefreshToken)) return 'refreshed';
      try {
        const now = Date.now();
        let lease = null;
        try { lease = JSON.parse(localStorage.getItem(REFRESH_LEASE_KEY) || 'null'); } catch { lease = null; }
        if (!lease?.owner || Number(lease.expiresAt) <= now) {
          localStorage.setItem(REFRESH_LEASE_KEY, JSON.stringify({ owner, expiresAt: now + REFRESH_LEASE_MS }));
          // Confirm after a short contention window. If another tab wrote a
          // competing claim, only the final owner proceeds.
          await new Promise((resolve) => { setTimeout(resolve, 40 + Math.floor(Math.random() * 30)); });
          let confirmed = null;
          try { confirmed = JSON.parse(localStorage.getItem(REFRESH_LEASE_KEY) || 'null'); } catch { confirmed = null; }
          if (confirmed?.owner === owner) {
            try {
              return await refreshUnderLock();
            } finally {
              try {
                const latest = JSON.parse(localStorage.getItem(REFRESH_LEASE_KEY) || 'null');
                if (latest?.owner === owner) localStorage.removeItem(REFRESH_LEASE_KEY);
              } catch { /* lease expiry recovers it */ }
            }
          }
        }
      } catch {
        storageAvailable = false;
        break;
      }
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }

    // If storage itself is unavailable, there is no shared persisted token to
    // coordinate across tabs. Otherwise fail transiently rather than ever
    // double-submit a credential behind a live lease.
    return storageAvailable ? 'transient' : this._doRefresh();
  }

  // Resolves to 'refreshed' | 'rejected' | 'transient'. Only 'rejected'
  // (the server explicitly refusing the refresh token) may destroy the
  // session — a network drop or /auth/refresh 5xx/429 says nothing about
  // whether the 30-day refresh token is still valid.
  async _doRefresh() {
    const submittedRefreshToken = this.refreshToken;
    const submittedGeneration = this.tokenGeneration;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: submittedRefreshToken }),
      });

      // Logout, property switching, another tab's rotation, or a new login may
      // have changed credentials while this request was in flight. Never let
      // the stale response repopulate cleared storage or overwrite a newer
      // session.
      if (this.tokenGeneration !== submittedGeneration
        || this.refreshToken !== submittedRefreshToken) {
        return this.token && this.refreshToken ? 'refreshed' : 'rejected';
      }

      if (res.status === 409) {
        const conflict = await res.json().catch(() => null);
        if (conflict?.code === 'REFRESH_TOKEN_ALREADY_ROTATED') {
          return this._waitForPublishedRotation(submittedRefreshToken);
        }
      }
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
      // Rebuild on a 401 retry: attemptRefresh rotates the credential before
      // retrying, so replaying a pre-serialized old token would revoke the
      // whole family under the server's reuse detection.
      bodyFactory: () => JSON.stringify({ customerId, refreshToken: this.refreshToken }),
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
  getPayments(limit = 50, cursor = 0) {
    return this.request(`/billing?limit=${limit}&cursor=${cursor}`);
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

  // Portal ACH: rebuild the hosted micro-deposit verification link for a
  // pending bank row (also heals stale pending/failed states server-side).
  getBankVerificationLink(cardId) {
    return this.request(`/billing/cards/${cardId}/bank-verification-link`);
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

  getStationMap() {
    return this.request('/property/station-map');
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

  sendReferralEmailInvite(data) {
    return this.request('/referrals/invite-email', {
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
