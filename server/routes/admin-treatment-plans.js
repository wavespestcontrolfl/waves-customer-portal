const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const { lawnCompletionDefaultsEnabled } = require('../services/lawn-completion-defaults');
const { isTechnicianRequest, technicianCurrentVisitFilter } = require('../services/technician-visit-scope');
const { stripKeysDeep, deepStripPriceTokens } = require('../services/protocol-reader');
const db = require('../models/db');
const Joi = require('joi');

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

function plannerOptions(req) {
  const body = req.body || {};
  const includeCompletionDefaults = req.query.completionDefaults === '1' || body.completionDefaults === true;
  const completionDefaultsEnabled = lawnCompletionDefaultsEnabled();
  const { value, error } = Joi.object({ lawnSqft: Joi.number().strict().integer().min(1).max(10000000).allow(null) })
    .validate({ lawnSqft: body.lawnSqft });
  if (error || (value.lawnSqft !== undefined && (!includeCompletionDefaults || !completionDefaultsEnabled))) {
    const err = new Error(error ? 'lawnSqft must be a positive whole number, or null to clear the visit area.' : 'Lawn completion defaults are unavailable.');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  return {
    includeCompletionDefaults, completionDefaultsEnabled, ...value,
    ...Object.fromEntries(['equipmentSystemId', 'calibrationId', 'selectedConditionalProductIds', 'selectedConditionalProductNames', 'selectedConditionalRaw']
      .map(key => [key, body[key] || req.query[key] || null])),
  };
}

// The plan is built with office-only inputs the response must not carry:
// customers.billing_mode rides propertyGate.billingMode for completion
// attribution (lawnPlanProgramApplies) and is stripped here for EVERY caller
// — technicians read this router, and the technician Customer 360 projection
// already withholds billingMode with the other billing fields (Codex #4365
// P2). Completion attribution builds its own plan server-side, never from
// this response.
// `stockAdvisory: true` when /complete takes this lawn visit's stock below zero instead of
// refusing (the same classifier), so the full completion form drops its inventory hold too. Absent otherwise.
//
// A technician also gets no vendor price or job cost (technician visibility audit
// A3): the plan repeats each product under protocol.base / conditional and
// mixCalculator.conditionalOptions, so the owner-only keys are removed at every
// depth, and priced protocol lines ("($2.18)") lose their dollar tokens as on the
// Protocols page. TreatmentPlanPanel reads none of these fields.
const TECHNICIAN_PLAN_OWNER_ONLY_KEYS = new Set([
  'bestPrice', 'costPerUnit', 'costUnit', 'needsPricing',
  'materialCost', 'materialCostSource', 'materialCostDetail', 'materialCostSummary',
]);

function projectPlanResponse(plan, { technician = false } = {}) {
  let projected = plan;
  if (plan && typeof plan === 'object' && plan.propertyGate && typeof plan.propertyGate === 'object') {
    const { billingMode: _billingMode, ...propertyGate } = plan.propertyGate;
    const stockAdvisory = require('../services/stock-advisory').isLawnTsStockAdvisoryCompletion({ service_type: propertyGate.service });
    projected = { ...plan, propertyGate, ...(stockAdvisory ? { stockAdvisory: true } : {}) };
  }
  return technician ? deepStripPriceTokens(stripKeysDeep(projected, TECHNICIAN_PLAN_OWNER_ONLY_KEYS)) : projected;
}

// Every technician request is pinned to a current/recent assigned visit —
// not only completion-default requests (codex #5568 r2 P1: the plan carries
// the customer's name, locality, lawn area and cost details). Admins pass.
async function completionScopeAllowed(req) {
  if (!isTechnicianRequest(req)) return true;
  const visit = await db('scheduled_services').where({ id: req.params.serviceId })
    .modify(query => technicianCurrentVisitFilter(req, query)).first('id');
  return !!visit;
}

// Read-only WaveGuard planner.
// Returns the six field cards for a scheduled service without creating
// completion records, deducting inventory, or approving exceptions.
router.get('/:serviceId', async (req, res, next) => {
  try {
    if (!(await completionScopeAllowed(req))) return res.status(404).json({ error: 'Visit not found' });
    const plan = await buildPlanForService(req.params.serviceId, plannerOptions(req));
    if (!(await completionScopeAllowed(req))) return res.status(404).json({ error: 'Visit not found' });
    if (plan.completionDefaults) res.set('Cache-Control', 'private, no-store');
    res.json({ plan: projectPlanResponse(plan, { technician: isTechnicianRequest(req) }) });
  } catch (err) {
    next(err);
  }
});

router.post('/:serviceId/build', async (req, res, next) => {
  try {
    if (!(await completionScopeAllowed(req))) return res.status(404).json({ error: 'Visit not found' });
    const plan = await buildPlanForService(req.params.serviceId, plannerOptions(req));
    if (!(await completionScopeAllowed(req))) return res.status(404).json({ error: 'Visit not found' });
    if (plan.completionDefaults) res.set('Cache-Control', 'private, no-store');
    res.json({ plan: projectPlanResponse(plan, { technician: isTechnicianRequest(req) }) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
