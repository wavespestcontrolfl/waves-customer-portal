const express = require('express');
const router = express.Router();
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { authenticate, authenticateAllowInactive } = require('../middleware/auth');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
// A non-GSM first name (Á) would flip the whole confirmation text to UCS-2
// and past two segments — fold it before rendering (codex pre-push P1).
const { gsmSafeName } = require('../services/messaging/gsm-normalize');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const AccountMembershipEmail = require('../services/account-membership-email');
const { processCancellationRequest } = require('../services/cancellation-processor');
const { sendCancellationConfirmations } = require('../services/cancellation-confirmations');
const { hasCancellableWork } = require('../services/cancellation-eligibility');
const CancellationResolution = require('../services/cancellation-resolution');
const { REASON_CODE_VALUES } = require('../services/cancellation-resolution/reason-codes');
const { situationalHardStop } = require('../services/cancellation-resolution/resolve');
const { etDateString } = require('../utils/datetime-et');

// Shape the portal reads to render the truthful post-submit state (H0).
// `processed` is true only when the processor reports a clean, churned run;
// `confirmation` names the channel that actually accepted the confirmation
// ('sms' | 'email') or null when none was sent from this response.
// `effectiveDate` is the ET calendar date the cancellation took effect —
// the ORIGINAL request's date on retries, so a next-day retry never says
// "as of today".
// `confirmationChannels` (additive) lists EVERY channel that accepted —
// a customer-initiated cancel sends both, and the portal copy must name
// only what was actually accepted (codex pre-push P1: "text and email"
// on an sms-only outcome).
// Scope a cancellation request was COMMITTED with — retries and repairs
// must never widen an empty response into a whole-account churn (codex r1
// P1: the 60s dedupe re-ran without families). The case row is the durable
// record; no case or empty scope = whole account, exactly as committed.
async function committedScopeFor(serviceRequestId) {
  try {
    const row = await db('cancellation_cases').where({ service_request_id: serviceRequestId }).first('scope');
    if (!row) return null; // case write failed or not yet landed — fail closed (codex P0)
    const scope = typeof row.scope === 'string' ? JSON.parse(row.scope) : row.scope;
    return Array.isArray(scope) ? scope.filter(Boolean) : [];
  } catch (err) {
    logger.warn(`[requests] scope recovery failed for request ${serviceRequestId}: ${err.message}`);
    return null; // unknown — caller must fail safe, never assume whole account
  }
}

function cancellationOutcome(result, confirmation, effectiveAt, confirmationChannels = []) {
  let effectiveDate = null;
  try {
    const at = effectiveAt ? new Date(effectiveAt) : new Date();
    effectiveDate = Number.isNaN(at.getTime()) ? etDateString() : etDateString(at);
  } catch (err) {
    effectiveDate = null;
  }
  return {
    // Scoped cancels never churn — "processed" means the selected families'
    // visits are pulled AND the remaining plan repriced (codex r1 P2: the
    // portal showed the manual-closeout copy while the scoped SMS said done).
    processed: !!(result && result.ok && (result.churned || result.scopedWoundDown)),
    visitsPulled: result ? Number(result.cancelledCount) || 0 : 0,
    confirmation: confirmation || null,
    confirmationChannels: Array.isArray(confirmationChannels) ? confirmationChannels.filter(Boolean) : [],
    effectiveDate,
  };
}
const {
  MAX_PHOTOS,
  MAX_ENCODED_PHOTO_CHARS,
  validateRequestPhotos,
} = require('../utils/request-photo-validation');

const VALID_CATEGORIES = ['pest_issue', 'lawn_concern', 'add_service', 'schedule_change', 'billing', 'cancellation', 'pause', 'upgrade', 'other'];
const VALID_URGENCIES = ['routine', 'urgent'];
const VALID_LOCATIONS = ['front_yard', 'back_yard', 'side_yard', 'inside_home', 'garage_lanai', 'garden_beds', 'other'];

// Throttle creates per authenticated customer — POST fans out two SMS messages,
// so we want stricter scoping than the global /api limiter.
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.customer && req.customer.id) || req.ip,
  message: { error: 'Too many service requests submitted. Please wait before sending another or call our office.' },
});

const createSchema = Joi.object({
  category: Joi.string().valid(...VALID_CATEGORIES).required(),
  subject: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().trim().allow('').max(500).optional(),
  urgency: Joi.string().valid(...VALID_URGENCIES).optional(),
  // The portal sends null when no location chip is tapped (it's optional in
  // the UI) — without .allow(null, '') that payload 400s and the request is
  // never created.
  locationOnProperty: Joi.string().valid(...VALID_LOCATIONS).allow(null, '').optional(),
  source: Joi.string().trim().max(50).optional(),
  type: Joi.string().trim().max(50).optional(),
  photos: Joi.array().items(Joi.string().max(MAX_ENCODED_PHOTO_CHARS)).max(MAX_PHOTOS).optional(),
  // Cancellation resolution engine (PR E, GATE_CANCEL_FLOW_V2) — additive,
  // all optional so every existing client payload validates unchanged. The
  // structured v2 reason + the card the customer saw and what they did with
  // it; recorded on the cancellation_cases row, never trusted for money
  // (offer grants re-derive eligibility server-side in C1).
  reasonCode: Joi.string().valid(...REASON_CODE_VALUES).optional(),
  resolutionTemplateId: Joi.string().trim().max(60).optional(),
  resolutionOutcome: Joi.string().valid('shown', 'accepted', 'declined').optional(),
  // The same scope/context the preview took, so the commit-time recompute
  // resolves the SAME situation the customer was shown (families intersect
  // server-derived ownership; the address is re-validated server-side).
  families: Joi.array().items(Joi.string().trim().max(64)).max(8).optional(),
  newAddress: Joi.string().trim().max(400).optional(),
  competitorQuote: Joi.boolean().optional(),
  adverseEvent: Joi.boolean().optional(),
  safetyComplaint: Joi.boolean().optional(),
});

// Strip any HTML-ish characters before storage so admin/UI surfaces can never
// render injected markup, regardless of the client renderer.
function stripHtml(s) {
  return String(s || '').replace(/[<>]/g, '');
}

// Cancellation moving-branch address verdict (PR E): the TRANSFER card only
// appears on a fully accepted in-area validation (validated_accept /
// corrected); an accepted OUT-of-area address is the clean-cancel hard stop;
// anything partial (ambiguous, missing component, confirm-needed,
// API-unavailable) resolves to null → no card, no hard stop.
function cancelMoveAddressVerdict(verdict, STATUSES) {
  if (!verdict) return null;
  if (verdict.status === STATUSES.OUT_OF_SERVICE_AREA) return false;
  const accepted = verdict.status === STATUSES.VALIDATED_ACCEPT || verdict.status === STATUSES.CORRECTED;
  if (!accepted || verdict.inServiceArea !== true) return null;
  return true;
}

// Durable cancellation case (PR E) — idempotent per request id, best-effort:
// a case failure never blocks or un-reports a cancel. Called from the fresh
// create AND both retry branches, so a transient insert failure on the first
// submit is repaired by any retry.
async function recordCancellationCase({ customerId, requestId, value = {}, families = [], snapshot = null, resolution = null, resolutionOutcome = null, processed = false, reasonText = null }) {
  if (!CancellationResolution.cancelFlowV2Enabled()) return;
  try {
    await CancellationResolution.openCancellationCase({
      customerId,
      serviceRequestId: requestId,
      families,
      reasonCode: value.reasonCode || null,
      reasonText,
      resolution,
      resolutionOutcome,
      snapshot: snapshot || {},
      processed,
    });
  } catch (caseErr) {
    logger.warn(`Cancellation case write failed for request ${requestId}: ${caseErr.message}`);
  }
}

// =========================================================================
// POST /api/requests — Create a new service request
// =========================================================================
// authenticateAllowInactive (NOT authenticate): the cancellation auto-processor
// churns the account (active=false) mid-flight, so a client retry after a lost
// response would otherwise 401 before reaching the dedupe/repair sweep below.
// The gate right after validation keeps every OTHER category blocked for
// inactive accounts, matching the strict middleware's behavior.
router.post('/', authenticateAllowInactive, createLimiter, async (req, res, next) => {
  try {
    const { value, error } = createSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { category, subject, description, urgency, locationOnProperty, photos } = value;

    if (req.customerInactive && category !== 'cancellation') {
      return res.status(401).json({ error: 'Customer not found or inactive' });
    }
    const validUrgency = urgency || 'routine';
    const validLocation = locationOnProperty || null;

    const cleanSubject = stripHtml(subject);
    const cleanDescription = stripHtml(description || '');
    // Families a scoped (per-service) cancel is limited to; [] = whole plan.
    let scopedFamilies = [];

    // Reject the whole submission when an attachment is unreadable or too
    // large. Silently dropping a photo makes the customer believe staff saw
    // evidence that was never persisted.
    const photoValidation = validateRequestPhotos(photos);
    if (!photoValidation.ok) {
      return res.status(photoValidation.status).json({
        error: photoValidation.error,
        ...(Number.isInteger(photoValidation.photoIndex)
          ? { photoIndex: photoValidation.photoIndex }
          : {}),
      });
    }
    const photoData = photoValidation.photos;

    // Lightweight server-side dedupe — reject identical create within 60s
    const dupeWindow = new Date(Date.now() - 60 * 1000);
    const dupe = await db('service_requests')
      .where({ customer_id: req.customer.id, category, subject: cleanSubject })
      .where('created_at', '>=', dupeWindow)
      .first();
    if (dupe) {
      // A deduped CANCELLATION retry must still re-run the processor: the
      // first submit's best-effort processing may have partially failed, and
      // returning "success" here without re-running would leave visits/billing
      // in the failed state until staff intervene. The processor is idempotent
      // (already-cancelled visits and an already-churned account are no-ops),
      // so a clean first run makes this a cheap sweep. No new admin alert —
      // the original request's alert already carries the review flag.
      let retryOutcome = null;
      if (category === 'cancellation') {
        try {
          const recoveredScope = await committedScopeFor(dupe.id);
          if (recoveredScope === null) throw new Error('scope unrecoverable — retry skipped');
          // Same customer-scoped lock as the admin commit: an unlocked
          // portal run racing an admin end_of_coverage confirm can pull the
          // paid visits the admin sweep is deliberately keeping. Busy or
          // unacquirable throws into this catch — the request parks for
          // review instead of processing unlocked.
          const releaseCancelLock = await require('../services/admin-cancellation').acquireCancelCommitLock(req.customer.id);
          let retry;
          try {
            retry = await processCancellationRequest({
              customerId: req.customer.id,
              reason: `Portal cancellation request ${dupe.id}`,
              requestId: dupe.id,
              families: recoveredScope,
            });
          } finally { await releaseCancelLock(); }
          retryOutcome = retry;
          logger.info(
            `Re-ran cancellation processing for deduped request ${dupe.id}: ok=${retry.ok}` +
              (retry.ok ? '' : ` (errors: ${retry.errors.join(', ')})`)
          );
        } catch (retryErr) {
          logger.error(`Deduped cancellation re-processing failed for ${dupe.id}: ${retryErr.message}`);
        }
        // Promote the original request's case to committed if this retry
        // completed the cancel. When the original writes BOTH failed and no
        // case row exists at all, the retry's structured inputs are the only
        // reconstruction available — openCancellationCase only fills MISSING
        // fields, so an intact original record is never overwritten by retry
        // input, and the taxonomy re-derives the hard-stop/review verdict.
        // The post-churn snapshot is marked degraded (tier/rate already
        // cleared, no card can be reconstructed).
        await recordCancellationCase({
          customerId: req.customer.id,
          requestId: dupe.id,
          value,
          families: [], // scope unverifiable post-churn — never retry input
          reasonText: dupe.description || null,
          // Situational hard stops (adverse event / safety complaint) are
          // derivable from reason+context alone — reconstruct them so a
          // repaired-from-nothing case still reaches the incident lane.
          resolution: situationalHardStop(value.reasonCode, { adverseEvent: value.adverseEvent === true, safetyComplaint: value.safetyComplaint === true }),
          snapshot: { written_on_retry: true, degraded: true },
          processed: !!(retryOutcome && retryOutcome.ok && retryOutcome.churned),
        });
      }
      return res.status(200).json({
        success: true,
        deduped: true,
        request: {
          id: dupe.id,
          category: dupe.category,
          subject: dupe.subject,
          description: dupe.description,
          urgency: dupe.urgency,
          locationOnProperty: dupe.location_on_property,
          status: dupe.status,
          photoCount: 0,
          createdAt: dupe.created_at,
        },
        // A retry is still a truthful outcome (H0): the sweep above is the
        // authority on whether the plan is closed. No confirmation is sent
        // from this branch — the original request's already went out.
        ...(category === 'cancellation' ? { cancellation: cancellationOutcome(retryOutcome, null, dupe.created_at) } : {}),
      });
    }

    // An INACTIVE account never creates a fresh request: the allow-inactive
    // auth exists solely so a churned customer's retry can reach the
    // idempotent repair, and an unexpired portal JWT must not keep minting
    // service_requests rows / admin alerts / SMS for days after churn.
    // Outside the 60s dedupe window, re-run the repair against their most
    // recent cancellation request and answer with that row; with no prior
    // cancellation request on file there is nothing to repair — reject like
    // the strict middleware would have.
    if (req.customerInactive) {
      const priorCancellation = await db('service_requests')
        .where({ customer_id: req.customer.id, category: 'cancellation' })
        // PORTAL-originated only: after an admin end_of_coverage cancel the
        // account is inactive while its prepaid visits deliberately stay
        // scheduled — re-running the ADMIN request's whole-account scope
        // from here (without its keepThrough/keepVisitIds boundary) would
        // pull every retained paid visit. Admin repairs run through the
        // admin commit path, which restores the durable boundary.
        .where((qb) => { qb.whereNull('source').orWhereNot('source', 'admin'); })
        .orderBy('created_at', 'desc')
        .first();
      if (!priorCancellation) {
        return res.status(401).json({ error: 'Customer not found or inactive' });
      }
      let retryOutcome = null;
      try {
        const recoveredScope = await committedScopeFor(priorCancellation.id);
        // Fail closed exactly like the dedupe branch: an unrecoverable
        // scope must never widen into a whole-account churn (codex P0).
        if (recoveredScope === null) throw new Error('scope unrecoverable — retry skipped');
        // Locked like every other cancellation writer (see the dedupe
        // branch above) — never process unlocked beside an admin commit.
        const releaseCancelLock = await require('../services/admin-cancellation').acquireCancelCommitLock(req.customer.id);
        let retry;
        try {
          retry = await processCancellationRequest({
            customerId: req.customer.id,
            reason: `Portal cancellation request ${priorCancellation.id}`,
            requestId: priorCancellation.id,
            families: recoveredScope,
          });
        } finally { await releaseCancelLock(); }
        retryOutcome = retry;
        logger.info(
          `Re-ran cancellation processing for inactive-account retry ${priorCancellation.id}: ok=${retry.ok}` +
            (retry.ok ? '' : ` (errors: ${retry.errors.join(', ')})`)
        );
      } catch (retryErr) {
        logger.error(`Inactive-account cancellation re-processing failed for ${priorCancellation.id}: ${retryErr.message}`);
      }
      // Same semantics as the dedupe branch above: promote when a row
      // exists, reconstruct what little can be reconstructed when none does.
      await recordCancellationCase({
        customerId: req.customer.id,
        requestId: priorCancellation.id,
        value,
        families: [], // scope unverifiable post-churn — never retry input
        reasonText: priorCancellation.description || null,
        resolution: situationalHardStop(value.reasonCode, { adverseEvent: value.adverseEvent === true, safetyComplaint: value.safetyComplaint === true }),
        snapshot: { written_on_retry: true, degraded: true },
        processed: !!(retryOutcome && retryOutcome.ok && retryOutcome.churned),
      });
      return res.status(200).json({
        success: true,
        deduped: true,
        request: {
          id: priorCancellation.id,
          category: priorCancellation.category,
          subject: priorCancellation.subject,
          description: priorCancellation.description,
          urgency: priorCancellation.urgency,
          locationOnProperty: priorCancellation.location_on_property,
          status: priorCancellation.status,
          photoCount: 0,
          createdAt: priorCancellation.created_at,
        },
        cancellation: cancellationOutcome(retryOutcome, null, priorCancellation.created_at),
      });
    }

    // Streamline (GATE_RESERVICE_STREAMLINE, owner ruling 2026-08-08): a
    // covered pest/lawn issue books through the /reservice/:token picker, not
    // a ticket — the notify-then-hand-send step is the one being deleted, and
    // the ticket queue is a proven black hole (14 requests, zero resolved).
    // Enforced server-side so an older cached client can't keep filing
    // tickets the overlay no longer offers. Only the customer's OWN granted
    // lane is refused; ineligible plans (mosquito/termite/tree&shrub/
    // one-time/lapsed) still file tickets — those genuinely are office calls.
    // Fail-open on lookup errors: a broken eligibility check must not block a
    // customer from reporting a problem.
    if (category === 'pest_issue' || category === 'lawn_concern') {
      try {
        const { reserviceStreamlineAccess } = require('../services/reservice-link');
        const access = await reserviceStreamlineAccess(req.customer.id);
        const lane = category === 'pest_issue' ? 'pest' : 'lawn';
        if (access && access.lanes.includes(lane)) {
          return res.status(409).json({
            error: 'Good news — this is covered by your plan. Book your free re-service from the Schedule tab (or the link in your service texts) and it goes straight on the calendar.',
            code: 'use_reservice_picker',
            reserviceUrl: `/reservice/${access.token}`,
          });
        }
      } catch (eligibilityErr) {
        logger.warn(`Reservice eligibility check failed for ${req.customer.id}: ${eligibilityErr.message}`);
      }
    }

    // A cancellation must have something to cancel. The client gates the
    // Pause/Cancel controls, but the API accepts category 'cancellation' from
    // any authenticated customer — without this guard an account with no
    // recurring series, no upcoming visits and no billing (tier 'none',
    // one-time history only) could still churn itself account-wide, and the
    // processor's wind-down (autopay off, retries disarmed, churn stamps) is
    // not reversible from the portal. The predicate is the SHARED
    // hasCancellableWork verdict (cancellation-eligibility) — the same one
    // /api/schedule serves to the Plan tab, so client and server can't
    // drift. Deliberately NO repair re-run here: an ACTIVE account failing
    // this check has nothing safe to re-process — re-running against a
    // re-won customer with an old cancellation request would re-churn them;
    // the partial-failure repair paths are the 60s dedupe above and the
    // inactive-retry path, and a partial run already raised a review alert.
    if (category === 'cancellation') {
      // Scoped (per-family) cancellation (ruling C-3): the processor keeps
      // the account and winds down only the named families. Prove the
      // wind-down is attributable BEFORE the request row exists — a
      // fail-closed plan must not leave a "cancellation" ticket behind.
      // Gate off: families are ignored and the whole plan cancels (H0).
      if (CancellationResolution.cancelFlowV2Enabled() && Array.isArray(value.families) && value.families.length) {
        const { planScopedWindDown } = require('../services/cancellation-processor');
        const plan = await planScopedWindDown(req.customer.id, value.families);
        if (!plan.ok) {
          if (plan.error === 'scope_is_whole_account') {
            // Every owned family selected = a whole-account cancel; fall
            // through with no scope so the customer gets exactly that.
            scopedFamilies = [];
          } else {
            return res.status(409).json({
              error: plan.error === 'scope_not_owned'
                ? 'That service is not on your plan any more. Refresh and try again.'
                : 'We could not price the services that would stay. Cancel the whole plan here, or call our office and we will cancel just that service by hand.',
              code: plan.error === 'scope_not_owned' ? 'scope_not_owned' : 'scoped_cancellation_unattributed',
            });
          }
        } else {
          scopedFamilies = plan.inScope;
        }
      }
      if (!(await hasCancellableWork(req.customer.id))) {
        return res.status(400).json({
          error:
            'There is no active plan, recurring service, or upcoming visit on this account to cancel. Please call our office if you need help with your account.',
          code: 'nothing_to_cancel',
        });
      }
    }

    const isCancellation = category === 'cancellation';
    let caseSnapshot = null;
    let preChurnFacts = null;
    let serverResolution = null;

    // Cancellation ordering — FINAL form (codex rounds 27, 30, 38, 46):
    // MONEY OUTRANKS DURABILITY. The pre-churn snapshot/facts load and the
    // PURE resolve run BEFORE the acceptance persists (a crash here just
    // means the customer resubmits); the instant the acceptance persists,
    // the processor's billing wind-down runs with NOTHING between them —
    // no facts legs, no case writes, and certainly no external I/O. The
    // case write and the paid address validation both run after the
    // wind-down; retries reconstruct a lost case.
    if (isCancellation && CancellationResolution.cancelFlowV2Enabled()) {
      try {
        caseSnapshot = await db('customers')
          .where({ id: req.customer.id })
          .first('waveguard_tier', 'monthly_rate', 'billing_mode', 'pipeline_stage');
      } catch (snapErr) {
        logger.warn(`Cancellation case snapshot failed for ${req.customer.id}: ${snapErr.message}`);
      }
      if (value.reasonCode) {
        try {
          const { loadCancellationFacts } = require('../services/cancellation-resolution/facts');
          preChurnFacts = await loadCancellationFacts(req.customer.id);
        } catch (factsErr) {
          logger.warn(`Cancellation facts preload failed for ${req.customer.id}: ${factsErr.message}`);
        }
      }
      // Pure, I/O-free resolve from the preloaded pre-churn facts. The
      // moving address verdict is deliberately absent here (it needs the
      // paid external call, which must wait until after the billing
      // wind-down) — an out-of-area hard stop is added post-processor.
      if (preChurnFacts && value.reasonCode) {
        try {
          const { resolveCancellation } = require('../services/cancellation-resolution/resolve');
          serverResolution = resolveCancellation({
            facts: preChurnFacts,
            reasonCode: value.reasonCode,
            families: Array.isArray(value.families) ? value.families : [],
            context: {
              newAddressInServiceArea: null,
              hasCompetitorQuote: value.competitorQuote === true,
              adverseEvent: value.adverseEvent === true,
              safetyComplaint: value.safetyComplaint === true,
            },
          });
        } catch (resErr) {
          logger.warn(`Cancellation resolution recompute failed for ${req.customer.id}: ${resErr.message}`);
        }
      }
    }


    const [request] = await db('service_requests')
      .insert({
        customer_id: req.customer.id,
        category,
        subject: cleanSubject,
        description: cleanDescription,
        urgency: validUrgency,
        location_on_property: validLocation,
        photos: JSON.stringify(photoData),
        status: 'new',
      })
      .returning('*');

    logger.info(`Service request created: ${request.id} by customer ${req.customer.id} [${validUrgency}]`);

    const customerName = `${req.customer.first_name} ${req.customer.last_name}`;
    const categoryLabel = category.replace(/_/g, ' ');
    const photoCount = photoData.length;
    const locationLabel = validLocation ? validLocation.replace(/_/g, ' ') : '';

    // A cancellation request is auto-processed: pull the customer's upcoming
    // visits off the calendar, stop any recurring series, and mark the account
    // churned. Best-effort — run it before the admin alert so the notification
    // can report what happened. The durable service_requests row and the alert
    // itself remain even if this fails.
    let cancellationResult = null;
    let cancellationProcessed = false;
    if (isCancellation) {
      try {
        // Locked like the admin commit (shared customer-scoped advisory
        // lock): a portal submission racing an admin end_of_coverage
        // confirm must never pull the paid visits the admin run keeps.
        // Busy throws into this catch — the durable request row + alert
        // remain and the repair paths pick it up.
        const releaseCancelLock = await require('../services/admin-cancellation').acquireCancelCommitLock(req.customer.id);
        try {
          cancellationResult = await processCancellationRequest({
            customerId: req.customer.id,
            reason: `Portal cancellation request ${request.id}`,
            requestId: request.id,
            families: scopedFamilies,
          });
        } finally { await releaseCancelLock(); }
      } catch (cancelErr) {
        logger.error(`Failed to auto-process cancellation for request ${request.id}: ${cancelErr.message}`);
      }
      // Scoped: "processed" means the families' visits are pulled AND the
      // remaining plan repriced — not a churn.
      cancellationProcessed = !!(cancellationResult && cancellationResult.ok
        && (cancellationResult.churned || cancellationResult.scopedWoundDown));

      // Moving branch: the paid Google validation runs ONLY NOW — after
      // the billing wind-down — and only refines the audit verdict (an
      // accepted out-of-area address becomes the clean-cancel hard stop on
      // the case; nothing customer-facing depends on it at commit time).
      if (CancellationResolution.cancelFlowV2Enabled()
        && value.reasonCode === 'moving_or_property_change' && value.newAddress) {
        try {
          const { validateAddress, STATUSES } = require('../services/address-validation');
          const verdict = await validateAddress({ addressLines: [value.newAddress] });
          const inArea = cancelMoveAddressVerdict(verdict, STATUSES);
          if (inArea === false) {
            serverResolution = { kind: 'hard_stop', reasonCode: value.reasonCode, scope: serverResolution ? serverResolution.scope : [], reviewType: 'none' };
          } else if (inArea === true && preChurnFacts) {
            // Verified in-area: re-run the pure resolver with the verdict so
            // the case records the transfer card the preview showed (the
            // pre-churn resolve deliberately ran without the paid verdict).
            const { resolveCancellation } = require('../services/cancellation-resolution/resolve');
            serverResolution = resolveCancellation({
              facts: preChurnFacts,
              reasonCode: value.reasonCode,
              families: Array.isArray(value.families) ? value.families : [],
              context: {
                newAddressInServiceArea: true,
                hasCompetitorQuote: value.competitorQuote === true,
                adverseEvent: value.adverseEvent === true,
                safetyComplaint: value.safetyComplaint === true,
              },
            });
          }
        } catch (addrErr) {
          logger.warn(`Cancellation address validation failed for request ${request.id}: ${addrErr.message}`);
        }
      }

      // The SOLE case write, after the billing wind-down (codex r46: no
      // writes between acceptance and wind-down). Idempotent per request;
      // retries reconstruct a lost case. Caller input can never forge the
      // card — the resolution is the server's, computed pre-churn.
      if (CancellationResolution.cancelFlowV2Enabled()) {
        const serverCard = serverResolution && serverResolution.kind === 'card' ? serverResolution.card : null;
        // Same outcome rule as the pre-write above: explicit, matching,
        // never 'accepted' on this path.
        const outcome = serverCard && value.resolutionTemplateId === serverCard.templateId
          && ['shown', 'declined'].includes(value.resolutionOutcome)
          ? value.resolutionOutcome
          : null;
        await recordCancellationCase({
          customerId: req.customer.id,
          requestId: request.id,
          value,
          // The scope the processor actually RAN with is the durable record
          // (codex P0: a reason-less scoped cancel stored [] and a retry
          // then churned the whole account).
          // Whole-account = [] — NEVER the resolver's "all owned" list (codex
          // r2 P1: that made a retry look scoped and skip the repair).
          families: Array.isArray(cancellationResult?.scope) && cancellationResult.scope.length
            ? cancellationResult.scope
            : scopedFamilies,
          reasonText: cleanDescription || null,
          resolution: serverResolution,
          resolutionOutcome: outcome,
          snapshot: {
            tier_before: caseSnapshot ? caseSnapshot.waveguard_tier : null,
            monthly_rate_before: caseSnapshot ? caseSnapshot.monthly_rate : null,
            billing_mode: caseSnapshot ? caseSnapshot.billing_mode : null,
          },
          processed: cancellationProcessed,
        });
      }
    }

    // Internal admin alert only. Service requests should surface in the admin
    // notification feed, not text the office number. The notification is now
    // the primary triage surface (there is no dedicated Requests page), so the
    // full request description goes in the body — it's capped at 500 chars by
    // the create-request validation above.
    try {
      const urgencyTag = validUrgency === 'urgent' ? '🚨 URGENT ' : '';
      const title = isCancellation
        ? `⚠️ ${urgencyTag}Cancellation request from ${customerName}`
        : `${urgencyTag}New service request from ${customerName}`;
      const cancellationSummary = isCancellation
        ? (cancellationResult && cancellationResult.ok
            ? `\n\nAuto-processed: ${cancellationResult.cancelledCount} upcoming visit(s) pulled, ` +
              (Array.isArray(cancellationResult?.scope) && cancellationResult.scope.length
                ? `recurrence stopped for ${cancellationResult.scope.join(', ')}; account stays active with ${(cancellationResult.remaining || []).join(', ') || 'its other services'} (tier ${cancellationResult.tierBefore || '—'} → ${cancellationResult.tierAfter || '—'}).`
                : 'recurrence stopped, account churned + billing stopped.')
            : '\n\n⚠️ Auto-processing did not fully complete — review the calendar/account manually.' +
              (cancellationResult && cancellationResult.errors && cancellationResult.errors.length
                ? ` (failed: ${cancellationResult.errors.join(', ')})`
                : ''))
        : '';
      const notif = await NotificationService.notifyAdmin(
        'service',
        title,
        `Category: ${categoryLabel}\n` +
          `Subject: ${cleanSubject}` +
          (locationLabel ? `\nLocation: ${locationLabel}` : '') +
          (photoCount > 0 ? `\n${photoCount} photo(s) attached` : '') +
          (cleanDescription ? `\n\n"${cleanDescription}"` : '') +
          cancellationSummary,
        {
          icon: isCancellation ? '⚠️' : (validUrgency === 'urgent' ? '🚨' : '🏠'),
          link: `/admin/customers?customerId=${encodeURIComponent(req.customer.id)}`,
          metadata: {
            requestId: request.id,
            customerId: req.customer.id,
            category,
            urgency: validUrgency,
            photoCount,
            ...(isCancellation
              ? {
                  autoProcessed: !!(cancellationResult && cancellationResult.ok),
                  visitsPulled: cancellationResult ? cancellationResult.cancelledCount : 0,
                  churned: cancellationResult ? cancellationResult.churned : false,
                  processingErrors: cancellationResult ? cancellationResult.errors : ['processor_threw'],
                }
              : {}),
          },
        }
      );
      // notifyAdmin swallows DB errors and returns null instead of throwing, so a
      // failed insert won't hit the catch below. With the dedicated Requests page
      // gone, this notification is the primary triage surface — a silent miss
      // would leave the request unsurfaced in the feed. The row is still durable
      // in service_requests (and reachable from the customer profile), so don't
      // fail the customer's submission; instead emit an explicit, recoverable
      // error so it pages through to Sentry and ops can re-surface it.
      if (!notif) {
        logger.error(
          `Admin notification did not persist for service request ${request.id} ` +
            `(customer ${req.customer.id}); request is durable in service_requests ` +
            `but may be unsurfaced in the admin feed.`
        );
      }
    } catch (notifErr) {
      logger.error(`Failed to create admin notification for request ${request.id}: ${notifErr.message}`);
    }

    // Customer confirmations. A cancellation is auto-processed, so it gets
    // the dedicated truth-gated templates (SMS + email, both awaited so the
    // response names only the channels that actually accepted) — the ONE
    // helper the admin Cancel plan path (C3) also uses; the customer's
    // portal submit is a customer-action entry point, so no quiet-hours
    // hold applies (owner ruling 2026-08-29).
    const responseTime = validUrgency === 'urgent' ? '2 hours' : '24 hours';
    let confirmationSmsSent = false;
    let confirmationEmailSent = false;
    if (isCancellation) {
      const confirmations = await sendCancellationConfirmations({
        customer: req.customer,
        request,
        result: cancellationResult,
        processed: cancellationProcessed,
        urgency: validUrgency,
      });
      confirmationSmsSent = confirmations.smsSent;
      confirmationEmailSent = confirmations.emailSent;
    } else {
      try {
        const body = await renderRequiredSmsTemplate('service_request_confirmation', {
          first_name: gsmSafeName(req.customer.first_name),
          category: categoryLabel,
          response_time: responseTime,
        }, {
          workflow: 'service_request_confirmation',
          entity_type: 'service_request',
          entity_id: request.id,
        });
        const smsResult = await sendCustomerMessage({
          to: req.customer.phone,
          body,
          channel: 'sms',
          audience: 'customer',
          purpose: 'support_resolution',
          customerId: req.customer.id,
          identityTrustLevel: 'authenticated_portal',
          entryPoint: 'customer_service_request',
          metadata: {
            original_message_type: 'service_request_confirmation',
            service_request_id: request.id,
            urgency: validUrgency,
          },
        });
        // No quiet-hours requeue: customer_service_request is a
        // customer-action entry point (owner ruling 2026-08-29) — the
        // confirmation answers the customer's own portal submit immediately,
        // at any hour, so QUIET_HOURS_HOLD cannot surface here.
        confirmationSmsSent = !!smsResult.sent;
        if (!smsResult.sent) {
          logger.warn(`Request confirmation SMS blocked/failed for customer ${req.customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
      } catch (smsErr) {
        logger.error(`Failed to send confirmation SMS for request ${request.id}: ${smsErr.message}`);
      }
      void AccountMembershipEmail.sendRequestReceived({
        customerId: req.customer.id,
        request,
        responseTime,
      }).catch((emailErr) => {
        logger.warn(`Failed to send confirmation email for request ${request.id}: ${emailErr.message}`);
      });
    }

    res.status(201).json({
      success: true,
      request: {
        id: request.id,
        category: request.category,
        subject: request.subject,
        description: request.description,
        urgency: request.urgency,
        locationOnProperty: request.location_on_property,
        status: request.status,
        photoCount: photoData.length,
        createdAt: request.created_at,
      },
      // Lets the portal render the truthful post-submit state (H0): the
      // account is already churned when `processed` is true.
      ...(isCancellation
        ? {
            cancellation: {
              ...cancellationOutcome(
                cancellationResult,
                confirmationSmsSent ? 'sms' : (confirmationEmailSent ? 'email' : null),
                request.created_at,
                [confirmationSmsSent ? 'sms' : null, confirmationEmailSent ? 'email' : null]
              ),
              // Scoped cancels report exactly what stopped and what stays.
              scope: Array.isArray(cancellationResult?.scope) ? cancellationResult.scope : [],
              remaining: Array.isArray(cancellationResult?.remaining) ? cancellationResult.remaining : [],
              ...(cancellationResult?.tierAfter !== undefined ? { tierBefore: cancellationResult.tierBefore, tierAfter: cancellationResult.tierAfter } : {}),
            },
          }
        : {}),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/requests/cancel-resolution — resolution preview (PR E, dark)
// =========================================================================
// Read-only despite the verb: reason + context → the ONE retention card (or
// hard-stop / nothing) the C1 flow will render. Writes nothing, sends
// nothing, and only ever quotes facts already on the customer's own
// account. POST because new_address is a street address — in a GET query
// string it would land verbatim in request logs and browser history
// (AGENTS.md PII-in-logs rule). 404 while GATE_CANCEL_FLOW_V2 is off so the
// surface simply does not exist dark.
const cancelResolutionSchema = Joi.object({
  reason: Joi.string().valid(...REASON_CODE_VALUES).optional(),
  families: Joi.array().items(Joi.string().trim().max(64)).max(8).optional(),
  new_address: Joi.string().trim().max(400).optional(),
  competitor_quote: Joi.boolean().optional(),
  adverse_event: Joi.boolean().optional(),
  safety_complaint: Joi.boolean().optional(),
});

// Per-customer limiter: the moving branch calls the paid Google Address
// Validation API, so an authed account must not be able to loop it for free.
const cancelResolutionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.customer && req.customer.id) || req.ip,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

router.post('/cancel-resolution', authenticate, cancelResolutionLimiter, async (req, res, next) => {
  try {
    if (!CancellationResolution.cancelFlowV2Enabled()) return res.status(404).json({ error: 'Not found' });
    const { value, error } = cancelResolutionSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const families = Array.isArray(value.families) ? value.families : [];

    // Moving: the transfer card only appears once the stated new address
    // verifies INSIDE the service area; a verified out-of-area address is a
    // clean-cancel hard stop; anything unverifiable resolves to no card.
    let newAddressInServiceArea = null;
    // Paid Google call — moving previews only (see the commit path).
    if (value.new_address && value.reason === 'moving_or_property_change') {
      const { validateAddress, STATUSES } = require('../services/address-validation');
      const verdict = await validateAddress({ addressLines: [value.new_address] });
      newAddressInServiceArea = cancelMoveAddressVerdict(verdict, STATUSES);
    }

    const preview = await CancellationResolution.previewCancellationResolution({
      customerId: req.customer.id,
      reasonCode: value.reason || null,
      families,
      context: {
        newAddressInServiceArea,
        hasCompetitorQuote: value.competitor_quote === true,
        adverseEvent: value.adverse_event === true,
        safetyComplaint: value.safety_complaint === true,
      },
    });
    if (!preview) return res.status(404).json({ error: 'Not found' });

    const { resolution } = preview;
    // C1: the screens render ONLY server facts — scope for the picker,
    // blockers for honesty, and the before/after impact table (the portal
    // computes no dollars client-side by design).
    let impact = null;
    try {
      const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');
      impact = await buildCancellationImpact(req.customer.id, families);
    } catch (impactErr) {
      logger.warn(`[cancel-resolution] impact build failed for ${req.customer.id}: ${impactErr.message}`);
    }
    res.json({
      kind: resolution.kind,
      reasonCode: resolution.reasonCode || null,
      scope: Array.isArray(resolution.scope) ? resolution.scope : [],
      ...(Array.isArray(resolution.offerBlockers) && resolution.offerBlockers.length ? { offerBlockers: resolution.offerBlockers } : {}),
      ...(resolution.kind === 'hard_stop' ? { reviewType: resolution.reviewType } : {}),
      ...(resolution.kind === 'card'
        ? { card: { templateId: resolution.card.templateId, headline: resolution.card.headline, body: resolution.card.body, action: resolution.card.action } }
        : {}),
      ...(impact ? { impact } : {}),
    });
  } catch (err) {
    next(err);
  }
});

const cancelResolutionAcceptSchema = Joi.object({
  reasonCode: Joi.string().valid(...REASON_CODE_VALUES).required(),
  families: Joi.array().items(Joi.string().trim().max(64)).max(8).optional(),
  templateId: Joi.string().trim().max(60).required(),
  params: Joi.object({
    resumeDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    preferredDay: Joi.string().trim().max(40).optional(),
    preferredTime: Joi.string().trim().max(40).optional(),
    newAddress: Joi.string().trim().max(400).optional(),
    keepFamilies: Joi.array().items(Joi.string().trim().max(64)).max(8).optional(),
    note: Joi.string().trim().max(300).optional(),
  }).optional(),
});

// POST /api/requests/cancel-resolution/accept — the customer accepted the
// ONE card. The server re-resolves from its own facts, refuses a card it
// would not show right now (template mismatch = stale screen), mints the
// committed + accepted cancellation_cases row, executes the action, and
// confirms by text AND email. The cancel itself is NOT performed — accepting
// the card means the plan stays.
router.post('/cancel-resolution/accept', authenticate, cancelResolutionLimiter, async (req, res, next) => {
  try {
    if (!CancellationResolution.cancelFlowV2Enabled()) return res.status(404).json({ error: 'Not found' });
    const { value, error } = cancelResolutionAcceptSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const families = Array.isArray(value.families) ? value.families : [];

    const { isAcceptableAction, executeAcceptedAction } = require('../services/cancellation-resolution/actions');

    // Double-tap / crash-retry idempotency (codex r1 P1): a prior accepted
    // case is REUSED only when it was the SAME accept — template, reason,
    // requested scope, and params (codex P1: a different family, resume
    // date, or preference must execute, not replay the old receipt). With
    // a receipt it returns; without one the action re-runs under the SAME
    // case id, so executor dedupe keys and the per-case grant guard hold.
    const acceptKey = JSON.stringify({
      t: value.templateId,
      r: value.reasonCode,
      f: [...families].sort(),
      p: value.params || {},
    });
    // Check + mint under a per-customer advisory lock (codex P1: two
    // concurrent taps both saw "no prior" and executed twice). The lock
    // covers only the durable claim; execution runs after it, protected by
    // per-case idempotency (executor dedupe keys + the grant's case guard).
    // The re-resolve is read-only and runs OUTSIDE the lock; the durable
    // claim (prior lookup + case mint) runs INSIDE it (codex r2 P1: the
    // lock must cover the insert, or two taps still mint two cases).
    const findPrior = async (dbh) => {
      const candidates = await dbh('cancellation_cases')
        .where({ customer_id: req.customer.id, resolution_template_id: value.templateId, resolution_outcome: 'accepted' })
        .where('created_at', '>=', new Date(Date.now() - 24 * 3600 * 1000))
        .orderBy('created_at', 'desc')
        .select('*');
      return (candidates || []).find((row) => {
        const snap = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : (row.snapshot || {});
        return snap.accept_key === acceptKey;
      }) || null;
    };
    let priorCase = await findPrior(db);
    if (priorCase) {
      const receipt = priorCase.snapshot && priorCase.snapshot.accept_receipt;
      if (receipt) return res.json({ ok: true, deduped: true, receipt });
    }

    let caseRow = priorCase || null;
    let cardAction = null;
    let cardHeadline = null;
    let caseScope = [];
    const loadFromCase = (row) => {
      cardAction = typeof row.resolution_action === 'string' ? JSON.parse(row.resolution_action) : row.resolution_action;
      cardHeadline = null;
      caseScope = (typeof row.scope === 'string' ? JSON.parse(row.scope) : row.scope) || [];
    };
    if (caseRow) {
      loadFromCase(caseRow);
    } else {
      // The transfer card only exists behind a VERIFIED in-area address —
      // re-run the verdict from the submitted address or the accept can
      // never match the preview (codex r1 P1).
      let newAddressInServiceArea = null;
      if (value.params?.newAddress && value.reasonCode === 'moving_or_property_change') {
        const { validateAddress, STATUSES } = require('../services/address-validation');
        const verdict = await validateAddress({ addressLines: [value.params.newAddress] });
        newAddressInServiceArea = cancelMoveAddressVerdict(verdict, STATUSES);
      }
      const preview = await CancellationResolution.previewCancellationResolution({
        customerId: req.customer.id,
        reasonCode: value.reasonCode,
        families,
        context: {
          newAddressInServiceArea,
          hasCompetitorQuote: false,
          adverseEvent: false,
          safetyComplaint: false,
        },
      });
      if (!preview) return res.status(404).json({ error: 'Not found' });
      const { resolution } = preview;
      if (resolution.kind !== 'card' || resolution.card.templateId !== value.templateId) {
        return res.status(409).json({
          error: 'That option is no longer available. Review your plan again.',
          code: 'resolution_stale',
        });
      }
      if (!isAcceptableAction(resolution.card.action)) {
        return res.status(409).json({ error: 'That option is informational only.', code: 'action_not_acceptable' });
      }
      const minted = await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`cancel-accept:${req.customer.id}`]);
        const raced = await findPrior(trx);
        if (raced) return { row: raced, reused: true };
        const row = await CancellationResolution.openCancellationCase({
          customerId: req.customer.id,
          serviceRequestId: null,
          families: resolution.scope,
          reasonCode: value.reasonCode,
          reasonText: null,
          resolution,
          resolutionOutcome: 'accepted',
          snapshot: { accepted_at: new Date().toISOString(), accepted_params: value.params || {}, accept_key: acceptKey },
          // An accepted resolution IS final — committed, or the ledger's
          // grant guard rejects the very offer the card promised (codex r1 P1).
          processed: true,
        }, trx);
        return { row, reused: false };
      });
      caseRow = minted.row;
      if (minted.reused) {
        const receipt = caseRow.snapshot && (typeof caseRow.snapshot === 'string' ? JSON.parse(caseRow.snapshot) : caseRow.snapshot).accept_receipt;
        if (receipt) return res.json({ ok: true, deduped: true, receipt });
        loadFromCase(caseRow);
      } else {
        cardAction = resolution.card.action;
        cardHeadline = resolution.card.headline;
        caseScope = resolution.scope;
      }
    }
    if (!isAcceptableAction(cardAction)) {
      return res.status(409).json({ error: 'That option is informational only.', code: 'action_not_acceptable' });
    }

    let execution;
    try {
      execution = await executeAcceptedAction({
        customerId: req.customer.id,
        caseRow,
        action: cardAction,
        params: { ...(value.params || {}) },
        families: caseScope,
      });
    } catch (execErr) {
      logger.error(`[cancel-resolution] accepted action failed for case ${caseRow?.id}: ${execErr.message}`);
      return res.status(execErr.code ? 409 : 500).json({
        error: execErr.code
          ? execErr.message
          : 'We could not set that up. Nothing about your plan has changed — call our office and we will do it by hand.',
        ...(execErr.code ? { code: execErr.code } : {}),
      });
    }

    const reference = String(caseRow.id).slice(0, 8).toUpperCase();
    const summary = execution.effects && execution.effects.length ? execution.effects[0] : (cardHeadline || 'Done');
    const receipt = {
      reference,
      actionType: execution.actionType,
      summary,
      effects: execution.effects || [],
      ...(execution.reserviceUrl ? { reserviceUrl: execution.reserviceUrl } : {}),
      confirmationChannels: [],
    };

    // Customer-initiated ⇒ text AND email (owner ruling 2026-08-31), each
    // fail-soft; the receipt names only the channels that accepted.
    try {
      const body = await renderRequiredSmsTemplate('service_resolution_confirmation', {
        first_name: gsmSafeName(req.customer.first_name),
        summary: String(summary).slice(0, 120),
        reference,
      }, { workflow: 'service_resolution_confirmation', entity_type: 'cancellation_case', entity_id: caseRow.id });
      const smsResult = await sendCustomerMessage({
        to: req.customer.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'support_resolution',
        customerId: req.customer.id,
        identityTrustLevel: 'authenticated_portal',
        entryPoint: 'customer_service_request',
        metadata: { original_message_type: 'service_resolution_confirmation', cancellation_case_id: caseRow.id },
      });
      if (smsResult.sent) receipt.confirmationChannels.push('sms');
    } catch (smsErr) {
      logger.warn(`[cancel-resolution] accept SMS failed for case ${caseRow.id}: ${smsErr.message}`);
    }
    try {
      const emailResult = await AccountMembershipEmail.sendResolutionAccepted({
        customerId: req.customer.id,
        caseId: caseRow.id,
        reference,
        summary,
        effects: execution.effects || [],
      });
      if (emailResult && emailResult.ok) receipt.confirmationChannels.push('email');
    } catch (emailErr) {
      logger.warn(`[cancel-resolution] accept email failed for case ${caseRow.id}: ${emailErr.message}`);
    }

    // Stash the receipt on the case for the 24h idempotency window.
    try {
      await db('cancellation_cases').where({ id: caseRow.id }).update({
        snapshot: db.raw("COALESCE(snapshot, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ accept_receipt: receipt })]),
        updated_at: new Date(),
      });
    } catch (stashErr) {
      logger.warn(`[cancel-resolution] receipt stash failed for case ${caseRow.id}: ${stashErr.message}`);
    }

    res.status(201).json({ ok: true, receipt });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/requests — List current customer's service requests
// =========================================================================
const listSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { value, error } = listSchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { limit, offset } = value;

    const requests = await db('service_requests')
      .where({ customer_id: req.customer.id })
      // Admin-originated rows (the C3 cancel acceptance) are internal ops
      // records: their subject embeds the staff actor and their description
      // is the operator's free-text note — neither is customer-facing.
      // NULL-safe: portal rows carry no source.
      .where((qb) => { qb.whereNull('service_requests.source').orWhereNot('service_requests.source', 'admin'); })
      .leftJoin('technicians', 'service_requests.assigned_technician_id', 'technicians.id')
      .select(
        'service_requests.id',
        'service_requests.category',
        'service_requests.subject',
        'service_requests.description',
        'service_requests.urgency',
        'service_requests.location_on_property as locationOnProperty',
        'service_requests.status',
        // photos intentionally omitted — up to 3×~6.7MB base64 strings per row
        // (50-row default page ≈ 1GB worst case) that the portal list never
        // renders. Anything that needs the attachments must fetch per-request.
        // admin_notes intentionally omitted — internal field, not customer-facing.
        'service_requests.created_at as createdAt',
        'service_requests.resolved_at as resolvedAt',
        'technicians.name as assignedTechnician'
      )
      .orderBy('service_requests.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const total = await db('service_requests')
      .where({ customer_id: req.customer.id })
      .count('id as count')
      .first();

    res.json({
      requests,
      total: parseInt(total?.count || 0),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
