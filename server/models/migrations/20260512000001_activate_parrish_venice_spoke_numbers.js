/**
 * Align Twilio-backed attribution rows with their live site / campaign
 * references so the admin dashboard never falls back to "Unmapped".
 *
 * Evidence checked 2026-05-12:
 * - Twilio friendly names:
 *   +19412535279 -> parrishpestcontrol.com
 *   +19412411388 -> veniceflpestcontrol.com
 *   +19412691697 -> Google Ads
 * - Astro spoke config:
 *   parrish_pest_main -> +19412535279
 *   venice_pest_main  -> +19412411388
 *   north_port_pest_main -> +19412589109
 */

const SPOKE_SOURCES = [
  {
    name: 'Spoke Pest — parrishpestcontrol.com',
    twilio_phone_number: '+19412535279',
    twilio_phone_sid: 'PN156798905dd717123bb818f41bc0ff71',
    domain: 'parrishpestcontrol.com',
    landing_page_url: 'https://parrishpestcontrol.com',
  },
  {
    name: 'Spoke Pest — veniceflpestcontrol.com',
    twilio_phone_number: '+19412411388',
    twilio_phone_sid: 'PN08e0d814516e374320813cb270aa6671',
    domain: 'veniceflpestcontrol.com',
    landing_page_url: 'https://veniceflpestcontrol.com',
  },
  {
    name: 'Spoke Pest — northportflpestcontrol.com',
    twilio_phone_number: '+19412589109',
    twilio_phone_sid: 'PNaada7fb89b37c9371d35624e97562c6c',
    domain: 'northportflpestcontrol.com',
    landing_page_url: 'https://northportflpestcontrol.com',
  },
];

const PAID_SOURCES = [
  {
    name: 'Google Ads — Pest (call-extension)',
    source_type: 'google_ads',
    channel: 'paid',
    twilio_phone_number: '+19412691697',
    twilio_phone_sid: 'PN2b33299302e2e48e99a54fa57acc1353',
    domain: null,
    landing_page_url: null,
    cost_type: 'paid',
    notes: 'Google Ads call-extension tracking number. Twilio friendly name confirmed 2026-05-12.',
  },
];

const GBP_SOURCES = [
  {
    name: 'GBP — Lakewood Ranch',
    twilio_phone_number: '+19413187612',
    twilio_phone_sid: 'PN0040f38868dd9d9cdba92ccae2ab239a',
    gbp_location_id: '11325506936615341094',
  },
  {
    name: 'GBP — Sarasota',
    twilio_phone_number: '+19412972606',
    twilio_phone_sid: 'PNfe2e60e5ca41ea65a7574b9df1168ac0',
    gbp_location_id: '2262372053807555721',
  },
  {
    name: 'GBP — Parrish',
    twilio_phone_number: '+19412972817',
    twilio_phone_sid: 'PN6ca156221e130182872a4ae674844fbf',
    gbp_location_id: '3749219908465956526',
  },
  {
    name: 'GBP — Venice',
    twilio_phone_number: '+19412973337',
    twilio_phone_sid: 'PN7708056fb5a11b11bb2f30eb3c644208',
    gbp_location_id: '9775694678945206688',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  for (const row of SPOKE_SOURCES) {
    await upsertByPhone(knex, row.twilio_phone_number, {
      name: row.name,
      source_type: 'spoke_site',
      channel: 'organic',
      twilio_phone_sid: row.twilio_phone_sid,
      domain: row.domain,
      landing_page_url: row.landing_page_url,
      cost_type: 'free',
      is_active: true,
      updated_at: knex.fn.now(),
    });
  }

  for (const row of PAID_SOURCES) {
    await upsertByPhone(knex, row.twilio_phone_number, {
      ...row,
      is_active: true,
      updated_at: knex.fn.now(),
    });
  }

  // These are GBP/direct location lines, not spoke-site rows. Clear stale
  // domain values left by older seed config and keep the dashboard labels
  // explicitly GBP.
  for (const row of GBP_SOURCES) {
    await upsertByPhone(knex, row.twilio_phone_number, {
      name: row.name,
      source_type: 'gbp',
      channel: 'organic',
      twilio_phone_sid: row.twilio_phone_sid,
      gbp_location_id: row.gbp_location_id,
      domain: null,
      landing_page_url: null,
      cost_type: 'free',
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
