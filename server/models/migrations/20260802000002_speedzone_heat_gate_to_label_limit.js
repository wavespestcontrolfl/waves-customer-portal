// Bring the SpeedZone Southern heat gate down from 90°F to the label limit of
// 85°F, across the DB operating layer (AGENTS.md lawn protocol data fan-out).
//
// The label says it twice, verbatim:
//
//   "Do not broadcast apply this product when ambient temperatures are below
//    50°F or above 85°F; some injury may be expected with spot treatments when
//    air temperatures exceed 85°F."
//
// Our gates authorized it up to 90°F, which opened an 86-90°F band where the
// field workflow would green-light an application the label prohibits. This is
// not a tuning preference: a gate may be MORE conservative than the label,
// never more permissive. 85°F is a compliance floor, and the owner remains
// free to set a lower threshold — just not a higher one.
//
// The substitution path already exists and is unchanged: Celsius WG is the
// documented hot-season broadleaf fallback (and on bahia, where there is no
// bahia-safe hot-season herbicide, the protocol defers instead). Only the
// threshold moves, so nothing new has to be wired.
//
// Companion changes in the same commit: server/config/protocols.json (the
// field-exec source of truth, 22 gate references) and products_catalog
// (max_temp_f, in 20260802000001).
//
// Gate KEYS are intentionally left alone — `speedzone_heat_gate` and the
// `heat_above_90_speedzone_substitute` trigger are identifiers other code and
// tests look up by name. Renaming them to say 85 would be cosmetic and would
// risk breaking those lookups; the numeric logic and the human-readable text
// are what actually gate the work.

const OLD_MAX = 90;
const NEW_MAX = 85;

exports.OLD_MAX = OLD_MAX;
exports.NEW_MAX = NEW_MAX;

async function shiftGateThreshold(knex, { from, to }) {
  // lawn_protocol_gates.logic is jsonb: {"product":"SpeedZone","maxTempF":90}
  if (await knex.schema.hasTable('lawn_protocol_gates')) {
    await knex('lawn_protocol_gates')
      .where('gate_key', 'speedzone_heat_gate')
      .whereRaw("logic->>'maxTempF' = ?", [String(from)])
      .update({
        logic: knex.raw("jsonb_set(logic, '{maxTempF}', ?::jsonb)", [String(to)]),
      });

    // rule_text is what a technician actually reads.
    await knex('lawn_protocol_gates')
      .where('gate_key', 'speedzone_heat_gate')
      .whereRaw('rule_text LIKE ?', [`%${from}°F%`])
      .update({
        rule_text: knex.raw('REPLACE(rule_text, ?, ?)', [`${from}°F`, `${to}°F`]),
      });
  }

  // lawn_protocol_products.gates is jsonb: {"maxTempF":90,"gateProduct":"SpeedZone..."}
  if (await knex.schema.hasTable('lawn_protocol_products')) {
    await knex('lawn_protocol_products')
      .whereRaw("gates->>'maxTempF' = ?", [String(from)])
      .whereRaw('product_name ILIKE ?', ['%speedzone%'])
      .update({
        gates: knex.raw("jsonb_set(gates, '{maxTempF}', ?::jsonb)", [String(to)]),
      });
  }

  // The window GOAL copy is what a technician actually reads in Command
  // Center, completion context, assignments and reports — leaving it at 90°F
  // would keep telling them SpeedZone is permitted in the band the gate now
  // blocks. `service_report_context.goal` is a jsonb duplicate of the same
  // string on the same row and must move with it; a parity test asserts the
  // two stay identical, so they are updated together in one statement.
  if (await knex.schema.hasTable('lawn_protocol_windows')) {
    await knex('lawn_protocol_windows')
      .whereRaw('goal LIKE ?', [`%${from}°F%`])
      .whereRaw('goal ILIKE ?', ['%speedzone%'])
      .update({
        goal: knex.raw('REPLACE(goal, ?, ?)', [`${from}°F`, `${to}°F`]),
        // Build the nested copy from the TOP-LEVEL goal rather than from
        // itself. Deriving it from service_report_context->>'goal' breaks two
        // ways: the column defaults to '{}', so a window without a nested goal
        // yields REPLACE(NULL, ...) = NULL and jsonb_set then returns NULL,
        // violating the NOT NULL constraint and aborting the whole migration;
        // and a nested goal that had already drifted would stay drifted while
        // the top-level moved. Sourcing both from `goal` restores parity in
        // every case. (Postgres evaluates SET expressions against the row's
        // pre-update values, so `goal` here is the old string.)
        service_report_context: knex.raw(
          "jsonb_set(COALESCE(service_report_context, '{}'::jsonb), '{goal}', to_jsonb(REPLACE(goal, ?, ?)))",
          [`${from}°F`, `${to}°F`],
        ),
      });
  }
}

exports.up = async function up(knex) {
  await shiftGateThreshold(knex, { from: OLD_MAX, to: NEW_MAX });
};

exports.down = async function down(knex) {
  // Symmetric, and equally guarded: only rows still reading 85 move back.
  await shiftGateThreshold(knex, { from: NEW_MAX, to: OLD_MAX });
};
