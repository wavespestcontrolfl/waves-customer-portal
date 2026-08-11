// Sticky cancel window (owner ruling 2026-08-10) — frozen per-row policy
// marker. A cancellation fee may be applied on the strength of an in-window
// reschedule ONLY when the row's consent surface disclosed that rule
// ("Rescheduling is free but doesn't reset the cancellation window").
// Default FALSE and stamped explicitly by post-deploy code at the same
// moments the fee terms themselves freeze, so:
//   - every row consented under the OLD copy stays non-sticky forever, and
//   - rows inserted by still-running pre-deploy code during a rolling
//     deploy also stay non-sticky (an ALTER-time default of true would
//     retro-authorize those).
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimate_card_holds')) {
    if (!(await knex.schema.hasColumn('estimate_card_holds', 'sticky_window_disclosed'))) {
      await knex.schema.alterTable('estimate_card_holds', (t) => {
        t.boolean('sticky_window_disclosed').notNullable().defaultTo(false);
      });
    }
  }
  if (await knex.schema.hasTable('appointment_card_requests')) {
    if (!(await knex.schema.hasColumn('appointment_card_requests', 'sticky_window_disclosed'))) {
      await knex.schema.alterTable('appointment_card_requests', (t) => {
        t.boolean('sticky_window_disclosed').notNullable().defaultTo(false);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('estimate_card_holds')) {
    if (await knex.schema.hasColumn('estimate_card_holds', 'sticky_window_disclosed')) {
      await knex.schema.alterTable('estimate_card_holds', (t) => {
        t.dropColumn('sticky_window_disclosed');
      });
    }
  }
  if (await knex.schema.hasTable('appointment_card_requests')) {
    if (await knex.schema.hasColumn('appointment_card_requests', 'sticky_window_disclosed')) {
      await knex.schema.alterTable('appointment_card_requests', (t) => {
        t.dropColumn('sticky_window_disclosed');
      });
    }
  }
};
