// One-time pest price: the same for an older home and a newer home
// (owner 2026-11-26, GATE_ONE_TIME_PEST_NO_HOME_AGE).
//
// The recurring pest price keeps its home-age adjustment (modifiers.js pestAgeAdj).
// A one-time pest price is the quarterly per-visit price times the one-time multiple,
// so the age adjustment used to ride into it on two paths: a one-time line priced on
// the same estimate as a pest plan, and the one-time choice the estimate page derives
// from the plan's quarterly rate. A one-time job priced alone never carried it.
//
// With the gate on, the engine stamps the plan line with the quarterly rate that has
// no age adjustment (`oneTimeAnchorPerApp`). The one-time line on the same estimate
// and the estimate page both price from that saved number. The page never reads the
// gate: an estimate shows and charges the rule it was priced on, and an estimate
// with no stamp prices exactly as before.
//
// The gate is read at CALL time, strict 'true', and ships dark: it changes a price,
// so the owner flips it. Kill = unset (new quotes only; a stamped quote keeps its price).
const { PEST } = require('./constants');

function oneTimePestNoHomeAgeLive() {
  return process.env.GATE_ONE_TIME_PEST_NO_HOME_AGE === 'true';
}

// The quarterly per-visit price with the home-age adjustment taken back out.
// The list price is max(floor, parts + age), so for a positive adjustment
// max(floor, price - age) is exactly the price of the same home with none.
// `floor` is the floor the plan line was priced with (the quote-time floor on a
// replay); without one, the live floor, as the pest pricer itself resolves it.
function quarterlyPerAppWithoutHomeAge(perApp, pestAgeAdj, floor) {
  const amount = Number(perApp);
  const age = Number(pestAgeAdj);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(age) || age <= 0) return perApp;
  const given = Number(floor);
  const live = Number(PEST.floor);
  const resolved = Number.isFinite(given) && given > 0 ? given : (Number.isFinite(live) && live > 0 ? live : 0);
  return Math.max(resolved, Math.round((amount - age) * 100) / 100);
}

// The age-free quarterly rate the saved pest plan line was stamped with, or null
// when the estimate was not priced on this rule.
function storedOneTimeAnchorPerApp(estData) {
  const line = [estData?.engineResult, estData?.result, estData]
    .flatMap((source) => (Array.isArray(source?.lineItems) ? source.lineItems : []))
    .find((l) => l?.service === 'pest_control');
  const anchor = Number(line?.oneTimeAnchorPerApp);
  return Number.isFinite(anchor) && anchor > 0 ? anchor : null;
}

// Saved-estimate replay signal: a quote keeps the rule it was priced on.
function oneTimePestNoHomeAgeReplaySignal(estData) {
  return storedOneTimeAnchorPerApp(estData) !== null;
}

module.exports = {
  oneTimePestNoHomeAgeLive,
  quarterlyPerAppWithoutHomeAge,
  storedOneTimeAnchorPerApp,
  oneTimePestNoHomeAgeReplaySignal,
};
