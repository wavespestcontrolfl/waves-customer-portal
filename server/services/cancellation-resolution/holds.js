'use strict';

/**
 * Cancel-flow C2 — the two "away" mechanisms (ruling C-4). Pause is NOT a
 * product: these run ONLY from an accepted resolution card inside the
 * cancel flow.
 *
 * Away Mode (pest): exterior-only visits continue; nobody needs to be home;
 * reports still send; price and tier unchanged. Persisted as
 * property_preferences.away_mode_until — the dispatch/tech surfaces read it.
 *
 * Hold (lawn / mosquito / tree & shrub): every upcoming visit in the family
 * shifts forward so the series restarts on the customer's resume date; the
 * family's monthly component is suspended (held_monthly_rate restored on
 * resume) so "no visits, no charges" is literally true; the WaveGuard tier
 * is protected (customers.tier_protected_until) so the bundle price stays
 * locked; a text goes out 7 days before the restart; auto-resume on the
 * date (Adam's C-4: the 7-day text IS the consent step). Once per family
 * per 12 months. ≤ 180 days.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { CANCELLABLE_STATUSES } = require('../cancellation-eligibility');
const { lockCustomerComms } = require('../../utils/customer-comms-lock');
const { resolveBillingLane } = require('../billing-lane');

const HOLDABLE_FAMILIES = ['lawn_care', 'mosquito', 'tree_shrub'];

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function ymd(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function displayDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function familyUpcomingVisits(customerId, familyKey, dbh = db) {
  const { familyOfServiceRow } = require('../cancellation-processor');
  const today = etDateString();
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .whereIn('s.status', CANCELLABLE_STATUSES)
    .where(function dateOrRescheduled() {
      this.where('s.scheduled_date', '>=', today).orWhere('s.status', 'rescheduled');
    })
    .whereRaw("(s.track_state IS NULL OR s.track_state NOT IN ('complete', 'en_route', 'on_property'))")
    .orderBy('s.scheduled_date', 'asc')
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  return rows.filter((row) => familyOfServiceRow(row) === familyKey);
}

async function startAwayMode({ customerId, caseId, until = null }) {
  const today = etDateString();
  const untilYmd = ymd(until) || addDays(today, 180);
  if (untilYmd <= today) throw codedError('away_date_invalid', 'The return date must be in the future');
  const existing = await db('property_preferences').where({ customer_id: customerId }).first('id');
  if (existing) {
    await db('property_preferences').where({ id: existing.id }).update({ away_mode_until: untilYmd, updated_at: new Date() });
  } else {
    await db('property_preferences').insert({ customer_id: customerId, away_mode_until: untilYmd, created_at: new Date(), updated_at: new Date() });
  }
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `Away Mode until ${untilYmd} (cancel flow)`,
      body: `Case ${caseId}. Exterior-only visits while away; reports continue; price and tier unchanged.`,
    });
  } catch (err) { logger.warn(`[holds] away-mode note failed for ${customerId}: ${err.message}`); }
  return { until: untilYmd, untilDisplay: displayDate(untilYmd) };
}

async function revertMoves(customerId, moved) {
  if (!moved || !moved.length) return;
  const SmartRebooker = require('../rebooker');
  for (const done of [...moved].reverse()) {
    try {
      // A compensating move back is not a schedule change the tech should
      // hear about — the forward move it undoes was never announced either.
      await SmartRebooker.reschedule(done.id, done.from, done.window, 'plan_hold_revert', 'customer', { suppressTechNotice: true });
    } catch (revertErr) {
      logger.error(`[holds] revert of visit ${done.id} failed: ${revertErr.message}`);
      const { notifyAdmin } = require('../notification-service');
      await notifyAdmin('service', 'Plan hold aborted: visit needs a manual move back', `Visit ${done.id} was moved to ${done.to} for a hold that then failed — move it back to ${done.from}.`, {
        bell: true, dedupeKey: `plan_hold_revert_failed:${done.id}`, metadata: { kind: 'plan_hold_revert_failed', customerId, visitId: done.id },
      }).catch(() => {});
    }
  }
}

async function startHold({ customerId, caseId, familyKey, resumeOn, maxDays = 180 }) {
  if (!HOLDABLE_FAMILIES.includes(familyKey)) throw codedError('hold_family_invalid', 'That service cannot be held');
  const today = etDateString();
  const resume = ymd(resumeOn);
  if (!resume || resume <= today) throw codedError('hold_date_invalid', 'Pick the date you are back');
  if (daysBetween(today, resume) > maxDays) throw codedError('hold_too_long', `A hold can run at most ${maxDays} days`);

  // Once per family per 12 months — ET calendar months, any prior hold counts.
  const floor = new Date(Date.now() - 365 * 86400000);
  const prior = await db('plan_holds').where({ customer_id: customerId, family_key: familyKey }).where('created_at', '>=', floor).first('id');
  if (prior) throw codedError('hold_cooldown', 'This service was already held in the last 12 months');

  // Money first (fail closed): a monthly-lane family we cannot attribute
  // cannot promise "no charges". Lane via the canonical resolver (#3140) —
  // the monthly dues charge the hold suspends only exists on the
  // monthly_membership lane; the old rate>0 shortcut demanded attribution
  // for prepay/per-visit rows the dues cron never bills (Codex #3669 r3 P2).
  const customer = await db('customers').where({ id: customerId }).first('monthly_rate', 'billing_mode', 'waveguard_tier', 'tier_protected_until');
  const monthlyLane = resolveBillingLane(customer).mode === 'monthly_membership';
  let heldRate = null;
  if (monthlyLane) {
    const component = await db('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey }).first('monthly_rate');
    if (!component) throw codedError('hold_unattributed', 'We could not suspend billing for that service — call our office');
    heldRate = Number(component.monthly_rate) || 0;
  }

  // Move the series FIRST (codex r1 P1): the hold's promise is "no visits
  // until the resume date" — if any visit will not move, revert the ones
  // that did and refuse the hold instead of suspending billing around a
  // visit that can still dispatch.
  const visits = await familyUpcomingVisits(customerId, familyKey);
  const moved = [];
  // Holder on each COMMITTED move (rebooker result), for the tech notices
  // sent only once the whole hold stands — kept off the persisted
  // moved_visits shape.
  const movedTechIds = new Map();
  if (visits.length) {
    const SmartRebooker = require('../rebooker');
    const delta = daysBetween(String(visits[0].scheduled_date).slice(0, 10), resume);
    for (const visit of visits) {
      const from = String(visit.scheduled_date).slice(0, 10);
      const to = addDays(from, delta);
      try {
        // suppressTechNotice: a later visit in this loop, or the hold write
        // below, can still fail and revert every move made so far — the
        // tech must never act on a schedule change that gets rolled back.
        const moveResult = await SmartRebooker.reschedule(visit.id, to, {
          start: visit.window_start || null, end: visit.window_end || null,
        }, 'plan_hold', 'customer', { suppressTechNotice: true });
        moved.push({ id: visit.id, from, to, window: { start: visit.window_start || null, end: visit.window_end || null } });
        movedTechIds.set(String(visit.id), moveResult?.technicianId || null);
      } catch (err) {
        logger.error(`[holds] visit ${visit.id} did not move for a ${familyKey} hold: ${err.message}`);
        await revertMoves(customerId, moved);
        throw codedError('hold_visits_unmovable', 'One of the upcoming visits could not be moved — call our office and we will set the hold up by hand');
      }
    }
  }

  // Hold + billing suspension + tier protection land ATOMICALLY (codex
  // P0): if any write fails, the transaction rolls back and every moved
  // visit is compensated back to its original date before the error
  // reaches the customer.
  let holdId = null;
  try {
    await db.transaction(async (trx) => {
      // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT): a hold rewrites
      // the plan ledger and the customer's rate — the writes the scoped
      // cancellation wind-down serializes on under the same key. The money
      // facts are RE-READ under the lock: the pre-lock reads above only
      // decided eligibility, and a wind-down or ledger writer committing
      // during the visit moves would otherwise leave the hold recording
      // (and later restoring) a stale rate. A family that lost its
      // component in the gap fails the hold (rolled back, visits
      // compensated) instead of suspending billing it can no longer prove.
      await lockCustomerComms(trx, customerId);
      // Eligibility is re-validated under the lock too: a concurrent hold
      // on the same family (both passed the cooldown read above) or a
      // scoped wind-down that cancelled the family's visits in the gap
      // must not leave an active hold — and tier protection — on a family
      // the customer no longer owns.
      const priorUnderLock = await trx('plan_holds').where({ customer_id: customerId, family_key: familyKey }).where('created_at', '>=', floor).first('id');
      if (priorUnderLock) throw new Error('a hold for this family was written concurrently');
      // Exactly the moved set, by identity — including the expected-EMPTY
      // case: a cancelled moved visit, or a visit booked in the gap (the
      // family's first one included) that would dispatch during the hold
      // unmoved, both refuse the hold.
      const liveVisits = await familyUpcomingVisits(customerId, familyKey, trx);
      const liveIds = liveVisits.map((v) => String(v.id)).sort();
      const movedIds = moved.map((v) => String(v.id)).sort();
      if (liveIds.length !== movedIds.length || liveIds.some((id, i) => id !== movedIds[i])) {
        throw new Error(`${familyKey} visits changed before the hold could be written (live ${liveIds.join(',')} vs moved ${movedIds.join(',')})`);
      }
      const live = await trx('customers').where({ id: customerId }).first('monthly_rate', 'billing_mode', 'waveguard_tier', 'tier_protected_until');
      if (!live) throw new Error('customer vanished before the hold could be written');
      if (resolveBillingLane(live).mode === 'monthly_membership') {
        const liveComponent = await trx('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey }).first('monthly_rate');
        if (!liveComponent) throw new Error(`${familyKey} lost its monthly component before the hold could be written`);
        heldRate = Number(liveComponent.monthly_rate) || 0;
      } else {
        heldRate = null;
      }
      const [hold] = await trx('plan_holds').insert({
        customer_id: customerId,
        cancellation_case_id: caseId || null,
        family_key: familyKey,
        starts_on: today,
        resume_on: resume,
        held_monthly_rate: heldRate,
        moved_visits: JSON.stringify({ moved }),
        status: 'active',
      }).returning(['id']);
      holdId = hold?.id || hold;
      if (heldRate != null) {
        await trx('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey })
          .update({ monthly_rate: 0, source: 'plan_hold', effective_at: new Date(), updated_at: new Date() });
        const rows = await trx('customer_plan_rates').where({ customer_id: customerId }).select('monthly_rate');
        const scalar = Math.round(rows.reduce((sum, r) => sum + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
        await trx('customers').where({ id: customerId }).update({ monthly_rate: scalar, updated_at: new Date() });
      }
      const protectedUntil = live.tier_protected_until && String(live.tier_protected_until).slice(0, 10) > resume
        ? live.tier_protected_until
        : resume;
      await trx('customers').where({ id: customerId }).update({ tier_protected_until: protectedUntil, updated_at: new Date() });
    });
  } catch (err) {
    logger.error(`[holds] hold write failed for ${customerId}/${familyKey} — compensating moved visits: ${err.message}`);
    await revertMoves(customerId, moved);
    throw codedError('hold_setup_failed', 'We could not set the hold up — nothing changed. Call our office and we will do it by hand');
  }

  // The hold stands, but the ENCLOSING action may not yet: a later family
  // in a multi-family hold, or the Away Mode write paired with it, can
  // still fail and cancelHold(compensateVisits) every hold this accept
  // made — and those compensating moves are silent. So the per-visit
  // notices are RETURNED, not emitted; the action emits them
  // (emitHoldTechNotices) once every family and Away Mode succeeded.
  const techNotices = moved
    .map((m) => ({
      visitId: m.id, technicianId: movedTechIds.get(String(m.id)) || null, actorId: 'customer',
      previous: { date: m.from, windowStart: m.window.start, windowEnd: m.window.end },
      snapshot: { date: m.to, windowStart: m.window.start, windowEnd: m.window.end },
    }))
    .filter((n) => n.technicianId);

  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `${familyKey} on hold until ${resume} (cancel flow)`,
      body: `Case ${caseId || '—'}. ${moved.length} visit(s) moved; monthly component ${heldRate == null ? 'n/a' : `$${heldRate} suspended`}; tier protected until ${resume}.`,
    });
  } catch (err) { logger.warn(`[holds] hold note failed for ${customerId}: ${err.message}`); }

  return { holdId, familyKey, resumeOn: resume, resumeDisplay: displayDate(resume), moved: moved.length, techNotices };
}

/**
 * Tell each moved visit's holder, once nothing can revert the moves
 * (tech-visit-notifications.js: post-commit, best-effort, never awaited,
 * gate-dark; actor "the customer online"). A notice whose row has since
 * moved on is dropped at write time.
 */
function emitHoldTechNotices(techNotices) {
  const notices = require('../tech-visit-notifications');
  for (const n of techNotices || []) void notices.notifyVisitRescheduled(n);
}

/**
 * Compensating cancel: undo a hold this same flow just created — restore
 * the suspended component and scalar, release tier protection, move the
 * visits back. Used when a LATER family in a multi-family accept fails so
 * money and schedule never partially commit (codex P0).
 */
async function cancelHold(holdId, { compensateVisits = true } = {}) {
  const hold = await db('plan_holds').where({ id: holdId }).first('*');
  if (!hold || hold.status !== 'active') return false;
  await db.transaction(async (trx) => {
    await lockCustomerComms(trx, hold.customer_id); // rung 6 — see startHold
    // The saved rate is re-read under the lock: a scoped wind-down reprices
    // plan_holds.held_monthly_rate for a held family, and restoring the
    // pre-lock copy would resurrect the pre-demotion price.
    const live = await trx('plan_holds').where({ id: holdId }).first('status', 'held_monthly_rate');
    if (!live || live.status !== 'active') return;
    const claimed = await trx('plan_holds').where({ id: holdId, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
    if (!claimed) return;
    if (live.held_monthly_rate != null) {
      const component = await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key }).first('source');
      if (component && component.source === 'plan_hold') {
        await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key })
          .update({ monthly_rate: Number(live.held_monthly_rate), source: 'plan_hold_revert', effective_at: new Date(), updated_at: new Date() });
        const rows = await trx('customer_plan_rates').where({ customer_id: hold.customer_id }).select('monthly_rate');
        const scalar = Math.round(rows.reduce((sum, r) => sum + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
        await trx('customers').where({ id: hold.customer_id }).update({ monthly_rate: scalar, updated_at: new Date() });
      }
    }
    const others = await trx('plan_holds').where({ customer_id: hold.customer_id, status: 'active' }).whereNot({ id: holdId }).max('resume_on as max');
    await trx('customers').where({ id: hold.customer_id }).update({ tier_protected_until: others?.[0]?.max || null, updated_at: new Date() });
  });
  if (compensateVisits) {
    let movedVisits = [];
    try {
      const parsed = typeof hold.moved_visits === 'string' ? JSON.parse(hold.moved_visits) : hold.moved_visits;
      movedVisits = Array.isArray(parsed?.moved) ? parsed.moved : [];
    } catch { movedVisits = []; }
    await revertMoves(hold.customer_id, movedVisits);
  }
  return true;
}

/**
 * Push a hold's restart out to `newResume`: every upcoming visit in the
 * family moves by the same delta (they were parked on the old resume
 * date) and the hold row follows, so no visit can dispatch while the
 * family is still held at $0 (codex r2 P1).
 */
async function shiftHoldResume(hold, newResume) {
  const oldResume = String(hold.resume_on).slice(0, 10);
  const delta = daysBetween(oldResume, newResume);
  if (delta <= 0) return { shifted: 0 };
  const visits = await familyUpcomingVisits(hold.customer_id, hold.family_key);
  const SmartRebooker = require('../rebooker');
  const moved = [];
  for (const visit of visits) {
    const from = String(visit.scheduled_date).slice(0, 10);
    try {
      await SmartRebooker.reschedule(visit.id, addDays(from, delta), {
        start: visit.window_start || null, end: visit.window_end || null,
      }, 'plan_hold_notice', 'system', {});
      moved.push({ id: visit.id, from, to: addDays(from, delta), window: { start: visit.window_start || null, end: visit.window_end || null } });
    } catch (err) {
      logger.error(`[holds] notice shift failed for visit ${visit.id} (hold ${hold.id}): ${err.message}`);
      const { notifyAdmin } = require('../notification-service');
      await notifyAdmin('service', 'Plan hold: visit needs a manual move', `Visit ${visit.id} could not be pushed to ${addDays(from, delta)} for hold ${hold.id} — move it by hand; the family is still held.`, {
        bell: true, dedupeKey: `plan_hold_notice_shift_failed:${visit.id}:${newResume}`, metadata: { kind: 'plan_hold_notice_shift_failed', holdId: hold.id, visitId: visit.id },
      }).catch(() => {});
    }
  }
  let prior = {};
  try { prior = typeof hold.moved_visits === 'string' ? JSON.parse(hold.moved_visits) : (hold.moved_visits || {}); } catch { prior = {}; }
  await db('plan_holds').where({ id: hold.id }).update({
    resume_on: newResume,
    moved_visits: JSON.stringify({ moved: [...(prior.moved || []), ...moved] }),
    updated_at: new Date(),
  });
  return { shifted: moved.length };
}

/**
 * Daily lifecycle (scheduler): 7-day restart texts, then auto-resume.
 * Both idempotent — the reminder stamps reminder_sent_at, the resume flips
 * status under the live-unique index.
 */
async function runPlanHoldLifecycle({ today = etDateString() } = {}) {
  const out = { reminded: 0, resumed: 0, errors: [] };

  const remindOn = addDays(today, 7);
  const toRemind = await db('plan_holds').where({ status: 'active' }).whereNull('reminder_sent_at').where('resume_on', '<=', remindOn).select('*');
  for (const hold of toRemind) {
    try {
      // Send FIRST, stamp only after the provider accepted (codex r1 P1):
      // a stamped-but-undelivered reminder would let the auto-resume fire
      // without the consent text. runExclusive serializes the cron, so the
      // post-send stamp cannot double-send.
      const customer = await db('customers').where({ id: hold.customer_id }).first('first_name', 'phone', 'active', 'pipeline_stage');
      if (!customer || customer.active === false || customer.pipeline_stage === 'churned') {
        await db('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
        continue;
      }
      let sent = false;
      if (customer?.phone) {
        const { renderRequiredSmsTemplate } = require('../sms-template-renderer');
        const { sendCustomerMessage } = require('../messaging/send-customer-message');
        const { gsmSafeName } = require('../messaging/gsm-normalize');
        const { familyLabel } = require('./templates');
        const body = await renderRequiredSmsTemplate('plan_hold_resume_reminder', {
          first_name: gsmSafeName(customer.first_name),
          service: familyLabel(hold.family_key) || hold.family_key,
          resume_date: displayDate(String(hold.resume_on).slice(0, 10)),
        }, { workflow: 'plan_hold_resume_reminder', entity_type: 'plan_hold', entity_id: hold.id });
        const smsResult = await sendCustomerMessage({
          to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'support_resolution',
          customerId: hold.customer_id, identityTrustLevel: 'system', entryPoint: 'plan_hold_reminder',
          metadata: { original_message_type: 'plan_hold_resume_reminder', plan_hold_id: hold.id },
        });
        sent = !!smsResult.sent;
      }
      if (sent) {
        await db('plan_holds').where({ id: hold.id }).whereNull('reminder_sent_at').update({ reminder_sent_at: new Date(), updated_at: new Date() });
        out.reminded += 1;
      } else {
        out.errors.push(`remind_unsent:${hold.id}`);
        logger.error(`[holds] resume reminder not delivered for hold ${hold.id} — will retry tomorrow`);
      }
    } catch (err) {
      out.errors.push(`remind:${hold.id}`);
      logger.error(`[holds] resume reminder failed for hold ${hold.id}: ${err.message}`);
    }
  }

  const toResume = await db('plan_holds').where({ status: 'active' }).where('resume_on', '<=', today).select('*');
  for (const hold of toResume) {
    try {
      // The 7-day text IS the consent step (ruling C-4): billing never
      // restarts before a reminder was ACCEPTED for delivery (codex P0).
      // The remind branch above keeps retrying daily; a hold overdue with
      // no deliverable reminder parks for the office instead.
      // Seven elapsed days after DELIVERY, not merely a stamp (codex P0):
      // a reminder that only got through on the resume date pushes the
      // restart out a full week — the notice period is the consent.
      if (hold.reminder_sent_at) {
        const stampedEt = etDateString(new Date(hold.reminder_sent_at));
        const effective = addDays(stampedEt, 7);
        if (today < effective) {
          // Late notice: the restart (and the parked visits) move out to
          // seven days after delivery — once, idempotently.
          if (String(hold.resume_on).slice(0, 10) < effective) await shiftHoldResume(hold, effective);
          continue;
        }
      }
      if (!hold.reminder_sent_at) {
        if (String(hold.resume_on).slice(0, 10) <= today) {
          // Undeliverable notice: push the restart a week, park a bell —
          // the visits must not sit on a past date while the family is $0.
          const pushed = addDays(today, 7);
          await shiftHoldResume(hold, pushed);
          const { notifyAdmin } = require('../notification-service');
          await notifyAdmin('service', 'Plan hold cannot auto-resume: restart text undeliverable', `Hold ${hold.id} (${hold.family_key}) reached its resume date with no delivered reminder — pushed to ${pushed}; contact the customer and resume by hand.`, {
            bell: true, dedupeKey: `plan_hold_resume_blocked:${hold.id}:${pushed}`, metadata: { kind: 'plan_hold_resume_blocked', holdId: hold.id, customerId: hold.customer_id },
          }).catch(() => {});
        }
        continue;
      }
      // A hold whose plan was cancelled or reconfigured in the meantime is
      // OBSOLETE (codex r1 P2): resuming would text a false restart and
      // overwrite the current component with the stale pre-hold rate.
      const owner = await db('customers').where({ id: hold.customer_id }).first('active', 'pipeline_stage');
      const component = await db('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key }).first('source');
      const obsolete = !owner || owner.active === false || owner.pipeline_stage === 'churned'
        || (hold.held_monthly_rate != null && (!component || component.source !== 'plan_hold'));
      if (obsolete) {
        await db('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
        continue;
      }
      const resumed = await db.transaction(async (trx) => {
        await lockCustomerComms(trx, hold.customer_id); // rung 6 — see startHold
        // Re-read under the lock (see cancelHold): the wind-down reprices a
        // held family's saved rate, and the component may have left
        // plan_hold ownership since the obsolete check above.
        const live = await trx('plan_holds').where({ id: hold.id }).first('status', 'held_monthly_rate');
        if (!live || live.status !== 'active') return false;
        if (live.held_monthly_rate != null) {
          const liveComponent = await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key }).first('source');
          if (!liveComponent || liveComponent.source !== 'plan_hold') {
            await trx('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
            return false;
          }
        }
        const claimed = await trx('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'resumed', resumed_at: new Date(), updated_at: new Date() });
        if (!claimed) return false;
        if (live.held_monthly_rate != null) {
          await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key })
            .update({ monthly_rate: Number(live.held_monthly_rate), source: 'plan_hold_resume', effective_at: new Date(), updated_at: new Date() });
          const rows = await trx('customer_plan_rates').where({ customer_id: hold.customer_id }).select('monthly_rate');
          const scalar = Math.round(rows.reduce((s, r) => s + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
          await trx('customers').where({ id: hold.customer_id }).update({ monthly_rate: scalar, updated_at: new Date() });
        }
        const others = await trx('plan_holds').where({ customer_id: hold.customer_id, status: 'active' }).whereNot({ id: hold.id }).max('resume_on as max');
        const nextProtected = others?.[0]?.max || null;
        await trx('customers').where({ id: hold.customer_id }).update({ tier_protected_until: nextProtected, updated_at: new Date() });
        return true;
      });
      // Only a hold the CAS actually moved to 'resumed' is reported (and
      // noted) as resumed — an obsolete one cancelled under the lock is not.
      if (!resumed) continue;
      try {
        await db('customer_interactions').insert({
          customer_id: hold.customer_id,
          interaction_type: 'note',
          subject: `${hold.family_key} hold resumed`,
          body: `Hold ${hold.id} resumed on schedule (${String(hold.resume_on).slice(0, 10)}); billing component restored.`,
        });
      } catch (noteErr) { logger.warn(`[holds] resume note failed for hold ${hold.id}: ${noteErr.message}`); }
      out.resumed += 1;
    } catch (err) {
      out.errors.push(`resume:${hold.id}`);
      logger.error(`[holds] resume failed for hold ${hold.id}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { startAwayMode, startHold, cancelHold, emitHoldTechNotices, shiftHoldResume, runPlanHoldLifecycle, HOLDABLE_FAMILIES };
