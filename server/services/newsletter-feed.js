/**
 * Shared helper for surfacing sent newsletter campaigns as public-feed
 * posts. Used by both the authenticated /api/feed/newsletter (Learn tab
 * in PortalPage) and the public /api/public/newsletter/posts (landing
 * page past-issues grid).
 *
 * Source of truth is `newsletter_sends` — both Beehiiv historical
 * imports (status='sent', external_source='beehiiv', external_web_url
 * set) and in-house pipeline sends (status='sent', no external URL)
 * appear in the same list, sorted by sent_at desc.
 *
 * Beehiiv RSS is no longer consulted; the import-beehiiv route already
 * round-tripped the historical posts into newsletter_sends, so the
 * table is the single store. Fresh installs with an empty table simply
 * return an empty array — callers render an empty state.
 */

const db = require('../models/db');

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
  mdash: '—', ndash: '–',
};

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

async function getPublishedPosts({ limit = 6 } = {}) {
  const cap = Math.max(1, Math.min(50, Number(limit) || 6));
  const rows = await db('newsletter_sends')
    .where({ status: 'sent' })
    .whereNotNull('sent_at')
    .orderBy('sent_at', 'desc')
    .limit(cap);

  return rows.map((s) => ({
    title: s.subject || '',
    // Beehiiv-imported rows carry external_web_url; in-house sends
    // don't have a public archive page yet, so the link is empty.
    // The client renders non-linked cards as preview-only.
    link: s.external_web_url || '',
    pubDate: s.sent_at ? new Date(s.sent_at).toUTCString() : '',
    description: s.preview_text || stripHtml(s.html_body || '').slice(0, 200),
    image: null,
    source: 'newsletter',
    sourceName: 'Waves Newsletter',
  }));
}

module.exports = { getPublishedPosts };
