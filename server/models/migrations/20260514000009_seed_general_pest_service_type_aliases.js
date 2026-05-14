/**
 * Seed routine General Pest Control service_type aliases for the
 * Exterior General Pest Perimeter protocol_template.
 *
 * The original seed in 20260514000007 only registered the canonical
 * 'General Pest Control' string. Real admin-created jobs use a wider
 * set of variant labels — quarterly / bi-monthly / monthly cadence
 * suffixes, legacy "Recurring Pest Control" strings, the bare "Pest
 * Control Service" service-library entry. Without aliases, the
 * resolver returned no_active_protocol_template for the majority of
 * routine pest visits and the one-tap button would never appear.
 *
 * Aliases are routing rules, not audit data, so this migration is
 * safe to run even though the parent protocol_template is already
 * status='active' (see 20260514000008 header for why the alias table
 * doesn't inherit the child immutability trigger).
 *
 * Idempotent — uses ON CONFLICT DO NOTHING on the
 * (protocol_template_id, service_type) unique index.
 */

const PROTOCOL_KEY = 'ext_gp_perim';
const PROTOCOL_VERSION = 'v1';

// Canonical strings the resolver should treat as routine exterior
// General Pest Control. Three naming conventions coexist in the
// codebase (booking flow / service library / legacy customer rows),
// so the alias list covers all three:
//
//   "General Pest Control (cadence)" — admin / service-library form
//   "cadence Pest Control Service"   — current scheduler/booking labels
//   bare "cadence Pest Control"       — legacy form on long-tenured customers
//
// Future PRs can extend this list (or seed a new template version
// with broader/narrower coverage).
//
// Intentionally EXCLUDED:
//   'General Pest Control + Lawn Care'      — combo service, different protocol
//   'Quarterly Pest Control — Residential'  — marketing label, not scheduler form
const SERVICE_TYPE_ALIASES = [
  // "General Pest Control (cadence)" form
  'General Pest Control',
  'General Pest Control (Initial)',
  'General Pest Control (Monthly)',
  'General Pest Control (Bi-Monthly)',
  'General Pest Control (Quarterly)',
  'General Pest Control (Semiannual)',
  // "cadence Pest Control Service" form (current scheduler)
  'Pest Control Service',
  'Monthly Pest Control Service',
  'Bi-Monthly Pest Control Service',
  'Quarterly Pest Control Service',
  // Bare cadence + Pest Control (legacy)
  'Monthly Pest Control',
  'Bi-Monthly Pest Control',
  'Quarterly Pest Control',
  'Recurring Pest Control',
];

exports.up = async function (knex) {
  const template = await knex('protocol_templates')
    .where({ protocol_key: PROTOCOL_KEY, version: PROTOCOL_VERSION })
    .first('id');
  if (!template) {
    // Seed migration 20260514000007 should have inserted this. If it
    // didn't, fail loudly — running this migration without the parent
    // would leave orphan alias rows.
    throw new Error(
      `Cannot seed service_type aliases: protocol_template (${PROTOCOL_KEY}, ${PROTOCOL_VERSION}) is missing. `
      + 'Ensure migration 20260514000007_seed_exterior_general_pest_perimeter ran first.'
    );
  }

  for (const serviceType of SERVICE_TYPE_ALIASES) {
    await knex.raw(
      `INSERT INTO protocol_template_service_types (protocol_template_id, service_type)
       VALUES (?, ?)
       ON CONFLICT (protocol_template_id, service_type) DO NOTHING`,
      [template.id, serviceType]
    );
  }
};

exports.down = async function (knex) {
  const template = await knex('protocol_templates')
    .where({ protocol_key: PROTOCOL_KEY, version: PROTOCOL_VERSION })
    .first('id');
  if (!template) return;
  await knex('protocol_template_service_types')
    .where({ protocol_template_id: template.id })
    .whereIn('service_type', SERVICE_TYPE_ALIASES)
    .del();
};
