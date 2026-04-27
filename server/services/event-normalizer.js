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

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}
const MODELS = require('../config/models');

const MAX_BATCH = 50;

async function extractVenueFromClaude({ title, description, existingVenue, city }) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You normalize event-listing metadata. Given a raw event, extract:
- venueName: the human name of the venue (e.g., "Van Wezel Performing Arts Hall", "Selby Gardens", "Mote Marine Lab"). Null if the event has no specific physical venue (online-only, "various locations", etc.) or you can't tell.
- venueAddress: a single-line full street address geocodable by Google Maps (e.g., "777 N Tamiami Trail, Sarasota, FL 34236"). Include city + state when inferable. Null if you can't determine a real address. Don't invent.

Output STRICT JSON only, no prose:
{ "venueName": "string or null", "venueAddress": "string or null" }`;

  const userPrompt = `Title: ${title || '(none)'}
City context: ${city || '(unknown)'}
Existing venueName (may be null or partial): ${existingVenue || '(none)'}
Description:
${description || '(none)'}`;

  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = response.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    venueName: typeof parsed.venueName === 'string' ? parsed.venueName.trim() : null,
    venueAddress: typeof parsed.venueAddress === 'string' ? parsed.venueAddress.trim() : null,
  };
}

async function normalizeRow(row) {
  // Skip threshold — no content for Claude to work with. Mark
  // normalized so we don't retry every cron.
  if (!row.description && !row.venue_name) {
    await db('events_raw').where({ id: row.id }).update({
      normalized_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    return { id: row.id, skipped: 'no_content' };
  }

  const updates = {};
  let claudeCalled = false;
  let geocodeCalled = false;

  // Stage 1: Claude pass (only if venue info is missing)
  if (!row.venue_name || !row.venue_address) {
    claudeCalled = true;
    const extracted = await extractVenueFromClaude({
      title: row.title,
      description: row.description,
      existingVenue: row.venue_name,
      city: row.city,
    });
    if (extracted.venueName && !row.venue_name) {
      // Match column lengths in 20260427000003: venue_name varchar(256)
      updates.venue_name = extracted.venueName.slice(0, 256);
      row.venue_name = updates.venue_name;
    }
    if (extracted.venueAddress && !row.venue_address) {
      // venue_address varchar(512)
      updates.venue_address = extracted.venueAddress.slice(0, 512);
      row.venue_address = updates.venue_address;
    }
  }

  // Stage 2: geocode pass (only if address is set and lat/lng missing)
  if (row.venue_address && (row.geo_lat == null || row.geo_lng == null)) {
    geocodeCalled = true;
    const geo = await geocodeAddress(row.venue_address);
    if (geo) {
      updates.geo_lat = geo.lat;
      updates.geo_lng = geo.lng;
    }
  }

  // Always set normalized_at — even if Claude returned both nulls
  // or geocode failed. The dashboard can still show what we have;
  // operator clears the column to force a retry.
  updates.normalized_at = db.fn.now();
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
