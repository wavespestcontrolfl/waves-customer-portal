const logger = require('./logger');

// cancelFence (the Intelligence Bar cancel recovery sweep only): the alert is written in the same transaction that proves the
// visit is still the cancelled one the card approved (a restore since means the failure is not worth an alert on a live visit).
async function recordTrackTransitionFailure({ jobId, action, actorId, error, cancelFence = null }) {
  if (!jobId || !action) return;
  try {
    const { createAlert } = require('./dispatch-alerts');
    const alert = {
      type: 'track_transition_failed',
      severity: 'critical',
      jobId,
      payload: {
        action,
        actor_id: actorId || null,
        error: error?.message || String(error || 'Unknown error'),
        occurred_at: new Date().toISOString(),
      },
    };
    if (!cancelFence) {
      await createAlert(alert);
      return;
    }
    const db = require('../models/db');
    await db.transaction(async (trx) => {
      await require('./cancel-generation-fence').assertCancelGeneration(trx, cancelFence);
      await createAlert({ ...alert, trx });
    });
  } catch (alertErr) {
    if (alertErr && alertErr.code === 'CANCEL_FENCE') return;
    logger.error(`[track-transition-alerts] failed to create alert for ${jobId}: ${alertErr.message}`);
  }
}

async function recordTrackTransitionResultFailure({ jobId, action, actorId, result, cancelFence = null }) {
  if (!result || result.ok !== false) return false;
  await recordTrackTransitionFailure({
    jobId,
    action,
    actorId,
    error: new Error(result.reason || 'track transition returned ok=false'),
    cancelFence,
  });
  return true;
}

module.exports = {
  recordTrackTransitionFailure,
  recordTrackTransitionResultFailure,
};
