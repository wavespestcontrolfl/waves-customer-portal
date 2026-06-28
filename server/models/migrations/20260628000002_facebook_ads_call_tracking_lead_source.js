/**
 * DNI Phase B2 — register the Facebook Ads paid call-tracking number in
 * lead_sources so inbound calls to it resolve a source-tagged lead.
 *
 * Background: lead-attribution (attributeInboundContact) only tags a call's
 * source if a lead_sources row exists with that `twilio_phone_number` and
 * is_active = true. The Google Ads paid number (+19412691697) was already
 * seeded in 20260425000003_seed_lead_sources.js (source_type 'google_ads',
 * channel 'paid'), so it needs no row here. The now-live Facebook Ads — Pest
 * number (+19418775491, Bradenton) was NOT seeded anywhere, so its inbound
 * calls would resolve no source and create untagged leads.
 *
 * Without this row, /calls-by-source joins call_log.to_phone → lead_sources
 * and shows the Facebook number as "Unmapped", and the call-created lead's
 * lead_source_id is left null (invisible to channel attribution / the offline-
 * conversion pipeline).
 *
 * Idempotent: the row is upserted by twilio_phone_number — re-running is a
 * no-op if it already exists (preserves operator-edited cost columns).
 */

const FACEBOOK_CALL_SOURCES = [
  {
    name: 'Facebook Ads — Pest',
    twilio_phone_number: '+19418775491',
    // Twilio SID not confirmed at migration time; attribution keys on the
    // phone number, so the SID is optional and left null until known.
    twilio_phone_sid: null,
    notes: 'Facebook Ads paid call-tracking number (Bradenton). DNI Phase B2.',
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
