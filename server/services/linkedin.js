/**
 * LinkedIn (Community Management API) service — single owned company page.
 *
 * Mirrors the Google Business Profile OAuth pattern (server/services/google-business.js)
 * but for ONE organization (Waves' own page), and with hand-rolled OAuth + REST
 * (LinkedIn has no Node SDK we use): authorization-code exchange, token refresh,
 * tokens persisted in `system_settings` (key `linkedin.oauth_tokens`), and a
 * Posts-API publish path used by social-media.js postToLinkedIn.
 *
 * ── VERIFY AGAINST CURRENT LINKEDIN DOCS before go-live (these churn, and were
 *    not web-verifiable when written; all are env-overridable) ───────────────
 *   - LINKEDIN_API_VERSION (the `LinkedIn-Version: YYYYMM` header the Posts API
 *     requires) — set to a CURRENT month LinkedIn supports.
 *   - LINKEDIN_SCOPES — company-page posting needs `w_organization_social`
 *     (+ `r_organization_social` to read/verify). NOT `w_member_social` (that's
 *     personal-profile posting).
 *   - Posts API body shape (`/rest/posts`) — `author`, `commentary`, `visibility`,
 *     `distribution`, `lifecycleState`. Image posts need the separate Images API
 *     (register-upload → asset URN); deferred — text + article-link only for now.
 *   - Refresh tokens are only issued to LinkedIn-approved apps. If none is
 *     returned, access tokens last ~60 days and the admin must re-authorize.
 *
 * Env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_COMPANY_ID (org URN
 *      numeric id), LINKEDIN_REDIRECT_URI (defaults to the portal callback).
 */

const logger = require('./logger');
const db = require('../models/db');
const { publicPortalUrl } = require('../utils/portal-url');

const TOKEN_KEY = 'linkedin.oauth_tokens';
const AUTH_BASE = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const POSTS_URL = 'https://api.linkedin.com/rest/posts';
const ORG_ACLS_URL = 'https://api.linkedin.com/rest/organizationAcls';

// LinkedIn-API specifics — confirmed against Microsoft Learn Posts API docs
// (defaultMoniker li-lms-2026-06) on 2026-06. LinkedIn sunsets monthly versions,
// so bump LINKEDIN_API_VERSION when the current one is deprecated. Scopes per the
// docs' Permissions table: w_organization_social (post) + r_organization_social
// (read/verify); both require an ADMINISTRATOR/CONTENT_ADMIN page role.
// NOTE: verifyOrgAccess() hits /organizationAcls, which needs an org-admin READ
// scope (e.g. rw_organization_admin) that we deliberately DON'T request by default
// — it broadens the consent screen and many apps aren't approved for it. Without
// it the ACL call 403s and _recordOrgVerification() records null (verification
// skipped, never a false "unverified"). To enable the company-admin check, add the
// admin scope to LINKEDIN_SCOPES once the LinkedIn app is approved for it.
const API_VERSION = process.env.LINKEDIN_API_VERSION || '202606';
const SCOPES = (process.env.LINKEDIN_SCOPES || 'w_organization_social r_organization_social')
  .split(/[\s,]+/).filter(Boolean);
const ACCESS_TOKEN_SKEW_MS = 5 * 60 * 1000; // refresh a bit before actual expiry

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

class LinkedInService {
  constructor() {
    this.clientId = process.env.LINKEDIN_CLIENT_ID || null;
    this.clientSecret = process.env.LINKEDIN_CLIENT_SECRET || null;
    this.companyId = process.env.LINKEDIN_COMPANY_ID || null; // org URN numeric id
    this.configured = !!(this.clientId && this.clientSecret);

    // LinkedIn requires an EXACT redirect_uri match against the app registration,
    // which uses the canonical portal host. Derive it from publicPortalUrl()
    // (PUBLIC_PORTAL_URL / PORTAL_URL / CLIENT_URL / PORTAL_DOMAIN → portal default),
    // NOT RAILWAY_PUBLIC_DOMAIN — that resolves to the generated *.up.railway.app
    // host and would break the exact-match. Override with LINKEDIN_REDIRECT_URI.
    this.redirectUri =
      process.env.LINKEDIN_REDIRECT_URI ||
      `${publicPortalUrl()}/api/admin/settings/linkedin/callback`;

    if (!this.configured) {
      logger.warn('[linkedin] No LINKEDIN_CLIENT_ID/SECRET — LinkedIn integration disabled');
    }
  }

  // ── OAuth: authorization URL ──────────────────────────────────────────────
  getAuthUrl(state) {
    if (!this.clientId) throw new Error('LINKEDIN_CLIENT_ID not configured');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state: String(state || ''),
      scope: SCOPES.join(' '),
    });
    return `${AUTH_BASE}?${params.toString()}`;
  }

  // ── Token storage (system_settings, mirrors GBP storeTokens) ──────────────
  async _getStoredTokens() {
    try {
      const row = await db('system_settings').where({ key: TOKEN_KEY }).first();
      return parseJsonObject(row?.value);
    } catch (err) {
      logger.warn(`[linkedin] Stored token lookup failed: ${err.message}`);
      return {};
    }
  }

  async storeTokens(tokens = {}, options = {}) {
    const existing = options.merge ? await this._getStoredTokens() : {};
    const accessToken = tokens.access_token || existing.access_token || null;
    if (!accessToken) {
      throw new Error('LinkedIn did not return an access token. Re-run authorization.');
    }
    const now = Date.now();
    const record = {
      access_token: accessToken,
      refresh_token: tokens.refresh_token || existing.refresh_token || null,
      token_expires_at: tokens.expires_in
        ? new Date(now + Number(tokens.expires_in) * 1000).toISOString()
        : existing.token_expires_at || null,
      refresh_token_expires_at: tokens.refresh_token_expires_in
        ? new Date(now + Number(tokens.refresh_token_expires_in) * 1000).toISOString()
        : existing.refresh_token_expires_at || null,
      scope: tokens.scope || existing.scope || SCOPES.join(' '),
      updated_at: new Date().toISOString(),
    };

    const ts = new Date();
    await db('system_settings')
      .insert({
        key: TOKEN_KEY,
        value: JSON.stringify(record),
        category: 'integrations',
        description: 'LinkedIn OAuth tokens for the company page',
        created_at: ts,
        updated_at: ts,
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(record),
        category: 'integrations',
        description: 'LinkedIn OAuth tokens for the company page',
        updated_at: ts,
      });

    this.configured = true;
    return {
      connected: true,
      tokenExpiresAt: record.token_expires_at,
      hasRefreshToken: !!record.refresh_token,
    };
  }

  // ── OAuth: authorization-code → tokens ────────────────────────────────────
  async handleCallback(code) {
    if (!code) throw new Error('Missing authorization code');
    if (!this.clientId || !this.clientSecret) throw new Error('LinkedIn client credentials not configured');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`LinkedIn token exchange ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const tokens = await res.json();
    const result = await this.storeTokens(tokens, { merge: true });
    // Soft-verify the authorizing account actually administers LINKEDIN_COMPANY_ID.
    // Never block the connection on it (the org-ACL response shape isn't doc-verified
    // here, and a transient failure shouldn't strand a valid token) — record the
    // outcome so getStatus / the UI can warn instead of silently 403-ing at post time.
    await this._recordOrgVerification();
    return result;
  }

  // Best-effort: confirm the connected account admins the configured company id.
  // Persists `org_verified` (true/false/null) into the stored token record and
  // logs a warning on a mismatch. Returns the boolean (or null when unknown).
  async _recordOrgVerification() {
    if (!this.companyId) return null;
    try {
      const { adminedOrganizations } = await this.verifyOrgAccess();
      const target = String(this.companyId);
      const verified = (adminedOrganizations || []).some((o) => String(o).includes(target));
      const existing = await this._getStoredTokens();
      await db('system_settings')
        .where({ key: TOKEN_KEY })
        .update({ value: JSON.stringify({ ...existing, org_verified: verified }), updated_at: new Date() });
      if (!verified) {
        logger.warn(`[linkedin] Authorized account does not administer org ${target} — company-page posts will 403 until reconnected with the right page admin.`);
      }
      return verified;
    } catch (err) {
      logger.warn(`[linkedin] Org verification skipped: ${err.message}`);
      return null;
    }
  }

  // ── Valid access token (refresh when possible) ────────────────────────────
  async _getValidAccessToken() {
    const stored = await this._getStoredTokens();
    if (!stored.access_token) throw new Error('LinkedIn not connected — authorize first.');

    const expMs = stored.token_expires_at ? new Date(stored.token_expires_at).getTime() : 0;
    const stillValid = expMs && expMs - Date.now() > ACCESS_TOKEN_SKEW_MS;
    if (stillValid) return stored.access_token;

    // Try refresh (only works for LinkedIn-approved apps that were issued a
    // refresh token). On any failure, fall back to the stored token — an
    // expired one yields a 401 at post time, surfacing "re-authorize".
    if (stored.refresh_token && this.clientId && this.clientSecret) {
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: stored.refresh_token,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        });
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (res.ok) {
          await this.storeTokens(await res.json(), { merge: true });
          return (await this._getStoredTokens()).access_token;
        }
        logger.warn(`[linkedin] token refresh failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      } catch (err) {
        logger.warn(`[linkedin] token refresh error: ${err.message}`);
      }
    }
    return stored.access_token;
  }

  // ── Connection status (for the admin Integrations UI) ─────────────────────
  async getStatus() {
    const stored = await this._getStoredTokens();
    return {
      configured: this.configured,
      connected: !!stored.access_token,
      companyId: this.companyId,
      tokenExpiresAt: stored.token_expires_at || null,
      refreshTokenExpiresAt: stored.refresh_token_expires_at || null,
      hasRefreshToken: !!stored.refresh_token,
      scope: stored.scope || null,
      orgVerified: typeof stored.org_verified === 'boolean' ? stored.org_verified : null,
    };
  }

  // ── Confirm the org URN id + admin access (organizationAcls) ──────────────
  // Use this to verify LINKEDIN_COMPANY_ID is the right org and that the
  // authorizing user administers it. Returns the list of admined org URNs.
  async verifyOrgAccess() {
    const token = await this._getValidAccessToken();
    const url = `${ORG_ACLS_URL}?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'LinkedIn-Version': API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });
    if (!res.ok) throw new Error(`LinkedIn organizationAcls ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const orgs = (data.elements || [])
      .map((e) => e.organization || e['organization~']?.id || null)
      .filter(Boolean);
    return { adminedOrganizations: orgs, raw: data.elements || [] };
  }

  // ── Publish a post to the company page (Posts API) ────────────────────────
  // Image/thumbnail upload is deferred (needs the Images API → image URN); text +
  // optional article link only. LinkedIn does NOT scrape article URLs, so we must
  // set title/description on the article ourselves (per the Posts API docs).
  async createPost({ text, link, title, description } = {}) {
    if (!this.companyId) throw new Error('LINKEDIN_COMPANY_ID not configured');
    const commentary = String(text || '').trim();
    if (!commentary) throw new Error('LinkedIn post requires text');

    const token = await this._getValidAccessToken();
    const body = {
      author: `urn:li:organization:${this.companyId}`,
      commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (link) {
      const article = { source: link, title: String(title || '').slice(0, 200) || link };
      const desc = String(description || '').trim();
      if (desc) article.description = desc.slice(0, 300);
      body.content = { article };
    }

    const res = await fetch(POSTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`LinkedIn Posts API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const postId = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || null;
    logger.info(`[linkedin] company post created: ${postId}`);
    return { platform: 'linkedin', postId, success: true };
  }
}

module.exports = new LinkedInService();
module.exports.TOKEN_KEY = TOKEN_KEY;
module.exports._test = { parseJsonObject, SCOPES, API_VERSION };
