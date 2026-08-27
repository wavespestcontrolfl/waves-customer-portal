/**
 * Notification Triggers — central dispatcher for admin-side notification events.
 *
 * Existing routes/services call `triggerNotification(triggerKey, payload)` when
 * something happens. This module:
 *   1. Loads each admin user's per-trigger preferences
 *   2. Persists a bell entry via NotificationService (if bell_enabled)
 *   3. Pushes a Web Push notification via PushNotificationService (if push_enabled)
 *
 * Adding a new trigger:
 *   1. Add to TRIGGER_REGISTRY below (key, label, category, priority, build())
 *   2. Add to the seed list in the notification_preferences migration
 *   3. Call `triggerNotification('your_key', { ... })` from the route that fires it
 */
const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const PushService = require('./push-notifications');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { stripEmoji } = require('../utils/strip-emoji');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Lookarounds keep the match from starting or ending inside a longer
// alphanumeric token: without them, a 10-digit run inside a hex digest or an
// ID like a dedupe key ("twilio:a1234567890bcdef") was masked as a phone
// number — which corrupted stored dedupe keys ~3% of the time. A real phone
// number embedded in prose is bounded by spaces/punctuation and still
// matches, and a conventional extension suffix ("x123", "ext 99",
// "extension 4") is consumed as part of the phone so the trailing lookahead
// doesn't mistake it for an identifier tail.
// Group 1 isolates the phone itself so the masked suffix ("***1234") is
// derived from the phone's last four digits, never the extension's.
const PHONE_CANDIDATE_RE = /(?<![A-Za-z0-9])(\+?\d[\d\s().-]{6,}\d)(?:\s*(?:extension|ext\.?|x)\s*\d{1,6})?(?![A-Za-z0-9])/gi;
// URL-encoded E.164 ("phone=%2B19415551212") starts its digit run right after
// the alphanumeric "B", which the identifier lookbehind above would skip —
// handle the encoded form first, before the boundary logic runs.
const URL_ENCODED_PHONE_RE = /%2B(\d{7,15})(?![A-Za-z0-9])/gi;
const STREET_ADDRESS_RE = /\b\d{1,6}\s+[A-Za-z0-9 .'-]+?\s(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Circle|Cir|Boulevard|Blvd|Trail|Trl|Terrace|Ter|Place|Pl|Parkway|Pkwy|Way)\b/gi;
const SENSITIVE_TEXT_KEY_RE = /(message|body|note|reason|summary|text|description|title)/i;

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return 'unknown';
  return `***${digits.slice(-4)}`;
}

function maskEmail(value) {
  const text = String(value || '').trim();
  const [local, domain] = text.split('@');
  if (!local || !domain) return '[email]';
  return `${local.slice(0, 1)}***@${domain.toLowerCase()}`;
}

function redactPhoneCandidate(match, phonePart) {
  const digits = String(phonePart || '').replace(/\D/g, '');
  return digits.length >= 10 ? maskPhone(phonePart) : match;
}

function redactSensitiveText(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(EMAIL_RE, (match) => maskEmail(match))
    .replace(STREET_ADDRESS_RE, '[address]')
    .replace(URL_ENCODED_PHONE_RE, (match, digits) => maskPhone(digits))
    .replace(PHONE_CANDIDATE_RE, redactPhoneCandidate);
}

function sanitizeNotificationValue(value, key = '') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeNotificationValue(item, key));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeNotificationValue(entryValue, entryKey),
      ])
    );
  }
  if (typeof value !== 'string') return value;

  if (/phone/i.test(key)) return maskPhone(value);
  if (/email/i.test(key)) return maskEmail(value);
  if (/address/i.test(key)) return '[address]';
  if (SENSITIVE_TEXT_KEY_RE.test(key)) return redactSensitiveText(value).slice(0, 1500);
  return redactSensitiveText(value);
}

function sanitizeNotificationPayload(triggerKey, payload = {}) {
  if (TRIGGER_REGISTRY[triggerKey]?.allowContactDetails) return payload;
  return sanitizeNotificationValue(payload);
}

// Emoji strip (owner ruling 2026-07-30, see utils/strip-emoji.js) applies
// here too: this `built` object also feeds the Web Push payload, which never
// passes through NotificationService.create.
function sanitizeBuiltNotification(built = {}, trigger = {}) {
  const cleanTitle = (value) => stripEmoji(String(value || 'Notification')) || String(value || 'Notification');
  const cleanBody = (value) => (value === null || value === undefined ? value : stripEmoji(value));
  if (trigger.allowContactDetails) {
    return { ...built, title: cleanTitle(built.title), body: cleanBody(built.body) };
  }
  return {
    ...built,
    title: cleanTitle(redactSensitiveText(built.title || 'Notification')),
    body: built.body === null || built.body === undefined ? built.body : cleanBody(redactSensitiveText(built.body)),
  };
}

// priority: 'urgent' (red, double vibrate), 'high' (amber), 'normal' (teal), 'low' (gray)
const TRIGGER_REGISTRY = {
  // Fired by server/services/property-lookup-canary.js when a golden parcel
  // stops parsing — a county PAO layout change silently degrading estimator
  // accuracy until fixed.
  property_lookup_canary_failed: {
    label: 'Property-lookup parser canary failed',
    category: 'system',
    priority: 'high',
    group: 'Alerts',
    build: (p) => {
      const failures = Array.isArray(p.failures) ? p.failures : [];
      return {
        title: 'Estimator data canary: county parser regression',
        body: `${failures.length} check(s) failing — ${failures.slice(0, 3).join('; ')}`.slice(0, 220),
        link: '/admin/estimates',
      };
    },
  },
  new_lead: {
    label: 'New lead submitted',
    category: 'new_lead',
    priority: 'high',
    group: 'Leads & Sales',
    // Owner-only end to end: THIS PR makes /admin/leads requireAdmin (sales
    // is not a technician surface), so push and feed visibility follow the
    // surface — neither the bell row nor the push reaches non-admin staff.
    adminRoleOnly: true,
    build: (p) => {
      const bodyParts = [
        `${p.name || 'A prospect'}${p.source ? ' via ' + p.source : ''}${p.area ? ' (' + p.area + ')' : p.zip ? ' (' + p.zip + ')' : ''}`,
      ];
      if (p.service) bodyParts.push(`Wants ${p.service}`);
      if (p.phone) bodyParts.push(`Phone: ${maskPhone(p.phone)}`);
      if (p.message) bodyParts.push('Message included on lead record');
      return {
        title: p.title || 'New lead',
        body: bodyParts.join(' - '),
        link: p.leadId ? `/admin/leads?lead=${p.leadId}` : '/admin/leads',
      };
    },
  },
  // Fired by the public careers funnel (routes/public-careers.js) on a new
  // job application. Applicants are never customers/leads; the owner calls
  // or texts every applicant himself from the recruiting queue.
  // NO applicant PII in the notification: bell/push fans out to every
  // active staff user, but the recruiting API is requireAdmin — name/city/
  // phone must not cross that boundary (codex P0). Details live behind the
  // link, in the admin-only queue.
  new_job_application: {
    label: 'New job application',
    category: 'new_lead',
    priority: 'high',
    group: 'Leads & Sales',
    // Recruiting is requireAdmin — a technician receiving this bell/push
    // would land on a 403. Deliver to admin-role users only (codex P1).
    adminRoleOnly: true,
    build: (p) => ({
      title: `Job application: ${p.role || 'technician'}`,
      body: 'New applicant — open the recruiting queue to review.',
      link: p.applicationId
        ? `/admin/recruiting?application=${p.applicationId}`
        : '/admin/recruiting',
    }),
  },
  // Fired by reschedule-intent-flagger when an inbound SMS reads as a
  // reschedule/away request while a visit is still armed — the automation
  // does not act on these, so the owner must (2026-08-05 incident class:
  // customer asked to reschedule at 12:30am, visit ran and invoiced anyway).
  appointment_reschedule_intent: {
    label: 'Customer asked to reschedule by text',
    category: 'schedule',
    priority: 'urgent',
    group: 'Communication',
    // Schedule-surface alert a field tech must see (their visit may still
    // be armed) — one of the few triggers in the non-admin bell feed.
    techVisible: true,
    build: (p) => ({
      title: `Reschedule request: ${p.name || 'customer'}`,
      body: [
        redactSensitiveText(p.message || '').slice(0, 120),
        p.visitDate
          ? `Next visit: ${p.visitDate}${p.visitService ? ` (${p.visitService})` : ''} — still armed`
          : (p.ambiguousVisits ? 'Multiple upcoming visits — check which one they mean' : 'No upcoming visit on the books'),
      ].join(' — '),
      link: p.customerId ? `/admin/communications?thread=${p.customerId}` : '/admin/communications',
    }),
  },
  sms_reply: {
    label: 'SMS reply received',
    category: 'inbound_sms',
    priority: 'high',
    // Communications is a tech-visible surface — inbound customer texts
    // belong in the non-admin bell feed (fail-closed allowlist).
    techVisible: true,
    group: 'Communication',
    build: (p) => ({
      title: `SMS from ${p.fromName || (p.fromPhone ? maskPhone(p.fromPhone) : 'unknown')}`,
      body: redactSensitiveText(p.message || '').slice(0, 140),
      // threadId is the customer id (see twilio-webhook). CommunicationsPageV2
      // reads ?thread=<customerId> and opens that customer's SMS conversation.
      link: p.threadId ? `/admin/communications?thread=${p.threadId}` : '/admin/communications',
    }),
  },
  // Fired by call-recording-processor (GATE_VOICEMAIL_CALLBACK_ALERT) for a
  // voicemail with concrete service intent that did NOT take the workable
  // lead path — usually an existing customer asking for service. Without
  // this, such voicemails end terminal and are only visible by scrolling
  // the comms inbox.
  customer_voicemail_callback: {
    // Tech-visible: links to a day-to-day surface (comms) a field tech works in.
    techVisible: true,
    label: 'Voicemail needs callback',
    category: 'voicemail_callback',
    priority: 'high',
    group: 'Communication',
    // Owner ruling (Adam, 2026-07-30, same as twilio_failure): the callback
    // bell shows the real number — a masked callback number is undialable.
    // Payload fields are built by call-recording-processor, not free text.
    allowContactDetails: true,
    build: (p) => {
      const who = p.name || p.phone || 'Unknown caller';
      const bodyParts = [who];
      if (p.service) bodyParts.push(`Asked about ${p.service}`);
      if (p.phone) bodyParts.push(`Callback: ${p.phone}`);
      return {
        // Banner-first: the WHO leads so a truncated phone banner still
        // identifies the caller (owner ruling 2026-07-30).
        title: `Voicemail — ${who}`,
        body: bodyParts.join(' - '),
        // Voicemail recordings render under the Calls tab (hash-routed);
        // ?thread= would open the SMS view instead. CallLogTabV2 has no
        // per-call URL param today, so the tab is the deepest stable link.
        link: '/admin/communications#tab=calls',
      };
    },
  },
  // Fired by estimate-converter when a paid acceptance deposit could not be
  // credited to the first invoice — the money sits on the deposit ledger
  // until someone reconciles it manually.
  estimate_deposit_reconcile_needed: {
    label: 'Estimate deposit needs manual reconciliation',
    category: 'system',
    priority: 'high',
    group: 'Alerts',
    build: (p) => ({
      title: 'Deposit paid but not credited',
      body: `Estimate ${String(p.estimateId || 'unknown').slice(0, 40)}: deposit is on the ledger but the first-invoice credit failed — reconcile manually`,
      link: '/admin/estimates',
    }),
  },
  // Fired by the service-report delivery queue when an email report has
  // exhausted its retries — the customer never received their report.
  service_report_delivery_failed: {
    // Tech-visible: links to a day-to-day surface (reports) a field tech works in.
    techVisible: true,
    label: 'Service report email failed to send',
    category: 'system',
    priority: 'high',
    group: 'Alerts',
    build: (p) => ({
      title: 'Service report not delivered',
      body: `${p.customerName || 'A customer'} did not receive their service report email${p.serviceLabel ? ` (${p.serviceLabel})` : ''} after ${p.attempts || 'multiple'} attempts${p.errorMessage ? ` — ${p.errorMessage}` : ''}. Re-send it from the customer's service.`,
      link: p.link || '/admin/dispatch',
    }),
  },
  // Fired by the PDF render queue when a report PDF can't be generated. The
  // report link still works; the attachment/share copy is missing until re-rendered.
  service_report_pdf_failed: {
    // Tech-visible: links to a day-to-day surface (reports) a field tech works in.
    techVisible: true,
    label: 'Service report PDF render failed',
    category: 'system',
    priority: 'normal',
    group: 'Alerts',
    build: (p) => ({
      title: 'Service report PDF could not be generated',
      body: `The PDF for ${p.customerName || 'a customer'}'s service report${p.serviceLabel ? ` (${p.serviceLabel})` : ''} failed to render after ${p.attempts || 'multiple'} attempts${p.errorMessage ? ` — ${p.errorMessage}` : ''}. The report link still works; re-render to restore the PDF.`,
      link: p.link || '/admin/dispatch',
    }),
  },
  twilio_failure: {
    label: 'Twilio call/SMS failure',
    category: 'system',
    priority: 'urgent',
    group: 'Communication',
    // Tech-visible: urgent comms failures link to /admin/communications,
    // a technician-allowed surface — a failed customer call/SMS is exactly
    // what field staff must see and acknowledge.
    techVisible: true,
    // Owner ruling (Adam, 2026-07-30): fully-masked failure bells ("from
    // ***5598 — CA...a76a0e") were untriageable. This trigger is exempt from
    // contact masking: the bell shows the real numbers and, when the remote
    // phone maps to exactly one customer, their name and record link. Every
    // payload field is built by twilio-failure-alerts.js, which still
    // sanitizes provider error text before it gets here.
    allowContactDetails: true,
    build: (p) => {
      const channel = String(p.channel || 'message').toUpperCase();
      const direction = p.direction ? `${p.direction} ` : '';
      const phase = p.phase ? ` (${p.phase})` : '';
      const status = p.status || 'failed';
      const code = p.errorCode ? ` error ${p.errorCode}` : '';
      const from = p.fromPhone || p.fromMasked || 'unknown';
      const to = p.toPhone || p.toMasked || 'unknown';
      // Banner-first title: iOS/Android banners truncate, so the WHO leads
      // (owner ruling 2026-07-30 — "the alert should immediately tell me").
      // Only an EXPLICIT direction identifies the remote side — the voice
      // call-status exception path passes direction 'unknown', and guessing
      // `from` there banners Waves' own originating number as the customer.
      const remote = p.direction === 'outbound' ? to : (p.direction === 'inbound' ? from : null);
      const who = p.remoteName || (remote && remote !== 'unknown' ? remote : null);
      return {
        title: `${who ? `${who} — ` : ''}${channel} ${status}`,
        // sidMasked stays in the body — with several events on one number it
        // is the only handle correlating this alert to the masked provider
        // SID in the logs.
        body: `${direction}${channel}${phase}${code}: from ${from} to ${to}${p.errorMessage ? ` — ${p.errorMessage}` : ''}${p.sidMasked ? ` — ${p.sidMasked}` : ''}`,
        // CustomersPageV2 opens a record via the customerId query param — the
        // SPA has no /admin/customers/<id> route.
        link: p.customerId ? `/admin/customers?customerId=${p.customerId}` : (p.link || '/admin/communications'),
      };
    },
  },
  payment_succeeded: {
    label: 'Payment received',
    category: 'payment',
    priority: 'low',
    group: 'Payments',
    build: (p) => ({
      title: 'Payment received',
      body: `$${Number(p.amount || 0).toFixed(2)} from ${p.customerName || 'customer'}`,
      link: p.invoiceId ? `/admin/invoices?invoice=${p.invoiceId}` : '/admin/revenue',
    }),
  },
  payment_failed: {
    label: 'Payment failed',
    category: 'payment',
    priority: 'urgent',
    group: 'Payments',
    build: (p) => ({
      title: 'Payment failed',
      body: `$${Number(p.amount || 0).toFixed(2)} — ${p.customerName || 'customer'}${p.reason ? ' — ' + p.reason : ''}`,
      link: p.invoiceId ? `/admin/invoices?invoice=${p.invoiceId}` : '/admin/revenue',
    }),
  },
  bill_payment_error: {
    label: 'Bill payment checkout error',
    category: 'payment',
    priority: 'high',
    group: 'Payments',
    build: (p) => {
      const invoiceLabel = p.invoiceNumber ? `Invoice ${p.invoiceNumber}` : 'Invoice payment';
      const method = p.methodLabel || 'Payment method';
      const phase = p.phaseLabel || p.phase || 'checkout';
      return {
        title: method === 'Bank account' ? 'Bank payment error' : 'Bill payment error',
        body: `${invoiceLabel} - ${p.customerName || 'customer'} - ${method} during ${phase}${p.reason ? ': ' + p.reason : ''}`,
        link: p.invoiceId ? `/admin/invoices?invoice=${p.invoiceId}` : '/admin/invoices',
      };
    },
  },
  payment_refunded: {
    label: 'Refund issued',
    category: 'payment',
    priority: 'normal',
    group: 'Payments',
    build: (p) => ({
      title: p.isFullRefund ? 'Full refund issued' : 'Partial refund issued',
      body: `$${Number(p.amount || 0).toFixed(2)} — ${p.customerName || 'customer'}`,
      link: p.invoiceId ? `/admin/invoices?invoice=${p.invoiceId}` : '/admin/revenue',
    }),
  },
  job_complete: {
    // Tech-visible: links to a day-to-day surface (schedule) a field tech works in.
    techVisible: true,
    label: 'Tech marked job complete',
    category: 'service',
    priority: 'low',
    group: 'Field Operations',
    build: (p) => ({
      title: 'Job complete',
      body: `${p.techName || 'Tech'} finished ${p.serviceName || 'service'} at ${p.customerName || 'customer'}`,
      link: p.serviceId ? `/admin/schedule?service=${p.serviceId}` : '/admin/schedule',
    }),
  },
  estimate_expired: {
    label: 'Estimate(s) expired',
    category: 'estimate',
    priority: 'normal',
    group: 'Leads & Sales',
    // Banner-first + actionable (owner ruling 2026-07-30): the WHO leads the
    // title, and the old nameless fallback ("Customer expired without a
    // decision.") never renders — a batch without names uses the count copy.
    build: (p) => {
      const names = Array.isArray(p.names) ? p.names.filter(Boolean) : [];
      if (p.count && p.count > 1) {
        const extra = p.count - names.length;
        return {
          title: `${p.count} estimates expired`,
          body: names.length
            ? `Expired without a decision: ${names.join(', ')}${extra > 0 ? ` +${extra} more` : ''}. Worth follow-up calls.`
            : `${p.count} estimates aged out today. Review the pipeline for follow-up opportunities.`,
          link: '/admin/estimates',
        };
      }
      // Postgres decimals arrive as strings ("0.00" is truthy) — coerce, and
      // label by which total actually carries the price: monthly, else the
      // annual-only recurring shape, else one-time.
      const monthly = Number(p.monthlyTotal || 0);
      const annual = Number(p.annualTotal || 0);
      const onetime = Number(p.onetimeTotal || 0);
      const price = monthly > 0 ? `$${monthly.toFixed(2)}/mo`
        : annual > 0 ? `$${annual.toFixed(2)}/yr`
          : onetime > 0 ? `$${onetime.toFixed(2)} one-time` : null;
      return {
        title: p.customerName ? `${p.customerName} — estimate expired` : 'Estimate expired',
        body: `${p.customerName ? `${p.customerName}'s` : 'An'} estimate${price ? ` (${price})` : ''} expired without a decision. Worth a follow-up call.`,
        link: p.estimateId ? `/admin/estimates?estimateId=${p.estimateId}` : '/admin/estimates',
      };
    },
  },
  bundle_quote_requested: {
    label: 'Bundle quote requested',
    category: 'estimate',
    priority: 'high',
    group: 'Leads & Sales',
    build: (p) => ({
      title: p.bundled
        ? `Bundle self-applied: ${p.customerName || 'Customer'}`
        // A refresh replaced the terms on an OPEN request (codex #3367 PR
        // r12): staff who already triaged the old one need to see that the
        // customer price-locked something different, not a repeat of the
        // inquiry they've already read.
        : p.refreshed
          ? `Bundle inquiry updated: ${p.customerName || 'Customer'}`
          : `Bundle inquiry: ${p.customerName || 'Customer'}`,
      body: p.bundled
        ? `Added ${p.suggestedService || 'service'} → ${p.newTier || p.tier || 'new tier'} @ $${Number(p.newMonthly || 0).toFixed(2)}/mo`
        // start-vs-add mirrors the request row (codex #3367 PR r3): a
        // no-plan customer's bell must not claim a "current plan".
        : p.relationship === 'start'
          ? `Interested in starting ${p.suggestedService || 'a service'} — no current plan`
          : `Interested in adding ${p.suggestedService || 'a service'} to ${p.previousTier || p.tier || 'current'} plan`,
      // Add-on inquiries create a service_requests row; the only place staff can
      // mark it handled (releasing uniq_service_requests_open_estimate_requested_service)
      // is the requests panel on the Customer 360 overview, so deep-link there when
      // we know the customer. Fall back to the estimate when there's no linked customer.
      link: p.customerId
        ? `/admin/customers?customerId=${encodeURIComponent(p.customerId)}`
        : p.estimateId
          ? `/admin/estimates?estimateId=${encodeURIComponent(p.estimateId)}`
          : '/admin/estimates',
    }),
  },
  one_tap_purchase_completed: {
    label: 'One-tap purchase completed',
    category: 'estimate',
    priority: 'high',
    group: 'Leads & Sales',
    build: (p) => ({
      title: `One-tap purchase: ${p.customerName || 'Customer'}`,
      body: `Self-purchased ${p.serviceLabel || 'a service'} at $${Number(p.perVisit || 0).toFixed(2)} per application${p.firstVisitDate ? ` — first visit ${p.firstVisitDate}` : ''}. Booked and converted automatically; no action needed unless something looks off.`,
      link: p.customerId
        ? `/admin/customers?customerId=${encodeURIComponent(p.customerId)}`
        : '/admin/customers',
    }),
  },
  credential_expiring_soon: {
    label: 'Credential expiring within 60 days',
    category: 'credential',
    priority: 'high',
    group: 'Compliance',
    build: (p) => ({
      title: `${p.displayName || 'Credential'} expires in ${p.daysUntil || '?'}d`,
      body: `${p.credentialNumber ? '#' + p.credentialNumber + ' — ' : ''}${p.issuingAuthority || 'Issuer'}. Renew before ${p.expirationDate || 'expiry'} to avoid service interruption.`,
      link: '/admin/credentials',
    }),
  },
  seo_sync_failed: {
    label: 'SEO sync failure (GSC / GBP)',
    category: 'system',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: `${p.source || 'SEO'} sync failed`,
      body: `${p.locationName ? p.locationName + ': ' : ''}${p.reason || 'unknown error'}. Check the Sync Health card on the SEO Advisor tab.`,
      link: '/admin/seo?tab=advisor',
    }),
  },
  // Fired by server/services/dashboard-alerts-cron.js when an
  // operational alert NEWLY appears or escalates (count grows). The
  // cron computes alerts via dashboard-alerts.js and diffs against
  // dashboard_alert_state. Payload echoes the alert shape so the bell,
  // push banner, and SMS all carry the same label.
  dashboard_alert: {
    label: 'Dashboard alert',
    category: 'alert',
    priority: 'urgent',
    group: 'Alerts',
    build: (p) => ({
      title: p.title || 'Dashboard alert',
      body: p.body || null,
      link: p.link || '/admin/dashboard',
    }),
  },
  internal_admin_alert: {
    label: 'Internal admin alert',
    category: 'alert',
    priority: 'high',
    group: 'Alerts',
    build: (p) => ({
      title: p.title || 'Internal admin alert',
      body: p.body || null,
      link: p.link || '/admin/dashboard',
    }),
  },
  newsletter_autopilot_draft: {
    label: 'Newsletter autopilot draft ready',
    category: 'newsletter',
    priority: 'normal',
    group: 'Marketing',
    build: (p) => {
      const warn = Array.isArray(p.preflightWarnings) && p.preflightWarnings.length
        ? ` Heads up: ${p.preflightWarnings.join('; ')}.`
        : '';
      return {
        title: 'Weekly newsletter draft ready',
        body: `Autopilot drafted "${p.subject || 'Untitled'}" from ${p.eventCount || 0} events.${warn} Review and send when ready.`,
        link: '/admin/newsletter?tab=compose',
      };
    },
  },
  newsletter_autopilot_skipped: {
    label: 'Newsletter autopilot skipped (not enough events)',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: 'Newsletter autopilot skipped',
      // p.report is the actionable preflight breakdown (counts + next
      // actions); fall back to the terse reason for legacy callers.
      body: p.report || `${p.reason || 'Not enough approved events'}. Approve more events in the Event Inbox to enable next week's auto-draft.`,
      link: '/admin/newsletter?tab=dashboard',
    }),
  },
  pest_insider_draft: {
    label: 'Pest Insider monthly draft ready',
    category: 'newsletter',
    priority: 'normal',
    group: 'Marketing',
    build: (p) => ({
      title: 'Pest Insider draft ready',
      body: `Autopilot drafted the ${p.month || 'monthly'} Pest Insider: "${p.subject || 'Untitled'}". Review and send when ready.`,
      // autopilotType deep-links Compose to the Pest Insider lane —
      // without it, hydration defaults to the weekly flagship draft.
      link: '/admin/newsletter?tab=compose&autopilotType=pest-insider-monthly',
    }),
  },
  newsletter_proof_sent: {
    label: 'Newsletter proof emailed for approval',
    category: 'newsletter',
    priority: 'normal',
    group: 'Marketing',
    build: (p) => ({
      title: 'Newsletter proof sent — reply APPROVED to send',
      body: `Proof of "${p.subject || 'Untitled'}" emailed to ${p.recipient || 'the owner inbox'}. Reply APPROVED to that email and it sends to ${p.recipientCount ?? '?'} active subscribers; any other reply (or none) leaves it a draft.`,
      link: '/admin/newsletter?tab=compose',
    }),
  },
  newsletter_proof_approved: {
    label: 'Newsletter approved via email reply',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: 'Newsletter approved — sending to the list',
      body: `"${p.subject || 'Untitled'}" was approved by ${p.approvedBy || 'the owner'} via email reply. Sending to ${p.recipientCount ?? '?'} active subscribers now.`,
      link: '/admin/newsletter?tab=history',
    }),
  },
  newsletter_proof_blocked: {
    label: 'Newsletter proof/approval blocked by validation',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: 'Newsletter proof blocked',
      body: `"${p.subject || 'Untitled'}" did not pass the send gate: ${(Array.isArray(p.errors) ? p.errors : []).join('; ') || 'validation failed'}. Fix the draft in the composer — nothing was sent.`,
      link: '/admin/newsletter?tab=compose',
    }),
  },
  event_sources_unhealthy: {
    label: 'Event ingestion sources unhealthy',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    build: (p) => ({
      title: 'Event sources unhealthy',
      // p.summary lists each failing / zero-yield source with its streak;
      // built by event-source-health.formatSourceHealthLines().
      body: p.summary
        ? `${p.summary}\n\nFix or disable these sources — they feed the weekly newsletter digest.`
        : 'One or more event ingestion sources are failing or yielding zero events.',
      link: '/admin/newsletter?tab=events',
    }),
  },
  kb_audit_flagged: {
    label: 'Knowledge base audit flagged entries',
    category: 'knowledge',
    priority: 'high',
    group: 'Knowledge Base',
    build: (p) => {
      const count = Number(p.count || p.flagged || 0);
      const entries = Array.isArray(p.entries) ? p.entries : [];
      const visible = entries.slice(0, 4).map((entry) => {
        const title = entry.title || 'Untitled entry';
        const summary = entry.summary || 'Needs review';
        return `${title}: ${String(summary).slice(0, 180)}`;
      });
      if (count > visible.length) visible.push(`${count - visible.length} more flagged entr${count - visible.length === 1 ? 'y' : 'ies'}`);
      return {
        title: count === 1 ? 'KB audit flagged 1 entry' : `KB audit flagged ${count} entries`,
        body: visible.join('\n') || 'Review flagged knowledge base entries.',
        link: '/admin/kb',
      };
    },
  },
};

const PRIORITY_VIBRATE = {
  urgent: [200, 100, 200, 100, 400],
  high:   [200, 100, 200],
  normal: [150],
  low:    [100],
};

function pushTagFor(triggerKey, payload = {}) {
  if (triggerKey === 'sms_reply') {
    const thread = payload.threadId || 'unknown-thread';
    return `waves-sms_reply-${thread}-${crypto.randomUUID()}`;
  }
  if (triggerKey === 'customer_voicemail_callback') {
    // Per-call tag: the service worker replaces same-tag pushes with
    // renotify:false, so a static tag would let a second caller's alert
    // silently swallow the first. Stable per call — a reprocess re-push for
    // the SAME call may replace itself.
    return `waves-customer_voicemail_callback-${payload.callLogId || 'unknown-call'}`;
  }
  if (triggerKey === 'appointment_reschedule_intent') {
    // Per-customer tag: two customers texting reschedule requests before
    // the owner opens notifications must not collapse into one push.
    // Per-request (codex r12): a re-armed second request must not replace
    // the first push silently (renotify:false in the service worker).
    return `waves-appointment_reschedule_intent-${payload.customerId || 'unknown-customer'}-${payload.decisionId || 'x'}`;
  }
  if (triggerKey === 'new_job_application') {
    // Per-application tag: two applications arriving before the owner opens
    // notifications must not collapse into one push (same-tag replacement).
    return `waves-new_job_application-${payload.applicationId || 'unknown-application'}`;
  }
  return `waves-${triggerKey}`;
}

/**
 * Fire a notification event. Non-blocking — never throws.
 *
 * @param {string} triggerKey — must match a key in TRIGGER_REGISTRY
 * @param {object} payload — trigger-specific data, see each build() for shape
 */
async function triggerNotification(triggerKey, payload = {}) {
  try {
    const trigger = TRIGGER_REGISTRY[triggerKey];
    if (!trigger) {
      logger.warn(`[notification-triggers] Unknown trigger: ${triggerKey}`);
      return;
    }

    // Demo/internal test accounts must not reach admins via bell OR push —
    // push dispatch happens below, outside NotificationService's own gate,
    // so suppress here before either channel. sms_reply carries the customer
    // id as threadId.
    const demoCid = payload?.customerId || payload?.customer_id || payload?.threadId;
    if (isInternalTestCustomerId(demoCid)) {
      logger.info(`[notification-triggers] Suppressed '${triggerKey}' for internal test customer`);
      return { bellWritten: false, push: null, suppressed: true };
    }

    const built = sanitizeBuiltNotification(trigger.build(payload), trigger);
    const safePayload = sanitizeNotificationPayload(triggerKey, payload);

    // Load per-user preferences (default to enabled if no row exists).
    // A FAILED lookup is not "no rows": falling through with prefs=[] treated
    // every admin as opted in to bell + push — an explicit opt-out was
    // silently overridden whenever the query blipped. FAIL CLOSED: no prefs,
    // no delivery to anyone.
    let prefs = [];
    try {
      prefs = await db('notification_preferences')
        .where({ trigger_key: triggerKey });
    } catch (e) {
      logger.error(`[notification-triggers] preferences lookup failed for '${triggerKey}' — delivering to nobody (fail closed): ${e.message}`);
      return { bellWritten: false, push: null, prefsUnavailable: true };
    }

    let activeAdmins = [];
    try {
      let recipientQuery = db('technicians').where({ active: true });
      // Delivery follows the same fail-closed model as the persisted feed
      // (notification-service scopeAdminFeedToRole): non-admin staff receive
      // ONLY triggers classified techVisible — everything else, including
      // unclassified finance/estimate alerts carrying customer names and
      // amounts, goes to admin-role users alone. adminRoleOnly remains as
      // explicit documentation on owner-only triggers; techVisible is the
      // operative flag for both push recipients and bell visibility.
      if (!trigger.techVisible) recipientQuery = recipientQuery.where({ role: 'admin' });
      activeAdmins = await recipientQuery.select('id', 'role');
    } catch (e) {
      logger.warn(`[notification-triggers] technicians query failed: ${e.message}`);
    }

    const prefsByUser = new Map(prefs.map((p) => [p.admin_user_id, p]));
    const anyBellEnabled = activeAdmins.some((u) => {
      const pref = prefsByUser.get(u.id);
      return !pref || pref.bell_enabled !== false;
    });
    const pushEnabledIds = activeAdmins
      .filter((u) => {
        const pref = prefsByUser.get(u.id);
        return !pref || pref.push_enabled !== false;
      })
      .map((u) => u.id);
    let bellWritten = false;

    for (const user of activeAdmins) {
      const userPref = prefsByUser.get(user.id) || { bell_enabled: true, push_enabled: true, sound_enabled: true };

      if (userPref.bell_enabled && !bellWritten) {
        // Write a single bell entry for "admin" recipients (existing model is shared)
        try {
          // NotificationService.create catches insert errors and returns null
          // (deliberate suppression — internal test customer or the admin
          // bell policy — returns a truthy sentinel with suppressed: true) —
          // bellWritten must reflect the actual outcome, not that the call
          // returned.
          const created = await NotificationService.notifyAdmin(
            trigger.category,
            built.title,
            built.body,
            { link: built.link, metadata: { triggerKey, priority: trigger.priority, payload: safePayload } }
          );
          if (created && !created.suppressed) bellWritten = true;
        } catch (e) {
          logger.error(`[notification-triggers] bell write failed: ${e.message}`);
        }
      }
    }

    const stats = { bellWritten, push: null };
    // Every active admin turned BOTH channels off: that is deliberate
    // preference suppression, not a delivery failure — report it so
    // callers (bell replay) stop retrying forever (codex #3232 r25).
    if (activeAdmins.length > 0 && !anyBellEnabled && pushEnabledIds.length === 0) {
      stats.suppressed = true;
    }

    // Push: send to all admin/technician subscriptions whose user has push enabled.
    try {
      const enabledUserIds = pushEnabledIds;

      if (enabledUserIds.length > 0) {
        const wantsSoundByUser = new Map(
          activeAdmins.map((u) => {
            const pref = prefsByUser.get(u.id);
            return [u.id, !pref || pref.sound_enabled !== false];
          })
        );

        // App-icon badge (installed-PWA Badging API / APNs aps.badge): mirror
        // the bell's unread count, computed AFTER the bell write above so the
        // triggering notification is included. The feed is role-scoped, not
        // per-user, so one count per role covers every recipient; a failed
        // count omits the badge (icon left untouched) rather than sending a
        // wrong number.
        const badgeByRole = new Map();
        for (const user of activeAdmins) {
          if (!enabledUserIds.includes(user.id) || badgeByRole.has(user.role)) continue;
          try {
            badgeByRole.set(user.role, await NotificationService.getAdminUnreadCount({ role: user.role }));
          } catch (e) {
            badgeByRole.set(user.role, null);
            logger.warn(`[notification-triggers] badge count failed for role '${user.role}': ${e.message}`);
          }
        }
        const roleByUser = new Map(activeAdmins.map((u) => [u.id, u.role]));

        stats.push = await PushService.sendToAdminUsers(
          enabledUserIds,
          (adminUserId) => {
            const wantsSound = wantsSoundByUser.get(adminUserId);
            const badgeCount = badgeByRole.get(roleByUser.get(adminUserId));
            return {
              title: built.title,
              body: built.body,
              url: built.link || '/admin',
              tag: pushTagFor(triggerKey, payload),
              priority: trigger.priority,
              vibrate: wantsSound ? PRIORITY_VIBRATE[trigger.priority] : [0],
              silent: !wantsSound,
              renotify: triggerKey === 'sms_reply',
              ...(Number.isInteger(badgeCount) ? { badge: badgeCount } : {}),
            };
          }
        );
      }
    } catch (e) {
      logger.error(`[notification-triggers] push dispatch failed: ${e.message}`);
    }
    return stats;
  } catch (err) {
    logger.error(`[notification-triggers] dispatch failed for ${triggerKey}: ${err.message}`);
    return { bellWritten: false, push: null, error: err.message };
  }
}

function listTriggers() {
  return Object.entries(TRIGGER_REGISTRY).map(([key, t]) => ({
    key, label: t.label, group: t.group, priority: t.priority,
  }));
}

module.exports = {
  triggerNotification,
  listTriggers,
  TRIGGER_REGISTRY,
  __private: {
    maskEmail,
    maskPhone,
    pushTagFor,
    redactSensitiveText,
    sanitizeBuiltNotification,
    sanitizeNotificationPayload,
  },
};
