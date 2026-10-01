'use strict';

/**
 * Annual rate review — admin screen columns (plan
 * ~/.claude/plans/annual-rate-review-2026-09-30.md, build step 2, the
 * Pricing hub → Rate review area; stacked on the ranking backend's
 * 20260930210000 / 20260930210100).
 *
 * rate_review_snapshots.approved_at / approved_by — stamped by
 * POST /api/admin/rate-review/batches/:key/approve when the owner approves a
 * batch (green rows → status 'approved'; the CHECK already allows it).
 * Nothing is sent by that route; the comms lane reads 'approved'.
 *
 * rate_review_batches.approved_at / approved_by / approval_digest — the
 * batch-level record of the same approval and the digest (row ids +
 * proposed cents + statuses) it was taken against.
 *
 * rate_review_config.cost_block / cost_block_set_at / cost_block_set_by —
 * the once-a-year "what changed on our side" paragraph the owner writes by
 * hand (plain text, never generated); the letter template reads it.
 *
 * All columns are nullable and additive; down() drops them. Dark behind
 * GATE_RATE_REVIEW like the rest of the lane.
 */
const SNAPSHOTS = 'rate_review_snapshots';
const BATCHES = 'rate_review_batches';
const CONFIG = 'rate_review_config';

async function addColumn(knex, table, column, define) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, (t) => define(t));
}

async function dropColumn(knex, table, column) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, column))) return;
  await knex.schema.alterTable(table, (t) => t.dropColumn(column));
}

exports.up = async function up(knex) {
  await addColumn(knex, SNAPSHOTS, 'approved_at', (t) => t.timestamp('approved_at', { useTz: true }));
  await addColumn(knex, SNAPSHOTS, 'approved_by', (t) => t.uuid('approved_by')); // technicians.id
  await addColumn(knex, BATCHES, 'approved_at', (t) => t.timestamp('approved_at', { useTz: true }));
  await addColumn(knex, BATCHES, 'approved_by', (t) => t.uuid('approved_by'));
  await addColumn(knex, BATCHES, 'approval_digest', (t) => t.string('approval_digest', 64));
  await addColumn(knex, CONFIG, 'cost_block', (t) => t.text('cost_block'));
  await addColumn(knex, CONFIG, 'cost_block_set_at', (t) => t.timestamp('cost_block_set_at', { useTz: true }));
  await addColumn(knex, CONFIG, 'cost_block_set_by', (t) => t.uuid('cost_block_set_by'));
};

exports.down = async function down(knex) {
  await dropColumn(knex, CONFIG, 'cost_block_set_by');
  await dropColumn(knex, CONFIG, 'cost_block_set_at');
  await dropColumn(knex, CONFIG, 'cost_block');
  await dropColumn(knex, BATCHES, 'approval_digest');
  await dropColumn(knex, BATCHES, 'approved_by');
  await dropColumn(knex, BATCHES, 'approved_at');
  await dropColumn(knex, SNAPSHOTS, 'approved_by');
  await dropColumn(knex, SNAPSHOTS, 'approved_at');
};
