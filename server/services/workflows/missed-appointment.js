const db = require('../../models/db');
const logger = require('../logger');

// The occurrence fields a caller's snapshot supplies (customer_id stays the live row's).
const OCCURRENCE_FIELDS = ['scheduled_date', 'window_start', 'window_end', 'service_type', 'service_id', 'property_id'];
function pickOccurrence(row) {
  const out = {};
  for (const f of OCCURRENCE_FIELDS) if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
  return out;
}

const STALE_CANDIDATE = Symbol('stale_candidate');
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));
// The nightly check's candidate, re-read under the visit lock: still open, same slot?
function stillScannedCandidate(current, scanned) {
  return ['pending', 'confirmed'].includes(current.status)
    && dateOnly(current.scheduled_date) === dateOnly(scanned.scheduled_date)
    && (current.window_start || null) === (scanned.window_start || null)
    && (current.window_end || null) === (scanned.window_end || null);
}

class MissedAppointment {
  /**
   * Handle a skipped/missed appointment. First skip is handled by reschedule
   * system. 2+ skips in 90 days surfaces a recommended outreach task — no
   * SMS is sent automatically; the team reviews and sends manually.
   */
  // `conn`: an optional open transaction / connection to run on (default: the shared pool), so a caller that
  // already holds a connection (the street-level hold guard) never waits on a second pool checkout.
  // `occurrence`: the row as the caller saw it when it marked the miss (dispatch's
  // no-show transition). Its slot and scope are what the log freezes — a fresh read
  // here could capture an edit committed after the transition (Codex #5669 r1).
  // `scanned`: the nightly check's candidate as its scan read it. The check calls
  // this under the visit's row lock (runUnlessLiveHold); a visit completed, cancelled
  // or moved since the scan is no longer a candidate, and nothing is logged
  // ({ action: 'stale_candidate' }).
  async onSkip(scheduledServiceId, reason = 'no_show', conn = db, { occurrence = null, scanned = null } = {}) {
    // A dispatch-marked no-show is recorded AFTER its status change committed, so a
    // rebook or a completion can land in between. Its log row and card are written
    // in one transaction that holds the visit's row lock and rechecks the occurrence
    // (logSkip). The nightly check stays lock-free on the caller's connection.
    if (reason === 'manual_no_show' && conn === db) {
      // The outreach evaluation runs in the same transaction (a savepoint, so its
      // failure never loses the row): its task commits with the confirmed row, and
      // a later "Not a miss" always finds it to withdraw.
      return db.transaction(async (t) => {
        const logged = await this.logSkip(scheduledServiceId, reason, t, { occurrence, lockVisit: true });
        if (!logged) return null;
        try {
          return await t.transaction((sp) => this.evaluateThreshold(logged.customerId, reason, sp, { logId: logged.logId }));
        } catch (err) {
          logger.warn(`MissedAppointment: outreach evaluation failed for ${scheduledServiceId}: ${err.message}`);
          return null;
        }
      });
    }
    const logged = await this.logSkip(scheduledServiceId, reason, conn, { occurrence, scanned });
    if (logged === STALE_CANDIDATE) return { action: 'stale_candidate' };
    if (!logged) return null;
    const { customerId, logId } = logged;
    // With the office queue on, the nightly check's row is only "still open at
    // 6 PM", not a miss: the repeated-miss outreach waits for a person to confirm
    // it (not-closed-out.js confirmMiss evaluates then).
    if (reason !== 'manual_no_show' && require('../not-closed-out').queueEnabled()) {
      return { action: 'awaiting_confirmation' };
    }
    return this.evaluateThreshold(customerId, reason, conn, { logId });
  }

  // Write the flagged row (and raise its card). Returns { customerId, logId }, null
  // when the visit or its customer is gone, or STALE_CANDIDATE (nothing written).
  // The row's id goes on the outreach task it may raise (withdrawOutreachFor).
  async logSkip(scheduledServiceId, reason, conn, { occurrence = null, lockVisit = false, scanned = null } = {}) {
    const currentQuery = conn('scheduled_services').where({ id: scheduledServiceId });
    if (lockVisit) currentQuery.forUpdate();
    const current = await currentQuery.first();
    const service = current && occurrence && String(occurrence.id) === String(scheduledServiceId)
      ? { ...current, ...pickOccurrence(occurrence) }
      : current;

    if (!service) {
      logger.error(`MissedAppointment: scheduled service ${scheduledServiceId} not found`);
      return null;
    }

    if (scanned && !stillScannedCandidate(current, scanned)) return STALE_CANDIDATE;

    const customerId = service.customer_id;
    const customer = await conn('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // original_date + original_window = the slot that was missed. Together
    // with the service id they are the OCCURRENCE key: the same
    // scheduled_services row can be missed more than once (soft Quick Move
    // no-show rebooks it in place — possibly later the SAME day), so dedupe
    // checks and the 90-day count discriminate by (service, slot date, slot
    // window), never by service row alone (codex r1+r2 on #3110).
    // A person marking the no-show in dispatch is a confirmed miss from the start;
    // the nightly check only knows the visit was still open (not-closed-out.js).
    const personMarked = reason === 'manual_no_show';
    const notClosedOut = require('../not-closed-out');
    const originalWindow = service.window_start ? `${service.window_start}-${service.window_end}` : null;
    // Under the visit lock: is the visit still the no-show occurrence being logged?
    // If it was rebooked or closed in between, the miss still counts (the row is
    // written) but it is already settled — no open confirmed miss, no card.
    const movedOn = lockVisit && !notClosedOut.isSameNoShowOccurrence(current, { date: service.scheduled_date, window: originalWindow });
    const inserted = await conn('reschedule_log').insert({
      customer_id: customerId,
      scheduled_service_id: scheduledServiceId,
      reason_code: 'customer_noshow',
      initiated_by: 'system',
      ...(personMarked ? { miss_confirmed_at: new Date(), miss_confirmed_by: 'dispatch' } : {}),
      ...(movedOn ? { resolved_at: new Date(), resolution: notClosedOut.RESOLUTION_BY_STATUS[current.status] || 'rebooked', resolved_by: 'system' } : {}),
      original_date: service.scheduled_date || null,
      original_window: originalWindow,
      // what was missed and where, frozen now: the row's own fields can change later
      occurrence_service_type: service.service_type || null,
      occurrence_service_id: service.service_id || null,
      occurrence_property_id: service.property_id || null,
      notes: reason || 'skip',
    }).returning('id');
    // The office's card for this flagged visit (gated; never blocks the log).
    const logId = Array.isArray(inserted) && inserted[0] ? (inserted[0].id || inserted[0]) : null;
    if (logId && !movedOn) {
      await notClosedOut.raiseCard({
        logId, service: { ...service, id: scheduledServiceId }, confirmed: personMarked, trx: conn === db ? null : conn,
      });
    }

    return { customerId, logId };
  }

  /**
   * Count distinct missed occurrences in the last 90 days and park the
   * outreach recommendation at 2+. Split from onSkip so a writer that
   * already logged the occurrence itself — the soft Quick Move no-show logs
   * customer_noshow through the rebooker — can run the threshold without
   * inserting the occurrence a second time (codex r2 on #3110).
   */
  // The customer's distinct missed occurrences in the last 90 days (see evaluateThreshold).
  async countMisses(customerId, conn = db) {
    const personMarkedOnly = require('../not-closed-out').queueEnabled();
    const skipCount = await conn('reschedule_log')
      .where({ customer_id: customerId, reason_code: 'customer_noshow' })
      .where('created_at', '>', conn.raw("NOW() - INTERVAL '90 days'"))
      .where(function personMarked() {
        if (personMarkedOnly) this.whereNotNull('miss_confirmed_at').orWhereNotNull('new_date');
      })
      .select(conn.raw("count(distinct (scheduled_service_id, coalesce(original_date, '1970-01-01'::date), coalesce(original_window, ''))) as count"))
      .first();
    return parseInt(skipCount.count, 10);
  }

  // `logId`: the flagged row whose confirmation triggered this evaluation, kept on
  // the task for the record.
  async evaluateThreshold(customerId, reason = 'no_show', conn = db, { logId = null } = {}) {
    const customer = await conn('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // Count distinct missed OCCURRENCES, not rows: a nightly-sweep flag and
    // a soft Quick Move of the same miss both log customer_noshow for the
    // same (service, slot) key and must count once, while a soft-moved
    // visit missed AGAIN — even later the same day — is a new occurrence
    // because the window differs. Legacy rows with NULL slot fields
    // collapse per-service, matching the old per-row behavior closely
    // enough for the 90-day window.
    // With the office queue on, only person-marked misses count: a row a person
    // confirmed (card or dispatch no-show) or a no-show Quick Move (a person moved
    // it: new_date is set). The nightly check's unconfirmed rows do not.
    const totalSkips = await this.countMisses(customerId, conn);

    if (totalSkips <= 1) {
      logger.info(`First skip for customer ${customerId} — handled by reschedule system`);
      return { action: 'reschedule_system', skips: totalSkips };
    }

    logger.warn(`Customer ${customerId} has ${totalSkips} skips in 90 days — creating recommendation`);

    const suggestedSms =
      `Hi ${String(customer.first_name || "").trim() || "there"}, we've noticed we've missed you a few times recently. ` +
      `We want to make sure your home stays protected. ` +
      `Can we find a better day/time that works for you? ` +
      `Reply with your preferred day or call us. - Waves Pest Control`;

    await conn('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'task',
      channel: 'internal',
      subject: `Recommended outreach: ${totalSkips} missed appointments in 90 days`,
      body:
        `Customer has skipped ${totalSkips} times in 90 days. Last reason: ${reason}. ` +
        `Recommend a phone call or reviewing/sending the SMS below.\n\n` +
        `Suggested SMS:\n${suggestedSms}`,
      status: 'pending',
      metadata: JSON.stringify({ source: 'missed_appointment_threshold', ...(logId ? { log_id: String(logId) } : {}) }),
    });

    return { action: 'recommendation_created', skips: totalSkips };
  }

  /**
   * A person withdrew a confirmed miss ("Not a miss" after "This was a miss"). The
   * customer's misses are counted again; below the threshold, every still-pending
   * outreach task this workflow raised for the customer is cancelled, with the
   * reason on it — whichever of the customer's misses the task was raised from.
   * Runs in the dismissal's transaction (after the confirmation is cleared), in a
   * savepoint, and never fails it.
   */
  async withdrawOutreachIfBelowThreshold(customerId, trx) {
    if (!customerId || !trx) return { withdrawn: 0 };
    try {
      const withdrawn = await trx.transaction(async (sp) => {
        if ((await this.countMisses(customerId, sp)) >= 2) return 0;
        return sp('customer_interactions')
          .where({ customer_id: customerId, interaction_type: 'task', status: 'pending' })
          .whereRaw("metadata->>'source' = 'missed_appointment_threshold'")
          .update({
            status: 'cancelled',
            body: sp.raw("concat('Withdrawn: the office marked a visit as not a miss; fewer than 2 misses remain.', E'\\n\\n', body)"),
          });
      });
      return { withdrawn: Number(withdrawn) || 0 };
    } catch (err) {
      logger.warn(`MissedAppointment: outreach task for customer ${customerId} not withdrawn: ${err.message}`);
      return { withdrawn: 0 };
    }
  }
}

module.exports = new MissedAppointment();
