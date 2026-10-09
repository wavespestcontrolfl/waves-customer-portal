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

module.exports = { weekPlanOnCard };
