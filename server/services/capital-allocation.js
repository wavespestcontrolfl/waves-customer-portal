/**
 * Capital allocation — band channels by LTV:CAC into a "where to dump cash"
 * decision surface.
 *
 * Rule of thumb (gross-profit LTV:CAC): 3:1 is the floor; the real money is in
 * outlier channels (30:1–200:1) where you pour in as much cash as the channel
 * can absorb. Bands:
 *   losing       <1    — spending more than lifetime gross profit returns
 *   below_target 1–3   — under the 3:1 minimum
 *   healthy      3–10   — profitable
 *   scale        10–30  — strong, increase budget
 *   pour_in      ≥30    — outlier, pour cash in
 *   no_spend     null   — free/organic or untracked (no paid spend to measure)
 *
 * Small-N guard: a ratio off a handful of customers is noise — a channel below
 * MIN_CONFIDENT_CUSTOMERS is flagged confidence='low' and is NOT eligible to be
 * the headline "scale this" opportunity (a 200:1 off 2 customers must not trigger
 * "pour cash in"). Pure / unit-testable.
 */

const MIN_CONFIDENT_CUSTOMERS = 5;

function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

const BAND_META = {
  no_spend:     { label: 'No paid spend', tone: 'neutral', verdict: 'Free or untracked — no ad spend to measure.' },
  losing:       { label: 'Losing money',  tone: 'bad',     verdict: 'Returns less gross profit than it costs — cut or fix.' },
  below_target: { label: 'Below 3:1',     tone: 'warn',    verdict: 'Under the 3:1 floor — improve close rate / targeting, or cut.' },
  healthy:      { label: 'Healthy',       tone: 'good',    verdict: 'Profitable — hold and optimize.' },
  scale:        { label: 'Scale up',      tone: 'good',    verdict: 'Strong returns — increase budget.' },
  pour_in:      { label: 'Pour cash in',  tone: 'great',   verdict: 'Outlier returns — pour in as much as it can absorb.' },
};

function bandFor(ltvCac) {
  if (ltvCac == null) return 'no_spend';
  if (ltvCac < 1) return 'losing';
  if (ltvCac < 3) return 'below_target';
  if (ltvCac < 10) return 'healthy';
  if (ltvCac < 30) return 'scale';
  return 'pour_in';
}

/**
 * rankCapitalAllocation(attribution, opts)
 * @param {Object} attribution  output of buildChannelAttribution + display `source`
 *   names ({ sources:[{ source, sourceKey, ltvCac, cac, adSpend, customers, ... }], blendedLtvCac })
 * @returns { channels (ranked, +band/tone/verdict/confidence), headline, minConfidentCustomers }
 */
function rankCapitalAllocation(attribution = {}, { minConfidentCustomers = MIN_CONFIDENT_CUSTOMERS } = {}) {
  const channels = (attribution.sources || []).map((s) => {
    // Band off the EXACT ratio (lifetimeValue / adSpend), not the display-rounded
    // ltvCac — otherwise a 2.96:1 rounds to 3.0 and crosses the 3:1 floor into
    // "Healthy". The rounded ltvCac is still carried through (spread) for display.
    const exactRatio = Number(s.adSpend) > 0 ? (Number(s.lifetimeValue) || 0) / Number(s.adSpend) : null;
    const band = bandFor(exactRatio);
    const meta = BAND_META[band];
    return {
      ...s,
      band,
      bandLabel: meta.label,
      tone: meta.tone,
      verdict: meta.verdict,
      // small-N guard: too few customers to trust the ratio
      confidence: (s.customers || 0) >= minConfidentCustomers ? 'ok' : 'low',
    };
  });

  // Rank: paid channels (have a ratio) first, by LTV:CAC desc; free/no-spend last.
  channels.sort((a, b) => {
    const aHas = a.ltvCac != null;
    const bHas = b.ltvCac != null;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return (b.ltvCac || 0) - (a.ltvCac || 0);
  });

  // Blend from PAID channels only. attribution.blendedLtvCac divides ALL sources'
  // lifetime value (incl. free organic/referral) by paid spend — for a "where to
  // put ad dollars" card that would let strong organic mask losing paid spend.
  const paid = channels.filter((c) => c.ltvCac != null); // ltvCac null ⇒ no paid spend
  const paidLifetime = paid.reduce((t, c) => t + (Number(c.lifetimeValue) || 0), 0);
  const paidSpend = paid.reduce((t, c) => t + (Number(c.adSpend) || 0), 0);
  // Band off the EXACT blended ratio (round only for display) — same threshold-drift
  // guard as the per-channel bands, so a 2.96 blend isn't promoted to "Healthy".
  const blendedExact = paidSpend > 0 ? paidLifetime / paidSpend : null;
  const blendedLtvCac = blendedExact == null ? null : round1(blendedExact);
  const blendedBand = bandFor(blendedExact);

  // Opportunity (the optimistic "pour cash in" call) requires CONFIDENCE — don't
  // bet on a sky-high ratio off a handful of customers. Highest-ratio scale/
  // pour-in channel (channels already sorted by LTV:CAC desc).
  const opp = channels.find(
    (c) => c.confidence === 'ok' && (c.band === 'scale' || c.band === 'pour_in'),
  );
  // Leak (the warning call) does NOT require confidence: a channel that spent
  // money and returned almost nothing is the clearest waste — and a zero-customer
  // channel (0 customers ⇒ low confidence by definition) is exactly the case to
  // flag. Pick the one wasting the MOST cash (adSpend − lifetime value).
  const wasted = (c) => (Number(c.adSpend) || 0) - (Number(c.lifetimeValue) || 0);
  const [leak] = channels
    .filter((c) => c.band === 'losing' && c.adSpend > 0)
    .sort((a, b) => wasted(b) - wasted(a));

  return {
    channels,
    headline: {
      blendedLtvCac,
      blendedBand,
      blendedBandLabel: BAND_META[blendedBand].label,
      blendedTone: BAND_META[blendedBand].tone,
      topOpportunity: opp
        ? { source: opp.source, sourceKey: opp.sourceKey, ltvCac: opp.ltvCac, band: opp.band }
        : null,
      biggestLeak: leak
        ? { source: leak.source, sourceKey: leak.sourceKey, ltvCac: leak.ltvCac }
        : null,
    },
    minConfidentCustomers,
  };
}

module.exports = {
  rankCapitalAllocation,
  bandFor,
  BAND_META,
  MIN_CONFIDENT_CUSTOMERS,
};
