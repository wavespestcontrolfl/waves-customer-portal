// Supersedes 20260924020000_tree_shrub_retire_quarterly.js (already pushed
// and FROZEN — the pre-push migration guard blocks edits to a pushed file,
// and SKIP_MIGRATION_GUARD is never used to get around that here) for ONE
// flag only: customer_visible.
//
// codex P1 pre-push finding (2026-09-24): track-public.js and tracking.js
// both join services.customer_visible to decide whether to show the
// "Today's visit" plain-language summary on the customer-facing tracking
// page (`row.service_customer_visible !== false`). tree_shrub_quarterly's
// customer_visible=false (set by 20260924020000) therefore blanks that
// summary for the ONE existing grandfathered quarterly customer's already-
// scheduled visits — a real regression to their tracking experience even
// though nothing about their existing plan changed.
//
// Fix: restore customer_visible=true for tree_shrub_quarterly.
// booking_enabled and public_quote_selectable STAY false — this migration
// touches nothing else 20260924020000 set. The row must still stay off the
// anonymous public MCP catalog (routes/public-mcp.js listServices/
// getService), which is now handled with a CODE-side filter instead
// (FORMERLY_PUBLIC_KEYS, the same denylist public-services-menu.js already
// maintains for other keys retired from public selection while their row
// stays customer_visible for an unrelated reason) — never by re-hiding the
// row from customer_visible, which is what caused this bug in the first
// place.
//
// down() is a documented no-op (same posture as the lawn bi-monthly
// migrations' no-op downs), not a real revert: re-flipping customer_visible
// back to false on a `migrate:down` of ONLY this file would immediately
// re-break the grandfathered customer's tracking page again, which is a
// worse outcome than leaving the flag as this migration set it. A genuine
// full rollback of the T&S quarterly retirement is a deliberate, reviewed
// change (roll back 20260924020000 too, or flip flags from the Service
// Library), not a mechanical migrate:down of one step.

const SERVICE_KEY = 'tree_shrub_quarterly';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'customer_visible'))) return;
  await knex('services')
    .where({ service_key: SERVICE_KEY })
    .update({ customer_visible: true, updated_at: knex.fn.now() });
};

exports.down = async function down() {
  // Documented no-op — see header. A genuine rollback is a deliberate,
  // reviewed change, not a mechanical migrate:down of this one step.
};

exports.SERVICE_KEY = SERVICE_KEY;
