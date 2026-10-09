'use strict';

/**
 * The ONE place the sprinkler head rate table is chosen (owner 2026-10-09: one table for every reader).
 *
 * GATE_IRRIGATION_OWNER_RATES off: the package's own UF/IFAS-typical table (spray 1.5, rotor 0.5 in/hr), exactly as
 * before. On: the owner's table (spray 15, rotor 40 minutes per quarter inch), the one the lawn report banner already
 * prints. The package never reads the environment, so every server reader passes this table in:
 *   deriveIrrigationInchesPerWeek(input, irrigationRateOptions())
 *   resolveApplicationRate(input, irrigationRateOptions())  /  buildWeekPlan({ ..., rates: irrigationRates() })
 * A customer's MEASURED rate (typed weekly inches plus a runtime) outranks either table, unchanged.
 */
const { HEAD_PRECIP_RATE_IN_PER_HR, OWNER_HEAD_RATE_IN_PER_HR } = require('@waves/irrigation-runtime');

// GATE_IRRIGATION_OWNER_RATES read at CALL time, strict `=== 'true'` (customer copy), so an unset variable is the kill
// switch. Read here, not in config/feature-gates.js, so the pure renderers and the report builder pull in no heavy module.
function irrigationOwnerRatesLive() {
  return process.env.GATE_IRRIGATION_OWNER_RATES === 'true';
}

function irrigationRates() {
  return irrigationOwnerRatesLive() ? OWNER_HEAD_RATE_IN_PER_HR : HEAD_PRECIP_RATE_IN_PER_HR;
}

// The { rates } option deriveIrrigationInchesPerWeek and resolveApplicationRate take.
function irrigationRateOptions() {
  return { rates: irrigationRates() };
}

module.exports = { irrigationRates, irrigationRateOptions, irrigationOwnerRatesLive };
