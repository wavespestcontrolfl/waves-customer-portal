/**
 * DNI Phase B2 — map the Facebook Ads paid call-tracking number in lead_sources
 * for RECOGNITION ONLY (not lead attribution in this PR).
 *
 * Purpose: so call_log.to_phone → lead_sources.twilio_phone_number joins
 * recognize +19418775491 as the Facebook Ads line. Without this row the admin
 * "unmapped inbound call" alert and /calls-by-source flag the number as
 * "Unmapped" (its calls land in call_log labeled numberType 'facebook' via
 * twilio-numbers.js, but with no matching lead_sources row to join against).
 *
 * This is NOT a lead-attribution row in this PR:
 *   - Facebook is intentionally ABSENT from PAID_TRACKING_TYPES in
 *     twilio-voice-webhook.js, so attributeInboundContact never creates a
 *     Facebook call lead. (Google Ads is the only attributed paid line in B2.)
 *   - The `.whereNull('twilio_phone_number')` guards in lead-webhook.js and
 *     lead-source-resolver.js keep web/quote Facebook leads from ever resolving
 *     to this phone-keyed row — so re-adding it introduces no web-lead skew.
 * Net: Facebook calls are recognized + mapped + labeled now; lead attribution
 * (and the PPC funnel) is deferred to the Facebook follow-up.
 *
 * Idempotent: the row is upserted by twilio_phone_number — re-running is a
 * no-op if it already exists (preserves operator-edited cost columns).
 */

const FACEBOOK_CALL_SOURCES = [
  {
    name: 'Facebook Ads — Pest',
    twilio_phone_number: '+19418775491',
    // Twilio SID not confirmed at migration time; the join keys on the phone
    // number, so the SID is optional and left null until known.
    twilio_phone_sid: null,
    notes: 'Facebook Ads paid call-tracking number (Bradenton). DNI Phase B2 — recognition/mapping only; lead attribution deferred to the Facebook follow-up.',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  for (const row of FACEBOOK_CALL_SOURCES) {
    await upsertByPhone(knex, row.twilio_phone_number, {
      name: row.name,
      source_type: 'facebook',
      channel: 'paid',
      twilio_phone_sid: row.twilio_phone_sid,
      domain: null,
      landing_page_url: null,
      gbp_location_id: null,
      cost_type: 'paid',
      is_active: true,
      notes: row.notes,
      updated_at: knex.fn.now(),
    });
  }
};

async function upsertByPhone(knex, twilioPhoneNumber, patch) {
  const existing = await knex('lead_sources')
    .where({ twilio_phone_number: twilioPhoneNumber })
    .first();

  if (existing) {
    // Refresh identity/label fields only; preserve operator-edited cost
    // columns (monthly_cost / cost_per_lead / setup_cost) and the SID if one
    // was already filled in (don't null a known SID with our placeholder).
    const refresh = { ...patch };
    if (refresh.twilio_phone_sid == null) delete refresh.twilio_phone_sid;
    await knex('lead_sources').where({ id: existing.id }).update(refresh);
    return;
  }

  await knex('lead_sources').insert({
    ...patch,
    twilio_phone_number: twilioPhoneNumber,
  });
}

exports.down = async function down() {};
