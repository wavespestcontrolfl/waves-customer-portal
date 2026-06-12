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
const { stripGreetingNameToken } = require('./newsletter-draft');

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
    slugLink: s.slug ? `/newsletter/archive/${s.slug}` : null,
    slug: s.slug || null,
    pubDate: s.sent_at ? new Date(s.sent_at).toUTCString() : '',
    // stripGreetingNameToken: sent bodies persist the {{greeting-name}}
    // substitution token; feed descriptions have no recipient identity.
    description: s.preview_text || stripHtml(stripGreetingNameToken(s.html_body || '')).slice(0, 200),
    image: null,
    source: 'newsletter',
    sourceName: 'Waves Newsletter',
    newsletterType: s.newsletter_type || null,
    indexability: s.indexability || 'index',
  }));
}

async function getPostBySlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const row = await db('newsletter_sends')
    .where({ slug, status: 'sent' })
    .first();
  return row || null;
}

function buildRssXml(posts) {
  const escXml = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const items = posts.map((p) => `    <item>
      <title>${escXml(p.title)}</title>
      <link>https://www.wavespestcontrol.com${escXml(p.slugLink || p.link)}</link>
      <description>${escXml(p.description)}</description>
      <pubDate>${p.pubDate}</pubDate>
      <guid isPermaLink="true">https://www.wavespestcontrol.com${escXml(p.slugLink || p.link)}</guid>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Fresh This Week — Waves Pest Control</title>
    <link>https://www.wavespestcontrol.com/newsletter</link>
    <description>A weekly local events guide from North Port to Tampa, powered by Waves Pest Control.</description>
    <language>en-us</language>
    <lastBuildDate>${posts[0]?.pubDate || new Date().toUTCString()}</lastBuildDate>
    <atom:link href="https://portal.wavespestcontrol.com/api/public/newsletter/rss" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

module.exports = { getPublishedPosts, getPostBySlug, buildRssXml, stripHtml };
