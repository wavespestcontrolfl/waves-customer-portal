'use strict';

const { gateEnvValue } = require('../config/feature-gates');
const { dateOnlyString } = require('../utils/date-only');
const { findEligibleCustomers, replayWeekPlanForCustomer } = require('./irrigation-weekly-email');
const { loadCurrentWeekPlan, planBindsToService, renderWeekPlanReport } = require('./irrigation-week-plan');

const GUIDES = [
  { label: 'Find your sprinkler timer and its guide', url: 'https://www.wavespestcontrol.com/sprinkler-timers/' },
  { label: 'Rain Bird: how to run your timer by hand', url: 'https://www.wavespestcontrol.com/lawn-care/rain-bird-sprinkler-timer-guide/' },
  { label: 'Overwatering vs. underwatering', url: 'https://www.wavespestcontrol.com/lawn-care/overwatering-lawn-vs-underwatering/' },
  { label: 'Mowing height for your grass type', url: 'https://www.wavespestcontrol.com/lawn-care/mowing-height-by-grass-type/' },
];

function appPlanEnabled() {
  return gateEnvValue('GATE_IRRIGATION_APP_PLAN') && gateEnvValue('GATE_IRRIGATION_WEEK_PLAN');
}

// Reuse the published plan (or a legacy sent email snapshot). Replaying its original weather with CURRENT
// customer inputs is a validity check only: any changed decision is withheld,
// never substituted for the plan the customer already received.
async function loadCustomerWateringPlan(customerId, { now = new Date(), customer = null } = {}) {
  if (!appPlanEnabled()) return null;
  const snapshot = await loadCurrentWeekPlan(customerId, { now, strict: true });
  if (!snapshot?.decisionInputs?.home?.addressLine1) return null;
  const current = customer || (await findEligibleCustomers({ customerId, now, includeApp: true }))[0];
  if (!current || !planBindsToService(snapshot, current)) return null;
  const replay = replayWeekPlanForCustomer(snapshot, current);
  if (!replay) return null;
  const inputs = snapshot.decisionInputs;
  const reportCopy = renderWeekPlanReport(snapshot.plan, { runMinutes: inputs.runMinutes, restriction: snapshot.restriction });
  if (!reportCopy) return null;
  const copy = replay.payload;
  return {
    weekEnding: dateOnlyString(snapshot.weekEnding),
    validThrough: inputs.planWeekEnd,
    sentAt: snapshot.sentAt ? new Date(snapshot.sentAt).toISOString() : null,
    availableAt: new Date(snapshot.availableAt).toISOString(),
    action: snapshot.plan.action,
    conditionalOnForecast: snapshot.plan.conditionalOnForecast === true,
    title: reportCopy.title,
    notificationBody: reportCopy.detail,
    summary: copy.summary_line,
    instruction: copy.week_plan,
    note: copy.plan_note || '',
    restrictionNote: copy.restriction_note || '',
    forecast: copy.forecast_line || '',
    guides: GUIDES,
  };
}

module.exports = { appPlanEnabled, loadCustomerWateringPlan };
