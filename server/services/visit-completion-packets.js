'use strict';

/**
 * The durable phase of grouped closeout (visit-closeout-phase2.md, stages 3–4).
 * No route or worker invokes this prerequisite yet. Shared effects and delivery
 * must be complete before a production entry point is connected.
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
        }, { trx, itemId: packetItem.id, uploadedPhotoRows });
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

module.exports = { saveVisitCompletionPacket };
