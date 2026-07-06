/**
 * SMS template library cleanup (owner-directed audit, 2026-07-06).
 *
 * Removes templates whose flows are retired or whose sends move to other
 * templates, reactivates two templates that live send paths still render,
 * and seeds the flea treatment-prep text (bed bug / cockroach equivalents
 * already exist as auto_bed_bug / auto_cockroach).
 *
 * Removed here AND from the TEMPLATES export in
 * 20260514000002_tighten_sms_template_copy.js — the boot seeder re-inserts
 * any missing key from that list, so a row delete without the seed edit
 * silently resurrects on the next deploy.
 */

const REMOVED_TEMPLATE_KEYS = [
  // NOTE: the cancellation_save_* templates are deliberately NOT removed —
  // owner kept the full save sequence (2026-07-06), templates stay inactive.
  // Call bookings now confirm through the shared appointment_confirmation
  // template (call-recording-processor rewire in this PR).
  'appointment_call_confirmed',
  // Health outreach texting retired; health alerts stay admin-facing.
  'health_check_in',
  'health_retention_offer',
  'health_rebook',
  'health_payment_reminder',
  'health_apology',
  'health_welcome_followup',
  // Post-service WaveGuard upsell workflow removed.
  'waveguard_upsell',
  // Seasonal tip blast retired (seasonal_reactivation is separate and kept).
  'seasonal_alert',
  // Estimates still auto-extend their expiry; the customer text is retired.
  'estimate_auto_renewed',
  // Completion-text overflow swap retired — long completion texts now send
  // at full length (recap-only trimming keeps the report link intact).
  'service_complete_concise',
  // Progress-headline report variant retired — the SMS is a gateway to the
  // report; the report itself carries the trend. Every visit sends the base
  // service_report_v1 text.
  'service_report_v1_progress',
  // Never wired to a live sender (sendRescheduleRequest had no callers, zero
  // prod sends); the rain-out engine owns weather moves with its own text.
  'reschedule_options_weather',
  'reschedule_options_access',
  'reschedule_options_general',
];

const REACTIVATED_TEMPLATE_KEYS = [
  // Public quote wizard booking invite — live send path in public-quote.js.
  'quote_wizard_booking_invite',
  // New-recurring welcome — queued ~1h after booking by this PR.
  'auto_new_recurring',
  // Treatment-prep texts rendered by the appointment tagger at booking.
  'auto_bed_bug',
  'auto_cockroach',
];

const FLEA_PREP_TEMPLATE = {
  template_key: 'auto_flea',
  name: 'Flea Treatment',
  category: 'automations',
  body: "Hello {first_name}! Let's get your home flea-free. We emailed your Waves treatment guide; please review it before service so we can get the best results.\n\nQuestions or requests? Reply here.",
  description: 'Treatment-prep text sent when a first-time flea treatment is booked.',
  variables: JSON.stringify(['first_name']),
  is_active: true,
  is_internal: false,
  sort_order: 100,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  if (await knex.schema.hasTable('sms_template_variants')) {
    await knex('sms_template_variants')
      .whereIn('template_key', REMOVED_TEMPLATE_KEYS)
      .del();
  }

  await knex('sms_templates')
    .whereIn('template_key', REMOVED_TEMPLATE_KEYS)
    .del();

  // Reactivate only — bodies stay whatever the admin last saved.
  await knex('sms_templates')
    .whereIn('template_key', REACTIVATED_TEMPLATE_KEYS)
    .where({ is_active: false })
    .update({ is_active: true, updated_at: new Date() });

  const existingFlea = await knex('sms_templates')
    .where({ template_key: FLEA_PREP_TEMPLATE.template_key })
    .first('id');
  if (!existingFlea) {
    await knex('sms_templates').insert(FLEA_PREP_TEMPLATE);
  }
};

exports.down = async function down() {
  // Removed templates are intentionally not restored (house precedent:
  // 20260616000003_sms_templates_remove_retired_copy.js).
};
