// Google Ads — Web Form lead source + backfill.
//
// The form webhook (routes/lead-webhook.js) classifies any gclid/wbraid/gbraid
// submission as source 'google_ads' (services/lead-source-classify.js) but its
// lead_sources resolver block had no google_ads branch, so EVERY paid-Google
// web-form lead landed with lead_source_id NULL → "Unattributed" in
// leads-by-source, an undercounted Google Ads column in LTV:CAC, and a
// perpetual "lead this week missing a source" dashboard alert.
//
// Until now the only google_ads row was the call-extension tracking number.
// Web-form leads get their own row (no twilio_phone_number) so call vs form
// conversions stay separable in source ROI. Both webhook and resolver prefer
// the phone-less row for web traffic; call attribution keys on the phone
// number, so the call-extension row is unaffected.
//
// Backfill: NULL-source leads that the live path would classify google_ads.
// Evidence, in the order the live code produces it (any one suffices):
//   1. a Google click id on the lead (gclid/wbraid/gbraid — auto-tagging);
//   2. the lead's OWN recorded classification — the webhook's
//      extracted_data.attribution.leadSource.source = 'google_ads', or the
//      quote wizard's top-level extracted_data.utm source=google/medium=cpc
//      (covers manually tagged utm_source=google&utm_medium=cpc with no click
//      id — note: lead-response triage REPLACES extracted_data on non-call
//      leads, so these blocks are often gone; the next signals cover those);
//   3. the webhook's funnel row: ad_service_attribution.lead_source =
//      'google_ads' keyed by lead_id;
//   4. ONLY when the lead carries no attribution block of its own, the
//      linked customer's first-touch utm_data (source google / medium cpc).
// Precedence: explicit lead-level evidence for ANOTHER source (attribution
// block or funnel row naming e.g. 'facebook') disqualifies the lead from
// every arm above — click ids included — mirroring the live classifier and
// 20260626000008_backfill_gbp_web_leads_per_city.
// Scope: WEB channels only — 'form' (lead-webhook), 'website_quote'
// (public-quote / public-property-lookup) and 'web' (lead-estimate-link),
// i.e. exactly the paths that run the two resolvers patched alongside this
// migration. ad_service_attribution.lead_source='google_ads' is also written
// for paid CALLS (recordCallPpcAttribution) and a customer's UTM first touch
// is not form-specific — a call lead must never be relabeled as a web form
// (calls attribute by tracking number to the call-extension row).
//
// Candidates are web leads with NO source (the webhook gap) AND web leads
// already sitting on a DIFFERENT google_ads row: before this change
// resolveLeadSource picked an arbitrary source_type='google_ads' row
// (call-extension or call-reporting bridge), so those web conversions are
// currently counted as calls. Both sets move to the web-form row.
// Idempotent: the row is looked up by name; re-running matches nothing.
const WEB_FORM_NAME = 'Google Ads — Web Form';
const WEB_CHANNELS = ['form', 'website_quote', 'web'];


// The backfill UPDATE, exported so its predicate can be asserted in a jest
// test (rendered SQL) without a database.
function buildBackfillQuery(knex, rowId, { hasFunnelLeadId, hasCustomerUtm }) {
  const otherGoogleAdsRows = knex('lead_sources').select('id')
    .where({ source_type: 'google_ads' }).whereNot({ id: rowId });
  return knex('leads')
    .whereNull('deleted_at')
    .whereIn('first_contact_channel', WEB_CHANNELS)
    .where((qb) => qb.whereNull('lead_source_id').orWhereIn('lead_source_id', otherGoogleAdsRows))
    // Explicit lead-level evidence for ANOTHER source wins over every arm
    // below, click ids included — the live classifier evaluates Facebook /
    // Nextdoor UTMs before Google click ids, and Facebook-keyed leads are
    // known to carry a lingering gclid (admin-dashboard.js). Mirror that.
    .whereRaw("COALESCE(extracted_data->'attribution'->'leadSource'->>'source', 'google_ads') = 'google_ads'")
    // quote-wizard top-level UTM naming another source is the same kind of
    // lead-level evidence (facebook / gbp / nextdoor …).
    .whereRaw("COALESCE(NULLIF(LOWER(BTRIM(extracted_data->'utm'->>'source')), ''), 'google') = 'google'")
    // …and the legacy GBP tuple (source=google, medium=organic, campaign=gbp)
    // is GBP, not paid search — both live classifiers test isGbpUtmCampaign
    // (config/locations.js) BEFORE click ids. Mirror that.
    .whereRaw("NOT (LOWER(BTRIM(COALESCE(extracted_data->'utm'->>'source', ''))) = 'google'"
      + " AND LOWER(BTRIM(COALESCE(extracted_data->'utm'->>'medium', ''))) = 'organic'"
      + " AND LOWER(BTRIM(COALESCE(extracted_data->'utm'->>'campaign', ''))) = 'gbp')")
    .modify((qb) => {
      if (hasFunnelLeadId) {
        qb.whereNotExists(knex('ad_service_attribution as a2')
          .whereRaw('a2.lead_id = leads.id')
          .whereNot('a2.lead_source', 'google_ads'));
      }
    })
    .where((qb) => {
      // NULLIF(BTRIM()) — an empty / whitespace-only click id is not paid
      // evidence (the live classifier tests truthiness, not presence).
      qb.whereRaw("NULLIF(BTRIM(gclid), '') IS NOT NULL")
        .orWhereRaw("NULLIF(BTRIM(wbraid), '') IS NOT NULL")
        .orWhereRaw("NULLIF(BTRIM(gbraid), '') IS NOT NULL")
        .orWhereRaw("extracted_data->'attribution'->'leadSource'->>'source' = 'google_ads'")
        // quote-wizard leads (public-property-lookup / public-quote) persist
        // the raw UTM at top-level extracted_data.utm — a google/cpc lead
        // abandoned before any customer or funnel row exists has only this.
        .orWhereRaw("LOWER(COALESCE(extracted_data->'utm'->>'source', '')) = 'google' AND LOWER(COALESCE(extracted_data->'utm'->>'medium', '')) = 'cpc'");
      if (hasFunnelLeadId) {
        qb.orWhereExists(knex('ad_service_attribution as a')
          .whereRaw('a.lead_id = leads.id')
          .where('a.lead_source', 'google_ads'));
      }
      if (hasCustomerUtm) {
        qb.orWhere((q2) => {
          // (contradictory funnel rows / UTMs are already excluded above);
          // BOTH lead-level attribution locations must be absent — the
          // webhook's attribution block AND the quote wizard's top-level utm
          // — before a customer's stale first touch is consulted.
          q2.whereRaw("extracted_data->'attribution' IS NULL")
            .whereRaw("extracted_data->'utm' IS NULL");
          q2.whereExists(knex('customers as c')
            .whereRaw('c.id = leads.customer_id')
            .whereRaw("LOWER(COALESCE(c.utm_data->>'source', '')) = 'google'")
            .whereRaw("LOWER(COALESCE(c.utm_data->>'medium', '')) = 'cpc'"));
        });
      }
    })
    // lead_source_id ONLY — updated_at is the pipeline's last-activity
    // timestamp (stale-lead queue, opportunity ordering); an attribution
    // correction is not activity (same as the GBP per-city backfill).
    .update({ lead_source_id: rowId });
   
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) {
    throw new Error('lead_sources table missing — run 20260401000095_lead_attribution first.');
  }

  let row = await knex('lead_sources').where({ name: WEB_FORM_NAME }).first();
  if (!row) {
    [row] = await knex('lead_sources')
      .insert({
        name: WEB_FORM_NAME,
        source_type: 'google_ads',
        channel: 'paid',
        cost_type: 'paid',
        is_active: true,
        notes: 'Web-form submissions arriving with a Google click id (gclid/wbraid/gbraid). '
          + 'Separate from the call-extension row so form vs call conversions stay distinguishable in ROI.',
      })
      .returning('*');
  }

  if (!(await knex.schema.hasTable('leads'))) return;
  const hasFunnelLeadId = (await knex.schema.hasTable('ad_service_attribution'))
    && (await knex.schema.hasColumn('ad_service_attribution', 'lead_id'));
  const hasCustomerUtm = (await knex.schema.hasTable('customers'))
    && (await knex.schema.hasColumn('customers', 'utm_data'));

  const updated = await buildBackfillQuery(knex, row.id, { hasFunnelLeadId, hasCustomerUtm });
  console.log(`[google_ads_web_form] backfilled ${updated} lead(s) onto "${WEB_FORM_NAME}"`);
};

// Non-destructive by design (matches 20260425000003_seed_lead_sources): the
// row may already carry operator-entered cost data and backfilled FKs.
exports.down = async function down() {};

exports.buildBackfillQuery = buildBackfillQuery;
