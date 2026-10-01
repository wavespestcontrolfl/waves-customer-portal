/**
 * purchase_receipt_lines — the inventory agent (GATE_INVENTORY_AGENT,
 * services/purchase-receipts/inventory-agent.js). 20260926000200..000500 are
 * pushed and frozen, so the status CHECK is extended again here, exactly as
 * each of those did.
 *
 * New statuses (a line the deterministic classifier held as 'unmatched',
 * 'needs_size' or 'size_mismatch' is handed to the agent instead, see
 * receipt-processor.js):
 *   - agent_pending    handed off to the agent; not yet decided (no bell,
 *                       no movement — this is the queue the agent works)
 *   - agent_ignored     the agent read it as a personal purchase, not stock
 *   - agent_equipment   the agent read it as equipment, not consumable stock
 *   - agent_unsure      the agent couldn't resolve it (or a proposal failed
 *                       deterministic validation) — held for a person
 * A line the agent resolves cleanly is written back as 'logged', same as
 * the deterministic lane.
 *
 * New columns (see inventory-agent.js for how they're written):
 *   - agent_attempts          failed LLM calls so far; the 3rd hands the
 *                             line to a person instead of retrying forever
 *   - agent_decision          the validated decision the agent applied (or
 *                             the reason it didn't), plus provenance —
 *                             products_catalog has no per-row "agent
 *                             created this" column, so that provenance lives
 *                             here instead
 *   - agent_decided_at        when agent_decision was written
 *   - agent_created_product_id  set when the agent created a NEW catalog
 *                             row for this line (FK products_catalog, so a
 *                             deleted product doesn't orphan the line)
 *   - agent_created_alias_id  set when the agent added a product_aliases
 *                             row for this line's exact raw_title (plain
 *                             uuid: product_aliases carries no FK-worthy
 *                             lifecycle of its own here, and the undo CLI
 *                             looks it up by id to delete it, not join it)
 */
const WITH_STATUSES = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'no_order_number', "
  + "'no_delivery_email', 'returned', 'unverified', 'unreadable', 'agent_pending', 'agent_ignored', 'agent_equipment', 'agent_unsure', 'skipped')";
const WITHOUT_STATUSES = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'no_order_number', "
  + "'no_delivery_email', 'returned', 'unverified', 'unreadable', 'skipped')";

async function replaceStatusCheck(knex, allowed) {
  await knex.raw('ALTER TABLE purchase_receipt_lines DROP CONSTRAINT IF EXISTS purchase_receipt_lines_status_check');
  await knex.raw(`ALTER TABLE purchase_receipt_lines ADD CONSTRAINT purchase_receipt_lines_status_check CHECK (status IN ${allowed})`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITH_STATUSES);
  await knex.schema.alterTable('purchase_receipt_lines', (t) => {
    t.integer('agent_attempts').notNullable().defaultTo(0);
    t.jsonb('agent_decision').nullable();
    t.timestamp('agent_decided_at', { useTz: true }).nullable();
    t.uuid('agent_created_product_id').nullable().references('id').inTable('products_catalog').onDelete('SET NULL');
    t.uuid('agent_created_alias_id').nullable();
  });
};

// Blocked while any row still carries one of the new statuses — resolve
// those first (the CHECK's own data validation is what enforces this; see
// 20260926000300 and onward for the same convention).
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await knex.schema.alterTable('purchase_receipt_lines', (t) => {
    t.dropColumn('agent_created_alias_id');
    t.dropColumn('agent_created_product_id');
    t.dropColumn('agent_decided_at');
    t.dropColumn('agent_decision');
    t.dropColumn('agent_attempts');
  });
  await replaceStatusCheck(knex, WITHOUT_STATUSES);
};
