/**
 * #3140 residue — align HISTORICAL per-customer MRR snapshots with the
 * corrected monthly-lane population.
 *
 * customer_mrr_snapshots was captured with the raw `monthly_rate > 0`
 * shortcut, so closed months contain per-visit / annual-prepay /
 * per-application rows that were never in the dues lane. The live capture
 * (mrr-snapshot.js customerRateRows) now scopes to MONTHLY_LANE_SQL, and
 * its current-month prune removes those rows on the next refresh — but a
 * CLOSED month keeps its final population, so without this backfill the Net
 * MRR bridge (mrr-bridge.js buildBridgeMonths) would diff a wide prior
 * month against a narrow current month and report every removed residue row
 * as a one-time surge of churned MRR at deploy (Codex #3669 r3 P0).
 *
 * Lane test is the customer's CURRENT lane — the same current-state
 * approximation the live fallbacks document (snapshots don't store
 * billing_mode, so month-of-capture lane is unknowable). A customer who
 * genuinely paid dues in a past month but has since moved to prepay loses
 * those rows from BOTH sides of every diff, which biases nothing.
 *
 * The predicate is MONTHLY_LANE_SQL (services/billing-lane.js) inlined with
 * qualified columns — deliberately frozen here rather than imported, per the
 * never-edit-a-run-migration rule: this is a point-in-time correction, and a
 * later lane-definition change ships its own backfill.
 *
 * down() is a documented no-op: the removed rows are point-in-time captures
 * that cannot be reconstructed, and under the corrected definition they
 * should never have been captured.
 */

const MONTHLY_LANE_SQL_QUALIFIED = `
  (c.billing_mode = 'monthly_membership' OR (
    c.billing_mode IS NULL
    AND regexp_replace(lower(coalesce(c.waveguard_tier, '')), '[^a-z0-9]+', '', 'g') <> ''
    AND regexp_replace(lower(coalesce(c.waveguard_tier, '')), '[^a-z0-9]+', '', 'g')
      NOT IN ('none', 'onetime', 'na', 'no', 'notset', 'commercial')
  ))`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_mrr_snapshots'))) return;
  const removed = await knex('customer_mrr_snapshots')
    .whereNotExists(function notMonthlyLane() {
      this.select(knex.raw('1'))
        .from('customers as c')
        .whereRaw('c.id = customer_mrr_snapshots.customer_id')
        .whereRaw(MONTHLY_LANE_SQL_QUALIFIED);
    })
    .del();
   
  console.log(`[migration] customer_mrr_snapshots: removed ${removed} non-monthly-lane row(s)`);
};

exports.down = async function down() {
  // No-op by design: removing point-in-time snapshot rows is irreversible,
  // and the rows were an artifact of the pre-#3140 lane shortcut.
};
