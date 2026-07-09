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
const { stripPersonalizationTokens } = require('./newsletter-draft');

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

// Sent bodies embed three kinds of <img>: the generated hero (S3/CDN jpg,
// first in the body when present), the Waves divider GIF between sections,
// and Giphy reaction GIFs (Beehiiv-imported issues proxy theirs through
// media.beehiiv.com but keep the .gif filename). The card thumbnail is the
// first NON-GIF image — skipping .gif drops the divider and the memes in one
// rule, and event photos still provide a thumbnail for hero-less issues.
// The client renders this inside CSS background:url(...), so mirror feed.js's
// safeImage hygiene: http(s) only, no characters that can break out of url().
function extractCardImage(htmlBody) {
  if (!htmlBody) return null;
  const imgSrcRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = imgSrcRe.exec(String(htmlBody))) !== null) {
    const src = match[1].replace(/&amp;/g, '&');
    let url;
    try { url = new URL(src); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (url.pathname.toLowerCase().endsWith('.gif')) continue;
    if (/[\s"'<>\\)]/.test(src)) continue;
    return src;
  }
  return null;
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
    // stripPersonalizationTokens: sent bodies persist the {{greeting-name}} /
    // {{city}} / {{grass-type}} tokens; feed descriptions have no recipient
    // identity, so neutralize them all (city/grass → neutral defaults).
    description: stripPersonalizationTokens(s.preview_text || '') || stripHtml(stripPersonalizationTokens(s.html_body || '')).slice(0, 200),
    image: extractCardImage(s.html_body),
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
