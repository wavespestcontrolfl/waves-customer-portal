// Owner 2026-10-20 ("make lawn and tree & shrub work the same as pest") made stock advisory on lawn, pest and tree & shrub
// visits; owner 2026-11-26 ("EVERYTHING SHOULD ONLY BE WARNED, NEVER BLOCKED FROM USING, FOR NOW") made it advisory on EVERY visit
// type, palm, mosquito, termite and rodent included. /complete takes stock below zero and alerts the office on any visit, so every
// server source of the `stockAdvisory` flag the tech sheets and the full form read (the pest, lawn, lawn re-service and tree & shrub
// contexts and the treatment plan) answers true here, and no client stock hold fires. Kept out of complete-scheduled-service.js so a
// light route can read it without loading the completion module. `svc` is accepted so each caller still asks the one classifier.
 
function isLawnTsStockAdvisoryCompletion(svc) {
  return true;
}

module.exports = { isLawnTsStockAdvisoryCompletion };
