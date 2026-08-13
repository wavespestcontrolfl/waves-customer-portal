'use strict';

/**
 * Customer-Facing Portal Home Recommendations Route
 *
 * GET  /               — the authenticated customer's recommendation stack
 *                        (see server/services/property-recommendations.js).
 * POST /request        — the customer tapped a card CTA: recompute the offer
 *                        server-side, reject on any drift from what was
 *                        rendered (409, same doctrine as the report
 *                        cross-sell click path), then write/refresh an open
 *                        service_requests row and ring the staff bell. No
 *                        customer message is sent — the owner sends all
 *                        customer comms.
 *
 * Dark behind GATE_PROPERTY_RECOMMENDATIONS (default OFF), read at request
 * time via the shared gateEnvValue parser so a Railway flip needs no
 * redeploy. Gate-off answers 200 {available:false} — the client renders
 * nothing rather than an error (same contract as the property-score card).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { gateEnvValue } = require('../config/feature-gates');
const db = require('../models/db');
const logger = require('../services/logger');
const { buildPropertyRecommendations, mosquitoNoteCard } = require('../services/property-recommendations');
const { buildPortalOffer } = require('../services/service-report/cross-sell');
const { normalizeRequestedServiceKey } = require('../services/estimate-add-service-request');
const { writeOrRefreshCtaRequest } = require('../services/cta-service-request');

router.use(authenticate);

// Same posture as the customer requests route: per-customer, low ceiling —
// a tap-through is a staff-bell write, not a browsing action.
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.customerId || req.ip,
  message: { error: 'Too many requests submitted. Please wait before sending another or call our office.' },
});

router.get('/', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_PROPERTY_RECOMMENDATIONS')) {
      return res.json({ available: false, reason: 'disabled' });
    }
    const result = await buildPropertyRecommendations(req.customerId);
    // Server-computed one-tap availability (bet 3): the client shows the
    // priced offer's purchase CTA only when this is true. Additive — the
    // existing fields are untouched. Monthly-membership accounts are fenced
    // out (their converter path would fold the add-on into monthly_rate,
    // contradicting the per-application terms); the write side re-checks.
    let oneTap = gateEnvValue('GATE_ONE_TAP_PURCHASE');
    if (oneTap) {
      const { customerPreservesMonthlyMembership } = require('../services/billing-cadence');
      const customer = await db('customers')
        .where({ id: req.customerId })
        .first('pipeline_stage', 'monthly_rate', 'billing_mode');
      oneTap = !!customer && !customerPreservesMonthlyMembership(customer);
    }
    return res.json({ available: true, oneTap, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/request', requestLimiter, async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_PROPERTY_RECOMMENDATIONS')) {
      return res.status(404).json({ error: 'Not available' });
    }
    const cardId = String(req.body?.cardId || '').trim();

    // ── Mosquito seasonal note: a plain quote request, no price snapshot ──
    if (cardId === 'mosquito_note') {
      // Revalidate before writing (same drift doctrine as the offer): a
      // stale page — or a direct authenticated POST — must not file a
      // request the card would no longer render (season over, ownership
      // changed, or ownership unknowable).
      const note = await mosquitoNoteCard(req.customerId, db);
      if (!note) {
        return res.status(409).json({ error: 'This suggestion is no longer available — please refresh the page' });
      }
      const requestedService = normalizeRequestedServiceKey('mosquito') || 'mosquito';
      const outcome = await writeOrRefreshCtaRequest(db, {
        customerId: req.customerId,
        requestedService,
        source: 'portal_home',
        subject: 'Add Mosquito Protection — requested from portal home',
        description: 'Customer asked about mosquito coverage from the portal home recommendations (quote requested — no price was shown). Review and follow up — no customer message has been sent.',
        revisionSnapshot: { source: 'portal_home', card: 'mosquito_note' },
      });
      await ringBell(req.customerId, 'Mosquito Protection (quote requested from portal home)', 'add', outcome);
      return res.json({ success: true, deduped: !!outcome.deduped });
    }

    if (cardId !== 'plan_offer') {
      return res.status(400).json({ error: 'Unknown card' });
    }

    // ── The matrix offer: recompute and reject on any drift ──────────────
    const offer = await buildPortalOffer(req.customerId, db);
    const metadata = req.body || {};
    const clickedPrint = String(metadata.fingerprint || '').trim();
    const clickedKey = String(metadata.serviceKey || '').trim();
    const clickedMode = String(metadata.offerMode || '').trim();
    // STRICT type check before any numeric handling (same rule as the report
    // click path): Number() coerces '', null, false, [] to 0 — a priced
    // click must carry an actual finite positive number, a quote click null.
    const rawPer = metadata.perApplication;
    const clickedPer = typeof rawPer === 'number' && Number.isFinite(rawPer) ? rawPer : null;
    const serverPer = Number(offer?.option?.perVisit);
    const offerMismatch = !offer
      || !clickedPrint || clickedPrint !== offer.fingerprint
      || !clickedKey || clickedKey !== offer.serviceKey
      || !clickedMode || clickedMode !== offer.mode
      || (offer.mode === 'priced'
        ? !(clickedPer !== null && clickedPer > 0
          && Number.isFinite(serverPer) && Math.abs(clickedPer - serverPer) < 0.005
          && String(metadata.optionId || '') === String(offer.option?.id || ''))
        : !(rawPer === null || rawPer === undefined));
    if (offerMismatch) {
      return res.status(409).json({ error: 'This offer is no longer available — please refresh the page' });
    }

    const requestedService = normalizeRequestedServiceKey(offer.serviceKey) || offer.serviceKey;
    const perApplication = Number(offer.option?.perVisit);
    const priceText = Number.isFinite(perApplication) && perApplication > 0
      ? `(shown $${perApplication.toFixed(2)} per application on portal home)`
      : '(quote requested from portal home)';
    const outcome = await writeOrRefreshCtaRequest(db, {
      customerId: req.customerId,
      requestedService,
      source: 'portal_home',
      subject: `Add ${offer.label} — requested from portal home`,
      description: `Customer tapped "${offer.label}" on the portal home recommendations ${priceText}. Review and follow up — no customer message has been sent.`,
      // The server-computed offer snapshot — the shown price is the honored
      // price (sent-quote price-lock doctrine).
      revisionSnapshot: { source: 'portal_home', offer },
    });
    await ringBell(req.customerId, [offer.label, priceText].join(' '), offer.relationship, outcome);
    return res.json({ success: true, deduped: !!outcome.deduped });
  } catch (err) {
    next(err);
  }
});

// Bell AFTER the durable row exists; a bell failure leaves the row
// actionable in the Customer 360 requests panel either way.
async function ringBell(customerId, suggestedService, relationship, outcome) {
  if (outcome.deduped) return;
  const customer = await db('customers').where({ id: customerId }).first('first_name', 'last_name').catch(() => null);
  const { triggerNotification } = require('../services/notification-triggers');
  await triggerNotification('bundle_quote_requested', {
    bundled: false,
    customerId,
    customerName: `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() || null,
    suggestedService,
    relationship,
    refreshed: !!outcome.refreshed,
  }).catch((err) => {
    logger.warn(`[property-recommendations] bell failed (request ${outcome.request?.id} stands): ${err.message}`);
  });
}

module.exports = router;
