const { detectServiceLine } = require('./service-report/service-line-configs');

// GATE_LAWN_TS_STOCK_ADVISORY (owner 2026-10-20, "make lawn and tree & shrub work the same as pest"): a lawn or tree &
// shrub visit's completion treats stock as advisory too, by the server's own service line. /complete
// (isStockAdvisoryCompletion), the lawn and tree & shrub sheets' contexts and the full form's plan read this one rule,
// so no screen refuses what the server accepts. Palm, mosquito, termite and rodent keep the hard refusal. Kept out of
// complete-scheduled-service.js so a light route can read it without loading the completion module.
function isLawnTsStockAdvisoryCompletion(svc) {
  return require('../config/feature-gates').lawnTsStockAdvisoryLive() && ['lawn', 'tree_shrub'].includes(detectServiceLine(svc?.service_type));
}

module.exports = { isLawnTsStockAdvisoryCompletion };
