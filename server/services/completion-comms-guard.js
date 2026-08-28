'use strict';

// Completion-path comms guard — dark behind GATE_COMPLETION_COMMS_GUARD.
//
// Gap (2026-08-07 comms-queue diagnosis): nothing in the dispatch /complete
// path consults comms state, so a visit can be completed — and invoiced —
// while the customer is sitting on an unanswered "can we reschedule?" text.
// Reproduced in the 2026-08-05 weekly comms sweep (a visit serviced and
// invoiced despite an unanswered reschedule ask). The #3232 flag rows and
// the EOD digest cover the arrival-time and morning windows; this module
// covers the moment-of-completion window.
//
// This module DETECTS and SURFACES only. It NEVER blocks completion or
// invoicing, never sends customer communications, and never writes
// agent_decisions (the reschedule-intent flagger/watcher own that state).
// It surfaces one admin exception per completed visit: a bell notification
// plus a dispatch_alerts action-queue card.
//
// Two read legs, both knex query builder (the #3232 lane-2 incident — an
// unbalanced paren in raw SQL that tests mocked away — is the argument):
//   Leg A: a pending_review comms_guards flag (reschedule/away intent)
//          raised in the last 14 days, linked to THIS visit or customer-wide
//          (entity_id IS NULL).
//   Leg B: the customer's newest UNANSWERED thread in the last 7 days.
//          Thread identity is the digest's — (peer phone, our endpoint) —
//          because one customer legitimately spans several: Waves answers on
//          multiple Twilio numbers, and a customer can text from more than
//          one handset. Collapsing them to a single customer-wide stream
//          lets a reply on one thread falsely answer another, and a newer
//          message on one hide an older unanswered one on another (both
//          false NEGATIVES, the failure mode that matters for a detector).
//          v1 stays CUSTOMER-LINKED — rows are selected by customer_id and
//          the digest's shared-phone/lateral machinery (matching unlinked
//          rows by phone tail across customer records) is deliberately not
//          reproduced; scoping applies WITHIN the customer's own rows.
//          Per thread: excluded machine/opt-flow types never count as the
//          latest message, a later STOP retires it, a standalone courtesy
//          closer as the last message retires it, and a human-APPROVED
//          PROACTIVE nudge (an unanchored message_drafts row finalized
//          alongside the outbound) is not an answer.
//
// Fail-soft throughout: runCompletionCommsGuard catches everything and the
// /complete call site wraps it again — a guard failure must never fail the
// committed completion (mirrors the dues-covered review-alert exemplar).

const db = require('../models/db');
const logger = require('./logger');

// Leg A window: flags older than this are stale — the daily watcher has
// already re-surfaced or expired them.
const PENDING_FLAG_WINDOW_DAYS = 14;
// Leg B window: mirrors the digest's "customer waiting" freshness frame.
const UNANSWERED_INBOUND_WINDOW_DAYS = 7;

// Same flag identity the reschedule-intent flagger writes.
const WORKFLOW = 'comms_guards';
const DETECTED_INTENT = 'reschedule_or_away_needs_review';

// Mirrors unworked-comms-watcher lane 3: reactions and opt-flows are not a
// waiting customer, and reschedule_reply rows are machine-answered by
// RescheduleSMS before the inbound row persists.
const EXCLUDED_INBOUND_TYPES = ['opt_out', 'opt_in', 'sms_reaction', 'help_request', 'reschedule_reply'];
// Human-authored reply types only — automated broadcasts (reminders,
// receipts, review asks) must not clear a waiting customer (#3232 r1).
// The two canonical watchers deliberately disagree on what answers what, and
// this module needs BOTH sets — one per leg:
//
//  - Leg B / general threads: unworked-comms-watcher's HUMAN_REPLY_TYPES.
//    The AI assistant and follow-up lanes ARE conversational answers, so
//    omitting them reports an answered customer as waiting.
//  - Leg A / reschedule flags: reschedule-intent-watcher's (narrower) set.
//    The AI assistant STANDS DOWN on reschedule intent, so a later AI
//    message is not an answer to a reschedule request — counting it would
//    hide an open flag.
const THREAD_REPLY_TYPES = [
  'manual', 'ai_approved', 'ai_revised', 'ai_assistant', 'ai_assistant_reply', 'follow_up',
];
const FLAG_REPLY_TYPES = ['manual', 'ai_approved', 'ai_revised'];
// Leg A only, and NARROWLY scoped (see flagResolved): the watcher accepts a
// delivered reschedule confirmation as proof only for a null-entity,
// non-ambiguous, customer-linked flag. For a multi-visit customer the moved
// visit may not be the requested one.
const RESCHEDULE_CONFIRMATION_TYPES = ['appointment_rescheduled', 'reschedule_series_confirmation'];
const OUTBOUND_SCAN_TYPES = [...THREAD_REPLY_TYPES, ...RESCHEDULE_CONFIRMATION_TYPES];
// CONFIRMED delivery only. The watcher draws this line deliberately: its
// transient daily bell accepts queued/sent/delivered (a reply that "actually
// left"), but its DURABLE auto_resolved write requires 'delivered'
// (reschedule-intent-watcher: "Resolution is a durable status write — only
// CONFIRMED"). This guard is one-shot — the per-visit advisory-lock dedupe
// means it never re-evaluates — so a queued row that Twilio later flips to
// failed/undelivered would permanently swallow the exception. Fail closed:
// only a confirmed delivery counts as an answer. The cost is a rare bell on
// a reply sent seconds before completion whose receipt hasn't landed yet,
// which is the right direction for a detection-only surface.
const CONFIRMED_OUTBOUND_STATUS = 'delivered';
// Proactive-draft matching window, mirroring the digest's ±2 minutes.
const DRAFT_MATCH_WINDOW_MS = 2 * 60 * 1000;
// One customer's SMS rows inside the window are a small set; the caps are
// runaway guards, not business rules. Rows are scanned newest-first, so a
// truncated scan keeps the freshest threads/flags.
const SMS_SCAN_CAP = 400;
const FLAG_CANDIDATE_CAP = 25;

// Standalone courtesy closers END a thread — verbatim mirror of the digest's
// lane-3 pattern (unworked-comms-watcher, codex r34/r46). Applied AFTER the
// latest-row selection, exactly as the digest does: a closing "Thanks!"
// retires the conversation instead of resurfacing the older substantive
// message.
const COURTESY_CLOSER_RE = /^(thanks?( you| u)?|thank you( so much| very much)?|ty|tysm|got it|perfect|great|awesome|ok(ay)?|k|sounds good|will do|no problem|you too|understood|10-4|roger)[.! ]*$/i;

const ALERT_TYPE = 'completed_with_open_comms';

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function isCourtesyCloser(body, metadata = null) {
  // The webhook's context-aware detector stamps sms_log.metadata.courtesyOnly
  // on arrival; honor it here so a resolved closer never raises an exception.
  let meta = metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  if (meta && meta.courtesyOnly === true) return true;
  return COURTESY_CLOSER_RE.test(String(body || '').trim());
}

// Last 10 digits — the repo-wide phone identity for SMS threads.
function tail10(phone) {
  return String(phone || '').replace(/[^0-9]/g, '').slice(-10);
}

function ts(value) {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// The flagger stamps phone_tail on EVERY flag so resolution can require the
// reply to have gone to the number that raised it. jsonb comes back parsed
// or as text depending on the driver path; tolerate both, and treat an
// unreadable snapshot as "no tail" (customer-wide match, the flagger's own
// fallback) rather than throwing.
function parseSnapshot(snapshot) {
  try {
    return (typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot) || null;
  } catch {
    return null;
  }
}

function flagPhoneTail(snapshot) {
  const tail = parseSnapshot(snapshot)?.phone_tail;
  return tail ? String(tail) : null;
}

// The flagger stamps ambiguous:true when the customer had several upcoming
// visits, so the request could not be linked to one. An unreadable snapshot
// is treated as AMBIGUOUS — the fail-closed direction: it withholds the
// weaker confirmation-based resolution and leaves the flag surfaced.
function flagIsAmbiguous(snapshot) {
  const snap = parseSnapshot(snapshot);
  if (!snap) return true;
  return snap.ambiguous === true || String(snap.ambiguous) === 'true';
}

/**
 * Pure read: does this customer have open comms state a just-completed
 * visit should surface?
 *
 * @param {object} args
 * @param {string} args.customerId  customers.id of the completed visit
 * @param {string} args.serviceId   scheduled_services.id of the completed visit
 * @param {object} [args.knex]      injectable knex (tests)
 * @returns {Promise<{pendingFlag: object|null, unansweredInbound: object|null}>}
 *   pendingFlag       — newest matching comms_guards agent_decisions row
 *   unansweredInbound — latest in-window inbound sms_log row with no later
 *                       human-authored outbound
 */
async function findOpenCommsExceptions({ customerId, serviceId, knex = db }) {
  const inboundFloor = daysAgo(UNANSWERED_INBOUND_WINDOW_DAYS);
  // Outbound is scanned wider than either leg's own frame: Leg A's
  // resolution recheck needs replies as old as the oldest flag it can
  // return. A visit-linked flag has no age cutoff, but the flagger only
  // raises one for a visit inside its 14-day horizon, so such a flag is at
  // most ~14 days older than the visit being completed; the extra week is
  // headroom. Missing an older reply only costs a redundant bell, never a
  // missed exception.
  const outboundFloor = daysAgo(PENDING_FLAG_WINDOW_DAYS + 7);

  // One scan of the customer's in-window SMS, newest first, then all thread
  // reasoning in JS. Fetching once (instead of a query per thread) keeps the
  // predicate knex-builder-only and the query count flat.
  const inboundRows = await knex('sms_log')
    .where({ customer_id: customerId, direction: 'inbound' })
    .where('created_at', '>=', inboundFloor)
    .orderBy('created_at', 'desc')
    .limit(SMS_SCAN_CAP)
    .select('id', 'created_at', 'message_type', 'message_body', 'from_phone', 'to_phone');

  // One scan covering both legs' type sets; each leg narrows below.
  const outboundRows = await knex('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .whereIn('message_type', OUTBOUND_SCAN_TYPES)
    .where('status', CONFIRMED_OUTBOUND_STATUS)
    .where('created_at', '>=', outboundFloor)
    .orderBy('created_at', 'desc')
    .limit(SMS_SCAN_CAP)
    .select('id', 'created_at', 'from_phone', 'to_phone', 'message_type');

  const threadReplies = outboundRows.filter((r) => THREAD_REPLY_TYPES.includes(r.message_type));
  const flagReplies = outboundRows.filter((r) => FLAG_REPLY_TYPES.includes(r.message_type));
  const rescheduleConfirmations = outboundRows.filter((r) => RESCHEDULE_CONFIRMATION_TYPES.includes(r.message_type));

  // A human-APPROVED proactive nudge (click_followup and friends) is outbound
  // marketing, not an answer — the EOD digest excludes it the same way
  // (unworked-comms-watcher lane 3, codex r24). Identified structurally: an
  // unanchored draft (sms_log_id IS NULL — not composed against a specific
  // inbound) finalized within a couple of minutes of the outbound.
  let proactiveTimes = [];
  if (outboundRows.length) {
    const drafts = await knex('message_drafts')
      .where({ customer_id: customerId })
      .whereNull('sms_log_id')
      .whereNotNull('sent_at')
      .where('sent_at', '>=', new Date(ts(outboundFloor) - DRAFT_MATCH_WINDOW_MS))
      .select('sent_at');
    proactiveTimes = drafts.map((d) => ts(d.sent_at));
  }
  const isProactive = (row) => proactiveTimes.some((dt) => Math.abs(dt - ts(row.created_at)) <= DRAFT_MATCH_WINDOW_MS);

  // A later STOP retires every thread from that handset: an opted-out
  // customer must never be surfaced as waiting for a reply nobody may send
  // (digest lane 3, codex r4). Keyed by peer, since opting out is a property
  // of the handset, not of one of our numbers. Rows are newest-first, so the
  // first opt_out seen per peer is the newest.
  const optOutByPeer = new Map();
  for (const row of inboundRows) {
    if (row.message_type !== 'opt_out') continue;
    const peer = tail10(row.from_phone);
    if (peer && !optOutByPeer.has(peer)) optOutByPeer.set(peer, ts(row.created_at));
  }

  // Newest substantive inbound per (peer, endpoint) thread. Excluded
  // machine/opt-flow types never count as a thread's latest message; NULL
  // message_type does (the digest's COALESCE(message_type,'') NOT IN
  // semantics). Newest-first iteration means the first hit per key wins.
  const latestPerThread = new Map();
  for (const row of inboundRows) {
    if (row.message_type != null && EXCLUDED_INBOUND_TYPES.includes(row.message_type)) continue;
    const peer = tail10(row.from_phone);
    if (!peer) continue;
    const endpoint = tail10(row.to_phone);
    const key = `${peer}|${endpoint}`;
    if (!latestPerThread.has(key)) latestPerThread.set(key, { peer, endpoint, row });
  }

  // Threads are keyed in newest-first order, so the first unanswered one is
  // the freshest thing the customer is waiting on.
  let unansweredInbound = null;
  for (const { peer, endpoint, row } of latestPerThread.values()) {
    const optOutAt = optOutByPeer.get(peer);
    if (optOutAt != null && optOutAt > ts(row.created_at)) continue;
    // Courtesy closer as the LAST message = the customer signed off. Applied
    // post-selection, exactly as the digest does, so a closing "Thanks!"
    // retires the thread instead of resurfacing the older substantive message.
    if (isCourtesyCloser(row.message_body, row.metadata)) continue;
    // Answered = a genuine human reply on THIS thread (same peer, same one of
    // our numbers) after the inbound. Endpoint scoping is what stops a reply
    // on one thread from clearing another.
    const answered = threadReplies.some((out) => tail10(out.to_phone) === peer
      && tail10(out.from_phone) === endpoint
      && ts(out.created_at) > ts(row.created_at)
      && !isProactive(out));
    if (!answered) { unansweredInbound = row; break; }
  }

  // Leg A: pending reschedule/away flag — linked to this visit, or raised
  // customer-wide (no visit inside the flagger's horizon / ambiguous).
  const flagCandidates = await knex('agent_decisions')
    .where({
      workflow: WORKFLOW,
      detected_intent: DETECTED_INTENT,
      status: 'pending_review',
    })
    .where(function flagScope() {
      // A flag LINKED TO THIS VISIT never ages out: the visit it is about is
      // the one being completed right now. The flagger's horizon books
      // flags up to 14 days ahead of the visit, so a strict created_at
      // cutoff drops exactly the request raised furthest in advance — the
      // one most likely to have been forgotten. The canonical watcher
      // likewise retains flags through the linked visit date.
      this.where('entity_id', serviceId)
        // Customer-wide flags have no visit to anchor to, so they keep the
        // staleness window (the daily watcher has re-surfaced or expired
        // anything older).
        .orWhere(function customerWide() {
          this.where('customer_id', customerId)
            .whereNull('entity_id')
            .where('created_at', '>=', daysAgo(PENDING_FLAG_WINDOW_DAYS));
        });
    })
    .orderBy('created_at', 'desc')
    .limit(FLAG_CANDIDATE_CAP)
    .select('id', 'entity_id', 'customer_id', 'created_at', 'input_snapshot');

  // `pending_review` is only as fresh as the periodic resolution pass: staff
  // can answer the customer and complete the visit before the watcher clears
  // the row. Mirror the watcher's resolveActionedFlags predicate — both of
  // its message-driven branches, with the same scoping:
  //
  //  (1) humanReply — a delivered reply that went TO the number which raised
  //      the flag (input_snapshot.phone_tail; a flag raised by a service
  //      contact is not resolved by texting the account's primary phone),
  //      excluding proactive nudges.
  //  (2) ambiguousRescheduled — a delivered reschedule confirmation, but
  //      ONLY for a null-entity, NON-ambiguous, customer-linked flag (the
  //      watcher's r32 scoping). For a multi-visit customer the confirmed
  //      move may not be the requested one, so a visit-linked or ambiguous
  //      flag stays pending for staff review.
  //
  // The watcher's third branch (slot moved/cancelled) is deliberately NOT
  // mirrored: it resolves an entity-linked flag whose visit was cancelled,
  // rescheduled or skipped — but the visit here was just COMPLETED, and
  // "completion is NOT resolution" (that rule is the reason this guard
  // exists). It could never fire in this context anyway.
  const flagResolved = (flag) => {
    const tail = flagPhoneTail(flag.input_snapshot);
    const wentToFlaggingNumber = (out) => (tail ? tail10(out.to_phone) === tail : true);
    const humanReplied = flagReplies.some((out) => ts(out.created_at) > ts(flag.created_at)
      && !isProactive(out)
      && wentToFlaggingNumber(out));
    if (humanReplied) return true;
    const confirmationEligible = flag.entity_id == null
      && flag.customer_id != null
      && !flagIsAmbiguous(flag.input_snapshot);
    return confirmationEligible && rescheduleConfirmations.some(
      (out) => ts(out.created_at) > ts(flag.created_at) && wentToFlaggingNumber(out),
    );
  };
  const pendingFlag = flagCandidates.find((flag) => !flagResolved(flag)) || null;

  return { pendingFlag, unansweredInbound };
}

/**
 * Post-commit completion hook: gate-checked, advisory-lock deduped
 * (one exception per completed visit, ever), fail-soft. Writes the admin
 * bell notification and the dispatch_alerts card atomically; never throws.
 *
 * @returns {Promise<{flagged: boolean, reason: string}>}
 */
async function runCompletionCommsGuard({ serviceId, customerId, knex = db }) {
  try {
    if (!require('../config/feature-gates').isEnabled('completionCommsGuard')) {
      return { flagged: false, reason: 'gate_off' };
    }
    if (!serviceId || !customerId) return { flagged: false, reason: 'missing_ids' };

    const { pendingFlag, unansweredInbound } = await findOpenCommsExceptions({ customerId, serviceId, knex });
    if (!pendingFlag && !unansweredInbound) return { flagged: false, reason: 'no_open_comms' };

    const dedupeKey = `completion-comms:${serviceId}`;
    const legs = [];
    if (pendingFlag) legs.push('a pending reschedule/away request flag');
    if (unansweredInbound) legs.push('an inbound text with no human reply');
    const body = `A visit was completed while the customer still had ${legs.join(' and ')}. `
      + 'Completion is not resolution — review the thread and follow up. '
      + 'Nothing was blocked: the completion and its invoice decision went through unchanged.';

    let flagged = false;
    await knex.transaction(async (trx) => {
      // Transaction-scoped advisory lock serializes concurrent completions
      // of the same visit so the check-then-insert can't double-bell
      // (verbatim dues-covered exemplar pattern, admin-dispatch.js ~L8353).
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeKey]);
      const already = await trx('notifications')
        .where({ recipient_type: 'admin' })
        .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
        .first();
      if (already) return;
      const notif = await require('./notification-service').notifyAdmin(
        'schedule',
        'Visit completed with an unanswered customer message',
        body,
        {
          link: `/admin/communications?thread=${customerId}`,
          bell: true,
          metadata: {
            scheduledServiceId: serviceId,
            customerId,
            decisionId: pendingFlag?.id || null,
            dedupeKey,
          },
          connection: trx,
        },
      );
      // Only mint the action-queue card when the notification row actually
      // landed — the notification is the dedupe anchor, so a suppressed or
      // failed insert must not leave an undeduped alert behind (a retry
      // would double-card).
      if (!notif || !notif.id) return;
      await require('./dispatch-alerts').createAlert({
        type: ALERT_TYPE,
        severity: 'warn',
        jobId: serviceId,
        payload: {
          customerId,
          decisionId: pendingFlag?.id || null,
          dedupeKey,
          pendingFlag: Boolean(pendingFlag),
          unansweredInbound: Boolean(unansweredInbound),
        },
        trx,
      });
      flagged = true;
    });
    return { flagged, reason: flagged ? 'flagged' : 'deduped' };
  } catch (err) {
    logger.warn(`[completion-comms-guard] guard failed (non-blocking) for service ${serviceId}: ${err.message}`);
    return { flagged: false, reason: 'error' };
  }
}

module.exports = {
  findOpenCommsExceptions,
  runCompletionCommsGuard,
  ALERT_TYPE,
  EXCLUDED_INBOUND_TYPES,
  THREAD_REPLY_TYPES,
  FLAG_REPLY_TYPES,
  RESCHEDULE_CONFIRMATION_TYPES,
  CONFIRMED_OUTBOUND_STATUS,
  PENDING_FLAG_WINDOW_DAYS,
  UNANSWERED_INBOUND_WINDOW_DAYS,
};
