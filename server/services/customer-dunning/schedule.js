'use strict';

/**
 * customer_dunning_schedules — the state machine of one customer's overdue
 * reminder cadence (dunning consolidation §4-§7). runPending reaches it under
 * the live gate (promote, then runner.runCustomerSchedules) and through the
 * kill switch (wiring.releaseIfDark); the admin controls through wiring.js.
 * The shadow run (runner.shadowRun) reads through here and never calls a writer.
 *
 * Every function takes `database` (default: the db module) and uses ONLY that
 * handle; the engine's entry points never inject one, it exists so a transaction
 * this module (or a caller's lock) opens is threaded through its own helpers. Every UPDATE stamps updated_at by hand (invoice-followups.js
 * convention) and is guarded on the state it read, so a concurrent writer
 * turns it into a no-op rather than an overwrite.
 *
 * Lock order everywhere: advisory key (lockKey, EXCLUSIVE here) -> schedule
 * row -> member invoice rows (claim only, in id order) -> sequence rows. The
 * per-invoice engine (invoice-followups.js fireStep / sendNextTouchNow) takes
 * the same key SHARED before its own invoice row lock, so the two never
 * acquire in opposite orders.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
const config = require('../../config/invoice-followups');
const Followups = require('../invoice-followups');
const { isTerminalEmailRefusal, reminderProgress } = require('../billing-reminder-delivery');
const { dunningCustomerScheduleAllowlist } = require('../../config/feature-gates');
const {
  OPEN_STATUSES, CLAIM_TTL_MS, SOURCE, lockKey, eventKey,
} = require('./constants');
const { promotionSeed, seedRefusal, oldestActive, firstLiveStep } = require('./seed');
const { resolveDunnableSet } = require('./balance-set');
const { claimVerdict } = require('../collections/contact-ledger');

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
// Raised through raiseAdminAlert (docs/admin-notifications.md). Every alert is needs-you: a person
// acts (applies credit, resumes a schedule, contacts the customer); none is an engine failure Claude
// could fix on its own (a delivery the engine cannot read is still a records decision for the office).

// What a person reads for a reason code: the code itself (snake_case, upper-case) never reaches the copy.
const REASON_TEXT = Object.freeze({
  member_paused: 'an invoice on their balance is paused',
  member_autopay_hold: 'an invoice on their balance is on autopay hold',
  account_credit_available: 'unused account credit',
  delivered_evidence_unreadable: 'a delivered notice cannot be read back',
  over_cap: 'the reminder cap was reached',
  no_reachable_channel: 'there is no way to reach them',
  all_channels_terminal: 'every channel was refused',
  customer_deleted: 'the customer was archived',
  collection_hold: 'a collections hold is active',
});
const reasonText = (reason) => REASON_TEXT[reason] || 'a delivery problem';

async function customerName(customerId) {
  if (!customerId) return null;
  try {
    const row = await db('customers').where({ id: customerId }).first('first_name', 'last_name');
    const first = String(row?.first_name || '').trim();
    const last = String(row?.last_name || '').trim();
    return first ? { full: `${first} ${last}`.trim(), first } : null;
  } catch {
    return null; // the alert still rings, with a generic headline
  }
}

/**
 * `verb` completes "<verb> for <Customer Name>" (the headline names the customer when it fits the 60
 * characters the rule allows, then the first name, then falls back to `generic`).
 */
async function alertStaff({ verb, generic, why, doneWhen, dedupeKey, customerId, subject = null, metadata = {} }) {
  try {
    const { composeAdminAlert, raiseAdminAlert } = require('../admin-alert-compose');
    const name = await customerName(customerId);
    const subj = customerId ? { type: 'customer', id: String(customerId) } : subject;
    const spec = (action) => ({
      area: 'Billing', action, why, severity: 'needs-you', who: 'person', doneWhen, subject: subj,
      link: customerId ? `/admin/customers?customerId=${encodeURIComponent(customerId)}` : '/admin/invoices',
    });
    const candidates = name ? [`${verb} for ${name.full}`, `${verb} for ${name.first}`, generic] : [generic];
    const action = candidates.find((candidate) => {
      try { composeAdminAlert(spec(candidate)); return true; } catch { return false; }
    }) || generic;
    await raiseAdminAlert('alert', spec(action), { dedupeKey, metadata: { customer_id: customerId || null, ...metadata } });
    return true;
  } catch (err) {
    logger.warn(`[customer-dunning] staff alert failed (${dedupeKey}): ${redactContact(err.message)}`);
    if (process.env.NODE_ENV === 'test' && err.code === 'ADMIN_ALERT_RULE') throw err; // the emitter's own tests catch a copy violation
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

async function lockMemberInvoices(trx, customerId) {
  const ids = [...new Set((await activeMemberRows(customerId, { database: trx })).map((r) => String(r.invoice_id)))].sort();
  if (ids.length) await trx('invoices').whereIn('id', ids).orderBy('id').forUpdate().select('id');
  return new Set(ids);
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
    // Lock the member INVOICE rows first, in id order - the invoice edit path's own order (it locks the invoice
    // row, THEN checks for a fresh claim on its sequence): an edit that already holds the invoice makes this
    // claim wait and then see its commit; an edit that comes after waits here and then sees the fresh claim and
    // refuses. Either way no title / service date / due date can commit under an in-flight touch unseen.
    const lockedInvoices = await lockMemberInvoices(trx, schedule.customer_id);
    const memberRows = await activeMemberRows(schedule.customer_id, { database: trx, forUpdate: true });
    if (memberRows.some((r) => !lockedInvoices.has(String(r.invoice_id)))) return null; // a member joined mid-claim: next run
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

// ── delivery evidence of a touch (shared with runner.js) ─────────────────

const metadataOf = (entry) => {
  if (typeof entry?.metadata !== 'string') return entry?.metadata || {};
  try { return JSON.parse(entry.metadata); } catch { return {}; }
};

const parseIds = (value) => {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
};

/**
 * The invoices a final notice named, leg by leg. A leg delivered in THIS tick named the set this tick quoted
 * (run.memberIds) - never an entry: when the post-send progress read fails the loaded entries are the
 * recover-first snapshots, and a failed or pending leg's snapshot may quote other invoices than the notice
 * that actually went out. A leg delivered EARLIER is read from its delivered reservation (event entries,
 * including a restored one); a failed or pending snapshot is never evidence. A delivered leg with neither is
 * unreadable; the caller must not complete anything for it.
 */
function namedForFinal(run, facts) {
  const ids = new Set();
  const covered = new Set();
  const sentNow = new Set(run.memberIds?.length ? facts.deliveredNow || [] : []);
  for (const channel of sentNow) {
    if (!facts.delivered.has(channel)) continue;
    run.memberIds.forEach((id) => ids.add(String(id)));
    covered.add(channel);
  }
  for (const entry of facts.event?.entries || []) {
    if (!facts.delivered.has(entry.channel) || covered.has(entry.channel)) continue;
    const meta = metadataOf(entry);
    if (meta.send_failed === true && meta.delivered !== true) continue; // a failed attempt's snapshot, not a delivered notice
    const named = parseIds(entry.invoice_ids);
    if (!named.length) continue;
    named.forEach((id) => ids.add(String(id)));
    covered.add(entry.channel);
  }
  const unreadable = [...facts.delivered].filter((channel) => !covered.has(channel));
  return { ids: [...ids], unreadable };
}

const EVERY_CHANNEL = Object.freeze(['email', 'push', 'sms']);

// A leg whose keyed reservation exists but whose outcome was never confirmed (a sender that died between the
// reservation and the provider's answer): the ledger's own claim decision (claimVerdict, the one the live
// claim and the shadow run use) refuses to retry it (`held`), and the live run holds the step on
// REMINDER_OUTCOME_UNCONFIRMED. It may have reached the customer.
const outcomeUnconfirmed = (event) => (event.entries || []).some((entry) => !event.delivered.has(entry.channel)
  && claimVerdict({ id: entry.id, reused: true, metadata: metadataOf(entry) }).held === true);

/**
 * What the schedule's CURRENT step already did, read from that touch's own ledger event exactly as
 * recover-first reads it (reminderProgress by its event key, no time window, read-only: nothing repaired).
 * null = nothing delivered and nothing unconfirmed. Otherwise { delivered, unconfirmed, final, named }:
 * `unconfirmed` = a leg's outcome is unknown (release must not hand members back: it could resend it);
 * `named` = the Set of invoices the delivered legs quoted (namedForFinal), or null when a delivered leg's
 * names cannot be read. Throws when the ledger cannot be read: the caller must not hand members back blind.
 */
async function currentStepDelivery(schedule) {
  const step = STEPS[Number(schedule.step_index)];
  if (!step) return null;
  const key = eventKey(schedule, step.id);
  const progress = await reminderProgress(schedule.customer_id, SOURCE, EVERY_CHANNEL, { eventKey: key, repair: false });
  const event = (progress || []).find((e) => e?.metadata?.notificationEventKey === key);
  if (!event) return null;
  const delivered = event.delivered?.size > 0;
  const unconfirmed = outcomeUnconfirmed({ ...event, delivered: event.delivered || new Set() });
  if (!delivered && !unconfirmed) return null;
  const { ids, unreadable } = delivered ? namedForFinal({}, { event, delivered: event.delivered }) : { ids: [], unreadable: [] };
  return {
    delivered, unconfirmed, final: isFinalIndex(schedule.step_index), named: unreadable.length ? null : new Set(ids),
  };
}

// ── release of surviving members (§7) ────────────────────────────────────

const nextRunFloor = (now) => Followups.firstEligibleFireAt(Followups.anchorTo10amNY(now, 1, config.sendWindow.hour));

// A step the LIVE ladder does not have (GATE_DUNNING_LADDER_90 off: the schedule reached Day 60/90 on the
// 90-day cadence): the row keeps that step, dated on the 90-day cadence, exactly like a per-invoice row the
// ladder advanced past Day 30 before the gate went off. Main's own rule then applies: the legacy cadence
// never fires it (fireTouch completes a step it does not have) and hasActiveSequence hands the invoice to
// the legacy late-payment checker, the Day 60/90 sender while the ladder is off. Clamping to the legacy
// final step instead would send Day 30 again.
function beyondLiveLadder(anchor, fromIndex, now) {
  const step = STEPS[fromIndex];
  if (!step) return null;
  const dueAt = anchor ? Followups.anchorTo10amNY(new Date(anchor), step.daysAfterSend, config.sendWindow.hour) : null;
  return { stepIndex: fromIndex, nextAt: dueAt && dueAt.getTime() > now.getTime() ? dueAt : nextRunFloor(now) };
}

// Where a released member row lands: its first non-stale step at/after the
// later of its own and the schedule's index, dated no earlier than the next
// run. null = past even the final step (never stale-completed silently).
function landingFrom(row, fromIndex, now) {
  const anchor = Followups.sequenceAnchor(row);
  if (Number(fromIndex) > Followups.followupSteps().length - 1) return beyondLiveLadder(anchor, Number(fromIndex), now);
  const { index, dueAt, pastFinal } = firstLiveStep(anchor, fromIndex, now);
  if (pastFinal) return null;
  const nextAt = !dueAt || dueAt.getTime() <= now.getTime() ? nextRunFloor(now) : dueAt;
  return { stepIndex: index, nextAt };
}

/**
 * What release does with ONE active member row (pure; shared by releaseMembers and the release script's dry
 * run). `delivery` = currentStepDelivery of the schedule (null when the caller hands back survivors of a
 * notice it already settled, e.g. completeFinal). Never repeats a step:
 *   - the schedule's current step DELIVERED (a TOLD partial delivery, or a crashed sender's delivered leg)
 *     to this invoice: its own ladder starts AFTER that step; when the names cannot be read, every member
 *     does (the safe direction is never resending);
 *   - a delivered FINAL notice that named this invoice: completed as completeFinal completes it (cadence-
 *     exhausted step); unreadable names: paused for a person (never completed, never sent again);
 *   - past its final step: paused for a person;
 *   - a PAUSED schedule (the office's pause, or the engine's): the row keeps that pause on its own ladder,
 *     at its landing step, so releasing never resumes reminders nobody resumed.
 * Returns { kind: 'land', stepIndex, nextAt } | { kind: 'paused', stepIndex, pausedReason, pausedBy }
 *   | { kind: 'complete' } | { kind: 'pause_for_person', reason }.
 */
function memberLanding(row, schedule, evidence, now) {
  const delivery = evidence?.delivered === false ? null : evidence; // only DELIVERED evidence moves a landing
  const scheduleStep = Number(schedule.step_index) || 0;
  const named = !delivery?.named || delivery.named.has(String(row.invoice_id));
  if (delivery?.final) {
    if (!delivery.named) return { kind: 'pause_for_person', reason: 'released_final_notice_unreadable' };
    if (named) return { kind: 'complete' };
  }
  const floor = delivery && !delivery.final && named ? scheduleStep + 1 : scheduleStep;
  const landing = landingFrom(row, Math.max(Number(row.step_index) || 0, floor), now);
  if (!landing) return { kind: 'pause_for_person', reason: 'released_past_final_step' };
  if (schedule.status === 'paused') {
    return {
      kind: 'paused', stepIndex: landing.stepIndex,
      pausedReason: schedule.paused_reason || 'customer_schedule_paused', pausedBy: schedule.paused_by_admin_id || null,
    };
  }
  return { kind: 'land', ...landing };
}

async function releaseOneMember(trx, row, schedule, delivery, now) {
  const plan = memberLanding(row, schedule, delivery, now);
  const guard = { id: row.id, status: 'active', step_index: row.step_index };
  const out = { rowId: row.id, invoiceId: String(row.invoice_id) };
  const write = (patch) => trx('invoice_followup_sequences').where(guard).update({ ...patch, updated_at: trx.fn.now() });
  if (plan.kind === 'complete') {
    // completeFinal's mark: past the last ladder step, so neither revival pass restarts it
    await write({ status: 'completed', step_index: STEPS.length, next_touch_at: null });
    return { ...out, completed: true };
  }
  if (plan.kind === 'pause_for_person') {
    await write({ status: 'paused', paused_reason: plan.reason, next_touch_at: null });
    return { ...out, pausedPastFinal: true, reason: plan.reason };
  }
  if (plan.kind === 'paused') {
    await write({
      status: 'paused', step_index: plan.stepIndex, paused_reason: plan.pausedReason, paused_by_admin_id: plan.pausedBy, next_touch_at: null,
    });
    return { ...out, stepIndex: plan.stepIndex, paused: true };
  }
  await write({ step_index: plan.stepIndex, next_touch_at: plan.nextAt });
  return { ...out, stepIndex: plan.stepIndex, nextAt: plan.nextAt };
}

/**
 * Every member row still ACTIVE goes back to its own per-invoice ladder (memberLanding: no step repeated,
 * a delivered current step never sent again, a paused schedule's pause kept, a row past its final step
 * paused for a person, never completed quietly).
 */
async function releaseMembers(trx, schedule, now, delivery = null) {
  const rows = await activeMemberRows(schedule.customer_id, { database: trx, forUpdate: true });
  const landed = [];
  for (const row of rows) landed.push(await releaseOneMember(trx, row, schedule, delivery, now));
  return landed;
}

// ── close / release ──────────────────────────────────────────────────────

const RELEASED_REASONS = new Set(['released_gate_off', 'released_prereq_off', 'released_admin', 'released_merge', 'customer_missing']);
const terminalStatusFor = (reason) => (RELEASED_REASONS.has(reason) ? 'released' : 'completed');

async function alertPastFinal(schedule, landed) {
  for (const l of landed.filter((x) => x.pausedPastFinal)) {
    await alertStaff({
      verb: 'follow up on an overdue invoice',
      generic: 'follow up on an overdue invoice',
      why: l.reason === 'released_final_notice_unreadable'
      ? 'An invoice came off the reminder schedule after its final notice, which cannot be read back; it was paused.'
      : 'An invoice came off the reminder schedule already past its last step; it was paused, not completed.',
      doneWhen: 'invoice_followed_up',
      dedupeKey: `customer-dunning-past-final:${schedule.id}:${l.invoiceId}`,
      customerId: schedule.customer_id,
      metadata: { invoice_id: l.invoiceId },
    });
  }
}

// The schedule row's version: PostgreSQL's xmin, which EVERY write to the row changes (a claim, markTold,
// markHeld, advance, releaseClaim, a control write), including a same-step send that only stamps
// last_touch_at. No column a writer might forget to stamp is trusted for it.
const ROW_VERSION = 'xmin as row_version'; // xid: node-pg hands it back as a string
const rowSnapshot = (database, id) => database(TABLE).where({ id }).whereIn('status', OPEN_STATUSES)
  .first('step_index', 'episode', ROW_VERSION);

// One attempt at close: the landings use the delivery evidence read against `at` (the row version read
// BEFORE that evidence). A row whose version moved since is returned as `changed`: a send may have
// delivered in between, so the caller reads the evidence again.
//
// closeUnderLock runs it on the CALLER's transaction (a customer merge closes inside its own transaction, so
// a merge that later refuses rolls the release back with it); it takes the customer's key itself, which is
// re-entrant for a transaction that already holds it. Nothing in it reads outside `trx`.
async function closeUnderLock(trx, schedule, reason, now, at, delivery, { extra = {}, claimStamp = null, expectedStepIndex = schedule.step_index } = {}) {
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
  const row = await trx(TABLE).where({ id: schedule.id }).whereIn('status', OPEN_STATUSES).forUpdate()
    .first('*', ROW_VERSION);
  if (!row) return { closed: false, landed: [] };
  if (claimStamp) {
    const ownsClaim = sameStamp(row.touch_claimed_at, claimStamp)
      && CLAIMABLE_STATUSES.includes(row.status) && Number(row.step_index) === Number(expectedStepIndex);
    if (!ownsClaim) return { closed: false, landed: [], reason: 'claim_lost' };
  } else if (claimIsFresh(row, now)) {
    return { closed: false, landed: [], reason: 'in_flight' };
  }
  // The evidence fence: any write since the snapshot the evidence was read against (a same-step TOLD
  // delivery that cleared its claim included) makes that evidence stale.
  if (row.row_version !== at.row_version) return { closed: false, landed: [], changed: true };
  // A leg of the current step whose outcome is unconfirmed: handing members back could send that step
  // again on their own ladders, so nothing is released while one remains to land (judged after the
  // in-flight check: a send in flight right now is the next run's, not an unconfirmed outcome).
  if (delivery?.unconfirmed && (await activeMemberRows(row.customer_id, { database: trx, forUpdate: true })).length) {
    return { closed: false, landed: [], reason: 'outcome_unconfirmed' };
  }
  await trx(TABLE).where({ id: row.id }).update({
    status: terminalStatusFor(reason), closed_reason: reason, closed_at: now,
    next_touch_at: null, updated_at: trx.fn.now(), ...extra,
  });
  return { closed: true, landed: await releaseMembers(trx, row, now, delivery) };
}

const closeOnce = (schedule, reason, now, at, delivery, { database, ...opts }) => database.transaction(
  (trx) => closeUnderLock(trx, schedule, reason, now, at, delivery, opts),
);

/**
 * Close a schedule (guarded on it still being open) and release surviving
 * members in ONE transaction. Returns { closed, landed, reason? }.
 *
 * The current step's delivery evidence (currentStepDelivery) is read BEFORE the
 * transaction (nothing slow runs under the advisory lock or row locks), against
 * a snapshot of the row's version taken just before it. Under the lock the row
 * must still be that version: any write in between (a send that delivered a leg
 * and marked the step TOLD, an advance, a claim) means the evidence may be stale,
 * so it is read again and the close retried (`schedule_changed` after
 * CLOSE_ATTEMPTS). A send records its delivery in the ledger before the row writes
 * that end it (markTold / advance / completeFinal, then releaseClaim), so an
 * unchanged version means no send finished in between; one still running holds a
 * fresh claim (`in_flight`) or left an unstamped reservation (`outcome_unconfirmed`).
 * Evidence that cannot be read
 * closes nothing (`evidence_unreadable`): handing members back blind could send
 * a step that already went out. Nor does a current step with a leg whose outcome
 * is unconfirmed while members remain to land (`outcome_unconfirmed`).
 */
const CLOSE_ATTEMPTS = 3;

async function close(schedule, reason, now = new Date(), {
  database = db, extra = {}, claimStamp = null, expectedStepIndex = schedule.step_index,
} = {}) {
  let out = null;
  for (let attempt = 0; attempt < CLOSE_ATTEMPTS && !out; attempt += 1) {
    const at = await rowSnapshot(database, schedule.id);
    if (!at) return { closed: false, landed: [] }; // already closed
    let delivery;
    try {
      delivery = await currentStepDelivery({ ...schedule, step_index: at.step_index, episode: at.episode });
    } catch (err) {
      logger.error(`[customer-dunning] schedule ${schedule.id} not closed (${reason}): delivery evidence unreadable: ${redactContact(err.message)}`);
      return { closed: false, landed: [], reason: 'evidence_unreadable' };
    }
    const attemptOut = await closeOnce(schedule, reason, now, at, delivery, {
      database, extra, claimStamp, expectedStepIndex,
    });
    if (!attemptOut.changed) out = attemptOut;
  }
  if (!out) return { closed: false, landed: [], reason: 'schedule_changed' };
  // Only a close that happened is reported: a refused one (claim_lost / in_flight / already closed) changed nothing.
  if (out.closed) {
    await alertPastFinal(schedule, out.landed);
    logger.info(`[customer-dunning] schedule ${schedule.id} closed (${reason}); ${out.landed.length} member row(s) released`);
  }
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
        // step_index past the last ladder step: the per-invoice "cadence
        // exhausted" mark. Both revival passes (Day 60/90 and reopened
        // low-step) select completed rows INSIDE the ladder, so a member the
        // final notice named, left on its low promotion-time step, would be
        // revived next run and dunned again after its final notice.
        .update({ status: 'completed', step_index: STEPS.length, next_touch_at: null, updated_at: trx.fn.now() });
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
    verb: 'check contact details',
    generic: 'check a customer\'s contact details',
    why: `A reminder reached them one way ${HELD_ALERT_DAYS}+ days ago; the other way keeps failing and retrying daily.`,
    doneWhen: 'contact_details_checked',
    dedupeKey: `customer-dunning-told:${schedule.id}:${schedule.episode}:${stepId}`,
    customerId: schedule.customer_id,
    metadata: { step_id: stepId },
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
function heldAlertCopy(reason, office) {
  if (reason === 'account_credit_available') {
    return {
      verb: 'apply account credit', generic: 'apply a customer\'s account credit',
      why: 'Unused account credit is holding their overdue reminders until it is applied.',
    };
  }
  if (office) {
    return {
      verb: 'review held reminders', generic: 'review a customer\'s held reminders',
      why: `Their overdue reminders are held: ${reasonText(reason)}.`,
    };
  }
  return {
    verb: 'check stuck reminders', generic: 'check a customer\'s stuck reminders',
    why: `Their overdue reminder has been held ${HELD_ALERT_DAYS}+ days (${reasonText(reason)}) and keeps retrying daily.`,
  };
}

async function alertHeld(schedule, reason, now, database) {
  const stepId = STEPS[schedule.step_index]?.id || `step${schedule.step_index}`;
  const since = new Date(heldSince(schedule, now));
  const long = now.getTime() - since.getTime() >= HELD_ALERT_DAYS * 24 * HOUR_MS;
  const office = OFFICE_HOLD_REASONS.includes(reason);
  // A collections hold is a WAIT the office placed itself: like the per-invoice ladder, no alert.
  if (reason === 'collection_hold') return false;
  if (schedule.hold_alerted_at || (!long && !office)) return false;
  // held_since is part of the key: one alert per HOLD, so a hold that comes
  // back after a release or resume rings again (notifyAdmin dedupes a key for good).
  const sent = await alertStaff({
    ...heldAlertCopy(reason, office),
    doneWhen: reason === 'account_credit_available' ? 'credit_applied' : 'hold_released',
    dedupeKey: `customer-dunning-held:${schedule.id}:${schedule.episode}:${office ? reason : stepId}:${since.getTime()}`,
    customerId: schedule.customer_id,
    metadata: { step_id: stepId, reason: String(reason).slice(0, 80) },
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
  // An autopay_hold schedule revisited under the run's own claim can fail a lookup (prefs, progress, the
  // autopay state itself): the failure hold must land on it, or the write matches nothing and the hold's
  // clock never starts. (It is the only claim-guarded writer reachable from an autopay_hold claim that
  // guardedOpen excluded: pause already acts on any open row, and every send-side writer runs after
  // resumeFromAutopay has made the row active.)
  const changed = await guardedOpen(database, schedule, claimStamp, CLAIMABLE_STATUSES).update({
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
  const final = isFinalIndex(schedule.step_index);
  await alertStaff({
    verb: final ? 'follow up on the final notice' : 'resume paused reminders',
    generic: final ? 'follow up on an undelivered final notice' : 'resume a customer\'s paused reminders',
    why: final
      ? `Their final overdue notice was not delivered: ${reasonText(reason)}.`
      : `Their overdue reminders were paused: ${reasonText(reason)}.`,
    doneWhen: final ? 'final_notice_followed_up' : 'schedule_resumed',
    // one alert per pause EVENT (a resumed schedule that pauses again rings again)
    dedupeKey: `customer-dunning-paused:${schedule.id}:${schedule.episode}:${stepId}:${reason}:${now.getTime()}`,
    customerId: schedule.customer_id,
    metadata: { step_id: stepId, reason: String(reason).slice(0, 80) },
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
  memberLanding,
  currentStepDelivery,
  namedForFinal,
  parseIds,
  releaseMembers,
  close,
  release,
  rowSnapshot,
  closeUnderLock,
  alertPastFinal,
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
  reasonText,
  inReadOnlyTransaction,
};
