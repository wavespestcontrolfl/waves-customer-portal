/**
 * Visit prep plant read — applicability only (is this stop a lawn or a
 * tree & shrub stop?). Sibling of visit-prep-pest-applicability.js, kept
 * apart from visit-prep-plant-read.js for the same reason: the technician's
 * Visit Brief can ask the question without loading the plant vision engine,
 * its catalog and prompts on the request path.
 *
 * Own design decision (documented per the assignment): a stop whose live
 * members include BOTH a pest-only service and a lawn/tree & shrub one runs
 * the pest read, never both — this module defers entirely to
 * visit-prep-pest-applicability.js's isPestStop for that check, so the two
 * modules can never independently reach "applicable" for the same stop at
 * the same time (mutual exclusion by construction, not a runtime lock: the
 * pest and plant triggers are two independent fire-and-forget calls with no
 * shared lock between them — see visit-prep-plant-read.js's header).
 *
 * Subject resolution uses the canonical service classifier
 * (utils/service-normalizer.js detectServiceCategory) plus this lane's
 * exclusions (a combined service, one naming another line, palm): see
 * isLawnOnlyServiceType / isTreeShrubOnlyServiceType below. A WDO
 * inspection, termite service or Waves Assessment never classifies as lawn
 * or tree_shrub.
 */
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { isPestOnlyServiceType } = require('./pest-production-calibration');
const { detectServiceCategory } = require('../utils/service-normalizer');
const { isPestStop, liveStopServiceTypes } = require('./visit-prep-pest-applicability');

// The line comes from the canonical classifier (utils/service-normalizer.js
// detectServiceCategory — "Weed Control Service" and "Sod Replacement" are
// lawn, "Ornamental Care Program" is tree & shrub; Codex #5320 r5). This
// lane only adds its exclusions: a combined service, or one naming another
// line (mosquito, termite, rodent, WDO, or pest joined to it), is never read here, and palm
// services stay out (the read's subject is lawn or tree_shrub only).
// 'pest' alone is NOT an exclusion: "Lawn Pest Control" is a lawn-line
// product (utils/service-line-infer.js) and the plant engine reads lawn
// pests (Codex #5320 r6). Only a genuinely combined label is excluded.
const OTHER_LINE_TOKENS = ['mosquito', 'termite', 'rodent', 'wdo', ' + ', ' & pest', ' and pest', 'pest &', 'pest and'];

function normalizedLabel(serviceType) {
  return String(serviceType || '').toLowerCase().replace(/[_-]+/g, ' ');
}

function namesAnotherLine(raw) {
  return OTHER_LINE_TOKENS.some((token) => raw.includes(token));
}

function isLawnOnlyServiceType(serviceType) {
  const raw = normalizedLabel(serviceType);
  return detectServiceCategory(serviceType) === 'lawn' && !namesAnotherLine(raw);
}

function isTreeShrubOnlyServiceType(serviceType) {
  const raw = normalizedLabel(serviceType);
  return detectServiceCategory(serviceType) === 'tree_shrub' && !namesAnotherLine(raw) && !raw.includes('palm');
}

// 'lawn' | 'tree_shrub' | null — lawn checked first (documented, arbitrary)
// on the rare stop that somehow carries both a lawn-only and a
// tree_shrub-only live member; a photo submission has no per-topic split
// (the appointment page no longer asks for one, same as the pest read), so
// only one subject can be read per submission.
function plantSubjectForTypes(types) {
  if ((types || []).some((t) => isLawnOnlyServiceType(t))) return 'lawn';
  if ((types || []).some((t) => isTreeShrubOnlyServiceType(t))) return 'tree_shrub';
  return null;
}

// The trigger's own applicability check: re-resolves svc's CURRENT live
// stop membership (visit-prep-pest-applicability.js's liveStopServiceTypes
// — the same member set the pest read and the technician's Visit Brief
// use) and returns 'lawn' | 'tree_shrub' | null. Pest wins first.
async function plantSubjectForStop(svc, conn) {
  if (await isPestStop(svc, conn)) return null;
  const types = await liveStopServiceTypes(svc, conn);
  return plantSubjectForTypes(types);
}

// The tech facts read's own check, over an ALREADY-RESOLVED member set (the
// final stop snapshot), so the answer never describes a different set of
// rows than the caller is about to serve — the same contract as the pest
// applicability module's membersArePest.
async function subjectForMembers(memberIds, conn) {
  const ids = [...new Set((memberIds || []).map(String))];
  if (!ids.length) return null;
  const rows = await conn('scheduled_services').whereIn('id', ids).select('service_type', 'status');
  const live = rows.filter((r) => !JOIN_INELIGIBLE_STATUSES.includes(r.status)).map((r) => r.service_type);
  if (live.some((t) => isPestOnlyServiceType(t))) return null;
  return plantSubjectForTypes(live);
}

module.exports = {
  isLawnOnlyServiceType,
  isTreeShrubOnlyServiceType,
  plantSubjectForTypes,
  plantSubjectForStop,
  subjectForMembers,
};
