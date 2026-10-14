/**
 * The Waves Assessment Fast Complete sheet's read of the visit (warm / cold /
 * lost, interests, a soft quote) rides the /complete body as `consultationOutcome`
 * and is recorded INSIDE the completion's transaction, under the visit lock the
 * completion already holds (GATE_ASSESSMENT_FAST_COMPLETE, owner 2026-10-09).
 * One write, so there is no state where the read is saved and the completion is
 * not: a completion refused for a changed visit, or rolled back for any reason,
 * takes the outcome with it.
 *
 * The outcome rules are recordOutcome's own (consultation-outcomes.js); nothing
 * here copies them. The field is accepted only for an assessment visit while the
 * gate is live, so it cannot become a general side door into that table.
 */
const { assessmentFastCompleteLive } = require('../config/feature-gates');
const { ASSESSMENT_SERVICE_KEY } = require('./assessment-booking');

const REFUSED = 'consultation_outcome_refused';
// The outcome fields a caller may pass through; anything else in the object is ignored.
const FIELDS = ['outcome', 'lostReason', 'interests', 'quotedAmount', 'quotedCadence', 'quoteNotes', 'followUpAt'];

// A 4xx payload before any write when the field is not allowed here, else null.
function consultationOutcomeBlockPayload({ consultationOutcome, completionProfile, visitOutcome } = {}) {
  if (consultationOutcome == null) return null;
  if (typeof consultationOutcome !== 'object' || Array.isArray(consultationOutcome)) {
    return { status: 400, body: { error: 'consultationOutcome must be an object', code: 'consultation_outcome_invalid' } };
  }
  if (!assessmentFastCompleteLive() || completionProfile?.serviceKey !== ASSESSMENT_SERVICE_KEY || visitOutcome !== 'completed') {
    return {
      status: 422,
      body: {
        error: 'A consultation outcome can only be recorded with the completion of a Waves Assessment visit.',
        code: 'consultation_outcome_not_allowed',
      },
    };
  }
  return null;
}

// Records the outcome on the completion's transaction. A consultation that
// already converted (won) keeps its read and the completion goes on, as the
// sheet does when it sees a won row. Any other refusal aborts the completion,
// and the error carries the outcome rule's own status and code.
async function recordConsultationOutcomeInCompletion({ trx, serviceId, consultationOutcome, actor }) {
  if (consultationOutcome == null) return null;
  const { recordOutcome } = require('./consultation-outcomes');
  const params = Object.fromEntries(FIELDS.filter((key) => key in consultationOutcome).map((key) => [key, consultationOutcome[key]]));
  try {
    return await recordOutcome({
      ...params,
      scheduledServiceId: serviceId,
      recordedBy: actor?.technician?.name || actor?.technicianId || null,
      actingTechnicianId: actor?.technicianId || null,
      actingIsAdmin: actor?.techRole === 'admin',
    }, { trx, duringCompletion: true });
  } catch (err) {
    if (err?.code === 'ALREADY_WON') return null;
    if (err?.isOperational && err.statusCode) {
      throw Object.assign(new Error(err.message), { code: REFUSED, statusCode: err.statusCode, outcomeCode: err.code });
    }
    throw err;
  }
}

// The HTTP answer for an error thrown by the call above, else null.
function consultationOutcomeRefusalResponse(err) {
  if (err?.code !== REFUSED) return null;
  return { status: err.statusCode, body: { error: err.message, code: err.outcomeCode } };
}

module.exports = {
  consultationOutcomeBlockPayload,
  recordConsultationOutcomeInCompletion,
  consultationOutcomeRefusalResponse,
};
