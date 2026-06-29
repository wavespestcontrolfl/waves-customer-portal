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
 * Idempotent (hasTable + hasColumn); existing rows keep is_paid NULL except the
 * targeted backfill below.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('ad_service_attribution');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'is_paid');
  if (hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.boolean('is_paid');
  });

  // Backfill already-recorded CALL-sourced paid rows, identified precisely by
  // lead linkage: a paid lead_source, NO click id (phone calls carry none), and a
  // lead whose first_contact_channel='call'. This rescues any Facebook call rows
  // recorded before this column existed from being mis-bucketed organic by the
  // fbclid/_fbc-only filters. (google_ads rows are unaffected by is_paid — it
  // isn't a paidOnly channel, so its paid filter already counts every row; the
  // flag is harmless and consistent there.) Rows WITH a click id are deliberately
  // excluded — those are web first-touch, already paid via fbclid/_fbc.
  // Guarded so a missing leads table / first_contact_channel column is a no-op
  // (not a migration failure); idempotent (only flips matching NULL rows → true).
  const hasLeads = await knex.schema.hasTable('leads');
  const hasChannelCol = hasLeads && await knex.schema.hasColumn('leads', 'first_contact_channel');
  if (hasChannelCol) {
    await knex('ad_service_attribution')
      .whereIn('lead_source', ['google_ads', 'facebook'])
      .whereNull('fbclid')
      .whereNull('fbc')
      .whereIn('lead_id', knex('leads').select('id').where('first_contact_channel', 'call'))
      .update({ is_paid: true });
  }
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
