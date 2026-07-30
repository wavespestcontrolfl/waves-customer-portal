/**
 * rain_out_moved_v3: short link-first rain-out SMS.
 *
 * Owner direction (2026-07-30): the v2 body packs five clauses (weather
 * lead, better-day, reschedule link, efficacy note, forecast URL) into one
 * text — the first real send billed 8 segments. v3 moves the detail onto
 * the tokenized /reschedule page (the "moved for weather" banner shows the
 * was/now slots, forecast chips, and the why-we-move explainer) and keeps
 * the SMS to the lead, the new slot, and one link.
 *
 * Rollout mirrors the v2 pattern (20260719000010): a NEW row, so there is
 * no cross-version render hazard in either direction —
 *   - new code renders v3 only while GATE_RAINOUT_MOVE_BANNER is on;
 *   - gate off, or a rolled-back MIGRATION (v3 row absent), falls back to
 *     the untouched v2 row;
 *   - an existing-but-disabled v3 row is the ops kill switch and stops the
 *     send (same semantics the v2 row has today).
 * The v2 row is retired in a follow-up cleanup PR once this deploy + gate
 * flip are verified.
 *
 * Body is seeded verbatim (not spliced from v2): v3 is an owner-approved
 * rewrite, not a variable swap — deriving it from an admin-edited v2 body
 * could only corrupt it. Admin copy edits made to this row after seeding
 * are preserved (nothing rewrites it).
 */

const TEMPLATE_KEY = 'rain_out_moved_v3';

const BODY = 'Hi {first_name} — {weather_lead}, so we moved your {service_type} to {new_option}.{link_clause}\n\nQuestions? Reply here. Reply STOP to opt out.';

const VARIABLES = ['first_name', 'weather_lead', 'service_type', 'new_option', 'link_clause'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) return;

  const v2 = await knex('sms_templates').where({ template_key: 'rain_out_moved_v2' }).first('sort_order');

  await knex('sms_templates').insert({
    template_key: TEMPLATE_KEY,
    name: 'Rain Out - Appointment Moved (Short + Link)',
    category: 'service',
    body: BODY,
    variables: JSON.stringify(VARIABLES),
    sort_order: (v2?.sort_order ?? 10) + 1,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
};
