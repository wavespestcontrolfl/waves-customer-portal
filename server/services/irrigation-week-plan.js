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
const db = require('../models/db');
const logger = require('./logger');
const { buildWeekPlan, HEAD_LABELS } = require('@waves/irrigation-runtime');
const { currentRestrictionPolicy } = require('../config/irrigation-restrictions');
const { lastCompletedWeekEndingET } = require('../utils/datetime-et');
const { _private: advicePrivate } = require('./service-report/irrigation-advice');

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

function minutesPhrase(plan) {
  if (plan.minutesPerEvent == null) return null;
  return plan.rateSource === 'measured' ? `${plan.minutesPerEvent} minutes` : `about ${plan.minutesPerEvent} minutes`;
}

/**
 * Build the decision from what the weekly email / report already computed.
 * `advice` is buildIrrigationAdvice()'s output for LAST week (target,
 * applied, rainKnown); the target doubles as this week's need (same month).
 */
function decideWeekPlan({
  advice,
  month,
  forecastRainInches = null,
  runMinutes = null,
  wateringDays = null,
  systemType = null,
  explicitInchesPerWeek = null,
  rainSensor = false,
  now = new Date(),
} = {}) {
  const restriction = currentRestrictionPolicy(now);
  const plan = buildWeekPlan({
    targetInchesPerWeek: advice?.recommendedInchesPerWeek ?? null,
    lastWeekAppliedInches: advice?.appliedInchesPerWeek ?? null,
    lastWeekTargetInches: advice?.recommendedInchesPerWeek ?? null,
    forecastRainInches,
    season: classifySeason(month),
    restriction,
    runMinutes,
    wateringDays,
    systemType,
    explicitInchesPerWeek,
    rainSensor,
    rainKnown: advice?.rainKnown !== false,
  });
  return { plan, restriction };
}

function restrictionNote(restriction) {
  if (!restriction) return '';
  const days = restriction.maxDaysPerWeek;
  const dayWord = days === 1 ? 'one day' : `${days} days`;
  const hours = restriction.hoursNote ? `, ${restriction.hoursNote}` : '';
  return `${restriction.label}: lawn watering is limited to ${dayWord} a week${hours}, through ${restriction.expiresOn}. Water on your assigned day only.`;
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
function renderWeekPlanEmail(plan, { firstName = 'there', grassLabel = 'lawn', runMinutes = null, restriction = null, omitRateNote = false } = {}) {
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
    const why = overwatered
      ? `Last week's rain and irrigation left more in the soil than your ${grassLabel} can use this week`
      : cool
        ? `December through March your ${grassLabel} is barely growing — every 10–14 days if needed is plenty`
        : `Your ${grassLabel} doesn't need a full watering this week`;
    actionLine = `This week: skip your turf watering. ${why}. If the grass shows ${WILT_CUES}, run ${fallbackCycle} on your permitted watering day.`;
  } else if (plan.conditionalOnForecast) {
    subject = `Rain first, then decide — this week's watering, ${name}`;
    heading = `Let the rain decide this week, ${name}`;
    // The forecast is a 7-day total and we do not know the customer's assigned
    // day, so the copy never asserts the rain comes first — it keys the
    // decision on what has actually fallen by the permitted day.
    actionLine = `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast near your home, so leave the turf irrigation off for now. When your permitted watering day comes around: if ½" or more has fallen so far this week, skip the run; if less than ½" has, run ${fallbackCycle}.`;
  } else {
    subject = minutes ? `This week: ${minutes} per turf zone, ${name}` : `This week's watering plan, ${name}`;
    heading = `Your watering plan for this week, ${name}`;
    const dayClause = plan.events > 1
      ? ` on each of your ${plan.events} permitted watering days`
      : ' on your permitted watering day';
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
  if (plan.rainSensor) {
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
    return {
      title: 'This week: skip your turf watering',
      detail: `Your lawn has what it needs for the week. If the grass shows ${WILT_CUES}, run one cycle on your permitted watering day.`,
    };
  }
  if (plan.conditionalOnForecast) {
    return {
      title: 'This week: let the rain go first',
      detail: `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast. Leave the turf irrigation off for now; on your permitted watering day, run one cycle${minutes ? ` of ${minutes} per turf zone` : ''} only if less than ½" has fallen so far this week.`,
    };
  }
  return {
    title: minutes ? `This week: ${minutes} per turf zone` : 'This week: one full cycle per turf zone',
    detail: `${plan.events > 1 ? `On each of your ${plan.events} permitted watering days` : 'On your permitted watering day'}, about ${fmtInches(plan.depthInches)} of water per run${comparisonClause(plan, runMinutes)}.`,
  };
}

/**
 * Snapshot the Monday decision so the report renders the same plan. Insert
 * once per (customer_id, week_ending). Never throws — a snapshot miss must
 * not block the send.
 */
async function persistWeekPlan({ customerId, weekEnding, planAsOf = new Date(), weatherInputs = {}, restriction = null, plan } = {}) {
  if (!customerId || !weekEnding || !plan) return false;
  try {
    const row = {
      customer_id: customerId,
      week_ending: weekEnding,
      plan_as_of: planAsOf,
      weather_inputs: JSON.stringify(weatherInputs || {}),
      restriction_policy: JSON.stringify(restriction || null),
      week_plan: JSON.stringify(plan),
      updated_at: db.fn.now(),
    };
    // First write wins: the plan the customer actually received for the
    // week is immutable — a rerun never rewrites it.
    await db('irrigation_week_plans')
      .insert({ ...row, created_at: db.fn.now() })
      .onConflict(['customer_id', 'week_ending'])
      .ignore();
    return true;
  } catch (err) {
    logger.warn(`[irrigation-week-plan] snapshot failed for ${customerId}/${weekEnding}: ${err.message}`);
    return false;
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
 * The snapshot for the CURRENT week (the sweep's week_ending key), and only
 * if the restriction policy it was decided under is still the one in force
 * — a policy that expired or tightened mid-week makes Monday's plan wrong,
 * so the report shows nothing rather than a stale legal instruction.
 * Null when there is no such snapshot.
 */
async function loadCurrentWeekPlan(customerId, { now = new Date() } = {}) {
  if (!customerId) return null;
  try {
    const weekEnding = lastCompletedWeekEndingET(now);
    const row = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding })
      .first();
    if (!row) return null;
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const restriction = parse(row.restriction_policy) || null;
    if (!samePolicy(restriction, currentRestrictionPolicy(now))) return null;
    return {
      weekEnding: row.week_ending,
      planAsOf: row.plan_as_of,
      weatherInputs: parse(row.weather_inputs) || {},
      restriction,
      plan: parse(row.week_plan),
    };
  } catch (err) {
    logger.warn(`[irrigation-week-plan] snapshot load failed for ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  decideWeekPlan,
  renderWeekPlanEmail,
  renderWeekPlanReport,
  persistWeekPlan,
  loadCurrentWeekPlan,
  _private: { fmtInches, restrictionNote, comparisonClause, samePolicy },
};
