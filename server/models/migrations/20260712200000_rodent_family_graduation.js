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
 *  - mode/pointer mismatch vs the PER-KEY expected pointer → loud skip
 *    (graduation flips delivery, it never repoints or accepts a drifted
 *    form — rodent_monitoring is the one deliberate repoint, own guards)
 *  - delivery anything other than the reviewed internal_only (notably the
 *    'disabled' kill switch) → loud skip; kill switches stay fail-closed
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

// The 14 internal_only rodent keys with their PER-KEY expected typed
// pointers (Codex P2 — a family-wide set would graduate a drifted row onto
// the wrong customer-facing form; the 20260612000012 map is the source of
// truth, verified against prod 2026-07-12). Graduation only flips delivery
// when the pointer matches its key exactly.
const RODENT_KEYS = [
  { key: 'rodent_bait_quarterly', pointer: 'rodent_bait_station' },
  { key: 'rodent_bait_setup', pointer: 'rodent_bait_station' },
  { key: 'rodent_exclusion', pointer: 'rodent_exclusion' },
  { key: 'rodent_exclusion_only', pointer: 'rodent_exclusion' },
  { key: 'rodent_general_one_time', pointer: 'rodent_inspection' },
  { key: 'rodent_inspection', pointer: 'rodent_inspection' },
  { key: 'rodent_sanitation_heavy', pointer: 'rodent_sanitation' },
  { key: 'rodent_sanitation_light', pointer: 'rodent_sanitation' },
  { key: 'rodent_sanitation_standard', pointer: 'rodent_sanitation' },
  { key: 'rodent_trapping', pointer: 'rodent_trapping' },
  { key: 'rodent_trapping_exclusion', pointer: 'rodent_trapping' },
  { key: 'rodent_trapping_exclusion_sanitation', pointer: 'rodent_trapping' },
  { key: 'rodent_trapping_followup', pointer: 'rodent_trapping' },
  { key: 'rodent_trapping_sanitation', pointer: 'rodent_trapping' },
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

  // 1. Standalone rodent keys: delivery flip only. Graduation ONLY lifts
  // the reviewed internal_only shadow — any other delivery (notably the
  // 'disabled' per-profile kill switch, Codex P1) is a deliberate posture
  // this migration must never re-enable.
  for (const target of RODENT_KEYS) {
    const { key } = target;
    const row = await knex('service_completion_profiles').where({ service_key: key }).first();
    if (!row) {
      console.warn(`[rodent-graduation] ${key}: profile row ABSENT in this environment — skipping`);
      continue;
    }
    if (!row.active) {
      console.warn(`[rodent-graduation] ${key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (row.completion_mode !== 'service_report' || row.project_type !== target.pointer) {
      console.warn(`[rodent-graduation] ${key}: UNEXPECTED state ${row.completion_mode || '-'}/${row.project_type || '-'} (expected service_report/${target.pointer}) — skipping (graduation never flips a drifted pointer)`);
      continue;
    }
    if (row.delivery_mode === 'auto_send') {
      console.log(`[rodent-graduation] ${key}: already auto_send — no-op`);
      continue;
    }
    if (row.delivery_mode !== 'internal_only') {
      console.warn(`[rodent-graduation] ${key}: delivery_mode='${row.delivery_mode || 'NULL'}' is not the reviewed internal_only shadow — skipping (kill switches stay fail-closed)`);
      continue;
    }
    await knex('service_completion_profiles')
      .where({ service_key: key })
      .update({
        delivery_mode: 'auto_send',
        notes: withMarker(row.notes, `updated:${row.delivery_mode}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[rodent-graduation] ${key}: internal_only → auto_send (prior recorded)`);
  }

  // 2. Combined-key companion: rodent_bait_station entry → auto_send. Only
  // on the validated primary topology (recurring generic service_report,
  // Codex P2) and only from the reviewed internal_only posture (Codex P1 —
  // a 'disabled' companion kill switch stays fail-closed).
  const combined = await knex('service_completion_profiles').where({ service_key: COMBINED_KEY }).first();
  if (!combined) {
    console.warn(`[rodent-graduation] ${COMBINED_KEY}: profile row ABSENT — companion flip skipped`);
  } else if (!combined.active) {
    console.warn(`[rodent-graduation] ${COMBINED_KEY}: profile row is INACTIVE — companion flip skipped`);
  } else if (combined.completion_mode !== 'service_report' || combined.project_type) {
    console.warn(`[rodent-graduation] ${COMBINED_KEY}: UNEXPECTED primary state ${combined.completion_mode || '-'}/${combined.project_type || '-'} (expected service_report/NULL) — companion flip skipped`);
  } else {
    const companions = parseCompanions(combined.companion_types);
    const entry = Array.isArray(companions)
      ? companions.find((c) => c && c.type === COMPANION_TYPE)
      : null;
    if (!entry) {
      console.warn(`[rodent-graduation] ${COMBINED_KEY}: no ${COMPANION_TYPE} companion entry — skipping`);
    } else if (entry.delivery === 'auto_send') {
      console.log(`[rodent-graduation] ${COMBINED_KEY}: companion already auto_send — no-op`);
    } else if (entry.delivery !== 'internal_only') {
      console.warn(`[rodent-graduation] ${COMBINED_KEY}: companion delivery='${entry.delivery || 'NULL'}' is not the reviewed internal_only shadow — skipping (kill switches stay fail-closed)`);
    } else {
      entry.delivery = 'auto_send';
      await knex('service_completion_profiles')
        .where({ service_key: COMBINED_KEY })
        .update({
          companion_types: JSON.stringify(companions),
          notes: withMarker(combined.notes, 'companion:internal_only'),
          updated_at: knex.fn.now(),
        });
      console.log(`[rodent-graduation] ${COMBINED_KEY}: companion ${COMPANION_TYPE} internal_only → auto_send (prior recorded)`);
    }
  }

  // 3. rodent_monitoring repoint: generic recurring → typed bait flow. The
  // one deliberate repoint. Codex round-1 hardening: the already-target
  // shortcut requires service_report mode AND auto_send (a pre-repointed row
  // still in shadow gets its delivery graduated); 'disabled' stays
  // fail-closed everywhere; drifted mode/pointer states loud-skip.
  const monitoring = await knex('service_completion_profiles').where({ service_key: MONITORING_KEY }).first();
  const GRADUATABLE_DELIVERIES = ['auto_send', 'internal_only'];
  if (!monitoring) {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: profile row ABSENT — repoint skipped`);
  } else if (!monitoring.active) {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: profile row is INACTIVE — repoint skipped`);
  } else if (monitoring.completion_mode !== 'service_report') {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: UNEXPECTED completion_mode='${monitoring.completion_mode || 'NULL'}' — skipping (repoint only applies to the generic service_report profile)`);
  } else if (monitoring.project_type && monitoring.project_type !== COMPANION_TYPE) {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: UNEXPECTED pointer '${monitoring.project_type}' — skipping (never clobbers a manual repoint)`);
  } else if (!GRADUATABLE_DELIVERIES.includes(monitoring.delivery_mode)) {
    console.warn(`[rodent-graduation] ${MONITORING_KEY}: delivery_mode='${monitoring.delivery_mode || 'NULL'}' — skipping (kill switches stay fail-closed)`);
  } else if (monitoring.project_type === COMPANION_TYPE && monitoring.delivery_mode === 'auto_send') {
    console.log(`[rodent-graduation] ${MONITORING_KEY}: already at ${COMPANION_TYPE}/auto_send — no-op`);
  } else {
    // Covers both: fresh repoint (pointer NULL) and delivery graduation of
    // an already-repointed row still in internal_only shadow.
    await knex('service_completion_profiles')
      .where({ service_key: MONITORING_KEY })
      .update({
        project_type: COMPANION_TYPE,
        delivery_mode: 'auto_send',
        notes: withMarker(monitoring.notes, `repointed:${monitoring.project_type || '-'}:${monitoring.delivery_mode || '-'}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[rodent-graduation] ${MONITORING_KEY}: ${monitoring.project_type || 'NULL'}/${monitoring.delivery_mode || 'NULL'} → ${COMPANION_TYPE}/auto_send (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', [...RODENT_KEYS.map((t) => t.key), COMBINED_KEY, MONITORING_KEY])
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
