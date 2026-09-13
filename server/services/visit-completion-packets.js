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
const { STALE_SEND_PARK_ERROR } = require('./invoice-helpers');
const { validate: isUuid } = require('uuid');
const db = require('../models/db');
const { hashCompletionRequest, withoutPhotoBytes, isOperatorTimeOnSite } = require('./completion-attempts');
const { dateOnly, lockStop, stopBaseKey } = require('./visit-groups');
const { parseETDateTime } = require('../utils/datetime-et');
const { RETAINED_HISTORY_STATUSES } = require('./visit-context/statuses');
const { cleanupUploadedServicePhotoObjects } = require('./service-photos');
const { finiteDate, firstFiniteDate } = require('../utils/service-duration-capture');
const { minutesFromElapsed } = require('../utils/duration-minutes');
const { parseJsonObject } = require('./job-costing');

// A packet's stored payload, parsed once: pg returns json columns as
// objects and the fixtures/older rows as strings.
function packetPayload(packet) {
  return typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
}

function failure(status, code, error) {
  return { status, body: { code, error } };
}

// A visit records a handful of members; the cap rejects an implausible
// array before the save acquires a per-item invoice-mint lock for each id.
const MAX_PACKET_ITEMS = 50;

function packetRequest({ visitId, idempotencyKey, items }) {
  if (!isUuid(visitId) || typeof idempotencyKey !== 'string'
      || !idempotencyKey.trim() || idempotencyKey.length > 120) {
    return { error: failure(400, 'visit_closeout_invalid', 'A visit and an idempotency key are required.') };
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_PACKET_ITEMS || items.some((item) => (
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

// The schedule's status-only completion path can leave no canonical record.
// Read that evidence for both staff access and the locked packet snapshot.
function visitCloseoutMemberQuery(visitId, database = db) {
  return database('scheduled_services').where({ visit_id: visitId }).select('scheduled_services.*', database.raw(
    'EXISTS (SELECT 1 FROM service_records r WHERE r.scheduled_service_id = scheduled_services.id AND r.customer_id = scheduled_services.customer_id) AS has_service_record',
  ));
}

function retainedCloseoutMembers(members, packet) {
  if (packet) return packet.payload.retainedMembers || [];
  return members.filter((member) => RETAINED_HISTORY_STATUSES.includes(member.status)
    || (member.status === 'completed' && member.has_service_record === true))
    .map((member) => ({ serviceId: member.id, status: member.status }));
}

function packetSnapshot(request, actor, members, existing) {
  if (existing) return { ...existing.payload, retainedMembers: existing.payload.retainedMembers || [] };
  const retainedMembers = retainedCloseoutMembers(members, null);
  // The packet-level request hash still covers the original photo bytes (a
  // save-time replay must resend the same photos); each member's attempt hash
  // covers this stripped form. Uploaded objects belong to each service record;
  // packet retries never upload them again.
  const items = request.items.map((item) => ({ ...item, body: withoutPhotoBytes(item.body) }));
  return { items, actor, retainedMembers };
}

// Retention is a membership rule, not proof that a record belongs to this
// physical stop. Require matching identity and a completion inside its live
// bounds; an earlier arrival or a quiet backfill is separate historical work.
function retainedWorkInStop(visit, members, records, start, end) {
  if (!start) return [];
  return members.flatMap((member) => {
    const record = records.find((row) => row.scheduled_service_id === member.id);
    if (!record || member.status !== 'completed'
      || member.customer_id !== visit.customer_id
      || (member.property_id || null) !== (visit.property_id || null)
      || dateOnly(member.scheduled_date) !== dateOnly(visit.scheduled_date)
      || dateOnly(record.service_date) !== dateOnly(visit.scheduled_date)) return [];
    const notes = parseJsonObject(record.structured_notes);
    const ended = firstFiniteDate(member.actual_end_time, member.check_out_time, member.completed_at, record.ended_at);
    const started = firstFiniteDate(member.actual_start_time, member.check_in_time, member.arrived_at, record.started_at);
    if (notes.backfill === true || !ended || ended < start || ended > end
      || (started && (started < start || started > ended))) return [];
    const corrected = minutesFromElapsed(member.time_on_site_adjusted_minutes)
      || (notes.timeOnSiteAdjusted === true ? minutesFromElapsed(notes.timeOnSite) : null);
    const allocation = notes.visitDurationAllocation;
    const minutes = corrected ?? (allocation?.version === 1
      ? allocation.allocatedMinutes
      : (minutesFromElapsed(member.service_time_minutes)
        ?? minutesFromElapsed(member.actual_duration_minutes) ?? minutesFromElapsed(notes.timeOnSite)));
    return [{ serviceId: member.id, serviceRecordId: record.id, completedAt: ended.toISOString(),
      minutes: Number.isInteger(minutes) && minutes >= 0 ? minutes : null }];
  });
}

// A grouped closeout represents one physical stop. Its linked rows share the
// same arrival/completion lifecycle, so copying the visit span onto every row
// would multiply labor by the number of services. Freeze one server-measured
// total and split only its unclaimed remainder across automatic members.
// Admin-entered live corrections and backfill durations keep their existing
// per-service authority and are deliberately absent from `items`.
//
// Integer columns require deterministic apportionment: floor every exact
// share, then give the remaining minutes to the largest fractional shares
// (service id breaks ties). Missing/nonpositive estimates receive zero when
// any positive estimate exists; if all estimates are missing, use a
// deterministic equal-weight fallback that preserves the measured total.
function buildVisitDurationAllocation({ visit, members, items, actor, retainedRecords = [], completedAt = new Date() }) {
  const memberById = new Map(members.map((member) => [String(member.id), member]));
  const timingMembers = items.filter((item) => item.body?.backfill !== true)
    .map((item) => memberById.get(String(item.serviceId))).filter(Boolean);
  // A status-only close may be reported later to create its missing records.
  // If every submitted row is already completed with a reliable server end,
  // the physical visit ended at the latest of those stamps; extending it to
  // the report time would overstate the stop. Any still-live/unstamped member
  // makes this a normal closeout whose end is the one captured now.
  const memberEnds = timingMembers.map((member) => finiteDate(
    member.actual_end_time || member.check_out_time || member.completed_at,
  ));
  const allPreviouslyEnded = timingMembers.length > 0
    && timingMembers.every((member) => String(member.status) === 'completed')
    && memberEnds.every(Boolean);
  const capturedEnd = finiteDate(completedAt) || new Date();
  let end = allPreviouslyEnded
    ? memberEnds.sort((a, b) => b.getTime() - a.getTime())[0]
    : capturedEnd;
  const automatic = [];
  let explicitMinutes = 0;

  for (const item of items) {
    const member = memberById.get(String(item.serviceId));
    const timeOnSite = item.body?.timeOnSite;
    const explicit = item.body?.backfill === true || isOperatorTimeOnSite(timeOnSite);
    if (explicit) {
      // Only an admin's valid live numeric correction participates in the
      // residual calculation. Backfills describe separate historical work;
      // invalid/non-admin overrides are still rejected by the canonical
      // completion validator and have no authority here.
      if (item.body?.backfill !== true && actor?.techRole === 'admin') {
        const minutes = minutesFromElapsed(timeOnSite);
        if (minutes > 0 && minutes <= 12 * 60) explicitMinutes += minutes;
      }
      continue;
    }
    // A completed row can be corrected before its missing report is saved.
    // Its durable admin correction reserves labor just like a typed override.
    const correctedMinutes = Number(member?.time_on_site_adjusted_minutes);
    if (Number.isFinite(correctedMinutes) && correctedMinutes > 0) {
      explicitMinutes += Math.round(correctedMinutes);
      continue;
    }
    automatic.push({
      serviceId: item.serviceId,
      estimatedMinutes: Number(member?.estimated_duration_minutes) > 0
        ? Number(member.estimated_duration_minutes) : 0,
    });
  }

  // The parent visit stamp is canonical. A legacy/partially-fanned visit may
  // lack it, so use the earliest start on an actually submitted live member;
  // retained history is absent from `items` and therefore cannot anchor the
  // new closeout's time.
  const memberStarts = timingMembers
    .flatMap((member) => member
      ? [member.actual_start_time, member.check_in_time, member.arrived_at]
      : [])
    .map(finiteDate).filter(Boolean).sort((a, b) => a.getTime() - b.getTime());
  const visitStart = finiteDate(visit?.arrived_at);
  const start = visitStart || memberStarts[0] || null;
  const retainedWork = retainedWorkInStop(visit, members, retainedRecords, start,
    allPreviouslyEnded ? capturedEnd : end);
  // A reportless member can have ended before another already-recorded
  // member. Both ends describe the same stop; reporting later must use its
  // actual last completion, not the earlier member or today's reporting time.
  if (allPreviouslyEnded) {
    for (const member of retainedWork) {
      const retainedEnd = finiteDate(member.completedAt);
      if (retainedEnd > end) end = retainedEnd;
    }
  }
  const elapsed = start ? (end.getTime() - start.getTime()) / 60000 : null;
  const totalMinutes = Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null;
  const retainedMinutes = retainedWork.some((member) => member.minutes == null)
    ? null : retainedWork.reduce((sum, member) => sum + member.minutes, 0);
  const allocatableMinutes = totalMinutes == null || retainedMinutes == null
    ? null : Math.max(0, totalMinutes - explicitMinutes - retainedMinutes);

  const weighted = automatic.map((item) => ({ ...item }));
  const positiveWeight = weighted.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  if (!positiveWeight) weighted.forEach((item) => { item.estimatedMinutes = 1; });
  const weightTotal = weighted.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  let allocated = 0;
  for (const item of weighted) {
    const exact = allocatableMinutes == null || !weightTotal
      ? null : (allocatableMinutes * item.estimatedMinutes) / weightTotal;
    item.allocatedMinutes = exact == null ? null : Math.floor(exact);
    item.remainder = exact == null ? 0 : exact - item.allocatedMinutes;
    if (item.allocatedMinutes != null) allocated += item.allocatedMinutes;
  }
  let remainder = allocatableMinutes == null ? 0 : allocatableMinutes - allocated;
  for (const item of weighted.slice().sort((a, b) => b.remainder - a.remainder
    || String(a.serviceId).localeCompare(String(b.serviceId)))) {
    if (remainder <= 0) break;
    item.allocatedMinutes += 1;
    remainder -= 1;
  }

  return {
    version: 1,
    source: visitStart ? 'visit_arrived_at' : (start ? 'member_start' : 'unavailable'),
    completedAtSource: allPreviouslyEnded ? 'existing_member_ends' : 'packet_save',
    startedAt: start ? start.toISOString() : null,
    completedAt: end.toISOString(),
    totalMinutes,
    explicitMinutes,
    retainedMinutes,
    retainedWork,
    // Keep the drive charge on previously recorded same-stop work when it
    // exists; otherwise one stable submitted live member owns it. Historical
    // backfills are separate work and keep their own accounting semantics.
    driveCostOwnerServiceId: retainedWork.map((member) => member.serviceId).sort()[0]
      || timingMembers.map((member) => member.id).sort()[0] || null,
    items: weighted.sort((a, b) => String(a.serviceId).localeCompare(String(b.serviceId)))
      .map(({ serviceId, estimatedMinutes, allocatedMinutes }) => ({ serviceId, estimatedMinutes, allocatedMinutes })),
  };
}

function memberDurationAllocation(payload, serviceId) {
  const allocation = payload?.durationAllocation;
  const item = allocation?.items?.find((candidate) => String(candidate.serviceId) === String(serviceId));
  if (!item) return null;
  return {
    version: allocation.version,
    source: allocation.source,
    startedAt: allocation.startedAt,
    completedAt: allocation.completedAt,
    completedAtSource: allocation.completedAtSource,
    totalMinutes: allocation.totalMinutes,
    allocatedMinutes: item.allocatedMinutes,
    estimatedMinutes: item.estimatedMinutes,
  };
}

function recordsResult(packet, items, billing, replayed = false) {
  return { status: 202, body: {
    visitId: packet.visit_id, packetId: packet.id, state: 'records_saved', replayed, billing,
    items: items.map((item) => ({ serviceId: item.scheduled_service_id, serviceRecordId: item.service_record_id })),
  } };
}

/** Owns the commit/rollback boundary; callers must supply a root Knex handle. */
// Invoice states a Bill-To withdrawal never touches and a reconciliation never releases.
// A void/cancel is an office problem when it lands mid-delivery; paid and
// prepaid are settled outcomes the collection verdict already names.
const VOIDED_INVOICE_STATUSES = new Set(['void', 'canceled', 'cancelled']);

const INVOICE_TERMINAL_STATUSES = ['void', 'refunded', 'canceled', 'cancelled', 'paid', 'prepaid'];

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
      const members = await visitCloseoutMemberQuery(visit.id, trx).orderBy('id').forUpdate();
      const existing = await trx('visit_completion_packets').where({ visit_id: visit.id }).first();
      const snapshot = packetSnapshot(request, actor, members, existing);
      const retainedIds = new Set(snapshot.retainedMembers.map((member) => member.serviceId));
      // Retained history (a cancelled child, its assignment cleared) is not
      // the technician's work; ownership is judged on the members recorded.
      const ownership = members.filter((member) => !retainedIds.has(member.id)).map((member) => completionOwnershipError({
        role: actor.techRole, actorTechnicianId: actor.technicianId, assignedTechnicianId: member.technician_id,
      })).find(Boolean);
      if (ownership) return { status: ownership.status, body: ownership.payload };
      // The route's current-assignment scope is re-applied on the locked rows:
      // a whole-visit reschedule that committed after the preflight read must
      // not let a technician close a visit outside their current window.
      if (members.filter((member) => !retainedIds.has(member.id)).some((member) => !memberInTechnicianScope(member, actor))) {
        return failure(409, 'visit_out_of_scope', 'This visit is no longer in your current schedule. Refresh the schedule.');
      }
      // Frozen visits retain terminal children as history. Only live children
      // need forms on the first submit. Replays use saved form membership,
      // since recording those services has already made them terminal too.
      const formMemberIds = members.filter((member) => !retainedIds.has(member.id)).map((member) => member.id);
      const frozenMemberIds = [...snapshot.items.map((item) => item.serviceId), ...retainedIds].sort();
      if (formMemberIds.join() !== request.items.map((item) => item.serviceId).join()
          || frozenMemberIds.join() !== members.map((member) => member.id).join()) {
        return failure(409, 'visit_members_changed', 'The visit service list changed. Refresh all service forms.');
      }
      // Retained history keeps the visit's identity but not its assignment.
      if (members.filter((member) => !retainedIds.has(member.id)).some((member) => member.customer_id !== visit.customer_id
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
      if (Number(visit.behavior_version) < 2 && !require('../config/feature-gates').isEnabled('visitCloseout')) {
        return failure(404, 'visit_closeout_disabled', 'Visit closeout is unavailable.');
      }
      if (!process.env.DATA_HYGIENE_VAULT_KEY) {
        return failure(503, 'visit_closeout_unavailable', 'Visit closeout is temporarily unavailable. No services were completed.');
      }
      const keyOwner = await trx('visit_completion_packets').where({ idempotency_key: request.key }).first('id');
      if (keyOwner) return failure(409, 'visit_closeout_key_reused', 'The idempotency key belongs to another visit.');
      const retainedCompletedIds = members.filter((member) => retainedIds.has(member.id)
        && member.status === 'completed').map((member) => member.id);
      // Member locks also serialize time-on-site corrections. Match the
      // costing reader's latest FK-linked record, never a historical soft join.
      const retainedRecords = retainedCompletedIds.length
        ? await trx('service_records').whereIn('scheduled_service_id', retainedCompletedIds)
          .where({ customer_id: visit.customer_id })
          .distinctOn('scheduled_service_id').orderBy('scheduled_service_id').orderBy('created_at', 'desc')
        : [];
      snapshot.durationAllocation = buildVisitDurationAllocation({
        visit, members, retainedRecords, items: request.items, actor, completedAt: new Date(),
      });
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
        }, {
          phase: 'records', trx, itemId: packetItem.id, uploadedPhotoRows,
          packetId: packet.id,
          completionAt: snapshot.durationAllocation.completedAt,
          durationAllocation: memberDurationAllocation(snapshot, item.serviceId),
          driveCostOwnerServiceId: snapshot.durationAllocation.driveCostOwnerServiceId,
        });
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
async function runVisitCompletionPacketMemberEffects(packetId, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  if (!packet) return failure(404, 'visit_closeout_not_found', 'Saved visit closeout not found.');
  if (packet.status === 'failed') return { status: 200, body: {
    visitId: packet.visit_id, packetId: packet.id, state: 'office_required', code: 'member_effects_rejected',
  } };
  const payload = packetPayload(packet);
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
    }, {
      phase: 'effects', itemId: item.id, packetId: packet.id,
      completionAt: payload.durationAllocation?.completedAt || null,
      durationAllocation: memberDurationAllocation(payload, item.scheduled_service_id),
    });
    if (result.status !== 200 || result.body.serviceRecordId !== item.service_record_id) {
      const verdict = memberEffectRefusal(result);
      // The visit left the packet's technician while effects ran (an office
      // reassignment after the resume boundary). The saved actor can never
      // complete the member again, so this is terminal for the packet the
      // same way a rejected member is: the office gets the closeout and its
      // alert, instead of a refusal the recovery sweep would repeat forever.
      if (verdict === 'terminal' || verdict === 'out_of_scope') {
        const code = verdict === 'out_of_scope' ? 'service_reassigned' : (result.body.code || 'member_effects_rejected');
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

// The canonical technician scope (technician-visit-scope.js), judged on a
// locked member row; administrators are unscoped.
function memberInTechnicianScope(member, actor) {
  return require('./technician-visit-scope').technicianVisitRowInScope(actor, member);
}

// The resume boundary re-applies the actor's scope on the locked member rows,
// exactly as the save does: a reassignment or reschedule that committed after
// the route's unlocked preflight must not let the former technician trigger
// billing and customer-summary effects. Retained history is not judged.
async function packetInTechnicianScope(packetId, actor, database) {
  return database.transaction(async (trx) => {
    const packet = await trx('visit_completion_packets').where({ id: packetId }).first('id', 'visit_id', 'payload');
    if (!packet) return true;
    const members = await visitCloseoutMemberQuery(packet.visit_id, trx).orderBy('id').forShare();
    const retainedIds = new Set(retainedCloseoutMembers(members, { payload: packetPayload(packet) }).map((member) => member.serviceId));
    return members.filter((member) => !retainedIds.has(member.id)).every((member) => memberInTechnicianScope(member, actor));
  });
}

// How a member effect's non-success result is treated: a live conflict with
// another runner retries, a visit that left the technician mid-run is out of
// scope (non-terminal), any other 4xx is the member's terminal verdict, and
// everything else (5xx, 408/425/429) retries.
function memberEffectRefusal(result) {
  const code = result.body?.code;
  if (result.status === 409 && ['service_completion_pending', 'completion_pending', 'completion_side_effects_running'].includes(code)) return 'retry';
  if (result.status === 403 && code === 'service_not_assigned') return 'out_of_scope';
  if (result.status >= 400 && result.status < 500 && ![408, 425, 429].includes(result.status)) return 'terminal';
  return 'retry';
}

/**
 * The two per-completion side effects a closed packet owes, each with its own
 * eligibility: a loyalty card mints for every performed, non-internal-only
 * completion (a backfill mints silently), while a referral credit excludes
 * backfills but not an internal-only report posture. Both helpers own their
 * single-use guards, so this runs once per packet pass and decides only WHO
 * qualifies.
 */
async function runPacketCompletionCredits(packetId, database) {
  const recorded = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where('i.packet_id', packetId).where('r.status', 'completed')
    .orderBy('s.window_start').orderBy('s.id')
    .select('s.id', 's.customer_id', 's.is_recurring', 's.recurring_pattern', 'r.id as record_id', 'r.structured_notes', 'r.service_date');
  const notesOf = (member) => (typeof member.structured_notes === 'string'
    ? JSON.parse(member.structured_notes) : member.structured_notes) || {};
  const performed = (member) => !['inspection_only', 'customer_declined', 'incomplete'].includes(notesOf(member).visitOutcome || 'completed');
  const backfill = (member) => notesOf(member).backfill === true;
  const internalOnly = (member) => notesOf(member).internalOnlyCompletion === true
    || (notesOf(member).internalOnlyCompletion === undefined && notesOf(member).typedReportDelivery === 'disabled');
  // A REAL completion outranks a quiet backfill for the card email (Codex
  // #4311 r47 P2): window/id ordering could make a backfill the first
  // eligible member, and the helper deliberately leaves email_sent_at empty
  // in suppressed mode — so the real completion sitting in the same packet
  // was skipped and the card email waited for some future visit.
  const cardEligible = recorded.filter((member) => performed(member) && !internalOnly(member));
  const cardMember = cardEligible.find((member) => !backfill(member)) || cardEligible[0];
  if (cardMember) {
    await require('./customer-card').ensureCardForCompletion({
      customerId: cardMember.customer_id, serviceRecordId: cardMember.record_id, scheduledServiceId: cardMember.id,
      suppressIssuedEmail: backfill(cardMember),
      firstVisitAt: backfill(cardMember) ? parseETDateTime(`${dateOnly(cardMember.service_date)}T12:00`) : null,
    });
  }
  const referralMember = recorded.find((member) => performed(member) && !backfill(member) && (member.is_recurring || member.recurring_pattern));
  if (referralMember) {
    await require('./referral-engine').creditReferralOnFirstService({ customerId: referralMember.customer_id, serviceId: referralMember.id });
  }
}

/**
 * One open office-review alert per packet. `dispatch_alerts` has no unique
 * index for (type, payload->>'packetId'), so the check and the insert are
 * SERIALIZED ON THE PACKET ROW (Codex #4311 r44 P1): an initial closeout that
 * overlaps the resume sweep would otherwise have both runners pass the lookup
 * before either insert commits, and the office would get two items for one
 * packet. The close path already holds that row FOR UPDATE, so the lock is
 * re-entrant there; the pending-delivery raiser takes it here.
 */
async function recordOfficeReviewAlert(database, { packet, memberId, state }) {
  const run = async (trx) => {
    await trx('visit_completion_packets').where({ id: packet.id }).forUpdate().first('id');
    const open = await trx('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
      .whereRaw("payload->>'packetId' = ?", [packet.id]).first('id');
    if (open) return false;
    const member = memberId ? await trx('scheduled_services').where({ id: memberId }).first() : null;
    await require('./dispatch-alerts').createAlert({
      type: 'visit_closeout_review', severity: 'warn',
      techId: member?.technician_id || null, jobId: member?.id || null,
      trx,
      payload: { visitId: packet.visit_id, packetId: packet.id, ...state },
    });
    return true;
  };
  return database.isTransaction ? run(database) : database.transaction(run);
}

/**
 * The delivery and payment verdicts, RE-DERIVED under the closing locks. Both
 * can move while the summary delivery is awaited: a recovery can settle an
 * uncertain summary (the packet goes back on the queue), a bounce can arrive
 * (the outreach is parked and the packet closes for review), and a Bill-To
 * change can assign, clear or hand off the payer (the withdrawal itself
 * records nothing while the packet is still processing). Returns the verdicts
 * to close on, or `reopened` when the packet belongs back on the queue.
 */
async function deriveClosingVerdicts(trx, { packet, payment, delivery }) {
  const uncertainNow = await trx('visit_effects').where({ visit_id: packet.visit_id })
    .whereIn('effect_type', ['completion_sms', 'completion_email']).where({ status: 'unknown_delivery' }).first('id');
  if (delivery.state === 'delivery_review' && !uncertainNow) return { reopened: true };
  let nextDelivery = delivery;
  if (uncertainNow && delivery.state === 'delivered') {
    nextDelivery = { ...delivery, state: 'delivery_review' };
    // Outreach enrolled a moment ago, before the bounce, is parked too.
    await require('./visit-completion-summary').parkVisitReviewOutreach(packet.id, trx);
  }
  const invoice = payment.invoiceId
    ? await trx('invoices').where({ id: payment.invoiceId }).first('id', 'status', 'payer_id', 'scheduled_send_error')
    : null;
  return { reopened: false, delivery: nextDelivery, payment: livePaymentVerdict(payment, invoice) };
}

/**
 * The payment verdict a closing invoice justifies, in BOTH directions: an
 * assignment or withdrawal during delivery closes for office review naming the
 * LIVE payer, and a payer cleared during delivery drops the verdict it
 * produced — a false payer alert would otherwise outlive the payer, and a
 * handoff would name the wrong AP account. A non-payer office review (a failed
 * charge) keeps its own.
 */
function livePaymentVerdict(payment, invoice) {
  if (!invoice) return payment;
  // A TERMINAL invoice is re-judged here too (Codex #4311 r46 P1): a void
  // landing while the summary delivery was awaited leaves the collection's
  // `payment_needed` verdict stale, and the packet would close as a clean
  // completion — no office review, no billing hold — even though the
  // collection applies exactly that when it sees the same void before
  // delivery. Only a VOID/CANCELED invoice is the office's problem; paid and
  // prepaid are the settled outcomes the verdict already describes.
  if (VOIDED_INVOICE_STATUSES.has(String(invoice.status || '').toLowerCase())) {
    return { ...payment, state: 'office_required', reason: 'invoice_voided', payerId: null };
  }
  const [, stampedPayer] = String(invoice.scheduled_send_error || '').split(':');
  const payerOwnedNow = Boolean(invoice.payer_id)
    || require('./invoice-helpers').invoiceWithdrawnFromCustomer(invoice);
  if (payerOwnedNow) {
    const livePayerId = invoice.payer_id || (stampedPayer ? Number(stampedPayer) : null) || payment.payerId || null;
    return { ...payment, state: 'office_required', reason: 'payer_assigned', payerId: livePayerId };
  }
  if (payment.reason !== 'payer_assigned') return payment;
  // The payer verdict goes, but the replacement is derived from the LIVE
  // invoice (local audit on r46): a released invoice is requeued and still
  // unpaid, so reporting `collected` would tell the caller money arrived that
  // nobody has paid. Only a settled row justifies a settled outcome.
  const settled = ['paid', 'prepaid'].includes(String(invoice.status || '').toLowerCase());
  if (payment.state !== 'office_required') return { ...payment, reason: null, payerId: null };
  return { ...payment, state: settled ? 'collected' : 'payment_needed', reason: null, payerId: null };
}

/**
 * The close itself: verdicts re-derived under the locks, the office alert (one
 * per packet), and the packet/visit transition. Returns the verdicts it closed
 * on, and whether the packet was reopened for recovery instead.
 */
async function closeVisitCompletionPacket(database, { packet, memberId, payment, delivery }) {
  let outcome = { payment, delivery, recovered: false };
  await database.transaction(async (trx) => {
    const visit = await trx('service_visits').where({ id: packet.visit_id }).first();
    await trx('customers').where({ id: visit.customer_id }).forNoKeyUpdate().first('id');
    await lockStop(trx, visit.stop_base_key);
    await trx('service_visits').where({ id: visit.id }).forUpdate().first('id');
    const locked = await trx('visit_completion_packets').where({ id: packet.id }).forUpdate().first();
    if (locked.status === 'done') return;
    const derived = await deriveClosingVerdicts(trx, { packet, payment, delivery });
    if (derived.reopened) {
      outcome = { ...outcome, recovered: true };
      await trx('visit_completion_packets').where({ id: packet.id })
        .update({ status: 'processing', error: 'review_enrollment_pending', updated_at: trx.fn.now() });
      return;
    }
    outcome = { payment: derived.payment, delivery: derived.delivery, recovered: false };
    const state = officeReviewState({
      payment: derived.payment.state, delivery: derived.delivery.state,
      reason: derived.payment.reason, payerId: derived.payment.payerId,
    });
    const closeReview = derived.payment.state === 'office_required' || derived.delivery.state === 'delivery_review';
    // A payment review derived HERE puts the visit on billing hold, exactly as
    // the collection does when it sees the same state before delivery (local
    // audit on r46): a void landing mid-delivery would otherwise close the
    // packet for office review while leaving billing_hold false, so the visit
    // itself carried no billing guard.
    if (derived.payment.state === 'office_required' && payment.state !== 'office_required') {
      await trx('service_visits').where({ id: packet.visit_id })
        .update({ billing_hold: true, updated_at: trx.fn.now() });
    }
    if (closeReview) await recordOfficeReviewAlert(trx, { packet, memberId, state });
    await trx('visit_completion_packets').where({ id: packet.id }).update({
      status: 'done',
      error: closeReview ? JSON.stringify(state) : null,
      updated_at: trx.fn.now(),
    });
    // A recovery reopens only the packet: a visit that already closed keeps
    // its original closure time and reason.
    await trx('service_visits').where({ id: packet.visit_id }).update({
      status: 'closed', closed_at: trx.raw('COALESCE(closed_at, NOW())'),
      close_reason: trx.raw('COALESCE(close_reason, ?)', [closeReview ? 'office_review' : 'completed']), updated_at: trx.fn.now(),
    });
  });
  return outcome;
}

/** Run summary and financial effects only after every member is ready. */
async function runVisitCompletionPacketEffects(packetId, database = db, { actor = null } = {}) {
  if (actor && require('./technician-visit-scope').isTechnicianRequest(actor) && !await packetInTechnicianScope(packetId, actor, database)) {
    return failure(409, 'visit_out_of_scope', 'This visit is no longer in your current schedule. Refresh the schedule.');
  }
  const members = await runVisitCompletionPacketMemberEffects(packetId, database);
  if (members.body.state !== 'member_effects_ready') return members;
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  const items = await database('visit_completion_packet_items').where({ packet_id: packet.id }).orderBy('scheduled_service_id');
  const Summary = require('./visit-completion-summary');
  // An internal-only packet (every member a backfill or a non-auto_send
  // posture) has nothing a customer may open: no link is minted, so the
  // encryption key is not a prerequisite for closing it.
  const token = await Summary.packetHasPublishableSummary(packet.id, database)
    ? await Summary.ensureVisitSummaryToken(packet.id, database) : null;
  // The collector decides live Bill-To under held rows before any automatic
  // collection (visit-completion-payment.js); a withdrawn invoice comes back
  // as office_required with reason payer_assigned.
  let payment = await require('./visit-completion-payment').collectVisitCompletionInvoice(packet.id, database);
  // Unpaid invoices use the existing scheduled invoice sender and its
  // durable send claim. Billing contacts receive their financial document;
  // service contacts' summary token never grants access to billing details.
  if (['payment_needed', 'payment_failed'].includes(payment.state)) {
    // The invoice was minted self-pay. If a third-party payer has since been
    // assigned to the customer or a billed member, the homeowner must not
    // receive a pay link for debt that now belongs to AP: the visit goes on
    // billing hold for the office instead. A lookup failure rethrows so the
    // recovery sweep retries rather than assuming self-pay.
    // Decided and applied under the same held rows the scheduled-send claim
    // uses, so a payer change cannot land between the decision and the
    // withdrawal or the scheduling.
    let recollect = false;
    payment = await database.transaction(async (trx) => {
      const { visit, billed, payerId: owner } = await resolvePacketOwnershipLocked(packet.id, trx);
      if (owner && await withdrawPacketInvoiceForPayer(trx, { packetId: packet.id, invoiceId: payment.invoiceId, visit, billed, payerId: owner })) {
        return { ...payment, state: 'office_required', reason: 'payer_assigned', payerId: owner };
      }
      const scheduled = await trx('invoices').where({ id: payment.invoiceId, status: 'draft', visit_completion_packet_id: packet.id })
        .whereNull('payer_id').whereNull('payer_statement_id').update({
          status: 'scheduled', scheduled_send_at: trx.fn.now(), scheduled_send_attempts: 0, scheduled_send_error: null,
          updated_at: trx.fn.now(),
        });
      if (scheduled) return payment;
      // Nothing moved. A self-pay invoice already on the send queue is this
      // coordinator's own earlier scheduling (a replay after that commit):
      // the queue owns it and there is nothing to decide again.
      const current = await trx('invoices').where({ id: payment.invoiceId, visit_completion_packet_id: packet.id })
        .first('status', 'payer_id', 'payer_statement_id');
      if (current?.status === 'scheduled' && !current.payer_id && !current.payer_statement_id) return payment;
      // Otherwise the draft was voided (or otherwise left draft) since the
      // collector read it. The collector's own terminal-state handling (hold
      // + office review) decides, never a clean close on a stale read. It
      // runs after these rows are released: its send claim opens its own
      // transaction and takes the member rows FOR UPDATE, which would wait
      // forever on the FOR SHARE this transaction holds.
      recollect = true;
      return payment;
    });
    if (recollect) payment = await require('./visit-completion-payment').collectVisitCompletionInvoice(packet.id, database);
  }
  let delivery = await Summary.deliverVisitCompletionSummary(packet.id, token, database);
  await runPacketCompletionCredits(packet.id, database);
  // Review outreach follows the summary: enrollment waits until every
  // requested delivery leg has settled and never runs for an uncertain one.
  const reviewEnrollment = delivery.state === 'delivered'
    ? await enrollVisitCompletionReview(packet.id, database, { deliverySettled: true })
    : { enrolled: false, reason: delivery.state };
  const paymentPending = ['payment_pending', 'processing'].includes(payment.state);
  const pending = paymentPending || delivery.state === 'delivery_pending' || reviewEnrollment.retryable === true;
  // A DELIVERY REVIEW is recorded even while the payment is still pending
  // (Codex #4311 r35 P2): the close below is the only other place that raises
  // the office alert, and an ACH settlement window is days long — the customer
  // did not reliably receive their summary and the review outreach is parked
  // that whole time, with nothing telling the office.
  if (pending && delivery.state === 'delivery_review') {
    try {
      await recordOfficeReviewAlert(database, {
        packet, memberId: items[0].scheduled_service_id,
        state: officeReviewState({ payment: payment.state, delivery: 'delivery_review' }),
      });
    } catch (alertErr) {
      require('./logger').warn(`[visit-closeout] could not record the delivery-review alert for packet ${packet.id}: ${alertErr.message}`);
    }
  }
  let recovered = false;
  if (!pending) {
    const closed = await closeVisitCompletionPacket(database, {
      packet, memberId: items[0].scheduled_service_id, payment, delivery,
    });
    payment = closed.payment;
    delivery = closed.delivery;
    recovered = closed.recovered;
  }
  // Judged after the close: the locked re-read above may have moved the
  // delivery state to office review.
  const stalled = pending || recovered;
  const review = payment.state === 'office_required' || delivery.state === 'delivery_review';
  const finalState = stalled ? 'effects_pending' : review ? 'office_required' : 'done';
  return { status: stalled ? 202 : 200, body: {
    visitId: packet.visit_id, packetId: packet.id, state: finalState, payment, delivery,
    summaryUrl: token ? `/visit/${token}` : null,
  } };
}

// True while a combined-visit invoice minted self-pay for this customer (or
// for the packet that billed this scheduled service) is claimed for delivery.
// Payer writers refuse the assignment in that window: the send claim holds
// the customer and billed-member rows while ownership is resolved, and a
// payer that lands after the claim commits would otherwise reach the
// homeowner with debt that now belongs to AP.
// `payerId` covers the activation writer: a send in flight for any customer
// or billed member that references the payer would resolve to it once active.
async function packetInvoiceSendInFlight({ customerId = null, scheduledServiceId = null, payerId = null } = {}, database = db) {
  if (!customerId && !scheduledServiceId && !payerId) return false;
  // A send claim ('sending'), or the coordinator's automatic collection
  // claim (the visit_payment effect held within its lease) — a saved-card
  // charge or credit settlement in flight is the same window for a payer.
  const VisitGroups = require('./visit-groups');
  const query = database('invoices').whereNotNull('visit_completion_packet_id').whereNull('payer_id')
    // A bank debit already CAPTURED on a packet invoice is the same window
    // (Codex #4311 r27 P1): settlement never re-resolves ownership, so an
    // ownership transition taken while the homeowner's money is moving
    // commits over funds that are about to pay a debt the payer now owes.
    .where((q) => q.where({ status: 'sending' })
      .orWhere((p) => p.where({ status: 'processing' }).whereNotNull('stripe_payment_intent_id'))
      .orWhereExists(database('visit_effects as e')
      .join('visit_completion_packets as p', 'p.visit_id', 'e.visit_id')
      .whereRaw('p.id = invoices.visit_completion_packet_id')
      .where({ 'e.effect_type': 'visit_payment', 'e.status': 'claimed' })
      .where('e.claimed_at', '>', new Date(Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS))));
  if (customerId) query.where({ customer_id: customerId });
  if (scheduledServiceId) {
    query.whereIn('visit_completion_packet_id', database('visit_completion_packet_items')
      .where({ scheduled_service_id: scheduledServiceId }).select('packet_id'));
  }
  if (payerId) {
    query.where((q) => q
      .whereIn('customer_id', database('customers').where({ payer_id: payerId }).select('id'))
      .orWhereIn('visit_completion_packet_id', database('visit_completion_packet_items')
        .whereIn('scheduled_service_id', database('scheduled_services').where({ payer_id: payerId }).select('id'))
        .select('packet_id')));
  }
  return Boolean(await query.first('id'));
}

/**
 * Is this invoice payer-owned RIGHT NOW? Three ways it can be, checked under
 * held rows: an attached payer_id, the withdrawal stamp, and — for a
 * combined-visit invoice — a payer on ANY billed member of its packet, which
 * the representative-service resolver cannot see. Used by the public
 * save-a-method seams before they persist anything, so the documented "a
 * withdrawn invoice saves and enrolls nothing" contract holds on the write
 * side too, not only at enrollment (Codex #4311 r39 P0).
 */
async function invoicePayerOwnedNow(invoiceId, database = db) {
  if (!invoiceId) return false;
  const run = async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId })
      .first('id', 'payer_id', 'scheduled_send_error', 'visit_completion_packet_id');
    if (!invoice) return true; // unreadable ownership is never "self-pay"
    if (invoice.payer_id) return true;
    if (require('./invoice-helpers').invoiceWithdrawnFromCustomer(invoice)) return true;
    if (!invoice.visit_completion_packet_id) return false;
    const { payerId } = await resolvePacketOwnershipLocked(invoice.visit_completion_packet_id, trx);
    return Boolean(payerId);
  };
  return database.isTransaction ? run(database) : database.transaction(run);
}

// The live Bill-To decision for a packet, made under held rows: the customer
// and the billed members FOR SHARE and every payer row the resolver consults,
// so a payer assignment, activation or deactivation serializes behind the
// decision instead of racing it. Returns the visit and the owning payer (null
// = self-pay). Both the coordinator and the scheduled-send claim decide here.
async function resolvePacketOwnershipLocked(packetId, trx) {
  const packet = await trx('visit_completion_packets').where({ id: packetId }).first('visit_id', 'payload');
  const visit = packet && await trx('service_visits').where({ id: packet.visit_id }).first('id', 'customer_id');
  if (!visit) return { visit: null, payerId: null, billed: [] };
  await trx('customers').where({ id: visit.customer_id }).forShare().first('id');
  const payload = packetPayload(packet);
  const billed = Array.isArray(payload?.billingSnapshot?.billedServiceIds) ? payload.billingSnapshot.billedServiceIds
    : await trx('visit_completion_packet_items').where({ packet_id: packetId }).pluck('scheduled_service_id');
  if (billed.length) await trx('scheduled_services').whereIn('id', billed).forShare().select('id');
  await lockPacketPayerRows(packetId, trx);
  return { visit, billed, payerId: await liveThirdPartyPayerForPacket(packetId, trx) };
}

// The one withdrawal for a self-pay combined-visit invoice whose live owner
// is a payer: the invoice leaves the send queue as a draft stamped with the
// payer it was withdrawn for, the visit goes on billing hold, and a packet
// that already closed records the office-review state (error + one open
// visit_closeout_review alert). A packet still processing gets that state
// from its own close. The stamp is what the reconciliation below keys on.
// Returns whether the invoice was withdrawn (false = it was already terminal
// or payer-owned when held, and nothing was recorded).
async function withdrawPacketInvoiceForPayer(trx, { packetId, invoiceId, visit, billed, payerId }) {
  // A repeated withdrawal (a second claim on the same draft) keeps the hold
  // flag the first one recorded: the invoice row is held before the marker
  // is read, so two withdrawals cannot both read the pre-flag value.
  const prior = await trx('invoices').where({ id: invoiceId }).forUpdate().first('scheduled_send_error', 'status', 'scheduled_send_at');
  // A row the stale-send recovery PARKED (scheduled with no send time, its
  // delivery unverified) may already have reached the customer (Codex #4311
  // r28 P1). Turning it into a draft would erase that evidence, and the
  // release below would then re-queue it as a fresh send — a second invoice
  // for a handoff that may well have succeeded. Such a row keeps its status
  // and its empty send time; only the stamp is written, flagged `park` so
  // the release restores the operator's evidence instead of scheduling it.
  // The homeowner's APPLIED CREDIT goes back before the debt changes hands
  // (Codex #4311 r35 P1): the payer-attach path (reverseCreditAndStampPayer)
  // already refuses to transfer ownership without returning it, and a
  // withdrawal is the same transfer by a different route — leaving it applied
  // understates the customer's balance and subsidizes the payer. An
  // incomplete reversal (a payment already in flight against the reduced
  // amount) THROWS, so the withdrawal and the Bill-To write roll back
  // together and the invoice stays self-pay for the caller's defer path.
  const appliedCredit = Number((await trx('invoices').where({ id: invoiceId }).first('credit_applied'))?.credit_applied || 0);
  if (appliedCredit > 0.004) {
    const { reverseAppliedCredit } = require('./customer-credit');
    const reversal = await reverseAppliedCredit({
      invoiceId, amount: appliedCredit, createdBy: 'system',
      note: `Bill-To moved to payer ${payerId} — homeowner credit returned`,
    }, trx);
    if ((Number(reversal?.reversed) || 0) + 0.005 < appliedCredit) {
      const stuck = new Error(`homeowner credit reversal incomplete (${reversal?.skipped || 'partial'}) — invoice stays self-pay`);
      stuck.code = 'CREDIT_REVERSAL_INCOMPLETE';
      throw stuck;
    }
  }
  const parked = prior?.status === 'scheduled' && !prior.scheduled_send_at
    && (String(prior.scheduled_send_error || '') === STALE_SEND_PARK_ERROR || /:park(:|$)/.test(String(prior.scheduled_send_error || '')));
  const stamp = `payer_billed:${payerId}${parked ? ':park' : ''}`;
  const withdrawn = parked
    ? await trx('invoices').where({ id: invoiceId, status: 'scheduled' }).whereNull('payer_id').whereNull('scheduled_send_at')
      .update({ scheduled_send_error: stamp, updated_at: trx.fn.now() })
    : await trx('invoices').where({ id: invoiceId }).whereIn('status', ['draft', 'scheduled', 'sending']).whereNull('payer_id')
      .update({ status: 'draft', scheduled_send_at: null, scheduled_send_error: stamp, updated_at: trx.fn.now() });
  // A pay link the homeowner already holds (sent, viewed, overdue) or a
  // settlement in flight cannot be recalled here. The stamp alone records
  // the withdrawal on such a row, so the office review below carries the
  // same signal and the Bill-To reconciliation can lift the hold, the
  // packet error and the alert once ownership returns to self-pay.
  let stamped = Number(withdrawn || 0);
  if (!stamped) {
    stamped = Number(await trx('invoices').where({ id: invoiceId }).whereNull('payer_id').whereNotIn('status', INVOICE_TERMINAL_STATUSES)
      .update({ scheduled_send_error: stamp, updated_at: trx.fn.now() }));
  }
  // Neither row moved: the invoice settled or left self-pay between the
  // caller's read and these held updates. There is nothing to withdraw and
  // no stamp for the reconciliation to clear, so no hold or office review
  // is recorded either; the caller decides on the invoice as it is now.
  if (!stamped) return false;
  // An ARMED dunning sequence chases the homeowner with the pay link, and
  // its guards read payer_id — which a withdrawal deliberately leaves NULL
  // (Codex #4311 r31 P1). Pause it here, inside the withdrawal, so the next
  // touch cannot go out before the cron's own stamp-aware filter sees it. The
  // release re-arms nothing: the reconciliation restores self-pay and the
  // ordinary lifecycle arms the sequence again.
  await trx('invoice_followup_sequences').where({ invoice_id: invoiceId }).whereIn('status', ['active', 'autopay_hold'])
    .update({ status: 'paused', next_touch_at: null, paused_reason: 'payer_billed', updated_at: trx.fn.now() });
  // The hold is the withdrawal's own only when the visit was not already
  // held for another office-owned reason; the stamp records that
  // (`:hold`), and the reconciliation lifts only a hold it created.
  const held = Number(await trx('service_visits').where({ id: visit.id })
    .where((q) => q.whereNull('billing_hold').orWhere('billing_hold', false))
    .update({ billing_hold: true, updated_at: trx.fn.now() }));
  if (held || /:hold$/.test(String(prior?.scheduled_send_error || ''))) {
    await trx('invoices').where({ id: invoiceId, scheduled_send_error: stamp }).update({ scheduled_send_error: `${stamp}:hold` });
  }
  // A packet that closed for DELIVERY review keeps that verdict (Codex #4311
  // r42 P2): replacing the whole error with a payer-only state would raise a
  // second alert beside the delivery one, and a later Bill-To clear would then
  // wipe the packet error entirely while the summary recovery is still
  // outstanding. The two verdicts are merged instead.
  const closedPacket = await trx('visit_completion_packets').where({ id: packetId, status: 'done' }).first('error');
  const priorState = parseOfficeReviewState(closedPacket?.error);
  // A PRE-EXISTING non-payer payment review survives too (Codex #4311 r45 P1).
  // Relabelling it `payer_assigned` erased the original provenance, and a
  // later Bill-To clear would then lift the alert and the packet error while
  // deliberately leaving the visit's own billing hold — the office would be
  // left holding a held visit with no signal for the problem that held it.
  // A REPEATED withdrawal (a coordinator replay) must not lose it (local
  // audit on r45): by then the original reason already lives in
  // priorPaymentReason and `reason` reads 'payer_assigned', so deriving only
  // from `reason` would null it out and the later lift would clear the error
  // and the alert while the original billing hold remained.
  const priorPaymentReason = priorState?.priorPaymentReason
    || (priorState?.payment === 'office_required'
      && priorState.reason && priorState.reason !== 'payer_assigned'
        ? priorState.reason : null);
  const mergedState = {
    ...officeReviewState({
      payment: 'office_required',
      delivery: priorState?.delivery === 'delivery_review' ? 'delivery_review' : null,
      reason: 'payer_assigned',
      payerId,
    }),
    ...(priorPaymentReason ? { priorPaymentReason } : {}),
  };
  const closed = await trx('visit_completion_packets').where({ id: packetId, status: 'done' })
    .update({ error: JSON.stringify(mergedState), updated_at: trx.fn.now() });
  if (!closed) return true;
  // Any open review alert for this packet is reused — the delivery alert
  // included — so the office sees one item carrying both verdicts.
  const open = await trx('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
    .whereRaw("payload->>'packetId' = ?", [packetId]).first('id');
  const member = billed.length ? await trx('scheduled_services').where({ id: billed[0] }).first('id', 'technician_id') : null;
  if (open) {
    // Augment it in place: the payer verdict joins whatever it already
    // carried, so a later lift can tell a delivery review is still owed.
    await trx('dispatch_alerts').where({ id: open.id })
      .update({ payload: trx.raw('payload || ?::jsonb', [JSON.stringify(mergedState)]) });
  } else if (member) {
    await require('./dispatch-alerts').createAlert({
      type: 'visit_closeout_review', severity: 'warn', techId: member.technician_id, jobId: member.id, trx,
      payload: { visitId: visit.id, packetId, ...mergedState },
    });
  }
  return true;
}

// One shape for the packet's office-review error and the alert payload,
// whichever writer records it (the coordinator's close or a late withdrawal).
function officeReviewState({ payment, delivery = null, reason = null, payerId = null }) {
  return { payment, ...(delivery ? { delivery } : {}), ...(reason ? { reason, payerId } : {}) };
}

// The packet's error column also carries plain sentinels (the review
// enrollment retry marker, a failure message), so a non-JSON value reads as
// no office-review state rather than throwing inside the caller's transaction.
function parseOfficeReviewState(error) {
  if (!error) return null;
  if (typeof error !== 'string') return error;
  try { return JSON.parse(error); } catch { return null; }
}

// Every Bill-To transition that can turn a withdrawn invoice self-pay again
// (a payer deactivated, a customer's or a job's payer link cleared, a self-pay
// override set) reconciles here, inside the writer's own transaction: each
// stamped invoice in scope whose live owner is now nobody is released — a
// withdrawn draft returns to the send queue (the worker re-judges ownership
// on its claim); a row the homeowner already holds or that is settling only
// loses its marker — its visit's hold is lifted, and the office-review state
// the withdrawal recorded (the packet error and the open alert) is cleared.
// An invoice voided or settled since keeps its terminal state untouched.
async function reconcileWithdrawnPacketInvoices(trx, { customerId = null, payerId = null, scheduledServiceId = null } = {}) {
  const query = trx('invoices').whereNotIn('status', INVOICE_TERMINAL_STATUSES).whereNull('payer_id').whereNotNull('visit_completion_packet_id')
    .where('scheduled_send_error', 'like', 'payer_billed:%');
  if (customerId) query.where({ customer_id: customerId });
  // Any flag combination for this payer (`:hold`, `:park`, both).
  if (payerId) {
    query.where((q) => q.where('scheduled_send_error', `payer_billed:${payerId}`)
      .orWhere('scheduled_send_error', 'like', `payer_billed:${payerId}:%`));
  }
  if (scheduledServiceId) {
    query.whereIn('visit_completion_packet_id', trx('visit_completion_packet_items').where({ scheduled_service_id: scheduledServiceId }).select('packet_id'));
  }
  const withdrawn = await query.select('id', 'status', 'visit_completion_packet_id', 'scheduled_send_error');
  let released = 0;
  for (const invoice of withdrawn) {
    if (await releaseWithdrawnPacketInvoice(trx, invoice)) released += 1;
  }
  return released;
}

// One withdrawn invoice: the stamp follows a payer that still owns the
// packet; otherwise the invoice is released (a draft back to its queue, a
// row the homeowner already holds keeps its status) and the withdrawal's
// own hold and office-review state are lifted. A failed packet keeps its
// hold and state: only the marker is cleared. Returns whether it was released.
async function releaseWithdrawnPacketInvoice(trx, invoice) {
  // `payer_billed:<payerId>[:park][:hold]` — the flags are order-independent
  // so a later one can be appended without re-parsing the rest.
  const [, stampedPayer, ...flags] = invoice.scheduled_send_error.split(':');
  const holdFlag = flags.includes('hold') ? 'hold' : null;
  const parked = flags.includes('park');
  const flagSuffix = flags.length ? `:${flags.join(':')}` : '';
  // Ownership is resolved under the customer, member and payer rows
  // (resolvePacketOwnershipLocked), so two Bill-To clears committing side by
  // side cannot each read the other's old payer and strand the withdrawal.
  const { payerId: live } = await resolvePacketOwnershipLocked(invoice.visit_completion_packet_id, trx);
  if (live) {
    if (String(live) !== stampedPayer) {
      await trx('invoices').where({ id: invoice.id, status: invoice.status, scheduled_send_error: invoice.scheduled_send_error })
        .update({ scheduled_send_error: `payer_billed:${live}${flagSuffix}`, updated_at: trx.fn.now() });
      // The office-review state records WHICH AP account owes this invoice,
      // so a payer-to-payer handoff has to move it with the stamp (fallback
      // audit P1): the packet error and the open alert were written with the
      // payer the withdrawal named, and office staff bill from them.
      await repointPayerOfficeReview(trx, invoice.visit_completion_packet_id, live);
    }
    return false;
  }
  const packet = await trx('visit_completion_packets').where({ id: invoice.visit_completion_packet_id }).first('id', 'visit_id', 'status', 'error');
  const requeue = invoice.status === 'draft' && packet?.status !== 'failed';
  const moved = await trx('invoices').where({ id: invoice.id, status: invoice.status, scheduled_send_error: invoice.scheduled_send_error }).whereNull('payer_id')
    .update(requeue
      ? { status: 'scheduled', scheduled_send_at: trx.fn.now(), scheduled_send_attempts: 0, scheduled_send_error: null, updated_at: trx.fn.now() }
      // A parked ambiguous send returns to the park it came from — its
      // evidence restored, its send time still empty — never to the queue.
      : { scheduled_send_error: parked ? STALE_SEND_PARK_ERROR : null, updated_at: trx.fn.now() });
  if (!moved || !packet || packet.status === 'failed') return false;
  // Only a hold the withdrawal created is lifted: a visit held before it
  // for another office-owned reason keeps that hold.
  if (holdFlag === 'hold') await trx('service_visits').where({ id: packet.visit_id }).update({ billing_hold: false, updated_at: trx.fn.now() });
  // The dunning the withdrawal paused resumes with it (local audit): a
  // sent/viewed/overdue invoice triggers no new send lifecycle on release, and
  // a paused row keeps the legacy reminder sweep away too, so the debt would
  // simply stop being collected. ONLY this system pause is lifted — an admin
  // pause or an autopay hold carries its own reason and is left alone.
  const pausedByWithdrawal = await trx('invoice_followup_sequences')
    .where({ invoice_id: invoice.id, status: 'paused', paused_reason: 'payer_billed' }).first('id', 'customer_id');
  if (pausedByWithdrawal) {
    // An AUTOPAY customer goes back to the hold, never to active dunning
    // (local audit): the withdrawal paused both states under one reason, so
    // resuming everything to active would start payment reminders for a
    // customer whose card runs automatically. Re-checked live, under this
    // transaction, the same way the follow-up re-arm does it.
    // The helper takes the customer ROW, not an id (local audit): an id makes
    // its payment-method lookup read `customer.id` as undefined and answer
    // "not on autopay", so every release would have activated dunning. A read
    // failure keeps the hold — the quiet direction for a customer whose card
    // may run automatically.
    let onAutopay = false;
    try {
      const customer = await trx('customers').where({ id: pausedByWithdrawal.customer_id }).first();
      onAutopay = customer
        ? await require('./autopay-eligibility').customerOnAutopay(customer, { db: trx, failClosed: true })
        : true;
    } catch { onAutopay = true; }
    await trx('invoice_followup_sequences').where({ id: pausedByWithdrawal.id })
      .update(onAutopay
        ? { status: 'autopay_hold', paused_reason: null, next_touch_at: null, updated_at: trx.fn.now() }
        : { status: 'active', paused_reason: null, next_touch_at: trx.fn.now(), updated_at: trx.fn.now() });
  }
  await liftPayerOfficeReview(trx, packet);
  return true;
}

// The payer named by an OPEN payer-assigned office review, moved to the payer
// that owns the packet now. Only the identity changes — the review itself is
// still owed, so nothing is resolved or re-created here.
async function repointPayerOfficeReview(trx, packetId, payerId) {
  const packet = await trx('visit_completion_packets').where({ id: packetId }).first('id', 'status', 'error');
  const state = packet && parseOfficeReviewState(packet.error);
  if (state?.reason === 'payer_assigned' && String(state.payerId) !== String(payerId)) {
    await trx('visit_completion_packets').where({ id: packetId })
      .update({ error: JSON.stringify({ ...state, payerId }), updated_at: trx.fn.now() });
  }
  await trx('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
    .whereRaw("payload->>'packetId' = ?", [packetId]).whereRaw("payload->>'reason' = 'payer_assigned'")
    .update({ payload: trx.raw("payload || jsonb_build_object('payerId', ?::text)", [String(payerId)]) });
}

// Only the payer portion of the office-review state is lifted: an uncertain
// summary delivery recorded beside it keeps its error and alert.
async function liftPayerOfficeReview(trx, packet) {
  const state = parseOfficeReviewState(packet.error);
  if (packet.status === 'done' && state?.reason === 'payer_assigned') {
    // Whatever the withdrawal did NOT own stays: a delivery review, and a
    // payment review that pre-dated the withdrawal (Codex #4311 r45 P1) —
    // the visit keeps its own hold for that one, so clearing the error and
    // the alert would leave the office no signal for it.
    const remaining = state.priorPaymentReason
      ? JSON.stringify(officeReviewState({
        payment: 'office_required',
        delivery: state.delivery === 'delivery_review' ? 'delivery_review' : null,
        reason: state.priorPaymentReason,
      }))
      : (state.delivery === 'delivery_review'
        ? JSON.stringify(officeReviewState({ payment: 'payment_needed', delivery: 'delivery_review' }))
        : null);
    await trx('visit_completion_packets').where({ id: packet.id }).update({ error: remaining, updated_at: trx.fn.now() });
    // An alert the withdrawal only borrowed is handed back rather than
    // resolved: the original review is still owed.
    if (state.priorPaymentReason) {
      await trx('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
        .whereRaw("payload->>'packetId' = ?", [packet.id])
        .update({ payload: trx.raw("(payload - 'payerId' - 'priorPaymentReason') || jsonb_build_object('reason', payload->>'priorPaymentReason')") });
      return;
    }
  }
  const alerts = await trx('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
    .whereRaw("payload->>'packetId' = ?", [packet.id]).whereRaw("payload->>'reason' = 'payer_assigned'")
    .whereRaw("COALESCE(payload->>'delivery', '') <> 'delivery_review'").select('id');
  for (const alert of alerts) await require('./dispatch-alerts').resolveAlert({ id: alert.id, resolvedBy: null, trx });
  // An alert that also carries the delivery review stays open, rewritten to
  // the delivery-only state the packet error now holds, so the summary
  // recovery can resolve it later (it ignores payer-held payloads).
  await trx('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
    .whereRaw("payload->>'packetId' = ?", [packet.id]).whereRaw("payload->>'reason' = 'payer_assigned'")
    .whereRaw("payload->>'delivery' = 'delivery_review'")
    .update({ payload: trx.raw("(payload - 'reason' - 'payerId') || '{\"payment\":\"payment_needed\"}'::jsonb") });
}

// The mirror of the reconciliation for ownership-ADDING transitions (a
// customer or job payer assigned, a self-pay override cleared, a payer
// reactivated): every self-pay combined-visit invoice the transition now
// makes payer-owned is withdrawn here, inside the writer's transaction —
// a draft leaves the queue, a pay link the homeowner already holds is
// stamped and the visit held for the office — instead of staying payable
// through its link while the debt belongs to AP. Ownership is decided under
// the held rows, so the resolver sees this transaction's own write.
async function withdrawPacketInvoicesForOwner(trx, { customerId = null, scheduledServiceId = null, payerId = null } = {}) {
  const query = trx('invoices').whereNotIn('status', INVOICE_TERMINAL_STATUSES).whereNull('payer_id').whereNotNull('visit_completion_packet_id')
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'));
  if (customerId) query.where({ customer_id: customerId });
  if (scheduledServiceId) {
    query.whereIn('visit_completion_packet_id', trx('visit_completion_packet_items').where({ scheduled_service_id: scheduledServiceId }).select('packet_id'));
  }
  if (payerId) {
    query.where((q) => q.whereIn('customer_id', trx('customers').where({ payer_id: payerId }).select('id'))
      .orWhereIn('visit_completion_packet_id', trx('visit_completion_packet_items')
        .whereIn('scheduled_service_id', trx('scheduled_services').where({ payer_id: payerId }).select('id')).select('packet_id')));
  }
  const candidates = await query.select('id', 'visit_completion_packet_id');
  // The IDS, not just a count (Codex #4311 r42 P1): a caller that must journal
  // what this withdrawal touched — the customer merge, whose undo repoints
  // rows by id — needs to know which invoices moved. `length` keeps the
  // count-like reading every other caller relies on.
  const withdrawn = [];
  for (const invoice of candidates) {
    const { visit, billed, payerId: owner } = await resolvePacketOwnershipLocked(invoice.visit_completion_packet_id, trx);
    if (!visit || !owner) continue;
    if (await withdrawPacketInvoiceForPayer(trx, { packetId: invoice.visit_completion_packet_id, invoiceId: invoice.id, visit, billed, payerId: owner })) {
      withdrawn.push(invoice.id);
    }
  }
  return withdrawn;
}

// Holds FOR SHARE every payer row the live Bill-To resolution for this
// packet can consult (the customer default and each billed member's per-job
// payer), so a payer activation — which changes that resolution without
// writing a customer or member row — waits for the send claim to commit and
// then sees it in flight.
async function lockPacketPayerRows(packetId, trx) {
  const packet = await trx('visit_completion_packets').where({ id: packetId }).first('visit_id', 'payload');
  if (!packet) return [];
  const visit = await trx('service_visits').where({ id: packet.visit_id }).first('customer_id');
  const payload = packetPayload(packet);
  const billed = Array.isArray(payload?.billingSnapshot?.billedServiceIds) ? payload.billingSnapshot.billedServiceIds
    : await trx('visit_completion_packet_items').where({ packet_id: packetId }).pluck('scheduled_service_id');
  const ids = new Set();
  const customer = visit && await trx('customers').where({ id: visit.customer_id }).first('payer_id');
  if (customer?.payer_id) ids.add(customer.payer_id);
  if (billed.length) {
    (await trx('scheduled_services').whereIn('id', billed).whereNotNull('payer_id').pluck('payer_id')).forEach((id) => ids.add(id));
  }
  const payerIds = [...ids];
  if (payerIds.length) await trx('payers').whereIn('id', payerIds).forShare().select('id');
  return payerIds;
}

// The active third-party payer that now owns a BILLED member, resolved live
// through the canonical Bill-To resolver with its per-job precedence (a
// per-job payer wins, a per-job self-pay override blocks the customer default,
// otherwise the customer default applies). Members the invoice excluded
// (inspection-only, declined, incomplete, recap-only) are not consulted, so an
// unrelated per-job payer cannot hold a valid homeowner invoice. null = self-pay.
async function liveThirdPartyPayerForPacket(packetId, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first('visit_id', 'payload');
  if (!packet) return null;
  const visit = await database('service_visits').where({ id: packet.visit_id }).first('customer_id');
  const payload = packetPayload(packet);
  const billed = Array.isArray(payload?.billingSnapshot?.billedServiceIds) ? payload.billingSnapshot.billedServiceIds
    : await database('visit_completion_packet_items').where({ packet_id: packetId }).pluck('scheduled_service_id');
  const Payer = require('./payer');
  for (const scheduledServiceId of billed) {
    const resolved = await Payer.resolveForInvoice({ database, customerId: visit.customer_id, scheduledServiceId, throwOnError: true });
    if (resolved.payerId) return resolved.payerId;
  }
  return null;
}

/** Completion and a later paid webhook share the same representative record. */
// The paid signal carries only the invoice; resolving its packet is part of
// the same one-shot boundary, so a failed lookup reopens the packet through
// the invoice link in one statement instead of losing the review.
async function enrollVisitCompletionReviewForInvoice(invoiceId, database = db) {
  let packetId;
  try {
    packetId = (await database('invoices').where({ id: invoiceId }).first('visit_completion_packet_id'))?.visit_completion_packet_id;
  } catch (err) {
    let reopened = null;
    try {
      reopened = Number(await database('visit_completion_packets')
        .whereIn('id', database('invoices').where({ id: invoiceId }).whereNotNull('visit_completion_packet_id').select('visit_completion_packet_id'))
        // Only a resumable packet reopens: a packet the office owns after a
        // permanent member-effect rejection stays failed.
        .whereIn('status', ['done', 'processing'])
        .update({ status: 'processing', error: 'review_enrollment_pending', updated_at: database.fn.now() }));
    } catch { reopened = null; }
    if (reopened === null) {
      // Neither the lookup nor the reopen reached the database: nothing
      // durable marks this packet for recovery, and the paid signal is one-
      // shot. Reported as unrecorded so the webhook can hand the event back
      // to Stripe; a manual caller has only this log.
      require('./logger').error(`[visit-closeout] review enrollment for invoice ${invoiceId} could not be recorded for recovery: ${err.message}`);
      return { enrolled: false, retryable: true, reason: 'error', error: err.message, reopened: false, recorded: false };
    }
    if (reopened > 0) return { enrolled: false, retryable: true, reason: 'error', error: err.message, reopened: true };
    // A reopen that ran and touched no packet means either no packet owns
    // this invoice or the owning packet is terminal (the office holds a
    // failed one). Only the first hands the review to the legacy
    // representative-record path; the link is re-read to tell them apart.
    try {
      packetId = (await database('invoices').where({ id: invoiceId }).first('visit_completion_packet_id'))?.visit_completion_packet_id;
    } catch (again) {
      // NOTHING was marked for recovery here: the first lookup failed, the
      // reopen touched no row, and this re-read failed too (Codex #4311 r32
      // P1). `recorded: false` is what makes the Stripe rail rethrow and
      // redeliver; without it the paid event is acknowledged and the
      // requested review is lost.
      return { enrolled: false, retryable: true, reason: 'error', error: again.message, reopened: false, recorded: false };
    }
    if (!packetId) return null;
    const owner = await database('visit_completion_packets').where({ id: packetId }).first('status');
    if (owner && !['done', 'processing'].includes(owner.status)) return { enrolled: false, reason: 'packet_owned', packetId, packetStatus: owner.status };
  }
  if (!packetId) return null;
  return enrollVisitCompletionReview(packetId, database);
}

// A paid webhook or manual settlement reaches this once for a packet that
// already closed awaiting payment. Any failure along the way, not only the
// final enrollment call, must put the packet back on the recovery queue or
// the requested review is lost with that one-shot signal.
async function enrollVisitCompletionReview(packetId, database = db, options = {}) {
  try {
    return await enrollVisitCompletionReviewOnce(packetId, database, options);
  } catch (err) {
    // Only a resumable packet reopens: a packet the office owns after a
    // permanent member-effect rejection stays failed, and the review is not
    // retried over it.
    let reopened;
    try {
      reopened = Number(await database('visit_completion_packets').where({ id: packetId })
        .whereIn('status', ['done', 'processing'])
        .update({ status: 'processing', error: 'review_enrollment_pending', updated_at: database.fn.now() }));
    } catch (again) {
      // Nothing durable marks the packet for the sweep: the caller must
      // keep its one-shot signal (a webhook redelivery, an admin alert).
      require('./logger').error(`[visit-closeout] review enrollment for packet ${packetId} could not be recorded for recovery: ${again.message}`);
      return { enrolled: false, retryable: true, reason: 'error', error: err.message, reopened: false, recorded: false };
    }
    if (!reopened) return { enrolled: false, reason: 'packet_owned', error: err.message };
    return { enrolled: false, retryable: true, reason: 'error', error: err.message };
  }
}

async function enrollVisitCompletionReviewOnce(packetId, database = db, { deliverySettled = false } = {}) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  if (!packet) return { enrolled: false, reason: 'packet_missing' };
  const payload = packetPayload(packet);
  const requested = payload.items.every(({ body }) => body.requestReview !== false
    && (!body.reviewSuppression || body.reviewSuppression === 'invoice_created'));
  const visit = await database('service_visits').where({ id: packet.visit_id }).first();
  if (!requested || visit.billing_hold) return { enrolled: false, reason: 'visit_review_suppressed' };
  const invoice = await database('invoices').where({ visit_completion_packet_id: packet.id }).first();
  if (invoice && !['paid', 'prepaid'].includes(invoice.status)) return { enrolled: false, reason: 'invoice_unpaid' };
  // A paid signal can arrive while the summary is still being delivered or
  // after an uncertain handoff: the ask never goes out ahead of the summary
  // it follows, and an uncertain delivery stays with the office.
  // The coordinator passes deliverySettled after observing 'delivered';
  // every other caller reads the two delivery effects itself. Absent rows
  // mean delivery has not run yet, not that nothing was requested.
  if (!deliverySettled) {
    const legs = await database('visit_effects').where({ visit_id: packet.visit_id })
      .whereIn('effect_type', ['completion_sms', 'completion_email']).select('status');
    if (legs.some((leg) => leg.status === 'unknown_delivery')) return { enrolled: false, reason: 'delivery_review' };
    if (legs.length < 2 || legs.some((leg) => !['sent', 'suppressed'].includes(leg.status))) {
      await database('visit_completion_packets').where({ id: packet.id }).update({
        status: 'processing', error: 'review_enrollment_pending', updated_at: database.fn.now(),
      });
      return { enrolled: false, retryable: true, reason: 'delivery_pending' };
    }
  }
  const members = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where('i.packet_id', packet.id).orderBy('s.window_start').orderBy('s.id')
    .select('i.status', 's.id', 'r.id as record_id', 'r.structured_notes', 'r.service_type');
  // A frozen visit that retained a terminal sibling legitimately records one member.
  if (!members.length || members.some((member) => member.status !== 'done'
      || member.structured_notes?.visitOutcome !== 'completed'
      || member.structured_notes?.requestReview !== true
      || (member.structured_notes?.reviewSuppression && member.structured_notes.reviewSuppression !== 'invoice_created')
      || (member.structured_notes?.typedReportDelivery && member.structured_notes.typedReportDelivery !== 'auto_send'))) {
    return { enrolled: false, reason: 'visit_outcome' };
  }
  // Terminal eligibility, checked here because the legacy and cadence paths
  // both report an archived customer as an opaque error that would otherwise
  // be retried on every recovery sweep.
  const customer = await database('customers').where({ id: visit.customer_id }).first('deleted_at');
  if (!customer || customer.deleted_at) return { enrolled: false, reason: 'customer_archived' };
  // Outreach parked while the summary was uncertain resumes at its kept
  // schedule instead of a fresh enrollment the cadence cooldown might refuse.
  const resumed = await require('./visit-completion-summary').resumeVisitReviewOutreach(packet.id, database);
  if (resumed) return { enrolled: true, resumed };
  const first = members[0];
  const result = await require('./review-request').enrollPostService({
    customerId: visit.customer_id, serviceRecordId: first.record_id, scheduledServiceId: first.id,
    serviceType: first.service_type, technicianId: visit.technician_id,
    completedAt: visit.completion_submitted_at, triggeredBy: 'auto',
    delayMinutes: require('./review-request').completionReviewDelay(first.structured_notes), legacyDelayMinutes: 120,
  }).catch(() => ({ started: false, reason: 'error' }));
  if (result.started === false && ['plan_resolution_failed', 'error'].includes(result.reason)) {
    // A paid webhook can reach a packet already closed while awaiting
    // payment. Put it back on the existing recovery worker's queue too.
    await database('visit_completion_packets').where({ id: packet.id }).update({
      status: 'processing', error: 'review_enrollment_pending', updated_at: database.fn.now(),
    });
    return { enrolled: false, retryable: true, reason: result.reason };
  }
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

module.exports = { invoicePayerOwnedNow, memberInTechnicianScope, visitCloseoutMemberQuery, retainedCloseoutMembers, packetPayload, parseOfficeReviewState, buildVisitDurationAllocation, memberDurationAllocation, resolvePacketOwnershipLocked, withdrawPacketInvoiceForPayer, reconcileWithdrawnPacketInvoices, withdrawPacketInvoicesForOwner, packetInvoiceSendInFlight, lockPacketPayerRows, liveThirdPartyPayerForPacket, enrollVisitCompletionReviewForInvoice, saveVisitCompletionPacket, runVisitCompletionPacketMemberEffects, runVisitCompletionPacketEffects, enrollVisitCompletionReview, resumePendingVisitCompletions };
