'use strict';

/**
 * The customer-level reminder engine (dunning consolidation §5). PR 2: the
 * live path (`runCustomerSchedules`, `processSchedule`) is complete and tested
 * directly but is NOT called from cron or any route; only `shadowRun` is wired
 * (runPending, under GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW) and it writes
 * nothing.
 *
 * processSchedule runs, in this order: CLAIM -> customer + prefs -> RECOVER
 * FIRST (the ledger, never the render) -> autopay -> SET -> stage
 * catch-up -> template probe -> SEND through sendReminderChannels ->
 * DISPOSITION (one path for every return) -> advance. Every stage returns
 * `null` to continue or an outcome object to stop.
 */

const db = require('../../models/db');
const logger = require('../logger');
const Followups = require('../invoice-followups');
const { explicitBillingChannels } = require('../billing-delivery-channels');
const { customerOnAutopay } = require('../autopay-eligibility');
const { reminderProgress, sendReminderChannels } = require('../billing-reminder-delivery');
const { dunningCustomerScheduleAllowlist } = require('../../config/feature-gates');
const { OPEN_STATUSES, SOURCE, eventKey } = require('./constants');
const { resolveDunnableSet } = require('./balance-set');
const { oldestActive } = require('./seed');
const Schedule = require('./schedule');
const Render = require('./render');
const Boundary = require('./boundary');
const { makeSender } = require('./send');

const { STEPS } = Schedule;
const FINAL_STEP_IDS = ['d60_reminder', 'd90_final_notice'];

const outcome = (kind, extra = {}) => ({ outcome: kind, ...extra });

// ── stage 2: customer + preferences ──────────────────────────────────────

const hold = (run, reason) => Schedule.markHeld(run.schedule, reason, run).then(() => outcome('held', { reason }));
const pause = (run, reason) => Schedule.markPaused(run.schedule, reason, run).then(() => outcome('paused', { reason }));

async function readPrefs(run) {
  try {
    return { prefs: await run.database('notification_prefs').where({ customer_id: run.schedule.customer_id }).first() };
  } catch (err) {
    logger.warn(`[customer-dunning] schedule ${run.schedule.id} held — channel preferences unavailable: ${err.message}`);
    return { error: true };
  }
}

// Channels: an explicit billing choice, else legacy ['email','sms'] (parity
// with fireTouch's null-selection branch); an operator send skips prefs.
function channelsFor(run, prefs, customer) {
  const explicitChannels = run.operatorInitiated ? null : explicitBillingChannels(prefs || {}, 'invoice');
  run.explicit = explicitChannels !== null;
  const base = run.operatorInitiated || explicitChannels === null ? ['email', 'sms'] : explicitChannels;
  return base.filter((c) => !(c === 'sms' && !customer.phone));
}

async function loadCustomer(run) {
  const customer = await run.database('customers').where({ id: run.schedule.customer_id }).first();
  if (!customer) {
    await Schedule.close(run.schedule, 'customer_missing', run.now, { database: run.database, claimStamp: run.claimStamp });
    await Schedule.alertStaff({
      title: 'Customer reminders stopped',
      body: 'A customer reminder schedule points at a customer record that no longer exists; it was closed.',
      dedupeKey: `customer-dunning-customer-missing:${run.schedule.id}`,
      customerId: null,
    });
    return outcome('closed', { reason: 'customer_missing' });
  }
  if (customer.deleted_at) return pause(run, 'customer_deleted');
  const { prefs, error } = await readPrefs(run);
  if (error) return hold(run, 'prefs_unreadable');
  run.customer = customer;
  run.channels = channelsFor(run, prefs, customer);
  return run.channels.length ? null : pause(run, 'no_reachable_channel');
}

// ── stage 3: recover first ───────────────────────────────────────────────

const parseIds = (value) => {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
};

/** The invoices a delivered reservation named (the reservation is the snapshot). */
function namedInvoiceIds(event) {
  const ids = new Set();
  for (const entry of event?.entries || []) {
    if (event.delivered.has(entry.channel)) parseIds(entry.invoice_ids).forEach((id) => ids.add(String(id)));
  }
  return [...ids];
}

async function memberRows(run) {
  if (!run.rows) run.rows = await Schedule.activeMemberRows(run.schedule.customer_id, { database: run.database });
  return run.rows;
}

async function nextStageArrived(run) {
  const oldest = oldestActive(await memberRows(run));
  const anchor = oldest ? Followups.sequenceAnchor(oldest) : null;
  return Schedule.stageFor(anchor, run.now, run.schedule.step_index) > Number(run.schedule.step_index);
}

const markAtRisk = async (run) => {
  if (!(Followups.ladderThrough90Live() && process.env.GATE_BALANCE_REMINDER_LEGACY_OFF === 'true')) return;
  if (!FINAL_STEP_IDS.includes(run.step.id)) return;
  try {
    await Followups.markAtRiskForLongOverdue(run.schedule.customer_id);
  } catch (err) {
    logger.warn(`[customer-dunning] at-risk stamp failed for customer ${run.schedule.customer_id}: ${err.message}`);
  }
};

const interactionType = (delivered) => (delivered.has('sms') ? 'sms_outbound' : delivered.has('push') ? 'app_outbound' : 'email_outbound');

// One customer_interactions row for legs delivered NOW; amounts from the
// snapshot handed to the reservation, never a fresh read (A-14).
async function recordInteraction(run, delivered) {
  const meta = run.snapshotMeta || {};
  try {
    await run.database('customer_interactions').insert({
      customer_id: run.schedule.customer_id,
      interaction_type: interactionType(delivered),
      subject: `Invoice reminder — ${run.step.label}`,
      body: `Step ${Number(run.schedule.step_index) + 1}/${STEPS.length} sent for ${meta.quoted?.length ?? 0} open invoice(s), total $${((meta.total_cents || 0) / 100).toFixed(2)}.`,
      metadata: JSON.stringify({
        schedule_id: run.schedule.id, episode: run.schedule.episode, step_id: run.step.id,
        stage: run.schedule.step_index, variant: meta.variant || null, quoted: meta.quoted || [],
        total_cents: meta.total_cents ?? null, channels: [...delivered],
      }),
    });
  } catch (err) {
    logger.warn(`[customer-dunning] interaction log failed for schedule ${run.schedule.id}: ${err.message}`);
  }
}

/**
 * Something reached the customer on every owed leg: advance (or, on the final
 * step, complete exactly the invoices the notice named). `recovered` = read
 * back from the ledger: no interaction row (A-8) and the ORIGINAL delivery
 * time is kept.
 */
async function finishDelivered(run, facts) {
  const deliveredAt = facts.deliveredAt ? new Date(facts.deliveredAt) : run.now;
  const base = { claimStamp: run.claimStamp, deliveredAt, now: run.now, database: run.database };
  let ok;
  if (Schedule.isFinalIndex(run.schedule.step_index)) {
    const named = namedInvoiceIds(facts.event);
    const done = await Schedule.completeFinal(run.schedule, { ...base, namedInvoiceIds: named.length ? named : (run.memberIds || []) });
    ok = done.completed;
  } else {
    // The next date is driven by the members active NOW: a member paid or
    // voided during the send must not keep the cadence (fresh read, never the
    // rows cached before the send).
    run.rows = null;
    ok = await Schedule.advance(run.schedule, { ...base, activeRows: await memberRows(run) });
  }
  if (!ok) return outcome('stale');
  if (facts.deliveredNow?.length) await recordInteraction(run, facts.delivered);
  await markAtRisk(run);
  return outcome(Schedule.isFinalIndex(run.schedule.step_index) ? 'completed' : 'advanced', { recovered: !facts.deliveredNow?.length });
}

async function recoverFirst(run) {
  let progress;
  try {
    progress = await reminderProgress(run.schedule.customer_id, SOURCE, run.channels);
  } catch (err) {
    logger.warn(`[customer-dunning] schedule ${run.schedule.id} held — delivery progress unreadable: ${err.message}`);
    return hold(run, 'progress_unreadable');
  }
  run.step = STEPS[run.schedule.step_index];
  if (!run.step) {
    logger.error(`[customer-dunning] schedule ${run.schedule.id} has no step at index ${run.schedule.step_index}; releasing`);
    await Schedule.close(run.schedule, 'released_prereq_off', run.now, { database: run.database, claimStamp: run.claimStamp });
    return outcome('closed', { reason: 'no_step' });
  }
  run.eventKey = eventKey(run.schedule, run.step.id);
  const event = progress.find((e) => e.metadata.notificationEventKey === run.eventKey);
  if (!event || event.delivered.size === 0) return event?.complete ? pause(run, 'all_channels_terminal') : null;
  run.priorEvent = event; // a partial delivery from an earlier tick, kept in case the post-send read fails
  // Delivered before: settle from the ledger. No render, no set read.
  if (event.complete || await nextStageArrived(run)) {
    return finishDelivered(run, { event, delivered: event.delivered, deliveredAt: event.deliveredAt, deliveredNow: [] });
  }
  return null;
}

// ── stage 4: autopay ─────────────────────────────────────────────────────

async function checkAutopay(run) {
  let onAutopay;
  try {
    onAutopay = await customerOnAutopay(run.customer, { failClosed: true });
  } catch (err) {
    logger.warn(`[customer-dunning] schedule ${run.schedule.id} held — autopay state unreadable: ${err.message}`);
    return hold(run, 'autopay_unreadable');
  }
  if (!onAutopay) return null;
  await Schedule.markAutopayHold(run.schedule, run);
  return outcome('autopay_hold');
}

// ── stages 6-8: set, stage, templates ────────────────────────────────────

/** A set that cannot be sent: empty closes, a hold holds (unused account credit is a hold: the office applies it). */
async function endForSet(run, set) {
  if (set.kind === 'hold') return hold(run, set.reason);
  const reason = set.reason === 'no_open_invoices' ? 'balance_cleared' : 'no_active_member';
  await Schedule.close(run.schedule, reason, run.now, { database: run.database, claimStamp: run.claimStamp });
  return outcome('closed', { reason });
}

const sendable = (set) => (set.kind === 'multi' || set.kind === 'single') && set.activeCount > 0;

// STAGE: catch up to the calendar, never beyond the final step. Nothing
// customer-facing happens, so no interaction row. A HELD schedule is the
// exception: its current stage was due and not delivered (markHeld promises to
// retry THAT step), so clearing the hold retries it — a Day 60 reminder held
// past Day 90 goes out as Day 60 first, and the next stage follows on its own
// spacing — instead of jumping to the final notice by calendar age. Catch-up is
// for a stage nobody attempted (a late promotion, a cron gap, a resume).
async function catchUpStage(run, set) {
  run.rows = null;
  const rows = Schedule.rowsInSet(await memberRows(run), set);
  run.rows = rows;
  const oldest = oldestActive(rows);
  const attemptedAndHeld = run.schedule.status === 'held';
  const stage = oldest && !attemptedAndHeld
    ? Schedule.stageFor(Followups.sequenceAnchor(oldest), run.now, run.schedule.step_index)
    : Number(run.schedule.step_index);
  if (stage > Number(run.schedule.step_index)) {
    logger.info(`[customer-dunning] stage_catch_up schedule ${run.schedule.id}: ${run.schedule.step_index} -> ${stage}`);
    if (!await Schedule.writeStage(run.schedule, stage, run)) return outcome('stale');
    run.schedule = { ...run.schedule, step_index: stage, link_digest: null, link_url: null };
  }
  run.step = STEPS[run.schedule.step_index];
  run.eventKey = eventKey(run.schedule, run.step.id);
  return null;
}

async function probeTemplates(run, set) {
  run.sendChannels = await Render.channelsWithTemplates(run.step, set.kind, run.channels, run.database);
  if (run.sendChannels.length) return null;
  return pause(run, 'no_reachable_channel');
}

// ── stage 9: send ────────────────────────────────────────────────────────

function snapshotMetadata(run, set) {
  return {
    schedule_id: run.schedule.id,
    episode: run.schedule.episode,
    step_id: run.step.id,
    stage: run.schedule.step_index,
    variant: set.kind,
    quoted: set.members.map((m) => ({ invoice_id: m.invoice_id, cents: m.cents })),
    total_cents: set.totalCents,
    set_digest: set.digest,
    anchor_invoice_id: set.anchor.id,
  };
}

const setChanged = (result) => Object.values(result.results || {})
  .some((r) => r?.code === Boundary.SET_CHANGED || r?.reason === Boundary.SET_CHANGED);

function attemptSend(run, set) {
  const memberIds = set.members.map((m) => m.invoice_id);
  run.memberIds = memberIds;
  run.snapshotMeta = snapshotMetadata(run, set);
  const ctx = {
    schedule: run.schedule, step: run.step, customer: run.customer, set, channels: run.sendChannels,
    explicit: run.explicit, eventKey: run.eventKey, operatorInitiated: run.operatorInitiated,
    snapshot: Boundary.snapshotOf(run.schedule.customer_id, set, { scheduleId: run.schedule.id, claimStamp: run.claimStamp }), claimStamp: run.claimStamp, database: run.database,
  };
  return sendReminderChannels({
    customerId: run.schedule.customer_id,
    invoiceId: null,
    invoiceIds: memberIds,
    policyInvoiceIds: memberIds,
    source: SOURCE,
    purpose: 'late_payment',
    eventKey: run.eventKey,
    channels: run.sendChannels,
    metadata: run.snapshotMeta,
    send: makeSender(ctx),
  });
}

/**
 * Send; when the boundary saw the set change and nothing was delivered,
 * re-resolve and send ONCE more in this tick (the failed leg was
 * markSendFailed, so claimAttempt re-quotes under the same key). A second
 * mismatch is left to the disposition (held).
 */
async function sendWithRerender(run, set) {
  const first = await attemptSend(run, set);
  if (!setChanged(first) || first.deliveredNow.length) return { result: first, set };
  const fresh = await resolveDunnableSet(run.schedule.customer_id, { now: run.now });
  run.rows = null; // the rows narrowed to the first set no longer describe the send
  if (!sendable(fresh)) return { result: first, set: fresh, ended: true };
  return { result: await attemptSend(run, fresh), set: fresh };
}

async function deliveryFacts(run, result) {
  let event = null;
  try {
    const progress = await reminderProgress(run.schedule.customer_id, SOURCE, run.sendChannels);
    event = progress.find((e) => e.metadata.notificationEventKey === run.eventKey) || null;
  } catch (err) {
    logger.warn(`[customer-dunning] post-send progress unreadable for schedule ${run.schedule.id}: ${err.message}`);
    // What this tick's recover-first read already saw as delivered still is:
    // a partial delivery must not turn into a hold or pause for want of a re-read.
    event = run.priorEvent || null;
  }
  const delivered = new Set([...(event?.delivered || []), ...result.deliveredNow]);
  const deliveredAt = event?.deliveredAt || (result.deliveredNow.length ? run.now : null);
  return { event, delivered, deliveredAt, deliveredNow: result.deliveredNow, complete: result.complete, results: result.results };
}

// ── stage 10: disposition ────────────────────────────────────────────────

async function dispose(run, facts) {
  const verdict = Schedule.dispositionOf(facts);
  if (verdict.kind === 'advance') return finishDelivered(run, facts);
  if (verdict.kind === 'told') {
    const ok = await Schedule.markTold(run.schedule, { ...run, deliveredAt: facts.deliveredAt ? new Date(facts.deliveredAt) : run.now });
    if (ok && facts.deliveredNow.length) await recordInteraction(run, facts.delivered);
    if (ok) await markAtRisk(run);
    if (ok) await Schedule.alertTold(run.schedule, { deliveredAt: facts.deliveredAt, now: run.now });
    return outcome(ok ? 'told' : 'stale');
  }
  return verdict.kind === 'held' ? hold(run, verdict.reason) : pause(run, verdict.reason);
}

async function sendPhase(run) {
  const set = await resolveDunnableSet(run.schedule.customer_id, { now: run.now });
  if (!sendable(set)) return endForSet(run, set);
  const staged = await catchUpStage(run, set) || await probeTemplates(run, set);
  if (staged) return staged;
  const { result, set: finalSet, ended } = await sendWithRerender(run, set);
  if (ended) return endForSet(run, finalSet);
  return dispose(run, await deliveryFacts(run, result));
}

// ── entry points ─────────────────────────────────────────────────────────

async function runClaimed(claimed, opts) {
  const run = { ...opts, schedule: claimed.schedule, claimStamp: claimed.claimStamp };
  return await loadCustomer(run) || await recoverFirst(run) || await checkAutopay(run) || sendPhase(run);
}

/**
 * Process ONE schedule end to end. `force` (operator send-now) skips the
 * "due" test only; every other guard, the claim included, still applies.
 */
async function processSchedule(scheduleId, now = new Date(), { database = db, operatorInitiated = false, force = false } = {}) {
  const claimed = await Schedule.claim(scheduleId, now, { database, force });
  if (!claimed) return outcome('skipped', { reason: 'not_claimable' });
  try {
    return await runClaimed(claimed, { now, database, operatorInitiated });
  } finally {
    await Schedule.releaseClaim(claimed, { database });
  }
}

async function dueScheduleIds(now, database) {
  const rows = await database(Schedule.TABLE).whereIn('status', ['active', 'held'])
    .where('next_touch_at', '<=', now).orderBy('next_touch_at', 'asc').select('id', 'customer_id');
  return allowlisted(rows).map((r) => r.id);
}

/** Every due schedule, one at a time; one failure never stops the rest. */
async function runCustomerSchedules(now = new Date(), { database = db } = {}) {
  const tally = { processed: 0, failed: 0, outcomes: {} };
  for (const id of await dueScheduleIds(now, database)) {
    try {
      const out = await processSchedule(id, now, { database });
      tally.processed += 1;
      tally.outcomes[out.outcome] = (tally.outcomes[out.outcome] || 0) + 1;
    } catch (err) {
      tally.failed += 1;
      logger.error(`[customer-dunning] schedule ${id} failed: ${err.message}`);
    }
  }
  return tally;
}

// ── shadow run: reads, logs, writes NOTHING ──────────────────────────────

const line = (verb, fields) => logger.info(`[customer-dunning] SHADOW would ${verb} ${Object.entries(fields)
  .map(([k, v]) => `${k}=${v}`).join(' ')}`);
const iso = (d) => (d ? new Date(d).toISOString() : 'none');

// The customers the canary allowlist names (empty = everyone): the ONE filter
// for the live due-scan and the shadow scan alike.
function allowlisted(rows) {
  const allow = dunningCustomerScheduleAllowlist();
  return allow ? rows.filter((r) => allow.has(String(r.customer_id))) : rows;
}

/**
 * What the live run would do with a schedule's resolved set: hold, close, or
 * send. `due` is set for a schedule that does not exist yet (a projected one).
 */
function judgeShadowSchedule(fields, set, due = null) {
  if (set.kind === 'hold') { line('hold', { ...fields, reason: set.reason }); return 'hold'; }
  if (!sendable(set)) { line('close', { ...fields, reason: set.reason }); return 'close'; }
  line('send', { ...fields, kind: set.kind, members: set.members.length, total_cents: set.totalCents, ...(due ? { due: iso(due) } : {}) });
  return 'send';
}

// The set resolve makes Stripe calls (pay-combined's live PaymentIntent check),
// so it runs on the pool with NO transaction held (a pinned connection would
// starve DB_POOL_MAX=2, as in promotion). It is a documented pure read; only
// the member-row read below sits inside the READ ONLY transaction.
async function shadowPromote(customerId, now, database) {
  const set = await resolveDunnableSet(customerId, { database, now });
  const rows = await Schedule.inReadOnlyTransaction(database, (trx) => Schedule.activeMemberRows(customerId, { database: trx }));
  const d = Schedule.promotionDecision(set, rows, now);
  if (!d.promote) { line('hold', { customer: customerId, reason: d.reason }); return ['hold']; }
  line('promote', {
    customer: customerId, members: set.members.length, active: d.active.length, step: d.seed.step_id,
    next: iso(d.seed.next_touch_at), total_cents: set.totalCents,
  });
  for (const row of d.absorbed) {
    line('absorb', { customer: customerId, seq: row.id, invoice: row.invoice_id, step: STEPS[row.step_index]?.id, next: iso(row.next_touch_at) });
  }
  // In a shadow-only rollout no schedule row is ever written, so the schedule
  // decisions would never be seen: model the schedule this promotion WOULD
  // create (in memory, never stored) and judge it the way the live run would.
  const projected = { customer: customerId, schedule: 'projected', step: d.seed.step_id };
  return ['promote', judgeShadowSchedule(projected, set, d.seed.next_touch_at)];
}

async function shadowSchedule(schedule, now, database) {
  const set = await resolveDunnableSet(schedule.customer_id, { database, now });
  return judgeShadowSchedule({ customer: schedule.customer_id, schedule: schedule.id, step: STEPS[schedule.step_index]?.id }, set);
}

/**
 * The shadow gate's whole job. It never calls a writer: no promotion, claim,
 * mint, reservation, send, or alert. Table reads go through a READ ONLY
 * transaction (PostgreSQL itself refuses a write); the set resolve is a pure
 * read outside it. It only logs `[customer-dunning] SHADOW would ...` lines.
 */
async function shadowRun(now = new Date(), { database = db } = {}) {
  const tally = { promote: 0, hold: 0, send: 0, close: 0, failed: 0 };
  const bump = (kind) => { tally[kind] += 1; };
  for (const customerId of await Schedule.promotionCandidates({ database })) {
    try { (await shadowPromote(customerId, now, database)).forEach(bump); } catch (err) {
      tally.failed += 1;
      logger.warn(`[customer-dunning] SHADOW promote check failed for customer ${customerId}: ${err.message}`);
    }
  }
  const open = allowlisted(await database(Schedule.TABLE).whereIn('status', ['active', 'held']).where('next_touch_at', '<=', now));
  for (const schedule of open) {
    try { bump(await shadowSchedule(schedule, now, database)); } catch (err) {
      tally.failed += 1;
      logger.warn(`[customer-dunning] SHADOW schedule check failed for ${schedule.id}: ${err.message}`);
    }
  }
  logger.info(`[customer-dunning] SHADOW summary: promote=${tally.promote} send=${tally.send} hold=${tally.hold} close=${tally.close} failed=${tally.failed}`);
  return tally;
}

module.exports = {
  processSchedule,
  runCustomerSchedules,
  shadowRun,
  // exported for tests
  namedInvoiceIds,
  snapshotMetadata,
  OPEN_STATUSES,
};
