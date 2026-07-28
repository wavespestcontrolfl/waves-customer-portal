const dns = require('dns').promises;
const net = require('net');
const db = require('../../models/db');
const logger = require('../logger');

// Reject internal/private hosts to prevent SSRF on unsubscribe fetches
function isSafePublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  // IPv4 private / loopback / link-local / metadata ranges
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return false;
  // IPv6 unique-local / link-local
  if (/^\[?(fc|fd|fe80)/i.test(host)) return false;
  return true;
}

/**
 * True unless the literal is a GLOBAL UNICAST address. Deny-by-default: the
 * request only proceeds for plain public space — private, loopback,
 * link-local, CGN, benchmarking (198.18/15), documentation, multicast
 * (224/4, ff00::/8), reserved (240/4), site-local and every other special
 * range all refuse.
 */
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return true; // unparseable — treat as unsafe
  const addr = ip.toLowerCase();
  if (v === 4) {
    const o = addr.split('.').map(Number);
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;           // this-net, private, loopback
    if (o[0] >= 224) return true;                                          // multicast + reserved + broadcast
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;            // CGN 100.64/10
    if (o[0] === 169 && o[1] === 254) return true;                         // link-local / metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;             // private 172.16/12
    if (o[0] === 192 && o[1] === 168) return true;                         // private 192.168/16
    if (o[0] === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return true; // IETF special + TEST-NET-1
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true;         // benchmarking 198.18/15
    if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true;          // TEST-NET-2
    if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true;           // TEST-NET-3
    return false;
  }
  // IPv6: IPv4-mapped recurses to the v4 rules; otherwise ONLY global
  // unicast (2000::/3) passes, minus the documentation prefix — loopback,
  // unspecified, unique-local, link-local, site-local, multicast and every
  // other special block fail the 2000::/3 test automatically.
  if (addr.startsWith('::ffff:')) return isPrivateAddress(addr.slice(7));
  if (!/^[23]/.test(addr)) return true;
  if (addr.startsWith('2001:db8')) return true; // documentation
  return false;
}

/**
 * One PINNED http(s) request: the socket connects to the pre-validated
 * address via a custom `lookup`, so the DNS answer the guard checked is the
 * DNS answer the connection uses — a rebinding attacker can't serve a public
 * A record to the validator and a private one to the request. Host header
 * and TLS SNI still come from the URL's hostname. Responses are truncated
 * (nothing is read beyond status/headers + a small body drain).
 */
function requestPinned(urlString, { method = 'GET', headers = {}, body = null } = {}, pinnedAddress, pinnedFamily) {
  const u = new URL(urlString);
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      headers,
      timeout: 10000,
      // Node's agent may call the custom lookup with { all: true } — that
      // shape REQUIRES an array result or every hostname request dies with
      // ERR_INVALID_IP_ADDRESS.
      lookup: (host, opts, cb) => (opts && opts.all
        ? cb(null, [{ address: pinnedAddress, family: pinnedFamily }])
        : cb(null, pinnedAddress, pinnedFamily)),
    }, (res) => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
      });
      // Status + headers are all we ever use — tear the socket down NOW so
      // an attacker endpoint can't stream forever (the request timeout is
      // inactivity-based and would never fire on an active stream).
      res.destroy();
    });
    req.on('timeout', () => req.destroy(new Error('unsubscribe request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * SSRF-hardened fetch for UNTRUSTED, sender-controlled URLs. The header/body
 * URL check alone is not enough: a public hostname can resolve to a private
 * address, an open redirect can bounce the request to internal/metadata
 * endpoints, and a rebinding DNS server can answer the validator and the
 * request differently. Every hop (redirects manual, max 3) is
 * string-validated, DNS-resolved with every address required public, and the
 * request socket is PINNED to the validated address (requestPinned above).
 */
async function fetchPublicOnly(rawUrl, options = {}, maxHops = 3) {
  let current = rawUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (!isSafePublicUrl(current)) throw new Error(`unsafe URL refused (hop ${hop})`);
    const { hostname } = new URL(current);
    let pinned;
    if (net.isIP(hostname)) {
      if (isPrivateAddress(hostname)) throw new Error(`private IP literal refused (hop ${hop})`);
      pinned = { address: hostname, family: net.isIP(hostname) };
    } else {
      const results = await dns.lookup(hostname, { all: true });
      if (!results.length || results.some((r) => isPrivateAddress(r.address))) {
        throw new Error(`private/unresolvable host refused (hop ${hop})`);
      }
      pinned = results[0];
    }
    const res = await requestPinned(current, options, pinned.address, pinned.family);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      current = new URL(location, current).toString();
      // Redirect hops downgrade to GET (mirrors browser semantics for 301/302
      // POSTs) and never re-send the one-click body to a new host.
      options = { headers: options.headers, method: 'GET' };
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

async function autoUnsubscribe(email) {
  const fromDomain = email.from_address?.split('@')[1] || '';

  // Belt-and-braces: NEVER unsubscribe from mail sent by Waves-owned or
  // operational domains, regardless of how the caller classified it. A
  // one-click POST on our own newsletter's List-Unsubscribe header
  // enrolls the shared inbox in SendGrid's suppression group — this
  // exact failure silently knocked contact@ off our own list twice.
  const { isOperationalDomain, domainFromAddress } = require('./spam-blocker');
  if (isOperationalDomain(domainFromAddress(email.from_address))) {
    logger.info(`[unsubscribe] Refused: operational sender (email ${email.id})`);
    return { method: 'none', note: 'operational sender — never unsubscribe' };
  }

  // The unsubscribe URLs are sender-controlled requests — following them for
  // mail that did not authenticate as its claimed domain hands harvesting
  // spammers a live-mailbox signal (and a request trigger). Unauthenticated
  // bulk mail gets archived only.
  const { hasAlignedAuth } = require('./inbox-hygiene');
  if (!hasAlignedAuth(email.authentication_results, domainFromAddress(email.from_address))) {
    logger.info(`[unsubscribe] Refused: sender not authenticated (email ${email.id})`);
    return { method: 'none', note: 'unauthenticated sender — archive only' };
  }

  // Method 1: Check List-Unsubscribe header (stored in extracted_data or label_ids context)
  // We need the raw headers — check if they were stored
  const listUnsub = email.list_unsubscribe || null;

  if (listUnsub) {
    const urlMatch = listUnsub.match(/<(https?:\/\/[^>]+)>/);

    if (urlMatch) {
      if (!isSafePublicUrl(urlMatch[1])) {
        logger.warn(`[unsubscribe] Refused unsafe List-Unsubscribe URL: ${urlMatch[1]}`);
        return { method: 'none', note: 'Unsafe unsubscribe URL refused' };
      }
      try {
        // RFC 8058 one-click POST is only allowed when the sender DECLARED
        // it via List-Unsubscribe-Post — a plain List-Unsubscribe URL may be
        // a preference page never meant to receive a POST. Hardened fetch
        // either way: every hop DNS-validated public, socket pinned,
        // redirects manual (see fetchPublicOnly).
        const oneClick = /list-unsubscribe=one-click/i.test(String(email.list_unsubscribe_post || ''));
        let res;
        if (oneClick) {
          res = await fetchPublicOnly(urlMatch[1], {
            method: 'POST',
            headers: {
              'User-Agent': 'Mozilla/5.0',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'List-Unsubscribe=One-Click',
          });
        }
        if (!res || !res.ok) {
          res = await fetchPublicOnly(urlMatch[1], { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
        }
        // A 404/500 on both attempts is a FAILED unsubscribe — reporting it
        // as success would let the digest claim work that never happened and
        // stop the newsletter path from trying the body-link fallback.
        if (!res.ok) throw new Error(`unsubscribe endpoint returned ${res.status}`);

        await db('email_unsubscribe_log').insert({
          email_id: email.id,
          from_domain: fromDomain,
          unsubscribe_method: 'list_header_url',
          unsubscribe_url: urlMatch[1],
          status: 'attempted',
        });
        logger.info(`[unsubscribe] Hit List-Unsubscribe URL (email ${email.id})`);
        return { method: 'list_header_url', url: urlMatch[1] };
      } catch (err) {
        logger.warn(`[unsubscribe] List-Unsubscribe URL failed: ${err.message}`);
      }
    }
  }

  // Method 2: Find unsubscribe link in email body
  const body = (email.body_html || email.body_text || '').substring(0, 5000);
  const unsubRegex = /https?:\/\/[^\s"'<>]+(?:unsubscribe|optout|opt-out|remove|manage[_-]?preferences)[^\s"'<>]*/gi;
  const matches = body.match(unsubRegex);

  if (matches && matches.length > 0) {
    const unsubUrl = matches[0].replace(/["'>]+$/, ''); // Clean trailing chars
    if (!isSafePublicUrl(unsubUrl)) {
      logger.warn(`[unsubscribe] Refused unsafe body unsubscribe URL: ${unsubUrl}`);
      return { method: 'none', note: 'Unsafe unsubscribe URL refused' };
    }
    try {
      const res = await fetchPublicOnly(unsubUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      // Same bar as the header path: a 4xx/5xx is a FAILED unsubscribe and
      // must not be recorded (or digested) as success.
      if (!res.ok) throw new Error(`unsubscribe endpoint returned ${res.status}`);

      await db('email_unsubscribe_log').insert({
        email_id: email.id,
        from_domain: fromDomain,
        unsubscribe_method: 'body_link',
        unsubscribe_url: unsubUrl,
        status: 'attempted',
      });
      logger.info(`[unsubscribe] Hit body unsubscribe link (email ${email.id})`);
      return { method: 'body_link', url: unsubUrl };
    } catch (err) {
      logger.warn(`[unsubscribe] Body link failed: ${err.message}`);
    }
  }

  return { method: 'none', note: 'No unsubscribe mechanism found' };
}

module.exports = { autoUnsubscribe, fetchPublicOnly, isPrivateAddress, isSafePublicUrl };
