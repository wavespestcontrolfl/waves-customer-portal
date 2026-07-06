/**
 * SMS template library cleanup (owner-directed audit, 2026-07-06).
 *
 * Removes templates whose flows are retired or whose sends move to other
 * templates, reactivates templates that live send paths still render, seeds
 * the flea treatment-prep text (bed bug / cockroach equivalents already
 * exist as auto_bed_bug / auto_cockroach) and the deposit receipt, and
 * regroups the library into moment-based categories.
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
  // WaveGuard monthly pre-charge text retired — autopay customers already
  // get the autopay pre-charge notice; the extra monthly text was noise.
  'billing_reminder',
  // Self-bookings now confirm through the shared appointment_confirmation
  // flow (registerAppointment sendConfirmation) — prefs/channel-aware with
  // email fallback, replacing the bespoke code/address text.
  'self_booking_confirmation',
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

const NEW_TEMPLATES = [
  {
    template_key: 'auto_flea',
    name: 'Flea Treatment',
    category: 'onboarding',
    body: "Hello {first_name}! Let's get your home flea-free. We emailed your Waves treatment guide; please review it before service so we can get the best results.\n\nQuestions or requests? Reply here.",
    description: 'Treatment-prep text sent when a first-time flea treatment is booked.',
    variables: JSON.stringify(['first_name']),
    is_active: true,
    is_internal: false,
    sort_order: 100,
  },
  {
    template_key: 'deposit_receipt',
    name: 'Deposit Receipt',
    category: 'invoices',
    body: 'Hello {first_name}! We received your ${amount} deposit — it will be applied toward your first visit. Thank you for choosing Waves!\n\nQuestions or requests? Reply here.',
    description: 'Sent once when an estimate deposit payment succeeds (webhook or accept-time verification).',
    variables: JSON.stringify(['first_name', 'amount']),
    is_active: true,
    is_internal: false,
    sort_order: 100,
  },
];

// Library re-grouping (owner-directed 2026-07-06): the old buckets were
// lopsided (billing carried 36 templates) and named by mechanism, not by
// customer moment. Categories only affect admin-library grouping — the UI
// derives its filter list from the live rows, so no client change rides
// along. 'custom' rows and any key not listed keep their category.
const RECATEGORIZED_TEMPLATE_KEYS = {
  leads: ['lead_auto_reply_biz', 'voicemail_quote_link', 'missed_call'],
  estimates: [
    'estimate_sent', 'estimate_followup_unviewed', 'estimate_followup_viewed',
    'estimate_followup_final', 'estimate_followup_expiring', 'estimate_followup_deposit',
    'estimate_accepted_onetime', 'estimate_accepted_annual_prepay',
    'estimate_extended', 'quote_wizard_booking_invite',
  ],
  appointments: [
    'appointment_confirmation', 'reminder_72h', 'reminder_24h',
    'tech_en_route', 'tech_arrived', 'appointment_no_show', 'rain_out_moved',
    'appointment_rescheduled', 'appointment_cancelled',
    'appointment_series_rescheduled', 'appointment_series_cancelled',
    'booking_abandonment_recovery',
  ],
  onboarding: [
    'auto_new_recurring', 'auto_new_appointment',
    'auto_bed_bug', 'auto_cockroach', 'auto_flea',
  ],
  'service-reports': [
    'service_complete', 'service_complete_prepaid', 'service_complete_with_invoice',
    'service_report_v1', 'service_report_v1_with_invoice',
    'lawn_health_report_ready', 'project_report_ready',
  ],
  requests: ['service_request_confirmation'],
  invoices: [
    'invoice_sent', 'invoice_sent_upfront', 'invoice_sent_annual_prepay',
    'invoice_receipt', 'manual_payment_receipt', 'payment_failed',
    'ach_payment_processing', 'annual_prepay_payment_reminder',
    'invoice_followup_3day', 'invoice_followup_7day',
    'invoice_followup_14day', 'invoice_followup_30day',
  ],
  'late-payments': [
    'late_payment_7d', 'late_payment_14d', 'late_payment_30d',
    'late_payment_60d', 'late_payment_90d',
    'balance_reminder_gentle', 'balance_reminder_firm', 'balance_reminder_urgent',
    'balance_payment_received',
  ],
  autopay: [
    'autopay_pre_charge', 'autopay_charge_success', 'autopay_charge_failed',
    'autopay_retry_success', 'autopay_retry_failed', 'autopay_retry_final_failed',
    'autopay_card_expired', 'autopay_card_expiring', 'payment_method_expiry',
    'ach_retry_notice', 'ach_card_fallback', 'ach_suspended',
    'bank_verification_incomplete', 'bank_verification_failed',
  ],
  cancellations: [
    'service_cancellation_confirmation',
    'cancellation_save_step1_price', 'cancellation_save_step1_moving',
    'cancellation_save_step1_quality', 'cancellation_save_step1_default',
    'cancellation_save_step2_price', 'cancellation_save_step2_moving',
    'cancellation_save_step2_quality', 'cancellation_save_step2_default',
    'cancellation_save_step3', 'cancellation_save_accepted_offer',
    'cancellation_save_callback_requested', 'cancellation_save_cancelled',
  ],
  retention: [
    'renewal_reminder', 'annual_prepay_renewal_reminder', 'auto_service_renewal',
    'seasonal_reactivation', 'upsell_interest_confirmation',
    'upsell_tier_upgrade', 'upsell_add_service',
  ],
  referrals: [
    'referral_enrollment', 'referral_invite', 'referral_milestone',
    'referral_nudge', 'referral_reward',
  ],
  reviews: ['review_request', 'review_request_followup'],
  // Not message copy — these three rows are the ops kill switches the
  // twilio send layer consults via isTemplateActive (AI conversational
  // replies + draft-approval sends).
  system: ['ai_assistant', 'ai_approved', 'ai_revised'],
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

  for (const template of NEW_TEMPLATES) {
    const existing = await knex('sms_templates')
      .where({ template_key: template.template_key })
      .first('id');
    if (!existing) {
      await knex('sms_templates').insert(template);
    }
  }

  // Category only — bodies, names, and active flags stay whatever the admin
  // last saved.
  for (const [category, keys] of Object.entries(RECATEGORIZED_TEMPLATE_KEYS)) {
    await knex('sms_templates')
      .whereIn('template_key', keys)
      .whereNot({ category })
      .update({ category, updated_at: new Date() });
  }
};

exports.down = async function down() {
  // Removed templates are intentionally not restored (house precedent:
  // 20260616000003_sms_templates_remove_retired_copy.js).
};
