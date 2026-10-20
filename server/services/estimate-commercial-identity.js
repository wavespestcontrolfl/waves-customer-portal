'use strict';

// Auto-priced commercial lawn/tree estimates are approval-only: no bookable
// slot, no booking deposit/card, and no auto-scheduling — the team confirms
// scope on-site, schedules, and invoices. They CAN prepay the year at the
// standard 5% discount (there is no WaveGuard setup fee on commercial). Mirrors
// estimate-slots-public's isCommercialAutoEstimate — keep both in sync.
function isCommercialAutoAcceptEstimate(estimate = {}) {
  let data = estimate.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
  data = data || {};
  if (data.commercialEstimatedPricing === true) return true;
  const isCommercialSvc = (s) => {
    const k = String(s?.service || s?.serviceKey || s?.name || '').toLowerCase();
    return k.includes('commercial_lawn') || k.includes('commercial_tree') || k.includes('commercial_pest') || k.includes('commercial_mosquito') || k.includes('commercial_termite') || k.includes('commercial_rodent');
  };
  const lineItems = Array.isArray(data.engineResult?.lineItems) ? data.engineResult.lineItems : [];
  if (lineItems.some((li) => li && li.estimatedPricing === true && isCommercialSvc(li) && Number(li.annual) > 0)) return true;
  const recurringRows = [
    ...(Array.isArray(data.result?.recurring?.services) ? data.result.recurring.services : []),
    ...(Array.isArray(data.recurring?.services) ? data.recurring.services : []),
  ];
  return recurringRows.some(isCommercialSvc);
}

module.exports = { isCommercialAutoAcceptEstimate };
