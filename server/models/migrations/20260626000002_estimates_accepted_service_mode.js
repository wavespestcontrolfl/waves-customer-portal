/**
 * estimates.accepted_service_mode + accepted_frequency_key — the service mode
 * ('recurring' | 'one_time') and the recurring frequency the customer actually
 * accepted, persisted at accept time.
 *
 * Why: with the React estimate view now the default (migration
 * 20260626000001), a customer reopening an ACCEPTED estimate is served the
 * React page, which renders a read-only recap of the agreed services + pricing.
 * That recap must reflect what they booked, but the page otherwise DERIVES both:
 *  - mode from `defaultServiceModeForEstimate`, which falls back to 'recurring'
 *    for a mixed recurring/one-time estimate — so a one-time acceptance would be
 *    misrepresented as the recurring plan; and
 *  - the recurring frequency from `section.defaultFrequencyKey`, so a customer
 *    who booked bi-monthly/monthly would see the default (quarterly) card/price.
 * The accept endpoint only echoed these in its immediate success payload;
 * nothing was stored. These columns record them so the recap (and any later
 * read) matches the committed transaction.
 *
 * Nullable: legacy accepted rows predate this and stay null; the recap falls
 * back to the derived mode/frequency for them (unchanged behavior).
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.text('accepted_service_mode').nullable();
    t.text('accepted_frequency_key').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('accepted_service_mode');
    t.dropColumn('accepted_frequency_key');
  });
};
