'use strict';

/**
 * This week's watering plan — server glue around @waves/irrigation-runtime
 * buildWeekPlan (the decision) for the two surfaces that show it: the Monday
 * irrigation email and the lawn service report.
 *
 *   decideWeekPlan()        inputs the engine already has → decision
 *   renderWeekPlanEmail()   decision → email copy (subject, heading, action, notes)
 *   renderWeekPlanReport()  decision → one report callout
 *   persistWeekPlan()       snapshot the Monday decision (inputs + policy + plan)
 *   loadCurrentWeekPlan()   the snapshot the report renders so both surfaces
 *                           show the SAME plan for the week (same function on
 *                           Thursday's weather would disagree with Monday's)
 *
 * Prose lives here, never in the runtime package: agronomy/regulatory logic
 * stays out of copy without a second decision engine (owner ruling 2026-08-28).
 * Wording rules: "each turf zone" (a controller may also run beds/drip);
 * "skip your turf watering" / "leave the turf irrigation off" — never "turn
 * your controller off"; "your permitted watering day" — never a weekday we
 * have not legally validated.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { buildWeekPlan, HEAD_LABELS, normalizeRuntimeInputs } = require('@waves/irrigation-runtime');
const { currentRestrictionPolicy } = require('../config/irrigation-restrictions');
const { lastCompletedWeekEndingET } = require('../utils/datetime-et');
const { recommendedFromEt0, recommendedInchesPerWeek, _private: advicePrivate } = require('./service-report/irrigation-advice');
const { etParts } = require('../utils/datetime-et');

const { classifySeason } = advicePrivate;

const WILT_CUES = 'a dull blue-gray tint, or footprints that stay pressed in';

function fmtInches(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  if (Math.abs(v - 0.5) < 0.01) return '½"';
  if (Math.abs(v - 0.75) < 0.01) return '¾"';
  if (Math.abs(v - 0.25) < 0.01) return '¼"';
  return `${String(Math.round(v * 100) / 100).replace(/\.?0+$/, '')}"`;
}

// Under a multi-day policy a single prescribed run may land on ANY of the
// customer's assigned days — never imply there is only one.
function permittedDayPhrase(plan) {
  return Number(plan?.legalMaxEvents) > 1 && Number(plan?.events || 0) <= 1
    ? 'one of your permitted watering days'
    : 'your permitted watering day';
}

function minutesPhrase(plan) {
  if (plan.minutesPerEvent == null) return null;
  return plan.rateSource === 'measured' ? `${plan.minutesPerEvent} minutes` : `about ${plan.minutesPerEvent} minutes`;
}

/**
 * Build the decision from what the weekly email already computed. `advice`
 * is buildIrrigationAdvice()'s output for LAST week (applied inches, target,
 * rainKnown) — it feeds carryover only. The plan is for the week AHEAD, so
 * its target and season come from the ET month of `now`, not from the
 * completed week's date (an early-April plan must not read as cool season),
 * and its target from FORECAST ET₀ (else the seasonal lookup).
 */
function decideWeekPlan({
  advice,
  grassType = null,
  forecastEt0Inches = null,
  lastWeekRainInches = null,
  forecastRainInches = null,
  runMinutes = null,
  wateringDays = null,
  systemType = null,
  explicitInchesPerWeek = null,
  rainSensor = false,
  county = null,
  now = new Date(),
} = {}) {
  const restriction = currentRestrictionPolicy(now, { county });
  const planMonth = etParts(now).month;
  // The week AHEAD's demand: forecast ET₀ when the forecast carried it, else
  // the seasonal target for this month — never the completed week's ET₀ (a
  // cool, cloudy week must not size a hot week's plan).
  const targetInchesPerWeek = recommendedFromEt0(forecastEt0Inches, grassType, planMonth)
    ?? recommendedInchesPerWeek(grassType, planMonth);
  const plan = buildWeekPlan({
    targetInchesPerWeek,
    lastWeekAppliedInches: advice?.appliedInchesPerWeek ?? null,
    lastWeekRainInches,
    lastWeekTargetInches: advice?.recommendedInchesPerWeek ?? null,
    forecastRainInches,
    season: classifySeason(planMonth),
    restriction,
    runMinutes,
    wateringDays,
    systemType,
    explicitInchesPerWeek,
    rainSensor,
    rainKnown: advice?.rainKnown !== false,
  });
  const runtime = normalizeRuntimeInputs({ runMinutes, wateringDays, systemType });
  // Everything the decision was made from, for the snapshot (the report
  // renders comparisons from these, never from today's prefs).
  const decisionInputs = {
    targetInches: targetInchesPerWeek,
    lastWeekTargetInches: advice?.recommendedInchesPerWeek ?? null,
    appliedInches: advice?.appliedInchesPerWeek ?? null,
    lastWeekRainInches,
    rainKnown: advice?.rainKnown !== false,
    forecastRainInches,
    planMonth,
    grassType,
    forecastEt0Inches,
    targetBasis: recommendedFromEt0(forecastEt0Inches, grassType, planMonth) != null ? 'forecast_et0' : 'seasonal',
    runMinutes: runtime.runMinutes,
    wateringDays: runtime.wateringDays,
    headTypes: runtime.headTypes,
    explicitInchesPerWeek: explicitInchesPerWeek ?? null,
    rainSensor: rainSensor === true,
    county,
  };
  return { plan, restriction, decisionInputs };
}

function restrictionNote(restriction) {
  if (!restriction) return '';
  const days = Number(restriction.maxDaysPerWeek);
  if (days === 0) {
    return `${restriction.label}: lawn irrigation is not permitted, through ${restriction.expiresOn}.`;
  }
  const dayWord = days === 1 ? 'one day' : `${days} days`;
  const hours = restriction.hoursNote ? `, ${restriction.hoursNote}` : '';
  return `${restriction.label}: lawn watering is limited to ${dayWord} a week${hours}, through ${restriction.expiresOn}. Water on your assigned ${days === 1 ? 'day' : 'days'} only.`;
}

function comparisonClause(plan, runMinutes) {
  const current = Number(runMinutes);
  if (plan.minutesPerEvent == null || !Number.isFinite(current) || current <= 0 || plan.rateSource !== 'system_type_default' && plan.rateSource !== 'measured') return '';
  const diff = plan.minutesPerEvent - current;
  if (Math.abs(diff) < 5) return ' — about what you run now';
  return diff < 0 ? ` — ${Math.abs(diff)} minutes less than you run now` : ` — ${diff} minutes more than you run now`;
}

function eventsOnlyClause() {
  return `run one full cycle on each turf zone — ½ to ¾ inch of water, which is about 20 minutes on spray zones and 60 on rotor zones`;
}

/**
 * Email copy for a decision. Returns null for an 'unavailable' plan so the
 * sender keeps its pre-plan template.
 */
function renderWeekPlanEmail(plan, { firstName = 'there', grassLabel = 'lawn', runMinutes = null, restriction = null, omitRateNote = false, omitSensorNote = false } = {}) {
  if (!plan || plan.action === 'unavailable') return null;
  const name = String(firstName || '').trim() || 'there';
  const notes = [];
  const overwatered = plan.reasons.includes('prior_week_overwatered');
  const cool = plan.reasons.includes('cool_season');
  const minutes = minutesPhrase(plan);
  const fallbackMinutes = plan.fallbackMinutesPerEvent != null
    ? (plan.rateSource === 'measured' ? `${plan.fallbackMinutesPerEvent} minutes` : `about ${plan.fallbackMinutesPerEvent} minutes`)
    : null;
  const fallbackCycle = fallbackMinutes
    ? `one cycle of ${fallbackMinutes} per turf zone`
    : 'one full cycle on each turf zone (½ to ¾ inch — about 20 minutes on spray zones, 60 on rotor zones)';

  let subject;
  let heading;
  let actionLine;

  if (plan.action === 'hold' && plan.reasons.includes('restriction_prohibits')) {
    // No permitted day exists — no override cycle can be offered.
    subject = `Skip your turf watering this week, ${name}`;
    heading = `No lawn watering this week, ${name}`;
    actionLine = `This week: skip your turf watering. Lawn irrigation isn't permitted in your area right now${restriction?.label ? ` under the ${restriction.label}` : ''}, so your ${grassLabel} rides on rainfall until the rules change. We'll tell you the week that changes.`;
  } else if (plan.action === 'hold') {
    subject = `Skip your turf watering this week, ${name}`;
    heading = `Your lawn is set for the week, ${name}`;
    const why = plan.reasons.includes('prior_week_rain_surplus')
      ? `Last week's rain alone left more in the soil than your ${grassLabel} can use this week`
      : overwatered
      ? `Last week's rain and irrigation left more in the soil than your ${grassLabel} can use this week`
      : cool
        ? `December through March your ${grassLabel} is barely growing — every 10–14 days if needed is plenty`
        : `Your ${grassLabel} doesn't need a full watering this week`;
    actionLine = `This week: skip your turf watering. ${why}. If the grass shows ${WILT_CUES}, run ${fallbackCycle} on ${permittedDayPhrase(plan)}.`;
  } else if (plan.conditionalOnForecast) {
    // Timing-neutral: a 7-day total can't promise the rain comes BEFORE the
    // permitted day, so the subject asks for the check, not the wait.
    subject = `Check the rain before you water this week, ${name}`;
    heading = `Check the rain before you water, ${name}`;
    // The forecast is a 7-day total and we do not know the customer's assigned
    // day, so the copy never asserts the rain comes first — it keys the
    // decision on what has actually fallen by the permitted day.
    // Multi-day: each run is judged on the rain since the PREVIOUS run, so one
    // early soaking cancels one run, not the whole week's water.
    actionLine = plan.events > 1
      ? `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast near your home, so leave the turf irrigation off for now. On each of your ${plan.events} permitted watering days: if ½" or more has fallen since your previous permitted watering day (skipped or not — since the start of the week, for the first), skip that run; if less than ½" has, run ${fallbackCycle}.`
      : `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast near your home, so leave the turf irrigation off for now. When ${permittedDayPhrase(plan)} comes around: if ½" or more has fallen so far this week, skip that run; if less than ½" has, run ${fallbackCycle}.`;
  } else {
    subject = minutes ? `This week: ${minutes} per turf zone, ${name}` : `This week's watering plan, ${name}`;
    heading = `Your watering plan for this week, ${name}`;
    const dayClause = plan.events > 1
      ? ` on each of your ${plan.events} permitted watering days`
      : ` on ${permittedDayPhrase(plan)}`;
    const depth = fmtInches(plan.depthInches);
    actionLine = minutes
      ? `This week: run each turf zone ${minutes}${dayClause}${comparisonClause(plan, runMinutes)}. That's about ${depth} of water per run — the deep-and-infrequent pattern UF/IFAS recommends.`
      : `This week: ${eventsOnlyClause()}${dayClause}.`;
    if (cool) {
      actionLine += ` It's the cool season, so after that leave the system off until the grass shows ${WILT_CUES} — every 10–14 days if needed is plenty.`;
    }
  }

  if (plan.reasons.includes('restriction_limited') && restriction) {
    const dayWord = restriction.maxDaysPerWeek === 1 ? 'one watering day' : `${restriction.maxDaysPerWeek} watering days`;
    notes.push(`Your area is limited to ${dayWord} a week right now, so this plan stays inside that even though your ${grassLabel} could use a little more — one deeper soak does more good than two light ones.`);
  }
  if (plan.action !== 'hold' && plan.minutesPerEvent == null) {
    notes.push('Add your sprinkler head type (spray or rotor) under Irrigation in your portal and next week\'s plan comes in minutes for your system.');
  } else if (plan.action !== 'hold' && plan.rateSource === 'system_type_default' && !omitRateNote) {
    notes.push(`Minutes assume typical ${HEAD_LABELS[plan.headType] || 'sprinkler'} rates from University of Florida turf guidance. If you know your system's actual weekly output, enter Weekly Inches in your portal and we'll tighten this to your numbers.`);
  }
  if (plan.rainSensor && !omitSensorNote) {
    notes.push('Your rain sensor will skip a run on its own if we get a soaking.');
  }
  if (plan.reasons.includes('forecast_unavailable') && plan.action === 'run') {
    notes.push('We couldn\'t get a rain forecast for your area this week, so this plan assumes a dry week — if we get ½" or more of rain before your watering day, skip that run.');
  }

  return {
    plan_subject: subject,
    plan_heading: heading,
    week_plan: actionLine,
    plan_note: notes.join(' '),
    restriction_note: restrictionNote(restriction),
  };
}

/**
 * One callout for the lawn report's Water This Week card. Null when there is
 * no plan (the card keeps its current advice copy).
 */
function renderWeekPlanReport(plan, { runMinutes = null } = {}) {
  if (!plan || plan.action === 'unavailable') return null;
  const minutes = minutesPhrase(plan);
  if (plan.action === 'hold' && plan.reasons.includes('restriction_prohibits')) {
    return {
      title: 'This week: no lawn watering',
      detail: 'Lawn irrigation isn\'t permitted in your area right now, so your lawn rides on rainfall until the rules change.',
    };
  }
  if (plan.action === 'hold') {
    // Same override cycle the email names — one default-dose event, sized
    // from the stored fallback (never the customer's own longer cycle).
    const fallback = plan.fallbackMinutesPerEvent != null
      ? `one cycle of ${plan.rateSource === 'measured' ? '' : 'about '}${plan.fallbackMinutesPerEvent} minutes per turf zone`
      : 'one full cycle on each turf zone (½ to ¾ inch — about 20 minutes on spray zones, 60 on rotor zones)';
    return {
      title: 'This week: skip your turf watering',
      detail: `Your lawn has what it needs for the week. If the grass shows ${WILT_CUES}, run ${fallback} on ${permittedDayPhrase(plan)}.`,
    };
  }
  if (plan.conditionalOnForecast) {
    return {
      title: 'This week: check the rain before you water',
      detail: plan.events > 1
        ? `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast. Leave the turf irrigation off for now; on each of your ${plan.events} permitted watering days, run one cycle${minutes ? ` of ${minutes} per turf zone` : ''} only if less than ½" has fallen since your previous permitted watering day (skipped or not — since the start of the week, for the first).`
        : `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast. Leave the turf irrigation off for now; on ${permittedDayPhrase(plan)}, run one cycle${minutes ? ` of ${minutes} per turf zone` : ''} only if less than ½" has fallen so far this week.`,
    };
  }
  return {
    title: minutes ? `This week: ${minutes} per turf zone` : 'This week: one full cycle per turf zone',
    detail: `${plan.events > 1 ? `On each of your ${plan.events} permitted watering days` : `On ${permittedDayPhrase(plan)}`}, about ${fmtInches(plan.depthInches)} of water per run${comparisonClause(plan, runMinutes)}.`,
  };
}

/**
 * Snapshot lifecycle — exactness contract: the row the report renders is the
 * decision the SENT email was built from.
 *   persistWeekPlan()       before the send: ATOMIC CLAIM — insert, or
 *                           replace an existing UNSENT row only when no
 *                           other worker holds a live lease on it; a SENT
 *                           row is never touched. Only the claimant sends.
 *   markWeekPlanSent()      after the provider accepts: stamp sent_at on the
 *                           row whose decision_hash matches — a stale row
 *                           from another decision can never be stamped.
 *   discardUnsentWeekPlan() send failed/blocked/threw: drop the undelivered
 *                           row so the next run's plan is the one both sent
 *                           and stored.
 *   weekPlanDeliveryState() the sweep's source of truth for "did a prior
 *                           run deliver, and which decision?" —
 *                           email_messages by idempotency key, whose
 *                           categories carry "plan:<hash>". A rerun that
 *                           finds 'sent' stamps ONLY the row with that hash
 *                           and never replaces it; a record with no hash
 *                           leaves the report plan absent; 'pending' (in
 *                           flight / unknown) touches nothing; a
 *                           post-provider throw is reconciled the same way.
 * A deduped rerun with no row (both inserts failed on the original run) is
 * left absent — the report shows no plan rather than one that was never
 * emailed. None of these throw — a snapshot problem must never block a send.
 */
// The hash covers the plan AND every snapshot input that changes rendered
// copy (runMinutes drives "10 minutes more than you run now"), so one email
// can never authenticate a row decided from different inputs.
function decisionHash(plan, decisionInputs = {}) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ plan, runMinutes: decisionInputs?.runMinutes ?? null }))
    .digest('hex');
}

const CLAIM_LEASE_MINUTES = 15;

/**
 * Pre-send write AND send claim, in one statement: insert the row, or
 * replace an existing UNSENT row only when nobody holds a live lease on it
 * (or we hold it — the post-send retry). RETURNING tells us whether we own
 * the row: { claimed: true, hash } → this worker sends; { claimed: false }
 * → another worker (or a sent row) owns the customer-week — do not send.
 */
async function persistWeekPlan({ customerId, weekEnding, planAsOf = new Date(), decisionInputs = {}, restriction = null, plan, claimToken = null } = {}) {
  if (!customerId || !weekEnding || !plan) return { claimed: false, hash: null };
  const hash = decisionHash(plan, decisionInputs);
  const token = claimToken || crypto.randomBytes(16).toString('hex');
  try {
    const row = {
      customer_id: customerId,
      week_ending: weekEnding,
      plan_as_of: planAsOf,
      weather_inputs: JSON.stringify(decisionInputs || {}),
      restriction_policy: JSON.stringify(restriction || null),
      week_plan: JSON.stringify(plan),
      decision_hash: hash,
      sent_at: null,
      claim_token: token,
      claimed_at: db.fn.now(),
      updated_at: db.fn.now(),
    };
    const returned = await db('irrigation_week_plans')
      .insert({ ...row, created_at: db.fn.now() })
      .onConflict(['customer_id', 'week_ending'])
      .merge(row)
      .whereRaw(
        `irrigation_week_plans.sent_at IS NULL AND (
           irrigation_week_plans.claim_token = ?
           OR irrigation_week_plans.claimed_at IS NULL
           OR irrigation_week_plans.claimed_at < now() - interval '${CLAIM_LEASE_MINUTES} minutes'
         )`,
        [token],
      )
      .returning(['decision_hash']);
    const claimed = Array.isArray(returned) && returned.length > 0;
    return { claimed, hash: claimed ? hash : null, claimToken: token };
  } catch (err) {
    logger.warn(`[irrigation-week-plan] snapshot claim failed for ${customerId}/${weekEnding}: ${err.message}`);
    return { claimed: false, hash: null, claimToken: token };
  }
}

async function markWeekPlanSent({ customerId, weekEnding, decisionHash: hash, sentAt = new Date() } = {}) {
  if (!hash) return false;
  try {
    const n = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding, decision_hash: hash })
      .whereNull('sent_at')
      .update({ sent_at: sentAt, updated_at: db.fn.now() });
    return n > 0;
  } catch (err) {
    logger.warn(`[irrigation-week-plan] mark-sent failed for ${customerId}/${weekEnding}: ${err.message}`);
    return false;
  }
}

// The decision hash rides the email record as a category ("plan:<sha1>") so
// the durable message row names the exact snapshot it was built from.
const PLAN_CATEGORY_PREFIX = 'plan:';
function planCategory(hash) { return hash ? `${PLAN_CATEGORY_PREFIX}${hash}` : null; }
function hashFromCategories(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = []; } }
  if (!Array.isArray(list)) return null;
  const hit = list.find((c) => typeof c === 'string' && c.startsWith(PLAN_CATEGORY_PREFIX));
  return hit ? hit.slice(PLAN_CATEGORY_PREFIX.length) : null;
}

/**
 * A prior run's delivery, from the durable email_messages record the library
 * keys by idempotency key: { state, decisionHash } — state 'sent' (provider
 * accepted — sent/delivered/opened/clicked), 'blocked' (suppressed),
 * 'failed', 'pending' (queued / in flight / lookup failed), or null (no
 * attempt); decisionHash = the snapshot the delivered email was built from
 * (null on a record that carries none). The sweep reconciles from THIS,
 * never from a return shape or an exception, and stamps only the row whose
 * hash the record names.
 */
async function weekPlanDeliveryState(idempotencyKey) {
  if (!idempotencyKey) return { state: null, decisionHash: null };
  try {
    const row = await db('email_messages').where({ idempotency_key: idempotencyKey }).first('status', 'categories');
    if (!row) return { state: null, decisionHash: null };
    const status = String(row.status || '').toLowerCase();
    const decisionHash = hashFromCategories(row.categories);
    if (['sent', 'delivered', 'opened', 'clicked'].includes(status)) return { state: 'sent', decisionHash };
    if (status === 'blocked') return { state: 'blocked', decisionHash };
    if (status === 'failed') return { state: 'failed', decisionHash };
    return { state: 'pending', decisionHash };
  } catch (err) {
    logger.warn(`[irrigation-week-plan] delivery state lookup failed for ${idempotencyKey}: ${err.message}`);
    return { state: 'pending', decisionHash: null }; // unknown → treat as in flight: never replace, never delete
  }
}

/** A SENT snapshot already exists for this customer-week (the weekly email went out). */
async function hasSentWeekPlan({ customerId, weekEnding } = {}) {
  try {
    const row = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding })
      .whereNotNull('sent_at')
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[irrigation-week-plan] sent-check failed for ${customerId}/${weekEnding}: ${err.message}`);
    return true; // unknown → do not send a second, possibly different, plan
  }
}

async function discardUnsentWeekPlan({ customerId, weekEnding } = {}) {
  try {
    await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding })
      .whereNull('sent_at')
      .del();
  } catch (err) {
    logger.warn(`[irrigation-week-plan] discard failed for ${customerId}/${weekEnding}: ${err.message}`);
  }
}

function samePolicy(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Number(a.maxDaysPerWeek) === Number(b.maxDaysPerWeek)
    && String(a.expiresOn || '') === String(b.expiresOn || '')
    && String(a.label || '') === String(b.label || '');
}

/**
 * The SENT snapshot for the CURRENT week (the sweep's week_ending key), and
 * only if the restriction policy it was decided under is still the one in force
 * — a policy that expired or tightened mid-week makes Monday's plan wrong,
 * so the report shows nothing rather than a stale legal instruction.
 * Null when there is no such snapshot.
 */
async function loadCurrentWeekPlan(customerId, { now = new Date(), pinnedSentAt, strict = false } = {}) {
  if (!customerId) return null;
  // A render pinned to the cache-signature lookup's answer: the snapshot
  // counts only if it is the SAME one that lookup saw (its sent_at), so a
  // Monday stamp landing between the two reads can't cache a plan under a
  // "plan=none" key (or vice versa).
  const pinned = pinnedSentAt !== undefined;
  if (pinned && pinnedSentAt === null) return null;
  try {
    const weekEnding = lastCompletedWeekEndingET(now);
    const row = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding })
      .whereNotNull('sent_at')
      .first();
    if (!row) return null;
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const restriction = parse(row.restriction_policy) || null;
    const decisionInputs = parse(row.weather_inputs) || {};
    if (!samePolicy(restriction, currentRestrictionPolicy(now, { county: decisionInputs.county || restriction?.county || null }))) return null;
    if (pinned && new Date(row.sent_at).toISOString() !== pinnedSentAt) return null;
    return {
      weekEnding: row.week_ending,
      planAsOf: row.plan_as_of,
      sentAt: row.sent_at,
      // The inputs the decision was made from — the report's "N minutes more
      // than you run now" compares against THESE, not today's prefs.
      decisionInputs,
      restriction,
      plan: parse(row.week_plan),
    };
  } catch (err) {
    logger.warn(`[irrigation-week-plan] snapshot load failed for ${customerId}: ${err.message}`);
    // A PINNED render must not quietly render plan-less under a plan-present
    // cache key — refuse the render (the caller retries) instead.
    if (strict) throw err;
    return null;
  }
}

module.exports = {
  decideWeekPlan,
  renderWeekPlanEmail,
  renderWeekPlanReport,
  persistWeekPlan,
  markWeekPlanSent,
  hasSentWeekPlan,
  discardUnsentWeekPlan,
  weekPlanDeliveryState,
  planCategory,
  loadCurrentWeekPlan,
  _private: { fmtInches, restrictionNote, comparisonClause, samePolicy, decisionHash, hashFromCategories, permittedDayPhrase },
};
