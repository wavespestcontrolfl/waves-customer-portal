/**
 * Seed the first deterministic protocol_template — Exterior General
 * Pest Perimeter — and activate it. This is the protocol the one-tap
 * "Complete — Protocol Performed" button will attest to for routine
 * General Pest Control completions.
 *
 * Activation sequence (required by the immutability triggers from
 * migration 20260514000003):
 *   1. Insert parent row as status='draft'
 *   2. Insert child products / areas / actions (child trigger only
 *      blocks INSERT under an active or retired parent)
 *   3. UPDATE parent draft → active (the active-protect trigger only
 *      fires when OLD.status is active or retired; draft → active is
 *      the legal activation path)
 *
 * Idempotency: the unique index on (protocol_key, version) makes a
 * re-run of this migration fail at INSERT. We check up-front and skip
 * cleanly — a re-applied migration should be a no-op, not an error.
 *
 * To change the protocol later: insert a new (protocol_key='ext_gp_perim',
 * version='v2') row. Do NOT edit this seed — the immutability triggers
 * will reject it once status='active'.
 */

const PROTOCOL_KEY = 'ext_gp_perim';
const PROTOCOL_VERSION = 'v1';
const PROTOCOL_DISPLAY_NAME = 'Exterior General Pest Perimeter';
const PROTOCOL_SERVICE_TYPE = 'General Pest Control';
const PROTOCOL_SERVICE_LINE = 'pest';

// Products that compose the protocol. Looked up by exact name in
// products_catalog at migration time so the seed records real IDs.
// If any product is missing, the migration fails loudly — we'd rather
// surface the gap than seed a half-templated protocol.
const PROTOCOL_PRODUCTS = [
  { name: 'Demand CS',             sort: 1, method: 'exterior perimeter band' },
  { name: 'Alpine WSG',            sort: 2, method: 'exterior perimeter band' },
  { name: 'Advion WDG Granular',   sort: 3, method: 'granular broadcast' },
];

const PROTOCOL_AREAS = [
  { key: 'perimeter',    label: 'Perimeter',    sort: 1 },
  { key: 'garage',       label: 'Garage',       sort: 2 },
  { key: 'entry_points', label: 'Entry points', sort: 3 },
];

const PROTOCOL_ACTIONS = [
  { key: 'apply_demand_cs',          label: 'Applied insect control — Demand CS',                              required: true,  sort: 1 },
  { key: 'apply_alpine_wsg',         label: 'Applied insect control — Alpine WSG',                             required: true,  sort: 2 },
  { key: 'apply_advion_wdg',         label: 'Applied insect control — Advion WDG Granular',                    required: true,  sort: 3 },
  { key: 'webster_sweep',            label: 'Webster sweep — eaves, windows, doors, lanai frames',             required: true,  sort: 4 },
  { key: 'glue_boards_utility',      label: 'Glue boards in garage or utility areas',                          required: false, sort: 5 },
  { key: 'escalate_moisture_issues', label: 'Escalate moisture / exclusion / sanitation issues in notes',       required: false, sort: 6 },
];

const ATTESTATION_TEMPLATE = (
  'I performed the {protocol_name} protocol on this visit: '
  + '{products} applied to {areas}.'
);

const PROTOCOL_NOTES = (
  'Standard recurring General Pest Control exterior service. '
  + 'Pesticide application follows EPA label rates for each product. '
  + 'Tech attests to performing this listed protocol; specific rate '
  + 'recorded by tank calibration, not by per-row mix entry.'
);

exports.up = async function (knex) {
  const existing = await knex('protocol_templates')
    .where({ protocol_key: PROTOCOL_KEY, version: PROTOCOL_VERSION })
    .first();
  if (existing) return;

  const products = [];
  for (const p of PROTOCOL_PRODUCTS) {
    const row = await knex('products_catalog')
      .where({ name: p.name })
      .first('id', 'name');
    if (!row) {
      throw new Error(
        `Seed protocol_template "${PROTOCOL_DISPLAY_NAME}" requires product '${p.name}' which is not present in products_catalog. `
        + 'Add the product (or correct the seed name) before applying this migration.'
      );
    }
    products.push({ ...p, productId: row.id, productName: row.name });
  }

  // Step 1 — parent row as draft so children can be inserted.
  const [parent] = await knex('protocol_templates').insert({
    protocol_key: PROTOCOL_KEY,
    version: PROTOCOL_VERSION,
    display_name: PROTOCOL_DISPLAY_NAME,
    service_type: PROTOCOL_SERVICE_TYPE,
    service_line: PROTOCOL_SERVICE_LINE,
    is_deterministic: true,
    status: 'draft',
    attestation_template: ATTESTATION_TEMPLATE,
    attestation_template_version: '2026.05',
    notes: PROTOCOL_NOTES,
  }).returning('*');

  // Step 2 — children under draft parent.
  await knex('protocol_template_products').insert(products.map((p) => ({
    protocol_template_id: parent.id,
    product_id: p.productId,
    product_name_snapshot: p.productName,
    rate_basis: 'label_compliant_default',
    application_method: p.method,
    sort_order: p.sort,
  })));

  await knex('protocol_template_areas').insert(PROTOCOL_AREAS.map((a) => ({
    protocol_template_id: parent.id,
    area_key: a.key,
    area_label: a.label,
    sort_order: a.sort,
  })));

  await knex('protocol_template_actions').insert(PROTOCOL_ACTIONS.map((a) => ({
    protocol_template_id: parent.id,
    action_key: a.key,
    action_label: a.label,
    required: a.required,
    sort_order: a.sort,
  })));

  // Step 3 — activate. The active-protect trigger does NOT fire on
  // OLD.status='draft', so this transition is unprotected and legal.
  // From this UPDATE forward the row's content is frozen by the
  // immutability triggers.
  await knex('protocol_templates')
    .where({ id: parent.id })
    .update({
      status: 'active',
      effective_from: knex.fn.now(),
      activated_at: knex.fn.now(),
    });
};

exports.down = async function (knex) {
  // Once active, the row cannot be deleted by the immutability
  // trigger. The down-migration must transition active → retired
  // first (writing retired_at + retired_by), then it can stay in
  // place — retired rows are also undeletable, by design (audit
  // history is forever). So this down() is intentionally a no-op
  // that documents what would happen.
  //
  // To genuinely undo this seed during local development:
  //   1. DROP TRIGGER protocol_templates_protect_active_trg
  //      ON protocol_templates;
  //   2. DELETE FROM protocol_templates WHERE protocol_key = ...
  //   3. Re-run migration 20260514000003 to restore the trigger.
  // Not done automatically — destructive operations on audit data
  // require explicit operator intent.
  void knex;
};
