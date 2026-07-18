/**
 * Migration — Tree & Shrub Light (4x) catalog service + typed completion profile
 *
 * T&S audit 2026-07-18 P2: the estimate accept path stamps the Light (4x)
 * downsell tier as service_key `tree_shrub_quarterly` / "Quarterly Tree &
 * Shrub Care Service" (estimate-public.js treeShrubTierRuntimeMeta), but no
 * catalog row or completion profile exists for that key — a sold Light
 * program completes on the DEFAULT generic report profile instead of the
 * owner-authored typed tree_shrub flow, and no assessment/V2 report is
 * produced.
 *
 * Seeds the services row and the typed completion profile, mirroring the
 * live `tree_shrub_program` (6x Standard) rows field-for-field except
 * cadence (quarterly / 4 visits). Shapes verified against the prod rows
 * read-only on 2026-07-18 — not the migration files.
 *
 * Catalogs are admin-mutable (self-healed 20260611000012/16 pattern):
 * insert when absent, heal a profile missing its typed pointer, loud-skip
 * anything an admin has deactivated. ROLLBACK FIDELITY: rows this migration
 * inserts carry a marker; down() removes ONLY marked rows and strips ONLY
 * the marker from healed ones.
 */

const SERVICE_KEY = 'tree_shrub_quarterly';
const SERVICE_NAME = 'Quarterly Tree & Shrub Care Service';
const SERVICE_MARKER = '[tree_shrub_quarterly_seed=inserted]';
const PROFILE_MARKER_RE = / ?\[tree_shrub_quarterly_seed=[^\]]*\]/;

function withProfileMarker(notes, action) {
  const base = String(notes || '').replace(PROFILE_MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[tree_shrub_quarterly_seed=${action}]`;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  const existing = await knex('services').where({ service_key: SERVICE_KEY }).first();
  if (!existing) {
    await knex('services').insert({
      service_key: SERVICE_KEY,
      name: SERVICE_NAME,
      short_name: 'Tree & Shrub (Light)',
      description: 'Quarterly fertilization, insect control, and disease management for ornamental trees and shrubs — the Light tier for clean, low-pressure landscapes.',
      internal_notes: SERVICE_MARKER,
      category: 'tree_shrub',
      billing_type: 'recurring',
      is_waveguard: true,
      default_duration_minutes: 60,
      min_duration_minutes: 30,
      max_duration_minutes: 75,
      frequency: 'quarterly',
      visits_per_year: 4,
      pricing_type: 'variable',
      pricing_model_key: 'bed_sqft',
      is_taxable: false,
      tax_service_key: 'lawn_care',
      requires_license: true,
      license_category: 'L&O',
      customer_visible: true,
      booking_enabled: true,
      sort_order: 51,
      icon: '🌳',
      color: '#059669',
      is_active: true,
      requires_service_report: true,
      requires_application_log: true,
      required_photo_count: 2,
      requires_customer_notice: true,
      closeout_requirements_source: 'inferred_v1',
    });
  } else if (existing.is_active === false || existing.is_archived === true) {
    console.warn(`[tree-shrub-quarterly] services row for ${SERVICE_KEY} exists but is inactive/archived — leaving it alone (admin decision)`);
  }

  if (!(await knex.schema.hasTable('service_completion_profiles'))) {
    console.warn('[tree-shrub-quarterly] service_completion_profiles table missing — profile not seeded');
    return;
  }
  const profile = await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).first();
  if (!profile) {
    await knex('service_completion_profiles').insert({
      service_key: SERVICE_KEY,
      service_name_snapshot: SERVICE_NAME,
      category: 'tree_shrub',
      billing_type: 'recurring',
      completion_mode: 'service_report',
      project_type: 'tree_shrub',
      delivery_mode: 'auto_send',
      creates_service_record: true,
      portal_visibility: 'customer_portal',
      portal_attach_policy: 'active_portal_customer',
      followup_policy: 'none',
      active: true,
      notes: withProfileMarker('Light (4x) tier uses the same typed tree & shrub completion/report flow as the 6x Standard program.', 'inserted'),
    });
  } else if (!profile.active) {
    console.warn(`[tree-shrub-quarterly] profile for ${SERVICE_KEY} is INACTIVE — skipping (runtime ignores inactive rows)`);
  } else if (!profile.project_type) {
    // Heal: an existing untyped profile gets the typed pointer only — every
    // other field is admin-owned. Marker records what up() changed so down()
    // can restore exactly that.
    await knex('service_completion_profiles')
      .where({ service_key: SERVICE_KEY })
      .update({
        project_type: 'tree_shrub',
        notes: withProfileMarker(profile.notes, `healed:${profile.project_type || '-'}`),
        updated_at: knex.fn.now(),
      });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const profile = await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).first();
    if (profile) {
      const marker = String(profile.notes || '').match(/\[tree_shrub_quarterly_seed=([^\]]*)\]/);
      if (marker && marker[1] === 'inserted') {
        await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).del();
      } else if (marker && marker[1].startsWith('healed:')) {
        const prior = marker[1].slice('healed:'.length);
        await knex('service_completion_profiles')
          .where({ service_key: SERVICE_KEY })
          .update({
            project_type: prior === '-' ? null : prior,
            notes: String(profile.notes || '').replace(PROFILE_MARKER_RE, '').trim() || null,
            updated_at: knex.fn.now(),
          });
      }
    }
  }
  if (await knex.schema.hasTable('services')) {
    await knex('services')
      .where({ service_key: SERVICE_KEY })
      .where('internal_notes', 'like', `%${SERVICE_MARKER}%`)
      .del();
  }
};
