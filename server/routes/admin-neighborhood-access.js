/**
 * Admin neighborhood gate-code directory (PR 3b of the gate-code directory).
 *
 * GET    /                          — neighborhoods with their gate entries
 *                                     (?q= search, ?filter=needs_confirm,
 *                                     ?include_retired=1, ?neighborhood=<id>, ?limit, ?offset)
 * GET    /customers/:customerId/properties — the customer's active properties, each
 *                                     with its neighborhood and that neighborhood's live entries
 * PUT    /properties/:propertyId/neighborhood — the office links a property to a
 *                                     neighborhood ({ neighborhoodId }), creates one
 *                                     ({ create: { name, county } }) or clears it
 *                                     ({ neighborhoodId: null }); an office pick is never
 *                                     overwritten by the county lookup
 * POST   /:neighborhoodId/entries   — office adds an entry (active, confirmed now;
 *                                     other live codes there then need confirming)
 * PATCH  /entries/:id               — edit an entry (a new value counts as confirmed),
 *                                     or { action: 'confirm' | 'retire' }
 * POST   /visits/:visitId/entries   — from a visit: add a keypad code to that
 *                                     visit's neighborhood ({ code, gateLabel? })
 * POST   /visits/:visitId/entries/:entryId/wrong — from a visit: report a
 *                                     neighborhood code wrong ({ code }: the code shown)
 *
 * A neighborhood's gate code is shared by every stop in it and is staff-only:
 * every route but the two /visits ones requires full admin, and every
 * response is no-store. The /visits routes (owner ruling 2026-10-03, dark
 * behind GATE_NEIGHBORHOOD_TECH_ACTIONS) also admit a technician, only
 * through a visit assigned to them: an added code is live at once, a code
 * marked wrong drops to needs_confirm and the office decides. No bell. QR / app passes are stored as instructions only,
 * never as a code. Dark behind GATE_NEIGHBORHOOD_ACCESS (read at call time):
 * off answers 404 { enabled: false } on every route.
 *
 * Never log a code or an instructions value — ids and error codes only (knex
 * errors carry bindings, so err.message is never logged either).
 */
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const { neighborhoodAccessLive, neighborhoodTechActionsLive } = require('../config/feature-gates');
const { isKeypadCode, matchKey, visitNeighborhoodIds } = require('../services/neighborhood-access');
const { isTechnicianRequest, lockOwnedLiveVisit } = require('../services/technician-visit-scope');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');

const router = express.Router();
router.use(adminAuthenticate);
router.use((req, res, next) => {
  // no-store first, so the disabled answer is never cached past a gate flip.
  res.set('Cache-Control', 'no-store');
  if (!neighborhoodAccessLive()) return res.status(404).json({ enabled: false });
  return next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TYPES = ['keypad', 'callbox', 'guard', 'pass', 'open', 'instructions'];
const STALE_MONTHS = 6;
const MAX_LABEL = 60;
const MAX_CODE = 100;
const MAX_INSTRUCTIONS = 1000;
const MAX_QUERY = 100;
const MAX_NAME = 120;
const COUNTIES = ['Manatee', 'Sarasota', 'Charlotte'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const KEYPAD_CODE_ERROR = 'A keypad code is 3 to 8 digits, with an optional leading or trailing # or *';

function logFailure(what, err) {
  logger.error(`[admin-neighborhood-access] ${what} failed (${(err && (err.code || err.name)) || 'error'})`);
}

function staleCutoff() {
  const d = new Date();
  d.setMonth(d.getMonth() - STALE_MONTHS);
  return d;
}

function serializeEntry(row, { cutoff, conflicted, staffNames }) {
  const confirmedAt = row.last_confirmed_at || null;
  const basis = confirmedAt || row.created_at;
  return {
    id: row.id,
    gateLabel: row.gate_label,
    accessType: row.access_type,
    code: row.code || null,
    instructions: row.instructions || null,
    status: row.status,
    source: row.source,
    lastConfirmedAt: confirmedAt ? new Date(confirmedAt).toISOString() : null,
    stale: row.status === 'active' && !!basis && new Date(basis) < cutoff,
    conflict: conflicted && !!row.code && row.status !== 'retired',
    // Field provenance: who added it from a visit, and a standing "this code
    // is wrong" report (cleared when the office confirms or edits the value).
    addedBy: row.source_technician_id ? (staffNames.get(row.source_technician_id) || 'Staff') : null,
    markedWrongAt: row.flagged_wrong_at ? new Date(row.flagged_wrong_at).toISOString() : null,
    markedWrongBy: row.flagged_wrong_at ? (staffNames.get(row.flagged_wrong_by) || 'Staff') : null,
  };
}

function positiveInt(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Overlay the supplied text fields on the current entry; null on a bad type.
function mergeFields(input, current) {
  const merged = { ...current };
  for (const field of ['gate_label', 'access_type', 'code', 'instructions']) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const v = input[field];
    if (v === null && field !== 'gate_label' && field !== 'access_type') merged[field] = null;
    else if (typeof v === 'string') merged[field] = v.trim();
    else return { error: `${field} must be text` };
  }
  return { merged };
}

// Merge the requested fields over the current entry and validate the result.
// Returns { error } or { value: { gate_label, access_type, code, instructions } }.
function validateEntry(body, current) {
  const input = body && typeof body === 'object' ? body : {};
  const overlay = mergeFields(input, current);
  if (overlay.error) return overlay;
  const { merged } = overlay;
  const codeSupplied = Object.prototype.hasOwnProperty.call(input, 'code');

  const label = String(merged.gate_label || '').trim();
  if (!label) return { error: 'gate_label is required' };
  if (label.length > MAX_LABEL) return { error: `gate_label is limited to ${MAX_LABEL} characters` };
  if (!ACCESS_TYPES.includes(merged.access_type)) return { error: 'access_type is not valid' };

  const rawCode = merged.code ? String(merged.code).trim() : '';
  if (rawCode.length > MAX_CODE) return { error: `code is limited to ${MAX_CODE} characters` };
  const instructions = merged.instructions ? String(merged.instructions).trim() : '';
  if (instructions.length > MAX_INSTRUCTIONS) return { error: `instructions are limited to ${MAX_INSTRUCTIONS} characters` };

  let code = null;
  if (merged.access_type === 'keypad') {
    if (!rawCode) return { error: 'A keypad entry needs a code' };
    if (!isKeypadCode(rawCode)) return { error: KEYPAD_CODE_ERROR };
    code = rawCode.replace(/\s+/g, '');
  } else {
    // Passes and app QR codes are stored as instructions only, never as a code.
    if (codeSupplied && rawCode) return { error: 'Only keypad entries take a code; put other access details in instructions' };
    if (!instructions) return { error: 'This entry type needs instructions' };
  }
  // A keypad entry is its code alone (as the filer stores it): instructions
  // left over from an entry switched to keypad are cleared, never kept
  // beside the code where the keypad form cannot show or edit them.
  return {
    value: {
      gate_label: label,
      access_type: merged.access_type,
      code,
      instructions: merged.access_type === 'keypad' ? null : (instructions || null),
    },
  };
}

// The office (or a fresh on-site code) answering a "this code is wrong" report.
const WRONG_REPORT_CLEARED = { flagged_wrong_at: null, flagged_wrong_by: null };

// Every other confirmed code in the neighborhood now needs confirming: a new
// code means one of them is stale or the community has two gates.
async function demoteOtherActiveCodes(trx, neighborhoodId, exceptId) {
  await trx('neighborhood_access')
    .where({ neighborhood_id: neighborhoodId, status: 'active' })
    .whereNotNull('code')
    .whereNot('id', exceptId)
    .update({ status: 'needs_confirm', updated_at: trx.fn.now() });
}

async function liveCodeTaken(trx, neighborhoodId, code, exceptId) {
  const q = trx('neighborhood_access')
    .where({ neighborhood_id: neighborhoodId })
    .whereNot('status', 'retired')
    .whereRaw('lower(code) = lower(?)', [code]);
  if (exceptId) q.whereNot('id', exceptId);
  return !!(await q.first('id'));
}

// ---- from a visit (technician or admin) --------------------------------------

// Declared BEFORE the router's requireAdmin below: these two are the only
// routes a technician reaches here.
function techActionsLive(req, res, next) {
  if (!neighborhoodTechActionsLive()) return res.status(404).json({ enabled: false });
  return next();
}

// Every open route screen refetches on dispatch:job_update: a shared code
// changed for every stop in the neighborhood, not only on the phone that
// sent it. Best effort, after the commit; the date set skips the
// route-quality refresh (no visit moved).
async function announceGateChange(req, result) {
  if (result.status >= 300) return;
  try {
    await emitDispatchJobUpdate({ jobId: req.params.visitId, actorId: req.technicianId, qualityDates: new Set() });
  } catch { /* the write stands; other screens catch up on their next load */ }
}

// A gate write always gives way. Other writers take the same rows in orders
// that cannot all be matched (the property writers lock the customer before
// its visits; the annual-prepay switch locks the visit before its customer),
// so instead of an order this transaction waits at most GATE_LOCK_WAIT_MS for
// any lock, well under Postgres's deadlock check, then rolls back and tries
// again. It can never be the transaction that makes a billing or property
// write fail; after the last try it answers "busy" and the technician retries.
const GATE_LOCK_WAIT_MS = 300;
const GATE_WRITE_TRIES = 3;
const BUSY = { status: 503, body: { error: 'That stop is busy right now. Try again in a moment.', code: 'busy' } };
const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';

async function gateWrite(work) {
  for (let attempt = 1; attempt <= GATE_WRITE_TRIES; attempt += 1) {
    try {
      return await db.transaction(async (trx) => {
        await trx.raw(`SET LOCAL lock_timeout = '${GATE_LOCK_WAIT_MS}ms'`);
        return work(trx);
      });
    } catch (err) {
      if (!err || ![LOCK_NOT_AVAILABLE, DEADLOCK_DETECTED].includes(err.code)) throw err;
      if (attempt < GATE_WRITE_TRIES) await new Promise((resolve) => { setTimeout(resolve, 50 * attempt); });
    }
  }
  return BUSY;
}

const NO_NEIGHBORHOOD = {
  status: 409,
  body: { error: 'This stop has no neighborhood yet. Ask the office to set one.', code: 'no_neighborhood' },
};

// The neighborhood of a visit this login may act on, read under the locks
// that make it stable, each waited for only briefly (see gateWrite):
//   1. the visit's CUSTOMER row, FOR SHARE. Every writer that adds a property,
//      changes the primary or relinks a neighborhood takes that row FOR
//      UPDATE first, so none of them can run until this commits and the
//      stop's neighborhood cannot move underneath the write;
//   2. the visit row (lockOwnedLiveVisit): a technician reaches only a visit
//      on their own route (assigned to them, not dead, inside the access
//      window, completed allowed), re-checked under the lock so a
//      reassignment or cancellation landing meanwhile cannot let a former
//      assignee's write through;
//   3. the neighborhood row (the lock every writer of its entries takes first).
// Returns { neighborhoodId } or { status, body }.
const VISIT_COLUMNS = [
  'scheduled_services.id', 'scheduled_services.customer_id', 'scheduled_services.property_id',
  'scheduled_services.service_address_line1', 'scheduled_services.service_address_zip',
];

async function lockVisitNeighborhood(trx, req, visitId) {
  const notFound = { status: 404, body: { error: 'Visit not found' } };
  if (!UUID_RE.test(visitId)) return notFound;
  // The customer is read off the visit before any lock, then confirmed under
  // the visit's lock: a visit moved to another customer meanwhile is refused.
  const peek = await trx('scheduled_services').where({ id: visitId }).first('customer_id');
  if (!peek || !peek.customer_id) return notFound;
  await trx('customers').where({ id: peek.customer_id }).forShare().first('id');
  let visit;
  try {
    visit = await lockOwnedLiveVisit(trx, req, visitId, VISIT_COLUMNS, { allowCompleted: true });
  } catch (err) {
    // Not theirs and not there read the same: a technician learns nothing
    // about another route's visits.
    if (err && (err.status === 403 || err.status === 404)) return notFound;
    throw err;
  }
  if (visit.customer_id !== peek.customer_id) return notFound;
  const neighborhoodId = (await visitNeighborhoodIds(trx, [visit])).get(visit.id);
  if (!neighborhoodId) return NO_NEIGHBORHOOD;
  const hood = await trx('neighborhoods').where({ id: neighborhoodId }).forUpdate().first('id', 'active');
  if (!hood || !hood.active) return NO_NEIGHBORHOOD;
  return { neighborhoodId };
}

// Returns { error } or { value: { code, gate_label } }. Keypad codes only: an
// instruction may be meant for one house, so those stay with the office.
function validateVisitCode(body) {
  const input = body && typeof body === 'object' ? body : {};
  if (typeof input.code !== 'string' || !input.code.trim()) return { error: 'Enter the gate code' };
  const raw = input.code.trim();
  if (raw.length > MAX_CODE || !isKeypadCode(raw)) return { error: KEYPAD_CODE_ERROR };
  let label = 'Main gate';
  if (input.gateLabel !== undefined && input.gateLabel !== null) {
    if (typeof input.gateLabel !== 'string') return { error: 'gateLabel must be text' };
    label = input.gateLabel.trim() || label;
    if (label.length > MAX_LABEL) return { error: `gateLabel is limited to ${MAX_LABEL} characters` };
  }
  return { value: { code: raw.replace(/\s+/g, ''), gate_label: label } };
}

router.post('/visits/:visitId/entries', requireTechOrAdmin, techActionsLive, async (req, res) => {
  const checked = validateVisitCode(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { code, gate_label: gateLabel } = checked.value;
  try {
    const result = await gateWrite(async (trx) => {
      const where = await lockVisitNeighborhood(trx, req, req.params.visitId);
      if (where.status) return where;
      const { neighborhoodId } = where;
      // The code that worked at the gate is the confirmed one (owner ruling
      // 2026-10-03): live at once, and every other confirmed code there now
      // needs confirming, the office-add rule.
      const existing = await trx('neighborhood_access')
        .where({ neighborhood_id: neighborhoodId })
        .whereNot('status', 'retired')
        .whereRaw('lower(code) = lower(?)', [code])
        .forUpdate()
        .first('id');
      if (existing) {
        // Already on file (perhaps unconfirmed or reported wrong): this is
        // fresh evidence for it. Who first filed it stays as recorded.
        await trx('neighborhood_access').where({ id: existing.id }).update({
          status: 'active', last_confirmed_at: trx.fn.now(), updated_at: trx.fn.now(), ...WRONG_REPORT_CLEARED,
        });
        await demoteOtherActiveCodes(trx, neighborhoodId, existing.id);
        return { status: 200, body: { id: existing.id, status: 'active' } };
      }
      const [ins] = await trx('neighborhood_access').insert({
        neighborhood_id: neighborhoodId,
        gate_label: gateLabel,
        access_type: 'keypad',
        code,
        status: 'active',
        source: isTechnicianRequest(req) ? 'tech' : 'office',
        source_technician_id: req.technicianId,
        last_confirmed_at: trx.fn.now(),
      }).returning('id');
      const newId = ins.id ?? ins;
      await demoteOtherActiveCodes(trx, neighborhoodId, newId);
      return { status: 201, body: { id: newId, status: 'active' } };
    });
    await announceGateChange(req, result);
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'That code is already on file for this neighborhood' });
    logFailure('visit add code', err);
    return res.status(500).json({ error: 'Could not save the gate code' });
  }
});

router.post('/visits/:visitId/entries/:entryId/wrong', requireTechOrAdmin, techActionsLive, async (req, res) => {
  const { entryId } = req.params;
  if (!UUID_RE.test(entryId)) return res.status(404).json({ error: 'Gate code not found' });
  // The code the technician was shown: an entry the office edited since is a
  // different code, never tested at the gate, and is not flagged.
  const shown = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
  if (!shown) return res.status(400).json({ error: 'code is required' });
  try {
    const result = await gateWrite(async (trx) => {
      const where = await lockVisitNeighborhood(trx, req, req.params.visitId);
      if (where.status) return where;
      // Only a code of THIS visit's neighborhood, and only a code: an
      // unconfirmed instruction is hidden from the schedule, so flagging one
      // would remove it for every stop.
      const row = await trx('neighborhood_access')
        .where({ id: entryId, neighborhood_id: where.neighborhoodId })
        .whereNot('status', 'retired')
        .whereNotNull('code')
        .forUpdate()
        .first('id', 'code');
      if (!row) return { status: 404, body: { error: 'Gate code not found' } };
      if (row.code.toLowerCase() !== shown.toLowerCase()) {
        return { status: 409, body: { error: 'That code was changed. Check your route for the new one.', code: 'entry_changed' } };
      }
      // Flagged, never retired (owner ruling 2026-10-03): the schedule tags
      // it "confirm on site" and the office decides.
      await trx('neighborhood_access').where({ id: entryId }).update({
        status: 'needs_confirm',
        flagged_wrong_at: trx.fn.now(),
        flagged_wrong_by: req.technicianId,
        updated_at: trx.fn.now(),
      });
      return { status: 200, body: { id: entryId, status: 'needs_confirm' } };
    });
    await announceGateChange(req, result);
    return res.status(result.status).json(result.body);
  } catch (err) {
    logFailure('visit mark wrong', err);
    return res.status(500).json({ error: 'Could not report the gate code' });
  }
});

// ---- the directory (admin only) -----------------------------------------------
router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, MAX_QUERY);
    const needsConfirmOnly = req.query.filter === 'needs_confirm';
    const includeRetired = ['1', 'true'].includes(String(req.query.include_retired || ''));
    const limit = Math.max(1, positiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT));
    const offset = positiveInt(req.query.offset, 0, 1_000_000);
    const onlyId = req.query.neighborhood === undefined ? null : String(req.query.neighborhood);
    if (onlyId !== null && !UUID_RE.test(onlyId)) return res.status(400).json({ error: 'neighborhood must be an id' });
    const cutoff = staleCutoff();

    const bindings = [cutoff];
    // ?picker=1 (Customer 360's neighborhood picker): every active
    // neighborhood, so an empty one can be reused instead of created again.
    const picker = req.query.picker === '1';
    let where = picker ? 'n.active' : 'n.active AND (COALESCE(f.live, 0) > 0 OR COALESCE(p.cnt, 0) > 0)';
    if (onlyId) {
      where += ' AND n.id = ?';
      bindings.push(onlyId);
    }
    if (needsConfirmOnly) where += ' AND (f.needs_confirm OR f.conflict OR f.stale)';
    if (q) {
      const like = likePattern(q);
      where += " AND (n.name ILIKE ? ESCAPE '\\' OR CAST(n.subdivision_names AS text) ILIKE ? ESCAPE '\\')";
      bindings.push(like, like);
    }
    const matched = `WITH matched AS (
      SELECT n.id, n.name, n.county, COALESCE(p.cnt, 0)::int AS property_count
      FROM neighborhoods n
      LEFT JOIN (
        SELECT neighborhood_id, count(*) AS cnt FROM customer_properties
        WHERE active AND neighborhood_id IS NOT NULL GROUP BY neighborhood_id
      ) p ON p.neighborhood_id = n.id
      LEFT JOIN (
        SELECT neighborhood_id,
          count(*) AS live,
          bool_or(status = 'needs_confirm') AS needs_confirm,
          bool_or(status = 'active' AND COALESCE(last_confirmed_at, created_at) < ?) AS stale,
          -- neighborhoodHasCodeConflict's rule: 2+ live codes, at least one unconfirmed.
          count(code) > 1 AND bool_or(code IS NOT NULL AND status = 'needs_confirm') AS conflict
        FROM neighborhood_access WHERE status <> 'retired' GROUP BY neighborhood_id
      ) f ON f.neighborhood_id = n.id
      WHERE ${where}
    )`;

    const total = Number((await db.raw(`${matched} SELECT count(*) AS total FROM matched`, bindings)).rows[0].total);
    const page = (await db.raw(
      `${matched} SELECT * FROM matched ORDER BY lower(name), id LIMIT ? OFFSET ?`,
      [...bindings, limit, offset],
    )).rows;

    const ids = page.map((r) => r.id);
    const entryRows = ids.length
      ? await db('neighborhood_access').whereIn('neighborhood_id', ids).orderBy([{ column: 'gate_label' }, { column: 'created_at' }, { column: 'id' }])
      : [];
    const byNeighborhood = new Map(ids.map((id) => [id, []]));
    for (const row of entryRows) byNeighborhood.get(row.neighborhood_id).push(row);
    const staffIds = [...new Set(entryRows.flatMap((r) => [r.source_technician_id, r.flagged_wrong_by]).filter(Boolean))];
    const staffNames = new Map(staffIds.length
      ? (await db('technicians').whereIn('id', staffIds).select('id', 'name')).map((t) => [t.id, t.name])
      : []);

    const neighborhoods = page.map((n) => {
      const rows = byNeighborhood.get(n.id);
      // The service's conflict rule (neighborhoodHasCodeConflict): two or more
      // live codes with at least one unconfirmed. Two codes the office has
      // confirmed are two real gates, not a conflict.
      const liveCodes = rows.filter((r) => r.code && r.status !== 'retired');
      const conflicted = liveCodes.length > 1 && liveCodes.some((r) => r.status === 'needs_confirm');
      return {
        id: n.id,
        name: n.name,
        county: n.county || null,
        propertyCount: n.property_count,
        hasConflict: conflicted,
        entries: rows
          .filter((r) => includeRetired || r.status !== 'retired')
          .map((r) => serializeEntry(r, { cutoff, conflicted, staffNames })),
      };
    });
    res.json({ neighborhoods, total, limit, offset });
  } catch (err) {
    logFailure('list', err);
    res.status(500).json({ error: 'Could not load gate codes' });
  }
});

// Each property with its neighborhood and that neighborhood's live entries.
async function propertyViews(conn, props) {
  const ids = [...new Set(props.map((p) => p.neighborhood_id).filter(Boolean))];
  // A switched-off neighborhood is not shown (the directory hides it and the
  // picker refuses it): the property reads as not linked, with no codes.
  const hoods = ids.length ? await conn('neighborhoods').whereIn('id', ids).where({ active: true }).select('id', 'name', 'county') : [];
  const entryRows = ids.length
    ? await conn('neighborhood_access').whereIn('neighborhood_id', ids).whereNot('status', 'retired')
      .orderBy([{ column: 'gate_label' }, { column: 'created_at' }, { column: 'id' }])
    : [];
  const hoodById = new Map(hoods.map((h) => [h.id, h]));
  return props.map((p) => {
    const hood = hoodById.get(p.neighborhood_id);
    return {
      id: p.id,
      label: p.label || null,
      addressLine1: p.address_line1 || null,
      addressLine2: p.address_line2 || null,
      city: p.city || null,
      zip: p.zip || null,
      neighborhood: hood ? { id: hood.id, name: hood.name, county: hood.county || null } : null,
      neighborhoodSource: hood ? (p.neighborhood_source || null) : null,
      entries: hood
        ? entryRows.filter((e) => e.neighborhood_id === hood.id).map((e) => ({
          id: e.id,
          gateLabel: e.gate_label,
          accessType: e.access_type,
          code: e.code || null,
          instructions: e.instructions || null,
          status: e.status,
        }))
        : [],
    };
  });
}

const PROPERTY_COLUMNS = ['id', 'label', 'address_line1', 'address_line2', 'city', 'zip', 'neighborhood_id', 'neighborhood_source'];

router.get('/customers/:customerId/properties', async (req, res) => {
  const { customerId } = req.params;
  if (!UUID_RE.test(customerId)) return res.status(404).json({ error: 'Customer not found' });
  try {
    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const props = await db('customer_properties').where({ customer_id: customerId, active: true })
      .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'created_at' }, { column: 'id' }])
      .select(PROPERTY_COLUMNS);
    return res.json({ properties: await propertyViews(db, props) });
  } catch (err) {
    logFailure('customer properties', err);
    return res.status(500).json({ error: 'Could not load the neighborhood' });
  }
});

// Returns { error } or { value: { neighborhoodId } | { create: { name, county } } }.
function validateLink(body) {
  const input = body && typeof body === 'object' ? body : {};
  const hasId = Object.prototype.hasOwnProperty.call(input, 'neighborhoodId');
  const hasCreate = Object.prototype.hasOwnProperty.call(input, 'create');
  if (hasId === hasCreate) return { error: 'Send either neighborhoodId or create' };
  if (hasId) {
    const id = input.neighborhoodId;
    if (id === null) return { value: { neighborhoodId: null } };
    if (typeof id !== 'string' || !UUID_RE.test(id)) return { error: 'neighborhoodId must be an id or null' };
    return { value: { neighborhoodId: id } };
  }
  const c = input.create && typeof input.create === 'object' ? input.create : null;
  if (!c) return { error: 'create needs a name and county' };
  const name = typeof c.name === 'string' ? c.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'name is required' };
  if (name.length > MAX_NAME) return { error: `name is limited to ${MAX_NAME} characters` };
  if (!COUNTIES.includes(c.county)) return { error: `county must be one of ${COUNTIES.join(', ')}` };
  return { value: { create: { name, county: c.county } } };
}

router.put('/properties/:propertyId/neighborhood', async (req, res) => {
  const { propertyId } = req.params;
  if (!UUID_RE.test(propertyId)) return res.status(404).json({ error: 'Property not found' });
  const checked = validateLink(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const link = checked.value;
  try {
    const result = await db.transaction(async (trx) => {
      // The sweep's lock order: the customer's advisory lock, the customer row,
      // the property row, then the neighborhood (advisory lock + row), so an
      // office pick and the filer cannot deadlock or overwrite each other.
      const peek = await trx('customer_properties').where({ id: propertyId }).first('customer_id');
      if (!peek) return { status: 404, body: { error: 'Property not found' } };
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(peek.customer_id)]);
      const customer = await trx('customers').where({ id: peek.customer_id }).whereNull('deleted_at').forUpdate().first('id');
      if (!customer) return { status: 404, body: { error: 'Property not found' } };
      const prop = await trx('customer_properties').where({ id: propertyId, customer_id: peek.customer_id, active: true })
        .forUpdate().first('id');
      if (!prop) return { status: 404, body: { error: 'Property not found' } };

      let neighborhoodId = null;
      if (link.create) {
        const { name, county } = link.create;
        const key = matchKey(county, name);
        // The same advisory key the county upsert takes, so a racing writer of
        // this name cannot insert a duplicate.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`neighborhood:${key}`]);
        const existing = await trx('neighborhoods').where({ match_key: key }).forUpdate().first('id', 'active');
        if (existing) {
          if (!existing.active) return { status: 409, body: { error: 'That neighborhood is switched off' } };
          neighborhoodId = existing.id;
        } else {
          const [ins] = await trx('neighborhoods').insert({
            name, county, match_key: key, subdivision_names: JSON.stringify([]), source: 'office',
          }).returning('id');
          neighborhoodId = ins.id ?? ins;
        }
      } else if (link.neighborhoodId) {
        const hood = await trx('neighborhoods').where({ id: link.neighborhoodId }).forUpdate().first('id', 'active');
        if (!hood || !hood.active) return { status: 404, body: { error: 'Neighborhood not found' } };
        neighborhoodId = hood.id;
      }

      // Checked-at is stamped on a clear too, so the county lookup never
      // overwrites an office decision.
      await trx('customer_properties').where({ id: propertyId }).update({
        neighborhood_id: neighborhoodId,
        neighborhood_source: 'office',
        neighborhood_checked_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      const updated = await trx('customer_properties').where({ id: propertyId }).first(PROPERTY_COLUMNS);
      return { status: 200, body: (await propertyViews(trx, [updated]))[0] };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'That neighborhood already exists' });
    logFailure('link property', err);
    return res.status(500).json({ error: 'Could not save the neighborhood' });
  }
});

router.post('/:neighborhoodId/entries', async (req, res) => {
  const { neighborhoodId } = req.params;
  if (!UUID_RE.test(neighborhoodId)) return res.status(404).json({ error: 'Neighborhood not found' });
  const checked = validateEntry(req.body, { gate_label: 'Main gate' });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const entry = checked.value;
  try {
    const result = await db.transaction(async (trx) => {
      const hood = await trx('neighborhoods').where({ id: neighborhoodId }).forUpdate().first('id', 'active');
      if (!hood || !hood.active) return { status: 404, body: { error: 'Neighborhood not found' } };
      if (entry.code && await liveCodeTaken(trx, neighborhoodId, entry.code)) {
        return { status: 409, body: { error: 'That code is already on file for this neighborhood' } };
      }
      const [ins] = await trx('neighborhood_access').insert({
        neighborhood_id: neighborhoodId,
        ...entry,
        status: 'active',
        source: 'office',
        last_confirmed_at: trx.fn.now(),
      }).returning('id');
      const newId = ins.id ?? ins;
      // The office's new code is the confirmed one: any other live code in
      // the neighborhood now needs confirming, as when the filer sees a new
      // code (the day feed then flags it "confirm on site").
      if (entry.code) await demoteOtherActiveCodes(trx, neighborhoodId, newId);
      return { status: 201, body: { id: newId } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    // The live-code unique index is the backstop for a racing writer.
    if (err && err.code === '23505') return res.status(409).json({ error: 'That code is already on file for this neighborhood' });
    logFailure('add entry', err);
    return res.status(500).json({ error: 'Could not save the entry' });
  }
});

router.patch('/entries/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Entry not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { action } = body;
  if (action !== undefined && !['confirm', 'retire'].includes(action)) {
    return res.status(400).json({ error: 'action must be confirm or retire' });
  }
  try {
    const result = await db.transaction(async (trx) => {
      // Lock order: neighborhood row, then the entry row (the same order the
      // filing service takes), so two writers on one gate cannot deadlock.
      const peek = await trx('neighborhood_access').where({ id }).first('neighborhood_id');
      if (!peek) return { status: 404, body: { error: 'Entry not found' } };
      await trx('neighborhoods').where({ id: peek.neighborhood_id }).forUpdate().first('id');
      const row = await trx('neighborhood_access').where({ id }).forUpdate().first();
      if (!row) return { status: 404, body: { error: 'Entry not found' } };

      if (action === 'retire') {
        if (row.status !== 'retired') {
          await trx('neighborhood_access').where({ id }).update({ status: 'retired', updated_at: trx.fn.now(), ...WRONG_REPORT_CLEARED });
        }
        return { status: 200, body: { id, status: 'retired' } };
      }
      if (row.status === 'retired') return { status: 409, body: { error: 'This entry is retired; add a new one instead' } };
      if (action === 'confirm') {
        await trx('neighborhood_access').where({ id }).update({
          status: 'active', last_confirmed_at: trx.fn.now(), updated_at: trx.fn.now(), ...WRONG_REPORT_CLEARED,
        });
        return { status: 200, body: { id, status: 'active' } };
      }

      const checked = validateEntry(body, {
        gate_label: row.gate_label, access_type: row.access_type, code: row.code, instructions: row.instructions,
      });
      if (checked.error) return { status: 400, body: { error: checked.error } };
      const next = checked.value;
      if (next.code && await liveCodeTaken(trx, row.neighborhood_id, next.code, id)) {
        return { status: 409, body: { error: 'That code is already on file for this neighborhood' } };
      }
      // The office changing the value vouches for it: the entry is confirmed.
      // A label-only edit keeps its status and confirmation date.
      const valueChanged = next.access_type !== row.access_type
        || (next.code || null) !== (row.code || null)
        || (next.instructions || null) !== (row.instructions || null);
      // The value is now the office's: it no longer comes from the customer
      // who filed it.
      const confirmation = valueChanged
        ? {
          status: 'active', last_confirmed_at: trx.fn.now(), source: 'office', source_customer_id: null,
          source_technician_id: null, ...WRONG_REPORT_CLEARED,
        }
        : {};
      await trx('neighborhood_access').where({ id }).update({ ...next, ...confirmation, updated_at: trx.fn.now() });
      return { status: 200, body: { id, status: valueChanged ? 'active' : row.status } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'That code is already on file for this neighborhood' });
    logFailure('update entry', err);
    return res.status(500).json({ error: 'Could not update the entry' });
  }
});

module.exports = router;
