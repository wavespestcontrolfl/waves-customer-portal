/**
 * Catalog service-name aliases — the rename history that runtime name
 * resolution must bridge in BOTH directions.
 *
 * The 2026-08-29 cadence-convention renames relocate the cadence word
 * ("General Pest Control Service (Bi-Monthly)" → "Bi-Monthly Pest Control
 * Service"), so the generic suffix/parenthetical bridges in
 * serviceNameCandidates cannot derive one form from the other. A call
 * extraction persisted before the deploy and replayed after it, a hold
 * labeled with the old form that commits after the migration, or the
 * documented down() (catalog restored while deployed code emits the new
 * labels) all need the counterpart name to resolve the same catalog row.
 *
 * Source of truth for the pairs is migration 20260829000010's RENAMES; the
 * cadence-convention test asserts this list equals it (migrations are
 * frozen artifacts, so the runtime copy lives here).
 */
const CADENCE_CONVENTION_RENAMES = [
  ['General Pest Control Service (Bi-Monthly)', 'Bi-Monthly Pest Control Service'],
  ['General Pest Control Service (Semiannual)', 'Semiannual Pest Control Service'],
  ['Lawn Care Program — Quarterly', 'Quarterly Lawn Care Service'],
  ['Lawn Care Program Service', 'Bi-Monthly Lawn Care Service'],
  ['Lawn Care Program — Every 6 Weeks', 'Every 6 Weeks Lawn Care Service'],
  ['Lawn Care Program — Monthly', 'Monthly Lawn Care Service'],
  ['Mosquito Control Service (Monthly)', 'Monthly Mosquito Control Service'],
  ['Rodent Monitoring Service (Monthly)', 'Monthly Rodent Bait Station Service'],
  ['Termite Active Bait Station Service (Quarterly)', 'Quarterly Termite Active Bait Station Service'],
  ['Termite Active Annual Bait Station Service', 'Annual Termite Active Bait Station Service'],
];

const BY_LOWER = new Map();
for (const [from, to] of CADENCE_CONVENTION_RENAMES) {
  BY_LOWER.set(from.toLowerCase(), to);
  BY_LOWER.set(to.toLowerCase(), from);
}

/** The other spelling of a renamed catalog service, or null. */
function counterpartServiceName(name) {
  return BY_LOWER.get(String(name || '').trim().toLowerCase()) || null;
}

module.exports = { CADENCE_CONVENTION_RENAMES, counterpartServiceName };
