'use strict';

/**
 * The record phase of grouped closeout (visit-closeout-phase2.md, stage 3).
 * No route or worker invokes this prerequisite yet. Billing and delivery must
 * own the saved packet before a production entry point is connected.
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
const { TERMINAL_ROW_STATUSES } = require('./visit-context/statuses');
const { cleanupUploadedServicePhotoObjects } = require('./service-photos');

function failure(status, code, error) {
  return { status, body: { code, error } };
}

function packetRequest({ visitId, idempotencyKey, items }) {
  if (!isUuid(visitId) || typeof idempotencyKey !== 'string'
      || !idempotencyKey.trim() || idempotencyKey.length > 120) {
    return { error: failure(400, 'visit_closeout_invalid', 'A visit and an idempotency key are required.') };
  }
  if (!Array.isArray(items) || items.length < 1 || items.some((item) => (
    !isUuid(item?.serviceId) || !item.body || typeof item.body !== 'object' || Array.isArray(item.body)
  )) || new Set(items.map((item) => item.serviceId.toLowerCase())).size !== items.length) {
    return { error: failure(400, 'visit_closeout_members_invalid', 'Submit each visit service once with its completion form.') };
  }
  // Canonical completion normalizes some form fields in place. Keep the
  // submitted snapshot immutable, and use its existing semantic hash rules
  // so a ticking panel timer does not invalidate a retry of the same packet.
  // PostgreSQL returns uuid columns lowercase; look up, compare, sort and
  // hash every submitted id in that same canonical form, so a retry built
  // from a response's ids replays instead of mismatching.
  const canonicalVisitId = visitId.toLowerCase();
  const ordered = structuredClone(items)
    .map((item) => ({ ...item, serviceId: item.serviceId.toLowerCase() }))
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    visitId: canonicalVisitId,
    items: ordered.map((item) => ({ serviceId: item.serviceId, hash: hashCompletionRequest(item.body) })),
  })).digest('hex');
  return { visitId: canonicalVisitId, key: idempotencyKey.trim(), items: ordered, hash };
}

function packetSnapshot(request, actor, members, existing) {
  if (existing) return { ...existing.payload, retainedMembers: existing.payload.retainedMembers || [] };
  const retainedMembers = members.filter((member) => TERMINAL_ROW_STATUSES.includes(member.status))
    .map((member) => ({ serviceId: member.id, status: member.status }));
  const items = structuredClone(request.items);
  for (const item of items) {
    if (item.body.gaugePhoto && typeof item.body.gaugePhoto === 'object') delete item.body.gaugePhoto.data;
    if (!Array.isArray(item.body.completionPhotos)) continue;
    for (const photo of item.body.completionPhotos) {
      if (photo && typeof photo === 'object') delete photo.data;
    }
  }
  // The request hash still covers the original photo bytes. Uploaded objects
  // belong to each service record; packet retries never upload them again.
  return { items, actor, retainedMembers };
}

function recordsResult(packet, items, replayed = false) {
  return { status: 202, body: {
    visitId: packet.visit_id, packetId: packet.id, state: 'records_saved', replayed,
    items: items.map((item) => ({ serviceId: item.scheduled_service_id, serviceRecordId: item.service_record_id })),
  } };
}

/** Authenticated actor is supplied by the caller, separately from the forms. */
async function saveVisitCompletionRecords(input, database = db) {
  const request = packetRequest(input);
  if (request.error) return request.error;
  const actor = input.actor || {};
  const uploadedPhotoRows = [];
  let readyToCommit = false;
  try {
    return await database.transaction(async (trx) => {
      const peek = await trx('service_visits').where({ id: request.visitId }).first();
      if (!peek) return failure(404, 'visit_not_found', 'Visit not found.');
      const { completeScheduledService, completionOwnershipError } = require('./complete-scheduled-service');
      const pricing = require('./completion-pricing');
      const pricingPlans = [];
      // Reviewed estimates must precede the customer/stop/member locks,
      // matching acceptance and canonical completion. Saved packets replay
      // their frozen forms without revalidating an already-applied discount.
      if (!await trx('visit_completion_packets').where({ visit_id: peek.id }).first('id')) {
        const reviewed = request.items.filter((item) => item.body.pricingReview);
        const candidates = await trx('scheduled_services').where({ visit_id: peek.id })
          .whereIn('id', reviewed.map((item) => item.serviceId)).orderBy('id');
        for (const member of candidates) {
          const denied = completionOwnershipError({ role: actor.techRole,
            actorTechnicianId: actor.technicianId, assignedTechnicianId: member.technician_id });
          if (denied) return { status: denied.status, body: denied.payload };
          const form = reviewed.find((item) => item.serviceId === member.id);
          pricingPlans.push(await pricing.prepareCompletionPricingReview(member.id, form.body.pricingReview,
            { database: trx, role: actor.techRole }));
        }
        pricingPlans.sort((a, b) => (a.source.estimate?.id || '').localeCompare(b.source.estimate?.id || ''));
        for (const plan of pricingPlans) await pricing.lockCompletionPricingEstimate(trx, plan);
      }
      // Same customer -> stop -> visit/member order as grouping. Customer
      // identity and assignment cannot change while the records are written.
      await trx('customers').where({ id: peek.customer_id }).forNoKeyUpdate().first('id');
      pricingPlans.sort((a, b) => (a.source.parent?.id || '').localeCompare(b.source.parent?.id || ''));
      for (const plan of pricingPlans) await pricing.lockCompletionPricingParent(trx, plan);
      await lockStop(trx, peek.stop_base_key);
      // Re-read under the lock with the peeked identity in the predicate: a
      // visit that moved stop or customer in between is simply not found.
      const visit = await trx('service_visits')
        .where({ id: peek.id, stop_base_key: peek.stop_base_key, customer_id: peek.customer_id })
        .forUpdate().first();
      if (!visit) return failure(409, 'visit_changed', 'The visit moved. Refresh before closing it.');
      const members = await trx('scheduled_services').where({ visit_id: visit.id }).orderBy('id').forUpdate();
      const ownership = members.map((member) => completionOwnershipError({
        role: actor.techRole, actorTechnicianId: actor.technicianId, assignedTechnicianId: member.technician_id,
      })).find(Boolean);
      if (ownership) return { status: ownership.status, body: ownership.payload };
      const existing = await trx('visit_completion_packets').where({ visit_id: visit.id }).first();
      const snapshot = packetSnapshot(request, actor, members, existing);
      const retainedIds = new Set(snapshot.retainedMembers.map((member) => member.serviceId));
      // Frozen visits retain terminal children as history. Only live children
      // need forms on the first submit. Replays use saved form membership,
      // since recording those services has already made them terminal too.
      const formMemberIds = members.filter((member) => !retainedIds.has(member.id)).map((member) => member.id);
      const frozenMemberIds = [...snapshot.items.map((item) => item.serviceId), ...retainedIds].sort();
      if (formMemberIds.join() !== request.items.map((item) => item.serviceId).join()
          || frozenMemberIds.join() !== members.map((member) => member.id).join()) {
        return failure(409, 'visit_members_changed', 'The visit service list changed. Refresh all service forms.');
      }
      if (members.some((member) => member.customer_id !== visit.customer_id
          || (member.property_id || null) !== (visit.property_id || null)
          || dateOnly(member.scheduled_date) !== dateOnly(visit.scheduled_date)
          || member.technician_id !== visit.technician_id
          || stopBaseKey({ propertyId: member.property_id, customerId: member.customer_id, scheduledDate: member.scheduled_date }) !== visit.stop_base_key)) {
        return failure(409, 'visit_members_incompatible', 'These services no longer share one property, date and technician.');
      }
      if (existing) {
        if (existing.idempotency_key !== request.key || existing.request_hash !== request.hash) {
          return failure(409, 'visit_closeout_payload_mismatch', 'A saved closeout already owns this visit. Resume that closeout.');
        }
        const saved = await trx('visit_completion_packet_items').where({ packet_id: existing.id })
          .whereNotNull('service_record_id').orderBy('scheduled_service_id');
        if (saved.map((item) => item.scheduled_service_id).join() !== formMemberIds.join()) {
          return failure(409, 'visit_closeout_pending', 'The saved closeout has not finished recording its services.');
        }
        return recordsResult(existing, saved, true);
      }
      if (visit.status !== 'open') return failure(409, 'visit_not_open', 'This visit is no longer open for closeout.');
      const [packet] = await trx('visit_completion_packets').insert({
        visit_id: visit.id, idempotency_key: request.key, request_hash: request.hash,
        payload: JSON.stringify(snapshot), status: 'processing',
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
          body: structuredClone(item.body), actor,
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
      readyToCommit = true;
      return recordsResult(packet, recorded);
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

module.exports = { saveVisitCompletionRecords };
