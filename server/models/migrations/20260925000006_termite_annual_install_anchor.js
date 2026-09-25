/**
 * Termite annual plan — installation anchor + durable scheduling handoff
 * (Codex round 4 on #4819). 20260925000001..000005 are frozen (pushed; the
 * preview DB has already run them) and are never edited — this is a NEW
 * additive migration.
 *
 * annual_prepay_terms.installation_anchored_at (timestamptz) +
 * annual_prepay_terms.installation_anchor_visit_id (uuid) — the signed
 * agreement says coverage starts at installation, but activation books no
 * visit, so the term is minted with a provisional start on the signature
 * day. Once the termite installation visit is COMPLETED,
 * termite-annual-activation.js's reconciliation re-anchors the original
 * (never-renewed) term to that visit's date + 12 months exactly once and
 * stamps these two columns — the idempotency marker and the audit of which
 * visit anchored it. Null on every other term (the table is shared across
 * every annual-prepay program).
 *
 * estimates.annual_plan_install_handoff_at (timestamptz) — the staff bell
 * asking for the station installation to be booked is the ONLY scheduling
 * handoff after signature. It is stamped only once notifyAdmin durably
 * records that bell; an activated estimate without it is re-belled by the
 * daily reconciliation until it lands. Null on every other estimate.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates either table.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'installation_anchored_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('installation_anchored_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'installation_anchor_visit_id'))) {
      const hasVisits = await knex.schema.hasTable('scheduled_services');
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        const col = t.uuid('installation_anchor_visit_id');
        if (hasVisits) col.references('id').inTable('scheduled_services').onDelete('SET NULL');
      });
    }
  }
  if (await knex.schema.hasTable('estimates')) {
    if (!(await knex.schema.hasColumn('estimates', 'annual_plan_install_handoff_at'))) {
      await knex.schema.alterTable('estimates', (t) => {
        t.timestamp('annual_plan_install_handoff_at', { useTz: true });
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (await knex.schema.hasColumn('estimates', 'annual_plan_install_handoff_at')) {
      await knex.schema.alterTable('estimates', (t) => {
        t.dropColumn('annual_plan_install_handoff_at');
      });
    }
  }
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    for (const column of ['installation_anchor_visit_id', 'installation_anchored_at']) {
      if (await knex.schema.hasColumn('annual_prepay_terms', column)) {
        await knex.schema.alterTable('annual_prepay_terms', (t) => {
          t.dropColumn(column);
        });
      }
    }
  }
};
