/**
 * GATE_LAWN_V13 bahia review: which estimates it applies to.
 *
 * The v13 program has no bahia track, so a NEW recurring bahia lawn plan parks for review
 * (priceLawnCare, reason lawn_v13_bahia_no_program). An estimate that was already issued keeps
 * its price when it is replayed as sold (savedEstimateReplay). An estimate that was never
 * issued (a draft, a scheduled send, a send in its first attempt) is not sold: it gets the
 * review on the send snapshot and at the send guard, even when it was saved before the gate
 * went live.
 *
 * "Issued" is the repo's own proof of publication: sent_at or viewed_at (status alone is not
 * proof, the expiry sweep flips drafts to expired too).
 */
const NOT_YET_ISSUED_STATUSES = new Set(['draft', 'scheduled', 'sending', 'send_failed']);

// A symbol key rides a shallow copy of the parsed estimate data, never reaches JSON, and is
// never a client-controlled field.
const UNISSUED_ESTIMATE = Symbol.for('waves.estimate.neverIssued');

// True only when the row is KNOWN never to have been issued. A partial object that carries
// neither column (a test fixture, a narrow select) cannot be told apart, so it reads as issued.
function estimateNeverIssued(estimate) {
  if (!estimate || typeof estimate !== 'object') return false;
  if (!('sent_at' in estimate) && !('viewed_at' in estimate)) return false;
  if (estimate.sent_at || estimate.viewed_at) return false;
  return NOT_YET_ISSUED_STATUSES.has(String(estimate.status || 'draft'));
}

// Does the stored estimate data hold a recurring bahia lawn plan, in ANY shape the send path and
// the pricing bundle accept?
//   - engine inputs   { services: { lawn: { track } } }          (engineInputs, inputs, engineInput)
//   - V1 form inputs  { svcLawn: true, grassType }               (inputs, result.inputs, IB drafts)
//   - a saved request { engineRequest: { selectedServices, options.grassType } }
//   - stored results  result.results.lawnMeta, engineResult.lineItems, recurring.services lawn rows
const isBahia = (value) => {
  if (value == null || value === '') return false;
  const { normalizeGrassType } = require('./pricing-engine/service-pricing');
  return normalizeGrassType(value) === 'bahia';
};
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const looksLikeLawnRow = (row) => isObject(row)
  && /lawn/i.test(`${row.service || ''} ${row.serviceKey || ''} ${row.name || ''}`)
  && !/one.?time/i.test(`${row.service || ''} ${row.serviceKey || ''}`);

function inputCarrierHasBahiaLawn(carrier) {
  if (!isObject(carrier)) return false;
  if (isObject(carrier.services?.lawn)) return isBahia(carrier.services.lawn.track);
  if (carrier.svcLawn === true) {
    return [carrier.grassType, carrier.grass_type, carrier.lawnTrack, carrier.track].some(isBahia);
  }
  return false;
}

function resultHasBahiaLawn(result) {
  if (!isObject(result)) return false;
  const meta = result.results?.lawnMeta || result.lawnMeta;
  if (isObject(meta) && [meta.grassType, meta.grassName, meta.track].some(isBahia)) return true;
  const rows = [
    ...(Array.isArray(result.lineItems) ? result.lineItems : []),
    ...(Array.isArray(result.recurring?.services) ? result.recurring.services : []),
    ...(Array.isArray(result.results?.recurring?.services) ? result.results.recurring.services : []),
  ];
  return rows.some((row) => looksLikeLawnRow(row) && [row.track, row.grassType, row.grassName, row.grass].some(isBahia));
}

function estimateHasBahiaLawn(estData) {
  if (!isObject(estData)) return false;
  if ([estData.engineInputs, estData.inputs, estData.engineInput, estData.result?.inputs].some(inputCarrierHasBahiaLawn)) return true;
  const request = estData.engineRequest;
  if (isObject(request)) {
    const selected = (Array.isArray(request.selectedServices) ? request.selectedServices : []).map((key) => String(key).toUpperCase());
    if (selected.includes('LAWN') && isBahia(request.options?.grassType)) return true;
  }
  return [estData.result, estData.engineResult, estData.result?.engineResult].some(resultHasBahiaLawn);
}

module.exports = { UNISSUED_ESTIMATE, estimateNeverIssued, estimateHasBahiaLawn };
