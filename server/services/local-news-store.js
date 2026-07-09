/**
 * Persistence for the Learn tab's Local Suncoast News card
 * (local_news_items).
 *
 * Publisher RSS feeds only carry each outlet's most recent items, and the
 * strict relevance filter passes few of them — served straight from the
 * feeds the card drains back to empty as stories rotate out. Stories that
 * pass the filter are banked here at ingest so /api/feed/local can always
 * serve the newest N ever seen (owner ask: keep the older posts so the
 * card always looks full).
 *
 * Callers own error handling: the feed route wraps these in try/catch and
 * degrades to serving the current fetch directly if the table is missing
 * or the DB is unreachable.
 */
const db = require('../models/db');

const TABLE = 'local_news_items';
// Plenty of history for a 5-item card without growing unbounded.
const KEEP_ROWS = 60;

// Subset of `links` not yet banked — the route only spends og:image page
// fetches on genuinely new stories.
async function newLinks(links) {
  if (!links.length) return [];
  const existing = await db(TABLE).whereIn('link', links).pluck('link');
  const seen = new Set(existing);
  return links.filter((link) => !seen.has(link));
}

// Items arrive in the route's candidate shape ({ title, link, description,
// image, sourceName, pubDate: Date }). Conflict on link = another refresh
// (or another dyno) already banked it — keep the first write.
async function insertItems(items) {
  if (!items.length) return;
  for (const item of items) {
    await db(TABLE)
      .insert({
        link: item.link,
        title: item.title,
        description: item.description,
        image: item.image,
        source_name: item.sourceName,
        pub_date: item.pubDate,
      })
      .onConflict('link')
      .ignore();
  }
  // Prune beyond the newest KEEP_ROWS so the table stays card-sized.
  const stale = await db(TABLE).select('id').orderBy('pub_date', 'desc').offset(KEEP_ROWS);
  if (stale.length) {
    await db(TABLE).whereIn('id', stale.map((row) => row.id)).del();
  }
}

async function latestItems(limit) {
  return db(TABLE).orderBy('pub_date', 'desc').limit(limit);
}

module.exports = { newLinks, insertItems, latestItems, KEEP_ROWS };
