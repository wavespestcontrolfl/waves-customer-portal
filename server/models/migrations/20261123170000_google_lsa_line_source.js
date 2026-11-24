/**
 * Seed the lead_sources row for the Google Local Services line +19412135010
 * ((941) 213-5010), a Bradenton number bought 2026-11-23 (owner: "yes buy, make
 * sure its bradenton based number") to be the phone on the Local Services
 * profile only. Inbound calls resolve their lead_source_id from this row
 * (utils/call-lead-source.js matches the dialed number against
 * lead_sources.twilio_phone_number), and ads/call-attribution.js maps
 * source_type 'google_lsa' to the paid google_lsa funnel channel, the key the
 * daily Local Services sync (ads/google-lsa.js) writes cost to.
 *
 * Values mirror the Google Ads and Facebook call-extension rows: channel 'paid',
 * cost_type 'paid', monthly and per-lead cost 0 (Google's per-lead charge comes
 * from ad_performance_daily, not from this row).
 *
 * The April registry seed (20260401000096) does not read paidTracking, so no
 * database has a row for this number yet. Insert it only when no row holds the
 * number in any format the resolver matches; a row that exists is left as it is.
 */
const NUMBER = '+19412135010';
// leadSourceNumberVariants('+19412135010') in utils/call-lead-source.js.
const NUMBER_FORMATS = ['+19412135010', '9412135010', '19412135010', '(941) 213-5010'];

const ROW = {
  name: 'Google LSA — Local Services profile line',
  source_type: 'google_lsa',
  channel: 'paid',
  twilio_phone_number: NUMBER,
  twilio_phone_sid: 'PN690de49f4fc36b56bcb0e24a81309c78',
  cost_type: 'paid',
  monthly_cost: 0,
  cost_per_lead: 0,
  is_active: true,
  notes: 'Phone on the Google Local Services profile only (bought 2026-11-23). Not on the website, GBP, citations or invoices. Spend comes from the daily Local Services sync (ad_performance_daily, platform google_lsa).',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;
  const existing = await knex('lead_sources').whereIn('twilio_phone_number', NUMBER_FORMATS).first('id');
  if (existing) return;
  await knex('lead_sources').insert(ROW);
};

// Seed rollback is never destructive: leads that called the line point at this
// row (lead_source_id), and the office may have edited it since.
exports.down = async function down() {};
