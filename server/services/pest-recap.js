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
const { generateRecap, smsRecap } = require('./completion-recap');
const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
const { invalidateServiceReportPdfCache } = require('./service-report/pdf-storage');
const { isValidRateUnit } = require('./inventory-units');
const { etDateString } = require('../utils/datetime-et');

const PEST_CONTROL_CATEGORY = 'pest_control';

// A re-recap on an already-`completed` visit is idempotent: skip the
// status transition but still refresh the record (and re-send if asked).
const COMPLETED_STATUS = 'completed';

// `cancelled`/`skipped` visits are NOT completable. A recap on them must be
// rejected before any artifact is written — otherwise we'd emit a
// "completed" service_records row, mark the tracker complete, and text the
// customer for a visit the status machine says never happened (Codex P1).
const NON_COMPLETABLE_STATUSES = new Set(['cancelled', 'skipped', 'no_show']);

// A visit already closed as NOT performed — status 'incomplete', or an
// inspection-only / customer-declined visitOutcome recorded by the heavy
// /complete path — must NOT earn a referral credit if it's later recapped: the
// recap re-completes the record, but the service was never actually delivered.
const NON_PERFORMED_VISIT_OUTCOMES = new Set(['inspection_only', 'customer_declined', 'incomplete']);

// service_records.structured_notes is jsonb in prod but may surface as a
// string depending on driver config — mirror admin-dispatch's tolerant parse.
function parseStructuredNotes(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

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
  // Typed specialty services (profile findingsType set post-cutover) must
  // complete through the typed completion form — the recap has no findings
  // validation, billing gate, or customer-copy snapshot. Same rule the
  // /complete endpoint enforces (typed_recap_not_allowed). Project-backed
  // profiles (project_required / special_project) are likewise excluded:
  // those services must close through their project, and the recap would
  // skip that billing/artifact path entirely.
  const eligible = profile?.category === PEST_CONTROL_CATEGORY
    && !profile?.findingsType
    && !profile?.projectBacked
    && !profile?.requiresProject;
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
    .select(
      'id', 'name', 'category', 'active_ingredient', 'moa_group',
      // Rate-prefill inputs: the modal computes the same prefill as
      // CompletionPanel (per-1,000 verified rate first, else the per-basis
      // display default's low bound) and shows it as an EDITABLE field —
      // the persisted rate is technician-confirmed, never a silent default.
      // application_method is a prefill INPUT too (codex P1 r7): an
      // explicit catalog method (e.g. foliar_spray) suppresses the pest
      // perimeter-spray inference and with it the 4-oz house default —
      // omitting it here would feed the shared resolver different inputs
      // than CompletionPanel receives.
      'default_rate', 'default_unit', 'rate_unit', 'default_rate_per_1000',
      'application_method',
    )
    .catch(() => []);

  const existingRecord = await knex('service_records')
    .where({ scheduled_service_id: serviceId })
    .orderBy('created_at', 'desc')
    .first('id', 'technician_notes', 'status')
    .catch(() => null);

  // Products already recorded on the existing record, so reopening a recap
  // shows (and preserves) the chemicals already applied instead of starting
  // from an empty selection. A FAILED load is not an empty list (codex P1,
  // PR #3419 r13): the flag tells the modal its picker cannot speak for
  // the recorded set, so it must not submit an authoritative
  // (productsConfirmed) replacement that would erase and retract real
  // applications over a transient error.
  let productsLoadFailed = false;
  const existingProducts = existingRecord
    ? await knex('service_products')
      .where({ service_record_id: existingRecord.id })
      .select('product_name', 'product_category', 'active_ingredient', 'moa_group', 'application_rate', 'rate_unit')
      .catch(() => {
        productsLoadFailed = true;
        return [];
      })
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
    existingRecord: existingRecord
      ? { ...existingRecord, products: existingProducts, productsLoadFailed }
      : null,
  };
}

/** Draft the customer-facing recap SMS copy via the shared recap generator. */
async function draftRecapMessage({ serviceId, technicianNotes, areasTreated, products = [], includeCustomerComms = false, knex = db }) {
  const { ok, reason, svc, eligible } = await resolveEligibility(serviceId, knex);
  if (!ok) return { ok: false, reason };
  if (!eligible) return { ok: false, reason: 'not_pest_control' };

  // F2 (ratified Q13): opt-in windowed comms context. resolveEligibility
  // already bound this call to the service, and the route's ownership guard
  // gates the caller — the context is scoped to this service's customer.
  let commsContext = '';
  if (includeCustomerComms === true && svc.customer_id) {
    try {
      const { buildCompletionCommsContext } = require('./completion-comms-context');
      const comms = await buildCompletionCommsContext({
        customerId: svc.customer_id,
        scheduledServiceId: svc.id,
        knex,
      });
      if (comms.text) commsContext = `${comms.promptHint}\n${comms.text}`;
    } catch (err) {
      logger.warn(`[pest-recap] comms context failed: ${err.message}`);
    }
  }

  // Season/weather/expectations context (owner directive 2026-07-21).
  let visitContext = '';
  try {
    const { buildRecapVisitContext } = require('./recap-visit-context');
    visitContext = await buildRecapVisitContext({
      serviceType: svc.service_type,
      customerId: svc.customer_id,
      knex,
    });
  } catch { /* context is polish — never block the draft */ }

  const { recap, source } = await generateRecap({
    serviceType: svc.service_type,
    technicianNotes,
    areasTreated,
    // Tech-chosen solutions feed the AI prompt (context only — the recap
    // rules keep product names out of the customer copy).
    products,
    visitOutcome: 'completed',
    commsContext,
    visitContext,
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
  // Modern clients set true: the submitted product SET is deliberate, so
  // an empty set is a full deselection (clear the recorded applications),
  // not a legacy resend-only omission (codex P1 r11).
  productsConfirmed = false,
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
  // Set under the lock when the heavy /complete flow already texted this
  // customer its templated completion SMS (structured_notes claim). The
  // recap text and the completion SMS are two wordings of the same
  // "service done" message — sending both double-texts the customer.
  let completionSmsAlreadySent = false;
  // Set under the lock if the visit can't be recapped (cancelled/skipped);
  // the transaction aborts having written nothing and we return ok:false.
  let rejectReason = null;
  // Set under the lock if the existing record shows the visit was NOT performed
  // (incomplete / inspection-only / customer-declined) — gates the referral credit.
  let recapPriorNonPerformed = false;
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
      .first('id', 'status', 'scheduled_date', 'service_id', 'service_type');
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
      .first('id', 'status', 'recap_sms_sent_at', 'structured_notes', 'service_data');

    // At-most-once recap text: claim recap_sms_sent_at here, inside the
    // lock. If a prior submit already sent (column set), this one skips —
    // so a double-tap/retry/race never re-texts the customer, while a
    // record whose claim is still NULL (e.g. completed earlier via the
    // heavy /complete path WITHOUT a text) can still send. When that
    // /complete path DID text (completionSmsStatus claim in
    // structured_notes), the recap must not send a second, differently
    // worded completion message. A fresh 'sending' status counts too —
    // /complete writes it before the provider call, so a recap landing in
    // that window would double-text once the in-flight send delivers.
    // The 10-minute freshness window mirrors /complete's own
    // completionSmsSendingFresh guard: a stale 'sending' (crashed
    // mid-send) does not suppress, the same way /complete itself treats
    // it as retryable. If the in-flight send ultimately fails, /complete
    // overwrites the status with 'failed'/'blocked' and a recap re-submit
    // is then allowed to text.
    const existingNotes = parseStructuredNotes(existing?.structured_notes);
    // The recap is about to overwrite this record to 'completed' below. If it
    // currently reflects a NOT-performed visit (incomplete status, or a non-
    // performed visitOutcome recorded by /complete — preserved here because the
    // recap update never rewrites structured_notes), block the referral credit so
    // a recap resubmit can't reward a service that was never delivered.
    recapPriorNonPerformed = existing?.status === 'incomplete'
      || NON_PERFORMED_VISIT_OUTCOMES.has(String(existingNotes.visitOutcome || ''));
    const completionSmsAttemptedAtMs = existingNotes.completionSmsAttemptedAt
      ? new Date(existingNotes.completionSmsAttemptedAt).getTime()
      : 0;
    const completionSmsSendingFresh = existingNotes.completionSmsStatus === 'sending'
      && completionSmsAttemptedAtMs
      && Date.now() - completionSmsAttemptedAtMs < 10 * 60 * 1000;
    completionSmsAlreadySent = existingNotes.completionSmsStatus === 'sent'
      || !!existingNotes.sentSmsBody
      || completionSmsSendingFresh;
    const alreadyTexted = !!existing?.recap_sms_sent_at || completionSmsAlreadySent;
    willSendSms = wantSms && !alreadyTexted;
    const smsClaim = willSendSms ? { recap_sms_sent_at: new Date() } : {};

    // Trace-identity freeze, same as the full /complete handler (codex
    // P2 on #3189): this lightweight path also completes permanent report
    // records, and without the frozen identities a later update-details
    // edit would re-resolve the mutable schedule rows. Computed for BOTH
    // branches (codex P2 r19): a recap that completes a pre-existing
    // draft/legacy record must freeze too, merging only when the fields
    // are absent so an earlier full completion's freeze is never
    // overwritten. Fail-soft — a lookup error omits the fields.
    let frozenTraceIdentity = {};
    try {
      const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
      // Resolve from the LOCKED row's identity (codex P2 r20): an
      // update-details transaction can repoint service_id/service_type
      // between the pre-lock read and this lock — the freeze must record
      // the service that is actually completing.
      const lockedIdentity = locked
        ? { id: serviceId, service_id: locked.service_id, service_type: locked.service_type }
        : svc;
      const recapProfile = await resolveCompletionProfileForScheduledService(lockedIdentity, trx);
      // Lines freeze their key + findings pointer too (codex P2 r21) —
      // shared freezer, same fail-soft posture as the /complete path.
      const { frozenAddonLinesForCompletion } = require('./service-report/trace-eligibility');
      const recapAddonLines = await frozenAddonLinesForCompletion(serviceId, trx).catch(() => null);
      // The freeze must be SAFE for the key's classification family —
      // typed and pointer-required keys stay live-resolvable without
      // their pointer, same as the /complete path (codex P2 r28/r29).
      const { primaryIdentityFreezable } = require('./service-report/trace-eligibility');
      frozenTraceIdentity = {
        ...(!primaryIdentityFreezable(recapProfile || {})
          ? {}
          : {
            completedServiceKey: recapProfile?.serviceKey || null,
            completedServiceName: (locked ? locked.service_type : svc.service_type) || null,
          }),
        ...(Array.isArray(recapAddonLines)
          ? { completedAddonLines: recapAddonLines }
          : {}),
      };
    } catch { /* legacy live-row behavior */ }

    if (existing) {
      let mergedServiceData;
      try {
        const existingData = typeof existing.service_data === 'string'
          ? JSON.parse(existing.service_data || '{}')
          : (existing.service_data || {});
        // Fields merge INDEPENDENTLY (codex P2 r28): a /complete whose
        // add-on freezer transiently failed leaves completedServiceKey
        // present but completedAddonLines absent — the recap fills only
        // what is missing, never overwriting an existing freeze.
        const missing = {};
        if (!Object.prototype.hasOwnProperty.call(existingData, 'completedServiceKey')
          && Object.prototype.hasOwnProperty.call(frozenTraceIdentity, 'completedServiceKey')) {
          missing.completedServiceKey = frozenTraceIdentity.completedServiceKey;
          missing.completedServiceName = frozenTraceIdentity.completedServiceName;
        }
        if (!Object.prototype.hasOwnProperty.call(existingData, 'completedAddonLines')
          && Object.prototype.hasOwnProperty.call(frozenTraceIdentity, 'completedAddonLines')) {
          missing.completedAddonLines = frozenTraceIdentity.completedAddonLines;
        }
        if (Object.keys(missing).length) {
          mergedServiceData = JSON.stringify({ ...existingData, ...missing });
        }
      } catch { /* leave service_data untouched */ }
      await trx('service_records').where({ id: existing.id }).update({
        technician_notes: note || null,
        status: 'completed',
        ...(mergedServiceData ? { service_data: mergedServiceData } : {}),
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
        ...(Object.keys(frozenTraceIdentity).length
          ? { service_data: JSON.stringify(frozenTraceIdentity) }
          : {}),
        ...(clientPestRating != null ? { client_pest_rating: clientPestRating } : {}),
        ...smsClaim,
        field_flags: JSON.stringify({ recap: true, recap_source: actorType || 'admin' }),
      }).returning('id');
      recordId = inserted[0]?.id || inserted[0];
      createdRecord = true;
    }

    // 3. service_products for the chemicals the tech selected. The rate is
    // TECHNICIAN-CONFIRMED: the recap modal collects it in an editable field
    // (prefilled from the catalog default, same computation as
    // CompletionPanel) and submits it per product. The server records only a
    // submitted rate — it never writes a catalog default as an observed
    // application (codex P1 r5): application_rate feeds the compliance
    // ledger and application-limit math, which read it as ground truth.
    const productEntries = (Array.isArray(products) ? products : [])
      .map((p) => {
        const rate = p.application_rate != null && p.application_rate !== ''
          ? Number(p.application_rate)
          : null;
        const unit = String(p.rate_unit || '').trim();
        return {
          // Modern clients send the selected catalog row's id and
          // rate_confirmed: true. Both are validated/consumed server-side
          // below — neither is trusted as-is (codex P1s r9).
          submittedProductId: p.product_id != null ? String(p.product_id) : null,
          rateConfirmed: p.rate_confirmed === true,
          row: {
            service_record_id: recordId,
            product_name: String(p.product_name || p.name || '').slice(0, 150),
            product_category: p.product_category || p.category || null,
            active_ingredient: p.active_ingredient || null,
            moa_group: p.moa_group || null,
            notes: p.notes || null,
            ...(Number.isFinite(rate) && rate > 0 && unit
              ? { application_rate: rate, rate_unit: unit.slice(0, 50) }
              : {}),
          },
        };
      })
      .filter((e) => e.row.product_name);
    const productRows = productEntries.map((e) => e.row);
    // Replace product rows only when this submit specifies a set, so an
    // explicit re-selection isn't additive. An EMPTY submission from a
    // legacy client must not wipe the recorded applications (resend-only
    // reopen). A modern client marks its set deliberate with
    // productsConfirmed, so a CONFIRMED empty set is a full deselection
    // (codex P1 r11): the recorded rows are cleared and every attributable
    // ledger row retracted, same as deselecting them one by one.
    const confirmedEmptyReplace = productsConfirmed === true
      && productRows.length === 0
      && Array.isArray(products)
      && !createdRecord;
    if (productRows.length || confirmedEmptyReplace) {
      // Resolve each submitted catalog id to a REAL catalog row before
      // anything is persisted (codex P1 r9): the exact id keys the
      // compliance ledger identity, so a name-pattern fallback ("Advion
      // Cockroach Gel" ilike-matching "Advion Cockroach Gel Bait") is used
      // only for payloads without an id. id::text comparison so a garbage
      // id from an arbitrary caller can't throw a cast error mid-trx.
      const hasProductIdCol = await trx.schema
        .hasColumn('service_products', 'product_id')
        .catch(() => false);
      const hasMethodCol = await trx.schema
        .hasColumn('service_products', 'application_method')
        .catch(() => false);
      for (const entry of productEntries) {
        // Rate units share the /complete allowlist (codex P1 r11): a
        // typo'd or unsupported unit from a stale client or direct API
        // caller must not reach service_products or the FDACS ledger.
        if (entry.row.rate_unit && !isValidRateUnit(entry.row.rate_unit)) {
          const err = new Error(`Invalid product unit for ${entry.row.product_name}`);
          err.isOperational = true;
          err.statusCode = 400;
          throw err;
        }
        if (entry.submittedProductId == null) continue;
        const catalog = await trx('products_catalog')
          .whereRaw('id::text = ?', [entry.submittedProductId])
          .first('id', 'name', 'category', 'active_ingredient', 'moa_group', 'application_method', 'active');
        // A supplied id that doesn't resolve is REJECTED, not silently
        // demoted to the name path (codex P1 r11) — same contract as the
        // /complete validation; the id-less legacy path stays for
        // payloads that never sent one. The throw rolls the trx back.
        if (!catalog) {
          const err = new Error(`Product not found: ${entry.submittedProductId}`);
          err.isOperational = true;
          err.statusCode = 400;
          throw err;
        }
        if (catalog.active === false) {
          const err = new Error(`Product is inactive: ${catalog.name}`);
          err.isOperational = true;
          err.statusCode = 400;
          throw err;
        }
        entry.catalogId = catalog.id;
        if (hasProductIdCol) entry.row.product_id = entry.catalogId;
        // Bind the persisted row's metadata to the VALIDATED catalog row
        // (codex P1 r10) — the compliance writer resolves EPA/AI facts
        // from the id, so the displayed name/category must come from the
        // same row, not from caller-supplied fields that may be stale.
        // Same authority order as the /complete path.
        if (catalog.name) entry.row.product_name = String(catalog.name).slice(0, 150);
        entry.row.product_category = catalog.category ?? entry.row.product_category;
        entry.row.active_ingredient = catalog.active_ingredient ?? entry.row.active_ingredient;
        entry.row.moa_group = catalog.moa_group ?? entry.row.moa_group;
        // An explicit catalog method is a truthful application detail
        // (codex P1 r10: the FDACS row otherwise records no method).
        // Methodless products stay null — null is "not recorded"; a
        // fabricated method would be a false field observation.
        if (catalog.application_method && hasMethodCol) {
          entry.row.application_method = catalog.application_method;
        }
      }
      // A re-submitted product with NO rate from a client that did NOT
      // confirm the field state (older client, API caller) keeps the rate
      // already recorded for it: the previously observed value outranks
      // absence and must survive the replace-not-merge delete below. A
      // rate-less row WITH rate_confirmed is a deliberate clear (codex P1
      // r9) — the tech removed a wrong rate, so nothing is restored.
      const rateless = productEntries
        .filter((e) => e.row.application_rate == null && !e.rateConfirmed)
        .map((e) => e.row);
      if (rateless.length && !createdRecord) {
        const priorRows = await trx('service_products')
          .where({ service_record_id: recordId })
          .select('product_name', 'application_rate', 'rate_unit')
          .catch(() => []);
        const priorByName = new Map(
          (Array.isArray(priorRows) ? priorRows : [])
            .filter((r) => r.application_rate != null)
            .map((r) => [String(r.product_name || '').trim().toLowerCase(), r]),
        );
        for (const row of rateless) {
          const prior = priorByName.get(String(row.product_name).trim().toLowerCase());
          if (prior) {
            row.application_rate = prior.application_rate;
            row.rate_unit = prior.rate_unit;
          }
        }
      }
      // Product-less legacy ledger rows (product_id NULL — a supported
      // legacy state in the FDACS writer) are reachable ONLY through
      // their service_product_id link, which the delete below SET-NULLs.
      // Capture them WITH their source row's product name BEFORE the FK
      // link is erased (codex P1 r14) so the replace can reconcile them:
      // a same-name replacement row re-adopts its legacy row (one record,
      // no second identified row minted beside it), and an authoritative
      // set retracts the leftovers like any other deselected application
      // — the retraction sweep's product_id predicate can't reach them.
      const legacyLedgerRows = createdRecord
        ? []
        : await trx('property_application_history')
          .leftJoin('service_products', 'property_application_history.service_product_id', 'service_products.id')
          .where('property_application_history.service_record_id', recordId)
          .whereNull('property_application_history.product_id')
          .whereNotNull('property_application_history.service_product_id')
          .select('property_application_history.id as ledger_id', 'service_products.product_name');
      const legacyByName = new Map();
      for (const row of (Array.isArray(legacyLedgerRows) ? legacyLedgerRows : [])) {
        const name = String(row.product_name || '').trim().toLowerCase();
        if (name && !legacyByName.has(name)) legacyByName.set(name, row.ledger_id);
      }
      // An AUTHORITATIVE set (productsConfirmed) replaces everything; an
      // UNCONFIRMED set replaces only the rows it names — a recorded
      // product the client could not represent (inactive/renamed, so the
      // modal cleared productsConfirmed) must survive a partial resubmit
      // (codex P1 r12), keeping both its service_products row and its
      // live ledger link.
      if (productsConfirmed === true) {
        await trx('service_products').where({ service_record_id: recordId }).del();
      } else {
        await trx('service_products')
          .where({ service_record_id: recordId })
          .whereRaw('LOWER(TRIM(product_name)) = ANY(?::text[])', [
            productRows.map((r) => String(r.product_name).trim().toLowerCase()),
          ])
          .del();
      }
      const insertedProducts = productRows.length
        ? await trx('service_products')
          .insert(productRows)
          .returning(['id', 'product_name', 'application_rate', 'rate_unit'])
        : [];
      // The delete above SET-NULLs the compliance ledger's
      // (property_application_history) service_product_id link, and the
      // ledger's stable (service_record_id, product_id) identity makes
      // createComplianceRecords skip — not replace — these applications on
      // any later run. A recap that edits a recorded rate must not leave
      // the ledger (the DACS inspector export and application-limit caps
      // read it as ground truth) holding the stale value (codex P1 r7):
      // re-link each replacement row to its ledger row and sync the
      // recorded rate, in the same trx as the replace so the report and
      // the ledger can never diverge. The validated exact catalog id wins;
      // the ledger writer's name resolution is the id-less fallback. A
      // rate-less row from a legacy client leaves the ledger rate standing
      // (absence never erases an observed value); a CONFIRMED clear (codex
      // P1 r9) clears the ledger rate with it.
      const linkedCatalogIds = [];
      const insertedList = Array.isArray(insertedProducts) ? insertedProducts : [];
      for (let i = 0; i < insertedList.length; i += 1) {
        const sp = insertedList[i];
        // returning() preserves insert order, so the entry metadata
        // (validated catalog id, rate_confirmed) pairs by index.
        const entry = productEntries[i] || {};
        if (!sp?.id || !sp.product_name) continue;
        let ledgerProductId = entry.catalogId ?? null;
        if (ledgerProductId == null) {
          const catalog = await trx('products_catalog')
            .where('name', 'ilike', `%${sp.product_name}%`)
            .first('id');
          ledgerProductId = catalog?.id ?? null;
        }
        const ledgerSyncPatch = {
          service_product_id: sp.id,
          // Re-selecting a previously deselected product un-retracts
          // its ledger row — the re-link IS the correction record.
          retracted_at: null,
          retraction_reason: null,
          // The validated catalog method reaches EXISTING ledger rows
          // too (codex P1 r12) — createComplianceRecords skips the
          // stable (service_record_id, product_id) row, so this sync is
          // the only writer that can refresh its method.
          ...(entry.row && entry.row.application_method
            ? { application_method: entry.row.application_method }
            : {}),
          ...(sp.application_rate != null
            ? { application_rate: sp.application_rate, rate_unit: sp.rate_unit || null }
            : entry.rateConfirmed
              ? { application_rate: null, rate_unit: null }
              : {}),
        };
        let synced = 0;
        if (ledgerProductId != null) {
          linkedCatalogIds.push(ledgerProductId);
          synced = await trx('property_application_history')
            .where({ service_record_id: recordId, product_id: ledgerProductId })
            .update(ledgerSyncPatch);
        }
        // No identified ledger row took the sync — re-adopt a captured
        // product-less legacy row of the same name instead (codex P1
        // r14): the legacy row stays THE record of this application, and
        // createComplianceRecords sees it linked so it never mints a
        // second identified row beside it.
        const legacyKey = String(sp.product_name).trim().toLowerCase();
        const legacyId = legacyByName.get(legacyKey);
        if (!synced && legacyId != null) {
          legacyByName.delete(legacyKey);
          await trx('property_application_history')
            .where({ id: legacyId })
            .update(ledgerSyncPatch);
        }
      }
      // Deselected products (codex P1 r9): the replace removed their
      // service_products rows, so their ledger rows still carry a NULL
      // link after the re-link pass above. RETRACT them — never delete
      // (codex P1 r10): the ledger is append-safe by design (the FK is ON
      // DELETE SET NULL so rows survive product replacement), so the row
      // stays as the auditable record of the correction while compliance
      // reporting and application-limit totals (which filter
      // retracted_at) mirror the corrected record. Rows with no catalog
      // product are left standing: they can't be attributed to a specific
      // product, and an unmatched-name replacement row keeps such a row
      // as the record of its application. Only an AUTHORITATIVE set may
      // retract (codex P1 r12) — an unconfirmed partial submit preserved
      // its unmatched rows above, so absence from it proves nothing.
      if (productsConfirmed === true) {
        let staleLedgerQuery = trx('property_application_history')
          .where({ service_record_id: recordId })
          .whereNull('service_product_id')
          .whereNotNull('product_id')
          .whereNull('retracted_at');
        if (linkedCatalogIds.length) {
          staleLedgerQuery = staleLedgerQuery.whereNotIn('product_id', linkedCatalogIds);
        }
        await staleLedgerQuery.update({
          retracted_at: new Date(),
          retraction_reason: 'recap_deselected',
        });
        // Captured product-less rows no replacement re-adopted: their
        // source row was deleted and the authoritative set does not
        // contain them — retract them like any other deselected
        // application (codex P1 r14).
        const leftoverLegacyIds = [...legacyByName.values()];
        if (leftoverLegacyIds.length) {
          await trx('property_application_history')
            .whereIn('id', leftoverLegacyIds)
            .whereNull('service_product_id')
            .whereNull('retracted_at')
            .update({
              retracted_at: new Date(),
              retraction_reason: 'recap_deselected',
            });
        }
      }
      // A first-time recap completion (never through /complete) has NO
      // ledger rows for the update above to hit — the recap was the only
      // completion path that skipped the FDACS writer entirely (codex P1
      // r8). Run the shared idempotent writer after the sync, in the same
      // trx: rows the loop just re-linked are already ledgered (unique
      // service_product_id / stable record+product identity) and are
      // skipped; anything new — a fresh recap completion, a product added
      // on an edit — gets its compliance row with the recap's
      // technician-confirmed rate.
      if (productRows.length) {
        const ComplianceService = require('./compliance');
        await ComplianceService.createComplianceRecords(recordId, { trx });
      }
    }

    // Re-completing an EXISTING record rewrites its notes / rating / products —
    // all of which the service report renders — so drop any cached PDF for it.
    // The report cache key is content-insensitive, so without this the next
    // view/email would serve the pre-edit PDF. New records have no cached PDF.
    if (existing) {
      await invalidateServiceReportPdfCache(recordId, trx);
    }
  });

  // Cancelled/skipped visit: nothing was written, skip all completion
  // side effects (track-complete, SMS) and report the rejection.
  if (rejectReason) {
    logger.info(`[pest-recap] recap rejected service=${serviceId} reason=${rejectReason}`);
    return { ok: false, reason: rejectReason };
  }

  // Referral reward: a recap completes a PERFORMED visit (we're past the
  // cancelled/skipped reject guard above), so a referred customer's first
  // *recurring* service can land here. The helper re-confirms THIS visit is
  // recurring — a one-time pest visit never qualifies — and handles idempotency
  // itself. Best-effort; never blocks. Skip when the recap is re-completing a
  // visit that was previously recorded as NOT performed (incomplete / inspection /
  // declined) — re-completing it must not mint a reward for a service never done.
  if (!recapPriorNonPerformed) {
    try {
      const referralEngine = require('./referral-engine');
      await referralEngine.creditReferralOnFirstService({ customerId: svc.customer_id, serviceId });
    } catch (referralErr) {
      logger.warn(`[pest-recap] referral first-service credit failed for customer=${svc.customer_id}: ${referralErr.message}`);
    }
    // Same performed-visit signal as the referral credit: convert the
    // originating lead to won if it's still open. Best-effort + idempotent;
    // only matches never-converted leads.
    try {
      const { convertLeadFromEvent } = require('./lead-estimate-link');
      await convertLeadFromEvent({ source: 'service_completed', customerId: svc.customer_id });
    } catch (leadErr) {
      logger.warn(`[pest-recap] lead conversion failed for customer=${svc.customer_id}: ${leadErr.message}`);
    }
  }

  // 4. Customer-facing track_state -> complete (best-effort, post-trx).
  let trackCompleted = false;
  try {
    const tr = await trackTransitions.markComplete(serviceId, { actorType, actorId });
    trackCompleted = !!tr?.ok;
  } catch (err) {
    logger.warn(`[pest-recap] markComplete failed for ${serviceId}: ${err.message}`);
  }

  // 4b. One-time card-on-file hold: the recap path completes WITHOUT invoicing,
  // so a held card would otherwise never be charged. For a held card-hold job
  // only, this mints the completion invoice from the recap's service record and
  // charges the saved card. Dark until ONE_TIME_CARD_HOLD; no-op when no hold
  // exists (normal recaps stay no-bill). Best-effort — never blocks the recap.
  try {
    const CardHolds = require('./estimate-card-holds');
    const holdResult = await CardHolds.chargeCardHoldForRecapCompletion({
      scheduledServiceId: serviceId,
      serviceRecordId: recordId,
      // A re-completed NOT-performed visit (incomplete / inspection-only /
      // declined) must not auto-charge a full completion fee — route to review.
      priorNonPerformed: recapPriorNonPerformed,
    });
    // Appointment-card completion lane (Codex #3153 r1 P1): a one-time visit
    // whose card came through the /secure link makes the same "charged after
    // completion" promise but has no hold row — without this fallback a
    // recap closeout leaves it uncharged forever. Runs ONLY when the hold
    // rail positively owns nothing here; any other hold outcome (charged,
    // review, failed) means that rail handled or parked the visit.
    if (!holdResult?.charged && ['no_hold', 'feature_disabled'].includes(holdResult?.reason)) {
      const ApptCards = require('./appointment-card-request');
      await ApptCards.chargeAppointmentCardForRecapCompletion({
        scheduledServiceId: serviceId,
        serviceRecordId: recordId,
        priorNonPerformed: recapPriorNonPerformed,
      });
    }
  } catch (err) {
    logger.warn(`[pest-recap] card-hold completion charge failed for ${serviceId}: ${err.message}`);
    // The completed visit may be UNBILLED with no pay-link fallback (Codex
    // #3153 r13 P1) — e.g. the hold rail threw BEFORE the appointment-card
    // fallback could run its own alerting. Best-effort office alert from
    // this outer boundary so a saved-card recap never strands silently.
    try {
      await require('./notification-service').notifyAdmin(
        'billing',
        'Recap completion needs billing review (saved card)',
        `A recap-completed visit's saved-card billing step errored before it could resolve (${err.message}). Review the visit's billing and collect manually if appropriate.`,
        {
          link: svc?.customer_id ? `/admin/customers/${svc.customer_id}` : '/admin/dispatch',
          metadata: { scheduledServiceId: serviceId, reason: 'recap_billing_error' },
        },
      );
    } catch (notifyErr) {
      logger.warn(`[pest-recap] recap billing alert failed: ${notifyErr.message}`);
    }
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
        // recapText is the full recap (stored for the service report); the SMS
        // gets the tightened, sentence-complete version.
        body: smsRecap(recapText),
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
  } else if (wantSms && completionSmsAlreadySent) {
    // The /complete flow already texted this customer its completion SMS
    // for this visit — a recap text on top would be the "two different
    // versions of the same message" double-text.
    smsError = 'completion_sms_already_sent';
  } else if (wantSms) {
    // Wanted to text but the claim was already taken (concurrent double-
    // submit, or a recap that already texted this customer): no-op.
    smsError = 'duplicate_suppressed';
  }

  // Cross-sell evidence pre-warm is DELIBERATELY NOT wired here (codex
  // #3382 rounds r1–r3 converged on this): recap-created service_records
  // carry no report_template_version, and reports-public returns the base
  // payload for non-v1 records before the builder that composes crossSell —
  // those reports render the legacy layout with NO card, so warming buys
  // nothing. The only v1 records this path touches are re-recaps of visits
  // completed through /complete — where the scheduled row is already
  // 'completed', this submit is not the transition winner, and the ORIGINAL
  // completion already warmed through the dispatch call site. Both branches
  // together make a recap-side warm unreachable; if recap completions ever
  // start stamping service_report_v1 (a product decision — the v1 layout
  // presents findings/coverage the recap doesn't capture), wire the warm
  // AFTER the SMS send above: the transaction durably claims
  // recap_sms_sent_at, and nothing may sit between that claim and the send.

  // Digital business card: a recap completion is a real performed visit —
  // mirror the /complete path's best-effort mint so a customer whose FIRST
  // completed visit lands through the recap flow still gets their card, tied
  // to the right tech/visit (Codex P2 on PR #2588 round 2). Skips recaps of
  // previously non-performed visits (incomplete / inspection_only /
  // customer_declined), matching the referral-credit gating above (Codex P2
  // round 3). Fire-and-forget; the card.issued email inside stays dark
  // behind GATE_DIGITAL_BUSINESS_CARD.
  if (!recapPriorNonPerformed) {
    try {
      const CustomerCardService = require('./customer-card');
      void CustomerCardService.ensureCardForCompletion({
        customerId: svc.customer_id,
        serviceRecordId: recordId,
        scheduledServiceId: serviceId,
      }).catch((e) => logger.warn(`[pest-recap] card mint failed (customerId=${svc.customer_id} errType=${e?.name || 'Error'})`));
    } catch (e) {
      logger.warn(`[pest-recap] card mint dispatch failed: ${e?.name || 'Error'}`);
    }
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
