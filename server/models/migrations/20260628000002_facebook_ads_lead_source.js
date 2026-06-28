/**
 * DNI — register the Facebook Ads call-extension tracking number
 * (+19418775491) in lead_sources so inbound FB-ad calls are attributed to
 * source_type='facebook' (paid) instead of logging as "Unmapped" on
 * /calls-by-source and leaving lead_source_id null in call-recording lead
 * creation.
 *
 * Mirrors the Google Ads paid row + the idempotent upsertByPhone seed
 * pattern (20260425000003 / 20260512000001). Meta ad spend is tracked via
 * ad_performance_daily (platform=facebook), so monthly_cost stays 0 to avoid
 * double-counting CAC.
 */

const FB_SOURCE = {
  name: 'Facebook Ads — Pest (call-extension)',
  source_type: 'facebook',
  channel: 'paid',
  twilio_phone_number: '+19418775491',
  twilio_phone_sid: 'PN8cbe5f3387b41b87b7d0c74078403364',
  cost_type: 'paid',
  notes: 'Facebook/Meta Ads call-extension tracking number (DNI, 2026-06-28). Routed to /voice; Trust Hub + A2P registered. Meta spend tracked via ad_performance_daily (platform=facebook), not monthly_cost.',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  await upsertByPhone(knex, FB_SOURCE.twilio_phone_number, {
    name: FB_SOURCE.name,
    source_type: FB_SOURCE.source_type,
    channel: FB_SOURCE.channel,
    twilio_phone_sid: FB_SOURCE.twilio_phone_sid,
    domain: null,
    landing_page_url: null,
    gbp_location_id: null,
    cost_type: FB_SOURCE.cost_type,
    is_active: true,
    notes: FB_SOURCE.notes,
    updated_at: knex.fn.now(),
  });
};

async function upsertByPhone(knex, twilioPhoneNumber, patch) {
  const existing = await knex('lead_sources')
    .where({ twilio_phone_number: twilioPhoneNumber })
    .first();

  if (existing) {
    await knex('lead_sources').where({ id: existing.id }).update(patch);
    return;
  }

  await knex('lead_sources').insert({
    ...patch,
    twilio_phone_number: twilioPhoneNumber,
  });
}

exports.down = async function down() {};
