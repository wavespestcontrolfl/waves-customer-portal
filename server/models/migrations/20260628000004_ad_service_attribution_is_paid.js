/**
 * ad_service_attribution.is_paid — explicit paid/organic dimension for the funnel.
 *
 * Facebook is the one paid lead_source that ALSO collects organic social: a
 * utm_source=facebook web lead lands lead_source='facebook' with no fbclid/_fbc,
 * and the paid filters (ad-cost-allocation.applyPaidFilter and
 * channel-attribution.splitFacebookByPaid) treat such rows as ORGANIC. Phone
 * calls to the paid Facebook tracking number carry no Meta click cookies
 * (fbclid/_fbc) either, so without a paid marker they'd be mis-bucketed organic
 * too — defeating the whole point of recording paid Facebook calls in the funnel.
 *
 * is_paid records the dimension directly: call-sourced rows come from paid
 * tracking numbers (google_ads + facebook) so they set is_paid=true and count as
 * PAID even with no click id. Nullable so the many legacy/web rows stay NULL
 * (= unknown) and keep their existing fbclid/_fbc behavior unchanged.
 *
 * Idempotent (hasTable + hasColumn); existing rows are untouched.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('ad_service_attribution');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'is_paid');
  if (hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.boolean('is_paid');
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('ad_service_attribution');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'is_paid');
  if (!hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.dropColumn('is_paid');
  });
};
