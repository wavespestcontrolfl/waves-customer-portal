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
 *   liveFence / liveStandDown - the follow-through runs under the same cancel fence as the sweep's; a refusal stands the request down
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
 * (or out of attempts) is NOT acted on and is reported to the office. That report is made only by the sweep that
 * CLAIMED the row (same SKIP LOCKED token pattern as the recovery claim), and the request's liveNotice/liveFinish write nothing
 * while any sweep holds a live lease on the row, so a cancel that is finishing is never reported as exhausted.
 *
 * THE RECEIPT. liveFinish marks the row complete BEFORE the route saves the result on the pending action (the card's
 * receipt). A crash between the two would leave a complete row, an empty receipt and the money/linked warnings lost. The
 * warnings are not lost: liveFinish stores them on the row, atomically with 'complete'. So the sweep RECONCILES: a row the
 * request completed, whose pending action still has no result 10 minutes later, gets the receipt rebuilt from the stored
 * outcome (onlyIfEmpty, so a slow request that saves its own wins) and the office alert raised from it. This covers every
 * crash point (and a failed receipt save), and needs no change to the request path or the table.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { countRestorations } = require('./cancel-generation-fence');

const TABLE = 'ib_cancel_effect_bundles';
const GRACE_MS = 10 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
const HARD_STOP_MS = 24 * 60 * 60 * 1000;
// A text whose reminder marker was stamped 'sent' this recently may still be at the provider handoff (a paused worker
// resumes there): the report waits this long so the send can land and leave its audit evidence.
const IN_FLIGHT_GRACE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETENTION_DAYS = 90;
const BATCH = 10;
const REQUEST_LEASE = 'request';
// A sweep that claimed a row only to REPORT it (past the hard stop / out of attempts) leases it under this prefix.
const REPORT_PREFIX = 'report:';
// A row the request completed whose receipt was found missing: marker values of finish_note.
const FINISH_REQUEST = 'request';
const FINISH_RECEIPT_CHECKED = 'request+receipt';

// Database-clock times as bound raw values (one binding each, so no value is spliced into the SQL).
const nowPlusMs = (conn, ms) => conn.raw("now() + (? * interval '1 millisecond')", [ms]);
const nowMinusMs = (conn, ms) => conn.raw("now() - (? * interval '1 millisecond')", [ms]);

const jsonOrNull = (value) => (value === undefined || value === null ? null : JSON.stringify(value));

// Phone numbers can ride on provider error text; mask digit runs before anything is stored or shown.
function scrub(text) {
  return String(text || '').replace(/\+?\d[\d\s().-]{5,}\d/g, '[number]').slice(0, 300);
}

// Each approved linked visit also pins its OWN restoration count (children locked here; the cancel's beforeCommit locked them
// already). If the dead request cancelled a child and an operator restored it before the sweep ran, the child matches its card
// again; the pinned count is how the cascade's child-lock recheck knows it was restored since (see assertApprovedChildUnchanged).
async function pinChildGenerations(trx, children) {
  if (!children.length) return children;
  await trx('scheduled_services').whereIn('id', children.map((c) => c.id)).orderBy('id').forUpdate().select('id');
  const pinned = [];
  for (const child of children) pinned.push({ ...child, restorations_seen: await countRestorations(trx, child.id) });
  return pinned;
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
  const linkedChildren = await pinChildGenerations(trx, Array.isArray(pins.linkedChildren) ? pins.linkedChildren : []);
  const inserted = await trx(TABLE).insert({
    restorations_seen: restorationsSeen,
    pending_action_id: pins.pendingActionId || null,
    scheduled_service_id: pins.scheduledServiceId,
    actor_id: pins.actorId ? String(pins.actorId) : null,
    notes: pins.notes || null,
    notify_customer: pins.notifyCustomer === true,
    approved_notice: jsonOrNull(Array.isArray(pins.approvedNotice) ? pins.approvedNotice : null),
    linked_children: JSON.stringify(linkedChildren),
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

async function guarded(label, fn, req = null) {
  try {
    return await fn();
  } catch (err) {
    // Never fails the request: the row stays pending and the sweep finishes it. The request cannot know what the row holds
    // now, so its reply is provisional (the sweep's note is the record) and gives no manual-send advice.
    logger.warn(`[ib-cancel-bundle] ${label} failed: ${scrub(err && err.message)}`);
    if (req) req.ibCancelBundleLost = true;
    return null;
  }
}

// A request bookkeeping write that changed NO row means the sweep (or a finished recovery) owns the bundle now: the request
// has to say so on its own receipt (req.ibCancelBundleLost -> the route), instead of overwriting the recovery's outcome.
async function trackOwnership(req, label, fn) {
  const changed = await guarded(label, fn, req);
  if (changed === 0) req.ibCancelBundleLost = true;
  return changed;
}

// Heartbeat at the start of the request's post-commit work: the sweep cannot claim before this lease runs out.
// Does not take a lease a sweep already holds (the work below is idempotent either way).
function liveStart(req) {
  const id = req && req.ibCancelBundleId;
  if (!id) return Promise.resolve(null);
  return trackOwnership(req, 'heartbeat', () => db(TABLE)
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

// The cancel fence for the REQUEST's own follow-through (the invoice, credit, linked-visit and tracker steps run after the text):
// the same proof the sweep uses, with the request's lease name as the token. A request that stalled past its lease (the sweep
// took the bundle, or the lease simply ran out) or whose visit was restored meanwhile is stopped at its next effect without a
// write. Returns null (and marks the bundle lost) when the bundle cannot be read: no effect runs unproven.
async function liveFence(req) {
  const id = req && req.ibCancelBundleId;
  if (!id) return null;
  const row = await guarded('fence', () => db(TABLE).where({ id }).first('scheduled_service_id', 'restorations_seen'), req);
  if (!row) {
    req.ibCancelBundleLost = true;
    return null;
  }
  return { visitId: row.scheduled_service_id, restorations: row.restorations_seen, bundleId: id, leaseToken: REQUEST_LEASE, hits: [] };
}

// The request's follow-through was refused by its fence (or hit a step that failed under it): the request stands down. The
// sweep owns the outcome now, re-runs the pinned steps (each is idempotent) or abandons them when the visit was restored. The
// request lease is released so the sweep need not wait it out, unless another owner already holds it. Returns true when stood down.
async function liveStandDown(req, fence) {
  if (!fence || !fence.hits.length) return false;
  req.ibCancelBundleLost = true;
  if (!fence.hits.includes('lease_lost')) {
    await guarded('release', () => db(TABLE)
      .where({ id: fence.bundleId, status: 'pending', lease_owner: REQUEST_LEASE })
      .update({ lease_owner: null, lease_until: null, updated_at: db.fn.now() }));
  }
  return true;
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

// The row's lease is not held by a sweep: either nobody holds it, the request does, or the holder's lease ran out. While a
// sweep holds a live lease the request writes NO bookkeeping (not its text outcome, not 'complete'): the sweep owns the row's
// outcome, and a request that woke up after its own lease ran out must not overwrite or discard what the sweep records.
function notHeldBySweep() {
  this.whereNull('lease_owner').orWhere('lease_owner', REQUEST_LEASE).orWhere('lease_until', '<', db.fn.now());
}

// A request whose approved send reads "not sent" because ANOTHER sender holds the text (the sweep stamped it just before
// the provider handoff, after the request read the reminder as ready) has not failed: the other sender may deliver it. The
// reminder is re-read, and the outcome the request reports (and its receipt) says delivered / partial / uncertain, never
// "send it by hand". Any other not-sent reason (no reminder, consent, a failed send) stays not sent.
async function settleRequestNotice(row, outcome, classified) {
  if (!['not_sent', 'sent'].includes(classified.state) || !row || !Array.isArray(row.approved_notice) || !row.approved_notice.length) return classified;
  const status = await require('./appointment-reminders').approvedCancellationNoticeStatus(row.scheduled_service_id, {
    recipientKeys: row.approved_notice.map((entry) => entry.recipient_key),
  });
  // "Sent" from an unclaimed send rests on ANY accepted audit row, so it is verified per approved recipient too: a recipient
  // the other sender never reached downgrades it to partial (or uncertain), and the receipt says so.
  // The approved marker is still untouched: nothing was claimed or handed to the provider, so the failure was operational (an
  // exception before the claim) or an early return, not a delivery verdict. Not terminal: the sweep claims the marker and sends.
  if (status === 'ready' && classified.state === 'not_sent') return { state: 'open' };
  if (status === 'delivered') {
    if (classified.state === 'sent') return classified;
    Object.assign(outcome, { notificationSent: true, notificationError: null });
    return { state: 'sent', note: NOTICE_TERMINAL_BY_STATUS.delivered.note };
  }
  if (status === 'partial') {
    Object.assign(outcome, { notificationSent: true, notificationPartial: true });
    return { ...NOTICE_TERMINAL_BY_STATUS.partial };
  }
  if (status === 'uncertain') {
    Object.assign(outcome, { notificationSent: false, notificationUncertain: true });
    return { ...NOTICE_TERMINAL_BY_STATUS.uncertain };
  }
  return classified;
}

// The text step ended inside the request: record it so the sweep never sends it again. A not-sent result is the
// operator's to send by hand (the receipt says so); the sweep must not send it behind their back.
function liveNotice(req, outcome) {
  const id = req && req.ibCancelBundleId;
  const classified = classifyNoticeOutcome(outcome);
  if (!id || !classified) return Promise.resolve(null);
  return trackOwnership(req, 'notice outcome', async () => {
    const row = classified.state === 'not_sent' || classified.state === 'sent'
      ? await db(TABLE).where({ id }).first('scheduled_service_id', 'approved_notice')
      : null;
    const settled = await settleRequestNotice(row, outcome, classified);
    if (settled.state === 'open') {
      // No terminal outcome: record nothing, and tell the request's reply the system retries the text (see liveFinish).
      if (outcome && typeof outcome === 'object') { delete outcome.notificationSent; delete outcome.notificationError; }
      req.ibCancelTextPending = true;
      return null;
    }
    return db(TABLE)
      .where({ id, status: 'pending' })
      .where(notHeldBySweep)
      .update({ notice_outcome: JSON.stringify({ ...settled, by: 'request' }), updated_at: db.fn.now() });
  });
}

// The follow-through returned: the request finished its work. The bundle is marked complete ONLY when the text step also has a
// terminal outcome on the row (sent, partial, uncertain or a definite not-sent), or the card chose no text. When the card
// approved a text and no outcome was recorded (the reminder step threw before reporting, or its outcome could not be saved),
// the follow-through is recorded as done and the bundle stays PENDING with the lease freed: the sweep then runs only the text
// step, claiming the still-untouched approved marker as usual (or classifying a marker that a handoff already touched). The
// request flags req.ibCancelTextPending so its own reply says the system is retrying, never "send it by hand".
function liveFinish(req) {
  const id = req && req.ibCancelBundleId;
  if (!id) return Promise.resolve(null);
  const followthrough = {
    money_skipped: (req.ibMoneyReport && req.ibMoneyReport.skipped) || [],
    linked_skipped: (req.ibLinkedChildReport && req.ibLinkedChildReport.skipped) || [],
  };
  return trackOwnership(req, 'complete', async () => {
    const row = await db(TABLE).where({ id }).first('status', 'notify_customer', 'approved_notice', 'notice_outcome');
    const textOpen = Boolean(row) && row.status === 'pending' && row.notify_customer === true
      && Array.isArray(row.approved_notice) && row.approved_notice.length > 0 && !row.notice_outcome;
    const patch = textOpen
      ? { followthrough_done_at: db.fn.now(), followthrough_outcome: JSON.stringify(followthrough), lease_owner: null, lease_until: null, updated_at: db.fn.now() }
      : {
        status: 'complete',
        followthrough_done_at: db.fn.now(),
        followthrough_outcome: JSON.stringify(followthrough),
        finished_at: db.fn.now(),
        finish_note: FINISH_REQUEST,
        lease_owner: null,
        lease_until: null,
        updated_at: db.fn.now(),
      };
    const changed = await db(TABLE)
      .where({ id, status: 'pending' })
      // Not completed under a live sweep lease (see notHeldBySweep): the sweep then finishes the row itself, idempotently,
      // and records its own result; a normal recovery that the request beat to it still ends in the sweep's LeaseLost.
      .where(notHeldBySweep)
      .update(patch);
    if (textOpen && changed) req.ibCancelTextPending = true;
    return changed;
  });
}

// ── The sweep's side ──────────────────────────────────────────────────────────────────────────────────────────

class LeaseLost extends Error {}

const ownedWhere = (id, token) => db(TABLE).where({ id, lease_owner: token, status: 'pending' });

const completeOwnedWhere = (id, token) => db(TABLE).where({ id, lease_owner: token, status: 'complete' });

async function ownedUpdate(id, token, patch) {
  const rows = await ownedWhere(id, token).update({ ...patch, updated_at: db.fn.now() });
  if (!rows) throw new LeaseLost(`lease on bundle ${id} was lost`);
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

// A bundle the sweep must not act on: older than the hard stop, or out of attempts. CLAIMED atomically (SKIP LOCKED, a
// report-prefixed token, no attempt counted), so only one sweep reports it and the request cannot complete it meanwhile.
// A bundle whose approved text was stamped 'sent' in the last IN_FLIGHT_GRACE_MS with no outcome recorded is skipped for
// now: a paused worker may be at the provider handoff, and the report is better written from the evidence once it lands.
async function claimUnactable(token) {
  const result = await db.raw(
    `UPDATE ${TABLE}
        SET lease_owner = ?, lease_until = now() + (? * interval '1 millisecond'), updated_at = now()
      WHERE id = (
        SELECT id FROM ${TABLE}
         WHERE status = 'pending'
           AND (lease_until IS NULL OR lease_until < now())
           AND (created_at <= now() - (? * interval '1 millisecond') OR attempts >= ?)
           AND NOT (notify_customer IS TRUE AND notice_outcome IS NULL AND EXISTS (
             SELECT 1 FROM appointment_reminders ar
              WHERE ar.scheduled_service_id = ${TABLE}.scheduled_service_id
                AND ar.cancellation_notice_state = 'sent'
                AND ar.updated_at > now() - (? * interval '1 millisecond')))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [token, LEASE_MS, HARD_STOP_MS, MAX_ATTEMPTS, IN_FLIGHT_GRACE_MS],
  );
  return (result && result.rows && result.rows[0]) || null;
}

// A row the request completed whose receipt may be missing: complete, request-finished, 10 minutes ago or more, and inside
// the hard stop or not: a gap found late (the scheduler was down, or reconciling kept failing) is still closed, with a
// needs-you alert. Claimed like the others.
async function claimReceiptGap(token) {
  const result = await db.raw(
    `UPDATE ${TABLE}
        SET lease_owner = ?, lease_until = now() + (? * interval '1 millisecond'), updated_at = now()
      WHERE id = (
        SELECT id FROM ${TABLE}
         WHERE status = 'complete'
           AND finish_note = '${FINISH_REQUEST}'
           AND pending_action_id IS NOT NULL
           AND finished_at <= now() - (? * interval '1 millisecond')
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY finished_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [token, LEASE_MS, GRACE_MS],
  );
  return (result && result.rows && result.rows[0]) || null;
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

// Children classified as already cancelled came from an UNLOCKED read: a child the dead request cancelled can have been restored
// since, and it matches its card again. Each is re-read under its own row lock and checked against the generation pinned with
// the bundle (cancelled, same restoration count); one that changed is reported as a linked skip, never recorded as done.
async function recheckCancelledChildren(bundle, ids) {
  if (!ids.length) return [];
  const pinned = new Map((Array.isArray(bundle.linked_children) ? bundle.linked_children : []).map((c) => [String(c.id), c.restorations_seen]));
  const skipped = [];
  await db.transaction(async (trx) => {
    const rows = await trx('scheduled_services').whereIn('id', ids).orderBy('id').forUpdate().select('id', 'status');
    const byId = new Map((rows || []).map((r) => [String(r.id), r]));
    for (const id of ids) {
      const row = byId.get(String(id));
      const want = pinned.get(String(id));
      const restored = !row || String(row.status) !== 'cancelled'
        || (want !== undefined && (await countRestorations(trx, id)) !== Number(want));
      if (restored) skipped.push({ id, reason: 'child_restored_since' });
    }
  });
  return skipped;
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
  // `notice`: delivery evidence the run found before it stopped (the text may already have reached some approved recipients).
  constructor(reason, partial = false, notice = null) {
    super(reason);
    this.reason = reason;
    this.partial = partial;
    this.notice = notice;
  }
}

// The cancel fence every sweep effect passes: the generation the card approved AND this runner's ownership of the bundle
// (services/cancel-generation-fence.js proves both, in the same transaction as each effect). A runner that lost its lease is
// stopped at its next effect without a write.
function sweepFence(bundle, token) {
  return { visitId: bundle.scheduled_service_id, restorations: bundle.restorations_seen, bundleId: bundle.id, leaseToken: token, hits: [] };
}

// An effect was refused because this runner no longer owns the bundle: stop at once, report nothing (the new owner reports).
function throwIfLeaseLost(fence) {
  if (fence.hits.includes('lease_lost')) throw new LeaseLost(`lease on bundle ${fence.bundleId} was lost`);
}

// Keeps the lease alive between steps (and notices a lost one before the next effect starts).
async function renewLease(bundle, token) {
  await ownedUpdate(bundle.id, token, { lease_until: nowPlusMs(db, LEASE_MS) });
}

async function recoverFollowThrough(bundle, token) {
  const { runVisitCancellationFollowThrough } = require('./visit-cancellation-followthrough');
  const reports = { money: { skipped: [] }, linked: { skipped: [] } };
  const fence = sweepFence(bundle, token);
  const { remaining, alreadyCancelled } = await splitLinkedChildren(bundle);
  await runVisitCancellationFollowThrough(followThroughArgs(bundle, remaining, reports, fence));
  throwIfLeaseLost(fence);
  if (fence.hits.length) {
    // A mutation was refused. The visit is either no longer the approved cancel (abandon: some steps may already have
    // run before it changed) or only busy because a restore is in flight (retry on the next pass, nothing is saved).
    const standing = await cancelStillStands(bundle);
    if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true);
    throw new Error(`the visit was busy (${fence.hits.join(', ')}); recovery will retry`);
  }
  const restoredChildren = await recheckCancelledChildren(bundle, alreadyCancelled);
  const restoredIds = new Set(restoredChildren.map((c) => String(c.id)));
  const stillCancelled = alreadyCancelled.filter((id) => !restoredIds.has(String(id)));
  const outcome = {
    money_skipped: reports.money.skipped,
    linked_skipped: [...reports.linked.skipped, ...restoredChildren],
    ...(stillCancelled.length ? { linked_already_cancelled: stillCancelled } : {}),
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
async function sendApprovedNotice(bundle, svc, token) {
  const { isWithinSendWindowET } = require('./messaging/send-window');
  if (visitDateHasPassed(svc)) return { done: true, outcome: { state: 'not_sent', note: 'The visit date has passed, so the cancellation text was not sent.' } };
  if (!isWithinSendWindowET(new Date())) return { done: false };
  const AppointmentReminders = require('./appointment-reminders');
  const reported = {};
  const fence = sweepFence(bundle, token);
  await AppointmentReminders.handleCancellation(bundle.scheduled_service_id, {
    sendNotification: true,
    outcome: reported,
    approvedNotice: bundle.approved_notice,
    // The claim proves THIS cancellation under a share lock on the visit, in its own transaction: see
    // AppointmentReminders.claimApprovedNoticeForGeneration.
    cancelGeneration: fence,
  });
  throwIfLeaseLost(fence);
  // The send window closed before the first recipient was reached: the approved marker is untouched, park to the next window.
  if (fence.windowHeld === true) return { done: false };
  // The claim was refused by the fence: nothing was claimed or sent. Changed visit: abandon. Only busy: retry next pass.
  if (fence.hits.length) {
    const standing = await cancelStillStands(bundle);
    // A later recipient's proof can be refused after an earlier one was already accepted: that evidence goes with the abandon.
    if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true, await noticeEvidence(bundle, classifyNoticeOutcome(reported)));
    throw new Error(`the visit was busy (${fence.hits.join(', ')}); the text will retry`);
  }
  let classified = classifyNoticeOutcome(reported)
    || { state: 'uncertain', error: 'no result was reported' };
  // A send this sweep could not claim reports "sent" on ANY accepted audit row (the request may have texted one approved
  // recipient between the readiness check and the claim). Coverage is proven per approved recipient before it is recorded.
  if (classified.state === 'sent') classified = await verifySentCoverage(bundle, classified);
  // Nothing went out and the claim was refused: the visit may have changed between the check and the claim. Say so
  // instead of recording a send failure.
  if (classified.state === 'not_sent') {
    const standing = await cancelStillStands(bundle);
    if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true, await noticeEvidence(bundle, null));
    return { done: true, outcome: await reclassifyUnclaimedSend(bundle, classified) };
  }
  return { done: true, outcome: classified };
}

// What is known about delivery when the text step stops: the state handleCancellation reported if it says anything went out
// (sent is verified per approved recipient), else the reminder re-read per recipient. null = no evidence that anything went out.
async function noticeEvidence(bundle, reportedState) {
  if (reportedState && ['partial', 'uncertain'].includes(reportedState.state)) return reportedState;
  if (reportedState && reportedState.state === 'sent') return verifySentCoverage(bundle, reportedState);
  const status = await require('./appointment-reminders').approvedCancellationNoticeStatus(bundle.scheduled_service_id, {
    recipientKeys: bundle.approved_notice.map((entry) => entry.recipient_key),
  });
  if (status === 'delivered') return { state: 'sent', note: NOTICE_TERMINAL_BY_STATUS.delivered.note };
  if (status === 'partial') return { ...NOTICE_TERMINAL_BY_STATUS.partial };
  if (status === 'uncertain') return { ...NOTICE_TERMINAL_BY_STATUS.uncertain };
  return null;
}

async function verifySentCoverage(bundle, classified) {
  const status = await require('./appointment-reminders').approvedCancellationNoticeStatus(bundle.scheduled_service_id, {
    recipientKeys: bundle.approved_notice.map((entry) => entry.recipient_key),
  });
  if (status === 'partial') return { ...NOTICE_TERMINAL_BY_STATUS.partial };
  if (status === 'uncertain') return { ...NOTICE_TERMINAL_BY_STATUS.uncertain };
  return classified;
}

// The text step's state for a REPORT (an expiry, an abandonment, a rebuilt receipt) when the bundle has no recorded outcome:
// the reminder re-read per approved recipient. A marker stamped 'sent' with no accepted audit row is a send that may be at
// the provider handoff RIGHT NOW (a paused worker resumes there and nothing can hold it under a lock), so it is reported
// as in flight, never as "nothing more will run", and no one is told to send it again. null = nothing went out.
const IN_FLIGHT_NOTE = 'a send was started for it and its delivery is not proven yet; it may be going out right now';
async function reportedTextState(bundle) {
  if (bundle.notice_outcome) return bundle.notice_outcome;
  if (bundle.notify_customer !== true || !Array.isArray(bundle.approved_notice) || !bundle.approved_notice.length) return null;
  const found = await noticeEvidence(bundle, null);
  return found && found.state === 'uncertain' ? { ...found, in_flight: true, note: IN_FLIGHT_NOTE } : found;
}

// A send this sweep could not claim or complete reads "not sent" from handleCancellation, but the reminder may have been
// taken meanwhile by the original request (it stamps 'sent' just BEFORE the provider handoff, after the status was read as
// 'ready'): its text can still go out a moment later. So the state is re-read before anyone is told to send by hand. Only a
// terminal 'suppressed' marker (the approved send failed or was blocked) stays a plain not-sent; anything delivered or in
// flight is recorded sent, partial or uncertain, which never advises a resend.
async function reclassifyUnclaimedSend(bundle, classified) {
  const AppointmentReminders = require('./appointment-reminders');
  const status = await AppointmentReminders.approvedCancellationNoticeStatus(bundle.scheduled_service_id, {
    recipientKeys: bundle.approved_notice.map((entry) => entry.recipient_key),
  });
  if (status === 'suppressed') return classified;
  if (status === 'delivered') return { state: 'sent', note: NOTICE_TERMINAL_BY_STATUS.delivered.note };
  if (status === 'partial') return { ...NOTICE_TERMINAL_BY_STATUS.partial };
  // The approved marker is still untouched: nothing was claimed or stamped, so nothing reached the provider handoff. The failure
  // was operational (a database error before the claim), not a delivery question: retry the text on the next pass (bounded by
  // the attempts; an exhausted bundle reports the text as not confirmed).
  if (status === 'ready') throw new Error('the approved text was not claimed (nothing was sent); the text will retry');
  return { state: 'uncertain', note: 'Another send already holds this text and its delivery is not proven. It was NOT sent again.' };
}

async function recoverNotice(bundle, svc, token) {
  if (bundle.notify_customer !== true) return { done: true, outcome: { state: 'no_text' } };
  if (!Array.isArray(bundle.approved_notice) || !bundle.approved_notice.length) {
    return { done: true, outcome: { state: 'not_sent', note: 'The approved text was not saved with the card, so nothing was sent.' } };
  }
  const AppointmentReminders = require('./appointment-reminders');
  const status = await AppointmentReminders.approvedCancellationNoticeStatus(bundle.scheduled_service_id, { recipientKeys: bundle.approved_notice.map((entry) => entry.recipient_key) });
  if (status !== 'ready') return { done: true, outcome: NOTICE_TERMINAL_BY_STATUS[status] || NOTICE_TERMINAL_BY_STATUS.other };
  // The money steps just ran and a restore may have landed since: re-prove the cancel before any customer text. (The
  // send's own stamp is conditional on status 'cancelled', and a restore sheds the approved marker.)
  const standing = await cancelStillStands(bundle);
  if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true);
  return sendApprovedNotice(bundle, svc, token);
}

// ── Receipts ──────────────────────────────────────────────────────────────────────────────────────────────────

const plain = (reason) => scrub(reason).replace(/_/g, ' ');

function followThroughLines(ft) {
  const lines = [];
  for (const m of (ft && ft.money_skipped) || []) lines.push(`Not done: ${String(m.kind).replace(/_/g, ' ')}${m.id ? ` ${m.id}` : ''} (${plain(m.reason)}). The office reviews it.`);
  for (const v of (ft && ft.linked_skipped) || []) lines.push(`Linked visit ${v.id} was not cancelled (${plain(v.reason)}). Check it.`);
  return lines;
}

// The text step's state in the receipt's own field names.
function noticeFlags(notice) {
  return {
    customer_text_sent: Boolean(notice && ['sent', 'partial'].includes(notice.state)),
    ...(notice && notice.state === 'partial' ? { customer_text_partial: true } : {}),
    ...(notice && notice.state === 'uncertain' ? { customer_text_uncertain: true } : {}),
  };
}

function noticeLines(bundle, notice) {
  if (!notice || notice.state === 'no_text') return [];
  if (notice.state === 'sent') return ['The approved customer text went out.'];
  const why = notice.note || notice.error || 'no reason given';
  if (notice.state === 'partial') return [`The customer text went to some recipients, not all (${why}). Do not send it again to those reached.`];
  if (notice.state === 'uncertain' && notice.in_flight) return [`The customer text may be going out right now: ${why}. Check the message history before acting. Do not send it again.`];
  if (notice.state === 'uncertain') return [`The customer text may have gone out (${why}). Check the message history before sending it again.`];
  return [`The customer text did not go out (${why}). Send it by hand if it is still needed.`];
}

/**
 * What the sweep records on the pending action (`result`) and tells the office (`lines`). `needsReview` is true when
 * any step was skipped, uncertain or not sent; a clean recovery has none.
 */
function buildReceipt(bundle, ft, notice, { receiptOnly = false } = {}) {
  const money = (ft && ft.money_skipped) || [];
  const linked = (ft && ft.linked_skipped) || [];
  const noticeProblems = notice && notice.state !== 'sent' ? noticeLines(bundle, notice) : [];
  const problems = [...followThroughLines(ft), ...noticeProblems];
  return {
    needsReview: problems.length > 0,
    lines: [...followThroughLines(ft), ...noticeLines(bundle, notice)],
    result: {
      success: true,
      appointment_id: bundle.scheduled_service_id,
      ran_dispatch_cancel: true,
      recovered_after_interruption: true,
      ...noticeFlags(notice),
      ...(linked.length ? { linked_visits_skipped: linked } : {}),
      ...(money.length ? { money_skipped: money } : {}),
      ...(problems.length ? { warning: `${receiptOnly ? 'The cancel finished, but the app stopped before it saved this result.' : 'The cancel was finished in the background after an interruption.'} ${problems.join(' ')}` } : {}),
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

// Saves the receipt on the pending action. A failed save THROWS (recordResult reports a database failure as false, and the
// caller then leaves the row retryable instead of marking it finished with no receipt). A save that finds the receipt already
// there (onlyIfEmpty) is a success: the request's own receipt wins.
async function recordOnPendingAction(bundle, result, conn = null) {
  if (!bundle.pending_action_id) return;
  // The receipt is FINAL (recovery_final): nothing but a request's recovery-owns pointer is ever replaced by it, and it is written
  // on the finalizing transaction (`conn`), so it exists only if the bundle's terminal status does.
  const saved = await require('./intelligence-bar/pending-actions').recordResult(bundle.pending_action_id, { ...result, recovery_final: true }, {
    onlyIfEmpty: true, replaceRecoveryPointer: true, ...(conn ? { database: conn } : {}),
  });
  if (saved === false) throw new Error('the receipt could not be saved on the pending action');
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

async function tellOffice(bundle, info, { review, action, why, lines }, conn = null) {
  // notifyAdmin reports a failed save as null (it never throws); a deliberate suppression is an object, not a failure. A failed
  // alert THROWS, so the row stays retryable (the dedupe key keeps a retry from doubling a row that did land).
  const raised = await require('./admin-alert-compose').raiseAdminAlert('alert', alertSpec(bundle, info, { review, action, why }), {
    dedupeKey: `ib-cancel-bundle:${bundle.id}`,
    detail: [`Visit: ${[info.name, info.service, info.day].filter(Boolean).join(', ') || 'a cancelled visit'}.`, ...lines].join('\n'),
    bell: review,
    fyiRow: true,
    // The bundle's outcome can change between the alert and the bundle's terminal status (a crash, then a restore): a retry
    // rewrites the standing row (and rings it if it now needs a look) instead of leaving the earlier text.
    refreshOnDedupe: true,
    ...(conn ? { trx: conn } : {}),
    metadata: { bundleId: bundle.id, scheduledServiceId: bundle.scheduled_service_id, source: 'ib-cancel-recovery' },
  });
  if (!raised) throw new Error('the office alert could not be saved');
}

// ── Sweep steps ───────────────────────────────────────────────────────────────────────────────────────────────

// ONE transaction finalizes a bundle: it locks the bundle row and checks the lease token, proves the cancellation generation
// (visit share lock, NOWAIT) when the outcome claims a standing cancel, writes the receipt and the office alert on the same
// transaction, and writes the terminal status last. So the receipt and alert exist exactly when the terminal status does:
//  - a worker whose lease was taken over (a pause longer than the lease, then another worker finished the bundle) fails the owner
//    check and writes NOTHING, so it can never replace a terminal receipt or refresh the alert;
//  - a restore found at the proof rolls everything back and the caller reports the abandonment instead (nothing provisional to replace);
//  - a crash anywhere leaves the bundle pending and unwritten, so the retry starts clean (no window needs reconciling).
async function finalizeOwned(bundle, token, { patch, writeOutputs, prove = true, ownerStatus = 'pending' }) {
  const { assertCancelGeneration, isCancelFence } = require('./cancel-generation-fence');
  const fence = { visitId: bundle.scheduled_service_id, restorations: bundle.restorations_seen, hits: [] };
  const ownedRow = (conn) => conn(TABLE).where({ id: bundle.id, lease_owner: token, status: ownerStatus });
  try {
    await db.transaction(async (trx) => {
      if (!(await ownedRow(trx).forUpdate().first('id'))) throw new LeaseLost(`lease on bundle ${bundle.id} was lost`);
      if (prove) await assertCancelGeneration(trx, fence);
      if (writeOutputs) await writeOutputs(trx);
      const rows = await ownedRow(trx).update({ ...patch, lease_owner: null, lease_until: null, updated_at: db.fn.now() });
      if (!rows) throw new LeaseLost(`lease on bundle ${bundle.id} was lost`);
    });
  } catch (err) {
    if (!prove || !isCancelFence(err)) throw err;
    const standing = await cancelStillStands(bundle);
    if (!standing.ok) throw new Abandon(`${standing.reason}_during_recovery`, true);
    throw new Error(`the visit was busy (${fence.hits.join(', ')}); finalizing will retry`);
  }
}

const terminalPatch = (status, finishNote) => ({ status, finish_note: finishNote, finished_at: db.fn.now() });

async function finishRecovered(bundle, token, ft, notice) {
  const info = await visitInfo(bundle);
  const receipt = buildReceipt(bundle, ft, notice);
  await finalizeOwned(bundle, token, {
    patch: terminalPatch('recovered', 'sweep'),
    writeOutputs: async (trx) => {
      await recordOnPendingAction(bundle, withVisitFacts(receipt.result, info), trx);
      await tellOffice(bundle, info, {
        review: receipt.needsReview,
        action: receipt.needsReview ? (name) => `check ${name}'s cancelled visit` : (name) => `${name}'s cancel finished`,
        why: receipt.needsReview
          ? 'The cancel finished after an interruption, but some approved steps were skipped or unconfirmed.'
          : 'The invoice, linked-visit and text steps the card approved are all done.',
        lines: receipt.lines.length ? receipt.lines : ['All approved steps are done.'],
      }, trx);
    },
  });
}

// What is known about the steps when the recovery stops: the saved results of the steps that ended, and the plain fact that
// the original request may have done some of the rest before it stopped (nothing is ever proven "not run").
function abandonedLines(bundle, partial, notice) {
  const done = bundle.followthrough_done_at ? bundle.followthrough_outcome || {} : null;
  const lines = [
    done ? 'The invoice, credit and linked-visit steps had finished before the change.' : 'The invoice, credit and linked-visit steps were not confirmed finished.',
    ...(done ? followThroughLines(done) : []),
    ...(notice ? noticeLines(bundle, notice) : []),
    partial || done
      ? 'Some steps may already have run before the change. Check the visit, its invoices and its linked visits.'
      : 'The recovery ran none of them, but the original request may have done some before it stopped. Check the visit, its invoices and its linked visits.',
  ];
  return lines;
}

// The skipped money and linked-visit steps already saved on the bundle, in the receipt's own field names.
function savedSkips(bundle) {
  const done = bundle.followthrough_done_at ? bundle.followthrough_outcome || {} : {};
  return {
    ...((done.money_skipped || []).length ? { money_skipped: done.money_skipped } : {}),
    ...((done.linked_skipped || []).length ? { linked_visits_skipped: done.linked_skipped } : {}),
  };
}

async function finishAbandoned(bundle, token, reason, partial = false) {
  const info = await visitInfo(bundle);
  const notice = await reportedTextState(bundle);
  const lines = abandonedLines(bundle, partial, notice);
  const result = withVisitFacts({
    success: true,
    appointment_id: bundle.scheduled_service_id,
    ran_dispatch_cancel: true,
    recovered_after_interruption: true,
    ...savedSkips(bundle),
    ...(notice ? noticeFlags(notice) : {}),
    warning: `The visit is no longer the cancelled visit the card approved (${plain(reason)}), so the recovery stopped. ${lines.join(' ')}`,
  }, info);
  // No generation proof: the visit has changed, which is the very thing being reported.
  await finalizeOwned(bundle, token, {
    prove: false,
    patch: terminalPatch('abandoned', reason),
    writeOutputs: async (trx) => {
      await recordOnPendingAction(bundle, result, trx);
      await tellOffice(bundle, info, {
        review: true,
        action: (name) => `check ${name}'s visit`,
        why: partial
          ? 'The visit was restored while its cancel steps ran, so the rest were stopped.'
          : 'The visit is no longer cancelled, so the recovery stopped; some steps may have run.',
        lines: [
          `Approved on the card: ${pinnedSummary(bundle)}.`,
          `Why it stopped: ${plain(reason)}.`,
          ...lines,
        ],
      }, trx);
    },
  });
}

// Run one claimed bundle. Returns 'recovered' | 'abandoned' | 'deferred'. A thrown error leaves the row pending.
async function runBundle(bundle, token) {
  const standing = await cancelStillStands(bundle);
  if (!standing.ok) {
    await finishAbandoned(bundle, token, standing.reason);
    return 'abandoned';
  }
  // What this run has saved so far, so an abandonment later in the SAME run reports it (the claimed snapshot predates it).
  let known = bundle;
  try {
    let ft = bundle.followthrough_done_at ? bundle.followthrough_outcome : null;
    if (!bundle.followthrough_done_at) {
      await renewLease(bundle, token);
      ft = await recoverFollowThrough(bundle, token);
      known = { ...known, followthrough_done_at: new Date(), followthrough_outcome: ft };
    }
    let notice = bundle.notice_outcome || null;
    if (!notice) {
      await renewLease(bundle, token);
      const step = await recoverNotice(bundle, standing.svc, token);
      if (!step.done) return 'deferred';
      notice = step.outcome;
      await ownedUpdate(bundle.id, token, { notice_outcome: JSON.stringify({ ...notice, by: 'sweep' }) });
      known = { ...known, notice_outcome: { ...notice, by: 'sweep' } };
    }
    await finishRecovered(bundle, token, ft || {}, notice);
    return 'recovered';
  } catch (err) {
    if (!(err instanceof Abandon)) throw err;
    // Delivery evidence found before the stop is saved first (a retry of this abandonment then reports it too).
    if (err.notice) {
      const notice = { ...err.notice, by: 'sweep' };
      await ownedUpdate(bundle.id, token, { notice_outcome: JSON.stringify(notice) });
      known = { ...known, notice_outcome: notice };
    }
    await finishAbandoned(known, token, err.reason, err.partial);
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

async function releaseReceiptClaim(bundle, token) {
  await completeOwnedWhere(bundle.id, token)
    .update({ lease_owner: null, lease_until: null, updated_at: db.fn.now() })
    .catch(() => {});
}

// The receipt for a bundle that is only reported: built from what the bundle SAVED (skipped-effect lists, text delivery),
// so a bundle whose steps all finished but whose finalization kept failing still says every step finished.
function unactableResult(bundle, { why, open, done, notice }) {
  const reason = why === 'hard_stop' ? 'too much time passed' : 'repeated failures';
  let head = `Every approved step finished, but the recovery could not be finalized (${reason}).`;
  if (open.length) head = `The approved follow-on steps of this cancel could not be confirmed (${reason}). Not confirmed finished: ${open.join(' and ')}.`;
  else if (notice && notice.in_flight) head = `The invoice, credit and linked-visit steps finished, but the customer text is not confirmed (${reason}).`;
  return {
    success: true,
    appointment_id: bundle.scheduled_service_id,
    ran_dispatch_cancel: true,
    recovered_after_interruption: true,
    ...(notice ? noticeFlags(notice) : {}),
    ...savedSkips(bundle),
    warning: [head, ...followThroughLines(done), ...(notice && notice.state !== 'sent' ? noticeLines(bundle, notice) : []), "Check the visit's invoices, linked visits and message history."].join(' '),
  };
}

// A bundle past the hard stop or out of attempts is only REPORTED: nothing runs, the office checks the visit by hand.
// Returns 'reported' (the expired report) or 'abandoned' (the visit was restored: the abandonment report instead).
async function reportUnactable(bundle, token) {
  // A bundle that ran out of time or attempts AFTER its visit was restored must not be reported as unresolved work on a
  // "cancelled visit": the abandonment result (with the saved outcomes and text evidence) is the right record.
  const standing = await cancelStillStands(bundle);
  if (!standing.ok) {
    await finishAbandoned(bundle, token, standing.reason);
    return 'abandoned';
  }
  try {
    await reportExpired(bundle, token);
    return 'reported';
  } catch (err) {
    if (!(err instanceof Abandon)) throw err;
    await finishAbandoned(bundle, token, err.reason, err.partial);
    return 'abandoned';
  }
}

function expiredWhy(open, inFlight) {
  if (open.length) return 'Approved cancel steps were not confirmed finished and will not run on their own.';
  if (inFlight) return 'The customer text may still be going out and its delivery is not proven.';
  return 'The approved cancel steps finished, but the recovery could not be finalized.';
}

async function reportExpired(bundle, token) {
  const why = bundle.attempts >= MAX_ATTEMPTS && new Date(bundle.created_at).getTime() > Date.now() - HARD_STOP_MS
    ? 'attempts_exhausted'
    : 'hard_stop';
  // The text is judged on the reminder evidence, so a send stamped but not yet proven is reported as in flight and is never
  // part of "nothing more will run" (that sentence covers only the steps listed as not confirmed).
  const notice = await reportedTextState(bundle);
  const done = bundle.followthrough_done_at ? bundle.followthrough_outcome : null;
  const open = [
    ...(done ? [] : ['the invoice, credit and linked-visit steps']),
    ...(notice || bundle.notify_customer !== true ? [] : ['the approved customer text']),
  ];
  const inFlight = Boolean(notice && notice.in_flight);
  let status = 'All steps finished; only the finishing note could not be saved.';
  if (open.length) status = `Not confirmed finished: ${open.join(' and ')}. Nothing more will run on its own for ${open.length > 1 ? 'those steps' : 'that step'}.`;
  else if (inFlight) status = 'The invoice, credit and linked-visit steps finished. The customer text is not confirmed.';
  const lines = [
    `Approved on the card: ${pinnedSummary(bundle)}.`,
    status,
    ...followThroughLines(done),
    ...noticeLines(bundle, notice),
    'Check the visit, its invoices, its linked visits and the customer message history.',
  ];
  const info = await visitInfo(bundle);
  // One transaction: the report claim is checked, the generation proven, the receipt and alert written, the status set last.
  await finalizeOwned(bundle, token, {
    patch: terminalPatch('expired', why),
    writeOutputs: async (trx) => {
      await recordOnPendingAction(bundle, withVisitFacts(unactableResult(bundle, { why, open, done, notice }), info), trx);
      await tellOffice(bundle, info, {
        review: true,
        action: (name) => `check ${name}'s cancelled visit`,
        why: expiredWhy(open, inFlight),
        lines,
      }, trx);
    },
  });
}

// The pending action's stored result, parsed; undefined = no such action, null = no result saved.
async function storedReceipt(pendingActionId) {
  const row = await db('ib_pending_actions').where({ id: pendingActionId }).first('id', 'result');
  if (!row) return undefined;
  if (row.result === null || row.result === undefined) return null;
  try { return typeof row.result === 'string' ? JSON.parse(row.result) : row.result; } catch { return null; }
}

// The request completed this row but may have stopped before it saved the card's receipt. If the receipt is missing, it is
// rebuilt from what the request stored on the row (followthrough_outcome, notice_outcome), saved only if still empty, and the
// office is told (a skipped step rings). A receipt that exists is the request's own and is left alone. Re-running after a
// crash is safe: the save is onlyIfEmpty and the alert has a dedupe key.
async function reconcileReceipt(bundle, token) {
  const stored = await storedReceipt(bundle.pending_action_id);
  const missing = stored === null || (stored !== undefined && stored && stored.recovery_owns_outcome === true);
  let writeOutputs = null;
  if (missing) {
    // The text outcome is unknown only if the request ended before liveNotice ran for a card that asked for a text.
    const notice = (await reportedTextState(bundle))
      || (bundle.notify_customer === true
        ? { state: 'uncertain', note: 'the app stopped before it recorded whether the text went out' }
        : { state: 'no_text' });
    const receipt = buildReceipt(bundle, bundle.followthrough_outcome || {}, notice, { receiptOnly: true });
    // Found after the hard stop: even a clean outcome gets a needs-you note, because nobody saw the result for a day or more.
    const late = Date.now() - new Date(bundle.finished_at).getTime() > HARD_STOP_MS;
    if (late) receipt.needsReview = true;
    const info = await visitInfo(bundle);
    writeOutputs = async (trx) => {
      await recordOnPendingAction(bundle, withVisitFacts(receipt.result, info), trx);
      await tellOffice(bundle, info, {
        review: receipt.needsReview,
        action: receipt.needsReview ? (name) => `check ${name}'s cancelled visit` : (name) => `${name}'s cancel finished`,
        why: receipt.needsReview
          ? (late ? 'The cancel finished, but its result was not saved for over a day, so check the visit.' : 'The cancel finished, but the app stopped before saving its result, and some steps need a look.')
          : 'The cancel finished; only its saved result was missing, and it is saved now.',
        lines: receipt.lines.length ? receipt.lines : ['All approved steps are done.'],
      }, trx);
    };
  }
  // The same single transaction: claim checked, receipt and alert written, the "receipt checked" mark last.
  await finalizeOwned(bundle, token, { prove: false, ownerStatus: 'complete', patch: { finish_note: FINISH_RECEIPT_CHECKED }, writeOutputs });
  return missing ? 'rebuilt' : 'present';
}

async function pruneFinished() {
  await db(TABLE)
    .whereNot('status', 'pending')
    // A complete bundle whose receipt has not been checked yet is never pruned (the receipt reconcile still owes it).
    .whereNot(function receiptStillOwed() {
      this.where({ status: 'complete', finish_note: FINISH_REQUEST }).whereNotNull('pending_action_id');
    })
    .where('finished_at', '<', nowMinusMs(db, RETENTION_DAYS * 24 * 60 * 60 * 1000))
    .del();
}

/**
 * One pass: report what is past the hard stop, then finish what is stale, oldest first. Returns counts. Safe to run
 * from several pods (SKIP LOCKED + lease) and safe to run late (it queries by age).
 */
async function sweepIbCancelBundles() {
  const summary = { recovered: 0, abandoned: 0, deferred: 0, failed: 0, reported: 0, lost: 0, receipts: 0 };
  // Claimed rows keep their lease until the loops end, so one pass cannot claim the same row twice; failures are released then.
  const release = [];
  const reportToken = `${REPORT_PREFIX}${crypto.randomUUID()}`;
  for (let i = 0; i < BATCH; i += 1) {
    const stale = await claimUnactable(reportToken);
    if (!stale) break;
    try {
      summary[await reportUnactable(stale, reportToken)] += 1;
    } catch (err) {
      if (err instanceof LeaseLost) {
        summary.lost += 1;
        logger.warn(`[ib-cancel-bundle] ${err.message}`);
      } else {
        summary.failed += 1;
        logger.error(`[ib-cancel-bundle] could not report ${stale.id}: ${scrub(err && err.message)}`);
        release.push(() => releaseFailed(stale, reportToken, err));
      }
    }
  }
  const token = crypto.randomUUID();
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
  const receiptToken = crypto.randomUUID();
  for (let i = 0; i < BATCH; i += 1) {
    const done = await claimReceiptGap(receiptToken);
    if (!done) break;
    try {
      if (await reconcileReceipt(done, receiptToken) === 'rebuilt') summary.receipts += 1;
    } catch (err) {
      if (err instanceof LeaseLost) {
        summary.lost += 1;
        logger.warn(`[ib-cancel-bundle] ${err.message}`);
      } else {
        summary.failed += 1;
        logger.error(`[ib-cancel-bundle] could not rebuild the receipt of ${done.id}: ${scrub(err && err.message)}`);
        release.push(() => releaseReceiptClaim(done, receiptToken));
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
  liveFence,
  liveStandDown,
  liveFinish,
  sweepIbCancelBundles,
  classifyNoticeOutcome,
  followThroughArgs,
  buildReceipt,
  alertSpec,
  GRACE_MS,
  IN_FLIGHT_GRACE_MS,
  LEASE_MS,
  HARD_STOP_MS,
  MAX_ATTEMPTS,
  TABLE,
};
