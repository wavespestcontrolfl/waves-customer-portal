/**
 * Summer micros must be 0-N: replace Chelated Iron Plus in Apr-Sep lawn
 * protocol windows and add the newly prescribed High Mn Combo lines.
 *
 * WHY. LESCO Chelated Iron Plus is 12-0-0 (quick-release urea N), so it counts as
 * nitrogen. The fertilizer-ordinance N blackout is Jun 1 - Sep 30 (North Port
 * Apr 1 - Sep 30). The operating-layer seeds put it in two Apr-Sep windows as a
 * default product (20260630000002_lawn_protocol_products_bzb):
 *
 *   zoysia  may_final_n          Chelated Iron Plus (default_in_plan)
 *   bahia   may_micros_crabgrass Chelated Iron Plus (default_in_plan, beside
 *                                a seeded Chelated AM + Micros row)
 *
 * server/config/protocols.json (the field-exec source) now prescribes a 0-N
 * micro in May instead: St. Augustine primary = High Mn Combo, Zoysia primary =
 * High Mn Combo, Bermuda secondary = High Mn Combo, Bahia primary = Chelated AM
 * + Micros only. This forward data-correction brings the structured layer
 * (buildLawnCompletionDefaults / Command Center / forecast) in line.
 * St. Augustine needs no SpeedZone removal here: the DB layer already blocks
 * SpeedZone there through the speedzone_cultivar_gate (Floratam, Bitterblue,
 * unknown/high-risk), and the St. Augustine seed carries no SpeedZone row.
 *
 * SCOPE. lawn_protocols with status active or draft (a draft is included so a
 * later publish cannot resurrect Iron Plus); their lawn_protocol_windows whose
 * window_key starts apr_ / may_ / jun_ / jul_ / aug_ / sep_. Archived protocols
 * and non-summer windows (Feb, Oct, Dec) are never touched. Only rows whose
 * product_name is Chelated Iron Plus are converted; admin-added rows are left.
 *
 * For each such window containing Chelated Iron Plus row(s), the target is
 * Chelated AM + Micros on the bahia track and High Mn Combo on every other track:
 *   - Window has NO target row: the first Iron Plus row is UPDATED IN PLACE to the
 *     target (same id, so lawn_protocol_product_actuals.protocol_product_id links
 *     survive). Its default_in_plan, sort_order, gates, annual_counter, mixing and
 *     report_copy are preserved; only the product identity and rate columns change.
 *   - Window ALREADY has a target row (the seeded bahia may_micros_crabgrass case),
 *     or there are additional Iron Plus rows: lawn_protocol_product_actuals
 *     .protocol_product_id is repointed from the Iron Plus row id to the retained
 *     target row id, THEN the Iron Plus row is deleted. lawn_protocol_product_actuals
 *     is the only table with a foreign key to lawn_protocol_products(id) in the
 *     migration history (its FK is ON DELETE SET NULL, which would silently drop
 *     the link, hence the explicit repoint first).
 *
 * INSERTS. Where protocols.json now prescribes a product but the seeded window
 * never had a row to convert, the row is inserted (only when that window has no
 * row of that product already):
 *   High Mn Combo (rate 0.1975 fl_oz, carrier 1, role micronutrients)
 *     st_augustine  may_final_n_or_zero_np  default_in_plan TRUE   (primary line)
 *     bermuda       may_final_n             default_in_plan FALSE  (secondary line)
 *   Celsius WG (spot, rate 0.057 oz, carrier 1, annual counter
 *   celsius_oz_per_1000; St. Augustine broadleaf is spot Celsius now that
 *   SpeedZone is off the track), default_in_plan FALSE, gates
 *   { trigger: broadleaf_present, noAdjuvantAboveF: 90, annualCounter }
 *     st_augustine  apr_insect_preventive
 *     st_augustine  sep_blackout_closeout
 * Columns/sort_order follow the B/Z/B seed (product_id resolved like the seed:
 * catalog name then product_aliases); sort_order is placed after the window's
 * existing rows.
 *
 * Idempotent: a second run finds no Iron Plus rows in those windows and the
 * target rows already exist.
 *
 * down() is a DOCUMENTED NO-OP. This is a data correction that preserves admin
 * edits; rolling it back must never rewrite rows it cannot prove it owns (a
 * converted row is indistinguishable from an admin-edited one, and Chelated Iron
 * Plus in a blackout window is the defect being fixed).
 */

const SUMMER_WINDOW_RE = /^(apr|may|jun|jul|aug|sep)_/;

const HIGH_MN = {
  name: 'High Mn Combo',
  role: 'micronutrients',
  rate: 0.1975,
  unit: 'fl_oz',
  carrier: 1,
};
const CHELATED_AM = {
  name: 'Chelated AM + Micros',
  role: 'micronutrients',
  rate: 2,
  unit: 'fl_oz',
  carrier: 1,
};

// St. Augustine broadleaf is now spot Celsius WG (SpeedZone is off the track).
// Rate/unit/carrier/role/annual counter mirror the B/Z/B seed's Celsius spot row.
const CELSIUS = {
  name: 'Celsius WG',
  role: 'post_emergent_spot',
  rate: 0.057,
  unit: 'oz',
  carrier: 1,
  annualCounter: 'celsius_oz_per_1000',
};

// New lines protocols.json prescribes with no seeded row to convert. Each is
// inserted only when its window has no row of that product yet.
const INSERTS = [
  { track: 'st_augustine', windowKey: 'may_final_n_or_zero_np', spec: HIGH_MN, defaultInPlan: true, gates: {} },
  { track: 'bermuda', windowKey: 'may_final_n', spec: HIGH_MN, defaultInPlan: false, gates: {} },
  // `trigger` is free text the pre-visit brief carries to the tech;
  // noAdjuvantAboveF is carried with the gate object and ignored by evaluators
  // (annualCounter in gates mirrors the seeds' Celsius rows).
  ...['apr_insect_preventive', 'sep_blackout_closeout'].map((windowKey) => ({
    track: 'st_augustine',
    windowKey,
    spec: CELSIUS,
    defaultInPlan: false,
    gates: { trigger: 'broadleaf_present', noAdjuvantAboveF: 90, annualCounter: CELSIUS.annualCounter },
  })),
];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Same matcher as the B/Z/B seed: catalog name first, then product_aliases.
async function loadMatcher(knex) {
  const catalog = await knex('products_catalog').select('id', 'name').catch(() => []);
  const aliases = await knex('product_aliases').select('product_id', 'alias_name').catch(() => []);
  return (name) => {
    const n = normalize(name);
    const m = catalog.find((c) => normalize(c.name).includes(n) || n.includes(normalize(c.name)));
    if (m) return m.id;
    const a = aliases.find((x) => normalize(x.alias_name) === n);
    return a ? a.product_id : null;
  };
}

function isIronPlus(name) {
  return /chelated iron plus/.test(normalize(name));
}

function bySortThenId(a, b) {
  return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    || String(a.id).localeCompare(String(b.id));
}

async function windowsOf(knex, protocols) {
  const out = [];
  for (const p of protocols) {
    const windows = await knex('lawn_protocol_windows')
      .where({ lawn_protocol_id: p.id })
      .select('id', 'window_key');
    for (const w of windows) out.push({ track: p.grass_track, windowId: w.id, windowKey: String(w.window_key || '') });
  }
  return out;
}

async function repointActuals(knex, hasActuals, fromId, toId) {
  if (!hasActuals) return;
  await knex('lawn_protocol_product_actuals')
    .where({ protocol_product_id: fromId })
    .update({ protocol_product_id: toId });
}

exports.up = async function up(knex) {
  for (const t of ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products']) {
    if (!(await knex.schema.hasTable(t))) return;
  }

  const hasActuals = (await knex.schema.hasTable('lawn_protocol_product_actuals'))
    && (await knex.schema.hasColumn('lawn_protocol_product_actuals', 'protocol_product_id'));
  const matchProductId = await loadMatcher(knex);
  const protocols = await knex('lawn_protocols').whereIn('status', ['active', 'draft']).select('id', 'grass_track');
  const windows = await windowsOf(knex, protocols);

  // 1. Convert / dedupe Chelated Iron Plus in Apr-Sep windows.
  for (const { track, windowId, windowKey } of windows) {
    if (!SUMMER_WINDOW_RE.test(windowKey)) continue;
    const rows = (await knex('lawn_protocol_products')
      .where({ lawn_protocol_window_id: windowId })
      .select('id', 'product_name', 'sort_order')).sort(bySortThenId);
    const ironRows = rows.filter((r) => isIronPlus(r.product_name));
    if (!ironRows.length) continue;

    const target = track === 'bahia' ? CHELATED_AM : HIGH_MN;
    const existing = rows.find((r) => normalize(r.product_name) === normalize(target.name));
    let retainedId;
    let toDelete;
    if (existing) {
      retainedId = existing.id;
      toDelete = ironRows;
    } else {
      const [first, ...rest] = ironRows;
      await knex('lawn_protocol_products')
        .where({ id: first.id })
        .update({
          product_name: target.name,
          role: target.role,
          application_mode: 'broadcast',
          rate_per_1000: target.rate,
          rate_unit: target.unit,
          carrier_gal_per_1000: target.carrier,
          product_id: matchProductId(target.name),
          updated_at: knex.fn.now(),
        });
      retainedId = first.id;
      toDelete = rest;
    }
    for (const r of toDelete) {
      await repointActuals(knex, hasActuals, r.id, retainedId);
      await knex('lawn_protocol_products').where({ id: r.id }).del();
    }
  }

  // 2. Insert the newly prescribed lines (only if the window lacks that product).
  for (const ins of INSERTS) {
    for (const w of windows) {
      if (w.track !== ins.track || w.windowKey !== ins.windowKey) continue;
      const { spec } = ins;
      const rows = await knex('lawn_protocol_products')
        .where({ lawn_protocol_window_id: w.windowId })
        .select('id', 'product_name', 'sort_order');
      if (rows.some((r) => normalize(r.product_name) === normalize(spec.name))) continue;
      const nextSort = rows.reduce((m, r) => Math.max(m, Number(r.sort_order) || 0), 0) + 1;
      await knex('lawn_protocol_products').insert({
        lawn_protocol_window_id: w.windowId,
        product_id: matchProductId(spec.name),
        product_name: spec.name,
        role: spec.role,
        application_mode: spec.role.includes('spot') ? 'spot' : 'broadcast',
        rate_per_1000: spec.rate,
        rate_unit: spec.unit,
        carrier_gal_per_1000: spec.carrier,
        default_in_plan: ins.defaultInPlan,
        gates: JSON.stringify(ins.gates),
        annual_counter: JSON.stringify(spec.annualCounter ? { counter: spec.annualCounter } : {}),
        mixing: JSON.stringify({}),
        report_copy: JSON.stringify({ role: spec.role }),
        sort_order: nextSort,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }
};

exports.down = async function down() {
  // Documented no-op: data correction that preserves admin edits. A converted or
  // inserted row cannot be proven to be this migration's (vs. an admin edit), and
  // restoring Chelated Iron Plus (12-0-0 N) into blackout-window defaults would
  // reintroduce the defect. up() is idempotent, so re-applying never duplicates.
};
