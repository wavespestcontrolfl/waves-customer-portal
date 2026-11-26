// One-time pest price: the same for an older home and a newer home
// (owner 2026-11-26, GATE_ONE_TIME_PEST_NO_HOME_AGE).
//
// The recurring pest price keeps its home-age adjustment (modifiers.js pestAgeAdj).
// A one-time pest price is the quarterly per-visit price times the one-time multiple,
// so the age adjustment used to ride into it on two paths: a one-time line priced on
// the same estimate as a pest plan, and the one-time choice the estimate page derives
// from the plan's quarterly rate. A one-time job priced alone never carried it.
//
// The gate is read at CALL time, strict 'true', and ships dark: it changes a price,
// so the owner flips it. Off = both paths price exactly as before. Kill = unset.
const { PEST } = require('./constants');

function oneTimePestNoHomeAgeLive() {
  return process.env.GATE_ONE_TIME_PEST_NO_HOME_AGE === 'true';
}

// The quarterly per-visit price with the home-age adjustment taken back out.
// The list price is max(floor, parts + age). For a positive age adjustment,
// max(floor, price - age) is exactly the price of the same home with no age
// adjustment. Zero, negative (a hand-set discount) or unreadable adjustments
// leave the price as it is.
function quarterlyPerAppWithoutHomeAge(perApp, pestAgeAdj) {
  const amount = Number(perApp);
  const age = Number(pestAgeAdj);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(age) || age <= 0) return perApp;
  const floor = Number(PEST.floor);
  return Math.max(Number.isFinite(floor) && floor > 0 ? floor : 0, Math.round((amount - age) * 100) / 100);
}

function savedLineItems(estData) {
  return [estData?.engineResult, estData?.result, estData]
    .flatMap((source) => (Array.isArray(source?.lineItems) ? source.lineItems : []));
}

// The home-age adjustment the saved pest plan line was priced with (0 when the
// estimate stores none, so an estimate with no stored adjustment never moves).
function storedPestAgeAdj(estData) {
  const line = savedLineItems(estData).find((l) => l?.service === 'pest_control');
  const age = Number(line?.pestAgeAdj);
  return Number.isFinite(age) && age > 0 ? age : 0;
}

// Saved-estimate replay signal: true only when the saved one-time pest line was
// priced with the age adjustment removed. A quote keeps the rule it was sold on.
function oneTimePestNoHomeAgeReplaySignal(estData) {
  return savedLineItems(estData).some((l) => l?.service === 'one_time_pest' && l.homeAgeExcluded === true);
}

// Whether the estimate page takes the age adjustment out of the one-time choice.
// An estimate that saved a one-time pest line follows that line's own rule, as
// the engine replay does; a plan-only estimate (no saved line) follows the gate.
function oneTimePestHomeAgeExcludedForEstimate(estData) {
  const saved = savedLineItems(estData).filter((l) => l?.service === 'one_time_pest');
  return saved.length ? saved.some((l) => l.homeAgeExcluded === true) : oneTimePestNoHomeAgeLive();
}

module.exports = {
  oneTimePestHomeAgeExcludedForEstimate,
  oneTimePestNoHomeAgeLive,
  quarterlyPerAppWithoutHomeAge,
  storedPestAgeAdj,
  oneTimePestNoHomeAgeReplaySignal,
};
