/**
 * Say "Waves" once per text — SMS templates (owner rulings 2026-09-28).
 *
 * A day-before reminder read "Hello <name>! Waves Waves Assessment:
 * tomorrow, …" and a confirmation read "Your Waves Assessment with Waves is
 * booked": the 2026-09-26 copy audit (20260926120000) put "Waves" next to
 * {service_type}/{service}, and two catalog services already carry the
 * brand in their own name ("Waves Assessment", "Waves Pest Control
 * Appointment Service"). The render-time fix (admin-sms-templates.js) stops
 * that from happening again for any future catalog name; this migration
 * fixes everything else the owner called out in the same pass:
 *
 *   - Every remaining customer text says "Waves" exactly once (several
 *     said "we"/"our" for an action Waves itself took — rain-out moves,
 *     emailed guides, dropped-call follow-ups — and now name the company).
 *   - No owner name ("Adam") in automated copy — those two-touch templates
 *     now read "it's Waves" instead of "Adam with/from Waves" (upsell_*
 *     also loses its first-person "I"/"me" phrasing, which was written
 *     for one specific owner-technician voice).
 *   - First texts to a brand-new lead say "Waves", not the fuller "Waves
 *     Pest Control" (lead_auto_reply_biz).
 *   - appointment_recurring_placement_confirmed's "stay as they are until
 *     we go over them with you" was read back by the owner as unclear;
 *     reworded to "won't change unless we talk with you first."
 *   - service_cancellation_scoped_confirmation and
 *     plan_hold_resume_reminder were missing the word "service" after the
 *     {service}/{service} variable, reading like "your Waves Lawn Care is
 *     cancelled" instead of "your Waves Lawn Care service is cancelled".
 *
 * Every body stays GSM-7 (straight apostrophes only) and no rewrite adds a
 * segment at typical lengths. Exact-body CAS, same contract as
 * 20260926120000 / 20260928050000: a template an administrator has since
 * edited is left alone, and down() only restores a body this migration
 * itself set (never overwrites a later admin edit).
 */
const SWAPS = [
  [
    "appointment_series_rescheduled",
    "Hello {first_name}! Your recurring Waves visits now start {start_date}{window_text}.\n\nWe'll text a reminder before each one.",
    "Hello {first_name}! Your recurring Waves visits now start {start_date}{window_text}.\n\nWe'll send you a reminder before each visit."
  ],
  [
    "appointment_recurring_placement_confirmed",
    "Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. We'll book each later visit within 3 days of its due date. Visits already on your calendar stay as they are until we go over them with you.",
    "Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. We'll book each later visit within 3 days of its due date. Visits already on your calendar won't change unless we talk with you first."
  ],
  [
    "service_report_v1_with_invoice",
    "Hello {first_name}! {service_type} report: {report_url}\n\nInvoice: {pay_url}\n\n{past_due_line}",
    "Hello {first_name}! Waves {service_type} report: {report_url}\n\nInvoice: {pay_url}\n\n{past_due_line}"
  ],
  [
    "service_complete_with_invoice",
    "Hello {first_name}! {service_type} report: {portal_url}\n\nInvoice: {pay_url}\n\n{past_due_line}",
    "Hello {first_name}! Waves {service_type} report: {portal_url}\n\nInvoice: {pay_url}\n\n{past_due_line}"
  ],
  [
    "rain_out_moved_v3",
    "Hi {first_name}, {weather_lead}, so we moved your {service_type} to {new_option}.{link_clause}",
    "Hi {first_name}, {weather_lead}, so Waves moved your {service_type} to {new_option}.{link_clause}"
  ],
  [
    "rain_out_moved_v2",
    "Hello {first_name}, {weather_lead}, so we moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}",
    "Hello {first_name}, {weather_lead}, so Waves moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}"
  ],
  [
    "rain_out_moved",
    "Hello {first_name}, {weather_phrase} rolled through your area, so we moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}",
    "Hello {first_name}, {weather_phrase} rolled through your area, so Waves moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}"
  ],
  [
    "rain_out_moved_custom_v1",
    "Hi {first_name} - {custom_message}\n\nWe've moved your {service_type} to {new_option}.{link_clause}",
    "Hi {first_name} - {custom_message}\n\nWaves moved your {service_type} to {new_option}.{link_clause}"
  ],
  [
    "secure_appointment_card",
    "Hi {first_name}! To finish booking your {service_type}{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after service.\n\n{cancel_fee_line}We never take card numbers by phone.",
    "Hi {first_name}! To finish booking your Waves {service_type}{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after service.\n\n{cancel_fee_line}We never take card numbers by phone."
  ],
  [
    "secure_appointment_card_plans",
    "Hello {first_name}! {service_type}{date_line}: prepay the year and save, or pay per application by card.\n\n{secure_link}\nNothing is charged today unless you prepay.\n\n{cancel_fee_line}We never take card numbers by phone.",
    "Hello {first_name}! Waves {service_type}{date_line}: prepay the year and save, or pay per application by card.\n\n{secure_link}\nNothing is charged today unless you prepay.\n\n{cancel_fee_line}We never take card numbers by phone."
  ],
  [
    "auto_bed_bug",
    "Hello {first_name}! We emailed your bed bug treatment guide. Please read it before your visit so the treatment works as well as it can.",
    "Hello {first_name}! Waves emailed your bed bug treatment guide. Please read it before your visit so the treatment works as well as it can."
  ],
  [
    "auto_cockroach",
    "Hello {first_name}! We emailed your cockroach treatment guide. Please read it before your visit so the treatment works as well as it can.",
    "Hello {first_name}! Waves emailed your cockroach treatment guide. Please read it before your visit so the treatment works as well as it can."
  ],
  [
    "auto_flea",
    "Hello {first_name}! We emailed your flea treatment guide. Please read it before your visit so the treatment works as well as it can.",
    "Hello {first_name}! Waves emailed your flea treatment guide. Please read it before your visit so the treatment works as well as it can."
  ],
  [
    "auto_prep_guide_link",
    "Hello {first_name}! Your {prep_label} prep guide is here: {prep_url}\n\nPlease read it before your visit so everything goes as smoothly as possible.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your Waves {prep_label} prep guide is here: {prep_url}\n\nPlease read it before your visit so everything goes as smoothly as possible.\n\nQuestions or requests? Reply here."
  ],
  [
    "booking_abandonment_recovery",
    "Hello {first_name}! Your {service_type} spot isn't reserved yet. Pick a time and you're set: {booking_url}\n\nReply STOP to opt out.",
    "Hello {first_name}! Your Waves {service_type} spot isn't reserved yet. Pick a time and you're set: {booking_url}\n\nReply STOP to opt out."
  ],
  [
    "annual_prepay_renewal_reminder",
    "Hello {first_name}! Your prepaid plan year ends on {term_end}.{last_service_sentence}\n\nIt continues into next year on its own. Want to change or cancel? Reply and we'll help.",
    "Hello {first_name}! Your Waves prepaid plan year ends on {term_end}.{last_service_sentence}\n\nIt continues into next year on its own. Want to change or cancel? Reply and we'll help."
  ],
  [
    "lawn_health_report_ready",
    "Hello {first_name}! Your lawn health report is ready. You scored {overall_score}/100{delta_line}.{tip_line}\n\nFull report: {portal_url}",
    "Hello {first_name}! Your Waves lawn health report is ready. You scored {overall_score}/100{delta_line}.{tip_line}\n\nFull report: {portal_url}"
  ],
  [
    "review_request",
    "Thanks for having us out, {first_name}! A Google review would mean a lot: {review_url}",
    "Thanks for having Waves out, {first_name}! A Google review would mean a lot: {review_url}"
  ],
  [
    "review_request_followup",
    "No pressure, {first_name}. If you have a minute, your review helps other SWFL families find a pest company they can trust: {google_review_url}",
    "No pressure, {first_name}. If you have a minute, your review of Waves helps other SWFL families find a pest company they can trust: {google_review_url}"
  ],
  [
    "lead_auto_reply_biz",
    "Hello {first_name}! Waves Pest Control here. We got your quote request and someone will call you shortly.\n\nReply STOP to opt out.",
    "Hello {first_name}! Waves here. We got your quote request and someone will call you shortly.\n\nReply STOP to opt out."
  ],
  [
    "voicemail_quote_link",
    "Hello {first_name}, it's Waves Pest Control. We got your message about {service_label}, and your quote is here: {quote_url}\n\nSomeone from the Waves team will follow up as soon as possible. Or reply and we'll call you back.\n\nReply STOP to opt out.",
    "Hello {first_name}, it's Waves. We got your message about {service_label}, and your quote is here: {quote_url}\n\nSomeone from the Waves team will follow up as soon as possible. Or reply and we'll call you back.\n\nReply STOP to opt out."
  ],
  [
    "dropped_call_address_request",
    "Hello {first_name}, it's Waves Pest Control. It looks like our call dropped. Reply with your service address and we'll get your quote moving, or call us back{callback_clause}.\n\nReply STOP to opt out.",
    "Hello {first_name}, it's Waves. It looks like our call dropped. Reply with your service address and we'll get your quote moving, or call us back{callback_clause}.\n\nReply STOP to opt out."
  ],
  [
    "referral_invite",
    "Hello {referee_name}! {referrer_name} recommended Waves Pest Control to you. Get a free quote here: {referral_link}\n\nReply STOP to opt out.",
    "Hello {referee_name}! {referrer_name} recommended Waves to you. Get a free quote here: {referral_link}\n\nReply STOP to opt out."
  ],
  [
    "upsell_add_service",
    "Hello {first_name}! Adam from Waves here. Since you are already a WaveGuard member, we can add {service_name} to your plan with bundled service savings. Want details? Reply YES.",
    "Hello {first_name}, it's Waves. Since you are already a WaveGuard member, we can add {service_name} to your plan with bundled service savings. Want details? Reply YES."
  ],
  [
    "upsell_tier_upgrade",
    "Hello {first_name}! Adam from Waves here. Upgrading to WaveGuard {next_tier} can add more coverage and service savings. Want me to run the numbers? Reply YES and I will send a breakdown.",
    "Hello {first_name}, it's Waves. Upgrading to WaveGuard {next_tier} can add more coverage and service savings. Want us to run the numbers? Reply YES and we'll send a breakdown."
  ],
  [
    "service_cancellation_scoped_confirmation",
    "Hello {first_name}, your Waves {service} is cancelled as of {effective_date}. {remaining} continue as before, and completed visits stay payable. Changed your mind or have a question? Reply here.",
    "Hello {first_name}, your Waves {service} service is cancelled as of {effective_date}. {remaining} continue as before, and completed visits stay payable. Changed your mind or have a question? Reply here."
  ],
  [
    "plan_hold_resume_reminder",
    "Hello {first_name}! Your Waves {service} hold ends {resume_date}, and your visits start again then. Want a different date, or to cancel instead? Reply here.",
    "Hello {first_name}! Your Waves {service} service hold ends {resume_date}, and your visits start again then. Want a different date, or to cancel instead? Reply here."
  ],
];

const MIGRATION = '20260928200000_sms_brand_just_waves';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  for (const [key, before, after] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || row.body !== before) continue; // missing, or an admin edit already changed it — leave it alone
    // Compare-and-swap on the body we read: an admin save landing between
    // the read and this update wins instead of being overwritten.
    const changed = await knex('sms_templates')
      .where({ id: row.id, body: before })
      .update({ body: after, updated_at: knex.fn.now() });
    if (changed && hasAudit) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: 'sms_template.delivery_copy_updated',
        resource_type: 'sms_templates', resource_id: String(row.id),
        metadata: { migration: MIGRATION, template_key: key },
        critical: true, trx: knex,
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const [key, before, after] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || row.body !== after) continue; // not this migration's own value — never touch a later admin edit
    await knex('sms_templates')
      .where({ id: row.id, body: after })
      .update({ body: before, updated_at: knex.fn.now() });
  }
};

exports._SWAPS = SWAPS;
