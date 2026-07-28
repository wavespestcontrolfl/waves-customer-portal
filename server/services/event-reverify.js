/**
 * Live official-page reverification for locked newsletter events
 * (owner spec 2026-07-28, Stage 6).
 *
 * Immediately before proof and again before delivery, each locked
 * event's official page is re-fetched and checked for STRONG dead-event
 * signals. Fail-closed ONLY on confirmed evidence:
 *   - the page is gone (HTTP 404 / 410 / 451), or
 *   - the page explicitly says cancelled/postponed near this event's own
 *     distinctive title tokens (a bare "cancelled" elsewhere on a
 *     listing page is not evidence about THIS event).
 * Everything else — timeouts, DNS failures, 403 WAFs, 5xx — passes with
 * a note: a flaky venue site must never block the Tuesday send.
 *
 * SSRF posture: event_url is INGESTED, UNTRUSTED data fetched from
 * inside Railway's network. Every fetch (and every redirect hop,
 * followed manually) must be http(s) to a hostname whose RESOLVED
 * addresses are all public — loopback, RFC1918, link-local/metadata,
 * CGNAT, and reserved ranges are refused. Responses are read as a
 * stream and aborted at the byte cap so an endless page can't exhaust
 * memory. (Resolve-then-fetch still has a narrow DNS-rebinding TOCTOU
 * window; per-hop re-validation and the private-range refusal are the
 * accepted mitigation at this tier — validation failures fail OPEN for
 * the event, closed for the fetch: we just don't fetch.)
 *
 * DARK SHIP: enabled only when NEWSLETTER_LIVE_REVERIFY === 'true'
 * (default OFF — this can block a send, so the owner flips it). Kill
 * switch = unset the var.
 */

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const logger = require('./logger');

const FETCH_TIMEOUT_MS = 12000;
const MAX_BODY_BYTES = 200 * 1024;
const CONCURRENCY = 3;
const MAX_REDIRECTS = 3;
const GONE_STATUSES = new Set([404, 410, 451]);
const DEAD_TEXT = /(cancell?ed|postponed|no longer taking place|event has been called off)/i;
// How close (in characters) a dead-text hit must be to the title tokens
// to count as evidence about THIS event.
const PROXIMITY = 600;

// Title words too generic to identify an event on a page full of events.
const GENERIC_TITLE_WORDS = new Set([
  'event', 'events', 'show', 'shows', 'night', 'nights', 'live', 'music',
  'festival', 'fest', 'expo', 'fair', 'market', 'party', 'series', 'annual',
  'weekly', 'family', 'summer', 'winter', 'spring', 'fall', 'tour', 'day',
  'week', 'weekend', 'with', 'from', 'this', 'that', '2025', '2026', '2027',
]);

function reverifyEnabled() {
  return process.env.NEWSLETTER_LIVE_REVERIFY === 'true';
}

// ── SSRF guard ───────────────────────────────────────────────────────

// ALLOWLIST posture: an address is acceptable only when it is provably
// globally-routable unicast. Everything else — including ranges we have
// never heard of — is refused (fail closed for the fetch).

function ipv4ToInt(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

// IANA IPv4 special-purpose registry (+ multicast/reserved). Any hit = refused.
const V4_BLOCKED_CIDRS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (ipv4ToInt(base) & mask) >>> 0, mask };
});

function isGlobalIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return !V4_BLOCKED_CIDRS.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

function isGlobalIPv6(ip) {
  // Only current global unicast (2000::/3) is acceptable. This refuses
  // loopback, unspecified, link-local, ULA, deprecated site-local
  // (fec0::/10), multicast (ff00::/8), v4-mapped/compat, and every
  // reserved block wholesale — a legitimate venue AAAA lives in 2000::/3.
  const lower = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const head = lower.split(':')[0];
  if (head === '' || head.length > 4) return false; // '::…' forms are never 2000::/3
  const hextet = parseInt(head, 16);
  if (Number.isNaN(hextet)) return false;
  return (hextet & 0xe000) === 0x2000;
}

function isPrivateIp(ip) {
  return net.isIPv4(ip) ? !isGlobalIPv4(ip) : !isGlobalIPv6(ip);
}

/**
 * Validate one URL for outbound fetch: http(s) only, and EVERY resolved
 * address public. Returns { ok } or { ok: false, why }. Exported for
 * tests; DNS failures report as unresolvable (caller fails open for the
 * event — the fetch simply doesn't happen).
 */
async function assertPublicHttpUrl(rawUrl, { lookup = dns.lookup.bind(dns) } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, why: 'unparseable url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, why: `refused protocol ${url.protocol}` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    return isPrivateIp(host)
      ? { ok: false, why: 'private address' }
      : { ok: true, url, address: host, family: net.isIPv4(host) ? 4 : 6 };
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, why: 'unresolvable host' };
  }
  if (!addrs?.length) return { ok: false, why: 'unresolvable host' };
  if (addrs.some((a) => isPrivateIp(a.address))) {
    return { ok: false, why: 'resolves to a private address' };
  }
  // Return the vetted address so the caller can PIN the connection to it —
  // re-resolving at connect time would reopen the DNS-rebinding window.
  return { ok: true, url, address: addrs[0].address, family: addrs[0].family || (net.isIPv4(addrs[0].address) ? 4 : 6) };
}

/**
 * One HTTP(S) GET pinned to a pre-validated address: the socket connects
 * to EXACTLY the IP the SSRF check vetted (custom `lookup`), while
 * Host/SNI still derive from the URL hostname. No automatic redirects —
 * the caller follows hops manually, re-validating each. Body is streamed
 * and the request destroyed at the byte cap.
 */
function pinnedGet(urlObj, address, family, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES } = {}) {
  const mod = urlObj.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    // Wall-clock deadline: Node's `timeout` option is an INACTIVITY
    // timer — an untrusted server trickling one byte per interval could
    // hold the send path hostage until the byte cap. Hard-stop the
    // request after FETCH_TIMEOUT_MS regardless of activity.
    let deadline;
    const req = mod.request(urlObj, {
      method: 'GET',
      // Pin: whatever the URL hostname is, connect only to the vetted IP.
      // Both lookup callback conventions are served: Node ≥20's
      // autoSelectFamily path calls lookup with { all: true } and expects
      // an ARRAY — answering in the legacy (err, address, family) style
      // there errors the connection and would silently fail the recheck
      // open on modern runtimes.
      lookup: (host, lookupOpts, cb) => {
        if (lookupOpts && lookupOpts.all) return cb(null, [{ address, family }]);
        return cb(null, address, family);
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WavesNewsletterBot/1.0; +https://portal.wavespestcontrol.com)',
        Accept: 'text/html,*/*',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let total = 0;
      let capped = false;
      let settled = false;
      const finishOnce = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({
          status: res.statusCode,
          location: res.headers.location || null,
          text: Buffer.concat(chunks).slice(0, maxBytes).toString('utf8'),
        });
      };
      const rejectOnce = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(err);
      };
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total <= maxBytes) chunks.push(chunk);
        if (total >= maxBytes && !capped) {
          capped = true;
          req.destroy();
        }
      });
      // Resolve ONLY on a completed body or our own intentional size-cap
      // abort. A premature close/abort/reset after headers must REJECT
      // (→ the caller's documented fail-open 'unreachable' path), never
      // resolve with silently-truncated text a cancellation check would
      // then run against.
      res.on('end', finishOnce);
      res.on('close', () => {
        if (capped) finishOnce();
        else rejectOnce(new Error('connection closed before the response completed'));
      });
      res.on('aborted', () => {
        if (capped) finishOnce();
        else rejectOnce(new Error('response aborted'));
      });
      res.on('error', (err) => {
        if (capped) finishOnce();
        else rejectOnce(err);
      });
    });
    const abort = () => req.destroy(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    deadline = setTimeout(abort, timeoutMs);
    req.on('timeout', abort);
    req.on('error', (err) => {
      // Post-cap destroy errors surface after we resolved (guarded by the
      // response's settled flag); pre-response errors reject here.
      clearTimeout(deadline);
      reject(err);
    });
    req.end();
  });
}

// ── Evidence check ───────────────────────────────────────────────────

function titleWords(title) {
  return String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

function distinctiveTitleWords(title) {
  return titleWords(title).filter((w) => !GENERIC_TITLE_WORDS.has(w));
}

/**
 * Pure check: does the page text carry a dead-event signal near THIS
 * event's identity? Requires at least two distinctive title tokens in
 * the window (or every distinctive token, for one-distinctive-word
 * titles). Titles with no distinctive tokens yield no evidence — better
 * to miss a cancellation than to kill a healthy lineup over the word
 * "event". Exported for tests.
 */
function deadTextNearTitle(pageText, title) {
  const text = String(pageText || '').toLowerCase();
  const words = distinctiveTitleWords(title);
  if (!words.length) return false;
  const required = Math.min(words.length, 2);
  const re = new RegExp(DEAD_TEXT.source, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    const from = Math.max(0, match.index - PROXIMITY);
    const to = Math.min(text.length, match.index + PROXIMITY);
    // WHOLE-token matching — a substring hit ('race' inside 'bracelet')
    // must never turn an unrelated cancellation into evidence.
    const windowTokens = new Set(text.slice(from, to).split(/[^a-z0-9]+/));
    const hits = words.filter((w) => windowTokens.has(w)).length;
    if (hits >= required) return true;
  }
  return false;
}

// ── Fetch + verdict ──────────────────────────────────────────────────

/**
 * Reverify one event against its live official page.
 * @returns {{ ok: boolean, reason?: string, note?: string }}
 */
async function reverifyEvent(event, { lookup, get = pinnedGet } = {}) {
  if (!event?.event_url) return { ok: true, note: 'no url' };
  try {
    let currentUrl = event.event_url;
    let resp = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const check = await assertPublicHttpUrl(currentUrl, lookup ? { lookup } : {});
      if (!check.ok) {
        // SSRF refusals and DNS failures are not dead-event evidence.
        return { ok: true, note: `fetch refused (${check.why})` };
      }
      // Connection is PINNED to the vetted address (no second resolution).
      resp = await get(check.url, check.address, check.family);
      if (resp.status >= 300 && resp.status < 400) {
        if (!resp.location) return { ok: true, note: 'redirect without location' };
        currentUrl = new URL(resp.location, check.url).toString();
        if (hop === MAX_REDIRECTS) return { ok: true, note: 'too many redirects' };
        continue;
      }
      break;
    }
    if (GONE_STATUSES.has(resp.status)) {
      return { ok: false, reason: `page gone (HTTP ${resp.status})` };
    }
    if (resp.status < 200 || resp.status >= 300) {
      // 403/5xx/etc: not evidence the EVENT is dead — the site is cranky.
      return { ok: true, note: `unreachable (HTTP ${resp.status})` };
    }
    const text = String(resp.text || '').replace(/<[^>]+>/g, ' ');
    if (deadTextNearTitle(text, event.title)) {
      return { ok: false, reason: 'page says cancelled/postponed near the event title' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: true, note: `unreachable (${err.name === 'AbortError' ? 'timeout' : err.message})` };
  }
}

/**
 * Reverify a lineup with bounded concurrency.
 * @returns {{ ok: boolean, failures: Array<{id, title, reason}>, notes: string[] }}
 */
async function reverifyEvents(events, opts = {}) {
  if (!reverifyEnabled()) return { ok: true, failures: [], notes: ['reverify gate off'], skipped: true };
  const rows = (Array.isArray(events) ? events : []).filter(Boolean);
  const failures = [];
  const notes = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((e) => reverifyEvent(e, opts)));
    results.forEach((r, idx) => {
      const e = batch[idx];
      if (!r.ok) failures.push({ id: e.id, title: e.title, reason: r.reason });
      else if (r.note) notes.push(`${e.title}: ${r.note}`);
    });
  }
  if (failures.length) {
    logger.warn(`[event-reverify] ${failures.length} locked event(s) failed live recheck: ${failures.map((f) => f.title).join('; ')}`);
  }
  return { ok: failures.length === 0, failures, notes };
}

module.exports = {
  reverifyEnabled,
  reverifyEvent,
  reverifyEvents,
  deadTextNearTitle,
  assertPublicHttpUrl,
  distinctiveTitleWords,
};
