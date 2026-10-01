/**
 * Why did we place this outbound call? — deterministic reason resolver for
 * the voicemail text-back (services/outbound-voicemail-sms.js).
 *
 * Scoped by the owner 2026-09-08 from 60 days of real outbound calls: the
 * only reasons the data supports naming to a customer, in priority order:
 *
 *   quote_request   the web quote-form auto-bridge (call_log.source) — they
 *                   just submitted a quote request; or a manual follow-up
 *                   call to someone who submitted a web quote form inside
 *                   the last 48h (a leads row from the form / website_quote
 *                   channel, or our own bridge call — the bridge does not
 *                   fire after hours, so the lead row is the primary signal).
 *
 *   Suppression (not a reason): nonServiceCaller() — the call we are
 *   returning was classified as something other than a service contact
 *   (other / spam / robocall / wrong number / vendor / job applicant — the
 *   audit's example: a stranger reporting a Waves van parked too close at
 *   Walmart). Owner ruling 2026-09-09: those callers get no text at all.
 *
 *   Suppression (not a reason): visitInProgress() — the technician is en
 *   route to or on site at this customer right now. Those calls are about
 *   finding the address or getting access; the customer just received the
 *   en-route / arrived texts, and a "returning your call" or "quote request"
 *   text would be wrong. The send layer skips the text entirely.
 *   returning_call  a callback of a specific inbound call
 *                   (call_log.metadata.relatedCallId, set by the call-log
 *                   Call button), or the most recent inbound call from them
 *                   inside the lookback (spam / robocall / wrong-number /
 *                   vendor natures excluded).
 *   saw_text        an inbound text from them inside the lookback — a real
 *                   message, not a one-word acknowledgement ("Ok", "1",
 *                   "Great! Thank you", a bare emoji, an empty MMS) or a
 *                   reschedule-option reply; the audit over real calls
 *                   showed those producing "Saw your text" for nothing.
 *   generic         nothing we can honestly name — "Sorry we missed you."
 *
 * When several of {inbound call, inbound text, quote bridge} fall inside
 * their lookbacks, the most recent wins (that is what the office was
 * reacting to).
 * Estimate follow-ups, visit reminders, service requests and billing were
 * deliberately left out (owner ruling). No model call; plain queries only.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isSmsReaction } = require('./sms-intent');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { etDateString } = require('../utils/datetime-et');
// The SAME customer-originated first_contact_channel allowlist the
// collections consent-provenance module uses (codex pre-push r4 P1 on PR
// #5012): a staff-created lead row (admin manual entry, tech field
// observation, tech-run lawn diagnostic) proves a staffer typed a number,
// never that its owner contacted Waves — reused verbatim, never a second
// allowlist that could drift from it.
const { CUSTOMER_ORIGINATED_LEAD_CHANNELS } = require('./collections/consent-provenance');
// Canonical "not a real lead engagement" set (codex pre-push r7 P1): the
// same array the dashboard KPIs and lead-attribution's conversion-rate
// scoping already use to keep spam/duplicate/cancelled rows out of the
// prospect population — reused verbatim here so a lead marked spam or a
// duplicate-wizard repeat can never stand in as prior-contact evidence.
// NANP-vs-international identity (codex pre-push r7 P1): the SAME rule the
// repo already uses everywhere else two phone strings are compared for
// "same contact" (smsThreadKey, the blocked-numbers query) — a non-NANP
// number never collapses to a bare last-10 (codex #4213: a shared-suffix
// international number wrongly matched an unrelated NANP customer). Used
// ONLY inside hasPriorContact below; the file's other probes keep last10()
// unchanged — they were reviewed and approved in earlier rounds and are out
// of scope for this fix.
const { phoneIdentityKey } = require('../utils/phone');

const REASONS = Object.freeze({
  QUOTE_REQUEST: 'quote_request',
  RETURNING_CALL: 'returning_call',
  SAW_TEXT: 'saw_text',
  GENERIC: 'generic',
});

const QUOTE_REQUEST_SOURCES = new Set(['lead-webhook-auto-bridge']);
// leads.first_contact_channel values written by the web quote funnels.
const QUOTE_FORM_CHANNELS = new Set(['form', 'website_quote']);
// Reply types that are answers to OUR texts, never a message to call back about.
const IGNORED_TEXT_TYPES = new Set(['reschedule_reply']);
const TEXT_SCAN_LIMIT = 25;
const VISIT_IN_PROGRESS_STATUSES = ['en_route', 'on_site'];
const VISIT_IN_PROGRESS_WINDOW_MS = 3 * 60 * 60 * 1000;
// The customer-facing arrival texts — phone-keyed, so they cover a call row
// with no linked customer and a visit row with no en_route_at/arrived_at stamp.
const ARRIVAL_TEXT_TYPES = ['tech_en_route', 'tech_arrived'];
// Same set context-aggregator uses to keep junk calls out of customer context.
const NON_CONTACT_NATURES = new Set(['spam_solicitation', 'robocall', 'wrong_number', 'vendor_or_partner']);
// Natures that mean "not a customer or prospect contacting us about service"
// — returning such a call never earns a text (owner ruling 2026-09-09).
const NON_SERVICE_NATURES = new Set([...NON_CONTACT_NATURES, 'other', 'job_applicant']);
// The call natures that POSITIVELY mean a customer or prospect called us
// about service (the schema's call_nature enum). hasPriorContact's call
// probe is an allowlist of these (codex r8 P1): a null nature (indeterminate),
// silent_or_noise, voicemail_message, other, and every non-service nature
// fail closed, so a call we can't positively classify never grants implied
// consent.
const SERVICE_CONTACT_NATURES = Object.freeze(['new_lead', 'existing_customer_service', 'existing_customer_scheduling', 'billing_question']);
// call_log.disposition non-service verdicts (codex pre-push r6 P1): an
// OLDER inbound row from before V2 call_nature extraction shipped has no
// nature at all (COALESCE above reads it as '', which passes the nature
// filter) but can still carry a DEFINITIVE terminal disposition from
// server/services/call-disposition.js's decideDisposition ruling it a
// non-service contact. No exported subset of TERMINAL_DISPOSITIONS exists
// there (call-self-audit.js's own local LEAD_LOSING list is the closest
// precedent — same pattern, a different purpose, and it also lists
// voicemail_processed/cancellation_processed, which ARE service contacts,
// so it is not reusable here). This module's own test file cross-checks
// every literal below against the live TERMINAL_DISPOSITIONS enum so a
// rename there fails a test instead of drifting silently.
const NON_SERVICE_DISPOSITIONS = ['vendor_logged', 'wrong_number_closed', 'spam_discarded', 'no_action_needed'];
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// hasPriorContact's evidence probes match a STORED column against a NANP
// identityKey by last-10 suffix — codex pre-push r7 P1 (second finding):
// the last-10 suffix alone lets a stored INTERNATIONAL number whose full
// digit string merely ENDS in the same 10 digits as identityKey pass, the
// exact shared-suffix collision phoneIdentityKey exists to prevent (codex
// #4213), just on the stored side instead of the requested side. Requiring
// the stored column's own full digit string to be NANP-shaped too (bare 10
// digits, or 11 starting with 1) closes that — an international row can
// never satisfy it, whatever its suffix. This is an ADDED AND'd condition
// on the SAME `right(regexp_replace(...),10) = ?` expression migration
// 20260927000006's indexes were built for, so those indexes are still used
// for the equality half; no new migration is required.
function nanpStoredPhoneClause(column) {
  // {0,1} not a bare `?` (codex pre-push r7 P1, on push): knex's raw-query
  // binding parser counts every `?` character in the SQL TEXT as a
  // positional placeholder, including one sitting inside a quoted regex
  // literal — it is not quote-aware. A literal `?` here would make knex
  // expect 2 bindings for this single-binding clause and throw
  // "Expected 1 bindings, saw 2" on every real compile, which the JS mock
  // (which never actually compiles SQL) could not catch.
  return `right(regexp_replace(${column}, '\\D', '', 'g'), 10) = ? AND regexp_replace(${column}, '\\D', '', 'g') ~ '^1{0,1}\\d{10}$'`;
}

function parseMetadata(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata === 'string' && metadata) {
    try { return JSON.parse(metadata) || {}; } catch { return {}; }
  }
  return {};
}

function callNature(row) {
  const enriched = row?.ai_extraction_enriched;
  const obj = typeof enriched === 'string' ? (() => { try { return JSON.parse(enriched); } catch { return null; } })() : enriched;
  return String(obj?.call_nature || '').trim().toLowerCase();
}

// "From them" predicate shared by the call and text probes: the linked
// customer when the row has one, otherwise the dialed number's last 10.
function fromContact(qb, { customerId, phoneLast10, phoneColumn }) {
  return qb.where(function contact() {
    if (customerId) this.where('customer_id', customerId);
    if (phoneLast10) {
      const clause = db.raw(`right(regexp_replace(${phoneColumn}, '\\D', '', 'g'), 10) = ?`, [phoneLast10]);
      if (customerId) this.orWhere(clause); else this.where(clause);
    }
    if (!customerId && !phoneLast10) this.whereRaw('false');
  });
}

async function relatedInboundCall(relatedCallId) {
  if (!relatedCallId || relatedCallId === 'undefined') return null;
  const row = await whereNotSandboxCall(db('call_log')
    .where({ id: relatedCallId, direction: 'inbound' }))
    .first('id', 'created_at', 'ai_extraction_enriched');
  if (!row) return null;
  if (NON_CONTACT_NATURES.has(callNature(row))) return null;
  return row;
}

async function latestInboundCall({ customerId, phoneLast10, before, since }) {
  const rows = await fromContact(
    whereNotSandboxCall(db('call_log')
      .where('direction', 'inbound')
      .where('created_at', '<', before)
      .where('created_at', '>=', since)),
    { customerId, phoneLast10, phoneColumn: 'from_phone' },
  )
    .orderBy('created_at', 'desc')
    .limit(5)
    .select('id', 'created_at', 'ai_extraction_enriched');
  return rows.find((r) => !NON_CONTACT_NATURES.has(callNature(r))) || null;
}

// A text worth saying "saw your text" about: has words, is not a bare
// acknowledgement / emoji reaction, and is not a reply to a reschedule menu.
function isSubstantiveText(row) {
  if (IGNORED_TEXT_TYPES.has(String(row?.message_type || ''))) return false;
  const body = String(row?.message_body || '').trim();
  if (!body || !/[a-z]/i.test(body)) return false;
  if (isSmsReaction(body)) return false;
  // Short courtesy closers with no content ("ok", "thanks", "great thank you").
  if (/^(ok(ay)?|k|yes|no|yep|nope|sure|great|thanks?|thank you|ty|got it|sounds good|perfect|will do|1|2)[\s!.]*(thanks?|thank you)?[\s!.]*$/i.test(body)) return false;
  return true;
}

async function latestInboundText({ customerId, phoneLast10, before, since }) {
  // An applicant's hiring reply on a phone that is also a customer's must
  // not become the "saw your text" this customer call is about (Codex
  // #4623 r31 P2): recruiting rows are excluded before the substantive pick.
  const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
  const rows = await fromContact(
    db('sms_log')
      .where('direction', 'inbound')
      .where('created_at', '<', before)
      .where('created_at', '>=', since),
    { customerId, phoneLast10, phoneColumn: 'from_phone' },
  )
    .modify((qb) => excludeRecruitingSmsLog(qb, 'message_type'))
    .orderBy('created_at', 'desc')
    // A thread of acknowledgements can be long ("Ok" / "Thanks" / a thumbs-up
    // per reminder); the real inquiry must still be reachable behind them.
    .limit(TEXT_SCAN_LIMIT)
    .select('id', 'created_at', 'message_body', 'message_type');
  return rows.find(isSubstantiveText) || null;
}

// A web quote-form lead from them inside the lookback (the form's own row —
// fires even when the after-hours bridge did not).
async function latestQuoteFormLead({ customerId, phoneLast10, before, since }) {
  return fromContact(
    db('leads')
      .whereNull('deleted_at')
      .whereIn('first_contact_channel', [...QUOTE_FORM_CHANNELS])
      .where('created_at', '<', before)
      .where('created_at', '>=', since),
    { customerId, phoneLast10, phoneColumn: 'phone' },
  )
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

// Call-derived first_contact_channel values (codex pre-push r5 P1): the
// call pipeline (call-recording-processor.js Step 4b, lead-attribution.js's
// attributeInboundContact) writes 'call' for EVERY phone-call-minted lead —
// voicemail-sourced leads included, per call-recording-processor.js's own
// comment ("first_contact_channel stays 'call'") — regardless of the call's
// DIRECTION. A lead minted from a COLD OUTBOUND call we placed gets the
// exact same 'call' value as one from a genuine inbound call, so it would
// otherwise pass CUSTOMER_ORIGINATED_LEAD_CHANNELS and wrongly count as
// "the person contacted us". Verified exhaustively (grep
// `first_contact_channel:` across server/): 'call' is the ONLY value any
// call/voicemail source writes anywhere in the repo — no separate
// 'voicemail' or 'phone_call' variant exists. Phone calls count as prior
// contact ONLY through existsQualifyingInboundCall above, which is
// direction-aware (`.where('direction', 'inbound')`) — never through a
// lead row here.
const CALL_DERIVED_LEAD_CHANNELS = new Set(['call']);
// The lead-evidence allowlist for THIS module: customer-originated (reused
// from consent-provenance.js) MINUS anything call-derived — computed once,
// not per query.
const LEAD_EVIDENCE_CHANNELS = CUSTOMER_ORIGINATED_LEAD_CHANNELS.filter(
  (channel) => !CALL_DERIVED_LEAD_CHANNELS.has(channel)
);

// Any CUSTOMER-ORIGINATED, NON-CALL-DERIVED lead row for this phone (not
// scoped to the form/quote channels latestQuoteFormLead checks) — "a lead
// record" in the owner's own list of what counts as prior contact
// (2026-09-26, outbound return-message gate).
async function anyLeadRecord({ phoneLast10, before, conn = db }) {
  if (!phoneLast10) return null;
  return conn('leads')
    .whereNull('deleted_at')
    .where('created_at', '<', before)
    .whereRaw(nanpStoredPhoneClause('phone'), [phoneLast10])
    // Customer-originated AND non-call-derived (codex pre-push r4 P1 + r5
    // P1): a lead this module counted before included 'manual' /
    // 'field_observation' / 'lawn_diagnostic' rows (staffer typed a
    // number) and 'call' rows minted from a COLD OUTBOUND call (see
    // CALL_DERIVED_LEAD_CHANNELS above) — neither proves the number's
    // owner ever contacted Waves. whereIn also fails closed on a NULL or
    // unrecognized channel (it matches no IN list, never a wildcard).
    .whereIn('first_contact_channel', LEAD_EVIDENCE_CHANNELS)
    // Exclude only confirmed spam (codex r9 P2). Status is lifecycle, not
    // provenance: a customer-originated lead later cancelled, or auto-filed
    // as a duplicate of another real lead, still proves the person contacted
    // Waves first. Spam is the one status that says the "contact" was never
    // a person reaching out. whereNot also fails closed on a NULL status
    // (SQL's three-valued logic excludes it), as elsewhere in this file.
    .whereNot('status', 'spam')
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

// EXISTS-style probes for hasPriorContact below — UNBOUNDED, unlike
// latestInboundCall/latestInboundText above (codex pre-push r1 P2 on PR
// #5012): those cap at 5 calls / 25 texts and filter for quality IN JS
// AFTER that cap, which is fine for "the single best evidence inside a 48h
// window" (resolveOutboundCallReason's own job) but wrong for an unbounded
// lookback — a genuine contact from months ago sitting behind a wall of
// newer spam calls or reminder acknowledgements would never surface. The
// SIMPLE qualifying filters (call nature; text type + "has a letter") move
// into the SQL WHERE clause instead of a row cap, so the query itself
// narrows the candidate set — `.first('id')` with no ORDER BY is a plain
// `LIMIT 1`, i.e. EXISTS-style, for the call probe. The harder text
// classifier (isSubstantiveText's emoji/reaction regexes) still runs in JS,
// REUSED rather than reimplemented in SQL, over that now-narrowed set —
// with no `.limit()` this time.
async function existsQualifyingInboundCall({ phoneLast10, before, conn = db }) {
  if (!phoneLast10) return false;
  // SERVICE_CONTACT_NATURES, an ALLOWLIST (codex r8 P1). The earlier
  // NON_SERVICE_NATURES denylist let through a null (indeterminate) nature
  // and silent_or_noise; only a positively service-classified call counts
  // now. A NULL nature fails the IN() test by SQL semantics, so no COALESCE.
  // Plus voicemail_message, gated below on a linked lead (codex r9 P1): a
  // prospect whose first contact was a service voicemail did reach out.
  const natures = [...SERVICE_CONTACT_NATURES, 'voicemail_message'];
  // NON_SERVICE_DISPOSITIONS (codex pre-push r6 P1): an OLDER inbound row
  // predating V2 call_nature extraction has no nature at all — the
  // COALESCE above reads it as '', which PASSES the nature filter — but it
  // can still carry a DEFINITIVE terminal call_log.disposition
  // (server/services/call-disposition.js) ruling it a non-service contact.
  // Both exclusions apply together; neither alone is sufficient for every
  // call's vintage.
  const dispositions = [...NON_SERVICE_DISPOSITIONS];
  const row = await whereNotSandboxCall(conn('call_log')
    .where('direction', 'inbound')
    .where('created_at', '<', before))
    .whereRaw(nanpStoredPhoneClause('from_phone'), [phoneLast10])
    // v2_extraction_status = 'valid' (codex pre-push r7 P1): a row the V2
    // pipeline never classified — no run yet, a parse failure, or a
    // pre-V2 legacy row with only call_outcome / processing_status /
    // ai_extraction.call_type set — is NOT positively known to be a
    // service contact and must fail closed here rather than pass on an
    // empty COALESCE. This also drops any need to read those legacy
    // fields: a row that never reached 'valid' never qualifies, full stop.
    .where('v2_extraction_status', 'valid')
    .whereRaw(
      `lower(trim(ai_extraction_enriched->>'call_nature')) IN (${natures.map(() => '?').join(',')})`,
      natures,
    )
    // A voicemail counts only when the pipeline tied it to a live, non-spam
    // lead, found by the call's own sid or the lead id stamped on the call
    // (a fresh lead links only through leads.twilio_call_sid). A voicemail
    // no one turned into a lead is not evidence of a service contact.
    .whereRaw(`(lower(trim(ai_extraction_enriched->>'call_nature')) <> 'voicemail_message'
      OR EXISTS (SELECT 1 FROM leads l WHERE l.deleted_at IS NULL AND l.status <> 'spam'
        AND (l.twilio_call_sid = call_log.twilio_call_sid OR l.id::text = call_log.metadata->>'lead_id')))`)
    .whereRaw(
      `COALESCE(disposition, '') NOT IN (${dispositions.map(() => '?').join(',')})`,
      dispositions,
    )
    .first('id');
  return !!row;
}

async function existsQualifyingInboundText({ phoneLast10, before, conn = db }) {
  if (!phoneLast10) return false;
  const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
  const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
  const rows = await conn('sms_log')
    .where('direction', 'inbound')
    .where('created_at', '<', before)
    .whereRaw(nanpStoredPhoneClause('from_phone'), [phoneLast10])
    // NOT IN excludes NULL rows entirely (SQL's three-valued logic) —
    // message_type is nullable, and isSubstantiveText's own JS check
    // (IGNORED_TEXT_TYPES.has(String(row.message_type || ''))) treats a
    // null type as '' (never ignored), so a null-typed substantive text
    // must still qualify (codex pre-push r2 P1).
    .where(function excludeIgnoredMessageType() {
      this.whereNull('message_type').orWhereNotIn('message_type', [...IGNORED_TEXT_TYPES]);
    })
    .whereRaw("message_body ~* '[a-z]'")
    // Exclude an enforced solicitation verdict (codex pre-push r7 P1) — the
    // exact fragment twilio-webhook.js's own unanswered-digest exclusion
    // uses (metadata->'spam_verdict'->>'enforced'): that row was silently
    // screened as spam, not a real inbound conversation, and must not
    // stand in as evidence the sender contacted Waves first.
    .whereRaw("COALESCE(metadata->'spam_verdict'->>'enforced', 'false') != 'true'")
    .modify((qb) => excludeRecruitingSmsLog(qb, 'message_type'))
    // Inbound rows are never send reservations, so this changes nothing
    // today. It's here because every sms_log reader goes through the shared
    // exclusion (sms-log-general-reader-source-guard).
    .modify(excludeUnresolvedSendReservations)
    .select('id', 'message_body', 'message_type');
  return rows.some(isSubstantiveText);
}

/**
 * Did this phone (or customer) EVER contact Waves before `before`? UNBOUNDED
 * — unlike resolveOutboundCallReason's own 48h LOOKBACK_MS above, which
 * answers a different question ("why did we place THIS call") and is too
 * narrow for "did they ever reach out first" (owner ruling 2026-09-26, the
 * outbound return-message gate: GATE_CALL_OUTBOUND_RETURN_MESSAGES). Reuses
 * the same qualifying rules this file already applies for the voicemail
 * text-back reason — an inbound call, an inbound text, or a lead record —
 * plus an existing customer link, through the EXISTS-style probes above
 * (never the capped latestInboundCall/latestInboundText, which would miss
 * an old genuine contact behind newer spam/acknowledgements).
 *
 * `conn` (codex #5018 pre-push P1) threads a caller's own held connection —
 * a transaction, or the same pool slot a phone-locked handoff already
 * occupies — through every probe below instead of opening a fresh one on
 * the shared pool. Required under the supported DB_POOL_MAX=2: a caller
 * that already holds the pool's other slot (a cron's exclusive lock, a
 * handoff transaction) would otherwise starve these probes into a
 * connection-acquire timeout. Defaults to the shared pool for a caller with
 * no transaction of its own.
 *
 * Deliberately does NOT catch a probe failure here and fold it into `false`
 * — this used to fail closed on ANY error, but a starved-pool timeout is an
 * infrastructure hiccup, not a genuine "no prior contact" answer, and
 * folding the two together made an outage indistinguishable from a real
 * negative — permanently refusing an otherwise-eligible send instead of
 * letting the caller's own retry/defer path (every current caller has one:
 * call-booking-link-text.js's staging/dispatch/neverSendRecheck rails,
 * call-recording-processor.js's own wrapping try/catch) pick it back up. A
 * caller that genuinely wants fail-closed-on-error keeps that as its own
 * explicit try/catch.
 */
async function hasPriorContact({ customerId = null, phone = null, before = new Date(), conn = db } = {}) {
  if (customerId) return true;
  // NANP-only evidence matching (codex pre-push r7 P1): phoneIdentityKey
  // returns the bare 10-digit form ONLY for a NANP (+1) number; anything
  // else comes back `+<fullDigits>` (or null for no digits at all). The
  // probes below all match on last-10 suffix, which is exactly the
  // collision phoneIdentityKey exists to prevent for a non-NANP number
  // (codex #4213 — a shared-suffix international caller wrongly matched an
  // unrelated NANP customer). Waves is SWFL-only, so a non-NANP destination
  // is rare; it fails closed here rather than risk that collision. This
  // keeps the last10() expression — and the frozen migration
  // 20260927000006 indexes built for it — unchanged for every NANP number.
  const identityKey = phoneIdentityKey(phone);
  if (!identityKey || !/^\d{10}$/.test(identityKey)) return false;
  const phoneLast10 = identityKey;
  const at = new Date(before);
  const [inboundCall, inboundText, leadRow] = await Promise.all([
    existsQualifyingInboundCall({ phoneLast10, before: at, conn }),
    existsQualifyingInboundText({ phoneLast10, before: at, conn }),
    anyLeadRecord({ phoneLast10, before: at, conn }),
  ]);
  return !!(inboundCall || inboundText || leadRow);
}

/**
 * Was the call we are returning a non-service contact? Looks at the exact
 * call the callback button pointed at (relatedCallId), else the most recent
 * inbound call from them inside the lookback — whatever its nature. True →
 * the send layer skips the text entirely.
 */
async function nonServiceCaller({ customerId, phone, relatedCallId = null, before = new Date() } = {}) {
  const at = new Date(before);
  const since = new Date(at.getTime() - LOOKBACK_MS);
  let row = null;
  if (relatedCallId && relatedCallId !== 'undefined') {
    row = await whereNotSandboxCall(db('call_log').where({ id: relatedCallId, direction: 'inbound' })).first('id', 'ai_extraction_enriched');
  }
  if (!row) {
    const phoneLast10 = last10(phone);
    if (!customerId && !phoneLast10) return false;
    row = await fromContact(
      whereNotSandboxCall(db('call_log').where('direction', 'inbound').where('created_at', '<', at).where('created_at', '>=', since)),
      { customerId, phoneLast10, phoneColumn: 'from_phone' },
    ).orderBy('created_at', 'desc').first('id', 'ai_extraction_enriched');
  }
  return !!row && NON_SERVICE_NATURES.has(callNature(row));
}

/**
 * Is a technician en route to / on site at this customer right now (or was,
 * inside the last 3h before `before`)? Three signals, any one suffices: a
 * live en_route/on_site visit dated today; an en_route_at / arrived_at stamp
 * inside the window; or an en-route / arrived TEXT we sent that number inside
 * the window (phone-keyed — covers unlinked call rows and unstamped visits).
 */
async function visitInProgress({ customerId, phone = null, before = new Date() } = {}) {
  const phoneLast10 = last10(phone);
  if (!customerId && !phoneLast10) return false;
  const at = new Date(before);
  const since = new Date(at.getTime() - VISIT_IN_PROGRESS_WINDOW_MS);
  // Live status counts only for a visit dated the call's ET day: the audit
  // found rows left at on_site for days (never transitioned), and a visit
  // booked AFTER the call must not suppress it (codex r1 P1: an adjacent-day
  // slack let yesterday's stale on_site row silence today's text). The
  // en_route_at / arrived_at stamps are exact and make the check replayable.
  const etDay = etDateString(at);
  const row = await db('scheduled_services as ss')
    .modify((qb) => {
      // No linked customer on the call row → match the dialed number to a
      // customer record (the audit's "no name" click during a visit).
      if (customerId) qb.where('ss.customer_id', customerId);
      else qb.join('customers as c', 'c.id', 'ss.customer_id')
        .whereNull('c.deleted_at')
        .whereRaw("right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ?", [phoneLast10]);
    })
    .where('ss.created_at', '<', at)
    .where(function active() {
      this.where(function liveToday() {
        this.whereIn('ss.status', VISIT_IN_PROGRESS_STATUSES)
          .where('ss.scheduled_date', etDay);
      })
        .orWhereBetween('ss.en_route_at', [since, at])
        .orWhereBetween('ss.arrived_at', [since, at]);
    })
    .first('ss.id');
  if (row) return true;
  if (!phoneLast10) return false;
  const arrivalText = await db('sms_log')
    .where('direction', 'outbound')
    .whereIn('message_type', ARRIVAL_TEXT_TYPES)
    .where('created_at', '>=', since)
    .where('created_at', '<', at)
    .whereRaw("right(regexp_replace(to_phone, '\\D', '', 'g'), 10) = ?", [phoneLast10])
    .first('id');
  return !!arrivalText;
}

// Our own quote-form auto-bridge to this person inside the last 48h: the
// follow-up call is still about their quote request. The bridge row's
// to_phone is the admin cell; the prospect's number is metadata.leadPhone.
async function latestQuoteBridge({ customerId, phoneLast10, before, since }) {
  return whereNotSandboxCall(db('call_log')
    .where('direction', 'outbound')
    .whereIn('source', [...QUOTE_REQUEST_SOURCES]))
    .where('created_at', '<', before)
    .where('created_at', '>=', since)
    .where(function contact() {
      if (customerId) this.where('customer_id', customerId);
      if (phoneLast10) {
        const clause = db.raw("right(regexp_replace(metadata->>'leadPhone', '\\D', '', 'g'), 10) = ?", [phoneLast10]);
        if (customerId) this.orWhere(clause); else this.where(clause);
      }
      if (!customerId && !phoneLast10) this.whereRaw('false');
    })
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

/**
 * @param {object} p
 * @param {object} p.call      call_log row: source, customer_id, metadata, created_at
 * @param {string} p.phone     the customer number we dialed
 * @returns {Promise<{ reason: string, evidence: object }>}
 */
async function resolveOutboundCallReason({ call = {}, phone } = {}) {
  const source = String(call.source || '');
  if (QUOTE_REQUEST_SOURCES.has(source)) {
    return { reason: REASONS.QUOTE_REQUEST, evidence: { source } };
  }

  const before = call.created_at ? new Date(call.created_at) : new Date();
  const since = new Date(before.getTime() - LOOKBACK_MS);
  const customerId = call.customer_id || null;
  const phoneLast10 = last10(phone);
  const meta = parseMetadata(call.metadata);

  try {
    const related = await relatedInboundCall(meta.relatedCallId);
    if (related) {
      return { reason: REASONS.RETURNING_CALL, evidence: { related_call_id: related.id, at: related.created_at } };
    }

    const [inboundCall, inboundText, quoteLead, quoteBridge] = await Promise.all([
      latestInboundCall({ customerId, phoneLast10, before, since }),
      latestInboundText({ customerId, phoneLast10, before, since }),
      latestQuoteFormLead({ customerId, phoneLast10, before, since }),
      latestQuoteBridge({ customerId, phoneLast10, before, since }),
    ]);
    const candidates = [
      inboundCall && { reason: REASONS.RETURNING_CALL, at: inboundCall.created_at, evidence: { inbound_call_id: inboundCall.id, at: inboundCall.created_at } },
      inboundText && { reason: REASONS.SAW_TEXT, at: inboundText.created_at, evidence: { inbound_sms_id: inboundText.id, at: inboundText.created_at } },
      quoteLead && { reason: REASONS.QUOTE_REQUEST, at: quoteLead.created_at, evidence: { quote_lead_id: quoteLead.id, at: quoteLead.created_at } },
      quoteBridge && { reason: REASONS.QUOTE_REQUEST, at: quoteBridge.created_at, evidence: { quote_bridge_call_id: quoteBridge.id, at: quoteBridge.created_at } },
    ].filter(Boolean);
    if (candidates.length) {
      // Most recent wins; on a tie the order above (call, text, lead, bridge) holds.
      const best = candidates.reduce((a, b) => (new Date(b.at) > new Date(a.at) ? b : a));
      return { reason: best.reason, evidence: best.evidence };
    }
  } catch (e) {
    // A probe failure must never block the text — fall back to the generic
    // copy, which is always true.
    logger.warn(`[outbound-call-reason] probe failed — generic reason: ${e.code || e.name || 'db_error'}`);
    return { reason: REASONS.GENERIC, evidence: { error: e.code || e.name || 'db_error' } };
  }
  return { reason: REASONS.GENERIC, evidence: {} };
}

module.exports = {
  REASONS,
  LOOKBACK_MS,
  QUOTE_REQUEST_SOURCES,
  QUOTE_FORM_CHANNELS,
  NON_CONTACT_NATURES,
  NON_SERVICE_NATURES,
  SERVICE_CONTACT_NATURES,
  NON_SERVICE_DISPOSITIONS,
  VISIT_IN_PROGRESS_WINDOW_MS,
  TEXT_SCAN_LIMIT,
  resolveOutboundCallReason,
  visitInProgress,
  nonServiceCaller,
  isSubstantiveText,
  hasPriorContact,
  // Promoted to a real export (codex #5018 r15 P2): call-booking-link-
  // text.js's own unlinked-customer phone match reuses this SAME SQL-side
  // NANP matcher rather than hand-roll a second regex — a private,
  // test-only export is the wrong way to share it across modules.
  nanpStoredPhoneClause,
  _private: {
    last10, callNature, parseMetadata, existsQualifyingInboundCall, existsQualifyingInboundText,
  },
};
