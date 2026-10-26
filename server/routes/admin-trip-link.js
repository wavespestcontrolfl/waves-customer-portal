const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const gates = require('../config/feature-gates');
const { validCalendarDate } = require('../utils/datetime-et');
const { etDayBounds } = require('../services/visit-gps-context');

// Trip link summary (GATE_TRIP_LINK, dark). Read only: counts and medians over visit_gps_legs and trip_links for a
// date range. Nothing here writes, and nothing is sent to anyone.
const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
// Gate off = the whole surface answers 404, exactly as if it were not mounted.
const tripLinkLive = () => typeof gates.tripLinkLive === 'function' && gates.tripLinkLive();
router.use((req, res, next) => (tripLinkLive() ? next() : res.status(404).json({ error: 'Not found' })));

const MAX_RANGE_DAYS = 120;
const STATUSES = ['matched', 'no_vehicle', 'no_destination', 'no_stop', 'ambiguous'];
const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / 86400000;
const num = (value) => (value == null ? null : Number(value));

// One row per PHYSICAL visit: grouped members share one leg, so they are one visit here.
const VISITS_SQL = `
  SELECT DISTINCT ON (g.leg_group_key) g.status, g.gps_on_site_minutes, g.drive_minutes, g.drive_miles,
         EXTRACT(EPOCH FROM (s.completed_at - s.arrived_at)) / 60 AS stamped_minutes
    FROM visit_gps_legs g JOIN scheduled_services s ON s.id = g.scheduled_service_id
   WHERE g.service_date BETWEEN ?::date AND ?::date
   ORDER BY g.leg_group_key, g.scheduled_service_id`;

router.get('/summary', async (req, res) => {
  const from = validCalendarDate(req.query.from);
  const to = validCalendarDate(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD' });
  const days = dayNumber(to) - dayNumber(from) + 1;
  if (days < 1) return res.status(400).json({ error: 'from must not be after to' });
  if (days > MAX_RANGE_DAYS) return res.status(400).json({ error: `The range is at most ${MAX_RANGE_DAYS} days` });
  try {
    const startAt = new Date(etDayBounds(from).startMs);
    const endAt = new Date(etDayBounds(to).endMs);
    const tripsBy = (column) => db('trip_links').where('trip_end', '>=', startAt).where('trip_end', '<', endAt)
      .groupBy(column).select(`${column} as key`).count({ trips: '*' }).sum({ miles: 'distance_miles' });
    const visits = await db.raw(`WITH v AS (${VISITS_SQL})
      SELECT status, count(*)::int AS visits,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY gps_on_site_minutes) AS gps_on_site_median,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY stamped_minutes) FILTER (WHERE status = 'matched' AND stamped_minutes > 0) AS stamped_on_site_median,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY drive_minutes) AS drive_minutes_median,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY drive_miles) AS drive_miles_median
        FROM v GROUP BY status`, [from, to]);
    const services = await db('visit_gps_legs').whereBetween('service_date', [from, to]).count({ n: '*' }).first();
    const purposes = await tripsBy('suggested_purpose');
    const endKinds = await tripsBy('ends_at_kind');
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    let total = 0;
    let matched = null;
    for (const row of visits.rows) {
      counts[row.status] = row.visits;
      total += row.visits;
      if (row.status === 'matched') matched = row;
    }
    // Medians are of the matched visits only (the others carry no GPS minutes or drive leg).
    const medians = matched ? {
      gps_on_site_minutes: num(matched.gps_on_site_median),
      stamped_on_site_minutes: num(matched.stamped_on_site_median),
      drive_minutes: num(matched.drive_minutes_median),
      drive_miles: num(matched.drive_miles_median),
    } : { gps_on_site_minutes: null, stamped_on_site_minutes: null, drive_minutes: null, drive_miles: null };
    const tally = (rows) => rows.map((row) => ({ key: row.key, trips: Number(row.trips), miles: num(row.miles) }))
      .sort((a, b) => b.trips - a.trips || String(a.key).localeCompare(String(b.key)));
    res.json({
      from, to, days,
      services: Number(services.n),
      visits: total,
      by_status: counts,
      matched_pct: total ? Math.round((counts.matched / total) * 1000) / 10 : null,
      medians,
      trips_by_suggested_purpose: tally(purposes),
      trips_by_ends_at_kind: tally(endKinds),
    });
  } catch (err) {
    logger.error(`[trip-link] summary failed: ${err.message}`);
    res.status(500).json({ error: 'Could not read the trip link summary' });
  }
});

module.exports = router;
