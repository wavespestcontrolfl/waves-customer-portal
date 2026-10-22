/**
 * Retire the completion comms guard's leftovers (owner 2026-10-21: the
 * "Visit completed with an unanswered customer message" alert is removed).
 * The producer is deleted in the same PR; rows it already wrote would stay
 * open forever, because nothing resolves this type any more:
 *   - dispatch_alerts cards of type completed_with_open_comms (the unresolved
 *     action-queue list returns every row with resolved_at NULL), and
 *   - the matching admin bell rows (notifications).
 * Both are closed, not deleted, so the history stays readable.
 *
 * Bell rows a person already marked Done are claimed by the system too:
 * NotificationService.reopenAdminDone lets a person-owned row come back from
 * "Recently done", and with the producer and closer gone it would then stay
 * open forever. The claim keeps the person's done_at, resolution and read_at
 * (the same COALESCE semantics as doneColumns({ keepExisting: true })) and
 * only takes done_by, which makes the row system-owned and not reopenable.
 *
 * Each table is guarded on its own (hasTable), so a drifted database that
 * lacks one still gets the other cleaned up.
 * down() is a no-op: the producer is gone, so reopening these would only
 * bring back alerts nothing will ever close.
 */

const ALERT_TYPE = 'completed_with_open_comms';
const BELL_TITLE = 'Visit completed with an unanswered customer message';
const RESOLUTION = 'Retired: this alert was removed (owner 2026-10-21)';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('dispatch_alerts')) {
    await knex('dispatch_alerts')
      .where({ type: ALERT_TYPE })
      .whereNull('resolved_at')
      .update({ resolved_at: knex.fn.now() });
  }

  if (await knex.schema.hasTable('notifications')) {
    await knex('notifications')
      .where({ recipient_type: 'admin', title: BELL_TITLE })
      .where((q) => q.whereNull('done_at').orWhereNot('done_by', 'system').orWhereNull('done_by'))
      .update({
        done_at: knex.raw('COALESCE(done_at, now())'),
        done_by: 'system',
        resolution: knex.raw('COALESCE(resolution, ?)', [RESOLUTION]),
        read_at: knex.raw('COALESCE(read_at, now())'),
      });
  }
};

exports.down = async function down() {};
