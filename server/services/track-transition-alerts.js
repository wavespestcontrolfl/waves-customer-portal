const logger = require('./logger');

async function recordTrackTransitionFailure({ jobId, action, actorId, error }) {
  if (!jobId || !action) return;
  try {
    const { createAlert } = require('./dispatch-alerts');
    await createAlert({
      type: 'track_transition_failed',
      severity: 'critical',
      jobId,
      payload: {
        action,
        actor_id: actorId || null,
        error: error?.message || String(error || 'Unknown error'),
        occurred_at: new Date().toISOString(),
      },
    });
  } catch (alertErr) {
    logger.error(`[track-transition-alerts] failed to create alert for ${jobId}: ${alertErr.message}`);
  }
}

module.exports = { recordTrackTransitionFailure };
