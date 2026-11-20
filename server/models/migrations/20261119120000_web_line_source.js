/**
 * Seed the lead_sources row for the website-only phone line +19412542617
 * ((941) 254-2617), bought 2026-11-19 for wavespestcontrol.com. Inbound calls
 * resolve their lead_source_id from this row (utils/call-lead-source.js matches
 * the dialed number against lead_sources.twilio_phone_number), so a call to the
 * line files under the main site, and the Leads screen can tell it apart from
 * the shared main line (lead-source-evidence.js reads the row's number).
 *
 * Values mirror the existing main-site row (20260425000003): source_type
 * 'main_site' (ads/call-attribution.js maps it to waves_website), channel
 * 'organic', domain wavespestcontrol.com, cost_type 'free'.
 *
 * Two database histories, one attribution and cost:
 *  - Production ran the April registry seed (20260401000096) before this line
 *    existed, so no row has the number: insert the row.
 *  - A fresh database (CI, previews) runs that April seed against today's
 *    registry, which lists this line, so the seed's generated row is already
 *    there (phone_tracking / website_organic: no funnel channel; per_month
 *    2.50, a cost lead ROI reads when no spend is logged). Give that row this
 *    seed's name, source type, channel, cost type and monthly cost, only while
 *    all five still hold the April values, and record one audit_log row.
 *    Notes, active status and URL are left exactly as they are.
 * A row with any of those five changed (an office edit) is left as it is.
 * The number matches on the resolver's exact formats, so a row this seed
 * leaves alone is still a row inbound calls find.
 */
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:april_defaults` must fit.
const MIGRATION = '20261119120000_web_line_source';
const NUMBER = '+19412542617';
// leadSourceNumberVariants('+19412542617') in utils/call-lead-source.js.
const NUMBER_FORMATS = ['+19412542617', '9412542617', '19412542617', '(941) 254-2617'];

const ROW = {
  name: 'Main Site — web-only line (wavespestcontrol.com)',
  source_type: 'main_site',
  channel: 'organic',
  twilio_phone_number: NUMBER,
  twilio_phone_sid: 'PN6cf7b72b0908028cea7935aff7e54fcd',
  domain: 'wavespestcontrol.com',
  landing_page_url: 'https://wavespestcontrol.com',
  cost_type: 'free',
  monthly_cost: 0,
  is_active: true,
  notes: 'Website-only line, shown only to wavespestcontrol.com visitors. Not on invoices, citations or Google Business Profiles.',
};

// The attribution and cost fields 20260401000096 generates for this line on a
// fresh database, and the values this seed gives them. Only these five change.
const APRIL_SEED_FIELDS = {
  name: 'wavespestcontrol.com — General',
  source_type: 'phone_tracking',
  channel: 'website_organic',
  cost_type: 'per_month',
  monthly_cost: 2.5,
};
const SEEDED_FIELDS = {
  name: ROW.name,
  source_type: ROW.source_type,
  channel: ROW.channel,
  cost_type: ROW.cost_type,
  monthly_cost: ROW.monthly_cost,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  const existing = await knex('lead_sources').whereIn('twilio_phone_number', NUMBER_FORMATS).first();
  if (!existing) {
    await knex('lead_sources').insert(ROW);
    return;
  }

  const changed = await knex('lead_sources')
    .where({ id: existing.id, ...APRIL_SEED_FIELDS })
    .update({ ...SEEDED_FIELDS, updated_at: knex.fn.now() });
  if (!changed || !(await knex.schema.hasTable('audit_log'))) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:april_defaults`,
    resource_type: 'lead_sources',
    resource_id: String(existing.id),
    metadata: {
      migration: MIGRATION,
      columns: Object.keys(APRIL_SEED_FIELDS),
      before: APRIL_SEED_FIELDS,
      after: SEEDED_FIELDS,
    },
    critical: true,
    trx: knex,
  });
};

// Seed rollback — never destructive. Leads that called the line point at this
// row (lead_source_id), and the office may have edited it since (renamed it,
// set its cost, marked it inactive); a delete would strand those leads and
// erase the edit.
exports.down = async function down() {};
