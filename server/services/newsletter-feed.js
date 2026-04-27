/**
 * Shared helper for surfacing sent newsletter campaigns as public-feed
 * posts. Used by both the authenticated /api/feed/newsletter (Learn tab
 * in PortalPage) and the public /api/public/newsletter/posts (landing
 * page past-issues grid).
 *
 * All sends route through the in-house pipeline (newsletter-sender.js)
 * and live in newsletter_sends. Each post's `link` points at the
 * in-portal archive (/newsletter/archive/:id), which renders html_body
 * inside a sandboxed iframe.
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
    link: `/newsletter/archive/${s.id}`,
    pubDate: s.sent_at ? new Date(s.sent_at).toUTCString() : '',
    description: s.preview_text || stripHtml(s.html_body || '').slice(0, 200),
    image: null,
    source: 'newsletter',
    sourceName: 'Waves Newsletter',
  }));
}

module.exports = { getPublishedPosts };
