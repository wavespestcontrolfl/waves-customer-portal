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
 *
 * A neighborhood's gate code is shared by every stop in it and is staff-only:
 * the whole router requires full admin (the tech portal is deprecated) and
 * every response is no-store. QR / app passes are stored as instructions only,
 * never as a code. Dark behind GATE_NEIGHBORHOOD_ACCESS (read at call time):
 * off answers 404 { enabled: false } on every route.
 *
 * Never log a code or an instructions value — ids and error codes only (knex
 * errors carry bindings, so err.message is never logged either).
 */
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { neighborhoodAccessLive } = require('../config/feature-gates');
const { isKeypadCode, matchKey } = require('../services/neighborhood-access');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
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

function logFailure(what, err) {
  logger.error(`[admin-neighborhood-access] ${what} failed (${(err && (err.code || err.name)) || 'error'})`);
}

function staleCutoff() {
  const d = new Date();
  d.setMonth(d.getMonth() - STALE_MONTHS);
  return d;
}

function serializeEntry(row, { cutoff, conflicted }) {
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
    if (!isKeypadCode(rawCode)) return { error: 'A keypad code is 3 to 8 digits, with an optional leading or trailing # or *' };
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

async function liveCodeTaken(trx, neighborhoodId, code, exceptId) {
  const q = trx('neighborhood_access')
    .where({ neighborhood_id: neighborhoodId })
    .whereNot('status', 'retired')
    .whereRaw('lower(code) = lower(?)', [code]);
  if (exceptId) q.whereNot('id', exceptId);
  return !!(await q.first('id'));
}

// Clearing a bell the change resolved is best-effort: it never fails the save.
async function closeBellsBestEffort(entryId) {
  try {
    await require('../services/neighborhood-access').closeResolvedConflictBells();
  } catch (err) {
    logger.warn(`[admin-neighborhood-access] conflict bell close failed for entry ${entryId} (${(err && (err.code || err.name)) || 'error'})`);
  }
}

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
    let where = 'n.active AND (COALESCE(f.live, 0) > 0 OR COALESCE(p.cnt, 0) > 0)';
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
          .map((r) => serializeEntry(r, { cutoff, conflicted })),
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
      if (entry.code) {
        await trx('neighborhood_access')
          .where({ neighborhood_id: neighborhoodId, status: 'active' })
          .whereNotNull('code')
          .whereNot('id', newId)
          .update({ status: 'needs_confirm', updated_at: trx.fn.now() });
      }
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
          await trx('neighborhood_access').where({ id }).update({ status: 'retired', updated_at: trx.fn.now() });
        }
        return { status: 200, body: { id, status: 'retired' } };
      }
      if (row.status === 'retired') return { status: 409, body: { error: 'This entry is retired; add a new one instead' } };
      if (action === 'confirm') {
        await trx('neighborhood_access').where({ id }).update({
          status: 'active', last_confirmed_at: trx.fn.now(), updated_at: trx.fn.now(),
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
      // who filed it (a later conflict bell must never open that customer).
      const confirmation = valueChanged
        ? { status: 'active', last_confirmed_at: trx.fn.now(), source: 'office', source_customer_id: null }
        : {};
      await trx('neighborhood_access').where({ id }).update({ ...next, ...confirmation, updated_at: trx.fn.now() });
      return { status: 200, body: { id, status: valueChanged ? 'active' : row.status } };
    });
    if (result.status === 200) await closeBellsBestEffort(id);
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'That code is already on file for this neighborhood' });
    logFailure('update entry', err);
    return res.status(500).json({ error: 'Could not update the entry' });
  }
});

module.exports = router;
