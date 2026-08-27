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
//   2. the lead's OWN recorded classification, extracted_data.attribution
//      .leadSource.source = 'google_ads' (covers manually tagged
//      utm_source=google&utm_medium=cpc with no click id — note: lead-response
//      triage REPLACES extracted_data on non-call leads, so this block is
//      often gone; the next two signals cover those);
//   3. the webhook's funnel row: ad_service_attribution.lead_source =
//      'google_ads' keyed by lead_id;
//   4. ONLY when the lead carries no attribution of its own — neither an
//      extracted_data.attribution block NOR a linked ad_service_attribution
//      funnel row naming a different source (e.g. 'facebook') — the linked
//      customer's first-touch utm_data (source google / medium cpc). Same
//      precedence rule as 20260626000008_backfill_gbp_web_leads_per_city: a
//      customer's stale first touch must never override lead-level evidence.
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

  const otherGoogleAdsRows = knex('lead_sources').select('id')
    .where({ source_type: 'google_ads' }).whereNot({ id: row.id });
  const updated = await knex('leads')
    .whereNull('deleted_at')
    .whereIn('first_contact_channel', WEB_CHANNELS)
    .where((qb) => qb.whereNull('lead_source_id').orWhereIn('lead_source_id', otherGoogleAdsRows))
    .where((qb) => {
      // NULLIF(BTRIM()) — an empty / whitespace-only click id is not paid
      // evidence (the live classifier tests truthiness, not presence).
      qb.whereRaw("NULLIF(BTRIM(gclid), '') IS NOT NULL")
        .orWhereRaw("NULLIF(BTRIM(wbraid), '') IS NOT NULL")
        .orWhereRaw("NULLIF(BTRIM(gbraid), '') IS NOT NULL")
        .orWhereRaw("extracted_data->'attribution'->'leadSource'->>'source' = 'google_ads'");
      if (hasFunnelLeadId) {
        qb.orWhereExists(knex('ad_service_attribution as a')
          .whereRaw('a.lead_id = leads.id')
          .where('a.lead_source', 'google_ads'));
      }
      if (hasCustomerUtm) {
        qb.orWhere((q2) => {
          q2.whereRaw("extracted_data->'attribution' IS NULL");
          if (hasFunnelLeadId) {
            // A funnel row for this lead that says anything other than
            // google_ads is lead-level evidence that CONTRADICTS the
            // customer's first touch — the fallback must not apply.
            q2.whereNotExists(knex('ad_service_attribution as a2')
              .whereRaw('a2.lead_id = leads.id')
              .whereNot('a2.lead_source', 'google_ads'));
          }
          q2.whereExists(knex('customers as c')
            .whereRaw('c.id = leads.customer_id')
            .whereRaw("LOWER(COALESCE(c.utm_data->>'source', '')) = 'google'")
            .whereRaw("LOWER(COALESCE(c.utm_data->>'medium', '')) = 'cpc'"));
        });
      }
    })
    .update({ lead_source_id: row.id, updated_at: knex.fn.now() });
   
  console.log(`[google_ads_web_form] backfilled ${updated} lead(s) onto "${WEB_FORM_NAME}"`);
};

// Non-destructive by design (matches 20260425000003_seed_lead_sources): the
// row may already carry operator-entered cost data and backfilled FKs.
exports.down = async function down() {};
