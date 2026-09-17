/**
 * Source guard: every "recent messages" read of sms_log must exclude
 * unresolved send reservations, or be explicitly allowlisted with a reason.
 *
 * Codex #4331 P2 stack — six rounds each found ANOTHER general reader
 * (conversation history, outbound counts, composer/estimator/LLM context)
 * that loaded sms_log without excludeUnresolvedSendReservations
 * (server/services/messaging/review-ask-reservation.js) and so could
 * present an in-flight review-ask or reply reservation (a synthetic
 * 'sending' row) to a human or model as a message that was actually
 * delivered. This guard is the structural stop for that class: every site
 * this scan finds is either wired through the shared helper, or is in
 * ALLOWLIST with a reason the exclusion genuinely does not apply there
 * (already scoped to a status/direction/message_type/twilio_sid the
 * reservation marker can never match, a single-row lookup by id, or not a
 * live reader at all).
 *
 * WIDENED (codex #4333 P2, GitHub round, "exclude reservations from the
 * voice corpus"): the original shape below caught six rounds of "latest N
 * messages" readers, but sms-voice-corpus-miner.js's reply-mining query was
 * a plain status/message_type filter with NO orderBy+limit at all — a
 * genuinely different shape carrying the exact same risk. Detection now
 * flags a `sms_log` table-call window for ANY of:
 *   (a) the original shape — chains BOTH `.orderBy(` and `.limit(`;
 *   (b) a WRITE-CLASSIFIED statement (its nearest verb is insert/update/
 *       del/delete) is exempt from (c) and (d) below — an insert or a
 *       where-scoped update/delete doesn't present rows to anyone, it only
 *       writes them;
 *   (c) a non-write statement whose window references `message_body`,
 *       `direction: 'outbound'`, or `message_type` — the corpus miner's own
 *       shape (a content/outbound/type-bearing SELECT with no orderBy or
 *       limit at all);
 *   (d) a non-write statement with a `.where(` chain that is not a
 *       single-row lookup by id (i.e. not `.where({ id })` / `.where('id',
 *       …)` alone) — any other predicate-scoped read.
 * A site is compliant when `excludeUnresolvedSendReservations` appears
 * (called directly, or passed by reference to `.modify(...)`) anywhere in
 * that same window — otherwise ALLOWLIST is the only way through, and a
 * stale or newly-unmatched entry fails its own check below.
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'migrations', '__tests__', 'coverage', 'dist']);
const WINDOW_SPAN = 15;

// Explicit exemptions. Each entry names the exact file + line the scan
// reports and why the exclusion genuinely does not apply. Default is ZERO —
// every OTHER unwrapped site fails.
const ALLOWLIST = [
  {
    file: 'routes/twilio-webhook.js',
    line: 1677,
    reason: 'inbound-only (where from_phone = the opting-out customer\'s own number) — every send reservation (review-ask or reply) is Waves\' own outbound row, so its from_phone can never match a customer\'s number here.',
  },
  {
    file: 'scripts/backfill-comms-pr2.js',
    line: 79,
    reason: 'one-off historical backfill script (ops tooling, run manually once, idempotent on re-run) — not a live reader feeding a human or a model.',
  },
  {
    file: 'scripts/backfill-comms-pr2.js',
    line: 88,
    reason: 'same one-off historical backfill script as line 79 (the paged batch read).',
  },
  {
    file: 'services/completion-comms-guard.js',
    line: 191,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/completion-comms-guard.js',
    line: 199,
    reason: 'filtered to CONFIRMED_OUTBOUND_STATUS, which excludes \'sending\' — an unresolved reservation cannot match this status filter.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    line: 65,
    reason: 'inbound-only count (direction: \'inbound\') — a send reservation is always an outbound row; the outbound-count query a few lines below already uses the helper.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    line: 74,
    reason: 'inbound-only message read (direction: \'inbound\') feeding sentiment mining — a send reservation is always an outbound row.',
  },
  {
    file: 'services/recipient-optin.js',
    line: 476,
    reason: 'single-row lookup (.first(\'status\')) — not a list read; the .limit( this scan\'s window sees belongs to the enclosing, unrelated recipient_optin sweep query above it.',
  },
  {
    file: 'services/messaging/deferred-replay-registry.js',
    line: 1319,
    reason: 'whereIn(status, [blocked, failed, cancelled]) excludes \'sending\' — an unresolved reservation cannot match this status filter.',
  },
  {
    file: 'services/messaging/sync-optout.js',
    line: 65,
    reason: 'from_phone = the opting-out customer\'s own number — every send reservation is Waves\' own outbound row and can never match a customer\'s from_phone.',
  },
  {
    file: 'services/outbound-call-reason.js',
    line: 146,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },

  // ─── Added by the widened-detection sweep (codex #4333 P2, GitHub round)
  // that followed the sms-voice-corpus-miner.js gap. Every entry below was
  // classified by hand against the reservation invariants enforced in
  // review-ask-reservation.js: a send reservation is ALWAYS direction
  // 'outbound', status 'sending' until resolved, message_type one of
  // 'review' / 'manual' / 'ai_autosent', and never carries a twilio_sid
  // until promoted (at which point it IS real delivery evidence, not a
  // placeholder). A site that structurally cannot match any of those is
  // listed here instead of wrapped; a site whose window intentionally
  // needs to see reservations (ask-spacing, in-flight-reply evidence, the
  // reservation sweep itself) says so explicitly.
  {
    file: 'routes/admin-communications.js',
    line: 144,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'routes/admin-communications.js',
    line: 3273,
    reason: 'status filtered to \'scheduled\', which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/admin-communications.js',
    line: 3365,
    reason: 'status filtered to queued/sent/delivered, which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/admin-communications.js',
    line: 957,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/admin-import-sheets.js',
    line: 58,
    reason: 'from_phone matches the imported customer\'s own number (this route always inserts direction: \'inbound\' rows) — a send reservation\'s from_phone is always one of Waves\' own numbers, never a customer\'s.',
  },
  {
    file: 'routes/admin-projects.js',
    line: 3726,
    reason: 'status filtered to queued/sent/delivered, which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/admin-projects.js',
    line: 3739,
    reason: 'metadata key (report_hold_release_key) is exclusive to this project\'s own report-hold-release claim rows — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'routes/admin-workflows.js',
    line: 53,
    reason: 'message_type restricted to \'reactivation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'routes/estimate-public.js',
    line: 24926,
    reason: 'message_type restricted to \'estimate_service_details\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'routes/stripe-webhook.js',
    line: 5686,
    reason: 'metadata key (stripe_payment_intent_id (+ stripe_event_id)) is exclusive to this ACH-failure-replay notice probe — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'routes/twilio-webhook.js',
    line: 105,
    reason: 'status filtered to queued/sent/delivered (see the window text), which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/twilio-webhook.js',
    line: 1203,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row. (also keyed by twilio_sid, which a reservation never has).',
  },
  {
    file: 'routes/twilio-webhook.js',
    line: 1582,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    line: 1590,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    line: 1826,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    line: 1868,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    line: 1997,
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'scripts/backfill-lead-activities-from-sms.js',
    line: 76,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'scripts/replay-estimate-conversion-agent.js',
    line: 70,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/appointment-reminders.js',
    line: 143,
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/appointment-reminders.js',
    line: 3692,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/call-commitments.js',
    line: 1158,
    reason: 'message_type restricted to \'confirmation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/call-commitments.js',
    line: 1233,
    reason: 'status filtered to queued/sent/delivered, which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/call-recording-processor.js',
    line: 14521,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/call-recording-processor.js',
    line: 15041,
    reason: 'message_type restricted to \'confirmation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/call-recording-processor.js',
    line: 15299,
    reason: 'message_type restricted to \'confirmation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/campaign-drafts-gate.js',
    line: 148,
    reason: 'message_type restricted to CAMPAIGN_SMS_TYPES (upsell / renewal / reactivation / retention_outreach / retention), disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/collections/consent-provenance.js',
    line: 58,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/contact-correction-queue.js',
    line: 386,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row. (also keyed by twilio_sid in the same window).',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    line: 272,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    line: 285,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/dropped-call-sms.js',
    line: 312,
    reason: 'message_type restricted to this file\'s own MESSAGE_TYPE constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/dropped-call-sms.js',
    line: 644,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/intelligence-bar/comms-tools.js',
    line: 304,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/intelligence-bar/comms-tools.js',
    line: 841,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/intelligence-bar/dashboard-tools.js',
    line: 1181,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row. (also status-scoped in the same window).',
  },
  {
    file: 'services/invoice.js',
    line: 3039,
    reason: 'metadata key (entry_point = \'invoice_send_deferred\') is exclusive to this deferred pay-link SMS claim — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'services/invoice.js',
    line: 5198,
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/invoice.js',
    line: 5256,
    reason: 'metadata key (entry_point IN (…deferred entry points…)) is exclusive to this deferred-dispatch SMS claim — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'services/lawn-intelligence.js',
    line: 202,
    reason: 'metadata key (entry_point = \'lawn_assessment_notification_deferred\') is exclusive to this deferred lawn-notification claim — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'services/lead-scorer.js',
    line: 16,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/messaging/landline-suppression.js',
    line: 103,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/new-recurring-welcome-sms.js',
    line: 596,
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/outbound-call-reason.js',
    line: 238,
    reason: 'message_type restricted to ARRIVAL_TEXT_TYPES (tech_en_route / tech_arrived), disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/outbound-voicemail-sms.js',
    line: 164,
    reason: 'message_type restricted to this file\'s own MESSAGE_TYPE constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/recipient-optin.js',
    line: 416,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder. (also message_type-scoped to a non-reservation type in the same window).',
  },
  {
    file: 'services/review-ask-history.js',
    line: 100,
    reason: 'deliberately includes in-flight review-ask/reply reservations as ask-spacing evidence (the REBUTTED FINDING note at the top of review-ask-reservation.js) — excluding them here would break the spacing guarantee this function exists to provide.',
  },
  {
    file: 'services/review-request.js',
    line: 3058,
    reason: 'status explicitly excludes \'sending\' in its own whereNotIn list (evidence of DELIVERY, not an in-flight attempt) — an unresolved reservation cannot match.',
  },
  {
    file: 'services/review-request.js',
    line: 3087,
    reason: 'status explicitly excludes \'sending\' in its own whereNotIn list, same as the stamped-evidence lookup just above it — an unresolved reservation cannot match.',
  },
  {
    file: 'services/review-request.js',
    line: 825,
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/scheduler.js',
    line: 4123,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder. (also status-scoped in the same window).',
  },
  {
    file: 'services/sms-additional-properties.js',
    line: 116,
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-additional-properties.js',
    line: 126,
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-auto-send.js',
    line: 595,
    reason: 'this IS the reply-reservation reconciliation sweep itself (settles manual_send_reservation / auto_send_reservation rows; review-ask reservations are explicitly excluded from it) — applying the exclusion helper here would hide the very rows this sweep exists to find and release.',
  },
  {
    file: 'services/sms-operational-actions.js',
    line: 284,
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-operational-actions.js',
    line: 381,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-operational-actions.js',
    line: 483,
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-operational-actions.js',
    line: 538,
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-operational-actions.js',
    line: 593,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-backfill.js',
    line: 172,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-backfill.js',
    line: 240,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-judge.js',
    line: 353,
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/sms-shadow-judge.js',
    line: 369,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-judge.js',
    line: 401,
    reason: 'status filtered to SENT_STATUSES (queued/sent/delivered), which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/sms-suggest-mode.js',
    line: 186,
    reason: 'status filtered to SENT_STATUSES (queued/sent/delivered), which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/sms-suggest-mode.js',
    line: 195,
    reason: 'deliberately includes in-flight reservations — a manual/auto reply reservation IS a real send in progress, and hiding it would let a competing suggestion publish over an active send. A reservation stuck at \'sending\' is the stranded-send reconciliation\'s problem, not this check\'s.',
  },
  {
    file: 'services/sms-suggest-mode.js',
    line: 204,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-suggest-mode.js',
    line: 370,
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-voice-corpus-miner.js',
    line: 307,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-voice-corpus-miner.js',
    line: 321,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/voicemail-lead-sms.js',
    line: 176,
    reason: 'message_type restricted to this file\'s own MESSAGE_TYPE constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/voicemail-lead-sms.js',
    line: 445,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    line: 136,
    reason: 'message_type restricted to \'balance_reminder\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    line: 519,
    reason: 'message_type restricted to \'late_payment\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    line: 526,
    reason: 'message_type restricted to \'late_payment\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    line: 747,
    reason: 'message_type restricted to this cooldown check\'s own message_type constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/payment-expiry.js',
    line: 277,
    reason: 'message_type restricted to \'payment_expiry\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/referral-nudge.js',
    line: 20,
    reason: 'message_type restricted to \'referral_nudge\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/renewal-reminder.js',
    line: 83,
    reason: 'message_type restricted to \'renewal\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
];

function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// A bare table-call — db/knex/trx/conn/database('sms_log') or '...as alias'.
const TABLE_CALL = /\b(?:db|knex|trx|conn|database)\(\s*(['"`])sms_log(?:\s+as\s+\w+)?\1/;

// The three shapes a NON-write statement is flagged for — see the WIDENED
// block in the header comment. A write (insert/update/del/delete) is never
// flagged by (b)/(c): it doesn't present rows to a reader, it writes them.
const MESSAGE_BODY_RE = /\bmessage_body\b/;
const OUTBOUND_RE = /direction['"`]?\s*[:,]\s*['"`]outbound['"`]/;
const MESSAGE_TYPE_RE = /\bmessage_type\b/;
// The nearest knex verb after the table call decides write vs. read. Scoped
// to just this statement (up to its own terminating `;`) so an unrelated
// verb elsewhere in the window can't misclassify it.
const VERB_RE = /\.(insert|update|del|delete|select|first|pluck|count|sum|max|min)\(/g;
function isWriteOperation(lines, idx) {
  let text = '';
  for (let i = idx; i < Math.min(lines.length, idx + WINDOW_SPAN); i++) {
    text += lines[i] + '\n';
    if (/;\s*$/.test(lines[i].trimEnd())) break;
  }
  let firstVerb = null;
  let m;
  VERB_RE.lastIndex = 0;
  while ((m = VERB_RE.exec(text))) {
    if (firstVerb === null) firstVerb = m[1];
  }
  if (!firstVerb) return false; // no explicit verb → implicit knex select
  return ['insert', 'update', 'del', 'delete'].includes(firstVerb);
}
// A `.where(` call whose ONLY predicate is `id` (object-shorthand, explicit
// key, or positional) — a single-row lookup, not a list read.
function isIdOnlyWhereCall(call) {
  return /\{\s*id\s*(:|\})/.test(call) || /\(\s*['"`]id['"`]\s*,/.test(call);
}
function hasNonIdWhereChain(window) {
  const whereCalls = window.match(/\.where\([^)]*\)/g) || [];
  if (!whereCalls.length) return false;
  return !whereCalls.every(isIdOnlyWhereCall);
}
// Compliant when the helper is either called directly
// (`excludeUnresolvedSendReservations(query)`) or passed by reference to
// `.modify(...)` (`.modify(excludeUnresolvedSendReservations)`) — both are
// live usages in this codebase; a plain identifier match after comments are
// already stripped can only come from actual code, not prose about it.
const HELPER_RE = /\bexcludeUnresolvedSendReservations\b/;

let cachedCandidates = null;
function findCandidates() {
  if (cachedCandidates) return cachedCandidates;
  const candidates = [];
  for (const abs of walk(SERVER_ROOT)) {
    const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
    if (rel === 'services/messaging/review-ask-reservation.js') continue; // the definition itself
    const src = fs.readFileSync(abs, 'utf8');
    if (!src.includes('sms_log')) continue;
    const lines = stripComments(src).split('\n');
    lines.forEach((line, idx) => {
      if (!TABLE_CALL.test(line)) return;
      // A few lines BACKWARD too: `excludeUnresolvedSendReservations(` often
      // opens on its own line just before a multi-line `.where(...)` filter
      // forces the table call onto the next one.
      const start = Math.max(0, idx - 3);
      const window = lines.slice(start, Math.min(lines.length, idx + WINDOW_SPAN)).join('\n');
      const originalShape = /\.orderBy\(/.test(window) && /\.limit\(/.test(window);
      const write = isWriteOperation(lines, idx);
      const touchesOutboundContent = !write
        && (MESSAGE_BODY_RE.test(window) || OUTBOUND_RE.test(window) || MESSAGE_TYPE_RE.test(window));
      const nonIdWhereChain = !write && hasNonIdWhereChain(window);
      if (!originalShape && !touchesOutboundContent && !nonIdWhereChain) return;
      candidates.push({
        file: rel,
        line: idx + 1,
        snippet: line.trim(),
        compliant: HELPER_RE.test(window),
      });
    });
  }
  cachedCandidates = candidates;
  return candidates;
}

function isAllowed(c) {
  return ALLOWLIST.some((a) => a.file === c.file && a.line === c.line);
}

describe('sms_log general-reader source guard (codex #4331)', () => {
  test('the shared exclusion helper still exports what this guard requires', () => {
    const reservation = require('../services/messaging/review-ask-reservation');
    expect(typeof reservation.excludeUnresolvedSendReservations).toBe('function');
  });

  test('finds the known reader shape (self-check on a synthetic fixture)', () => {
    // Guards against a regex/window regression silently turning this guard
    // into a no-op that always passes.
    const fixtureCompliant = "const rows = await excludeUnresolvedSendReservations(db('sms_log').where({ customer_id: id }))\n  .orderBy('created_at', 'desc')\n  .limit(5);";
    const fixtureRaw = "const rows = await db('sms_log').where({ customer_id: id })\n  .orderBy('created_at', 'desc')\n  .limit(5);";
    const scan = (src) => {
      const lines = src.split('\n');
      const idx = lines.findIndex((l) => TABLE_CALL.test(l));
      const window = lines.slice(idx, idx + WINDOW_SPAN).join('\n');
      return { found: idx >= 0, compliant: HELPER_RE.test(window) };
    };
    expect(scan(fixtureCompliant)).toEqual({ found: true, compliant: true });
    expect(scan(fixtureRaw)).toEqual({ found: true, compliant: false });
  });

  test('the widened shapes are genuinely detected (self-check on synthetic fixtures, codex #4333 P2)', () => {
    // (1) The corpus-miner shape itself: no orderBy/limit at all, just an
    // outbound + message_type filter — this is exactly what escaped the
    // ORIGINAL (narrower) guard.
    const minerShapeRaw = "const rows = await db('sms_log')\n  .where('direction', 'outbound')\n  .where('message_type', 'manual')\n  .select('id', 'message_body');";
    const minerShapeFixed = "const rows = await excludeUnresolvedSendReservations(db('sms_log')\n  .where('direction', 'outbound')\n  .where('message_type', 'manual'))\n  .select('id', 'message_body');";
    // (2) `.modify(excludeUnresolvedSendReservations)` — a bare function
    // reference, not a call — must still read as compliant.
    const modifyRefFixed = "const rows = await db('sms_log')\n  .where('direction', 'outbound')\n  .modify(excludeUnresolvedSendReservations)\n  .select('id');";
    // (3) A non-id where chain with no body/outbound/type token anywhere —
    // still flagged, since it's still a predicate-scoped read.
    const nonIdWhereRaw = "const row = await db('sms_log').where({ customer_id: id }).first();";
    // (4) A write (insert) that happens to mention message_type/outbound in
    // its payload must NOT be flagged — it's a write, not a read.
    const insertNotFlagged = "await db('sms_log').insert({ direction: 'outbound', message_type: 'manual', message_body: body });";
    // (5) A single-row lookup by id must NOT be flagged.
    const idOnlyNotFlagged = "const row = await db('sms_log').where({ id: smsLogId }).first();";

    const evaluate = (src) => {
      const lines = src.split('\n');
      const idx = lines.findIndex((l) => TABLE_CALL.test(l));
      if (idx < 0) return { found: false };
      const start = Math.max(0, idx - 3);
      const window = lines.slice(start, Math.min(lines.length, idx + WINDOW_SPAN)).join('\n');
      const originalShape = /\.orderBy\(/.test(window) && /\.limit\(/.test(window);
      const write = isWriteOperation(lines, idx);
      const touchesOutboundContent = !write
        && (MESSAGE_BODY_RE.test(window) || OUTBOUND_RE.test(window) || MESSAGE_TYPE_RE.test(window));
      const nonIdWhereChain = !write && hasNonIdWhereChain(window);
      const flagged = originalShape || touchesOutboundContent || nonIdWhereChain;
      return { found: true, flagged, compliant: flagged && HELPER_RE.test(window) };
    };

    expect(evaluate(minerShapeRaw)).toEqual({ found: true, flagged: true, compliant: false });
    expect(evaluate(minerShapeFixed)).toEqual({ found: true, flagged: true, compliant: true });
    expect(evaluate(modifyRefFixed)).toEqual({ found: true, flagged: true, compliant: true });
    expect(evaluate(nonIdWhereRaw)).toEqual({ found: true, flagged: true, compliant: false });
    expect(evaluate(insertNotFlagged)).toEqual({ found: true, flagged: false, compliant: false });
    expect(evaluate(idOnlyNotFlagged)).toEqual({ found: true, flagged: false, compliant: false });
  });

  test('every "latest N messages" sms_log read either uses the shared helper or is explicitly allowlisted', () => {
    const candidates = findCandidates();
    const violations = candidates.filter((c) => !c.compliant && !isAllowed(c));
    const message = violations
      .map((v) => `  server/${v.file}:${v.line}  ${v.snippet}`)
      .join('\n');
    if (violations.length) {
      throw new Error(
        `Unwrapped sms_log "latest N messages" read(s) found — an unresolved send reservation ` +
        `('sending', a synthetic placeholder) can be presented as a delivered message.\n` +
        `Wrap the query in excludeUnresolvedSendReservations(...) from ` +
        `server/services/messaging/review-ask-reservation.js BEFORE .orderBy()/.limit(), ` +
        `or add the site to ALLOWLIST in this test with a one-line reason the exclusion ` +
        `genuinely does not apply (e.g. already direction/status-scoped so a reservation ` +
        `structurally cannot match, or not a live reader).\n` +
        `Offending site(s):\n${message}\n` +
        `(Codex #4331 — this exact class of gap has recurred across six review rounds on this stack.)`,
      );
    }
    expect(violations).toEqual([]);
  });

  test('every ALLOWLIST entry still matches a real (still-unwrapped) candidate — no stale entries', () => {
    const candidates = findCandidates();
    for (const entry of ALLOWLIST) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(10);
      const hit = candidates.find((c) => c.file === entry.file && c.line === entry.line);
      if (!hit) {
        throw new Error(`ALLOWLIST entry server/${entry.file}:${entry.line} no longer matches any candidate site — remove it.`);
      }
      if (hit.compliant) {
        throw new Error(`ALLOWLIST entry server/${entry.file}:${entry.line} now uses the shared helper directly — remove the now-redundant entry.`);
      }
    }
  });
});
