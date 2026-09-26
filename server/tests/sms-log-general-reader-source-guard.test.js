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

// Explicit exemptions. Keyed on `file` + a stable `snippet` (the exact,
// trimmed source line of the table-call statement — see findCandidates
// below) instead of a line number: a line-number key churns on every
// unrelated edit above it (every child branch merge-down, every future
// PR touching the file, even a merge from main into this branch), forcing
// a line-number chase on code this guard never actually cares about
// (codex #4333 P2, GitHub round, "the guard's own line-number churn" —
// confirmed on CI: main's independent edits since this branch's
// merge-base shifted a dozen already-allowlisted lines and broke every
// one of them under the old line key). `nth` disambiguates the rare case
// where the exact same snippet text occurs more than once in one file
// (1-based, in source order) — omit it when the snippet is unique in its
// file. Each entry's reason says why the exclusion genuinely does not
// apply. Default is ZERO — every OTHER unwrapped site fails.
const ALLOWLIST = [
  {
    file: 'services/messaging/push-channel-routing.js',
    snippet: "? await trx('sms_log').where({ customer_id: customerId, from_phone: 'push' }).where(function sameNotice() {",
    reason: 'persistPushProof: existence check for this accepted push notice before writing its proof; a send reservation is never a push proof.',
  },
  {
    file: 'services/messaging/push-channel-routing.js',
    snippet: ": await trx('sms_log').where({ customer_id: customerId, from_phone: 'push', message_type: row.message_type, created_at: row.created_at }).first('id');",
    reason: 'persistPushProof: idempotency check on the proof row\'s own acceptance instant; a send reservation is never a push proof.',
  },
  {
    file: 'services/billing-retry-email-obligation.js',
    snippet: "const existing = await trx('sms_log')",
    reason: 'Exact billing_retry_email_key lookup owns queue deduplication across every status; it never presents a reservation as delivered contact history.',
  },
  {
    file: 'services/billing-retry-email-obligation.js',
    snippet: "let query = database('sms_log').where({ id, status: 'sending' });",
    reason: 'This is a guarded metadata UPDATE of the exact claimed queue row, not a message-history read; excluding the sending row would discard provider-start evidence.',
  },
  {
    file: 'services/sms-reply-alert-delivery.js',
    snippet: "const prior = await db('sms_log')",
    reason: "inbound-only (direction: 'inbound', from_phone = the unknown sender) repeat-receipt check — a send reservation is always Waves' own outbound row and can never match an inbound sender's from_phone.",
  },
  {
    file: 'services/sms-reply-alert-delivery.js',
    snippet: "const row = await db('sms_log').where({ direction: 'inbound', twilio_sid: MessageSid }).first('metadata')",
    reason: "single-row inbound lookup keyed by the inbound MessageSid (direction: 'inbound') — a send reservation is always an outbound row, so it structurally cannot match.",
  },
  {
    file: 'services/scheduled-sms-delivery.js',
    snippet: "const row = await db('sms_log').where({ direction: 'outbound' })",
    reason: 'status-scoped to queued / sent / delivered, which excludes sending, so an unresolved reservation structurally cannot match; it is also keyed to one scheduled row by scheduled_sms_log_id.',
  },
  {
    file: 'services/review-request.js',
    snippet: 'const reservationRow = await db("sms_log")',
    reason: 'reservation-lifecycle bookkeeping, not a general reader: looks a review-ask reservation up BY its own marker to mark a stuck one release_pending for the stranded-send sweep; excluding reservations here would hide the very rows it exists to process (same class as the sms-auto-send sweep).',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'const inbound = await trx(\'sms_log\')',
    reason: 'inbound-only (where from_phone = the opting-out customer\'s own number) — every send reservation (review-ask or reply) is Waves\' own outbound row, so its from_phone can never match a customer\'s number here.',
  },
  {
    file: 'scripts/backfill-comms-pr2.js',
    snippet: 'const total = await db(\'sms_log\')',
    reason: 'one-off historical backfill script (ops tooling, run manually once, idempotent on re-run) — not a live reader feeding a human or a model.',
  },
  {
    file: 'scripts/backfill-comms-pr2.js',
    snippet: 'const batch = await db(\'sms_log\')',
    reason: 'same one-off historical backfill script as the total-count query above (the paged batch read).',
  },
  {
    file: 'services/completion-comms-guard.js',
    snippet: 'const inboundRows = await knex(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/completion-comms-guard.js',
    snippet: 'const outboundRows = await knex(\'sms_log\')',
    reason: 'filtered to CONFIRMED_OUTBOUND_STATUS, which excludes \'sending\' — an unresolved reservation cannot match this status filter.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    snippet: 'const recentInbound = await db(\'sms_log\')',
    reason: 'inbound-only count (direction: \'inbound\') — a send reservation is always an outbound row; the outbound-count query a few lines below already uses the helper.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    snippet: 'const smsMessages = await db(\'sms_log\')',
    reason: 'inbound-only message read (direction: \'inbound\') feeding sentiment mining — a send reservation is always an outbound row.',
  },
  {
    file: 'services/recipient-optin.js',
    snippet: 'const lastAsk = await db(\'sms_log\')',
    reason: 'single-row lookup (.first(\'status\')) — not a list read; the .limit( this scan\'s window sees belongs to the enclosing, unrelated recipient_optin sweep query above it.',
  },
  {
    file: 'services/messaging/deferred-replay-registry.js',
    snippet: 'rows = await db(\'sms_log\')',
    reason: 'whereIn(status, [blocked, failed, cancelled]) excludes \'sending\' — an unresolved reservation cannot match this status filter.',
  },
  {
    file: 'services/messaging/sync-optout.js',
    snippet: 'const inbound = await trx(\'sms_log\')',
    reason: 'from_phone = the opting-out customer\'s own number — every send reservation is Waves\' own outbound row and can never match a customer\'s from_phone.',
  },
  {
    file: 'services/outbound-call-reason.js',
    snippet: 'db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'routes/admin-communications.js',
    snippet: 'const newerInbound = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'routes/admin-communications.js',
    snippet: 'const scheduled = await db(\'sms_log\')',
    reason: 'status filtered to \'scheduled\', which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/admin-communications.js',
    snippet: 'const sentSibling = await trx(\'sms_log\')',
    reason: 'status filtered to queued/sent/delivered, which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/admin-communications.js',
    snippet: 'const logged = outcome.providerMessageId && await db(\'sms_log\')',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/admin-import-sheets.js',
    snippet: 'const existing = await db(\'sms_log\')',
    reason: 'from_phone matches the imported customer\'s own number (this route always inserts direction: \'inbound\' rows) — a send reservation\'s from_phone is always one of Waves\' own numbers, never a customer\'s.',
  },
  {
    file: 'routes/admin-projects.js',
    snippet: 'return db(\'sms_log\')',
    reason: 'status filtered to queued/sent/delivered, which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/admin-projects.js',
    snippet: 'let claim = await db(\'sms_log\')',
    reason: 'metadata key (report_hold_release_key) is exclusive to this project\'s own report-hold-release claim rows — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'routes/admin-workflows.js',
    snippet: 'const recentReactivations = await db(\'sms_log\')',
    reason: 'message_type restricted to \'reactivation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'routes/estimate-public.js',
    snippet: 'const recentPacketSend = async () => db(\'sms_log\')',
    reason: 'message_type restricted to \'estimate_service_details\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'routes/stripe-webhook.js',
    snippet: 'const probeQueued = db(\'sms_log\')',
    reason: 'metadata key (stripe_payment_intent_id (+ stripe_event_id)) is exclusive to this ACH-failure-replay notice probe — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'const sent = await db(\'sms_log\')',
    reason: 'status filtered to queued/sent/delivered (see the window text), which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'const prior = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row. (also keyed by twilio_sid, which a reservation never has).',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'let logRow = await trx(\'sms_log\').where({ twilio_sid: MessageSid }).first(\'customer_id\', \'created_at\', \'metadata\');',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'logRow = await trx(\'sms_log\').where({ twilio_sid: MessageSid }).first(\'customer_id\', \'created_at\', \'metadata\');',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'void db(\'sms_log\').where({ twilio_sid: MessageSid }).first()',
    nth: 1,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'void db(\'sms_log\').where({ twilio_sid: MessageSid }).first()',
    nth: 2,
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'routes/twilio-webhook.js',
    snippet: 'const last = await db(\'sms_log\')',
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'scripts/backfill-lead-activities-from-sms.js',
    snippet: 'const rows = await db(\'sms_log\')',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'scripts/replay-estimate-conversion-agent.js',
    snippet: 'const q = db(\'sms_log as s\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/appointment-reminders.js',
    snippet: 'const delivered = await db(\'sms_log\')',
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/appointment-reminders.js',
    snippet: 'const bounceLog = sid ? await trx(\'sms_log\').where({ twilio_sid: sid }).first(\'created_at\', \'metadata\') : null;',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/call-commitments.js',
    snippet: 'const sms = await conn("sms_log")',
    reason: 'message_type restricted to \'confirmation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/call-commitments.js',
    snippet: 'const text = await conn("sms_log as os")',
    reason: 'status filtered to queued/sent/delivered, which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/call-recording-processor.js',
    snippet: 'confirmationDelivered = await db(\'sms_log\')',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/call-recording-processor.js',
    snippet: 'const existing = await db(\'sms_log\')',
    reason: 'message_type restricted to \'confirmation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/call-recording-processor.js',
    snippet: 'const recentDup = await db(\'sms_log\')',
    reason: 'message_type restricted to \'confirmation\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/campaign-drafts-gate.js',
    snippet: 'const recentCampaignSms = await db(\'sms_log\')',
    reason: 'message_type restricted to CAMPAIGN_SMS_TYPES (upsell / renewal / reactivation / retention_outreach / retention), disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/collections/consent-provenance.js',
    snippet: 'return db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/contact-correction-queue.js',
    snippet: '? await knex(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row. (also keyed by twilio_sid in the same window).',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    snippet: 'const inbound = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    snippet: 'const recentMessages = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/dropped-call-sms.js',
    snippet: 'const prior = await db(\'sms_log\')',
    reason: 'message_type restricted to this file\'s own MESSAGE_TYPE constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/dropped-call-sms.js',
    snippet: 'const row = await db(\'sms_log\')',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/intelligence-bar/comms-tools.js',
    snippet: 'const inbound = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/intelligence-bar/comms-tools.js',
    snippet: 'const lastInbound = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/intelligence-bar/dashboard-tools.js',
    snippet: 'db(\'sms_log\').where({ direction: \'inbound\' }).where(function () {',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row. (also status-scoped in the same window).',
  },
  {
    file: 'services/invoice.js',
    snippet: 'const existingQueued = await db("sms_log")',
    reason: 'metadata key (entry_point = \'invoice_send_deferred\') is exclusive to this deferred pay-link SMS claim — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'services/invoice.js',
    snippet: 'const deferredRows = await trx("sms_log")',
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/invoice.js',
    snippet: 'const dispatchingNow = await trx("sms_log")',
    reason: 'metadata key (entry_point IN (…deferred entry points…)) is exclusive to this deferred-dispatch SMS claim — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'services/lawn-intelligence.js',
    snippet: 'const existing = await trx(\'sms_log\').where({ customer_id: customer.id })',
    reason: 'metadata key (entry_point = \'lawn_assessment_notification_deferred\') is exclusive to this deferred lawn-notification claim — a review-ask/reply reservation never sets it, regardless of any status/direction overlap.',
  },
  {
    file: 'services/lead-scorer.js',
    snippet: 'const inboundSms = await db(\'sms_log\').where({ customer_id: customerId, direction: \'inbound\' }).count(\'* as count\').first();',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/messaging/landline-suppression.js',
    snippet: 'const row = await trx(\'sms_log\').where({ twilio_sid: sid }).first(\'created_at\', \'metadata\');',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/new-recurring-welcome-sms.js',
    snippet: ': await db(\'sms_log\')',
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/outbound-call-reason.js',
    snippet: 'const arrivalText = await db(\'sms_log\')',
    reason: 'message_type restricted to ARRIVAL_TEXT_TYPES (tech_en_route / tech_arrived), disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/outbound-voicemail-sms.js',
    snippet: 'const prior = await db(\'sms_log\')',
    reason: 'message_type restricted to this file\'s own MESSAGE_TYPE constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/recipient-optin.js',
    snippet: 'const priorSendRow = await db(\'sms_log\')',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder. (also message_type-scoped to a non-reservation type in the same window).',
  },
  {
    file: 'services/review-ask-history.js',
    snippet: 'const rows = await db(\'sms_log\')',
    reason: 'deliberately includes in-flight review-ask/reply reservations as ask-spacing evidence (the REBUTTED FINDING note at the top of review-ask-reservation.js) — excluding them here would break the spacing guarantee this function exists to provide.',
  },
  {
    file: 'services/review-request.js',
    snippet: 'const stamped = await db("sms_log")',
    reason: 'status explicitly excludes \'sending\' in its own whereNotIn list (evidence of DELIVERY, not an in-flight attempt) — an unresolved reservation cannot match.',
  },
  {
    file: 'services/review-request.js',
    snippet: 'const evidence = await db("sms_log")',
    reason: 'status explicitly excludes \'sending\' in its own whereNotIn list, same as the stamped-evidence lookup just above it — an unresolved reservation cannot match.',
  },
  {
    file: 'services/review-request.js',
    snippet: 'const rows = await db("sms_log")',
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/sms-additional-properties.js',
    snippet: 'const message = await conn(\'sms_log\').where({ id: smsLogId }).first();',
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-additional-properties.js',
    snippet: 'const live = await trx(\'sms_log\').where({ id: message.id }).forUpdate().first();',
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-auto-send.js',
    snippet: "const anchor = await trx('sms_log').where({ id: smsLogId, direction: 'inbound' })",
    reason: 'single-row inbound lookup for the gratitude thread lock; an outbound send reservation cannot match the id plus inbound direction predicate.',
  },
  {
    file: 'services/sms-auto-send.js',
    snippet: 'reservationsCleared = await db(\'sms_log\')',
    reason: 'this IS the reply-reservation reconciliation sweep itself (settles manual_send_reservation / auto_send_reservation rows; review-ask reservations are explicitly excluded from it) — applying the exclusion helper here would hide the very rows this sweep exists to find and release.',
  },
  {
    file: 'services/sms-operational-actions.js',
    snippet: 'const source = await trx(\'sms_log\').modify(withoutScheduledDeliveryTwins, \'sms_log\')',
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-operational-actions.js',
    snippet: 'const candidates = await conn(\'sms_log as s\').modify(withoutScheduledDeliveryTwins, \'s\').where(\'s.created_at\', \'>=\', since).where(\'s.created_at\', \'<=\', now)',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-operational-actions.js',
    snippet: 'const source = await trx(\'sms_log\').where({ id: initial.sms_log_id }).forUpdate().first();',
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-operational-actions.js',
    snippet: 'const source = customer && await scheduledSourceMessage(trx, await trx(\'sms_log\').where({ id: message.id }).forUpdate().first());',
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-operational-actions.js',
    snippet: 'const message = await conn(\'sms_log as s\').where({ \'s.id\': smsLogId, \'s.direction\': \'inbound\' })',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-backfill.js',
    snippet: 'return db(\'sms_log as i\')',
    nth: 1,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-backfill.js',
    snippet: 'return db(\'sms_log as i\')',
    nth: 2,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-judge.js',
    snippet: 'const outbounds = await db(\'sms_log\')',
    reason: 'status filtered to a set that excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/sms-shadow-judge.js',
    snippet: 'const inboundBoundaries = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-shadow-judge.js',
    snippet: 'const correctedSends = await db(\'sms_log\')',
    reason: 'status filtered to SENT_STATUSES (queued/sent/delivered), which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/sms-suggest-mode.js',
    snippet: 'const answered = await trx(\'sms_log\')',
    reason: 'status filtered to SENT_STATUSES (queued/sent/delivered), which excludes \'sending\' — an unresolved reservation cannot match (once promoted to \'sent\' it is real delivery evidence by design, not a reservation).',
  },
  {
    file: 'services/sms-suggest-mode.js',
    snippet: 'const replyInFlight = await trx(\'sms_log\')',
    reason: 'deliberately includes in-flight reservations — a manual/auto reply reservation IS a real send in progress, and hiding it would let a competing suggestion publish over an active send. A reservation stuck at \'sending\' is the stranded-send reconciliation\'s problem, not this check\'s.',
  },
  {
    file: 'services/sms-suggest-mode.js',
    snippet: 'const newerInbound = await trx(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-suggest-mode.js',
    snippet: 'const inbound = await trx(\'sms_log\').where({ id: smsLogId }).first(\'created_at\', \'from_phone\');',
    reason: 'single-row lookup by id — not a list read.',
  },
  {
    file: 'services/sms-voice-corpus-miner.js',
    snippet: 'const inbounds = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/sms-voice-corpus-miner.js',
    snippet: 'const followups = await db(\'sms_log\')',
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/voicemail-lead-sms.js',
    snippet: 'const prior = await db(\'sms_log\')',
    reason: 'message_type restricted to this file\'s own MESSAGE_TYPE constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/voicemail-lead-sms.js',
    snippet: 'const row = await db(\'sms_log\')',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    snippet: 'const smsHistory = await db("sms_log")',
    reason: 'message_type restricted to \'balance_reminder\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    snippet: '|| await db(\'sms_log\').where({ customer_id: customer.id, message_type: \'late_payment\' })',
    reason: 'message_type restricted to \'late_payment\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    snippet: 'const prevCount = await db("sms_log")',
    reason: 'message_type restricted to \'late_payment\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    snippet: 'const sentRecently = await db("sms_log")',
    reason: 'message_type restricted to \'late_payment\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/balance-reminder.js',
    snippet: 'const recentReminder = await db("sms_log")',
    reason: 'message_type restricted to this cooldown check\'s own message_type constant, disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/payment-expiry.js',
    snippet: 'const recentNotice = await db(\'sms_log\')',
    reason: 'message_type restricted to \'payment_expiry\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/referral-nudge.js',
    snippet: 'const recentNudge = await db(\'sms_log\')',
    reason: 'message_type restricted to \'referral_nudge\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/workflows/renewal-reminder.js',
    snippet: 'const recent = await db(\'sms_log\')',
    reason: 'message_type restricted to \'renewal\', disjoint from every reservation message_type (review / manual / ai_autosent) — a reservation can never match this filter.',
  },
  {
    file: 'services/reschedule-link-promises.js',
    snippet: 'const messages = await conn(\'sms_log\').where({ customer_id: context.customer.id, direction: \'outbound\' })',
    reason: 'requires .whereNotNull(\'twilio_sid\') in the same statement — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder (status overlaps \'sending\', but the twilio_sid requirement is the true disqualifier).',
  },
  {
    file: 'services/reschedule-link-promises.js',
    snippet: 'const sms = await conn(\'sms_log\').where({ twilio_sid: row.provider_message_id })',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
  },
  {
    file: 'services/reschedule-link-promises.js',
    snippet: 'const sms = await conn(\'sms_log\').where({ twilio_sid: row.provider_message_id }).first(\'id\', \'status\');',
    reason: 'keyed by twilio_sid — a send reservation never has one until it is promoted to a real send, at which point it is legitimate delivery evidence, not a placeholder.',
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

// 1-based position of `target` among all candidates sharing its exact
// file + snippet, ordered by line ascending — this is what `nth` addresses.
function occurrenceIndex(allCandidates, target) {
  const siblings = allCandidates
    .filter((c) => c.file === target.file && c.snippet === target.snippet)
    .sort((a, b) => a.line - b.line);
  return siblings.findIndex((c) => c.line === target.line) + 1;
}

function isAllowed(c, allCandidates) {
  return ALLOWLIST.some((a) => {
    if (a.file !== c.file || a.snippet !== c.snippet) return false;
    return occurrenceIndex(allCandidates, c) === (a.nth || 1);
  });
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
    const violations = candidates.filter((c) => !c.compliant && !isAllowed(c, candidates));
    const message = violations
      .map((v) => `  server/${v.file}:${v.line}  ${v.snippet}`)
      .join('\n');
    if (violations.length) {
      throw new Error(
        `Unwrapped sms_log "latest N messages" read(s) found — an unresolved send reservation ` +
        `('sending', a synthetic placeholder) can be presented as a delivered message.\n` +
        `Wrap the query in excludeUnresolvedSendReservations(...) from ` +
        `server/services/messaging/review-ask-reservation.js BEFORE .orderBy()/.limit(), ` +
        `or add the site to ALLOWLIST in this test as { file, snippet, reason } — snippet is ` +
        `the exact trimmed source line printed below (add nth if that same snippet occurs ` +
        `more than once in the file) — with a one-line reason the exclusion genuinely does ` +
        `not apply (e.g. already direction/status-scoped so a reservation structurally cannot ` +
        `match, or not a live reader).\n` +
        `Offending site(s) (file:line shown for reference; ALLOWLIST keys on file+snippet, not line):\n${message}\n` +
        `(Codex #4331 — this exact class of gap has recurred across six review rounds on this stack.)`,
      );
    }
    expect(violations).toEqual([]);
  });

  test('every ALLOWLIST entry still matches a real (still-unwrapped) candidate — no stale entries', () => {
    const candidates = findCandidates();
    const seenKeys = new Set();
    for (const entry of ALLOWLIST) {
      expect(typeof entry.file).toBe('string');
      expect(typeof entry.snippet).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(10);
      const nth = entry.nth || 1;
      const key = `${entry.file} ${entry.snippet} ${nth}`;
      if (seenKeys.has(key)) {
        throw new Error(`Duplicate ALLOWLIST entry for server/${entry.file} snippet "${entry.snippet}"${entry.nth ? ` (nth=${entry.nth})` : ''} — one of these two is masking a different, still-unwrapped site.`);
      }
      seenKeys.add(key);
      const siblings = candidates
        .filter((c) => c.file === entry.file && c.snippet === entry.snippet)
        .sort((a, b) => a.line - b.line);
      const hit = siblings[nth - 1];
      if (!hit) {
        throw new Error(
          `ALLOWLIST entry server/${entry.file} snippet "${entry.snippet}"${entry.nth ? ` (nth=${entry.nth})` : ''} ` +
          `no longer matches any candidate site (found ${siblings.length} occurrence(s) of this ` +
          `snippet in the file) — remove it or fix its nth.`,
        );
      }
      if (hit.compliant) {
        throw new Error(`ALLOWLIST entry server/${entry.file}:${hit.line} "${entry.snippet}" now uses the shared helper directly — remove the now-redundant entry.`);
      }
    }
  });
});
