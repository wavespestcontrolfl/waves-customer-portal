/**
 * Visit prep plant read — applicability only (does this stop have a lawn or
 * tree & shrub PART, and what is the stop's read shape?). Sibling of
 * visit-prep-pest-applicability.js, kept apart from visit-prep-plant-read.js
 * for the same reason: the technician's Visit Brief can ask the question
 * without loading the plant vision engine, its catalog and prompts on the
 * request path.
 *
 * Owner ruling 2026-09-30 (replaces the older "pest wins, never both" rule):
 * a combined Lawn & Pest visit gets BOTH reads. There are two combo shapes,
 * and this module reports both the same way, as a read SHAPE
 * `{ pest, plantSubject }`:
 *   (a) one live member whose service_type is a COMBINED label
 *       (visit-prep-combo-types.js, e.g. "Lawn Care + Pest Control");
 *   (b) separate live pest-only AND lawn-only / tree & shrub-only members.
 * A stop with both a pest part and a plant part is a combo stop. Which
 * engine(s) actually run for a shape depends on the live gates and is decided
 * in ONE place, visit-prep-read-key.js.
 *
 * Subject resolution uses the canonical service classifier
 * (utils/service-normalizer.js detectServiceCategory) plus this lane's
 * exclusions (a combined service, one naming another line, palm): see
 * isLawnOnlyServiceType / isTreeShrubOnlyServiceType below. A WDO
 * inspection, termite service or Waves Assessment never classifies as lawn
 * or tree_shrub; mosquito, termite, rodent, WDO and palm never make a combo.
 */
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { detectServiceCategory } = require('../utils/service-normalizer');
const { liveStopServiceTypes, hasPestPart } = require('./visit-prep-pest-applicability');
const { comboSubjectForType } = require('./visit-prep-combo-types');

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

// 'lawn' | 'tree_shrub' | null — the plant SUBJECT of a member set: a
// lawn-only / tree & shrub-only member, or the plant side of a combined label.
// Lawn checked first (documented, arbitrary) on the rare stop that somehow
// carries both a lawn and a tree_shrub part; a photo submission has no
// per-topic split (the appointment page no longer asks for one, same as the
// pest read), so only one plant subject can be read per submission. A pest
// member does NOT hide it: a pest + lawn stop still has a lawn subject.
function plantSubjectForTypes(types) {
  const list = types || [];
  const comboSubjects = list.map(comboSubjectForType);
  if (list.some((t) => isLawnOnlyServiceType(t)) || comboSubjects.includes('lawn')) return 'lawn';
  if (list.some((t) => isTreeShrubOnlyServiceType(t)) || comboSubjects.includes('tree_shrub')) return 'tree_shrub';
  return null;
}

// { pest: boolean, plantSubject: 'lawn'|'tree_shrub'|null } for a member set.
// pest = a pest-only service or the pest side of a combined label.
function readShapeForTypes(types) {
  const list = types || [];
  return { pest: list.some(hasPestPart), plantSubject: plantSubjectForTypes(list) };
}

// The stop's read shape as it is NOW: re-resolves svc's CURRENT live stop
// membership (visit-prep-pest-applicability.js's liveStopServiceTypes — the
// same member set the pest read and the technician's Visit Brief use).
async function stopReadShape(svc, conn) {
  return readShapeForTypes(await liveStopServiceTypes(svc, conn));
}

// 'lawn' | 'tree_shrub' | null for the stop as it is now (pest membership
// does not hide it).
async function plantSubjectForStop(svc, conn) {
  return plantSubjectForTypes(await liveStopServiceTypes(svc, conn));
}

async function liveTypesForMembers(memberIds, conn) {
  const ids = [...new Set((memberIds || []).map(String))];
  if (!ids.length) return [];
  const rows = await conn('scheduled_services').whereIn('id', ids).select('service_type', 'status');
  return rows.filter((r) => !JOIN_INELIGIBLE_STATUSES.includes(r.status)).map((r) => r.service_type);
}

// The tech facts read's own checks, over an ALREADY-RESOLVED member set (the
// final stop snapshot), so the answer never describes a different set of
// rows than the caller is about to serve — the same contract as the pest
// applicability module's membersArePest. A pest member never hides the plant
// subject (a combo stop shows both notes).
async function subjectForMembers(memberIds, conn) {
  return plantSubjectForTypes(await liveTypesForMembers(memberIds, conn));
}

async function readShapeForMembers(memberIds, conn) {
  return readShapeForTypes(await liveTypesForMembers(memberIds, conn));
}

module.exports = {
  isLawnOnlyServiceType,
  isTreeShrubOnlyServiceType,
  plantSubjectForTypes,
  readShapeForTypes,
  stopReadShape,
  plantSubjectForStop,
  subjectForMembers,
  readShapeForMembers,
};
