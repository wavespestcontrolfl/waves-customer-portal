'use strict';

/**
 * The technician estimate tool, step 2a (GATE_TECH_ESTIMATES, owner 2026-11-09): save the quote as a DRAFT
 * estimate and read his own. Nothing is sent, texted or emailed here (the send is step 4). Step 2b rings the office bell once for a
 * new held estimate, after the commit (ringIfHeld).
 *
 * The create rebuilds the quote exactly as the preview does (tech-estimate-price.js prepareQuote/judgeQuote),
 * then calls the SAME shared save (admin-estimate-persistence createOrReuseAdminEstimate), without dryRun, with
 * the digest the phone got from the preview as expectedEngineResultDigest: a price that moved in between is a
 * 409 price_changed. The save runs inside ONE transaction of ours, so the estimate row, the tool row, the
 * Sold by credit and the audit event commit together or not at all (the save's own transaction nests as a
 * savepoint; it has no post-commit side effect, and its advisory locks last until our commit, which only
 * makes a concurrent retry wait for the first answer).
 *
 * A retry with the same clientDraftId by the same technician answers the same estimate and writes nothing more
 * (no second tool row, credit or audit event). Responses are built field by field: never the public token, a
 * view URL, the stored estimate data, costs or margins.
 */

const db = require('../models/db');
const logger = require('./logger');
const Price = require('./tech-estimate-price');
const { roundMoney } = require('./billing-cadence');

const { PriceRefusal } = Price;
const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/i;
const LIST_LIMIT = 50;
// The save's own refusal when the digest does not match (admin-estimate-persistence assertApprovedEstimatePricing).
const PRICE_CHANGED_RE = /^The estimate price or options changed\./;

function createKeys(body) {
  const { clientDraftId, digest } = body;
  if (typeof clientDraftId !== 'string' || !DRAFT_ID_RE.test(clientDraftId)) throw new PriceRefusal(400, 'Send the draft id again.');
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw new PriceRefusal(400, 'Price the quote again before saving it.');
  return { clientDraftId, digest: digest.toLowerCase() };
}

// The save's refusals as the tool answers them. A message from the save is never echoed, except a bad typed phone.
function saveRefusal(err) {
  const status = Number(err && (err.statusCode || err.status));
  if (err && err.code === 'INVALID_PHONE') return new PriceRefusal(400, err.message);
  if (status === 409 && PRICE_CHANGED_RE.test(String(err.message))) {
    return new PriceRefusal(409, 'The price changed. Price it again.', { code: 'price_changed' });
  }
  if (status >= 400 && status < 500) return Price.officePrices();
  return err;
}

// The tool row, the Sold by credit and the audit event for a NEW estimate; a retry only reads its stored reasons.
async function recordToolEstimate(trx, req, saved, detailed) {
  const { estimate } = saved;
  const where = { estimate_id: estimate.id, technician_id: req.technicianId };
  const stored = () => trx('tech_estimates').where(where).first('office_first_reasons');
  const inserted = saved.reused ? [] : await trx('tech_estimates')
    .insert({ ...where, office_first_reasons: JSON.stringify(detailed) })
    .onConflict('estimate_id').ignore()
    .returning('estimate_id');
  if (inserted.length === 0) {
    // A retry. An id that is not his tool estimate (an office estimate, or another login's) is refused.
    const row = await stored();
    if (!row) throw Price.officePrices();
    return { estimate, detailed: row.office_first_reasons || [], created: false };
  }
  // Sold by = the creator, for a W-2 technician only: an admin login is never credited.
  const credited = req.techRole === 'admin' ? estimate
    : await require('./estimate-sold-by').creditCreator(trx, estimate, { technicianId: req.technicianId });
  await require('./audit-log').recordAuditEvent({
    actor_type: 'technician',
    actor_id: req.technicianId,
    action: 'tech_estimate.created',
    resource_type: 'estimates',
    resource_id: estimate.id,
    metadata: { estimate_id: estimate.id, technician_id: req.technicianId, customer_id: estimate.customer_id || null, office_first: detailed.length > 0 },
    critical: true,
    trx,
  });
  return { estimate: credited, detailed, created: true };
}

async function saveDraft(req, { prep, clientDraftId, digest, detailed }) {
  try {
    return await db.transaction(async (trx) => {
      const saved = await require('./admin-estimate-persistence').createOrReuseAdminEstimate({
        database: trx,
        body: { ...prep.saveBody, clientDraftId },
        technicianId: req.technicianId,
        technician: req.technician,
        requireLivePricing: true,
        expectedEngineResultDigest: digest,
      });
      return recordToolEstimate(trx, req, saved, detailed);
    });
  } catch (err) {
    throw saveRefusal(err);
  }
}

// Step 2b: a NEW estimate held for the office rings the admin bell once (tech-estimate-office-bell.js). It runs after the
// transaction has committed. A failure to raise is logged (ids only) and never fails the create: the estimate is saved and
// the office also sees it in the estimate list.
async function ringIfHeld(req, saved) {
  if (!saved.created || saved.detailed.length === 0) return;
  try {
    await require('./tech-estimate-office-bell').ringOfficeFirst({ estimate: saved.estimate, detailed: saved.detailed, technician: req.technician });
  } catch (err) {
    logger.warn(`[tech-estimates] office bell not raised for estimate ${saved.estimate.id} (technician ${req.technicianId}): ${String(err?.code || err?.name || 'error').slice(0, 40)}`);
  }
}

async function createQuote(req, body) {
  const { clientDraftId, digest } = createKeys(body);
  const prep = await Price.prepareQuote(req, body);
  const judged = await Price.judgeQuote(req, prep);
  const phoneMatch = await Price.phoneMatchesCustomer(prep.subject);
  const saved = await saveDraft(req, { prep, clientDraftId, digest, detailed: Price.detailedReasons(prep, judged, { phoneMatch }) });
  await ringIfHeld(req, saved);
  return {
    id: saved.estimate.id,
    status: saved.estimate.status,
    // The stored row is the truth (a retry answers what was saved), shaped like the preview.
    ...Price.quoteAnswer(saved.estimate, Price.parseEstimateData(saved.estimate), { facts: prep.layered.shown, detailed: saved.detailed }),
  };
}

// ---------------------------------------------------------------------------
// His own estimates

// His rows only (an admin login sees only its own too), archived ones left out like the admin list. `who` is the stored
// customer name, or the linked customer's name for a customer on his route.
const OWN_COLUMNS = [
  'e.id', 't.created_at', 'e.status', 'e.sent_at', 'e.accepted_at', 'e.address',
  'e.monthly_total', 'e.annual_total', 'e.onetime_total', 't.office_first_reasons',
];
const ownQuery = (req) => db('tech_estimates as t')
  .join('estimates as e', 'e.id', 't.estimate_id')
  .leftJoin('customers as c', 'c.id', 'e.customer_id')
  .where('t.technician_id', req.technicianId)
  .whereNull('e.archived_at');
const whoColumn = () => db.raw("COALESCE(NULLIF(e.customer_name, ''), NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '')) as who");

function ownShape(row) {
  const stored = Array.isArray(row.office_first_reasons) ? row.office_first_reasons : [];
  const reasons = Price.phoneReasons(stored);
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    sentAt: row.sent_at || null,
    acceptedAt: row.accepted_at || null,
    who: row.who || null,
    addressLine: String(row.address || '').split(',')[0].trim(),
    monthlyTotal: roundMoney(row.monthly_total),
    annualTotal: roundMoney(row.annual_total),
    oneTimeTotal: roundMoney(row.onetime_total),
    officeFirst: { required: reasons.length > 0, reasons },
    // Step 4: the Send button shows for his draft only when no stored reason holds it for the office.
    canSend: row.status === 'draft' && stored.length === 0,
  };
}

async function listOwn(req) {
  const rows = await ownQuery(req).orderBy('t.created_at', 'desc').limit(LIST_LIMIT).select(...OWN_COLUMNS, whoColumn());
  return { estimates: rows.map(ownShape) };
}

// 404 for an id that is not his, the same answer as an unknown id.
async function readOwn(req, id) {
  const notFound = new PriceRefusal(404, 'Estimate not found');
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound;
  const row = await ownQuery(req).where('e.id', id).first(...OWN_COLUMNS, 'e.estimate_data', whoColumn());
  if (!row) throw notFound;
  return { ...ownShape(row), lines: Price.buildLines((Price.parseEstimateData(row) || {}).result || {}) };
}

module.exports = { createQuote, listOwn, readOwn, _private: { createKeys, saveRefusal } };
