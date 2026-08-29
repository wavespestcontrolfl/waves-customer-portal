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
 *     with the observed labels AND the population identity (cadence /
 *     linkage) recorded in a system_settings state row, so down() never
 *     reverses a row the owner re-cadenced or linked in the meantime
 *     (GH codex #3599 P2).
 *
 * Leg A (unlinked): a (label, recurring_pattern) pair maps to exactly one
 *   current catalog name; the pair is the cadence evidence, so no guess is
 *   involved. A mapping whose target name is missing from the active
 *   catalog is skipped (fail closed), never written blind.
 * Leg B (linked): the row already knows its service; the label syncs from
 *   services.name — but ONLY for labels on the known-stale whitelist, so a
 *   deliberate custom label is never clobbered. The whitelist is further
 *   filtered AT RUN TIME against the active catalog: a whitelisted label
 *   that is itself a current catalog name (e.g. a live "General Pest
 *   Control" row) is a linkage conflict, not a stale snapshot, and is left
 *   for the owner (GH codex #3599 P2). Rows whose label is any other valid
 *   catalog name contradicting their service_id are likewise excluded —
 *   flagged to the owner in the audit instead.
 *
 * Reminder fanout (GH codex #3599 P1): appointment_reminders.service_type
 *   is the label the customer appointment page PREFERS
 *   (appointment-public.js resolveServiceLabel) and the 72h/24h senders
 *   render, so a relabeled visit's reminder row — plus same-slot sibling
 *   rows, where the merger stores the combined label on the EARLIER
 *   visit's row — swaps the same component, exactly as 000010 does. The
 *   swap is component-wise (whole old name at list/edge boundaries), so a
 *   merged "A & B" label keeps its other component; down() reverses the
 *   component on the CURRENT value under the completed-history invariant
 *   (a reminder whose component visit completed since keeps the new
 *   label in agreement with the visit).
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
// conflict for the owner, not a snapshot to overwrite; enforced at run time
// against the active catalog, see activeCatalogNames()).
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

async function activeCatalogNames(knex) {
  const rows = await knex('services').where({ is_active: true }).select('name');
  return new Set(rows.map((r) => r.name).filter((n) => typeof n === 'string'));
}

// Component-wise swap on possibly-merged reminder labels ("A & B",
// "A, B, and C") — same contract as 000010's relabelReminderServiceType:
// the FULL old name is matched at list-delimiter/edge boundaries (an
// optional "(Qualifier)" rides along), so it swaps whether it stands alone
// or inside a merged list, while a longer name that merely starts with it
// never matches. Returns null when nothing changes.
function relabelReminderComponent(value, fromName, toName) {
  if (typeof value !== 'string' || !value) return null;
  if (value === fromName || value.startsWith(`${fromName} (`)) {
    return toName + value.slice(fromName.length);
  }
  const escaped = fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '(?:,\\s+and\\s+|,\\s+|\\s+&\\s+)';
  const re = new RegExp(`(^|${boundary})${escaped}(\\s*\\([^()]*\\))?(?=$|${boundary})`, 'g');
  const next = value.replace(re, (m, pre, qualifier) => pre + toName + (qualifier || ''));
  return next === value ? null : next;
}

const REMINDER_COLS = ['id', 'service_type', 'customer_id', 'appointment_time', 'scheduled_service_id'];

// Fan a (from → to) visit relabel out to the reminder registrations of the
// given visit ids and their same-slot siblings. Each record carries its
// COMPONENT visit (the relabeled visit that put it in the sweep) so down()
// can honor the completed-history invariant per reminder.
async function relabelReminders(knex, visitIds, fromName, toName, state) {
  if (!visitIds.length) return;
  const linked = await knex('appointment_reminders')
    .whereIn('scheduled_service_id', visitIds)
    .select(...REMINDER_COLS);
  const targets = new Map(linked.map((r) => [r.id, { rem: r, sourceVisitId: r.scheduled_service_id || null }]));
  for (const rem of linked) {
    if (rem.customer_id == null || rem.appointment_time == null) continue;
    const siblings = await knex('appointment_reminders')
      .where({ customer_id: rem.customer_id, appointment_time: rem.appointment_time })
      .select(...REMINDER_COLS);
    for (const sib of siblings) {
      if (!targets.has(sib.id)) targets.set(sib.id, { rem: sib, sourceVisitId: rem.scheduled_service_id || null });
    }
  }
  for (const { rem, sourceVisitId } of targets.values()) {
    const next = relabelReminderComponent(rem.service_type, fromName, toName);
    if (next === null) continue;
    const count = await knex('appointment_reminders')
      .where({ id: rem.id, service_type: rem.service_type })
      .update({ service_type: next, updated_at: knex.fn.now() });
    if (count) {
      state.reminders.push({ id: rem.id, prior: rem.service_type, written: next, from: fromName, to: toName, visit_id: sourceVisitId });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('services'))) return;

  const state = { unlinked: [], linked: [], reminders: [] };
  const catalog = await activeCatalogNames(knex);
  // (from → to) → relabeled visit ids, for the reminder fanout below.
  const relabeled = new Map();
  const noteRelabel = (from, to, id) => {
    const key = `${from} ${to}`;
    if (!relabeled.has(key)) relabeled.set(key, { from, to, ids: [] });
    relabeled.get(key).ids.push(id);
  };

  // Leg A — unlinked legacy rows, mapped by (label, cadence).
  for (const [stale, pattern, target] of UNLINKED_MAPPING) {
    if (!catalog.has(target)) continue; // fail closed — never write a name the catalog doesn't carry

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
      if (count) {
        state.unlinked.push({ id: r.id, from: stale, to: target, pattern });
        noteRelabel(stale, target, r.id);
      }
    }
  }

  // Leg B — linked rows on the known-stale whitelist sync from the catalog.
  // A whitelisted label that is itself a live catalog name is a linkage
  // conflict (owner-managed), so it drops out of the sweep here.
  const staleLabels = LINKED_STALE_LABELS.filter((label) => !catalog.has(label));
  const linkedRows = staleLabels.length
    ? await openVisitStatus(
      knex('scheduled_services as ss')
        .join('services as sv', 'sv.id', 'ss.service_id')
        .whereIn('ss.service_type', staleLabels)
        .whereRaw('ss.service_type <> sv.name')
    ).select('ss.id', 'ss.service_type', 'ss.service_id', 'sv.name as catalog_name')
    : [];

  for (const r of linkedRows) {
    const count = await openVisitStatus(
      knex('scheduled_services')
        .where({ id: r.id, service_type: r.service_type, service_id: r.service_id })
    ).update({ service_type: r.catalog_name });
    if (count) {
      state.linked.push({ id: r.id, from: r.service_type, to: r.catalog_name, service_id: r.service_id });
      noteRelabel(r.service_type, r.catalog_name, r.id);
    }
  }

  // Reminder registrations render their own service_type (and the public
  // appointment page prefers it over the visit row) — sweep them too.
  if (relabeled.size && (await knex.schema.hasTable('appointment_reminders'))) {
    for (const { from, to, ids } of relabeled.values()) {
      await relabelReminders(knex, ids, from, to, state);
    }
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

  // Reverse only rows still carrying exactly what up() wrote AND still in
  // the population up() matched (same cadence / linkage — an owner who
  // re-cadenced or linked the row since has taken it over), and only while
  // still open (a visit completed under the new label is history). A
  // record missing its identity fields is skipped: never guess.
  for (const rec of state.unlinked || []) {
    if (!rec || typeof rec.pattern !== 'string') continue;
    await openVisitStatus(
      knex('scheduled_services')
        .where({ id: rec.id, service_type: rec.to, recurring_pattern: rec.pattern })
        .whereNull('service_id')
    ).update({ service_type: rec.from });
  }
  for (const rec of state.linked || []) {
    if (!rec || rec.service_id == null) continue;
    await openVisitStatus(
      knex('scheduled_services')
        .where({ id: rec.id, service_type: rec.to, service_id: rec.service_id })
    ).update({ service_type: rec.from });
  }

  const reminderRecs = Array.isArray(state.reminders) ? state.reminders : [];
  if (reminderRecs.length && (await knex.schema.hasTable('appointment_reminders'))) {
    // Completed-history invariant applies to reminders too: a reminder
    // whose component visit completed since up() keeps the new label in
    // agreement with the visit.
    const visitIds = [...new Set(reminderRecs.map((r) => r && r.visit_id).filter(Boolean))];
    const terminal = new Set();
    if (visitIds.length) {
      const visits = await knex('scheduled_services').whereIn('id', visitIds).select('id', 'status');
      for (const v of visits) if (TERMINAL_VISIT_STATUSES.includes(v.status)) terminal.add(v.id);
    }
    // Reverse in the opposite order to the forward passes so a merged label
    // touched by two (from → to) pairs unwinds cleanly.
    for (const rec of [...reminderRecs].reverse()) {
      if (!rec || typeof rec.from !== 'string' || typeof rec.to !== 'string') continue;
      if (rec.visit_id && terminal.has(rec.visit_id)) continue;
      // Component-wise reversal on the CURRENT value: a merged reminder
      // whose OTHER component is kept can never equal the recorded
      // `written` whole-string, and only rows up() recorded are touched.
      const current = await knex('appointment_reminders').where({ id: rec.id }).first('id', 'service_type');
      if (!current) continue;
      const restored = relabelReminderComponent(current.service_type, rec.to, rec.from);
      if (restored === null) continue;
      await knex('appointment_reminders')
        .where({ id: rec.id, service_type: current.service_type })
        .update({ service_type: restored, updated_at: knex.fn.now() });
    }
  }

  await knex('system_settings').where({ key: STATE_KEY }).del();
};
