/**
 * Ad Cost Allocation — the spend (denominator) side of LTV:CAC / ROAS.
 *
 * ad_service_attribution.ad_cost was never populated, so every /admin/ads ratio
 * that divides by spend (CAC, ROAS, LTV:CAC) read 0/null. Spend lives in
 * ad_performance_daily (cost per campaign per day), rolled up to a platform via
 * ad_campaigns.platform. Web leads don't carry a campaign_id (only gclid/utm), so
 * the reliable link is CHANNEL-level: lead_source maps 1:1 to the paid platforms.
 *
 * For each paid channel and calendar month we spread that month's platform spend
 * evenly across that channel's leads:
 *     ad_cost(lead) = platform spend in the month / leads from the channel in the month
 * Spend is allocated to ALL the channel's leads (converted or not) — true CAC must
 * include money spent on leads that didn't close. The per-month totals are exact
 * (the sum of allocated ad_cost over a channel-month equals that month's spend);
 * only the split WITHIN a month is an even approximation. Free/organic channels
 * have no platform spend, so their rows keep ad_cost NULL (shown as free).
 *
 * Idempotent: recompute overwrites ad_cost from the current spend + lead counts,
 * so the daily cron (after the ad syncs) and the one-time backfill converge.
 */

const logger = require('./logger');

// lead_source values that map 1:1 to an ad_campaigns.platform carrying spend.
// `facebook` is paidOnly: utm_source=facebook also lands ORGANIC social leads as
// lead_source='facebook' (determineLeadSource), so allocation must restrict to
// genuine paid clicks (fbclid/_fbc present) or Meta ad spend would smear onto
// organic leads. Google paid leads already use a distinct lead_source.
const PAID_CHANNELS = [
  { source: 'google_ads' },
  { source: 'google_lsa' },
  { source: 'facebook', paidOnly: true },
];

function resolveDb(db) {
  return db || require('../models/db');
}

// Restrict a query to genuine paid leads for paidOnly channels (Meta): a paid
// click id (fbclid/_fbc) OR the explicit is_paid flag. is_paid is the paid/organic
// dimension that call-sourced rows carry — phone calls to the paid Facebook
// tracking number have no click cookies, so without it they'd read as organic.
// Web-organic Facebook (no fbclid/_fbc and is_paid NULL) is still correctly
// excluded, so Meta ad spend never smears onto organic-social leads.
// LIMITATION (deferred): a paid Meta WEB click whose fbclid/_fbc was stripped
// (ad-block / consent) but that carries utm_medium=cpc is classified paid at
// ingestion, yet utm_medium isn't persisted on the row and the web path doesn't
// set is_paid, so it's still missed here. Currently no live impact — Meta Ads ship
// dark (META_ADS_* unprovisioned), so there is no Facebook spend to mis-allocate.
// hasIsPaid guards the new column: the all-time backfill migration (000003) calls
// allocateAdCosts BEFORE migration 000004 adds is_paid, so on a fresh DB the
// is_paid clause must be omitted until the column exists.
function applyPaidFilter(q, channel, hasIsPaid) {
  if (channel.paidOnly) {
    q.where((b) => {
      b.whereNotNull('fbclid').orWhereNotNull('fbc');
      if (hasIsPaid) b.orWhere('is_paid', true);
    });
  }
  return q;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Even per-lead share of a month's channel spend. 0 when there are no leads
// (no one to attribute the spend to) — avoids divide-by-zero. Pure.
function perLeadCost(spend, leads) {
  const l = Number(leads) || 0;
  if (l <= 0) return 0;
  return round2((Number(spend) || 0) / l);
}

// 'YYYY-MM' → { start: 'YYYY-MM-01', end: 'YYYY-(MM+1)-01' } (half-open range).
// Pure string math so it never depends on the host timezone / current date.
function monthBounds(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const start = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const end = `${String(nextY).padStart(4, '0')}-${String(nextM).padStart(2, '0')}-01`;
  return { start, end };
}

/**
 * allocateAdCosts(db?, opts?)
 * Recompute ad_service_attribution.ad_cost for paid-channel leads from
 * ad_performance_daily spend. `sinceDate` ('YYYY-MM-DD') bounds the work to recent
 * months (daily cron); omit it for an all-time backfill. Returns counts.
 */
async function allocateAdCosts(db, { sinceDate = null } = {}) {
  db = resolveDb(db);
  // No-op if either side is missing in this environment.
  if (!(await db.schema.hasTable('ad_service_attribution')) || !(await db.schema.hasTable('ad_performance_daily'))) {
    return { updatedRows: 0, monthsTouched: 0 };
  }
  // Resolve once: the all-time backfill migration runs this BEFORE the column
  // exists, so the paid filter must drop the is_paid clause until then.
  const hasIsPaid = await db.schema.hasColumn('ad_service_attribution', 'is_paid');

  // Normalize to the FIRST of the month. The cron passes today-90d, which lands
  // mid-month; without this the spend/lead queries would see only that partial
  // month while the per-month UPDATE rewrites the WHOLE month — overwriting an
  // earlier full-month allocation with a partial-month rate.
  const since = sinceDate ? `${String(sinceDate).slice(0, 7)}-01` : null;

  let updatedRows = 0;
  let monthsTouched = 0;

  for (const channel of PAID_CHANNELS) {
    const platform = channel.source; // lead_source == ad_campaigns.platform for paid channels
    // Spend by month for this platform.
    const spendRows = await db('ad_performance_daily as apd')
      .join('ad_campaigns as ac', 'ac.id', 'apd.campaign_id')
      .where('ac.platform', platform)
      .modify((q) => { if (since) q.where('apd.date', '>=', since); })
      .groupByRaw("to_char(apd.date, 'YYYY-MM')")
      .select(db.raw("to_char(apd.date, 'YYYY-MM') as ym"), db.raw('SUM(apd.cost) as spend'));
    const spendByMonth = new Map(spendRows.map((r) => [r.ym, Number(r.spend) || 0]));

    // Leads by month for this channel (paid clicks only, for paidOnly channels).
    const leadRows = await db('ad_service_attribution')
      .where('lead_source', channel.source)
      .whereNotNull('lead_date')
      .modify((q) => { if (since) q.where('lead_date', '>=', since); })
      .modify((q) => applyPaidFilter(q, channel, hasIsPaid))
      .groupByRaw("to_char(lead_date, 'YYYY-MM')")
      .select(db.raw("to_char(lead_date, 'YYYY-MM') as ym"), db.raw('COUNT(*) as leads'));

    for (const lr of leadRows) {
      const leads = Number(lr.leads) || 0;
      if (!leads) continue;
      const perLead = perLeadCost(spendByMonth.get(lr.ym) || 0, leads);
      const { start, end } = monthBounds(lr.ym);
      const n = await db('ad_service_attribution')
        .where('lead_source', channel.source)
        .where('lead_date', '>=', start)
        .where('lead_date', '<', end)
        .modify((q) => applyPaidFilter(q, channel, hasIsPaid))
        .update({ ad_cost: perLead, updated_at: new Date() });
      updatedRows += n;
      monthsTouched += 1;
    }
  }

  logger.info(`[ad-cost-allocation] allocated — rows ${updatedRows}, channel-months ${monthsTouched}${since ? ` (since ${since})` : ' (all)'}`);
  return { updatedRows, monthsTouched };
}

module.exports = {
  allocateAdCosts,
  // exported for unit tests
  perLeadCost,
  monthBounds,
  PAID_CHANNELS,
};
