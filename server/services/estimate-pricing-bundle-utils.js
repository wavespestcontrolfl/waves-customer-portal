function moneyCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function moneyMatches(left, right) {
  const a = moneyCents(left);
  const b = moneyCents(right);
  return a != null && b != null && Math.abs(a - b) <= 1;
}

function pricingBundleMatchesEstimateTotals(bundle = {}, estimate = {}) {
  const monthly = Number(estimate.monthly_total ?? estimate.monthlyTotal ?? 0);
  const annual = Number(estimate.annual_total ?? estimate.annualTotal ?? 0);
  if (!(monthly > 0) && !(annual > 0)) return true;

  const frequencies = Array.isArray(bundle.frequencies) ? bundle.frequencies : [];
  return frequencies.some((freq) => {
    const freqMonthly = Number(freq?.monthly);
    const explicitAnnual = Number(freq?.annual);
    const freqAnnual = explicitAnnual > 0
      ? explicitAnnual
      : (freqMonthly > 0 ? freqMonthly * 12 : null);
    const monthlyOk = monthly > 0 ? moneyMatches(freqMonthly, monthly) : true;
    const annualOk = annual > 0 ? moneyMatches(freqAnnual, annual) : true;
    return monthlyOk && annualOk;
  });
}

// The entry the estimate page opens a service on (client EstimateViewPage
// pricingServices + defaultSelectedForServices; keep in step): that
// service's section, then its defaultFrequencyKey, else its first entry. A
// bundle with no services[] split renders as one pest section.
function openingEntryForService(bundle, serviceKey) {
  const sections = Array.isArray(bundle?.services) && bundle.services.length
    ? bundle.services
    : [{ key: 'pest_control', frequencies: bundle?.frequencies }];
  const section = sections.find((candidate) => candidate?.key === serviceKey);
  const frequencies = Array.isArray(section?.frequencies) ? section.frequencies : [];
  return frequencies.find((entry) => entry?.key === section.defaultFrequencyKey) || frequencies[0] || null;
}

// The per-application price the estimate page's price card leads with on a
// service section, and the visits it covers (client PriceCard
// perApplicationNetForFrequency and its quote and range guards; keep in
// step): the one priced treatment row's net displayPrice, or with no priced
// row the entry's own perTreatment. null when the card leads with anything
// else (a quote-required note, a price range, several priced rows).
function displayedPerApplication(entry) {
  if (!entry || entry.quoteRequired === true || Number(entry.lowConfidenceRangePct) > 0) return null;
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const rows = Array.isArray(entry.perServiceTreatments) ? entry.perServiceTreatments : [];
  const priced = rows
    .map((row) => ({ price: Number(row?.displayPrice ?? row?.perTreatment), monthly: Number(row?.monthly), visits: Number(row?.visitsPerYear) }))
    .filter((row) => (Number.isFinite(row.price) && row.price > 0) || (Number.isFinite(row.monthly) && row.monthly > 0));
  if (priced.length > 1) return null;
  if (priced.length === 1) {
    return priced[0].price > 0 && priced[0].visits > 0 ? { amount: round2(priced[0].price), visits: priced[0].visits } : null;
  }
  const CADENCE_VISITS = { quarterly: 4, bi_monthly: 6, monthly: 12 };
  const visitRows = rows.filter((row) => Number(row?.visitsPerYear) > 0);
  const visits = Number(entry.visitsPerYear) > 0
    ? Number(entry.visitsPerYear)
    : (visitRows.length === 1
      ? Number(visitRows[0].visitsPerYear)
      : (visitRows.length === 0 ? (CADENCE_VISITS[entry.key] || null) : null));
  const perTreatment = Number(entry.perTreatment);
  return perTreatment > 0 && Number.isFinite(visits) && visits > 0 ? { amount: round2(perTreatment), visits } : null;
}

// A plan-start quote (estimates.source 'plan_start', GATE_PORTAL_PLAN_START)
// opens on one entry, which the mint checked against the portal card to the
// cent. That entry's yearly figure is its monthly x 12, so it sits cents off
// a yearly total the monthly cannot carry exactly (quarterly pest: 4 x $113
// = $452 billed, 37.67 x 12 = $452.04 shown). pricingBundleMatchesEstimateTotals
// then misses and the page would rebuild the offer on live pricing. The page
// (sentSnapshotServesAsIs) and the mint accept such a snapshot when its
// opening entry carries the row's monthly to the cent, and its displayed
// per-application price times its visits is the row's yearly total to the cent.
function planStartSnapshotMatchesTotals(bundle, estimate, estData) {
  if (estimate?.source !== 'plan_start') return false;
  const families = estData?.planStart?.families;
  if (!Array.isArray(families) || families.length !== 1) return false;
  const entry = openingEntryForService(bundle, families[0]);
  const perApplication = displayedPerApplication(entry);
  const monthly = moneyCents(estimate.monthly_total);
  const annual = moneyCents(estimate.annual_total);
  return Boolean(perApplication) && monthly > 0 && annual > 0
    && moneyCents(entry.monthly) === monthly
    && moneyCents(perApplication.amount) * perApplication.visits === annual;
}

// Curve provenance for an UNSTAMPED pest replay (codex #2966 r7-r9 P1s,
// extended to the public read path 2026-07-28): stored engineInputs and
// persisted Admin-V2 engineRequests predate version stamping, and agent
// drafts persist raw engineResult lineItems. The provenance signal is the
// STORED RESULT — an unstamped pest input with a priced stored pest line is
// a replay of that line's curve (unstamped line = v1). No stored pest line
// = pest was just added: genuinely new, caller keeps the live default.
function resolveStoredPestPricingVersion(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return null;
  const root = estimateData.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
  const storedPestLine = (Array.isArray(root?.recurring?.services) ? root.recurring.services : [])
    .find((svc) => svc?.service === 'pest_control')
    || root?.results?.pest
    || (Array.isArray(estimateData?.engineResult?.lineItems) ? estimateData.engineResult.lineItems : [])
      .find((li) => li?.service === 'pest_control')
    || null;
  if (!storedPestLine) {
    // No stored pest line normally means pest was just added (caller keeps the
    // live default) — but a service opt-out DELETES the stored rows, and its
    // removal event captured this very resolver's answer at removal time
    // precisely because the evidence was about to disappear. Without the
    // fallback, an Admin V2 estimate replaying from engineRequest (no flat
    // input carrier to re-stamp) restores pest onto the live default curve
    // instead of the customer's quote-time curve (codex #3684 r1 P1). Latest
    // removal event wins — its provenance was captured while the line still
    // existed.
    const events = estimateData?.serviceOptOut?.events;
    if (Array.isArray(events)) {
      const lastRemoval = events
        .filter((e) => e && e.serviceKey === 'pest_control' && e.included === false
          && e.provenance && typeof e.provenance === 'object')
        .pop();
      const captured = lastRemoval?.provenance?.pestPricingVersion;
      if (captured) return captured === 'v2' ? 'v2' : 'v1';
    }
    return null;
  }
  return storedPestLine.pricingVersion === 'v2' ? 'v2' : 'v1';
}

module.exports = {
  moneyCents,
  moneyMatches,
  pricingBundleMatchesEstimateTotals,
  openingEntryForService,
  displayedPerApplication,
  planStartSnapshotMatchesTotals,
  resolveStoredPestPricingVersion,
};
