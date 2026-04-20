/**
 * audit_log — generic, permanent record of actor → action → resource events.
 *
 * Replaces the ad-hoc pattern of per-feature audit tables / scattered inserts
 * into activity_log (which is admin-scoped and lacks IP/UA context). Designed
 * to be written to by any feature that needs a forensic trail:
 *
 *   - Tap to Pay handoff mints (first caller)
 *   - WaveGuard plan changes
 *   - Discount applications
 *   - Procurement approval queue transitions
 *   - Agent-initiated actions (Lead Response, Customer Assistant, …)
 *   - High-value admin mutations
 *
 * All writes flow through services/audit-log.js — do not insert directly.
 * Rows are never deleted. Aggregation queries use (resource_type, resource_id)
 * or (actor_type, actor_id, created_at) indexes.
 *
 * `activity_log` is left in place for now; migrate callers to audit_log
 * opportunistically and drop activity_log in a later pass.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasTable('audit_log');
  if (has) return;

  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await knex.schema.createTable('audit_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    // Who. actor_type values seen so far: 'technician', 'customer', 'agent',
    // 'system'. actor_id is loose (no FK) so heterogeneous actors can share
    // the table — technicians.id for 'technician', customers.id for
    // 'customer', agent identifier string encoded as uuid-from-name for
    // 'agent', NULL for 'system'.
    t.string('actor_type', 32).notNullable();
    t.uuid('actor_id');
    // What. Dotted namespace convention: 'terminal.handoff.mint',
    // 'invoice.discount.apply', 'plan.waveguard.change', …
    t.string('action', 96).notNullable();
    // On what. Loose (type, id) — see entity_type/entity_id in short_codes
    // for the same pattern.
    t.string('resource_type', 48);
    t.uuid('resource_id');
    // Free-form event detail. Amounts, before/after states, referenced
    // external IDs (Stripe jti, PI id, …). Keep it small — this isn't a log
    // dump.
    t.jsonb('metadata').defaultTo('{}');
    // Where from. Populated when the event came from an HTTP request.
    t.string('ip_address', 64);
    t.text('user_agent');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['actor_type', 'actor_id', 'created_at']);
    t.index(['resource_type', 'resource_id']);
    t.index(['action', 'created_at']);
    t.index(['created_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('audit_log');
};
