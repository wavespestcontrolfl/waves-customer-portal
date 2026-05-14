/**
 * protocol_template_service_types — many-to-one alias mapping from
 * scheduled_services.service_type strings to a protocol_template.
 *
 * Real-world routine pest jobs use a variety of service_type labels
 * — 'General Pest Control', 'General Pest Control (Quarterly)',
 * '(Bi-Monthly)', '(Monthly)', 'Quarterly Pest Control', 'Recurring
 * Pest Control', etc. The original seed pinned the template to a
 * single string, so the resolver returned no_active_protocol_template
 * for every variant. This alias table lets one deterministic
 * protocol_template cover the full set of canonical strings that
 * mean "routine exterior General Pest Control."
 *
 * Mutability — different from products/areas/actions:
 *   Unlike the other protocol_template_* child tables, aliases are
 *   MUTABLE under an active parent. Aliases are routing rules, not
 *   audit data — they decide which template a visit uses, but they
 *   do not change what that template's tech_attestation_text said
 *   on past completions. The audit record on service_records keys
 *   off (protocol_template_id, protocol_template_version) directly,
 *   not via the alias chain. So adding/removing aliases on the fly
 *   only changes future routing, never past attestations.
 *
 *   This is deliberate: operators need to extend coverage to new
 *   service_type strings (new product lines, market expansion,
 *   admin-created custom labels) without the friction of a
 *   retire-and-supersede dance.
 *
 * Uniqueness:
 *   (protocol_template_id, service_type) — the same string never
 *   maps twice to the same template. Globally non-unique on
 *   service_type alone: an operator error could create two active
 *   templates with overlapping aliases. The resolver's read query
 *   (status='active' LIMIT 1, ordered by activated_at DESC) picks
 *   the newest active and the duplicate becomes inert. A future PR
 *   may add a soft warning on insert if a collision is detected.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('protocol_template_service_types', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('protocol_template_id').notNullable()
      .references('id').inTable('protocol_templates').onDelete('CASCADE');
    t.string('service_type', 200).notNullable();
    t.text('notes');
    t.timestamps(true, true);

    t.unique(['protocol_template_id', 'service_type']);
    t.index('service_type', 'protocol_template_service_types_service_type_idx');
  });

  // NOTE: protocol_template_child_protect trigger is intentionally
  // NOT attached here. See the file header for rationale.
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('protocol_template_service_types');
};
