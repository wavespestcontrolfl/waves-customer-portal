'use strict';

/**
 * technicians.bouncie_imei_changed_at — WHEN the tracker mapping last changed
 * (Codex round-35 P2, PR #5334).
 *
 * technicians.updated_at is restamped by ordinary edits (name, phone, payroll,
 * employment), so it cannot say when a technician was pointed at a different
 * Bouncie device. The live-ETA path (SMS) and the public tracker use this instant
 * as the floor for trusting a cached tech_status fix: tech_status is keyed by
 * technician and stores no device identity, so a fix reported BEFORE the mapping
 * changed may be the old vehicle's. Written only by the writer that changes
 * bouncie_imei (admin-geofence PUT /vehicles/:technicianId), and only when the
 * value actually changes.
 *
 * Nullable, no backfill: NULL means "no known remap", i.e. no cutoff (the cache is
 * trusted as before). Idempotent (hasColumn guard). Additive only.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('technicians', 'bouncie_imei_changed_at')) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.timestamp('bouncie_imei_changed_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('technicians', 'bouncie_imei_changed_at'))) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.dropColumn('bouncie_imei_changed_at');
  });
};
