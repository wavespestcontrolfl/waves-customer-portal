'use strict';

/**
 * New-sod mode over the WHOLE report payload (lawn report rebuild P35, GATE_LAWN_NEW_SOD_MODE).
 *
 * The mode used to be enforced key by key where each watering or mowing sentence was built,
 * and every round found another key it did not know about. This is the one rule instead:
 * when new-sod mode is ACTIVE for the visit, buildReportV1Data hands its finished payload
 * to enforceNewSodPayload, which walks an explicit list of every module the clients read
 * for watering, irrigation or mowing (the web lawn section, ServiceReportDocument and the
 * image-URL mirror) and either REPLACES it with the fixed new-sod value or REMOVES it.
 *
 * Measurements stay (rain, the customer's irrigation figures, the product list, the
 * treatment record): they are facts, not instructions. Instruction-bearing and
 * advice-bearing keys do not. To add a surface that reads watering or mowing, add its
 * key to NEW_SOD_PAYLOAD_RULES and to the render test (client/src/pages/
 * ServiceReportDocument.newSod.test.jsx), which renders both documents from a maximal
 * payload and fails on any watering / mowing wording the mode forbids.
 *
 * Pure: mutates and returns the payload it is given; no database, no clock.
 */

const { NEW_SOD_COPY, buildNewSodBanner, buildNewSodWeekPlan } = require('./lawn-new-sod');

// Advice words. A text key from the advice list below that matches is removed. Observations
// ("what we saw") and the customer's own words are not on the list and are never touched.
const ADVICE_WORDS = /water|irrigat|sprinkl|moist|\bdry\b|drought|damp|\brain\b|\bmow|mower|ease back|\bskip\b|extra run/i;

// Every watering / irrigation / mowing module and key, where it lives, and what happens to it.
const NEW_SOD_PAYLOAD_RULES = Object.freeze({
  // [path]: 'replaced:<value>' | 'removed' | 'scrubbed'
  'data.mowingHeight': 'removed (height, target band, trend and the gauge photo; rendered-image-urls follows)',
  'data.applications[].product.irrigation_notes': 'removed ("Watering in:" row)',
  'data.applications[].product.irrigation_required': 'removed',
  'data.lawnAssessment.waterContext.weekPlan': 'replaced: the fixed new-sod plan',
  'data.lawnAssessment.waterContext.irrigationAdvice': 'removed',
  'data.lawnAssessment.waterContext.targetInchesPerWeek': 'removed',
  'data.lawnAssessment.overwateringSignal': 'replaced: false',
  'data.lawnAssessment.droughtStress': 'removed',
  'data.reportV2.banner': 'replaced: the fixed new-sod banner (no forecastLine, observedRain, mowHold)',
  'data.reportV2.water.weekPlan': 'replaced: the fixed new-sod plan (no afterHold, afterTreatment, depthInches, credit fields)',
  'data.reportV2.water.{status,explanation,coverageWatch,droughtSignal,targetInches,scheduleOnFile,scheduleUnconfirmed}': 'replaced: neutral values (no target range, no schedule CTA or move note)',
  'data.reportV2.aftercare': 'replaced: the fixed new-sod lines; hold, credit, review and instruction-evidence fields removed; the pet re-entry note stays',
  'data.reportV2.mowing': 'removed',
  'data.reportV2.trends.{waterGap,mowing,mowingBand}': 'removed',
  'data.reportV2.insights[category water|mowing]': 'removed',
  'data.reportV2.{snapshot,insights[],followUp,smsSummary} advice keys': 'scrubbed (see ADVICE_KEYS)',
});

// The advice-bearing text keys. Observations (whatWeSaw, photoSummary), the treatment record
// (treatmentSummary) and a customer-concern card carry facts or the customer's own words.
const SNAPSHOT_ADVICE_KEYS = ['customerAction', 'wavesNext', 'rootCause', 'scoreExplanation'];
const INSIGHT_ADVICE_KEYS = ['headline', 'whyItMatters', 'wavesAction', 'customerAction', 'nextVisitPlan'];
const FOLLOW_UP_ADVICE_KEYS = ['headline', 'reason', 'customerAction'];

const advice = (value) => typeof value === 'string' && ADVICE_WORDS.test(value);

function scrubKeys(host, keys) {
  if (!host || typeof host !== 'object') return;
  for (const key of keys) if (advice(host[key])) host[key] = null;
}

function enforceReportV2(v2, plan, banner) {
  v2.banner = banner;
  const old = v2.water && typeof v2.water === 'object' ? v2.water : {};
  v2.water = {
    ...old,
    status: 'unknown',
    explanation: null,
    coverageWatch: false,
    droughtSignal: null,
    targetInches: null,
    scheduleOnFile: true,
    scheduleUnconfirmed: false,
    weekPlan: plan,
  };
  const oldAftercare = v2.aftercare && typeof v2.aftercare === 'object' ? v2.aftercare : {};
  v2.aftercare = {
    // Both fixed lines: the PDF and Ask Waves read only this field for the visit's watering.
    watering: banner.lines.join(' '),
    reentry: oldAftercare.reentry ?? null,
    waterInRequired: false,
    neutral: true,
    ruleSource: null,
  };
  v2.mowing = null;
  if (v2.trends && typeof v2.trends === 'object') {
    delete v2.trends.waterGap;
    delete v2.trends.mowing;
    delete v2.trends.mowingBand;
  }
  if (Array.isArray(v2.insights)) {
    v2.insights = v2.insights.filter((card) => !card || (card.category !== 'water' && card.category !== 'mowing'));
    for (const card of v2.insights) if (card && card.category !== 'customer_concern') scrubKeys(card, INSIGHT_ADVICE_KEYS);
  }
  scrubKeys(v2.snapshot, SNAPSHOT_ADVICE_KEYS);
  scrubKeys(v2.followUp, FOLLOW_UP_ADVICE_KEYS);
  if (advice(v2.smsSummary)) v2.smsSummary = null;
}

/**
 * @param {object} data  the finished buildReportV1Data payload of an ACTIVE new-sod lawn visit
 * @returns {object} the same payload, enforced
 */
function enforceNewSodPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const plan = buildNewSodWeekPlan();
  const banner = buildNewSodBanner();

  data.mowingHeight = null;

  if (Array.isArray(data.applications)) {
    for (const app of data.applications) {
      if (app && app.product && typeof app.product === 'object') {
        if ('irrigation_notes' in app.product) app.product.irrigation_notes = null;
        if ('irrigation_required' in app.product) app.product.irrigation_required = null;
      }
    }
  }

  const la = data.lawnAssessment;
  if (la && typeof la === 'object') {
    if (la.waterContext && typeof la.waterContext === 'object') {
      la.waterContext.weekPlan = plan;
      la.waterContext.irrigationAdvice = null;
      la.waterContext.targetInchesPerWeek = null;
    }
    la.overwateringSignal = false;
    la.droughtStress = null;
  }

  if (data.reportV2 && typeof data.reportV2 === 'object') enforceReportV2(data.reportV2, plan, banner);
  return data;
}

module.exports = { enforceNewSodPayload, NEW_SOD_PAYLOAD_RULES, ADVICE_WORDS, NEW_SOD_COPY };
