/**
 * Staff onboarding documents (GATE_STAFF_ONBOARDING_DOCS, owner 2026-10-08).
 *
 * A staff document an admin marked "Required at onboarding"
 * (document_templates.onboarding_required) is OUTSTANDING for an active staff member
 * who can open it until that member has SIGNED its CURRENT issued version:
 *   - policy: a staff_document_acknowledgments row for the version;
 *   - form / procedure: a COMPLETED staff_document_records row (owner = the member).
 * Outstanding is derived from that evidence on every read. Nothing is pre-assigned and
 * nothing is written: a new issued version is outstanding again by itself, and a
 * deactivated hire leaves no open row behind (an open staff record cannot be deleted).
 * The card deep-links document + version; the record screen starts the member's own
 * record when none is picked.
 *
 * Gate off = the read functions return empty before any query. The auto clock-in
 * vehicle-agreement check (hasCompletedIssuedRecord) is NOT gated: it is a pay-compliance
 * precondition that applies whenever GATE_GEOFENCE_AUTO_CLOCK_IN is on.
 */
const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const { dateOnlyString } = require('../utils/date-only');
const { parseETDateTime, addETDaysAtWallClock } = require('../utils/datetime-et');

const VEHICLE_AGREEMENT_KEY = 'staff.vehicle-use-commuting-agreement';
// Display only: the due date shown for a form or procedure is this many days after the
// later of the hire date and the version's effective date. Nothing is stored or enforced.
const DUE_DAYS = 7;

const empty = () => ({ enabled: false, documents: [], counts: { outstanding: 0, total: 0 } });

function live() {
  return featureGates.staffOnboardingDocsLive() && featureGates.gateEnvValue('GATE_CONTROLLED_STAFF_DOCUMENTS');
}

/**
 * True when this technician has a COMPLETED record on ANY issued version (effective now or
 * earlier) of the staff form `templateKey`. A wording re-issue must not silently undo a
 * signed agreement. One plain snapshot query; the caller decides what an error means.
 */
async function hasCompletedIssuedRecord(conn, technicianId, templateKey, now = new Date()) {
  const row = await conn('staff_document_records as r')
    .join('document_template_versions as v', 'v.id', 'r.version_id')
    .join('document_templates as t', 't.id', 'v.template_id')
    .where({ 't.template_key': templateKey, 't.audience': 'staff', 'r.owner_id': technicianId })
    .whereNotNull('r.completed_at')
    .whereNotNull('v.published_at')
    .where('v.effective_at', '<=', now)
    .first('r.id');
  return !!row;
}

// The current ISSUED version of every required staff document (the same rule as
// staff-documents.js recordableVersion: published, effective now, latest effective_at).
function requiredVersions(conn, now) {
  return conn('document_templates as t')
    .join('document_template_versions as v', 'v.template_id', 't.id')
    .where({ 't.audience': 'staff', 't.onboarding_required': true, 't.status': 'active' })
    .whereNotNull('v.published_at')
    .where('v.effective_at', '<=', now)
    .whereRaw(`v.id = (SELECT c.id FROM document_template_versions c
      WHERE c.template_id = t.id AND c.published_at IS NOT NULL AND c.effective_at <= ?
      ORDER BY c.effective_at DESC LIMIT 1)`, [now])
    .orderBy('t.name')
    .select('t.id as document_id', 't.name', 't.staff_kind as kind', 't.staff_access', 'v.id as version_id', 'v.effective_at', 'v.content_snapshot');
}

// The payroll hire date (start of that ET day) is the authority; the account's
// created_at is only the fallback for a profile with no hire date recorded.
function hiredAt(person) {
  const day = dateOnlyString(person.hire_date);
  const parsed = day ? parseETDateTime(`${day}T00:00`) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(person.created_at);
}
// Seven Eastern CALENDAR days, same wall-clock time (a DST change inside the
// window must not pull the deadline a day early).
const displayDue = (person, doc) => addETDaysAtWallClock(
  new Date(Math.max(hiredAt(person).getTime(), new Date(doc.effective_at).getTime())), DUE_DAYS,
);

// Three reads for any number of people: Map(person id -> their required documents, each with
// when it was signed). A non-admin sees only staff_access 'staff' documents.
async function standingFor(conn, people, now = new Date()) {
  const standing = new Map(people.map((person) => [person.id, []]));
  const required = await requiredVersions(conn, now);
  if (!required.length || !people.length) return standing;
  const ids = people.map((person) => person.id);
  const versionIds = required.map((doc) => doc.version_id);
  const signed = new Map();
  const acks = await conn('staff_document_acknowledgments').whereIn('technician_id', ids)
    .whereIn('version_id', versionIds).select('technician_id as who', 'version_id', 'acknowledged_at as at');
  const records = await conn('staff_document_records').whereIn('owner_id', ids).whereNotNull('completed_at')
    .whereIn('version_id', versionIds).select('owner_id as who', 'version_id', 'completed_at as at');
  for (const row of [...acks, ...records]) signed.set(`${row.who}:${row.version_id}`, row.at);
  for (const person of people) {
    standing.set(person.id, required.filter((doc) => person.role === 'admin' || doc.staff_access === 'staff').map((doc) => {
      const completedAt = signed.get(`${person.id}:${doc.version_id}`) || null;
      return {
        document_id: doc.document_id, title: doc.content_snapshot?.title || doc.name, kind: doc.kind,
        version_id: doc.version_id, done: !!completedAt, completed_at: completedAt,
        due_at: doc.kind === 'policy' ? null : displayDue(person, doc),
      };
    }));
  }
  return standing;
}

const shown = (item) => ({ document_id: item.document_id, title: item.title, kind: item.kind, version_id: item.version_id, due_at: item.due_at });

/** The caller's own outstanding required documents. tech = { id }. A pure read. */
async function onboardingFor(tech) {
  if (!live()) return empty();
  const person = await db('technicians').where({ id: tech.id, employment_status: 'active' }).first('id', 'role', 'created_at', 'hire_date');
  const items = person ? (await standingFor(db, [person])).get(person.id) : [];
  const documents = items.filter((item) => !item.done).map(shown);
  return { enabled: true, documents, counts: { outstanding: documents.length, total: items.length } };
}

/** Admin: every active technician, signed vs outstanding. A pure read. */
async function onboardingForTeam() {
  if (!live()) return { enabled: false, technicians: [] };
  const people = await db('technicians').where({ employment_status: 'active' }).orderBy('name').select('id', 'name', 'role', 'created_at', 'hire_date');
  const standing = await standingFor(db, people);
  return {
    enabled: true,
    technicians: people.map((person) => {
      const items = standing.get(person.id);
      return {
        technician_id: person.id, name: person.name, role: person.role,
        outstanding: items.filter((item) => !item.done).map(shown),
        signed: items.filter((item) => item.done).map((item) => ({ document_id: item.document_id, title: item.title, kind: item.kind, completed_at: item.completed_at })),
      };
    }),
  };
}

module.exports = {
  VEHICLE_AGREEMENT_KEY,
  DUE_DAYS,
  hasCompletedIssuedRecord,
  onboardingFor,
  onboardingForTeam,
};
