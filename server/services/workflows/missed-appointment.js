const db = require('../../models/db');
const logger = require('../logger');

// The occurrence fields a caller's snapshot supplies (customer_id stays the live row's).
const OCCURRENCE_FIELDS = ['scheduled_date', 'window_start', 'window_end', 'service_type', 'service_id', 'property_id'];
function pickOccurrence(row) {
  const out = {};
  for (const f of OCCURRENCE_FIELDS) if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
  return out;
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
  async onSkip(scheduledServiceId, reason = 'no_show', conn = db, { occurrence = null } = {}) {
    // A dispatch-marked no-show is recorded AFTER its status change committed, so a
    // rebook or a completion can land in between. Its log row and card are written
    // in one transaction that holds the visit's row lock and rechecks the occurrence
    // (logSkip). The nightly check stays lock-free on the caller's connection.
    if (reason === 'manual_no_show' && conn === db) {
      const customerId = await db.transaction((t) => this.logSkip(scheduledServiceId, reason, t, { occurrence, lockVisit: true }));
      return customerId ? this.evaluateThreshold(customerId, reason, db) : null;
    }
    const customerId = await this.logSkip(scheduledServiceId, reason, conn, { occurrence });
    return customerId ? this.evaluateThreshold(customerId, reason, conn) : null;
  }

  // Write the flagged row (and raise its card). Returns the customer id, or null
  // when the visit or its customer is gone.
  async logSkip(scheduledServiceId, reason, conn, { occurrence = null, lockVisit = false } = {}) {
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

    return customerId;
  }

  /**
   * Count distinct missed occurrences in the last 90 days and park the
   * outreach recommendation at 2+. Split from onSkip so a writer that
   * already logged the occurrence itself — the soft Quick Move no-show logs
   * customer_noshow through the rebooker — can run the threshold without
   * inserting the occurrence a second time (codex r2 on #3110).
   */
  async evaluateThreshold(customerId, reason = 'no_show', conn = db) {
    const customer = await conn('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // Count distinct missed OCCURRENCES, not rows: a nightly-sweep flag and
    // a soft Quick Move of the same miss both log customer_noshow for the
    // same (service, slot) key and must count once, while a soft-moved
    // visit missed AGAIN — even later the same day — is a new occurrence
    // because the window differs. Legacy rows with NULL slot fields
    // collapse per-service, matching the old per-row behavior closely
    // enough for the 90-day window.
    const skipCount = await conn('reschedule_log')
      .where({ customer_id: customerId, reason_code: 'customer_noshow' })
      .where('created_at', '>', conn.raw("NOW() - INTERVAL '90 days'"))
      .select(conn.raw("count(distinct (scheduled_service_id, coalesce(original_date, '1970-01-01'::date), coalesce(original_window, ''))) as count"))
      .first();

    const totalSkips = parseInt(skipCount.count, 10);

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
    });

    return { action: 'recommendation_created', skips: totalSkips };
  }
}

module.exports = new MissedAppointment();
