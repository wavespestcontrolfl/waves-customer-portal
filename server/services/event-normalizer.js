/**
 * Newsletter event normalizer (P3b leg 3). Two-stage enrichment for
 * rows in events_raw that the ingestion handlers (RSS / iCal /
 * scrape) couldn't fully populate:
 *
 *   1. Claude pass — for rows where venue_name OR venue_address is
 *      null, send title + description + city to Claude and ask for
 *      structured { venueName, venueAddress }.
 *   2. Geocode pass — for rows where venue_address is set but
 *      geo_lat / geo_lng are null, hit Google Geocoding API via the
 *      existing server/services/geocoder.js helper (DB-cached, has
 *      an in-process memo).
 *
 * Idempotency:
 *   - normalized_at is set on every processed row (even if Claude
 *     couldn't extract anything) so the cron doesn't re-charge for
 *     unfix-able rows. Operator can UPDATE events_raw SET
 *     normalized_at = NULL to force a retry.
 *   - On thrown errors (Claude API down, geocode API down) we leave
 *     normalized_at NULL so the next cron retries.
 *
 * Cost cap:
 *   - MAX_BATCH defaults to 50 rows per cron run. Claude WORKHORSE
 *     pricing on this prompt size is ~$0.015/row; geocode is
 *     ~$0.005/row → ~$1/day at 50 rows.
 *   - Sequential pulls (small volume, coherent logs).
 *
 * Skip threshold:
 *   - Rows with no description AND no venue_name are skipped (no
 *     content for Claude to work with). Their normalized_at is set
 *     anyway so they're not retried.
 */

const db = require('../models/db');
const logger = require('./logger');
const { geocodeAddress } = require('./geocoder');
const { classifyFreshness, cityToZone } = require('./event-freshness');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}
const MODELS = require('../config/models');

const MAX_BATCH = 50;

async function extractVenueAndFreshness({ title, description, existingVenue, city }) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You normalize event-listing metadata. Given a raw event, extract:

VENUE:
- venueName: the human name of the venue (e.g., "Van Wezel Performing Arts Hall", "Selby Gardens", "Mote Marine Lab"). Null if the event has no specific physical venue (online-only, "various locations", etc.) or you can't tell.
- venueAddress: a single-line full street address geocodable by Google Maps (e.g., "777 N Tamiami Trail, Sarasota, FL 34236"). Include city + state when inferable. Null if you can't determine a real address. Don't invent.

EVENT CLASSIFICATION:
- eventType: one of "one_time" | "annual" | "limited_run" | "recurring_series" | "special_edition" | "ongoing" | "unknown"
  • one_time = happens once (a specific festival date, a grand opening, a concert)
  • annual = happens once per year (annual festival, yearly fundraiser)
  • limited_run = runs for a set period then ends (art exhibit, multi-day festival, seasonal market with an end date)
  • recurring_series = repeats regularly with no end date (weekly market, monthly meetup, weekly trivia)
  • special_edition = a special/themed version of an otherwise recurring event
  • ongoing = permanent attraction or always-available (museum, park — not really an "event")
  • unknown = can't determine from the listing
- recurrenceType: one of "none" | "daily" | "weekly" | "monthly" | "seasonal" | "annual" | "custom" | "unknown"
- familyFriendly: true if clearly family-oriented or all-ages, false if clearly adults-only, null if unclear
- isFree: true if free/no-cost, false if paid, null if unclear

Output STRICT JSON only, no prose:
{ "venueName": "string or null", "venueAddress": "string or null", "eventType": "string", "recurrenceType": "string", "familyFriendly": "boolean or null", "isFree": "boolean or null" }`;

  const userPrompt = `Title: ${title || '(none)'}
City context: ${city || '(unknown)'}
Existing venueName (may be null or partial): ${existingVenue || '(none)'}
Description:
${description || '(none)'}`;

  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = response.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  const VALID_EVENT_TYPES = ['one_time', 'annual', 'limited_run', 'recurring_series', 'special_edition', 'ongoing', 'unknown'];
  const VALID_RECURRENCE_TYPES = ['none', 'daily', 'weekly', 'monthly', 'seasonal', 'annual', 'custom', 'unknown'];

  return {
    venueName: typeof parsed.venueName === 'string' ? parsed.venueName.trim() : null,
    venueAddress: typeof parsed.venueAddress === 'string' ? parsed.venueAddress.trim() : null,
    eventType: VALID_EVENT_TYPES.includes(parsed.eventType) ? parsed.eventType : 'unknown',
    recurrenceType: VALID_RECURRENCE_TYPES.includes(parsed.recurrenceType) ? parsed.recurrenceType : 'unknown',
    familyFriendly: typeof parsed.familyFriendly === 'boolean' ? parsed.familyFriendly : null,
    isFree: typeof parsed.isFree === 'boolean' ? parsed.isFree : null,
  };
}

// Backward compat — old callers that only need venue data
async function extractVenueFromClaude(args) {
  const result = await extractVenueAndFreshness(args);
  return { venueName: result.venueName, venueAddress: result.venueAddress };
}

async function normalizeRow(row) {
  const updates = {};

  // Revival recompute (independent of content extraction): when ingestion
  // flagged a genuine past→future re-date via the explicit
  // freshness_revival_pending marker — never inferred from normalized_at IS NULL,
  // which a geocode re-queue could also cause — recompute freshness directly and
  // clear the one-shot marker. Done BEFORE the no-content early return so a
  // revived row that happens to lack description/venue still gets handled rather
  // than left stuck 'expired'/'stale_recurring'. Gated to the terminal states
  // revival concerns, a known event_type, and an effective date today-or-later
  // in ET (same ET-midnight cutoff as ingestion + the expiry sweep). The Claude
  // freshness pass below only runs for unknown event_type, so it never collides.
  if (row.freshness_revival_pending) {
    const etMidnightToday = parseETDateTime(`${etDateString()}T00:00:00`);
    if (['expired', 'stale_recurring'].includes(row.freshness_status)
        && row.event_type && row.event_type !== 'unknown'
        && new Date(row.end_at || row.start_at) >= etMidnightToday) {
      const { freshness_status, freshness_score } = classifyFreshness({
        event_type: row.event_type,
        times_featured: row.times_featured || 0,
        start_at: row.start_at,
        end_at: row.end_at,
      });
      updates.freshness_status = freshness_status;
      updates.freshness_score = freshness_score;
    }
    updates.freshness_revival_pending = false; // one-shot, whether or not recomputed
  }

  // Skip threshold — no content at all to work with. Has to consider
  // venue_address too: a row with venue_address set but no description
  // and no venue_name is still a valid candidate for Stage 2 geocoding.
  // Without this check, scrape-extracted "address-only" rows would be
  // marked normalized without ever being geocoded. Still persist any revival
  // updates computed above so the marker is cleared and freshness re-enters.
  if (!row.description && !row.venue_name && !row.venue_address) {
    await db('events_raw').where({ id: row.id }).update({
      ...updates,
      normalized_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    return { id: row.id, skipped: 'no_content' };
  }

  let claudeCalled = false;
  let geocodeCalled = false;

  // Stage 1: Claude pass — venue extraction + freshness classification
  // in a single API call. Always runs if venue is missing; also runs if
  // freshness fields haven't been classified yet (event_type = 'unknown').
  const needsVenue = !row.venue_name || !row.venue_address;
  const needsFreshness = !row.event_type || row.event_type === 'unknown';
  if (needsVenue || needsFreshness) {
    claudeCalled = true;
    const extracted = await extractVenueAndFreshness({
      title: row.title,
      description: row.description,
      existingVenue: row.venue_name,
      city: row.city,
    });
    if (extracted.venueName && !row.venue_name) {
      updates.venue_name = extracted.venueName.slice(0, 256);
      row.venue_name = updates.venue_name;
    }
    if (extracted.venueAddress && !row.venue_address) {
      updates.venue_address = extracted.venueAddress.slice(0, 512);
      row.venue_address = updates.venue_address;
    }

    // Stage 3: Freshness classification (from the same Claude call)
    if (needsFreshness) {
      updates.event_type = extracted.eventType;
      updates.recurrence_type = extracted.recurrenceType;
      if (extracted.familyFriendly !== null) updates.family_friendly = extracted.familyFriendly;
      if (extracted.isFree !== null) updates.is_free = extracted.isFree;

      const { freshness_status, freshness_score } = classifyFreshness({
        event_type: extracted.eventType,
        times_featured: row.times_featured || 0,
        start_at: row.start_at,
        end_at: row.end_at,
      });
      updates.freshness_status = freshness_status;
      updates.freshness_score = freshness_score;
    }
  }

  // Derive region_zone from city if not already set
  if (!row.region_zone && row.city) {
    const zone = cityToZone(row.city);
    if (zone) updates.region_zone = zone;
  }

  // Stage 2: geocode pass (only if address is set and lat/lng missing)
  let geocodeAttempted = false;
  let geocodeSucceeded = false;
  if (row.venue_address && (row.geo_lat == null || row.geo_lng == null)) {
    geocodeAttempted = true;
    geocodeCalled = true;
    const geo = await geocodeAddress(row.venue_address);
    if (geo) {
      updates.geo_lat = geo.lat;
      updates.geo_lng = geo.lng;
      geocodeSucceeded = true;
    }
  }

  // Set normalized_at unless geocoding was attempted and returned null.
  // geocodeAddress() returns null indistinguishably for transient API
  // failures, missing GOOGLE_API_KEY, AND legitimate "no match" — so
  // marking the row done in any of those cases would hide recoverable
  // work after an outage or config fix (codex P2 on PR #337).
  // Trade-off: a permanently-hopeless address gets re-attempted every
  // cron run, bounded by MAX_BATCH * geocode-cost (~$0.005 each), so
  // worst case is a few cents/day until operator manually marks it
  // done via UPDATE events_raw SET normalized_at = NOW() WHERE id=...
  if (!geocodeAttempted || geocodeSucceeded) {
    updates.normalized_at = db.fn.now();
  }
  updates.updated_at = db.fn.now();
  await db('events_raw').where({ id: row.id }).update(updates);

  return {
    id: row.id,
    title: row.title,
    claudeCalled,
    geocodeCalled,
    fields: Object.keys(updates).filter((k) => k !== 'normalized_at' && k !== 'updated_at'),
  };
}

/**
 * Pull up to `limit` un-normalized rows (newest first), normalize
 * each. Errors per-row are logged but don't stop the batch — the
 * row's normalized_at stays NULL so the next cron retries.
 */
async function normalizeBatch(limit = MAX_BATCH) {
  const cap = Math.max(1, Math.min(MAX_BATCH, Number(limit) || MAX_BATCH));
  const rows = await db('events_raw')
    .whereNull('normalized_at')
    .orderBy('pulled_at', 'desc')
    .limit(cap);

  if (!rows.length) {
    logger.info('[event-normalizer] No un-normalized rows — nothing to do');
    return { processed: 0, results: [] };
  }

  logger.info(`[event-normalizer] Starting normalization for ${rows.length} row(s)`);
  const results = [];
  let claudeCalls = 0;
  let geocodeCalls = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const r = await normalizeRow(row);
      results.push(r);
      if (r.claudeCalled) claudeCalls += 1;
      if (r.geocodeCalled) geocodeCalls += 1;
    } catch (err) {
      errors += 1;
      logger.error(`[event-normalizer] Row ${row.id} (${row.title?.slice(0, 60)}) failed: ${err.message}`);
      // Don't update normalized_at — retry next cron run.
    }
  }
  logger.info(
    `[event-normalizer] Done: ${results.length} processed, ${claudeCalls} Claude calls, ${geocodeCalls} geocode calls, ${errors} errors`
  );
  return { processed: results.length, claudeCalls, geocodeCalls, errors, results };
}

module.exports = {
  normalizeBatch,
  normalizeRow, // exported for ad-hoc admin retries
};
