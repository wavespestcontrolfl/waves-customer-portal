/**
 * Lawn protocol v13: the Headway take-all pass goes out in 5 gal of water per 1,000 sq ft, not 2 (owner 2026-11-20, *headway*).
 *
 * Why. The Headway liquid label (EPA Reg. No. 100-1216, accepted 2026-04-03; Banner Heritage MAXX, alternate brand Headway) says of
 * handheld applications (backpack and manually pressurized sprayers) to landscape turf: "Do not exceed a concentration of 0.615 fl oz
 * ... per gallon of water", and for a spot spray it mixes "3.0 fl oz ... per 5.0 gallons of water" for 1,000 sq ft. The v13 take-all
 * pass is 3 fl oz per 1,000 sq ft from the spot backpack. Its staged rows (written by 20261007180000) carry 2 gal per 1,000 sq ft,
 * and the job card sizes a spot row's tank dose over the row's own carrier (job-card.js buildMixAmount: rate / carrier x gallons):
 * 1.5 fl oz a gallon, 2.4 times the limit. At 5 gal it is 0.6 fl oz a gallon, and any label rate (1.5 to 3 fl oz) fits.
 *
 * 1. Protocol rows. On every v13 protocol (version 2026.10-v13), the Headway Fungicide row of the April window
 *    (apr_v13_spreader_feeding, second spring take-all pass) and of the October window (oct_v13_spreader_fall, second fall pass)
 *    takes carrier_gal_per_1000 5, and updated_at, as an office edit would. Nothing else on the row changes. Every such row whose
 *    carrier is not 5 changes, an empty one included (the job card then falls back to the rig's carrier). Production has 8, all at 2
 *    (4 protocols x 2 windows, read 2026-11-20). A value other than 2 is not an office choice to keep: the app edits protocol rows
 *    only on a draft protocol (admin-protocols.js answers 409 otherwise), and below 5 gal the program's 3 fl oz is over the label's
 *    limit. One lawn_protocol_audit_log row per protocol (the earlier v13 migrations' shape) holds each row's carrier before and after.
 *    The two Headway G rows of the 2026.06 zoysia protocol are the granule (no water) and are not touched.
 * 2. The catalog note. The July 2026 label backfill (20260712100000) quoted the label's soil-injection passage into the Headway
 *    Fungicide row's label_source_note without saying so: "Apply Headway at 1.5-3 fl oz per 1,000 sq ft. Spray carrier volume should
 *    fall within 30-150 gallons of water per 1,000 sq ft." The protocol reference tab shows that note to staff beside a program that
 *    sprays the product from a backpack. The label gives 30-150 gal only "For use with soil injection applications" (a liquid
 *    fungicide injector); a turf spray goes out in "1.0 to 5.0 gallons of water per 1,000 sq ft", and a backpack tank holds at most
 *    0.615 fl oz a gallon. The quote stays, marked soil injection only, and one line with the spray and handheld directions is added;
 *    the rest of the note stays. A note without the unmarked quote (an office edit, or this migration already ran) is left as it is.
 *    One lawn_protocol_audit_log row (entity_type 'catalog', the earlier v13 catalog migrations' shape) holds the note before and after.
 *
 * The recipe file (server/config/lawn-protocol-v13.json, three tracks) changes in the same PR, "in 2 to 4 gal of water" -> "in 5 gal
 * of water": a lawn protocol change reaches both sources of truth (AGENTS.md). Future visits only: the plan and the job card read the
 * live staged row for an open visit; a closed visit keeps the carrier it recorded.
 *
 * The rows each step decides on are read FOR UPDATE (the migration runs in one transaction), and a second run writes nothing. A
 * database without the tables a step reads has nothing to correct, and the step returns. A change that is needed while
 * lawn_protocol_audit_log is missing throws before any write: knex would otherwise record a correction it never made.
 *
 * down() is a documented no-op (waves-db: a data correction's rollback is never destructive). Putting the old carrier back would put
 * a tank dose over the label's limit back on every open visit, and the old note back beside it. Code from before this migration reads
 * a 5 gal row as it reads any other carrier. The audit rows keep each old value, for a new migration if one is ever wanted.
 */

const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = staged.V13_VERSION;
const MIGRATION = '20261120140000_lawn_v13_headway_carrier_5gal';
// lawn_protocol_audit_log.action is varchar(40).
const ACTION = 'v13_headway_carrier_5gal';
const NOTE_ACTION = 'v13_headway_carrier_5gal_note';
const ACTOR = 'migration 20261120140000';

const HEADWAY = 'Headway Fungicide';
const WINDOWS = Object.freeze(['apr_v13_spreader_feeding', 'oct_v13_spreader_fall']);
const CARRIER_GAL_PER_1000 = 5;
const DATA_TABLES = ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products'];
const AUDIT_TABLE = 'lawn_protocol_audit_log';

// The backfill's quote of the label's soil-injection passage, and the same quote marked as soil injection.
const INJECTION_QUOTE = '"Apply Headway at 1.5-3 fl oz per 1,000 sq ft. Spray carrier volume should fall within 30-150 gallons of water per 1,000 sq ft."';
const INJECTION_SCOPED = `soil injection only (a liquid fungicide injector): ${INJECTION_QUOTE}`;
const NOTE_LINE = 'Spray (label EPA Reg. No. 100-1216, accepted 2026-04-03): turf, "1.0 to 5.0 gallons of water per 1,000 sq ft". Handheld '
  + '(backpack and manually pressurized sprayers) to landscape turf: "Do not exceed a concentration of 0.615 fl oz ... per gallon of '
  + 'water"; a spot spray mixes "3.0 fl oz ... per 5.0 gallons of water" for 1,000 sq ft. The v13 take-all pass is 3 fl oz in 5 gal '
  + 'per 1,000 sq ft from the backpack (owner 2026-11-20).';

const carrierOf = (value) => (value == null ? null : Number(value));

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function requireAuditTable(knex, what) {
  if (!(await knex.schema.hasTable(AUDIT_TABLE))) throw new Error(`${MIGRATION}: ${AUDIT_TABLE} is missing; ${what} still need the change`);
}

async function correctCarriers(knex) {
  if (!(await hasTables(knex, DATA_TABLES))) return;
  const targets = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where({ 'l.version': V13_VERSION, 'p.product_name': HEADWAY })
    .whereIn('w.window_key', WINDOWS)
    .orderBy(['l.protocol_key', 'w.window_key', 'p.id'])
    .select('p.id', 'w.window_key', 'l.id as protocol_id');
  if (!targets.length) return;
  // Locked until the migration commits, so each audit row's before value is the value its update replaced.
  const locked = await knex('lawn_protocol_products').whereIn('id', targets.map((row) => row.id)).forUpdate().select('id', 'carrier_gal_per_1000');
  const carrierById = new Map(locked.map((row) => [String(row.id), carrierOf(row.carrier_gal_per_1000)]));
  const changes = targets.filter((row) => carrierById.get(String(row.id)) !== CARRIER_GAL_PER_1000);
  if (!changes.length) return;
  await requireAuditTable(knex, `${changes.length} Headway row(s)`);

  const byProtocol = new Map();
  for (const row of changes) {
    await knex('lawn_protocol_products').where({ id: row.id }).update({ carrier_gal_per_1000: CARRIER_GAL_PER_1000, updated_at: knex.fn.now() });
    if (!byProtocol.has(row.protocol_id)) byProtocol.set(row.protocol_id, []);
    byProtocol.get(row.protocol_id).push({ rowId: row.id, windowKey: row.window_key, before: carrierById.get(String(row.id)) });
  }
  for (const [protocolId, changed] of byProtocol) {
    await knex(AUDIT_TABLE).insert({
      lawn_protocol_id: protocolId,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['carrier_gal_per_1000']),
      before_snapshot: JSON.stringify({ rows: changed.map(({ rowId, windowKey, before }) => ({ rowId, windowKey, carrier_gal_per_1000: before })) }),
      after_snapshot: JSON.stringify({ rows: changed.map(({ rowId, windowKey }) => ({ rowId, windowKey, carrier_gal_per_1000: CARRIER_GAL_PER_1000 })) }),
      metadata: JSON.stringify({ migration: MIGRATION, product: HEADWAY, label: 'EPA Reg. No. 100-1216: at most 0.615 fl oz per gal from handheld equipment' }),
    });
  }
}

async function correctCatalogNote(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  // The July backfill matched the name in any case; so does this step.
  const rows = await knex('products_catalog').whereRaw('LOWER(name) = LOWER(?)', [HEADWAY]).forUpdate().select('id', 'label_source_note');
  const stale = rows.filter((row) => {
    const note = String(row.label_source_note || '');
    return note.includes(INJECTION_QUOTE) && !note.includes(INJECTION_SCOPED);
  });
  if (!stale.length) return;
  await requireAuditTable(knex, `${stale.length} Headway catalog note(s)`);
  for (const row of stale) {
    const after = `${row.label_source_note.replace(INJECTION_QUOTE, INJECTION_SCOPED)}\n\n${NOTE_LINE}`;
    await knex('products_catalog').where({ id: row.id }).update({ label_source_note: after, updated_at: knex.fn.now() });
    await knex(AUDIT_TABLE).insert({
      lawn_protocol_id: null,
      actor_name: ACTOR,
      entity_type: 'catalog',
      entity_id: row.id,
      action: NOTE_ACTION,
      changed_fields: JSON.stringify(['label_source_note']),
      before_snapshot: JSON.stringify({ label_source_note: row.label_source_note }),
      after_snapshot: JSON.stringify({ label_source_note: after }),
      metadata: JSON.stringify({ migration: MIGRATION, product: HEADWAY }),
    });
  }
}

exports.up = async function up(knex) {
  await correctCarriers(knex);
  await correctCatalogNote(knex);
};

// Documented no-op: see the header. A rollback keeps every row at 5 gal, the corrected note and every audit row.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
exports.NOTE_ACTION = NOTE_ACTION;
exports.HEADWAY = HEADWAY;
exports.WINDOWS = WINDOWS;
exports.CARRIER_GAL_PER_1000 = CARRIER_GAL_PER_1000;
exports.INJECTION_QUOTE = INJECTION_QUOTE;
exports.INJECTION_SCOPED = INJECTION_SCOPED;
exports.NOTE_LINE = NOTE_LINE;
