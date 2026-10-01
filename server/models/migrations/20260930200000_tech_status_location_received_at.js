'use strict';

/**
 * tech_status.location_received_at — the SERVER's own receipt time for the stored lat/lng
 * (Codex round-45 P2, PR #5334).
 *
 * tech_status.location_updated_at is the PROVIDER's fix time, and the tracker accepts provider
 * timestamps up to two minutes in the future, so it cannot prove a point was received AFTER a
 * technician's tracker was remapped: an old device's point committed before the remap can carry a
 * future-skewed fix time that beats technicians.bouncie_imei_changed_at. tech_status.updated_at is
 * no better — status-only writes (setTechJobStatus) restamp it without any new location. This
 * column is stamped NOW() by every writer that changes lat/lng (pingTechLocation, and
 * upsertTechStatus when coordinates are supplied) and left alone by status-only writes.
 *
 * Additive and idempotent. The default is NOW() at migration time: rows that exist already read as
 * "received at migration", which precedes any remap performed afterwards, so they behave as before
 * until a remap happens; after a remap only points written by a post-remap location write qualify.
 */
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE tech_status ADD COLUMN IF NOT EXISTS location_received_at timestamptz DEFAULT NOW()');
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE tech_status DROP COLUMN IF EXISTS location_received_at');
};
