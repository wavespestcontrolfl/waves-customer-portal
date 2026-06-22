/**
 * Newsletter event ingestion. Pulls feeds listed in the event_sources
 * table, normalizes the items into events_raw, and upserts on
 * (source_id, external_id) so re-running is idempotent and edited
 * events get refreshed.
 *
 * Handlers by feed_type:
 *   - 'rss'   → pullRssSource (P3a, rss-parser)
 *   - 'ical'  → pullIcalSource (P3b, node-ical)
 *   - 'scrape' → pullScrapeSource (P3b leg 2, Playwright + Claude
 *     extraction). For SPA event aggregators that don't expose
 *     RSS or iCal.
 *   - 'json'  → not implemented yet; sources with this feed_type are
 *     skipped with a warn-level log so the cron can pre-seed them
 *     without failing.
 *
 * Each pull is bounded by:
 *   - 15s HTTP timeout
 *   - 200 items per feed (most local-news RSS caps at ~20-50; iCal
 *     feeds can be larger but the 90-day forward window prunes most
 *     of the tail)
 *   - 90 days forward window — events with start_at > now+90d are
 *     dropped on insert (we don't write the customer about an event
 *     three months out)
 *   - 24h post-event recap drop — events with start_at < now-24h are
 *     dropped (some feeds publish recaps after the fact)
 *
 * Per-source failure tracking:
 *   - On success: last_pull_status='success', consecutive_failures=0
 *   - On failure: increments consecutive_failures, stores last_error.
 *     The dashboard can render a health badge from this; the cron
 *     does NOT auto-disable a failing source (operator decides).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { yieldTrackingUpdateFor, checkAndNotifySourceHealth } = require('./event-source-health');

// On a re-pull that moves an event's date from the PAST back into the FUTURE
// (a feed correcting/rescheduling a previously-expired event), re-queue the row
// for the normalizer by resetting normalized_at — the normalizer then recomputes
// freshness for the new date so the row isn't stuck 'expired'/'stale_recurring'
// (the editorial fetch filters exclude those). We deliberately do NOT touch
// freshness_status here: the column is NOT NULL (migration 20260524000002), so
// nulling it in the ON CONFLICT update would violate the constraint and fail the
// whole source pull. Leaving the stale status in place is harmless — the row is
// excluded for the ~1h until the next normalize run recomputes it.
//
// We ALSO set freshness_revival_pending=true — an explicit, one-shot marker the
// normalizer consumes to recompute freshness for ONLY genuinely-revived rows.
// Without it the normalizer would have to infer "was revived" from
// normalized_at IS NULL, which is not unique to revival (e.g. a geocode
// re-queue) and would let it override an admin's manual 'expired' on a row that
// ingestion never re-dated.
//
// Gated on OLD effective date < ET-midnight-today AND NEW effective date >=
// ET-midnight-today, where effective date = COALESCE(end_at, start_at). Two
// reasons for the ET-midnight boundary rather than now():
//   1. Old EFFECTIVE date (not bare start_at): an in-progress multi-day event
//      (start past, end still future) was never expirable, so it must NOT trip
//      revival on every upsert and undo an admin's manual 'expired' curation.
//   2. The SAME ET-midnight cutoff the expiry sweep uses (scheduler.js) and the
//      digest treats today as upcoming — so an event manually expired earlier
//      *today* (its effective date is today, not before midnight) is NOT past
//      by this gate and won't be revived when a source re-dates it forward.
//      now() would treat earlier-today as past and clobber that curation.
// EXCLUDED.* is the proposed insert; events_raw.* is the existing row.
const REVIVAL_COND = 'COALESCE(events_raw.end_at, events_raw.start_at) < :etMidnight AND COALESCE(EXCLUDED.end_at, EXCLUDED.start_at) >= :etMidnight';
function revivalResetFields() {
  // ET-midnight-today as a bound timestamptz — identical to the sweep's
  // parseETDateTime(`${etDateString()}T00:00:00`) (avoids the naive-ISO leak).
  const etMidnight = parseETDateTime(`${etDateString()}T00:00:00`);
  return {
    normalized_at: db.raw(`CASE WHEN ${REVIVAL_COND} THEN NULL ELSE events_raw.normalized_at END`, { etMidnight }),
    freshness_revival_pending: db.raw(`CASE WHEN ${REVIVAL_COND} THEN true ELSE events_raw.freshness_revival_pending END`, { etMidnight }),
    // A revival is a NEW occurrence editorially — re-open auto-curation
    // (event-curation.js excludes rows with curated_at, so a previously
    // examined-but-not-approved event would otherwise never be looked at
    // again after its date moved back into the future). Safe for
    // approved rows: the curation candidate query also requires
    // admin_status='pending', so clearing the marker can't re-judge them.
    curated_at: db.raw(`CASE WHEN ${REVIVAL_COND} THEN NULL ELSE events_raw.curated_at END`, { etMidnight }),
    curation_note: db.raw(`CASE WHEN ${REVIVAL_COND} THEN NULL ELSE events_raw.curation_note END`, { etMidnight }),
  };
}

let Parser;
try {
  Parser = require('rss-parser');
} catch {
  Parser = null;
}

let ical;
try {
  ical = require('node-ical');
} catch {
  ical = null;
}

// Playwright + Anthropic SDK for the scrape handler. Both are already
// in workspace deps (Playwright via root package.json, Anthropic via
// other server services). Wrap the require() in try/catch so a fresh
// install missing them doesn't crash the whole ingestion service.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}

const MODELS = require('../config/models');

const HTTP_TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_FEED = 200;
const FORWARD_WINDOW_DAYS = 90;

// Best-effort city extraction from venue / location strings. Falls back
// to null when nothing recognizable. The full geocoding pass lives in
// P3b — this is just enough to populate the dashboard tile's city
// label without a Google Geocoding API call per event.
const KNOWN_CITIES = [
  'tampa', 'st petersburg', 'st pete', 'clearwater', 'gulfport',
  'bradenton', 'palmetto', 'parrish', 'lakewood ranch', 'ellenton',
  'sarasota', 'siesta key', 'longboat key', 'venice', 'nokomis',
  'osprey', 'north port', 'englewood', 'port charlotte', 'punta gorda',
  'wellen park', 'cortez', 'anna maria',
];

function extractCity(text) {
  if (!text || typeof text !== 'string') return null;
  const haystack = text.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (haystack.includes(city)) return city.replace(/\s+/g, ' ');
  }
  return null;
}

function parseDateOrNull(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    // `d` is scoped to the try block — return null directly so a single
    // malformed feed date doesn't fail the whole source ingestion run.
    return null;
  }
}

// Allowlist URL protocols. RSS data is external/untrusted; rendering a
// `javascript:` (or `data:`, etc.) URL into an <a href> would execute on
// click. Apply at ingestion boundary so bad URLs never reach the DB,
// AND at render boundary on the client (defense in depth).
function safeHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Returns the dedup key for an RSS item. `guid` is the standard but
// some feeds omit it; fall back to `link` then a synthetic hash.
function externalIdFor(item) {
  if (item.guid) return String(item.guid).slice(0, 256);
  if (item.link) return String(item.link).slice(0, 256);
  // Synthetic fallback — lossy but stable enough that re-pulls match.
  return `${(item.title || '').slice(0, 100)}|${item.pubDate || ''}`.slice(0, 256);
}

async function pullRssSource(source) {
  if (!Parser) {
    throw new Error('rss-parser not installed');
  }
  const parser = new Parser({
    timeout: HTTP_TIMEOUT_MS,
    headers: {
      // Polite bot UA by default. Some hosts (e.g. The Gabber's WP Engine
      // host) UA-filter anything that isn't a real browser — those sources
      // set scrape_config.userAgent to a browser string instead of being
      // abandoned. Per-source override, not global, so we stay identifiable
      // everywhere we're allowed to be.
      'User-Agent': source.scrape_config?.userAgent
        || 'Mozilla/5.0 (compatible; WavesNewsletterBot/1.0; +https://portal.wavespestcontrol.com)',
    },
  });

  const feed = await parser.parseURL(source.feed_url);
  const items = (feed.items || []).slice(0, MAX_ITEMS_PER_FEED);

  // RSS feeds come in two shapes, selected per-source via
  // scrape_config.rssMode:
  //
  //   'news' (DEFAULT) — items are ARTICLES (weekend roundups, "things
  //     to do" columns, municipal announcements). item.pubDate is the
  //     publication date, NOT an event date — writing it to start_at
  //     dates every event "yesterday at pull time", so nothing ever
  //     lands in the forward digest window and tier-1 auto-approval
  //     seeds junk (council agendas) into the approved pool. Articles
  //     are bundled and run through the same Claude extraction as
  //     scrape sources to pull real event dates out of the text;
  //     articles with no dated event yield nothing.
  //
  //   'calendar' — items ARE events and the item date is the event
  //     start. Opt-in only: every RSS source live today is a news
  //     feed, and pubDate-as-event-date is the default failure mode
  //     of a newly added RSS source, so news is the safe default.
  const rssMode = source.scrape_config?.rssMode === 'calendar' ? 'calendar' : 'news';
  if (rssMode === 'news') {
    return pullNewsRssItems(source, items);
  }

  const cutoffMs = Date.now() + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let upserted = 0;
  let dropped = 0;

  for (const item of items) {
    const start = parseDateOrNull(item.isoDate || item.pubDate);
    // Drop events scheduled more than 90d out (we'd never write about
    // them in a near-term newsletter). NULL start_at is fine — those
    // are evergreen items (ongoing markets, exhibits) we keep.
    if (start && start.getTime() > cutoffMs) { dropped += 1; continue; }
    // Drop events that already happened more than 24h ago. Some RSS
    // feeds publish post-event recaps; we don't want them in tiles.
    if (start && start.getTime() < now - 24 * 60 * 60 * 1000) { dropped += 1; continue; }

    const externalId = externalIdFor(item);
    const title = (item.title || '(untitled)').slice(0, 512);
    const description = item.contentSnippet || item.content || item.summary || null;
    // Reject non-http(s) URLs at the ingestion boundary so a compromised
    // RSS feed can't seed `javascript:` (or other) links into the DB.
    const eventUrl = safeHttpUrl(item.link);
    const imageUrl = safeHttpUrl(item.enclosure?.url || item['itunes:image']?.href);
    const categories = Array.isArray(item.categories) && item.categories.length
      ? JSON.stringify(item.categories.map(String))
      : null;

    // Best-effort city from title + description; falls back to source
    // coverage_geo[0] so the tile always has *something*.
    const city = extractCity(title) || extractCity(description) || (source.coverage_geo?.[0] || null);
    const autoApprove = source.priority_tier === 1;

    await db('events_raw')
      .insert({
        source_id: source.id,
        external_id: externalId,
        title,
        description,
        start_at: start,
        venue_name: null, // P3b normalizer pulls these from description
        venue_address: null,
        city,
        event_url: eventUrl,
        image_url: imageUrl,
        categories,
        ...(autoApprove && { admin_status: 'approved' }),
      })
      .onConflict(['source_id', 'external_id'])
      .merge({
        title,
        description,
        start_at: start,
        city,
        event_url: eventUrl,
        image_url: imageUrl,
        categories,
        pulled_at: db.fn.now(),
        updated_at: db.fn.now(),
        ...revivalResetFields(),
      });

    upserted += 1;
  }

  return { upserted, dropped, total: items.length };
}

// ── Shared Claude event extraction ──────────────────────────────────
// Used by both the scrape handler (page mode: raw HTML from Playwright)
// and the news-RSS handler (articles mode: bundled feed items). One
// Claude call per source per run either way.

// Per-article cap keeps one long-form post from crowding everything
// else out of the bundle; the bundle cap matches the scrape handler's
// HTML truncation so both modes send Claude the same input budget.
const MAX_ARTICLE_CHARS = 2500;
const MAX_BUNDLE_CHARS = 25000;

// Bundle RSS article items into one labeled text document for
// extraction. Items are taken in feed order (newest first on every
// live feed) until the bundle budget is spent.
function buildArticleBundle(items) {
  const parts = [];
  let used = 0;
  for (const item of items) {
    // Prefer the FULL article body over the description teaser:
    // rss-parser maps <content:encoded> to item['content:encoded'] /
    // ['content:encodedSnippet'] (plain-text), while contentSnippet /
    // content come from <description>. Feeds that tease in the
    // description carry their event dates only in the encoded body.
    const content = String(
      item['content:encodedSnippet'] || item['content:encoded']
      || item.contentSnippet || item.content || item.summary || '',
    ).slice(0, MAX_ARTICLE_CHARS);
    const image = safeHttpUrl(item.enclosure?.url || item['itunes:image']?.href);
    const part = [
      `### Article ${parts.length + 1}`,
      `Title: ${item.title || '(untitled)'}`,
      `URL: ${item.link || '(none)'}`,
      `Published: ${item.isoDate || item.pubDate || '(unknown)'}`,
      image ? `Image: ${image}` : null,
      `Content: ${content}`,
    ].filter(Boolean).join('\n');
    if (used + part.length > MAX_BUNDLE_CHARS) break;
    parts.push(part);
    used += part.length;
  }
  return { text: parts.join('\n\n'), bundled: parts.length };
}

function buildExtractionSystemPrompt(source, maxEvents, mode, todayIso) {
  const intro = mode === 'articles'
    ? 'You extract upcoming public events from recent articles in a Southwest Florida local-news RSS feed.'
    : 'You extract upcoming public events from raw HTML scraped from a Southwest Florida event-listing page.';

  const modeRules = mode === 'articles'
    ? [
      '- The input is one or more articles. A single article (weekend roundup, "things to do" column) often describes several distinct events — extract each one.',
      "- An article's Published date is NOT the event date. Only use event dates stated in the text. If no specific event date is stated, skip that event.",
      "- For eventUrl: use the event's own detail-page URL when the article includes one; otherwise use the article's URL.",
      '- For imageUrl: use the article\'s Image line only when the article clearly covers that single event; null when ambiguous.',
    ]
    : [];

  return `${intro}

Today's date: ${todayIso}. Source: ${source.name} (${source.url}).

Output STRICT JSON only, no prose, with this shape:
{
  "events": [
    {
      "title": "string, the event name",
      "startAt": "ISO 8601 datetime in America/New_York timezone, or null if no specific date is given",
      "venueName": "string or null",
      "city": "lowercase city slug — sarasota | bradenton | venice | tampa | st-petersburg | clearwater | gulfport | punta-gorda | port-charlotte | englewood | north-port | lakewood-ranch | parrish | palmetto | anna-maria | siesta-key | longboat-key | etc — or null if not determinable",
      "description": "string, 1-2 short sentences describing why someone would go. May be null if no description is on the page.",
      "eventUrl": "absolute http(s) URL to the event detail page, or null",
      "imageUrl": "absolute http(s) URL of an image clearly associated with this event, or null"
    }
  ]
}

Rules:
- Skip events with no title.
- Skip events that already happened (date < today).
- Skip events more than 90 days out.
- Skip recurring/series rows that don't have a specific upcoming instance.
- Skip "View all events" or navigation links.
- Skip government/administrative items: council, committee, or board meetings, agendas, public hearings, workshops, and procurement/RFP/bid notices. Readers want things to DO, not civic process.
${modeRules.length ? `${modeRules.join('\n')}\n` : ''}- Cap output at ${maxEvents} events.
- If you can't find events, return {"events": []}.
- Return JSON only — no code fence, no commentary.`;
}

// Recover complete event objects from a possibly-truncated JSON array.
// The model emits {"events":[ {...}, {...}, ... ]}; when the response hits
// the max_tokens ceiling the trailing object is cut off mid-string and the
// whole blob fails JSON.parse (V8: "Expected ',' or ']' after array
// element …"). Rather than fail the entire pull — which trips the source's
// consecutive_failures and fires a health alert (this was The Gabber's
// 24-failed-pulls alarm) — walk the events array and keep every object that
// closed cleanly, dropping only the partial tail.
function recoverEventObjectsFromTruncatedJson(text) {
  const eventsKey = text.indexOf('"events"');
  if (eventsKey === -1) return null;
  const arrStart = text.indexOf('[', eventsKey);
  if (arrStart === -1) return null;

  const objects = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = arrStart + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) objStart = i; depth += 1; }
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && objStart !== -1) { objects.push(text.slice(objStart, i + 1)); objStart = -1; }
    } else if (ch === ']' && depth === 0) break; // clean end of array
  }
  if (!objects.length) return null;
  const events = [];
  for (const obj of objects) {
    try { events.push(JSON.parse(obj)); } catch { /* skip a malformed object */ }
  }
  return events.length ? events : null;
}

async function extractEventsWithClaude(source, content, { mode, maxEvents }) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // Anchor "today" in America/New_York, not UTC. The cron runs at 4am ET
  // which is in the UTC-day-overlap region; without ET anchoring the
  // prompt could tell Claude the wrong day and a same-evening event
  // gets filtered as already past, or the 90-day cutoff shifts by ±1d.
  const todayIso = etDateString(new Date());
  const systemPrompt = buildExtractionSystemPrompt(source, maxEvents, mode, todayIso);
  const wrapped = mode === 'articles' ? `<articles>\n${content}\n</articles>` : `<html>\n${content}\n</html>`;

  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    // Headroom for the full maxEvents (≤30) list. The old 2000-token cap
    // truncated event-dense feeds mid-array (~4KB of JSON), which then
    // failed JSON.parse and hard-failed the pull; ~250 tokens/event needs
    // well north of that to emit 30 complete objects.
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: wrapped }],
  });
  const text = response.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return JSON for event extraction');
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    // Defense-in-depth against truncation even with the raised cap:
    // salvage the complete event objects instead of dropping the pull.
    const recovered = recoverEventObjectsFromTruncatedJson(text);
    if (!recovered) throw err;
    logger.warn(
      `[event-ingestion] recovered ${recovered.length} event(s) from truncated JSON for source ${source.id} (${source.name || source.feed_url})`,
    );
    parsed = { events: recovered };
  }
  return Array.isArray(parsed.events) ? parsed.events.slice(0, maxEvents) : [];
}

/**
 * Validate one Claude-extracted event and shape it for upsert.
 * Pure — returns null when the event should be dropped, else
 * { row, autoApprove } where row holds the events_raw columns.
 *
 * opts.requireStart — drop events without a parseable start date.
 * News-mode RSS sets this: the articles contract says "no stated event
 * date → no event", and an undated article summary can never enter the
 * digest but WOULD clutter the inbox/dashboard (the events endpoint
 * includes NULL start_at rows). Page mode keeps undated events —
 * ongoing exhibits/markets on real event pages are legitimate.
 */
function normalizeExtractedEvent(source, ev, nowMs, opts = {}) {
  const cutoffMs = nowMs + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const title = (ev.title || '').toString().trim().slice(0, 512);
  if (!title) return null;

  const start = parseDateOrNull(ev.startAt);
  if (opts.requireStart && !start) return null;
  if (start && start.getTime() > cutoffMs) return null;
  if (start && start.getTime() < nowMs - 24 * 60 * 60 * 1000) return null;

  // Compute canonicalized fields BEFORE the dedup key so the key is
  // stable across pulls. Claude's raw startAt/eventUrl strings can
  // drift between runs (different timezone formatting, trailing
  // slashes, etc) — the parsed Date's toISOString() and the
  // safeHttpUrl() canonical form don't.
  const description = ev.description ? String(ev.description).slice(0, 2000) : null;
  const venueName = ev.venueName ? String(ev.venueName).slice(0, 256) : null;
  const eventUrl = safeHttpUrl(ev.eventUrl);
  const imageUrl = safeHttpUrl(ev.imageUrl);

  // Synthesize a stable dedup key from canonical title+date+url.
  // Extracted events don't have a UID/guid, so we key on the
  // post-normalization fields. Title is lowercased so casing drift
  // from Claude (e.g. "Boat Parade" vs "BOAT PARADE") doesn't
  // create duplicates either.
  const titleKey = title.toLowerCase().slice(0, 80);
  const startKey = start ? start.toISOString() : '';
  const urlKey = eventUrl || '';
  const externalId = `${titleKey}|${startKey}|${urlKey}`.slice(0, 256);

  // Clamp to varchar(128) — events_raw.city per migration
  // 20260427000003. Claude can return long location strings; without
  // the slice the INSERT throws "value too long for type character
  // varying(128)" and bubbles out of the loop, failing the whole
  // source pull and dropping remaining events.
  const city = (typeof ev.city === 'string' && ev.city.trim())
    ? ev.city.trim().toLowerCase().slice(0, 128)
    : (source.coverage_geo?.[0] || null);

  // Tier-1 auto-approve additionally requires a real extracted start
  // date. An undated event can never enter the digest (eligibility
  // requires start_at), so pre-approving it only seeds unreviewed
  // rows into the approved pool.
  const autoApprove = source.priority_tier === 1 && Boolean(start);

  return {
    autoApprove,
    row: {
      source_id: source.id,
      external_id: externalId,
      title,
      description,
      start_at: start,
      venue_name: venueName,
      city,
      event_url: eventUrl,
      image_url: imageUrl,
    },
  };
}

async function upsertExtractedEvents(source, claudeEvents, opts = {}) {
  const nowMs = Date.now();
  let upserted = 0;
  let dropped = 0;

  for (const ev of claudeEvents) {
    const normalized = normalizeExtractedEvent(source, ev, nowMs, opts);
    if (!normalized) { dropped += 1; continue; }
    const { row, autoApprove } = normalized;

    await db('events_raw')
      .insert({
        ...row,
        ...(autoApprove && { admin_status: 'approved' }),
      })
      .onConflict(['source_id', 'external_id'])
      .merge({
        title: row.title,
        description: row.description,
        start_at: row.start_at,
        venue_name: row.venue_name,
        city: row.city,
        event_url: row.event_url,
        image_url: row.image_url,
        pulled_at: db.fn.now(),
        updated_at: db.fn.now(),
        ...revivalResetFields(),
      });

    upserted += 1;
  }

  return { upserted, dropped };
}

// News-mode RSS: bundle the feed's articles and extract real, dated
// events from their text. Returns the same shape as the other pull
// handlers so ingestSource logging/health stays uniform.
async function pullNewsRssItems(source, items) {
  if (!items.length) return { upserted: 0, dropped: 0, total: 0 };
  const cfg = source.scrape_config || {};
  const maxEvents = Math.max(3, Math.min(30, Number(cfg.maxEvents) || 15));

  const { text, bundled } = buildArticleBundle(items);
  if (!text.trim()) return { upserted: 0, dropped: 0, total: 0 };

  const claudeEvents = await extractEventsWithClaude(source, text, { mode: 'articles', maxEvents });
  // requireStart: the articles contract is "no stated event date → no
  // event" — enforce it even when the model ignores the prompt rule.
  const { upserted, dropped } = await upsertExtractedEvents(source, claudeEvents, { requireStart: true });
  return { upserted, dropped, total: claudeEvents.length, articlesBundled: bundled };
}

// node-ical's `vevent` records use unconventional shapes:
//   - .uid is the dedup key (RFC 5545 UID)
//   - .start / .end are JS Date objects already (when present)
//   - .summary is the title
//   - .description is the body (may contain HTML or plain text)
//   - .location is a free-form venue/address string
//   - .url is the event URL (when present)
//   - Recurring events expose .rrule with an .options.rrule string;
//     we don't expand recurrences in this PR — only the base event
//     is ingested. P3b can layer on rrule expansion if needed.
async function pullIcalSource(source) {
  if (!ical) {
    throw new Error('node-ical not installed');
  }

  // node-ical exposes a fromURL helper that handles the fetch +
  // parse in one shot. The default 5s timeout is too tight for some
  // CivicPlus / GrowthZone feeds that serve large calendars; bump
  // to match the RSS timeout (15s).
  const events = await new Promise((resolve, reject) => {
    ical.async.fromURL(
      source.feed_url,
      {
        timeout: HTTP_TIMEOUT_MS,
        headers: {
          // Polite bot UA by default; per-source browser-UA override for
          // hosts that UA-filter bots (e.g. Visit Venice's WAF serves the
          // iCal feed a 403 to non-browser UAs). Same convention as RSS.
          'User-Agent': source.scrape_config?.userAgent
            || 'Mozilla/5.0 (compatible; WavesNewsletterBot/1.0; +https://portal.wavespestcontrol.com)',
        },
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(data || {});
      },
    );
  });

  // node-ical returns an object keyed by UID with mixed types
  // (vevent, vcalendar, vtimezone, etc). Filter to vevent only.
  const vevents = Object.values(events)
    .filter((e) => e && e.type === 'VEVENT')
    .slice(0, MAX_ITEMS_PER_FEED);

  const cutoffMs = Date.now() + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let upserted = 0;
  let dropped = 0;

  for (const ev of vevents) {
    const start = parseDateOrNull(ev.start);
    const end = parseDateOrNull(ev.end);

    if (start && start.getTime() > cutoffMs) { dropped += 1; continue; }
    if (start && start.getTime() < now - 24 * 60 * 60 * 1000) { dropped += 1; continue; }

    // UID is the standard iCal dedup key (RFC 5545). Always present
    // on real feeds; synthesize from title+start as a fallback for
    // malformed feeds that omit it.
    const externalId = String(ev.uid || `${(ev.summary || '').slice(0, 100)}|${ev.start || ''}`).slice(0, 256);
    const title = (ev.summary || '(untitled)').toString().slice(0, 512);
    const description = ev.description ? String(ev.description) : null;
    const eventUrl = safeHttpUrl(ev.url);
    const venueName = ev.location ? String(ev.location).slice(0, 256) : null;

    // Best-effort city from title/description/location; falls back to
    // source.coverage_geo[0] just like the RSS handler.
    const city = extractCity(title)
      || extractCity(description)
      || extractCity(venueName)
      || (source.coverage_geo?.[0] || null);
    const autoApprove = source.priority_tier === 1;

    await db('events_raw')
      .insert({
        source_id: source.id,
        external_id: externalId,
        title,
        description,
        start_at: start,
        end_at: end,
        venue_name: venueName,
        venue_address: null,
        city,
        event_url: eventUrl,
        image_url: null, // iCal spec doesn't carry images
        categories: null,
        ...(autoApprove && { admin_status: 'approved' }),
      })
      .onConflict(['source_id', 'external_id'])
      .merge({
        title,
        description,
        start_at: start,
        end_at: end,
        venue_name: venueName,
        city,
        event_url: eventUrl,
        pulled_at: db.fn.now(),
        updated_at: db.fn.now(),
        ...revivalResetFields(),
      });

    upserted += 1;
  }

  return { upserted, dropped, total: vevents.length };
}

// Playwright + Claude scrape handler. For SPA event aggregators that
// don't expose RSS or iCal (Visit Sarasota, Visit Tampa Bay, Patch.com,
// chamber-of-commerce calendar pages, etc.). Flow:
//
//   1. Playwright launches headless Chromium, navigates to feed_url,
//      waits for network-idle so the SPA hydrates.
//   2. Optionally selects the listing container (per
//      source.scrape_config.contentSelector — defaults to <body>).
//      Falls back to body if the selector isn't found.
//   3. Strips scripts/styles, takes the inner HTML, truncates to
//      ~25k chars (more than enough for ~30 event tiles, well under
//      Claude's input cap with margin).
//   4. Sends to Claude (WORKHORSE) with a strict-JSON-output prompt
//      asking for {events: [{title, startAt, venueName, city, description, eventUrl}]}.
//   5. Validates each event, applies the same forward-window +
//      recap-drop filters as RSS/iCal, upserts into events_raw.
//
// Per-source flexibility lives in event_sources.scrape_config (jsonb):
//   - contentSelector?: CSS selector for the listing container
//   - waitForSelector?: optional selector to await before extraction
//   - maxEvents?:        cap on events Claude is asked to extract (default 15)
//
// Cost: ~$0.05/scrape with WORKHORSE on a 25k-char SPA. At a daily
// cron with 5-10 scrape sources, that's ~$0.25-0.50/day.
//
// Browser lifecycle: caller (ingestSource) opens one browser per
// scrape pull. For high-volume scraping we'd reuse a browser across
// multiple sources in one ingest run — current volume doesn't justify
// the bookkeeping; revisit if scrape source count grows past ~10.
async function pullScrapeSource(source) {
  if (!chromium) throw new Error('playwright not installed');
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }

  const cfg = source.scrape_config || {};
  const contentSelector = cfg.contentSelector || 'body';
  const waitForSelector = cfg.waitForSelector || null;
  const maxEvents = Math.max(3, Math.min(30, Number(cfg.maxEvents) || 15));
  // DMO/tourism sites run analytics + ad beacons that keep the network
  // busy indefinitely — goto(networkidle) at 15s hard-failed Visit
  // Sarasota / Visit St. Pete every day for weeks. Land on
  // domcontentloaded (30s ceiling, overridable per source), then give
  // hydration a best-effort settle window instead of a hard gate.
  const gotoTimeoutMs = Math.max(5000, Math.min(60000, Number(cfg.gotoTimeoutMs) || 30000));

  const browser = await chromium.launch({ headless: true });
  let html;
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; WavesNewsletterBot/1.0; +https://portal.wavespestcontrol.com)',
      viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();
    const response = await page.goto(source.feed_url, { timeout: gotoTimeoutMs, waitUntil: 'domcontentloaded' });
    // A bot wall / 404 serves a perfectly parseable error page — without
    // this gate the LLM extracts zero events from "Access Denied" and the
    // pull records a healthy 'success' (the Akamai-walled city sites sat
    // green for weeks while yielding nothing). Surface it as the failure
    // it is so consecutive_failures/health escalation see it.
    if (response && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} from ${source.feed_url}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: HTTP_TIMEOUT_MS }).catch(() => {});
    }
    // Pull the listing container (or body), strip scripts/styles in-page
    // before extracting innerHTML so we don't send useless markup to
    // Claude. Falls back to body if the selector misses OR if the
    // selector itself is invalid CSS (operator typo in scrape_config
    // would otherwise throw a SyntaxError that fails the whole pull
    // every run until edited).
    html = await page.evaluate((sel) => {
      let root = document.body;
      if (sel && sel !== 'body') {
        try {
          const found = document.querySelector(sel);
          if (found) root = found;
        } catch {
          // Invalid CSS selector — degrade to body.
        }
      }
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, svg').forEach((n) => n.remove());
      return clone.innerHTML || '';
    }, contentSelector);
  } finally {
    await browser.close().catch(() => {});
  }

  // Truncate. Cheap insurance against runaway pages. Default 25k;
  // per-source override (clamped to 60k) for heavy page-builder sites
  // (Selby's Divi markup runs 796KB — its server-rendered events sat
  // past the cut, so extraction silently saw none) — prefer setting
  // contentSelector first, the budget bump is the fallback.
  const TRUNC = Math.max(10000, Math.min(60000, Number(cfg.maxHtmlChars) || 25000));
  const truncated = html.length > TRUNC ? html.slice(0, TRUNC) : html;

  // Shared Claude extraction + validated upsert — same path the
  // news-RSS handler uses, in page mode.
  const claudeEvents = await extractEventsWithClaude(source, truncated, { mode: 'page', maxEvents });
  const { upserted, dropped } = await upsertExtractedEvents(source, claudeEvents);
  return { upserted, dropped, total: claudeEvents.length };
}

async function ingestSource(source) {
  const startedAt = Date.now();
  try {
    let result;
    if (source.feed_type === 'rss') {
      result = await pullRssSource(source);
    } else if (source.feed_type === 'ical') {
      result = await pullIcalSource(source);
    } else if (source.feed_type === 'scrape') {
      result = await pullScrapeSource(source);
    } else {
      // 'json' not implemented yet — skip gracefully so the cron can
      // pre-seed sources without failing. Don't increment
      // consecutive_failures (those are for real failures).
      logger.warn(`[event-ingestion] Skipping ${source.name} — feed_type=${source.feed_type} not implemented yet`);
      return { source: source.name, skipped: true };
    }

    await db('event_sources').where({ id: source.id }).update({
      last_pulled_at: db.fn.now(),
      last_pull_status: 'success',
      last_error: null,
      consecutive_failures: 0,
      // Zero-yield tracking: a pull that "succeeds" with 0 events run
      // after run is a broken source wearing a green badge.
      ...yieldTrackingUpdateFor(result.upserted || 0),
      updated_at: db.fn.now(),
    });

    const ms = Date.now() - startedAt;
    logger.info(
      `[event-ingestion] ${source.name}: ${result.upserted} upserted, ${result.dropped} dropped (window/recap), ${ms}ms`
    );
    return { source: source.name, ...result, ms };
  } catch (err) {
    const ms = Date.now() - startedAt;
    await db('event_sources').where({ id: source.id })
      .update({
        last_pulled_at: db.fn.now(),
        last_pull_status: 'error',
        last_error: String(err.message || err).slice(0, 1024),
        consecutive_failures: db.raw('consecutive_failures + 1'),
        updated_at: db.fn.now(),
      });
    logger.error(`[event-ingestion] ${source.name} FAILED in ${ms}ms: ${err.message}`);
    return { source: source.name, error: err.message, ms };
  }
}

/**
 * Run all enabled sources in priority order. Sources are pulled
 * sequentially (not parallel) — the volume is small (~6-20 sources)
 * and serial keeps log lines coherent + avoids hammering any single
 * shared CDN if multiple feeds happen to be on the same provider.
 */
async function ingestAllEnabledSources() {
  const sources = await db('event_sources')
    .where({ enabled: true })
    .orderBy('priority_tier', 'asc')
    .orderBy('name', 'asc');

  if (!sources.length) {
    logger.info('[event-ingestion] No enabled sources — nothing to do');
    return { sources: 0, results: [] };
  }

  logger.info(`[event-ingestion] Starting pull for ${sources.length} enabled source(s)`);
  const results = [];
  for (const source of sources) {
    results.push(await ingestSource(source));
  }
  const totalUpserted = results.reduce((sum, r) => sum + (r.upserted || 0), 0);
  const failed = results.filter((r) => r.error).length;
  logger.info(
    `[event-ingestion] Done: ${totalUpserted} upserted across ${sources.length} source(s), ${failed} failed`
  );

  // Escalate unhealthy sources (hard failures + zero-yield streaks) —
  // one notification per run at most, never fails the ingest.
  try {
    await checkAndNotifySourceHealth();
  } catch (err) {
    logger.warn(`[event-ingestion] source-health check failed: ${err.message}`);
  }

  return { sources: sources.length, totalUpserted, failed, results };
}

module.exports = {
  ingestAllEnabledSources,
  ingestSource, // exported for ad-hoc admin-triggered pulls
  revivalResetFields, // exported for unit testing the past→future revival SQL
  // Exported for unit tests — pure pieces of the shared extraction path.
  buildArticleBundle,
  buildExtractionSystemPrompt,
  normalizeExtractedEvent,
  recoverEventObjectsFromTruncatedJson,
};
