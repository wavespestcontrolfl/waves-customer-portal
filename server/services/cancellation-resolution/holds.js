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

async function familyUpcomingVisits(customerId, familyKey) {
  const { familyOfServiceRow } = require('../cancellation-processor');
  const today = etDateString();
  const rows = await db('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .whereIn('s.status', CANCELLABLE_STATUSES)
    .where(function dateOrRescheduled() {
      this.where('s.scheduled_date', '>=', today).orWhere('s.status', 'rescheduled');
    })
    .whereRaw("(s.track_state IS NULL OR s.track_state NOT IN ('complete', 'en_route', 'on_property'))")
    .orderBy('s.scheduled_date', 'asc')
    .select('s.*', 'sv.service_key', 'sv.service_name');
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
  // cannot promise "no charges".
  const customer = await db('customers').where({ id: customerId }).first('monthly_rate', 'billing_mode', 'tier_protected_until');
  const monthlyLane = Number(customer?.monthly_rate) > 0 && String(customer?.billing_mode || '') !== 'per_application';
  let heldRate = null;
  if (monthlyLane) {
    const component = await db('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey }).first('monthly_rate');
    if (!component) throw codedError('hold_unattributed', 'We could not suspend billing for that service — call our office');
    heldRate = Number(component.monthly_rate) || 0;
  }

  const [hold] = await db('plan_holds').insert({
    customer_id: customerId,
    cancellation_case_id: caseId || null,
    family_key: familyKey,
    starts_on: today,
    resume_on: resume,
    held_monthly_rate: heldRate,
    status: 'active',
  }).returning(['id']);
  const holdId = hold?.id || hold;

  // Shift the series: every upcoming visit moves forward by the same delta
  // so the cadence resumes intact on the return date. A visit that will not
  // move is left for the office — never silently dropped.
  const visits = await familyUpcomingVisits(customerId, familyKey);
  const moved = [];
  const failed = [];
  if (visits.length) {
    const SmartRebooker = require('../rebooker');
    const delta = daysBetween(String(visits[0].scheduled_date).slice(0, 10), resume);
    for (const visit of visits) {
      const from = String(visit.scheduled_date).slice(0, 10);
      const to = addDays(from, delta);
      try {
        await SmartRebooker.reschedule(visit.id, to, {
          start: visit.window_start || null, end: visit.window_end || null,
        }, 'plan_hold', 'customer', {});
        moved.push({ id: visit.id, from, to });
      } catch (err) {
        failed.push({ id: visit.id, from, error: err.message });
        logger.error(`[holds] visit ${visit.id} did not move for hold ${holdId}: ${err.message}`);
      }
    }
  }
  await db('plan_holds').where({ id: holdId }).update({ moved_visits: JSON.stringify({ moved, failed }), updated_at: new Date() });
  if (failed.length) {
    const { notifyAdmin } = require('../notification-service');
    await notifyAdmin('service', 'Plan hold: visits need a manual move', `${failed.length} visit(s) did not move for the ${familyKey} hold (customer ${customerId}). Move them past ${resume}.`, {
      bell: true,
      dedupeKey: `plan_hold_move_failed:${holdId}`,
      metadata: { kind: 'plan_hold_move_failed', customerId, holdId, failed },
    }).catch(() => {});
  }

  // Suspend the component + protect the tier, in one transaction.
  await db.transaction(async (trx) => {
    if (monthlyLane) {
      await trx('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey })
        .update({ monthly_rate: 0, source: 'plan_hold', effective_at: new Date(), updated_at: new Date() });
      const rows = await trx('customer_plan_rates').where({ customer_id: customerId }).select('monthly_rate');
      const scalar = Math.round(rows.reduce((s, r) => s + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
      await trx('customers').where({ id: customerId }).update({ monthly_rate: scalar, updated_at: new Date() });
    }
    const protectedUntil = customer?.tier_protected_until && String(customer.tier_protected_until).slice(0, 10) > resume
      ? customer.tier_protected_until
      : resume;
    await trx('customers').where({ id: customerId }).update({ tier_protected_until: protectedUntil, updated_at: new Date() });
  });

  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `${familyKey} on hold until ${resume} (cancel flow)`,
      body: `Case ${caseId || '—'}. ${moved.length} visit(s) moved${failed.length ? `, ${failed.length} need a manual move` : ''}; monthly component ${heldRate == null ? 'n/a' : `$${heldRate} suspended`}; tier protected until ${resume}.`,
    });
  } catch (err) { logger.warn(`[holds] hold note failed for ${customerId}: ${err.message}`); }

  return { holdId, familyKey, resumeOn: resume, resumeDisplay: displayDate(resume), moved: moved.length, failedMoves: failed.length };
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
      const claimed = await db('plan_holds').where({ id: hold.id }).whereNull('reminder_sent_at').update({ reminder_sent_at: new Date(), updated_at: new Date() });
      if (!claimed) continue;
      const customer = await db('customers').where({ id: hold.customer_id }).first('first_name', 'phone');
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
        await sendCustomerMessage({
          to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'support_resolution',
          customerId: hold.customer_id, identityTrustLevel: 'system', entryPoint: 'plan_hold_reminder',
          metadata: { original_message_type: 'plan_hold_resume_reminder', plan_hold_id: hold.id },
        });
      }
      out.reminded += 1;
    } catch (err) {
      out.errors.push(`remind:${hold.id}`);
      logger.error(`[holds] resume reminder failed for hold ${hold.id}: ${err.message}`);
    }
  }

  const toResume = await db('plan_holds').where({ status: 'active' }).where('resume_on', '<=', today).select('*');
  for (const hold of toResume) {
    try {
      await db.transaction(async (trx) => {
        const claimed = await trx('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'resumed', resumed_at: new Date(), updated_at: new Date() });
        if (!claimed) return;
        if (hold.held_monthly_rate != null) {
          await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key })
            .update({ monthly_rate: Number(hold.held_monthly_rate), source: 'plan_hold_resume', effective_at: new Date(), updated_at: new Date() });
          const rows = await trx('customer_plan_rates').where({ customer_id: hold.customer_id }).select('monthly_rate');
          const scalar = Math.round(rows.reduce((s, r) => s + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
          await trx('customers').where({ id: hold.customer_id }).update({ monthly_rate: scalar, updated_at: new Date() });
        }
        const others = await trx('plan_holds').where({ customer_id: hold.customer_id, status: 'active' }).whereNot({ id: hold.id }).max('resume_on as max');
        const nextProtected = others?.[0]?.max || null;
        await trx('customers').where({ id: hold.customer_id }).update({ tier_protected_until: nextProtected, updated_at: new Date() });
      });
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

module.exports = { startAwayMode, startHold, runPlanHoldLifecycle, HOLDABLE_FAMILIES };
