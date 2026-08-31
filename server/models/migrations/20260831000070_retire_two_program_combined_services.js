/**
 * Retire the two TRUE two-program combined catalog rows — the flip-time
 * data pass for GATE_SEPARATE_COMBO_VISITS (#3655, converter routes retired
 * 2026-08-31; gate flipped by the owner the same day):
 *
 *   - pest_termite_bait_quarterly  "Quarterly Pest + Termite Bait Station Service"
 *   - lawn_tree_shrub_combo        "Lawn + Tree & Shrub Service"
 *
 * Same shape as 20260712600000 (pest_rodent_quarterly retirement), with the
 * prior flags recorded in a notes marker so down() restores exactly what
 * up() changed:
 *   1. services row: is_active=false, is_archived=true, customer_visible=false,
 *      booking_enabled=false, groupable=false. The ROW stays — history keeps
 *      resolving by service_id, and residual combined visits (the six live
 *      ones are handled by their own data migrations) still render.
 *   2. service_completion_profiles row: active=false — a residual combined
 *      visit falls to the standard recurring report, the documented posture
 *      for a retired combined key.
 *
 * Deliberately AFTER the gate (not in the dark-ship PR): archiving while the
 * converter could still produce combined rows would have broken the
 * gate-off rollback contract. Kill switch for the whole retirement is still
 * the gate (unset) plus this migration's down().
 */

const KEYS = ['pest_termite_bait_quarterly', 'lawn_tree_shrub_combo'];
const MARKER_RE = / ?\[two_program_retire=[^\]]*\]/;

function withMarker(notes, payload) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[two_program_retire=${payload}]`;
}

function readMarker(notes) {
  const m = String(notes || '').match(/\[two_program_retire=([^\]]*)\]/);
  return m ? m[1] : null;
}

function stripMarker(notes) {
  const out = String(notes || '').replace(MARKER_RE, '').trim();
  return out || null;
}

const FLAGS = ['is_active', 'is_archived', 'customer_visible', 'booking_enabled', 'groupable'];
const FLAG_CODES = ['a', 'r', 'v', 'b', 'g'];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('services')) {
    const present = [];
    for (const col of FLAGS) present.push(await knex.schema.hasColumn('services', col));
    for (const key of KEYS) {
      const svc = await knex('services').where({ service_key: key }).first();
      if (!svc) continue;
      if (readMarker(svc.internal_notes) != null) continue; // already retired by us
      const prior = FLAGS.map((col, i) => (present[i] && svc[col] ? FLAG_CODES[i] : '-')).join('');
      const patch = { internal_notes: withMarker(svc.internal_notes, prior), updated_at: knex.fn.now() };
      if (present[0]) patch.is_active = false;
      if (present[1]) patch.is_archived = true;
      if (present[2]) patch.customer_visible = false;
      if (present[3]) patch.booking_enabled = false;
      if (present[4]) patch.groupable = false;
      await knex('services').where({ service_key: key }).update(patch);
    }
  }

  if (await knex.schema.hasTable('service_completion_profiles')) {
    for (const key of KEYS) {
      const profile = await knex('service_completion_profiles').where({ service_key: key }).first();
      if (!profile || !profile.active) continue;
      await knex('service_completion_profiles').where({ service_key: key }).update({
        active: false,
        notes: withMarker(profile.notes, 'deactivated'),
        updated_at: knex.fn.now(),
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('services')) {
    const present = [];
    for (const col of FLAGS) present.push(await knex.schema.hasColumn('services', col));
    for (const key of KEYS) {
      const svc = await knex('services').where({ service_key: key }).first();
      const prior = svc && readMarker(svc.internal_notes);
      if (!prior) continue; // not ours (or an admin cleared the marker) — leave it
      const patch = { internal_notes: stripMarker(svc.internal_notes), updated_at: knex.fn.now() };
      FLAGS.forEach((col, i) => { if (present[i]) patch[col] = prior[i] === FLAG_CODES[i]; });
      await knex('services').where({ service_key: key }).update(patch);
    }
  }

  if (await knex.schema.hasTable('service_completion_profiles')) {
    for (const key of KEYS) {
      const profile = await knex('service_completion_profiles').where({ service_key: key }).first();
      if (!profile || readMarker(profile.notes) !== 'deactivated') continue;
      await knex('service_completion_profiles').where({ service_key: key }).update({
        active: true,
        notes: stripMarker(profile.notes),
        updated_at: knex.fn.now(),
      });
    }
  }
};

exports.KEYS = KEYS;
