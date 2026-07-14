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
const { parseETDateTime } = require('../utils/datetime-et');

const STATION_STATUSES = ['ok', 'activity', 'serviced', 'inaccessible'];
// Sized to the worst LEGAL payload, not the active cap: a full relayout of a
// capped property sends a status for every surviving station plus a retire
// AND a create for every replaced one — up to 3 × MAX_ACTIVE_STATIONS
// entries (Codex P2 ×2, PR #2714). This is purely a request-sanity bound;
// the active cap is enforced by stationCapWouldOverflow + the sync guard.
const MAX_ACTIVE_STATIONS = 80;
const MAX_STATION_ENTRIES = MAX_ACTIVE_STATIONS * 3;
const MAX_ACTION_ENTRIES = 10;

function isStationMapReportEnabled() {
  const raw = process.env.SERVICE_REPORT_STATION_MAP_ENABLED;
  if (raw == null || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

// Station programs: termite in-ground bait stations and exterior rodent
// bait stations share the registry/check tables and every write path —
// numbering, dedupe, occupancy, and report scoping are all per-program.
const STATION_PROGRAMS = ['termite', 'rodent'];
const PROGRAM_TYPED_FLOW = {
  termite: 'termite_bait_station',
  rodent: 'rodent_bait_station',
};

function normalizeProgram(value) {
  return STATION_PROGRAMS.includes(value) ? value : 'termite';
}

// A completion may write stations only when the SERVER-resolved completion
// profile carries a station typed flow — as the primary findingsType or a
// declared companion. The profile is authoritative, never the client
// payload (same doctrine as the companionFindings authorization): a stale
// or crafted non-station completion body must not be able to mutate the
// customer's station registry or mint check rows. Returns the PROGRAM the
// profile authorizes ('termite' | 'rodent'), or null; the primary
// findingsType wins if a profile ever carried both.
function stationProgramForProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  for (const program of STATION_PROGRAMS) {
    if (profile.findingsType === PROGRAM_TYPED_FLOW[program]) return program;
  }
  const companions = Array.isArray(profile.companions) ? profile.companions : [];
  for (const program of STATION_PROGRAMS) {
    if (companions.some((companion) => companion && companion.type === PROGRAM_TYPED_FLOW[program])) {
      return program;
    }
  }
  return null;
}

function profileAllowsStationSync(profile) {
  return stationProgramForProfile(profile) != null;
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

// Exact-position identity for the replay-dedupe and occupancy guards: a
// resumed body carries byte-identical shapes, so identical normalized
// coordinates mean "the same pin", never two stations in one hole.
function positionKey(shape) {
  const parsed = typeof shape === 'string'
    ? (() => { try { return JSON.parse(shape); } catch { return null; } })()
    : shape;
  if (!parsed || parsed.cx == null || parsed.cy == null) return null;
  return `${Number(parsed.cx)}:${Number(parsed.cy)}`;
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
  // Two id-less creates at one exact position in a SINGLE payload can only
  // come from a stale/crafted client (the marking UI ignores taps on
  // existing pins) — reject rather than silently collapse them, or the
  // sender's counts would disagree with the registry. Payload-internal
  // only: a resumed body's creates match EXISTING rows, not each other,
  // so replays are unaffected.
  const seenCreatePositions = new Set();
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
      if (entry.shape != null) {
        const cleanShape = sanitizeStationShape(entry.shape);
        if (!cleanShape) {
          return 'a termiteStations shape must be a circle with coordinates normalized 0-1';
        }
        if (!hasId) {
          const createKey = positionKey(cleanShape);
          if (createKey && seenCreatePositions.has(createKey)) {
            return 'two new stations share the same position — remove the duplicate pin';
          }
          if (createKey) seenCreatePositions.add(createKey);
        }
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
 * Pre-commit active-cap check shared by /complete and the office PUT. Nets
 * the payload against the customer's ACTIVE rows with the SAME arithmetic
 * the sync will apply — that alignment is what makes the 400 trustworthy
 * (anything that passes here cannot be silently cap-skipped post-commit):
 *  - only retires that target a real active station free a slot (the sync
 *    skips bogus/foreign ids, so they must not free one here);
 *  - a create at an exact active position is the sync's replay/occupied
 *    dedupe and adds no row — EXCEPT when that occupant is itself retired
 *    in this payload (same-hole replacement), which genuinely inserts.
 * Never runs before the route's replay machinery needs it to be safe: a
 * resumed body's creates all match the positions the first pass persisted,
 * so they net to zero and the retry sails through to the stored-response
 * path instead of 400ing an already-committed completion.
 */
async function stationCapWouldOverflow(db, customerId, entries = [], program = 'termite') {
  const list = Array.isArray(entries) ? entries : [];
  const creates = list.filter((entry) => entry && entry.retire !== true
    && (entry.id == null || String(entry.id).trim() === '') && entry.shape != null);
  if (!creates.length) return false;
  const activeRows = await db('termite_stations')
    .where({ customer_id: customerId, is_active: true, program: normalizeProgram(program) })
    .select('id', 'geometry_image')
    .catch(() => null);
  if (!activeRows) return false; // pre-migration — the sync no-ops anyway
  const activeIds = new Set(activeRows.map((row) => String(row.id)));
  const validRetireIds = new Set(list
    .filter((entry) => entry && entry.retire === true && entry.id != null
      && activeIds.has(String(entry.id)))
    .map((entry) => String(entry.id)));
  const survivingPositions = new Set(activeRows
    .filter((row) => !validRetireIds.has(String(row.id)))
    .map((row) => positionKey(row.geometry_image))
    .filter(Boolean));
  const effectiveCreates = creates.filter((entry) => {
    const clean = sanitizeStationShape(entry.shape);
    const key = clean ? positionKey(clean) : null;
    return !key || !survivingPositions.has(key);
  }).length;
  return activeRows.length - validRetireIds.size + effectiveCreates > MAX_ACTIVE_STATIONS;
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
async function upsertStationsForCustomer(trx, { customerId, entries = [], program = 'termite' } = {}) {
  const summary = {
    created: 0, moved: 0, retired: 0, deduped: 0, skipped: [], stationIdByIndex: new Map(),
  };
  if (!customerId || !Array.isArray(entries) || !entries.length) return summary;
  const stationProgram = normalizeProgram(program);

  // Number allocation reads max(station_number) below, and the occupancy /
  // replay-dedupe guards read a point-in-time position snapshot — two
  // concurrent geometry writes for one customer (office PUT + a field
  // completion) could both read pre-write state and collide on the number
  // unique or stack two active pins in one hole (geometry has no DB
  // constraint). A per-customer advisory lock serializes every geometry
  // write (creates AND moves); it releases at transaction end, so this
  // function MUST run inside a transaction (both callers do). Status-only
  // payloads skip the lock.
  const hasGeometryWrites = entries.some((entry) => entry && entry.retire !== true
    && entry.shape != null);
  if (hasGeometryWrites) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`termite_stations:${customerId}:${stationProgram}`]);
  }

  // Program-scoped throughout: numbering, ownership, dedupe, occupancy and
  // the active cap are each per (customer, program) — a rodent save can
  // never renumber, move, or retire a termite pin, and vice versa.
  const existing = await trx('termite_stations')
    .where({ customer_id: customerId, program: stationProgram })
    .orderBy('station_number');
  const activeById = new Map(existing
    .filter((row) => row.is_active !== false)
    .map((row) => [String(row.id), row]));
  let activeCount = activeById.size;
  // Replay guard: a durable completion can resume after this post-commit
  // sync already ran but before the attempt was marked succeeded, replaying
  // the same body — id-less create entries would then insert duplicate
  // stations. A resumed body carries byte-identical shapes, so an active
  // station at the exact same normalized position IS that create: reuse it
  // (two physical stations never share one hole in the ground).
  const activeByPosition = new Map();
  for (const row of activeById.values()) {
    const key = positionKey(row.geometry_image);
    if (key && !activeByPosition.has(key)) activeByPosition.set(key, row);
  }
  // Numbers are never reused — allocate above the max across ALL rows,
  // retired included, so "station 7" keeps meaning the same hole in the
  // ground in every historical report.
  let nextNumber = existing.reduce((max, row) => Math.max(max, Number(row.station_number) || 0), 0) + 1;

  // Retire intents apply FIRST, regardless of payload order: the client
  // emits entries in station-number order, so a move onto the hole vacated
  // by a LATER retire entry would otherwise see the doomed occupant and be
  // skipped as position-occupied — and the follow-up retire would then
  // leave the registry with no station where the UI showed the moved pin.
  // Retires are independent of every other intent, so hoisting them is
  // side-effect-free.
  for (const entry of entries) {
    if (!entry || entry.retire !== true) continue;
    const hasId = entry.id != null && String(entry.id).trim() !== '';
    const station = hasId ? activeById.get(String(entry.id)) : null;
    if (!station) {
      summary.skipped.push(`retire:${entry.id || 'missing-id'}`);
      continue;
    }
    await trx('termite_stations')
      .where({ id: station.id, customer_id: customerId })
      .update({ is_active: false, retired_at: trx.fn.now(), updated_at: trx.fn.now() });
    // vacate the dedupe index — retiring a damaged station and dropping a
    // NEW pin in the same hole (in this same payload) is a replacement,
    // not a replay, and must insert a fresh row
    const retiredKey = positionKey(station.geometry_image);
    if (retiredKey && activeByPosition.get(retiredKey) === station) {
      activeByPosition.delete(retiredKey);
    }
    activeById.delete(String(station.id));
    activeCount -= 1;
    summary.retired += 1;
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] || {};
    const hasId = entry.id != null && String(entry.id).trim() !== '';

    if (entry.retire === true) continue; // applied in the first pass

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
        const newKey = positionKey(shape);
        const occupant = newKey ? activeByPosition.get(newKey) : null;
        if (occupant && occupant !== station) {
          // another ACTIVE station already sits at these exact coordinates —
          // persisting the move would stack two rows in one hole (stacked
          // report pins, diverging statuses for one physical station). Skip
          // the geometry write; the entry's status still lands below.
          summary.skipped.push(`station:${entry.id}:position-occupied`);
        } else {
          patch.geometry_image = JSON.stringify(shape);
          // re-key the dedupe index — a later create at this station's OLD
          // spot is a new station, and a create at its NEW spot is a replay
          const oldKey = positionKey(station.geometry_image);
          if (oldKey && activeByPosition.get(oldKey) === station) {
            activeByPosition.delete(oldKey);
          }
          station.geometry_image = patch.geometry_image;
          if (newKey) activeByPosition.set(newKey, station);
        }
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
    const existingAtPosition = activeByPosition.get(positionKey(shape));
    if (existingAtPosition) {
      // completion-replay dedupe — the status check row still lands on the
      // already-created station via stationIdByIndex
      summary.deduped += 1;
      summary.stationIdByIndex.set(i, String(existingAtPosition.id));
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
        program: stationProgram,
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
      const createdKey = positionKey(shape);
      if (createdKey) activeByPosition.set(createdKey, created);
    }
  }

  return summary;
}

/**
 * Completion-time sync: registry writes + per-visit check rows in one
 * transaction. Check rows upsert on (station_id, service_record_id) so a
 * completion replay/resume lands the same state instead of throwing.
 */
async function syncStationsForCompletion(db, { customerId, serviceRecordId, entries = [], program = 'termite' } = {}) {
  if (!customerId || !Array.isArray(entries) || !entries.length) {
    return { created: 0, moved: 0, retired: 0, checksApplied: 0, skipped: [] };
  }
  return db.transaction(async (trx) => {
    const summary = await upsertStationsForCustomer(trx, { customerId, entries, program });
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

// Capture-UI payload slice: the customer's active stations across BOTH
// programs (each tagged), drift-resolved against the image being served
// (same contract as the zones list on /property-map). The marking surfaces
// filter to their visit's program. `staleMark` flags a stored pin hidden by
// drift resolution so the UI can ask for a re-drop instead of showing it as
// absent. `nextStationNumberByProgram` spans retired rows per program
// (numbers are never reused within a program) so the client's provisional
// numbering for new pins matches what the sync will allocate in payload
// order; `nextStationNumber` keeps the termite value for shape stability.
async function loadStationsForPropertyMap(db, customerId, imageContext) {
  const rows = await db('termite_stations')
    .where({ customer_id: customerId })
    .orderBy('station_number')
    .catch(() => []);
  const nextStationNumberByProgram = {};
  for (const program of STATION_PROGRAMS) {
    nextStationNumberByProgram[program] = rows
      .filter((row) => normalizeProgram(row.program) === program)
      .reduce((max, row) => Math.max(max, Number(row.station_number) || 0), 0) + 1;
  }
  const active = rows.filter((row) => row.is_active !== false);
  if (!active.length) {
    return { stations: [], nextStationNumber: nextStationNumberByProgram.termite, nextStationNumberByProgram };
  }
  const resolved = resolveZoneRowsImageDrift(active, imageContext);
  return {
    stations: resolved.map((row, i) => ({
      id: row.id,
      number: row.station_number,
      program: normalizeProgram(row.program),
      label: row.label || null,
      geometryImage: row.geometry_image || null,
      staleMark: Boolean(active[i]?.geometry_image) && !row.geometry_image,
    })),
    nextStationNumber: nextStationNumberByProgram.termite,
    nextStationNumberByProgram,
  };
}

// Scopes the station rows to THE VISIT the report describes. Report tokens
// are long-lived, so rendering the current registry would make historical
// reports mutate as the office later adds or retires stations (Codex P2,
// PR #2714). Primary rule: when the visit recorded per-station checks, the
// map shows exactly the checked stations (retired-later included — the row
// still existed for that visit). Fallback (no check rows — reports rendered
// between migration and the first checked visit): stations that existed on
// the visit's ET service day (created before end-of-day, not retired before
// start-of-day). Positions always render from the current row so drift
// re-anchoring and physical re-pins keep pointing at the real ground.
function selectStationRowsForVisit(stationRows, statusByStationId, serviceDate) {
  if (statusByStationId.size > 0) {
    return stationRows.filter((row) => statusByStationId.has(String(row.id)));
  }
  const dateStr = typeof serviceDate === 'string'
    ? serviceDate.slice(0, 10)
    : serviceDate instanceof Date && !Number.isNaN(serviceDate.getTime())
      ? serviceDate.toISOString().slice(0, 10)
      : null;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    // no visit anchor — active rows only (legacy behavior)
    return stationRows.filter((row) => row.is_active !== false);
  }
  const dayEnd = parseETDateTime(`${dateStr}T23:59:59`);
  return stationRows.filter((row) => {
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    if (createdAt && !Number.isNaN(createdAt.getTime()) && createdAt > dayEnd) return false;
    if (row.is_active === false) {
      const retiredAt = row.retired_at ? new Date(row.retired_at) : null;
      // a retired row with no timestamp can't be placed in time — keep it
      // off historical maps rather than resurrecting it everywhere
      if (!retiredAt || Number.isNaN(retiredAt.getTime())) return false;
      // Retired on or before the visit day → off THIS visit's map. A
      // retire-all completion writes no check rows (retires carry no
      // status), so it lands in this fallback — its just-retired pins must
      // not render as "on file" while the visit's counts dropped to zero.
      // The trade (an office retirement later the same ET day also hides
      // the pin on that morning's no-check report) shows the customer a
      // station that no longer exists one report early, which is the safer
      // direction than resurrecting removed stations.
      if (retiredAt <= dayEnd) return false;
    }
    return true;
  });
}

/**
 * Customer-report context for the station map. Pure given its inputs —
 * report-data supplies the rows (ACTIVE AND RETIRED — visit scoping happens
 * here), the visit's check rows and service date, the already-built
 * satellite context, the drift image context, and the viewer-visible typed
 * snapshot types.
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
  serviceDate = null,
} = {}) {
  if (!isStationMapReportEnabled()) return { available: false, reason: 'disabled' };
  // The visit's typed flow picks the PROGRAM: a rodent bait report renders
  // rodent pins only, a termite report termite pins only — a property with
  // both programs never co-renders them on one visit's map. typedTypes
  // arrives PRIMARY-FIRST from report-data ([snapshot.type, ...companions]),
  // and the primary's program must win when both station flows appear on
  // one visit (codex P2: probing STATION_PROGRAMS order selected termite
  // for a rodent-primary report with a termite companion) — mirroring
  // stationProgramForProfile's primary-wins doctrine.
  const types = Array.isArray(typedTypes) ? typedTypes : [];
  const stationType = types.find((t) => STATION_PROGRAMS.some((p) => PROGRAM_TYPED_FLOW[p] === t)) || null;
  const program = stationType
    ? STATION_PROGRAMS.find((p) => PROGRAM_TYPED_FLOW[p] === stationType)
    : null;
  if (!program) return { available: false, reason: 'not_station_visit' };
  const programRows = (Array.isArray(stationRows) ? stationRows : [])
    .filter((row) => normalizeProgram(row.program) === program);
  if (!programRows.length) {
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

  const visitRows = selectStationRowsForVisit(programRows, statusByStationId, serviceDate);
  if (!visitRows.length) return { available: false, reason: 'no_stations' };

  const resolved = resolveZoneRowsImageDrift(visitRows, imageContext);
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
  // ALL-OR-NOTHING, like the zones satellite overlay: drift resolution (or a
  // malformed stored shape) can drop a single edge pin while the rest of the
  // visit's rows survive, and a partial map would publish a summary ("4 of 4
  // stations inspected") that contradicts the visit's frozen typed findings
  // and check rows. Every station this visit covered renders, or no map.
  if (pins.length !== visitRows.length || !pins.length) {
    return { available: false, reason: 'marks_stale' };
  }

  const summary = {
    total: pins.length,
    checked: pins.filter((pin) => pin.status && pin.status !== 'inaccessible').length,
    activity: pins.filter((pin) => pin.status === 'activity').length,
    serviced: pins.filter((pin) => pin.status === 'serviced').length,
    inaccessible: pins.filter((pin) => pin.status === 'inaccessible').length,
  };

  return {
    available: true,
    program,
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
  STATION_PROGRAMS,
  MAX_STATION_ENTRIES,
  MAX_ACTIVE_STATIONS,
  sanitizeStationShape,
  validateStationEntriesBody,
  profileAllowsStationSync,
  stationProgramForProfile,
  stationCapWouldOverflow,
  upsertStationsForCustomer,
  syncStationsForCompletion,
  loadStationsForPropertyMap,
  buildStationMapReportContext,
  isStationMapReportEnabled,
};
