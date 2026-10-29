/**
 * "Sold by" on an estimate (owner ruling 2026-10-29, D5 part 3b-1 of the first-technician pay
 * plan: "the technician's flag, checked by the truck GPS, fills in 'Sold by'"). Dark behind
 * GATE_COMMISSION_SOLD_BY. This records WHO sold; the commission ledger that pays it is part
 * 3b-2 and reads only estimates.sold_by_technician_id. Nothing here pays, texts, emails or
 * charges anyone.
 *
 * Three ways the column gets its value:
 *  - 'flag': a GPS-verified field lead of an active W-2 technician matches the estimate (the
 *    auto-fill, run from createOrReuseAdminEstimate and reviseAdminEstimate);
 *  - 'office': an admin chose the technician;
 *  - 'cleared': an admin chose no one. Auto-fill never refills a cleared estimate.
 * Once the customer accepts (accepted_at set) the value is locked.
 */
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');

const FLAG_LOOKBACK_DAYS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCKED_MESSAGE = 'Sold by is locked once the customer accepts.';

// Call-time read, guarded so a test that mocks the whole feature-gates module keeps working.
function soldByLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.commissionSoldByLive === 'function' && gates.commissionSoldByLive() === true;
}

function errorWithStatus(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const SOLD_BY_COLUMNS = [
  'sold_by_technician_id', 'sold_by_source', 'sold_by_lead_id', 'sold_by_set_by', 'sold_by_set_at',
];

// The newest qualifying field flag for the estimate, or null. Matches by customer, by the last
// ten digits of the phone, or by the lead already linked to the estimate. The seller is the
// technician who flagged (gps_check.technician_id, written once by the flag), never
// leads.assigned_to, which the office may reassign.
async function findMatchingFlag(trx, estimate, now) {
  const since = new Date(now.getTime() - FLAG_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const phoneDigits = String(estimate.customer_phone || '').replace(/\D/g, '');
  const phoneKey = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : null;
  const query = trx('leads')
    .joinRaw("JOIN technicians ON technicians.id::text = leads.gps_check->>'technician_id'")
    .where('leads.gps_verified', true)
    .where('leads.first_contact_channel', 'field_observation')
    .whereNull('leads.deleted_at')
    .where('leads.created_at', '>=', since)
    .where('leads.created_at', '<=', now)
    .where('technicians.employment_type', 'w2')
    .where('technicians.active', true)
    .where(function matchesEstimate() {
      this.where('leads.estimate_id', estimate.id);
      if (estimate.customer_id) this.orWhere('leads.customer_id', estimate.customer_id);
      if (phoneKey) {
        this.orWhereRaw(
          "length(regexp_replace(coalesce(leads.phone, ''), '\\D', '', 'g')) >= 10 AND right(regexp_replace(coalesce(leads.phone, ''), '\\D', '', 'g'), 10) = ?",
          [phoneKey],
        );
      }
    })
    .orderBy('leads.created_at', 'desc')
    .orderBy('leads.id', 'desc');
  return query.first('leads.id as lead_id', 'technicians.id as technician_id');
}

/**
 * Auto-fill, inside the estimate's write transaction. Gate off, an accepted estimate, or any
 * estimate that already has a source (flag, office or cleared) changes nothing. Returns the
 * estimate row, with the Sold by columns when this call filled them.
 */
async function autoFillSoldBy(trx, estimate, { now = () => new Date() } = {}) {
  if (!soldByLive() || !estimate?.id) return estimate;
  if (estimate.accepted_at || estimate.sold_by_source) return estimate;
  const at = now();
  const flag = await findMatchingFlag(trx, estimate, at);
  if (!flag) return estimate;
  // The guards ride the write: a concurrent accept or admin choice wins.
  const [filled] = await trx('estimates')
    .where({ id: estimate.id })
    .whereNull('accepted_at')
    .whereNull('sold_by_source')
    .update({
      sold_by_technician_id: flag.technician_id,
      sold_by_source: 'flag',
      sold_by_lead_id: flag.lead_id,
      sold_by_set_at: at,
    })
    .returning(SOLD_BY_COLUMNS);
  return filled ? { ...estimate, ...filled } : estimate;
}

async function loadSellerCandidate(database, technicianId) {
  const tech = await database('technicians').where({ id: technicianId }).first('id', 'name', 'active', 'employment_type');
  if (!tech || tech.active !== true || tech.employment_type !== 'w2') {
    throw errorWithStatus('Sold by must be an active W-2 technician.', 400);
  }
  return tech;
}

/**
 * Admin sets (technicianId) or clears (null) Sold by. 409 once accepted. One critical audit
 * event, ids and sources only. Returns the new values.
 */
async function setEstimateSoldBy({ database = db, estimateId, technicianId, actorId, now = () => new Date() }) {
  if (technicianId !== null && (typeof technicianId !== 'string' || !UUID_RE.test(technicianId))) {
    throw errorWithStatus('technicianId must be a technician id or null.', 400);
  }
  if (typeof estimateId !== 'string' || !UUID_RE.test(estimateId)) throw errorWithStatus('Estimate not found', 404);
  return database.transaction(async (trx) => {
    const estimate = await trx('estimates').where({ id: estimateId }).forUpdate()
      .first('id', 'accepted_at', 'sold_by_technician_id', 'sold_by_source');
    if (!estimate) throw errorWithStatus('Estimate not found', 404);
    if (estimate.accepted_at) throw errorWithStatus(LOCKED_MESSAGE, 409);
    if (technicianId) await loadSellerCandidate(trx, technicianId);
    const next = {
      sold_by_technician_id: technicianId || null,
      sold_by_source: technicianId ? 'office' : 'cleared',
      sold_by_lead_id: null,
      sold_by_set_by: actorId || null,
      sold_by_set_at: now(),
    };
    await trx('estimates').where({ id: estimateId }).update(next);
    await recordAuditEvent({
      actor_type: 'admin',
      actor_id: actorId || null,
      action: 'estimate.sold_by_set',
      resource_type: 'estimate',
      resource_id: estimateId,
      metadata: {
        previous_technician_id: estimate.sold_by_technician_id || null,
        previous_source: estimate.sold_by_source || null,
        technician_id: next.sold_by_technician_id,
        source: next.sold_by_source,
      },
      critical: true,
      trx,
    });
    return next;
  });
}

// Active W-2 technicians an admin can pick from.
async function listSellerCandidates(database = db) {
  return database('technicians').where({ active: true, employment_type: 'w2' }).orderBy('name').select('id', 'name');
}

// The soldBy block for the admin estimate list: one batched read for the page of estimates.
// Returns null when the gate is off. Map of estimate id -> block.
async function loadSoldByForList(database, estimates) {
  if (!soldByLive()) return null;
  const rows = estimates.filter((e) => e.sold_by_source);
  const techIds = [...new Set(rows.map((e) => e.sold_by_technician_id).filter(Boolean))];
  const leadIds = [...new Set(rows.map((e) => e.sold_by_lead_id).filter(Boolean))];
  const names = new Map();
  if (techIds.length) {
    for (const t of await database('technicians').whereIn('id', techIds).select('id', 'name')) names.set(String(t.id), t.name);
  }
  const leads = new Map();
  if (leadIds.length) {
    for (const l of await database('leads').whereIn('id', leadIds).select('id', 'created_at', 'gps_check')) leads.set(String(l.id), l);
  }
  const out = new Map();
  for (const e of estimates) {
    const lead = e.sold_by_lead_id ? leads.get(String(e.sold_by_lead_id)) : null;
    const check = lead?.gps_check && typeof lead.gps_check === 'object' ? lead.gps_check : null;
    out.set(e.id, {
      technicianId: e.sold_by_technician_id || null,
      name: e.sold_by_technician_id ? names.get(String(e.sold_by_technician_id)) || null : null,
      source: e.sold_by_source || null,
      leadId: e.sold_by_lead_id || null,
      gpsDistanceM: knownMeters(check?.distance_m),
      flaggedAt: lead?.created_at || null,
    });
  }
  return out;
}

// A distance the check measured, or null when it did not (null must not read as 0 m).
function knownMeters(value) {
  if (value === null || value === undefined || value === '') return null;
  const meters = Number(value);
  return Number.isFinite(meters) ? meters : null;
}

// Spread into a list row: {} with the gate off.
function soldByRowFields(soldByById, estimateId) {
  return soldByById ? { soldBy: soldByById.get(estimateId) } : {};
}

module.exports = {
  LOCKED_MESSAGE,
  soldByLive,
  autoFillSoldBy,
  setEstimateSoldBy,
  listSellerCandidates,
  loadSoldByForList,
  soldByRowFields,
};
