/**
 * estimates.accepted_service_mode — the service mode the customer actually
 * accepted ('recurring' | 'one_time'), persisted at accept time.
 *
 * Why: with the React estimate view now the default (migration
 * 20260626000001), a customer reopening an ACCEPTED estimate is served the
 * React page, which renders a read-only recap of the agreed services + pricing.
 * That recap must reflect the mode they booked, but the page otherwise derives
 * mode from `defaultServiceModeForEstimate`, which falls back to 'recurring'
 * for a mixed recurring/one-time estimate — so a one-time acceptance would be
 * misrepresented as the recurring plan. The accept endpoint only echoed
 * `serviceMode` in its immediate success payload; nothing was stored. This
 * column records it so the recap (and any later read) is accurate.
 *
 * Nullable: legacy accepted rows predate this and stay null; the recap falls
 * back to the derived mode for them (unchanged behavior).
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.text('accepted_service_mode').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('accepted_service_mode');
  });
};
