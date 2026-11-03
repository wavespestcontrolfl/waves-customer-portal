/**
 * Book at the Table, hand-off mode (owner 2026-11-02, GATE_IN_PERSON_CARD).
 *
 * The owner hands his admin iPhone to a customer at their table. The Waves Admin
 * app opens the texted secure card page (/secure/:token?handoff=1) in a separate,
 * isolated customer web view (no admin sign-in is reachable from it). This module
 * is the server half of the D2 terms step:
 *
 *   buildHandoffBlock    the optional `handoff` block on GET /api/public/secure-card/:token
 *                        when the request carries `handoff=1`: `{ terms }`, the estimate
 *                        acceptance terms the customer ticks on the phone. It is data about
 *                        the token holder's own estimate, so it needs no sign-in. Absent
 *                        (payload byte-identical) without `handoff=1`, with a dark gate,
 *                        or when no terms are needed.
 *   recordInPersonTerms  stamps the estimate's acceptance terms once the customer ticks
 *                        "I accept estimate {ref} and its terms". A staff accept-on-book
 *                        records no terms (estimate-manual-acceptance), so this makes the
 *                        record match an online accept. It writes the same fields the
 *                        online accept writes and runs NONE of the accept's side effects:
 *                        the estimate is already accepted. Called only by the signed-in
 *                        admin page (POST /api/admin/schedule/:id/in-person-terms); the
 *                        customer page reaches it through the app's relay.
 *
 * Nothing here is charged, texted or emailed. The acceptance copy-email catch-up
 * sweep skips these rows (method 'in_person_handoff').
 */

const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const acceptanceTerms = require('./acceptance-terms-text');

const ACCEPTANCE_METHOD = 'in_person_handoff';

const refusal = (status, code, error) => ({ ok: false, status, code, error });
const TERMS_CHANGED_MESSAGE = 'The terms changed. Reload this page to see them.';

// The estimate the visit was booked from (accept-on-book stamps source_estimate_id
// on every row of the series); a later occurrence falls back to its series parent.
async function linkedEstimateFor(visitId, conn = db) {
  const visit = await conn('scheduled_services').where({ id: visitId }).first('id', 'source_estimate_id', 'recurring_parent_id');
  if (!visit) return { visit: null, estimate: null };
  let estimateId = visit.source_estimate_id || null;
  if (!estimateId && visit.recurring_parent_id) {
    const parent = await conn('scheduled_services').where({ id: visit.recurring_parent_id }).first('source_estimate_id');
    estimateId = parent?.source_estimate_id || null;
  }
  const estimate = estimateId ? await conn('estimates').where({ id: estimateId }).first() : null;
  return { visit, estimate };
}

// Mirrors the online accept's applicability check (estimate-public.js): the Florida
// notice applies while the gate is live and the customer has no signed notice on file.
// An unreadable state shows the notice (disclosure errs toward the customer).
async function consumerNoticeApplies(estimate) {
  if (!featureGates.estimateConsumerNoticeLive()) return false;
  try {
    return await require('./estimate-consumer-notice').consumerNoticeBlocksAccept(estimate);
  } catch {
    return true;
  }
}

// Null unless the estimate is accepted, has no recorded terms version, and the
// terms apply to it (the same rule the online accept uses).
async function termsContextFor(estimate) {
  if (!featureGates.isEnabled('estimateAcceptanceTerms')) return null;
  if (!estimate || estimate.status !== 'accepted' || estimate.terms_version) return null;
  const route = require('../routes/estimate-public');
  if (!route.acceptanceTermsApplyTo(estimate)) return null;
  const estData = route.parseEstimateDataSafe(estimate);
  const scope = route.acceptanceTermsScopeFor(estimate, estData, await route.buildPricingBundle(estimate));
  return { estimate, scope, noticeApplies: await consumerNoticeApplies(estimate) };
}

function estimateRefOf(estimate) {
  const slug = String(estimate.estimate_slug || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  return slug || String(estimate.id || '').split('-')[0].toUpperCase();
}

function termsPayload({ estimate, scope, noticeApplies }) {
  return {
    estimateRef: estimateRefOf(estimate),
    version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION,
    scope,
    lines: acceptanceTerms.acceptanceTermsSnapshot(scope).split('\n'),
    consumerNotice: noticeApplies ? { text: require('./estimate-consumer-notice').HANDOFF_NOTICE_TEXT } : null,
  };
}

// The `handoff` block for GET /api/public/secure-card/:token, or null. `data` is
// the page payload already built for the token.
async function buildHandoffBlock(req, { token, data }) {
  if (!data || data.state !== 'ready' || req.query?.handoff !== '1') return null;
  if (!featureGates.inPersonCardLive()) return null;
  const request = await db('appointment_card_requests').where({ token }).first('kind', 'scheduled_service_id');
  if (!request || request.kind === 'customer' || !request.scheduled_service_id) return null;
  const { estimate } = await linkedEstimateFor(request.scheduled_service_id);
  const context = await termsContextFor(estimate);
  return context ? { terms: termsPayload(context) } : null;
}

// Stamp the acceptance terms for the visit's estimate. Idempotent: a second call
// (or an estimate that already carries a terms version) changes nothing.
async function recordInPersonTerms({ visitId, technician, termsVersion, termsScope, consumerNoticeShown, ip = null, userAgent = null }) {
  if (termsVersion !== acceptanceTerms.ACCEPTANCE_TERMS_VERSION) {
    return refusal(409, 'TERMS_VERSION_STALE', 'The terms were updated. Reload the page and read them again.');
  }
  // The scope the page showed ('plan' carries the annual rate review sentence, 'base'
  // does not); both share one version, so it is attested beside it, as the online
  // accept does with acceptedTermsScope.
  const shownScope = acceptanceTerms.normalizeAcceptanceTermsScope(termsScope);
  if (!shownScope) return refusal(409, 'terms_changed', TERMS_CHANGED_MESSAGE);
  const { visit, estimate } = await linkedEstimateFor(visitId);
  if (!visit) return refusal(404, 'visit_not_found', 'Scheduled service not found');
  if (!estimate || estimate.terms_version) return { ok: true, recorded: false };
  const { recordAuditEvent } = require('./audit-log');
  const acceptedAt = new Date();
  const recorded = await db.transaction(async (trx) => {
    // Locked and re-read: a second tap, or the customer's own online accept,
    // landing first leaves exactly one record. The terms are judged on THIS row.
    const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
    if (!locked || locked.status !== 'accepted' || locked.terms_version) return false;
    const context = await termsContextFor(locked);
    if (!context) return refusal(409, 'terms_not_applicable', 'No terms are needed for this estimate.');
    if (context.scope !== shownScope) return refusal(409, 'terms_changed', TERMS_CHANGED_MESSAGE);
    if (context.noticeApplies && consumerNoticeShown !== true) {
      return refusal(409, 'consumer_notice_required', 'The Florida consumer notice must be shown before the terms are accepted.');
    }
    await trx('estimate_acceptances').insert({
      estimate_id: locked.id,
      customer_id: locked.customer_id || null,
      method: ACCEPTANCE_METHOD,
      terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION,
      terms_text: acceptanceTerms.acceptanceTermsSnapshot(context.scope),
      accepted_at: acceptedAt,
      ip: String(ip || '').slice(0, 64) || null,
      user_agent: String(userAgent || '').slice(0, 1000) || null,
    });
    await trx('estimates').where({ id: locked.id }).update({ terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION });
    // The 'plan' drawer the customer read carried the annual rate review line, so the
    // frozen document keeps it (the same stamp the online accept writes).
    if (context.scope === 'plan') {
      await trx('estimates').where({ id: locked.id }).update({
        estimate_data: trx.raw("jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{rateReviewDisclosedAtAccept}', 'true'::jsonb)"),
      });
    }
    if (locked.customer_id) {
      // Latest version accepted on any estimate; never downgrade.
      await trx('customers').where({ id: locked.customer_id })
        .where((q) => q.whereNull('accepted_terms_version').orWhere('accepted_terms_version', '<', acceptanceTerms.ACCEPTANCE_TERMS_VERSION))
        .update({ accepted_terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION });
    }
    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: technician?.id || null,
      action: 'estimate.acceptance_terms.in_person',
      resource_type: 'estimate',
      resource_id: locked.id,
      metadata: {
        visit_id: visit.id,
        terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION,
        scope: context.scope,
        consumer_notice_shown: context.noticeApplies && consumerNoticeShown === true,
      },
      ip_address: ip,
      user_agent: userAgent,
      critical: true,
      trx,
    });
    return true;
  });
  if (recorded && recorded.ok === false) return recorded;
  return { ok: true, recorded };
}

module.exports = {
  ACCEPTANCE_METHOD,
  buildHandoffBlock,
  recordInPersonTerms,
};
