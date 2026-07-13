/**
 * Retire the "Pest & Rodent Control" combined service (owner decision
 * 2026-07-12): rodent bait stations ride their own standalone
 * "Quarterly Rodent Bait Station Service" visit instead of combining into
 * the pest visit. The estimate converter's pest+rodent combined route is
 * removed in the same PR (STANDALONE_SUPPLEMENT_ROUTES takes over
 * scheduling sold bait lines).
 *
 * Two moves, both self-healed with marker rollback:
 *  1. services.pest_rodent_quarterly — the row was already
 *     archived/inactive but still customer_visible + booking_enabled
 *     (contradictory flags); clear both so nothing can book it.
 *  2. service_completion_profiles.pest_rodent_quarterly — active=false so
 *     the runtime stops resolving the combined profile (any residual
 *     visit named "Pest & Rodent Control Service" falls to the standard
 *     recurring report, which is the correct posture for a retired
 *     combined key). Historical completed visits are untouched.
 *
 * The 3 historical completed visits (2025-10 – 2026-01) and their
 * customers keep their rows/history as-is; re-booking those customers on
 * standalone services is an owner scheduling action, not a migration.
 */

const KEY = 'pest_rodent_quarterly';
const MARKER_RE = / ?\[pest_rodent_retire_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[pest_rodent_retire_action=${action}]`;
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('services')) {
    const svc = await knex('services').where({ service_key: KEY }).first();
    if (!svc) {
      console.warn(`[pest-rodent-retire] services.${KEY} ABSENT — skipping catalog flags`);
    } else if (!svc.customer_visible && !svc.booking_enabled) {
      console.log(`[pest-rodent-retire] services.${KEY} already hidden/unbookable — no-op`);
    } else {
      await knex('services')
        .where({ service_key: KEY })
        .update({
          customer_visible: false,
          booking_enabled: false,
          internal_notes: withMarker(svc.internal_notes, `flags:${svc.customer_visible ? 'v' : '-'}${svc.booking_enabled ? 'b' : '-'}`),
          updated_at: knex.fn.now(),
        });
      console.log(`[pest-rodent-retire] services.${KEY}: customer_visible/booking_enabled cleared (prior recorded)`);
    }
  }

  if (await knex.schema.hasTable('service_completion_profiles')) {
    const profile = await knex('service_completion_profiles').where({ service_key: KEY }).first();
    if (!profile) {
      console.warn(`[pest-rodent-retire] profile ${KEY} ABSENT — skipping`);
    } else if (!profile.active) {
      console.log(`[pest-rodent-retire] profile ${KEY} already inactive — no-op`);
    } else {
      await knex('service_completion_profiles')
        .where({ service_key: KEY })
        .update({
          active: false,
          notes: withMarker(profile.notes, 'deactivated'),
          updated_at: knex.fn.now(),
        });
      console.log(`[pest-rodent-retire] profile ${KEY}: active → false (prior recorded)`);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('services')) {
    const svc = await knex('services').where({ service_key: KEY }).first();
    const match = String(svc?.internal_notes || '').match(/\[pest_rodent_retire_action=flags:(.)(.)\]/);
    if (match) {
      await knex('services')
        .where({ service_key: KEY })
        .update({
          customer_visible: match[1] === 'v',
          booking_enabled: match[2] === 'b',
          internal_notes: String(svc.internal_notes || '').replace(MARKER_RE, '').trim() || null,
          updated_at: knex.fn.now(),
        });
      console.log(`[pest-rodent-retire:down] services.${KEY} flags restored`);
    }
  }
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const profile = await knex('service_completion_profiles').where({ service_key: KEY }).first();
    if (profile && / ?\[pest_rodent_retire_action=deactivated\]/.test(String(profile.notes || ''))) {
      await knex('service_completion_profiles')
        .where({ service_key: KEY })
        .update({
          active: true,
          notes: String(profile.notes || '').replace(MARKER_RE, '').trim() || null,
          updated_at: knex.fn.now(),
        });
      console.log(`[pest-rodent-retire:down] profile ${KEY} reactivated`);
    }
  }
};
