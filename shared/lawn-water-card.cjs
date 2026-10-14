'use strict';

/**
 * The one rule for "a weekly plan is on the Water This Week card". A weekly plan on the card is the sole watering
 * instruction, so the card prints no status explanation beside it (client: LawnReportV2.jsx explanationPrinted), and
 * Ask Waves must not be handed a rain-card explanation the page hides (server: report-ask-ai.js lawnWaterFacts).
 * Both read this function, so the two cannot drift. The client imports it through the '@lawn-water-card' alias.
 */
function weekPlanOnCard(water) {
  return !!(water && water.weekPlan && water.weekPlan.title);
}

/**
 * The one rule for "the card prints the Florida rain shutoff sentence" (GATE_LAWN_WATER_RAIN, advisor A.4): the server set
 * water.rainSensorLine, and the card is in the rain-covered state. It prints beside a weekly plan too, so it does not
 * depend on weekPlanOnCard. The client (LawnReportV2.jsx WaterRainSensorLine) and Ask Waves (report-ask-ai.js
 * lawnWaterFacts) both read this function, so a sentence on the page is always in the Ask facts and the reverse.
 */
function rainSensorLineOnCard(water) {
  return !!(water && water.rainSensorLine === true && water.status === 'rain_covered');
}

module.exports = { weekPlanOnCard, rainSensorLineOnCard };
