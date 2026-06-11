/**
 * Pest-control "Service Recap" — a lightweight completion path for
 * pest_control services, the recurring/one-time pest visits that were
 * being forced into the heavy CreateProjectModal "project report" flow.
 *
 * What it does (recap-only completion, NO billing):
 *   1. Transitions scheduled_services.status -> 'completed'
 *      (via the canonical transitionJobStatus sole-writer).
 *   2. Writes/updates the service_records row keyed by the direct
 *      scheduled_service_id FK (migration 20260427000007) — same row the
 *      tech photo upload + customer portal service history read from.
 *   3. Writes service_products rows for the chemicals the tech selected.
 *   4. Flips track_state -> 'complete' (customer /track view).
 *   5. Optionally texts the customer the recap message (service_completion
 *      purpose, via the send-customer-message contract).
 *
 * It deliberately does NOT invoice / charge — this mirrors the existing
 * `oneTimeRecapOnly` recap mode of the full completion endpoint
 * (admin-dispatch :serviceId/complete), but as a slim, pest-only path so
 * the giant completion handler and its project-required gate are left
 * untouched. Reachable by admin + tech (the admin-dispatch router runs
 * requireTechOrAdmin, and the tech portal already calls /api/admin/*).
 */
const db = require('../models/db');
const logger = require('./logger');
const { transitionJobStatus } = require('./job-status');
const trackTransitions = require('./track-transitions');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { generateRecap } = require('./completion-recap');
const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
const { etDateString } = require('../utils/datetime-et');

const PEST_CONTROL_CATEGORY = 'pest_control';

// A re-recap on an already-`completed` visit is idempotent: skip the
// status transition but still refresh the record (and re-send if asked).
const COMPLETED_STATUS = 'completed';

// `cancelled`/`skipped` visits are NOT completable. A recap on them must be
// rejected before any artifact is written — otherwise we'd emit a
// "completed" service_records row, mark the tracker complete, and text the
// customer for a visit the status machine says never happened (Codex P1).
const NON_COMPLETABLE_STATUSES = new Set(['cancelled', 'skipped']);

async function loadServiceWithCustomer(serviceId, knex = db) {
  return knex('scheduled_services')
    .where('scheduled_services.id', serviceId)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name',
      'customers.last_name',
      'customers.phone as cust_phone',
    )
    .first();
}

/**
 * Resolve eligibility: the service exists AND its completion profile
 * category is pest_control. The category is services-table backed (the
 * authoritative signal) — not the broad detectServiceCategory fallback.
 */
async function resolveEligibility(serviceId, knex = db) {
  const svc = await loadServiceWithCustomer(serviceId, knex);
  if (!svc) return { ok: false, reason: 'not_found' };
  const profile = await resolveCompletionProfileForScheduledService(svc, knex).catch((err) => {
    logger.warn(`[pest-recap] profile lookup failed for ${serviceId}: ${err.message}`);
    return null;
  });
  const eligible = profile?.category === PEST_CONTROL_CATEGORY;
  return { ok: true, svc, profile, eligible };
}

/** Build the data the recap modal needs: service info, timeline, catalog, prior note. */
async function buildRecapContext(serviceId, knex = db) {
  const { ok, reason, svc, profile, eligible } = await resolveEligibility(serviceId, knex);
  if (!ok) return { ok: false, reason };

  const timeline = await knex('job_status_history')
    .where({ job_id: serviceId })
    .orderBy('transitioned_at', 'asc')
    .select('from_status', 'to_status', 'transitioned_at')
    .catch(() => []);

  const products = await knex('products_catalog')
    .where({ active: true })
    .orderBy('category')
    .orderBy('name')
    .select('id', 'name', 'category', 'active_ingredient', 'moa_group', 'default_rate', 'default_unit')
    .catch(() => []);

  const existingRecord = await knex('service_records')
    .where({ scheduled_service_id: serviceId })
    .orderBy('created_at', 'desc')
    .first('id', 'technician_notes', 'status')
    .catch(() => null);

  // Products already recorded on the existing record, so reopening a recap
  // shows (and preserves) the chemicals already applied instead of starting
  // from an empty selection.
  const existingProducts = existingRecord
    ? await knex('service_products')
      .where({ service_record_id: existingRecord.id })
      .select('product_name', 'product_category', 'active_ingredient', 'moa_group')
      .catch(() => [])
    : [];

  return {
    ok: true,
    eligible,
    service: {
      id: svc.id,
      customerId: svc.customer_id,
      customerName: `${svc.first_name || ''} ${svc.last_name || ''}`.trim() || 'Customer',
      serviceType: svc.service_type,
      status: svc.status,
      scheduledDate: svc.scheduled_date,
      hasPhone: !!svc.cust_phone,
      category: profile?.category || null,
    },
    timeline,
    products,
    existingRecord: existingRecord ? { ...existingRecord, products: existingProducts } : null,
  };
}

/** Draft the customer-facing recap SMS copy via the shared recap generator. */
async function draftRecapMessage({ serviceId, technicianNotes, areasTreated, knex = db }) {
  const { ok, reason, svc, eligible } = await resolveEligibility(serviceId, knex);
  if (!ok) return { ok: false, reason };
  if (!eligible) return { ok: false, reason: 'not_pest_control' };

  const { recap, source } = await generateRecap({
    serviceType: svc.service_type,
    technicianNotes,
    areasTreated,
    visitOutcome: 'completed',
  });
  return { ok: true, recap, source };
}

/**
 * Commit the recap: complete (no bill) + service_records + service_products,
 * track_state complete, optional customer SMS.
 */
async function submitRecap({
  serviceId,
  actorType,
  actorId,
  technicianNotes,
  products = [],
  customerRecap,
  sendSms = false,
  clientPestRating = null,
  knex = db,
}) {
  const { ok, reason, svc, eligible } = await resolveEligibility(serviceId, knex);
  if (!ok) return { ok: false, reason };
  if (!eligible) return { ok: false, reason: 'not_pest_control' };

  // Stale-recap guard: a live job force-rescheduled to a future day
  // (rebooker allowLive) must not be completed by a recap form opened
  // before the reschedule. See track-transitions.isFutureScheduledDate.
  if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
    return { ok: false, reason: 'future_scheduled_date' };
  }

  if (clientPestRating != null
    && (!Number.isInteger(clientPestRating) || clientPestRating < 0 || clientPestRating > 5)) {
    return { ok: false, reason: 'client_pest_rating_invalid' };
  }

  const note = typeof technicianNotes === 'string' ? technicianNotes.trim() : '';
  const recapText = typeof customerRecap === 'string' ? customerRecap.trim() : '';
  const serviceDate = svc.scheduled_date ? String(svc.scheduled_date).split('T')[0] : etDateString();
  // transitionedBy FKs technicians(id) ON DELETE SET NULL — only a tech
  // actor has a valid id; admin operators pass null.
  const transitionedBy = actorType === 'tech' ? (actorId || null) : null;
  // Does this submit ask to text the customer, and can it?
  const wantSms = !!sendSms && !!recapText && !!svc.cust_phone;

  let recordId;
  let createdRecord = false;
  // Whether THIS submit is the one that gets to send the recap text.
  // Decided under the row lock so concurrent submits can't both send.
  let willSendSms = false;
  // Set under the lock if the visit can't be recapped (cancelled/skipped);
  // the transaction aborts having written nothing and we return ok:false.
  let rejectReason = null;
  // Concurrency idempotency (Codex P1): scheduled_service_id has only a
  // non-unique index, so two simultaneous submits (double-tap, browser
  // retry, admin+tech race) could each pass the existing-record lookup
  // and insert duplicate service_records + double-text the customer.
  // We don't reuse service_completion_attempts here because that table is
  // keyed by service_id and shared with the real /complete flow — a recap
  // "succeeded" row would make a later genuine completion 409. Instead we
  // SELECT ... FOR UPDATE the scheduled_services row: concurrent recap
  // submits serialize on that lock, so the loser observes the winner's
  // committed status + record and takes the update (not insert) path. The
  // one-time customer SMS is gated on a recap_sms_sent_at claim taken under
  // that same lock (see below), so a duplicate/concurrent submit never
  // re-texts — while a genuine "completed earlier, text now" still sends.
  await knex.transaction(async (trx) => {
    // 0. Lock the service row — serializes concurrent recap submissions.
    const locked = await trx('scheduled_services')
      .where({ id: serviceId })
      .forUpdate()
      .first('id', 'status', 'scheduled_date');
    // Re-read status under the lock — svc.status was read before the lock
    // and may be stale once a concurrent submit has completed the visit.
    const lockedStatus = locked ? locked.status : svc.status;

    // 0b. Reject a recap on a cancelled/skipped visit before writing any
    //     artifact. Returning here aborts the transaction body with nothing
    //     written (no transition, no record, no products, no SMS).
    if (NON_COMPLETABLE_STATUSES.has(lockedStatus)) {
      rejectReason = `service_${lockedStatus}`;
      return;
    }

    // 0c. Re-check the stale-recap guard under the lock. The pre-lock
    //     check reads scheduled_date before FOR UPDATE — a staff live
    //     reschedule can commit while this submit waits on the lock,
    //     leaving the row pointing at a future visit that this recap
    //     must not complete (TOCTOU; Codex P1).
    if (locked && trackTransitions.isFutureScheduledDate(locked.scheduled_date)) {
      rejectReason = 'future_scheduled_date';
      return;
    }

    // 1. Status -> completed. Skip only when already completed (idempotent
    //    re-recap); any other non-terminal status transitions now.
    if (lockedStatus !== COMPLETED_STATUS) {
      await transitionJobStatus({
        jobId: serviceId,
        fromStatus: lockedStatus,
        toStatus: 'completed',
        transitionedBy,
        trx,
      });
    }

    // 2. Upsert the service_records row keyed by the direct FK. Under the
    // row lock this lookup is race-free — the loser sees the committed row.
    const existing = await trx('service_records')
      .where({ scheduled_service_id: serviceId })
      .orderBy('created_at', 'desc')
      .first('id', 'recap_sms_sent_at');

    // At-most-once recap text: claim recap_sms_sent_at here, inside the
    // lock. If a prior submit already sent (column set), this one skips —
    // so a double-tap/retry/race never re-texts the customer, while a
    // record whose claim is still NULL (e.g. completed earlier via the
    // heavy /complete path) can still send.
    const alreadyTexted = !!existing?.recap_sms_sent_at;
    willSendSms = wantSms && !alreadyTexted;
    const smsClaim = willSendSms ? { recap_sms_sent_at: new Date() } : {};

    if (existing) {
      await trx('service_records').where({ id: existing.id }).update({
        technician_notes: note || null,
        status: 'completed',
        ...(clientPestRating != null ? { client_pest_rating: clientPestRating } : {}),
        ...smsClaim,
        updated_at: new Date(),
      });
      recordId = existing.id;
    } else {
      const inserted = await trx('service_records').insert({
        customer_id: svc.customer_id,
        technician_id: svc.technician_id || null,
        scheduled_service_id: serviceId,
        service_date: serviceDate,
        service_type: svc.service_type || 'Pest Control',
        status: 'completed',
        technician_notes: note || null,
        ...(clientPestRating != null ? { client_pest_rating: clientPestRating } : {}),
        ...smsClaim,
        field_flags: JSON.stringify({ recap: true, recap_source: actorType || 'admin' }),
      }).returning('id');
      recordId = inserted[0]?.id || inserted[0];
      createdRecord = true;
    }

    // 3. service_products for the chemicals the tech selected.
    const productRows = (Array.isArray(products) ? products : [])
      .map((p) => ({
        service_record_id: recordId,
        product_name: String(p.product_name || p.name || '').slice(0, 150),
        product_category: p.product_category || p.category || null,
        active_ingredient: p.active_ingredient || null,
        moa_group: p.moa_group || null,
        notes: p.notes || null,
      }))
      .filter((r) => r.product_name);
    // Replace product rows only when this submit specifies a set, so an
    // explicit re-selection isn't additive. An EMPTY submission must not
    // wipe the recorded applications: reopening a completed recap to
    // re-send (the modal starts with no products selected) would otherwise
    // delete the service's chemical history. Empty = leave existing rows.
    if (productRows.length) {
      await trx('service_products').where({ service_record_id: recordId }).del();
      await trx('service_products').insert(productRows);
    }
  });

  // Cancelled/skipped visit: nothing was written, skip all completion
  // side effects (track-complete, SMS) and report the rejection.
  if (rejectReason) {
    logger.info(`[pest-recap] recap rejected service=${serviceId} reason=${rejectReason}`);
    return { ok: false, reason: rejectReason };
  }

  // 4. Customer-facing track_state -> complete (best-effort, post-trx).
  let trackCompleted = false;
  try {
    const tr = await trackTransitions.markComplete(serviceId, { actorType, actorId });
    trackCompleted = !!tr?.ok;
  } catch (err) {
    logger.warn(`[pest-recap] markComplete failed for ${serviceId}: ${err.message}`);
  }

  // 5. Optional customer recap SMS. Only the submit that won the
  //    recap_sms_sent_at claim under the lock reaches the send — a
  //    concurrent/retried submit has willSendSms=false and is skipped.
  let smsSent = false;
  let smsError = null;
  if (willSendSms) {
    try {
      const msg = await sendCustomerMessage({
        to: svc.cust_phone,
        body: recapText,
        channel: 'sms',
        audience: 'customer',
        purpose: 'service_completion',
        customerId: svc.customer_id,
        identityTrustLevel: 'admin_operator',
        metadata: { original_message_type: 'pest_recap', service_record_id: recordId },
      });
      smsSent = !(msg?.blocked || msg?.sent === false);
      if (!smsSent) smsError = msg?.code || msg?.reason || 'blocked';
    } catch (err) {
      smsError = err.message;
      logger.warn(`[pest-recap] recap SMS failed for ${serviceId}: ${err.message}`);
    }
    if (!smsSent) {
      // Send failed/blocked — release the at-most-once claim so a later
      // retry can re-attempt the text instead of being permanently skipped.
      await knex('service_records')
        .where({ id: recordId })
        .update({ recap_sms_sent_at: null })
        .catch((err) => logger.warn(`[pest-recap] failed to release recap SMS claim for ${serviceId}: ${err.message}`));
    }
  } else if (sendSms && recapText && !svc.cust_phone) {
    smsError = 'no_phone';
  } else if (wantSms) {
    // Wanted to text but the claim was already taken (concurrent double-
    // submit, or a recap that already texted this customer): no-op.
    smsError = 'duplicate_suppressed';
  }

  logger.info(
    `[pest-recap] recap committed service=${serviceId} record=${recordId} `
    + `actor=${actorType} created=${createdRecord} `
    + `products=${Array.isArray(products) ? products.length : 0} `
    + `smsSent=${smsSent}${smsError ? ` smsError=${smsError}` : ''}`,
  );

  return {
    ok: true,
    recordId,
    completed: true,
    created: createdRecord,
    trackCompleted,
    smsSent,
    smsError,
  };
}

module.exports = {
  PEST_CONTROL_CATEGORY,
  resolveEligibility,
  buildRecapContext,
  draftRecapMessage,
  submitRecap,
};
