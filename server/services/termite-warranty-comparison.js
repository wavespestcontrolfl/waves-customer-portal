// ============================================================
// termite-warranty-comparison.js — data for the termite options sheet
//
// One customer-facing question drives builder-warranty takeovers: "do I buy
// the bait stations, or rent them like my builder's program?" This module
// prices BOTH answers for the exact property on an existing estimate — two
// deterministic engine replays of the estimate's own saved inputs with the
// ownership toggled — plus the bond (warranty) term snapshot, and returns a
// plain data object the PDF renderer lays out. No LLM anywhere: every number
// is the pricing engine's, every sentence is fixed copy.
//
// Fail-closed availability: the sheet exists only when BOTH ownership modes
// actually price. Gate off, commercial property, unpriceable uplift, or a
// manual-quote bait line all return null — a comparison that can only show
// one column is not a comparison, and advertising a rental the engine would
// re-price as a purchase is exactly the bug the estimator UI just fixed.
// ============================================================

const { generateEstimate } = require('./pricing-engine/estimate-engine');
const { recurringServiceKey } = require('./estimate-converter');

// Dark ship (customer-facing): default OFF, explicit opt-in. Kill = unset.
function termiteComparisonGateOn() {
  return ['1', 'true', 'on'].includes(String(process.env.GATE_TERMITE_COMPARISON_SHEET || '').toLowerCase());
}

const TERMITE_SERVICE_INPUT_KEYS = ['termite', 'termiteBait', 'termite_bait'];

// Deep-copy the saved engine inputs and force the bait ownership. The service
// entry may be `true` (defaults) or an options object — normalize to an
// object so the ownership lands where serviceOptions() reads it.
function inputsWithOwnership(engineInputs, ownership) {
  let inputs;
  try {
    inputs = JSON.parse(JSON.stringify(engineInputs));
  } catch {
    return null;
  }
  if (!inputs || typeof inputs !== 'object') return null;
  const services = inputs.services && typeof inputs.services === 'object' ? inputs.services : null;
  if (!services) return null;
  const key = TERMITE_SERVICE_INPUT_KEYS.find((k) => services[k]);
  if (!key) return null;
  if (!services[key] || typeof services[key] !== 'object') services[key] = {};
  services[key].ownership = ownership;
  return inputs;
}

function pricedBaitLine(engineResult) {
  const lines = Array.isArray(engineResult?.lineItems) ? engineResult.lineItems : [];
  const bait = lines.find((li) => li && li.service === 'termite_bait');
  if (!bait || bait.quoteRequired || bait.requiresMeasurement) return null;
  return bait;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// The line's FINAL customer annual: manual-discount and WaveGuard-bundle
// participation land in manualFinalAnnual / annualAfterDiscount, and the
// gross `annual` is only correct when neither applied (codex P1 on #3001 —
// reading gross perApp overstated every discounted estimate's columns).
function finalLineAnnual(li) {
  const v = Number(li?.manualFinalAnnual ?? li?.annualAfterDiscount ?? li?.annual);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Build the comparison data for one estimate's saved engine inputs.
// Returns null whenever the sheet must not exist (see header).
//
// bondOptions (optional) is the estimate's QUOTE-TIME snapshot — the same
// one PUT /:token/bond validates selections against — passed in by the
// route. The replay's freshly-priced options are deliberately NOT used
// (codex P1): after a bond-rate config change they could advertise terms or
// rates the linked estimate cannot actually select.
// selectedTier (optional) is the estimate row's persisted waveguard_tier.
// PUT /:token/select-tier lets a customer COMMIT to a higher tier than the
// natural service count derives, storing the choice on the row — a replay
// can't see it, so its discounted figures would misstate the selected quote
// (codex P2). Fail closed on a mismatch: no sheet beats a wrong-priced one.
//
// expectedTierDiscount (optional) is the QUOTE-TIME tier discount the
// estimate page preserves (sendSnapshot.tierDiscounts via
// tierDiscountForEstimate) — same WAVEGUARD.tiers unit as the engine's
// waveGuard.discount. A live-config change after send means the replay
// prices at a different percentage than the customer-visible quote (codex
// P1); the name-only tier guard can't see that, so the rate itself is
// checked and any mismatch fails the sheet closed.
// The estimate's STORED termite pricing, for the replay-vs-frozen-quote
// guard. GROSS values on purpose: the mapped rows persist pre-discount
// per-application figures (v1-legacy-mapper's documented convention), and
// gross-vs-gross is exactly where bait-bracket / monitoring-rate / rental-
// horizon config drift shows up — discount-config drift is guarded
// separately (expectedTierDiscount), and manual discounts replay from the
// estimate's own stored inputs. Reads BOTH persisted shapes: mapped
// result.recurring.services (+ the one-time install item) and raw
// { engineInputs, engineResult } lineItems (codex P2 — IB/server-
// authoritative saves carry no mapped rows).
function persistedTermiteQuoteFromEstimateData(estData) {
  const rows = [estData?.result?.recurring?.services, estData?.recurring?.services]
    .flatMap((list) => (Array.isArray(list) ? list : []));
  const mappedBait = rows.find((svc) => recurringServiceKey(svc) === 'termite_bait');
  if (mappedBait) {
    const mappedRental = rows.find((svc) => String(svc?.service || '').toLowerCase() === 'termite_station_rental'
      || /termite station rental/i.test(String(svc?.name || '')));
    const installItem = [estData?.result?.oneTime?.items, estData?.oneTime?.items]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .find((item) => String(item?.service || '') === 'termite_bait_installation');
    return {
      ownership: mappedRental ? 'rent' : 'own',
      baitPerApp: Number(mappedBait.perTreatment ?? mappedBait.perApp) || null,
      upliftPerApp: mappedRental ? (Number(mappedRental.perTreatment ?? mappedRental.perApp) || null) : null,
      installPrice: installItem != null ? (Number(installItem.price) || 0) : null,
    };
  }
  const lines = [estData?.engineResult?.lineItems, estData?.result?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []));
  const rawBait = lines.find((li) => li && li.service === 'termite_bait' && !li.quoteRequired);
  if (!rawBait) return null;
  const rawRental = lines.find((li) => li && li.service === 'termite_station_rental');
  const rented = rawRental || String(rawBait.ownership || '').toLowerCase() === 'rent';
  return {
    ownership: rented ? 'rent' : 'own',
    baitPerApp: Number(rawBait.perApp) || null,
    upliftPerApp: rawRental ? (Number(rawRental.perApp) || null) : null,
    installPrice: Number.isFinite(Number(rawBait.installation?.price)) ? Number(rawBait.installation.price) : null,
  };
}

// persistedQuote (optional) is persistedTermiteQuoteFromEstimateData's
// result. Any mutable termite config change after send (bait brackets,
// monitoring rate, install pricing, recovery horizon) makes the live replay
// disagree with the frozen quote the customer sees and accepts (codex P1);
// the sold-ownership column is checked GROSS-vs-GROSS against the stored
// rows — including the own-mode install price — and any mismatch fails the
// sheet closed.
function buildTermiteComparisonData(engineInputs, {
  bondOptions = null,
  selectedTier = null,
  expectedTierDiscount = null,
  persistedQuote = null,
} = {}) {
  if (!termiteComparisonGateOn()) return null;
  if (!engineInputs) return null;

  const ownInputs = inputsWithOwnership(engineInputs, 'own');
  const rentInputs = inputsWithOwnership(engineInputs, 'rent');
  if (!ownInputs || !rentInputs) return null;

  let ownResult;
  let rentResult;
  try {
    ownResult = generateEstimate(ownInputs);
    rentResult = generateEstimate(rentInputs);
  } catch {
    return null;
  }

  const ownBait = pricedBaitLine(ownResult);
  const rentBait = pricedBaitLine(rentResult);
  if (!ownBait || !rentBait) return null;
  // Customer-selected tier must match what the replay derived, or the
  // discounted figures below describe a different quote than the one the
  // customer holds (see header note on selectedTier).
  if (selectedTier) {
    const replayTier = String(ownResult?.waveGuard?.tier || '').toLowerCase();
    if (!replayTier || replayTier !== String(selectedTier).toLowerCase()) return null;
  }
  if (expectedTierDiscount != null) {
    const replayDiscount = Number(ownResult?.waveGuard?.discount);
    if (!Number.isFinite(replayDiscount)
      || Math.abs(replayDiscount - Number(expectedTierDiscount)) > 1e-9) {
      return null;
    }
  }
  // The rent replay must have ACTUALLY priced as a rental: with
  // GATE_TERMITE_STATION_RENTAL off the engine silently re-prices 'rent' as
  // a purchase, and the fail-closed unpriceable-uplift path reverts it too.
  // Either way both columns would be identical — no sheet.
  if (rentBait.ownership !== 'rent' || !rentBait.stationRental) return null;

  const installToday = Number(ownBait.installation?.price);
  const visitsPerYear = Number(ownBait.visitsPerYear) || 4;
  // Final DISCOUNTED per-application figures — what the estimate actually
  // charges, not the gross monitoring rate. The rental uplift is
  // discount-exempt by design, so it adds on top of the discounted base.
  const ownAnnual = finalLineAnnual(ownBait);
  const rentBaseAnnual = finalLineAnnual(rentBait);
  if (!ownAnnual || !rentBaseAnnual) return null;
  const perAppOwn = round2(ownAnnual / visitsPerYear);
  const upliftPerApp = Number(rentBait.stationRental.perApp);
  const rentBasePerApp = round2(rentBaseAnnual / visitsPerYear);
  const perAppRent = round2(rentBasePerApp + upliftPerApp);
  if (!(installToday > 0) || !(perAppOwn > 0) || !(upliftPerApp > 0)) return null;

  // The sold-ownership column must reproduce the STORED quote (see header
  // note on persistedQuote): a bait/monitoring/install/rental config change
  // after send means the estimate page serves the frozen price while this
  // replay prices the new one — fail closed rather than disagree with it.
  // GROSS-vs-GROSS (stored rows are pre-discount by mapper convention);
  // discount drift is caught by expectedTierDiscount above.
  if (persistedQuote && typeof persistedQuote === 'object') {
    const near = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b))
      && Math.abs(Number(a) - Number(b)) <= 0.01;
    if (persistedQuote.ownership === 'rent') {
      if (!near(Number(rentBait.perApp), persistedQuote.baitPerApp)) return null;
      if (!near(upliftPerApp, persistedQuote.upliftPerApp)) return null;
    } else {
      if (!near(Number(ownBait.perApp), persistedQuote.baitPerApp)) return null;
      // Own-mode: the amount due at installation is on the sheet — a
      // termite_install config change after send must not reprice it.
      if (persistedQuote.installPrice != null && !near(installToday, persistedQuote.installPrice)) return null;
    }
  }

  // Five-year totals — the honest horizon: with the seeded 20-quarter
  // recovery the two lines meet at year five, and past it renting costs
  // more. The sheet SAYS so; that asymmetry is the price of $0 up front.
  const fiveYearOwn = round2(installToday + perAppOwn * visitsPerYear * 5);
  const fiveYearRent = round2(perAppRent * visitsPerYear * 5);

  // Quote-time snapshot only (see header). Absent/empty → no bond section.
  // Sorted by term length so the PDF's rate-ordering copy can be derived
  // from the actual snapshot rather than assumed.
  const bondMenu = (Array.isArray(bondOptions)
    ? bondOptions
      .map((opt) => ({
        key: opt.key,
        label: opt.label,
        years: opt.years,
        perApp: Number(opt.perApp ?? opt.quarterly) || 0,
      }))
      .filter((opt) => opt.perApp > 0 && opt.label)
    : [])
    .sort((a, b) => (Number(a.years) || 0) - (Number(b.years) || 0));

  return {
    system: ownBait.selectedSystem || ownBait.system || 'advance',
    stations: Number(ownBait.stations) || null,
    footprintSqFt: Number(ownBait.footprintSqFt) || null,
    visitsPerYear,
    own: {
      installToday: round2(installToday),
      perApp: round2(perAppOwn),
      firstYear: round2(installToday + perAppOwn * visitsPerYear),
      fiveYear: fiveYearOwn,
    },
    rent: {
      installToday: 0,
      hardwareValue: Number(rentBait.stationRental.retailValue) || round2(installToday),
      perApp: perAppRent,
      upliftPerApp: round2(upliftPerApp),
      basePerApp: rentBasePerApp,
      firstYear: round2(perAppRent * visitsPerYear),
      fiveYear: fiveYearRent,
      recoveryQuarters: Number(rentBait.stationRental.recoveryQuarters) || null,
    },
    bondOptions: bondMenu,
  };
}

module.exports = {
  termiteComparisonGateOn,
  buildTermiteComparisonData,
  persistedTermiteQuoteFromEstimateData,
};
