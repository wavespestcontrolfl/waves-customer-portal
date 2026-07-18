// Freeze the booking-time accepted amount onto the card-hold row (Codex
// #2821 P1). The completion-charge cap must compare against what the
// customer accepted AT BOOKING — scheduled_services.estimated_price is
// rewritten by the admin appointment editors (admin-schedule.js), so a
// pre-completion staff price edit would silently raise the cap and let the
// saved card be charged an amount the customer never consented to. Same
// frozen-terms discipline as no_show_fee_amount / cancel_window_hours on
// this table: stamped inside the accept transaction, never re-read from
// live, mutable state.
//
// Backfill: existing non-terminal holds ('held', plus transient 'charging'
// rows that revert to 'held' on a failed charge) get today's
// estimated_price as the best available record of the accepted amount —
// without it every pre-migration hold would fail closed into manual review
// at completion. Terminal rows (charged/released/failed) never consult the
// cap and are left NULL.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_card_holds'))) return;
  if (!(await knex.schema.hasColumn('estimate_card_holds', 'accepted_amount'))) {
    await knex.schema.alterTable('estimate_card_holds', (t) => {
      t.decimal('accepted_amount', 10, 2);
    });
  }
  await knex.raw(`
    UPDATE estimate_card_holds h
    SET accepted_amount = ss.estimated_price
    FROM scheduled_services ss
    WHERE ss.id = h.scheduled_service_id
      AND h.accepted_amount IS NULL
      AND h.status IN ('held', 'charging')
      AND ss.estimated_price > 0
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimate_card_holds'))) return;
  if (await knex.schema.hasColumn('estimate_card_holds', 'accepted_amount')) {
    await knex.schema.alterTable('estimate_card_holds', (t) => {
      t.dropColumn('accepted_amount');
    });
  }
};
