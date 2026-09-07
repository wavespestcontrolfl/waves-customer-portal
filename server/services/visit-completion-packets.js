'use strict';

/**
 * The durable grouped closeout and effect coordinator (stages 3–5).
 * The recovery worker resumes saved packets; the gated production submission
 * entry point and technician screen are connected in the next stage.
 *
 * The existing stop lock serializes membership, legacy claims and packets.
 * Every member uses the canonical completion validator/writer on one outer
 * transaction. A rejected member rolls back the packet and ALL member writes.
 */
const crypto = require('crypto');
const { validate: isUuid } = require('uuid');
const db = require('../models/db');
const { hashCompletionRequest } = require('./completion-attempts');
const { dateOnly, lockStop, stopBaseKey } = require('./visit-groups');
const { cleanupUploadedServicePhotoObjects } = require('./service-photos');

function failure(status, code, error) {
  return { status, body: { code, error } };
}

function packetRequest({ visitId, idempotencyKey, items }) {
  if (!isUuid(visitId) || typeof idempotencyKey !== 'string'
      || !idempotencyKey.trim() || idempotencyKey.length > 120) {
    return { error: failure(400, 'visit_closeout_invalid', 'A visit and an idempotency key are required.') };
  }
  if (!Array.isArray(items) || items.length < 2 || items.some((item) => (
    !isUuid(item?.serviceId) || !item.body || typeof item.body !== 'object' || Array.isArray(item.body)
  )) || new Set(items.map((item) => item.serviceId)).size !== items.length) {
    return { error: failure(400, 'visit_closeout_members_invalid', 'Submit each visit service once with its completion form.') };
  }
  // Canonical completion normalizes some form fields in place. Keep the
  // submitted snapshot immutable, and use its existing semantic hash rules
  // so a ticking panel timer does not invalidate a retry of the same packet.
  const ordered = structuredClone(items).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    visitId, items: ordered.map((item) => ({ serviceId: item.serviceId, hash: hashCompletionRequest(item.body) })),
  })).digest('hex');
  return { visitId, key: idempotencyKey.trim(), items: ordered, hash };
}

function recordsResult(packet, items, billing, replayed = false) {
  return { status: 202, body: {
    visitId: packet.visit_id, packetId: packet.id, state: 'records_saved', replayed, billing,
    items: items.map((item) => ({ serviceId: item.scheduled_service_id, serviceRecordId: item.service_record_id })),
  } };
}

/** Authenticated actor is supplied by the caller, separately from the forms. */
async function saveVisitCompletionPacket(input, database = db) {
  const request = packetRequest(input);
  if (request.error) return request.error;
  const uploadedPhotoRows = [];
  let readyToCommit = false;
  try {
    return await database.transaction(async (trx) => {
      const peek = await trx('service_visits').where({ id: request.visitId }).first();
      if (!peek) return failure(404, 'visit_not_found', 'Visit not found.');
      // Same mint identities/order as invoice creation. The member comparison
      // below refuses a stale submitted set after the stop lock is acquired.
      const { acquireScheduledInvoiceMintLock } = require('./scheduled-invoice-mint');
      for (const item of request.items) await acquireScheduledInvoiceMintLock(trx, item.serviceId);
      // Same customer -> stop -> visit/member order as grouping. Customer
      // identity and assignment cannot change while the records are written.
      await trx('customers').where({ id: peek.customer_id }).forNoKeyUpdate().first('id');
      await lockStop(trx, peek.stop_base_key);
      const visit = await trx('service_visits').where({ id: peek.id }).forUpdate().first();
      if (!visit || visit.stop_base_key !== peek.stop_base_key || visit.customer_id !== peek.customer_id) {
        return failure(409, 'visit_changed', 'The visit moved. Refresh before closing it.');
      }
      const members = await trx('scheduled_services').where({ visit_id: visit.id }).orderBy('id').forUpdate();
      const { completeScheduledService, completionOwnershipError } = require('./complete-scheduled-service');
      const ownership = members.map((member) => completionOwnershipError({
        role: input.actor?.techRole, actorTechnicianId: input.actor?.technicianId,
        assignedTechnicianId: member.technician_id,
      })).find(Boolean);
      if (ownership) return { status: ownership.status, body: ownership.payload };
      if (members.length !== request.items.length
          || members.some((member, index) => member.id !== request.items[index].serviceId)) {
        return failure(409, 'visit_members_changed', 'The visit service list changed. Refresh all service forms.');
      }
      if (members.some((member) => member.customer_id !== visit.customer_id
          || (member.property_id || null) !== (visit.property_id || null)
          || dateOnly(member.scheduled_date) !== dateOnly(visit.scheduled_date)
          || member.technician_id !== visit.technician_id
          || stopBaseKey({ propertyId: member.property_id, customerId: member.customer_id, scheduledDate: member.scheduled_date }) !== visit.stop_base_key)) {
        return failure(409, 'visit_members_incompatible', 'These services no longer share one property, date and technician.');
      }
      const existing = await trx('visit_completion_packets').where({ visit_id: visit.id }).first();
      if (existing) {
        if (existing.idempotency_key !== request.key || existing.request_hash !== request.hash) {
          return failure(409, 'visit_closeout_payload_mismatch', 'A saved closeout already owns this visit. Resume that closeout.');
        }
        const saved = await trx('visit_completion_packet_items').where({ packet_id: existing.id }).orderBy('scheduled_service_id');
        if (saved.length !== members.length || saved.some((item) => !item.service_record_id)) {
          return failure(409, 'visit_closeout_pending', 'The saved closeout has not finished recording its services.');
        }
        const billing = await require('./visit-completion-invoice').createVisitCompletionInvoice(existing.id, trx);
        return recordsResult(existing, saved, billing, true);
      }
      if (visit.status !== 'open') return failure(409, 'visit_not_open', 'This visit is no longer open for closeout.');
      const keyOwner = await trx('visit_completion_packets').where({ idempotency_key: request.key }).first('id');
      if (keyOwner) return failure(409, 'visit_closeout_key_reused', 'The idempotency key belongs to another visit.');
      const [packet] = await trx('visit_completion_packets').insert({
        visit_id: visit.id, idempotency_key: request.key, request_hash: request.hash,
        payload: JSON.stringify({ items: request.items, actor: input.actor }), status: 'processing',
      }).returning('*');
      await trx('service_visits').where({ id: visit.id }).update({
        status: 'closing', completion_submitted_at: trx.fn.now(), updated_at: trx.fn.now(),
      });
      const recorded = [];
      for (const item of request.items) {
        const key = `visit:${packet.id}:${item.serviceId}`;
        const [packetItem] = await trx('visit_completion_packet_items').insert({
          packet_id: packet.id, scheduled_service_id: item.serviceId,
          derived_idempotency_key: key, status: 'processing', attempt_count: 1, started_at: trx.fn.now(),
        }).returning('*');
        const result = await completeScheduledService({
          serviceId: item.serviceId, idempotencyKey: key,
          body: structuredClone(item.body), actor: input.actor,
        }, { phase: 'records', trx, itemId: packetItem.id, uploadedPhotoRows });
        if (result.status !== 202 || !result.body.serviceRecordId) {
          const rejected = new Error('Visit member completion rejected');
          rejected.completionResult = { ...result, body: { ...result.body, serviceId: item.serviceId } };
          throw rejected;
        }
        const [saved] = await trx('visit_completion_packet_items').where({ id: packetItem.id }).update({
          service_record_id: result.body.serviceRecordId, updated_at: trx.fn.now(),
        }).returning('*');
        recorded.push(saved);
      }
      const billing = await require('./visit-completion-invoice').createVisitCompletionInvoice(packet.id, trx);
      readyToCommit = true;
      return recordsResult(packet, recorded, billing);
    });
  } catch (err) {
    // S3 objects are external to PostgreSQL. Earlier successful members must
    // have their uploads removed too when a later form or the outer commit fails.
    // After the callback returned, a connection failure can leave COMMIT's
    // outcome unknown. Retain those objects for recovery rather than delete
    // photos that a committed packet may already reference.
    if (!readyToCommit && uploadedPhotoRows.length) await cleanupUploadedServicePhotoObjects(uploadedPhotoRows);
    if (err.completionResult) return err.completionResult;
    if (err.code === '23505' && err.constraint === 'visit_completion_packets_idempotency_key_unique') {
      return failure(409, 'visit_closeout_key_reused', 'The idempotency key belongs to another visit.');
    }
    throw err;
  }
}

/** Resume the existing member claims; the saved packet owns every form/key. */
async function runVisitCompletionPacketEffects(packetId, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  if (!packet) return failure(404, 'visit_closeout_not_found', 'Saved visit closeout not found.');
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
  const items = await database('visit_completion_packet_items').where({ packet_id: packet.id }).orderBy('scheduled_service_id');
  if (!items.length || items.some((item) => !item.service_record_id)) {
    return failure(409, 'visit_closeout_pending', 'The saved closeout has not finished recording its services.');
  }
  const { completeScheduledService } = require('./complete-scheduled-service');
  for (const item of items) {
    if (item.status === 'done') continue;
    const savedForm = payload.items.find((form) => form.serviceId === item.scheduled_service_id);
    if (!savedForm) throw new Error('Saved visit closeout is missing a member form');
    const result = await completeScheduledService({
      serviceId: item.scheduled_service_id, idempotencyKey: item.derived_idempotency_key,
      body: structuredClone(savedForm.body), actor: payload.actor,
    }, { phase: 'effects', itemId: item.id });
    if (result.status !== 200 || result.body.serviceRecordId !== item.service_record_id) {
      await database('visit_completion_packet_items').where({ id: item.id }).update({
        last_error: result.body.code || 'member_effects_pending', updated_at: database.fn.now(),
      });
      return { status: 202, body: {
        visitId: packet.visit_id, packetId: packet.id, state: 'service_effects_pending',
        serviceId: item.scheduled_service_id, code: result.body.code || 'member_effects_pending',
      } };
    }
    await database('visit_completion_packet_items').where({ id: item.id, service_record_id: item.service_record_id }).update({
      status: 'done', completed_at: database.fn.now(), last_error: null, updated_at: database.fn.now(),
    });
  }
  const Summary = require('./visit-completion-summary');
  const token = await Summary.ensureVisitSummaryToken(packet.id, database);
  const payment = await require('./visit-completion-payment').collectVisitCompletionInvoice(packet.id, database);
  // Unpaid invoices use the existing scheduled invoice sender and its
  // durable send claim. Billing contacts receive their financial document;
  // service contacts' summary token never grants access to billing details.
  if (['payment_needed', 'payment_failed'].includes(payment.state)) {
    await database('invoices').where({ id: payment.invoiceId, status: 'draft', visit_completion_packet_id: packet.id })
      .whereNull('payer_id').whereNull('payer_statement_id').update({
        status: 'scheduled', scheduled_send_at: database.fn.now(), scheduled_send_attempts: 0,
        updated_at: database.fn.now(),
      });
  }
  const delivery = await Summary.deliverVisitCompletionSummary(packet.id, token, database);
  const performed = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where('i.packet_id', packet.id).where('r.status', 'completed')
    .whereRaw("COALESCE(r.structured_notes->>'backfill', 'false') = 'false'")
    .whereRaw("COALESCE(r.structured_notes->>'visitOutcome', 'completed') NOT IN ('inspection_only', 'customer_declined', 'incomplete')")
    .whereRaw("COALESCE(r.structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'")
    .orderBy('s.window_start').orderBy('s.id')
    .select('s.id', 's.customer_id', 's.is_recurring', 's.recurring_pattern', 'r.id as record_id');
  if (performed.length) {
    const first = performed[0];
    // These existing helpers own their customer-level single-use guards.
    // A retry cannot issue a second card or referral credit.
    await require('./customer-card').ensureCardForCompletion({
      customerId: first.customer_id, serviceRecordId: first.record_id, scheduledServiceId: first.id,
    });
    const recurring = performed.find((member) => member.is_recurring || member.recurring_pattern);
    if (recurring) await require('./referral-engine').creditReferralOnFirstService({ customerId: recurring.customer_id, serviceId: recurring.id });
  }
  await enrollVisitCompletionReview(packet.id, database);
  const paymentPending = ['payment_pending', 'processing'].includes(payment.state);
  const pending = paymentPending || delivery.state === 'delivery_pending';
  const review = payment.state === 'office_required' || delivery.state === 'delivery_review';
  const state = pending ? 'effects_pending' : review ? 'office_required' : 'done';
  if (!pending) await database.transaction(async (trx) => {
    const locked = await trx('visit_completion_packets').where({ id: packet.id }).forUpdate().first();
    if (locked.status !== 'done') {
      if (review) {
        const member = await trx('scheduled_services').where({ id: items[0].scheduled_service_id }).first();
        await require('./dispatch-alerts').createAlert({
          type: 'visit_closeout_review', severity: 'warn', techId: member.technician_id, jobId: member.id, trx,
          payload: { visitId: packet.visit_id, packetId: packet.id, payment: payment.state, delivery: delivery.state },
        });
      }
      await trx('visit_completion_packets').where({ id: packet.id }).update({
        status: 'done', error: review ? JSON.stringify({ payment: payment.state, delivery: delivery.state }) : null,
        updated_at: trx.fn.now(),
      });
      await trx('service_visits').where({ id: packet.visit_id }).update({
        status: 'closed', closed_at: trx.fn.now(), close_reason: review ? 'office_review' : 'completed', updated_at: trx.fn.now(),
      });
    }
  });
  return { status: pending ? 202 : 200, body: {
    visitId: packet.visit_id, packetId: packet.id, state, payment, delivery, summaryUrl: `/visit/${token}`,
  } };
}

/** Completion and a later paid webhook share the same representative record. */
async function enrollVisitCompletionReview(packetId, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  if (!packet) return { enrolled: false, reason: 'packet_missing' };
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
  const requested = payload.items.every(({ body }) => body.requestReview === true
    && (!body.reviewSuppression || body.reviewSuppression === 'invoice_created'));
  const visit = await database('service_visits').where({ id: packet.visit_id }).first();
  if (!requested || visit.billing_hold) return { enrolled: false, reason: 'visit_review_suppressed' };
  const invoice = await database('invoices').where({ visit_completion_packet_id: packet.id }).first();
  if (invoice && !['paid', 'prepaid'].includes(invoice.status)) return { enrolled: false, reason: 'invoice_unpaid' };
  const members = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where('i.packet_id', packet.id).orderBy('s.window_start').orderBy('s.id')
    .select('i.status', 's.id', 'r.id as record_id', 'r.structured_notes', 'r.service_type');
  if (members.length < 2 || members.some((member) => member.status !== 'done'
      || member.structured_notes?.visitOutcome !== 'completed'
      || member.structured_notes?.requestReview !== true
      || (member.structured_notes?.reviewSuppression && member.structured_notes.reviewSuppression !== 'invoice_created')
      || (member.structured_notes?.typedReportDelivery && member.structured_notes.typedReportDelivery !== 'auto_send'))) {
    return { enrolled: false, reason: 'visit_outcome' };
  }
  const first = members[0];
  const result = await require('./review-request').enrollPostService({
    customerId: visit.customer_id, serviceRecordId: first.record_id, scheduledServiceId: first.id,
    serviceType: first.service_type, technicianId: visit.technician_id,
    completedAt: visit.completion_submitted_at, triggeredBy: 'auto',
    delayMinutes: require('./review-request').completionReviewDelay(first.structured_notes), legacyDelayMinutes: 120,
  });
  return { enrolled: true, result };
}

/** Existing completion/effect claims own retries; this sweep only resumes them. */
async function resumePendingVisitCompletions({ limit = 3 } = {}) {
  const packets = await db('visit_completion_packets').where({ status: 'processing' })
    .where('updated_at', '<', new Date(Date.now() - 60 * 1000)).orderBy('updated_at').limit(limit).select('id');
  for (const packet of packets) {
    try { await runVisitCompletionPacketEffects(packet.id); }
    catch (err) {
      require('./logger').warn(`[visit-closeout] retry pending for packet ${packet.id} (${err.name || 'Error'})`);
    }
    // A persistently blocked packet must not monopolize the oldest-first batch.
    await db('visit_completion_packets').where({ id: packet.id, status: 'processing' }).update({ updated_at: db.fn.now() });
  }
  return { checked: packets.length };
}

module.exports = { saveVisitCompletionPacket, runVisitCompletionPacketEffects, enrollVisitCompletionReview, resumePendingVisitCompletions };
