/**
 * Tighten Waves SMS template copy across the admin SMS Templates table.
 *
 * Goals:
 * - Keep every operational template key intact.
 * - Preserve the placeholders each sender depends on.
 * - Remove repeated assistance filler in favor of shorter, consistent replies.
 * - Keep customer-facing copy warm, direct, and visibly from Waves.
 */

const TEMPLATES = [
  // automations
  {
    template_key: 'auto_new_recurring',
    name: 'New Recurring Customer',
    category: 'automations',
    body: 'Hello {first_name}! Welcome to Waves!\n\nYou can also manage your account at portal.wavespestcontrol.com to view your upcoming appointments, reschedule services, request re-services, view invoices, and more.\n\nQuestions or requests? Reply here.',
    variables: ['first_name'],
    sort_order: 40,
  },
  {
    template_key: 'auto_new_appointment',
    name: 'New First-Time Appointment',
    category: 'automations',
    body: 'Hello {first_name}! We just emailed what to expect for your first Waves service.\n\nQuestions or requests? Reply here.',
    variables: ['first_name'],
    sort_order: 42,
  },
  {
    template_key: 'auto_bed_bug',
    name: 'Bed Bug Treatment',
    category: 'automations',
    body: "Hello {first_name}! Let's get your home bed bug-free. We emailed your Waves treatment guide; please review it before service so we can get the best results.\n\nQuestions or requests? Reply here.",
    variables: ['first_name'],
    sort_order: 43,
  },
  {
    template_key: 'auto_cockroach',
    name: 'Cockroach Control',
    category: 'automations',
    body: "Hello {first_name}! Let's get your home cockroach-free. We emailed your Waves treatment guide; please review it before service so we can get the best results.\n\nQuestions or requests? Reply here.",
    variables: ['first_name'],
    sort_order: 44,
  },
  {
    template_key: 'auto_service_renewal',
    name: 'Service Renewal Reminder',
    category: 'automations',
    body: 'Hello {first_name}! Your Waves service is coming up for renewal. We emailed the details - take a look when you can.\n\nQuestions or requests? Reply here.',
    variables: ['first_name'],
    sort_order: 46,
  },

  // billing
  {
    template_key: 'invoice_sent',
    name: 'Invoice Sent (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Your invoice for {service_type} completed on {service_date} is ready: {pay_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'service_type', 'service_date', 'pay_url'],
    sort_order: 10,
  },
  {
    template_key: 'payment_failed',
    name: 'Payment Failed',
    category: 'billing',
    body: 'Hello {first_name}! Your payment for {service_type} completed on {service_date} did not go through. Please update your payment method or pay here: {pay_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'service_type', 'service_date', 'pay_url'],
    sort_order: 11,
  },
  {
    template_key: 'late_payment_7d',
    name: 'Late Payment — 7 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Your Waves invoice for {invoice_title}{service_date_clause} is 7 days overdue. Please pay here: {pay_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 12,
  },
  {
    template_key: 'late_payment_14d',
    name: 'Late Payment — 14 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Your Waves invoice for {invoice_title}{service_date_clause} is 14 days overdue. Please pay as soon as possible: {pay_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 13,
  },
  {
    template_key: 'late_payment_30d',
    name: 'Late Payment — 30 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Final reminder: your Waves invoice for {invoice_title}{service_date_clause} is 30 days overdue. Please pay now: {pay_url}\n\nNeed a payment plan? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 14,
  },
  {
    template_key: 'late_payment_60d',
    name: 'Late Payment — 60 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Your Waves invoice for {invoice_title}{service_date_clause} is 60 days overdue. Please pay or contact us today to avoid further action: {pay_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 15,
  },
  {
    template_key: 'late_payment_90d',
    name: 'Late Payment — 90 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Final notice: your Waves invoice for {invoice_title}{service_date_clause} is 90 days overdue and may be sent to collections. Please pay today: {pay_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 16,
  },
  {
    template_key: 'invoice_receipt',
    name: 'Payment Receipt (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Payment received - thank you. Invoice {invoice_number}: ${amount}{card_line}. Receipt: {receipt_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'invoice_number', 'amount', 'card_line', 'receipt_url'],
    sort_order: 17,
  },
  {
    template_key: 'billing_reminder',
    name: 'Billing Reminder (WaveGuard Monthly)',
    category: 'billing',
    body: 'Hello {first_name}! Your {waveguard_tier} WaveGuard monthly charge of ${amount} will be processed on {charge_date}.\n\nManage your payment method in the customer portal or call (941) 297-5749.',
    variables: ['first_name', 'waveguard_tier', 'amount', 'charge_date'],
    sort_order: 18,
  },
  {
    template_key: 'invoice_followup_3day',
    name: 'Invoice — 3-Day Friendly Nudge (hardcoded)',
    category: 'billing',
    body: "Hello {first_name}! Your invoice for {invoice_title} still has an open balance of ${amount}. Pay securely here: {pay_url}\n\nIf something looks off, reply and we'll sort it.",
    variables: ['first_name', 'invoice_title', 'amount', 'pay_url'],
    sort_order: 19,
  },
  {
    template_key: 'autopay_charge_success',
    name: 'Autopay — Charge Success',
    category: 'billing',
    body: 'Hello {first_name}! Your WaveGuard monthly payment of ${amount} was processed. Thank you!{receipt_line}',
    variables: ['first_name', 'amount', 'receipt_line'],
    sort_order: 20,
  },
  {
    template_key: 'invoice_followup_7day',
    name: 'Invoice Follow-Up — 7 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Quick reminder: your Waves invoice for {invoice_title}{service_date_clause} is still open. Pay here: {pay_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 21,
  },
  {
    template_key: 'invoice_followup_14day',
    name: 'Invoice Follow-Up — 14 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Checking in on your Waves invoice for {invoice_title}{service_date_clause}. Please pay when you can: {pay_url}\n\nNeed help? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 22,
  },
  {
    template_key: 'autopay_charge_failed',
    name: 'Autopay — First Failure',
    category: 'billing',
    body: "Hello {first_name}! Your WaveGuard monthly payment of ${amount} could not be processed. We'll retry in a few days. Update your card here: {update_card_url}\n\nQuestions or requests? Reply here or call (941) 297-5749.",
    variables: ['first_name', 'amount', 'update_card_url'],
    sort_order: 23,
  },
  {
    template_key: 'autopay_retry_success',
    name: 'Autopay — Retry Success',
    category: 'billing',
    body: 'Hello {first_name}! Your payment of ${amount} went through. Thank you for being a Waves customer!{receipt_line}',
    variables: ['first_name', 'amount', 'receipt_line'],
    sort_order: 24,
  },
  {
    template_key: 'invoice_followup_30day',
    name: 'Invoice Follow-Up — 30 Day (hardcoded)',
    category: 'billing',
    body: 'Hello {first_name}! Final notice on your Waves invoice for {invoice_title}{service_date_clause}. Please pay now to keep the account in good standing: {pay_url}\n\nNeed a payment plan? Reply here.',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 25,
  },
  {
    template_key: 'autopay_retry_failed',
    name: 'Autopay — Retry Failed',
    category: 'billing',
    body: "Hello {first_name}! Your payment of ${amount} still did not go through. We'll try again in a few days, or you can update your card here: {update_card_url}\n\nQuestions or requests? Reply here or call (941) 297-5749.",
    variables: ['first_name', 'amount', 'update_card_url'],
    sort_order: 26,
  },
  {
    template_key: 'autopay_retry_final_failed',
    name: 'Autopay — Final Failure (all retries exhausted)',
    category: 'billing',
    body: "Hello {first_name}! After several attempts we still could not process your payment of ${amount}. Please update your card to keep service active: {update_card_url}\n\nQuestions or requests? Reply here or call (941) 297-5749.",
    variables: ['first_name', 'amount', 'update_card_url'],
    sort_order: 27,
  },
  {
    template_key: 'autopay_pre_charge',
    name: 'Autopay - Pre-Charge Reminder',
    category: 'billing',
    body: 'Hello {first_name}! Your WaveGuard auto-pay will process on {charge_date}.\n\nNeed to update your card or pause? Visit portal.wavespestcontrol.com or reply here.',
    variables: ['first_name', 'charge_date'],
    sort_order: 36,
  },
  {
    template_key: 'autopay_card_expired',
    name: 'Autopay - Card Expired',
    category: 'billing',
    body: 'Hello {first_name}! Your {card_brand} card ending in {last_four} expired {exp_date}. Please update it in the portal to keep auto-pay active: portal.wavespestcontrol.com\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'card_brand', 'last_four', 'exp_date'],
    sort_order: 37,
  },
  {
    template_key: 'autopay_card_expiring',
    name: 'Autopay - Card Expiring Soon',
    category: 'billing',
    body: 'Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Please update it in the portal to avoid auto-pay disruption: portal.wavespestcontrol.com\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'card_brand', 'last_four', 'exp_date'],
    sort_order: 38,
  },
  {
    template_key: 'payment_method_expiry',
    name: 'Payment Method Expiry Notice',
    category: 'billing',
    body: 'Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Update your payment method to avoid service interruption: portal.wavespestcontrol.com\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'card_brand', 'last_four', 'exp_date'],
    sort_order: 39,
  },
  {
    template_key: 'manual_payment_receipt',
    name: 'Manual Payment Receipt',
    category: 'billing',
    body: 'Hello {first_name}! Your payment to Waves was processed. Thank you!{receipt_line}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'receipt_line'],
    sort_order: 42,
  },
  {
    template_key: 'balance_reminder_gentle',
    name: 'Balance Reminder - Before Service',
    category: 'billing',
    body: "Hello {first_name}! Waves here. We're scheduled to see you on {service_date}.\n\nOur records show an outstanding balance. To avoid any service interruption, please take care of it before your appointment: {pay_url}\n\nQuestions or requests? Reply here.",
    variables: ['first_name', 'service_date', 'pay_url'],
    sort_order: 43,
  },
  {
    template_key: 'balance_reminder_firm',
    name: 'Balance Reminder - Upcoming Service',
    category: 'billing',
    body: "Hello {first_name}! Quick reminder from Waves: your {service_type} is {service_timing} and there is an outstanding balance.\n\nPlease take care of it so we can keep you on schedule: {pay_url}\n\nQuestions or requests? Reply here.",
    variables: ['first_name', 'service_type', 'service_timing', 'pay_url'],
    sort_order: 44,
  },
  {
    template_key: 'balance_reminder_urgent',
    name: 'Balance Reminder - Urgent Service Hold',
    category: 'billing',
    body: 'Hello {first_name}! Your Waves service is {service_timing} and your account has an outstanding balance.\n\nPay now to keep your appointment: {pay_url}\n\nAlready paid? Reply here and we will check it.',
    variables: ['first_name', 'service_timing', 'pay_url'],
    sort_order: 45,
  },
  {
    template_key: 'balance_payment_received',
    name: 'Balance Payment Received',
    category: 'billing',
    body: 'Hello {first_name}! Got it - thank you for the payment. Your account is caught up. We will see you at your next service.',
    variables: ['first_name'],
    sort_order: 46,
  },
  {
    template_key: 'ach_retry_notice',
    name: 'ACH Failure - Retry Notice',
    category: 'billing',
    body: 'Hello {first_name}! Your bank payment did not go through. We will retry automatically in 3 business days. No action is needed right now.\n\nQuestions or requests? Reply here.',
    variables: ['first_name'],
    sort_order: 47,
  },
  {
    template_key: 'ach_card_fallback',
    name: 'ACH Failure - Card Fallback',
    category: 'billing',
    body: 'Hello {first_name}! Your bank payment failed again, so we switched this payment to your card on file. Card payments include a processing fee. You can switch back to bank payment once your account is verified.\n\nQuestions or requests? Reply here.',
    variables: ['first_name'],
    sort_order: 48,
  },
  {
    template_key: 'ach_suspended',
    name: 'ACH Failure - Bank Payment Suspended',
    category: 'billing',
    body: 'Hello {first_name}! Your bank payment failed again. We updated your default payment to your card. Card payments include a processing fee.\n\nTo pay by bank with no added fee, update your bank account here: {billing_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'billing_url'],
    sort_order: 49,
  },
  {
    template_key: 'bank_verification_incomplete',
    name: 'Bank Verification Incomplete',
    category: 'billing',
    body: 'Hello {first_name}! Your bank account verification is incomplete. Please finish setup here to complete your payment: {billing_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'billing_url'],
    sort_order: 50,
  },
  {
    template_key: 'bank_verification_failed',
    name: 'Bank Verification Failed',
    category: 'billing',
    body: 'Hello {first_name}! We could not verify your bank account. Please try again or use a card here: {billing_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'billing_url'],
    sort_order: 51,
  },

  // estimates
  {
    template_key: 'estimate_sent',
    name: 'Estimate Sent',
    category: 'estimates',
    body: 'Hello {first_name}! Your Waves estimate is ready: {estimate_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'estimate_url'],
    sort_order: 20,
  },
  {
    template_key: 'lead_auto_reply_biz',
    name: 'Lead Auto-Reply (Business Hours)',
    category: 'estimates',
    body: "Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in: Pest Control, Lawn Care, or a One-Time Service?\n\nReply and we'll get you a quote.",
    variables: ['first_name'],
    sort_order: 21,
  },
  {
    template_key: 'estimate_followup_unviewed',
    name: 'Estimate Follow-Up — Unviewed (24h) (hardcoded)',
    category: 'estimates',
    body: 'Hello {first_name}! Just making sure you saw your Waves estimate: {estimate_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'estimate_url'],
    sort_order: 22,
  },
  {
    template_key: 'estimate_accepted_onetime',
    name: 'Estimate Accepted — One-Time Booking',
    category: 'estimates',
    body: 'Hello {first_name}! Thanks for booking your {service_label} with Waves. Choose a time here: {booking_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'service_label', 'booking_url'],
    sort_order: 24,
  },
  {
    template_key: 'estimate_followup_viewed',
    name: 'Estimate Follow-Up — Viewed Not Accepted (48h) (hardcoded)',
    category: 'estimates',
    body: "Hello {first_name}! Saw you opened your Waves estimate. Any questions we can answer? {estimate_url}\n\nReply here and we'll help.",
    variables: ['first_name', 'estimate_url'],
    sort_order: 26,
  },
  {
    template_key: 'estimate_followup_final',
    name: 'Estimate Follow-Up — Final Nudge (5d) (hardcoded)',
    category: 'estimates',
    body: 'Hello {first_name}! One last check-in. Your Waves estimate is still available: {estimate_url}\n\nNo pressure - reply here if you have questions.',
    variables: ['first_name', 'estimate_url'],
    sort_order: 28,
  },
  {
    template_key: 'estimate_followup_expiring',
    name: 'Estimate Follow-Up — Expiring (hardcoded)',
    category: 'estimates',
    body: "Hello {first_name}! Heads up: your Waves estimate expires on {expires_at}. {estimate_url}\n\nReply here if you'd like to move forward.",
    variables: ['first_name', 'estimate_url', 'expires_at'],
    sort_order: 29,
  },
  {
    template_key: 'estimate_accepted_annual_prepay',
    name: 'Estimate Accepted — Annual Prepay',
    category: 'estimates',
    body: 'Hello {first_name}! Your {waveguard_tier} WaveGuard plan is approved. Our team will review and send your annual prepay invoice{amount_text}.\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'waveguard_tier', 'amount_text'],
    sort_order: 34,
  },
  {
    template_key: 'estimate_extended',
    name: 'Estimate Extended',
    category: 'estimates',
    body: 'Hello {first_name}! We extended your Waves estimate through {new_expiry} so you have more time to review it: {estimate_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'estimate_url', 'new_expiry'],
    sort_order: 35,
  },

  // referrals
  {
    template_key: 'referral_nudge',
    name: 'Referral Nudge (hardcoded)',
    category: 'referrals',
    body: 'Hello {first_name}! Share your Waves referral link. They get $25 off, you get $25: {referral_link}',
    variables: ['first_name', 'referral_link'],
    sort_order: 31,
  },
  {
    template_key: 'referral_enrollment',
    name: 'Referral Program Enrollment',
    category: 'referrals',
    body: "Hello {first_name}! You're enrolled in the Waves Referral Program. Share your link and earn a reward for every new customer: {referral_link}",
    variables: ['first_name', 'referral_link'],
    sort_order: 32,
  },
  {
    template_key: 'referral_invite',
    name: 'Referral Invite',
    category: 'referrals',
    body: "Hello {referee_name}! {referrer_name} thinks you'd love Waves Pest Control. Get a free quote here: {referral_link}\n\nQuestions? Call (941) 297-5749.",
    variables: ['referee_name', 'referrer_name', 'referral_link'],
    sort_order: 33,
  },
  {
    template_key: 'referral_reward',
    name: 'Referral Reward Earned',
    category: 'referrals',
    body: 'Great news, {referrer_name}! Your referral {referee_name} signed up with Waves. You earned {reward_amount}. Thank you for sharing Waves!',
    variables: ['referrer_name', 'referee_name', 'reward_amount'],
    sort_order: 34,
  },
  {
    template_key: 'referral_milestone',
    name: 'Referral Milestone',
    category: 'referrals',
    body: 'Congrats {referrer_name}! You reached {milestone_level} with {count} referrals and earned {bonus_amount}. Thanks for helping Waves grow.',
    variables: ['referrer_name', 'milestone_level', 'count', 'bonus_amount'],
    sort_order: 35,
  },

  // retention
  // health_* outreach texts and waveguard_upsell removed by
  // 20260706000010_sms_template_cleanup.js — health alerts stay admin-facing
  // (call actions only) and the post-service upsell workflow is retired.
  {
    template_key: 'renewal_reminder',
    name: 'Renewal Reminder (hardcoded)',
    category: 'retention',
    body: 'Hello {first_name}! Your {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active. Questions or requests? Reply here.',
    variables: ['first_name', 'renewal_label', 'urgency'],
    sort_order: 48,
  },
  {
    template_key: 'annual_prepay_renewal_reminder',
    name: 'Annual Prepay Renewal Reminder',
    category: 'retention',
    body: 'Hello {first_name}! Your annual prepaid Waves plan renews on {term_end}.{last_service_sentence}\n\nReply RENEW, LAPSE, or CHANGE and our team will help.',
    variables: ['first_name', 'term_end', 'last_service_sentence'],
    sort_order: 50,
  },
  // seasonal_alert removed by 20260706000010_sms_template_cleanup.js
  // (seasonal_reactivation below is a separate, retained flow).
  {
    template_key: 'seasonal_reactivation',
    name: 'Seasonal Reactivation (hardcoded)',
    category: 'retention',
    body: "Hello {first_name}! {hook_text}. We'd love to get you back on the schedule{address_clause}. Reply YES or call {call_number} to book. - Waves",
    variables: ['first_name', 'hook_text', 'address_clause', 'call_number'],
    sort_order: 52,
  },
  {
    template_key: 'upsell_interest_confirmation',
    name: 'Upsell Interest Confirmation',
    category: 'retention',
    body: 'Hello {first_name}! Thanks for your interest in {service_name}. Waves will follow up within 24 hours to get you set up. Your {new_tier} WaveGuard discount will apply automatically.\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'service_name', 'new_tier'],
    sort_order: 53,
  },
  {
    template_key: 'upsell_tier_upgrade',
    name: 'Upsell - Tier Upgrade',
    category: 'retention',
    body: 'Hello {first_name}! Adam from Waves here. Upgrading to WaveGuard {next_tier} can add more coverage and service savings. Want me to run the numbers? Reply YES and I will send a breakdown.',
    variables: ['first_name', 'next_tier'],
    sort_order: 54,
  },
  {
    template_key: 'upsell_add_service',
    name: 'Upsell - Add Service',
    category: 'retention',
    body: 'Hello {first_name}! Adam from Waves here. Since you are already a WaveGuard member, we can add {service_name} to your plan with bundled service savings. Want details? Reply YES.',
    variables: ['first_name', 'service_name'],
    sort_order: 55,
  },
  {
    template_key: 'cancellation_save_step1_price',
    name: 'Cancellation Save - Price Step 1',
    category: 'retention',
    body: "Hello {first_name}. We understand budgets matter. We've been proud to help protect your home and do not want to lose you. We'll follow up with options shortly.",
    variables: ['first_name'],
    sort_order: 56,
  },
  {
    template_key: 'cancellation_save_step1_moving',
    name: 'Cancellation Save - Moving Step 1',
    category: 'retention',
    body: "Hello {first_name}. Moving is a lot to manage. We've been proud to help protect your home and will follow up with transfer options shortly.",
    variables: ['first_name'],
    sort_order: 57,
  },
  {
    template_key: 'cancellation_save_step1_quality',
    name: 'Cancellation Save - Quality Step 1',
    category: 'retention',
    body: "Hello {first_name}. We're sorry service has not met expectations. Your satisfaction matters to us, and we will follow up with options to make this right.",
    variables: ['first_name'],
    sort_order: 58,
  },
  {
    template_key: 'cancellation_save_step1_default',
    name: 'Cancellation Save - General Step 1',
    category: 'retention',
    body: "Hello {first_name}. We're sorry to hear you are thinking about leaving Waves. We will follow up with options shortly.",
    variables: ['first_name'],
    sort_order: 59,
  },
  {
    template_key: 'cancellation_save_step2_price',
    name: 'Cancellation Save - Price Step 2',
    category: 'retention',
    body: 'Hello {first_name}. We can review lower-cost Waves plan options while keeping core coverage in place. Reply 1 to switch plans, 2 to discuss options, or CANCEL to proceed.',
    variables: ['first_name'],
    sort_order: 60,
  },
  {
    template_key: 'cancellation_save_step2_moving',
    name: 'Cancellation Save - Moving Step 2',
    category: 'retention',
    body: "Hello {first_name}. Waves serves most of SW Florida. Reply 1 if you'd like us to transfer service to your new address, 2 to talk it through, or CANCEL to proceed.",
    variables: ['first_name'],
    sort_order: 61,
  },
  {
    template_key: 'cancellation_save_step2_quality',
    name: 'Cancellation Save - Quality Step 2',
    category: 'retention',
    body: "Hello {first_name}. We'd like a chance to make this right. Reply 1 to schedule a free callback with our service manager, 2 to discuss options, or CANCEL to proceed.",
    variables: ['first_name'],
    sort_order: 62,
  },
  {
    template_key: 'cancellation_save_step2_default',
    name: 'Cancellation Save - General Step 2',
    category: 'retention',
    body: "Hello {first_name}. We'd like to find a way to keep earning your business. Reply 1 for a retention offer, 2 to talk with our team, or CANCEL to proceed.",
    variables: ['first_name'],
    sort_order: 63,
  },
  {
    template_key: 'cancellation_save_step3',
    name: 'Cancellation Save - Step 3',
    category: 'retention',
    body: "Hello {first_name}. The door is always open. If you ever want to come back to Waves, we'll waive the setup fee and get you protected right away.",
    variables: ['first_name'],
    sort_order: 64,
  },
  {
    template_key: 'cancellation_save_accepted_offer',
    name: 'Cancellation Save - Offer Accepted',
    category: 'retention',
    body: "Great, {first_name}. We're glad you're staying with Waves. Someone from our team will reach out within 24 hours to get you set up.",
    variables: ['first_name'],
    sort_order: 65,
  },
  {
    template_key: 'cancellation_save_callback_requested',
    name: 'Cancellation Save - Callback Requested',
    category: 'retention',
    body: "Thanks {first_name}. We'll have someone from Waves call you within a few hours.",
    variables: ['first_name'],
    sort_order: 66,
  },
  {
    template_key: 'cancellation_save_cancelled',
    name: 'Cancellation Save - Cancelled',
    category: 'retention',
    body: "We're sorry to see you go, {first_name}. Your Waves service has been cancelled. The door is always open if you need us again.",
    variables: ['first_name'],
    sort_order: 67,
  },

  // reviews
  {
    template_key: 'review_request',
    name: 'Review Request (hardcoded)',
    category: 'reviews',
    body: "Hello {first_name}! How was your Waves service? We'd love your feedback: {review_url}\n\nQuestions or requests? Reply here.",
    variables: ['first_name', 'review_url'],
    sort_order: 30,
  },
  {
    template_key: 'review_request_followup',
    name: 'Review Request — 48h Non-Responder',
    category: 'reviews',
    body: 'No pressure, {first_name}. If you have a minute, your review helps other SWFL families find a pest company they can trust: {google_review_url}',
    variables: ['first_name', 'google_review_url'],
    sort_order: 31,
  },

  // sales
  // estimate_auto_renewed removed by 20260706000010_sms_template_cleanup.js —
  // estimates still auto-extend silently; the customer text is retired.

  // service
  {
    template_key: 'appointment_confirmation',
    name: 'Appointment Confirmation',
    category: 'service',
    body: 'Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\nQuestions or need to reschedule? Reply here.',
    variables: ['first_name', 'service_type', 'date', 'time'],
    sort_order: 1,
  },
  {
    template_key: 'reminder_72h',
    name: '72-Hour Reminder',
    category: 'service',
    body: 'Hello {first_name}! Reminder: your {service_type} with Waves is scheduled for {day} at {time}. Your technician will arrive within a two-hour window of the start time.\n\nNeed to reschedule? Visit portal.wavespestcontrol.com or reply here.',
    variables: ['first_name', 'service_type', 'day', 'time'],
    sort_order: 2,
  },
  {
    template_key: 'tech_en_route',
    name: 'Tech En Route (hardcoded)',
    category: 'service',
    body: 'Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}Questions or requests? Reply here. Reply STOP to opt out.',
    variables: ['first_name', 'tech_name', 'eta_line', 'track_clause'],
    sort_order: 3,
  },
  {
    template_key: 'tech_arrived',
    name: 'Tech Arrived (hardcoded)',
    category: 'service',
    body: 'Hello {first_name}! {tech_name} has arrived and is servicing your property.\n\nQuestions or requests? Reply here. Reply STOP to opt out.',
    variables: ['first_name', 'tech_name'],
    sort_order: 4,
  },
  {
    template_key: 'reminder_24h',
    name: '24-Hour Reminder',
    category: 'service',
    body: 'Hello {first_name}! Reminder: your {service_type} with Waves is tomorrow at {time}. Your technician will arrive within a two-hour window and text when 15 minutes out.\n\nQuestions or need to reschedule? Reply here.',
    variables: ['first_name', 'service_type', 'time'],
    sort_order: 5,
  },
  {
    template_key: 'service_complete_with_invoice',
    name: 'Service Complete + Invoice',
    category: 'service',
    body: "Hello {first_name}! Your {service_type} service report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply here.",
    variables: ['first_name', 'service_type', 'portal_url', 'pay_url'],
    sort_order: 6,
  },
  {
    template_key: 'service_complete',
    name: 'Service Complete (hardcoded)',
    category: 'service',
    body: 'Hello {first_name}! Your service report is ready: {portal_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'portal_url'],
    sort_order: 7,
  },
  {
    template_key: 'service_complete_prepaid',
    name: 'Service Complete + Paid',
    category: 'service',
    body: 'Hello {first_name}! Thanks for your payment today. Your {service_type} service report is ready: {portal_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'service_type', 'portal_url'],
    sort_order: 8,
  },
  // service_complete_concise removed by 20260706000010_sms_template_cleanup.js —
  // the completion-text overflow swap is retired.
  // appointment_call_confirmed removed by 20260706000010_sms_template_cleanup.js —
  // call bookings confirm through the shared appointment_confirmation template.
  {
    template_key: 'appointment_rescheduled',
    name: 'Appointment Rescheduled',
    category: 'service',
    body: 'Hello {first_name}! Your {service_type} with Waves has been rescheduled to {day}, {date} at {time}.\n\nNeed to change it again? Visit portal.wavespestcontrol.com or reply here.',
    variables: ['first_name', 'service_type', 'day', 'date', 'time'],
    sort_order: 11,
  },
  {
    template_key: 'appointment_cancelled',
    name: 'Appointment Cancelled',
    category: 'service',
    body: "Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\nWant to reschedule? Reply here and we'll get you back on the calendar.",
    variables: ['first_name', 'service_type', 'day', 'date'],
    sort_order: 12,
  },
  {
    template_key: 'missed_call',
    name: 'Missed Call Follow-Up',
    category: 'service',
    body: 'Hello {first_name}! Waves here. Sorry we missed your call. How can we help?',
    variables: ['first_name'],
    sort_order: 13,
  },
  {
    template_key: 'reschedule_options_weather',
    name: 'Reschedule Options - Weather (hardcoded)',
    category: 'service',
    body: 'Hello {first_name}! Weather means your {service_type} on {original_date} needs to move.\n\nOptions:\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2, or suggest another day.',
    variables: ['first_name', 'service_type', 'original_date', 'option_1', 'option_2'],
    sort_order: 14,
  },
  {
    template_key: 'reschedule_options_access',
    name: 'Reschedule Options - Access Issue (hardcoded)',
    category: 'service',
    body: 'Hello {first_name}! We stopped by for your {service_type}, but {access_issue}. We can come back:\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2.',
    variables: ['first_name', 'service_type', 'access_issue', 'option_1', 'option_2'],
    sort_order: 15,
  },
  {
    template_key: 'reschedule_options_general',
    name: 'Reschedule Options - General (hardcoded)',
    category: 'service',
    body: 'Hello {first_name}! Your {service_type} on {original_date} needs to be rescheduled.{reason_text}\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2.',
    variables: ['first_name', 'service_type', 'original_date', 'reason_text', 'option_1', 'option_2'],
    sort_order: 16,
  },
  {
    template_key: 'self_booking_confirmation',
    name: 'Self-Booking Confirmation (hardcoded)',
    category: 'service',
    body: 'Hello {first_name}! Your Waves appointment is confirmed for {date}, {time} at {address}. Confirmation: {confirmation_code}.\n\nNeed to change it? Reply RESCHEDULE.',
    variables: ['first_name', 'date', 'time', 'address', 'confirmation_code'],
    sort_order: 19,
  },
  {
    template_key: 'appointment_series_rescheduled',
    name: 'Appointment Series Rescheduled',
    category: 'service',
    body: "Hello {first_name}! Your recurring Waves appointments have been rescheduled starting {start_date}{window_text}.\n\nWe'll remind you before each visit. Questions or requests? Reply here.",
    variables: ['first_name', 'start_date', 'window_text'],
    sort_order: 20,
  },
  {
    template_key: 'appointment_series_cancelled',
    name: 'Appointment Series Cancelled',
    category: 'service',
    body: "Hello {first_name}! Your Waves {scope} for {service_type} has been cancelled.\n\nWant to reschedule? Reply here and we'll get you back on the calendar.",
    variables: ['first_name', 'scope', 'service_type'],
    sort_order: 21,
  },
  {
    template_key: 'service_report_v1',
    name: 'Service Report V1',
    category: 'service',
    body: 'Hello {first_name}! Your Waves service report is ready: {report_url}{reentry_line}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'report_url', 'reentry_line'],
    sort_order: 25,
  },
  {
    template_key: 'service_report_v1_with_invoice',
    name: 'Service Report V1 + Invoice',
    category: 'service',
    body: "Hello {first_name}! Your Waves service report is ready: {report_url}{reentry_line}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply here.",
    variables: ['first_name', 'report_url', 'reentry_line', 'pay_url'],
    sort_order: 26,
  },
  {
    template_key: 'project_report_ready',
    name: 'Project Report Ready',
    category: 'service',
    body: 'Hello {first_name}! Your Waves {project_type} report is ready: {report_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'project_type', 'report_url'],
    sort_order: 27,
  },
  {
    template_key: 'service_request_confirmation',
    name: 'Service Request Confirmation',
    category: 'service',
    body: "Hello {first_name}! We received your {category} request. Our team will review it within {response_time}. We'll text you when it has been assigned to a technician.\n\nTrack progress in your customer portal or reply here.",
    variables: ['first_name', 'category', 'response_time'],
    sort_order: 30,
  },
  {
    template_key: 'lawn_health_report_ready',
    name: 'Lawn Health Report Ready',
    category: 'service',
    body: 'Hello {first_name}! Your lawn health report is ready - you scored {overall_score}/100{delta_line}.{tip_line}\n\nView full report: {portal_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'overall_score', 'delta_line', 'tip_line', 'portal_url'],
    sort_order: 31,
  },
];

exports.TEMPLATES = TEMPLATES;

function tableRow(cols, template, now) {
  const row = {
    template_key: template.template_key,
    name: template.name,
    category: template.category,
    body: template.body,
    variables: JSON.stringify(template.variables),
    sort_order: template.sort_order,
  };

  if (cols.is_active && template.is_active !== undefined) row.is_active = template.is_active;
  if (cols.is_internal && template.is_internal !== undefined) row.is_internal = template.is_internal;
  if (cols.updated_at) row.updated_at = now;

  return row;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();

  for (const template of TEMPLATES) {
    const row = tableRow(cols, template, now);
    const existing = await knex('sms_templates')
      .where({ template_key: template.template_key })
      .first();

    if (existing) {
      await knex('sms_templates')
        .where({ template_key: template.template_key })
        .update(row);
      continue;
    }

    await knex('sms_templates').insert({
      ...row,
      ...(cols.is_active && template.is_active === undefined ? { is_active: true } : {}),
      ...(cols.is_internal && template.is_internal === undefined ? { is_internal: false } : {}),
      ...(cols.created_at ? { created_at: now } : {}),
    });
  }
};

exports.down = async function down() {
  // Copy-only migration. Rolling back would restore more verbose messages.
};
