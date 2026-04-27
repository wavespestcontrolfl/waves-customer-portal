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

// Hosts the newsletter feed is allowed to link to. Mirrors the smaller
// surface of feed.js's ALLOWED_LINK_HOSTS — only places we'd actually
// expect a sent-newsletter row's external_web_url to point at:
//   - the public Waves site (in-house archive embeds)
//   - Beehiiv's hosted post URLs (historical imports)
// Anything else (a `javascript:`, `data:`, third-party link) gets
// rejected and the post falls back to the in-portal archive URL.
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'wavespestcontrol.com', 'www.wavespestcontrol.com',
  'beehiiv.com', 'www.beehiiv.com', 'mag.beehiiv.com', 'rss.beehiiv.com',
]);

function safeExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (ALLOWED_EXTERNAL_HOSTS.has(host)) return u.toString();
    for (const allowed of ALLOWED_EXTERNAL_HOSTS) {
      if (host.endsWith('.' + allowed)) return u.toString();
    }
    return null;
  } catch { return null; }
}

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

  return rows.map((s) => {
    // Beehiiv-imported rows carry an external_web_url. We only emit it
    // when it parses to a known-good http(s) host — anything else
    // (malformed import payload, javascript:/data:, third-party host)
    // falls back to the in-portal archive page so we never render a
    // hostile URL into a clickable anchor on the public landing page.
    const external = safeExternalUrl(s.external_web_url);
    return {
      title: s.subject || '',
      link: external || `/newsletter/archive/${s.id}`,
      pubDate: s.sent_at ? new Date(s.sent_at).toUTCString() : '',
      description: s.preview_text || stripHtml(s.html_body || '').slice(0, 200),
      image: null,
      source: 'newsletter',
      sourceName: 'Waves Newsletter',
    };
  });
}

module.exports = { getPublishedPosts };
