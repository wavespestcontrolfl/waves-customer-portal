/**
 * Apply CUSTOMER_SMS_HOUSE_VOICE to every active SMS template (owner
 * directive 2026-08-01).
 *
 * The house voice lives in server/services/ai-assistant/managed-agent-config.js
 * and governs what the AI drafts, but the stored templates predate it. An
 * audit of the 93 active templates found 79 in violation:
 *   65  banned sign-off boilerplate ("Questions or requests? Reply here.")
 *   32  self-announcing ("with Waves", "Waves here") to people already
 *       mid-conversation with us
 *    8  performed enthusiasm ("Let's get your home bed bug-free")
 *    7  more than one exclamation mark
 *    2  filler ("a quick reminder", "no problem", "simply")
 *
 * Rewrites follow the prompt's own test: read it back, and if it sounds like
 * an automated system, rewrite it. Every {placeholder} each sender depends on
 * is preserved. Content that is load-bearing is NOT trimmed: prep steps,
 * money amounts, fee disclosures, the "we never take card numbers by phone"
 * warning, and the recipient_optin_request consent copy (untouched entirely).
 *
 * Opt-out language follows the 2026-08-01 ruling: "Reply STOP to opt out."
 * belongs on program-entry and marketing-adjacent messages (confirmations,
 * onboarding, estimates, referrals, reviews, retention, lead first-contact)
 * and comes OFF recurring operational notices to already-consented customers.
 * The keywords keep working regardless — they are registered on the approved
 * A2P campaign and enforced account-wide, plus our own opt-out detector.
 *
 * ADMIN-EDIT SAFETY: sms_templates rows are editable in /admin. Each rewrite
 * carries the exact body this sweep audited; a row whose body no longer
 * matches has been edited by hand since, and is SKIPPED rather than
 * clobbered.
 */

// [template_key, expected current body, new body]
const REWRITES = [
  // ── appointments ────────────────────────────────────────────────
  ['appointment_cancelled',
    "Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\nWant to reschedule? Reply here and we'll get you back on the calendar.",
    "Hello {first_name}! Your {service_type} on {day}, {date} is cancelled.\n\nWant to get back on the schedule? Reply here."],
  ['appointment_confirmation',
    "Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\n{reschedule_line}Questions? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your {service_type} is confirmed for {date} at {time}.\n\n{reschedule_line}Reply STOP to opt out."],
  ['appointment_no_show',
    "Hello {first_name}, it's {tech_name} from Waves Pest Control. We missed you for your service {when} at {time}. If you'd like to get back on the schedule, just reply to this message or give us a call and we'll find a new time.",
    "Hello {first_name}, it's {tech_name} from Waves. We missed you {when} at {time}. Reply here or give us a call and we'll find a new time."],
  ['appointment_rescheduled',
    "Hello {first_name}! You're confirmed: your {service_type} with Waves is now set for {day}, {date} at {time}.\n\nNeed to change it? Visit portal.wavespestcontrol.com or reply here.",
    "Hello {first_name}! Your {service_type} is now set for {day}, {date} at {time}.\n\nNeed to change it again? Reply here."],
  ['appointment_series_cancelled',
    "Hello {first_name}! Your Waves {scope} for {service_type} has been cancelled.\n\nWant to reschedule? Reply here and we'll get you back on the calendar.",
    "Hello {first_name}! Your {scope} for {service_type} is cancelled.\n\nWant to get back on the schedule? Reply here."],
  ['appointment_series_rescheduled',
    "Hello {first_name}! Your recurring Waves appointments have been rescheduled starting {start_date}{window_text}.\n\nWe'll remind you before each visit. Questions or requests? Reply here.",
    "Hello {first_name}! Your recurring appointments now start {start_date}{window_text}.\n\nWe'll remind you before each visit."],
  ['booking_abandonment_recovery',
    "Hello {first_name}! You were almost booked with Waves for {service_type} - your spot isn't reserved yet. Pick a time and you're all set: {booking_url}\n\nReply here with any questions.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your {service_type} spot isn't reserved yet. Pick a time and you're set: {booking_url}\n\nReply STOP to opt out."],
  ['rain_out_moved',
    "Hello {first_name} - {weather_phrase} rolled through your area, so we moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.",
    "Hello {first_name}, {weather_phrase} rolled through your area, so we moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}"],
  // The two reminders also switch from explaining the arrival-window concept
  // to simply stating it, via the new {window} placeholder (arrivalWindowRange,
  // the same helper dispatch/estimates/reschedule already use).
  ['reminder_24h',
    "Hello {first_name}! Your {service_type} with Waves is tomorrow. Your arrival window starts at {time}, and we'll text you a tracking link when your technician is on the way.{card_hold_policy_line}\n\nQuestions or need to reschedule? Reply here.",
    "Hello {first_name}! Your {service_type} is tomorrow, {window}. We'll text you a tracking link when your tech is on the way.{card_hold_policy_line}"],
  ['reminder_72h',
    "Hello {first_name}! Reminder: your {service_type} with Waves is scheduled for {day} at {time}. Your technician will arrive within a two-hour window of the start time.\n\n{reschedule_line}Questions? Reply here.\n\nReply STOP to opt out.{card_hold_policy_line}",
    "Hello {first_name}! Your {service_type} is this {day}, {window}.\n\n{reschedule_line}{card_hold_policy_line}"],
  ['tech_arrived',
    "Hello {first_name}! {tech_name} has arrived at your property for your scheduled service.\n\nQuestions or requests? Reply to this message.",
    "Hello {first_name}! {tech_name} has arrived for your service."],
  ['tech_en_route',
    "Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}Questions or requests? Reply here.",
    "Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}"],

  // ── autopay ─────────────────────────────────────────────────────
  ['ach_card_fallback',
    "Hello {first_name}! Your bank payment failed again, so we switched this payment to your card on file. Card payments include a processing fee. You can switch back to bank payment once your account is verified.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your bank payment failed again, so we switched this payment to your card on file. Card payments include a processing fee. You can switch back to bank payment once your account is verified."],
  ['ach_retry_notice',
    "Hello {first_name}! Your bank payment did not go through. We will retry automatically in 3 business days. No action is needed right now.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your bank payment did not go through. We'll retry automatically in 3 business days. Nothing you need to do right now."],
  ['ach_suspended',
    "Hello {first_name}! Your bank payment failed again. We updated your default payment to your card. Card payments include a processing fee.\n\nTo pay by bank with no added fee, update your bank account here: {billing_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your bank payment failed again, so we set your card as the default. Card payments include a processing fee.\n\nTo pay by bank with no added fee, update your bank account here: {billing_url}"],
  ['autopay_card_expired',
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expired {exp_date}. Please update it in the portal to keep auto-pay active: portal.wavespestcontrol.com\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expired {exp_date}. Update it here to keep auto-pay active: portal.wavespestcontrol.com"],
  ['autopay_card_expiring',
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Please update it in the portal to avoid auto-pay disruption: portal.wavespestcontrol.com\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Update it here so auto-pay keeps working: portal.wavespestcontrol.com"],
  ['autopay_charge_failed',
    "Hello {first_name}! Your WaveGuard monthly payment of ${amount} could not be processed. We'll retry in a few days. Update your card here: {update_card_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your WaveGuard monthly payment of ${amount} did not go through. We'll retry in a few days, or you can update your card here: {update_card_url}"],
  ['autopay_charge_success',
    "Hello {first_name}! Your WaveGuard monthly payment of ${amount} was processed. Thank you!{receipt_line}",
    "Hello {first_name}! Your WaveGuard monthly payment of ${amount} went through. Thank you.{receipt_line}"],
  ['autopay_pre_charge',
    "Hello {first_name}! Your {autopay_label} will process on {charge_date}.\n\nNeed to update your card or pause? Visit portal.wavespestcontrol.com or reply here.",
    "Hello {first_name}! Your {autopay_label} processes on {charge_date}.\n\nNeed to update your card or pause? Reply here."],
  ['autopay_retry_failed',
    "Hello {first_name}! Your payment of ${amount} still did not go through. We'll try again in a few days, or you can update your card here: {update_card_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your payment of ${amount} still did not go through. We'll try again in a few days, or you can update your card here: {update_card_url}"],
  ['autopay_retry_final_failed',
    "Hello {first_name}! After several attempts we still could not process your payment of ${amount}. Please update your card to keep service active: {update_card_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! After several tries your payment of ${amount} still has not gone through. Update your card to keep service active: {update_card_url}"],
  ['autopay_retry_success',
    "Hello {first_name}! Your payment of ${amount} went through. Thank you for being a Waves customer!{receipt_line}",
    "Hello {first_name}! Your payment of ${amount} went through. Thank you.{receipt_line}"],
  ['bank_verification_failed',
    "Hello {first_name}! We could not verify your bank account. Please try again or use a card here: {billing_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! We could not verify your bank account. Try again or use a card here: {billing_url}"],
  ['bank_verification_incomplete',
    "Hello {first_name}! Your bank account verification is incomplete. Please finish setup here to complete your payment: {billing_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your bank account verification isn't finished. Complete it here so your payment can go through: {billing_url}"],
  ['payment_method_expiry',
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Update your payment method to avoid service interruption: portal.wavespestcontrol.com\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Update it here so your service isn't interrupted: portal.wavespestcontrol.com"],

  // ── billing ─────────────────────────────────────────────────────
  ['previsit_balance_reminder',
    "Hello {first_name}! Ahead of your {service_type} visit on {visit_date}, a quick reminder: your account has a past-due balance of ${amount}. Already handled it? Thank you - no action needed.\n\nPay here: {billing_url}",
    "Hello {first_name}! Ahead of your {service_type} visit on {visit_date}: your account has a past-due balance of ${amount}. If you already paid it, nothing more is needed.\n\nPay here: {billing_url}"],
  ['price_change_notice',
    "Hello {first_name}! A heads-up from Waves: your recurring service price changes on {effective_date}. No action needed - reply with any questions.\n\nDetails: {price_change_url}",
    "Hello {first_name}! Your recurring service price changes on {effective_date}. Nothing you need to do.\n\nDetails: {price_change_url}"],
  ['secure_appointment_card',
    "Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file. Nothing is charged today - your card is only charged after service is completed: {secure_link}{cancel_fee_line}\nWe never take card numbers by phone. Reply STOP to opt out.",
    "Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after the service is done.{cancel_fee_line}\nWe never take card numbers by phone. Reply STOP to opt out."],
  ['service_complete_paid_receipt',
    "Hello {first_name}! Thanks for your payment today - ${amount}{card_line}. Your {service_type} service report is ready: {portal_url}\n\nReceipt: {receipt_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Payment received, ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\nReceipt: {receipt_url}"],

  // ── cancellations ───────────────────────────────────────────────
  ['service_cancellation_confirmation',
    "Hello {first_name}! We received your cancellation request. Our team will process it and follow up to confirm. Questions? Reply here.",
    "Hello {first_name}! We got your cancellation request and will follow up to confirm."],

  // ── estimates (program entry / marketing-adjacent: STOP stays) ───
  ['estimate_accepted_annual_prepay',
    "Hello {first_name}! Your {waveguard_tier} WaveGuard plan is approved. Our team will review and send your annual prepay invoice{amount_text}.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {waveguard_tier} WaveGuard plan is approved. We'll review and send your annual prepay invoice{amount_text}."],
  ['estimate_accepted_onetime',
    "Hello {first_name}! Thanks for booking your {service_label} with Waves. Choose a time here: {booking_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Thanks for booking your {service_label}. Choose a time here: {booking_url}"],
  ['estimate_extended',
    "Hello {first_name}! We extended your Waves estimate through {new_expiry} so you have more time to review it: {estimate_url}\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! We extended your estimate through {new_expiry} so you have more time with it: {estimate_url}\n\nReply STOP to opt out."],
  ['estimate_followup_deposit',
    "Hello {first_name}! Your Waves appointment is almost reserved - your estimate is saved and just needs the ${deposit_amount} deposit to lock in your spot: {estimate_url}\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your estimate is saved and needs the ${deposit_amount} deposit to lock in your spot: {estimate_url}\n\nReply STOP to opt out."],
  ['estimate_sent',
    "Hello {first_name}! Your Waves estimate is ready: {estimate_url}\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your estimate is ready: {estimate_url}\n\nReply STOP to opt out."],
  ['quote_wizard_booking_invite',
    "Hello {first_name}! Your {service_label} quote from Waves is ready. Want to get started? Pick a time that works for you: {booking_url}\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your {service_label} quote is ready. Pick a time that works for you: {booking_url}\n\nReply STOP to opt out."],

  // ── invoices ────────────────────────────────────────────────────
  ['ach_payment_processing',
    "Hello {first_name}! Got it - we received your bank payment for invoice {invoice_number}. ACH transfers typically take 3-5 business days to clear; we'll send a receipt as soon as it does.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! We got your bank payment for invoice {invoice_number}. ACH transfers take 3-5 business days to clear, and we'll send a receipt as soon as it does."],
  ['annual_prepay_payment_reminder',
    "Hello {first_name}! A quick reminder that your Waves annual prepay invoice{amount_text} is still open ahead of your first visit on {first_visit_date}.\n\nIf it isn't settled before the visit, no problem - we'll simply bill that visit individually instead. Questions? Reply here.\n\nPay here: {pay_link}",
    "Hello {first_name}! Your annual prepay invoice{amount_text} is still open ahead of your first visit on {first_visit_date}. If it isn't paid by then, we'll bill that visit individually instead.\n\nPay here: {pay_link}"],
  ['deposit_receipt',
    "Hello {first_name}! We received your ${amount} deposit{charge_note} - it will be applied toward your first visit. Thank you for choosing Waves!\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! We received your ${amount} deposit{charge_note}. It goes toward your first visit. Thank you."],
  ['invoice_followup_14day',
    "Hello {first_name}! Checking in on your Waves invoice for {invoice_title}{service_date_clause}. Please pay when you can: {pay_url}\n\nNeed help? Reply here.",
    "Hello {first_name}! Checking in on your invoice for {invoice_title}{service_date_clause}. You can pay here: {pay_url}\n\nIf something is holding it up, reply and we'll help."],
  ['invoice_followup_30day',
    "Hello {first_name}! Final notice on your Waves invoice for {invoice_title}{service_date_clause}. Please pay now to keep the account in good standing: {pay_url}\n\nNeed a payment plan? Reply here.",
    "Hello {first_name}! Final notice on your invoice for {invoice_title}{service_date_clause}. Please pay to keep the account in good standing: {pay_url}\n\nNeed a payment plan? Reply here."],
  ['invoice_followup_3day',
    "Hello {first_name}! Your invoice for {invoice_title} still has an open balance of ${amount}. Pay securely here: {pay_url}\n\nIf something looks off, reply and we'll sort it.",
    "Hello {first_name}! Your invoice for {invoice_title} has an open balance of ${amount}: {pay_url}\n\nIf something looks off, reply and we'll sort it."],
  ['invoice_followup_7day',
    "Hello {first_name}! Quick reminder: your Waves invoice for {invoice_title}{service_date_clause} is still open. Pay here: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is still open. Pay here: {pay_url}"],
  ['invoice_receipt',
    "Hello {first_name}! Payment received - thank you. Invoice {invoice_number}: ${amount}{card_line}. Receipt: {receipt_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Payment received, thank you. Invoice {invoice_number}: ${amount}{card_line}.\n\nReceipt: {receipt_url}"],
  ['invoice_sent',
    "Hello {first_name}! Your invoice for {service_type} completed on {service_date} is ready: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your invoice for {service_type} on {service_date} is ready: {pay_url}"],
  ['invoice_sent_annual_prepay',
    "Hello {first_name}! Your Waves annual prepay plan invoice is ready - it prepays {coverage_summary}.{first_visit_clause} Questions? Reply here.\n\nPay here: {pay_url}",
    "Hello {first_name}! Your annual prepay plan invoice is ready. It prepays {coverage_summary}.{first_visit_clause}\n\nPay here: {pay_url}"],
  ['invoice_sent_upfront',
    "Hello {first_name}! Your invoice to get started with {service_type} is ready. Questions? Reply here.\n\nPay here: {pay_url}",
    "Hello {first_name}! Your invoice to get started with {service_type} is ready.\n\nPay here: {pay_url}"],
  ['manual_payment_receipt',
    "Hello {first_name}! Your payment to Waves was processed. Thank you!{receipt_line}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your payment went through. Thank you.{receipt_line}"],
  ['payment_failed',
    "Hello {first_name}! Your payment{card_line} for {service_type} completed on {service_date} did not go through. Please update your payment method or pay here: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your payment{card_line} for {service_type} on {service_date} did not go through. You can update your card or pay here: {pay_url}"],

  // ── late payments ───────────────────────────────────────────────
  ['balance_payment_received',
    "Hello {first_name}! Got it - thank you for the payment. Your account is caught up. We will see you at your next service.",
    "Hello {first_name}! Thank you for the payment. Your account is caught up and we'll see you at your next service."],
  ['balance_reminder_firm',
    "Hello {first_name}! Quick reminder from Waves: your {service_type} is {service_timing} and there is an outstanding balance.\n\nPlease take care of it so we can keep you on schedule: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {service_type} is {service_timing} and your account has an outstanding balance.\n\nPlease take care of it so we can keep you on schedule: {pay_url}"],
  ['balance_reminder_gentle',
    "Hello {first_name}! Waves here. We're scheduled to see you on {service_date}.\n\nOur records show an outstanding balance. To avoid any service interruption, please take care of it before your appointment: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! We're scheduled to see you on {service_date}, and your account has an outstanding balance.\n\nTaking care of it before the visit keeps your service uninterrupted: {pay_url}"],
  ['balance_reminder_urgent',
    "Hello {first_name}! Your Waves service is {service_timing} and your account has an outstanding balance.\n\nPay now to keep your appointment: {pay_url}\n\nAlready paid? Reply here and we will check it.",
    "Hello {first_name}! Your service is {service_timing} and your account has an outstanding balance.\n\nPay here to keep your appointment: {pay_url}\n\nAlready paid? Reply and we'll check."],
  ['late_payment_7d',
    "Hello {first_name}! Your Waves invoice for {invoice_title}{service_date_clause} is 7 days overdue. Please pay here: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 7 days overdue. Please pay here: {pay_url}"],
  ['late_payment_14d',
    "Hello {first_name}! Your Waves invoice for {invoice_title}{service_date_clause} is 14 days overdue. Please pay as soon as possible: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 14 days overdue. Please pay as soon as you can: {pay_url}"],
  ['late_payment_30d',
    "Hello {first_name}! Final reminder: your Waves invoice for {invoice_title}{service_date_clause} is 30 days overdue. Please pay now: {pay_url}\n\nNeed a payment plan? Reply here.",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 30 days overdue. Please pay here: {pay_url}\n\nNeed a payment plan? Reply here."],
  ['late_payment_60d',
    "Hello {first_name}! Your Waves invoice for {invoice_title}{service_date_clause} is 60 days overdue. Please pay or contact us today to avoid further action: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your invoice for {invoice_title}{service_date_clause} is 60 days overdue. Please pay or contact us today to avoid further action: {pay_url}"],
  ['late_payment_90d',
    "Hello {first_name}! Final notice: your Waves invoice for {invoice_title}{service_date_clause} is 90 days overdue and may be sent to collections. Please pay today: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Final notice: your invoice for {invoice_title}{service_date_clause} is 90 days overdue and may be sent to collections. Please pay today: {pay_url}"],

  // ── leads (FIRST contact: the brand name stays, they don't know us yet) ──
  ['lead_auto_reply_biz',
    "Hello {first_name}! Waves here! We received your quote request. A specialist will be calling soon. Thank you!\n\nReply STOP to opt out.",
    "Hello {first_name}! Waves Pest Control here. We got your quote request and someone will call you shortly.\n\nReply STOP to opt out."],
  ['voicemail_quote_link',
    "Hello {first_name}, it's Waves Pest Control - got your message about {service_label}. Get your quote here: {quote_url}\n\nOr reply here and we'll call you back.\n\nReply STOP to opt out.",
    "Hello {first_name}, it's Waves Pest Control. We got your message about {service_label}, and your quote is here: {quote_url}\n\nOr reply and we'll call you back.\n\nReply STOP to opt out."],

  // ── onboarding ──────────────────────────────────────────────────
  ['auto_bed_bug',
    "Hello {first_name}! Let's get your home bed bug-free. We emailed your Waves treatment guide; please review it before service so we can get the best results.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! We emailed your bed bug treatment guide. Please read it before your visit so the treatment works as well as it can."],
  ['auto_bed_bug_no_email',
    "Hello {first_name}! Let's get your home bed bug-free. Before your visit:\n\n- Launder bedding and clothing from affected rooms in hot water, dry on highest heat 30+ min, then seal in bags.\n- Vacuum mattresses, frames, and baseboards (empty the vacuum outside).\n- Pull beds and furniture 12-18 in. from walls.\n\nYour 14-day follow-up is critical - please repeat these steps before it. Questions? Reply here.",
    "Hello {first_name}! Before your bed bug visit:\n\n- Launder bedding and affected clothing in hot water, dry on high 30+ min, then bag it.\n- Vacuum mattresses, frames, and baseboards, emptying outside.\n- Pull beds and furniture 12-18 in. from walls.\n\nRepeat all three before your 14-day follow-up."],
  ['auto_cockroach',
    "Hello {first_name}! Let's get your home cockroach-free. We emailed your Waves treatment guide; please review it before service so we can get the best results.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! We emailed your cockroach treatment guide. Please read it before your visit so the treatment works as well as it can."],
  ['auto_cockroach_no_email',
    "Hello {first_name}! Let's get your home cockroach-free. Before your visit:\n\n- Clear access under sinks, around appliances, and along pantry edges.\n- Store food, dishes, and pet bowls away from treatment areas.\n- Please avoid store-bought sprays - they can scatter the activity.\n\nQuestions? Reply here.",
    "Hello {first_name}! Before your cockroach visit:\n\n- Clear access under sinks, around appliances, and along pantry edges.\n- Store food, dishes, and pet bowls away from treatment areas.\n- Skip store-bought sprays, which scatter the activity."],
  ['auto_flea',
    "Hello {first_name}! Let's get your home flea-free. We emailed your Waves treatment guide; please review it before service so we can get the best results.\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! We emailed your flea treatment guide. Please read it before your visit so the treatment works as well as it can."],
  ['auto_flea_no_email',
    "Hello {first_name}! Let's get your home flea-free. Before your visit:\n\n- Vacuum carpets, rugs, and pet resting areas (empty the vacuum outside).\n- Wash pet bedding on a hot cycle.\n- Coordinate pet flea control with your vet and keep people and pets off treated areas until dry.\n\nQuestions? Reply here.",
    "Hello {first_name}! Before your flea visit:\n\n- Vacuum carpets, rugs, and pet resting areas, emptying outside.\n- Wash pet bedding on a hot cycle.\n- Coordinate pet flea control with your vet, and keep people and pets off treated areas until dry."],
  ['auto_new_appointment',
    "Hello {first_name}! We just emailed what to expect for your first Waves service.\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! We just emailed what to expect for your first service.\n\nReply STOP to opt out."],
  ['auto_new_recurring',
    "Hello {first_name}! Welcome to Waves!\n\nManage everything in the free Waves app: upcoming visits, live tech tracking, easy rescheduling, invoices, and more. Get it at wavespestcontrol.com/app\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}, welcome to Waves!\n\nYou can manage everything in the free Waves app: upcoming visits, live tech tracking, rescheduling, and invoices. Get it at wavespestcontrol.com/app\n\nReply STOP to opt out."],

  // ── referrals ───────────────────────────────────────────────────
  ['referral_invite',
    "Hello {referee_name}! {referrer_name} thinks you'd love Waves Pest Control. Get a free quote here: {referral_link}\n\nQuestions? Reply here.\n\nReply STOP to opt out.",
    "Hello {referee_name}! {referrer_name} recommended Waves Pest Control to you. Get a free quote here: {referral_link}\n\nReply STOP to opt out."],
  ['referral_reward',
    "Great news, {referrer_name}! Your referral {referee_name} signed up with Waves. You earned {reward_amount}. Thank you for sharing Waves!\n\nReply STOP to opt out.",
    "{referrer_name}, your referral {referee_name} signed up and you earned {reward_amount}. Thank you for sharing Waves.\n\nReply STOP to opt out."],

  // ── requests ────────────────────────────────────────────────────
  ['service_request_confirmation',
    "Hello {first_name}! We received your {category} request. Our team will review it within {response_time}. We'll text you when it has been assigned to a technician.\n\nTrack progress in your customer portal or reply here.",
    "Hello {first_name}! We got your {category} request and will review it within {response_time}. We'll text you once it's assigned to a technician."],

  // ── retention ───────────────────────────────────────────────────
  ['annual_prepay_renewal_reminder',
    "Hello {first_name}! Your prepaid Waves plan year ends on {term_end}.{last_service_sentence}\n\nNo action needed - your plan continues into the next year. Want to change or cancel? Just reply and our team will help.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your prepaid plan year ends on {term_end}.{last_service_sentence}\n\nIt continues into next year on its own. Want to change or cancel? Reply and we'll help.\n\nReply STOP to opt out."],
  ['renewal_reminder',
    "Hello {first_name}! Your {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active. Questions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active.\n\nReply STOP to opt out."],
  ['upsell_interest_confirmation',
    "Hello {first_name}! Thanks for your interest in {service_name}. Waves will follow up within 24 hours to get you set up. Your {new_tier} WaveGuard discount will apply automatically.\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! Thanks for your interest in {service_name}. We'll follow up within 24 hours to get you set up, and your {new_tier} WaveGuard discount applies automatically.\n\nReply STOP to opt out."],

  // ── reviews ─────────────────────────────────────────────────────
  ['review_request',
    "Hello {first_name}! How was your Waves service? We'd love your feedback: {review_url}\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.",
    "Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\nReply STOP to opt out."],

  // ── service (rain-out) ──────────────────────────────────────────
  ['rain_out_moved_v2',
    "Hello {first_name} - {weather_lead}, so we moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.",
    "Hello {first_name}, {weather_lead}, so we moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}"],
  ['rain_out_moved_v3',
    "Hi {first_name} - {weather_lead}, so we moved your {service_type} to {new_option}.{link_clause}\n\nQuestions? Reply here. Reply STOP to opt out.",
    "Hi {first_name}, {weather_lead}, so we moved your {service_type} to {new_option}.{link_clause}\n\nReply STOP to opt out."],

  // ── service reports ─────────────────────────────────────────────
  ['lawn_health_report_ready',
    "Hello {first_name}! Your lawn health report is ready - you scored {overall_score}/100{delta_line}.{tip_line}\n\nView full report: {portal_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your lawn health report is ready. You scored {overall_score}/100{delta_line}.{tip_line}\n\nFull report: {portal_url}"],
  ['project_report_ready',
    "Hello {first_name}! Your Waves {project_type} report is ready: {report_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {project_type} report is ready: {report_url}"],
  ['service_complete',
    "Hello {first_name}! Your service report is ready: {portal_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your service report is ready: {portal_url}"],
  ['service_complete_annual_prepay',
    "Hello {first_name}! Your {service_type} service is complete and covered by your annual prepaid plan - nothing due today. Your service report is ready: {portal_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {service_type} is done and covered by your annual prepaid plan, so nothing is due today.\n\nYour report: {portal_url}"],
  ['service_complete_prepaid',
    "Hello {first_name}! Thanks for your payment today. Your {service_type} service report is ready: {portal_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Thanks for your payment today. Your {service_type} report is ready: {portal_url}"],
  ['service_complete_with_invoice',
    "Hello {first_name}! Your {service_type} service report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your {service_type} report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}"],
  ['service_report_v1',
    "Hello {first_name}! Your Waves service report is ready: {report_url}{reentry_line}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your service report is ready: {report_url}{reentry_line}"],
  ['service_report_v1_with_invoice',
    "Hello {first_name}! Your Waves service report is ready: {report_url}{reentry_line}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply here.",
    "Hello {first_name}! Your service report is ready: {report_url}{reentry_line}\n\nInvoice for today's visit: {pay_url}"],
];

// reminder_24h / reminder_72h swap {time} for {window} (the 2-hour arrival
// range). Their `variables` column must follow or the admin editor's
// placeholder list goes stale.
const VARIABLE_UPDATES = {
  reminder_24h: ['first_name', 'service_type', 'time', 'window', 'reschedule_line', 'card_hold_policy_line'],
  reminder_72h: ['first_name', 'service_type', 'day', 'date', 'time', 'window', 'reschedule_line', 'card_hold_policy_line'],
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return;

  let updated = 0;
  const skipped = [];
  for (const [templateKey, expected, next] of REWRITES) {
    const patch = { body: next };
    if (cols.updated_at) patch.updated_at = new Date();
    if (cols.variables && VARIABLE_UPDATES[templateKey]) {
      patch.variables = JSON.stringify(VARIABLE_UPDATES[templateKey]);
    }
    // Admin-edit guard, enforced IN the UPDATE predicate rather than by a
    // separate SELECT: 86 sequential rewrites during a live deploy leave a
    // wide window for an operator to save an edit between a read and its
    // write, and a key-only UPDATE would silently overwrite the newer copy.
    // Zero rows matched = edited (or missing) = skipped.
    const matched = await knex('sms_templates')
      .where({ template_key: templateKey, body: expected })
      .update(patch);
    if (matched) updated += 1;
    else skipped.push(templateKey);
  }

  // The referral engine prefers referral_program_settings.*_sms_template when
  // those columns are non-null and never consults sms_templates, so rewriting
  // the base rows alone leaves the live referral copy untouched.
  const legacyReferral = [
    ['invite_sms_template',
      "Hi {referee_name}! Your neighbor {referrer_name} thinks you'd love Waves Pest Control. You'll both save when you sign up: {referral_link}",
      "Hi {referee_name}! Your neighbor {referrer_name} recommended Waves Pest Control. You'll both save when you sign up: {referral_link}"],
    ['reward_sms_template',
      "Great news, {referrer_name}! Your referral {referee_name} signed up. You earned {reward_amount} in credit!",
      "{referrer_name}, your referral {referee_name} signed up and you earned {reward_amount} in credit."],
  ];
  if (await knex.schema.hasTable('referral_program_settings')) {
    const refCols = await knex('referral_program_settings').columnInfo();
    for (const [column, expected, next] of legacyReferral) {
      if (!refCols[column]) continue;
      const matched = await knex('referral_program_settings')
        .where({ [column]: expected })
        .update({ [column]: next });
      if (matched) updated += 1;
      else skipped.push(`referral_program_settings.${column}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[house-voice-sweep] rewrote ${updated}; skipped ${skipped.length}${skipped.length ? ` (edited since audit or missing): ${skipped.join(', ')}` : ''}`);
};

exports.LEGACY_REFERRAL_REWRITES = [
  ['invite_sms_template',
    "Hi {referee_name}! Your neighbor {referrer_name} thinks you'd love Waves Pest Control. You'll both save when you sign up: {referral_link}",
    "Hi {referee_name}! Your neighbor {referrer_name} recommended Waves Pest Control. You'll both save when you sign up: {referral_link}"],
  ['reward_sms_template',
    "Great news, {referrer_name}! Your referral {referee_name} signed up. You earned {reward_amount} in credit!",
    "{referrer_name}, your referral {referee_name} signed up and you earned {reward_amount} in credit."],
];

// The variables each reminder carried BEFORE this migration. down() must
// restore these alongside the bodies: the admin template validator builds its
// allowlist from this column, so a body back on {time} with an allowlist still
// listing only {window} makes every later edit to that reminder fail
// validation with "unknown placeholder: time".
const VARIABLE_ROLLBACK = {
  reminder_24h: ['first_name', 'service_type', 'time', 'reschedule_line', 'card_hold_policy_line'],
  reminder_72h: ['first_name', 'service_type', 'day', 'time', 'reschedule_line', 'card_hold_policy_line'],
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    for (const [templateKey, expected, next] of REWRITES) {
      const patch = { body: expected };
      if (cols.updated_at) patch.updated_at = new Date();
      if (cols.variables && VARIABLE_ROLLBACK[templateKey]) {
        patch.variables = JSON.stringify(VARIABLE_ROLLBACK[templateKey]);
      }
      // Same predicate-guard as up(): only revert rows still carrying exactly
      // what this migration wrote, so a later hand edit survives a rollback.
      await knex('sms_templates')
        .where({ template_key: templateKey, body: next })
        .update(patch);
    }
  }

  if (await knex.schema.hasTable('referral_program_settings')) {
    const refCols = await knex('referral_program_settings').columnInfo();
    for (const [column, expected, next] of exports.LEGACY_REFERRAL_REWRITES) {
      if (!refCols[column]) continue;
      await knex('referral_program_settings').where({ [column]: next }).update({ [column]: expected });
    }
  }
};

module.exports.REWRITES = REWRITES;
