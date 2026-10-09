const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');

// Technician-traced treatment perimeter for a visit: the traced path (image +
// geo coordinates), computed linear feet, and a composited satellite snapshot
// PNG stored in S3. One map per scheduled visit — re-tracing replaces it.

// Nested under service-photos/ deliberately: the deployed IAM policy already
// grants PutObject on service-photos/* (the daily photo-upload path), so this
// needs no policy change. A sibling top-level prefix was AccessDenied.
const TREATMENT_ZONE_PREFIX = 'service-photos/treatment-zones/';
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PATH_POINTS = 500;
const MAX_LINEAR_FT = 100000;

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function operationalError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  return err;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Path points arrive from the tech client as
// [{ px: { x, y }, latLng: { lat, lng } }, ...] in the static map's physical
// pixel space. Normalize hard — this JSON lands on the customer report path.
function normalizePathPoints(raw) {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw operationalError('pathPoints must be an array of at least 2 points');
  }
  if (raw.length > MAX_PATH_POINTS) {
    throw operationalError(`pathPoints cannot exceed ${MAX_PATH_POINTS} points`);
  }
  return raw.map((point, i) => {
    const x = finiteOrNull(point?.px?.x);
    const y = finiteOrNull(point?.px?.y);
    if (x == null || y == null) {
      throw operationalError(`pathPoints[${i}].px must have finite x and y`);
    }
    const lat = finiteOrNull(point?.latLng?.lat);
    const lng = finiteOrNull(point?.latLng?.lng);
    return {
      px: { x, y },
      latLng: lat != null && lng != null ? { lat, lng } : null,
    };
  });
}

function visitCompletedError() {
  return Object.assign(
    operationalError('This visit is complete, so its trace stays on the report.', 409),
    { code: 'visit_completed' },
  );
}

function propertyChangedError() {
  return Object.assign(
    operationalError('This visit moved to another property. Close it and reopen it from the schedule.', 409),
    { code: 'visit_property_changed' },
  );
}

// The visit is no longer the one the request read (another customer or
// service on the row since): a trace picked for the old one must not land.
function visitChangedError() {
  return Object.assign(
    operationalError('This visit changed. Close it and reopen it from the schedule.', 409),
    { code: 'visit_changed' },
  );
}

function traceExistsError() {
  return Object.assign(
    operationalError('This visit already has a trace. Remove it first to use the last visit\'s.', 409),
    { code: 'trace_exists' },
  );
}

// Every save takes the visit row's lock, the one a completion holds while
// it judges the trace (complete-scheduled-service.js, traceSeen), so a save
// either lands before that read or waits for the completion (Codex #5538).
// A caller that loaded the visit at a property (every trace opener sends it)
// is refused, at the write itself, when the office has moved the visit since:
// a save that waited on this lock behind the move never lands a map of the
// old home on the new one (Codex #5538). The report flow, whose trace is
// judged with the report, is also refused once the visit is completed
// (openVisitOnly); the Zone action may still add a trace to a completed visit.
async function lockVisitForTrace(conn, scheduledServiceId, expectedPropertyId, openVisitOnly) {
  const visit = await conn('scheduled_services')
    .where({ id: scheduledServiceId })
    .forUpdate()
    .first('property_id', 'status');
  if (expectedPropertyId === undefined) return;
  if (!visit || String(expectedPropertyId ?? '') !== String(visit.property_id ?? '')) {
    throw propertyChangedError();
  }
  if (openVisitOnly && visit.status === 'completed') throw visitCompletedError();
}

// The reuse path's lock (Codex P1 on #6175): the copy reads and copies images
// between the route's checks and this write, so the visit is read again under
// the lock, inside the technician's own scope (a reassigned visit is refused
// as on the remove path), and must still be the visit the request read: same
// customer, same service, same property, still open.
// Any closed status refuses the copy, not only completed: an administrator's
// lock carries no status filter (Codex P2 r2). Where the visit IS is judged
// separately, by recheckReuseUnderLock.
const TRACE_CLOSED_STATUSES = new Set(['cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled']);
async function lockScopedVisitForTrace(conn, scheduledServiceId, { actor, visit }, openVisitOnly) {
  const { lockOwnedLiveVisit } = require('./technician-visit-scope');
  const locked = await lockOwnedLiveVisit(conn, actor, scheduledServiceId, [
    'property_id', 'status', 'customer_id', 'service_id', 'service_type',
  ], { allowCompleted: true });
  if (String(locked.property_id ?? '') !== String(visit.property_id ?? '')) throw propertyChangedError();
  if (openVisitOnly && locked.status === 'completed') throw visitCompletedError();
  if (TRACE_CLOSED_STATUSES.has(String(locked.status || ''))) throw visitChangedError();
  const same = (key) => String(locked[key] ?? '') === String(visit[key] ?? '');
  if (!same('customer_id') || !same('service_id') || !same('service_type')) throw visitChangedError();
}

function noReusableTraceError() {
  return Object.assign(operationalError('There is no earlier trace for this property to reuse.', 409), { code: 'no_reusable_trace' });
}

// The copy's last look, inside the save transaction and after the target visit
// is locked (Codex P1 r4 on #6175). Nothing read before the lock still holds:
//  - the target's location inputs (the columns its coordinates were resolved
//    from) must be the ones the lookup used: an address corrected during the
//    copy moves the visit, so the trace no longer proves the place. The inputs
//    are compared, never re-geocoded under a row lock.
//  - the source must still be the row the lookup chose: its zone row (same id,
//    visit and updated_at, so the same points and picture) and its visit, still
//    completed for the same customer. Correcting a completed visit's address
//    deletes its zone row (appointment-address.js), which ends the offer here.
// The source rows are locked in the order that address correction takes them
// (visit, then zone), so the two cannot deadlock.
async function recheckReuseUnderLock(conn, scheduledServiceId, { locationKey, source, targetDate }) {
  await recheckReuseTarget(conn, scheduledServiceId, { locationKey, targetDate, sourceDate: source.scheduledDate });
  await recheckReuseSource(conn, source);
}

// The target, its row locked by now: still at the place the lookup proved,
// and still on the day the source was chosen as an EARLIER visit of (a target
// rescheduled during the copy is another visit to judge; Codex P2 r10 on #6175).
async function recheckReuseTarget(conn, scheduledServiceId, { locationKey, targetDate, sourceDate }) {
  const here = await readVisitLocationRow(conn, scheduledServiceId);
  if (!here || visitLocationKey(here) !== locationKey) throw propertyChangedError();
  const target = await conn('scheduled_services').where({ id: scheduledServiceId }).first('scheduled_date');
  const lockedDate = dateOnlyOrNull(target?.scheduled_date);
  if (!lockedDate || lockedDate !== targetDate || !(sourceDate < lockedDate)) throw visitChangedError();
}

// The source, locked visit first and then its trace row: every field it was
// chosen and approved on (Codex P1 r9 on #6175). The office can move a
// completed visit to another day or make it another service while the
// picture is copied, and it would no longer be an earlier visit of a service
// that shows a trace; its frozen record must still be the one the render
// verdict read; its trace row must be the same row, unchanged.
async function recheckReuseSource(conn, source) {
  const sourceVisit = await conn('scheduled_services').where({ id: source.serviceId }).forUpdate()
    .first('status', 'customer_id', 'scheduled_date', 'service_id', 'service_type');
  const zone = await conn('treatment_zone_maps').where({ id: source.zoneId }).forUpdate().first('id', 'scheduled_service_id', 'updated_at');
  const record = sourceVisit && zone
    ? await conn('service_records').where({ scheduled_service_id: source.serviceId }).orderBy('created_at', 'desc').first()
    : null;
  if (!sourceVisit || !zone || !record) throw noReusableTraceError();
  // Still the completion that was judged against this very trace row.
  let judged = false;
  try { judged = traceJudgedAgainst(notesOf(record), zone); } catch { judged = false; }
  if (!judged) throw noReusableTraceError();
  await recheckSourceVerdicts(conn, source, sourceVisit, record);
  const sameInstant = (a, b) => Number.isFinite(new Date(a).getTime()) && new Date(a).getTime() === new Date(b).getTime();
  const sameText = (a, b) => String(a ?? '') === String(b ?? '');
  const unchanged = [
    sourceVisit.status === 'completed',
    dateOnlyOrNull(sourceVisit.scheduled_date) === source.scheduledDate,
    sameText(sourceVisit.service_id, source.serviceCatalogId),
    sameText(sourceVisit.service_type, source.serviceType),
    sameText(sourceVisit.customer_id, source.customerId),
    sameText(record.id, source.recordId),
    sameText(zone.id, source.zoneId),
    sameText(zone.scheduled_service_id, source.serviceId),
    sameInstant(zone.updated_at, source.updatedAt),
  ];
  if (!unchanged.every(Boolean)) throw noReusableTraceError();
}

// The source's two verdicts, asked again under the lock (Codex P1 r11 on
// #6175). A legacy record with no frozen add-on lines takes its render
// verdict from the LIVE scheduled_service_addons rows, which an office edit
// can replace while the picture is copied without touching the visit, the
// record or the trace row. Those rows are held, then both verdicts are read
// again inside the transaction; a verdict that fails is not a yes.
async function recheckSourceVerdicts(conn, source, sourceVisit, record) {
  try {
    await conn('scheduled_service_addons').where({ scheduled_service_id: source.serviceId }).forShare().select('id');
    const { resolveTraceRenderVerdict, traceCaptureBlockPayload } = require('./service-report/trace-eligibility');
    const verdict = await resolveTraceRenderVerdict(record, conn);
    const blocked = await traceCaptureBlockPayload({ ...sourceVisit, id: source.serviceId }, conn, { captureMode: REUSE_CAPTURE_MODE });
    if (verdict && !verdict.suppressed && !blocked) return;
  } catch (err) {
    logger.warn(`[treatment-zone] source verdict recheck failed service=${source.serviceId}: ${err.message}`);
  }
  throw noReusableTraceError();
}

// The save's locks and what is judged under them: the visit (inside the
// technician's scope for a reuse), then a reuse's proof of place.
async function lockForSave(conn, scheduledServiceId, { lockedScope, reuseGuard, expectedPropertyId, openVisitOnly }) {
  // A reuse's place may rest on the CUSTOMER's pin and address (a visit with
  // no pin of its own), so the customer row is held too: a geocode correction
  // (customer-geocode-review.js takes the row FOR UPDATE) waits until the copy
  // has committed, and cannot move the pin between the recheck and the insert
  // (Codex P1 r5 on #6175). Customer first, then the visit: the parent-first
  // order the other customer-and-visit writers take.
  if (reuseGuard) await conn('customers').where({ id: reuseGuard.source.customerId }).forShare().first('id');
  if (lockedScope) await lockScopedVisitForTrace(conn, scheduledServiceId, lockedScope, openVisitOnly);
  else await lockVisitForTrace(conn, scheduledServiceId, expectedPropertyId, openVisitOnly);
  if (reuseGuard) await recheckReuseUnderLock(conn, scheduledServiceId, reuseGuard);
}

// One visit's row: the keys it replaces, then the upsert.
async function upsertZoneRow(conn, scheduledServiceId, buildRecord) {
  const existing = await conn('treatment_zone_maps')
    .where({ scheduled_service_id: scheduledServiceId })
    .first('id', 'snapshot_s3_key', 'mask_s3_key');
  const record = buildRecord(existing);
  const [row] = await conn('treatment_zone_maps')
    .insert(record)
    .onConflict('scheduled_service_id')
    .merge()
    .returning('*');
  return { row, existing, record };
}

async function saveTreatmentZoneMap({
  scheduledServiceId,
  customerId = null,
  technicianId = null,
  pathPoints,
  closedLoop = false,
  linearFt = null,
  centerLat = null,
  centerLng = null,
  zoom = null,
  address = null,
  snapshotPngBuffer = null,
  // Transparent grass-highlight layer (lawn_highlight saves only) — the
  // report animates this over the snapshot (owner 2026-07-30).
  maskPngBuffer = null,
  captureMode = null,
  // Optional: the property the caller loaded the visit at. Checked under the
  // visit row's lock at the write itself, so an office move that commits
  // after the route's read still refuses the save. Undefined (a caller that
  // sends none) writes as before, under the same lock.
  expectedPropertyId,
  // The report flow's trace is judged with the report: also refused once the
  // visit is completed.
  openVisitOnly = false,
  // Reusing the last visit's trace never replaces a trace this visit already
  // has (a hand trace is the tech's claim for today): refused under the lock.
  createOnly = false,
  // Reuse only: { actor, visit } re-reads the visit under the lock inside the
  // technician's own scope and against the row the request read (see
  // lockScopedVisitForTrace).
  lockedScope = null,
  // Reuse only: { locationKey, source } the lookup's proof of place, read again
  // under the lock (see recheckReuseUnderLock).
  reuseGuard,
  knex = db,
}) {
  if (!scheduledServiceId) throw operationalError('scheduledServiceId is required');
  const points = normalizePathPoints(pathPoints);

  const linear = finiteOrNull(linearFt);
  if (linear != null && (linear < 0 || linear > MAX_LINEAR_FT)) {
    throw operationalError('linearFt out of range');
  }

  let snapshotKey = null;
  if (snapshotPngBuffer) {
    if (!config.s3?.bucket) throw operationalError('S3 not configured', 500);
    if (snapshotPngBuffer.length > MAX_SNAPSHOT_BYTES) {
      throw operationalError('Snapshot exceeds the 8MB limit', 413);
    }
    snapshotKey =
      `${TREATMENT_ZONE_PREFIX}${scheduledServiceId}/` +
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-map.png`;
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: snapshotKey,
        Body: snapshotPngBuffer,
        ContentType: 'image/png',
      })
    );
  }

  let maskKey = null;
  if (maskPngBuffer) {
    if (!config.s3?.bucket) throw operationalError('S3 not configured', 500);
    if (maskPngBuffer.length > MAX_SNAPSHOT_BYTES) {
      throw operationalError('Mask exceeds the 8MB limit', 413);
    }
    maskKey =
      `${TREATMENT_ZONE_PREFIX}${scheduledServiceId}/` +
      `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-mask.png`;
    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: maskKey,
        Body: maskPngBuffer,
        ContentType: 'image/png',
      })
    );
  }

  // The saved row's fields, from the keys it replaces.
  const buildRecord = (existing) => ({
    scheduled_service_id: scheduledServiceId,
    customer_id: customerId || null,
    created_by_technician_id: technicianId || null,
    path_points: JSON.stringify(points),
    closed_loop: Boolean(closedLoop),
    linear_ft: linear == null ? null : Math.round(linear),
    center_lat: finiteOrNull(centerLat),
    center_lng: finiteOrNull(centerLng),
    zoom: finiteOrNull(zoom),
    address: address ? String(address).slice(0, 300) : null,
    snapshot_s3_key: snapshotKey || existing?.snapshot_s3_key || null,
    // The mask FOLLOWS the snapshot: a new snapshot without a mask (spray/
    // outline-fallback save) must CLEAR any stale mask — a leftover
    // highlight layer would pulse over a snapshot it doesn't match.
    mask_s3_key: maskKey || (snapshotKey ? null : existing?.mask_s3_key || null),
    // 'lawn' (turf outline) vs 'lawn_highlight' (grass mask baked into the
    // snapshot — codex P1 #3075: the report must only claim "highlighted"
    // when a highlight was actually saved) vs 'yard' (mosquito outline —
    // turf + landscape beds, owner 2026-08-11) vs 'perimeter' (building
    // spray trace) vs 'interior' (building footprint + interior wash, owner
    // 2026-07-29) — anything else stores NULL, same as legacy rows (codex
    // P1 #3038). Lawn/yard modes and 'interior' are AREA claims: only a
    // closed loop of 3+ points qualifies; open lawn/yard traces downgrade
    // to unlabeled and an open interior trace downgrades to 'perimeter'
    // (still true of the line it draws) so the report never presents a
    // line as a treated area (codex P2 #3038, mirrors the client gate).
    capture_mode: (() => {
      const mode = ['lawn', 'lawn_highlight', 'yard', 'perimeter', 'interior'].includes(captureMode) ? captureMode : null;
      if ((mode === 'lawn' || mode === 'lawn_highlight' || mode === 'yard') && (!closedLoop || points.length < 3)) return null;
      if (mode === 'interior' && (!closedLoop || points.length < 3)) return 'perimeter';
      return mode;
    })(),
    updated_at: knex.fn.now(),
  });
  const persist = async (conn) => {
    await lockForSave(conn, scheduledServiceId, { lockedScope, reuseGuard, expectedPropertyId, openVisitOnly });
    if (createOnly && await conn('treatment_zone_maps').where({ scheduled_service_id: scheduledServiceId }).first('id')) {
      throw traceExistsError();
    }
    return upsertZoneRow(conn, scheduledServiceId, buildRecord);
  };

  let saved;
  try {
    saved = await knex.transaction(persist);
  } catch (err) {
    // A refused save leaves no orphaned upload behind (best effort).
    if (['visit_property_changed', 'visit_completed', 'trace_exists', 'visit_changed', 'no_reusable_trace', 'service_not_assigned', 'not_found'].includes(err?.code)) {
      for (const key of [snapshotKey, maskKey].filter(Boolean)) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
        } catch (deleteErr) {
          logger.warn(`[treatment-zone] refused upload delete failed: ${deleteErr.message}`);
        }
      }
    }
    throw err;
  }
  const { row, existing, record } = saved;

  // Replaced snapshot: drop the orphaned object, best effort only.
  if (snapshotKey && existing?.snapshot_s3_key && existing.snapshot_s3_key !== snapshotKey) {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: existing.snapshot_s3_key })
      );
    } catch (err) {
      logger.warn(`[treatment-zone] stale snapshot delete failed: ${err.message}`);
    }
  }
  // Replaced or cleared mask: same best-effort cleanup.
  if (existing?.mask_s3_key && existing.mask_s3_key !== record.mask_s3_key) {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: existing.mask_s3_key })
      );
    } catch (err) {
      logger.warn(`[treatment-zone] stale mask delete failed: ${err.message}`);
    }
  }

  return row;
}

// "Remove the trace" (the Fast Complete report flow): a trace that no longer
// matches the note comes off before the visit is completed. Under the visit
// row's lock, which the completion takes before it reads the trace, with the
// actor's current assignment judged on the locked row (lockOwnedLiveVisit; a
// technician reassigned meanwhile is refused): a visit moved to another
// property, or already completed (its report shows the trace), is refused.
// The images come off S3 after the commit, best effort.
async function deleteTreatmentZoneMap({ scheduledServiceId, actor, expectedPropertyId, knex = db }) {
  if (!scheduledServiceId) throw operationalError('scheduledServiceId is required');
  if (!actor) throw operationalError('actor is required');
  const { lockOwnedLiveVisit } = require('./technician-visit-scope');
  const removed = await knex.transaction(async (trx) => {
    const visit = await lockOwnedLiveVisit(trx, actor, scheduledServiceId, ['property_id', 'status'], { allowCompleted: true });
    if (expectedPropertyId !== undefined && String(expectedPropertyId ?? '') !== String(visit.property_id ?? '')) {
      throw propertyChangedError();
    }
    if (visit.status === 'completed') throw visitCompletedError();
    const [row] = await trx('treatment_zone_maps')
      .where({ scheduled_service_id: scheduledServiceId })
      .del()
      .returning(['snapshot_s3_key', 'mask_s3_key']);
    return row || null;
  });
  for (const key of [removed?.snapshot_s3_key, removed?.mask_s3_key].filter(Boolean)) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    } catch (err) {
      logger.warn(`[treatment-zone] removed trace image delete failed: ${err.message}`);
    }
  }
  return removed;
}

// A visit completed through the Fast Complete report flow froze the trace its
// record was judged against (structured_notes.traceJudged.seen: that trace's
// updated_at, or null for none): its report shows only that trace, never
// one saved or replaced after (another tracer after completion, a save that
// waited behind the completion) nor one the record never saw (a trace kept
// while the map gate was dark). Any other record shows its trace as before
// (Codex #5538).
function traceJudgedAllows(structuredNotes, row) {
  const judged = structuredNotes?.traceJudged;
  if (!judged || typeof judged !== 'object' || !Object.prototype.hasOwnProperty.call(judged, 'seen')) return true;
  const stamp = (value) => (value == null ? null : new Date(value).getTime());
  const seen = stamp(judged.seen);
  return seen !== null && Number.isFinite(seen) && seen === stamp(row?.updated_at);
}

async function getTreatmentZoneMapForScheduledService(scheduledServiceId, { knex = db } = {}) {
  if (!scheduledServiceId) return null;
  return (
    (await knex('treatment_zone_maps')
      .where({ scheduled_service_id: scheduledServiceId })
      .first()) || null
  );
}

// PDF cache-key component (same pattern as mosquitoReportV2PdfSignature):
// cached report PDFs bake the traced map in, so the key must vary when the
// map they would render changes — a GATE_TREATMENT_ZONE_MAP flip in either
// direction or a re-trace. Returns '' whenever the gate is off or the visit
// has no trace, so untraced records keep their pre-feature keys (no mass
// cache bust). Fail-soft: a lookup error must never block PDF serving.
async function treatmentZonePdfSignature(service, knex = db) {
  try {
    if (!featureGates.isEnabled('treatmentZoneMap')) return '';
    const scheduledServiceId = service?.scheduled_service_id;
    if (!scheduledServiceId) return '';
    const row = await knex('treatment_zone_maps')
      .where({ scheduled_service_id: scheduledServiceId })
      .first('updated_at', 'created_at', 'capture_mode');
    if (!row) return '';
    const stamp = new Date(row.updated_at || row.created_at || 0).getTime();
    // Trace-eligibility component (GATE_TRACE_ELIGIBILITY): the live view
    // suppresses ineligible traces at render, and a cached PDF must not
    // keep serving the old spray map after the flip — owner ruling
    // 2026-08-04: invalidate on next open, no bulk regen. Appended ONLY
    // when the gate is on, so pre-flip keys are untouched and each traced
    // record re-renders exactly once on its next open. Mirrors the render
    // inputs (snapshot findingsType is the authority, live profile widens,
    // display names last) — the verdict itself comes from the shared
    // resolver, so registry changes invalidate here for free.
    let eligibilityComponent = '';
    const { resolveTraceRenderVerdict } = require('./service-report/trace-eligibility');
    // Callers with PARTIAL rows (the PDF lookup path selects a narrow
    // column set) must still key on the same evidence the renderer sees —
    // a missing areas_serviced column made the lookup verdict diverge
    // from the stored one and forced a browser re-render on every
    // attachment fetch (codex P2 r20). Fail-soft: an unloadable row just
    // uses what the caller passed.
    let verdictRecord = service;
    if (service?.id
      && (service.areas_serviced === undefined || service.structured_notes === undefined
        || service.service_data === undefined)) {
      try {
        const fullRow = await knex('service_records')
          .where({ id: service.id })
          .first('areas_serviced', 'structured_notes', 'service_data', 'service_type');
        if (fullRow) verdictRecord = { ...fullRow, ...service };
      } catch { /* partial row stands */ }
    }
    const verdict = await resolveTraceRenderVerdict(verdictRecord, knex);
    if (verdict.eligibility) {
      eligibilityComponent = verdict.suppressed
        ? '-te0'
        : `-te1${verdict.eligibility.variant || ''}`;
      // The capture PRESENTATION keys the cached PDF too (codex P1 r19):
      // the live builder harmonizes variant/copy with capture_mode (a
      // lawn-family capture renders outline regardless of the winning
      // verdict; lawn vs lawn_highlight changes the wording), and the
      // trace timestamp doesn't change at deploy — without the mode in
      // the key, pre-harmonization PDFs would serve stale spray/highlight
      // wording forever. Gate-on only, like the verdict component.
      eligibilityComponent += `-cm${String(row.capture_mode || 'none')}`;
    }
    return `-tz${Number.isFinite(stamp) ? stamp : 0}${eligibilityComponent}`;
  } catch {
    return '';
  }
}

// ── "Same as last visit" (GATE_TRACE_REUSE) ─────────────────────────────────
// A recurring visit re-traces the same house every quarter. The tech can copy
// the customer's last saved spray trace onto the open visit with one tap. The
// server finds the source itself; a client never names a zone.
//
// "The same place" is proved by coordinates and nothing else: the target
// visit's own location, resolved on the server, must fall inside the footprint
// of the source trace. A property id or an address string cannot prove it,
// because both are editable in place (a primary property row can move to
// another street, an address can be re-spelled or corrected) while the visits
// that point at them keep their old meaning (Codex P1 r4 on #6175).
//
// Only a 'perimeter' trace is offered. 'interior' (building footprint + the
// inside wash) is a per-visit fact, not a standing outline; the lawn, lawn
// highlight and yard modes are area claims for other services; a row with no
// mode is a legacy or downgraded open trace we cannot vouch for. The offered
// mode must also pass the same capture check the save route runs for THIS
// visit, so a lawn or bait visit is never offered a spray outline.
const REUSE_CAPTURE_MODE = 'perimeter';
// Enough rows that a valid trace is never hidden behind others of the same
// customer (Codex P2 on #6175): the length filter runs in SQL, the footprint
// is judged per row below.
const REUSE_CANDIDATE_LIMIT = 200;

// How far outside the traced points' bounding box the visit's location may
// still sit and count as the same place. A visit's pin is a geocoded address
// point (a rooftop or parcel point, often a few metres off the walls the tech
// walked), not the centre of the drawing; 15 m takes in that offset without
// reaching a house on the next lot.
const REUSE_FOOTPRINT_MARGIN_M = 15;
const METRES_PER_DEGREE_LAT = 111320;

const validCoordinate = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// The trace's footprint: the bounding box of its lat/lng points, grown by the
// margin. A trace with fewer than 3 usable points has no footprint to prove a
// place with (a point missing its lat/lng is skipped), so it is never offered.
function traceFootprint(rawPathPoints) {
  let points = rawPathPoints;
  if (typeof points === 'string') {
    try { points = JSON.parse(points); } catch { return null; }
  }
  if (!Array.isArray(points)) return null;
  const usable = [];
  for (const point of points) {
    if (point?.latLng?.lat == null || point?.latLng?.lng == null) continue;
    const lat = Number(point.latLng.lat);
    const lng = Number(point.latLng.lng);
    if (validCoordinate(lat, lng)) usable.push({ lat, lng });
  }
  if (usable.length < 3) return null;
  const lats = usable.map((p) => p.lat);
  const lngs = usable.map((p) => p.lng);
  const latMargin = REUSE_FOOTPRINT_MARGIN_M / METRES_PER_DEGREE_LAT;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lngMargin = latMargin / Math.max(Math.cos((midLat * Math.PI) / 180), 0.01);
  return {
    minLat: Math.min(...lats) - latMargin, maxLat: Math.max(...lats) + latMargin,
    minLng: Math.min(...lngs) - lngMargin, maxLng: Math.max(...lngs) + lngMargin,
  };
}

function footprintContains(box, point) {
  return !!box && point.lat >= box.minLat && point.lat <= box.maxLat
    && point.lng >= box.minLng && point.lng <= box.maxLng;
}

// What a visit's location is resolved from: the stored pin on the visit, else
// the customer's pin when the visit's stamped address does not diverge from the
// customer's, and the stamped-over-customer address the tracer geocodes when
// neither holds (day-stops.js serviceLocationSelects: the one read the
// schedule row, the route and the tracer's /geocode all use).
async function readVisitLocationRow(conn, scheduledServiceId) {
  const { serviceLocationSelects } = require('./scheduling/day-stops');
  return conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.id', scheduledServiceId)
    .first(...serviceLocationSelects(conn));
}

// The inputs of that resolution, compared again under the write lock.
function visitLocationKey(row) {
  return JSON.stringify([row.lat, row.lng, row.address_line1, row.city, row.state, row.zip].map((v) => (v == null ? null : String(v))));
}

// The point the tracer would centre on for this visit, with the key of the
// inputs it came from, or null (no address, geocoder miss or error): reuse is
// then not offered, never held.
async function resolveVisitLocation(knex, scheduledServiceId) {
  try {
    const row = await readVisitLocationRow(knex, scheduledServiceId);
    if (!row) return null;
    const { resolveServiceLocation } = require('./scheduling/day-stops');
    const pin = await resolveServiceLocation(row);
    const lat = pin?.lat == null ? NaN : Number(pin.lat);
    const lng = pin?.lng == null ? NaN : Number(pin.lng);
    return validCoordinate(lat, lng) ? { lat, lng, key: visitLocationKey(row) } : null;
  } catch (err) {
    logger.warn(`[treatment-zone] reuse location failed service=${scheduledServiceId}: ${err.message}`);
    return null;
  }
}

// The newest offerable trace for `visit` (a scheduled_services row with id,
// customer_id, scheduled_date, service_id, service_type), or null. The SQL
// narrows to the same customer's earlier COMPLETED visits; the checks below
// judge each row again, so a wrong row can never pass on the query alone.
// The visit's location is resolved once, and only when some row gets that far.
async function findReusableTreatmentZone(visit, { knex = db } = {}) {
  if (!visit?.id || !visit.customer_id) return null;
  const visitDate = dateOnlyOrNull(visit.scheduled_date);
  if (!visitDate) return null;
  if (await knex('treatment_zone_maps').where({ scheduled_service_id: visit.id }).first('id')) return null;

  const rows = await knex('scheduled_services as ss')
    .join('treatment_zone_maps as tz', 'tz.scheduled_service_id', 'ss.id')
    .where('ss.customer_id', visit.customer_id)
    .where('ss.status', 'completed')
    .whereNot('ss.id', visit.id)
    .where('ss.scheduled_date', '<', visitDate)
    .where('tz.capture_mode', REUSE_CAPTURE_MODE)
    .where('tz.linear_ft', '>', 0)
    // The report draws a trace only from its picture: one with none would
    // clear the sheet's hold and show nothing (Codex P2 r3 on #6175).
    .whereNotNull('tz.snapshot_s3_key')
    .orderBy('ss.scheduled_date', 'desc')
    .orderBy('tz.updated_at', 'desc')
    .limit(REUSE_CANDIDATE_LIMIT)
    .select('tz.*', 'ss.id as source_service_id', 'ss.customer_id as source_customer_id',
      'ss.property_id as source_property_id', 'ss.status as source_status',
      'ss.scheduled_date as source_date', 'ss.service_id as source_service_catalog_id',
      'ss.service_type as source_service_type');

  const { traceCaptureBlockPayload } = require('./service-report/trace-eligibility');
  let here;
  let targetBlocked;
  for (const row of rows) {
    if (!reuseRowMatches(row, visit, visitDate)) continue;
    const footprint = traceFootprint(row.path_points);
    if (!footprint) continue;
    if (here === undefined) here = await resolveVisitLocation(knex, visit.id);
    if (!here) return null;
    if (!footprintContains(footprint, here)) continue;
    // This visit's own eligibility is the same for every candidate (they are
    // all perimeter traces): asked once, not once per row (Codex P2 r11 on #6175).
    if (targetBlocked === undefined) {
      targetBlocked = !!(await traceCaptureBlockPayload(visit, knex, { captureMode: REUSE_CAPTURE_MODE }));
    }
    if (targetBlocked) return null;
    // The SOURCE visit must itself be one whose trace may be captured and
    // shown: a legacy perimeter trace saved on an inspection, a trapping or
    // another service the report hides the map for is never copied onto a
    // visit that would show it (Codex P1 on #6175).
    if (await traceCaptureBlockPayload(sourceVisitOf(row), knex, { captureMode: row.capture_mode })) continue;
    const sourceRecordId = await sourceTraceWasShown(row, knex);
    if (!sourceRecordId) continue;
    return {
      zone: row, sourceServiceId: row.source_service_id, capturedOn: dateOnlyOrNull(row.source_date), locationKey: here.key,
      // What the source was chosen on, for the write to find unchanged.
      sourceFacts: {
        scheduledDate: dateOnlyOrNull(row.source_date),
        serviceCatalogId: row.source_service_catalog_id ?? null,
        serviceType: row.source_service_type ?? null,
        recordId: sourceRecordId,
      },
    };
  }
  return null;
}

// Positive proof that a record's report showed this very trace (owner
// 2026-10-09, "narrow it"; Codex r12 on #6175): the record was completed
// through the Fast Complete report flow, which froze the trace it was judged
// against, and that trace is this row (same updated_at). A record with no
// such judgement (the full form, or a completion before the report flow), or
// one judged with no trace, proves nothing: the report has several separate
// rules that can hide a trace (a callback closed as inspection only, a
// declined visit), and this asks for the evidence instead of listing them.
function traceJudgedAgainst(structuredNotes, row) {
  const judged = structuredNotes?.traceJudged;
  if (!judged || typeof judged !== 'object' || judged.seen == null) return false;
  const seen = new Date(judged.seen).getTime();
  return Number.isFinite(seen) && seen === new Date(row?.updated_at).getTime();
}
const notesOf = (record) => (typeof record?.structured_notes === 'string'
  ? JSON.parse(record.structured_notes || '{}')
  : record?.structured_notes);

// The source trace was one its own report could show (Codex P1 r3 on #6175):
// the render-side verdict, read from the source visit's frozen service record
// (its completion facts and areas, which the capture-side check never sees),
// did not suppress it, AND the record carries the proof that it was judged
// against this very trace (traceJudgedAgainst; a record with no judgement is
// not enough). No record, or any error, is not shown: the copy would put the
// trace on a report, so this fails closed.
async function sourceTraceWasShown(row, knex) {
  try {
    const record = await knex('service_records')
      .where({ scheduled_service_id: row.source_service_id })
      .orderBy('created_at', 'desc')
      .first();
    if (!record) return null;
    const { resolveTraceRenderVerdict } = require('./service-report/trace-eligibility');
    const verdict = await resolveTraceRenderVerdict(record, knex);
    if (!verdict || verdict.suppressed) return null;
    // The record the verdict read, so the write can tell it is still the one.
    return traceJudgedAgainst(notesOf(record), row) ? record.id : null;
  } catch (err) {
    logger.warn(`[treatment-zone] source trace verdict failed service=${row.source_service_id}: ${err.message}`);
    return null;
  }
}

// The source visit as the eligibility check reads a scheduled service.
function sourceVisitOf(row) {
  return {
    id: row.source_service_id,
    customer_id: row.source_customer_id,
    property_id: row.source_property_id,
    scheduled_date: row.source_date,
    status: row.source_status,
    service_id: row.source_service_catalog_id,
    service_type: row.source_service_type,
  };
}

// One candidate row against this visit, before its place is judged: same
// customer, an earlier COMPLETED visit that is not this one, perimeter mode
// with a length and a picture.
function reuseRowMatches(row, visit, visitDate) {
  const sourceDate = dateOnlyOrNull(row.source_date);
  return row.source_service_id !== visit.id
    && String(row.source_customer_id) === String(visit.customer_id)
    && row.source_status === 'completed'
    && !!sourceDate && sourceDate < visitDate
    && row.capture_mode === REUSE_CAPTURE_MODE
    // The sheet's hold clears on a length, so a trace with none is no help;
    // the report draws only a trace that has its picture.
    && Number(row.linear_ft) > 0 && !!row.snapshot_s3_key;
}

function dateOnlyOrNull(value) {
  return require('./visit-groups').dateOnly(value);
}

// What the sheet shows before the tap: no path points, just the size and day.
async function describeReusableTreatmentZone(visit, { knex = db } = {}) {
  const found = await findReusableTreatmentZone(visit, { knex });
  if (!found) return { available: false };
  return {
    available: true,
    linearFt: found.zone.linear_ft ?? null,
    capturedOn: found.capturedOn,
    captureMode: found.zone.capture_mode,
  };
}

async function readStoredImage(key) {
  if (!config.s3?.bucket) throw operationalError('S3 not configured', 500);
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    const bytes = Buffer.from(await out.Body.transformToByteArray());
    if (!bytes.length) throw new Error('empty object');
    return bytes;
  } catch (err) {
    logger.warn(`[treatment-zone] reuse picture read failed key=${key}: ${err.message}`);
    throw Object.assign(
      operationalError('Could not copy the last visit\'s trace picture. Trace it by hand.', 502),
      { code: 'trace_image_copy_failed' },
    );
  }
}

// Copies the trace onto `visit` through the normal save, so the property
// fence, the completed-visit refusal and the one-row-per-visit lock all run,
// and the proof of place (the visit's location, the source's rows) is read
// again under that lock.
// The pictures are read BEFORE the save: a picture that cannot be copied
// fails the request instead of saving a zone with a missing picture.
// One copy per visit at a time in this process (Codex security P2 r7 on
// #6175): the copy buffers and re-uploads the source pictures BEFORE the
// create-only save decides a winner, so a burst of taps (or requests) for one
// visit would each hold megabytes and write storage objects only to delete
// them. A second copy for the same visit while one runs is refused at once,
// with nothing read or uploaded. The route's rate limit bounds the rest.
const reuseInFlight = new Set();
function reuseInProgressError() {
  return Object.assign(operationalError('The last trace is already being copied. Wait a moment.', 409), { code: 'reuse_in_progress' });
}
async function reuseLastTreatmentZone(args) {
  const key = String(args?.visit?.id ?? '');
  if (reuseInFlight.has(key)) throw reuseInProgressError();
  reuseInFlight.add(key);
  try {
    return await copyLastTreatmentZone(args);
  } finally {
    reuseInFlight.delete(key);
  }
}

async function copyLastTreatmentZone({ visit, actor = null, technicianId = null, expectedPropertyId, openVisitOnly = false, knex = db }) {
  // A visit that gained a trace since the offer was read (another device) is
  // told so by name, so the sheet reads that trace: the lookup below answers
  // nothing for it and would read as "no trace to reuse" (pre-push P1).
  if (await knex('treatment_zone_maps').where({ scheduled_service_id: visit.id }).first('id')) throw traceExistsError();
  const found = await findReusableTreatmentZone(visit, { knex });
  if (!found) {
    throw noReusableTraceError();
  }
  const { zone, sourceServiceId, locationKey } = found;
  const snapshotPngBuffer = zone.snapshot_s3_key ? await readStoredImage(zone.snapshot_s3_key) : null;
  const maskPngBuffer = zone.mask_s3_key ? await readStoredImage(zone.mask_s3_key) : null;
  const pathPoints = typeof zone.path_points === 'string' ? JSON.parse(zone.path_points) : zone.path_points;
  const row = await saveTreatmentZoneMap({
    scheduledServiceId: visit.id,
    customerId: visit.customer_id,
    technicianId,
    pathPoints,
    closedLoop: zone.closed_loop,
    linearFt: zone.linear_ft,
    centerLat: zone.center_lat,
    centerLng: zone.center_lng,
    zoom: zone.zoom,
    address: zone.address,
    snapshotPngBuffer,
    maskPngBuffer,
    captureMode: zone.capture_mode,
    ...(expectedPropertyId !== undefined ? { expectedPropertyId } : {}),
    openVisitOnly,
    createOnly: true,
    ...(actor ? { lockedScope: { actor, visit } } : {}),
    reuseGuard: {
      locationKey,
      targetDate: dateOnlyOrNull(visit.scheduled_date),
      source: { zoneId: zone.id, serviceId: sourceServiceId, customerId: visit.customer_id, updatedAt: zone.updated_at, ...found.sourceFacts },
    },
    knex,
  });
  // No column records where a copy came from; the log line does.
  logger.info(`[treatment-zone] reused service=${visit.id} from=${sourceServiceId} linearFt=${row?.linear_ft ?? 'n/a'}`);
  return row;
}

module.exports = {
  traceJudgedAllows,
  saveTreatmentZoneMap,
  deleteTreatmentZoneMap,
  getTreatmentZoneMapForScheduledService,
  findReusableTreatmentZone,
  describeReusableTreatmentZone,
  reuseLastTreatmentZone,
  treatmentZonePdfSignature,
  normalizePathPoints,
  TREATMENT_ZONE_PREFIX,
  MAX_SNAPSHOT_BYTES,
  MAX_PATH_POINTS,
};
