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

// Does the stored estimate data hold a recurring bahia lawn plan? Reads the stored engine inputs,
// or, for an estimate saved as a request (profile + selected services), the request's grass type.
function estimateHasBahiaLawn(estData) {
  if (!estData || typeof estData !== 'object') return false;
  const { normalizeGrassType } = require('./pricing-engine/service-pricing');
  const inputs = (estData.engineInputs && typeof estData.engineInputs === 'object' ? estData.engineInputs : null)
    || (estData.inputs && typeof estData.inputs === 'object' ? estData.inputs : null);
  if (inputs?.services?.lawn && typeof inputs.services.lawn === 'object') {
    return normalizeGrassType(inputs.services.lawn.track) === 'bahia';
  }
  const request = estData.engineRequest;
  if (!request || typeof request !== 'object') return false;
  const selected = (Array.isArray(request.selectedServices) ? request.selectedServices : []).map((key) => String(key).toUpperCase());
  return selected.includes('LAWN') && normalizeGrassType(request.options?.grassType) === 'bahia';
}

module.exports = { UNISSUED_ESTIMATE, estimateNeverIssued, estimateHasBahiaLawn };
