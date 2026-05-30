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

// Statuses we will not re-transition out of. A re-recap on an already
// completed visit still updates the record + can re-send, but never
// regresses the status machine.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'skipped']);

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
    existingRecord: existingRecord || null,
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

  if (clientPestRating != null
    && (!Number.isInteger(clientPestRating) || clientPestRating < 0 || clientPestRating > 5)) {
    return { ok: false, reason: 'client_pest_rating_invalid' };
  }

  const note = typeof technicianNotes === 'string' ? technicianNotes.trim() : '';
  const recapText = typeof customerRecap === 'string' ? customerRecap.trim() : '';
  const serviceDate = svc.scheduled_date ? String(svc.scheduled_date).split('T')[0] : etDateString();
  const fromStatus = svc.status;
  // transitionedBy FKs technicians(id) ON DELETE SET NULL — only a tech
  // actor has a valid id; admin operators pass null.
  const transitionedBy = actorType === 'tech' ? (actorId || null) : null;

  let recordId;
  await knex.transaction(async (trx) => {
    // 1. Status -> completed (skip if already terminal; recap is idempotent).
    if (!TERMINAL_STATUSES.has(fromStatus)) {
      await transitionJobStatus({
        jobId: serviceId,
        fromStatus,
        toStatus: 'completed',
        transitionedBy,
        trx,
      });
    }

    // 2. Upsert the service_records row keyed by the direct FK.
    const existing = await trx('service_records')
      .where({ scheduled_service_id: serviceId })
      .orderBy('created_at', 'desc')
      .first('id');

    if (existing) {
      await trx('service_records').where({ id: existing.id }).update({
        technician_notes: note || null,
        status: 'completed',
        ...(clientPestRating != null ? { client_pest_rating: clientPestRating } : {}),
        updated_at: new Date(),
      });
      recordId = existing.id;
      // Replace prior recap product rows so an edited selection is not additive.
      await trx('service_products').where({ service_record_id: recordId }).del();
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
        field_flags: JSON.stringify({ recap: true, recap_source: actorType || 'admin' }),
      }).returning('id');
      recordId = inserted[0]?.id || inserted[0];
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
    if (productRows.length) await trx('service_products').insert(productRows);
  });

  // 4. Customer-facing track_state -> complete (best-effort, post-trx).
  let trackCompleted = false;
  try {
    const tr = await trackTransitions.markComplete(serviceId, { actorType, actorId });
    trackCompleted = !!tr?.ok;
  } catch (err) {
    logger.warn(`[pest-recap] markComplete failed for ${serviceId}: ${err.message}`);
  }

  // 5. Optional customer recap SMS.
  let smsSent = false;
  let smsError = null;
  if (sendSms && recapText && svc.cust_phone) {
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
  } else if (sendSms && recapText && !svc.cust_phone) {
    smsError = 'no_phone';
  }

  logger.info(
    `[pest-recap] recap committed service=${serviceId} record=${recordId} `
    + `actor=${actorType} products=${Array.isArray(products) ? products.length : 0} `
    + `smsSent=${smsSent}${smsError ? ` smsError=${smsError}` : ''}`,
  );

  return { ok: true, recordId, completed: true, trackCompleted, smsSent, smsError };
}

module.exports = {
  PEST_CONTROL_CATEGORY,
  resolveEligibility,
  buildRecapContext,
  draftRecapMessage,
  submitRecap,
};
