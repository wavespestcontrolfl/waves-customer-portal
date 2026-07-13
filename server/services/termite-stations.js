// Termite bait station map (station-map-v1) — the customer-scoped
// per-station layer behind the recurring "where are my stations" satellite
// map on termite bait service reports.
//
// Stations live in `termite_stations` (one row per physical in-ground
// station, per-customer station_number identity that survives retirement).
// The technician's satellite mark is stored in `geometry_image` using the
// SAME normalized local-shape contract as property_zones.geometry_image —
// { type: 'circle', cx, cy, r, ref: { lat, lng, zoom, width, height,
// capturedAt } }, coordinates normalized 0-1 against the 640×340 satellite
// image — so zone-drift re-anchoring (resolveZoneRowsImageDrift) applies to
// station pins unchanged.
//
// Per-visit status lives in `termite_station_checks` (one row per station
// per service_record, upserted so completion replays stay idempotent).
// Status vocabulary is fixed by the DB CHECK and the report legend in
// lockstep: 'ok' | 'activity' | 'serviced' | 'inaccessible'.
//
// Write payload contract (completion `termiteStations` and the office PUT):
//   { shape, status?, label? }            → create a station (+ visit check)
//   { id, shape?, status?, label? }       → move/relabel and/or check
//   { id, retire: true }                  → retire (number is never reused)
// Creates allocate station_number sequentially in payload order, so the
// client's provisional numbering (max existing + position) matches what the
// server persists.

const { sanitizeZoneShape } = require('./property-zones');
const { resolveZoneRowsImageDrift } = require('./service-report/zone-drift');

const STATION_STATUSES = ['ok', 'activity', 'serviced', 'inaccessible'];
const MAX_STATION_ENTRIES = 60;
const MAX_ACTIVE_STATIONS = 80;
const MAX_ACTION_ENTRIES = 10;

function isStationMapReportEnabled() {
  const raw = process.env.SERVICE_REPORT_STATION_MAP_ENABLED;
  if (raw == null || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

// Station marks are point pins: the circle capture shape only, never rects.
// Returns the sanitized shape to persist, or null when malformed.
function sanitizeStationShape(shape) {
  const clean = sanitizeZoneShape(shape);
  if (!clean || clean.type !== 'circle') return null;
  return clean;
}

function normalizeLabel(value) {
  if (value == null) return null;
  const text = String(value).trim().slice(0, 120);
  return text || null;
}

function sanitizeActions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || '').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, MAX_ACTION_ENTRIES);
}

// Route-level validation for a station entries payload. Returns an error
// string (400 material) or null when acceptable. `allowStatus: false` is the
// office desk flow — there is no visit to hang a check on, so a status there
// would silently vanish; reject it instead.
function validateStationEntriesBody(entries, { allowStatus = true } = {}) {
  if (entries == null) return null;
  if (!Array.isArray(entries)) return 'termiteStations must be an array';
  if (entries.length > MAX_STATION_ENTRIES) {
    return `termiteStations supports at most ${MAX_STATION_ENTRIES} entries`;
  }
  const seenIds = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return 'each termiteStations entry must be an object';
    }
    const hasId = entry.id != null && String(entry.id).trim() !== '';
    if (entry.retire === true) {
      if (!hasId) return 'a retire entry needs the station id';
      if (entry.shape != null || entry.status != null) {
        return 'a retire entry cannot also carry a shape or status — send one intent per station';
      }
    } else {
      if (!hasId && entry.shape == null) {
        return 'each termiteStations entry needs a shape (new station) or an id (existing station)';
      }
      // A malformed shape must 400 here, not silently drop in the sync — the
      // completion sync is post-commit fail-soft, so a silent skip would lose
      // the tech's pin behind a successful completion.
      if (entry.shape != null && !sanitizeStationShape(entry.shape)) {
        return 'a termiteStations shape must be a circle with coordinates normalized 0-1';
      }
      if (entry.status != null) {
        if (!allowStatus) return 'station status only applies during a completion — the office save takes positions only';
        if (!STATION_STATUSES.includes(entry.status)) {
          return `station status must be one of: ${STATION_STATUSES.join(', ')}`;
        }
      }
      if (entry.actions != null && !Array.isArray(entry.actions)) {
        return 'station actions must be an array of strings';
      }
    }
    if (hasId) {
      const key = String(entry.id);
      // Two entries for one station would race the later one's intent against
      // the earlier one's — reject the ambiguity instead of guessing.
      if (seenIds.has(key)) return 'termiteStations has more than one entry for the same station';
      seenIds.add(key);
    }
  }
  return null;
}

/**
 * Applies station registry writes (create / move / relabel / retire) for a
 * customer. Runs on the provided trx/knex; callers own transaction scope.
 *
 * @returns {{ created: number, moved: number, retired: number,
 *             skipped: string[], stationIdByIndex: Map<number, string> }}
 *          stationIdByIndex maps payload index → station id (created or
 *          existing) so check rows can be written for new stations too.
 */
async function upsertStationsForCustomer(trx, { customerId, entries = [] } = {}) {
  const summary = {
    created: 0, moved: 0, retired: 0, skipped: [], stationIdByIndex: new Map(),
  };
  if (!customerId || !Array.isArray(entries) || !entries.length) return summary;

  const existing = await trx('termite_stations')
    .where({ customer_id: customerId })
    .orderBy('station_number');
  const activeById = new Map(existing
    .filter((row) => row.is_active !== false)
    .map((row) => [String(row.id), row]));
  let activeCount = activeById.size;
  // Numbers are never reused — allocate above the max across ALL rows,
  // retired included, so "station 7" keeps meaning the same hole in the
  // ground in every historical report.
  let nextNumber = existing.reduce((max, row) => Math.max(max, Number(row.station_number) || 0), 0) + 1;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] || {};
    const hasId = entry.id != null && String(entry.id).trim() !== '';

    if (entry.retire === true) {
      const station = hasId ? activeById.get(String(entry.id)) : null;
      if (!station) {
        summary.skipped.push(`retire:${entry.id || 'missing-id'}`);
        continue;
      }
      await trx('termite_stations')
        .where({ id: station.id, customer_id: customerId })
        .update({ is_active: false, retired_at: trx.fn.now(), updated_at: trx.fn.now() });
      activeById.delete(String(station.id));
      activeCount -= 1;
      summary.retired += 1;
      continue;
    }

    if (hasId) {
      const station = activeById.get(String(entry.id));
      if (!station) {
        // not this customer's station (or already retired) — never write
        // across the customer boundary on a client-supplied id
        summary.skipped.push(`station:${entry.id}`);
        continue;
      }
      const patch = {};
      if (entry.shape != null) {
        const shape = sanitizeStationShape(entry.shape);
        if (!shape) {
          summary.skipped.push(`station:${entry.id}`);
          continue;
        }
        patch.geometry_image = JSON.stringify(shape);
      }
      if (entry.label !== undefined) patch.label = normalizeLabel(entry.label);
      if (Object.keys(patch).length) {
        await trx('termite_stations')
          .where({ id: station.id, customer_id: customerId })
          .update({ ...patch, updated_at: trx.fn.now() });
        if (patch.geometry_image) summary.moved += 1;
      }
      summary.stationIdByIndex.set(i, String(station.id));
      continue;
    }

    const shape = sanitizeStationShape(entry.shape);
    if (!shape) {
      summary.skipped.push('new:invalid-shape');
      continue;
    }
    if (activeCount >= MAX_ACTIVE_STATIONS) {
      summary.skipped.push('new:station-cap');
      continue;
    }
    const [created] = await trx('termite_stations')
      .insert({
        customer_id: customerId,
        station_number: nextNumber,
        program: 'termite',
        label: normalizeLabel(entry.label),
        geometry_image: JSON.stringify(shape),
      })
      .returning('*');
    nextNumber += 1;
    activeCount += 1;
    summary.created += 1;
    if (created?.id) {
      activeById.set(String(created.id), created);
      summary.stationIdByIndex.set(i, String(created.id));
    }
  }

  return summary;
}

/**
 * Completion-time sync: registry writes + per-visit check rows in one
 * transaction. Check rows upsert on (station_id, service_record_id) so a
 * completion replay/resume lands the same state instead of throwing.
 */
async function syncStationsForCompletion(db, { customerId, serviceRecordId, entries = [] } = {}) {
  if (!customerId || !Array.isArray(entries) || !entries.length) {
    return { created: 0, moved: 0, retired: 0, checksApplied: 0, skipped: [] };
  }
  return db.transaction(async (trx) => {
    const summary = await upsertStationsForCustomer(trx, { customerId, entries });
    let checksApplied = 0;
    if (serviceRecordId) {
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i] || {};
        if (entry.retire === true || entry.status == null) continue;
        if (!STATION_STATUSES.includes(entry.status)) continue;
        const stationId = summary.stationIdByIndex.get(i);
        if (!stationId) continue;
        await trx('termite_station_checks')
          .insert({
            station_id: stationId,
            service_record_id: serviceRecordId,
            status: entry.status,
            actions: sanitizeActions(entry.actions),
            note: entry.note != null ? String(entry.note).trim().slice(0, 300) || null : null,
          })
          .onConflict(['station_id', 'service_record_id'])
          .merge({
            status: entry.status,
            actions: sanitizeActions(entry.actions),
            note: entry.note != null ? String(entry.note).trim().slice(0, 300) || null : null,
            updated_at: trx.fn.now(),
          });
        checksApplied += 1;
      }
    }
    const { stationIdByIndex, ...counts } = summary;
    return { ...counts, checksApplied };
  });
}

// Capture-UI payload slice: the customer's active stations, drift-resolved
// against the image being served (same contract as the zones list on
// /property-map). `staleMark` flags a stored pin hidden by drift resolution
// so the UI can ask for a re-drop instead of showing it as absent.
// `nextStationNumber` spans retired rows (numbers are never reused) so the
// client's provisional numbering for new pins matches what the completion
// sync will allocate in payload order.
async function loadStationsForPropertyMap(db, customerId, imageContext) {
  const rows = await db('termite_stations')
    .where({ customer_id: customerId })
    .orderBy('station_number')
    .catch(() => []);
  const nextStationNumber = rows.reduce((max, row) => Math.max(max, Number(row.station_number) || 0), 0) + 1;
  const active = rows.filter((row) => row.is_active !== false);
  if (!active.length) return { stations: [], nextStationNumber };
  const resolved = resolveZoneRowsImageDrift(active, imageContext);
  return {
    stations: resolved.map((row, i) => ({
      id: row.id,
      number: row.station_number,
      label: row.label || null,
      geometryImage: row.geometry_image || null,
      staleMark: Boolean(active[i]?.geometry_image) && !row.geometry_image,
    })),
    nextStationNumber,
  };
}

/**
 * Customer-report context for the station map. Pure given its inputs —
 * report-data supplies the rows, the already-built satellite context, the
 * drift image context, and the viewer-visible typed snapshot types.
 *
 * Renders ONLY for termite-bait-typed reports (primary or viewer-visible
 * companion): gating on the visible snapshot types keeps an internal_only
 * companion's station data off the customer copy, and keeps station pins
 * off unrelated (lawn/pest-only) reports for the same property.
 */
function buildStationMapReportContext({
  stationRows = [],
  checkRows = [],
  satelliteMap = null,
  imageContext = {},
  typedTypes = [],
} = {}) {
  if (!isStationMapReportEnabled()) return { available: false, reason: 'disabled' };
  if (!Array.isArray(typedTypes) || !typedTypes.includes('termite_bait_station')) {
    return { available: false, reason: 'not_station_visit' };
  }
  if (!Array.isArray(stationRows) || !stationRows.length) {
    return { available: false, reason: 'no_stations' };
  }
  if (!satelliteMap?.available || !satelliteMap.live?.url) {
    return { available: false, reason: satelliteMap?.fallbackReason || 'satellite_unavailable' };
  }

  const statusByStationId = new Map();
  for (const check of Array.isArray(checkRows) ? checkRows : []) {
    if (check?.station_id != null && STATION_STATUSES.includes(check.status)) {
      statusByStationId.set(String(check.station_id), check.status);
    }
  }

  const resolved = resolveZoneRowsImageDrift(stationRows, imageContext);
  const pins = [];
  for (const row of resolved) {
    const shape = typeof row.geometry_image === 'string'
      ? (() => { try { return JSON.parse(row.geometry_image); } catch { return null; } })()
      : row.geometry_image;
    if (!shape || shape.type !== 'circle') continue;
    const cx = Number(shape.cx);
    const cy = Number(shape.cy);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    pins.push({
      id: String(row.id),
      number: Number(row.station_number) || null,
      label: row.label || null,
      cx,
      cy,
      status: statusByStationId.get(String(row.id)) || null,
    });
  }
  if (!pins.length) return { available: false, reason: 'marks_stale' };

  const summary = {
    total: pins.length,
    checked: pins.filter((pin) => pin.status && pin.status !== 'inaccessible').length,
    activity: pins.filter((pin) => pin.status === 'activity').length,
    serviced: pins.filter((pin) => pin.status === 'serviced').length,
    inaccessible: pins.filter((pin) => pin.status === 'inaccessible').length,
  };

  return {
    available: true,
    image: {
      url: satelliteMap.live.url,
      width: satelliteMap.live.width || 640,
      height: satelliteMap.live.height || 340,
    },
    attributionText: satelliteMap.attributionText || '',
    stations: pins,
    summary,
  };
}

module.exports = {
  STATION_STATUSES,
  MAX_STATION_ENTRIES,
  sanitizeStationShape,
  validateStationEntriesBody,
  upsertStationsForCustomer,
  syncStationsForCompletion,
  loadStationsForPropertyMap,
  buildStationMapReportContext,
  isStationMapReportEnabled,
};
