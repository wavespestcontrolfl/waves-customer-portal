/**
 * Intelligence Bar cancel card: durable approved-effect bundle + recovery sweep (follow-up to #6377,
 * GATE_IB_CANCEL_WITH_EFFECTS; owner ruling 2026-10-22, option A).
 *
 * THE GAP. The bar's approved cancel commits the status transaction, then runs the approved follow-on work after the
 * commit: the pinned invoice void and inspection-credit reversal, the approved customer text, and the pinned
 * linked-visit cascade. A process exit between the commit and that work left nothing to finish it, and a retry
 * is refused as stale (the visit is already cancelled).
 *
 * THE FIX. The cancel handler's own transaction writes ONE row here (insertBundle, called from
 * admin-dispatch.js#cancelServiceFromBar's beforeCommit) holding exactly what the card approved: the pinned invoices
 * and credit offers, the approved text per recipient (or the no-text choice), the approved linked visits, the pending
 * action id and the actor. The row commits or rolls back with the cancel. The request then:
 *   liveStart   - takes a 10 minute 'request' lease (so a slow request is not overtaken by the sweep)
 *   liveNotice  - records the text step's outcome the moment handleCancellation returns
 *   liveFinish  - marks the row 'complete' when the follow-through returns (success or terminal skip)
 * A row still pending 10 minutes after it was written (the request is dead) is finished by sweepIbCancelBundles,
 * which runs every 5 minutes from services/scheduler.js and queries by AGE, not by tick, so a dropped tick only delays
 * it. The sweep calls the SAME pinned code the request calls, with the same arguments:
 *   - runVisitCancellationFollowThrough with pinnedEffects/moneyReport/linkedChildren (invoice void under the invoice
 *     row lock at the pinned amounts, credit reversal for the pinned offers only, NO card fee rail, then the tracker
 *     cancel and the linked cascade, each child re-read under its own lock);
 *   - AppointmentReminders.handleCancellation with the APPROVED text only.
 * Anything that no longer matches the card is skipped and reported, never forced.
 *
 * IDEMPOTENCY (the request and the sweep may race; each effect happens once):
 *   - Invoice void: only OPEN invoices are candidates and the void re-checks under the invoice FOR UPDATE lock, so a
 *     second run finds the invoice void; alreadySettledApprovedEffects counts a void invoice as done, not skipped.
 *   - Credit reversal: only offers still redeemed against the visit reverse (invoice.js, inspection-credit.js).
 *   - Linked visits: a child already cancelled is no longer a live linked follow-up; the sweep drops those from the
 *     approved list first so they are reported done, not 'no_longer_linked'.
 *   - Text: the sweep calls handleCancellation ONLY when the reminder marker is still 'pending_approved' (nothing
 *     reached the provider handoff: the pre-dispatch 'sent' stamp precedes it). 'sent' with no provider-accepted audit
 *     row is UNCERTAIN and is never sent again. The claim is token fenced, so a request that is still alive loses its
 *     pre-dispatch check to the sweep's token (or the reverse), and exactly one of them stamps and sends.
 *   - The text is also skipped if the request already recorded its text outcome, if the visit date has passed, and is
 *     DEFERRED (not dropped) while the 8 AM to 8 PM ET send window is closed.
 *   - One runner per row: a lease (lease_owner token + lease_until) claimed with FOR UPDATE SKIP LOCKED. Only the
 *     token holder writes results.
 *
 * The sweep acts only while the visit is still cancelled with no later restoration; a row past the 24 hour hard stop
 * (or out of attempts) is NOT acted on and is reported to the office.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { countRestorations } = require('./cancel-generation-fence');

const TABLE = 'ib_cancel_effect_bundles';
const GRACE_MS = 10 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
const HARD_STOP_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETENTION_DAYS = 90;
const BATCH = 10;
const REQUEST_LEASE = 'request';

// Database-clock times as bound raw values (one binding each, so no value is spliced into the SQL).
const nowPlusMs = (conn, ms) => conn.raw("now() + (? * interval '1 millisecond')", [ms]);
const nowMinusMs = (conn, ms) => conn.raw("now() - (? * interval '1 millisecond')", [ms]);

const jsonOrNull = (value) => (value === undefined || value === null ? null : JSON.stringify(value));

// Phone numbers can ride on provider error text; mask digit runs before anything is stored or shown.
function scrub(text) {
  return String(text || '').replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]').slice(0, 300);
}

/**
 * Writes the bundle on the cancel handler's transaction (rolls back with it). Everything here is what the card
 * approved. created_at / lease_until use clock_timestamp() (commit time is close to it), not now() (transaction start); no generation
 * decision ever compares times (restorations_seen is the generation).
 * A failure THROWS: the cancel aborts rather than committing without its recovery record.
 */
async function insertBundle(trx, pins) {
  // The cancellation generation (see cancel-generation-fence.js): the visit row is locked FOR UPDATE here (the caller's
  // handler holds it already; locking again is free), so no restoration can be in flight and the count is exact.
  await trx('scheduled_services').where({ id: pins.scheduledServiceId }).forUpdate().first('id');
  const restorationsSeen = await countRestorations(trx, pins.scheduledServiceId);
  const inserted = await trx(TABLE).insert({
    restorations_seen: restorationsSeen,
    pending_action_id: pins.pendingActionId || null,
    scheduled_service_id: pins.scheduledServiceId,
    actor_id: pins.actorId ? String(pins.actorId) : null,
    notes: pins.notes || null,
    notify_customer: pins.notifyCustomer === true,
    approved_notice: jsonOrNull(Array.isArray(pins.approvedNotice) ? pins.approvedNotice : null),
    linked_children: JSON.stringify(Array.isArray(pins.linkedChildren) ? pins.linkedChildren : []),
    approved_money: JSON.stringify(pins.approvedMoney || {}),
    lease_owner: REQUEST_LEASE,
    lease_until: trx.raw("clock_timestamp() + (? * interval '1 millisecond')", [LEASE_MS]),
    created_at: trx.raw('clock_timestamp()'),
    updated_at: trx.raw('clock_timestamp()'),
  }).returning('id');
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  return first && typeof first === 'object' ? first.id : first;
}

// ── The request's side ────────────────────────────────────────────────────────────────────────────────────────

async function guarded(label, fn) {
  try {
    return await fn();
  } catch (err) {
    // Never fails the request: the row stays pending and the sweep finishes it.
    logger.warn(`[ib-cancel-bundle] ${label} failed: ${scrub(err && err.message)}`);
    return null;
  }
}

// Heartbeat at the start of the request's post-commit work: the sweep cannot claim before this lease runs out.
// Does not take a lease a sweep already holds (the work below is idempotent either way).
function liveStart(req) {
  const id = req && req.ibCancelBundleId;
  if (!id) return Promise.resolve(null);
  return guarded('heartbeat', () => db(TABLE)
    .where({ id, status: 'pending' })
    .where(function leaseFree() {
      this.whereNull('lease_until').orWhere('lease_until', '<', db.fn.now()).orWhere('lease_owner', REQUEST_LEASE);
    })
    .update({
      lease_owner: REQUEST_LEASE,
      lease_until: nowPlusMs(db, LEASE_MS),
      updated_at: db.fn.now(),
    }));
}

/** handleCancellation's reported outcome -> the stored text state. */
function classifyNoticeOutcome(outcome) {
  if (!outcome || outcome.notificationSent === undefined) return null;
  if (outcome.notificationUncertain === true) return { state: 'uncertain', error: scrub(outcome.notificationError) };
  if (outcome.notificationSent === true) {
    return outcome.notificationPartial === true
      ? { state: 'partial', error: scrub(outcome.notificationError) }
      : { state: 'sent' };
  }
  return { state: 'not_sent', error: scrub(outcome.notificationError) };
}

// The text step ended inside the request: record it so the sweep never sends it again. A not-sent result is the
// operator's to send by hand (the receipt says so); the sweep must not send it behind their back.
function liveNotice(req, outcome) {
  const id = req && req.ibCancelBundleId;
  const classified = classifyNoticeOutcome(outcome);
  if (!id || !classified) return Promise.resolve(null);
  return guarded('notice outcome', () => db(TABLE)
    .where({ id, status: 'pending' })
    .update({ notice_outcome: JSON.stringify({ ...classified, by: 'request' }), updated_at: db.fn.now() }));
}

// The follow-through returned: the request finished its work.
function liveFinish(req) {
  const id = req && req.ibCancelBundleId;
  if (!id) return Promise.resolve(null);
  const followthrough = {
    money_skipped: (req.ibMoneyReport && req.ibMoneyReport.skipped) || [],
    linked_skipped: (req.ibLinkedChildReport && req.ibLinkedChildReport.skipped) || [],
  };
  return guarded('complete', () => db(TABLE)
    .where({ id, status: 'pending' })
    .update({
      status: 'complete',
      followthrough_done_at: db.fn.now(),
      followthrough_outcome: JSON.stringify(followthrough),
      finished_at: db.fn.now(),
      finish_note: 'request',
      lease_owner: null,
      lease_until: null,
      updated_at: db.fn.now(),
    }));
}

// ── The sweep's side ──────────────────────────────────────────────────────────────────────────────────────────

class LeaseLost extends Error {}

const ownedWhere = (id, token) => db(TABLE).where({ id, lease_owner: token, status: 'pending' });

async function ownedUpdate(id, token, patch) {
  const rows = await ownedWhere(id, token).update({ ...patch, updated_at: db.fn.now() });
  if (!rows) throw new LeaseLost(`lease on bundle ${id} was lost`);
}

// Before telling anyone anything: the request may have finished the row while the sweep worked.
async function assertStillOwned(id, token) {
  if (!(await ownedWhere(id, token).first('id'))) throw new LeaseLost(`lease on bundle ${id} was lost`);
}

async function claimNext(token) {
  const result = await db.raw(
    `UPDATE ${TABLE}
        SET lease_owner = ?, lease_until = now() + (? * interval '1 millisecond'), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM ${TABLE}
         WHERE status = 'pending'
           AND created_at <= now() - (? * interval '1 millisecond')
           AND created_at > now() - (? * interval '1 millisecond')
           AND attempts < ?
           AND (lease_until IS NULL OR lease_until < now())
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [token, LEASE_MS, GRACE_MS, HARD_STOP_MS, MAX_ATTEMPTS],
  );
  return (result && result.rows && result.rows[0]) || null;
}

// A bundle the sweep must not act on: older than the hard stop, or out of attempts.
async function listUnactable() {
  return db(TABLE)
    .where({ status: 'pending' })
    .where(function leaseFree() { this.whereNull('lease_until').orWhere('lease_until', '<', db.fn.now()); })
    .where(function stale() {
      this.where('created_at', '<=', nowMinusMs(db, HARD_STOP_MS)).orWhere('attempts', '>=', MAX_ATTEMPTS);
    })
    .orderBy('created_at')
    .limit(BATCH);
}

// The cancel must still stand: the visit is cancelled and has had no restoration since the bundle was written (an unlocked
// pre-check; the guard of each write is assertCancelGeneration inside that write's transaction). Counts, never times.
async function cancelStillStands(bundle) {
  const svc = await db('scheduled_services').where({ id: bundle.scheduled_service_id }).first('status', 'scheduled_date');
  if (!svc) return { ok: false, reason: 'visit_missing' };
  if (String(svc.status) !== 'cancelled') return { ok: false, reason: `visit_is_${svc.status}` };
  if ((await countRestorations(db, bundle.scheduled_service_id)) !== Number(bundle.restorations_seen)) return { ok: false, reason: 'visit_restored_since' };
  return { ok: true, svc };
}

// The approved linked visits the cascade still has to cancel: one already cancelled (by the request before it died) is
// the state the card promised, so it is not asked again and not reported as changed.
async function splitLinkedChildren(bundle) {
  const approved = Array.isArray(bundle.linked_children) ? bundle.linked_children : [];
  if (!approved.length) return { remaining: [], alreadyCancelled: [] };
  const rows = await db('scheduled_services').whereIn('id', approved.map((c) => c.id)).select('id', 'status');
  const cancelled = new Set((rows || []).filter((r) => String(r.status) === 'cancelled').map((r) => String(r.id)));
  return {
    remaining: approved.filter((c) => !cancelled.has(String(c.id))),
    alreadyCancelled: approved.filter((c) => cancelled.has(String(c.id))).map((c) => c.id),
  };
}

/** The follow-through call, with exactly the arguments the Dispatch handler's cancel branch passes. */
function followThroughArgs(bundle, linkedChildren, reports, cancelFence = null) {
  return {
    targetIds: [bundle.scheduled_service_id],
    actorId: bundle.actor_id || null,
    waiveFee: false,
    reason: bundle.notes || null,
    source: 'ib-cancel-recovery',
    linkedChildren,
    linkedChildReport: reports.linked,
    pinnedEffects: { [bundle.scheduled_service_id]: bundle.approved_money || {} },
    moneyReport: reports.money,
    // Recovery only (the request is never fenced): every mutation re-proves the cancellation generation.
    ...(cancelFence ? { cancelFence } : {}),
  };
}

// The visit changed under the recovery (restored, re-cancelled by another cancel, or gone): nothing more runs.
class Abandon extends Error {
  constructor(reason, partial = false) {
    super(reason);
    this.reason = reason;
    this.partial = partial;
  }
}

async function recoverFollowThrough(bundle, token) {
  const { runVisitCancellationFollowThrough } = require('./visit-cancellation-followthrough');
  const reports = { money: { skipped: [] }, linked: { skipped: [] } };
  const fence = { visitId: bundle.scheduled_service_id, restorations: bundle.restorations_seen, hits: [] };
  const { remaining, alreadyCancelled } = await splitLinkedChildren(bundle);
  await runVisitCancellationFollowThrough(followThroughArgs(bundle, remaining, reports, fence));
  if (fence.hits.length) {
    // A mutation was refused. The visit is either no longer the approved cancel (abandon: some steps may already have
    // run before it changed) or only busy because a restore is in flight (retry on the next pass, nothing is saved).
    const standing = await cancelStillStands(bundle);
    if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true);
    throw new Error(`the visit was busy (${fence.hits.join(', ')}); recovery will retry`);
  }
  const outcome = {
    money_skipped: reports.money.skipped,
    linked_skipped: reports.linked.skipped,
    ...(alreadyCancelled.length ? { linked_already_cancelled: alreadyCancelled } : {}),
  };
  await ownedUpdate(bundle.id, token, {
    followthrough_done_at: db.fn.now(),
    followthrough_outcome: JSON.stringify(outcome),
  });
  return outcome;
}

// A DATE column arrives as a Date at LOCAL midnight (no type parser is set), so read its local parts.
function dateOnly(raw) {
  if (!raw) return null;
  if (!(raw instanceof Date)) return String(raw).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`;
}

function visitDateHasPassed(svc) {
  const day = dateOnly(svc && svc.scheduled_date);
  return Boolean(day) && day < require('../utils/datetime-et').etDateString();
}

const NOTICE_TERMINAL_BY_STATUS = {
  delivered: { state: 'sent', note: 'It had already gone out before the interruption.' },
  uncertain: { state: 'uncertain', note: 'The send began before the interruption and delivery cannot be proven. It was NOT sent again.' },
  partial: { state: 'partial', note: 'The send began before the interruption and was proven for some approved recipients only. It was NOT sent again.' },
  suppressed: { state: 'not_sent', note: 'The approved send was blocked or failed before the interruption. It was NOT sent again.' },
  no_reminder: { state: 'not_sent', note: 'The visit has no reminder record, so no text could be sent.' },
  other: { state: 'not_sent', note: 'The reminder holds a notice the card did not approve. Nothing was sent.' },
};

// Sends the approved text through the same call the request uses. Returns { done, outcome }; done false = try again later.
async function sendApprovedNotice(bundle, svc) {
  const { isWithinSendWindowET } = require('./messaging/send-window');
  if (visitDateHasPassed(svc)) return { done: true, outcome: { state: 'not_sent', note: 'The visit date has passed, so the cancellation text was not sent.' } };
  if (!isWithinSendWindowET(new Date())) return { done: false };
  const AppointmentReminders = require('./appointment-reminders');
  const reported = {};
  const fence = { visitId: bundle.scheduled_service_id, restorations: bundle.restorations_seen, hits: [] };
  await AppointmentReminders.handleCancellation(bundle.scheduled_service_id, {
    sendNotification: true,
    outcome: reported,
    approvedNotice: bundle.approved_notice,
    // The claim proves THIS cancellation under a share lock on the visit, in its own transaction: see
    // AppointmentReminders.claimApprovedNoticeForGeneration.
    cancelGeneration: fence,
  });
  // The claim was refused by the fence: nothing was claimed or sent. Changed visit: abandon. Only busy: retry next pass.
  if (fence.hits.length) {
    const standing = await cancelStillStands(bundle);
    if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true);
    throw new Error(`the visit was busy (${fence.hits.join(', ')}); the text will retry`);
  }
  const classified = classifyNoticeOutcome(reported)
    || { state: 'uncertain', error: 'no result was reported' };
  // Nothing went out and the claim was refused: the visit may have changed between the check and the claim. Say so
  // instead of recording a send failure.
  if (classified.state === 'not_sent') {
    const standing = await cancelStillStands(bundle);
    if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true);
  }
  return { done: true, outcome: classified };
}

async function recoverNotice(bundle, svc) {
  if (bundle.notify_customer !== true) return { done: true, outcome: { state: 'no_text' } };
  if (!Array.isArray(bundle.approved_notice) || !bundle.approved_notice.length) {
    return { done: true, outcome: { state: 'not_sent', note: 'The approved text was not saved with the card, so nothing was sent.' } };
  }
  const AppointmentReminders = require('./appointment-reminders');
  const status = await AppointmentReminders.approvedCancellationNoticeStatus(bundle.scheduled_service_id, { recipients: bundle.approved_notice.length });
  if (status !== 'ready') return { done: true, outcome: NOTICE_TERMINAL_BY_STATUS[status] || NOTICE_TERMINAL_BY_STATUS.other };
  // The money steps just ran and a restore may have landed since: re-prove the cancel before any customer text. (The
  // send's own stamp is conditional on status 'cancelled', and a restore sheds the approved marker.)
  const standing = await cancelStillStands(bundle);
  if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true);
  return sendApprovedNotice(bundle, svc);
}

// ── Receipts ──────────────────────────────────────────────────────────────────────────────────────────────────

const plain = (reason) => scrub(reason).replace(/_/g, ' ');

function followThroughLines(ft) {
  const lines = [];
  for (const m of (ft && ft.money_skipped) || []) lines.push(`Not done: ${String(m.kind).replace(/_/g, ' ')}${m.id ? ` ${m.id}` : ''} (${plain(m.reason)}). The office reviews it.`);
  for (const v of (ft && ft.linked_skipped) || []) lines.push(`Linked visit ${v.id} was not cancelled (${plain(v.reason)}). Check it.`);
  return lines;
}

function noticeLines(bundle, notice) {
  if (!notice || notice.state === 'no_text') return [];
  if (notice.state === 'sent') return ['The approved customer text went out.'];
  const why = notice.note || notice.error || 'no reason given';
  if (notice.state === 'partial') return [`The customer text went to some recipients, not all (${why}). Do not send it again to those reached.`];
  if (notice.state === 'uncertain') return [`The customer text may have gone out (${why}). Check the message history before sending it again.`];
  return [`The customer text did not go out (${why}). Send it by hand if it is still needed.`];
}

/**
 * What the sweep records on the pending action (`result`) and tells the office (`lines`). `needsReview` is true when
 * any step was skipped, uncertain or not sent; a clean recovery has none.
 */
function buildReceipt(bundle, ft, notice) {
  const money = (ft && ft.money_skipped) || [];
  const linked = (ft && ft.linked_skipped) || [];
  const noticeProblems = notice && notice.state !== 'sent' ? noticeLines(bundle, notice) : [];
  const problems = [...followThroughLines(ft), ...noticeProblems];
  const sent = notice && ['sent', 'partial'].includes(notice.state);
  return {
    needsReview: problems.length > 0,
    lines: [...followThroughLines(ft), ...noticeLines(bundle, notice)],
    result: {
      success: true,
      appointment_id: bundle.scheduled_service_id,
      ran_dispatch_cancel: true,
      recovered_after_interruption: true,
      customer_text_sent: Boolean(sent),
      ...(notice && notice.state === 'partial' ? { customer_text_partial: true } : {}),
      ...(notice && notice.state === 'uncertain' ? { customer_text_uncertain: true } : {}),
      ...(linked.length ? { linked_visits_skipped: linked } : {}),
      ...(money.length ? { money_skipped: money } : {}),
      ...(problems.length ? { warning: `The cancel was finished in the background after an interruption. ${problems.join(' ')}` } : {}),
    },
  };
}

function pinnedSummary(bundle) {
  const money = bundle.approved_money || {};
  const parts = [];
  const invoices = (money.invoices || []).length;
  const credits = (money.creditReversalOfferIds || []).length;
  const children = (Array.isArray(bundle.linked_children) ? bundle.linked_children : []).length;
  if (invoices) parts.push(`${invoices} invoice(s) to void`);
  if (credits) parts.push(`${credits} inspection credit(s) to take back`);
  if (children) parts.push(`${children} linked visit(s) to cancel`);
  if (bundle.notify_customer === true) parts.push('the approved customer text');
  return parts.length ? parts.join(', ') : 'no money, linked-visit or text steps';
}

// Who the office reads about: the customer's name and the visit day, best effort.
async function visitInfo(bundle) {
  try {
    const row = await db('scheduled_services as s')
      .leftJoin('customers as c', 'c.id', 's.customer_id')
      .where('s.id', bundle.scheduled_service_id)
      .first('c.first_name', 'c.last_name', 's.service_type', 's.scheduled_date');
    if (!row) return { name: '', day: null, service: null };
    return {
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      day: dateOnly(row.scheduled_date),
      service: row.service_type || null,
    };
  } catch {
    return { name: '', day: null, service: null };
  }
}

// The same facts the request's own receipt carries (cancelReplayResult in tools.js), so the card can name the visit.
const withVisitFacts = (result, info) => ({
  ...result,
  ...(info.name ? { customer_name: info.name } : {}),
  ...(info.service ? { service_type: info.service } : {}),
  ...(info.day ? { date: info.day } : {}),
});

async function recordOnPendingAction(bundle, result) {
  if (!bundle.pending_action_id) return;
  try {
    // onlyIfEmpty: a request that is alive after all records its own receipt over this one.
    await require('./intelligence-bar/pending-actions').recordResult(bundle.pending_action_id, result, { onlyIfEmpty: true });
  } catch (err) {
    logger.warn(`[ib-cancel-bundle] could not record the receipt on pending action: ${scrub(err && err.message)}`);
  }
}

// The office alert (docs/admin-notifications.md): a headline that names the customer, a one-sentence why, the full
// receipt in detail. Anything to check rings (needs-you); a clean recovery leaves a quiet row.
function alertSpec(bundle, info, { review, action, why }) {
  const { fitAction } = require('./admin-alert-names');
  return {
    area: 'Schedule',
    action: fitAction('Schedule', info.name || 'the customer', [action]),
    why,
    severity: review ? 'needs-you' : 'fyi',
    link: info.day ? `/admin/dispatch?tab=schedule&date=${encodeURIComponent(info.day)}` : '/admin/dispatch',
    subject: { type: 'visit', id: String(bundle.scheduled_service_id) },
    doneWhen: 'visit_checked',
    who: 'person',
  };
}

async function tellOffice(bundle, info, { review, action, why, lines }) {
  await require('./admin-alert-compose').raiseAdminAlert('alert', alertSpec(bundle, info, { review, action, why }), {
    dedupeKey: `ib-cancel-bundle:${bundle.id}`,
    detail: [`Visit: ${[info.name, info.service, info.day].filter(Boolean).join(', ') || 'a cancelled visit'}.`, ...lines].join('\n'),
    bell: review,
    fyiRow: true,
    metadata: { bundleId: bundle.id, scheduledServiceId: bundle.scheduled_service_id, source: 'ib-cancel-recovery' },
  });
}

// ── Sweep steps ───────────────────────────────────────────────────────────────────────────────────────────────

async function finishRecovered(bundle, token, ft, notice) {
  await assertStillOwned(bundle.id, token);
  const info = await visitInfo(bundle);
  const receipt = buildReceipt(bundle, ft, notice);
  await recordOnPendingAction(bundle, withVisitFacts(receipt.result, info));
  await tellOffice(bundle, info, {
    review: receipt.needsReview,
    action: receipt.needsReview ? (name) => `check ${name}'s cancelled visit` : (name) => `${name}'s cancel finished`,
    why: receipt.needsReview
      ? 'The cancel finished after an interruption, but some approved steps were skipped or unconfirmed.'
      : 'The invoice, linked-visit and text steps the card approved are all done.',
    lines: receipt.lines.length ? receipt.lines : ['All approved steps are done.'],
  });
  await ownedUpdate(bundle.id, token, {
    status: 'recovered', finished_at: db.fn.now(), finish_note: 'sweep', lease_owner: null, lease_until: null,
  });
}

async function finishAbandoned(bundle, token, reason, partial = false) {
  await assertStillOwned(bundle.id, token);
  const info = await visitInfo(bundle);
  await recordOnPendingAction(bundle, withVisitFacts({
    success: true,
    appointment_id: bundle.scheduled_service_id,
    ran_dispatch_cancel: true,
    recovered_after_interruption: true,
    warning: `The visit is no longer the cancelled visit the card approved (${plain(reason)}), so the approved follow-on steps were ${partial ? 'stopped' : 'NOT run'}. Check the visit's invoices, linked visits and message history.`,
  }, info));
  await tellOffice(bundle, info, {
    review: true,
    action: (name) => `check ${name}'s visit`,
    why: partial
      ? 'The visit was restored while its cancel steps ran, so the rest were stopped.'
      : 'The visit is no longer cancelled, so the approved cancel steps were not run.',
    lines: [
      `Approved on the card: ${pinnedSummary(bundle)}.`,
      `Why it stopped: ${plain(reason)}.`,
      ...(partial ? ['Some steps may already have run before the change. Check the visit, its invoices and its linked visits.'] : []),
    ],
  });
  await ownedUpdate(bundle.id, token, {
    status: 'abandoned', finished_at: db.fn.now(), finish_note: reason, lease_owner: null, lease_until: null,
  });
}

// Run one claimed bundle. Returns 'recovered' | 'abandoned' | 'deferred'. A thrown error leaves the row pending.
async function runBundle(bundle, token) {
  const standing = await cancelStillStands(bundle);
  if (!standing.ok) {
    await finishAbandoned(bundle, token, standing.reason);
    return 'abandoned';
  }
  try {
    let ft = bundle.followthrough_done_at ? bundle.followthrough_outcome : null;
    if (!bundle.followthrough_done_at) ft = await recoverFollowThrough(bundle, token);
    let notice = bundle.notice_outcome || null;
    if (!notice) {
      const step = await recoverNotice(bundle, standing.svc);
      if (!step.done) return 'deferred';
      notice = step.outcome;
      await ownedUpdate(bundle.id, token, { notice_outcome: JSON.stringify({ ...notice, by: 'sweep' }) });
    }
    await finishRecovered(bundle, token, ft || {}, notice);
    return 'recovered';
  } catch (err) {
    if (!(err instanceof Abandon)) throw err;
    await finishAbandoned(bundle, token, err.reason, err.partial);
    return 'abandoned';
  }
}

// Frees the lease without counting a deferral against the attempts, and keeps the row out of every claim until the send
// window opens: the money and linked work of other bundles must never queue behind a text that has to wait.
async function releaseDeferred(bundle, token) {
  const { nextSendWindowOpenET } = require('./messaging/send-window');
  await db(TABLE)
    .where({ id: bundle.id, lease_owner: token, status: 'pending' })
    .update({
      lease_owner: null,
      lease_until: null,
      next_attempt_at: nextSendWindowOpenET(new Date()),
      attempts: db.raw('GREATEST(attempts - 1, 0)'),
      updated_at: db.fn.now(),
    });
}

async function releaseFailed(bundle, token, err) {
  logger.error(`[ib-cancel-bundle] recovery of ${bundle.id} failed (attempt ${bundle.attempts}): ${scrub(err && err.message)}`);
  await db(TABLE)
    .where({ id: bundle.id, lease_owner: token, status: 'pending' })
    .update({ lease_owner: null, lease_until: null, updated_at: db.fn.now() })
    .catch(() => {});
}

// A bundle past the hard stop or out of attempts is only REPORTED: nothing runs, the office checks the visit by hand.
async function reportUnactable(bundle) {
  const why = bundle.attempts >= MAX_ATTEMPTS && new Date(bundle.created_at).getTime() > Date.now() - HARD_STOP_MS
    ? 'attempts_exhausted'
    : 'hard_stop';
  const notice = bundle.notice_outcome || null;
  const done = bundle.followthrough_done_at ? bundle.followthrough_outcome : null;
  const open = [
    ...(done ? [] : ['the invoice, credit and linked-visit steps']),
    ...(notice || bundle.notify_customer !== true ? [] : ['the approved customer text']),
  ];
  const lines = [
    `Approved on the card: ${pinnedSummary(bundle)}.`,
    open.length ? `Not confirmed finished: ${open.join(' and ')}. Nothing more will run on its own.` : 'All steps finished; only the receipt was missing.',
    ...followThroughLines(done),
    ...noticeLines(bundle, notice),
    'Check the visit, its invoices, its linked visits and the customer message history.',
  ];
  const info = await visitInfo(bundle);
  await recordOnPendingAction(bundle, withVisitFacts({
    success: true,
    appointment_id: bundle.scheduled_service_id,
    ran_dispatch_cancel: true,
    recovered_after_interruption: true,
    warning: `The approved follow-on steps of this cancel could not be confirmed (${why === 'hard_stop' ? 'too much time passed' : 'repeated failures'}). Check the visit's invoices, linked visits and message history.`,
  }, info));
  await tellOffice(bundle, info, {
    review: true,
    action: (name) => `check ${name}'s cancelled visit`,
    why: open.length
      ? 'Approved cancel steps were not confirmed finished and will not run on their own.'
      : 'The approved cancel steps finished, but their receipt was missing.',
    lines,
  });
  await db(TABLE)
    .where({ id: bundle.id, status: 'pending' })
    .update({ status: 'expired', finished_at: db.fn.now(), finish_note: why, lease_owner: null, lease_until: null, updated_at: db.fn.now() });
}

async function pruneFinished() {
  await db(TABLE)
    .whereNot('status', 'pending')
    .where('finished_at', '<', nowMinusMs(db, RETENTION_DAYS * 24 * 60 * 60 * 1000))
    .del();
}

/**
 * One pass: report what is past the hard stop, then finish what is stale, oldest first. Returns counts. Safe to run
 * from several pods (SKIP LOCKED + lease) and safe to run late (it queries by age).
 */
async function sweepIbCancelBundles() {
  const summary = { recovered: 0, abandoned: 0, deferred: 0, failed: 0, reported: 0, lost: 0 };
  for (const stale of await listUnactable()) {
    try { await reportUnactable(stale); summary.reported += 1; } catch (err) {
      summary.failed += 1;
      logger.error(`[ib-cancel-bundle] could not report ${stale.id}: ${scrub(err && err.message)}`);
    }
  }
  const token = crypto.randomUUID();
  // A deferred or failed row keeps its lease until the loop ends, so this pass cannot claim the same row again.
  const release = [];
  for (let i = 0; i < BATCH; i += 1) {
    const bundle = await claimNext(token);
    if (!bundle) break;
    try {
      const result = await runBundle(bundle, token);
      summary[result] += 1;
      if (result === 'deferred') release.push(() => releaseDeferred(bundle, token));
    } catch (err) {
      if (err instanceof LeaseLost) {
        // The request (or another pod) finished the row first: nothing is wrong.
        summary.lost += 1;
        logger.warn(`[ib-cancel-bundle] ${err.message}`);
      } else {
        summary.failed += 1;
        release.push(() => releaseFailed(bundle, token, err));
      }
    }
  }
  for (const free of release) await free();
  await pruneFinished().catch((err) => logger.warn(`[ib-cancel-bundle] prune failed: ${scrub(err && err.message)}`));
  return summary;
}

module.exports = {
  insertBundle,
  liveStart,
  liveNotice,
  liveFinish,
  sweepIbCancelBundles,
  classifyNoticeOutcome,
  followThroughArgs,
  buildReceipt,
  alertSpec,
  GRACE_MS,
  LEASE_MS,
  HARD_STOP_MS,
  MAX_ATTEMPTS,
  TABLE,
};
