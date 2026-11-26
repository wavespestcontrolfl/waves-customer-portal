'use strict';

/**
 * The customer-level reminder engine (dunning consolidation §5). runPending
 * calls `runCustomerSchedules` after its per-invoice loop while the live gate
 * is on (GATE_DUNNING_CUSTOMER_SCHEDULE + prerequisites, narrowed by the
 * allowlist). `processSchedule` is also the office send-now
 * (admin.sendNow, through wiring.js).
 *
 * processSchedule runs, in this order: CLAIM -> customer + prefs -> RECOVER
 * FIRST (the ledger, never the render) -> autopay -> SET -> stage
 * catch-up -> template probe -> SEND through sendReminderChannels ->
 * DISPOSITION (one path for every return) -> advance. Every stage returns
 * `null` to continue or an outcome object to stop.
 *
 * Every pre-send guard (customer, preferences, recover-first, autopay, set,
 * stage, templates) is split into a read-only `decide*` half, which returns
 * null or a decision, and a write half (`applyDecision`). The live run calls
 * both.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
const Followups = require('../invoice-followups');
const { explicitBillingChannels } = require('../billing-delivery-channels');
const { customerOnAutopay } = require('../autopay-eligibility');
const { reminderProgress, sendReminderChannels } = require('../billing-reminder-delivery');
const { dunningCustomerScheduleAllowlist } = require('../../config/feature-gates');
const collectionHold = require('../collections/collection-hold');
const { OPEN_STATUSES, SOURCE, eventKey } = require('./constants');
const { resolveDunnableSet } = require('./balance-set');
const { oldestActive } = require('./seed');
const Schedule = require('./schedule');
const Render = require('./render');
const Boundary = require('./boundary');
const { makeSender } = require('./send');

const { STEPS, namedForFinal, parseIds } = Schedule;
const FINAL_STEP_IDS = ['d60_reminder', 'd90_final_notice'];

const outcome = (kind, extra = {}) => ({ outcome: kind, ...extra });

// ── stage 2: customer + preferences ──────────────────────────────────────

// A claim-guarded write that matched no row means the schedule is no longer the one this run read (a control
// action, a successor's claim): report it, never the state the write would have produced.
function staleWrite(run, writer) {
  logger.warn(`[customer-dunning] ${writer} matched no row for schedule ${run.schedule.id}; its claim or state changed`);
  return outcome('stale');
}
const hold = async (run, reason) => (await Schedule.markHeld(run.schedule, reason, run) ? outcome('held', { reason }) : staleWrite(run, 'markHeld'));
const pause = async (run, reason) => (await Schedule.markPaused(run.schedule, reason, run) ? outcome('paused', { reason }) : staleWrite(run, 'markPaused'));

const COLLECTION_HOLD = 'collection_hold';

async function readPrefs(run) {
  try {
    return { prefs: await db('notification_prefs').where({ customer_id: run.schedule.customer_id }).first() };
  } catch (err) {
    logger.warn(`[customer-dunning] schedule ${run.schedule.id} held — channel preferences unavailable: ${redactContact(err.message)}`);
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

// A decision: what a guard concluded, with no write done. kind = hold | pause |
// close | autopay_hold | settle.
const decision = (kind, reason, extra = {}) => ({ kind, reason, ...extra });

async function decideCustomer(run) {
  const customer = await db('customers').where({ id: run.schedule.customer_id }).first();
  if (!customer) return decision('close', 'customer_missing', { closeReason: 'customer_missing', alertMissingCustomer: true });
  if (customer.deleted_at) return decision('pause', 'customer_deleted');
  const { prefs, error } = await readPrefs(run);
  if (error) return decision('hold', 'prefs_unreadable');
  run.customer = customer;
  run.channels = channelsFor(run, prefs, customer);
  return null;
}

// Judged AFTER delivery evidence is recovered: a touch whose every leg already reached the customer is
// done even if the customer has since lost their last reachable channel (pausing it would leave a
// completed final notice open and alert staff over nothing).
const decideReachable = (run) => (run.channels.length ? null : decision('pause', 'no_reachable_channel'));

// ── stage 3: recover first ───────────────────────────────────────────────

/** The invoices a delivered reservation named (the reservation is the snapshot). */
function namedInvoiceIds(event) {
  const ids = new Set();
  for (const entry of event?.entries || []) {
    if (event.delivered.has(entry.channel)) parseIds(entry.invoice_ids).forEach((id) => ids.add(String(id)));
  }
  return [...ids];
}

/**
 * The rows that drive the cadence are the members of the set a touch went out on,
 * never every active sequence: an invoice the set excluded (a microdeposit-pending
 * one) stays `active` and would otherwise pull the next touch weeks early. `sent` is
 * the resolved set of a fresh send; a touch settled from the ledger has only the
 * invoices its reservation named. Unknown = every row (nothing to narrow by).
 */
function cadenceRows(rows, run, facts = null) {
  if (run.sentSet) return Schedule.rowsInSet(rows, run.sentSet);
  const named = new Set((facts ? namedForFinal(run, facts).ids : []).map(String));
  return named.size ? rows.filter((r) => named.has(String(r.invoice_id))) : rows;
}

async function memberRows(run) {
  if (!run.rows) run.rows = await Schedule.activeMemberRows(run.schedule.customer_id);
  return run.rows;
}

async function nextStageArrived(run, event) {
  const oldest = oldestActive(cadenceRows(await memberRows(run), run, { event, delivered: event.delivered }));
  const anchor = oldest ? Followups.sequenceAnchor(oldest) : null;
  return Schedule.stageFor(anchor, run.now, run.schedule.step_index) > Number(run.schedule.step_index);
}

const markAtRisk = async (run) => {
  if (!Followups.ladderThrough90Live()) return;
  if (!FINAL_STEP_IDS.includes(run.step.id)) return;
  try {
    await Followups.markAtRiskForLongOverdue(run.schedule.customer_id);
  } catch (err) {
    logger.warn(`[customer-dunning] at-risk stamp failed for customer ${run.schedule.customer_id}: ${redactContact(err.message)}`);
  }
};

const interactionType = (delivered) => (delivered.has('sms') ? 'sms_outbound' : delivered.has('push') ? 'app_outbound' : 'email_outbound');

// One customer_interactions row for legs delivered NOW; amounts from the
// snapshot handed to the reservation, never a fresh read (A-14).
async function recordInteraction(run, delivered) {
  const meta = run.snapshotMeta || {};
  try {
    await db('customer_interactions').insert({
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
    logger.warn(`[customer-dunning] interaction log failed for schedule ${run.schedule.id}: ${redactContact(err.message)}`);
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
  const base = { claimStamp: run.claimStamp, deliveredAt, now: run.now };
  // Settling evidence that is ALREADY delivered (nothing is sent) is allowed on an autopay_hold row, under
  // the run's own claim; a new send from that row still needs resumeFromAutopay first.
  if (!facts.deliveredNow?.length && run.schedule.status === 'autopay_hold') {
    base.fromStatuses = ['active', 'held', 'autopay_hold'];
    // Where it lands: still on autopay (or the state unreadable, fail closed) stays held and is revisited
    // tomorrow; off autopay lands active at the cadence date.
    base.landStatus = (await decideAutopay(run)) ? 'autopay_hold' : 'active';
  }
  let ok;
  if (Schedule.isFinalIndex(run.schedule.step_index)) {
    const { ids, unreadable } = namedForFinal(run, facts);
    // Never complete debt on evidence we cannot read: today's membership is not
    // what a recovered notice named. Held for the office, nothing completed.
    if (unreadable.length) return hold(run, 'delivered_evidence_unreadable');
    const done = await Schedule.completeFinal(run.schedule, { ...base, namedInvoiceIds: ids });
    ok = done.completed;
  } else {
    // The next date is driven by the members active NOW: a member paid or
    // voided during the send must not keep the cadence (fresh read, never the
    // rows cached before the send).
    run.rows = null;
    ok = await Schedule.advance(run.schedule, { ...base, activeRows: cadenceRows(await memberRows(run), run, facts) });
  }
  if (!ok) return outcome('stale');
  if (facts.deliveredNow?.length) await recordInteraction(run, facts.delivered);
  await markAtRisk(run);
  return outcome(Schedule.isFinalIndex(run.schedule.step_index) ? 'completed' : 'advanced', { recovered: !facts.deliveredNow?.length });
}

// The delivery-progress event of the touch this run is CURRENTLY about (run.eventKey). Key-driven on
// purpose: nothing may hold on to an event object across a change of stage.
const currentEvent = (run) => (run.progress || []).find((e) => e.metadata.notificationEventKey === run.eventKey) || null;

// A customer with no reachable channel today: the same rule as any removal (recoveryComplete with no enabled
// channel) - a touch that selected channels and has delivery evidence is settled, anything else falls through
// to the reachability pause.
function decideUnreachableRecovery(event) {
  return recoveryComplete(event, [])
    ? decision('settle', 'already_delivered', { facts: { event, delivered: event.delivered, deliveredAt: event.deliveredAt, deliveredNow: [] } })
    : null;
}

// The channels a touch selected: the deterministic union of EVERY reservation's persisted selection (a retried
// leg's claim refreshes only its own row after a prefs change, and an unordered query hands back rows in any
// order), falling back to the event's first-row metadata only when no entry carries one. null = unknown.
function selectedChannelsOf(event) {
  const union = new Set();
  let seen = false;
  for (const entry of event.entries || []) {
    let meta = entry.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    if (Array.isArray(meta?.selectedChannels)) { seen = true; meta.selectedChannels.forEach((c) => union.add(c)); }
  }
  if (seen) return [...union].sort();
  return Array.isArray(event.metadata?.selectedChannels) ? event.metadata.selectedChannels : null;
}

// Is an EXISTING touch done? Judged against the legs that touch itself selected (its reservations persist
// selectedChannels), minus any channel the customer has since removed: a channel enabled after the touch went
// out is not owed to it (the progress view's own `complete` counts today's channels). A touch with no persisted
// selection (an older row) falls back to today's channels.
function recoveryComplete(event, channels) {
  if (!event) return false;
  const selected = selectedChannelsOf(event);
  // Today's enabled channels narrow the legs (a removal). When the touch selected channels and NONE is still enabled,
  // nothing it owed can be owed any more: with delivery evidence it is settled (never re-sent over a newly enabled
  // channel); with none it is not complete (the ordinary send / reachability path decides). A missing / empty
  // selection falls back to today's channels.
  const legs = selected?.length ? selected.filter((c) => channels.includes(c)) : channels;
  if (!legs.length) return !!selected?.length && event.delivered.size > 0;
  return legs.every((c) => event.delivered.has(c) || event.resolved.has(c) || (event.waived.has(c) && event.delivered.size > 0));
}

async function decideRecovery(run) {
  let progress;
  try {
    run.step = STEPS[run.schedule.step_index];
    if (!run.step) return decision('close', 'no_step', { closeReason: 'released_prereq_off' });
    run.eventKey = eventKey(run.schedule, run.step.id);
    // This touch's keyed reservations are loaded without the 90-day window (see reminderProgress), so a schedule
    // paused longer than that still recovers an accepted email instead of holding unconfirmed for good.
    progress = await reminderProgress(run.schedule.customer_id, SOURCE, run.channels, { eventKey: run.eventKey });
  } catch (err) {
    logger.warn(`[customer-dunning] schedule ${run.schedule.id} held — delivery progress unreadable: ${redactContact(err.message)}`);
    return decision('hold', 'progress_unreadable');
  }
  // Keep the WHOLE collection: run.eventKey moves when the stage is planned again (catch-up,
  // re-plan), and everything that reads "this touch's events" selects by the CURRENT key.
  run.progress = progress;
  const event = currentEvent(run);
  const complete = recoveryComplete(event, run.channels);
  if (!run.channels.length) return decideUnreachableRecovery(event);
  if (!event || event.delivered.size === 0) return complete ? decision('pause', 'all_channels_terminal') : null;
  // Delivered before: settle from the ledger. No render, no set read.
  if (complete || await nextStageArrived(run, event)) {
    return decision('settle', 'already_delivered', { facts: { event, delivered: event.delivered, deliveredAt: event.deliveredAt, deliveredNow: [] } });
  }
  return null;
}

// ── stage 4: autopay ─────────────────────────────────────────────────────

async function decideAutopay(run) {
  let onAutopay;
  try {
    onAutopay = await customerOnAutopay(run.customer, { failClosed: true, now: run.now });
  } catch (err) {
    logger.warn(`[customer-dunning] schedule ${run.schedule.id} held — autopay state unreadable: ${redactContact(err.message)}`);
    return decision('hold', 'autopay_unreadable');
  }
  return onAutopay ? decision('autopay_hold', 'autopay_hold') : null;
}

// ── stages 6-8: set, stage, templates ────────────────────────────────────

/** A set that cannot be sent: empty closes, a hold holds (unused account credit is a hold: the office applies it). */
function decideEndOfSet(set) {
  if (set.kind === 'hold') return decision('hold', set.reason);
  const reason = set.reason === 'no_open_invoices' ? 'balance_cleared' : 'no_active_member';
  return decision('close', reason, { closeReason: reason });
}

const sendable = (set) => (set.kind === 'multi' || set.kind === 'single') && set.activeCount > 0;

// STAGE: plan the catch-up to the calendar, never beyond the final step. A HELD
// schedule is the exception: its current stage was due and not delivered
// (markHeld promises to retry THAT step), so clearing the hold retries it — a
// Day 60 reminder held past Day 90 goes out as Day 60 first, and the next stage
// follows on its own spacing — instead of jumping to the final notice by
// calendar age. Catch-up is for a stage nobody attempted (a late promotion, a
// cron gap, a resume). Pure: it sets run.plannedStage / step / eventKey and
// writes nothing (applyStage writes it).
async function planStage(run, set) {
  run.rows = null;
  const rows = Schedule.rowsInSet(await memberRows(run), set);
  run.rows = rows;
  const oldest = oldestActive(rows);
  const attemptedAndHeld = run.schedule.status === 'held';
  // An operator send-now sends the STORED stage: the control is documented as sending the current step, so
  // it never catches up to the calendar (the next scheduled tick does).
  run.plannedStage = oldest && !attemptedAndHeld && !run.operatorInitiated
    ? Schedule.stageFor(Followups.sequenceAnchor(oldest), run.now, run.schedule.step_index)
    : Number(run.schedule.step_index);
  run.step = STEPS[run.plannedStage];
  run.eventKey = eventKey(run.schedule, run.step.id);
}

/** The set-level guards: a sendable set, the stage it goes out at, an available template. */
async function decideSet(run, set) {
  if (!sendable(set)) return decideEndOfSet(set);
  await planStage(run, set);
  run.sendChannels = await Render.channelsWithTemplates(run.step, set.kind, run.channels);
  return run.sendChannels.length ? null : decision('pause', 'no_reachable_channel');
}

// Nothing customer-facing happens, so no interaction row.
async function applyStage(run) {
  if (run.plannedStage > Number(run.schedule.step_index)) {
    logger.info(`[customer-dunning] stage_catch_up schedule ${run.schedule.id}: ${run.schedule.step_index} -> ${run.plannedStage}`);
    if (!await Schedule.writeStage(run.schedule, run.plannedStage, run)) return outcome('stale');
    run.schedule = { ...run.schedule, step_index: run.plannedStage, link_digest: null, link_url: null };
  }
  return null;
}

/** The write half of every decision. */
async function applyDecision(run, d) {
  switch (d.kind) {
    case 'hold': return hold(run, d.reason);
    case 'pause': return pause(run, d.reason);
    case 'autopay_hold':
      return await Schedule.markAutopayHold(run.schedule, run) ? outcome('autopay_hold') : staleWrite(run, 'markAutopayHold');
    case 'settle': return finishDelivered(run, d.facts);
    default: { // close
      if (d.reason === 'no_step') logger.error(`[customer-dunning] schedule ${run.schedule.id} has no step at index ${run.schedule.step_index}; releasing`);
      const closed = await Schedule.close(run.schedule, d.closeReason, run.now, {
        claimStamp: run.claimStamp, expectedStepIndex: run.schedule.step_index,
      });
      // The current step's delivery evidence could not be read, so nothing was handed back: the step
      // stays due and is retried like any unreadable progress (held, revisited at the next run).
      if (closed?.reason === 'evidence_unreadable') return hold(run, 'progress_unreadable');
      if (closed?.reason === 'outcome_unconfirmed') return hold(run, 'REMINDER_OUTCOME_UNCONFIRMED');
      // A close refused because the claim was lost (a pause, a resume, another run)
      // changed nothing: report it, alert nobody.
      if (closed && closed.closed === false) return outcome('stale');
      if (d.alertMissingCustomer) {
        await Schedule.alertStaff({
          verb: 'review a stopped reminder schedule',
          generic: 'review a stopped reminder schedule',
          why: 'A reminder schedule pointed at a customer record that no longer exists, so it was closed.',
          doneWhen: 'schedule_reviewed',
          dedupeKey: `customer-dunning-customer-missing:${run.schedule.id}`,
          customerId: null,
          subject: { type: 'check', id: String(run.schedule.id) },
        });
      }
      return outcome('closed', { reason: d.reason });
    }
  }
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
  run.sentSet = set; // the set this touch goes out on: what its cadence is driven by
  run.snapshotMeta = snapshotMetadata(run, set);
  const ctx = {
    schedule: run.schedule, step: run.step, customer: run.customer, set, channels: run.sendChannels,
    explicit: run.explicit, eventKey: run.eventKey, operatorInitiated: run.operatorInitiated,
    snapshot: Boundary.snapshotOf(run.schedule.customer_id, set, { scheduleId: run.schedule.id, claimStamp: run.claimStamp, operatorInitiated: run.operatorInitiated }), claimStamp: run.claimStamp,
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
    unwindowed: true, // this touch's keyed reservations are judged with no 90-day window (reminderProgress eventKey)
    // the office "send now" skips a plain dispute hold at the policy consult too (a fallback hold still waits)
    ...(run.operatorInitiated ? { holdExempt: 'operator' } : {}),
  });
}

/**
 * Send; when the boundary saw the set change and nothing was delivered,
 * re-resolve and send ONCE more in this tick (the failed leg was
 * markSendFailed, so claimAttempt re-quotes under the same key). The fresh set
 * is PLANNED again first — the stage it goes out at (an older invoice that
 * became eligible catches the schedule up), its variant's templates and its
 * channels — through the same decideSet/applyStage the first attempt used; a
 * stop there (hold, pause, close, a stale stage write) ends the tick with
 * nothing more sent. A second mismatch is left to the disposition (held).
 * Returns { result, set } or { stop } (a decision or an outcome).
 */
async function sendWithRerender(run, set) {
  const first = await attemptSend(run, set);
  if (!setChanged(first) || first.deliveredNow.length) return { result: first, set };
  const fresh = await resolveDunnableSet(run.schedule.customer_id, { now: run.now });
  run.rows = null; // the rows narrowed to the first set no longer describe the send
  const stop = await decideSet(run, fresh) || await applyStage(run);
  if (stop) return { stop };
  return { result: await attemptSend(run, fresh), set: fresh };
}

async function deliveryFacts(run, result) {
  let event = null;
  try {
    const progress = await reminderProgress(run.schedule.customer_id, SOURCE, run.sendChannels, { eventKey: run.eventKey });
    event = progress.find((e) => e.metadata.notificationEventKey === run.eventKey) || null;
  } catch (err) {
    logger.warn(`[customer-dunning] post-send progress unreadable for schedule ${run.schedule.id}: ${redactContact(err.message)}`);
    // What this tick's recover-first read already saw as delivered still is:
    // a partial delivery must not turn into a hold or pause for want of a re-read.
    const prior = currentEvent(run); // this touch's event from the recover-first read, never another step's
    event = prior && prior.delivered.size > 0 ? prior : null;
  }
  // `result.delivered` carries every leg the send saw as delivered, including one
  // deduped from a reservation older than the progress window (a final notice
  // accepted, crash, resumed 90+ days later): complete with nothing 'delivered'
  // would read as all-terminal and pause a notice that was in fact delivered.
  const delivered = new Set([...(event?.delivered || []), ...(result.delivered || []), ...result.deliveredNow]);
  // Legs restored from a reservation older than the progress window: what THAT
  // reservation recorded (its invoices, its time) is the evidence, attached to
  // the event so a final notice completes exactly what it named.
  const restored = (result.restored || []).filter((r) => !(event?.delivered || new Set()).has(r.channel));
  if (restored.length) {
    event = {
      ...(event || { delivered: new Set(), metadata: {} }),
      entries: [...(event?.entries || []), ...restored.filter((r) => r.invoiceIds).map((r) => ({ channel: r.channel, invoice_ids: r.invoiceIds }))],
    };
  }
  const times = [event?.deliveredAt, ...restored.map((r) => r.deliveredAt)].filter(Boolean).map((t) => new Date(t).getTime());
  const deliveredAt = times.length ? new Date(Math.max(...times)) : (result.deliveredNow.length ? run.now : null);
  return { event, delivered, deliveredAt, deliveredNow: result.deliveredNow, complete: result.complete, results: result.results };
}

// ── stage 10: disposition ────────────────────────────────────────────────

const customerArchived = (result) => Object.values(result.results || {})
  .some((r) => r?.code === Boundary.CUSTOMER_DELETED || r?.reason === Boundary.CUSTOMER_DELETED);

// A leg a collections hold refused at the provider boundary (the one COLLECTION_HOLD_DEFER outcome): a WAIT.
// sendReminderChannels already released that leg's reservation; with nothing delivered the schedule holds.
const heldByCollectionHold = (facts) => Object.values(facts.results || {}).some((r) => collectionHold.isHoldSuppression(r));

// Enrolled in autopay while the message was prepared (the boundary's last-moment guard): the schedule parks.
const autopayEnrolled = (facts) => Object.values(facts.results || {})
  .some((r) => r?.code === Boundary.AUTOPAY_ENROLLED || r?.reason === Boundary.AUTOPAY_ENROLLED);

async function dispose(run, facts) {
  // Archived at the provider boundary with nothing delivered: pause as decideCustomer does (the email leg's
  // generic not-sent would otherwise read as retryable and keep the schedule held).
  if (!facts.delivered?.size && customerArchived(facts)) return pause(run, 'customer_deleted');
  if (!facts.delivered?.size && heldByCollectionHold(facts)) return hold(run, COLLECTION_HOLD);
  if (!facts.delivered?.size && autopayEnrolled(facts)) return applyDecision(run, decision('autopay_hold', 'autopay_hold'));
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

async function sendPhase(run, set) {
  const blocked = await decideSet(run, set);
  if (blocked) return applyDecision(run, blocked);
  const staged = await applyStage(run);
  if (staged) return staged;
  const { result, stop } = await sendWithRerender(run, set);
  if (stop) return stop.kind ? applyDecision(run, stop) : stop;
  return dispose(run, await deliveryFacts(run, result));
}

// ── entry points ─────────────────────────────────────────────────────────

// A balance that is gone closes the schedule whether or not the customer is on autopay: the empty set is
// judged BEFORE the autopay guard (an autopay hold parks a schedule, and nothing else would ever close it).
const decideEmptySet = (set) => (set.kind !== 'hold' && !sendable(set) ? decideEndOfSet(set) : null);

/** The guards after recover-first and the set read. */
// A set HOLD (unused account credit, a paused member, ...) comes before the autopay guard: it is a hold the
// office must hear about (markHeld alerts it), while an autopay hold only parks the schedule silently.
async function decideAfterSet(run, set) {
  return decideEmptySet(set) || (set.kind === 'hold' ? decideEndOfSet(set) : null) || await decideAutopay(run)
    || await decideCollectionHold(run);
}

// A collections hold (dispute, or the wrong-number / wrong-party fallback) is a WAIT, as in the per-invoice
// ladder: nothing is sent, nothing is reserved, nothing fails, and the touch stays due (held, revisited daily;
// no office alert - the office placed the hold). An operator send-now skips a plain dispute hold only.
async function decideCollectionHold(run) {
  const held = await collectionHold.messagingHeldByCollectionHold(run.schedule.customer_id, db, { ignoreDisputeHold: run.operatorInitiated === true });
  return held.held ? decision('hold', COLLECTION_HOLD) : null;
}

async function runClaimed(claimed, opts) {
  const run = { ...opts, schedule: claimed.schedule, claimStamp: claimed.claimStamp };
  const early = await decideCustomer(run) || await decideRecovery(run) || decideReachable(run);
  if (early) return applyDecision(run, early);
  const set = await resolveDunnableSet(run.schedule.customer_id, { now: run.now });
  const stop = await decideAfterSet(run, set);
  if (stop) return applyDecision(run, stop);
  // Revisited from an autopay hold and no longer on autopay: the ordinary send path takes the step.
  if (run.schedule.status === 'autopay_hold') {
    if (!await Schedule.resumeFromAutopay(run.schedule, run)) return outcome('stale');
    run.schedule = { ...run.schedule, status: 'active' };
  }
  return sendPhase(run, set);
}

/**
 * Process ONE schedule end to end. `force` (operator send-now) skips the
 * "due" test only; every other guard, the claim included, still applies.
 */
async function processSchedule(scheduleId, now = new Date(), {
  operatorInitiated = false, force = false, claimAt = null, expectedStepIndex = null,
} = {}) {
  // `claimAt` is when the claim is actually taken (a batch passes its start
  // time plus elapsed wall time); `now` stays the batch clock for cadence.
  // `expectedStepIndex` (an office send-now): claim only while the schedule is
  // still at the step the operator confirmed.
  const claimed = await Schedule.claim(scheduleId, claimAt || now, { force, expectedStepIndex });
  if (!claimed) return outcome('skipped', { reason: 'not_claimable' });
  try {
    return await runClaimed(claimed, { now, operatorInitiated });
  } finally {
    await Schedule.releaseClaim(claimed);
  }
}

async function dueScheduleIds(now) {
  const rows = await db(Schedule.TABLE).whereIn('status', ['active', 'held', 'autopay_hold'])
    .where('next_touch_at', '<=', now).orderBy('next_touch_at', 'asc').select('id', 'customer_id');
  return allowlisted(rows).map((r) => r.id);
}

/** Every due schedule, one at a time; one failure never stops the rest. */
async function runCustomerSchedules(now = new Date(), { clockStartedAt = Date.now() } = {}) {
  const tally = { processed: 0, failed: 0, outcomes: {} };
  const ids = await dueScheduleIds(now);
  // A sequential batch can outlive CLAIM_TTL_MS: each claim is stamped at the
  // time it is TAKEN (batch clock + elapsed wall time), never the batch start,
  // or later claims would be born expired to admin controls and
  // InvoiceService's edit fence. `clockStartedAt` is the wall time `now` was
  // read: runPending passes its own start, so the time its per-invoice loop
  // spent before this call counts too.
  const wallStart = clockStartedAt;
  for (const id of ids) {
    try {
      const claimAt = new Date(now.getTime() + (Date.now() - wallStart));
      const out = await processSchedule(id, now, { claimAt });
      tally.processed += 1;
      tally.outcomes[out.outcome] = (tally.outcomes[out.outcome] || 0) + 1;
    } catch (err) {
      tally.failed += 1;
      logger.error(`[customer-dunning] schedule ${id} failed: ${redactContact(err.message)}`);
    }
  }
  return tally;
}

// The customers the canary allowlist names (empty = everyone): the filter for the live due-scan.
function allowlisted(rows) {
  const allow = dunningCustomerScheduleAllowlist();
  return allow ? rows.filter((r) => allow.has(String(r.customer_id))) : rows;
}

module.exports = {
  processSchedule,
  runCustomerSchedules,
  // exported for tests
  namedInvoiceIds,
  snapshotMetadata,
  selectedChannelsOf,
  OPEN_STATUSES,
};
