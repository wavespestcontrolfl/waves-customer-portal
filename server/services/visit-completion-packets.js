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
const { parseETDateTime } = require('../utils/datetime-et');
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
async function runVisitCompletionPacketMemberEffects(packetId, database = db) {
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

/** Run summary and financial effects only after every member is ready. */
async function runVisitCompletionPacketEffects(packetId, database = db) {
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
    const owner = await liveThirdPartyPayerForPacket(packet.id, database);
    if (owner) {
      await database('service_visits').where({ id: packet.visit_id }).update({ billing_hold: true, updated_at: database.fn.now() });
      payment = { ...payment, state: 'office_required', reason: 'payer_assigned', payerId: owner };
    } else {
      await database('invoices').where({ id: payment.invoiceId, status: 'draft', visit_completion_packet_id: packet.id })
        .whereNull('payer_id').whereNull('payer_statement_id').update({
          status: 'scheduled', scheduled_send_at: database.fn.now(), scheduled_send_attempts: 0,
          updated_at: database.fn.now(),
        });
    }
  }
  let delivery = await Summary.deliverVisitCompletionSummary(packet.id, token, database);
  // Canonical completion gives these two effects different eligibility: a
  // card mints for every performed, non-internal-only completion (a backfill
  // mints silently), while a referral credit excludes backfills but not an
  // internal-only report posture. Both helpers own their single-use guards.
  const recorded = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where('i.packet_id', packet.id).where('r.status', 'completed')
    .orderBy('s.window_start').orderBy('s.id')
    .select('s.id', 's.customer_id', 's.is_recurring', 's.recurring_pattern', 'r.id as record_id', 'r.structured_notes', 'r.service_date');
  const notesOf = (member) => (typeof member.structured_notes === 'string'
    ? JSON.parse(member.structured_notes) : member.structured_notes) || {};
  const performed = (member) => !['inspection_only', 'customer_declined', 'incomplete'].includes(notesOf(member).visitOutcome || 'completed');
  const backfill = (member) => notesOf(member).backfill === true;
  const internalOnly = (member) => notesOf(member).internalOnlyCompletion === true
    || (notesOf(member).internalOnlyCompletion === undefined && notesOf(member).typedReportDelivery === 'disabled');
  const cardMember = recorded.find((member) => performed(member) && !internalOnly(member));
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
  // Review outreach follows the summary: enrollment waits until every
  // requested delivery leg has settled and never runs for an uncertain one.
  const reviewEnrollment = delivery.state === 'delivered'
    ? await enrollVisitCompletionReview(packet.id, database, { deliverySettled: true })
    : { enrolled: false, reason: delivery.state };
  const paymentPending = ['payment_pending', 'processing'].includes(payment.state);
  const pending = paymentPending || delivery.state === 'delivery_pending' || reviewEnrollment.retryable === true;
  const review = payment.state === 'office_required' || delivery.state === 'delivery_review';
  let recovered = false;
  if (!pending) await database.transaction(async (trx) => {
    const visit = await trx('service_visits').where({ id: packet.visit_id }).first();
    await trx('customers').where({ id: visit.customer_id }).forNoKeyUpdate().first('id');
    await lockStop(trx, visit.stop_base_key);
    await trx('service_visits').where({ id: visit.id }).forUpdate().first('id');
    const locked = await trx('visit_completion_packets').where({ id: packet.id }).forUpdate().first();
    if (locked.status !== 'done') {
      // The delivery effects are re-read under this lock. A recovery that
      // settled the uncertain summary since the delivery read must not be
      // closed over with the stale result (the packet stays on the recovery
      // queue), and a bounce that arrived since must close for office review
      // with its parked outreach rather than as a clean completion.
      const uncertainNow = await trx('visit_effects').where({ visit_id: packet.visit_id })
        .whereIn('effect_type', ['completion_sms', 'completion_email']).where({ status: 'unknown_delivery' }).first('id');
      if (delivery.state === 'delivery_review' && !uncertainNow) {
        recovered = true;
        await trx('visit_completion_packets').where({ id: packet.id })
          .update({ status: 'processing', error: 'review_enrollment_pending', updated_at: trx.fn.now() });
        return;
      }
      if (uncertainNow && delivery.state === 'delivered') {
        delivery = { ...delivery, state: 'delivery_review' };
        // Outreach enrolled a moment ago, before the bounce, is parked too.
        await Summary.parkVisitReviewOutreach(packet.id, trx);
      }
      const closeReview = payment.state === 'office_required' || delivery.state === 'delivery_review';
      if (closeReview) {
        const member = await trx('scheduled_services').where({ id: items[0].scheduled_service_id }).first();
        await require('./dispatch-alerts').createAlert({
          type: 'visit_closeout_review', severity: 'warn', techId: member.technician_id, jobId: member.id, trx,
          payload: { visitId: packet.visit_id, packetId: packet.id, payment: payment.state, delivery: delivery.state },
        });
      }
      await trx('visit_completion_packets').where({ id: packet.id }).update({
        status: 'done', error: closeReview ? JSON.stringify({ payment: payment.state, delivery: delivery.state }) : null,
        updated_at: trx.fn.now(),
      });
      // A recovery reopens only the packet: a visit that already closed keeps
      // its original closure time and reason.
      await trx('service_visits').where({ id: packet.visit_id }).update({
        status: 'closed', closed_at: trx.raw('COALESCE(closed_at, NOW())'),
        close_reason: trx.raw('COALESCE(close_reason, ?)', [closeReview ? 'office_review' : 'completed']), updated_at: trx.fn.now(),
      });
    }
  });
  const finalState = recovered ? 'effects_pending' : pending ? 'effects_pending'
    : (payment.state === 'office_required' || delivery.state === 'delivery_review') ? 'office_required' : 'done';
  return { status: pending || recovered ? 202 : 200, body: {
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
  const query = database('invoices').where({ status: 'sending' }).whereNotNull('visit_completion_packet_id').whereNull('payer_id');
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

// Holds FOR SHARE every payer row the live Bill-To resolution for this
// packet can consult (the customer default and each billed member's per-job
// payer), so a payer activation — which changes that resolution without
// writing a customer or member row — waits for the send claim to commit and
// then sees it in flight.
async function lockPacketPayerRows(packetId, trx) {
  const packet = await trx('visit_completion_packets').where({ id: packetId }).first('visit_id', 'payload');
  if (!packet) return [];
  const visit = await trx('service_visits').where({ id: packet.visit_id }).first('customer_id');
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
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
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
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
    if (reopened !== 0) return { enrolled: false, retryable: true, reason: 'error', error: err.message, reopened: reopened > 0 };
    // A reopen that ran and touched no packet means either no packet owns
    // this invoice or the owning packet is terminal (the office holds a
    // failed one). Only the first hands the review to the legacy
    // representative-record path; the link is re-read to tell them apart.
    try {
      packetId = (await database('invoices').where({ id: invoiceId }).first('visit_completion_packet_id'))?.visit_completion_packet_id;
    } catch (again) {
      return { enrolled: false, retryable: true, reason: 'error', error: again.message, reopened: false };
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
    const reopened = Number(await database('visit_completion_packets').where({ id: packetId })
      .whereIn('status', ['done', 'processing'])
      .update({ status: 'processing', error: 'review_enrollment_pending', updated_at: database.fn.now() }));
    if (!reopened) return { enrolled: false, reason: 'packet_owned', error: err.message };
    return { enrolled: false, retryable: true, reason: 'error', error: err.message };
  }
}

async function enrollVisitCompletionReviewOnce(packetId, database = db, { deliverySettled = false } = {}) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  if (!packet) return { enrolled: false, reason: 'packet_missing' };
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
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
  if (result?.started === false && ['plan_resolution_failed', 'error'].includes(result.reason)) {
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

module.exports = { packetInvoiceSendInFlight, lockPacketPayerRows, liveThirdPartyPayerForPacket, enrollVisitCompletionReviewForInvoice, saveVisitCompletionPacket, runVisitCompletionPacketMemberEffects, runVisitCompletionPacketEffects, enrollVisitCompletionReview, resumePendingVisitCompletions };
