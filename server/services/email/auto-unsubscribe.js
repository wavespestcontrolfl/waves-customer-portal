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

async function autoUnsubscribe(email) {
  const fromDomain = email.from_address?.split('@')[1] || '';

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
        // Try POST first (RFC 8058 one-click)
        let res = await fetch(urlMatch[1], {
          method: 'POST',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'List-Unsubscribe=One-Click',
        });

        if (!res.ok) {
          res = await fetch(urlMatch[1], { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
        }

        await db('email_unsubscribe_log').insert({
          email_id: email.id,
          from_domain: fromDomain,
          unsubscribe_method: 'list_header_url',
          unsubscribe_url: urlMatch[1],
          status: 'attempted',
        });
        logger.info(`[unsubscribe] Hit List-Unsubscribe URL for ${email.from_address}`);
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
      await fetch(unsubUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      await db('email_unsubscribe_log').insert({
        email_id: email.id,
        from_domain: fromDomain,
        unsubscribe_method: 'body_link',
        unsubscribe_url: unsubUrl,
        status: 'attempted',
      });
      logger.info(`[unsubscribe] Hit body unsubscribe link for ${email.from_address}`);
      return { method: 'body_link', url: unsubUrl };
    } catch (err) {
      logger.warn(`[unsubscribe] Body link failed: ${err.message}`);
    }
  }

  return { method: 'none', note: 'No unsubscribe mechanism found' };
}

module.exports = { autoUnsubscribe };
