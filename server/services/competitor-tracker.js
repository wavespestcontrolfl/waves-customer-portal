const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

/**
 * Competitor Review Tracker
 *
 * Fetches a competitor's Google rating + review count via Places Details API,
 * updates competitor_businesses and appends a daily snapshot to competitor_review_cache.
 *
 * Usage:
 *   await CompetitorTracker.syncOne(competitorId);
 *   await CompetitorTracker.syncAll();
 */

async function fetchPlaceDetails(placeId) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,rating,user_ratings_total&key=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') throw new Error(`Places API: ${data.status}`);
  return {
    name: data.result?.name || null,
    rating: data.result?.rating || null,
    reviewCount: data.result?.user_ratings_total || null,
  };
}

async function syncOne(competitorId) {
  const row = await db('competitor_businesses').where({ id: competitorId }).first();
  if (!row) throw new Error('Competitor not found');
  const details = await fetchPlaceDetails(row.google_place_id);
  const today = etDateString();

  await db('competitor_businesses').where({ id: competitorId }).update({
    current_rating: details.rating,
    current_review_count: details.reviewCount,
    last_synced_at: db.fn.now(),
    updated_at: db.fn.now(),
  });

  // Upsert today's snapshot (one per day)
  try {
    await db('competitor_review_cache')
      .insert({
        competitor_id: competitorId,
        rating: details.rating,
        review_count: details.reviewCount,
        snapshot_date: today,
      })
      .onConflict(['competitor_id', 'snapshot_date'])
      .merge({ rating: details.rating, review_count: details.reviewCount });
  } catch (e) {
    logger.error(`[competitor-tracker] snapshot upsert failed: ${e.message}`);
  }

  return details;
}

async function syncAll() {
  const competitors = await db('competitor_businesses').where({ active: true });
  const results = { synced: 0, failed: 0, errors: [] };
  for (const c of competitors) {
    try {
      await syncOne(c.id);
      results.synced++;
    } catch (err) {
      results.failed++;
      results.errors.push({ name: c.name, error: err.message });
      logger.error(`[competitor-tracker] ${c.name}: ${err.message}`);
    }
  }
  return results;
}

async function getMarketPosition() {
  // Waves own rating vs competitor average
  const wavesAgg = await db('google_reviews')
    .where('reviewer_name', '!=', '_stats')
    .whereNotNull('star_rating')
    .avg('star_rating as avg_rating')
    .count('id as total')
    .first();

  const competitors = await db('competitor_businesses')
    .where({ active: true })
    .whereNotNull('current_rating')
    .select('id', 'name', 'market', 'current_rating', 'current_review_count');

  const compAvg = competitors.length
    ? competitors.reduce((s, c) => s + parseFloat(c.current_rating || 0), 0) / competitors.length
    : null;
  const compReviewAvg = competitors.length
    ? Math.round(competitors.reduce((s, c) => s + parseInt(c.current_review_count || 0), 0) / competitors.length)
    : null;

  return {
    waves: {
      avg_rating: parseFloat(wavesAgg?.avg_rating || 0).toFixed(2),
      total_reviews: parseInt(wavesAgg?.total || 0),
    },
    competitors_tracked: competitors.length,
    competitor_avg_rating: compAvg ? compAvg.toFixed(2) : null,
    competitor_avg_review_count: compReviewAvg,
    competitors,
  };
}

module.exports = { syncOne, syncAll, getMarketPosition, fetchPlaceDetails };
