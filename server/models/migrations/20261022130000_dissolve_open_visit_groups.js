/**
 * Dissolve the open visit groups (owner ruling 2026-10-22: appointments are no
 * longer grouped; GATE_VISIT_GROUPS stays off, so nothing forms a new one).
 *
 * A group created while the gate was on keeps behaving as a group after the
 * gate goes off (behavior_version is frozen at creation): Fast Complete
 * refuses its members (`grouped_visit`) and the per-row completion answers
 * 409 visit_grouped until the office uses "Separate these services". This is
 * that separation, once, for every group that can still be undone cleanly:
 * each member's visit_id is cleared and the visit is marked dissolved, the
 * same two writes visit-groups.js splitChild makes when the last member
 * leaves, under the same stop lock.
 *
 * Only a group canDissolve() would allow: no visit effect past pending (no
 * grouped reminder or tracker text went out), no en-route or arrived stamp,
 * no completion packet, no service record or invoice on a member, no summary
 * link, no payment. A group that has started is left for the office.
 *
 * Sends nothing: no customer text or email, no tech notice, no date or time
 * moves. Only visit_id changes on scheduled_services, and every trigger on
 * that table fires on date, window or status columns, so none runs. The
 * members keep their own appointment_reminders rows, which arm the ordinary
 * per-appointment reminders. carryVisitReminderState is not needed: a
 * dissolvable visit has no sent or suppressed reminder effect to carry.
 */

const CLOSE_REASON = 'grouping_retired';

// canDissolve() on a locked visit row (visit-groups.js visitActivity), as a
// reason string, or null when the group can be dissolved.
async function startedReason(trx, visit) {
  if (visit.status !== 'open') return 'not_open';
  if (visit.en_route_at || visit.arrived_at) return 'route_started';
  if (visit.summary_token_issued_at) return 'link_issued';
  if (visit.payment_intent_id) return 'payment_attempted';
  if (await trx('visit_effects').where({ visit_id: visit.id }).whereNot('status', 'pending').first('id')) {
    return 'effects_sent';
  }
  if (await trx('visit_completion_packets').where({ visit_id: visit.id }).first('id')) return 'packet_exists';
  const members = () => trx('scheduled_services').where({ visit_id: visit.id }).select('id');
  if (await trx('service_records').whereIn('scheduled_service_id', members()).first('id')) return 'child_artifacts';
  if (await trx('invoices').whereIn('scheduled_service_id', members()).first('id')) return 'child_artifacts';
  return null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_visits'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'visit_id'))) return;

  const open = await knex('service_visits').where({ status: 'open' })
    .orderBy('scheduled_date').select('id', 'stop_base_key');
  let dissolved = 0;
  let detached = 0;
  const left = {};
  for (const { id, stop_base_key: baseKey } of open) {
    try {
      // A savepoint per group: one group that fails is left open and logged,
      // never a failed migration that blocks every deploy.
      const result = await knex.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['visit.stop', baseKey]);
        const visit = await trx('service_visits').where({ id }).forUpdate().first();
        if (!visit) return { left: 'missing' };
        const reason = await startedReason(trx, visit);
        if (reason) return { left: reason };
        const rows = await trx('scheduled_services').where({ visit_id: id }).update({ visit_id: null });
        await trx('service_visits').where({ id }).update({
          status: 'dissolved', close_reason: CLOSE_REASON, closed_at: trx.fn.now(), updated_at: trx.fn.now(),
        });
        return { rows };
      });
      if (result.left) {
        left[result.left] = (left[result.left] || 0) + 1;
      } else {
        dissolved += 1;
        detached += result.rows;
      }
    } catch (err) {
      left.error = (left.error || 0) + 1;
      console.log(`[dissolve-open-visit-groups] visit ${id} left open: ${err.message}`);
    }
  }
  const leftText = Object.entries(left).map(([reason, n]) => `${reason} ${n}`).join(', ') || 'none';
  console.log(`[dissolve-open-visit-groups] dissolved ${dissolved} of ${open.length} open group(s), ${detached} row(s) detached; left open: ${leftText}`);
};

// Not reversible: regrouping is retired (owner ruling 2026-10-22), and the
// rows a dissolved group held are no longer recorded on scheduled_services.
exports.down = async function down() {};
