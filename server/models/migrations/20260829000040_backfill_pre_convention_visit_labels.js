/**
 * Backfill pre-convention visit labels (owner GO 2026-08-29, service-name
 * audit). Companion to 20260829000010: that migration relabeled open visits
 * still carrying the ten SHIPPED pre-rename catalog names; this one covers
 * the older generation of labels stamped before those names existed —
 * unlinked legacy series ("Quarterly Pest Control", "Lawn Care", "General
 * Pest Control (Quarterly)", …) and linked rows whose snapshot predates the
 * current catalog name. Prod pre-read 2026-08-29: 214 unlinked + 10 linked
 * open rows across ~65 customers.
 *
 * Same invariants as 20260829000010:
 *  1. Historical immutability — only OPEN visits relabel (NULL status is
 *     open; `rescheduled` is a live rebook state and relabels). Terminal
 *     visits keep the label they closed under.
 *  2. Conflict-safe rollback — per-row compare-and-set both directions,
 *     with the observed labels recorded in a system_settings state row.
 *
 * Leg A (unlinked): a (label, recurring_pattern) pair maps to exactly one
 *   current catalog name; the pair is the cadence evidence, so no guess is
 *   involved. A mapping whose target name is missing from the active
 *   catalog is skipped (fail closed), never written blind.
 * Leg B (linked): the row already knows its service; the label syncs from
 *   services.name — but ONLY for labels on the known-stale whitelist, so a
 *   deliberate custom label is never clobbered. Rows whose label is itself
 *   a valid catalog name that CONTRADICTS their service_id (a linkage
 *   conflict, not a stale label) are deliberately excluded — flagged to the
 *   owner in the audit instead.
 *
 * Deliberately out of scope: backfilling service_id linkage on legacy rows
 * (would activate per-service closeout/report requirements — separate
 * owner decision), and terminal series parents — they keep their
 * closed-under label per Invariant 1, so a child generated FROM a terminal
 * parent (admin-schedule.js copies parent.service_type verbatim) is still
 * born with the old label. Closing that requires the generator to resolve
 * the catalog name at insert time — follow-up, not a data backfill.
 */

const STATE_KEY = 'migration.20260829000040.state';

// Copied from 20260829000010 (migrations are frozen artifacts — no import).
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

// (stale label, recurring_pattern) → current catalog name. The pattern is
// load-bearing: "Pest Control" alone is ambiguous, "Pest Control" +
// quarterly is not. Prod pre-read row counts in the PR body.
const UNLINKED_MAPPING = [
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

// Linked rows relabel from their own services.name, but only while carrying
// one of these known-stale generics (never a deliberate custom label, and
// never a label that is itself a current catalog name — that's a linkage
// conflict for the owner, not a snapshot to overwrite).
const LINKED_STALE_LABELS = [
  'Pest Control',
  'Pest Control Service',
  'General Pest Control',
  'General Pest Control (Quarterly)',
  'Quarterly Pest Control',
  'Lawn Care Service',
  'Lawn Care Visit',
];

function openVisitStatus(q) {
  return q.where((b) => b.whereNull('status').orWhereNotIn('status', TERMINAL_VISIT_STATUSES));
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('services'))) return;

  const state = { unlinked: [], linked: [] };

  // Leg A — unlinked legacy rows, mapped by (label, cadence).
  for (const [stale, pattern, target] of UNLINKED_MAPPING) {
    const targetExists = await knex('services')
      .where({ name: target, is_active: true })
      .first('id');
    if (!targetExists) continue; // fail closed — never write a name the catalog doesn't carry

    const rows = await openVisitStatus(
      knex('scheduled_services')
        .whereNull('service_id')
        .where({ service_type: stale, recurring_pattern: pattern })
    ).select('id');

    for (const r of rows) {
      // CAS scoped to id + observed label + population predicate: a row
      // relinked or completed between read and write is never renamed.
      const count = await openVisitStatus(
        knex('scheduled_services')
          .where({ id: r.id, service_type: stale, recurring_pattern: pattern })
          .whereNull('service_id')
      ).update({ service_type: target });
      if (count) state.unlinked.push({ id: r.id, from: stale, to: target });
    }
  }

  // Leg B — linked rows on the known-stale whitelist sync from the catalog.
  const linkedRows = await openVisitStatus(
    knex('scheduled_services as ss')
      .join('services as sv', 'sv.id', 'ss.service_id')
      .whereIn('ss.service_type', LINKED_STALE_LABELS)
      .whereRaw('ss.service_type <> sv.name')
  ).select('ss.id', 'ss.service_type', 'ss.service_id', 'sv.name as catalog_name');

  for (const r of linkedRows) {
    const count = await openVisitStatus(
      knex('scheduled_services')
        .where({ id: r.id, service_type: r.service_type, service_id: r.service_id })
    ).update({ service_type: r.catalog_name });
    if (count) state.linked.push({ id: r.id, from: r.service_type, to: r.catalog_name });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  let state;
  try {
    state = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  } catch {
    return; // unreadable state — leave data as-is rather than guess
  }

  // Reverse only rows still carrying exactly what up() wrote, and only
  // while still open (a visit completed under the new label is history).
  for (const rec of [...(state.unlinked || []), ...(state.linked || [])]) {
    await openVisitStatus(
      knex('scheduled_services').where({ id: rec.id, service_type: rec.to })
    ).update({ service_type: rec.from });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
