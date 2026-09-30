'use strict';

/**
 * customer_dunning_schedules — the state machine of one customer's overdue
 * reminder cadence (dunning consolidation §4-§7). PR 2: complete and directly
 * tested, but nothing on the cron or a route calls it yet (the live wiring is
 * PR 3); only shadow.js/runner.shadowRun reads through here, and it never
 * calls a writer.
 *
 * Every function takes `database` (default: the db module) and uses ONLY that
 * handle; the engine's entry points never inject one, it exists so a transaction
 * this module (or a caller's lock) opens is threaded through its own helpers. Every UPDATE stamps updated_at by hand (invoice-followups.js
 * convention) and is guarded on the state it read, so a concurrent writer
 * turns it into a no-op rather than an overwrite.
 *
 * Lock order everywhere: advisory key (lockKey) -> schedule row -> sequence
 * rows. The engine never locks invoice rows.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
const config = require('../../config/invoice-followups');
const Followups = require('../invoice-followups');
const { isTerminalEmailRefusal } = require('../billing-reminder-delivery');
const { dunningCustomerScheduleAllowlist } = require('../../config/feature-gates');
const { OPEN_STATUSES, CLAIM_TTL_MS, lockKey } = require('./constants');
const { promotionSeed, seedRefusal, oldestActive, firstLiveStep } = require('./seed');
const { resolveDunnableSet } = require('./balance-set');

const TABLE = 'customer_dunning_schedules';
const STEPS = config.stepsThrough90;
const FINAL_INDEX = STEPS.length - 1;
// The same terminal set runPending's batch select excludes.
const TERMINAL_INVOICE_STATUSES = ['paid', 'prepaid', 'void', 'processing', 'refunded', 'canceled', 'cancelled'];
// D10: a step held this long gets ONE staff alert (and keeps retrying).
const HELD_ALERT_DAYS = 7;
// Hold reasons the office must resolve by hand: alerted at once, once.
const OFFICE_HOLD_REASONS = Object.freeze(['member_paused', 'member_autopay_hold', 'account_credit_available', 'delivered_evidence_unreadable', 'over_cap']);
const HOUR_MS = 60 * 60 * 1000;

const isFinalIndex = (index) => Number(index) >= FINAL_INDEX;

// ── staff alerts (best effort; never throws) ─────────────────────────────
async function alertStaff({ title, body, dedupeKey, customerId }) {
  try {
    await require('../notification-service').notifyAdmin('alert', title, body, {
      link: customerId ? `/admin/customers?customerId=${customerId}` : '/admin/invoices',
      dedupeKey,
      metadata: { customer_id: customerId || null },
    });
    return true;
  } catch (err) {
    logger.warn(`[customer-dunning] staff alert failed (${dedupeKey}): ${redactContact(err.message)}`);
    return false;
  }
}

// ── cadence ──────────────────────────────────────────────────────────────

/**
 * The latest step whose date on `anchor` has arrived, never below `fromIndex`
 * and never beyond the final step. A step that was never sent because the
 * cron skipped a day is passed over here (logged by the caller), never sent
 * late; the final step is never passed over — it is the cap.
 */
function stageFor(anchor, now, fromIndex = 0) {
  let stage = Math.min(Math.max(Number(fromIndex) || 0, 0), FINAL_INDEX);
  if (!anchor) return stage;
  for (let i = stage + 1; i <= FINAL_INDEX; i += 1) {
    const dueAt = Followups.computeNextTouchAt(anchor, i);
    if (dueAt && dueAt.getTime() <= now.getTime()) stage = i;
  }
  return stage;
}

// ── member rows ──────────────────────────────────────────────────────────

const memberRowsQuery = (database, customerId) => database('invoice_followup_sequences as s')
  .join('invoices as i', 'i.id', 's.invoice_id')
  .where({ 's.customer_id': customerId, 's.status': 'active' })
  .whereNotIn('i.status', TERMINAL_INVOICE_STATUSES)
  .orderBy('i.created_at', 'asc')
  .select(
    's.*',
    'i.sent_at as invoice_sent_at', 'i.sms_sent_at as invoice_sms_sent_at',
    'i.created_at as invoice_created_at', 'i.status as invoice_status',
  );

/** The customer's ACTIVE per-invoice sequences on open invoices, runPending row shape. */
async function activeMemberRows(customerId, { database = db, forUpdate = false } = {}) {
  const query = memberRowsQuery(database, customerId);
  if (forUpdate) query.forUpdate('s');
  return query;
}

/** Narrow rows to the ones the resolved set counts as active members. */
function rowsInSet(rows, set) {
  const ids = new Set((set?.members || []).filter((m) => m.seqStatus === 'active').map((m) => String(m.invoice_id)));
  return rows.filter((r) => ids.has(String(r.invoice_id)));
}

// ── ownership + locks ────────────────────────────────────────────────────
const takeLock = (trx, customerId) => trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey(customerId)]);

async function openScheduleFor(customerId, { database = db } = {}) {
  return database(TABLE).where({ customer_id: customerId }).whereIn('status', OPEN_STATUSES).first();
}

const claimIsFresh = (row, now) => !!row.touch_claimed_at
  && new Date(row.touch_claimed_at).getTime() > now.getTime() - CLAIM_TTL_MS;

const sameStamp = (a, b) => !!a && !!b && new Date(a).getTime() === new Date(b).getTime();

// ── promotion ────────────────────────────────────────────────────────────

async function promotionCandidates({ database = db } = {}) {
  const rows = await database('invoice_followup_sequences as s')
    .join('invoices as i', 'i.id', 's.invoice_id')
    .where('s.status', 'active')
    .whereNotIn('i.status', TERMINAL_INVOICE_STATUSES)
    .whereNull('i.payer_id')
    .where(function withdrawnExcluded() {
      this.whereNull('i.scheduled_send_error').orWhereNot('i.scheduled_send_error', 'like', 'payer_billed:%');
    })
    .whereNotExists(function hasOpenSchedule() {
      this.select(database.raw('1')).from(`${TABLE} as c`)
        .whereRaw('c.customer_id = s.customer_id').whereIn('c.status', OPEN_STATUSES);
    })
    .groupBy('s.customer_id')
    .havingRaw('count(*) >= 2')
    .orderBy('s.customer_id')
    .select('s.customer_id');
  const allow = dunningCustomerScheduleAllowlist();
  const ids = rows.map((r) => String(r.customer_id));
  return allow ? ids.filter((id) => allow.has(id)) : ids;
}

const snapshotOf = (rows) => rows.map((r) => ({
  seq_id: r.id, invoice_id: String(r.invoice_id), step_index: r.step_index,
  next_touch_at: r.next_touch_at || null, last_touch_at: r.last_touch_at || null,
}));

/**
 * Should this customer be promoted, and to what? Pure decision over rows the
 * caller already holds (shared by promote() and the shadow run so they can
 * never disagree). `rows` = all the customer's active member rows.
 */
function promotionDecision(set, rows, now) {
  if (set.kind !== 'multi') return { promote: false, reason: set.kind === 'hold' ? set.reason : `set_${set.kind}` };
  const active = rowsInSet(rows, set);
  // Quiet members (completed / no row) are named but never count toward promotion.
  if (active.length < 2) return { promote: false, reason: 'fewer_than_two_active_members' };
  const seed = promotionSeed(active, now);
  if (!seed) return { promote: false, reason: seedRefusal(active, now) || 'no_seed' };
  return { promote: true, seed, active, absorbed: active.filter((r) => String(r.id) !== String(seed.oldest_seq_id)) };
}

async function nextEpisode(trx, customerId) {
  const row = await trx(TABLE).where({ customer_id: customerId }).max('episode as max').first();
  return Number(row?.max || 0) + 1;
}

async function insertSchedule(trx, customerId, decision, now) {
  const { seed, active } = decision;
  const [row] = await trx(TABLE).insert({
    customer_id: customerId,
    episode: await nextEpisode(trx, customerId),
    status: 'active',
    step_index: seed.step_index,
    next_touch_at: seed.next_touch_at,
    last_touch_at: seed.last_touch_at,
    touches_sent: seed.touches_sent,
    seeded_from: JSON.stringify(snapshotOf(active)),
    created_at: now,
    updated_at: now,
  }).returning('*');
  return row;
}

// The set was resolved BEFORE this transaction (the resolve makes Stripe
// calls; nothing slow may run under the advisory lock, row locks or a pooled
// connection). What the lock protects is the decision: the member rows are
// re-read FOR UPDATE here and promotionDecision narrows the pre-resolved set
// to the rows that are STILL active, so a member that changed in between
// cannot be promoted over. A stale set is harmless anyway — promotion never
// sends, and every send re-resolves and re-checks at the boundary.
async function promoteInTransaction(trx, customerId, set, now) {
  await takeLock(trx, customerId);
  if (await openScheduleFor(customerId, { database: trx })) return { promoted: false, reason: 'already_open' };
  const rows = await activeMemberRows(customerId, { database: trx, forUpdate: true });
  if (rows.some((r) => claimIsFresh(r, now))) return { promoted: false, reason: 'member_claim_fresh' };
  const decision = promotionDecision(set, rows, now);
  if (!decision.promote) return { promoted: false, reason: decision.reason };
  const schedule = await insertSchedule(trx, customerId, decision, now);
  return { promoted: true, schedule, seed: decision.seed };
}

/**
 * Promote ONE customer. Never sends: `next_touch_at` is always a future run's
 * anchor (seed.js). A concurrent promotion loses on the open unique index
 * (23505), which is caught and reported — nothing else was written in the
 * losing transaction, so there is nothing to undo.
 */
async function promoteCustomer(customerId, now = new Date(), { database = db } = {}) {
  const set = await resolveDunnableSet(customerId, { database, now });
  if (set.kind !== 'multi') return { promoted: false, reason: set.kind === 'hold' ? set.reason : `set_${set.kind}` };
  try {
    return await database.transaction((trx) => promoteInTransaction(trx, customerId, set, now));
  } catch (err) {
    if (err.code === '23505') {
      logger.info(`[customer-dunning] promotion of customer ${customerId} lost the race to a concurrent promotion`);
      return { promoted: false, reason: 'concurrent_promotion' };
    }
    throw err;
  }
}

async function promote(now = new Date(), { database = db } = {}) {
  const promoted = [];
  for (const customerId of await promotionCandidates({ database })) {
    try {
      const out = await promoteCustomer(customerId, now, { database });
      if (out.promoted) {
        promoted.push(out.schedule.id);
        logger.info(`[customer-dunning] promoted customer ${customerId} to schedule ${out.schedule.id} at ${STEPS[out.seed.step_index].id} (next ${out.seed.next_touch_at.toISOString()})`);
      } else {
        logger.info(`[customer-dunning] customer ${customerId} not promoted: ${out.reason}`);
      }
    } catch (err) {
      logger.error(`[customer-dunning] promotion failed for customer ${customerId}: ${redactContact(err.message)}`);
    }
  }
  return { promoted };
}

// ── claim / release claim ────────────────────────────────────────────────

// An autopay_hold schedule is revisited on its (daily) next_touch_at: closed when its balance is gone,
// resumed when the customer is no longer on autopay, re-armed while they are.
const CLAIMABLE_STATUSES = Object.freeze(['active', 'held', 'autopay_hold']);

const claimReadable = (row, { expectedStepIndex, force, now }) => {
  if (!row || !CLAIMABLE_STATUSES.includes(row.status)) return false;
  if (expectedStepIndex != null && Number(row.step_index) !== Number(expectedStepIndex)) return false;
  if (!force && (!row.next_touch_at || new Date(row.next_touch_at).getTime() > now.getTime())) return false;
  return !claimIsFresh(row, now);
};

async function stampMemberClaims(trx, rows, claimStamp) {
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await trx('invoice_followup_sequences').whereIn('id', ids)
      .update({ touch_claimed_at: claimStamp, updated_at: trx.fn.now() });
  }
  return ids;
}

/**
 * CLAIM (§5 step 1): one short transaction, no external work. Stamps the
 * schedule and the customer's ACTIVE member rows (null when any of them holds
 * a fresh foreign claim) so InvoiceService.update's
 * existing fence (a fresh touch_claimed_at on the sequence row) applies for the
 * whole send. Returns { schedule, claimStamp, memberSeqIds } or null.
 */
async function claim(scheduleId, now = new Date(), { database = db, force = false, expectedStepIndex = null } = {}) {
  const claimStamp = new Date(now.getTime());
  return database.transaction(async (trx) => {
    const peek = await trx(TABLE).where({ id: scheduleId }).first('customer_id');
    if (!peek) return null;
    await takeLock(trx, peek.customer_id);
    const schedule = await trx(TABLE).where({ id: scheduleId }).forUpdate().first();
    if (!claimReadable(schedule, { expectedStepIndex, force, now })) return null;
    // A member row another worker is sending right now (the per-invoice batch,
    // a payment-side fence) means this customer is being contacted: do not
    // claim, exactly as promotion refuses (member_claim_fresh). The next run
    // finds the row settled.
    const memberRows = await activeMemberRows(schedule.customer_id, { database: trx, forUpdate: true });
    if (memberRows.some((r) => claimIsFresh(r, now))) return null;
    await trx(TABLE).where({ id: scheduleId }).update({ touch_claimed_at: claimStamp, updated_at: trx.fn.now() });
    const memberSeqIds = await stampMemberClaims(trx, memberRows, claimStamp);
    return { schedule: { ...schedule, touch_claimed_at: claimStamp }, claimStamp, memberSeqIds };
  });
}

/** Clear OUR stamps only (a successor may hold the row after a TTL expiry). */
async function releaseClaim(claimed, { database = db } = {}) {
  if (!claimed) return;
  const { schedule, claimStamp, memberSeqIds } = claimed;
  try {
    await database(TABLE).where({ id: schedule.id, touch_claimed_at: claimStamp })
      .update({ touch_claimed_at: null, updated_at: database.fn.now() });
    if (memberSeqIds?.length) {
      await database('invoice_followup_sequences').whereIn('id', memberSeqIds).where({ touch_claimed_at: claimStamp })
        .update({ touch_claimed_at: null, updated_at: database.fn.now() });
    }
  } catch (err) {
    logger.warn(`[customer-dunning] could not clear touch claim for schedule ${schedule.id}: ${redactContact(err.message)}`);
  }
}

// ── release of surviving members (§7) ────────────────────────────────────

// Where a released member row lands: its first non-stale step at/after the
// later of its own and the schedule's index, dated no earlier than the next
// run. null = past even the final step (never stale-completed silently).
function landingFrom(row, fromIndex, now) {
  const anchor = Followups.sequenceAnchor(row);
  const { index, dueAt, pastFinal } = firstLiveStep(anchor, fromIndex, now);
  if (pastFinal) return null;
  const nextAt = !dueAt || dueAt.getTime() <= now.getTime()
    ? Followups.firstEligibleFireAt(Followups.anchorTo10amNY(now, 1, config.sendWindow.hour))
    : dueAt;
  return { stepIndex: index, nextAt };
}

async function releaseOneMember(trx, row, scheduleStep, now) {
  const landing = landingFrom(row, Math.max(Number(row.step_index) || 0, Number(scheduleStep) || 0), now);
  const guard = { id: row.id, status: 'active', step_index: row.step_index };
  if (!landing) {
    await trx('invoice_followup_sequences').where(guard).update({
      status: 'paused', paused_reason: 'released_past_final_step', next_touch_at: null, updated_at: trx.fn.now(),
    });
    return { rowId: row.id, invoiceId: String(row.invoice_id), pausedPastFinal: true };
  }
  await trx('invoice_followup_sequences').where(guard).update({
    step_index: landing.stepIndex, next_touch_at: landing.nextAt, updated_at: trx.fn.now(),
  });
  return { rowId: row.id, invoiceId: String(row.invoice_id), stepIndex: landing.stepIndex, nextAt: landing.nextAt };
}

/**
 * Every member row still ACTIVE goes back to its own per-invoice ladder. No
 * step is repeated (landing starts at max(row step, schedule step)); a row
 * already past its final step is paused for a person, never completed quietly.
 */
async function releaseMembers(trx, schedule, now) {
  const rows = await activeMemberRows(schedule.customer_id, { database: trx, forUpdate: true });
  const landed = [];
  for (const row of rows) landed.push(await releaseOneMember(trx, row, schedule.step_index, now));
  return landed;
}

// ── close / release ──────────────────────────────────────────────────────

const RELEASED_REASONS = new Set(['released_gate_off', 'released_prereq_off', 'released_admin', 'customer_missing']);
const terminalStatusFor = (reason) => (RELEASED_REASONS.has(reason) ? 'released' : 'completed');

async function alertPastFinal(schedule, landed) {
  for (const l of landed.filter((x) => x.pausedPastFinal)) {
    await alertStaff({
      title: 'Overdue invoice past its last reminder',
      body: `Invoice ${l.invoiceId} came off a customer reminder schedule already past its final reminder step. It was paused, not completed; the office should follow up by hand.`,
      dedupeKey: `customer-dunning-past-final:${schedule.id}:${l.invoiceId}`,
      customerId: schedule.customer_id,
    });
  }
}

/**
 * Close a schedule (guarded on it still being open) and release surviving
 * members in ONE transaction. Returns { closed, landed }.
 */
async function close(schedule, reason, now = new Date(), {
  database = db, extra = {}, claimStamp = null, expectedStepIndex = schedule.step_index,
} = {}) {
  const out = await database.transaction(async (trx) => {
    await takeLock(trx, schedule.customer_id);
    // Re-read under the lock: the landings below start from the row AS IT IS
    // NOW (a step that advanced since the caller read it), and a FRESH claim
    // that is not the caller's is a send in flight — closing under it would
    // hand its members back to the per-invoice ladder, which repeats the step
    // it is delivering. Control writes (admin release) pass no claimStamp and are
    // refused while a fresh foreign claim stands. A runner-internal close passes
    // ITS claimStamp and is held to the whole claim it acted on: the stamp must
    // still be the row's (an admin pause / resume clears it, another run replaces
    // it), the schedule must still be active or held (never an admin's pause),
    // and still at the step the runner judged. Anything else is `claim_lost` and
    // closes nothing — a slow worker never overrides a control action.
    const row = await trx(TABLE).where({ id: schedule.id }).whereIn('status', OPEN_STATUSES).forUpdate().first();
    if (!row) return { closed: false, landed: [] };
    if (claimStamp) {
      const ownsClaim = sameStamp(row.touch_claimed_at, claimStamp)
        && CLAIMABLE_STATUSES.includes(row.status) && Number(row.step_index) === Number(expectedStepIndex);
      if (!ownsClaim) return { closed: false, landed: [], reason: 'claim_lost' };
    } else if (claimIsFresh(row, now)) {
      return { closed: false, landed: [], reason: 'in_flight' };
    }
    await trx(TABLE).where({ id: row.id }).update({
      status: terminalStatusFor(reason), closed_reason: reason, closed_at: now,
      next_touch_at: null, updated_at: trx.fn.now(), ...extra,
    });
    return { closed: true, landed: await releaseMembers(trx, row, now) };
  });
  await alertPastFinal(schedule, out.landed);
  logger.info(`[customer-dunning] schedule ${schedule.id} closed (${reason}); ${out.landed.length} member row(s) released`);
  return out;
}

const release = (schedule, reason, now, opts) => close(schedule, reason, now, opts);

// ── advance ──────────────────────────────────────────────────────────────

function nextTouchFor(schedule, activeRows, now) {
  const oldest = oldestActive(activeRows);
  const cadence = oldest ? Followups.computeNextTouchAt(Followups.sequenceAnchor(oldest), Number(schedule.step_index) + 1) : null;
  const floor = Followups.heldTouchFloor(now);
  return cadence && cadence.getTime() > floor.getTime() ? cadence : floor;
}

// `statuses` widens what the guarded write may act on. Only the recovery-settle path (delivery evidence
// already in the ledger, nothing sent) widens it to an autopay_hold row; a send never does.
const guardedOpen = (trx, schedule, claimStamp, statuses = ['active', 'held']) => trx(TABLE)
  .where({ id: schedule.id, step_index: schedule.step_index, touch_claimed_at: claimStamp })
  .whereIn('status', statuses);

/**
 * ADVANCE (§5 step 11): one UPDATE guarded by id, status, step_index and OUR
 * claim. The next date is recomputed from the CURRENT oldest active member
 * (D4/§5.12), never earlier than heldTouchFloor(); step_index never decreases.
 * The final step goes through completeFinal instead.
 */
async function advance(schedule, {
  claimStamp, deliveredAt, activeRows = [], now = new Date(), database = db, fromStatuses, landStatus = 'active',
}) {
  // Settling delivered evidence on an autopay_hold row lands it where the customer's autopay state says:
  // still held (revisited tomorrow) or active (the cadence date, sent by the ordinary path).
  const changed = await guardedOpen(database, schedule, claimStamp, fromStatuses).update({
    touches_sent: Number(schedule.touches_sent) + 1,
    step_index: Number(schedule.step_index) + 1,
    last_touch_at: deliveredAt || now,
    next_touch_at: landStatus === 'autopay_hold' ? Followups.heldTouchFloor(now) : nextTouchFor(schedule, activeRows, now),
    status: landStatus,
    held_reason: null, held_since: null, hold_alerted_at: null,
    link_digest: null, link_url: null,
    updated_at: database.fn.now(),
  });
  return Number(changed) === 1;
}

/**
 * FINAL NOTICE DELIVERED (§5 step 11): in ONE transaction the schedule
 * completes, exactly the invoices the notice NAMED complete, and the
 * survivors (a microdeposit-pending or paused-then-resumed invoice the notice
 * did not name) go back to their own ladder.
 */
async function completeFinal(schedule, {
  claimStamp, deliveredAt, namedInvoiceIds = [], now = new Date(), database = db, fromStatuses,
}) {
  const out = await database.transaction(async (trx) => {
    await takeLock(trx, schedule.customer_id);
    const changed = await guardedOpen(trx, schedule, claimStamp, fromStatuses).update({
      status: 'completed', closed_reason: 'final_notice_delivered',
      final_notice_at: deliveredAt || now, closed_at: now, next_touch_at: null,
      touches_sent: Number(schedule.touches_sent) + 1, last_touch_at: deliveredAt || now,
      held_reason: null, updated_at: trx.fn.now(),
    });
    if (Number(changed) !== 1) return { completed: false, landed: [] };
    if (namedInvoiceIds.length) {
      await trx('invoice_followup_sequences')
        .where({ customer_id: schedule.customer_id, status: 'active' })
        .whereIn('invoice_id', namedInvoiceIds)
        .update({ status: 'completed', next_touch_at: null, updated_at: trx.fn.now() });
    }
    return { completed: true, landed: await releaseMembers(trx, schedule, now) };
  });
  await alertPastFinal(schedule, out.landed);
  return out;
}

// ── disposition (§5 step 10): the ONE path for every non-advance return ──

const TRANSIENT = (r) => r?.retryable === true || r?.held === true || r?.deliveryHeld === true
  || r?.deferred === true || r?.deliveryOutcome === 'uncertain' || r?.code === 'COLLECTIONS_POLICY';

// An email that was not delivered is terminal ONLY when the shared classifier
// says so (no address, email not selected, template off, suppressed). Every
// other failure is retryable, including the real sender's definite non-sends
// — `{ ok: false, error, deliveryOutcome: 'not_sent' }` from a SendGrid 429 or
// a pre-handoff failure carries no `retryable` flag — so an email-only customer
// is never paused for good by a temporary provider failure.
const isTransientResult = (channel, r) => TRANSIENT(r)
  || (channel === 'email' && !!r && r.sent !== true && r.ok !== true && !isTerminalEmailRefusal(r));

// A machine code for held_reason / alerts; a raw provider `error` message can
// echo an address, so it is never used.
function firstCode(results) {
  for (const r of Object.values(results || {})) {
    const code = r?.code || r?.reason;
    if (code) return String(code).slice(0, 80);
    if (r?.error) return 'send_failed';
  }
  return 'not_delivered';
}

/**
 * Classify what a send attempt amounted to. `facts` = { complete, results,
 * delivered (Set of channels delivered now or restored), deliveredNow[] }.
 *   advance -> every leg settled and something was delivered
 *   told    -> something delivered, a leg still pending (B-7)
 *   held    -> nothing delivered, any transient result
 *   paused  -> nothing delivered and every leg terminal
 * COLLECTIONS_POLICY is always treated as transient here: the reminder
 * engine's return does not say whether a denial is durable, and a held step
 * retries daily and alerts staff after HELD_ALERT_DAYS.
 */
function dispositionOf(facts) {
  const delivered = facts.delivered || new Set();
  const results = Object.entries(facts.results || {});
  if (delivered.size > 0) {
    if (facts.complete) return { kind: 'advance' };
    // A leg that is still owed only because it was DEFINITELY not sent (a
    // non-mobile / opted-out number, an unavailable template — no retryable or
    // deferred flag) can never succeed on retry: with a sibling delivered the
    // touch is done, as the per-invoice ladder treats it. Anything retryable
    // keeps the step TOLD so the leg is retried.
    const owed = results.filter(([channel]) => !delivered.has(channel));
    const stuck = owed.some(([channel, r]) => !r || isTransientResult(channel, r));
    return { kind: owed.length && !stuck ? 'advance' : 'told' };
  }
  if (facts.complete) return { kind: 'paused', reason: 'all_channels_terminal' };
  if (!results.length || results.some(([channel, r]) => isTransientResult(channel, r))) return { kind: 'held', reason: firstCode(facts.results) };
  return { kind: 'paused', reason: firstCode(facts.results) };
}

const heldSince = (schedule, now) => schedule.held_since || now;

// A step that stays TOLD (a leg delivered, another retrying) for HELD_ALERT_DAYS
// gets ONE staff alert, so a retry loop can never be silent. Age = since the
// leg first reached the customer (that leg is delivered once, so its time is
// stable across the daily retries).
async function alertTold(schedule, { deliveredAt, now = new Date() }) {
  if (!deliveredAt || now.getTime() - new Date(deliveredAt).getTime() < HELD_ALERT_DAYS * 24 * HOUR_MS) return false;
  const stepId = STEPS[schedule.step_index]?.id || `step${schedule.step_index}`;
  return alertStaff({
    title: 'Customer reminder half-delivered',
    body: `A customer's overdue reminder (${stepId}) reached them on one channel ${HELD_ALERT_DAYS}+ days ago but another channel keeps failing and retrying daily. The office should check the customer's contact details.`,
    dedupeKey: `customer-dunning-told:${schedule.id}:${schedule.episode}:${stepId}`,
    customerId: schedule.customer_id,
  });
}

/** TOLD: a leg reached the customer; the pending leg retries at the next tick. */
async function markTold(schedule, { claimStamp, deliveredAt, now = new Date(), database = db }) {
  const changed = await guardedOpen(database, schedule, claimStamp).update({
    last_touch_at: deliveredAt || now, status: 'active', next_touch_at: Followups.heldTouchFloor(now),
    held_reason: null, held_since: null, hold_alerted_at: null, updated_at: database.fn.now(),
  });
  return Number(changed) === 1;
}

// The engine never applies account credit (owner ruling 2026-09-30): the office does.
const officeHoldBody = (reason, stepId) => (reason === 'account_credit_available'
  ? `The customer has unused account credit, so their overdue reminders are held until it is applied. Apply the credit to their open invoices; the reminders then resume on their own. Step ${stepId}.`
  : `The customer's overdue reminders are held (${reason}); the office should resume or release the schedule. Step ${stepId}.`);

async function alertHeld(schedule, reason, now, database) {
  const stepId = STEPS[schedule.step_index]?.id || `step${schedule.step_index}`;
  const since = new Date(heldSince(schedule, now));
  const long = now.getTime() - since.getTime() >= HELD_ALERT_DAYS * 24 * HOUR_MS;
  const office = OFFICE_HOLD_REASONS.includes(reason);
  if (schedule.hold_alerted_at || (!long && !office)) return false;
  // held_since is part of the key: one alert per HOLD, so a hold that comes
  // back after a release or resume rings again (notifyAdmin dedupes a key for good).
  const sent = await alertStaff({
    title: office ? (reason === 'account_credit_available' ? 'Apply customer account credit' : 'Customer reminders on hold') : 'Customer reminder stuck',
    body: office
      ? officeHoldBody(reason, stepId)
      : `A customer's overdue reminder (${stepId}) has been held ${HELD_ALERT_DAYS}+ days (${reason}) and keeps retrying daily.`,
    dedupeKey: `customer-dunning-held:${schedule.id}:${schedule.episode}:${office ? reason : stepId}:${since.getTime()}`,
    customerId: schedule.customer_id,
  });
  if (sent) {
    // Stamp ONLY this held episode. notifyAdmin ran between markHeld and here; if staff resumed or released
    // the schedule meanwhile (or it advanced), the row is no longer this hold, and writing the stamp back
    // would carry a stale alert mark into the NEXT hold and swallow its alert.
    await database(TABLE).where({ id: schedule.id, status: 'held', held_reason: String(reason).slice(0, 80), held_since: since })
      .update({ hold_alerted_at: now, updated_at: database.fn.now() });
  }
  return sent;
}

/** HELD: retry at the next run; never stale-skipped (A-7, A-15). */
async function markHeld(schedule, reason, { claimStamp, now = new Date(), database = db }) {
  const heldReason = String(reason).slice(0, 80);
  // A new hold starts its clock and its alert over: any transition INTO held from another status (whatever
  // a stale stamp says), or a DIFFERENT reason than the stored one, so an office hold (account credit,
  // paused member) is never swallowed by an earlier alert for another reason.
  const newHold = schedule.status !== 'held' || (!!schedule.held_reason && schedule.held_reason !== heldReason);
  const since = newHold ? now : heldSince(schedule, now);
  const changed = await guardedOpen(database, schedule, claimStamp).update({
    status: 'held', held_reason: heldReason, held_since: since,
    ...(newHold ? { hold_alerted_at: null } : {}),
    next_touch_at: Followups.heldTouchFloor(now), updated_at: database.fn.now(),
  });
  if (Number(changed) === 1) {
    await alertHeld(newHold ? { ...schedule, held_since: since, hold_alerted_at: null } : schedule, String(reason), now, database);
  }
  return Number(changed) === 1;
}

/** PAUSED: terminal for this step (or the customer); staff alert always. */
async function markPaused(schedule, reason, { claimStamp, now = new Date(), database = db }) {
  const changed = await database(TABLE).where({ id: schedule.id, touch_claimed_at: claimStamp })
    .whereIn('status', OPEN_STATUSES).update({
      status: 'paused', paused_reason: String(reason), next_touch_at: null, updated_at: database.fn.now(),
    });
  if (Number(changed) !== 1) return false;
  const stepId = STEPS[schedule.step_index]?.id || `step${schedule.step_index}`;
  await alertStaff({
    title: isFinalIndex(schedule.step_index) ? 'Final notice not delivered' : 'Customer reminders paused',
    body: `${isFinalIndex(schedule.step_index) ? 'The final notice was not delivered. ' : ''}The customer's overdue reminders (${stepId}) were paused: ${reason}. The office should contact the customer or resume the schedule.`,
    // one alert per pause EVENT (a resumed schedule that pauses again rings again)
    dedupeKey: `customer-dunning-paused:${schedule.id}:${schedule.episode}:${stepId}:${reason}:${now.getTime()}`,
    customerId: schedule.customer_id,
  });
  return true;
}

/**
 * AUTOPAY HOLD: the customer is on autopay, so nothing is sent. The schedule is REVISITED the next
 * day (next_touch_at = the held-touch floor), never parked with no date: a balance that clears
 * meanwhile closes it, and a customer who leaves autopay resumes it. Also re-arms an existing hold.
 */
async function markAutopayHold(schedule, { claimStamp, now = new Date(), database = db }) {
  const changed = await database(TABLE)
    .where({ id: schedule.id, step_index: schedule.step_index, touch_claimed_at: claimStamp })
    .whereIn('status', CLAIMABLE_STATUSES)
    .update({ status: 'autopay_hold', next_touch_at: Followups.heldTouchFloor(now), updated_at: database.fn.now() });
  return Number(changed) === 1;
}

/** The revisit found the customer no longer on autopay: back to active so the ordinary send path owns the step. */
async function resumeFromAutopay(schedule, { claimStamp, database = db }) {
  const changed = await database(TABLE)
    .where({ id: schedule.id, step_index: schedule.step_index, touch_claimed_at: claimStamp, status: 'autopay_hold' })
    .update({ status: 'active', updated_at: database.fn.now() });
  return Number(changed) === 1;
}

/** Stage catch-up write (no interaction row; nothing customer-facing happened). */
async function writeStage(schedule, stage, { claimStamp, database = db }) {
  const changed = await guardedOpen(database, schedule, claimStamp)
    .update({ step_index: stage, link_digest: null, link_url: null, updated_at: database.fn.now() });
  return Number(changed) === 1;
}

/** Run `fn(trx)` in a READ ONLY transaction, always rolled back (shadow run). */
async function inReadOnlyTransaction(database, fn) {
  const trx = await database.transaction();
  try {
    await trx.raw('SET TRANSACTION READ ONLY');
    return await fn(trx);
  } finally {
    await trx.rollback();
  }
}

module.exports = {
  TABLE,
  STEPS,
  HELD_ALERT_DAYS,
  isFinalIndex,
  stageFor,
  activeMemberRows,
  rowsInSet,
  openScheduleFor,
  promotionCandidates,
  promotionDecision,
  promoteCustomer,
  promote,
  claim,
  releaseClaim,
  landingFrom,
  releaseMembers,
  close,
  release,
  nextTouchFor,
  advance,
  completeFinal,
  dispositionOf,
  markTold,
  alertTold,
  claimIsFresh,
  markHeld,
  markPaused,
  markAutopayHold,
  resumeFromAutopay,
  writeStage,
  alertStaff,
  inReadOnlyTransaction,
};
