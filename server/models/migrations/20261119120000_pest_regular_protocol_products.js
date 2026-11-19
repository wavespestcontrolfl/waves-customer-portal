/**
 * The regular general-pest settings name the owner's products (owner ruling 2026-11-19: "lesco and taurus are in our general pest
 * control treatments, while gentrol and atticus antapex, what used to be alpine, should be for cockroach treatment").
 *
 * General pest = LESCO Crosscheck Plus (+ Taurus SC where the plan fits its label) + LESCO 90/10 Nonionic Surfactant. Cockroach
 * treatment = Atticus Antapex WSG + Gentrol Complete EC3 + the live Advion gel. The code change (server/config/protocols.json) moves
 * the protocol lines; this migration moves the data rows that still name the old products. Four steps, each changing a row only
 * while it holds the exact value read from production on 2026-11-19; any other value is skipped and logged, never overwritten.
 *
 * Taurus SC and its label (EPA 53883-279): the label allows 0.03% (0.4 fl oz/gal) four times a calendar year, or 0.06% (0.8 fl oz/gal)
 * twice a year, or 0.03% twice plus 0.06% once. The owner chose 0.03% four times a year on 2026-11-19: 1.6 fl oz in a 4-gal FlowZone
 * tank. So Taurus SC is mapped (1.6 fl_oz) only on the Quarterly COGS mapping, which is 4 visits a year; the Bi-Monthly (6) and the
 * frequency-agnostic General Pest Perimeter mappings name LESCO Crosscheck Plus and the surfactant only. All six general-pest service
 * lists name Taurus SC (and the close-out house mix does, client/src/lib/pest-default-mix.js, Taurus 1.6): a list names the product, it
 * is not a schedule. Counting Taurus applications per home, to leave it out of the prefill after four in a calendar year, is the next
 * change, not this one.
 *
 *   1. service_product_usage (the COGS mapping): "Quarterly Pest Control" and "Bi-Monthly Pest Control" each hold Atticus Antapex
 *      WSG 5 g + Demand CS 1.6 oz (0.4 per 1000 sf); "General Pest Perimeter" holds Demand CS 1.6 oz (0.4 per 1000 sf), every row
 *      primary with the exact notes read. A service type whose rows are exactly those becomes: Quarterly = Taurus SC 1.6 fl_oz
 *      (primary) + Crosscheck 4 fl_oz (primary) + surfactant 0.25 fl_oz (not primary); Bi-Monthly and General Pest Perimeter =
 *      Crosscheck 4 fl_oz (primary) + surfactant 0.25 fl_oz (not primary), with no Taurus row. The old rows are removed whole into their audit events. No
 *      row is added under a key no reader looks up: the readers key on "Quarterly Pest Control" / "Pest Control" / "General Pest
 *      Perimeter" (admin-pricing-config.js, estimate-pricing-audit.js) and on one exact visit service_type (dry-time.js); a Monthly,
 *      Semiannual or One-Time pest row stays absent (production has none) until a reader needs it.
 *   2. services.default_products (jsonb array of product names): pest_general_quarterly and pest_general_semiannual hold ["Demand
 *      CS","Advion Gel","Gentrol Complete EC3"], pest_general_monthly and pest_general_bimonthly hold ["Demand CS","Advion Gel"],
 *      one_time_pest_control and pest_re_service hold NULL. Each becomes [Taurus SC, Crosscheck, surfactant].
 *   3. Roach services' default_products: "Advion Gel" matches no catalog row (the catalog's gel is "Advion Evolution Cockroach Gel
 *      Bait"; "Advion Cockroach Gel Bait" is inactive), so in cockroach_control, german_roach, vehicle_roach_addon and
 *      vehicle_german_roach that one element becomes the live name, in place. german_roach (["Advion Gel","Gentrol Complete EC3"])
 *      becomes ["Atticus Antapex WSG","Advion Evolution Cockroach Gel Bait","Gentrol Complete EC3"]. Needs exactly one active catalog
 *      row of the live name.
 *   4. Roach COGS rows: the primary gel rows (1 tube, no per-area rate) of "Cockroach Treatment" and "German Roach Cleanout" point at
 *      the inactive "Advion Cockroach Gel Bait" row; they are re-pointed to the live row. A Gentrol row whose note is exactly
 *      "Tank-mixed at 1 oz/gal with the Alpine gallon" says "Antapex gallon" instead (the product was renamed). Gentrol's catalog
 *      default_rate is not touched.
 *
 * Follow-up, not done here: the one-tap template protocol_templates ext_gp_perim v1 still lists Demand CS, "Alpine WSG" and Advion
 * WDG Granular. Production has never used it (no service_records or service_completion_attempts reference any protocol template), and
 * a replacement needs a label-aware design (Taurus SC: at most 4 a year), so v1 is left untouched.
 *
 * No price changes: none of the readers feeds a customer price (see the PR notes); the quote price comes from the pricing engine.
 *
 * Audit: every changed row writes one audit_log event through recordAuditEvent (action migration:<name>:<step>), the before and
 * after in its metadata. Up is idempotent: every write is guarded by the value it replaces, so a second run writes nothing. The rows
 * a step decides on are read FOR UPDATE (the migration runs in one transaction).
 *
 * Down restores exactly what up() recorded and nothing else, each item only while it still holds the value up() wrote (a value changed
 * since is kept and logged). The usage step reverses a whole service type or none of it: down() first checks that every row up() wrote
 * for that service type still holds every written field (read FOR UPDATE) and that every removed row can go back (its id is free,
 * its product exists); if not, the service type's current mapping is left whole and logged. audit_log is append-only: down() appends a
 * :rollback event that names the up() event it reversed (from_audit_id) and skips an event that already has one.
 */
const MIGRATION = '20261119120000_pest_regular_protocol_products';
const LOG = '[pest-regular-protocol-products]';
const STEPS = { usage: 'usage', services: 'services', roachServices: 'roach_services', roachUsage: 'roach_usage' };
const actionFor = (step) => `migration:${MIGRATION}:${step}`;
const rollbackActionFor = (step) => `${actionFor(step)}:rollback`;

const TAURUS = 'Taurus SC';
const CROSSCHECK = 'LESCO Crosscheck Plus';
const SURFACTANT = 'LESCO 90/10 Nonionic Surfactant';
const ANTAPEX = 'Atticus Antapex WSG';
const DEMAND = 'Demand CS';

const FULL_MIX = [TAURUS, CROSSCHECK, SURFACTANT];
const NEW_NOTE = 'Regular pest visit mix (owner 2026-11-19). Taurus SC (0.03%, 1.6 fl oz per 4 gal) is on at most 4 visits a year, so only the Quarterly mapping carries it.';

const crosscheckRow = { product: CROSSCHECK, amount: 4, unit: 'fl_oz', primary: true };
const surfactantRow = { product: SURFACTANT, amount: 0.25, unit: 'fl_oz', primary: false };
// Taurus SC is on at most 4 visits a year (label, 0.03%): the Quarterly mapping (4 visits) carries it; Bi-Monthly (6) and the
// frequency-agnostic General Pest Perimeter do not.
const taurusRow = { product: TAURUS, amount: 1.6, unit: 'fl_oz', primary: true };
const NEW_USAGE = {
  'Quarterly Pest Control': [taurusRow, crosscheckRow, surfactantRow],
  'Bi-Monthly Pest Control': [crosscheckRow, surfactantRow],
  'General Pest Perimeter': [crosscheckRow, surfactantRow],
};

// The rows read from production on 2026-11-19 (every column that carries a value).
const antapexRow = (notes) => ({ product: ANTAPEX, amount: 5, unit: 'g', per1000: null, primary: true, notes });
const demandRow = (notes) => ({ product: DEMAND, amount: 1.6, unit: 'oz', per1000: 0.4, primary: true, notes });
const OLD_USAGE = {
  'Quarterly Pest Control': [antapexRow('Interior baseboards + entry points (0.5 x 10 g label dose)'), demandRow('Exterior perimeter band')],
  'Bi-Monthly Pest Control': [antapexRow('Interior treatment (0.5 x 10 g label dose)'), demandRow('Exterior perimeter band')],
  'General Pest Perimeter': [demandRow('Exterior general pest perimeter band; use existing recurring pest pricing logic for customer price.')],
};

const DEMAND_ADVION_GENTROL = [DEMAND, 'Advion Gel', 'Gentrol Complete EC3'];
const DEMAND_ADVION = [DEMAND, 'Advion Gel'];
const OLD_DEFAULTS = {
  pest_general_quarterly: DEMAND_ADVION_GENTROL,
  pest_general_semiannual: DEMAND_ADVION_GENTROL,
  pest_general_monthly: DEMAND_ADVION,
  pest_general_bimonthly: DEMAND_ADVION,
  one_time_pest_control: null,
  pest_re_service: null,
};
const NEW_DEFAULTS = {
  pest_general_quarterly: FULL_MIX,
  pest_general_semiannual: FULL_MIX,
  one_time_pest_control: FULL_MIX,
  pest_general_monthly: FULL_MIX,
  pest_general_bimonthly: FULL_MIX,
  pest_re_service: FULL_MIX,
};

const GEL_OLD_LIST_NAME = 'Advion Gel';
const GEL_CATALOG_OLD = 'Advion Cockroach Gel Bait';
const GEL_LIVE = 'Advion Evolution Cockroach Gel Bait';
const ROACH_SERVICE_KEYS = ['cockroach_control', 'german_roach', 'vehicle_roach_addon', 'vehicle_german_roach'];
const GERMAN_ROACH_BEFORE = [GEL_OLD_LIST_NAME, 'Gentrol Complete EC3'];
const GERMAN_ROACH_AFTER = [ANTAPEX, GEL_LIVE, 'Gentrol Complete EC3'];
const ROACH_USAGE_TYPES = ['Cockroach Treatment', 'German Roach Cleanout'];
const GENTROL = 'Gentrol Complete EC3';
const GENTROL_NOTE_BEFORE = 'Tank-mixed at 1 oz/gal with the Alpine gallon';
const GENTROL_NOTE_AFTER = 'Tank-mixed at 1 oz/gal with the Antapex gallon';

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};
const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
};
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
// A JSON-safe copy of a row (dates as ISO strings), so down() can insert it back exactly.
const snapshotRow = (row) => JSON.parse(JSON.stringify(row));
// A numeric column against a value: null matches null/undefined only; numbers compare as numbers (pg returns decimals as strings).
const sameNumber = (a, b) => (a == null || b == null ? a == null && b == null : Number(a) === Number(b));

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// The one audit_log writer: critical, so a lost event fails the migration instead of leaving a change down() cannot see.
async function writeAudit(knex, action, resourceType, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action,
    resource_type: resourceType, resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
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

// The one catalog row of a name, or null (logged) when there is none or more than one.
async function onlyCatalogRow(knex, name) {
  const rows = await knex('products_catalog').where({ name }).select('id', 'name');
  if (rows.length === 1) return rows[0];
  console.log(`${LOG} ${rows.length} catalog rows are named "${name}": skipping the steps that need it`);
  return null;
}

async function productExists(knex, id) {
  return Boolean(id) && Boolean(await knex('products_catalog').where({ id }).first('id'));
}

// ── step 1: service_product_usage ────────────────────────────────────────────

// Do these rows hold exactly the listed products, amounts, units, per-area rates, primary flags and notes (and nothing else)?
function usageMatches(rows, names, expected) {
  if (rows.length !== expected.length) return false;
  const left = [...rows];
  for (const want of expected) {
    const at = left.findIndex((row) => names.get(String(row.product_id)) === want.product
      && sameNumber(row.usage_amount, want.amount)
      && row.usage_unit === want.unit
      && sameNumber(row.usage_per_1000sf, want.per1000)
      && Boolean(row.is_primary) === want.primary
      && (row.notes == null ? null : row.notes) === want.notes);
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

async function swapUsage(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log', 'service_product_usage']))) return;
  const house = new Map();
  for (const name of FULL_MIX) {
    const row = await onlyCatalogRow(knex, name);
    if (!row) return;
    house.set(name, row);
  }
  for (const [serviceType, expected] of Object.entries(OLD_USAGE)) {
    // Locked until the migration commits, so the audit event holds the row as it was deleted.
    const rows = await knex('service_product_usage').where({ service_type: serviceType }).select('*').forUpdate();
    const catalog = rows.length
      ? await knex('products_catalog').whereIn('id', rows.map((row) => row.product_id)).select('id', 'name')
      : [];
    const names = new Map(catalog.map((row) => [String(row.id), row.name]));
    if (!usageMatches(rows, names, expected)) {
      console.log(`${LOG} "${serviceType}" usage rows are not the ones read on 2026-11-19 (${rows.length} rows): kept`);
      continue;
    }
    for (const row of rows) {
      const removed = await knex('service_product_usage').where({ id: row.id, product_id: row.product_id }).del();
      if (removed) await writeAudit(knex, actionFor(STEPS.usage), 'service_product_usage', row.id, { kind: 'removed', service_type: serviceType, row: snapshotRow(row) });
    }
    for (const want of NEW_USAGE[serviceType]) {
      const values = {
        service_type: serviceType, product_id: house.get(want.product).id, usage_amount: want.amount, usage_unit: want.unit,
        usage_per_1000sf: null, is_primary: want.primary, notes: NEW_NOTE,
      };
      const [made] = await knex('service_product_usage').insert(values).returning('id');
      const id = made && typeof made === 'object' ? made.id : made;
      await writeAudit(knex, actionFor(STEPS.usage), 'service_product_usage', id, { kind: 'inserted', service_type: serviceType, row: { id, ...values } });
    }
  }
}

// Does the row hold every field up() wrote? (service_type, product, amount, unit, per-area rate, primary flag, notes.)
function holdsWritten(current, written) {
  return Boolean(current) && current.service_type === written.service_type
    && String(current.product_id) === String(written.product_id)
    && sameNumber(current.usage_amount, written.usage_amount) && current.usage_unit === written.usage_unit
    && sameNumber(current.usage_per_1000sf, written.usage_per_1000sf)
    && Boolean(current.is_primary) === Boolean(written.is_primary)
    && (current.notes == null ? null : current.notes) === (written.notes == null ? null : written.notes);
}

// A removed row goes back only while nothing took its id and its product exists (the foreign key needs it).
async function canRestoreRow(knex, row) {
  if (!row || !row.id) return false;
  if (await knex('service_product_usage').where({ id: row.id }).first('id')) return false;
  return productExists(knex, row.product_id);
}

// One service type at a time, whole or not at all: every row up() wrote must still hold what it wrote, and every row it removed
// must be able to go back. Otherwise the service type's current mapping stays exactly as it is.
async function restoreUsage(knex) {
  const byType = new Map();
  for (const event of await pendingEvents(knex, STEPS.usage)) {
    const { kind, service_type: serviceType, row } = asObject(event.metadata);
    if (!serviceType || !row || !['inserted', 'removed'].includes(kind)) continue;
    if (!byType.has(serviceType)) byType.set(serviceType, { inserted: [], removed: [] });
    byType.get(serviceType)[kind].push({ event, row });
  }
  for (const [serviceType, { inserted, removed }] of byType) {
    // Locked until the migration commits, so an edit cannot land between the check and the delete.
    const current = inserted.length
      ? await knex('service_product_usage').whereIn('id', inserted.map((item) => item.event.resource_id)).select('*').forUpdate()
      : [];
    const byId = new Map(current.map((row) => [String(row.id), row]));
    const editedOrGone = inserted.filter((item) => !holdsWritten(byId.get(String(item.event.resource_id)), item.row));
    if (editedOrGone.length) {
      console.log(`${LOG} "${serviceType}" usage: row ${editedOrGone[0].event.resource_id} changed or gone since up() wrote it: the service type is kept as it is`);
      continue;
    }
    const blocked = [];
    for (const item of removed) if (!(await canRestoreRow(knex, item.row))) blocked.push(item);
    if (blocked.length) {
      console.log(`${LOG} "${serviceType}" usage: old row ${blocked[0].event.resource_id} cannot go back (its id is taken or its product is gone): the service type is kept as it is`);
      continue;
    }
    for (const item of inserted) {
      await knex('service_product_usage').where({ id: item.event.resource_id, product_id: item.row.product_id }).del();
      await recordRollback(knex, STEPS.usage, item.event, 'service_product_usage');
    }
    for (const item of removed) {
      await knex('service_product_usage').insert(item.row);
      await recordRollback(knex, STEPS.usage, item.event, 'service_product_usage');
    }
  }
}

// ── step 2: services.default_products ────────────────────────────────────────

// One service-library row per key, each rewritten only while it holds the value its `decide` accepts (it returns the new list, or
// null to keep the row). The write is guarded by the value read (jsonb equality, or NULL), so a later edit is never overwritten.
async function rewriteServiceDefaults(knex, step, plans) {
  if (!(await hasTables(knex, ['services', 'audit_log']))) return;
  if (!(await knex.schema.hasColumn('services', 'default_products'))) return;
  for (const { key: serviceKey, decide } of plans) {
    const rows = await knex('services').where({ service_key: serviceKey }).select('id', 'name', 'default_products').forUpdate();
    if (rows.length !== 1) { console.log(`${LOG} ${rows.length} services have the key "${serviceKey}": kept`); continue; }
    const [service] = rows;
    const before = service.default_products == null ? null : asArray(service.default_products);
    const after = decide(before);
    if (!after) { console.log(`${LOG} service "${serviceKey}" default_products is not the value read on 2026-11-19: kept`); continue; }
    const where = before === null ? { id: service.id, default_products: null } : { id: service.id, default_products: JSON.stringify(before) };
    const changed = await knex('services').where(where).update({ default_products: JSON.stringify(after) });
    if (changed) await writeAudit(knex, actionFor(step), 'services', service.id, { service_key: serviceKey, service: service.name, before, after });
  }
}

async function swapServiceDefaults(knex) {
  await rewriteServiceDefaults(knex, STEPS.services, Object.entries(OLD_DEFAULTS).map(([key, expected]) => ({
    key,
    decide: (before) => ((expected === null ? before === null : sameList(before, expected)) ? NEW_DEFAULTS[key] : null),
  })));
}

// "Advion Gel" matches no catalog row: the one element becomes the live gel, in place.
async function swapRoachServiceGel(knex) {
  if (!(await hasTables(knex, ['products_catalog']))) return;
  if (!(await liveGelRow(knex))) return;
  await rewriteServiceDefaults(knex, STEPS.roachServices, ROACH_SERVICE_KEYS.map((key) => ({
    key,
    decide: (before) => {
      if (key === 'german_roach') return sameList(before, GERMAN_ROACH_BEFORE) ? GERMAN_ROACH_AFTER : null;
      if (!Array.isArray(before) || before.filter((item) => item === GEL_OLD_LIST_NAME).length !== 1 || before.includes(GEL_LIVE)) return null;
      return before.map((item) => (item === GEL_OLD_LIST_NAME ? GEL_LIVE : item));
    },
  })));
}

async function restoreServices(knex, step) {
  for (const event of await pendingEvents(knex, step)) {
    const { before, after } = asObject(event.metadata);
    if (!Array.isArray(after) || !(before === null || Array.isArray(before))) continue;
    const restored = await knex('services').where({ id: event.resource_id, default_products: JSON.stringify(after) })
      .update({ default_products: before === null ? null : JSON.stringify(before) });
    if (restored) await recordRollback(knex, step, event, 'services');
    else keptLog(`service ${event.resource_id} default_products`);
  }
}

// ── step 4 (and the lookup step 3 needs): the roach gel ──────────────────────

// The one ACTIVE catalog row of the live gel name, or null (logged).
async function liveGelRow(knex) {
  const rows = await knex('products_catalog').where({ name: GEL_LIVE, active: true }).select('id', 'name');
  if (rows.length === 1) return rows[0];
  console.log(`${LOG} ${rows.length} active catalog rows are named "${GEL_LIVE}": skipping the roach gel steps`);
  return null;
}

async function repointRoachUsage(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log', 'service_product_usage']))) return;
  const live = await liveGelRow(knex);
  if (!live) return;
  const olds = (await knex('products_catalog').where({ name: GEL_CATALOG_OLD }).select('id', 'active')).filter((row) => row.active === false);
  const gentrol = await knex('products_catalog').where({ name: GENTROL }).select('id');
  const oldIds = new Set(olds.map((row) => String(row.id)));
  const gentrolIds = new Set(gentrol.map((row) => String(row.id)));
  for (const serviceType of ROACH_USAGE_TYPES) {
    const rows = await knex('service_product_usage').where({ service_type: serviceType }).select('*').forUpdate();
    const alreadyLive = rows.some((row) => String(row.product_id) === String(live.id));
    for (const row of rows) {
      // The values read from production on 2026-11-19: 1 tube, no per-area rate, primary.
      const isOldGel = oldIds.has(String(row.product_id)) && sameNumber(row.usage_amount, 1) && row.usage_unit === 'tube'
        && row.usage_per_1000sf == null && row.is_primary === true;
      if (isOldGel && alreadyLive) { console.log(`${LOG} "${serviceType}" already maps the live gel: the old gel row ${row.id} is kept`); continue; }
      if (isOldGel) {
        const changed = await knex('service_product_usage').where({ id: row.id, product_id: row.product_id }).update({ product_id: live.id });
        if (changed) await writeAudit(knex, actionFor(STEPS.roachUsage), 'service_product_usage', row.id, { kind: 'repointed', service_type: serviceType, from: String(row.product_id), to: String(live.id) });
      } else if (gentrolIds.has(String(row.product_id)) && row.notes === GENTROL_NOTE_BEFORE) {
        const changed = await knex('service_product_usage').where({ id: row.id, notes: GENTROL_NOTE_BEFORE }).update({ notes: GENTROL_NOTE_AFTER });
        if (changed) await writeAudit(knex, actionFor(STEPS.roachUsage), 'service_product_usage', row.id, { kind: 'note', service_type: serviceType, before: GENTROL_NOTE_BEFORE, after: GENTROL_NOTE_AFTER });
      }
    }
  }
}

async function restoreRoachUsage(knex) {
  for (const event of await pendingEvents(knex, STEPS.roachUsage)) {
    const { kind, from, to, before, after } = asObject(event.metadata);
    let restored = 0;
    if (kind === 'repointed' && from && to && await productExists(knex, from)) {
      restored = await knex('service_product_usage').where({ id: event.resource_id, product_id: to }).update({ product_id: from });
    } else if (kind === 'note' && before && after) {
      restored = await knex('service_product_usage').where({ id: event.resource_id, notes: after }).update({ notes: before });
    }
    if (restored) await recordRollback(knex, STEPS.roachUsage, event, 'service_product_usage');
    else keptLog(`usage row ${event.resource_id}`);
  }
}

// ── migration ────────────────────────────────────────────────────────────────

exports.up = async function up(knex) {
  await swapUsage(knex);
  await swapServiceDefaults(knex);
  await swapRoachServiceGel(knex);
  await repointRoachUsage(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  if (await knex.schema.hasTable('service_product_usage')) await restoreUsage(knex);
  if (await knex.schema.hasTable('services')) {
    await restoreServices(knex, STEPS.services);
    await restoreServices(knex, STEPS.roachServices);
  }
  if (await knex.schema.hasTable('service_product_usage')) await restoreRoachUsage(knex);
};

exports.MIGRATION = MIGRATION;
exports.STEPS = STEPS;
exports.actionFor = actionFor;
exports.rollbackActionFor = rollbackActionFor;
exports.NEW_USAGE = NEW_USAGE;
exports.OLD_USAGE = OLD_USAGE;
exports.OLD_DEFAULTS = OLD_DEFAULTS;
exports.NEW_DEFAULTS = NEW_DEFAULTS;
exports.GEL_LIVE = GEL_LIVE;
