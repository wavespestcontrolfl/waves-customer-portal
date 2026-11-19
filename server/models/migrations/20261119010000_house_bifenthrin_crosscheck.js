/**
 * The house bifenthrin changes from Atticus Talak 7.9 F to LESCO Crosscheck Plus (owner ruling 2026-11-18). The code change moves
 * every default for NEW work; this migration moves the data rows that pick the product for new work. Atticus Talak 7.9 F stays a
 * valid catalog product (old records still render, leftover stock can still be recorded): its catalog row is never touched.
 *
 * Both products are found by exact catalog name: LESCO Crosscheck Plus, and Atticus Talak 7.9 F (else Atticus Talak, the name a
 * repo-built catalog carries). Steps 1 to 3 need both. If either is missing (a repo-built or test database) they do nothing and
 * never throw. Step 4 needs only Crosscheck.
 *
 *   1. lawn_protocol_products: every row linked to Talak (15 in production) takes the Crosscheck product_id and product_name.
 *      Nothing else on the row changes (not its rate, role, gates or updated_at). One lawn_protocol_audit_log row per protocol
 *      (the earlier v13 migrations' shape) holds each row's before and after link.
 *   2. services.default_products (jsonb array of product names): the element 'Atticus Talak 7.9 F' becomes 'LESCO Crosscheck Plus'
 *      in place, array order kept. A service that already lists Crosscheck loses the Talak element instead (no duplicate).
 *   3. product_aliases: 'Talstar P', 'Bifen I/T', 'Bifen IT' and 'Bifen I/T 7.9%' move from Talak to Crosscheck (office and tech
 *      names for the bottle now used). Where Crosscheck already carries the same name (and vendor), the Talak row is deleted
 *      instead, its whole row in the audit event (down() puts it back): one name must resolve to one product. Production has no
 *      such pair (read 2026-11-18). The Talak-named aliases stay on Talak. 'Crosscheck Plus' and 'Cross Check Plus' are added
 *      to Crosscheck unless that spelling already resolves (an alias on any product, or a catalog name, compared the way every
 *      reader compares: lower case, trimmed). 'CrossCheck Plus' and 'LESCO CrossCheck Plus' differ from catalog names and
 *      aliases only in case, so they already resolve. Every alias reader resolves what a person types or says, or what a
 *      protocol line spells, to a product for NEW input; none re-points a stored record (read 2026-11-18).
 *   4. products_catalog, the Crosscheck row: fills ONLY the columns that are NULL, in the same wording as the other bifenthrin rows,
 *      plus default_rate_per_1000 0.18 -> 0.5 (Talak's value) and the two approval flags false -> true. It never sets
 *      cost_per_unit: inventory-cost.js prices a used amount by cost_per_unit FIRST, so a fixed figure would outlive the next price
 *      change; with it NULL the cost follows best_price / unit_size_oz (the bifenthrin cost PR sets $30.90 for 128 fl oz). An
 *      epa_reg_number of exactly 279-3206-10404 becomes 10404-120: migration 20260712100000 backfilled the old number from a 2017
 *      distributor label; the current SiteOne label (D00001542) prints EPA Reg. No. 10404-120, which production already holds,
 *      and label-rain-rules.js finds the rule by that number. best_price, vendor_pricing, needs_pricing and inventory_on_hand
 *      are never touched, and the Talak row is not touched at all.
 *   5. service_product_usage: every row on Talak (1 in production: Mosquito Treatment - Essential Barrier) takes the Crosscheck
 *      product_id (owner 2026-11-18: "yes all linked services follow it"). Where a service type already maps Crosscheck, its
 *      Talak row is deleted instead (getInventoryCostEstimate sums every row, so both would count the same bifenthrin twice);
 *      its whole row goes into the audit event, and down() puts it back. These rows set no price: getInventoryCostEstimate (admin-pricing-config.js) feeds
 *      only the POST /margin-check display, estimate-pricing-audit.js and knowledge-base.js read them as cost, auto-dispatch
 *      dry-time.js reads the product's rain rule for a customer with no earlier visit, and public-products.js lists only rows that
 *      are public and approved_for_public (neither bifenthrin row is). The quote cost moves in its own PR (pricing_config).
 *
 * Audit: steps 2 to 5 write one audit_log event per changed row through recordAuditEvent (action migration:<name>:<step>, the
 * before and after values in metadata). Step 1 writes one lawn_protocol_audit_log row per protocol, the shape the earlier v13
 * lawn migrations use. Up is idempotent: every write is guarded by the value it replaces, so a second run writes nothing. The
 * rows steps 1, 3 and 5 decide on are read FOR UPDATE (the migration runs in one transaction), so an office edit made while it
 * runs waits for the commit instead of landing between a read and the write it decides.
 *
 * Down restores exactly what up() recorded and nothing else, each item only while it still holds the value up() wrote (a value
 * changed since is kept and logged), and a link or a deleted row goes back to Talak only while Talak's catalog row exists (the
 * foreign key would fail the rollback). audit_log is append-only: down() never deletes an event; it appends a
 * migration:<name>:<step>:rollback event that names the up() event it reversed (from_audit_id), and skips an event that already
 * has one. Step 1 keeps the v13 lawn shape: its lawn_protocol_audit_log row goes once every row in it is restored.
 */
// audit_log.action is varchar(96): `migration:<name>:<step>:rollback` must fit, so the name stays short.
const MIGRATION = '20261119010000_house_bifenthrin_crosscheck';
const LOG = '[house-bifenthrin-crosscheck]';
const ACTOR = 'migration 20261119010000';
const LAWN_ACTION = 'house_bifenthrin_crosscheck'; // lawn_protocol_audit_log.action is varchar(40)
const STEPS = { services: 'services', aliases: 'aliases', catalog: 'catalog', usage: 'usage' };
const actionFor = (step) => `migration:${MIGRATION}:${step}`;
const rollbackActionFor = (step) => `${actionFor(step)}:rollback`;

const CROSSCHECK = 'LESCO Crosscheck Plus';
const TALAK_NAMES = ['Atticus Talak 7.9 F', 'Atticus Talak'];
const TALAK_SERVICE_ELEMENT = 'Atticus Talak 7.9 F';

const MOVED_ALIASES = ['Talstar P', 'Bifen I/T', 'Bifen IT', 'Bifen I/T 7.9%'];
const NEW_ALIASES = ['Crosscheck Plus', 'CrossCheck Plus', 'LESCO CrossCheck Plus', 'Cross Check Plus'];

// Filled only while the column is NULL. Same wording the other bifenthrin rows carry.
const FILL_IF_NULL = [
  ['reentry_text', 'People and pets are kept off treated surfaces until the spray has dried.'],
  ['pet_kid_guidance_text', 'Keep people and pets off treated areas until dry.'],
  ['customer_safety_summary', 'Applied according to label directions by licensed technicians. Allow treated areas to dry before normal contact.'],
  ['common_name', 'Bifenthrin perimeter insecticide'],
  ['public_summary', 'A professional bifenthrin insecticide used for perimeter and harborage treatments, rotated with other products.'],
  ['portal_summary', 'Applied to exterior perimeter and lawn-adjacent pest-pressure areas for broad-spectrum residual control.'],
  ['application_zones', ['exterior perimeter', 'foundation', 'lawn edge']],
  ['customer_visibility', 'portal_only'],
  ['content_status', 'approved_for_portal'],
  ['product_type', 'pesticide'],
  ['signal_word', 'CAUTION'],
  ['inventory_unit', 'fl_oz'],
  ['low_stock_threshold', 128],
];
const JSON_COLUMNS = new Set(['application_zones']);
const EPA = { from: '279-3206-10404', to: '10404-120' };
const LABEL_RATE_PER_1000 = { from: 0.18, to: 0.5 };
const APPROVAL_FLAGS = ['approved_for_estimate_packet', 'approved_for_public_page'];

const norm = (value) => String(value == null ? '' : value).trim().toLowerCase();
const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
};
const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function findCatalogRow(knex, names) {
  for (const name of names) {
    const rows = await knex('products_catalog').where({ name }).select('id', 'name');
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) {
      console.log(`${LOG} ${rows.length} catalog rows are named "${name}": not touching anything for it`);
      return null;
    }
  }
  return null;
}

// The one audit_log writer (waves-db §4): critical, so a lost event fails the migration instead of leaving a change down() cannot see.
async function writeAudit(knex, action, resourceType, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: resourceType, resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

// ── up ───────────────────────────────────────────────────────────────────────

async function moveProtocolRows(knex, talak, crosscheck) {
  // Locked until the migration commits, so the audit row's before-snapshot is the row each update changed.
  const rows = await knex('lawn_protocol_products').where({ product_id: talak.id }).select('id', 'product_id', 'product_name', 'lawn_protocol_window_id').forUpdate();
  if (!rows.length) return;
  const windows = await knex('lawn_protocol_windows').whereIn('id', rows.map((row) => row.lawn_protocol_window_id).filter(Boolean)).select('id', 'lawn_protocol_id');
  const protocolOfWindow = new Map(windows.map((window) => [String(window.id), window.lawn_protocol_id]));
  const byProtocol = new Map();
  for (const row of rows) {
    const changed = await knex('lawn_protocol_products').where({ id: row.id, product_id: talak.id })
      .update({ product_id: crosscheck.id, product_name: CROSSCHECK });
    if (!changed) continue;
    const protocolId = protocolOfWindow.get(String(row.lawn_protocol_window_id)) || null;
    const key = protocolId || 'none';
    if (!byProtocol.has(key)) byProtocol.set(key, { protocolId, rows: [] });
    byProtocol.get(key).rows.push({ rowId: row.id, product_id: String(talak.id), product_name: row.product_name });
  }
  for (const { protocolId, rows: moved } of byProtocol.values()) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocolId || crosscheck.id,
      action: LAWN_ACTION,
      changed_fields: JSON.stringify(['product_id', 'product_name']),
      before_snapshot: JSON.stringify({ rows: moved }),
      after_snapshot: JSON.stringify({ rows: moved.map((row) => ({ rowId: row.rowId, product_id: String(crosscheck.id), product_name: CROSSCHECK })) }),
      metadata: JSON.stringify({ migration: MIGRATION, from: talak.name, to: CROSSCHECK }),
    });
  }
}

async function swapServiceDefaults(knex, talak, crosscheck) {
  if (!(await knex.schema.hasColumn('services', 'default_products'))) return;
  const elements = new Set([TALAK_SERVICE_ELEMENT, talak.name]);
  const services = await knex('services').select('id', 'name', 'default_products');
  for (const service of services) {
    const before = asArray(service.default_products);
    if (!before || !before.some((item) => elements.has(item))) continue;
    const has = before.includes(CROSSCHECK);
    let placed = false;
    const after = [];
    for (const item of before) {
      if (!elements.has(item)) { after.push(item); continue; }
      if (has || placed) continue; // Crosscheck is already listed (or already placed): drop the Talak element
      after.push(CROSSCHECK);
      placed = true;
    }
    // Guarded by the array it replaces (jsonb equality), so an edit made since the read is never overwritten.
    const changed = await knex('services').where({ id: service.id, default_products: JSON.stringify(before) })
      .update({ default_products: JSON.stringify(after) });
    if (changed) await writeAudit(knex, actionFor(STEPS.services), 'services', service.id, { service: service.name, before, after });
  }
}

// A JSON-safe copy of a row (dates as ISO strings), so down() can insert it back exactly.
const snapshotRow = (row) => JSON.parse(JSON.stringify(row));
const aliasKey = (row) => `${norm(row.alias_name)}|${row.vendor_id || ''}`;

// The two products' aliases are read FOR UPDATE: locked until the migration commits, so an office edit cannot change a row between
// the read that decides its fate and the write. The spellings that already resolve (any alias, any catalog name) are a plain read.
async function readAliasState(knex, talak, crosscheck) {
  const rows = await knex('product_aliases').whereIn('product_id', [talak.id, crosscheck.id]).select('*').forUpdate();
  const others = await knex('product_aliases').select('alias_name');
  const catalog = await knex('products_catalog').select('name');
  const resolves = new Set([...others.map((row) => norm(row.alias_name)), ...catalog.map((row) => norm(row.name))]);
  const onCrosscheck = new Set(rows.filter((row) => String(row.product_id) === String(crosscheck.id)).map(aliasKey));
  return { rows, resolves, onCrosscheck };
}

async function moveAliases(knex, talak, crosscheck) {
  const { rows, resolves, onCrosscheck } = await readAliasState(knex, talak, crosscheck);
  const action = actionFor(STEPS.aliases);
  const wanted = new Set(MOVED_ALIASES.map(norm));
  for (const row of rows) {
    if (String(row.product_id) !== String(talak.id) || !wanted.has(norm(row.alias_name))) continue;
    if (onCrosscheck.has(aliasKey(row))) {
      // Crosscheck already carries this name: a second mapping on Talak would leave readers two products for one name (a
      // receipt match sees both, a first() reader can still pick Talak), so the Talak row goes, whole, into the audit event.
      const removed = await knex('product_aliases').where({ id: row.id, product_id: talak.id }).del();
      if (removed) await writeAudit(knex, action, 'product_aliases', row.id, { kind: 'removed', alias_name: row.alias_name, row: snapshotRow(row) });
      continue;
    }
    const changed = await knex('product_aliases').where({ id: row.id, product_id: talak.id }).update({ product_id: crosscheck.id });
    if (changed) await writeAudit(knex, action, 'product_aliases', row.id, { kind: 'moved', alias_name: row.alias_name, from: String(talak.id), to: String(crosscheck.id) });
  }
  for (const aliasName of NEW_ALIASES) {
    if (resolves.has(norm(aliasName))) continue;
    resolves.add(norm(aliasName));
    const [made] = await knex('product_aliases').insert({ product_id: crosscheck.id, alias_name: aliasName, vendor_id: null }).returning('id');
    const id = made && typeof made === 'object' ? made.id : made;
    await writeAudit(knex, action, 'product_aliases', id, { kind: 'inserted', alias_name: aliasName, product_id: String(crosscheck.id) });
  }
}

// Read FOR UPDATE: both products' rows stay locked until the migration commits, so an office edit (a service type, a rate) cannot
// land between the read that decides a row is a duplicate and the delete, and the audit event holds the row as it was deleted.
async function moveUsageRows(knex, talak, crosscheck) {
  const rows = await knex('service_product_usage').whereIn('product_id', [talak.id, crosscheck.id]).select('*').forUpdate();
  const mapsCrosscheck = new Set(rows.filter((row) => String(row.product_id) === String(crosscheck.id)).map((row) => row.service_type));
  const action = actionFor(STEPS.usage);
  for (const row of rows) {
    if (String(row.product_id) !== String(talak.id)) continue;
    if (mapsCrosscheck.has(row.service_type)) {
      // Crosscheck already costs this service type, so the Talak row would count the same bifenthrin a second time.
      const removed = await knex('service_product_usage').where({ id: row.id, product_id: talak.id }).del();
      if (removed) await writeAudit(knex, action, 'service_product_usage', row.id, { kind: 'removed', service_type: row.service_type, row: snapshotRow(row) });
      continue;
    }
    const changed = await knex('service_product_usage').where({ id: row.id, product_id: talak.id }).update({ product_id: crosscheck.id });
    if (changed) await writeAudit(knex, action, 'service_product_usage', row.id, { kind: 'moved', service_type: row.service_type, from: String(talak.id), to: String(crosscheck.id) });
  }
}

// What up() would write on the Crosscheck row: column -> { before, after }. Pure: reads the row and the column list only.
function planCatalogChanges(row, has) {
  const changes = {};
  for (const [column, value] of FILL_IF_NULL) {
    if (!has(column)) console.log(`${LOG} products_catalog.${column} does not exist: skipped`);
    else if (row[column] == null) changes[column] = { before: null, after: value };
  }
  if (has('epa_reg_number') && row.epa_reg_number === EPA.from) changes.epa_reg_number = { before: EPA.from, after: EPA.to };
  if (has('default_rate_per_1000') && row.default_rate_per_1000 != null && Number(row.default_rate_per_1000) === LABEL_RATE_PER_1000.from) {
    changes.default_rate_per_1000 = { before: row.default_rate_per_1000, after: LABEL_RATE_PER_1000.to };
  }
  for (const column of APPROVAL_FLAGS) {
    if (has(column) && row[column] === false) changes[column] = { before: false, after: true };
  }
  return changes;
}

async function fillCatalog(knex, crosscheck) {
  const row = await knex('products_catalog').where({ id: crosscheck.id }).first();
  if (!row) return;
  const columns = new Set();
  for (const column of [...FILL_IF_NULL.map(([name]) => name), 'epa_reg_number', 'default_rate_per_1000', ...APPROVAL_FLAGS]) {
    if (await knex.schema.hasColumn('products_catalog', column)) columns.add(column);
  }
  const changes = planCatalogChanges(row, (column) => columns.has(column));
  // Each column only while it still holds the value described above, so a concurrent edit is never overwritten.
  const written = {};
  for (const [column, { before, after }] of Object.entries(changes)) {
    const value = JSON_COLUMNS.has(column) ? JSON.stringify(after) : after;
    const query = knex('products_catalog').where({ id: crosscheck.id });
    const changed = await (before == null ? query.whereNull(column) : query.where({ [column]: before })).update({ [column]: value });
    if (changed) written[column] = changes[column];
  }
  if (Object.keys(written).length) await writeAudit(knex, actionFor(STEPS.catalog), 'products_catalog', crosscheck.id, { product: CROSSCHECK, changes: written });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const crosscheck = await findCatalogRow(knex, [CROSSCHECK]);
  if (!crosscheck) {
    console.log(`${LOG} no catalog row named "${CROSSCHECK}": nothing to do`);
    return;
  }
  const canAudit = await knex.schema.hasTable('audit_log');
  if (!canAudit) {
    console.log(`${LOG} audit_log table is missing: nothing to do (no snapshot, no change)`);
    return;
  }
  const talak = await findCatalogRow(knex, TALAK_NAMES);
  if (talak && String(talak.id) !== String(crosscheck.id)) {
    if (await hasTables(knex, ['lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocol_audit_log'])) await moveProtocolRows(knex, talak, crosscheck);
    if (await knex.schema.hasTable('services')) await swapServiceDefaults(knex, talak, crosscheck);
    if (await knex.schema.hasTable('product_aliases')) await moveAliases(knex, talak, crosscheck);
    if (await knex.schema.hasTable('service_product_usage')) await moveUsageRows(knex, talak, crosscheck);
  } else {
    console.log(`${LOG} no catalog row named "${TALAK_NAMES.join('" or "')}": links, service defaults and aliases left alone`);
  }
  await fillCatalog(knex, crosscheck);
};

// ── down ─────────────────────────────────────────────────────────────────────

// Whether a catalog row exists. A link goes back to its original product only while that product exists: the foreign key would
// otherwise fail the whole rollback (Talak deleted after up() keeps every row on Crosscheck, logged).
async function productExists(knex, id) {
  return Boolean(id) && Boolean(await knex('products_catalog').where({ id }).first('id'));
}

async function restoreProtocolRows(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: LAWN_ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const before = new Map((asObject(log.before_snapshot).rows || []).map((row) => [String(row.rowId), row]));
    let kept = 0;
    for (const written of asObject(log.after_snapshot).rows || []) {
      const old = before.get(String(written.rowId));
      const restored = old && await productExists(knex, old.product_id) && await knex('lawn_protocol_products')
        .where({ id: written.rowId, product_id: written.product_id, product_name: written.product_name })
        .update({ product_id: old.product_id, product_name: old.product_name });
      if (!restored) { kept += 1; console.log(`${LOG} protocol row ${written.rowId} is no longer as written: kept`); }
    }
    if (!kept) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

// The up() events of a step that no rollback event names yet. audit_log is append-only: down() never deletes an event.
async function pendingEvents(knex, step) {
  const events = await knex('audit_log').where({ action: actionFor(step) }).select('id', 'resource_id', 'metadata');
  const rollbacks = await knex('audit_log').where({ action: rollbackActionFor(step) }).select('metadata');
  const reversed = new Set(rollbacks.map((row) => String(asObject(row.metadata).from_audit_id)));
  return events.filter((event) => !reversed.has(String(event.id)));
}

async function recordRollback(knex, step, event, resourceType, extra = {}) {
  await writeAudit(knex, rollbackActionFor(step), resourceType, event.resource_id, { from_audit_id: String(event.id), ...extra });
}

const keptLog = (what) => console.log(`${LOG} ${what} no longer holds what up() wrote: kept`);

async function restoreServices(knex) {
  for (const event of await pendingEvents(knex, STEPS.services)) {
    const { before, after } = asObject(event.metadata);
    if (!Array.isArray(before) || !Array.isArray(after)) continue;
    const restored = await knex('services').where({ id: event.resource_id, default_products: JSON.stringify(after) })
      .update({ default_products: JSON.stringify(before) });
    if (restored) await recordRollback(knex, STEPS.services, event, 'services');
    else keptLog(`service ${event.resource_id} default_products`);
  }
}

// A removed row goes back only while its id is free, its product exists (the foreign key needs it) and no row holds its exact name
// and vendor (product_aliases is unique on alias_name + vendor_id; a NULL vendor never collides).
async function insertBackAlias(knex, row) {
  if (await knex('product_aliases').where({ id: row.id }).first('id')) return 0;
  if (!(await productExists(knex, row.product_id))) return 0;
  if (row.vendor_id != null && await knex('product_aliases').where({ alias_name: row.alias_name, vendor_id: row.vendor_id }).first('id')) return 0;
  await knex('product_aliases').insert(row);
  return 1;
}

async function restoreAliases(knex) {
  for (const event of await pendingEvents(knex, STEPS.aliases)) {
    const meta = asObject(event.metadata);
    let restored = 0;
    if (meta.kind === 'inserted') {
      // up() inserted a global row (no vendor): one the office has since given a vendor is the office's mapping and stays.
      restored = await knex('product_aliases').where({ id: event.resource_id, product_id: meta.product_id, alias_name: meta.alias_name })
        .whereNull('vendor_id').del();
    } else if (meta.kind === 'moved' && meta.from && meta.to && await productExists(knex, meta.from)) {
      restored = await knex('product_aliases').where({ id: event.resource_id, product_id: meta.to }).update({ product_id: meta.from });
    } else if (meta.kind === 'removed' && meta.row && meta.row.id) {
      restored = await insertBackAlias(knex, meta.row);
    }
    if (restored) await recordRollback(knex, STEPS.aliases, event, 'product_aliases');
    else keptLog(`alias "${meta.alias_name}"`);
  }
}

// The value as a WHERE matches it: jsonb compares by content, so a JSON column is matched by its JSON text.
const whereValue = (column, value) => (JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);

async function restoreCatalog(knex) {
  for (const event of await pendingEvents(knex, STEPS.catalog)) {
    const { changes = {} } = asObject(event.metadata);
    const restored = [];
    for (const [column, { before, after }] of Object.entries(changes)) {
      if (!(await knex.schema.hasColumn('products_catalog', column))) continue;
      // Guarded by the value up() wrote, in the UPDATE itself, so an office edit made since is never overwritten.
      const value = JSON_COLUMNS.has(column) && before != null ? JSON.stringify(before) : before;
      const changed = await knex('products_catalog').where({ id: event.resource_id, [column]: whereValue(column, after) }).update({ [column]: value });
      if (changed) restored.push(column);
      else keptLog(`products_catalog.${column}`);
    }
    if (restored.length) await recordRollback(knex, STEPS.catalog, event, 'products_catalog', { restored });
  }
}

async function restoreUsage(knex) {
  for (const event of await pendingEvents(knex, STEPS.usage)) {
    const { kind, from, to, row } = asObject(event.metadata);
    let restored = 0;
    if (kind === 'moved' && from && to && await productExists(knex, from)) {
      restored = await knex('service_product_usage').where({ id: event.resource_id, product_id: to }).update({ product_id: from });
    } else if (kind === 'removed' && row && row.id) {
      // Back only while nothing took its id and its product still exists (the foreign key needs it).
      const taken = await knex('service_product_usage').where({ id: row.id }).first('id');
      if (!taken && await productExists(knex, row.product_id)) { await knex('service_product_usage').insert(row); restored = 1; }
    }
    if (restored) await recordRollback(knex, STEPS.usage, event, 'service_product_usage');
    else keptLog(`usage row ${event.resource_id}`);
  }
}

exports.down = async function down(knex) {
  if (await hasTables(knex, ['lawn_protocol_products', 'lawn_protocol_audit_log'])) await restoreProtocolRows(knex);
  if (!(await knex.schema.hasTable('audit_log'))) return;
  if (await knex.schema.hasTable('services')) await restoreServices(knex);
  if (await knex.schema.hasTable('product_aliases')) await restoreAliases(knex);
  if (await knex.schema.hasTable('products_catalog')) await restoreCatalog(knex);
  if (await knex.schema.hasTable('service_product_usage')) await restoreUsage(knex);
};

exports.MIGRATION = MIGRATION;
exports.LAWN_ACTION = LAWN_ACTION;
exports.actionFor = actionFor;
exports.rollbackActionFor = rollbackActionFor;
exports.STEPS = STEPS;
exports.MOVED_ALIASES = MOVED_ALIASES;
exports.NEW_ALIASES = NEW_ALIASES;
exports.FILL_IF_NULL = FILL_IF_NULL;
