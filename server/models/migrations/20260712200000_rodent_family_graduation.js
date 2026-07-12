/**
 * Rodent family graduation: internal_only → auto_send for the whole rodent
 * shadow (Phase A of docs/design/universal-onetime-services-plan.md), on the
 * owner's fixture-render review (2026-07-12, ratified Q1 — the shadow period
 * stored ZERO reports, so the review ran on golden-fixture renders of all
 * four form families instead: ops/agents/rodent-shadow-report-list.js).
 *
 * Three moves, per the graduation recipe in
 * docs/design/combined-service-completions.md:
 *  1. delivery_mode → auto_send on the 14 shadowed rodent keys
 *     (20260612000023 termite pattern).
 *  2. pest_rodent_quarterly companion entry: rodent_bait_station
 *     delivery → auto_send (read-modify-write of the jsonb array).
 *  3. rodent_monitoring (B0 CONFIRMED GAP): the legacy Square-era recurring
 *     bait key was never repointed by 20260612000001 and completes with a
 *     GENERIC recurring report — point it at the typed rodent_bait_station
 *     flow so bait customers on the legacy key get the same typed report.
 *
 * Self-healing/per-key against live state (the #1617 lesson — env catalogs
 * are admin-mutable, never assert replay-derived counts):
 *  - profile absent → loud skip; inactive → loud skip
 *  - mode/pointer mismatch → loud skip (graduation flips delivery, it never
 *    repoints — rodent_monitoring is the one deliberate repoint and has its
 *    own guard: service_report mode with a NULL/blank pointer only)
 *  - already at target → no-op
 *
 * Completed visits keep their FROZEN typedReportDelivery posture
 * (structured_notes) — graduation never retro-publishes stored shadow
 * reports; only completions after this runs deliver to customers.
 *
 * ROLLBACK FIDELITY: up() stamps [rodent_graduation_action=...] into each
 * touched row's notes and down() restores ONLY those rows, stripping the
 * marker. Companion + repoint actions carry their prior values the same way.
 */

const MARKER_RE = / ?\[rodent_graduation_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[rodent_graduation_action=${action}]`;
}

// The 14 internal_only rodent keys, verified against prod 2026-07-12
// (ops/agents/rodent-shadow-report-list.js run) with their expected typed
// pointers — graduation only flips delivery when the pointer matches.
const RODENT_TYPED_POINTERS = new Set([
  'rodent_trapping', 'rodent_exclusion', 'rodent_sanitation',
  'rodent_inspection', 'rodent_bait_station',
]);
const RODENT_KEYS = [
  'rodent_bait_quarterly',
  'rodent_bait_setup',
  'rodent_exclusion',
  'rodent_exclusion_only',
  'rodent_general_one_time',
  'rodent_inspection',
  'rodent_sanitation_heavy',
  'rodent_sanitation_light',
  'rodent_sanitation_standard',
  'rodent_trapping',
  'rodent_trapping_exclusion',
  'rodent_trapping_exclusion_sanitation',
  'rodent_trapping_followup',
  'rodent_trapping_sanitation',
];

const COMBINED_KEY = 'pest_rodent_quarterly';
const COMPANION_TYPE = 'rodent_bait_station';
const MONITORING_KEY = 'rodent_monitoring';

function parseCompanions(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) {
    console.warn('[rodent-graduation] service_completion_profiles table absent — skipping');
    return;
  }

  // 1. Standalone rodent keys: delivery flip only.
  for (const key of RODENT_KEYS) {
    const row = await knex('service_completion_profiles').where({ service_key: key }).first();
    if (!row) {
      console.warn(`[rodent-graduation] ${key}: profile row ABSENT in this environment — skipping`);
      continue;
    }
    if (!row.active) {
      console.warn(`[rodent-graduation] ${key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (row.completion_mode !== 'service_report' || !RODENT_TYPED_POINTERS.has(row.project_type)) {
      console.warn(`[rodent-graduation] ${key}: UNEXPECTED state ${row.completion_mode || '-'}/${row.project_type || '-'} — skipping (graduation only flips delivery on typed rodent profiles)`);
      continue;
    }
    if (row.delivery_mode === 'auto_send') {
      console.log(`[rodent-graduation] ${key}: already auto_send — no-op`);
      continue;
    }
    await knex('service_completion_profiles')
      .where({ service_key: key })
      .update({
        delivery_mode: 'auto_send',
        notes: withMarker(row.notes, `updated:${row.delivery_mode || '-'}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[rodent-graduation] ${key}: ${row.delivery_mode || '-'} → auto_send (prior recorded)`);
  }

  // 2. Combined-key companion: rodent_bait_station entry → auto_send.
  const combined = await knex('service_completion_profiles').where({ service_key: COMBINED_KEY }).first();
  if (!combined) {
    console.warn(`[rodent-graduation] ${COMBINED_KEY}: profile row ABSENT — companion flip skipped`);
  } else if (!combined.active) {
    console.warn(`[rodent-graduation] ${COMBINED_KEY}: profile row is INACTIVE — companion flip skipped`);
  } else {
    const companions = parseCompanions(combined.companion_types);
    const entry = Array.isArray(companions)
      ? companions.find((c) => c && c.type === COMPANION_TYPE)
      : null;
    if (!entry) {
      console.warn(`[rodent-graduation] ${COMBINED_KEY}: no ${COMPANION_TYPE} companion entry — skipping`);
    } else if (entry.delivery === 'auto_send') {
      console.log(`[rodent-graduation] ${COMBINED_KEY}: companion already auto_send — no-op`);
    } else {
      const prior = entry.delivery || '-';
      entry.delivery = 'auto_send';
      await knex('service_completion_profiles')
        .where({ service_key: COMBINED_KEY })
        .update({
          companion_types: JSON.stringify(companions),
          notes: withMarker(combined.notes, `companion:${prior}`),
          updated_at: knex.fn.now(),
        });
      console.log(`[rodent-graduation] ${COMBINED_KEY}: companion ${COMPANION_TYPE} ${prior} → auto_send (prior recorded)`);
    }
  }

  // 3. rodent_monitoring repoint: generic recurring → typed bait flow. The
  // one deliberate repoint — guard requires service_report mode with a
  // NULL/blank pointer so an admin's later manual pointer is never clobbered.
  const monitoring = await knex('service_completion_profiles').where({ service_key: MONITORING_KEY }).first();
  if (!monitoring) {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: profile row ABSENT — repoint skipped`);
  } else if (!monitoring.active) {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: profile row is INACTIVE — repoint skipped`);
  } else if (monitoring.project_type === COMPANION_TYPE) {
    console.log(`[rodent-graduation] ${MONITORING_KEY}: already points at ${COMPANION_TYPE} — no-op`);
  } else if (monitoring.completion_mode !== 'service_report' || monitoring.project_type) {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: UNEXPECTED state ${monitoring.completion_mode || '-'}/${monitoring.project_type || '-'} — skipping repoint`);
  } else {
    await knex('service_completion_profiles')
      .where({ service_key: MONITORING_KEY })
      .update({
        project_type: COMPANION_TYPE,
        delivery_mode: 'auto_send',
        notes: withMarker(monitoring.notes, `repointed:${monitoring.project_type || '-'}:${monitoring.delivery_mode || '-'}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[rodent-graduation] ${MONITORING_KEY}: repointed to ${COMPANION_TYPE}, delivery ${monitoring.delivery_mode || '-'} → auto_send (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', [...RODENT_KEYS, COMBINED_KEY, MONITORING_KEY])
    .select('service_key', 'notes', 'delivery_mode', 'companion_types', 'project_type');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[rodent_graduation_action=([^\]]*)\]/);
    if (!match) continue;
    const [action, ...priorParts] = match[1].split(':');
    const cleanNotes = String(row.notes || '').replace(MARKER_RE, '').trim() || null;

    if (action === 'updated') {
      const prior = priorParts[0] === '-' ? null : priorParts[0];
      await knex('service_completion_profiles')
        .where({ service_key: row.service_key })
        .update({ delivery_mode: prior, notes: cleanNotes, updated_at: knex.fn.now() });
      console.log(`[rodent-graduation:down] ${row.service_key}: restored delivery_mode=${prior || 'NULL'}`);
    } else if (action === 'companion') {
      const prior = priorParts[0] === '-' ? null : priorParts[0];
      const companions = parseCompanions(row.companion_types);
      const entry = Array.isArray(companions)
        ? companions.find((c) => c && c.type === COMPANION_TYPE)
        : null;
      if (entry) {
        entry.delivery = prior;
        await knex('service_completion_profiles')
          .where({ service_key: row.service_key })
          .update({ companion_types: JSON.stringify(companions), notes: cleanNotes, updated_at: knex.fn.now() });
        console.log(`[rodent-graduation:down] ${row.service_key}: companion restored delivery=${prior || 'NULL'}`);
      }
    } else if (action === 'repointed') {
      const priorType = priorParts[0] === '-' ? null : priorParts[0];
      const priorDelivery = priorParts[1] === '-' ? null : priorParts[1];
      await knex('service_completion_profiles')
        .where({ service_key: row.service_key })
        .update({
          project_type: priorType,
          delivery_mode: priorDelivery,
          notes: cleanNotes,
          updated_at: knex.fn.now(),
        });
      console.log(`[rodent-graduation:down] ${row.service_key}: repoint restored ${priorType || 'NULL'}/${priorDelivery || 'NULL'}`);
    }
  }
};
