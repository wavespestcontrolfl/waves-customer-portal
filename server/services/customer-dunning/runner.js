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
 *
 * Every pre-send guard (customer, preferences, recover-first, autopay, set,
 * stage, templates) is split into a read-only `decide*` half, which returns
 * null or a decision, and a write half (`applyDecision`). The live run calls
 * both; the shadow run calls only the decide halves, so its verdicts can
 * never drift from the live path's.
 *
 * SHADOW SCOPE: shadow gives full verdicts (would send / hold / pause / close /
 * settle) ONLY for customers already on a customer_dunning_schedules row. For a
 * customer who is not yet promoted it reports only the promotion and its first due
 * date (`would promote ... step=<id> next=<iso>`, plus `would absorb`): no send,
 * hold or pause is judged for a schedule that does not exist. Send evidence for
 * unpromoted customers comes from the one-customer allowlist canary (owner
 * rollout plan D12), not from shadow.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { redactContact } = require('../../utils/redact-contact');
const Followups = require('../invoice-followups');
const { explicitBillingChannels } = require('../billing-delivery-channels');
const { customerOnAutopay } = require('../autopay-eligibility');
const {
  reminderProgress, sendReminderChannels, verdictAllows, verdictDurablyDenied, pendingReminderChannels, reminderPolicyVerdicts,
  findReminderReservation,
} = require('../billing-reminder-delivery');
const { dunningCustomerScheduleAllowlist } = require('../../config/feature-gates');
const { OPEN_STATUSES, SOURCE, eventKey } = require('./constants');
const { resolveDunnableSet } = require('./balance-set');
const { oldestActive } = require('./seed');
const Schedule = require('./schedule');
const Render = require('./render');
const Boundary = require('./boundary');
const { makeSender } = require('./send');
const { claimVerdict } = require('../collections/contact-ledger');

const { STEPS } = Schedule;
const FINAL_STEP_IDS = ['d60_reminder', 'd90_final_notice'];

const outcome = (kind, extra = {}) => ({ outcome: kind, ...extra });

// ── stage 2: customer + preferences ──────────────────────────────────────

const hold = (run, reason) => Schedule.markHeld(run.schedule, reason, run).then(() => outcome('held', { reason }));
const pause = (run, reason) => Schedule.markPaused(run.schedule, reason, run).then(() => outcome('paused', { reason }));

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
  return run.channels.length ? null : decision('pause', 'no_reachable_channel');
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

/**
 * The invoices a final notice named, leg by leg: from the delivered
 * reservations (event entries, including a restored one), or — for a leg
 * delivered in THIS tick — the set this tick quoted. A delivered leg with
 * neither is unreadable; the caller must not complete anything for it.
 */
function namedForFinal(run, facts) {
  const ids = new Set();
  const covered = new Set();
  for (const entry of facts.event?.entries || []) {
    if (!facts.delivered.has(entry.channel)) continue;
    const named = parseIds(entry.invoice_ids);
    if (!named.length) continue;
    named.forEach((id) => ids.add(String(id)));
    covered.add(entry.channel);
  }
  const unreadable = [];
  for (const channel of facts.delivered) {
    if (covered.has(channel)) continue;
    if ((facts.deliveredNow || []).includes(channel) && run.memberIds?.length) run.memberIds.forEach((id) => ids.add(String(id)));
    else unreadable.push(channel);
  }
  return { ids: [...ids], unreadable };
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
  if (!(Followups.ladderThrough90Live() && process.env.GATE_BALANCE_REMINDER_LEGACY_OFF === 'true')) return;
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

async function decideRecovery(run) {
  let progress;
  try {
    // The shadow run reads the same view but must not repair (stamp) anything.
    progress = await reminderProgress(run.schedule.customer_id, SOURCE, run.channels, run.readOnly ? { repair: false } : undefined);
  } catch (err) {
    logger.warn(`[customer-dunning] schedule ${run.schedule.id} held — delivery progress unreadable: ${redactContact(err.message)}`);
    return decision('hold', 'progress_unreadable');
  }
  run.step = STEPS[run.schedule.step_index];
  if (!run.step) return decision('close', 'no_step', { closeReason: 'released_prereq_off' });
  run.eventKey = eventKey(run.schedule, run.step.id);
  // Keep the WHOLE collection: run.eventKey moves when the stage is planned again (catch-up,
  // re-plan), and everything that reads "this touch's events" selects by the CURRENT key.
  run.progress = progress;
  const event = currentEvent(run);
  if (!event || event.delivered.size === 0) return event?.complete ? decision('pause', 'all_channels_terminal') : null;
  // Delivered before: settle from the ledger. No render, no set read.
  if (event.complete || await nextStageArrived(run, event)) {
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
  run.plannedStage = oldest && !attemptedAndHeld
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
      await Schedule.markAutopayHold(run.schedule, run);
      return outcome('autopay_hold');
    case 'settle': return finishDelivered(run, d.facts);
    default: { // close
      if (d.reason === 'no_step') logger.error(`[customer-dunning] schedule ${run.schedule.id} has no step at index ${run.schedule.step_index}; releasing`);
      const closed = await Schedule.close(run.schedule, d.closeReason, run.now, {
        claimStamp: run.claimStamp, expectedStepIndex: run.schedule.step_index,
      });
      // A close refused because the claim was lost (a pause, a resume, another run)
      // changed nothing: report it, alert nobody.
      if (closed && closed.closed === false) return outcome('stale');
      if (d.alertMissingCustomer) {
        await Schedule.alertStaff({
          title: 'Customer reminders stopped',
          body: 'A customer reminder schedule points at a customer record that no longer exists; it was closed.',
          dedupeKey: `customer-dunning-customer-missing:${run.schedule.id}`,
          customerId: null,
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
    snapshot: Boundary.snapshotOf(run.schedule.customer_id, set, { scheduleId: run.schedule.id, claimStamp: run.claimStamp }), claimStamp: run.claimStamp,
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
    const progress = await reminderProgress(run.schedule.customer_id, SOURCE, run.sendChannels);
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

/** The guards after recover-first and the set read, shared by the live and the shadow run. */
async function decideAfterSet(run, set) {
  return decideEmptySet(set) || await decideAutopay(run);
}

async function runClaimed(claimed, opts) {
  const run = { ...opts, schedule: claimed.schedule, claimStamp: claimed.claimStamp };
  const early = await decideCustomer(run) || await decideRecovery(run);
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
async function processSchedule(scheduleId, now = new Date(), { operatorInitiated = false, force = false, claimAt = null } = {}) {
  // `claimAt` is when the claim is actually taken (a batch passes its start
  // time plus elapsed wall time); `now` stays the batch clock for cadence.
  const claimed = await Schedule.claim(scheduleId, claimAt || now, { force });
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
async function runCustomerSchedules(now = new Date()) {
  const tally = { processed: 0, failed: 0, outcomes: {} };
  const ids = await dueScheduleIds(now);
  // A sequential batch can outlive CLAIM_TTL_MS: each claim is stamped at the
  // time it is TAKEN (batch clock + elapsed wall time), never the batch start,
  // or later claims would be born expired to admin controls and
  // InvoiceService's edit fence.
  const wallStart = Date.now();
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
 * The collections-policy half of a send (what sendReminderChannels asks per owed
 * channel before it reserves anything), as a pure read: which channels the live
 * attempt would send and which it would deny. No reservation, claim or waiver is
 * written (persistPolicyWaivers is never reached). Every channel denied is a
 * hold on COLLECTIONS_POLICY (or, when the denials are durable and a sibling
 * already delivered, the step settles on the waiver, as it does live).
 */
async function decideShadowPolicy(run, set) {
  const event = currentEvent(run);
  const delivered = event?.delivered || new Set();
  const pending = pendingReminderChannels(run.sendChannels, delivered, event?.resolved || new Set());
  run.policyDenied = [];
  run.unclaimable = [];
  run.deduped = [];
  if (!pending.length) return null;
  const memberIds = set.members.map((m) => m.invoice_id);
  const verdicts = await reminderPolicyVerdicts({
    customerId: run.schedule.customer_id, invoiceId: null, invoiceIds: memberIds, policyInvoiceIds: memberIds,
    source: SOURCE, purpose: 'late_payment', entries: event?.entries || [],
  }, pending);
  if (verdicts.some((v) => v?.balanceIncomplete)) return decision('hold', 'COLLECTIONS_POLICY', { denied: pending });
  const denied = pending.filter((_c, i) => !verdictAllows(verdicts[i]));
  if (denied.length === pending.length) {
    const waivable = delivered.size > 0 && denied.every((channel) => verdictDurablyDenied(verdicts[pending.indexOf(channel)]));
    return waivable ? decision('settle', 'policy_waived', { denied }) : decision('hold', 'COLLECTIONS_POLICY', { denied });
  }
  // The keyed reservation of each owed leg, read by its key with NO time window (live recordContact /
  // claimAttempt find a reservation of any age; reminderProgress forgets rows past 90 days). Judged by
  // the ledger's own claim decision, read-only: an ambiguous one (a worker that died between the
  // reservation and the handoff) is refused live as REMINDER_OUTCOME_UNCONFIRMED; a delivered one is
  // deduped, not sent again.
  const allowed = pending.filter((channel) => !denied.includes(channel));
  const verdictOf = new Map();
  for (const channel of allowed) verdictOf.set(channel, claimVerdict(await standingReservation(run, channel)));
  const deduped = allowed.filter((channel) => verdictOf.get(channel).delivered);
  const unclaimable = allowed.filter((channel) => !verdictOf.get(channel).allowed && !verdictOf.get(channel).delivered);
  if (unclaimable.length === allowed.length - deduped.length && unclaimable.length) {
    return decision('hold', 'REMINDER_OUTCOME_UNCONFIRMED', { denied, unclaimable });
  }
  if (deduped.length === allowed.length) return decision('settle', 'already_delivered', { denied });
  run.policyDenied = denied; // a partial send: the claimable allowed channels go, these do not
  run.unclaimable = unclaimable;
  run.deduped = deduped;
  return null;
}

// The ledger row a channel's keyed reservation already has, shaped as recordContact returns a reused one.
async function standingReservation(run, channel) {
  const row = await findReminderReservation(run.schedule.customer_id, run.eventKey, channel);
  return row ? { id: row.id, reused: true, metadata: row.metadata } : { id: 'new', reused: false, metadata: {} };
}

/**
 * What the live run would do with a schedule: the SAME read-only guards
 * runClaimed runs (customer, preferences, recover-first, autopay, then the set,
 * stage and template checks), and only their decide halves — nothing is applied.
 * `schedule` is always a STORED row (shadow never judges a schedule that does not exist).
 */
async function judgeShadowSchedule(schedule, set, { now }) {
  const run = { schedule, now, operatorInitiated: false, claimStamp: null, readOnly: true };
  const fields = { customer: schedule.customer_id, schedule: schedule.id, step: STEPS[schedule.step_index]?.id };
  const stop = await decideCustomer(run) || await decideRecovery(run) || await decideAfterSet(run, set)
    || await decideSet(run, set) || await decideShadowPolicy(run, set);
  if (!stop) {
    line('send', {
      ...fields, step: run.step?.id, kind: set.kind, members: set.members.length, total_cents: set.totalCents,
      ...(run.policyDenied?.length ? { denied: run.policyDenied.join('+') } : {}),
      ...(run.unclaimable?.length ? { unclaimable: run.unclaimable.join('+') } : {}),
      ...(run.deduped?.length ? { deduped: run.deduped.join('+') } : {}),
    });
    return 'send';
  }
  const verb = { hold: 'hold', autopay_hold: 'hold', pause: 'pause', close: 'close', settle: 'settle' }[stop.kind];
  line(verb, {
    ...fields, reason: stop.reason, ...(stop.denied?.length ? { denied: stop.denied.join('+') } : {}),
    ...(stop.unclaimable?.length ? { unclaimable: stop.unclaimable.join('+') } : {}),
  });
  return verb;
}

// A customer with no schedule row yet: the promotion decision and its first due date, nothing more.
// The set resolve makes Stripe calls (pay-combined's live PaymentIntent check), so it runs on the
// pool with NO transaction held (a pinned connection would starve DB_POOL_MAX=2, as in promotion).
// It is a documented pure read; only the member-row read below sits inside the READ ONLY transaction.
async function shadowPromote(customerId, now) {
  const set = await resolveDunnableSet(customerId, { now });
  const rows = await Schedule.inReadOnlyTransaction(db, (trx) => Schedule.activeMemberRows(customerId, { database: trx }));
  const d = Schedule.promotionDecision(set, rows, now);
  if (!d.promote) { line('hold', { customer: customerId, reason: d.reason }); return ['hold']; }
  line('promote', {
    customer: customerId, members: set.members.length, active: d.active.length, step: d.seed.step_id,
    next: iso(d.seed.next_touch_at), total_cents: set.totalCents,
  });
  for (const row of d.absorbed) {
    line('absorb', { customer: customerId, seq: row.id, invoice: row.invoice_id, step: STEPS[row.step_index]?.id, next: iso(row.next_touch_at) });
  }
  // Promotion is all shadow says about a customer with no schedule row yet: what the first touch
  // would be and when it is due. The schedule it would create is not judged (see SHADOW SCOPE).
  return ['promote'];
}

async function shadowSchedule(schedule, now) {
  const set = await resolveDunnableSet(schedule.customer_id, { now });
  return judgeShadowSchedule(schedule, set, { now });
}

/**
 * The shadow gate's whole job. It never calls a writer: no promotion, claim,
 * mint, reservation, send, or alert. Table reads go through a READ ONLY
 * transaction (PostgreSQL itself refuses a write); the set resolve is a pure
 * read outside it. It only logs `[customer-dunning] SHADOW would ...` lines.
 *
 * Scope: full verdicts only for customers already on a customer_dunning_schedules row
 * (shadowSchedule); for a customer not yet promoted, only the promotion and its first
 * due date (shadowPromote). Send evidence for unpromoted customers comes from the
 * one-customer allowlist canary (owner rollout plan D12).
 */
async function shadowRun(now = new Date()) {
  const tally = { promote: 0, hold: 0, send: 0, pause: 0, settle: 0, close: 0, failed: 0 };
  const bump = (kind) => { tally[kind] += 1; };
  for (const customerId of await Schedule.promotionCandidates()) {
    try { (await shadowPromote(customerId, now)).forEach(bump); } catch (err) {
      tally.failed += 1;
      logger.warn(`[customer-dunning] SHADOW promote check failed for customer ${customerId}: ${redactContact(err.message)}`);
    }
  }
  const open = allowlisted(await db(Schedule.TABLE).whereIn('status', ['active', 'held', 'autopay_hold']).where('next_touch_at', '<=', now));
  for (const schedule of open) {
    try { bump(await shadowSchedule(schedule, now)); } catch (err) {
      tally.failed += 1;
      logger.warn(`[customer-dunning] SHADOW schedule check failed for ${schedule.id}: ${redactContact(err.message)}`);
    }
  }
  logger.info(`[customer-dunning] SHADOW summary: promote=${tally.promote} send=${tally.send} hold=${tally.hold} pause=${tally.pause} settle=${tally.settle} close=${tally.close} failed=${tally.failed}`);
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
