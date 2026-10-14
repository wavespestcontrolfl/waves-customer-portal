/**
 * Shorter, evenly spaced customer texts (owner 2026-10-06).
 *
 * The owner flagged the recurring placement text ("We'll book each later
 * visit within 3 days of its due date. Visits already on your calendar
 * won't change unless we talk with you first.") as wordy and the texts as
 * badly spaced, and asked for an audit of every SMS template. Owner approved
 * the rewrite of 97 active templates on 2026-10-06 (review page
 * https://claude.ai/artifact/KbwnGmrfze6tCCqwNQHRD3). One house layout:
 *
 *   - Open with "Hi {first_name}," (95 bodies opened "Hello {first_name}!",
 *     including bad news such as a failed payment).
 *   - The fact first, then a blank line, then the action. A link starts its
 *     own line behind a short label ("Pay here:", "Report:", "Receipt:").
 *   - Internal policy and repeated "Thank you." are cut.
 *
 * Unchanged on purpose: every placeholder (each swap keeps the exact same
 * set), every "Reply STOP to opt out." line (docs/sms-stop-line-policy.md),
 * "Waves" once and no sign-off (owner 09-26 / 09-28), the owner-approved
 * line "Someone from the Waves team will follow up as soon as possible.",
 * the words of the termite auto-renewal notice (spacing only), and the
 * carrier opt-in, recruiting and review-ask texts (not in this list).
 * Every body is GSM-7 (straight apostrophes only).
 *
 * "before" bodies are the live production bodies read on 2026-10-06.
 * Exact-body CAS on sms_templates and sms_template_variants, same contract
 * as 20260928210000: a row an administrator has edited is left alone.
 */
const SWAPS = [
  [
    "tech_en_route",
    "Hello {first_name}! {tech_name} from Waves is on the way.\n\n{eta_line}{track_clause}",
    "Hi {first_name}, {tech_name} from Waves is on the way.\n\n{eta_line}{track_clause}"
  ],
  [
    "reminder_24h_v2",
    "Hello {first_name}! Waves {service_type}: tomorrow, {window}.\n\n{appointment_line}{card_hold_policy_line}",
    "Hi {first_name}, your Waves {service_type} is tomorrow, {window}.\n\n{appointment_line}{card_hold_policy_line}"
  ],
  [
    "tech_arrived",
    "Hello {first_name}! {tech_name} from Waves has arrived for your {service_type}.",
    "Hi {first_name}, {tech_name} from Waves is here for your {service_type}."
  ],
  [
    "reminder_72h",
    "Hello {first_name}! Waves {service_type}: {day}, {date}, {window}.\n\n{reschedule_line}{card_hold_policy_line}",
    "Hi {first_name}, your Waves {service_type} is {day}, {date}, {window}.\n\n{reschedule_line}{card_hold_policy_line}"
  ],
  [
    "appointment_confirmation_v2",
    "Hello {first_name}! Your {service_type} with Waves is booked for {date}, {window}.\n\n{appointment_line}",
    "Hi {first_name}, your {service_type} with Waves is booked for {date}, {window}.\n\n{appointment_line}"
  ],
  [
    "appointment_recurring_placement_confirmed",
    "Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. We'll book each later visit within 3 days of its due date. Visits already on your calendar won't change unless we talk with you first.",
    "Hi {first_name}, your next Waves visit is {start_date}{window_text}.\n\nYou'll get a reminder before each visit."
  ],
  [
    "appointment_series_rescheduled",
    "Hello {first_name}! Your recurring Waves visits now start {start_date}{window_text}.\n\nWe'll send you a reminder before each visit.",
    "Hi {first_name}, your recurring Waves visits now start {start_date}{window_text}.\n\nYou'll get a reminder before each visit."
  ],
  [
    "appointment_confirmation",
    "Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\n{reschedule_line}",
    "Hi {first_name}, your {service_type} with Waves is confirmed for {date} at {time}.\n\n{reschedule_line}"
  ],
  [
    "appointment_cancelled",
    "Hello {first_name}, your {service_type} with Waves on {day}, {date} is cancelled.\n\nWant a new time? Reply here and we'll set it up.",
    "Hi {first_name}, your {service_type} with Waves on {day}, {date} is cancelled.\n\nWant a new time? Reply here."
  ],
  [
    "appointment_rescheduled",
    "Hello {first_name}! Your {service_type} with Waves is now {day}, {date}, {window}.\n\nNeed a different time? Reply here.",
    "Hi {first_name}, your {service_type} with Waves is now {day}, {date}, {window}.\n\nNeed a different time? Reply here."
  ],
  [
    "appointment_series_cancelled",
    "Hello {first_name}, your {scope} for {service_type} with Waves is cancelled.\n\nWant to get back on the schedule? Reply here.",
    "Hi {first_name}, your {scope} for {service_type} with Waves is cancelled.\n\nWant to get back on the schedule? Reply here."
  ],
  [
    "appointment_no_show",
    "Hello {first_name}, it's {tech_name} from Waves. We came by {when} at {time} but couldn't complete your visit. Reply or call and we'll find a new time.",
    "Hi {first_name}, it's {tech_name} from Waves. We came by {when} at {time} but couldn't complete your visit.\n\nReply or call and we'll find a new time."
  ],
  [
    "reminder_24h",
    "Hello {first_name}! Your {service_type} with Waves is tomorrow, {window}. We'll text a tracking link when your tech is on the way.{card_hold_policy_line}",
    "Hi {first_name}, your {service_type} with Waves is tomorrow, {window}. We'll text you when your tech is on the way.{card_hold_policy_line}"
  ],
  [
    "booking_abandonment_recovery",
    "Hello {first_name}! Your Waves {service_type} spot isn't reserved yet. Pick a time and you're set: {booking_url}\n\nReply STOP to opt out.",
    "Hi {first_name}, your Waves {service_type} isn't booked yet.\n\nPick a time: {booking_url}\n\nReply STOP to opt out."
  ],
  [
    "rain_out_moved",
    "Hello {first_name}, {weather_phrase} rolled through your area, so Waves moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}",
    "Hi {first_name}, {weather_phrase} rolled through your area, so Waves moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}"
  ],
  [
    "rain_out_moved_v2",
    "Hello {first_name}, {weather_lead}, so Waves moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}",
    "Hi {first_name}, {weather_lead}, so Waves moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}"
  ],
  [
    "plan_hold_restart_first_visit",
    "Hello {first_name}! Your Waves {service} visits start again on {visit_date}. Want a different date, or to cancel instead? Reply here.",
    "Hi {first_name}, your Waves {service} visits start again on {visit_date}.\n\nWant a different date, or to cancel instead? Reply here."
  ],
  [
    "invoice_receipt",
    "Hello {first_name}! Waves received your payment. Thank you. Invoice {invoice_number}: ${amount}{card_line}.\n\nReceipt: {receipt_url}",
    "Hi {first_name}, Waves received your payment of ${amount}{card_line} for invoice {invoice_number}. Thank you!\n\nReceipt: {receipt_url}"
  ],
  [
    "service_complete_paid_receipt",
    "Hello {first_name}! Waves received your payment of ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\n\nReceipt: {receipt_url}",
    "Hi {first_name}, your {service_type} is done and paid: ${amount}{card_line}. Thank you!\n\nReport: {portal_url}\nReceipt: {receipt_url}"
  ],
  [
    "service_report_v1_with_invoice",
    "Hello {first_name}! Waves {service_type} report: {report_url}\n\nInvoice: {pay_url}\n\n{past_due_line}",
    "Hi {first_name}, your Waves {service_type} is done.\n\nReport: {report_url}\nInvoice: {pay_url}\n\n{past_due_line}"
  ],
  [
    "service_complete_with_invoice",
    "Hello {first_name}! Waves {service_type} report: {portal_url}\n\nInvoice: {pay_url}\n\n{past_due_line}",
    "Hi {first_name}, your Waves {service_type} is done.\n\nReport: {portal_url}\nInvoice: {pay_url}\n\n{past_due_line}"
  ],
  [
    "service_complete_annual_prepay",
    "Hello {first_name}! Your {service_type} is done, and it's covered by your Waves annual prepaid plan, so nothing is due today.\n\nYour report: {portal_url}",
    "Hi {first_name}, your {service_type} is done. Your Waves annual plan covers it, so nothing is due.\n\nReport: {portal_url}"
  ],
  [
    "service_complete_annual_prepay_after_first_visit",
    "Hello {first_name}! Your {service_type} is done and covered by your Waves annual plan. Your plan payment is processed after this first visit - you'll get a receipt.\n\nYour report: {portal_url}",
    "Hi {first_name}, your {service_type} is done and covered by your Waves annual plan. Your plan payment is processed after this first visit - you'll get a receipt.\n\nReport: {portal_url}"
  ],
  [
    "service_complete_annual_prepay_first_charge",
    "Hello {first_name}! Your {service_type} is done. Your Waves annual plan payment of {amount} is being charged to your {method_line} now - receipt to follow.\n\nYour report: {portal_url}",
    "Hi {first_name}, your {service_type} is done. Your Waves annual plan payment of {amount} is being charged to your {method_line} now - receipt to follow.\n\nReport: {portal_url}"
  ],
  [
    "service_complete",
    "Hello {first_name}! Your Waves service report is ready: {portal_url}",
    "Hi {first_name}, your Waves service report is ready: {portal_url}"
  ],
  [
    "service_complete_prepaid",
    "Hello {first_name}! Thanks for your payment. Your Waves {service_type} report is ready: {portal_url}",
    "Hi {first_name}, thanks for your payment. Your Waves {service_type} report is ready: {portal_url}"
  ],
  [
    "service_report_v1",
    "Hello {first_name}! Your Waves {service_type} report is ready: {report_url}",
    "Hi {first_name}, your Waves {service_type} report is ready: {report_url}"
  ],
  [
    "project_report_ready",
    "Hello {first_name}! Your Waves {project_type} report is ready: {report_url}",
    "Hi {first_name}, your Waves {project_type} report is ready: {report_url}"
  ],
  [
    "contact_report_ready",
    "Hello {first_name}! The Waves service report for {street_address} is ready: {report_url}\n\nQuestions or requests? Reply here.",
    "Hi {first_name}, the Waves service report for {street_address} is ready: {report_url}\n\nQuestions? Reply here."
  ],
  [
    "lawn_health_report_ready",
    "Hello {first_name}! Your Waves lawn health report is ready. You scored {overall_score}/100{delta_line}.{tip_line}\n\nFull report: {portal_url}",
    "Hi {first_name}, your Waves lawn health score is {overall_score}/100{delta_line}.{tip_line}\n\nFull report: {portal_url}"
  ],
  [
    "manual_payment_receipt",
    "Hello {first_name}! Waves received your payment. Thank you.{receipt_line}",
    "Hi {first_name}, Waves received your payment. Thank you!{receipt_line}"
  ],
  [
    "balance_payment_received",
    "Hello {first_name}! Waves received your payment, and your account is all caught up. See you at your next service.",
    "Hi {first_name}, Waves received your payment. Your account is all caught up."
  ],
  [
    "deposit_receipt",
    "Hello {first_name}! Waves received your ${amount} deposit{charge_note}. It goes toward your first visit. Thank you.",
    "Hi {first_name}, Waves received your ${amount} deposit{charge_note}. It goes toward your first visit. Thank you!"
  ],
  [
    "ach_payment_processing",
    "Hello {first_name}! Waves got your bank payment for invoice {invoice_number}. It usually clears within 5 business days, and we'll send a receipt then.",
    "Hi {first_name}, Waves got your bank payment for invoice {invoice_number}. It usually clears in 5 business days, and we'll text a receipt then."
  ],
  [
    "payment_failed",
    "Hello {first_name}, your Waves payment{card_line} for {service_type} on {service_date} didn't go through. Update your card or pay here: {pay_url}",
    "Hi {first_name}, your Waves payment{card_line} for {service_type} on {service_date} didn't go through.\n\nUpdate your card or pay here: {pay_url}"
  ],
  [
    "invoice_sent",
    "Hello {first_name}! Your Waves invoice for {service_type} on {service_date} is ready: {pay_url}",
    "Hi {first_name}, your Waves invoice for {service_type} on {service_date} is ready: {pay_url}"
  ],
  [
    "invoice_sent_upfront",
    "Hello {first_name}! Your Waves invoice to start {service_type} is ready.\n\nPay here: {pay_url}",
    "Hi {first_name}, your Waves invoice to start {service_type} is ready.\n\nPay here: {pay_url}"
  ],
  [
    "invoice_sent_annual_prepay",
    "Hello {first_name}! Your Waves annual prepay invoice is ready. It prepays {coverage_summary}.{first_visit_clause}\n\nPay here: {pay_url}",
    "Hi {first_name}, your Waves annual prepay invoice is ready. It covers {coverage_summary}.{first_visit_clause}\n\nPay here: {pay_url}"
  ],
  [
    "invoice_followup_3day",
    "Hello {first_name}, your Waves invoice for {invoice_title} has an open balance of ${amount}: {pay_url}\n\nIf something looks off, reply and we'll sort it out.",
    "Hi {first_name}, your Waves invoice for {invoice_title} has an open balance of ${amount}.\n\nPay here: {pay_url}\n\nSomething look off? Reply here."
  ],
  [
    "invoice_followup_7day",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still open. Pay here: {pay_url}",
    "Hi {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still open.\n\nPay here: {pay_url}"
  ],
  [
    "invoice_followup_14day",
    "Hello {first_name}, checking in on your Waves invoice for {invoice_title}{service_date_clause}. You can pay here: {pay_url}\n\nIf something is holding it up, reply and we'll help.",
    "Hi {first_name}, checking in on your Waves invoice for {invoice_title}{service_date_clause}.\n\nPay here: {pay_url}\n\nSomething holding it up? Reply here."
  ],
  [
    "invoice_followup_30day",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still unpaid. Please pay here to keep your account in good standing: {pay_url}\n\nNeed a payment plan? Reply here.",
    "Hi {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still unpaid.\n\nPay here: {pay_url}\n\nNeed a payment plan? Reply here."
  ],
  [
    "invoice_followup_60day",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still unpaid. Please pay today, or reply and we'll work out a payment plan: {pay_url}",
    "Hi {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still unpaid. Please pay today, or reply to set up a payment plan.\n\nPay here: {pay_url}"
  ],
  [
    "invoice_followup_90day",
    "Hello {first_name}, final notice from Waves: your invoice for {invoice_title}{service_date_clause} is past due and may be sent to collections. Please pay today, or reply to work out a plan: {pay_url}",
    "Hi {first_name}, final notice from Waves: your invoice for {invoice_title}{service_date_clause} is past due and may be sent to collections. Please pay today, or reply to set up a plan.\n\nPay here: {pay_url}"
  ],
  [
    "invoice_followup_combined_3day",
    "Hello {first_name}, you have {invoice_count} open Waves invoices totaling ${total_due}. You can pay them all here: {pay_url}\n\nIf something looks off, reply and we'll sort it out.",
    "Hi {first_name}, you have {invoice_count} open Waves invoices totaling ${total_due}.\n\nPay them all here: {pay_url}\n\nSomething look off? Reply here."
  ],
  [
    "invoice_followup_combined_10day",
    "Hello {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still open. Pay here: {pay_url}",
    "Hi {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still open.\n\nPay here: {pay_url}"
  ],
  [
    "invoice_followup_combined_17day",
    "Hello {first_name}, checking in on your {invoice_count} open Waves invoices (${total_due} total). You can pay here: {pay_url}\n\nIf something is holding it up, reply and we'll help.",
    "Hi {first_name}, checking in on your {invoice_count} open Waves invoices (${total_due} total).\n\nPay here: {pay_url}\n\nSomething holding it up? Reply here."
  ],
  [
    "invoice_followup_combined_30day",
    "Hello {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still unpaid. Please pay here to keep your account in good standing: {pay_url}\n\nNeed a payment plan? Reply here.",
    "Hi {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still unpaid.\n\nPay here: {pay_url}\n\nNeed a payment plan? Reply here."
  ],
  [
    "invoice_followup_combined_60day",
    "Hello {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still unpaid. Please pay today, or reply and we'll work out a payment plan: {pay_url}",
    "Hi {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still unpaid. Please pay today, or reply to set up a payment plan.\n\nPay here: {pay_url}"
  ],
  [
    "invoice_followup_combined_90day",
    "Hello {first_name}, final notice from Waves: your {invoice_count} unpaid invoices (${total_due} total) are past due and may be sent to collections. Please pay today, or reply to work out a plan: {pay_url}",
    "Hi {first_name}, final notice from Waves: your {invoice_count} unpaid invoices (${total_due} total) are past due and may be sent to collections. Please pay today, or reply to set up a plan.\n\nPay here: {pay_url}"
  ],
  [
    "late_payment_7d",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 7 days past due. Pay here: {pay_url}",
    "Hi {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 7 days past due.\n\nPay here: {pay_url}"
  ],
  [
    "late_payment_14d",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 14 days past due. Please pay as soon as you can: {pay_url}\n\nIf something is holding it up, reply and we'll help.",
    "Hi {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 14 days past due.\n\nPay here: {pay_url}\n\nSomething holding it up? Reply here."
  ],
  [
    "late_payment_30d",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 30 days past due. Please pay here: {pay_url}\n\nNeed a payment plan? Reply here.",
    "Hi {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 30 days past due.\n\nPay here: {pay_url}\n\nNeed a payment plan? Reply here."
  ],
  [
    "late_payment_60d",
    "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 60 days past due. Please pay today, or reply so we can work out a plan: {pay_url}",
    "Hi {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is 60 days past due. Please pay today, or reply to set up a plan.\n\nPay here: {pay_url}"
  ],
  [
    "late_payment_90d",
    "Hello {first_name}, final notice from Waves: your invoice for {invoice_title}{service_date_clause} is 90 days past due and may be sent to collections. Please pay today, or reply to work out a plan: {pay_url}",
    "Hi {first_name}, final notice from Waves: your invoice for {invoice_title}{service_date_clause} is 90 days past due and may be sent to collections. Please pay today, or reply to set up a plan.\n\nPay here: {pay_url}"
  ],
  [
    "balance_reminder_gentle",
    "Hello {first_name}, Waves is scheduled to see you on {service_date}, and your account has an open balance.\n\nYou can take care of it before the visit here: {pay_url}",
    "Hi {first_name}, Waves will see you on {service_date}, and your account has an open balance.\n\nPay before the visit here: {pay_url}"
  ],
  [
    "balance_reminder_firm",
    "Hello {first_name}, your {service_type} with Waves is {service_timing}, and your account has an open balance.\n\nYou can take care of it here: {pay_url}",
    "Hi {first_name}, your {service_type} with Waves is {service_timing}, and your account has an open balance.\n\nPay here: {pay_url}"
  ],
  [
    "balance_reminder_urgent",
    "Hello {first_name}, your Waves service is {service_timing}, and your account has an open balance.\n\nPay here: {pay_url}\n\nAlready paid? Reply and we'll check.",
    "Hi {first_name}, your Waves service is {service_timing}, and your account has an open balance.\n\nPay here: {pay_url}\n\nAlready paid? Reply and we'll check."
  ],
  [
    "previsit_balance_reminder",
    "Hello {first_name}, a note from Waves before your {service_type} visit on {visit_date}: your account shows a past-due balance of ${amount}. Already paid? Then you're all set.\n\nPay here: {billing_url}",
    "Hi {first_name}, before your Waves {service_type} visit on {visit_date}: your account shows a past-due balance of ${amount}.\n\nPay here: {billing_url}\n\nAlready paid? Then you're all set."
  ],
  [
    "price_change_notice",
    "Hello {first_name}, it's Waves. Your recurring service price changes on {effective_date}. New price and details: {price_change_url}",
    "Hi {first_name}, it's Waves. Your recurring service price changes on {effective_date}.\n\nNew price and details: {price_change_url}"
  ],
  [
    "autopay_setup_link",
    "Hi {first_name}! Set up Auto Pay for your Waves service here: {secure_link}\nSave a payment method and each completed service is paid automatically. Nothing is charged today. We never take card numbers by phone.",
    "Hi {first_name}, set up Auto Pay for Waves here: {secure_link}\n\nCompleted services are paid automatically. Nothing is charged today. We never take card numbers by phone."
  ],
  [
    "secure_appointment_card",
    "Hi {first_name}! To finish booking your Waves {service_type}{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after service.\n\n{cancel_fee_line}We never take card numbers by phone.",
    "Hi {first_name}, to finish booking your Waves {service_type}{date_line}, add a card on file: {secure_link}\n\nNothing is charged until after service.\n\n{cancel_fee_line}We never take card numbers by phone."
  ],
  [
    "secure_appointment_card_plans",
    "Hello {first_name}! Waves {service_type}{date_line}: prepay the year and save, or pay per application by card.\n\n{secure_link}\nNothing is charged today unless you prepay.\n\n{cancel_fee_line}We never take card numbers by phone.",
    "Hi {first_name}, Waves {service_type}{date_line}: prepay the year and save, or pay per application by card.\n\n{secure_link}\nNothing is charged today unless you prepay.\n\n{cancel_fee_line}We never take card numbers by phone."
  ],
  [
    "termite_annual_renewal_charge_failed",
    "Hi {first_name}, we tried to charge your payment method on file ${amount} to renew your Waves Subterranean Termite Protection plan, but it didn't go through. Please pay here to keep your coverage active: {pay_url}.\n\nQuestions or need help? Just reply to this message.",
    "Hi {first_name}, the ${amount} renewal charge for your Waves Subterranean Termite Protection didn't go through.\n\nPay here to keep your coverage active: {pay_url}\n\nQuestions? Reply here."
  ],
  [
    "service_cancellation_confirmation",
    "Hello {first_name}, your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off. Completed visits stay payable. Changed your mind or have a question? Reply here.",
    "Hi {first_name}, your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off. Completed visits are still payable.\n\nQuestions or change your mind? Reply here."
  ],
  [
    "service_cancellation_end_of_term_confirmation",
    "Hello {first_name}, your Waves plan is cancelled and will not renew. Paid-for visits stay on the calendar through {effective_date}; after that nothing new is scheduled or charged. Charges for completed visits remain payable. Changed your mind or have a question? Reply here.",
    "Hi {first_name}, your Waves plan is cancelled and won't renew. Paid visits stay on the calendar through {effective_date}, and nothing is charged after that. Completed visits are still payable.\n\nQuestions or change your mind? Reply here."
  ],
  [
    "service_cancellation_scoped_confirmation",
    "Hello {first_name}, your Waves {service} service is cancelled as of {effective_date}. {remaining} continue as before, and completed visits stay payable. Changed your mind or have a question? Reply here.",
    "Hi {first_name}, your Waves {service} service is cancelled as of {effective_date}. {remaining} continue as before. Completed visits are still payable.\n\nQuestions or change your mind? Reply here."
  ],
  [
    "service_cancellation_received",
    "Hello {first_name}, it's Waves. We got your cancellation request. A team member is handling it and will confirm within 1 business day exactly what has stopped.",
    "Hi {first_name}, it's Waves. We got your cancellation request. A team member will confirm what has stopped within 1 business day."
  ],
  [
    "service_resolution_confirmation",
    "Hello {first_name}, it's Waves. Done: {summary} Reference: {reference}. Nothing else on your plan changes. Questions? Reply here.",
    "Hi {first_name}, it's Waves. Done: {summary}\n\nNothing else on your plan changes. Ref: {reference}. Questions? Reply here."
  ],
  [
    "estimate_sent",
    "Hello {first_name}! Your Waves estimate is ready: {estimate_url}\n\nReply STOP to opt out.",
    "Hi {first_name}, your Waves estimate is ready: {estimate_url}\n\nReply STOP to opt out."
  ],
  [
    "estimate_extended",
    "Hello {first_name}! We extended your Waves estimate through {new_expiry}: {estimate_url}\n\nReply STOP to opt out.",
    "Hi {first_name}, we extended your Waves estimate through {new_expiry}: {estimate_url}\n\nReply STOP to opt out."
  ],
  [
    "estimate_accepted_onetime",
    "Hello {first_name}! Thanks for booking your {service_label} with Waves. Choose a time here: {booking_url}",
    "Hi {first_name}, thanks for booking your {service_label} with Waves.\n\nPick a time: {booking_url}"
  ],
  [
    "estimate_accepted_annual_prepay",
    "Hello {first_name}! Your WaveGuard {waveguard_tier} annual plan is approved. Your invoice{amount_text} is on the way.",
    "Hi {first_name}, your WaveGuard {waveguard_tier} annual plan is approved. Your invoice{amount_text} is on the way."
  ],
  [
    "quote_wizard_booking_invite",
    "Hello {first_name}! Your Waves {service_label} quote is ready. Pick a time that works: {booking_url}\n\nReply STOP to opt out.",
    "Hi {first_name}, your Waves {service_label} quote is ready.\n\nPick a time: {booking_url}\n\nReply STOP to opt out."
  ],
  [
    "lead_auto_reply_biz",
    "Hello {first_name}, it's Waves. We got your quote request and someone will call you shortly.\n\nReply STOP to opt out.",
    "Hi {first_name}, it's Waves. We got your quote request and will call you shortly.\n\nReply STOP to opt out."
  ],
  [
    "missed_call",
    "Hello {first_name}, it's Waves. Sorry we missed your call. How can we help?\n\nReply STOP to opt out.",
    "Hi {first_name}, it's Waves. Sorry we missed your call. How can we help?\n\nReply STOP to opt out."
  ],
  [
    "voicemail_quote_link",
    "Hello {first_name}, it's Waves. We got your message about {service_label}, and your quote is here: {quote_url}\n\nSomeone from the Waves team will follow up as soon as possible. Or reply and we'll call you back.\n\nReply STOP to opt out.",
    "Hi {first_name}, it's Waves. We got your message about {service_label}.\n\nYour quote: {quote_url}\n\nSomeone from the Waves team will follow up as soon as possible.\n\nReply STOP to opt out."
  ],
  [
    "dropped_call_address_request",
    "Hello {first_name}, it's Waves. It looks like our call dropped. Reply with your service address and we'll get your quote moving, or call us back{callback_clause}.\n\nReply STOP to opt out.",
    "Hi {first_name}, it's Waves. Looks like our call dropped. Reply with your service address and we'll get your quote moving, or call us back{callback_clause}.\n\nReply STOP to opt out."
  ],
  [
    "auto_new_recurring",
    "Hello {first_name}, welcome to Waves!\n\nYou can manage everything in the free Waves app: upcoming visits, live tech tracking, rescheduling, and invoices. Get it at wavespestcontrol.com/app",
    "Hi {first_name}, welcome to Waves!\n\nGet the free app for upcoming visits, live tech tracking, rescheduling and invoices: wavespestcontrol.com/app"
  ],
  [
    "auto_new_appointment",
    "Hello {first_name}! We just emailed what to expect at your first Waves service.",
    "Hi {first_name}, we just emailed what to expect at your first Waves service."
  ],
  [
    "auto_prep_guide_link",
    "Hello {first_name}! Your Waves {prep_label} prep guide is here: {prep_url}\n\nPlease read it before your visit so everything goes as smoothly as possible.\n\nQuestions or requests? Reply here.",
    "Hi {first_name}, your Waves {prep_label} prep guide: {prep_url}\n\nPlease read it before your visit. Questions? Reply here."
  ],
  [
    "auto_bed_bug",
    "Hello {first_name}! Waves emailed your bed bug treatment guide. Please read it before your visit so the treatment works as well as it can.",
    "Hi {first_name}, Waves emailed your bed bug treatment guide. Please read it before your visit so the treatment works its best."
  ],
  [
    "auto_cockroach",
    "Hello {first_name}! Waves emailed your cockroach treatment guide. Please read it before your visit so the treatment works as well as it can.",
    "Hi {first_name}, Waves emailed your cockroach treatment guide. Please read it before your visit so the treatment works its best."
  ],
  [
    "auto_flea",
    "Hello {first_name}! Waves emailed your flea treatment guide. Please read it before your visit so the treatment works as well as it can.",
    "Hi {first_name}, Waves emailed your flea treatment guide. Please read it before your visit so the treatment works its best."
  ],
  [
    "auto_bed_bug_no_email",
    "Hello {first_name}! Before your Waves bed bug visit:\n\n- Wash bedding and affected clothing hot, dry on high 30+ min, then bag it.\n- Vacuum mattresses, frames, and baseboards, emptying outside.\n- Pull beds and furniture 18 in. from walls.\n\nRepeat all three before each follow-up visit.",
    "Hi {first_name}, before your Waves bed bug visit:\n\n- Wash bedding and affected clothing hot, dry on high 30+ min, then bag it.\n- Vacuum mattresses, frames, and baseboards, emptying outside.\n- Pull beds and furniture 18 in. from walls.\n\nRepeat all three before each follow-up visit."
  ],
  [
    "auto_cockroach_no_email",
    "Hello {first_name}! Before your Waves cockroach visit:\n\n- Empty the cabinets under your sinks and clear around appliances.\n- Store food, dishes, and pet bowls away from treatment areas.\n- Don't spray store-bought products. They drive roaches away from the bait.",
    "Hi {first_name}, before your Waves cockroach visit:\n\n- Empty the cabinets under your sinks and clear around appliances.\n- Store food, dishes, and pet bowls away from treatment areas.\n- Don't spray store-bought products. They drive roaches away from the bait."
  ],
  [
    "auto_flea_no_email",
    "Hello {first_name}! Before your Waves flea visit:\n\n- Vacuum carpets, rugs, and pet resting areas, emptying outside.\n- Wash pet bedding on a hot cycle.\n- Treat every pet the same day with a vet-recommended flea product. Keep people and pets off treated areas until dry.",
    "Hi {first_name}, before your Waves flea visit:\n\n- Vacuum carpets, rugs, and pet resting areas, emptying outside.\n- Wash pet bedding on a hot cycle.\n- Treat every pet the same day with a vet-recommended flea product. Keep people and pets off treated areas until dry."
  ],
  [
    "auto_sprinkler_timer",
    "Hello {first_name}! Run your sprinklers by hand for your Monday watering plan: https://www.wavespestcontrol.com/sprinkler-timers/ Tap your timer brand and follow the photos. Stuck? Reply with a timer photo for help.",
    "Hi {first_name}, here's how to run your sprinklers by hand for your Monday watering plan:\nhttps://www.wavespestcontrol.com/sprinkler-timers/\n\nTap your timer brand and follow the photos. Stuck? Reply with a photo of your timer."
  ],
  [
    "service_request_confirmation",
    "Hello {first_name}! Waves got your {category} request. We'll review it within {response_time} and follow up once we have.",
    "Hi {first_name}, Waves got your {category} request. We'll follow up within {response_time}."
  ],
  [
    "annual_prepay_renewal_reminder",
    "Hello {first_name}! Your Waves prepaid plan year ends on {term_end}.{last_service_sentence}\n\nIt continues into next year on its own. Want to change or cancel? Reply and we'll help.",
    "Hi {first_name}, your Waves prepaid plan year ends on {term_end}.{last_service_sentence}\n\nIt continues into next year on its own. Want to change or cancel? Reply here."
  ],
  [
    "renewal_reminder",
    "Hello {first_name}! Your Waves {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active.",
    "Hi {first_name}, your Waves {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active."
  ],
  [
    "termite_annual_renewal_notice",
    "Hi {first_name}, your Waves Subterranean Termite Protection at {address_short} renews on {renewal_date} for another 12 months at {renewal_fee}. It renews automatically unless you cancel first: {cancel_link}. Questions? Reply here.",
    "Hi {first_name}, your Waves Subterranean Termite Protection at {address_short} renews on {renewal_date} for another 12 months at {renewal_fee}.\n\nIt renews automatically unless you cancel first: {cancel_link}\n\nQuestions? Reply here."
  ],
  [
    "upsell_add_service",
    "Hello {first_name}, it's Waves. Since you are already a WaveGuard member, we can add {service_name} to your plan with bundled service savings. Want details? Reply YES.",
    "Hi {first_name}, it's Waves. As a WaveGuard member, you can add {service_name} to your plan with bundle savings. Want details? Reply YES."
  ],
  [
    "upsell_tier_upgrade",
    "Hello {first_name}, it's Waves. Upgrading to WaveGuard {next_tier} can add more coverage and service savings. Want us to run the numbers? Reply YES and we'll send a breakdown.",
    "Hi {first_name}, it's Waves. WaveGuard {next_tier} adds more coverage and bigger savings. Want the numbers? Reply YES and we'll send a breakdown."
  ],
  [
    "upsell_interest_confirmation",
    "Hello {first_name}! Thanks for your interest in {service_name}. We'll follow up within 24 hours to get you set up, and your {new_tier} WaveGuard discount applies automatically.",
    "Hi {first_name}, thanks for your interest in {service_name}. We'll follow up within 24 hours, and your {new_tier} WaveGuard discount applies automatically."
  ],
  [
    "referral_invite",
    "Hello {referee_name}! {referrer_name} recommended Waves to you. Get a free quote here: {referral_link}\n\nReply STOP to opt out.",
    "Hi {referee_name}, {referrer_name} recommended Waves to you. Get a free quote: {referral_link}\n\nReply STOP to opt out."
  ],
  [
    "referral_nudge",
    "Hello {first_name}! Share your Waves referral link. They get $25 off, you get $25: {referral_link}\n\nReply STOP to opt out.",
    "Hi {first_name}, share your Waves referral link. They get $25 off, and you get $25: {referral_link}\n\nReply STOP to opt out."
  ]
];

const MIGRATION = '20261006220000_sms_template_tighten';

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
