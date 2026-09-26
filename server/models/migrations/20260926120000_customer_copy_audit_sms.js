/**
 * Customer copy audit (2026-09-26) — SMS templates.
 *
 * A read of every active customer SMS template found three recurring
 * problems, fixed here without touching placeholders, fees, consent, links
 * or opt-out wording:
 *  - Bad-news texts opened with a cheerful "Hello {first_name}!" (cancelled
 *    visits, failed payments, 60/90-day past-due notices). Those now open
 *    with a comma; routine texts keep the house greeting.
 *  - Many texts never said they came from Waves after the 2026-09-07
 *    shortening pass ("{service_type}: {day}, {window}", "{tech_name} is on
 *    the way"). Each now names Waves once.
 *  - Factual drift: ACH copy said "3-5 business days" while the webhook
 *    stamps five business days; the bed bug no-email text said "12-18 in."
 *    and "your 14-day follow-up" while the prep guide says 18 inches and
 *    follow-ups (plural) at about 10-14 days; the flea text told customers
 *    to "coordinate with your vet" where the guide says treat every pet the
 *    same day; price_change_notice said "Nothing you need to do" about a
 *    price increase; invoice_followup_30day said "Final notice" although
 *    the late-payment job keeps sending 60- and 90-day notices after it.
 *
 * Every body stays GSM-7 and no rewrite adds a segment at typical lengths.
 * Exact-body CAS: a template an administrator has edited is left alone.
 */
const SWAPS = [
  [
    "appointment_cancelled",
    "Hello {first_name}! Your {service_type} on {day}, {date} is cancelled.\n\nWant to get back on the schedule? Reply here.",
    "Hello {first_name}, your {service_type} with Waves on {day}, {date} is cancelled.\n\nWant a new time? Reply here and we'll set it up."
  ],
  [
    "appointment_confirmation",
    "Hello {first_name}! Your {service_type} is confirmed for {date} at {time}.\n\n{reschedule_line}",
    "Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\n{reschedule_line}"
  ],
  [
    "appointment_no_show",
    "Hello {first_name}, it's {tech_name} from Waves. We missed you {when} at {time}. Reply here or give us a call and we'll find a new time.",
    "Hello {first_name}, it's {tech_name} from Waves. We came by {when} at {time} but couldn't complete your visit. Reply or call and we'll find a new time."
  ],
  [
    "appointment_rescheduled",
    "Hello {first_name}! Your {service_type} is now set for {day}, {date} at {time}.\n\nNeed to change it again? Reply here.",
    "Hello {first_name}! Your {service_type} with Waves is now {day}, {date} at {time}.\n\nNeed a different time? Reply here."
  ],
  [
    "appointment_series_cancelled",
    "Hello {first_name}! Your {scope} for {service_type} is cancelled.\n\nWant to get back on the schedule? Reply here.",
    "Hello {first_name}, your {scope} for {service_type} with Waves is cancelled.\n\nWant to get back on the schedule? Reply here."
  ],
  [
    "appointment_series_rescheduled",
    "Hello {first_name}! Your recurring appointments now start {start_date}{window_text}.\n\nWe'll remind you before each visit.",
    "Hello {first_name}! Your recurring Waves visits now start {start_date}{window_text}.\n\nWe'll text a reminder before each one."
  ],
  [
    "reminder_24h",
    "Hello {first_name}! Your {service_type} is tomorrow, {window}. We'll text you a tracking link when your tech is on the way.{card_hold_policy_line}",
    "Hello {first_name}! Your {service_type} with Waves is tomorrow, {window}. We'll text a tracking link when your tech is on the way.{card_hold_policy_line}"
  ],
  [
    "reminder_72h",
    "Hello {first_name}! {service_type}: {day}, {window}.\n\n{reschedule_line}{card_hold_policy_line}",
    "Hello {first_name}! Waves {service_type}: {day}, {window}.\n\n{reschedule_line}{card_hold_policy_line}"
  ],
  [
    "reminder_24h_v2",
    "Hello {first_name}! {service_type}: tomorrow, {window}.\n\n{appointment_line}{card_hold_policy_line}",
    "Hello {first_name}! Waves {service_type}: tomorrow, {window}.\n\n{appointment_line}{card_hold_policy_line}"
  ],
  [
    "appointment_confirmation_v2",
    "Hello {first_name}! Your {service_type} is booked for {date}, {window}.\n\n{appointment_line}",
    "Hello {first_name}! Your {service_type} with Waves is booked for {date}, {window}.\n\n{appointment_line}"
  ],
  [
    "tech_arrived",
    "Hello {first_name}! {tech_name} has arrived for your {service_type}.",
    "Hello {first_name}! {tech_name} from Waves has arrived for your {service_type}."
  ],
  [
    "tech_en_route",
    "Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}",
    "Hello {first_name}! {tech_name} from Waves is on the way.\n\n{eta_line}{track_clause}"
  ],
  [
    "plan_hold_resume_reminder",
    "Hello {first_name}! Your {service} hold ends {resume_date} and visits restart then. Want a different date, or to cancel instead? Reply here.",
    "Hello {first_name}! Your Waves {service} hold ends {resume_date}, and your visits start again then. Want a different date, or to cancel instead? Reply here."
  ],
  [
    "service_cancellation_received",
    "Hello {first_name}! We got your cancellation request and are closing out your plan by hand. You will hear from us within 1 business day to confirm exactly what has stopped.",
    "Hello {first_name}, Waves here. We got your cancellation request. A team member is handling it and will confirm within 1 business day exactly what has stopped."
  ],
  [
    "service_cancellation_confirmation",
    "Hello {first_name}! Your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off. Completed visits stay payable. Changed your mind or have a question? Reply here.",
    "Hello {first_name}, your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off. Completed visits stay payable. Changed your mind or have a question? Reply here."
  ],
  [
    "service_cancellation_end_of_term_confirmation",
    "Hello {first_name}! Your Waves plan is cancelled and will not renew. Paid-for visits stay on the calendar through {effective_date}; after that nothing new is scheduled or charged. Charges for completed visits remain payable. Changed your mind or have a question? Reply here.",
    "Hello {first_name}, your Waves plan is cancelled and will not renew. Paid-for visits stay on the calendar through {effective_date}; after that nothing new is scheduled or charged. Charges for completed visits remain payable. Changed your mind or have a question? Reply here."
  ],
  [
    "service_cancellation_scoped_confirmation",
    "Hello {first_name}! {service} is cancelled as of {effective_date}. {remaining} continue as before, and completed visits stay payable. Changed your mind or have a question? Reply here.",
    "Hello {first_name}, your Waves {service} is cancelled as of {effective_date}. {remaining} continue as before, and completed visits stay payable. Changed your mind or have a question? Reply here."
  ],
  [
    "service_resolution_confirmation",
    "Hello {first_name}! Done: {summary} Reference {reference}. Nothing else about your plan changes. Questions? Reply here.",
    "Hello {first_name}! Waves here. Done: {summary} Reference: {reference}. Nothing else on your plan changes. Questions? Reply here."
  ],
  [
    "previsit_balance_reminder",
    "Hello {first_name}! Ahead of your {service_type} visit on {visit_date}: your account has a past-due balance of ${amount}. If you already paid it, nothing more is needed.\n\nPay here: {billing_url}",
    "Hello {first_name}, a note from Waves before your {service_type} visit on {visit_date}: your account shows a past-due balance of ${amount}. Already paid? Then you're all set.\n\nPay here: {billing_url}"
  ],
  [
    "price_change_notice",
    "Hello {first_name}! Your recurring service price changes on {effective_date}. Nothing you need to do.\n\nDetails: {price_change_url}",
    "Hello {first_name}, Waves here. Your recurring service price changes on {effective_date}. New price and details: {price_change_url}"
  ],
  [
    "service_complete_paid_receipt",
    "Hello {first_name}! Payment received, ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\n\nReceipt: {receipt_url}",
    "Hello {first_name}! Waves received your payment of ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\n\nReceipt: {receipt_url}"
  ],
  [
    "estimate_accepted_onetime",
    "Hello {first_name}! Thanks for booking your {service_label}. Choose a time here: {booking_url}",
    "Hello {first_name}! Thanks for booking your {service_label} with Waves. Choose a time here: {booking_url}"
  ],
  [
    "estimate_extended",
    "Hello {first_name}! We extended your estimate through {new_expiry} so you have more time with it: {estimate_url}\n\nReply STOP to opt out.",
    "Hello {first_name}! We extended your Waves estimate through {new_expiry}: {estimate_url}\n\nReply STOP to opt out."
  ],
  [
    "estimate_followup_deposit",
    "Hello {first_name}! Your estimate is saved and needs the ${deposit_amount} deposit to lock in your spot: {estimate_url}\n\nReply STOP to opt out.",
    "Hello {first_name}! Your Waves estimate is saved. The ${deposit_amount} deposit locks in your spot: {estimate_url}\n\nReply STOP to opt out."
  ],
  [
    "estimate_sent",
    "Hello {first_name}! Your estimate is ready: {estimate_url}\n\nReply STOP to opt out.",
    "Hello {first_name}! Your Waves estimate is ready: {estimate_url}\n\nReply STOP to opt out."
  ],
  [
    "quote_wizard_booking_invite",
    "Hello {first_name}! Your {service_label} quote is ready. Pick a time that works for you: {booking_url}\n\nReply STOP to opt out.",
    "Hello {first_name}! Your Waves {service_label} quote is ready. Pick a time that works: {booking_url}\n\nReply STOP to opt out."
  ],
  [
    "ach_payment_processing",
    "Hello {first_name}! We got your bank payment for invoice {invoice_number}. ACH transfers take 3-5 business days to clear, and we'll send a receipt as soon as it does.",
    "Hello {first_name}! Waves got your bank payment for invoice {invoice_number}. It usually clears within 5 business days, and we'll send a receipt then."
  ],
  [
    "annual_prepay_payment_reminder",
    "Hello {first_name}! Your annual prepay invoice{amount_text} is still open ahead of your first visit on {first_visit_date}. If it isn't paid by then, we'll bill that visit individually instead.\n\nPay here: {pay_link}",
    "Hello {first_name}, your Waves annual prepay invoice{amount_text} is still open, and your first visit is {first_visit_date}. If it isn't paid by then, we'll bill that visit on its own instead.\n\nPay here: {pay_link}"
  ],
  [
    "deposit_receipt",
    "Hello {first_name}! We received your ${amount} deposit{charge_note}. It goes toward your first visit. Thank you.",
    "Hello {first_name}! Waves received your ${amount} deposit{charge_note}. It goes toward your first visit. Thank you."
  ],
  [
    "invoice_followup_3day",
    "Hello {first_name}! Your invoice for {invoice_title} has an open balance of ${amount}: {pay_url}\n\nIf something looks off, reply and we'll sort it.",
    "Hello {first_name}, your Waves invoice for {invoice_title} has an open balance of ${amount}: {pay_url}\n\nIf something looks off, reply and we'll sort it out."
  ],
  [
    "invoice_followup_7day",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is still open. Pay here: {pay_url}",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still open. Pay here: {pay_url}"
  ],
  [
    "invoice_followup_14day",
    "Hello {first_name}! Checking in on your invoice for {invoice_title}{service_date_clause}. You can pay here: {pay_url}\n\nIf something is holding it up, reply and we'll help.",
    "Hello {first_name}, checking in on your Waves invoice for {invoice_title}{service_date_clause}. You can pay here: {pay_url}\n\nIf something is holding it up, reply and we'll help."
  ],
  [
    "invoice_followup_30day",
    "Hello {first_name}! Final notice on your invoice for {invoice_title}{service_date_clause}. Please pay to keep the account in good standing: {pay_url}\n\nNeed a payment plan? Reply here.",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still unpaid. Please pay here to keep your account in good standing: {pay_url}\n\nNeed a payment plan? Reply here."
  ],
  [
    "invoice_receipt",
    "Hello {first_name}! Payment received, thank you. Invoice {invoice_number}: ${amount}{card_line}.\n\nReceipt: {receipt_url}",
    "Hello {first_name}! Waves received your payment. Thank you. Invoice {invoice_number}: ${amount}{card_line}.\n\nReceipt: {receipt_url}"
  ],
  [
    "invoice_sent",
    "Hello {first_name}! Your invoice for {service_type} on {service_date} is ready: {pay_url}",
    "Hello {first_name}! Your Waves invoice for {service_type} on {service_date} is ready: {pay_url}"
  ],
  [
    "invoice_sent_annual_prepay",
    "Hello {first_name}! Your annual prepay plan invoice is ready. It prepays {coverage_summary}.{first_visit_clause}\n\nPay here: {pay_url}",
    "Hello {first_name}! Your Waves annual prepay invoice is ready. It prepays {coverage_summary}.{first_visit_clause}\n\nPay here: {pay_url}"
  ],
  [
    "invoice_sent_upfront",
    "Hello {first_name}! Your invoice to get started with {service_type} is ready.\n\nPay here: {pay_url}",
    "Hello {first_name}! Your Waves invoice to start {service_type} is ready.\n\nPay here: {pay_url}"
  ],
  [
    "manual_payment_receipt",
    "Hello {first_name}! Your payment went through. Thank you.{receipt_line}",
    "Hello {first_name}! Waves received your payment. Thank you.{receipt_line}"
  ],
  [
    "payment_failed",
    "Hello {first_name}! Your payment{card_line} for {service_type} on {service_date} did not go through. You can update your card or pay here: {pay_url}",
    "Hello {first_name}, your Waves payment{card_line} for {service_type} on {service_date} didn't go through. Update your card or pay here: {pay_url}"
  ],
  [
    "balance_payment_received",
    "Hello {first_name}! Thank you for the payment. Your account is caught up and we'll see you at your next service.",
    "Hello {first_name}! Waves received your payment, and your account is all caught up. See you at your next service."
  ],
  [
    "balance_reminder_gentle",
    "Hello {first_name}! We're scheduled to see you on {service_date}, and your account has an outstanding balance.\n\nYou can take care of it before the visit here: {pay_url}",
    "Hello {first_name}, Waves is scheduled to see you on {service_date}, and your account has an open balance.\n\nYou can take care of it before the visit here: {pay_url}"
  ],
  [
    "balance_reminder_firm",
    "Hello {first_name}! Your {service_type} is {service_timing} and your account has an outstanding balance.\n\nYou can take care of it here: {pay_url}",
    "Hello {first_name}, your {service_type} with Waves is {service_timing}, and your account has an open balance.\n\nYou can take care of it here: {pay_url}"
  ],
  [
    "balance_reminder_urgent",
    "Hello {first_name}! Your service is {service_timing} and your account has an outstanding balance.\n\nPay here: {pay_url}\n\nAlready paid? Reply and we'll check.",
    "Hello {first_name}, your Waves service is {service_timing}, and your account has an open balance.\n\nPay here: {pay_url}\n\nAlready paid? Reply and we'll check."
  ],
  [
    "late_payment_7d",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 7 days overdue. Please pay here: {pay_url}",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 7 days past due. Pay here: {pay_url}"
  ],
  [
    "late_payment_14d",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 14 days overdue. Please pay as soon as you can: {pay_url}",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 14 days past due. Please pay as soon as you can: {pay_url}\n\nIf something is holding it up, reply and we'll help."
  ],
  [
    "late_payment_30d",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 30 days overdue. Please pay here: {pay_url}\n\nNeed a payment plan? Reply here.",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 30 days past due. Please pay here: {pay_url}\n\nNeed a payment plan? Reply here."
  ],
  [
    "late_payment_60d",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 60 days overdue. Please pay or contact us today to avoid further action: {pay_url}",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 60 days past due. Please pay today, or reply so we can work out a plan: {pay_url}"
  ],
  [
    "late_payment_90d",
    "Hello {first_name}! Final notice: your invoice for {invoice_title}{service_date_clause} is 90 days overdue and may be sent to collections. Please pay today: {pay_url}",
    "Hello {first_name}, final notice from Waves: your invoice for {invoice_title}{service_date_clause} is 90 days past due and may be sent to collections. Please pay today, or reply to work out a plan: {pay_url}"
  ],
  [
    "auto_bed_bug_no_email",
    "Hello {first_name}! Before your bed bug visit:\n\n- Launder bedding and affected clothing in hot water, dry on high 30+ min, then bag it.\n- Vacuum mattresses, frames, and baseboards, emptying outside.\n- Pull beds and furniture 12-18 in. from walls.\n\nRepeat all three before your 14-day follow-up.",
    "Hello {first_name}! Before your Waves bed bug visit:\n\n- Wash bedding and affected clothing hot, dry on high 30+ min, then bag it.\n- Vacuum mattresses, frames, and baseboards, emptying outside.\n- Pull beds and furniture 18 in. from walls.\n\nRepeat all three before each follow-up visit."
  ],
  [
    "auto_cockroach_no_email",
    "Hello {first_name}! Before your cockroach visit:\n\n- Clear access under sinks, around appliances, and along pantry edges.\n- Store food, dishes, and pet bowls away from treatment areas.\n- Skip store-bought sprays, which scatter the activity.",
    "Hello {first_name}! Before your Waves cockroach visit:\n\n- Empty the cabinets under your sinks and clear around appliances.\n- Store food, dishes, and pet bowls away from treatment areas.\n- Don't spray store-bought products. They drive roaches away from the bait."
  ],
  [
    "auto_flea_no_email",
    "Hello {first_name}! Before your flea visit:\n\n- Vacuum carpets, rugs, and pet resting areas, emptying outside.\n- Wash pet bedding on a hot cycle.\n- Coordinate pet flea control with your vet, and keep people and pets off treated areas until dry.",
    "Hello {first_name}! Before your Waves flea visit:\n\n- Vacuum carpets, rugs, and pet resting areas, emptying outside.\n- Wash pet bedding on a hot cycle.\n- Treat every pet the same day with a vet-recommended flea product. Keep people and pets off treated areas until dry."
  ],
  [
    "auto_new_appointment",
    "Hello {first_name}! We just emailed what to expect for your first service.",
    "Hello {first_name}! We just emailed what to expect at your first Waves service."
  ],
  [
    "project_report_ready",
    "Hello {first_name}! Your {project_type} report is ready: {report_url}",
    "Hello {first_name}! Your Waves {project_type} report is ready: {report_url}"
  ],
  [
    "service_complete",
    "Hello {first_name}! Your service report is ready: {portal_url}",
    "Hello {first_name}! Your Waves service report is ready: {portal_url}"
  ],
  [
    "service_complete_annual_prepay",
    "Hello {first_name}! Your {service_type} is done and covered by your annual prepaid plan, so nothing is due today.\n\nYour report: {portal_url}",
    "Hello {first_name}! Your {service_type} is done, and it's covered by your Waves annual prepaid plan, so nothing is due today.\n\nYour report: {portal_url}"
  ],
  [
    "service_complete_prepaid",
    "Hello {first_name}! Thanks for your payment today. Your {service_type} report is ready: {portal_url}",
    "Hello {first_name}! Thanks for your payment. Your Waves {service_type} report is ready: {portal_url}"
  ],
  [
    "service_report_v1",
    "Hello {first_name}! Your {service_type} report is ready: {report_url}",
    "Hello {first_name}! Your Waves {service_type} report is ready: {report_url}"
  ],
  [
    "service_request_confirmation",
    "Hello {first_name}! We got your {category} request and will review it within {response_time}. We'll follow up as soon as we've reviewed it.",
    "Hello {first_name}! Waves got your {category} request. We'll review it and get back to you within {response_time}."
  ],
  [
    "appointment_recurring_placement_confirmed",
    "Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. Later visits will be arranged within 3 days of each new due date. Existing commitments stay unchanged until we review them with you.",
    "Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. We'll book each later visit within 3 days of its due date. Visits already on your calendar stay as they are until we go over them with you."
  ],
  [
    "renewal_reminder",
    "Hello {first_name}! Your {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active.",
    "Hello {first_name}! Your Waves {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active."
  ]
];

const MIGRATION = '20260926120000_customer_copy_audit_sms';

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
      if (row.body !== before) continue;
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
  // Intentionally no-op: reverting seeded copy would erase later admin edits.
};
exports._SWAPS = SWAPS;
