/**
 * Admin neighborhood gate-code directory (PR 3b of the gate-code directory).
 *
 * GET    /                          — neighborhoods with their gate entries
 *                                     (?q= search, ?filter=needs_confirm,
 *                                     ?include_retired=1, ?limit, ?offset)
 * POST   /:neighborhoodId/entries   — office adds an entry (active, confirmed now)
 * PATCH  /entries/:id               — edit an entry, or { action: 'confirm' | 'retire' }
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
const { isKeypadCode } = require('../services/neighborhood-access');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
router.use((req, res, next) => {
  if (!neighborhoodAccessLive()) return res.status(404).json({ enabled: false });
  res.set('Cache-Control', 'no-store');
  return next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TYPES = ['keypad', 'callbox', 'guard', 'pass', 'open', 'instructions'];
const STALE_MONTHS = 6;
const MAX_LABEL = 60;
const MAX_CODE = 100;
const MAX_INSTRUCTIONS = 1000;
const MAX_QUERY = 100;
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
  return { value: { gate_label: label, access_type: merged.access_type, code, instructions: instructions || null } };
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
    const cutoff = staleCutoff();

    const bindings = [cutoff];
    let where = 'n.active AND (COALESCE(f.live, 0) > 0 OR COALESCE(p.cnt, 0) > 0)';
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
          count(code) > 1 AS conflict
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
      const conflicted = rows.filter((r) => r.code && r.status !== 'retired').length > 1;
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
      return { status: 201, body: { id: ins.id ?? ins } };
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
      await trx('neighborhood_access').where({ id }).update({ ...next, updated_at: trx.fn.now() });
      return { status: 200, body: { id, status: row.status } };
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
