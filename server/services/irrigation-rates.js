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
 *
 * FREEZE RULE (Codex round 1 on #6236): the live gate is read only when a NEW week-plan decision is made. That decision
 * records the table it used in its snapshot's decisionInputs as `rateTable: 'owner'` (key written ONLY for the owner
 * table, so a gate-off snapshot is byte-identical to before). Replay and every renderer of a STORED plan take the table
 * from that key through storedRateTable(); a row without the key is the package table, whatever the gate reads now.
 *
 * WHO MAY READ THE LIVE GATE (Codex rounds 1 and 2 on #6236): irrigationOwnerRatesLive / irrigationRates /
 * irrigationRateOptions / liveRateTable / resolveRateTable() answer "what table is in force today". Only these may call
 * them: (a) the ONE read that opens a new week-plan decision (weeklyInputsForCustomer, once per decision, whose result
 * feeds the move guard AND the decision), and (b) readers that show today's preferences and compare nothing with a stored
 * plan (the report's water card, the portal flag, the completion-time longer-cycles answer that is frozen in its record).
 * Everything else takes a table as an ARGUMENT: scheduleUnconfirmedAfterMove / sizingFieldsUnconfirmed REQUIRE one
 * (they throw without it), and replay, the sweep's re-decide and the stored-plan renderers pass storedRateTable(...).
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

// 'owner' | 'package': the table a NEW decision uses (the live gate).
function liveRateTable() {
  return irrigationOwnerRatesLive() ? 'owner' : 'package';
}

// The table a STORED decision used: its decisionInputs.rateTable, else the package table (legacy rows). Never the gate.
function storedRateTable(decisionInputs) {
  return decisionInputs && decisionInputs.rateTable === 'owner' ? 'owner' : 'package';
}

// Anything that is not exactly 'owner' or 'package' (including undefined) means "decide now": read the live gate.
function resolveRateTable(table) {
  return table === 'owner' || table === 'package' ? table : liveRateTable();
}

function ratesForTable(table) {
  return table === 'owner' ? OWNER_HEAD_RATE_IN_PER_HR : HEAD_PRECIP_RATE_IN_PER_HR;
}

function rateOptionsForTable(table) {
  return { rates: ratesForTable(table) };
}

// What a snapshot's decisionInputs carries: the key only for the owner table, so a package-table snapshot is unchanged.
function rateTableInputs(table) {
  return table === 'owner' ? { rateTable: 'owner' } : {};
}

module.exports = {
  irrigationRates,
  irrigationRateOptions,
  irrigationOwnerRatesLive,
  liveRateTable,
  storedRateTable,
  resolveRateTable,
  ratesForTable,
  rateOptionsForTable,
  rateTableInputs,
};
