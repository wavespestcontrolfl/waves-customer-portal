/**
 * Chelated Iron Plus is LESCO 12-0-0 (quick-release urea N), so it counts as
 * nitrogen. It was seeded as a default product in two Apr-Sep operating-layer
 * windows, where the N blackout (Jun 1 - Sep 30; North Port Apr 1 - Sep 30)
 * would forbid it:
 *
 *   zoysia  may_final_n          Chelated Iron Plus (default_in_plan)
 *   bahia   may_micros_crabgrass Chelated Iron Plus (default_in_plan)
 *
 * (20260630000002_lawn_protocol_products_bzb). protocols.json (the field-exec
 * source) already swapped the May micro to a 0-N product in this PR:
 *   - St. Augustine / Zoysia / Bermuda May -> High Mn Combo
 *   - Bahia May -> Chelated AM + Micros only (bahia already carries that row)
 * so buildLawnCompletionDefaults could not match the new line and the
 * operating-layer SOP still showed Iron Plus. This forward migration brings the
 * structured layer in line (AGENTS.md "Lawn protocol data fan-out").
 *
 * Scope: every window whose window_key is apr_/may_/jun_/jul_/aug_/sep_* of the
 * active (and draft, so a later publish cannot resurrect it) protocol of each
 * track. A row is touched only when its product_name is Chelated Iron Plus;
 * admin-added or already-replaced rows are left alone.
 *   - non-bahia track: the row is UPDATED IN PLACE to High Mn Combo (same id, so
 *     completion-ledger FKs keep pointing at it); if the window already has a
 *     High Mn Combo row, the Iron Plus row is deleted instead.
 *   - bahia: the row is UPDATED IN PLACE to Chelated AM + Micros; if the window
 *     already has that row, the Iron Plus row is deleted instead.
 *
 * St. Augustine: the seed (20260529000003) has NO SpeedZone and NO Chelated Iron
 * Plus rows, and the DB layer already blocks SpeedZone there through
 * speedzone_cultivar_gate (Floratam, Bitterblue, unknown/high-risk), so nothing
 * is removed for St. Augustine.
 *
 * Idempotent: a second run finds no Iron Plus rows in those windows.
 * down() puts Chelated Iron Plus back ONLY where it can prove the row is the
 * replacement (High Mn Combo in a zoysia/bermuda May window, Chelated AM +
 * Micros in a bahia May window); it never recreates a deleted-because-duplicate
 * row.
 */

const SUMMER_WINDOW_RE = /^(apr|may|jun|jul|aug|sep)_/;

const IRON_PLUS = {
  name: 'Chelated Iron Plus',
  role: 'micronutrients',
  rate: 3.0,
  unit: 'fl_oz',
  carrier: 1,
};
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

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

async function summerWindows(knex) {
  const protocols = await knex('lawn_protocols').whereIn('status', ['active', 'draft']).select('id', 'grass_track');
  const out = [];
  for (const p of protocols) {
    const windows = await knex('lawn_protocol_windows')
      .where({ lawn_protocol_id: p.id })
      .select('id', 'window_key');
    for (const w of windows) {
      if (SUMMER_WINDOW_RE.test(String(w.window_key || ''))) {
        out.push({ track: p.grass_track, windowId: w.id });
      }
    }
  }
  return out;
}

function rowFor(spec, productId) {
  return {
    product_name: spec.name,
    role: spec.role,
    application_mode: 'broadcast',
    rate_per_1000: spec.rate,
    rate_unit: spec.unit,
    carrier_gal_per_1000: spec.carrier,
    gates: JSON.stringify({}),
    annual_counter: JSON.stringify({}),
    product_id: productId,
  };
}

exports.up = async function up(knex) {
  for (const t of ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products']) {
    if (!(await knex.schema.hasTable(t))) return;
  }

  const matchProductId = await loadMatcher(knex);

  for (const { track, windowId } of await summerWindows(knex)) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: windowId }).select('id', 'product_name');
    const ironRows = rows.filter((r) => isIronPlus(r.product_name));
    if (!ironRows.length) continue;

    const target = track === 'bahia' ? CHELATED_AM : HIGH_MN;
    const haveTarget = rows.some((r) => normalize(r.product_name) === normalize(target.name));
    let converted = haveTarget;

    for (const r of ironRows) {
      if (!converted) {
        await knex('lawn_protocol_products')
          .where({ id: r.id })
          .update({ ...rowFor(target, matchProductId(target.name)), updated_at: knex.fn.now() });
        converted = true; // later duplicates (if any) are deleted
      } else {
        await knex('lawn_protocol_products').where({ id: r.id }).del();
      }
    }
  }
};

exports.down = async function down(knex) {
  for (const t of ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products']) {
    if (!(await knex.schema.hasTable(t))) return;
  }

  const matchProductId = await loadMatcher(knex);

  // Only the two windows the seed put Iron Plus in; the replacement row is
  // converted back in place.
  const ORIGINAL = [
    { track: 'zoysia', windowKey: 'may_final_n', from: HIGH_MN, gates: {} },
    { track: 'bahia', windowKey: 'may_micros_crabgrass', from: CHELATED_AM, gates: { irrigatedOnly: false } },
  ];
  const protocols = await knex('lawn_protocols').whereIn('status', ['active', 'draft']).select('id', 'grass_track');
  for (const o of ORIGINAL) {
    for (const p of protocols.filter((x) => x.grass_track === o.track)) {
      const w = await knex('lawn_protocol_windows')
        .where({ lawn_protocol_id: p.id, window_key: o.windowKey })
        .first('id');
      if (!w) continue;
      const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: w.id }).select('id', 'product_name', 'gates');
      if (rows.some((r) => isIronPlus(r.product_name))) continue; // already original
      const repl = rows.find((r) => normalize(r.product_name) === normalize(o.from.name));
      if (!repl) continue;
      // Bahia's seed carried BOTH rows (Iron Plus plus Chelated AM + Micros), so
      // for bahia re-insert Iron Plus and keep the AM row; zoysia swaps back.
      if (o.track === 'bahia') {
        await knex('lawn_protocol_products').insert({
          ...rowFor(IRON_PLUS, matchProductId(IRON_PLUS.name)),
          gates: JSON.stringify(o.gates),
          default_in_plan: true,
          lawn_protocol_window_id: w.id,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        });
      } else {
        await knex('lawn_protocol_products')
          .where({ id: repl.id })
          .update({
            ...rowFor(IRON_PLUS, matchProductId(IRON_PLUS.name)),
            gates: JSON.stringify(parseJson(repl.gates, {})),
            updated_at: knex.fn.now(),
          });
      }
    }
  }
};
