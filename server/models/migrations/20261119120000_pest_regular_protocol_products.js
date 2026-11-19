/**
 * The regular general-pest protocol names the owner's products (owner ruling 2026-11-19: "lesco and taurus are in our general pest
 * control treatments, while gentrol and atticus antapex, what used to be alpine, should be for cockroach treatment").
 *
 * General pest = LESCO Crosscheck Plus + Taurus SC (+ LESCO 90/10 Nonionic Surfactant): the close-out house mix in
 * client/src/lib/pest-default-mix.js already says so. Cockroach treatment = Atticus Antapex WSG + Gentrol Complete EC3 + the live
 * Advion gel. The code change (server/config/protocols.json: pest visit 1 lineMeta hints; the roach gel name and the roach visit 2
 * bifenthrin hint) moves the protocol lines; this migration moves the data rows that still name the old products. Five steps, each
 * changing a row only while it holds the exact value read from production on 2026-11-19; any other value is skipped and logged, never
 * overwritten:
 *
 *   1. service_product_usage (the COGS mapping): "Quarterly Pest Control" and "Bi-Monthly Pest Control" each hold Atticus Antapex
 *      WSG 5 g (primary) + Demand CS 1.6 oz (primary); "General Pest Perimeter" holds Demand CS 1.6 oz (primary). A service type
 *      whose rows are exactly those becomes Taurus SC 4 fl_oz (primary) + LESCO Crosscheck Plus 4 fl_oz (primary) + LESCO 90/10
 *      Nonionic Surfactant 0.25 fl_oz (not primary), the amounts the close-out house mix carries. The old rows are removed whole into
 *      their audit events. No row is added under a key no reader looks up: the readers key on "Quarterly Pest Control" / "Pest
 *      Control" / "General Pest Perimeter" (admin-pricing-config.js, estimate-pricing-audit.js) and on one exact visit service_type
 *      (dry-time.js); a Monthly, Semiannual or One-Time pest row stays absent (production has none) until a reader needs it.
 *   2. services.default_products (jsonb array of product names): pest_general_quarterly and pest_general_semiannual hold ["Demand
 *      CS","Advion Gel","Gentrol Complete EC3"], pest_general_monthly and pest_general_bimonthly hold ["Demand CS","Advion Gel"],
 *      one_time_pest_control and pest_re_service hold NULL. Each becomes ["Taurus SC","LESCO Crosscheck Plus","LESCO 90/10 Nonionic
 *      Surfactant"].
 *   3. protocol_templates ext_gp_perim v1 (the one-tap "Complete - Protocol Performed" template): products Demand CS, "Alpine WSG" (the
 *      row since renamed Atticus Antapex WSG) and Advion WDG Granular (inactive in the catalog). An active template is immutable (the
 *      triggers of 20260514000003), so this adds v2 superseding v1, with LESCO Crosscheck Plus + Taurus SC on the exterior perimeter
 *      band, v1's areas, v1's actions less the three apply_* actions for the old products (plus two for the new ones), and v1's
 *      service_type aliases; then retires v1 (retired_by = the oldest active admin technician, which the trigger requires) and
 *      activates v2. Past completions keep pointing at v1, so their attestation text is unchanged.
 *   4. Roach services' default_products: "Advion Gel" matches no catalog row (the catalog's gel is "Advion Evolution Cockroach Gel
 *      Bait"; "Advion Cockroach Gel Bait" is inactive), so in cockroach_control, german_roach, vehicle_roach_addon and
 *      vehicle_german_roach that one element becomes the live name, in place. german_roach (["Advion Gel","Gentrol Complete EC3"])
 *      becomes ["Atticus Antapex WSG","Advion Evolution Cockroach Gel Bait","Gentrol Complete EC3"]. Needs exactly one active catalog
 *      row of the live name.
 *   5. Roach COGS rows: the 1-tube primary gel rows of "Cockroach Treatment" and "German Roach Cleanout" point at the inactive
 *      "Advion Cockroach Gel Bait" row; they are re-pointed to the live row. A Gentrol row whose note is exactly "Tank-mixed at 1
 *      oz/gal with the Alpine gallon" says "Antapex gallon" instead (the product was renamed). Gentrol's catalog default_rate is not
 *      touched.
 *
 * No price changes: none of the readers feeds a customer price (see the PR notes); the quote price comes from the pricing engine.
 *
 * Audit: every changed row writes one audit_log event through recordAuditEvent (action migration:<name>:<step>), the before and
 * after in its metadata. Up is idempotent: every write is guarded by the value it replaces, so a second run writes nothing. The rows
 * a step decides on are read FOR UPDATE (the migration runs in one transaction).
 *
 * Down restores exactly what up() recorded and nothing else, each item only while it still holds the value up() wrote (a value changed
 * since is kept and logged). audit_log is append-only: down() appends a :rollback event that names the up() event it reversed
 * (from_audit_id) and skips an event that already has one. A retired template cannot be re-activated (the trigger), so down()
 * retires v2 and adds v1-restored: v1's own content (products, areas, actions, aliases) as a new active version superseding v2.
 */
const MIGRATION = '20261119120000_pest_regular_protocol_products';
const LOG = '[pest-regular-protocol-products]';
const STEPS = { usage: 'usage', services: 'services', template: 'template', roachServices: 'roach_services', roachUsage: 'roach_usage' };
const actionFor = (step) => `migration:${MIGRATION}:${step}`;
const rollbackActionFor = (step) => `${actionFor(step)}:rollback`;

const TAURUS = 'Taurus SC';
const CROSSCHECK = 'LESCO Crosscheck Plus';
const SURFACTANT = 'LESCO 90/10 Nonionic Surfactant';
const ANTAPEX = 'Atticus Antapex WSG';
const DEMAND = 'Demand CS';

const HOUSE_MIX_NAMES = [TAURUS, CROSSCHECK, SURFACTANT];
const HOUSE_MIX_USAGE = [
  { product: TAURUS, amount: 4, unit: 'fl_oz', primary: true },
  { product: CROSSCHECK, amount: 4, unit: 'fl_oz', primary: true },
  { product: SURFACTANT, amount: 0.25, unit: 'fl_oz', primary: false },
];
const HOUSE_MIX_NOTE = 'Regular pest visit house mix (owner 2026-11-19); matches client/src/lib/pest-default-mix.js.';

const ANTAPEX_AND_DEMAND = [
  { product: ANTAPEX, amount: 5, unit: 'g', primary: true },
  { product: DEMAND, amount: 1.6, unit: 'oz', primary: true },
];
const OLD_USAGE = {
  'Quarterly Pest Control': ANTAPEX_AND_DEMAND,
  'Bi-Monthly Pest Control': ANTAPEX_AND_DEMAND,
  'General Pest Perimeter': [{ product: DEMAND, amount: 1.6, unit: 'oz', primary: true }],
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

const TEMPLATE_KEY = 'ext_gp_perim';
const OLD_VERSION = 'v1';
const NEW_VERSION = 'v2';
const RESTORED_VERSION = 'v1-restored';
const OLD_TEMPLATE_PRODUCTS = [DEMAND, 'Alpine WSG', 'Advion WDG Granular'];
const OLD_APPLY_ACTIONS = ['apply_demand_cs', 'apply_alpine_wsg', 'apply_advion_wdg'];
const NEW_TEMPLATE_PRODUCTS = [
  { name: CROSSCHECK, sort: 1 },
  { name: TAURUS, sort: 2 },
];
const NEW_APPLY_ACTIONS = [
  { key: 'apply_lesco_crosscheck_plus', label: `Applied insect control — ${CROSSCHECK}`, required: true, sort: 1 },
  { key: 'apply_taurus_sc', label: `Applied insect control — ${TAURUS}`, required: true, sort: 2 },
];
const NEW_TEMPLATE_NOTE = ` Products since 2026-11-19 (owner): ${CROSSCHECK} and ${TAURUS}; Atticus Antapex WSG and Gentrol are the cockroach-treatment products.`;

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

// Do these rows hold exactly the listed products, amounts, units and primary flags (and nothing else)?
function usageMatches(rows, names, expected) {
  if (rows.length !== expected.length) return false;
  const left = [...rows];
  for (const want of expected) {
    const at = left.findIndex((row) => names.get(String(row.product_id)) === want.product
      && Number(row.usage_amount) === want.amount
      && row.usage_unit === want.unit
      && Boolean(row.is_primary) === want.primary
      && !(Number(row.usage_per_1000sf) > 0));
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

async function swapUsage(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log', 'service_product_usage']))) return;
  const house = new Map();
  for (const name of HOUSE_MIX_NAMES) {
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
    for (const want of HOUSE_MIX_USAGE) {
      const values = {
        service_type: serviceType, product_id: house.get(want.product).id, usage_amount: want.amount, usage_unit: want.unit,
        usage_per_1000sf: null, is_primary: want.primary, notes: HOUSE_MIX_NOTE,
      };
      const [made] = await knex('service_product_usage').insert(values).returning('id');
      const id = made && typeof made === 'object' ? made.id : made;
      await writeAudit(knex, actionFor(STEPS.usage), 'service_product_usage', id, { kind: 'inserted', service_type: serviceType, row: { id, ...values } });
    }
  }
}

// Back only while nothing took its id and its product exists (the foreign key needs it).
async function restoreRow(knex, row) {
  if (!row || !row.id) return false;
  if (await knex('service_product_usage').where({ id: row.id }).first('id')) return false;
  if (!(await productExists(knex, row.product_id))) return false;
  await knex('service_product_usage').insert(row);
  return true;
}

async function restoreUsage(knex) {
  const events = await pendingEvents(knex, STEPS.usage);
  // A service type whose new rows were edited since keeps them, and so keeps its old rows out: both together would count twice.
  const blocked = new Set();
  for (const event of events) {
    const { kind, service_type: serviceType, row } = asObject(event.metadata);
    if (kind !== 'inserted' || !row) continue;
    const current = await knex('service_product_usage').where({ id: event.resource_id }).first('*');
    const unchanged = current && String(current.product_id) === String(row.product_id)
      && Number(current.usage_amount) === Number(row.usage_amount) && current.usage_unit === row.usage_unit
      && Boolean(current.is_primary) === Boolean(row.is_primary);
    const removed = unchanged ? await knex('service_product_usage').where({ id: event.resource_id, product_id: row.product_id }).del() : 0;
    if (removed) await recordRollback(knex, STEPS.usage, event, 'service_product_usage');
    else { blocked.add(serviceType); keptLog(`usage row ${event.resource_id}`); }
  }
  for (const event of events) {
    const { kind, service_type: serviceType, row } = asObject(event.metadata);
    if (kind !== 'removed') continue;
    if (blocked.has(serviceType)) { console.log(`${LOG} usage row ${event.resource_id} stays out: "${serviceType}" keeps edited rows`); continue; }
    if (await restoreRow(knex, row)) await recordRollback(knex, STEPS.usage, event, 'service_product_usage');
    else console.log(`${LOG} usage row ${event.resource_id} cannot go back (its id is taken or its product is gone): kept out`);
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
    decide: (before) => ((expected === null ? before === null : sameList(before, expected)) ? HOUSE_MIX_NAMES : null),
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

// ── step 5 (and the lookup step 4 needs): the roach gel ──────────────────────

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
      const isOldGel = oldIds.has(String(row.product_id)) && Number(row.usage_amount) === 1 && Boolean(row.is_primary);
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

// ── step 3: protocol template ext_gp_perim ───────────────────────────────────

// retired_by is required by the retire trigger (20260514000003): the oldest active admin.
async function retiringTechnician(knex) {
  if (!(await knex.schema.hasTable('technicians'))) return null;
  const tech = await knex('technicians').where({ role: 'admin', active: true }).orderBy('created_at', 'asc').orderBy('id', 'asc').first('id');
  return tech ? tech.id : null;
}

async function templateChildren(knex, templateId) {
  const [products, areas, actions, aliases] = await Promise.all([
    knex('protocol_template_products').where({ protocol_template_id: templateId }).orderBy('sort_order', 'asc').select('*'),
    knex('protocol_template_areas').where({ protocol_template_id: templateId }).orderBy('sort_order', 'asc').select('*'),
    knex('protocol_template_actions').where({ protocol_template_id: templateId }).orderBy('sort_order', 'asc').select('*'),
    knex('protocol_template_service_types').where({ protocol_template_id: templateId }).select('*'),
  ]);
  return { products, areas, actions, aliases };
}

/**
 * Retires `from` and activates a new version that supersedes it: draft parent, children, aliases, then the two legal transitions
 * (the immutability triggers allow nothing else). `products` and `actions` are the new version's child rows (sans parent id).
 */
async function supersedeTemplate(knex, from, { version, notes, products, actions, areas, aliases, retiredBy }) {
  const [parent] = await knex('protocol_templates').insert({
    protocol_key: from.protocol_key, version, supersedes_protocol_template_id: from.id,
    display_name: from.display_name, service_type: from.service_type, service_line: from.service_line,
    is_deterministic: from.is_deterministic, status: 'draft',
    attestation_template: from.attestation_template, attestation_template_version: from.attestation_template_version,
    notes,
  }).returning('*');
  const parentId = parent.id;
  await knex('protocol_template_products').insert(products.map((row) => ({ ...row, protocol_template_id: parentId })));
  if (areas.length) await knex('protocol_template_areas').insert(areas.map((row) => ({ ...row, protocol_template_id: parentId })));
  if (actions.length) await knex('protocol_template_actions').insert(actions.map((row) => ({ ...row, protocol_template_id: parentId })));
  if (aliases.length) await knex('protocol_template_service_types').insert(aliases.map((row) => ({ ...row, protocol_template_id: parentId })));
  // One active version per key: v1 retires first (status, retired_at, retired_by and effective_to are the only columns it may change).
  await knex('protocol_templates').where({ id: from.id, status: 'active' })
    .update({ status: 'retired', retired_at: knex.fn.now(), retired_by: retiredBy, effective_to: knex.fn.now() });
  await knex('protocol_templates').where({ id: parentId, status: 'draft' })
    .update({ status: 'active', effective_from: knex.fn.now(), activated_at: knex.fn.now() });
  return parentId;
}

const TEMPLATE_TABLES = ['protocol_templates', 'protocol_template_products', 'protocol_template_areas', 'protocol_template_actions', 'protocol_template_service_types', 'products_catalog', 'audit_log'];
// What a child row is, minus the columns a new row gets of its own.
const childValues = (row) => {
  const rest = { ...row };
  for (const column of ['id', 'protocol_template_id', 'created_at', 'updated_at']) delete rest[column];
  return rest;
};

async function supersedeGeneralPestTemplate(knex) {
  if (!(await hasTables(knex, TEMPLATE_TABLES))) return;
  const versions = await knex('protocol_templates').where({ protocol_key: TEMPLATE_KEY }).select('*').forUpdate();
  const old = versions.find((row) => row.version === OLD_VERSION);
  if (!old || old.status !== 'active' || !old.is_deterministic || versions.length !== 1) {
    console.log(`${LOG} ${TEMPLATE_KEY} is not the single active ${OLD_VERSION} read on 2026-11-19 (${versions.map((row) => `${row.version}:${row.status}`).join(', ') || 'none'}): kept`);
    return;
  }
  const kids = await templateChildren(knex, old.id);
  const held = kids.products.map((row) => row.product_name_snapshot);
  if (held.length !== OLD_TEMPLATE_PRODUCTS.length || !OLD_TEMPLATE_PRODUCTS.every((name) => held.includes(name))) {
    console.log(`${LOG} ${TEMPLATE_KEY} ${OLD_VERSION} products are not the ones read on 2026-11-19 (${held.join(', ')}): kept`);
    return;
  }
  const catalog = [];
  for (const want of NEW_TEMPLATE_PRODUCTS) {
    const row = await onlyCatalogRow(knex, want.name);
    if (!row) return;
    catalog.push({ ...want, productId: row.id });
  }
  const retiredBy = await retiringTechnician(knex);
  if (!retiredBy) { console.log(`${LOG} no active admin technician to retire ${TEMPLATE_KEY} ${OLD_VERSION} (the trigger needs one): kept`); return; }
  // v1's shape: label-compliant defaults, no rate, the perimeter band.
  const method = (kids.products.find((row) => row.product_name_snapshot === DEMAND) || kids.products[0]).application_method;
  const products = catalog.map((want) => ({
    product_id: want.productId, product_name_snapshot: want.name, rate_basis: 'label_compliant_default', rate: null, rate_unit: null,
    application_method: method || 'exterior perimeter band', sort_order: want.sort,
  }));
  const actions = [
    ...NEW_APPLY_ACTIONS.map((a) => ({ action_key: a.key, action_label: a.label, required: a.required, sort_order: a.sort })),
    ...kids.actions.filter((row) => !OLD_APPLY_ACTIONS.includes(row.action_key)).map(childValues),
  ];
  const newId = await supersedeTemplate(knex, old, {
    version: NEW_VERSION, notes: `${old.notes || ''}${NEW_TEMPLATE_NOTE}`.trim(), products, actions,
    areas: kids.areas.map(childValues), aliases: kids.aliases.map(childValues), retiredBy,
  });
  await writeAudit(knex, actionFor(STEPS.template), 'protocol_templates', newId, {
    kind: 'superseded', protocol_key: TEMPLATE_KEY, from: String(old.id), from_version: OLD_VERSION, to_version: NEW_VERSION,
    from_products: held, to_products: NEW_TEMPLATE_PRODUCTS.map((want) => want.name), retired_by: String(retiredBy),
  });
}

async function restoreTemplate(knex) {
  if (!(await hasTables(knex, TEMPLATE_TABLES))) return;
  for (const event of await pendingEvents(knex, STEPS.template)) {
    const { from, protocol_key: key } = asObject(event.metadata);
    const current = await knex('protocol_templates').where({ id: event.resource_id }).first('*');
    const previous = from ? await knex('protocol_templates').where({ id: from }).first('*') : null;
    const taken = key ? await knex('protocol_templates').where({ protocol_key: key, version: RESTORED_VERSION }).first('id') : null;
    const retiredBy = await retiringTechnician(knex);
    if (!current || current.status !== 'active' || !previous || previous.status !== 'retired' || taken || !retiredBy) {
      keptLog(`protocol template ${event.resource_id}`);
      continue;
    }
    // A retired row cannot be re-activated: v1's own content comes back as a new version.
    const kids = await templateChildren(knex, previous.id);
    const restoredId = await supersedeTemplate(knex, current, {
      version: RESTORED_VERSION, notes: previous.notes,
      products: kids.products.map(childValues), actions: kids.actions.map(childValues), areas: kids.areas.map(childValues),
      aliases: kids.aliases.map(childValues), retiredBy,
    });
    await recordRollback(knex, STEPS.template, event, 'protocol_templates', { restored_template: String(restoredId), restored_version: RESTORED_VERSION });
  }
}

// ── migration ────────────────────────────────────────────────────────────────

exports.up = async function up(knex) {
  await swapUsage(knex);
  await swapServiceDefaults(knex);
  await supersedeGeneralPestTemplate(knex);
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
  await restoreTemplate(knex);
  if (await knex.schema.hasTable('service_product_usage')) await restoreRoachUsage(knex);
};

exports.MIGRATION = MIGRATION;
exports.STEPS = STEPS;
exports.actionFor = actionFor;
exports.rollbackActionFor = rollbackActionFor;
exports.HOUSE_MIX_NAMES = HOUSE_MIX_NAMES;
exports.HOUSE_MIX_USAGE = HOUSE_MIX_USAGE;
exports.OLD_USAGE = OLD_USAGE;
exports.OLD_DEFAULTS = OLD_DEFAULTS;
exports.GEL_LIVE = GEL_LIVE;
