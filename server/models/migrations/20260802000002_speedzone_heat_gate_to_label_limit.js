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

// The label's St. Augustine-only seasonal prohibitions, recorded structurally
// alongside the temperature bounds. Both are defined by turf CONDITION rather
// than by calendar month, which is why nothing here maps them to dates.
const SEASONAL_BLOCK = ['spring_green_up', 'fall_to_winter_transition'];

exports.OLD_MAX = OLD_MAX;
exports.NEW_MAX = NEW_MAX;
exports.SEASONAL_BLOCK = SEASONAL_BLOCK;

async function shiftGateThreshold(knex, { from, to }) {
  // lawn_protocol_gates.logic is jsonb: {"product":"SpeedZone","maxTempF":90}
  if (await knex.schema.hasTable('lawn_protocol_gates')) {
    await knex('lawn_protocol_gates')
      .where('gate_key', 'speedzone_heat_gate')
      .whereRaw("logic->>'maxTempF' = ?", [String(from)])
      .update({
        logic: knex.raw("jsonb_set(logic, '{maxTempF}', ?::jsonb)", [String(to)]),
      });

    // Same completeness point as the product gates below, and the same
    // per-key independence — an existing value is never overwritten.
    await knex('lawn_protocol_gates')
      .where('gate_key', 'speedzone_heat_gate')
      .whereRaw("NOT (COALESCE(logic, '{}'::jsonb) \\? 'minTempF')")
      .update({
        logic: knex.raw("jsonb_set(COALESCE(logic, '{}'::jsonb), '{minTempF}', ?::jsonb)", ['50']),
      });

    await knex('lawn_protocol_gates')
      .where('gate_key', 'speedzone_heat_gate')
      .whereRaw("NOT (COALESCE(logic, '{}'::jsonb) \\? 'stAugustineSeasonalBlock')")
      .update({
        logic: knex.raw(
          "jsonb_set(COALESCE(logic, '{}'::jsonb), '{stAugustineSeasonalBlock}', ?::jsonb)",
          [JSON.stringify(SEASONAL_BLOCK)],
        ),
      });

    // rule_text is what a technician actually reads — the numbers inside
    // `logic` are advisory metadata that nothing evaluates against live
    // weather, so this string is the gate in practice.
    await knex('lawn_protocol_gates')
      .where('gate_key', 'speedzone_heat_gate')
      .whereRaw('rule_text LIKE ?', [`%${from}°F%`])
      .update({
        rule_text: knex.raw('REPLACE(rule_text, ?, ?)', [`${from}°F`, `${to}°F`]),
      });

    // The label prohibits more than the upper bound, and the rest of it was
    // recorded only in products_catalog.heat_restrictions where the protocol
    // sources never see it. Append the lower bound and the St. Augustine
    // seasonal prohibitions so the gate a tech reads carries the whole rule.
    // Idempotent: skipped once the sentence is present.
    await knex('lawn_protocol_gates')
      .where('gate_key', 'speedzone_heat_gate')
      .whereRaw('rule_text NOT LIKE ?', ['%below 50°F%'])
      .update({
        rule_text: knex.raw("rule_text || ?", [
          ' Also do not broadcast below 50°F, and do not apply to St. Augustinegrass'
          + ' during spring green-up or the fall-to-winter transition (or when temperatures'
          + ' are expected below 40°F within 10 days).',
        ]),
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

    // Record the rest of the label's limits alongside the ceiling so the
    // structured row is complete rather than half a rule.
    //
    // BE CLEAR ABOUT WHAT THIS DOES: nothing evaluates these numbers against
    // live weather. `gates` is checked for PRESENCE (admin-lawn-assessment
    // excludes gated products from auto-planning) and rendered into the SOP a
    // technician reads; there is no plan matcher consuming maxTempF today, and
    // that was already true of the ceiling before this change. These keys make
    // the record complete and correct for whenever an evaluator does arrive —
    // they are not, on their own, enforcement. The enforcement that reaches a
    // person is the rule_text and visit copy updated above.
    // Each key is backfilled INDEPENDENTLY and only where absent.
    //
    // Keying this off maxTempF = 85 was wrong three ways: a stricter admin
    // ceiling (say 80) would skip the backfill entirely; a row that already had
    // minTempF but no seasonal block stayed incomplete; and `gates || {...}`
    // would have overwritten an existing seasonal block whenever minTempF
    // happened to be absent. jsonb_set adds a missing key without disturbing
    // any other, so an existing value always wins.
    await knex('lawn_protocol_products')
      .whereRaw('product_name ILIKE ?', ['%speedzone%'])
      .whereRaw("NOT (COALESCE(gates, '{}'::jsonb) \\? 'minTempF')")
      .update({
        gates: knex.raw("jsonb_set(COALESCE(gates, '{}'::jsonb), '{minTempF}', ?::jsonb)", ['50']),
      });

    await knex('lawn_protocol_products')
      .whereRaw('product_name ILIKE ?', ['%speedzone%'])
      .whereRaw("NOT (COALESCE(gates, '{}'::jsonb) \\? 'stAugustineSeasonalBlock')")
      .update({
        gates: knex.raw(
          "jsonb_set(COALESCE(gates, '{}'::jsonb), '{stAugustineSeasonalBlock}', ?::jsonb)",
          [JSON.stringify(SEASONAL_BLOCK)],
        ),
      });
  }

  // service_product_usage carries an operator-facing note that 20260401000091
  // seeded as "weather gate >90°F". Prod has no SpeedZone row in that table
  // today (verified read-only: 32 rows, none matching), so this is a no-op
  // there — but a database replayed from migrations DOES get the row, and it
  // would then contradict every other source. Guarded on the old value so a
  // reworded note is never clobbered.
  if (await knex.schema.hasTable('service_product_usage')) {
    await knex('service_product_usage')
      .whereRaw('product ILIKE ?', ['%speedzone%'])
      .whereRaw('notes LIKE ?', [`%${from}°F%`])
      .update({ notes: knex.raw('REPLACE(notes, ?, ?)', [`${from}°F`, `${to}°F`]) });
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

// Deliberately a no-op — and here the reason is stronger than for the sibling
// migrations. Shifting these gates back to 90°F would re-open the 86-90°F band
// the label prohibits, so an automatic rollback would restore an off-label
// authorization across every protocol source at once. A rollback is meant to
// undo a bad deploy, not to reinstate a compliance gap.
//
// It also cannot tell a row it changed from one already reading 85°F because
// someone corrected it by hand — the same value-is-not-provenance problem as
// the sibling migrations.
//
// To raise the threshold deliberately, change it in the protocol editor, where
// the decision is visible and attributable.
exports.down = async function down() {};
