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

const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const logger = require('../logger');

// ── SSRF guards ───────────────────────────────────────────────────────────────
// The prospect domain is untrusted and fetched server-side, so a malicious domain
// (or a redirect to one) must not let us probe internal/cloud-metadata hosts.

// Extract the embedded IPv4 from an IPv4-mapped/compatible IPv6 address — both
// the dotted form (::ffff:127.0.0.1) AND the hex form (::ffff:7f00:1, including
// expanded 0:0:0:0:0:ffff:7f00:1). Without the hex case, ::ffff:a9fe:a9fe (the
// metadata host) would slip past the private-IP check.
function mappedIpv4(h) {
  const dotted = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted && net.isIPv4(dotted[1])) return dotted[1];
  if (!/(^|:)ffff:/.test(h)) return null;
  const groups = h.replace(/^.*ffff:/, '').split(':');
  if (groups.length !== 2) return null;
  const hi = parseInt(groups[0], 16), lo = parseInt(groups[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)              // link-local / cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);   // CGNAT
  }
  const h = String(ip).toLowerCase();
  const mapped = mappedIpv4(h);
  if (mapped) return isPrivateIp(mapped);
  return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

// Synchronous, no-network reject of obviously-unsafe hostnames.
function isBlockedHostname(host) {
  if (!host) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (net.isIP(h)) return isPrivateIp(h);     // IP literal → only block private ones
  if (!h.includes('.')) return true;          // single-label / intranet name
  return false;
}

// Resolve the host and reject if it (or any A/AAAA record) is a private address.
async function hostResolvesPublic(host) {
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

// A dns.lookup-style callback that rejects private IPs. Passed as the `lookup`
// option to the actual http(s) request so the check is tied to the REAL socket
// connection — this is what closes the DNS-rebinding gap a preflight can't
// (the preflight and the connection would otherwise resolve independently).
function rejectingLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options || {});
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: opts.family || 4 }];
    for (const a of list) {
      if (isPrivateIp(a.address)) return cb(new Error(`blocked private address for ${hostname}`));
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

// Default fetcher: a minimal GET over Node http/https that pins the private-IP
// check to the connection via `lookup`. redirect:'manual' shape so the caller's
// per-hop revalidation still runs. Returns a fetch-like object (ok/status/
// headers.get/text) so tests can inject a plain mock instead. Never throws.
function nodeFetch(url, { signal, headers, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let u;
    try { u = new URL(url); } catch { return done(null); }
    const mod = u.protocol === 'http:' ? http : https;
    let req;
    try {
      req = mod.request(u, { method: 'GET', headers, signal, lookup: rejectingLookup }, (res) => {
        const status = res.statusCode || 0;
        const wrap = (body) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null }, text: async () => body });
        if (status < 200 || status >= 300) { res.resume(); return done(wrap('')); } // incl. 3xx (caller follows)
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; if (data.length >= 600000) { data = data.slice(0, 600000); res.destroy(); done(wrap(data)); } });
        res.on('end', () => done(wrap(data)));
        res.on('close', () => done(wrap(data)));      // never wait forever if 'end' is skipped
        res.on('error', () => done(null));
      });
    } catch { return done(null); }
    req.setTimeout(timeoutMs, () => req.destroy());   // independent stall guard
    req.on('error', () => done(null));
    req.end();
  });
}

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

// Fetch with manual redirect handling so EVERY hop's host is SSRF-revalidated
// (a public domain can 30x to an internal one). Bounded redirects; fail-soft.
async function fetchText(url, { fetchFn, timeoutMs, resolveHostFn = hostResolvesPublic, maxRedirects = 2 }) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (isBlockedHostname(u.hostname) || !(await resolveHostFn(u.hostname))) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'WavesPestControl-LinkResearch/1.0 (+https://wavespestcontrol.com)' },
      });
      if (res && res.status >= 300 && res.status < 400 && res.headers && typeof res.headers.get === 'function') {
        const loc = res.headers.get('location');
        if (!loc) return null;
        current = new URL(loc, current).toString(); // re-validated on next loop
        continue;
      }
      if (!res || !res.ok) return null;
      const html = await res.text();
      return typeof html === 'string' ? html.slice(0, 600000) : null; // cap pathological pages
    } catch {
      return null; // timeout / DNS / TLS / abort — treated as "no signal"
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // redirect budget exhausted
}

/**
 * findContact(domain) → { domain, contact_url, contact_email, has_contact_path,
 *                         contributor_path, checked_at }
 * Never throws.
 */
async function findContact(domain, { fetchFn = nodeFetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxFetches = MAX_FETCHES, resolveHostFn = hostResolvesPublic } = {}) {
  const host = normalizeDomain(domain);
  const result = {
    domain: host,
    contact_url: null,
    contact_email: null,
    has_contact_path: false,
    contributor_path: null,
    checked_at: new Date().toISOString(),
  };
  // SSRF gate: never probe an internal/private/literal host (cheap, no network).
  if (!host || isBlockedHostname(host)) return result;

  let fetches = 0;
  for (const path of CONTACT_PATHS) {
    if (fetches >= maxFetches) break;
    const url = `https://${host}${path}`;
    fetches++;
    const html = await fetchText(url, { fetchFn, timeoutMs, resolveHostFn });
    if (!html) continue;

    if (path !== '/' && FORM_RE.test(html)) {
      result.contact_url = result.contact_url || url;
      result.has_contact_path = true;
    }
    if (WRITE_FOR_US_RE.test(html)) {
      result.contributor_path = result.contributor_path || url;
      // Persist a reachable URL too — has_contact_path with a null contact_url
      // would pass the gate but leave the worker nothing to act on.
      result.contact_url = result.contact_url || url;
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
module.exports._internals = { normalizeDomain, extractEmails, isUsableEmail, scoreEmail, isBlockedHostname, isPrivateIp, hostResolvesPublic, CONTACT_PATHS };
