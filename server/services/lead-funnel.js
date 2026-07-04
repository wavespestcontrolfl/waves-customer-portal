/**
 * Lead funnel by source — per-channel stage progression from the
 * ad_service_attribution rows (Growth Command Center Phase 6).
 *
 * funnel_stage is a row's CURRENT state (lead → contacted → estimate_sent →
 * estimate_viewed → booked → completed, or terminal lost), so the funnel
 * counts "reached at least stage X" cumulatively: a row sitting at booked has
 * necessarily been contacted and estimated. `lost` rows collapse their
 * history — they count in the lead total and in `lost`, nothing between.
 *
 * DATA REALITY (why stagesPresent exists): today the attribution pipeline
 * only ever writes 'lead' at creation and patches 'completed' on sync — the
 * intermediate stages are schema, not live data. The card therefore renders
 * only the rungs that actually carry rows (stagesPresent), so it never
 * implies "0% contacted" for leads whose contact was simply never recorded.
 * The rungs light up automatically as stage tracking starts writing them.
 *
 * Paid semantics mirror channel-attribution's splitFacebookByPaid: a Meta
 * click id (fbclid/_fbc) OR the explicit is_paid flag marks a row paid — the
 * flag alone is NULL on most historical rows (prod-verified), and the paid
 * PLATFORM keys (google_ads / google_lsa) are paid by definition.
 *
 * Basis caveat (surfaced by the card): these are ATTRIBUTION rows, not the
 * raw leads table — totals will differ from Leads-by-Source (which counts
 * lead records), and call↔lead linkage is call-SID based. Pure / unit-testable.
 */

const { formatSourceName } = require('./source-names');

const pctOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// Stages above (and including) each rung, for reached-at-least counting.
const REACHED = {
  contacted: new Set(['contacted', 'estimate_sent', 'estimate_viewed', 'booked', 'completed']),
  estimate: new Set(['estimate_sent', 'estimate_viewed', 'booked', 'completed']),
  booked: new Set(['booked', 'completed']),
  completed: new Set(['completed']),
};

/**
 * buildLeadFunnel(rows) — rows are GROUP BY (lead_source, funnel_stage,
 * paid-signal) counts: [{ lead_source, funnel_stage, is_paid, n }], where
 * is_paid is the EFFECTIVE paid signal (click id OR flag — the route computes
 * it in SQL so the flag's historical NULLs can't misfile paid Meta rows).
 */
function buildLeadFunnel(rows = []) {
  const bySource = new Map();
  const ensure = (key, isPaid) => {
    if (!bySource.has(key)) {
      bySource.set(key, {
        sourceKey: key,
        source: formatSourceName(key),
        isPaid: !!isPaid,
        leads: 0,
        contacted: 0,
        estimate: 0,
        booked: 0,
        completed: 0,
        lost: 0,
      });
    }
    return bySource.get(key);
  };

  // Which intermediate rungs actually carry rows in this window — the card
  // renders only these (see DATA REALITY above).
  const present = { contacted: false, estimate: false, booked: false };

  for (const r of rows) {
    // Organic Facebook splits off the paid Meta bucket, mirroring
    // splitFacebookByPaid so the two panels can't disagree about what
    // "Facebook" means. r.is_paid here is the effective signal (click id OR
    // flag), so click-attributed paid Meta rows stay under Facebook.
    const rawKey = r.lead_source || 'unknown';
    const key = rawKey === 'facebook' && !r.is_paid ? 'facebook_organic' : rawKey;
    const n = parseInt(r.n, 10) || 0;
    // Paid = the paid PLATFORM keys plus effectively-flagged Meta rows.
    const isPaid = key === 'google_ads' || key === 'google_lsa' || (rawKey === 'facebook' && !!r.is_paid);
    const s = ensure(key, isPaid);
    s.isPaid = s.isPaid || isPaid;
    s.leads += n;
    const stage = r.funnel_stage;
    if (n > 0) {
      if (stage === 'contacted') present.contacted = true;
      if (stage === 'estimate_sent' || stage === 'estimate_viewed') present.estimate = true;
      if (stage === 'booked') present.booked = true;
    }
    if (REACHED.contacted.has(stage)) s.contacted += n;
    if (REACHED.estimate.has(stage)) s.estimate += n;
    if (REACHED.booked.has(stage)) s.booked += n;
    if (REACHED.completed.has(stage)) s.completed += n;
    if (stage === 'lost') s.lost += n;
  }

  const sources = [...bySource.values()]
    .map((s) => ({
      ...s,
      rates: {
        contactRate: pctOf(s.contacted, s.leads),
        estimateRate: pctOf(s.estimate, s.leads),
        bookRate: pctOf(s.booked, s.leads),
        completeRate: pctOf(s.completed, s.leads),
      },
    }))
    .sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source));

  const totalOf = (filter) => {
    const t = { leads: 0, contacted: 0, estimate: 0, booked: 0, completed: 0, lost: 0 };
    for (const s of sources) {
      if (filter && !filter(s)) continue;
      t.leads += s.leads;
      t.contacted += s.contacted;
      t.estimate += s.estimate;
      t.booked += s.booked;
      t.completed += s.completed;
      t.lost += s.lost;
    }
    return { ...t, bookRate: pctOf(t.booked, t.leads), completeRate: pctOf(t.completed, t.leads) };
  };

  return {
    sources,
    stagesPresent: present,
    totals: totalOf(null),
    paid: totalOf((s) => s.isPaid),
    organic: totalOf((s) => !s.isPaid),
  };
}

module.exports = { buildLeadFunnel };
