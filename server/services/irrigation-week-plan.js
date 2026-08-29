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
const { queuedRowInFlight, QUEUED_IN_FLIGHT_MS, ABORTED_BEFORE_DISPATCH } = require('./email-template-library');
const { stampedAddressDiverges, premiseStampConflicts } = require('./stamped-address');
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
function permittedDayPhrase(plan, restriction = null) {
  const day = Number(plan?.legalMaxEvents) > 1 && Number(plan?.events || 0) <= 1
    ? 'one of your permitted watering days'
    : 'your permitted watering day';
  return withHours(day, restriction);
}

// Multi-run plans: when the plan prescribes FEWER runs than the law allows
// (legalMaxEvents 7 under a 2-event seasonal cap), the runs are a choice
// among the customer's permitted days — "two of your permitted watering
// days" — never a redefinition of the legal schedule as "each of your 2"
// (codex gh-r18). Equal counts keep "each of your N".
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
function multiDayPhrase(plan, restriction = null) {
  const n = Number(plan?.events || 0);
  const phrase = Number(plan?.legalMaxEvents) > n
    ? `${COUNT_WORDS[n] || n} of your permitted watering days`
    : `each of your ${n} permitted watering days`;
  return withHours(phrase, restriction);
}

// The policy's hour restriction rides EVERY instruction (email and report
// alike), not just the footnote — a run on the right day at the wrong hour
// is still illegal.
function withHours(dayPhrase, restriction) {
  const hours = restriction && restriction.hoursNote ? String(restriction.hoursNote).trim() : '';
  return hours ? `${dayPhrase} (${hours})` : dayPhrase;
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
  // The home the plan is decided for (address + coordinates the sweep used);
  // the report attaches the plan only to a service at THIS address.
  home = null,
  // The plan week's Sunday: a policy that expires before it does not cover
  // the instruction and yields no plan.
  planWeekEnd = null,
  // Last week's SENT plan's event count — cool-season cadence input.
  priorWeekEvents = null,
  // Last week's delivered plan's prescribed inches — replaces the programmed
  // schedule as last week's applied irrigation (null = no delivered plan).
  priorWeekPrescribedInches = null,
  // Unconfirmed schedule after a move: carryover from observed RAIN only
  // (the former home's programmed irrigation is withheld).
  rainOnlyCarryover = false,
  now = new Date(),
} = {}) {
  const restriction = currentRestrictionPolicy(now, { county, horizonEnd: planWeekEnd });
  const planMonth = etParts(now).month;
  // The week AHEAD's demand: forecast ET₀ when the forecast carried it, else
  // the seasonal target for this month — never the completed week's ET₀ (a
  // cool, cloudy week must not size a hot week's plan).
  const targetInchesPerWeek = recommendedFromEt0(forecastEt0Inches, grassType, planMonth)
    ?? recommendedInchesPerWeek(grassType, planMonth);
  // Last week's APPLIED water is rain + irrigation (buildIrrigationAdvice's
  // appliedInchesPerWeek). A delivered prior plan replaces only the
  // irrigation half: its prescribed depth PLUS the observed rain — a prior
  // hold after 1.25" of rain is 1.25" applied, not 0, so the rain surplus
  // still carries (codex gh-r32). Rain counts only when it is trusted, the
  // same rule the advice engine applies.
  const rainKnown = advice?.rainKnown !== false;
  const lastWeekRain = Number.isFinite(Number(lastWeekRainInches)) ? Number(lastWeekRainInches) : null;
  const lastWeekAppliedInches = priorWeekPrescribedInches != null
    ? Math.round((Number(priorWeekPrescribedInches) + (rainKnown && lastWeekRain != null ? lastWeekRain : 0)) * 100) / 100
    : (advice?.appliedInchesPerWeek ?? null);
  const plan = buildWeekPlan({
    targetInchesPerWeek,
    lastWeekAppliedInches,
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
    rainKnown,
    priorWeekEvents,
    rainOnlyCarryover,
  });
  const runtime = normalizeRuntimeInputs({ runMinutes, wateringDays, systemType });
  // Everything the decision was made from, for the snapshot (the report
  // renders comparisons from these, never from today's prefs).
  const decisionInputs = {
    targetInches: targetInchesPerWeek,
    lastWeekTargetInches: advice?.recommendedInchesPerWeek ?? null,
    appliedInches: lastWeekAppliedInches,
    priorWeekEvents,
    priorWeekPrescribedInches,
    rainOnlyCarryover: rainOnlyCarryover === true,
    lastWeekRainInches,
    rainKnown,
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
    planWeekEnd,
    home: home ? {
      addressLine1: home.addressLine1 || null,
      addressLine2: home.addressLine2 || null,
      city: home.city || null,
      zip: home.zip || null,
      latitude: home.latitude ?? null,
      longitude: home.longitude ?? null,
    } : null,
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
function renderWeekPlanEmail(plan, { firstName = 'there', grassLabel = 'lawn', runMinutes = null, restriction = null, omitRateNote = false, omitSensorNote = false, scheduleUnconfirmed = false } = {}) {
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
    // Cadence hold: a SENT plan proves the email went out, not that the
    // irrigation ran — the copy is conditional on what the customer did,
    // never "you watered last week" (hook P1 on 246b5bfc8).
    actionLine = plan.reasons.includes('cool_season_cadence')
      ? `This week: if you ran last week's watering, skip your turf watering — December through March your ${grassLabel} is barely growing, and every 10–14 days if needed is plenty. If you didn't, run ${fallbackCycle} on ${permittedDayPhrase(plan, restriction)}.`
      : `This week: skip your turf watering. ${why}. If the grass shows ${WILT_CUES}, run ${fallbackCycle} on ${permittedDayPhrase(plan, restriction)}.`;
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
      ? `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast near your home, so leave the turf irrigation off for now. On ${multiDayPhrase(plan, restriction)}: if ½" or more has fallen since your previous permitted watering day (skipped or not — since the start of the week, for the first), skip that run; if less than ½" has, run ${fallbackCycle}.`
      : `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast near your home, so leave the turf irrigation off for now. When ${permittedDayPhrase(plan, restriction)} comes around: if ½" or more has fallen so far this week, skip that run; if less than ½" has, run ${fallbackCycle}.`;
  } else {
    subject = minutes ? `This week: ${minutes} per turf zone, ${name}` : `This week's watering plan, ${name}`;
    heading = `Your watering plan for this week, ${name}`;
    const dayClause = plan.events > 1
      ? ` on ${multiDayPhrase(plan, restriction)}`
      : ` on ${permittedDayPhrase(plan, restriction)}`;
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
  if (scheduleUnconfirmed && plan.action !== 'hold') {
    // The home moved after the sprinkler settings were saved — the plan
    // deliberately left them out (events-only), and says so.
    notes.push('Your address changed after your sprinkler settings were saved, so this plan leaves them out. Re-enter each of your zone minutes, watering days and head type (and weekly inches, if you use them) under Irrigation in your portal and next week\'s plan comes in minutes for your system.');
  } else if (plan.action !== 'hold' && plan.minutesPerEvent == null) {
    notes.push('Add your sprinkler head type (spray or rotor) under Irrigation in your portal and next week\'s plan comes in minutes for your system.');
  } else if (plan.action !== 'hold' && plan.rateSource === 'system_type_default' && !omitRateNote) {
    notes.push(`Minutes assume typical ${HEAD_LABELS[plan.headType] || 'sprinkler'} rates from University of Florida turf guidance. If you know your system's actual weekly output, enter Weekly Inches in your portal and we'll tighten this to your numbers.`);
  }
  if (plan.rainSensor && !omitSensorNote) {
    notes.push('Your rain sensor will skip a run on its own if we get a soaking.');
  }
  // One soaking skips one run — on EVERY unconditional run plan, whatever
  // the forecast said (an under-predicted storm is still ½" in the ground).
  if (plan.action === 'run' && !plan.conditionalOnForecast) {
    const lead = plan.reasons.includes('forecast_unavailable')
      ? 'We couldn\'t get a rain forecast for your area this week, so this plan assumes a dry week — '
      : 'And if the forecast is wrong: ';
    notes.push(lead + (plan.events > 1
      ? 'before each run, if ½" or more has fallen since your previous permitted watering day (skipped or not — since the start of the week, for the first), skip that run.'
      : 'if we get ½" or more of rain before your run, skip it.'));
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
function renderWeekPlanReport(plan, { runMinutes = null, restriction = null } = {}) {
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
    if (plan.reasons.includes('cool_season_cadence')) {
      return {
        title: 'This week: skip if you watered last week',
        detail: `In the cool season every 10–14 days is plenty. If you ran last week's watering, skip this week; if you didn't, run ${fallback} on ${permittedDayPhrase(plan, restriction)}.`,
      };
    }
    return {
      title: 'This week: skip your turf watering',
      detail: `Your lawn has what it needs for the week. If the grass shows ${WILT_CUES}, run ${fallback} on ${permittedDayPhrase(plan, restriction)}.`,
    };
  }
  if (plan.conditionalOnForecast) {
    // Same cycle the email names: minutes when a rate exists, otherwise the
    // turf-zone / depth fallback — never a bare "one cycle" a customer could
    // read as the whole controller program.
    const cycle = minutes
      ? `one cycle of ${minutes} per turf zone`
      : 'one full cycle on each turf zone (½ to ¾ inch — about 20 minutes on spray zones, 60 on rotor zones)';
    return {
      title: 'This week: check the rain before you water',
      detail: plan.events > 1
        ? `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast. Leave the turf irrigation off for now; on ${multiDayPhrase(plan, restriction)}, run ${cycle} only if less than ½" has fallen since your previous permitted watering day (skipped or not — since the start of the week, for the first).`
        : `About ${fmtInches(plan.forecastRainInches)} of rain is in this week's forecast. Leave the turf irrigation off for now; on ${permittedDayPhrase(plan, restriction)}, run ${cycle} only if less than ½" has fallen so far this week.`,
    };
  }
  // One soaking skips one run — on every unconditional run plan (the email
  // carries the same safeguard); the no-forecast case just says why.
  const rainLead = plan.reasons.includes('forecast_unavailable') ? ' No rain forecast was available for this plan — ' : ' If the forecast is wrong: ';
  const noForecastNote = rainLead + (plan.events > 1
    ? 'before each run, if ½" or more has fallen since your previous permitted watering day (skipped or not — since the start of the week, for the first), skip that run.'
    : 'if ½" or more of rain falls before your run, skip it.');
  return {
    title: minutes ? `This week: ${minutes} per turf zone` : 'This week: one full cycle per turf zone',
    detail: `${plan.events > 1 ? `On ${multiDayPhrase(plan, restriction)}` : `On ${permittedDayPhrase(plan, restriction)}`}, about ${fmtInches(plan.depthInches)} of water per run${comparisonClause(plan, runMinutes)}.${noForecastNote}`,
  };
}

/**
 * The report card's plan once a REQUIRED treatment watering-in has been
 * credited as one of the week's runs: the customer must never see the
 * unreduced plan under the credit note (a one-run plan + the watering-in =
 * two waterings, over both the agronomic plan and a one-day legal limit —
 * codex gh-r24). Null for hold / unavailable plans (nothing to reduce).
 */
function renderWeekPlanAfterTreatment(plan, { restriction = null } = {}) {
  if (!plan || plan.action !== 'run') return null;
  const events = Number(plan.events || 0);
  const remaining = Math.max(0, events - 1);
  if (remaining === 0) {
    return {
      title: 'This week: covered by today\'s treatment watering-in',
      detail: 'Water in today\'s application as the after-visit note says — that is this week\'s run. No further turf runs this week.',
    };
  }
  const minutes = minutesPhrase(plan);
  const cycles = remaining === 1
    ? (minutes ? `one more cycle of ${minutes} per turf zone` : 'one more full cycle on each turf zone')
    : (minutes ? `${remaining} more cycles of ${minutes} per turf zone` : `${remaining} more full cycles on each turf zone`);
  const days = remaining === 1 ? 'one of your other permitted watering days' : 'your other permitted watering days';
  // The remaining runs keep the plan's own rain rule: a conditional plan's
  // "only if less than ½" has fallen" clause, or the unconditional
  // one-soaking-skips-one-run safeguard (codex gh-r30).
  const rainRule = plan.conditionalOnForecast
    ? ', only if less than ½" has fallen since your previous run'
    : ' — and if ½" or more of rain falls before a run, skip it';
  return {
    title: `This week: ${remaining} more run${remaining === 1 ? '' : 's'} after today\'s watering-in`,
    detail: `Today\'s watering-in counts as one of your ${events} runs. Run ${cycles} on ${withHours(days, restriction)}${rainRule}.`,
  };
}

/**
 * Snapshot lifecycle — exactness contract: the row the report renders is the
 * decision the SENT email was built from.
 *   persistWeekPlan()       before the send: ATOMIC CLAIM — insert, or
 *                           replace an existing UNSENT row only when no
 *                           other worker holds a live lease on it (lease =
 *                           the email library's queued-row lease); a SENT
 *                           row is never touched. Only the claimant sends.
 *   markWeekPlanSent()      after the provider accepts: stamp sent_at on the
 *                           row whose decision_hash matches — a stale row
 *                           from another decision can never be stamped.
 *   discardUnsentWeekPlan() send failed/blocked/threw: drop the undelivered
 *                           row — only the claimant's own (claim_token) —
 *                           so the next run's plan is the one both sent and
 *                           stored.
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
// The hash covers EVERYTHING persisted on the row that shapes copy or
// premise binding — the plan, every decision input (runtime, home, county,
// forecast, targets…) and the restriction — so one email can never
// authenticate a row decided from different inputs or a different home.
function decisionHash(plan, decisionInputs = {}, restriction = null) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ plan, decisionInputs: decisionInputs || {}, restriction: restriction || null }))
    .digest('hex');
}

// The send claim expires on the SAME clock as the email library's queued-row
// lease (QUEUED_IN_FLIGHT_MS): once the library would reclaim an abandoned
// queued row, a retry must be able to reclaim the snapshot too — otherwise a
// Monday retry in the gap sends nothing and the week is lost.
const CLAIM_LEASE_SECONDS = Math.max(1, Math.round(QUEUED_IN_FLIGHT_MS / 1000));

/**
 * Pre-send write AND send claim, in one statement: insert the row, or
 * replace an existing UNSENT row only when nobody holds a live lease on it
 * (or we hold it — the post-send retry). RETURNING tells us whether we own
 * the row: { claimed: true, hash } → this worker sends; { claimed: false }
 * → another worker (or a sent row) owns the customer-week — do not send.
 */
async function persistWeekPlan({ customerId, weekEnding, planAsOf = new Date(), decisionInputs = {}, restriction = null, plan, claimToken = null } = {}) {
  if (!customerId || !weekEnding || !plan) return { claimed: false, hash: null };
  const hash = decisionHash(plan, decisionInputs, restriction);
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
           OR irrigation_week_plans.claimed_at < now() - interval '${CLAIM_LEASE_SECONDS} seconds'
         )`,
        [token],
      )
      .returning(['decision_hash']);
    const claimed = Array.isArray(returned) && returned.length > 0;
    return { claimed, hash: claimed ? hash : null, claimToken: token };
  } catch (err) {
    logger.warn(`[irrigation-week-plan] snapshot claim failed for ${customerId}/${weekEnding}: ${err.message}`);
    // Distinct from contention: the caller falls back to the pre-plan email
    // rather than silencing the week's communication.
    return { claimed: false, hash: null, claimToken: token, error: true };
  }
}

// Renew the claimant's lease on the SAME transition the email library's
// in-flight lease starts (its onQueued hook): the claim was taken before
// weather fetches, rendering, template resolution and suppression checks, so
// a lease of equal length that started earlier could expire while the email
// is still legitimately in flight — another sweep would replace the snapshot
// and this worker's claim-scoped stamp would then miss (codex #3565 gh-r19).
// Returns true (renewed), false (claim LOST — another worker replaced the
// row; the caller must not send its older decision), or null (unreadable —
// ambiguous, the caller proceeds best-effort).
async function renewWeekPlanClaim({ customerId, weekEnding, claimToken } = {}) {
  if (!customerId || !weekEnding || !claimToken) return false;
  try {
    const n = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding, claim_token: claimToken })
      .whereNull('sent_at')
      .update({ claimed_at: db.fn.now(), updated_at: db.fn.now() });
    return n > 0;
  } catch (err) {
    logger.warn(`[irrigation-week-plan] claim renew failed for ${customerId}/${weekEnding}: ${err.message}`);
    return null;
  }
}

// The PRIOR week's delivered plan — what the customer was told to do last
// week: `events` (null when the plan was forecast-conditional: it may have
// been skipped as instructed) drives the cool-season cadence, and
// `prescribedInches` replaces the customer's programmed schedule as last
// week's applied irrigation from the second plan week on (events × depth;
// 0 for a hold or a conditional plan — conservative, never a manufactured
// surplus/carryover from a schedule the plan superseded — codex gh-r31).
// Null when there is no delivered prior plan (or it cannot be read).
async function loadPriorWeekPlan({ customerId, weekEnding } = {}) {
  const prior = etDateStringPlusDays(weekEnding, -7);
  if (!customerId || !prior) return null;
  try {
    const row = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: prior })
      .first('week_plan', 'sent_at', 'decision_hash');
    if (!row) return null;
    // Delivered = stamped, OR the durable customer-week delivery record says
    // the provider accepted it and names this decision — the same
    // reconciliation the sweep and the merge use (codex gh-r20/r23).
    if (!row.sent_at) {
      const delivery = await weekPlanDeliveryState({ triggerEventId: `irrigation.weekly:${customerId}:${prior}` });
      if (delivery.state !== 'sent' || !delivery.decisionHash || delivery.decisionHash !== row.decision_hash) return null;
    }
    const plan = typeof row.week_plan === 'string' ? JSON.parse(row.week_plan) : row.week_plan;
    if (!plan || plan.action === 'unavailable') return null;
    const events = Number(plan.events);
    const depth = Number(plan.depthInches);
    const ran = plan.action === 'run' && !plan.conditionalOnForecast && Number.isFinite(events) && events > 0;
    return {
      events: plan.conditionalOnForecast ? null : (Number.isFinite(events) ? events : null),
      prescribedInches: ran && Number.isFinite(depth) ? Math.round(events * depth * 100) / 100 : 0,
    };
  } catch (err) {
    logger.warn(`[irrigation-week-plan] prior-week lookup failed for ${customerId}/${weekEnding}: ${err.message}`);
    return null;
  }
}

async function markWeekPlanSent({ customerId, weekEnding, decisionHash: hash, claimToken = null, sentAt = new Date() } = {}) {
  if (!hash) return false;
  try {
    // Hash AND (when the caller holds one) claim token: the row stamped is
    // the exact decision this worker claimed and emailed.
    const n = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding, decision_hash: hash, ...(claimToken ? { claim_token: claimToken } : {}) })
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
 * A prior run's delivery, from the durable email_messages record — looked up
 * at customer/week scope (trigger_event_id): { state, decisionHash } — state 'sent' (provider
 * accepted — sent/delivered/opened/clicked), 'blocked' (suppressed),
 * 'failed' (rejected BEFORE the provider — retryable), 'stale' (queued past
 * the library's in-flight lease — abandoned, retryable), 'pending' (queued
 * in flight / failed AFTER the provider accepted — ambiguous / lookup
 * failed), or null (no attempt); decisionHash = the snapshot the delivered email was built from
 * (null on a record that carries none). The sweep reconciles from THIS,
 * never from a return shape or an exception, and stamps only the row whose
 * hash the record names.
 */
// A 'failed' row is ambiguous when the provider may have accepted the
// message: it carries a provider id, OR it is recent enough that the
// library's post-send bookkeeping (which writes the provider id in the same
// update that can throw) may have failed after acceptance and the delivery
// webhook has not yet repaired it. Past that window with no id it is a
// definite pre-provider rejection, retryable through the library's own path.
const FAILED_AMBIGUITY_MS = 30 * 60 * 1000;
function failedIsAmbiguous(row, now = Date.now()) {
  if (row.provider_message_id) return true;
  const at = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
  return Number.isFinite(at) && now - at < FAILED_AMBIGUITY_MS;
}

/**
 * Does a sent snapshot bind to the premise a report is for? The plan was
 * decided for the HOME recorded on the snapshot; a service at any other
 * premise — rental, mid-week move, another unit in the building — must not
 * carry it. Used by the report build AND its cache signature, so an address
 * change re-keys cached PDFs.
 */
function planBindsToService(snapshot, service) {
  const home = snapshot?.decisionInputs?.home || null;
  if (!home) return true;
  const serviceStamp = { service_address_line1: service?.address_line1, service_address_line2: service?.address_line2, service_address_city: service?.city, service_address_zip: service?.zip };
  const homeStamp = { service_address_line1: home.addressLine1, service_address_line2: home.addressLine2, service_address_city: home.city, service_address_zip: home.zip };
  const diverges = stampedAddressDiverges({
    service_address_line1: service?.address_line1, service_address_city: service?.city, service_address_zip: service?.zip,
    customer_address_line1: home.addressLine1, customer_city: home.city, customer_zip: home.zip,
  });
  return !(diverges || premiseStampConflicts(serviceStamp, homeStamp));
}

async function weekPlanDeliveryState({ triggerEventId, idempotencyKey } = {}) {
  // Customer/week scope (trigger_event_id) — recipient-independent, so a
  // delivery made before an email change is still found; the recipient key
  // is only a fallback for records without a trigger id.
  const where = triggerEventId ? { trigger_event_id: triggerEventId } : (idempotencyKey ? { idempotency_key: idempotencyKey } : null);
  if (!where) return { state: null, decisionHash: null };
  try {
    const rows = await db('email_messages').where(where).select('status', 'categories', 'provider_message_id', 'queued_at', 'updated_at', 'error_message');
    if (!rows || !rows.length) return { state: null, decisionHash: null };
    // 'failed' splits on whether the provider ever accepted the message: a
    // failed row WITH a provider_message_id is a post-provider bookkeeping
    // failure (ambiguous → pending: never reclaimed, resent or deleted until
    // a webhook repairs it); a failed row WITHOUT one is a definite
    // pre-provider rejection → 'failed', which the library's own
    // shouldRetryExistingMessage path is allowed to retry.
    // A 'queued' row is in flight only inside the library's own two-minute
    // lease (queuedRowInFlight); past it the row is abandoned (a worker died
    // before recording a terminal status) and the library reclaims it on the
    // next send — so it classifies 'stale' (claimable), never a week-long
    // 'pending' that would lose the customer's Monday-only email.
    const classify = (row) => {
      const status = String(row.status || '').toLowerCase();
      if (['sent', 'delivered', 'opened', 'clicked'].includes(status)) return 'sent';
      if (status === 'blocked') return 'blocked';
      // An attempt its own caller aborted at the queue transition never
      // reached the provider — retryable now, not a 30-minute ambiguity
      // (the reclaiming owner must proceed, or a weekly cron loses the email).
      if (status === 'failed') return (row.error_message === ABORTED_BEFORE_DISPATCH || !failedIsAmbiguous(row)) ? 'failed' : 'pending';
      if (status === 'queued') return queuedRowInFlight(row) ? 'pending' : 'stale';
      return 'pending';
    };
    // A delivered record wins over any other attempt for the week.
    const sent = rows.find((r) => classify(r) === 'sent');
    if (sent) return { state: 'sent', decisionHash: hashFromCategories(sent.categories) };
    const pending = rows.find((r) => classify(r) === 'pending');
    if (pending) return { state: 'pending', decisionHash: hashFromCategories(pending.categories) };
    const last = rows[rows.length - 1];
    return { state: classify(last), decisionHash: hashFromCategories(last.categories) };
  } catch (err) {
    logger.warn(`[irrigation-week-plan] delivery state lookup failed for ${triggerEventId || idempotencyKey}: ${err.message}`);
    return { state: 'pending', decisionHash: null }; // unknown → treat as in flight: never replace, never delete
  }
}

/** A SENT snapshot already exists for this customer-week (the weekly email went out). */
/**
 * true = a SENT snapshot exists for the customer-week; false = none; null =
 * UNKNOWN (lookup failed / table unavailable) — the caller falls back to the
 * pre-plan email rather than treating an unreadable table as a sent row.
 */
async function hasSentWeekPlan({ customerId, weekEnding } = {}) {
  try {
    const row = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding })
      .whereNotNull('sent_at')
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[irrigation-week-plan] sent-check failed for ${customerId}/${weekEnding}: ${err.message}`);
    return null;
  }
}

async function discardUnsentWeekPlan({ customerId, weekEnding, claimToken = null } = {}) {
  // Only the claimant may discard, and only its own row: a worker whose
  // lease expired must never delete the row a newer worker reclaimed.
  if (!claimToken) return;
  try {
    await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding, claim_token: claimToken })
      .whereNull('sent_at')
      .del();
  } catch (err) {
    logger.warn(`[irrigation-week-plan] discard failed for ${customerId}/${weekEnding}: ${err.message}`);
  }
}

/**
 * Whether a visit on `serviceDate` falls inside the snapshot's PLAN week —
 * the days the Monday decision covers: after `weekEnding` (the completed
 * week's Sunday) through the decision's `planWeekEnd` (else +7). Report
 * links are long-lived: a historical visit's watering-in must never be
 * credited against the CURRENT week's run count (codex gh-r14).
 */
function visitInPlanWeek(snapshot, serviceDate) {
  const weekEnding = etDateStringPlusDays(snapshot?.weekEnding, 0);
  const visit = etDateStringPlusDays(serviceDate, 0);
  if (!weekEnding || !visit) return false;
  const planWeekEnd = etDateStringPlusDays(snapshot?.decisionInputs?.planWeekEnd, 0) || etDateStringPlusDays(weekEnding, 7);
  return visit > weekEnding && visit <= planWeekEnd;
}

function etDateStringPlusDays(ymd, days) {
  const iso = ymd instanceof Date ? ymd.toISOString().slice(0, 10) : String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Every field that shapes the instruction must match — days, dates, hours,
// label, county: an operator changing hoursNote alone must retire Monday's
// snapshot from the report just like a day-cap change would.
const POLICY_IDENTITY_FIELDS = ['maxDaysPerWeek', 'effectiveFrom', 'expiresOn', 'label', 'hoursNote', 'county'];
function policyIdentity(p) {
  return JSON.stringify(POLICY_IDENTITY_FIELDS.map((k) => (k === 'maxDaysPerWeek' ? Number(p?.[k]) : String(p?.[k] ?? ''))));
}
function samePolicy(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return policyIdentity(a) === policyIdentity(b);
}

/**
 * The SENT snapshot for the CURRENT week (the sweep's week_ending key), and
 * only if the restriction policy it was decided under is still the one in force
 * — a policy that expired or tightened mid-week makes Monday's plan wrong,
 * so the report shows nothing rather than a stale legal instruction.
 * Null when there is no such snapshot.
 */
// A render pinned to a plan the cache key saw, that can no longer be shown as
// that plan (row gone, policy changed, a different send stamped) — refusal,
// never a quiet plan-less render under a plan-present signature: the browser
// would otherwise produce a plan-less PDF a queued delivery mails while the
// Monday email carried the plan (codex #3565 gh-r16). Mirrors
// PinnedAssessmentUnavailable; reports-public maps the code to 409.
class PinnedWeekPlanUnavailable extends Error {
  constructor(reason) {
    super(`pinned week plan is no longer available for this render (${reason})`);
    this.code = 'pinned_week_plan_unavailable';
    this.reason = reason;
  }
}

async function loadCurrentWeekPlan(customerId, { now = new Date(), pinnedSentAt, strict = false } = {}) {
  if (!customerId) return null;
  // A render pinned to the cache-signature lookup's answer: the snapshot
  // counts only if it is the SAME one that lookup saw (its sent_at), so a
  // Monday stamp landing between the two reads can't cache a plan under a
  // "plan=none" key (or vice versa).
  const pinned = pinnedSentAt !== undefined;
  if (pinned && pinnedSentAt === null) return null;
  // Strict + pinned to a real send: any way the pinned plan fails to resolve
  // is a refusal, not an absence.
  const strictPin = strict && typeof pinnedSentAt === 'string';
  const absent = (reason) => {
    if (strictPin) throw new PinnedWeekPlanUnavailable(reason);
    return null;
  };
  try {
    const weekEnding = lastCompletedWeekEndingET(now);
    let row = await db('irrigation_week_plans')
      .where({ customer_id: customerId, week_ending: weekEnding })
      .first();
    if (!row) return absent('missing');
    if (!row.sent_at) {
      // The provider may have accepted the email while the post-send stamp
      // failed (a once-a-week cron would otherwise leave the report plan-less
      // all week): reconcile from the customer-week delivery record, stamp,
      // and re-read — served only once actually stamped (codex gh-r26).
      const delivery = await weekPlanDeliveryState({ triggerEventId: `irrigation.weekly:${customerId}:${weekEnding}` });
      if (delivery.state === 'sent' && delivery.decisionHash && delivery.decisionHash === row.decision_hash) {
        await markWeekPlanSent({ customerId, weekEnding, decisionHash: row.decision_hash });
        row = await db('irrigation_week_plans')
          .where({ customer_id: customerId, week_ending: weekEnding })
          .first();
      }
      if (!row || !row.sent_at) return absent('unstamped');
    }
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const restriction = parse(row.restriction_policy) || null;
    const decisionInputs = parse(row.weather_inputs) || {};
    // The policy must still be in force for the county AND still cover the
    // snapshot's whole plan week.
    const horizonEnd = decisionInputs.planWeekEnd || etDateStringPlusDays(row.week_ending, 7);
    if (!samePolicy(restriction, currentRestrictionPolicy(now, { county: decisionInputs.county || restriction?.county || null, horizonEnd }))) return absent('policy_changed');
    if (pinned && new Date(row.sent_at).toISOString() !== pinnedSentAt) return absent('sent_at_mismatch');
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
    if (err instanceof PinnedWeekPlanUnavailable) throw err;
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
  renderWeekPlanAfterTreatment,
  visitInPlanWeek,
  renewWeekPlanClaim,
  loadPriorWeekPlan,
  PinnedWeekPlanUnavailable,
  persistWeekPlan,
  markWeekPlanSent,
  hasSentWeekPlan,
  discardUnsentWeekPlan,
  weekPlanDeliveryState,
  planBindsToService,
  planCategory,
  loadCurrentWeekPlan,
  _private: { fmtInches, restrictionNote, comparisonClause, samePolicy, decisionHash, hashFromCategories, permittedDayPhrase, multiDayPhrase, withHours, failedIsAmbiguous, CLAIM_LEASE_SECONDS },
};
