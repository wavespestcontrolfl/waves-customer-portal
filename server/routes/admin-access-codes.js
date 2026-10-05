/**
 * Admin access codes (access codes section, server half, PR 2a).
 *
 * GET    /?customerId=      — one customer's codes: { active, found }
 * GET    /found             — every customer's codes waiting for a decision
 *                             (?limit, ?offset), newest first
 * POST   /                  — the office adds a code (active at once)
 *                             { customerId, kind, life, code?, instructions? }
 * POST   /:id/accept        — accept a found code, optionally edited
 *                             { kind?, life?, code?, instructions? }
 * POST   /:id/dismiss       — found → dismissed
 * POST   /:id/retire        — active → retired
 *
 * Staff-only (full admin) and no-store. Dark behind GATE_ACCESS_CODES_SECTION
 * (read at call time): off answers 404 { enabled: false } on every route.
 *
 * Never echo a code in an error and never log one: ids and error codes only
 * (knex errors carry bindings, so err.message is never logged either).
 */
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const access = require('../services/access-code-capture');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
router.use((req, res, next) => {
  // no-store first, so the disabled answer is never cached past a gate flip.
  res.set('Cache-Control', 'no-store');
  if (!access.enabled()) return res.status(404).json({ enabled: false });
  return next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const MESSAGES = {
  not_found: 'That access code was not found',
  customer_not_found: 'That customer was not found',
  not_pending: 'That code was already decided',
  not_active: 'That code is not active',
  duplicate_active: 'That customer already has this code',
  duplicate: 'Another code from the same text already has this value',
  invalid_customer: 'customerId must be a customer id',
  invalid_kind: 'kind is not valid',
  invalid_life: 'life must be standing or visit',
  invalid_code: 'code must be text of 40 characters or fewer',
  invalid_instructions: 'instructions must be text of 600 characters or fewer',
  value_required: 'A code or instructions are required',
  invalid_visit: 'scheduledServiceId must be a visit of this customer that has not ended',
  visit_required: 'Choose the visit this code is for',
  expired: 'This one-visit code is more than 14 days old',
  source_moved: 'The text this code came from now belongs to another customer',
  invalid_body: 'The request body must be a JSON object',
};

function logFailure(what, err) {
  logger.error(`[admin-access-codes] ${what} failed (${(err && (err.code || err.name)) || 'error'})`);
}

function send(res, result) {
  if (result.ok) return res.json({ accessCode: result.row, profileField: result.profileField || null });
  return res.status(result.status).json({ error: MESSAGES[result.code] || 'Request failed', code: result.code });
}

function positiveInt(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null);

// Only the fields the caller supplied: an absent key keeps the current value,
// an explicit null clears code or instructions.
function suppliedFields(input) {
  const out = {};
  for (const key of ['kind', 'life', 'code', 'instructions', 'scheduledServiceId']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  return out;
}

function failWith(res, what, err) {
  logFailure(what, err);
  return res.status(500).json({ error: 'Request failed', code: 'server_error' });
}

router.get('/', async (req, res) => {
  const customerId = String(req.query.customerId || '');
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: MESSAGES.invalid_customer, code: 'invalid_customer' });
  try {
    return res.json(await access.listForCustomer(db, customerId));
  } catch (err) {
    return failWith(res, 'list', err);
  }
});

router.get('/found', async (req, res) => {
  try {
    return res.json(await access.listFound(db, {
      limit: positiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT,
      offset: positiveInt(req.query.offset, 0, 1000000),
    }));
  } catch (err) {
    return failWith(res, 'list found', err);
  }
});

router.post('/', async (req, res) => {
  const input = body(req);
  if (!input) return res.status(400).json({ error: MESSAGES.invalid_body, code: 'invalid_body' });
  try {
    return send(res, await access.addByStaff(db, {
      customerId: String(input.customerId || ''), ...suppliedFields(input), adminUserId: req.technicianId,
    }));
  } catch (err) {
    return failWith(res, 'add', err);
  }
});

router.post('/:id/accept', async (req, res) => {
  const input = req.body === undefined ? {} : body(req);
  if (!input) return res.status(400).json({ error: MESSAGES.invalid_body, code: 'invalid_body' });
  try {
    return send(res, await access.accept(db, req.params.id, { ...suppliedFields(input), adminUserId: req.technicianId }));
  } catch (err) {
    return failWith(res, 'accept', err);
  }
});

router.post('/:id/dismiss', async (req, res) => {
  try {
    return send(res, await access.dismiss(db, req.params.id, { adminUserId: req.technicianId }));
  } catch (err) {
    return failWith(res, 'dismiss', err);
  }
});

router.post('/:id/retire', async (req, res) => {
  try {
    return send(res, await access.retire(db, req.params.id, { adminUserId: req.technicianId }));
  } catch (err) {
    return failWith(res, 'retire', err);
  }
});

module.exports = router;
