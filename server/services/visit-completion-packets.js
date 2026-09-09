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
const { hashCompletionRequest, withoutPhotoBytes } = require('./completion-attempts');
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
  // The packet-level request hash still covers the original photo bytes (a
  // save-time replay must resend the same photos); each member's attempt hash
  // covers this stripped form. Uploaded objects belong to each service record;
  // packet retries never upload them again.
  const items = request.items.map((item) => ({ ...item, body: withoutPhotoBytes(item.body) }));
  return { items, actor, retainedMembers };
}

function recordsResult(packet, items, billing, replayed = false) {
  return { status: 202, body: {
    visitId: packet.visit_id, packetId: packet.id, state: 'records_saved', replayed, billing,
    items: items.map((item) => ({ serviceId: item.scheduled_service_id, serviceRecordId: item.service_record_id })),
  } };
}

/** Owns the commit/rollback boundary; callers must supply a root Knex handle. */
async function saveVisitCompletionPacket(input, database = db) {
  if (database.isTransaction) throw new TypeError('Visit completion requires a root database connection');
  const request = packetRequest(input);
  if (request.error) return request.error;
  const actor = input.actor || {};
  const uploadedPhotoRows = [];
  let readyToCommit = false;
  try {
    return await database.transaction(async (trx) => {
      const peek = await trx('service_visits').where({ id: request.visitId }).first();
      if (!peek) return failure(404, 'visit_not_found', 'Visit not found.');
      // Baseline confirmation and canonical completion take this fence before
      // estimate, invoice-mint and customer locks.
      if (require('../config/feature-gates').gateEnvValue('GATE_LAWN_PROPERTY_HISTORY')) {
        await require('./lawn-assessment').lockCustomerBaseline(peek.customer_id, trx);
      }
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
      // Use the canonical invoice-mint identities before customer/stop locks.
      const { acquireScheduledInvoiceMintLock } = require('./scheduled-invoice-mint');
      for (const item of request.items) await acquireScheduledInvoiceMintLock(trx, item.serviceId);
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
        const billing = await require('./visit-completion-invoice').createVisitCompletionInvoice(existing.id, trx);
        return recordsResult(existing, saved, billing, true);
      }
      if (visit.status !== 'open') return failure(409, 'visit_not_open', 'This visit is no longer open for closeout.');
      const keyOwner = await trx('visit_completion_packets').where({ idempotency_key: request.key }).first('id');
      if (keyOwner) return failure(409, 'visit_closeout_key_reused', 'The idempotency key belongs to another visit.');
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
  if (packet.status === 'failed') return { status: 200, body: {
    visitId: packet.visit_id, packetId: packet.id, state: 'office_required', code: 'member_effects_rejected',
  } };
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
      const retryableConflict = result.status === 409
        && ['service_completion_pending', 'completion_pending', 'completion_side_effects_running'].includes(result.body.code);
      if (result.status >= 400 && result.status < 500
          && ![408, 425, 429].includes(result.status) && !retryableConflict) {
        const code = result.body.code || 'member_effects_rejected';
        const finishedElsewhere = await database.transaction(async (trx) => {
          const visit = await trx('service_visits').where({ id: packet.visit_id }).first();
          await trx('customers').where({ id: visit.customer_id }).forNoKeyUpdate().first('id');
          await lockStop(trx, visit.stop_base_key);
          await trx('service_visits').where({ id: visit.id }).forUpdate().first('id');
          const locked = await trx('visit_completion_packets').where({ id: packet.id }).forUpdate().first();
          if (locked.status === 'failed') return false;
          // Two runners (the sweep and a Resume tap) can read the same
          // processing item; the one whose claim lands second is refused
          // ownership. That refusal is not the member's verdict when the
          // other runner already finished it under the same record.
          const current = await trx('visit_completion_packet_items').where({ id: item.id }).forUpdate().first();
          if (current?.status === 'done' && current.service_record_id === item.service_record_id) return true;
          const member = await trx('scheduled_services').where({ id: item.scheduled_service_id }).first();
          await require('./dispatch-alerts').createAlert({
            type: 'visit_closeout_review', severity: 'warn', techId: member.technician_id, jobId: member.id, trx,
            payload: { visitId: packet.visit_id, packetId: packet.id, serviceId: member.id, code },
          });
          await trx('visit_completion_packet_items').where({ id: item.id }).update({
            status: 'failed', last_error: code, updated_at: trx.fn.now(),
          });
          await trx('visit_completion_packets').where({ id: packet.id }).update({
            status: 'failed', error: JSON.stringify({ serviceId: member.id, code }), updated_at: trx.fn.now(),
          });
          await trx('service_visits').where({ id: packet.visit_id }).update({
            billing_hold: true, updated_at: trx.fn.now(),
          });
          return false;
        });
        if (finishedElsewhere) continue;
        return { status: 200, body: {
          visitId: packet.visit_id, packetId: packet.id, state: 'office_required',
          serviceId: item.scheduled_service_id, code,
        } };
      }
      const pendingCode = result.body.code || 'member_effects_pending';
      await database('visit_completion_packet_items').where({ id: item.id }).update({
        last_error: pendingCode, updated_at: database.fn.now(),
      });
      return { status: 202, body: {
        visitId: packet.visit_id, packetId: packet.id, state: 'service_effects_pending',
        serviceId: item.scheduled_service_id, code: pendingCode,
      } };
    }
    await database('visit_completion_packet_items').where({ id: item.id, service_record_id: item.service_record_id }).update({
      status: 'done', completed_at: database.fn.now(), last_error: null, updated_at: database.fn.now(),
    });
  }
  return { status: 202, body: { visitId: packet.visit_id, packetId: packet.id, state: 'member_effects_ready' } };
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

module.exports = { saveVisitCompletionPacket, runVisitCompletionPacketEffects, resumePendingVisitCompletions };
