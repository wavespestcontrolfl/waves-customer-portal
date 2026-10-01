/**
 * Normalize every automated-SMS intro to "it's Waves" (owner ruling
 * 2026-09-28): brand is "Waves", never "Waves Pest Control" and never a
 * person's name, and the several spellings used to introduce Waves on a
 * text ("Waves here", "this is Waves Pest Control") collapse to one phrase.
 * 20260928210000_sms_brand_just_waves already did this for most templates
 * (and for the two upsells, "it's Waves"); this migration finishes the
 * sweep on the five lead/service-intro templates that pass had not reached,
 * plus reschedule_link_promise — deliberately skipped by that earlier pass
 * with no recorded reason. A check of its own dependents
 * (20260909000092_reschedule_link_promises.js, the outbox generation
 * migration, admin-sms-templates.js's REQUIRED_TEMPLATE_PLACEHOLDERS) found
 * nothing that pins its exact wording or needs the full company name — it
 * only requires the {link} placeholder — so it is safe to fold in here.
 *
 * "Hello {first_name}! Waves here." / "Hello {first_name}, Waves here."
 * becomes "Hello {first_name}, it's Waves." (the "!" or "," after the name
 * becomes ","); "Hi {first}, this is Waves Pest Control." becomes
 * "Hi {first}, it's Waves." Every other word is unchanged.
 *
 * Every body stays GSM-7 (straight apostrophes only). The five "Waves
 * here" -> "it's Waves" swaps are exact character-count trades (13 -> 13),
 * so no template gains a segment; reschedule_link_promise's swap removes
 * 17 characters.
 *
 * Exact-body CAS on both sms_templates and sms_template_variants (getTemplate
 * renders a selected variant INSTEAD of the base row), same contract as
 * 20260928210000: a row an administrator has edited is left alone.
 */
const SWAPS = [
  [
    'lead_auto_reply_biz',
    'Hello {first_name}! Waves here. We got your quote request and someone will call you shortly.\n\nReply STOP to opt out.',
    "Hello {first_name}, it's Waves. We got your quote request and someone will call you shortly.\n\nReply STOP to opt out."
  ],
  [
    'missed_call',
    'Hello {first_name}! Waves here. Sorry we missed your call. How can we help?\n\nReply STOP to opt out.',
    "Hello {first_name}, it's Waves. Sorry we missed your call. How can we help?\n\nReply STOP to opt out."
  ],
  [
    'price_change_notice',
    'Hello {first_name}, Waves here. Your recurring service price changes on {effective_date}. New price and details: {price_change_url}',
    "Hello {first_name}, it's Waves. Your recurring service price changes on {effective_date}. New price and details: {price_change_url}"
  ],
  [
    'service_cancellation_received',
    'Hello {first_name}, Waves here. We got your cancellation request. A team member is handling it and will confirm within 1 business day exactly what has stopped.',
    "Hello {first_name}, it's Waves. We got your cancellation request. A team member is handling it and will confirm within 1 business day exactly what has stopped."
  ],
  [
    'service_resolution_confirmation',
    'Hello {first_name}! Waves here. Done: {summary} Reference: {reference}. Nothing else on your plan changes. Questions? Reply here.',
    "Hello {first_name}, it's Waves. Done: {summary} Reference: {reference}. Nothing else on your plan changes. Questions? Reply here."
  ],
  [
    'reschedule_link_promise',
    'Hi {first}, this is Waves Pest Control. As promised, choose a new appointment time here: {link}. Reply here if you need help. Reply STOP to opt out.',
    "Hi {first}, it's Waves. As promised, choose a new appointment time here: {link}. Reply here if you need help. Reply STOP to opt out."
  ],
];

const MIGRATION = '20260928230000_sms_intro_its_waves';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  for (const table of tables) {
    const rows = await knex(table).whereIn('template_key', [...swaps.keys()]).select('id', 'template_key', 'body');
    for (const row of rows) {
      const { before, after } = swaps.get(row.template_key);
      if (row.body !== before) continue; // an admin edit already changed it — leave it alone
      // Exact-body CAS protects an administrator save racing this migration.
      const changed = await knex(table)
        .where({ id: row.id, body: before })
        .update({ body: after, updated_at: knex.fn.now() });
      if (changed && hasAudit) {
        const { recordAuditEvent } = require('../../services/audit-log');
        await recordAuditEvent({
          actor_type: 'system', action: 'sms_template.delivery_copy_updated',
          resource_type: table, resource_id: String(row.id),
          metadata: { migration: MIGRATION, template_key: row.template_key },
          critical: true, trx: knex,
        });
      }
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: up() preserves admin edits, and a body matching
  // this migration's copy may be an administrator's own — reverting seeded
  // copy would erase it (waves-db data-correction rule).
};

exports._SWAPS = SWAPS;
