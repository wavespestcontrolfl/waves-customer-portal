// waveguard_tier_source — provenance for the WaveGuard tier value.
//
// 'auto'   = stamped by the GATE_AUTO_WAVEGUARD_TIER machinery (booking-time
//            sync, nightly reconcile, or the --enroll-no-plan backfill) from
//            upcoming recurring coverage. ONLY these tiers are label-only:
//            eligible for automatic realignment/clearing and excluded from
//            member-only messaging gates.
// 'manual' = set by a human through the admin customer create/edit flows.
// NULL     = pre-existing/unclassified — e.g. legacy members whose billing
//            lane is also intentionally NULL (20260717000001). NEVER treated
//            as auto-derived: without provenance, automatic tier changes and
//            messaging suppression must not touch the customer (Codex #3011
//            r7 P1 — a legacy zero-rate member's tier must not be cleared by
//            the reconciler on lane ambiguity alone).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (await knex.schema.hasColumn('customers', 'waveguard_tier_source')) return;
  await knex.schema.alterTable('customers', (t) => {
    t.string('waveguard_tier_source', 20);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'waveguard_tier_source'))) return;
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('waveguard_tier_source');
  });
};
