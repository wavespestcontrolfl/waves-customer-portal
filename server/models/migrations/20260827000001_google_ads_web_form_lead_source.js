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
// Backfill: leads carrying a Google click id with no source are, by
// construction, paid-Google web leads — stamp them so history is attributed
// too. Idempotent: the row is looked up by name; the backfill only touches
// NULL-source rows.
const WEB_FORM_NAME = 'Google Ads — Web Form';

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
  const updated = await knex('leads')
    .whereNull('lead_source_id')
    .whereNull('deleted_at')
    .where((qb) => qb.whereNotNull('gclid').orWhereNotNull('wbraid').orWhereNotNull('gbraid'))
    .update({ lead_source_id: row.id, updated_at: knex.fn.now() });
   
  console.log(`[google_ads_web_form] backfilled ${updated} lead(s) onto "${WEB_FORM_NAME}"`);
};

// Non-destructive by design (matches 20260425000003_seed_lead_sources): the
// row may already carry operator-entered cost data and backfilled FKs.
exports.down = async function down() {};
