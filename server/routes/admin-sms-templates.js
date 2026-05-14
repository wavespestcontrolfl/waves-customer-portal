const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { formatSmsTemplateVars } = require('../utils/sms-time-format');

router.use(adminAuthenticate, requireTechOrAdmin);

// Auto-create table if missing + seed any new default templates that don't exist yet
let _seededThisProcess = false;
async function ensureTable() {
  if (!(await db.schema.hasTable('sms_templates'))) {
    await db.schema.createTable('sms_templates', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('template_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.string('category', 30).notNullable();
      t.text('body').notNullable();
      t.text('description');
      t.jsonb('variables');
      t.boolean('is_active').defaultTo(true);
      t.boolean('is_internal').defaultTo(false);
      t.integer('sort_order').defaultTo(100);
      t.timestamps(true, true);
    });
  }
  if (_seededThisProcess) return;
  _seededThisProcess = true;
  // Upsert default templates — onConflict.ignore means existing rows are untouched,
  // new template_keys (like newly-added seeds) get inserted on deploy.
  const templates = [
      { template_key: 'appointment_confirmation', name: 'Appointment Confirmation', category: 'service', body: 'Hi {first_name}! Your {service_type} with Waves is confirmed for {date} between {time}. Reply to reschedule.\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','service_type','date','time']), sort_order: 1 },
      { template_key: 'reminder_72h', name: '72-Hour Reminder', category: 'service', body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for {day} at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Need to reschedule? Log into your Waves Customer Portal at portal.wavespestcontrol.com. If you have any questions or need assistance, simply reply to this message. — Waves', variables: JSON.stringify(['first_name','service_type','day','time']), sort_order: 2 },
      { template_key: 'reminder_24h', name: '24-Hour Reminder', category: 'service', body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for tomorrow at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Your tech will text you when they are 15 minutes out. If you have any questions or need assistance, simply reply to this message. — Waves', variables: JSON.stringify(['first_name','service_type','time']), sort_order: 3 },
      { template_key: 'tech_en_route', name: 'Tech En Route (hardcoded)', category: 'service', body: 'Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}Questions or requests? Reply to this message. Reply STOP to opt out.', variables: JSON.stringify(['first_name','tech_name','eta_line','track_clause']), sort_order: 3 },
      { template_key: 'tech_arrived', name: 'Tech Arrived (hardcoded)', category: 'service', body: 'Hello {first_name}! {tech_name} has arrived and is servicing your property.\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.', variables: JSON.stringify(['first_name','tech_name']), sort_order: 4 },
      { template_key: 'service_complete', name: 'Service Complete (hardcoded)', category: 'service', body: 'Hello {first_name}! Your service report is ready. View it here: portal.wavespestcontrol.com\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name']), sort_order: 4 },
      { template_key: 'service_complete_with_invoice', name: 'Service Complete + Invoice', category: 'service', body: "Hello {first_name}! Your {service_type} service report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!", variables: JSON.stringify(['first_name','service_type','portal_url','pay_url']), sort_order: 5 },
      { template_key: 'service_complete_prepaid', name: 'Service Complete + Paid', category: 'service', body: 'Hello {first_name}! Thanks for your payment today. Your {service_type} service report is ready: {portal_url}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!', variables: JSON.stringify(['first_name','service_type','portal_url']), sort_order: 5 },
      { template_key: 'missed_call', name: 'Missed Call Follow-Up', category: 'service', body: 'Hey {first_name}, this is Waves. Sorry we missed your call. How can we help? Reply or call (941) 318-7612.', variables: JSON.stringify(['first_name']), sort_order: 5 },
      { template_key: 'appointment_rescheduled', name: 'Appointment Rescheduled', category: 'service', body: 'Hello {first_name}! Your {service_type} with Waves has been rescheduled to {day}, {date} at {time}.\n\nNeed to change it again? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','service_type','day','date','time']), sort_order: 6 },
      { template_key: 'appointment_cancelled', name: 'Appointment Cancelled', category: 'service', body: "Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\nWant to reschedule? Reply to this message and we'll get you back on the calendar.", variables: JSON.stringify(['first_name','service_type','day','date']), sort_order: 7 },
      { template_key: 'invoice_sent', name: 'Invoice Sent (hardcoded)', category: 'billing', body: 'Hi {first_name}! Your invoice for {service_type} completed on {service_date} is ready: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','service_type','service_date','pay_url']), sort_order: 10 },
      { template_key: 'invoice_receipt', name: 'Payment Receipt (hardcoded)', category: 'billing', body: 'Payment received — thank you, {first_name}!\n\nInvoice: {invoice_number}\nAmount: ${amount}{card_line}\n\nView receipt: {receipt_url}\n\nYour property is protected. See you at your next service!\n\n— Waves Pest Control', variables: JSON.stringify(['first_name','invoice_number','amount','card_line','receipt_url']), sort_order: 17 },
      { template_key: 'billing_reminder', name: 'Billing Reminder (WaveGuard Monthly) (hardcoded)', category: 'billing', body: 'Hi {first_name}, your {waveguard_tier} WaveGuard monthly charge of ${amount} will be processed on {charge_date}.\n\nManage your payment method in your customer portal or call (941) 318-7612.', variables: JSON.stringify(['first_name','waveguard_tier','amount','charge_date']), sort_order: 18 },
      { template_key: 'payment_failed', name: 'Payment Failed', category: 'billing', body: "Hi {first_name}, your payment for {service_type} completed on {service_date} didn't go through. Please update your payment method or reply for help.", variables: JSON.stringify(['first_name','service_type','service_date']), sort_order: 11 },
      { template_key: 'late_payment_7d', name: 'Late Payment — 7 Day (hardcoded)', category: 'billing', body: 'Hello {first_name}! This is a reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 7 days overdue.\n\nPlease make your payment here: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 12 },
      { template_key: 'late_payment_14d', name: 'Late Payment — 14 Day (hardcoded)', category: 'billing', body: 'Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 14 days overdue.\n\nPlease make your payment as soon as possible at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 13 },
      { template_key: 'late_payment_30d', name: 'Late Payment — 30 Day (hardcoded)', category: 'billing', body: 'Hello {first_name}, this is a final reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 30 days overdue.\n\nPlease make your payment immediately at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 14 },
      { template_key: 'late_payment_60d', name: 'Late Payment — 60 Day (hardcoded)', category: 'billing', body: 'Hello {first_name}, this is an urgent notice from Waves. Your invoice for {invoice_title}{service_date_clause} is now 60 days overdue.\n\nPlease make payment or contact us immediately to avoid further action: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 15 },
      { template_key: 'late_payment_90d', name: 'Late Payment — 90 Day (hardcoded)', category: 'billing', body: 'Hello {first_name}, your invoice from Waves for {invoice_title}{service_date_clause} is now 90 days overdue.\n\nFinal notice: This account will be sent to collections if payment is not received today. Please pay now: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 16 },
      { template_key: 'invoice_followup_3day', name: 'Invoice Follow-Up — 3 Day (hardcoded)', category: 'billing', body: "Hi {first_name}, still showing an open balance on your invoice for {invoice_title} — \${amount}. Secure pay link: {pay_url}\n\nIf something's off, just reply and we'll sort it. — Waves", variables: JSON.stringify(['first_name','invoice_title','amount','pay_url']), sort_order: 19 },
      { template_key: 'invoice_followup_7day', name: 'Invoice Follow-Up — 7 Day (hardcoded)', category: 'billing', body: 'Hi {first_name}, just a friendly reminder from Waves — your invoice for {invoice_title}{service_date_clause} is still open. You can pay here: {pay_url}\n\nQuestions? Reply to this message. — Waves', variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 20 },
      { template_key: 'invoice_followup_14day', name: 'Invoice Follow-Up — 14 Day (hardcoded)', category: 'billing', body: "Hi {first_name}, checking in on your Waves invoice for {invoice_title}{service_date_clause} — we'd appreciate payment at your earliest convenience: {pay_url}\n\nReply if you need anything. — Waves", variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 21 },
      { template_key: 'invoice_followup_30day', name: 'Invoice Follow-Up — 30 Day (hardcoded)', category: 'billing', body: 'Hi {first_name}, this is a final notice on your Waves invoice for {invoice_title}{service_date_clause}. Please pay now to keep the account in good standing: {pay_url}\n\nReply to discuss a payment plan. — Waves', variables: JSON.stringify(['first_name','invoice_title','service_date_clause','pay_url']), sort_order: 22 },
      { template_key: 'estimate_sent', name: 'Estimate Sent', category: 'estimates', body: 'Hi {first_name}! Your Waves estimate is ready: {estimate_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','estimate_url']), sort_order: 20 },
      { template_key: 'estimate_followup_unviewed', name: 'Estimate Follow-Up — Unviewed 24h (hardcoded)', category: 'estimates', body: "Hey {first_name}! Just wanted to make sure you saw your Waves Pest Control estimate.\n\n{estimate_url}\n\nTake a look when you get a chance — we're here if you have any questions! (941) 318-7612", variables: JSON.stringify(['first_name','estimate_url']), sort_order: 26 },
      { template_key: 'estimate_followup_viewed', name: 'Estimate Follow-Up — Viewed Not Accepted 48h (hardcoded)', category: 'estimates', body: "Hi {first_name}! I noticed you checked out your Waves estimate — any questions I can answer?\n\n{estimate_url}\n\nI'm happy to walk through it with you. Just reply here or call (941) 318-7612.\n\n— Adam, Waves Pest Control", variables: JSON.stringify(['first_name','estimate_url']), sort_order: 27 },
      { template_key: 'estimate_followup_final', name: 'Estimate Follow-Up — Final Nudge 5d (hardcoded)', category: 'estimates', body: "Hey {first_name} — last check-in from me! Your Waves estimate is still available:\n\n{estimate_url}\n\nWe'd love to earn your business. No pressure at all — just reply if you'd like to move forward or have any questions.\n\n— Adam", variables: JSON.stringify(['first_name','estimate_url']), sort_order: 28 },
      { template_key: 'estimate_followup_expiring', name: 'Estimate Follow-Up — Expiring (hardcoded)', category: 'estimates', body: "Hi {first_name}! Just a heads up — your Waves Pest Control estimate expires on {expires_at}.\n\n{estimate_url}\n\nLet us know if you'd like to move forward! (941) 318-7612", variables: JSON.stringify(['first_name','estimate_url','expires_at']), sort_order: 29 },
      { template_key: 'lead_auto_reply_biz', name: 'Lead Auto-Reply (Business Hours)', category: 'estimates', body: 'Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in: Pest Control, Lawn Care, or a One-Time Service?\n\nReply and we\'ll get you a quote right away.', variables: JSON.stringify(['first_name']), sort_order: 21 },
      { template_key: 'lead_auto_reply_after_hours', name: 'Lead Auto-Reply (After Hours)', category: 'estimates', body: 'Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in — Pest Control, Lawn Care, or a One-Time Service?\n\nWe\'ll follow up first thing in the morning with a custom quote.', variables: JSON.stringify(['first_name']), sort_order: 22 },
      { template_key: 'lead_service_pest', name: 'Lead Reply — Pest Control Selected', category: 'estimates', body: 'Great, {first_name} — putting together a pest control quote now.', variables: JSON.stringify(['first_name']), sort_order: 23 },
      { template_key: 'lead_service_lawn', name: 'Lead Reply — Lawn Care Selected', category: 'estimates', body: 'Great, {first_name} — putting together a lawn care quote now.', variables: JSON.stringify(['first_name']), sort_order: 24 },
      { template_key: 'lead_service_one_time', name: 'Lead Reply — One-Time Service Selected', category: 'estimates', body: 'Got it, {first_name} — one-time service it is. Send me the service address and a quick note on what needs attention, and I\'ll put a quote together.', variables: JSON.stringify(['first_name']), sort_order: 25 },
      { template_key: 'lead_address_needed', name: 'Lead Reply — Still Need Address', category: 'estimates', body: 'Just need the service address to finish your quote, {first_name}.', variables: JSON.stringify(['first_name']), sort_order: 26 },
      { template_key: 'estimate_accepted_onetime', name: 'Estimate Accepted — One-Time Booking', category: 'estimates', body: "Hey {first_name}! Thanks for booking your {service_label} with Waves. Pick your time here — we'll show you slots when a tech will already be in your neighborhood: {booking_url}\n\nQuestions? Just reply. — Waves", variables: JSON.stringify(['first_name','service_label','booking_url']), sort_order: 22 },
      { template_key: 'review_request', name: 'Review Request (hardcoded)', category: 'reviews', body: "Hi {first_name}! How was your service? We'd love your feedback: {review_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!", variables: JSON.stringify(['first_name','review_url']), sort_order: 30 },
      { template_key: 'referral_nudge', name: 'Referral Nudge (hardcoded)', category: 'referrals', body: 'Hi {first_name}! Share your link — they get $25 off, you get $50: {referral_link}', variables: JSON.stringify(['first_name','referral_link']), sort_order: 31 },
      { template_key: 'autopay_pre_charge', name: 'Autopay - Pre-Charge Reminder', category: 'billing', body: 'Hello {first_name}! This is a friendly reminder from Waves that your WaveGuard auto-pay will process on {charge_date}.\n\nNeed to update your card or pause? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','charge_date']), sort_order: 36 },
      { template_key: 'autopay_card_expired', name: 'Autopay - Card Expired', category: 'billing', body: 'Hello {first_name}, your {card_brand} card ending in {last_four} on file with Waves has expired ({exp_date}).\n\nPlease update it in your Waves Customer Portal at portal.wavespestcontrol.com to keep auto-pay active.\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','card_brand','last_four','exp_date']), sort_order: 37 },
      { template_key: 'autopay_card_expiring', name: 'Autopay - Card Expiring Soon', category: 'billing', body: 'Hello {first_name}! Your {card_brand} card ending in {last_four} on file with Waves expires {exp_date}.\n\nPlease update it in your Waves Customer Portal at portal.wavespestcontrol.com to avoid any auto-pay disruption.\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','card_brand','last_four','exp_date']), sort_order: 38 },
      { template_key: 'payment_method_expiry', name: 'Payment Method Expiry Notice', category: 'billing', body: 'Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}.\n\nPlease update your payment method in your Waves Customer Portal at portal.wavespestcontrol.com to avoid any interruption in service.\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','card_brand','last_four','exp_date']), sort_order: 39 },
      { template_key: 'autopay_authorization_request', name: 'Autopay - Authorization Request', category: 'billing', body: 'Hello {first_name}! Waves needs your electronic authorization before we keep a payment method on file for future service payments.\n\nReview and sign here: {contract_url}\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','contract_url']), is_active: false, sort_order: 40 },
      { template_key: 'autopay_authorization_cancelled', name: 'Autopay - Authorization Cancelled', category: 'billing', body: 'Hello {first_name}, your Waves auto-pay authorization has been cancelled as of {cancelled_date}.\n\nYour saved payment method will not be used for future automatic charges. You can still pay invoices in the customer portal: {portal_url}\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','cancelled_date','portal_url']), is_active: false, sort_order: 41 },
      { template_key: 'churn_save_step1', name: 'Churn Save — Step 1', category: 'retention', body: 'Hey {first_name}, this is Adam from Waves. Just checking in — anything we can do better? Reply here.', variables: JSON.stringify(['first_name']), sort_order: 40 },
      { template_key: 'waveguard_upsell', name: 'WaveGuard Plan Recommendation', category: 'retention', body: 'Hello {first_name}! Based on your recent services, our {tier_label} WaveGuard plan may be a better fit with unlimited coverage and predictable billing.\n\nReply INFO to learn more. Questions or requests? Reply to this message.', variables: JSON.stringify(['first_name','tier_label']), sort_order: 47 },
      { template_key: 'renewal_reminder', name: 'Renewal Reminder (hardcoded)', category: 'retention', body: "Hello {first_name}! Your {renewal_label} {urgency}.\n\nDon't let your coverage lapse - reply RENEW or call us to take care of it. Questions or requests? Reply to this message.", variables: JSON.stringify(['first_name','renewal_label','urgency']), sort_order: 48 },
      { template_key: 'seasonal_reactivation', name: 'Seasonal Reactivation (hardcoded)', category: 'retention', body: "Hi {first_name}! {hook_text}. We'd love to get you back on the schedule{address_clause}. Reply YES or call {call_number} to book. - Waves Pest Control", variables: JSON.stringify(['first_name','hook_text','address_clause','call_number']), sort_order: 51 },
      { template_key: 'seasonal_alert', name: 'Seasonal Alert / Tip (hardcoded)', category: 'retention', body: 'Hi {first_name}! {tip}\n\nQuestions? Reply to this text or call (941) 318-7612.', variables: JSON.stringify(['first_name','tip']), sort_order: 50 },
      { template_key: 'auto_renewal_30_60_day_notice', name: 'Auto-Renewal Notice - 30-60 Day', category: 'retention', body: 'Hello {first_name}! Your {service_name} agreement is set to renew on {renewal_date}.\n\nReview the renewal details and cancellation options here: {contract_url}\n\nNeed changes before {cancellation_deadline}? Reply to this message or call (941) 318-7612.', variables: JSON.stringify(['first_name','service_name','renewal_date','contract_url','cancellation_deadline']), is_active: false, sort_order: 49 },
      { template_key: 'reschedule_options_weather', name: 'Reschedule Options - Weather (hardcoded)', category: 'service', body: 'Hello {first_name}, due to weather your {service_type} on {original_date} needs to move.\n\nWe have:\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2, or suggest a day. Questions or requests? Reply to this message.', variables: JSON.stringify(['first_name','service_type','original_date','option_1','option_2']), sort_order: 8 },
      { template_key: 'reschedule_options_access', name: 'Reschedule Options - Access Issue (hardcoded)', category: 'service', body: 'Hello {first_name}, we stopped by for your {service_type} but {access_issue}. We can come back:\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2. Questions or requests? Reply to this message.', variables: JSON.stringify(['first_name','service_type','access_issue','option_1','option_2']), sort_order: 9 },
      { template_key: 'reschedule_options_general', name: 'Reschedule Options - General (hardcoded)', category: 'service', body: 'Hello {first_name}, your {service_type} on {original_date} needs to be rescheduled.{reason_text}\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2. Questions or requests? Reply to this message.', variables: JSON.stringify(['first_name','service_type','original_date','reason_text','option_1','option_2']), sort_order: 10 },
      { template_key: 'reschedule_confirmed_sms_reply', name: 'Reschedule Confirmed - SMS Reply (hardcoded)', category: 'service', body: "Confirmed! Your service is rescheduled for {date}, {time}.\n\nWe'll remind you the day before. Questions or requests? Reply to this message.", variables: JSON.stringify(['date','time']), sort_order: 11 },
      { template_key: 'reschedule_call_requested', name: 'Reschedule - Call Requested Reply (hardcoded)', category: 'service', body: "No problem! We'll give you a call shortly.\n\nQuestions or requests? Reply to this message.", variables: JSON.stringify([]), sort_order: 12 },
      { template_key: 'self_booking_confirmation', name: 'Self-Booking Confirmation (hardcoded)', category: 'service', body: 'Hello {first_name}! Your Waves appointment is confirmed for {date}, {time} at {address}. Confirmation: {confirmation_code}.\n\nNeed to change it? Reply RESCHEDULE. Questions or requests? Reply to this message.', variables: JSON.stringify(['first_name','date','time','address','confirmation_code']), sort_order: 13 },
      { template_key: 'onboarding_welcome', name: 'Onboarding Welcome (hardcoded)', category: 'service', body: 'Welcome to Waves, {first_name}! Your first {service_type} is {service_date}{tech_clause}. Log into your portal anytime: portal.wavespestcontrol.com', variables: JSON.stringify(['first_name','service_type','service_date','tech_clause']), sort_order: 0 },
      { template_key: 'service_reminder_legacy', name: 'Service Reminder Legacy 24h (hardcoded)', category: 'service', body: 'Hi {first_name}! Your {service_type} is scheduled for tomorrow {time_window}.\n\nTechnician: {tech_name}\n\nPlease ensure gates are unlocked and pets are secured. Reply CONFIRM to confirm or call (941) 318-7612 to reschedule.', variables: JSON.stringify(['first_name','service_type','time_window','tech_name']), sort_order: 6 },
      { template_key: 'appointment_series_cancelled', name: 'Appointment Series Cancelled', category: 'service', body: "Hello {first_name}! Your Waves {scope} for {service_type} has been cancelled.\n\nWant to reschedule? Reply to this message and we'll get you back on the calendar.", variables: JSON.stringify(['first_name','scope','service_type']), sort_order: 14 },
      { template_key: 'onboarding_followup_24h', name: 'Onboarding Follow-Up - 24h', category: 'service', body: 'Hello {first_name}! Thanks again for choosing Waves. Just need a few quick details to get you on the schedule: {onboarding_url}\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','onboarding_url']), sort_order: 15 },
      { template_key: 'onboarding_followup_72h', name: 'Onboarding Follow-Up - 72h', category: 'service', body: "Hello {first_name}! Still here whenever you're ready. Wrap up your Waves setup here and we'll confirm your first service: {onboarding_url}\n\nQuestions or requests? Reply to this message.", variables: JSON.stringify(['first_name','onboarding_url']), sort_order: 16 },
      { template_key: 'onboarding_followup_expiring', name: 'Onboarding Follow-Up - Expiring', category: 'service', body: 'Hello {first_name}! Heads up — your Waves onboarding link expires on {expires_at}. Lock in your WaveGuard {waveguard_tier} plan and first service here: {onboarding_url}\n\nQuestions or requests? Reply to this message.', variables: JSON.stringify(['first_name','onboarding_url','expires_at','waveguard_tier']), sort_order: 17 },
      { template_key: 'admin_new_lead', name: 'New Lead Alert', category: 'internal', body: '🔔 New lead! {name} 📞 {phone} 📍 {address} 🌐 {source}', variables: JSON.stringify(['name','phone','address','source']), is_internal: true, sort_order: 60 },
  ];
  for (const t of templates) {
    try { await db('sms_templates').insert(t).onConflict('template_key').ignore(); }
    catch (_) { /* best-effort */ }
  }
}

// GET / — list all templates
router.get('/', async (req, res, next) => {
  try {
    await ensureTable();
    const { category } = req.query;
    let query = db('sms_templates').orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    const templates = await query;
    res.json({ templates });
  } catch (err) { next(err); }
});

// GET /:id — single template
router.get('/:id', async (req, res, next) => {
  try {
    const template = await db('sms_templates').where({ id: req.params.id }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (err) { next(err); }
});

// PUT /:id — update template body
router.put('/:id', async (req, res, next) => {
  try {
    const { body, name, is_active } = req.body;
    const updates = { updated_at: new Date() };
    if (body !== undefined) updates.body = body;
    if (name !== undefined) updates.name = name;
    if (is_active !== undefined) updates.is_active = is_active;
    await db('sms_templates').where({ id: req.params.id }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST / — create new template
router.post('/', async (req, res, next) => {
  try {
    const { template_key, name, category, body, description, variables, is_internal } = req.body;
    if (!template_key || !name || !body) return res.status(400).json({ error: 'template_key, name, and body required' });
    const [template] = await db('sms_templates').insert({
      template_key, name, category: category || 'custom', body,
      description, variables: variables ? JSON.stringify(variables) : null,
      is_internal: is_internal || false,
    }).returning('*');
    res.status(201).json(template);
  } catch (err) { next(err); }
});

// DELETE /:id — delete template
router.delete('/:id', async (req, res, next) => {
  try {
    await db('sms_templates').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /preview — preview a template with sample data
router.post('/preview', async (req, res) => {
  try {
    const { templateId, sampleData } = req.body;
    const template = await db('sms_templates').where({ id: templateId }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    let preview = template.body;
    for (const [key, val] of Object.entries(formatSmsTemplateVars(sampleData || {}))) {
      preview = preview.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    }
    res.json({ preview, originalLength: template.body.length, previewLength: preview.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Map messageType values to template_key values
const MSG_TYPE_TO_TEMPLATE = {
  confirmation: 'appointment_confirmation',
  booking_confirmation: 'appointment_confirmation',
  appointment_reminder: 'reminder_24h',
  appointment_series_cancelled: 'appointment_series_cancelled',
  en_route: 'tech_en_route',
  service_complete: 'service_complete',
  service_complete_prepaid: 'service_complete_prepaid',
  service_complete_with_invoice: 'service_complete_with_invoice',
  missed_call_followup: 'missed_call',
  invoice: 'invoice_sent',
  receipt: 'invoice_receipt',
  invoice_receipt: 'invoice_receipt',
  payment_expiry: 'payment_method_expiry',
  review_request: 'review_request',
  review_followup: 'review_request_followup',
  referral_nudge: 'referral_nudge',
  referral_invite: 'referral_nudge',
  retention: 'churn_save_step1',
  retention_outreach: 'churn_save_step1',
  renewal: 'renewal_reminder',
  upsell: 'waveguard_upsell',
  autopay_pre_charge: 'autopay_pre_charge',
  payment_method_expiry: 'payment_method_expiry',
  lead_response: 'lead_auto_reply_biz',
  auto_reply: 'lead_auto_reply_biz',
  onboarding_followup: 'onboarding_followup_24h',
  onboarding_start: 'estimate_accepted_customer',
  estimate_sent: 'estimate_sent',
  estimate_accepted_onetime: 'estimate_accepted_onetime',
  estimate_accepted_customer: 'estimate_accepted_customer',
  estimate_auto_renewed: 'estimate_auto_renewed',
  estimate_followup: 'estimate_followup_unviewed',
  reactivation: 'churn_save_step1',
};

// ── Template helper for services — check if a template is enabled before sending ──
router.isTemplateActive = async function(messageType) {
  try {
    if (!(await db.schema.hasTable('sms_templates'))) return true;
    const templateKey = MSG_TYPE_TO_TEMPLATE[messageType] || messageType;
    const t = await db('sms_templates').where({ template_key: templateKey }).first();
    if (!t) return true; // template not in DB = active by default
    return t.is_active !== false;
  } catch { return true; }
};

// Get template body by key (returns null if disabled)
router.getTemplate = async function(templateKey, vars = {}) {
  try {
    if (!(await db.schema.hasTable('sms_templates'))) return null;
    const t = await db('sms_templates').where({ template_key: templateKey }).first();
    if (!t || t.is_active === false) return null;
    let body = t.body;
    for (const [key, val] of Object.entries(formatSmsTemplateVars(vars))) {
      body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), val == null ? '' : String(val));
    }
    if (/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(body)) return null;
    return body;
  } catch { return null; }
};

module.exports = router;
