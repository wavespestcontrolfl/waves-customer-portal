'use strict';

// The model lanes of the blog fact check the Mac job runs: the editorial review
// (content/editorial-review.js) and the publish-time fact check (content/fact-check-gate.js).
// The owner's spend line (2026-11-19, "A"): on the Mac job each is answered by the Max plan
// (~/max-runner answers api.anthropic.com). Any other provider would bill a paid API, so the
// fallback chain (llm/call.js runFallbackChain) keeps only the Anthropic route for these lanes
// there; a Claude outage then fails the call, and the draft waits.
const MAC_MODEL_LANES = Object.freeze(['editorial_review', 'editorial_repair', 'editorial_plan_review', 'fact_check_gate']);

// The Mac job (CONTENT_EDITORIAL_REVIEW_RUNNER=mac, strict) calling one of those lanes.
function anthropicOnlyLane(laneId, env = process.env) {
  return env.CONTENT_EDITORIAL_REVIEW_RUNNER === 'mac' && MAC_MODEL_LANES.includes(laneId);
}

module.exports = { MAC_MODEL_LANES, anthropicOnlyLane };
