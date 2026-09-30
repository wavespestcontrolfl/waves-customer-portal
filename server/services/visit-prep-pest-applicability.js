/**
 * Visit prep pest read — applicability only (does this stop have a PEST
 * part?). A pest part is a strict pest-only service, or the pest side of a
 * combined lawn + pest service label (visit-prep-combo-types.js; owner ruling
 * 2026-09-30). Whether the stop is ALSO a lawn / tree & shrub stop, and which
 * read engine(s) run, is decided by visit-prep-read-key.js.
 * Kept apart from visit-prep-pest-read.js so the technician's Visit Brief
 * can ask the question without loading the vision engine, its catalog and
 * validators on the request path (Codex #5305 r13).
 */
const db = require('../models/db');
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
// Strict pest identity, not the revenue classifier's Pest Control catch-all
// (which also takes WDO inspections and assessments; Codex #5305 r10 P1).
const { isPestOnlyServiceType } = require('./pest-production-calibration');
const { isComboServiceType } = require('./visit-prep-combo-types');

// A pest part: a pest-only service, or the pest side of a combined label.
const hasPestPart = (serviceType) => isPestOnlyServiceType(serviceType) || isComboServiceType(serviceType);

// Every LIVE (non-terminal) service_type on svc's CURRENT physical stop:
// the same member set the technician's Visit Brief shows
// (visit-prep.js techStopMemberIds — rowStillAtVisitStop plus the stop's
// technician), so a sibling moved to another day or window but still
// carrying the frozen visit_id never counts (Codex #5305 r1 P1).
async function liveStopServiceTypes(svc, conn) {
  // The anchor row is always re-read: the deferred trigger's snapshot can be
  // stale (reclassified Pest -> Lawn, rescheduled or cancelled since the
  // upload), and a stale pest type must not spend a paid read (Codex #5305
  // r9). A join-ineligible anchor contributes nothing.
  const anchor = svc?.id
    ? await conn('scheduled_services').where({ id: svc.id }).first('service_type', 'status', 'visit_id')
    : null;
  const own = anchor && anchor.service_type && !JOIN_INELIGIBLE_STATUSES.includes(anchor.status)
    ? [anchor.service_type] : [];
  if (!anchor?.visit_id) return own;
  const { techStopMemberIds } = require('./visit-prep');
  const others = (await techStopMemberIds({ ...svc, visit_id: anchor.visit_id }, conn)).filter((id) => String(id) !== String(svc.id));
  if (!others.length) return own;
  const rows = await conn('scheduled_services').whereIn('id', others).select('service_type', 'status');
  // Join-ineligible = terminal + 'rescheduled' (a row awaiting a new date
  // keeps its old visit_id/date/window but is no longer at this stop;
  // Codex #5305 r7 P2).
  return [...own, ...rows.filter((r) => !JOIN_INELIGIBLE_STATUSES.includes(r.status)).map((r) => r.service_type)];
}

async function isPestStop(svc, conn = db) {
  const types = await liveStopServiceTypes(svc, conn);
  return types.some(hasPestPart);
}

// Pest-ness of an ALREADY-RESOLVED member set (e.g. the tech facts read's
// final membership snapshot), so the answer can never describe a different
// set of rows than the caller is about to serve.
async function membersArePest(memberIds, conn = db) {
  const ids = [...new Set((memberIds || []).map(String))];
  if (!ids.length) return false;
  const rows = await conn('scheduled_services').whereIn('id', ids).select('service_type', 'status');
  return rows.some((r) => !JOIN_INELIGIBLE_STATUSES.includes(r.status) && hasPestPart(r.service_type));
}

module.exports = { isPestStop, liveStopServiceTypes, membersArePest, hasPestPart };
