/**
 * Lawn Report V2 — daily area rainfall sync (Phase 2).
 *
 * For each active lawn_water_area center, pull daily precipitation (Open-Meteo,
 * inches, America/New_York) for the recent window and upsert into
 * lawn_area_weather_daily. The report's water-intake snapshot sums these over the
 * service week, so the customer copy can say "your area received X".
 *
 * Run ad hoc:   node server/scripts/sync-lawn-area-weather.js [pastDays]
 * Schedule:     call runLawnAreaWeatherSync() from a daily cron (see scheduler.js).
 * Idempotent (onConflict[area_id,date].merge); fail-soft per area.
 */

const db = require('../models/db');
const logger = require('../services/logger');

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

async function fetchAreaDailyPrecip(lat, lng, pastDays) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('daily', 'precipitation_sum');
  url.searchParams.set('timezone', 'America/New_York');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('past_days', String(Math.min(92, Math.max(1, pastDays))));
  url.searchParams.set('forecast_days', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return [];
    const payload = await resp.json();
    const days = Array.isArray(payload.daily?.time) ? payload.daily.time : [];
    const vals = Array.isArray(payload.daily?.precipitation_sum) ? payload.daily.precipitation_sum : [];
    return days.map((date, i) => ({ date, rain: Number(vals[i]) }))
      .filter((r) => r.date && Number.isFinite(r.rain));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function runLawnAreaWeatherSync({ pastDays = 7, knex = db } = {}) {
  let areas = [];
  try {
    areas = await knex('lawn_water_areas')
      .where({ active: true })
      .whereNotNull('center_lat')
      .whereNotNull('center_lng');
  } catch (err) {
    logger.warn(`[lawn-area-weather] areas query failed (migration not run?): ${err.message}`);
    return { areas: 0, upserts: 0 };
  }

  let upserts = 0;
  for (const area of areas) {
    const rows = await fetchAreaDailyPrecip(Number(area.center_lat), Number(area.center_lng), pastDays);
    for (const r of rows) {
      try {
        await knex('lawn_area_weather_daily')
          .insert({ area_id: area.id, date: r.date, rain_inches: Math.max(0, r.rain), source: 'radar', confidence: 'high', updated_at: knex.fn.now() })
          .onConflict(['area_id', 'date'])
          .merge();
        upserts += 1;
      } catch { /* per-day best-effort */ }
    }
  }
  logger.info(`[lawn-area-weather] synced ${areas.length} areas, ${upserts} day-rows`);
  return { areas: areas.length, upserts };
}

module.exports = { runLawnAreaWeatherSync };

if (require.main === module) {
  const pastDays = Number(process.argv[2]) || 7;
  runLawnAreaWeatherSync({ pastDays })
    .then((r) => { logger.info(`[lawn-area-weather] done: ${JSON.stringify(r)}`); process.exit(0); })
    .catch((err) => { logger.error(`[lawn-area-weather] failed: ${err.message}`); process.exit(1); });
}
