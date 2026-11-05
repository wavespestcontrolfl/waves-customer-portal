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
 *      (with a `rule`: area, severity, who, and doneWhen + closedBy or expiryDays;
 *      server/tests/admin-alert-catalog-contract.test.js enforces it)
 *   2. Add to the seed list in the notification_preferences migration
 *   3. Call `triggerNotification('your_key', { ... })` from the route that fires it
 */
const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { rescueClaudeFault } = require('./admin-alert-routing');
const PushService = require('./push-notifications');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { stripEmoji } = require('../utils/strip-emoji');
const { agentName } = require('./voice-agent/relay-protocol');
const { soundForTrigger } = require('./alert-sounds');

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
// The house number is not the minutes of a clock time (a digit then a colon; "Address:421 Spring Ave" still redacts) ("8:00 AM at 421 Spring Ave" kept "8:[address]") and not an
// hour followed by AM/PM ("8 AM at ..."): those numbers start no address.
const STREET_ADDRESS_RE = /\b(?<!\d)(?<!\d:)\d{1,6}(?!\s*(?:a\.?m\b|p\.?m\b))\s+[A-Za-z0-9 .'-]+?\s(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Circle|Cir|Boulevard|Blvd|Trail|Trl|Terrace|Ter|Place|Pl|Parkway|Pkwy|Way)\b/gi;
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

  // Opaque row ids (emailId, callLogId, customer_id…) are not contact
  // details — masking `emailId` to '[email]' broke the reclaim dedupe that
  // looks the bell up by it (codex r6). Verbatim: the digit redactor would
  // otherwise mangle a UUID's digit runs like a card number. A list of ids
  // (allocationInvoiceIds, *_ids) passes each element with its parent key.
  if (/(?:^|_)ids?$|Ids?$/.test(key)) return value;
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
    ...(built.detail ? { detail: cleanBody(redactSensitiveText(built.detail)) } : {}),
  };
}

// A call alert opens the call it is about: the Calls tab reads
// #tab=calls&call=<call_log id> (CallLogTabV2 pins a call outside its loaded
// window). No id in the payload keeps the bare tab.
const callLink = (p) => `/admin/communications#tab=calls${p.callLogId ? `&call=${encodeURIComponent(p.callLogId)}` : ''}`;
// The Call button for a row about one caller (alert-call-button.js, GATE_ALERT_CALL_BUTTON), as the built row's
// `alert`; nothing when the payload names no call or customer, so such a row is written as before.
const callButtonAlert = (ids) => {
  const buttons = require('./alert-call-button').callButtons(ids);
  return buttons ? { alert: { buttons } } : {};
};
// A US number the way the office writes it, "(941) 544-1363" (owner 2026-10-21 for the promise chaser,
// 2026-11-04 for a voicemail's callback number); anything else as it came. Still the whole real number.
function shownPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : phone;
}

// bundle_quote_requested's `alert` (GATE_PORTAL_ITEM_CLOSE): the request row and its customer at the top of the
// bell's metadata. Gate off, or a bell with no request row (a self-applied bundle): nothing, as before.
function bundleRequestAlert(p) {
  if (!p.requestId || !p.customerId || !require('../config/feature-gates').portalItemCloseLive?.()) return {};
  return { alert: { requestId: String(p.requestId), customerId: String(p.customerId) } };
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
    rule: { area: 'System', severity: 'broken', who: 'claude', expiryDays: 30 },
    build: (p) => {
      const failures = Array.isArray(p.failures) ? p.failures : [];
      return {
        title: 'Estimator data canary: county parser regression',
        body: `${failures.length} check(s) failing — ${failures.slice(0, 3).join('; ')}`.slice(0, 220),
        link: '/admin/estimates',
      };
    },
  },
  // Fired by call-recording-processor.js right after it creates a customer
  // row from a call whose on-file phone resolves to a non-mobile line
  // (landline / fixed-VoIP) — the 2026-09-10 incident: a caller-ID landline
  // became customers.phone, and the customer's real cell (only ever texted
  // in from later) could never receive the SMS login code. allowContactDetails
  // so the office has a dialable number to call and ask for a cell.
  //
  // Own dedicated category, deliberately NOT 'alert' (codex review, PR #4341
  // r1 P1): the shared 'alert' bucket default-denies under
  // GATE_ADMIN_BELL_POLICY, which would silently drop this trigger. This
  // category is instead on notification-bell-policy.js's DEFAULT_ON_CATEGORIES
  // (rings unless the owner turns it off in Settings — same treatment as
  // estimate_change_request), so it also has to be added there, not just here.
  customer_landline_from_call: {
    label: 'New customer created with a landline number',
    category: 'customer_landline_from_call',
    priority: 'normal',
    group: 'Leads & Sales',
    rule: { area: 'Customers', severity: 'needs-you', who: 'person', expiryDays: 30 },
    allowContactDetails: true,
    build: (p) => ({
      title: `Landline on file: ${p.name || 'New customer'}`,
      body: `Created from a caller-ID landline${p.phone ? ` (${p.phone})` : ''} — SMS login codes and texts won't reach it. Call to collect a mobile number.`,
      link: p.customerId
        ? `/admin/customers?customerId=${encodeURIComponent(p.customerId)}`
        : '/admin/customers',
      // Call: the customer page's own Call (alert-call-button.js, GATE_ALERT_CALL_BUTTON).
      ...callButtonAlert({ customerId: p.customerId }),
    }),
  },
  new_lead: {
    label: 'New lead submitted',
    category: 'new_lead',
    priority: 'high',
    group: 'Leads & Sales',
    rule: { area: 'Leads', severity: 'needs-you', who: 'person', doneWhen: 'lead_contacted', closedBy: 'server/services/admin-alert-relevance.js', contact: true },
    // Owner-only end to end: THIS PR makes /admin/leads requireAdmin (sales
    // is not a technician surface), so push and feed visibility follow the
    // surface — neither the bell row nor the push reaches non-admin staff.
    adminRoleOnly: true,
    build: (p) => {
      // A text from a number with no customer record to a website or van-wrap line, the one caller that names a
      // text (sms-reply-alert-delivery.js ringTrackingLineTextBell): one row per sender, rewritten by each new text
      // like a known customer's thread row ("2 texts from wavespestcontrol.com"). It says who and what (owner
      // audit 2026-10-01): the latest text in quotes, masked like every bell body. Who: the name on file for the
      // number (owner 2026-11-04) and the line they texted, else the line and the masked number. A text with no
      // words is a photo (the webhook rings only for words or a photo).
      if (p.twilioSid) {
        const { redactedWords, whyWithQuote } = require('./admin-alert-names');
        const count = Math.floor(Number(p.textCount)) || 1;
        const words = redactedWords(p.message);
        const [who, tail] = p.name ? [p.name, ` — via ${p.source}`] : [p.source, ` — unknown sender ${maskPhone(p.phone)}`];
        const body = whyWithQuote({ lead: words ? '' : 'Photo message', quote: words, tail });
        return {
          title: `${count > 1 ? `${count} texts` : 'New text'} from ${who}`,
          body,
          // The whole text for "Show full text" when the quote had to be cut.
          ...(body.includes(words) ? {} : { detail: words.slice(0, 1600) }),
          link: p.link,
          // Call: the Communications thread's Call back for the sender (alert-call-button.js, GATE_ALERT_CALL_BUTTON).
          ...callButtonAlert({ smsSid: p.twilioSid }),
        };
      }
      const bodyParts = [
        `${p.name || 'A prospect'}${p.source ? ' via ' + p.source : ''}${p.area ? ' (' + p.area + ')' : p.zip ? ' (' + p.zip + ')' : ''}`,
      ];
      if (p.service) bodyParts.push(`Wants ${p.service}`);
      if (p.phone) bodyParts.push(`Phone: ${maskPhone(p.phone)}`);
      if (p.message) bodyParts.push(p.leadId ? 'Message included on lead record' : 'Message in the SMS inbox');
      return {
        title: p.title || 'New lead',
        body: bodyParts.join(' - '),
        link: p.leadId ? `/admin/leads?lead=${p.leadId}` : (p.link || '/admin/leads'),
        // Call: the Leads page's Call Now for the lead, else the customer page's Call (a web form whose lead row
        // failed sends the customer id as leadId) (alert-call-button.js, GATE_ALERT_CALL_BUTTON).
        ...callButtonAlert({ leadId: p.leadId === p.customerId ? null : p.leadId, customerId: p.customerId }),
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
    // Own category: an applicant is not a customer lead. Silent by default
    // under the bell policy, owner-overridable (Settings → Notifications).
    category: 'job_application',
    priority: 'high',
    group: 'Leads & Sales',
    rule: { area: 'Leads', severity: 'needs-you', who: 'person', expiryDays: 30 },
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
  // Fired by the public interview self-scheduling route (POST
  // /interview/:token/book) when an applicant picks or changes a time.
  // Same no-PII contract as new_job_application: mode + when label only,
  // no name/phone/email cross the requireAdmin boundary.
  job_interview_booked: {
    label: 'Interview booked',
    category: 'job_application',
    priority: 'high',
    group: 'Leads & Sales',
    rule: { area: 'Leads', severity: 'fyi', who: 'person', expiryDays: 7 },
    adminRoleOnly: true,
    build: (p) => ({
      title: 'Interview booked',
      body: p.whenLabel
        ? `${p.mode === 'in_person' ? 'In person' : 'Phone'} interview — ${p.whenLabel}.`
        : 'An applicant booked an interview time.',
      link: p.applicationId
        ? `/admin/recruiting?application=${p.applicationId}`
        : '/admin/recruiting',
    }),
  },
  // Fired by the public interview link's "I'm no longer interested" action.
  job_application_withdrawn: {
    label: 'Applicant withdrew',
    category: 'job_application',
    priority: 'normal',
    group: 'Leads & Sales',
    rule: { area: 'Leads', severity: 'fyi', who: 'person', expiryDays: 7 },
    adminRoleOnly: true,
    build: (p) => ({
      title: 'Applicant withdrew',
      body: 'An applicant is no longer interested — open the recruiting queue.',
      link: p.applicationId
        ? `/admin/recruiting?application=${p.applicationId}`
        : '/admin/recruiting',
    }),
  },
  // Fired by the Twilio inbound webhook (services/recruiting-inbound.js)
  // when an applicant texts back. Admin-only: recruiting threads never
  // reach the tech-visible sms_reply bell; no name/phone/body crosses.
  job_applicant_reply: {
    label: 'Applicant replied',
    category: 'job_application',
    priority: 'high',
    group: 'Leads & Sales',
    rule: { area: 'Leads', severity: 'needs-you', who: 'person', expiryDays: 30 },
    adminRoleOnly: true,
    build: (p) => ({
      title: 'Applicant replied',
      body: 'An applicant texted back — open the recruiting queue to read it.',
      link: p.applicationId
        ? `/admin/recruiting?application=${p.applicationId}`
        : '/admin/recruiting',
    }),
  },
  // Nothing fires this today (the reschedule-intent flagger and its gate were
  // removed). Kept so the bell rows it wrote before 2026-08-15 still render,
  // stay in the technician feed allowlist and keep their push tag.
  appointment_reschedule_intent: {
    label: 'Customer asked to reschedule by text',
    category: 'schedule',
    priority: 'urgent',
    group: 'Communication',
    rule: { area: 'Schedule', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true },
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
  // A customer booked their own free re-service from the self-serve link
  // (owner 2026-10-05): the request is a customer telling us about a
  // problem, so it rings and pushes like a text. The headline names who and
  // when, the why quotes their words (or the pests they picked), and the
  // whole request rides in the detail. Fired by reservice-public.js.
  reservice_self_booked: {
    label: 'Customer booked a re-service',
    category: 'schedule',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'visit_closed', closedBy: 'server/services/admin-alert-relevance.js', contact: true },
    // Composed through docs/admin-notifications.md: `alert` carries the
    // structured parts (area, severity, subject, done-when, who) into the
    // row's metadata. A customer's own words that trip a copy rule never
    // cost the alert (the composer's own fallback shape, as raiseAdminAlert).
    build: (p) => {
      const names = require('./admin-alert-names');
      const compose = require('./admin-alert-compose');
      const named = p.name || 'a customer';
      const when = p.when ? ` for ${p.when}` : '';
      const pests = p.pests ? `${p.pests}: ` : '';
      const words = p.request ? names.redactedWords(p.request) : '';
      const spec = {
        area: 'Schedule',
        action: names.fitAction('Schedule', named, [
          (n) => `read ${n}'s re-service request${when}`,
          (n) => `read ${n}'s re-service request`,
        ]),
        why: words
          ? names.whyWithQuote({ lead: pests, quote: words })
          : (p.pests ? `Picked ${p.pests.toLowerCase()} and typed no description.` : 'They typed no description of the problem.'),
        severity: 'needs-you',
        // The booked visit on the schedule (its job card shows the request);
        // the customer only when the visit is not known.
        link: p.scheduledServiceId && p.serviceDate
          ? `/admin/dispatch?tab=schedule&date=${encodeURIComponent(p.serviceDate)}&appointment=${encodeURIComponent(p.scheduledServiceId)}`
          : (p.customerId ? `/admin/customers?customerId=${encodeURIComponent(p.customerId)}` : '/admin/schedule'),
        subject: p.scheduledServiceId ? { type: 'visit', id: p.scheduledServiceId } : { type: 'customer', id: p.customerId },
        // Closed by the relevance sweep (admin-alert-relevance.js
        // reservice_booked) once the visit is completed, cancelled or gone.
        doneWhen: 'visit_closed',
        who: 'person',
      };
      const detail = words ? [p.pests ? `Pests: ${p.pests}` : null, p.when ? `Visit: ${p.when}` : null, `Request: ${words}`].filter(Boolean).join('\n') : null;
      let composed;
      try {
        composed = compose.composeAdminAlert(spec);
      } catch (err) {
        // Even under test: only the customer's words can break a rule here
        // (the copy tests prove our own text passes), so this is data, not a bug.
        if (err.code !== 'ADMIN_ALERT_RULE') throw err;
        composed = {
          headline: compose.cutAtWord(`${spec.area} — ${spec.action}`, compose.MAX_HEADLINE_CHARS),
          why: spec.why,
          link: spec.link,
          metadata: { ...compose.validStructuredFields(spec), ruleViolations: err.violations },
        };
      }
      return {
        title: composed.headline,
        body: composed.why,
        ...(detail ? { detail } : {}),
        link: composed.link,
        alert: composed.metadata,
      };
    },
  },
  sms_reply: {
    label: 'SMS reply received',
    category: 'inbound_sms',
    priority: 'high',
    // Communications is a tech-visible surface — inbound customer texts
    // belong in the non-admin bell feed (fail-closed allowlist).
    techVisible: true,
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'text_answered', closedBy: 'server/services/admin-alert-relevance.js', contact: true },
    build: (p) => ({
      // One bell row per conversation: a known sender's later texts rewrite the
      // row while it is still open, so a count leads the title ("3 texts from
      // Name") and the body is always the latest text.
      // A lead's bare CALL / TEXT reply leads
      // with the choice so the owner calls the CALL leads first. Only the text
      // that carried it has it: the next text's payload replaces the row's, and
      // an older late text never changes the title (the row keeps its content).
      title: (p.leadPreference === 'call' || p.leadPreference === 'text')
        ? `${p.leadPreference === 'call' ? 'Wants a call:' : 'Prefers text:'} ${p.fromName || (p.fromPhone ? maskPhone(p.fromPhone) : 'unknown')}${Number(p.textCount) > 1 ? ` (${Math.floor(Number(p.textCount))} texts)` : ''}`
        : `${Number(p.textCount) > 1 ? `${Math.floor(Number(p.textCount))} texts from` : 'SMS from'} ${p.fromName || (p.fromPhone ? maskPhone(p.fromPhone) : 'unknown')}`,
      body: redactSensitiveText(p.message || '').slice(0, 140),
      // The whole text, for the bell's "Show full text": the 140-character
      // body above (also the push text) used to be all the bell ever kept.
      ...(String(p.message || '').length > 140 ? { detail: redactSensitiveText(p.message).slice(0, 1600) } : {}),
      // threadId is the customer id (see twilio-webhook). CommunicationsPageV2
      // reads ?thread=<customerId> and opens that customer's SMS conversation.
      // The MessageSid (never the phone number, which this feed masks) names
      // the message the alert is about, so the page scrolls to THAT message
      // even when newer ones arrive before the tap. A known sender keeps the
      // thread link and appends &message=<sid> (markInboundSmsReadAdmin and
      // inbound-sms-read match the part before &message=); an unknown sender
      // has no customer, so ?message= alone opens the conversation
      // (inbound-sms-read recognises both unlinked shapes by this prefix).
      link: p.threadId
        ? `/admin/communications?thread=${p.threadId}${p.twilioSid ? `&message=${encodeURIComponent(p.twilioSid)}` : ''}`
        : (p.twilioSid ? `/admin/communications?message=${encodeURIComponent(p.twilioSid)}` : '/admin/communications'),
      // Handled: the bell's own Done with that note (admin-alert-buttons.js, GATE_ALERT_CLOSE_BUTTONS). No reply.
      // A lead's bare CALL reply also gets Call first, for the text that carried it: the next text's emission sets
      // the row's buttons again (alert-call-button.js, GATE_ALERT_CALL_BUTTON).
      alert: { buttons: p.leadPreference === 'call' && p.threadId
        ? require('./alert-call-button').callButtons({ customerId: p.threadId, close: 'handled' })
        : require('./admin-alert-buttons').closeNoteButtons('handled') },
    }),
  },
  // Written directly by messenger-inbox.js ringBell (raiseAdminAlert with a per-thread dedupeKey and bell: true):
  // one standing bell per Facebook thread. Registered so the row carries a known trigger key and the phone banner
  // (bell-banners.js, GATE_BELL_BANNERS) has a type to send under. `build` takes the written row's own words as
  // alertTitle/alertBody/alertLink. Admin-only (not techVisible), as the bell row already is.
  messenger_reply: {
    label: 'Facebook message',
    category: 'alert',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'customer_answered', closedBy: 'server/services/messenger-inbox.js', contact: true },
    build: (p) => ({
      title: p.alertTitle || 'New Facebook message',
      body: p.alertBody || 'Open the thread to read it and reply.',
      link: p.alertLink || '/admin/communications#tab=messenger',
    }),
  },
  // The phone banner for a new-lead email (GATE_RING_NEW_CONTACTS, bell-banners.js kind new_lead_email, owner 2026-11-04
  // "ring new"). The bell row is the plain 'new_lead' category row email-actions.js already writes, which carries no
  // triggerKey of its own (the writer names this kind with notifyAdmin's bannerKind), so no sweep closes it and its
  // rule is the retention expiry. `build` takes the written row's own words as alertTitle/alertBody/alertLink.
  // Admin-only like the lead bell.
  new_lead_email: {
    label: 'New lead email banner',
    category: 'new_lead',
    priority: 'high',
    group: 'Leads & Sales',
    rule: { area: 'Leads', severity: 'needs-you', who: 'person', expiryDays: 30 },
    adminRoleOnly: true,
    build: (p) => ({
      title: p.alertTitle || 'New lead from email',
      body: p.alertBody || 'Open the email to read it and reply.',
      link: p.alertLink || '/admin/email',
    }),
  },
  // Sandy PR 2A: a live transfer went to the office WITHOUT its summary
  // (the handoff packet write failed or timed out). The staff member who
  // pressed 1 heard the generic whisper; this is the only record that a
  // summary existed. Written directly by relay-transfer.js (notifyAdmin with
  // a per-CallSid dedupeKey and bell: true, the watchdog pattern);
  // registered here so the persisted rows carry a known trigger key and
  // `build` mirrors the shape it writes.
  sandy_transfer_no_context: {
    label: `${agentName()} transfer arrived without its summary`,
    category: 'alert',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true },
    techVisible: true, // the calls tab is staff-wide; whoever pressed 1 must see it
    build: (p) => ({
      title: `${agentName()} transfer without context`,
      body: `A caller${p.from ? ` from ${maskPhone(p.from)}` : ''} was transferred to the office but the call summary could not be saved — ask the caller to recap.`,
      link: callLink(p),
    }),
  },
  // Direct watcher bells must also join the staff visibility allowlist.
  sms_operational_followup: {
    techVisible: true,
    label: 'SMS request needs follow-up',
    category: 'alert',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'promise_fulfilled', closedBy: 'server/services/sms-operational-actions.js', promise: true },
    // The phone banner (bell-banners.js) carries the written row's own words as alertTitle/alertBody/alertLink.
    build: (p) => ({
      title: p.alertTitle || 'An SMS request needs follow-up',
      body: p.alertBody || 'Open the customer profile to verify completion or take the next step.',
      link: p.alertLink || `/admin/customers?customerId=${encodeURIComponent(p.customerId)}&tab=comms`,
    }),
  },
  // Written directly by call-commitments-watchdog (notifyAdmin with its own
  // per-commitment per-ET-day dedupeKey and bell: true — the 'alert'
  // category is silenced under the bell policy and a pager must page);
  // registered here so the persisted rows are tech-visible: the Owed tab is
  // staff-wide and the people who work it must see its overdue bell. `build`
  // is the shape the watchdog writes, for triggerNotification parity.
  call_commitment_overdue: {
    techVisible: true,
    label: 'Promise to a caller is overdue',
    category: 'alert',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'promise_fulfilled', closedBy: 'server/services/call-commitments-watchdog.js', promise: true },
    // The phone banner (bell-banners.js) carries the written row's own words as alertTitle/alertBody/alertLink.
    build: (p) => ({
      title: p.alertTitle || (p.count > 1 ? `${p.count} promises to callers are overdue` : 'A promise to a caller is overdue'),
      body: p.alertBody || p.summary || 'Open the Owed tab to mark it done or dismiss it.',
      link: p.alertLink || '/admin/communications#tab=owed',
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
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'caller_reached', closedBy: 'server/services/admin-alert-relevance.js', contact: true },
    // Owner ruling (Adam, 2026-07-30, same as twilio_failure): the callback
    // bell shows the real number — a masked callback number is undialable.
    // Payload fields are built by call-recording-processor, not free text.
    allowContactDetails: true,
    build: (p) => {
      // The callback number the way the office writes it (owner 2026-11-04), still the whole number.
      const phone = shownPhone(p.phone);
      const who = p.name || phone || 'Unknown caller';
      const bodyParts = [who];
      if (p.service) bodyParts.push(`Asked about ${p.service}`);
      if (phone) bodyParts.push(`Callback: ${phone}`);
      return {
        // Banner-first: the WHO leads so a truncated phone banner still
        // identifies the caller (owner ruling 2026-07-30).
        title: `${p.reason === 'sandy_provider_failure' ? 'AI call callback' : 'Voicemail'} — ${who}`,
        body: bodyParts.join(' - '),
        // Voicemail recordings render under the Calls tab (hash-routed);
        // ?thread= would open the SMS view instead.
        link: callLink(p),
        // Call: the Call Log's own "Call back" for this call (alert-call-button.js, GATE_ALERT_CALL_BUTTON).
        ...callButtonAlert({ callLogId: p.callLogId }),
      };
    },
  },
  // Fired by email-sync when a NEW inbound email's sender matches a customer
  // on file (owner ruling 2026-08-28). Vendor/spam/bulk mail never fires it.
  customer_email_received: {
    label: 'Email from a customer',
    category: 'inbound_email',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'email_answered', closedBy: 'server/services/admin-alert-relevance.js', contact: true },
    build: (p) => ({
      title: `Email from ${p.fromName || 'a customer'}`,
      body: redactSensitiveText(p.subject || '(no subject)').slice(0, 140),
      link: p.emailId ? `/admin/email?id=${p.emailId}` : '/admin/email',
    }),
  },
  // Fired 2 minutes after an inbound call from a customer on file ends with
  // no human/AI answer and no voicemail (missed-call-bell.js). Voicemails
  // ring through customer_voicemail_callback instead.
  customer_missed_call: {
    label: 'Missed call from a customer',
    category: 'missed_call',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'caller_reached', closedBy: 'server/services/missed-call-bell.js', contact: true },
    // Same owner ruling as the voicemail bell: the number must be dialable.
    allowContactDetails: true,
    build: (p) => ({
      title: `Missed call — ${p.name || 'a customer'}`,
      // GATE_MISSED_CALL_ALERT_DETAIL: the producer adds line / duration /
      // next visit to the payload only with the gate on; without them this is
      // the original sentence, character for character.
      body: require('./missed-call-alert-detail').formatMissedCallBody(p),
      // Calls live under the hash-routed Calls tab; ?thread= would open the
      // SMS conversation instead (same destination as the voicemail bell).
      link: callLink(p),
      // Call: the Call Log's own "Call back" for this call (alert-call-button.js, GATE_ALERT_CALL_BUTTON). Called back:
      // the bell's own Done with that note (admin-alert-buttons.js, GATE_ALERT_CLOSE_BUTTONS); it places no call.
      alert: { buttons: require('./alert-call-button').callButtons({ callLogId: p.callLogId, close: 'called_back' }) },
    }),
  },
  // Staff alert for a repeat window, gated by GATE_REPEAT_CALLER_BELL.
  repeat_caller: {
    label: 'Repeat caller',
    category: 'missed_call',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', expiryDays: 30 },
    allowContactDetails: true,
    build: (p) => ({
      title: `Repeat caller — ${p.name || 'unknown number'}`,
      body: `${p.phone || 'unknown number'} has called ${p.count} times in the last 3 hours (${p.unanswered} unanswered)${p.line ? ` on ${p.line}` : ''}.`,
      link: callLink(p),
      ...callButtonAlert({ callLogId: p.callLogId }),
    }),
  },
  // A lead calls back while a Waves promise from an earlier unbooked call
  // (a callback, a quote, a time to come out) is still open — gated by
  // GATE_PROMISE_CHASER_BELL. See services/promise-chaser-bell.js.
  promise_chaser: {
    label: 'Lead calling back — promise still owed',
    category: 'missed_call',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'promise_fulfilled', closedBy: 'server/services/promise-chaser-bell.js', promise: true },
    allowContactDetails: true,
    build: (p) => {
      // The headline and the body lead with WHO (owner 2026-10-21): the name,
      // else the number in its usual form, else a plain "A lead". The body
      // used to show the raw +1 number under a formatted headline (owner
      // screenshot 2026-11-04).
      const who = p.name || shownPhone(p.phone) || 'A lead';
      // Dispatched only by the durable sweep now (no more live /voice call
      // site) — the call has always already ended by the time this fires,
      // so the copy always states when they called, never "is calling in
      // now".
      return {
        title: `${who} called back — we still owe a ${p.what || 'follow-up'}`,
        body: `${who} called at ${p.calledAtLabel || 'earlier'}. We still owe them a ${p.what || 'follow-up'} promised ${p.when || 'earlier'}.`,
        link: callLink(p),
        ...callButtonAlert({ callLogId: p.callLogId }),
      };
    },
  },
  // Sandy (the AI phone agent) took a real call, the caller spoke, and the
  // call ended with no booking, no lead and no transfer — gated by
  // GATE_RELAY_UNBOOKED_HANDOFF. See services/voice-agent/relay-unbooked-handoff.js.
  relay_unbooked_call: {
    label: `${agentName()} call ended without a booking`,
    category: 'missed_call',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true },
    // Same owner ruling as the voicemail bell: a callback number must be
    // dialable. The payload is built by the hand-off module from the
    // PAN-scrubbed call summary, not free model text.
    allowContactDetails: true,
    build: (p) => ({
      title: `${agentName()} call ended without a booking`,
      body: [p.phone ? `Caller: ${p.phone}` : null, p.summary ? String(p.summary).slice(0, 400) : `The caller spoke with ${agentName()}, then the call ended.`]
        .filter(Boolean).join(' - '),
      link: callLink(p),
      ...callButtonAlert({ callLogId: p.callLogId }),
    }),
  },
  // Sandy flagged a caller HOT on capture_lead (an emergency, a swarm, a
  // sting, an angry customer): the urgent page services/voice-agent/
  // relay-alert.js owes the owner, once per call (dedupeKey
  // relay-hot-lead:<CallSid>). Until sweep #7303 B1 it rode the owner-phone
  // internal_alert redirect, whose trigger the bell policy denylists, so the
  // page reached nobody while the caller was told the team was notified.
  relay_hot_lead: {
    label: `Urgent caller on a ${agentName()} call`,
    category: 'new_lead',
    priority: 'urgent',
    group: 'Communication',
    rule: { area: 'Leads', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true },
    adminRoleOnly: true,
    // relay-alert.js composes the page (composeAdminAlert): `alert` carries
    // its structured parts into the row's metadata and `detail` the full text.
    build: (p) => ({
      title: p.title || 'Leads — call back an urgent caller now',
      body: p.body || null,
      ...(p.detail ? { detail: p.detail } : {}),
      link: p.link || '/admin/leads',
      ...(p.alert ? { alert: p.alert } : {}),
    }),
  },
  // The phone page for a re-service Sandy filed (voice-agent/relay-reservice.js,
  // sweep #7303 B1). The ticket's own bell card is written there with
  // bell:true, so relay-alert.js sends this one pushOnly: the bell keeps one
  // row per ticket and the push is the page.
  relay_reservice_filed: {
    label: `${agentName()} filed a re-service`,
    category: 'service',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Schedule', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true },
    adminRoleOnly: true,
    build: (p) => ({
      title: p.title || `Schedule — book the re-service ${agentName()} took`,
      body: p.body || null,
      link: p.link || '/admin/customers',
    }),
  },
  // The phone page for a customer's ask inside the app (GATE_PORTAL_ASK_PUSH, owner 2026-11-02): a portal chat
  // hand-off, a service-request form, the late "Still waiting" re-ring, an estimate page's change or call request.
  // Each of those writes its own admin bell row (raiseAdminAlert, bell:true) and, until now, never rang a phone,
  // so a customer could ask ten times and nobody saw it. services/portal-ask-push.js sends this one pushOnly:
  // the bell keeps one row per ask and this is the page. The text carries the customer's first name and last
  // initial and the ask in a few words, never a phone number or an email.
  portal_ask: {
    label: 'Customer asked in the app',
    category: 'service',
    priority: 'high',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true },
    adminRoleOnly: true,
    build: (p) => ({
      title: p.title || 'Comms - answer a customer who asked in the app',
      body: p.body || null,
      link: p.link || '/admin/communications',
    }),
  },
  // Fired by estimate-converter when a paid acceptance deposit could not be
  // credited to the first invoice — the money sits on the deposit ledger
  // until someone reconciles it manually.
  estimate_deposit_reconcile_needed: {
    label: 'Estimate deposit needs manual reconciliation',
    category: 'system',
    priority: 'high',
    group: 'Alerts',
    rule: { area: 'Billing', severity: 'needs-you', who: 'person', expiryDays: 30 },
    build: (p) => ({
      title: 'Deposit paid but not credited',
      body: `Estimate ${String(p.estimateId || 'unknown').slice(0, 40)}: deposit is on the ledger but the first-invoice credit failed — reconcile manually`,
      link: p.estimateId ? `/admin/estimates?estimateId=${encodeURIComponent(p.estimateId)}` : '/admin/estimates',
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
    rule: { area: 'Comms', severity: 'broken', who: 'claude', expiryDays: 30 },
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
    rule: { area: 'System', severity: 'broken', who: 'claude', expiryDays: 30 },
    build: (p) => ({
      title: 'Service report PDF could not be generated',
      body: `The PDF for ${p.customerName || 'a customer'}'s service report${p.serviceLabel ? ` (${p.serviceLabel})` : ''} failed to render after ${p.attempts || 'multiple'} attempts${p.errorMessage ? ` — ${p.errorMessage}` : ''}. The report link still works; re-render to restore the PDF.`,
      link: p.link || '/admin/dispatch',
    }),
  },
  // Fired by the completion route when the public report token could not be
  // minted for a report-v1 visit. The completion text is WITHHELD on this
  // path (it would otherwise say "your report is ready" and link the portal
  // home), so the customer has heard nothing until an admin re-completes or
  // re-sends.
  service_report_token_mint_failed: {
    // Tech-visible: links to a day-to-day surface (reports) a field tech works in.
    techVisible: true,
    label: 'Service report link could not be minted',
    category: 'system',
    priority: 'high',
    group: 'Alerts',
    rule: { area: 'System', severity: 'broken', who: 'claude', expiryDays: 30 },
    build: (p) => ({
      title: 'Service report link unavailable — completion text withheld',
      body: `${p.customerName || 'A customer'}'s service report link could not be created${p.serviceLabel ? ` (${p.serviceLabel})` : ''}${p.errorMessage ? ` — ${p.errorMessage}` : ''}. No "report ready" text was sent; the closeout is held for retry — retry it from the tech portal.`,
      link: p.link || '/admin/dispatch',
    }),
  },
  // Fired by the completion route when the completion SMS itself failed at
  // the provider (or threw). The route is a ONE-SHOT sender — nothing retries
  // a failed completion text — so without this bell a customer who never got
  // their report/pay-link text is indistinguishable from one who did.
  completion_sms_failed: {
    // Tech-visible: links to a day-to-day surface (reports) a field tech works in.
    techVisible: true,
    label: 'Completion text failed to send',
    category: 'system',
    priority: 'high',
    group: 'Alerts',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', expiryDays: 30 },
    build: (p) => ({
      title: 'Completion text not delivered',
      body: `${p.customerName || 'A customer'} did not receive their completion text${p.serviceLabel ? ` (${p.serviceLabel})` : ''}${p.smsType ? ` [${p.smsType}]` : ''}${p.errorClass ? ` — ${p.errorClass}` : ''}${p.errorMessage ? `: ${p.errorMessage}` : ''}. ${p.resumable === false
        ? 'The closeout finalized without it; retrying the closeout will not re-send — fix the cause first (a bad number on file, an inactive template).'
        : 'Nothing retries it automatically; the closeout is held for retry — retry it from the tech portal.'}`,
      link: p.link || '/admin/dispatch',
    }),
  },
  twilio_failure: {
    label: 'Twilio call/SMS failure',
    category: 'system',
    priority: 'urgent',
    group: 'Communication',
    rule: { area: 'Comms', severity: 'needs-you', who: 'person', expiryDays: 30 },
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
    rule: { area: 'Billing', severity: 'fyi', who: 'person', expiryDays: 7 },
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
    rule: { area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'invoice_paid', closedBy: 'server/services/payment-failed-alert-close.js' },
    // Owner audit 2026-10-01: the headline names WHO ("Billing — Dana Example's $85.00
    // payment failed"), the body says why the processor refused, and the link opens the
    // invoice, else the customer, never the revenue list. A customer with no name on file
    // reaches here as the word "customer" (or a bare phone number, masked downstream).
    build: (p) => {
      const names = require('./admin-alert-names');
      const amount = `$${Number(p.amount || 0).toFixed(2)}`;
      const named = p.customerName && p.customerName !== 'customer' ? p.customerName : 'a customer';
      const reason = String(p.reason || '').replace(/\s+/g, ' ').trim();
      return {
        title: `Billing — ${names.fitAction('Billing', named, [(n) => `${n}'s ${amount} payment failed`])}`,
        // One sentence for the why (the friendly processor message can run to two); the whole
        // reason rides in the detail.
        body: require('./admin-alert-compose').cutAtWord(require('./admin-alert-compose').firstSentence(reason) || 'The processor gave no reason.', 110),
        ...(reason ? { detail: reason } : {}),
        link: p.invoiceId ? `/admin/invoices?invoice=${p.invoiceId}`
          : (p.customerId ? `/admin/customers?customerId=${encodeURIComponent(p.customerId)}` : '/admin/revenue'),
      };
    },
  },
  bill_payment_error: {
    label: 'Bill payment checkout error',
    category: 'payment',
    priority: 'high',
    group: 'Payments',
    rule: { area: 'Billing', severity: 'needs-you', who: 'person', expiryDays: 30 },
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
    rule: { area: 'Billing', severity: 'fyi', who: 'person', expiryDays: 7 },
    build: (p) => ({
      title: p.isFullRefund ? 'Full refund issued' : 'Partial refund issued',
      body: `$${Number(p.amount || 0).toFixed(2)} — ${p.customerName || 'customer'}`,
      link: p.invoiceId ? `/admin/invoices?invoice=${p.invoiceId}` : '/admin/revenue',
    }),
  },
  job_complete: {
    // Tech-visible: links to a day-to-day surface (schedule) a field tech works in.
    techVisible: true,
    // Owner ruling 2026-09-24: 13% of these bells were ever opened — off
    // (bell, push, sound) unless an admin turns it on in Settings.
    quietByDefault: true,
    label: 'Tech marked job complete',
    category: 'service',
    priority: 'low',
    group: 'Field Operations',
    rule: { area: 'Schedule', severity: 'fyi', who: 'person', expiryDays: 7 },
    build: (p) => ({
      title: 'Job complete',
      body: `${p.techName || 'Tech'} finished ${p.serviceName || 'service'} at ${p.customerName || 'customer'}`,
      // The dispatch page opens the visit's detail sheet from ?appointment= on ?date=.
      link: p.serviceId && p.serviceDate
        ? `/admin/dispatch?tab=schedule&date=${encodeURIComponent(p.serviceDate)}&appointment=${encodeURIComponent(p.serviceId)}`
        : '/admin/schedule',
    }),
  },
  estimate_expired: {
    label: 'Estimate(s) expired',
    category: 'estimate',
    priority: 'normal',
    group: 'Leads & Sales',
    rule: { area: 'Estimates', severity: 'needs-you', who: 'person', expiryDays: 30 },
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
    rule: { area: 'Estimates', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true },
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
      // GATE_PORTAL_ITEM_CLOSE: the request row and its customer at the TOP of the bell's metadata (the
      // payload nests under `payload`), so the Portal tab's Mark handled and the relevance sweep find this bell
      // by metadata->>'requestId'. A bell with no request row (a self-applied bundle) carries neither.
      ...bundleRequestAlert(p),
    }),
  },
  one_tap_purchase_completed: {
    label: 'One-tap purchase completed',
    category: 'estimate',
    priority: 'high',
    group: 'Leads & Sales',
    rule: { area: 'Estimates', severity: 'fyi', who: 'person', expiryDays: 7 },
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
    rule: { area: 'System', severity: 'needs-you', who: 'person', expiryDays: 30 },
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
    rule: { area: 'Content', severity: 'broken', who: 'claude', expiryDays: 30 },
    build: (p) => ({
      title: `${p.source || 'SEO'} sync failed`,
      body: `${p.locationName ? p.locationName + ': ' : ''}${p.reason || 'unknown error'}. Check the Sync Health card on the SEO Advisor tab.`,
      link: '/admin/seo?workspace=command&view=advisor',
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
    rule: { area: 'System', severity: 'needs-you', who: 'person', expiryDays: 30 },
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
    rule: { area: 'System', severity: 'broken', who: 'claude', expiryDays: 30 },
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
    rule: { area: 'Content', severity: 'needs-you', who: 'person', expiryDays: 30 },
    build: (p) => {
      const warn = Array.isArray(p.preflightWarnings) && p.preflightWarnings.length
        ? ` Heads up: ${p.preflightWarnings.join('; ')}.`
        : '';
      return {
        title: 'Weekly newsletter draft ready',
        body: `Autopilot drafted "${p.subject || 'Untitled'}" from ${p.eventCount || 0} events.${warn} It is in Newsletter → History.`,
        link: '/admin/newsletter?tab=history',
      };
    },
  },
  newsletter_autopilot_skipped: {
    label: 'Newsletter autopilot skipped (not enough events)',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    rule: { area: 'Content', severity: 'needs-you', who: 'person', expiryDays: 30 },
    build: (p) => ({
      title: 'Newsletter autopilot skipped',
      // p.report is the actionable preflight breakdown (counts + next
      // actions); fall back to the terse reason for legacy callers.
      body: p.report || `${p.reason || 'Not enough approved events'}. Approve more events in the Event Inbox to enable next week's auto-draft.`,
      link: '/admin/newsletter?tab=dashboard',
    }),
  },
  newsletter_proof_sent: {
    label: 'Newsletter proof emailed for approval',
    category: 'newsletter',
    priority: 'normal',
    group: 'Marketing',
    rule: { area: 'Content', severity: 'needs-you', who: 'person', expiryDays: 30 },
    build: (p) => ({
      title: 'Newsletter proof sent — reply APPROVED to send',
      body: `Proof of "${p.subject || 'Untitled'}" emailed to ${p.recipient || 'the owner inbox'}. Reply APPROVED to that email and it sends to ${p.recipientCount ?? '?'} active subscribers; any other reply (or none) leaves it a draft.`,
      link: '/admin/newsletter?tab=history',
    }),
  },
  newsletter_proof_approved: {
    label: 'Newsletter approved via email reply',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    rule: { area: 'Content', severity: 'fyi', who: 'person', expiryDays: 7 },
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
    rule: { area: 'Content', severity: 'needs-you', who: 'person', expiryDays: 30 },
    build: (p) => ({
      title: 'Newsletter proof blocked',
      body: `"${p.subject || 'Untitled'}" did not pass the send gate: ${(Array.isArray(p.errors) ? p.errors : []).join('; ') || 'validation failed'}. Nothing was sent.`,
      link: '/admin/newsletter?tab=history',
    }),
  },
  event_sources_unhealthy: {
    label: 'Event ingestion sources unhealthy',
    category: 'newsletter',
    priority: 'high',
    group: 'Marketing',
    rule: { area: 'Content', severity: 'broken', who: 'claude', expiryDays: 30 },
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
    rule: { area: 'Content', severity: 'needs-you', who: 'either', expiryDays: 30 },
    build: (p) => {
      const count = Number(p.count || p.flagged || 0);
      const entries = Array.isArray(p.entries) ? p.entries : [];
      const visible = entries.slice(0, 4).map((entry) => {
        const title = entry.title || 'Untitled entry';
        const summary = entry.summary || 'Needs review';
        // Generated entries are fixed at their source; say where.
        const where = entry.fixLabel ? ` (fix in ${entry.fixLabel})` : '';
        return `${title}${where}: ${String(summary).slice(0, 180)}`;
      });
      if (count > visible.length) visible.push(`${count - visible.length} more flagged entr${count - visible.length === 1 ? 'y' : 'ies'}`);
      return {
        title: count === 1 ? 'KB audit flagged 1 entry' : `KB audit flagged ${count} entries`,
        body: visible.join('\n') || 'Review flagged knowledge base entries.',
        link: '/admin/kb',
      };
    },
  },
  // The 8:00 AM ET banner (GATE_MORNING_BANNER, owner 2026-11-03 "ok add", choice C): one phone banner that says how many
  // items wait for the owner and opens his alert list. services/morning-banner.js sends it pushOnly, so it writes no bell
  // row (rule: fyi, only the retention sweep would ever close one) and the owner can switch it off in Push Settings. It
  // takes the place of a banner for each of his other action items. p = { count, areas: [{ area, count }], day }.
  waiting_summary: {
    label: 'Morning summary: items waiting for you',
    category: 'alert',
    priority: 'normal',
    group: 'Alerts',
    rule: { area: 'System', severity: 'fyi', who: 'person', expiryDays: 7 },
    build: (p) => {
      // count = unread waiting items (owner 2026-11-04 "fix count"); total = every waiting item, read or not.
      const count = Number(p.count) || 0;
      const total = Number(p.total) || 0;
      const areas = (Array.isArray(p.areas) ? p.areas : []).slice(0, 3);
      const parts = [...areas.map((a) => `${a.area} ${a.count}`), ...(total > count ? [`${total} open in all`] : [])];
      return {
        title: count === 1 ? '1 item waits for you' : `${count} items wait for you`,
        body: parts.join(' \u00b7 ') || null,
        link: '/admin/dashboard?bell=open',
      };
    },
  },
  // The owner's 7 PM open-visit nudge as a phone banner (GATE_OWNER_NUDGE_BANNER, owner 2026-11-04 "banner"): the same words
  // the text carries, a tap opens the tech close-out page. services/tech-open-visit-nudge.js sends it pushOnly to the owner's
  // own admin user, so it writes no bell row (rule: fyi) and the owner can switch it off in Push Settings. p = { headline,
  // lines: [visit line], day }; the nudge module builds the words (customer first name + last initial only).
  open_visits_nudge: {
    label: 'Evening nudge: visits still open',
    category: 'alert',
    priority: 'normal',
    group: 'Alerts',
    rule: { area: 'Schedule', severity: 'fyi', who: 'person', expiryDays: 7 },
    build: (p) => ({
      title: String(p.headline || 'Visits are still open'),
      body: ['Tap to close out.', ...(Array.isArray(p.lines) ? p.lines : []).map(String)].join('\n'),
      link: '/tech',
    }),
  },
};

const PRIORITY_VIBRATE = {
  urgent: [200, 100, 200, 100, 400],
  high:   [200, 100, 200],
  normal: [150],
  low:    [100],
};

function pushTagFor(triggerKey, payload = {}) {
  // A bell banner (bell-banners.js): one tag per bell row, so a refresh ring replaces its own banner.
  if (payload.alertRowId) return `waves-${triggerKey}-${payload.alertRowId}`;
  if (triggerKey === 'new_lead' && payload.twilioSid) {
    return `waves-new_lead-${payload.twilioSid}`;
  }
  if (triggerKey === 'sms_reply') {
    const thread = payload.threadId || 'unknown-thread';
    return `waves-sms_reply-${thread}-${crypto.randomUUID()}`;
  }
  if (triggerKey === 'relay_unbooked_call') {
    return `waves-relay_unbooked_call-${payload.callSid || payload.callLogId || 'unknown-call'}`;
  }
  // One banner per call / per ticket: a second urgent caller's page must not
  // replace the first one's on the phone.
  if (triggerKey === 'relay_hot_lead') {
    return `waves-relay_hot_lead-${payload.callSid || crypto.randomUUID()}`;
  }
  if (triggerKey === 'relay_reservice_filed') {
    return `waves-relay_reservice_filed-${payload.requestId || crypto.randomUUID()}`;
  }
  // One banner per ask: a customer who asks again in the same chat replaces their own banner, and a
  // second customer's ask never replaces the first one's.
  if (triggerKey === 'portal_ask') {
    return `waves-portal_ask-${payload.itemKey || crypto.randomUUID()}`;
  }
  if (triggerKey === 'customer_missed_call') {
    return `waves-customer_missed_call-${payload.callLogId || crypto.randomUUID()}`;
  }
  if (triggerKey === 'repeat_caller') {
    // The persisted delivery identity survives a newer call reclaiming a
    // push-only attempt. Different caller windows still have distinct tags.
    return `waves-repeat_caller-${payload.repeatCallerDeliveryId || payload.callLogId || 'unknown-call'}`;
  }
  if (triggerKey === 'promise_chaser') {
    // Fallback only — the real dispatch path below tags with the bell's own
    // per-day dedupeKey instead, so a same-day repeat callback collapses
    // into one banner even under a push-only preference. Per-promise here
    // too: two different open promises calling back must not collapse.
    return `waves-promise_chaser-${payload.commitmentId || payload.callLogId || 'unknown-call'}`;
  }
  if (triggerKey === 'payment_failed' && (payload.attemptId || payload.paymentIntentId)) {
    // Per-attempt tag: the service worker replaces same-tag pushes with
    // renotify:false, so two customers' failures before the first is
    // dismissed must not collapse into one banner (codex P2 on #4392).
    return `waves-payment_failed-${payload.attemptId || payload.paymentIntentId}`;
  }
  if (triggerKey === 'reservice_self_booked') {
    // Per-visit tag: two customers booking before the first banner is
    // dismissed must not collapse into one (renotify:false in the worker).
    return `waves-reservice_self_booked-${payload.scheduledServiceId || crypto.randomUUID()}`;
  }
  if (triggerKey === 'customer_email_received') {
    // Per-email tag: same-tag pushes replace each other without renotifying,
    // so two customer emails must not collapse into one banner (hook P1).
    return `waves-customer_email_received-${payload.emailId || crypto.randomUUID()}`;
  }
  if (triggerKey === 'customer_voicemail_callback') {
    // Per-call tag: the service worker replaces same-tag pushes with
    // renotify:false, so a static tag would let a second caller's alert
    // silently swallow the first. Stable per call — a reprocess re-push for
    // the SAME call may replace itself.
    return `waves-customer_voicemail_callback-${payload.callLogId || 'unknown-call'}`;
  }
  if (triggerKey === 'customer_landline_from_call') {
    // Per-customer tag: two call-created customers classified as landlines
    // before the office opens the first alert must not collapse into one
    // push (renotify:false in the service worker replaces same-tag pushes).
    // Stable per customer — a re-run for the SAME customer may replace itself.
    return `waves-customer_landline_from_call-${payload.customerId || 'unknown-customer'}`;
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
  if (triggerKey === 'job_applicant_reply') {
    // Distinct per reply (Codex r12 P2): a second text before the first push
    // is dismissed must alert again, not silently replace it (same-tag
    // pushes are renotify:false in the service worker) — like sms_reply.
    return `waves-job_applicant_reply-${payload.applicationId || 'unknown-application'}-${payload.replyId || Date.now()}`;
  }
  if (triggerKey === 'job_interview_booked' || triggerKey === 'job_application_withdrawn') {
    // Per-application tag, same reasoning as new_job_application above — a
    // rebooked time (a second job_interview_booked for the same applicant)
    // may legitimately replace its own earlier push.
    return `waves-${triggerKey}-${payload.applicationId || 'unknown-application'}`;
  }
  if (triggerKey === 'service_report_token_mint_failed' || triggerKey === 'completion_sms_failed') {
    // Per-service-record tag: an outage that fails several completions must
    // not let later customers' banners silently replace earlier ones.
    return `waves-${triggerKey}-${payload.serviceRecordId || 'unknown-record'}`;
  }
  // One banner per ET day: a late or repeated send replaces the same day's banner, and tomorrow's never replaces today's.
  if (triggerKey === 'waiting_summary') {
    return `waves-waiting_summary-${payload.day || 'unknown-day'}`;
  }
  // One nudge banner per technician-day claim: a repeat replaces the same day's banner, tomorrow's never replaces today's.
  if (triggerKey === 'open_visits_nudge') {
    return `waves-open_visits_nudge-${payload.day || 'unknown-day'}`;
  }
  return `waves-${triggerKey}`;
}

/**
 * Fire a notification event. Non-blocking — never throws.
 *
 * @param {string} triggerKey — must match a key in TRIGGER_REGISTRY
 * @param {object} payload — trigger-specific data, see each build() for shape
 */
// A registry event the bell policy just dropped: when it is a fault marked "Claude fixes this"
// (GATE_ALERT_CLAUDE_FAULTS, services/admin-alert-routing.js), write its one row to Claude's queue through the same
// bell write (`writeBell`, so it is keyed like a ring and a retry dedupes), send no push (Claude's queue never pages a
// phone), and return the stats. `policySilenced` stays true: the policy still kept it off the bell.
// null = not rescued, drop as before. Never throws.
async function writeRescuedFault({ trigger, triggerKey, payload, bellMetadata, writeBell, onBell, pushOnly, relayFailureCall }) {
  if (pushOnly || relayFailureCall) return null;
  const metadata = rescueClaudeFault({ category: trigger.category, triggerKey, metadata: bellMetadata, payload });
  if (!metadata) return null;
  let bellWritten = false;
  try {
    const created = await writeBell(metadata);
    bellWritten = Boolean(created && !created.suppressed);
  } catch (e) {
    logger.error(`[notification-triggers] Claude-queue fault write failed: ${e.message}`);
  }
  onBell?.(bellWritten);
  return { bellWritten, push: { sent: 0, skipped: 'claude_queue' }, policySilenced: true, claudeQueue: true };
}

async function triggerNotification(triggerKey, payload = {}, { beforePush = null, relayFailureCall = null, onBell = null, dedupeKey = null, refreshOnDedupe = false, bumpOnRefresh = false, refreshPayload = null, shouldContinue = null, deliveredSubscriptionIds = null, pushOnly = false, adminOnly = false, bellAuthorized = false, onlyUserIds = null } = {}) {
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
      // adminOnly: a caller that sends the owner a banner (bell-banners.js) skips technicians even for a techVisible type.
      if (!trigger.techVisible || adminOnly) recipientQuery = recipientQuery.where({ role: 'admin' });
      activeAdmins = await recipientQuery.select('id', 'role');
      // onlyUserIds: a banner meant for named users (the owner's open-visit nudge) reaches only them; null = everyone.
      if (Array.isArray(onlyUserIds)) {
        const wanted = new Set(onlyUserIds.map(String));
        activeAdmins = activeAdmins.filter((u) => wanted.has(String(u.id)));
      }
      // GATE_TECH_LOGIN_PRIVACY: a technician login gets a customer's alert only
      // for a customer on its own route (technicianServicesCustomer, the rule the
      // Communications routes use). No customer on the event = today's routing.
      const scopeCid = demoCid || payload?.scopeCustomerId;
      if (require('../config/feature-gates').techLoginPrivacyLive?.() && scopeCid && activeAdmins.some((u) => u.role === 'technician')) {
        const { technicianServicesCustomer } = require('./technician-visit-scope');
        const own = await Promise.all(activeAdmins.map(async (u) => {
          if (u.role !== 'technician') return true;
          try {
            return await technicianServicesCustomer({ techRole: 'technician', technicianId: u.id }, scopeCid);
          } catch (e) {
            logger.warn(`[notification-triggers] technician customer scope failed for '${triggerKey}' — skipping that technician (fail closed): ${e.message}`);
            return false;
          }
        }));
        activeAdmins = activeAdmins.filter((u, i) => own[i]);
      }
    } catch (e) {
      logger.warn(`[notification-triggers] technicians query failed: ${e.message}`);
      if (dedupeKey) return { bellWritten: false, push: null, retryable: true };
    }

    const prefsByUser = new Map(prefs.map((p) => [p.admin_user_id, p]));
    // No row = the trigger's default (on, or off for quietByDefault triggers).
    const anyBellEnabled = activeAdmins.some((u) => (prefsByUser.get(u.id) || defaultPreference(trigger)).bell_enabled !== false);
    const pushEnabledIds = activeAdmins
      .filter((u) => (prefsByUser.get(u.id) || defaultPreference(trigger)).push_enabled !== false)
      .map((u) => u.id);
    let bellWritten = false;
    // A dedupe HIT on a trigger whose identity is the dedupeKey itself (not
    // the bell row) means this event already delivered — the push must not
    // repeat either. sms_reply: a concurrent lease winner reaching this
    // dispatcher after the canonical send already delivered. promise_chaser:
    // its sweep is stateless and never retries a push, so a dedupe hit can
    // only be a concurrent dispatch of the same (promise, ET day) that
    // already pushed. property_lookup_canary_failed: keyed per ET day, and a
    // hit is the deploy-kill retry of a run that already alerted.
    // reservice_self_booked: keyed per booking, so a hit is the customer's
    // idempotent replay of a booking whose bell already landed.
    // relay_hot_lead: keyed per call, so a hit is a reconnect's or the
    // hourly sweep's retry of a page that already landed.
    // new_lead, on a thread row only (refreshOnDedupe: an unknown sender's
    // texts to a website line, one row rewritten by each new text): a plain
    // hit there is the same text delivered again, which already pushed.
    let dedupedNoPush = false;
    let bellSuppressed = false;
    // ONE routing decision per event (owner ruling 2026-08-28 — "some are
    // banners, some are bells"): the bell policy is evaluated ONCE per event,
    // independent of any user's bell/push preference, and gates BOTH the
    // bell row and the phone push. Previously the policy ran only inside the
    // bell write, so silenced events (dashboard alerts, internal alerts,
    // silenced categories) still buzzed the phone — and a push-only admin
    // bypassed it entirely (hook P1). Category overrides re-enable both.
    let policySilenced = false;
    // GATE_CUSTOMER_ALERTS_RING: a customer alert (the type's rule declares `contact`/`promise`, or it is
    // bill_payment_error) passes the policy, and its bell write below carries `bell: true` so
    // NotificationService.create's own policy check, which sees only the category and the trigger key, agrees.
    let declaredCustomerAlert = false;
    try {
      const bellPolicy = require('./notification-bell-policy');
      if (bellPolicy.isBellPolicyEnabled()) {
        // bellAuthorized (pushOnly only): the banner for a bell row its writer already rang (bell-banners.js; each writer
        // tags bell: true). The push keeps that answer instead of judging the event again without the tag, so the
        // banner does not depend on GATE_CUSTOMER_ALERTS_RING.
        const authorized = pushOnly && bellAuthorized ? { options: { bell: true } } : {};
        policySilenced = !(await bellPolicy.bellAllowed({ category: trigger.category, triggerKey, declared: trigger.rule, ...authorized }));
        // Guarded: a test that mocks the policy module without the helper keeps today's bell write.
        declaredCustomerAlert = !policySilenced && typeof bellPolicy.ringsAsCustomerAlert === 'function'
          && bellPolicy.ringsAsCustomerAlert({ triggerKey, declared: trigger.rule });
      }
    } catch (err) {
      logger.warn(`[notification-triggers] bell policy check failed: ${err.message}; delivering`);
    }
    // The one bell write, shared by a ring (the loop below) and a rescued Claude fault (writeRescuedFault): the
    // registry's built row under the given metadata, with the caller's dedupe and refresh options.
    const bellMetadata = { ...(built.alert || {}), triggerKey, priority: trigger.priority, payload: safePayload };
    const writeBell = (metadata) => NotificationService.notifyAdmin(
      trigger.category,
      built.title,
      built.body,
      { link: built.link, ...(built.detail ? { detail: built.detail } : {}), metadata,
        ...(declaredCustomerAlert ? { bell: true } : {}),
        ...(dedupeKey ? { dedupeKey } : {}),
        // A standing thread row (sms_reply, one per customer) is rewritten
        // in place by each new message instead of inserting another row.
        ...(dedupeKey && refreshOnDedupe ? { refreshOnDedupe: true, ...(bumpOnRefresh ? { bumpOnRefresh: true } : {}) } : {}),
        // Decided inside notifyAdmin's keyed lock against the row as it stands:
        // refreshPayload(existingRow, existingPayload) -> null | { payload, keepContent }.
        // keepContent: this emission is OLDER than what the row shows, so the
        // row keeps its text, link and position and only its payload (the
        // count) moves, quietly.
        ...(dedupeKey && refreshOnDedupe && typeof refreshPayload === 'function' ? {
          standingRefresh: async (existing, existingMeta) => {
            const base = existingMeta?.payload || {};
            const r = await refreshPayload(existing, base);
            if (!r) return null;
            if (r.keepContent) {
              const kept = { ...base, ...r.payload };
              const rebuilt = sanitizeBuiltNotification(trigger.build(kept), trigger);
              // The row keeps the buttons of the text it still shows, rebuilt from its own payload like its title: an
              // older emission's own buttons (a late CALL text's Call) must not land on it. Always set, because
              // notifyAdmin merges this over the older emission's metadata.
              return { title: rebuilt.title, body: existing.body, link: existing.link, detail: existing.detail ?? undefined, metadata: { payload: kept, buttons: rebuilt.alert?.buttons ?? null }, quiet: true };
            }
            const merged = { ...payload, ...r.payload };
            const rebuilt = sanitizeBuiltNotification(trigger.build(merged), trigger);
            return { title: rebuilt.title, body: rebuilt.body, link: rebuilt.link, detail: rebuilt.detail, metadata: { payload: sanitizeNotificationPayload(triggerKey, merged) } };
          },
        } : {}),
        ...(shouldContinue ? { shouldContinue } : {}),
        ...(relayFailureCall ? { relayFailureCall, dedupeKey: `relay-failure:${relayFailureCall.callSid}` } : {}) }
    );

    if (policySilenced) {
      // GATE_ALERT_CLAUDE_FAULTS (services/admin-alert-routing.js): a fault the registry marks "Claude fixes this" is
      // written to Claude's queue instead of the drop below: one Activity-only row, no ring, no push.
      const rescued = await writeRescuedFault({ trigger, triggerKey, payload, bellMetadata, writeBell, onBell, pushOnly, relayFailureCall });
      if (rescued) return rescued;
      logger.info('[bell-policy] silenced (bell + push)', { triggerKey, category: trigger.category });
      // GATE_ALERT_CATALOG=watch: this return skips NotificationService.create, so the muted record is left here,
      // by the same helper (it reads the gate). A failure costs the record, never the silence; the log has no title.
      try {
        await require('./audit-log').auditBellPolicyMuted({ category: trigger.category, triggerKey, title: built.title });
      } catch (err) {
        logger.warn(`[notification-triggers] muted-alert audit failed: ${err?.code || 'error'}`);
      }
      return { bellWritten: false, push: { sent: 0, skipped: 'bell_policy' }, policySilenced: true };
    }

    let bellRowId = null;
    for (const user of activeAdmins) {
      const userPref = prefsByUser.get(user.id) || defaultPreference(trigger);

      // pushOnly (missed-call push retry): the bell row already exists; only the push is re-sent.
      if (!pushOnly && userPref.bell_enabled && !bellWritten) {
        // Write a single bell entry for "admin" recipients (existing model is shared)
        try {
          // NotificationService.create catches insert errors and returns null
          // (deliberate suppression — internal test customer or the admin
          // bell policy — returns a truthy sentinel with suppressed: true) —
          // bellWritten must reflect the actual outcome, not that the call
          // returned.
          const created = await writeBell(bellMetadata);
          if (created && !created.suppressed) bellWritten = true;
          if (created && !created.suppressed) bellRowId = created.notification?.id || created.id || null;
          // A refresh carries a NEW message onto the standing row: that is not
          // an event that already delivered, so its push still goes.
          if (created?.deduped && !created.refreshed && dedupeKey && (triggerKey === 'sms_reply' || triggerKey === 'promise_chaser' || triggerKey === 'property_lookup_canary_failed' || triggerKey === 'reservice_self_booked' || triggerKey === 'relay_hot_lead' || (triggerKey === 'new_lead' && refreshOnDedupe))) dedupedNoPush = true;
          if (created?.suppressed) bellSuppressed = true;
        } catch (e) {
          logger.error(`[notification-triggers] bell write failed: ${e.message}`);
        }
      }
    }

    const stats = { bellWritten, push: null,
      ...(dedupeKey ? { retryable: anyBellEnabled && !bellWritten && !bellSuppressed } : {}),
    };
    if (shouldContinue && bellSuppressed && !bellWritten) stats.suppressed = true;
    onBell?.(bellWritten); // durable bell result is available before badge lookup or push
    if (dedupedNoPush) return { ...stats, deduped: true };
    if (relayFailureCall && !bellWritten) return stats; // an unclaimed callback never dispatches a push
    // Every active admin turned BOTH channels off: that is deliberate
    // preference suppression, not a delivery failure — report it so
    // callers (bell replay) stop retrying forever (codex #3232 r25).
    if (activeAdmins.length > 0 && !anyBellEnabled && pushEnabledIds.length === 0) {
      stats.suppressed = true;
    }

    // Push: send to all admin/technician subscriptions whose user has push enabled.
    try {
      const enabledUserIds = pushEnabledIds;

      // Caller-supplied last-moment check (e.g. "is the SMS still unread?").
      // Fail open: a throwing check still pushes.
      if (enabledUserIds.length > 0 && typeof beforePush === 'function') {
        const stillWanted = await Promise.resolve(beforePush({ dispatching: false })).catch(() => true);
        if (stillWanted === false) {
          stats.push = { sent: 0, skipped: 'superseded_before_push' };
          return stats;
        }
      }

      if (enabledUserIds.length > 0) {
        const wantsSoundByUser = new Map(
          activeAdmins.map((u) => {
            const pref = prefsByUser.get(u.id);
            return [u.id, !pref || pref.sound_enabled !== false];
          })
        );

        // App-icon badge (installed-PWA Badging API / APNs aps.badge): mirror
        // EXACTLY what the bell's /unread-count returns — persisted unread
        // plus live dashboard alerts after this admin's dismissals
        // (admin-unread.js, shared with the route) — computed per recipient
        // because dismissal state is per admin, and AFTER the bell write
        // above so the triggering notification is included. The badge is
        // garnish and the push is the product: the count runs the
        // dashboard-alert aggregate battery (cold memo when the PWA is
        // closed — exactly the inbound-SMS case) plus a per-admin ordering
        // lock, so it is raced against a hard timeout and any
        // failure/timeout OMITS the badge (icon left untouched) rather
        // than delaying delivery or sending a wrong number. The snapshot's
        // `at` stamp comes from the DB clock inside that lock (see
        // admin-unread.js) so overlapping snapshots can't hand the older
        // count the newer stamp — the service worker keeps the highest.
        // Lazy require: admin-unread pulls in dashboard-alerts-cron, which
        // requires this module back — a top-level require would cycle.
        const { getUnreadCountForAdmin } = require('./admin-unread');
        const BADGE_COUNT_TIMEOUT_MS = 1500;
        const BADGE_TIMED_OUT = Symbol('badge-timeout');
        // Admin-role recipients only: techVisible triggers (sms_reply) also
        // push to technicians, but the app-icon badge is scoped to the
        // installed Waves Admin PWA — techs keep the banner, no badge field.
        const badgeByUser = new Map();
        await Promise.all(
          activeAdmins
            .filter((u) => u.role === 'admin' && enabledUserIds.includes(u.id))
            .map(async (user) => {
              let timer;
              // queued: this is the unbounded fan-out path, so it goes
              // through admin-unread's process-wide chain; abandoned lets
              // the chain drop this task unstarted once the race below
              // has already given up on it.
              let abandoned = false;
              const snapshot = await Promise.race([
                getUnreadCountForAdmin(
                  { adminUserId: user.id, role: user.role },
                  { queued: true, abandoned: () => abandoned },
                ).catch((e) => {
                  logger.warn(`[notification-triggers] badge count failed for admin ${user.id}: ${e.message}`);
                  return null;
                }),
                new Promise((resolve) => { timer = setTimeout(resolve, BADGE_COUNT_TIMEOUT_MS, BADGE_TIMED_OUT); }),
              ]);
              clearTimeout(timer);
              if (snapshot === BADGE_TIMED_OUT) {
                abandoned = true;
                logger.warn(`[notification-triggers] badge count timed out for admin ${user.id} — sending push without badge`);
                return;
              }
              if (snapshot && Number.isInteger(snapshot.count) && Number.isFinite(snapshot.at)) {
                badgeByUser.set(user.id, { count: snapshot.count, at: snapshot.at });
              }
            })
        );

        // Second look right before the send: the badge fan-out above can take
        // up to ~1.5s and a thread opened in that window must not buzz (P2).
        // The push service runs it after its subscription lookup, so a
        // durable claim taken here is only burned when a handoff follows.
        const beforeDispatch = typeof beforePush === 'function'
          ? () => Promise.resolve(beforePush({ dispatching: true })).catch(() => true)
          : null;
        // The Call action on the Waves Admin push (alert-call-button.js): the row this emission wrote, when it
        // carries a Call button, for admin-role recipients only (the bell runs buttons for admins only).
        const pushCall = bellRowId
          ? await require('./alert-call-button').pushCallAction(bellRowId).catch((e) => {
            logger.warn(`[notification-triggers] push call action skipped: ${e.message}`);
            return null;
          })
          : null;
        const adminRoleIds = new Set(activeAdmins.filter((u) => u.role === 'admin').map((u) => u.id));
        stats.push = await PushService.sendToAdminUsers(
          enabledUserIds,
          (adminUserId) => {
            const wantsSound = wantsSoundByUser.get(adminUserId);
            const badgeInfo = badgeByUser.get(adminUserId);
            return {
              title: built.title,
              body: built.body,
              url: built.link || '/admin',
              // promise_chaser: the push tag IS the bell's own dedupeKey
              // (already 'waves-promise_chaser-<commitment>-<ET day>') so a
              // same-day repeat callback on the same open promise collapses
              // into the same banner even on a push-only preference, where
              // notifyAdmin's own dedupe lock is never reached below.
              tag: triggerKey === 'sms_reply' && dedupeKey
                ? `waves-sms_reply-${payload.twilioSid}`
                : (triggerKey === 'promise_chaser' && dedupeKey ? dedupeKey : pushTagFor(triggerKey, payload)),
              priority: trigger.priority,
              vibrate: wantsSound ? PRIORITY_VIBRATE[trigger.priority] : [0],
              silent: !wantsSound,
              // iPhone: a per-alert sound file (alert-sounds.js), only when the admin's Sound switch is on.
              ...(wantsSound && soundForTrigger(triggerKey) ? { sound: soundForTrigger(triggerKey) } : {}),
              // portal_ask: every push is an ask that is new or rang again (portal-ask-push.js callers), so a repeat on
              // the same tag (the customer asked again in the same chat) must alert again, not silently replace the
              // banner. The admin's sound preference still holds (silent/vibrate above).
              renotify: (triggerKey === 'sms_reply' && !dedupeKey) || (triggerKey === 'new_lead' && Boolean(payload.twilioSid)) || triggerKey === 'portal_ask' || Boolean(payload.alertRowId),
              ...(badgeInfo ? { badge: badgeInfo.count, badgeAt: badgeInfo.at } : {}),
              ...(pushCall && adminRoleIds.has(adminUserId) ? pushCall : {}),
            };
          },
          { beforeDispatch, ...(deliveredSubscriptionIds ? { deliveredSubscriptionIds } : {}) },
        );
        if (dedupeKey && stats.push?.failed > 0) stats.retryable = true;
        if (stats.push?.superseded) stats.push = { sent: 0, skipped: 'superseded_before_push' };
      }
    } catch (e) {
      logger.error(`[notification-triggers] push dispatch failed: ${e.message}`);
      // A resumed event owns its retry: a failure before any handoff (the
      // subscription lookup) must not read as a delivered push.
      if (dedupeKey) { stats.push = null; stats.retryable = true; stats.error = e.message; }
    }
    return stats;
  } catch (err) {
    logger.error(`[notification-triggers] dispatch failed for ${triggerKey}: ${err.message}`);
    return { bellWritten: false, push: null, error: err.message };
  }
}

// The preference an admin WITHOUT a notification_preferences row gets.
// quietByDefault triggers (job_complete) are off on every channel until an
// admin turns them on; everything else defaults on (unchanged behavior).
function defaultPreference(trigger) {
  const on = !trigger?.quietByDefault;
  return { bell_enabled: on, push_enabled: on, sound_enabled: on };
}

function listTriggers() {
  return Object.entries(TRIGGER_REGISTRY).map(([key, t]) => ({
    key, label: t.label, group: t.group, priority: t.priority, quietByDefault: t.quietByDefault === true,
  }));
}

module.exports = {
  triggerNotification,
  listTriggers,
  defaultPreference,
  TRIGGER_REGISTRY,
  __private: {
    maskEmail,
    maskPhone,
    pushTagFor,
    PRIORITY_VIBRATE,
    redactSensitiveText,
    sanitizeBuiltNotification,
    sanitizeNotificationPayload,
  },
};
