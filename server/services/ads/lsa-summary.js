const db = require('../../models/db');
const logger = require('../logger');
const { parseETDateTime } = require('../../utils/datetime-et');

// ---------------------------------------------------------------------------
// The Local Service Ads card's second row on the Ads page (owner 2026-11-23,
// "do step b next"). Same 30 complete Eastern days as /campaigns' last30d:
// [today - 30, today). Read only.
//
//   leads    lsa_leads created in the period
//   charged  Google charged for the lead and has not credited it back
//   matched  leads tied to a portal call (phone_time) or customer (phone_customer)
//   booked   google_lsa funnel rows at booked or completed, by lead_date
//   recurring  the same rows with a recurring plan
//   spend    the Local Services campaign rows' 30-day spend (the card's number)
//   costPerWon  spend / booked, null when nothing booked
// ---------------------------------------------------------------------------

const WON_STAGES = ['booked', 'completed'];

const toInt = (value) => Number.parseInt(value, 10) || 0;

// Pure. The Local Services campaigns' spend the card shows: campaign_type
// google_lsa, last30d.spend (already over the same complete days).
function lsaSpend(campaigns) {
  const total = (campaigns || [])
    .filter((c) => c.campaign_type === 'google_lsa')
    .reduce((sum, c) => sum + (Number(c.last30d?.spend) || 0), 0);
  return Math.round(total * 100) / 100;
}

// Pure. Money per won job; null when nothing was won.
function costPerWon(spend, booked) {
  return booked > 0 ? Math.round((spend / booked) * 100) / 100 : null;
}

async function leadCounts(start, end) {
  const row = await db('lsa_leads')
    .where('lead_created_at', '>=', start)
    .where('lead_created_at', '<', end)
    .select(
      db.raw('COUNT(*) AS leads'),
      db.raw("COUNT(*) FILTER (WHERE charged IS TRUE AND COALESCE(credit_state, '') <> 'CREDITED') AS charged"),
      db.raw("COUNT(*) FILTER (WHERE match_basis IN ('phone_time', 'phone_customer')) AS matched"),
    )
    .first();
  return { leads: toInt(row?.leads), charged: toInt(row?.charged), matched: toInt(row?.matched) };
}

// excludeRows(qb) adds the dashboard's lead exclusions (soft-deleted, internal
// and test leads) to a query on ad_service_attribution aliased `asa`.
async function wonCounts(since, until, excludeRows) {
  const row = await excludeRows(
    db('ad_service_attribution as asa')
      .where({ 'asa.lead_source': 'google_lsa' })
      .whereIn('asa.funnel_stage', WON_STAGES)
      .where('asa.lead_date', '>=', since)
      .where('asa.lead_date', '<', until),
  )
    .select(
      db.raw('COUNT(*) AS booked'),
      db.raw('COUNT(*) FILTER (WHERE asa.is_recurring IS TRUE) AS recurring'),
    )
    .first();
  return { booked: toInt(row?.booked), recurring: toInt(row?.recurring) };
}

/**
 * lsaSummary(campaigns, { since, until }) -> object | null
 * `since` and `until` are the Eastern dates (YYYY-MM-DD) /campaigns uses:
 * since = today - 30, until = today. `excludeRows` is the caller's lead filter
 * for the funnel rows (admin-ads.js applyAttributionExclusions). null when the table is missing or any read
 * fails, so the campaigns list never breaks over this extra.
 */
async function lsaSummary(campaigns, { since, until, excludeRows = (qb) => qb }) {
  try {
    const start = parseETDateTime(`${since}T00:00`);
    const end = parseETDateTime(`${until}T00:00`);
    if (!(await db.schema.hasTable('lsa_leads'))) return null;
    const [leads, won] = await Promise.all([leadCounts(start, end), wonCounts(since, until, excludeRows)]);
    const spend = lsaSpend(campaigns);
    return { ...leads, ...won, spend, costPerWon: costPerWon(spend, won.booked) };
  } catch (err) {
    // Code and table only: a database error can echo a row.
    logger.warn(`[lsa-summary] not available (${err?.code || 'error'}${err?.table ? `, table ${err.table}` : ''})`);
    return null;
  }
}

module.exports = { lsaSummary, lsaSpend, costPerWon };
