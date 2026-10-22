/**
 * Retire the completion comms guard's leftovers (owner 2026-10-21: the
 * "Visit completed with an unanswered customer message" alert is removed).
 * The producer is deleted in the same PR; rows it already wrote would stay
 * open forever, because nothing resolves this type any more:
 *   - dispatch_alerts cards of type completed_with_open_comms (the unresolved
 *     action-queue list returns every row with resolved_at NULL), and
 *   - the matching admin bell rows (notifications, done_at NULL).
 * Both are closed, not deleted, so the history stays readable.
 * down() is a no-op: the producer is gone, so reopening them would only
 * bring back alerts nothing will ever close.
 */

const ALERT_TYPE = 'completed_with_open_comms';
const BELL_TITLE = 'Visit completed with an unanswered customer message';

exports.up = async function up(knex) {
  await knex('dispatch_alerts')
    .where({ type: ALERT_TYPE })
    .whereNull('resolved_at')
    .update({ resolved_at: knex.fn.now() });

  await knex('notifications')
    .where({ recipient_type: 'admin', title: BELL_TITLE })
    .whereNull('done_at')
    .update({
      done_at: knex.fn.now(),
      done_by: 'system',
      resolution: 'Retired: this alert was removed (owner 2026-10-21)',
      read_at: knex.raw('COALESCE(read_at, now())'),
    });
};

exports.down = async function down() {};
