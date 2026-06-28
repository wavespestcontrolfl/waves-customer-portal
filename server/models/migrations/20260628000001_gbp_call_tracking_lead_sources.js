/**
 * DNI Phase A — register the 4 GBP call-button tracking numbers in
 * lead_sources, and re-tag the (formerly-GBP) real location numbers as the
 * website source.
 *
 * Background: each GBP profile used to put the *real* location number on its
 * "Call" button — the same number that's on the website city pages. That
 * conflation made GBP call counts include website callers. We bought one
 * dedicated tracking number per profile and set it as the GBP primary (real #
 * demoted to a GBP additional number; website + citations untouched).
 *
 * So attribution must move with it:
 *  - the NEW tracking numbers become the `gbp` source (per city), and
 *  - the real numbers become the website source (`main_site`), since that's
 *    what they now represent (NAP anchor on the city pages).
 *
 * Without this, /calls-by-source joins call_log.to_phone → lead_sources and
 * shows the new numbers as "Unmapped", and call-recording lead creation
 * leaves lead_source_id null. Leaving the real numbers as `gbp` would also
 * double-count GBP. (Already applied to production data 2026-06-28; this
 * migration makes it reproducible on fresh/staging DBs.)
 *
 * Idempotent: every row is upserted by twilio_phone_number.
 */

// New GBP call-button tracking numbers (one per profile). Twilio SIDs +
// gbp_location_id confirmed 2026-06-28; location ids mirror
// server/config/locations.js.
const GBP_CALL_SOURCES = [
  {
    name: 'GBP — Lakewood Ranch',
    twilio_phone_number: '+19413521572',
    twilio_phone_sid: 'PN44fbbc3368e25155ae51526e690c4f39',
    gbp_location_id: '11325506936615341094',
  },
  {
    name: 'GBP — Parrish',
    twilio_phone_number: '+19413840224',
    twilio_phone_sid: 'PN41f58ebe36b356ba3636aa73fc1d2baf',
    gbp_location_id: '3749219908465956526',
  },
  {
    name: 'GBP — Sarasota',
    twilio_phone_number: '+19414910407',
    twilio_phone_sid: 'PNde1ec94f2b9fe61eb2ebb36c3c2c057b',
    gbp_location_id: '2262372053807555721',
  },
  {
    name: 'GBP — Venice',
    twilio_phone_number: '+19414774880',
    twilio_phone_sid: 'PN34161ec4243b7397cbd59f80c70c6755',
    gbp_location_id: '9775694678945206688',
  },
];

// The real location numbers — formerly the GBP primaries, now the website
// (city-page) numbers. Re-tag gbp → main_site so website calls aren't
// labelled GBP. landing_page_url paths mirror locations.js gbpWebsitePath.
const WEBSITE_RETAG_SOURCES = [
  {
    name: 'Website — Bradenton (city page)',
    twilio_phone_number: '+19413187612',
    landing_page_url: 'https://wavespestcontrol.com/pest-control-bradenton-fl/',
  },
  {
    name: 'Website — Parrish (city page)',
    twilio_phone_number: '+19412972817',
    landing_page_url: 'https://wavespestcontrol.com/pest-control-parrish-fl/',
  },
  {
    name: 'Website — Sarasota (city page)',
    twilio_phone_number: '+19412972606',
    landing_page_url: 'https://wavespestcontrol.com/pest-control-sarasota-fl/',
  },
  {
    name: 'Website — Venice (city page)',
    twilio_phone_number: '+19412973337',
    landing_page_url: 'https://wavespestcontrol.com/pest-control-venice-fl/',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  for (const row of GBP_CALL_SOURCES) {
    await upsertByPhone(knex, row.twilio_phone_number, {
      name: row.name,
      source_type: 'gbp',
      channel: 'organic',
      twilio_phone_sid: row.twilio_phone_sid,
      gbp_location_id: row.gbp_location_id,
      domain: null,
      landing_page_url: null,
      // The GBP channel is organic/free; the $1.15/mo is the Twilio number rental.
      cost_type: 'per_month',
      monthly_cost: 1.15,
      is_active: true,
      updated_at: knex.fn.now(),
    });
  }

  for (const row of WEBSITE_RETAG_SOURCES) {
    await upsertByPhone(knex, row.twilio_phone_number, {
      name: row.name,
      source_type: 'main_site',
      channel: 'organic',
      domain: 'wavespestcontrol.com',
      landing_page_url: row.landing_page_url,
      // No longer a GBP source — clear the GBP deep-link id.
      gbp_location_id: null,
      is_active: true,
      updated_at: knex.fn.now(),
    });
  }
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
