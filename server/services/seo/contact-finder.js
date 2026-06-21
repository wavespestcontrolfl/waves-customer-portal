/**
 * Contact finder — does a prospect site expose a way to reach a human?
 *
 * Outreach to a site with no contact path is dead on arrival, so the prospect
 * scorer uses this to GATE outreach-intent prospects at intake (the "no contact
 * path = don't queue it" rule). We fetch the homepage plus a small fixed set of
 * likely contact paths, then pull mailto: addresses, a contact-form signal, and
 * "write for us"/contributor hints out of the HTML.
 *
 * Regex-only (no HTML-parser dependency). Bounded + polite: a hard per-fetch
 * timeout, an early exit once a usable email is found, and a small cap on how
 * many paths we probe per domain. Fail-soft everywhere — a flaky or hostile
 * site resolves to { has_contact_path: false }, never a thrown error, so one
 * bad domain can't crash a harvest of hundreds.
 */

const logger = require('../logger');

// Probed in order; we stop early once we have an email.
const CONTACT_PATHS = ['/', '/contact', '/contact-us', '/write-for-us', '/contribute', '/advertise', '/about'];
const MAX_FETCHES = 4;            // homepage + up to 3 likely paths
const DEFAULT_TIMEOUT_MS = 8000;

// Role inboxes worth pitching, best first. A role address beats a personal one
// for cold outreach and is far less likely to be a parsing artifact.
const ROLE_PREFIXES = ['editor', 'editorial', 'news', 'tips', 'press', 'media', 'contribute', 'submissions', 'hello', 'contact', 'info', 'team', 'marketing', 'partnerships'];

// Junk we never want to treat as a contact (CDNs, placeholders, asset names).
const EMAIL_BLOCKLIST = /(example\.|sentry\.|wixpress\.|godaddy|domain\.com|email\.com|yourdomain|sentry-next|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|@2x|u003e|u003c)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAILTO_RE = /mailto:([^"'?>\s]+)/gi;
const FORM_RE = /<form[^>]*>/i;
const WRITE_FOR_US_RE = /(write[\s-]?for[\s-]?us|become[\s-]a[\s-]contributor|guest[\s-]post|contributor[\s-]guidelines|submit[\s-]a[\s-](?:story|tip|guest))/i;

function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
  }
}

function isUsableEmail(email, domain) {
  if (!email || EMAIL_BLOCKLIST.test(email)) return false;
  const lower = email.toLowerCase();
  if (lower.length > 80) return false;
  // Drop obvious tracking/no-reply sinks for an outreach context.
  if (/^(no-?reply|donotreply|abuse|postmaster|webmaster)@/i.test(lower)) return false;
  return true;
}

function scoreEmail(email, domain) {
  const lower = email.toLowerCase();
  const local = lower.split('@')[0];
  const onDomain = domain && lower.endsWith(`@${domain}`);
  const roleIdx = ROLE_PREFIXES.findIndex((p) => local === p || local.startsWith(p));
  // Lower is better: prefer on-domain role inboxes.
  return (onDomain ? 0 : 100) + (roleIdx === -1 ? 50 : roleIdx);
}

function extractEmails(html, domain) {
  const found = new Set();
  let m;
  MAILTO_RE.lastIndex = 0;
  while ((m = MAILTO_RE.exec(html))) {
    const e = decodeURIComponent(m[1].split('?')[0]).trim();
    if (isUsableEmail(e, domain)) found.add(e.toLowerCase());
  }
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(html))) {
    const e = m[0].trim();
    if (isUsableEmail(e, domain)) found.add(e.toLowerCase());
  }
  return [...found].sort((a, b) => scoreEmail(a, domain) - scoreEmail(b, domain));
}

async function fetchText(url, { fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'WavesPestControl-LinkResearch/1.0 (+https://wavespestcontrol.com)' },
    });
    if (!res || !res.ok) return null;
    const html = await res.text();
    return typeof html === 'string' ? html.slice(0, 600000) : null; // cap pathological pages
  } catch {
    return null; // timeout / DNS / TLS / abort — treated as "no signal"
  } finally {
    clearTimeout(timer);
  }
}

/**
 * findContact(domain) → { domain, contact_url, contact_email, has_contact_path,
 *                         contributor_path, checked_at }
 * Never throws.
 */
async function findContact(domain, { fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxFetches = MAX_FETCHES } = {}) {
  const host = normalizeDomain(domain);
  const result = {
    domain: host,
    contact_url: null,
    contact_email: null,
    has_contact_path: false,
    contributor_path: null,
    checked_at: new Date().toISOString(),
  };
  if (!host) return result;

  let fetches = 0;
  for (const path of CONTACT_PATHS) {
    if (fetches >= maxFetches) break;
    const url = `https://${host}${path}`;
    fetches++;
    const html = await fetchText(url, { fetchFn, timeoutMs });
    if (!html) continue;

    if (path !== '/' && FORM_RE.test(html)) {
      result.contact_url = result.contact_url || url;
      result.has_contact_path = true;
    }
    if (WRITE_FOR_US_RE.test(html)) {
      result.contributor_path = result.contributor_path || url;
      result.has_contact_path = true;
    }

    const emails = extractEmails(html, host);
    if (emails.length) {
      result.contact_email = emails[0];
      result.contact_url = result.contact_url || url;
      result.has_contact_path = true;
      break; // good enough — stop probing
    }
  }

  // Never log the address itself — emails in logs are treated as PII.
  logger?.debug?.(`[contact-finder] ${host}: contactable=${result.has_contact_path} hasEmail=${!!result.contact_email}`);
  return result;
}

module.exports = { findContact };
module.exports._internals = { normalizeDomain, extractEmails, isUsableEmail, scoreEmail, CONTACT_PATHS };
