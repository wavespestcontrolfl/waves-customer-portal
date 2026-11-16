'use strict';

/**
 * The ONE place the sprinkler head rate table is chosen (owner 2026-10-09: one table for every reader).
 *
 * Every NEW decision uses the owner's table (spray 15, rotor 40 minutes per quarter inch), the one the lawn report
 * banner prints. The package's own UF/IFAS-typical table (spray 1.5, rotor 0.5 in/hr) stays only for STORED plans
 * decided before the owner's table went live (see the freeze rule). The package never reads the environment, so every
 * server reader passes this table in:
 *   deriveIrrigationInchesPerWeek(input, irrigationRateOptions())
 *   resolveApplicationRate(input, irrigationRateOptions())  /  buildWeekPlan({ ..., rates: irrigationRates() })
 * A customer's MEASURED rate (typed weekly inches plus a runtime) outranks either table, unchanged.
 *
 * FREEZE RULE (Codex round 1 on #6236): a NEW week-plan decision records the table it used in its snapshot's
 * decisionInputs as `rateTable: 'owner'` (key written ONLY for the owner table). Replay and every renderer of a STORED
 * plan take the table from that key through storedRateTable(); a row without the key is a plan decided before the
 * owner's table went live and keeps the package table, so a stored or already-sent plan never changes its minutes.
 *
 * irrigationRates / irrigationRateOptions / liveRateTable / resolveRateTable() answer "what table is in force today"
 * (always the owner's). Only these may call them: (a) the ONE read that opens a new week-plan decision
 * (weeklyInputsForCustomer, once per decision, whose result feeds the move guard AND the decision), and (b) readers that
 * show today's preferences and compare nothing with a stored plan (the report's water card, the completion-time
 * longer-cycles answer that is frozen in its record).
 * Everything else takes a table as an ARGUMENT: scheduleUnconfirmedAfterMove / sizingFieldsUnconfirmed REQUIRE one
 * (they throw without it), and replay, the sweep's re-decide and the stored-plan renderers pass storedRateTable(...).
 */
const { HEAD_PRECIP_RATE_IN_PER_HR, OWNER_HEAD_RATE_IN_PER_HR } = require('@waves/irrigation-runtime');

function irrigationRates() {
  return OWNER_HEAD_RATE_IN_PER_HR;
}

// The { rates } option deriveIrrigationInchesPerWeek and resolveApplicationRate take.
function irrigationRateOptions() {
  return { rates: irrigationRates() };
}

// 'owner' | 'package': the table a NEW decision uses (always the owner's).
function liveRateTable() {
  return 'owner';
}

// The table a STORED decision used: its decisionInputs.rateTable, else the package table (legacy rows). Never the gate.
function storedRateTable(decisionInputs) {
  return decisionInputs && decisionInputs.rateTable === 'owner' ? 'owner' : 'package';
}

// Anything that is not exactly 'owner' or 'package' (including undefined) means "decide now": the live table.
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
  liveRateTable,
  storedRateTable,
  resolveRateTable,
  ratesForTable,
  rateOptionsForTable,
  rateTableInputs,
};
