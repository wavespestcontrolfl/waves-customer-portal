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

/**
 * Pre-convention series labels — the generation of labels stamped BEFORE
 * the ten renamed names existed ("Quarterly Pest Control", "Lawn Care",
 * "General Pest Control (Quarterly)", …). A label alone is ambiguous
 * ("Pest Control" is quarterly OR monthly); the (label, recurring_pattern)
 * pair is the cadence evidence and maps to exactly one current catalog
 * name.
 *
 * Source of truth is migration 20260829000040's UNLINKED_MAPPING (which
 * relabeled the OPEN visits); the runtime copy exists because TERMINAL
 * series parents keep their closed-under label by that migration's
 * Invariant 1 — and series generation reads the parent — so the generator
 * resolves the current name at insert instead of copying the parent label
 * verbatim. The backfill test asserts this list equals the migration's.
 */
const LEGACY_LABEL_CADENCE_NAMES = [
  ['Quarterly Pest Control', 'quarterly', 'Quarterly Pest Control Service'],
  ['Pest Control', 'quarterly', 'Quarterly Pest Control Service'],
  ['General Pest Control (Quarterly)', 'quarterly', 'Quarterly Pest Control Service'],
  ['General Pest Control', 'quarterly', 'Quarterly Pest Control Service'],
  ['General Pest Control (Semiannual)', 'semiannual', 'Semiannual Pest Control Service'],
  ['General Pest Control (Bi-Monthly)', 'bimonthly', 'Bi-Monthly Pest Control Service'],
  ['Pest Control', 'monthly', 'Monthly Pest Control Service'],
  ['Lawn Care', 'monthly_nth_weekday', 'Monthly Lawn Care Service'],
  ['Lawn Care', 'every_6_weeks', 'Every 6 Weeks Lawn Care Service'],
  ['Lawn Care Service', 'bimonthly', 'Bi-Monthly Lawn Care Service'],
];

const LEGACY_BY_PAIR = new Map(
  LEGACY_LABEL_CADENCE_NAMES.map(([label, pattern, to]) => [`${label.toLowerCase()}|${pattern}`, to])
);

/** Current catalog name for a pre-convention (label, cadence) pair, or null. */
function legacyCatalogName(label, recurringPattern) {
  if (!label || !recurringPattern) return null;
  return LEGACY_BY_PAIR.get(`${String(label).trim().toLowerCase()}|${String(recurringPattern).trim()}`) || null;
}

module.exports = {
  CADENCE_CONVENTION_RENAMES,
  LEGACY_LABEL_CADENCE_NAMES,
  counterpartServiceName,
  legacyCatalogName,
};
