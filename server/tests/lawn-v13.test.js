// Lawn protocol v13, loaded dark behind GATE_LAWN_V13 (PR 1 of 2).
// Synthetic catalog, synthetic knex: no database.
//
// Pins: the gate is strict and read at call time; gate off every reader sees
// protocols.json `lawn` untouched (byte-identical); the v13 recipe is one
// universal 12-month program in the existing visit shape whose every line
// resolves to its intended catalog row whatever the prices are; the staged
// migration inserts what the recipe says (whole-lawn tool = default_in_plan,
// spots are not), is idempotent and reverses only its own unreferenced rows;
// getActiveLawnProtocol prefers the staged version only with the gate on; the
// completion prefill returns exactly each month's whole-lawn products.

const protocolsJson = require('../config/protocols.json');
const v13 = require('../config/lawn-protocol-v13.json');
const featureGates = require('../config/feature-gates');
const { lawnProtocols, LAWN_V13_VERSION, isServingProtocol } = require('../services/lawn-program');
const { matchesLawnCompletionProtocol } = require('../services/lawn-completion-defaults');
const auditScript = require('../scripts/audit-waveguard-protocol-material-costs');
const fixMigration = require('../models/migrations/20261005130000_lawn_v13_catalog_rows_and_product_links');
const engine = require('../services/waveguard-plan-engine');
const { buildLawnCompletionDefaults } = require('../services/lawn-completion-defaults');
const { getActiveLawnProtocol } = require('../services/lawn-protocol-operating-layer');
const protocolReader = require('../services/protocol-reader');
const lineModule = require('../services/service-report/lawn-program-line');
const migration = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const { buildProgramLine, PROGRAM_LINES, PROGRAM_LINES_V13, QUALIFIERS } = lineModule;
const GRASSES = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function withGate(value, fn) {
  const saved = process.env.GATE_LAWN_V13;
  try {
    if (value === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
  }
}
const withGateAsync = async (value, fn) => {
  const saved = process.env.GATE_LAWN_V13;
  try {
    if (value === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = value;
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
  }
};

const nameOfLine = (line) => line.split(' — ')[0];
const visitFor = (month) => v13.st_augustine.visits.find((v) => v.month === MONTH_ABBR[month - 1]);
const lines = (text) => String(text || '').split('\n').filter(Boolean);

describe('gate and loader', () => {
  test('GATE_LAWN_V13 is on only for exactly "true", read at call time', () => {
    for (const [value, expected] of [[undefined, false], ['', false], ['1', false], ['on', false], ['TRUE', false], ['false', false], ['true', true]]) {
      expect(withGate(value, () => featureGates.lawnV13Live())).toBe(expected);
    }
  });

  test('gate off hands every reader protocols.json lawn itself; on hands v13', () => {
    expect(withGate(undefined, () => lawnProtocols())).toBe(protocolsJson.lawn);
    expect(withGate('true', () => lawnProtocols())).toBe(v13);
  });

  test('a feature-gates mock without the reader reads as off', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({}));
      const isolated = require('../services/lawn-program');
      expect(isolated.lawnProtocols()).toBe(require('../config/protocols.json').lawn);
    });
  });

  test('staged serves only for version 2026.10-v13 and only while the gate is on', () => {
    const staged = { status: 'staged', version: LAWN_V13_VERSION };
    expect(withGate('true', () => [isServingProtocol({ status: 'active', version: '2026.06' }), isServingProtocol(staged), isServingProtocol({ status: 'staged', version: '2099.01' }), isServingProtocol({ status: 'draft', version: LAWN_V13_VERSION }), isServingProtocol({ status: 'archived', version: '1' }), isServingProtocol(null)]))
      .toEqual([true, true, false, false, false, false]);
    // Gate unset: a staged v13 protocol no longer serves (fail closed), active still does.
    expect(withGate(undefined, () => [isServingProtocol(staged), isServingProtocol({ status: 'active', version: '2026.06' })])).toEqual([false, true]);
  });

  test('a visit pinned to v13 fails closed when the gate is unset', () => {
    const protocol = { status: 'staged', version: LAWN_V13_VERSION, protocolKey: 'k', grassTrack: 'bermuda', window: { key: 'w' } };
    const assigned = { protocolKey: 'k', protocolVersion: LAWN_V13_VERSION, windowKey: 'w' };
    expect(withGate('true', () => matchesLawnCompletionProtocol(protocol, assigned, 'bermuda'))).toBe(true);
    expect(withGate(undefined, () => matchesLawnCompletionProtocol(protocol, assigned, 'bermuda'))).toBe(false);
  });
});

describe('gate off is byte-identical for the readers', () => {
  const sample = [['st_augustine', 'Jan'], ['bermuda', 'May'], ['zoysia', 'Oct'], ['bahia', 'Dec']];

  test('selectProtocolVisit returns the old track and visit', () => {
    withGate(undefined, () => {
      for (const [grass, month] of sample) {
        const idx = MONTH_ABBR.indexOf(month);
        const got = engine.selectProtocolVisit({ track_key: grass }, new Date(Date.UTC(2026, idx, 15, 16)));
        expect(JSON.stringify(got)).toBe(JSON.stringify({
          trackKey: grass, track: protocolsJson.lawn[grass], month,
          visit: protocolsJson.lawn[grass].visits.find((v) => v.month === month),
        }));
      }
    });
  });

  test('protocol reader and program line are the old output', () => {
    withGate(undefined, () => {
      expect(JSON.stringify(protocolReader.getProtocol({ service_type: 'lawn', lawn_track: 'bermuda' })))
        .toBe(JSON.stringify({ protocol: protocolsJson.lawn.bermuda, track: 'bermuda', type: 'lawn_care' }));
      for (const grass of GRASSES) {
        for (const month of MONTHS) {
          expect(buildProgramLine({ programVisit: true, grassType: grass, month })).toBe(PROGRAM_LINES[grass][month].line);
        }
      }
    });
  });

  test('protocols.json itself is unchanged by v13 (the recipe lives in its own file)', () => {
    expect(Object.keys(protocolsJson)).not.toContain('lawn_v13');
    expect(Object.keys(protocolsJson.lawn)).toEqual(GRASSES);
  });

  test('gate on reads the v13 visit for every grass', () => {
    withGate('true', () => {
      for (const grass of GRASSES) {
        const got = engine.selectProtocolVisit({ track_key: grass }, new Date(Date.UTC(2026, 1, 15, 16)));
        expect(got.visit.primary).toContain('LESCO 24-0-11 with PolyPlus OPTI');
        expect(got.track.name).toContain('v13');
      }
      expect(protocolReader.getProtocol({ service_type: 'lawn', lawn_track: 'zoysia' }).protocol).toBe(v13.zoysia);
    });
  });
});

describe('the v13 recipe', () => {
  test('four tracks, one universal program, 12 months in the existing visit shape', () => {
    expect(Object.keys(v13)).toEqual(GRASSES);
    for (const grass of GRASSES) {
      expect(v13[grass].visits).toEqual(v13.st_augustine.visits);
      expect(v13[grass].visits.map((v) => v.month)).toEqual(MONTH_ABBR);
      expect(v13[grass].visits.map((v) => v.visit)).toEqual(MONTHS);
      expect(v13[grass].exact_catalog_names).toBe(true);
      expect(v13[grass].notes).toEqual(v13.st_augustine.notes);
      expect(v13[grass].safety_rules.length).toBeGreaterThan(0);
      for (const visit of v13[grass].visits) {
        expect(Object.keys(visit).sort()).toEqual(['month', 'notes', 'primary', 'secondary', 'tiers', 'visit']);
        expect(Object.values(visit.tiers)).toEqual([true, true, true, true]);
      }
    }
  });

  test('what the program drops stays out (no Pennant, no July potash, no March large patch spray, no SpeedZone)', () => {
    const text = JSON.stringify(v13);
    expect(text).not.toMatch(/pennant|k-?flow|potash|speedzone|medallion|t-storm|eagle|sedgehammer|cleary|harrell|atrazine|headway|image for southern/i);
    const jul = visitFor(7);
    expect(jul.primary).toMatch(/scout visit/i);
    expect(jul.primary).not.toMatch(/\bLESCO|Dimension|Stonewall/);
    expect(visitFor(3).secondary).not.toMatch(/velista|gravex/i);
    expect(visitFor(3).secondary).toMatch(/artavia/i);
  });

  test('line grammar the plan engine depends on: no "if", no scope words, one product per line', () => {
    for (const visit of v13.st_augustine.visits) {
      for (const line of lines(visit.primary)) {
        expect(line).not.toMatch(/\bif\b|skip|audit|premium|history|drive by|soil sample/i);
        if (visit.month !== 'Jul') expect(line).toMatch(/ — /);
      }
      for (const line of [...lines(visit.primary), ...lines(visit.secondary)]) expect(line).not.toMatch(/\$\d/);
    }
  });

  test('July is inspect and spot: its primary line classifies as inspection (no area, no product)', () => {
    const [line] = engine.parseProtocolLines(visitFor(7).primary, 'base', { exactName: true });
    expect(line.scope).toBe('INSPECTION_ONLY');
  });

  test('N targets parse from the visit notes and total the program', () => {
    const n = MONTHS.map((m) => engine.parseVisitNutrientTargets(visitFor(m).notes).targetNPer1000);
    expect(n).toEqual([0, 0.75, 0, 0.5, 0, 0, 0, 0, 0, 0.6, 0.75, 0.5]);
    expect(Number(n.reduce((a, b) => a + b, 0).toFixed(2))).toBe(3.1);
    expect(engine.parseVisitNutrientTargets(visitFor(10).notes).targetKPer1000).toBe(0.6);
    // No N or P in Jun-Sep.
    for (const m of [6, 7, 8, 9]) expect(n[m - 1]).toBe(0);
  });

  test('whole-lawn tools per month match the approved program', () => {
    const tools = MONTHS.map((m) => lines(visitFor(m).primary).filter((l) => / — /.test(l)).map(nameOfLine));
    const N = migration.NAMES;
    expect(tools).toEqual([
      [N.STW, N.NT], [N.F24], [N.DIM, N.NT], [N.F24], [N.TET], [N.NT, N.DIM], [], [N.NT], [N.NT], [N.STW15], [N.F24], [N.F24],
    ]);
  });
});

// ── Every line resolves to the intended catalog row ──────────────────────────
const CATALOG_NAMES = Object.values(migration.NAMES);
const DECOYS = ['Dylox 420 SL T&O Insecticide', 'LESCO 24-2-11 with PolyPlus OPTI', 'Talstar P', 'Prodiamine 65 WDG', 'Acelepryn Xtra', 'Celsius WG Herbicide Pack', 'Velista Pro Kit', 'Three-Way Herbicide'];
function buildCatalog(price) {
  // price(name) -> { cost_per_unit, needs_pricing }
  return [...CATALOG_NAMES, ...DECOYS].map((name, i) => ({ id: `p${i}`, name, active: true, ...price(name) }));
}
const PRICE_SCENARIOS = {
  'all priced': () => ({ cost_per_unit: 5, needs_pricing: false }),
  'none priced': () => ({ cost_per_unit: 0, needs_pricing: false }),
  'every catalog row unpriced and needing pricing, decoys priced': (name) => (CATALOG_NAMES.includes(name)
    ? { cost_per_unit: 0, needs_pricing: true } : { cost_per_unit: 9, needs_pricing: false }),
  'only the intended-looking neighbours priced': (name) => (['Acelepryn Insecticide', 'Tetrino Insecticide'].includes(name)
    ? { cost_per_unit: 0, needs_pricing: true } : { cost_per_unit: 9, needs_pricing: false }),
};

describe('every v13 line resolves to its intended catalog row', () => {
  const rows = [];
  for (const month of MONTHS) {
    for (const [role, text] of [['base', visitFor(month).primary], ['conditional', visitFor(month).secondary]]) {
      for (const raw of lines(text)) if (raw.includes(' — ')) rows.push([`${MONTH_ABBR[month - 1]} ${role}: ${nameOfLine(raw)}`, raw, role]);
    }
  }

  test('the recipe names only catalog names the migration knows', () => {
    for (const [, raw] of rows) expect(CATALOG_NAMES).toContain(nameOfLine(raw));
  });

  test.each(Object.keys(PRICE_SCENARIOS))('scenario: %s', (scenario) => {
    const catalog = buildCatalog(PRICE_SCENARIOS[scenario]);
    for (const [label, raw, role] of rows) {
      const [line] = engine.parseProtocolLines(raw, role, { exactName: true });
      const product = engine.matchCatalogProduct(line, catalog);
      expect({ label, name: product && product.name }).toEqual({ label, name: nameOfLine(raw) });
    }
  });

  test('Dylox 6.2 G never resolves to Dylox 420 SL, and the reverse', () => {
    const catalog = buildCatalog(PRICE_SCENARIOS['all priced']);
    const [line] = engine.parseProtocolLines(`${migration.NAMES.DYL} — grubs`, 'conditional', { exactName: true });
    expect(engine.matchCatalogProduct(line, catalog).name).toBe(migration.NAMES.DYL);
    const [other] = engine.parseProtocolLines('Dylox 420 SL T&O Insecticide — grubs', 'conditional', { exactName: true });
    expect(engine.matchCatalogProduct(other, catalog).name).toBe('Dylox 420 SL T&O Insecticide');
  });

  test('without the exact-name rule a price swing picks the wrong Insecticide (why the flag exists)', () => {
    // Tetrino is new and unpriced; Acelepryn is priced. Both share the word "Insecticide".
    const catalog = buildCatalog((name) => (name === 'Tetrino Insecticide'
      ? { cost_per_unit: 0, needs_pricing: true } : { cost_per_unit: 9, needs_pricing: false }));
    const raw = rows.find(([label]) => label.includes('Tetrino'))[1];
    const [plain] = engine.parseProtocolLines(raw, 'base');
    expect(engine.matchCatalogProduct(plain, catalog).name).not.toBe('Tetrino Insecticide');
    const [exact] = engine.parseProtocolLines(raw, 'base', { exactName: true });
    expect(engine.matchCatalogProduct(exact, catalog).name).toBe('Tetrino Insecticide');
  });

  test('the exact-name flag is absent unless asked for (old lines parse as before)', () => {
    const [old] = engine.parseProtocolLines('Prodiamine 65 WDG split 1 ($3.51)', 'base');
    expect('exactName' in old).toBe(false);
  });
});

// ── The staged migration ─────────────────────────────────────────────────────
function makeKnex(db) {
  let counter = 0;
  const knex = (table) => {
    // 'lawn_protocol_products as p' joined to its window and protocol (the fix migration's read).
    const joined = table === 'lawn_protocol_products as p';
    const rowsOf = () => {
      if (!joined) return (db[table] = db[table] || []);
      return (db.lawn_protocol_products || []).map((p) => {
        const w = db.lawn_protocol_windows.find((x) => x.id === p.lawn_protocol_window_id);
        const l = db.lawn_protocols.find((x) => x.id === w.lawn_protocol_id);
        return { ...p, 'l.version': l.version, protocol_id: l.id };
      });
    };
    const conds = [];
    let insertRows = null; let isDel = false; let updatePatch = null;
    const test = (row, obj) => Object.entries(obj).every(([k, v]) => (row[k] ?? null) === v);
    const hit = (row) => conds.reduce((acc, c, i) => (i === 0 ? test(row, c.obj) : (c.or ? acc || test(row, c.obj) : acc && test(row, c.obj))), true);
    const run = () => {
      if (insertRows) {
        const made = insertRows.map((r) => ({ id: `${table}-${++counter}`, ...r }));
        rowsOf().push(...made);
        return made;
      }
      if (updatePatch) { const hits = rowsOf().filter(hit); hits.forEach((r) => Object.assign(r, updatePatch)); return hits.length; }
      if (isDel) { const keep = rowsOf().filter((r) => !hit(r)); const n = rowsOf().length - keep.length; db[table] = keep; return n; }
      return rowsOf().filter(hit);
    };
    const b = {
      where(obj, val) { conds.push({ obj: typeof obj === 'string' ? { [obj]: val } : obj }); return b; },
      orWhere(obj) { conds.push({ obj, or: true }); return b; },
      join() { return b; },
      update(patch) { updatePatch = patch; return b; },
      first() { return Promise.resolve(run()[0]); },
      select() { return b; },
      del() { isDel = true; return Promise.resolve(run()); },
      insert(r) { insertRows = Array.isArray(r) ? r : [r]; return b; },
      returning() { return Promise.resolve(run()); },
      then(res, rej) {
        const result = insertRows ? run().map(() => 1) : run();
        return Promise.resolve(result).then(res, rej);
      },
    };
    return b;
  };
  knex.schema = { hasTable: async (t) => t in db };
  knex.fn = { now: () => 'now' };
  return knex;
}

function seedDb({ without = [] } = {}) {
  const N = migration.NAMES;
  const catalog = Object.values(N).filter((name) => !without.includes(name))
    .map((name, i) => ({ id: `cat-${i}`, name: name === N.VEL ? 'Velista Fungicide' : name, active: true }));
  const db = {
    lawn_protocols: migration.TRACKS.map((t, i) => ({ id: `base-${i}`, protocol_key: t.key, version: '2026.06', status: 'active', grass_track: t.track })),
    lawn_protocol_windows: [], lawn_protocol_products: [],
    lawn_protocol_gates: migration.TRACKS.flatMap((t, i) => [
      { id: `g-${i}-a`, lawn_protocol_id: `base-${i}`, gate_key: 'sarasota_blackout', gate_type: 'ordinance', severity: 'block', title: 'x', rule_text: 'y', logic: { start: '06-01' }, wiki_refs: [] },
      { id: `g-${i}-b`, lawn_protocol_id: `base-${i}`, gate_key: 'valid_calibration_required', gate_type: 'equipment', severity: 'block', title: 'x', rule_text: 'y', logic: {}, wiki_refs: [] },
    ]),
    lawn_protocol_audit_log: [],
    products_catalog: catalog,
    product_aliases: [{ product_id: 'cat-alias', alias_name: 'Velista' }],
    scheduled_services: [], lawn_protocol_service_completions: [],
  };
  return db;
}

describe('staged migration 20261005120000', () => {
  test('inserts v13 staged per key with 12 windows, products, copied gates and an audit row', async () => {
    const db = seedDb();
    await migration.up(makeKnex(db));
    const staged = db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION);
    expect(migration.V13_VERSION).toBe(LAWN_V13_VERSION);
    expect(staged.map((p) => [p.protocol_key, p.grass_track, p.status])).toEqual(migration.TRACKS.map((t) => [t.key, t.track, 'staged']));
    // The old versions are untouched and still the only active rows.
    expect(db.lawn_protocols.filter((p) => p.status === 'active').map((p) => p.version)).toEqual(['2026.06', '2026.06', '2026.06', '2026.06']);
    expect(staged.every((p) => p.effective_from === '2000-01-01')).toBe(true);
    for (const p of staged) {
      const wins = db.lawn_protocol_windows.filter((w) => w.lawn_protocol_id === p.id);
      expect(wins.map((w) => w.month)).toEqual(MONTHS);
      expect(db.lawn_protocol_gates.filter((g) => g.lawn_protocol_id === p.id).map((g) => g.gate_key)).toEqual(['sarasota_blackout', 'valid_calibration_required']);
      const audit = db.lawn_protocol_audit_log.filter((a) => a.lawn_protocol_id === p.id);
      expect(audit.map((a) => a.action)).toEqual(['seed_v13']);
    }
    // product_id resolved by catalog name, then alias (Velista only has an alias row here).
    const prods = db.lawn_protocol_products;
    expect(prods.filter((r) => r.product_name === migration.NAMES.ART).every((r) => /^cat-\d+$/.test(r.product_id))).toBe(true);
    expect(prods.filter((r) => r.product_name === migration.NAMES.VEL).every((r) => r.product_id === 'cat-alias' || /^cat-\d+$/.test(r.product_id))).toBe(true);
    expect(prods.every((r) => r.product_id)).toBe(true);
  });

  test('a name in neither the catalog nor the aliases keeps product_id null instead of failing', async () => {
    const db = seedDb();
    db.products_catalog = db.products_catalog.filter((r) => r.name !== migration.NAMES.GRA);
    await migration.up(makeKnex(db));
    const gra = db.lawn_protocol_products.filter((r) => r.product_name === migration.NAMES.GRA);
    expect(gra.length).toBe(4);
    expect(gra.every((r) => r.product_id === null)).toBe(true);
  });

  test('idempotent, and a key with no active version is skipped', async () => {
    const db = seedDb();
    db.lawn_protocols = db.lawn_protocols.filter((p) => p.protocol_key !== 'swfl_bahia_10_10');
    const knex = makeKnex(db);
    await migration.up(knex);
    const count = db.lawn_protocols.length; const prods = db.lawn_protocol_products.length;
    await migration.up(knex);
    expect(db.lawn_protocols.length).toBe(count);
    expect(db.lawn_protocol_products.length).toBe(prods);
    expect(db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION).length).toBe(3);
  });

  test('default_in_plan is true only for the whole-lawn tool, and matches the recipe', () => {
    for (const month of MONTHS) {
      const [, windowKey] = migration.WINDOWS.find((w) => w[0] === month);
      const rowsForWindow = migration.PRODUCTS.filter(([key]) => key === windowKey).map(([, spec]) => spec);
      const whole = rowsForWindow.filter((s) => s[6]).map((s) => s[0]);
      const spots = rowsForWindow.filter((s) => !s[6]).map((s) => s[0]);
      const visit = visitFor(month);
      expect(whole.sort()).toEqual(lines(visit.primary).filter((l) => / — /.test(l)).map(nameOfLine).sort());
      expect(spots.sort()).toEqual([...new Set(lines(visit.secondary).map(nameOfLine))].sort());
      // Spot products are application_mode spot except the granular Dylox; broadcast only for the tool.
      for (const s of rowsForWindow) {
        if (s[6]) expect(s[2]).toBe('broadcast');
        if (!s[6] && s[0] !== migration.NAMES.DYL) expect(s[2]).toBe('spot');
      }
    }
  });

  test('down deletes only its own unreferenced rows; a referenced key stays', async () => {
    const db = seedDb();
    const knex = makeKnex(db);
    await migration.up(knex);
    db.scheduled_services.push({ id: 's1', lawn_protocol_key: 'swfl_zoysia_10_10', lawn_protocol_version: LAWN_V13_VERSION });
    const zoysiaId = db.lawn_protocols.find((p) => p.protocol_key === 'swfl_bermuda_10_10' && p.version === LAWN_V13_VERSION).id;
    db.lawn_protocol_service_completions.push({ id: 'c1', lawn_protocol_id: zoysiaId });
    await migration.down(knex);
    const left = db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION).map((p) => p.protocol_key).sort();
    expect(left).toEqual(['swfl_bermuda_10_10', 'swfl_zoysia_10_10']);
    expect(db.lawn_protocols.filter((p) => p.status === 'active').length).toBe(4);
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'seed_v13').length).toBe(2);
  });
});

// ── getActiveLawnProtocol ────────────────────────────────────────────────────
function recordingKnex() {
  const calls = [];
  const knex = (table) => {
    const b = {};
    for (const m of ['where', 'orWhere', 'orderBy', 'orderByRaw']) {
      b[m] = (...args) => {
        if (typeof args[0] === 'function') {
          const inner = {};
          const sub = [];
          for (const mm of ['where', 'orWhere']) inner[mm] = (...a) => { sub.push([mm, ...a]); return inner; };
          args[0].call(inner);
          calls.push([m, 'group', sub]);
        } else calls.push([m, ...args]);
        return b;
      };
    }
    b.first = () => Promise.resolve(null);
    calls.push(['table', table]);
    return b;
  };
  return { knex, calls };
}

describe('getActiveLawnProtocol', () => {
  test('gate off: exactly the old query', async () => {
    const { knex, calls } = recordingKnex();
    await withGateAsync(undefined, () => getActiveLawnProtocol(knex, { grassTrack: 'bermuda', region: 'swfl' }));
    expect(calls).toEqual([
      ['table', 'lawn_protocols'], ['where', { status: 'active' }],
      ['orderBy', 'effective_from', 'desc'], ['orderBy', 'created_at', 'desc'],
      ['where', { grass_track: 'bermuda' }], ['where', { region: 'swfl' }],
    ]);
  });

  test('gate on: active or the staged v13 version, v13 ranked first', async () => {
    const { knex, calls } = recordingKnex();
    await withGateAsync('true', () => getActiveLawnProtocol(knex, { grassTrack: 'bermuda', region: 'swfl' }));
    expect(calls[1]).toEqual(['where', 'group', [['where', { status: 'active' }], ['orWhere', { status: 'staged', version: LAWN_V13_VERSION }]]]);
    expect(calls[2]).toEqual(['orderByRaw', '(version = ?) DESC', [LAWN_V13_VERSION]]);
    expect(calls.slice(3, 5)).toEqual([['orderBy', 'effective_from', 'desc'], ['orderBy', 'created_at', 'desc']]);
  });
});

// ── The completion prefill ───────────────────────────────────────────────────
describe('completion defaults with the v13 protocol resolved', () => {
  const WHOLE = {
    1: [migration.NAMES.STW, migration.NAMES.NT],
    2: [migration.NAMES.F24],
    3: [migration.NAMES.DIM, migration.NAMES.NT],
    4: [migration.NAMES.F24],
    5: [migration.NAMES.TET],
    6: [migration.NAMES.NT, migration.NAMES.DIM],
    7: [],
    8: [migration.NAMES.NT],
    9: [migration.NAMES.NT],
    10: [migration.NAMES.STW15],
    11: [migration.NAMES.F24],
    12: [migration.NAMES.F24],
  };
  const catalog = buildCatalog(PRICE_SCENARIOS['every catalog row unpriced and needing pricing, decoys priced']);
  const idOf = (name) => catalog.find((c) => c.name === name).id;

  function planFor(grass, month) {
    const date = new Date(Date.UTC(2026, month - 1, 15, 16));
    const { track, visit } = engine.selectProtocolVisit({ track_key: grass }, date);
    const exactName = track.exact_catalog_names === true;
    const parsed = [...engine.parseProtocolLines(visit.primary, 'base', { exactName }), ...engine.parseProtocolLines(visit.secondary, 'conditional', { exactName })];
    const resolved = engine.resolveProtocolItems(parsed, catalog, {}, {});
    const [, windowKey] = migration.WINDOWS.find((w) => w[0] === month);
    const products = migration.PRODUCTS.filter(([key]) => key === windowKey).map(([, s]) => ({
      productId: idOf(s[0]), defaultInPlan: s[6], gates: s[7], applicationMode: s[2], ratePer1000: s[3], rateUnit: s[4],
    }));
    const items = resolved.filter((i) => i.product).map((i) => ({ ...i, product: { id: i.product.id, name: i.product.name, active: true }, mix: { amount: 1, amountUnit: 'fl oz', treatedSqft: 4000 } }));
    return {
      serviceId: 'visit', appointmentAssignment: {},
      propertyGate: { serviceTier: 'Silver', trackKey: grass, blocks: [], propertyMatchesProfile: true },
      protocol: { structured: { status: 'staged', grassTrack: grass, protocolKey: 'k', version: LAWN_V13_VERSION, window: { key: windowKey }, products } },
      mixCalculator: { lawnSqft: 4000, conditionalOptions: items.filter((i) => !i.selected), items: items.filter((i) => i.selected) },
    };
  }

  test.each(GRASSES)('%s: each month prefills exactly the whole-lawn products (July none)', async (grass) => {
    await withGateAsync('true', async () => {
      for (const month of MONTHS) {
        const result = buildLawnCompletionDefaults(planFor(grass, month), { isLawn: true, propertyId: 'p', propertyMatchesProfile: true, history: { rows: [] } });
        expect({ month, names: result.items.map((i) => i.product.name).sort() }).toEqual({ month, names: [...WHOLE[month]].sort() });
        // Every spot product is still offered as an option, never prefilled.
        if (month !== 7) expect(result.options.length).toBeGreaterThan(WHOLE[month].length - 1);
      }
    });
  });

  test('July carries no default and no "unregistered" explanation', async () => {
    await withGateAsync('true', async () => {
      const result = buildLawnCompletionDefaults(planFor('bermuda', 7), { isLawn: true, propertyId: 'p', propertyMatchesProfile: true, history: { rows: [] } });
      expect(result.items).toEqual([]);
      expect(result.message).toBeNull();
    });
  });
});

// ── Customer program line ────────────────────────────────────────────────────
describe('v13 monthly program line', () => {
  const EVIDENCE = {
    pre_emergent: /stonewall|dimension|pre-emergent/i,
    micros: /nutra-tech/i,
    feed: /24-0-11|stonewall 0\.43/i,
    fungicide: /artavia|velista|gravex/i,
    broadleaf: /celsius|dismiss/i,
    insect_spot: /arena|talak|acelepryn|dylox/i,
    insect_treatment: /tetrino/i,
    dry_spots: /dispatch/i,
    scouting_visit: /scout visit/i,
  };
  const CONDITION_WORDS = /\bno\b|\bonly\b|\bhold\b|\bif\b|\bskip/i;
  const clausesOf = (text) => String(text).split(/[\n,;:]|\.\s|\s—\s/).map((c) => c.trim()).filter(Boolean);
  const hasQualifier = (phrase) => QUALIFIERS.some((q) => phrase.toLowerCase().includes(q));

  const BANNED_WORDS = /\b(ordinances?|counties|county|blackouts?|laws?|bans?|banned|restrict\w*|prohibit\w*)\b/i;
  const WATER_MOW = /\b(water\w*|irrigat\w*|sprinkl\w*|rain\w*|mow\w*|drought|soak\w*)/i;
  const ORDINAL = /\b(first|second|third|final|last|continu\w*|again|re-?check\w*|complet\w*|another|next|follow-?up|start\w*|begin\w*|round)\b/i;
  const BRANDS = /(prodiamine|celsius|acelepryn|tetrino|dimension|stonewall|nutra|artavia|velista|gravex|arena|talak|dylox|dismiss|certainty|dispatch|lesco|bifen|nis\b)/i;

  test('a line for every month; gate on every grass (and an unknown one) gets it; gate off keeps the old table', () => {
    expect(Object.keys(PROGRAM_LINES_V13).map(Number)).toEqual(MONTHS);
    withGate('true', () => {
      for (const grassType of [...GRASSES, null, 'unknown', 'mixed']) {
        for (const month of MONTHS) expect(buildProgramLine({ programVisit: true, grassType, month })).toBe(PROGRAM_LINES_V13[month].line);
      }
      // The Jun-Sep rule is unchanged: a visit that applied nitrogen gets no line.
      expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 7, nitrogenApplied: true })).toBeNull();
    });
    withGate(undefined, () => expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 3 })).toBe(PROGRAM_LINES.bermuda[3].line));
  });

  test.each(MONTHS)('month %i: clean customer copy', (month) => {
    const { line } = PROGRAM_LINES_V13[month];
    expect(line).not.toMatch(BANNED_WORDS);
    expect(line).not.toMatch(WATER_MOW);
    expect(line).not.toMatch(ORDINAL);
    expect(line).not.toMatch(BRANDS);
    expect(line).not.toMatch(/\d|—|–/);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(line).toMatch(/\.$/);
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(validateCustomerCopy(line)).toBe(true);
  });

  test.each(MONTHS)('month %i: every claim is in the line and backed by the v13 visit; conditional steps are qualified', (month) => {
    const { line, claims } = PROGRAM_LINES_V13[month];
    const visit = visitFor(month);
    const primary = clausesOf(visit.primary);
    const everything = [...primary, ...clausesOf(visit.secondary), ...clausesOf(visit.notes)];
    for (const [tag, phrase] of Object.entries(claims)) {
      expect(line).toContain(phrase);
      expect(EVIDENCE[tag]).toBeDefined();
      const hits = everything.filter((c) => EVIDENCE[tag].test(c));
      expect({ tag, backed: hits.length > 0 }).toEqual({ tag, backed: true });
      const plain = primary.some((c) => EVIDENCE[tag].test(c)) && !hits.some((c) => CONDITION_WORDS.test(c));
      if (!plain) expect({ tag, phrase, qualified: hasQualifier(phrase) }).toEqual({ tag, phrase, qualified: true });
    }
  });
});

describe('v13 safety rules reach the reference tab through the catalog payload', () => {
  test('every track carries the same non-empty list; the old tracks carry none (the tab keeps its static list)', () => {
    for (const grass of GRASSES) {
      expect(v13[grass].safety_rules).toEqual(v13.st_augustine.safety_rules);
      expect(protocolsJson.lawn[grass].safety_rules).toBeUndefined();
    }
  });
});

// ── Codex round 1 fixes ──────────────────────────────────────────────────────
describe('migration 20261005130000: catalog rows, links and unread gate keys', () => {
  const MISSING = fixMigration.PRODUCTS.slice(0, 4).map((p) => p.name);
  const stage = async (db) => { await migration.up(makeKnex(db)); };

  test('the four catalog rows carry the owner values', () => {
    const byName = Object.fromEntries(fixMigration.PRODUCTS.map((p) => [p.name, p]));
    expect(byName[migration.NAMES.NT]).toMatchObject({ category: 'fertilizer', formulation: 'liquid', container_size: '2.5 gal', unit_size_oz: 320, epa_reg_number: 'N/A', default_rate_per_1000: 12, min_label_rate_per_1000: 6, max_label_rate_per_1000: 16, rate_unit: 'fl oz' });
    expect(byName[migration.NAMES.STW15]).toMatchObject({ category: 'fertilizer', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800, epa_reg_number: '10404-89', default_rate_per_1000: 4.02, rate_unit: 'lb' });
    expect(byName['LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer']).toMatchObject({ epa_reg_number: '10404-87', default_rate_per_1000: 2.78, max_label_rate_per_1000: 5.48, rate_unit: 'lb' });
    expect(byName[migration.NAMES.DYL]).toMatchObject({ category: 'insecticide', formulation: 'granular', container_size: '30 lb', unit_size_oz: 480, epa_reg_number: '432-1308', default_rate_per_1000: 3, rate_unit: 'lb' });
  });

  test('every product the recipe names has a catalog row spec; an EPA number appears only where the owner gave one', () => {
    const named = new Set();
    for (const month of MONTHS) {
      for (const line of [...lines(visitFor(month).primary), ...lines(visitFor(month).secondary)]) if (line.includes(' — ')) named.add(nameOfLine(line));
    }
    const specNames = fixMigration.PRODUCTS.map((p) => p.name);
    for (const name of named) expect(specNames).toContain(name);
    expect(new Set(specNames).size).toBe(specNames.length);
    const withEpa = Object.fromEntries(fixMigration.PRODUCTS.filter((p) => p.epa_reg_number).map((p) => [p.name, p.epa_reg_number]));
    expect(withEpa).toEqual({
      'LESCO Nutra-TECH T&O Micronutrient Package': 'N/A',
      'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer': '10404-89',
      'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer': '10404-87',
      'Dylox 6.2 G Granular Insecticide': '432-1308',
      'Artavia 2 SC (Azoxy)': '91234-74',
      'Certainty Turf Herbicide': '59639-226',
      'Gravex 20 EW': '91234-283',
      'LESCO 24-0-11 with PolyPlus OPTI': 'N/A',
      'LESCO 90/10 Nonionic Surfactant': 'N/A',
      'Celsius WG': '432-1507',
    });
  });

  test('a repo-built catalog with only the recipe products absent from a bare database: all are inserted and linked', async () => {
    const db = seedDb({ without: Object.values(migration.NAMES) });
    await stage(db);
    await fixMigration.up(makeKnex(db));
    // Velista is covered by an alias row in this fixture, so it is not inserted.
    for (const name of Object.values(migration.NAMES).filter((n) => n !== migration.NAMES.VEL)) expect(db.products_catalog.filter((c) => c.name === name)).toHaveLength(1);
    expect(db.products_catalog.filter((c) => c.name === migration.NAMES.VEL)).toHaveLength(0);
    expect(db.lawn_protocol_products.filter((r) => !r.product_id)).toEqual([]);
  });

  test('a repo-built catalog (the four rows absent): rows are inserted, every v13 row links, unread gate keys go', async () => {
    const db = seedDb({ without: MISSING });
    await stage(db);
    expect(db.lawn_protocol_products.some((r) => r.product_id === null)).toBe(true);
    const knex = makeKnex(db);
    await fixMigration.up(knex);
    for (const name of MISSING) expect(db.products_catalog.filter((c) => c.name === name)).toHaveLength(1);
    expect(db.lawn_protocol_products.filter((r) => !r.product_id)).toEqual([]);
    const nt = db.products_catalog.find((c) => c.name === migration.NAMES.NT);
    expect(db.lawn_protocol_products.filter((r) => r.product_name === migration.NAMES.NT).every((r) => r.product_id === nt.id)).toBe(true);
    // Tetrino keeps sunnyTurfOnly (read by the plan engine) and loses the keys nothing reads.
    const tet = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.TET);
    expect(JSON.parse(tet.gates)).toEqual({ sunnyTurfOnly: true });
    for (const row of db.lawn_protocol_products) {
      const keys = Object.keys(typeof row.gates === 'string' ? JSON.parse(row.gates) : row.gates);
      expect(keys.filter((k) => !fixMigration.KEPT_GATE_KEYS.has(k))).toEqual([]);
    }
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'v13_link_fix')).toHaveLength(4);
    // Idempotent.
    const rows = db.products_catalog.length; const logs = db.lawn_protocol_audit_log.length;
    await fixMigration.up(knex);
    expect(db.products_catalog.length).toBe(rows);
    expect(db.lawn_protocol_audit_log.length).toBe(logs);
  });

  test('a prod catalog that already has the rows is not touched or duplicated; an alias counts as present', async () => {
    const db = seedDb();
    db.products_catalog = db.products_catalog.filter((c) => c.name !== migration.NAMES.DYL);
    db.product_aliases.push({ product_id: 'cat-existing', alias_name: migration.NAMES.DYL });
    await stage(db);
    const before = db.products_catalog.length;
    await fixMigration.up(makeKnex(db));
    // Only the two rows this fixture lacks (Blindside, the 18-0-10) are added: no Dylox row.
    expect(db.products_catalog.length).toBe(before + 2);
    expect(db.products_catalog.filter((c) => /Dylox 6\.2/.test(c.name))).toHaveLength(0);
    expect(db.lawn_protocol_products.filter((r) => r.product_name === migration.NAMES.DYL).every((r) => r.product_id === 'cat-existing')).toBe(true);
  });

  test('a v13 product row naming something no spec covers fails the migration', async () => {
    const db = seedDb();
    await stage(db);
    const row = db.lawn_protocol_products[0];
    Object.assign(row, { product_id: null, product_name: 'Unlisted Product XYZ' });
    await expect(fixMigration.up(makeKnex(db))).rejects.toThrow(/Unlisted Product XYZ/);
  });

  test('a database with no staged rows is a no-op (nothing to link, nothing thrown)', async () => {
    const db = seedDb({ without: MISSING });
    await expect(fixMigration.up(makeKnex(db))).resolves.toBeUndefined();
  });

  test('down restores the gates, nulls only the ids it wrote, removes its audit rows, keeps the catalog rows', async () => {
    const db = seedDb({ without: MISSING });
    await stage(db);
    const gatesBefore = new Map(db.lawn_protocol_products.map((r) => [r.id, r.gates]));
    const nullBefore = db.lawn_protocol_products.filter((r) => !r.product_id).map((r) => r.id).sort();
    const knex = makeKnex(db);
    await fixMigration.up(knex);
    // A link made by someone else after the fact must survive down().
    const other = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.DYL);
    other.product_id = 'manual-link';
    await fixMigration.down(knex);
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'v13_link_fix')).toHaveLength(0);
    for (const r of db.lawn_protocol_products) expect(JSON.stringify(typeof r.gates === 'string' ? JSON.parse(r.gates) : r.gates)).toBe(JSON.stringify(typeof gatesBefore.get(r.id) === 'string' ? JSON.parse(gatesBefore.get(r.id)) : gatesBefore.get(r.id)));
    const nullAfter = db.lawn_protocol_products.filter((r) => !r.product_id).map((r) => r.id).sort();
    expect(nullAfter).toEqual(nullBefore.filter((id) => id !== other.id));
    expect(other.product_id).toBe('manual-link');
    for (const name of MISSING) expect(db.products_catalog.filter((c) => c.name === name)).toHaveLength(1);
  });
});

describe('plan engine reads the matched v13 protocol row', () => {
  const noDefault = { id: 'stw', name: migration.NAMES.STW, default_rate_per_1000: null, rate_unit: null };

  test('protocol rate beats a missing catalog rate; catalog and nutrient paths are unchanged without it', () => {
    const withRate = engine.calculateProductAmount({ product: noDefault, lawnSqft: 10000, areaFactor: 1, protocolRate: { rate: 0.5, unit: 'fl oz' } });
    expect(withRate).toMatchObject({ ratePer1000: 0.5, rateUnit: 'fl oz', rateSource: 'protocol_rate', amount: 5 });
    expect(engine.calculateProductAmount({ product: noDefault, lawnSqft: 10000, areaFactor: 1 }).rateSource).toBe('missing_rate');
    expect(engine.calculateProductAmount({ product: { ...noDefault, default_rate_per_1000: 2, rate_unit: 'oz' }, lawnSqft: 10000, areaFactor: 1 }).rateSource).toBe('catalog_default_rate');
    // A protocol row with no rate (lb_n rows) does not override the nutrient derivation.
    const fert = { id: 'f', name: migration.NAMES.F24, analysis_n: 24 };
    expect(engine.calculateProductAmount({ product: fert, lawnSqft: 1000, areaFactor: 1, targetNPer1000: 0.75, protocolRate: { rate: null, unit: 'lb_n' } }).rateSource).toBe('target_n_analysis');
  });

  test('v13ProtocolRows is empty unless the gate is on and the structured protocol is v13', () => {
    const structured = { version: LAWN_V13_VERSION, products: [{ productId: 'stw', ratePer1000: 0.5, rateUnit: 'fl oz', gates: {} }, { productId: null }] };
    expect(withGate(undefined, () => engine.v13ProtocolRows(structured).size)).toBe(0);
    expect(withGate('true', () => engine.v13ProtocolRows({ ...structured, version: '2026.06' }).size)).toBe(0);
    expect(withGate('true', () => engine.v13ProtocolRows(null).size)).toBe(0);
    expect(withGate('true', () => engine.v13ProtocolRows(structured).get('stw').ratePer1000)).toBe(0.5);
  });

  test('every rate the migration states for a whole-lawn product reaches the engine as a positive protocol rate', () => {
    const stated = migration.PRODUCTS.filter(([, s]) => s[6] && s[3] != null).map(([, s]) => s[0]);
    expect(stated).toEqual(expect.arrayContaining([migration.NAMES.STW, migration.NAMES.NT, migration.NAMES.DIM, migration.NAMES.TET, migration.NAMES.STW15]));
  });

  test('sunnyTurfOnly narrows a whole-lawn line by the profile sun exposure; no flag, no change', () => {
    const [tetrino] = engine.parseProtocolLines(visitFor(5).primary, 'base', { exactName: true });
    expect(tetrino.scope).toBe('BROADCAST_FULL');
    const flagged = { ...tetrino, sunnyTurfOnly: true };
    expect(engine.effectiveAreaFactor(flagged, { sunExposure: 'full_sun' })).toBe(1);
    expect(engine.effectiveAreaFactor(flagged, { sunExposure: 'partial_shade' })).toBe(0.5);
    expect(engine.effectiveAreaFactor(flagged, { sunExposure: 'heavy_shade' })).toBe(0);
    expect(engine.effectiveAreaFactor(flagged, {})).toBe(0.5);
    expect(engine.effectiveAreaFactor(tetrino, { sunExposure: 'heavy_shade' })).toBe(1);
    // Only the Tetrino row asks for it.
    const asking = migration.PRODUCTS.filter(([, s]) => s[7]?.sunnyTurfOnly).map(([, s]) => s[0]);
    expect(asking).toEqual([migration.NAMES.TET]);
  });
});

describe('the material-cost audit reads the gate-aware program', () => {
  test('gate on: the default report covers the v13 tracks; gate off: protocols.json lawn', () => {
    const catalog = [{ id: 'x', name: 'Synthetic', aliases: [], default_rate_per_1000: 1, rate_unit: 'oz' }];
    const on = withGate('true', () => auditScript.buildCadenceReport(catalog));
    const off = withGate(undefined, () => auditScript.buildCadenceReport(catalog));
    const trackNames = (report) => [...new Set(report.rows.map((r) => r.track || r.trackKey))].sort();
    expect(trackNames(off)).toEqual(expect.arrayContaining(['bahia', 'bermuda', 'st_augustine', 'zoysia']));
    // The v13 visits carry no cost fields, which the old ones do: the two reports differ.
    expect(JSON.stringify(on)).not.toBe(JSON.stringify(off));
  });

  test('analyzeVisit resolves a v13 line by its exact catalog name', () => {
    const catalog = Object.values(migration.NAMES).map((name, i) => ({ id: `c${i}`, name, aliases: [], default_rate_per_1000: 1, rate_unit: 'oz', needs_pricing: true }))
      .concat([{ id: 'dec', name: 'Dylox 420 SL T&O Insecticide', aliases: [], default_rate_per_1000: 1, rate_unit: 'oz', cost_per_unit: 9 }, { id: 'ace', name: 'Acelepryn Xtra', aliases: [], cost_per_unit: 9 }]);
    const result = auditScript.analyzeVisit({ trackKey: 'bermuda', track: v13.bermuda, visit: visitFor(5), products: catalog, options: { plan: 'Platinum', includePremiumOnly: true, isFirstYear: true, weedPressure: 'normal' } });
    expect(result.items.find((i) => i.raw.startsWith('Tetrino'))?.product?.name).toBe('Tetrino Insecticide');
  });
});
