// One-time pest, small job: a flat price for one spot
// (owner 2026-11-26 "150 for small one time jobs", GATE_ONE_TIME_PEST_SMALL_JOB).
//
// A small job is one-time pest work limited to one spot: one wasp nest, one room,
// one sink area (gnats), one small area. Those callers were quoted the full
// one-time price (a multiple of the quarterly visit, with a floor) and did not book.
//
// With the gate on, staff mark the one-time pest request `smallJob: true` and a
// residential one-time pest line prices at ONE_TIME.pest.smallJobPrice ($150 default,
// overlaid from the live `onetime_pest` pricing_config row's `smallJobPrice` key).
// Urgency, after-hours and the recurring-customer discount apply as they do to the
// full one-time price. The one-time floor does not: the flat price is the price.
// A roach job is never a small job, commercial stays a manual quote, and a bedroom-band
// unit price ignores the flag.
//
// The priced line is stamped `smallJob: true`. A saved estimate replayed as sold
// follows that stamp, never the gate, so it keeps the price it was sold on.
//
// The gate is read at CALL time, strict 'true', and ships dark: it changes a price,
// so the owner flips it. Kill = unset (new quotes only; a stamped quote keeps its price).
const { ONE_TIME } = require('./constants');

function oneTimePestSmallJobLive() {
  return process.env.GATE_ONE_TIME_PEST_SMALL_JOB === 'true';
}

// The configured flat price, or null when the config holds no usable number.
function smallJobPrice() {
  const price = Number(ONE_TIME.pest?.smallJobPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

// The saved one-time pest line that carries the small-job stamp, or null.
function storedSmallJobLine(estData) {
  return [estData?.engineResult, estData?.result, estData]
    .flatMap((source) => (Array.isArray(source?.lineItems) ? source.lineItems : []))
    .find((l) => l?.service === 'one_time_pest' && l?.smallJob === true) || null;
}

// The flat price the saved line was priced on (before urgency and discount), or null.
function storedSmallJobBasePrice(estData) {
  const line = storedSmallJobLine(estData);
  const base = Number(line?.smallJobBasePrice ?? line?.basePrice);
  return line && Number.isFinite(base) && base > 0 ? base : null;
}

// Saved-estimate replay signal: a quote keeps the rule AND the flat price it was priced on.
// The saved base price when the saved one-time pest line carries the small-job stamp, else null.
function oneTimePestSmallJobReplaySignal(estData) {
  return storedSmallJobBasePrice(estData);
}

// Whether the saved estimate carries a small-job line. Such an estimate never
// offers the estimate page's [Recurring | One-time] choice: the choice prices
// its one-time side from the plan and its discounts (member perk, credits,
// manual discount) follow rules a flat one-spot price does not fit, so the
// small job is quoted as its own line instead (estimate-delivery-options.js).
function hasSmallJobLine(estData) {
  return !!storedSmallJobLine(estData);
}

// Whether this pricing run prices the one-time pest request as a small job.
// A stored estimate replayed as sold follows its saved stamp alone and returns the saved
// flat price; a live run needs the staff's flag and the gate and returns the configured price.
// Returns the flat base price, or null when this is not a small job. A roach request never is.
function oneTimePestSmallJobBasePrice(input, request) {
  if (String(request?.roachType || 'none').toLowerCase() !== 'none') return null;
  if (input?.savedEstimateReplay === true) {
    const saved = Number(input.oneTimePestSmallJobReplay);
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  }
  return request?.smallJob === true && oneTimePestSmallJobLive() ? smallJobPrice() : null;
}

module.exports = {
  oneTimePestSmallJobLive,
  smallJobPrice,
  oneTimePestSmallJobReplaySignal,
  oneTimePestSmallJobBasePrice,
  hasSmallJobLine,
};
