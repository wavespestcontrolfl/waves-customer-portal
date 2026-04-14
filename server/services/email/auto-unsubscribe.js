const db = require('../../models/db');
const logger = require('../logger');

async function autoUnsubscribe(email) {
  const fromDomain = email.from_address?.split('@')[1] || '';

  // Method 1: Check List-Unsubscribe header (stored in extracted_data or label_ids context)
  // We need the raw headers — check if they were stored
  const listUnsub = email.list_unsubscribe || null;

  if (listUnsub) {
    const urlMatch = listUnsub.match(/<(https?:\/\/[^>]+)>/);

    if (urlMatch) {
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
