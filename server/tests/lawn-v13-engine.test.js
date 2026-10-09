// Lawn protocol v13 engine, loaded dark behind GATE_LAWN_V13 (PR 2 of 3).
// Synthetic catalog, synthetic knex: no database.
//
// Pins: the gate is strict and read at call time; gate off every reader sees
// protocols.json `lawn` untouched (byte-identical); every v13 line resolves to
// its intended catalog row whatever the prices are; getActiveLawnProtocol serves
// the staged version only with the gate on and returns nothing, never the old
// active version, when it is missing; the plan blocks an unpinned visit with no
// staged v13 protocol; the completion prefill returns exactly each month's
// whole-lawn products; the plan, the tank sheet and the material-cost audit read
// the matched protocol row's rate.

const protocolsJson = require('../config/protocols.json');
const v13 = require('../config/lawn-protocol-v13.json');
const featureGates = require('../config/feature-gates');
const { lawnProtocols, LAWN_V13_VERSION, isServingProtocol } = require('../services/lawn-program');
const { matchesLawnCompletionProtocol } = require('../services/lawn-completion-defaults');
const auditScript = require('../scripts/audit-waveguard-protocol-material-costs');
const engine = require('../services/waveguard-plan-engine');
const { buildLawnCompletionDefaults } = require('../services/lawn-completion-defaults');
const { getActiveLawnProtocol } = require('../services/lawn-protocol-operating-layer');
const protocolReader = require('../services/protocol-reader');
const migration = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const octoberMigration = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const decemberMigration = require('../models/migrations/20261008130000_lawn_v13_december_potash');

const GRASSES = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
// The v13 recipe has no bahia track (owner 2026-10-06); protocols.json (gate off) still does.
const V13_GRASSES = ['st_augustine', 'bermuda', 'zoysia'];
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
    // Gate on, bermuda removal gate off: v13 without the per-visit addOns blocks.
    const stripped = Object.fromEntries(Object.entries(v13).map(([track, program]) => [track, { ...program, visits: program.visits.map(({ addOns, ...visit }) => visit) }]));
    expect(withGate('true', () => lawnProtocols())).toEqual(stripped);
    expect(JSON.stringify(withGate('true', () => lawnProtocols()))).not.toContain('addOns');
  });

  test('the bermuda removal addOns reach the shared reader only while GATE_LAWN_BERMUDA_REMOVAL is on', () => {
    const saved = process.env.GATE_LAWN_BERMUDA_REMOVAL;
    try {
      process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true';
      expect(withGate('true', () => lawnProtocols())).toBe(v13);
      expect(JSON.stringify(withGate('true', () => lawnProtocols()))).toContain('addOns');
      // The removal gate cannot surface the add-on while v13 itself is off.
      expect(withGate(undefined, () => lawnProtocols())).toBe(protocolsJson.lawn);
      delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
      expect(JSON.stringify(withGate('true', () => lawnProtocols()))).not.toContain('addOns');
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_BERMUDA_REMOVAL; else process.env.GATE_LAWN_BERMUDA_REMOVAL = saved;
    }
  });

  test('gate off: the protocol reader and the engine see no addOns anywhere', () => {
    withGate('true', () => {
      expect(JSON.stringify(protocolReader.getProtocol({ service_type: 'lawn', lawn_track: 'zoysia' }))).not.toContain('addOns');
      for (const grass of V13_GRASSES) { // bahia has no v13 program at all
        for (const month of [4, 6]) {
          const got = engine.selectProtocolVisit({ track_key: grass }, new Date(Date.UTC(2026, month - 1, 15, 16)));
          expect(got.visit).not.toHaveProperty('addOns');
        }
      }
    });
  });

  test('a feature-gates mock without the reader reads as off', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({}));
      const isolated = require('../services/lawn-program');
      expect(isolated.lawnProtocols()).toBe(require('../config/protocols.json').lawn);
    });
    jest.dontMock('../config/feature-gates');
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

  test('protocol reader is the old output', () => {
    withGate(undefined, () => {
      expect(JSON.stringify(protocolReader.getProtocol({ service_type: 'lawn', lawn_track: 'bermuda' })))
        .toBe(JSON.stringify({ protocol: protocolsJson.lawn.bermuda, track: 'bermuda', type: 'lawn_care' }));
    });
  });

  test('protocols.json itself is unchanged by v13 (the recipe lives in its own file)', () => {
    expect(Object.keys(protocolsJson)).not.toContain('lawn_v13');
    expect(Object.keys(protocolsJson.lawn)).toEqual(GRASSES);
  });

  test('gate on reads the v13 visit for every v13 grass', () => {
    withGate('true', () => {
      for (const grass of V13_GRASSES) {
        const got = engine.selectProtocolVisit({ track_key: grass }, new Date(Date.UTC(2026, 1, 15, 16)));
        expect(got.visit.primary).toContain('LESCO 24-0-11 with PolyPlus OPTI');
        expect(got.track.name).toContain('v13');
      }
      expect(protocolReader.getProtocol({ service_type: 'lawn', lawn_track: 'zoysia' }).protocol).toEqual({ ...v13.zoysia, visits: v13.zoysia.visits.map(({ addOns, ...visit }) => visit) });
    });
  });

  // Bahiagrass: Celsius and Blindside (the v13 weed spots) are not labeled for it, so v13 has no bahia
  // track and a bahia lawn must never borrow another grass's program (owner 2026-10-06).
  test('gate on: a bahia lawn has no v13 track and no fallback, however the grass is recorded', () => {
    const date = new Date(Date.UTC(2026, 1, 15, 16));
    expect(v13.bahia).toBeUndefined();
    withGate('true', () => {
      for (const [profile, legacy] of [[{ grass_type: 'bahia' }, null], [{ track_key: 'bahia' }, null], [{ grass_type: 'bahia', track_key: 'bahia' }, null], [{ grass_type: 'mixed', track_key: 'bahia' }, null],
        // Either field naming bahia ends the lookup, whichever other track the other field names.
        [{ grass_type: 'bahia', track_key: 'st_augustine' }, null], [{ grass_type: 'st_augustine', track_key: 'bahia' }, null],
        [{ grass_type: 'bahia', track_key: 'zoysia' }, null], [{ grass_type: 'bermuda', track_key: 'bahia' }, null], [null, 'Argentine Bahia']]) {
        for (const requireKnownGrass of [false, true]) {
          const got = engine.selectProtocolVisit(profile, date, legacy, { requireKnownGrass });
          expect({ profile, legacy, trackKey: got.trackKey, track: got.track, visit: got.visit, noProgram: got.v13NoProgram }).toEqual({ profile, legacy, trackKey: null, track: null, visit: null, noProgram: true });
        }
      }
      expect(protocolReader.getProtocol({ service_type: 'lawn', lawn_track: 'bahia' }).protocol).toBeUndefined();
    });
  });

  test('gate on: mixed and unknown lawns keep the any-grass fallback and carry no no-program flag', () => {
    withGate('true', () => {
      for (const grass of ['mixed', 'unknown']) {
        const got = engine.selectProtocolVisit({ grass_type: grass }, new Date(Date.UTC(2026, 1, 15, 16)));
        expect(got.trackKey).toBe('st_augustine');
        expect('v13NoProgram' in got).toBe(false);
      }
    });
  });

  test('gate off: conflicting recorded fields resolve as before (the explicit track key wins), no flag', () => {
    withGate(undefined, () => {
      const got = engine.selectProtocolVisit({ grass_type: 'bahia', track_key: 'st_augustine' }, new Date(Date.UTC(2026, 1, 15, 16)));
      expect(got.trackKey).toBe('st_augustine');
      expect('v13NoProgram' in got).toBe(false);
    });
  });

  test('gate off: a bahia lawn keeps its old track and no flag appears on any result', () => {
    withGate(undefined, () => {
      const got = engine.selectProtocolVisit({ grass_type: 'bahia' }, new Date(Date.UTC(2026, 1, 15, 16)));
      expect(got.trackKey).toBe('bahia');
      expect('v13NoProgram' in got).toBe(false);
    });
  });
});

// ── A grass with no track of its own runs the one program ──────────────────
describe('mixed or unknown grass under GATE_LAWN_V13', () => {
  const { loadCustomerGrassContext } = require('../services/lawn-grass-context');
  const { LAWN_V13_ANY_GRASS_TRACK } = require('../services/lawn-program');
  const date = new Date(Date.UTC(2026, 9, 6, 16));
  const knexFor = (rows) => (table) => ({ where() { return this; }, first: async () => rows[table] ?? null });

  test('the v13 copies are one program, so any key serves any grass', () => {
    // The bermuda removal add-on (GATE_LAWN_BERMUDA_REMOVAL) exists only on the St. Augustine and
    // Zoysia copies, by design; the base program is compared without it.
    const body = ({ name, ...rest }) => JSON.stringify({ ...rest, visits: rest.visits.map(({ addOns, ...visit }) => visit) });
    for (const grass of V13_GRASSES) expect(body(v13[grass])).toBe(body(v13[LAWN_V13_ANY_GRASS_TRACK]));
  });

  test.each(['mixed', 'unknown', 'centipede'])('gate on: recorded %s plans the October v13 visit', (grass) => {
    withGate('true', () => {
      for (const requireKnownGrass of [false, true]) {
        const got = engine.selectProtocolVisit({ grass_type: grass }, date, null, { requireKnownGrass });
        expect(got.trackKey).toBe(LAWN_V13_ANY_GRASS_TRACK);
        expect(got.visit).toBe(v13[LAWN_V13_ANY_GRASS_TRACK].visits.find((v) => v.month === 'Oct'));
      }
    });
  });

  test.each(['mixed', 'unknown', 'centipede'])('gate off: recorded %s still has no track', (grass) => {
    withGate(undefined, () => {
      expect(engine.selectProtocolVisit({ grass_type: grass }, date).trackKey).toBeNull();
    });
  });

  test('gate on: blank grass under completion defaults stays unresolved', () => {
    withGate('true', () => {
      expect(engine.selectProtocolVisit({ grass_type: '', track_key: null }, date, null, { requireKnownGrass: true }).trackKey).toBeNull();
    });
  });

  // The general loader also feeds historical report context (no planning flag),
  // where a synthesized track would resolve the old active program for a past
  // visit. The fallback is planning-only: the loader keeps a mixed lawn untracked.
  test('grass context keeps a mixed profile untracked even with the gate on', async () => {
    const knex = knexFor({ customer_turf_profiles: { grass_type: 'mixed' }, customers: {} });
    await withGateAsync('true', async () => {
      expect((await loadCustomerGrassContext('c1', knex)).trackKey).toBeNull();
    });
  });

  test('gate on: unrecognized legacy lawn_type with no profile plans the v13 visit', () => {
    withGate('true', () => {
      expect(engine.selectProtocolVisit(null, date, 'Centipede', { requireKnownGrass: true }).trackKey).toBe(LAWN_V13_ANY_GRASS_TRACK);
    });
  });
});

// ── Every line resolves to the intended catalog row ──────────────────────────
// Blindside is added by migration 20261005140000 (the staged rows of 120000 have none).
const BLINDSIDE = 'Blindside Herbicide';
// October's whole-lawn bag is the Dimension 0.21% 18-0-10 row (20261007120500 swaps it in for
// the staged Stonewall 15-0-15 line).
const DIMENSION_18 = octoberMigration.NEW_NAME;
const matrixMigration = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
const granuleMigration = require('../models/migrations/20261009100000_lawn_v13_fire_ant_granule');
// December's whole-lawn bag is the LESCO 10-0-22 row (20261008130000 swaps it in for the staged 24-0-11 line).
const F10_22 = decemberMigration.NEW_NAME;
const CATALOG_NAMES = [...Object.values(migration.NAMES), BLINDSIDE, DIMENSION_18, F10_22, matrixMigration.HEAD, matrixMigration.SOP, granuleMigration.GRANULE];
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

  test('exact names are a hard rule: a missing product leaves the line unmatched, never a partial-name stand-in', () => {
    const withoutTetrino = buildCatalog(PRICE_SCENARIOS['all priced']).filter((p) => p.name !== 'Tetrino Insecticide');
    const raw = rows.find(([label]) => label.includes('Tetrino'))[1];
    const [line] = engine.parseProtocolLines(raw, 'base', { exactName: true });
    expect(engine.matchCatalogProduct(line, withoutTetrino)).toBeNull();
    expect(engine.resolveProtocolItems([line], withoutTetrino, {}, {})[0].product).toBeNull();
    // Without the flag the old loose match still picks something (the behavior the flag exists to stop).
    const [loose] = engine.parseProtocolLines(raw, 'base');
    expect(engine.matchCatalogProduct(loose, withoutTetrino)).not.toBeNull();
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

// ── getActiveLawnProtocol ────────────────────────────────────────────────────
function recordingKnex() {
  const calls = [];
  const knex = (table) => {
    const b = {};
    for (const m of ['where', 'whereNot', 'orWhere', 'orderBy', 'orderByRaw']) {
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

  test('gate on, planning caller: only the staged v13 version, never the active one', async () => {
    const { knex, calls } = recordingKnex();
    await withGateAsync('true', () => getActiveLawnProtocol(knex, { grassTrack: 'bermuda', region: 'swfl', planning: true }));
    expect(calls).toEqual([
      // The staged bahia rows are never served for planning (the v13 program has no bahia track).
      ['table', 'lawn_protocols'], ['where', { status: 'staged', version: LAWN_V13_VERSION }], ['whereNot', 'grass_track', 'bahia'],
      ['orderBy', 'effective_from', 'desc'], ['orderBy', 'created_at', 'desc'],
      ['where', { grass_track: 'bermuda' }], ['where', { region: 'swfl' }],
    ]);
  });

  test('gate on, historical caller (no planning option): exactly the old active query', async () => {
    const { knex, calls } = recordingKnex();
    await withGateAsync('true', () => getActiveLawnProtocol(knex, { grassTrack: 'bermuda', region: 'swfl' }));
    expect(calls[1]).toEqual(['where', { status: 'active' }]);
  });

  // A table-backed fake: first() returns the first stored row every where() object matches.
  function tableKnex(protocols) {
    return (table) => {
      const conds = [];
      const nots = [];
      const b = {
        where(obj) { conds.push(obj); return b; },
        whereNot(column, value) { nots.push([column, value]); return b; },
        orderBy() { return b; },
        first() { return Promise.resolve(table === 'lawn_protocols' ? protocols.find((row) => conds.every((c) => Object.entries(c).every(([k, v]) => row[k] === v)) && nots.every(([k, v]) => row[k] !== v)) : undefined); },
        then(resolve) { return Promise.resolve([]).then(resolve); },
      };
      return b;
    };
  }
  const ACTIVE = { id: 'a1', protocol_key: 'k', version: '2026.06', status: 'active', grass_track: 'bermuda', region: 'swfl' };
  const STAGED = { id: 's1', protocol_key: 'k', version: LAWN_V13_VERSION, status: 'staged', grass_track: 'bermuda', region: 'swfl' };

  // The v13 program has no bahia track: the staged bahia rows stay in the table for history but are
  // never served for planning, whatever the caller filters on.
  const STAGED_BAHIA = { id: 's2', protocol_key: 'swfl_bahia_10_10', version: LAWN_V13_VERSION, status: 'staged', grass_track: 'bahia', region: 'swfl' };

  test('gate on, planning caller: the staged bahia protocol is never served', async () => {
    const rows = tableKnex([STAGED_BAHIA, STAGED]);
    for (const filters of [{ grassTrack: 'bahia', region: 'swfl' }, { grassTrack: 'bahia', protocolKey: 'swfl_bahia_10_10' }, { protocolKey: 'swfl_bahia_10_10' }]) {
      expect(await withGateAsync('true', () => getActiveLawnProtocol(rows, { ...filters, planning: true }))).toBeNull();
    }
    // With no track filter the bahia row is skipped, not returned ahead of the real tracks.
    expect((await withGateAsync('true', () => getActiveLawnProtocol(rows, { region: 'swfl', planning: true }))).grass_track).toBe('bermuda');
    // Gate off, and a historical reader, keep the old reads (bahia has its own active protocol then).
    const active = { ...STAGED_BAHIA, id: 'a2', version: '2026.06', status: 'active' };
    expect((await withGateAsync(undefined, () => getActiveLawnProtocol(tableKnex([active]), { grassTrack: 'bahia', planning: true }))).id).toBe('a2');
    expect((await withGateAsync('true', () => getActiveLawnProtocol(tableKnex([active]), { grassTrack: 'bahia' }))).id).toBe('a2');
  });

  test('a visit pinned to the staged bahia version plans from no protocol; a historical read still gets it', async () => {
    const { getProtocolWindowContext } = require('../services/lawn-protocol-operating-layer');
    const knex = tableKnex([STAGED_BAHIA]);
    const pinned = { protocolId: 's2', region: 'swfl' };
    expect(await withGateAsync('true', () => getProtocolWindowContext(knex, { ...pinned, planning: true }))).toBeNull();
    expect((await withGateAsync('true', () => getProtocolWindowContext(knex, pinned))).protocol.grass_track).toBe('bahia');
    expect((await withGateAsync(undefined, () => getProtocolWindowContext(knex, { ...pinned, planning: true }))).protocol.grass_track).toBe('bahia');
  });

  test('gate on with the staged row missing returns nothing instead of the old active version', async () => {
    const filters = { grassTrack: 'bermuda', region: 'swfl', planning: true };
    expect(await withGateAsync('true', () => getActiveLawnProtocol(tableKnex([ACTIVE]), filters))).toBeNull();
    expect((await withGateAsync('true', () => getActiveLawnProtocol(tableKnex([ACTIVE, STAGED]), filters))).version).toBe(LAWN_V13_VERSION);
    // A historical reader never sees the staged row: it keeps the active one.
    expect((await withGateAsync('true', () => getActiveLawnProtocol(tableKnex([ACTIVE, STAGED]), { grassTrack: 'bermuda', region: 'swfl' }))).version).toBe('2026.06');
    // Gate off: the old behavior, the active row, and a staged row alone is never served.
    expect((await withGateAsync(undefined, () => getActiveLawnProtocol(tableKnex([ACTIVE, STAGED]), filters))).version).toBe('2026.06');
    expect(await withGateAsync(undefined, () => getActiveLawnProtocol(tableKnex([STAGED]), filters))).toBeNull();
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
    10: [DIMENSION_18],
    11: [migration.NAMES.F24],
    12: [F10_22],
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
    // The staged rows as 20261007120500 leaves them: October's bag is Dimension 18-0-10 at 4.04 lb.
    const swapped = (spec) => (spec[0] === octoberMigration.OLD_NAME
      ? [DIMENSION_18, spec[1], spec[2], octoberMigration.OCT_RATE, spec[4], spec[5], spec[6], { ...spec[7], ...octoberMigration.NEW_GATES }]
      : spec);
    // 20261008130000 swaps December's 24-0-11 row for the 10-0-22 (still a lb_n row; the target is 0.45 lb N).
    const decSwapped = (spec) => (spec[0] === decemberMigration.OLD_NAME && windowKey === decemberMigration.DECEMBER_WINDOW
      ? [F10_22, spec[1], spec[2], spec[3], spec[4], spec[5], spec[6], { ...spec[7], ...decemberMigration.NEW_GATES }]
      : spec);
    // 20261007180000 adds its rows (its July 0-0-50 row is deleted by 20261007189000) and turns the April Artavia row into Headway (Arena keeps its name: 20261007181000).
    const matrixName = (name) => (name === migration.NAMES.ART && windowKey === matrixMigration.WINDOWS.APR ? matrixMigration.HEAD : name);
    const staged = migration.PRODUCTS.filter(([key]) => key === windowKey).map(([, s]) => decSwapped(swapped(s))).map((s) => ({
      productId: idOf(matrixName(s[0])), defaultInPlan: s[6], gates: s[7], applicationMode: s[2], ratePer1000: s[3], rateUnit: s[4],
    }));
    // 20261009100000 retires the Advion add-on rows and inserts the fire ant granule rows in their place.
    const added = matrixMigration.INSERTS.filter((spec) => spec.windowKey === windowKey && spec.name !== matrixMigration.SOP).map((spec) => (spec.name === matrixMigration.ADVION ? { ...spec, name: granuleMigration.GRANULE } : spec)).map((spec) => ({
      productId: idOf(spec.name), defaultInPlan: spec.defaultInPlan, gates: spec.gates, applicationMode: spec.mode, ratePer1000: spec.rate, rateUnit: spec.unit,
    }));
    const products = [...staged, ...added];
    const items = resolved.filter((i) => i.product).map((i) => ({ ...i, product: { id: i.product.id, name: i.product.name, active: true }, mix: { amount: 1, amountUnit: 'fl oz', treatedSqft: 4000 } }));
    return {
      serviceId: 'visit', appointmentAssignment: {},
      propertyGate: { serviceTier: 'Silver', trackKey: grass, blocks: [], propertyMatchesProfile: true },
      protocol: { structured: { status: 'staged', grassTrack: grass, protocolKey: 'k', version: LAWN_V13_VERSION, window: { key: windowKey }, products } },
      mixCalculator: { lawnSqft: 4000, conditionalOptions: items.filter((i) => !i.selected), items: items.filter((i) => i.selected) },
    };
  }

  test.each(V13_GRASSES)('%s: each month prefills exactly the whole-lawn products (July none)', async (grass) => {
    await withGateAsync('true', async () => {
      for (const month of MONTHS) {
        const result = buildLawnCompletionDefaults(planFor(grass, month), { isLawn: true, propertyId: 'p', propertyMatchesProfile: true, history: { rows: [] } });
        expect({ month, names: result.items.map((i) => i.product.name).sort() }).toEqual({ month, names: [...WHOLE[month]].sort() });
        // Every spot product is still offered as an option, never prefilled.
        if (month !== 7) expect(result.options.length).toBeGreaterThan(WHOLE[month].length - 1);
      }
    });
  });

  test('July carries no default and no "unregistered" explanation (the scout visit)', async () => {
    await withGateAsync('true', async () => {
      const result = buildLawnCompletionDefaults(planFor('bermuda', 7), { isLawn: true, propertyId: 'p', propertyMatchesProfile: true, history: { rows: [] } });
      expect(result.items).toEqual([]);
      expect(result.message).toBeNull();
    });
  });
});

describe('v13 safety rules reach the reference tab through the catalog payload', () => {
  test('every track carries the same non-empty list; the old tracks carry none (the tab keeps its static list)', () => {
    for (const grass of V13_GRASSES) expect(v13[grass].safety_rules).toEqual(v13.st_augustine.safety_rules);
    for (const grass of GRASSES) expect(protocolsJson.lawn[grass].safety_rules).toBeUndefined();
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

  test('plan block: gate on, any structured protocol but the staged v13 one; gate off, anything pinned to v13', () => {
    const staged = { version: LAWN_V13_VERSION };
    const old = { version: '2026.06' };
    const block = (args, gate = 'true') => withGate(gate, () => engine.lawnV13PlanBlock({ service: {}, ...args }));
    expect(block({ trackKey: 'bermuda', structuredProtocol: null }).code).toBe('lawn_v13_protocol_missing');
    expect(block({ trackKey: 'bermuda', structuredProtocol: old }).code).toBe('lawn_v13_protocol_missing');
    expect(block({ trackKey: 'bermuda', structuredProtocol: old, service: { lawn_protocol_version: '2026.06' } }).code).toBe('lawn_v13_protocol_missing');
    expect(block({ trackKey: 'bermuda', structuredProtocol: staged })).toBeNull();
    // No track has its own block elsewhere.
    expect(block({ trackKey: null, structuredProtocol: null })).toBeNull();
    // Gate off: a visit pinned to the staged v13 protocol has no recipe to match.
    expect(block({ trackKey: 'bermuda', structuredProtocol: old, service: { lawn_protocol_version: LAWN_V13_VERSION } }, 'false').code).toBe('lawn_v13_gate_off');
    expect(block({ trackKey: 'bermuda', structuredProtocol: staged }, 'false').code).toBe('lawn_v13_gate_off');
    // Gate off, nothing v13 about the visit: never.
    expect(block({ trackKey: 'bermuda', structuredProtocol: old, service: { lawn_protocol_version: '2026.06' } }, 'false')).toBeNull();
    expect(block({ trackKey: 'bermuda', structuredProtocol: null }, 'false')).toBeNull();
  });

  describe('v13SelectionBlocks: the apply-alone hold, judged before any quantity', () => {
    const rowOf = (rows) => (line) => rows[line.product.id];
    const tet = { product: { id: 't', name: 'Tetrino Insecticide' }, selected: true };
    const arena = { product: { id: 'a', name: 'Arena 50 WDG' }, selected: true };
    const rows = { t: { gates: { applyAlone: true } }, a: { gates: {} } };
    test('another selected product beside an apply-alone one is a block; alone, or the other unselected, is not', () => {
      expect(engine.v13SelectionBlocks([tet, arena], rowOf(rows), {}).map((b) => b.code)).toEqual(['lawn_v13_apply_alone']);
      expect(engine.v13SelectionBlocks([tet], rowOf(rows), {})).toEqual([]);
      expect(engine.v13SelectionBlocks([tet, { ...arena, selected: false }], rowOf(rows), {})).toEqual([]);
      expect(engine.v13SelectionBlocks([{ ...tet, selected: false }, arena], rowOf(rows), {})).toEqual([]);
      expect(engine.v13SelectionBlocks([tet, arena], rowOf({ t: { gates: {} }, a: { gates: {} } }), {})).toEqual([]);
      expect(engine.v13SelectionBlocks([tet, arena], () => null, {})).toEqual([]);
    });
  });

  describe('v13LineState: one decision per v13 line', () => {
    const tet = { id: 't' };
    const rows = new Map([['t', { applicationMode: 'broadcast', ratePer1000: 0.367, rateUnit: 'fl oz' }], ['a', { applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate' }]]);
    test('unlinked, capped, spot and calculate, in that order of precedence', () => {
      expect(engine.v13LineState({ id: 'x' }, rows).state).toBe('unavailable');
      expect(engine.v13LineState({ id: 'x' }, rows, new Set(['x'])).state).toBe('unavailable'); // no row beats a cap: nothing to size
      expect(engine.v13LineState(tet, rows, new Set(['t'])).state).toBe('capped');
      expect(engine.v13LineState({ id: 'a' }, rows).state).toBe('spot');
      expect(engine.v13LineState({ id: 'a' }, rows, new Set(['a'])).state).toBe('capped'); // a capped spot row says so
      expect(engine.v13LineState(tet, rows).state).toBe('calculate');
    });
    test('the item fields name why a line is unavailable, and carry nothing for a calculating row', () => {
      expect(engine.v13ItemFields({ row: null, state: 'unavailable' }, {}, tet).unavailable.reason).toMatch(/No protocol row is linked/);
      expect(engine.v13ItemFields({ row: rows.get('t'), state: 'capped' }, {}, tet).unavailable.reason).toMatch(/application limit/);
      expect(engine.v13ItemFields({ row: rows.get('t'), state: 'calculate' }, {}, tet)).toMatchObject({ spot: null, unavailable: null });
    });
  });

  describe('which v13 rows compute a quantity (v13RowCalculates)', () => {
    test('only a whole-lawn row that states a rate or a nutrient target', () => {
      const calc = (row) => engine.v13RowCalculates(row);
      expect(calc({ applicationMode: 'broadcast', ratePer1000: 0.5, rateUnit: 'fl oz' })).toBe(true); // Stonewall 4FL, Nutra-TECH, Tetrino, Dimension 18-0-10
      expect(calc({ applicationMode: 'broadcast', ratePer1000: null, rateUnit: 'lb_n' })).toBe(true); // 24-0-11
      expect(calc({ applicationMode: 'spot', ratePer1000: 0.085, rateUnit: 'oz' })).toBe(false); // Celsius: stated rate, but spot
      expect(calc({ applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate' })).toBe(false); // Arena, Artavia, the surfactant ...
      expect(calc({ applicationMode: 'broadcast', ratePer1000: null, rateUnit: 'label_rate' })).toBe(false); // Dylox 6.2 G
    });
    test('every spot or label-rate row the staged migration writes is withheld, every whole-lawn default row computes', () => {
      for (const [, spec] of migration.PRODUCTS) {
        const [name, , mode, rate, unit, , defaultInPlan] = spec;
        const row = { applicationMode: mode, ratePer1000: rate, rateUnit: unit };
        expect({ name, calculates: engine.v13RowCalculates(row) }).toEqual({ name, calculates: Boolean(defaultInPlan) });
      }
    });
    test('the reference text puts a concentration first, then the row rate, the label range, the catalog default', () => {
      const ref = (row, product) => engine.v13ItemFields({ row: { applicationMode: 'spot', gates: {}, ...row }, state: 'spot' }, {}, product).spot.reference;
      expect(ref({ ratePer1000: null, gates: { concentration: '0.25% v/v' } }, { default_rate_per_1000: 0.25, rate_unit: 'fl oz' })).toBe('Label concentration 0.25% v/v');
      expect(ref({ ratePer1000: 0.085, rateUnit: 'oz' }, {})).toBe('Label rate 0.085 oz per 1,000 sq ft');
      expect(ref({ ratePer1000: null, gates: { rateRange: '0.046-0.092 fl oz/1000' } }, { default_rate_per_1000: 0.05, rate_unit: 'fl oz' })).toBe('Label rate 0.046-0.092 fl oz/1000');
      expect(ref({ ratePer1000: null }, { default_rate_per_1000: 3, rate_unit: 'lb' })).toBe('Label rate 3 lb per 1,000 sq ft');
      expect(ref({ ratePer1000: null }, {})).toBeNull();
    });
  });

  describe('v13GateNotes', () => {
    const keys = (notes) => notes.map((n) => `${n.severity}:${n.key}`);
    test('May Tetrino: water distance is a required warning, apply-alone and sunny turf are notes', () => {
      const notes = engine.v13GateNotes({ sunnyTurfOnly: true, minDistanceFromWaterFt: 25, applyAlone: true });
      expect(keys(notes)).toEqual(['required:minDistanceFromWaterFt', 'note:applyAlone', 'note:sunnyTurfOnly']);
      expect(notes[0].text).toBe('Keep 25 ft from ponds, lakes and canals; skip that strip.');
    });
    test('judged gates: Nov-Mar only by month, North Port by municipality, spreader-only by production mode', () => {
      expect(keys(engine.v13GateNotes({ novToMarOnly: true }, { monthNumber: 7 }))).toEqual(['required:novToMarOnly']);
      for (const month of [11, 12, 1, 3]) expect(engine.v13GateNotes({ novToMarOnly: true }, { monthNumber: month })).toEqual([]);
      expect(keys(engine.v13GateNotes({ northPortBlocked: true }, { municipality: 'North Port' }))).toEqual(['required:northPortBlocked']);
      expect(engine.v13GateNotes({ northPortBlocked: true }, { municipality: 'Sarasota' })).toEqual([]);
      expect(engine.v13GateNotes({ northPortBlocked: true }, {})).toEqual([]);
      expect(keys(engine.v13GateNotes({ spreaderVisitOnly: true }, { productionMode: 'main_reel_plus_spot_backpack' }))).toEqual(['required:spreaderVisitOnly']);
      expect(engine.v13GateNotes({ spreaderVisitOnly: true }, { productionMode: 'spreader_plus_spot_backpack' })).toEqual([]);
    });
    test('tropical watch is required; watering, tank mix, concentration, rate gates are notes; unknown keys say nothing', () => {
      expect(keys(engine.v13GateNotes({ holdForTropicalWatch: true }))).toEqual(['required:holdForTropicalWatch']);
      expect(keys(engine.v13GateNotes({ delayWateringHours: 24, noWaterIn: true, tankMixWith: 'Celsius WG', concentration: '0.25% v/v', paleTurfRate: '16 fl oz', rateRange: '0.046-0.092 fl oz/1000', trigger: 'x', annualCounter: 'y' })))
        .toEqual(['note:delayWateringHours', 'note:noWaterIn', 'note:tankMixWith', 'note:concentration', 'note:paleTurfRate', 'note:rateRange']);
      expect(engine.v13GateNotes(null)).toEqual([]);
    });
    test('every restored gate key the data migration puts on a row is either shown here or deliberately silent', () => {
      const silent = new Set(['trigger', 'annualCounter', 'stressGate', 'targetN', 'targetK2O', 'blackoutSensitive', 'requiresZeroNP', 'postAppIrrigation']);
      const shown = new Set();
      for (const [, spec] of migration.PRODUCTS) {
        for (const key of Object.keys(spec[7] || {})) {
          if (silent.has(key) || key === 'recheckDays') continue;
          const probe = engine.v13GateNotes({ [key]: key === 'minDistanceFromWaterFt' ? 25 : key === 'delayWateringHours' ? 24 : true },
            { monthNumber: 7, municipality: 'North Port', productionMode: 'main_reel_plus_spot_backpack' });
          if (probe.length) shown.add(key);
          expect({ key, shown: probe.length > 0 }).toEqual({ key, shown: true });
        }
      }
      expect(shown.has('minDistanceFromWaterFt')).toBe(true);
    });
  });

  describe('loadV13RowsForMonth', () => {
    const summary = { version: LAWN_V13_VERSION, products: [{ productId: 'stw', ratePer1000: 0.5, rateUnit: 'fl oz', gates: {} }] };
    function isolatedEngine(context) {
      let loaded;
      jest.isolateModules(() => {
        jest.doMock('../services/lawn-protocol-operating-layer', () => ({
          getProtocolWindowContext: jest.fn(async () => context),
          summarizeProtocolContext: (c) => c,
        }));
        loaded = require('../services/waveguard-plan-engine');
      });
      jest.dontMock('../services/lawn-protocol-operating-layer');
      return loaded;
    }

    test('gate off: empty and the database is never read', async () => {
      const knex = () => { throw new Error('no database read expected'); };
      const rows = await withGateAsync(undefined, () => engine.loadV13RowsForMonth(knex, 'bermuda', 'Jan'));
      expect(rows.size).toBe(0);
    });

    test('gate on: the staged protocol rows by catalog id', async () => {
      const rows = await withGateAsync('true', () => isolatedEngine(summary).loadV13RowsForMonth({}, 'bermuda', 'Jan'));
      expect(rows.get('stw').ratePer1000).toBe(0.5);
    });

    test('gate on with no staged protocol throws lawn_v13_protocol_missing, whatever else is active', async () => {
      for (const context of [null, { version: '2026.06', products: [] }]) {
        await expect(withGateAsync('true', () => isolatedEngine(context).loadV13RowsForMonth({}, 'bermuda', 'Jan')))
          .rejects.toMatchObject({ code: 'lawn_v13_protocol_missing' });
      }
    });
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

  test('the cadence report prices April by the plan: Dimension 18-0-10 at the 9x row, the 24-0-11 at 12x and 6x', () => {
    const DIM = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
    const catalog = [
      { id: 'f24', name: migration.NAMES.F24, aliases: [], default_rate_per_1000: 4.2, rate_unit: 'lb', analysis_n: 24, analysis_k: 11, cost_per_unit: 1, cost_unit: 'lb', needs_pricing: false },
      { id: 'dim', name: DIM, aliases: [], default_rate_per_1000: 2.78, rate_unit: 'lb', analysis_n: 18, analysis_k: 10, cost_per_unit: 2, cost_unit: 'lb', needs_pricing: false },
    ];
    const aprilRows = new Map([['f24', { ratePer1000: null, rateUnit: 'lb_n', gates: {} }], ['dim', { ratePer1000: null, rateUnit: 'lb_n', gates: {} }]]);
    const v13Rows = new Map([['st_augustine|Apr', aprilRows]]);
    const report = withGate('true', () => auditScript.buildCadenceReport(catalog, lawnProtocols(), v13Rows));
    const april = (tier) => report.rows.find((r) => r.track === 'st_augustine' && r.tier === tier).visits.find((v) => v.month === 'Apr');
    const selected = (result) => result.items.filter((i) => i.selected && i.product).map((i) => i.product.name);
    expect(selected(april('enhanced'))).toEqual([DIM]);
    expect(april('enhanced').items.find((i) => i.product?.name === DIM).mix.ratePer1000).toBeCloseTo(2.7778, 3);
    expect(selected(april('premium'))).toEqual([migration.NAMES.F24]);
    expect(selected(april('standard'))).toEqual([migration.NAMES.F24]);
  });

  test('analyzeVisit resolves a v13 line by its exact catalog name', () => {
    const catalog = Object.values(migration.NAMES).map((name, i) => ({ id: `c${i}`, name, aliases: [], default_rate_per_1000: 1, rate_unit: 'oz', needs_pricing: true }))
      .concat([{ id: 'dec', name: 'Dylox 420 SL T&O Insecticide', aliases: [], default_rate_per_1000: 1, rate_unit: 'oz', cost_per_unit: 9 }, { id: 'ace', name: 'Acelepryn Xtra', aliases: [], cost_per_unit: 9 }]);
    const result = auditScript.analyzeVisit({ trackKey: 'bermuda', track: v13.bermuda, visit: visitFor(5), products: catalog, options: { plan: 'Platinum', includePremiumOnly: true, isFirstYear: true, weedPressure: 'normal' } });
    expect(result.items.find((i) => i.raw.startsWith('Tetrino'))?.product?.name).toBe('Tetrino Insecticide');
  });

  describe('rates come from the matched staged protocol row, as in the plan', () => {
    const N = migration.NAMES;
    const catalog = [
      { id: 'nt', name: N.NT, aliases: [], default_rate_per_1000: 12, rate_unit: 'fl oz', cost_per_unit: 1, needs_pricing: false },
      { id: 'stw', name: N.STW, aliases: [], default_rate_per_1000: null, rate_unit: null, cost_per_unit: 1, needs_pricing: false },
      { id: 'f24', name: N.F24, aliases: [], default_rate_per_1000: 4.2, rate_unit: 'lb', analysis_n: 24, analysis_k: 11, cost_per_unit: 1, needs_pricing: false },
      { id: 'tet', name: N.TET, aliases: [], default_rate_per_1000: 0.367, rate_unit: 'fl oz', cost_per_unit: 1, needs_pricing: false },
    ];
    const options = { plan: 'Platinum', includePremiumOnly: true, isFirstYear: true, weedPressure: 'normal' };
    const analyze = (month, v13Rows) => auditScript.analyzeVisit({ trackKey: 'bermuda', track: v13.bermuda, visit: visitFor(month), products: catalog, options, v13Rows });
    const rowsFor = (month, rows) => new Map([[`bermuda|${MONTH_ABBR[month - 1]}`, new Map(Object.entries(rows))]]);
    const itemOf = (result, name) => result.items.find((i) => i.product?.name === name);

    test('January Nutra-TECH is audited at the protocol 6 fl oz, not the 12 fl oz catalog default', () => {
      const rows = rowsFor(1, { nt: { ratePer1000: 6, rateUnit: 'fl oz', gates: {} }, stw: { ratePer1000: 0.5, rateUnit: 'fl oz', gates: {} } });
      expect(itemOf(analyze(1, rows), N.NT).mix).toMatchObject({ ratePer1000: 6, rateSource: 'protocol_rate' });
      expect(itemOf(analyze(1, rows), N.STW).mix).toMatchObject({ ratePer1000: 0.5, rateSource: 'protocol_rate' });
      // No rows (gate off, or the old recipe): the catalog default, exactly as before.
      expect(itemOf(analyze(1), N.NT).mix).toMatchObject({ ratePer1000: 12, rateSource: 'catalog_default_rate' });
      expect(itemOf(analyze(1), N.STW).mix.rateSource).toBe('missing_rate');
    });

    test('a fertilizer month derives from the visit nutrient target, not the 4.2 lb bag default', () => {
      const rows = rowsFor(2, { f24: { ratePer1000: null, rateUnit: 'lb_n', gates: {} } });
      const mix = itemOf(analyze(2, rows), N.F24).mix;
      expect(mix.rateSource).toBe('target_n_analysis');
      expect(mix.ratePer1000).toBeCloseTo(3.125, 3);
      expect(itemOf(analyze(2), N.F24).mix.ratePer1000).toBe(4.2);
    });

    test('sunnyTurfOnly narrows the Tetrino line to the half the audit has no profile for', () => {
      const rows = rowsFor(5, { tet: { ratePer1000: 0.367, rateUnit: 'fl oz', gates: { sunnyTurfOnly: true } } });
      const narrowed = itemOf(analyze(5, rows), N.TET).mix;
      const whole = itemOf(analyze(5), N.TET).mix;
      expect(narrowed.amount).toBeCloseTo(whole.amount / 2, 3);
    });

    test('a spot row is not priced: no amount, as in the plan; the whole-lawn rows around it still are', () => {
      const withArena = [...catalog, { id: 'are', name: matrixMigration.ARENA_OLD, aliases: [], default_rate_per_1000: 0.29, rate_unit: 'oz', cost_per_unit: 1, needs_pricing: false }];
      const rows = new Map([['bermuda|May', new Map([['are', { applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate', gates: {} }], ['tet', { applicationMode: 'broadcast', ratePer1000: 0.367, rateUnit: 'fl oz', gates: {} }]])]]);
      const result = auditScript.analyzeVisit({ trackKey: 'bermuda', track: v13.bermuda, visit: visitFor(5), products: withArena, options, v13Rows: rows });
      expect(itemOf(result, matrixMigration.ARENA_OLD).mix).toBeNull();
      expect(itemOf(result, N.TET).mix.amount).toBeGreaterThan(0);
    });

    test('with the gate off the loader returns an empty row set for every track and month', async () => {
      const rows = await withGateAsync(undefined, () => auditScript.loadV13Rows());
      expect(rows.size).toBe(GRASSES.length * 12);
      expect([...rows.values()].every((r) => r.size === 0)).toBe(true);
    });
  });
});

describe('lb_n nutrition rows derive from the visit target (v13)', () => {
  const f24 = { id: 'f24', name: migration.NAMES.F24, analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb' };
  const dim18 = { id: 'd18', name: DIMENSION_18, analysis_n: 18, analysis_k: 10, default_rate_per_1000: 2.78, rate_unit: 'lb' };
  const rowFor = (windowMonth, name) => {
    const [, windowKey] = migration.WINDOWS.find((w) => w[0] === windowMonth);
    const [, spec] = migration.PRODUCTS.find(([key, s]) => key === windowKey && s[0] === name);
    return { ratePer1000: spec[3], rateUnit: spec[4] };
  };
  const amountFor = (product, month, row) => engine.calculateProductAmount({
    product, lawnSqft: 1000, areaFactor: 1, ...engine.parseVisitNutrientTargets(visitFor(month).notes), ...engine.v13RateOptions(row),
  });

  test.each([[2, 3.125], [4, 2.083], [11, 3.125]])('24-0-11 in month %i is %f lb per 1,000 sq ft', (month, lb) => {
    const result = amountFor(f24, month, rowFor(month, migration.NAMES.F24));
    expect(result).toMatchObject({ rateSource: 'target_n_analysis', rateUnit: 'lb' });
    expect(result.amount).toBeCloseTo(lb, 3);
  });

  test('December LESCO 10-0-22 derives 4.5 lb per 1,000 sq ft from the 0.45 lb N target (0.99 lb K2O, 50% slow-release N)', () => {
    const f10 = { id: 'f10', name: F10_22, analysis_n: 10, analysis_k: 22, slow_release_n_pct: 50, default_rate_per_1000: 4.5, rate_unit: 'lb' };
    const row = rowFor(12, migration.NAMES.F24); // the staged lb_n row: the swap changes its name and target, not its rate shape
    expect(row).toEqual({ ratePer1000: null, rateUnit: 'lb_n' });
    const result = amountFor(f10, 12, row);
    expect(result).toMatchObject({ rateSource: 'target_n_analysis', rateUnit: 'lb', amount: 4.5 });
    expect(result.amount * 0.10).toBeCloseTo(0.45, 6);
    expect(result.amount * 0.22).toBeCloseTo(0.99, 6);
    // The catalog default rate agrees with the derived one, so a row that loses its target still plans 4.5 lb.
    expect(amountFor(f10, 12, { ratePer1000: null, rateUnit: null })).toMatchObject({ amount: 4.5 });
  });

  test('October Dimension 18-0-10 is its stated 4.04 lb (0.73 lb N, 0.40 lb K2O, the commercial Coastal South rate)', () => {
    const row = { ratePer1000: octoberMigration.OCT_RATE, rateUnit: 'lb' };
    const result = amountFor(dim18, 10, row);
    expect(result).toMatchObject({ rateSource: 'protocol_rate', amount: 4.04 });
    expect(result.amount * 0.18).toBeCloseTo(0.7272, 4);
    expect(result.amount * 0.10).toBeCloseTo(0.404, 4);
    // 4.04 lb x 0.21% = 0.0085 lb ai per 1,000 sq ft = 0.37 lb ai per acre, under the 5.46 lb per-application maximum.
    expect((result.amount * 0.0021) * 43.56).toBeCloseTo(0.37, 2);
    expect(result.amount).toBeLessThan(octoberMigration.MAX_LABEL);
    // The recipe's own October notes and primary line state the same figures.
    const targets = engine.parseVisitNutrientTargets(visitFor(10).notes);
    expect(targets).toMatchObject({ targetNPer1000: 0.73, targetKPer1000: 0.4 });
    expect(visitFor(10).primary).toContain('4.04 lb per 1,000 sq ft (0.73 lb N, 0.4 lb K2O)');
  });

  test('without a v13 row (gate off or no match) the catalog default still applies, unchanged', () => {
    const result = amountFor(f24, 4, null);
    expect(result).toMatchObject({ rateSource: 'catalog_default_rate', amount: 4.2 });
    expect(engine.v13RateOptions(null)).toEqual({});
    expect(engine.v13RateOptions({ ratePer1000: null, rateUnit: 'label_rate' })).toEqual({});
  });

  test('a lb_n row with no target falls back to the catalog default instead of a zero', () => {
    const result = engine.calculateProductAmount({ product: f24, lawnSqft: 1000, areaFactor: 1, ...engine.v13RateOptions({ ratePer1000: null, rateUnit: 'lb_n' }) });
    expect(result.rateSource).toBe('catalog_default_rate');
  });
});

describe('Blindside in the recipe', () => {
  // Owner 2026-10-08: Blindside is a November-through-March product, and February is Celsius alone
  // (20261008130000 retires the staged rows): of the Celsius windows only January, March and December list it.
  const BLINDSIDE_MONTHS = [1, 3, 12];

  test('every Celsius spot window lists Blindside by its exact catalog name, after the Celsius lines, and the line stays a spot line; none in February or April through October', () => {
    for (const month of MONTHS) {
      const secondary = lines(visitFor(month).secondary);
      const hasCelsius = secondary.some((l) => l.startsWith('Celsius WG'));
      const blind = secondary.filter((l) => l.startsWith(`${BLINDSIDE} — `));
      expect(blind).toHaveLength(BLINDSIDE_MONTHS.includes(month) ? 1 : 0);
      expect(hasCelsius || !BLINDSIDE_MONTHS.includes(month)).toBe(true);
      if (!BLINDSIDE_MONTHS.includes(month)) continue;
      expect(secondary.indexOf(blind[0])).toBeGreaterThan(secondary.findIndex((l) => l.startsWith('Celsius WG')));
      const [parsed] = engine.parseProtocolLines(blind[0], 'conditional', { exactName: true });
      expect(parsed.scope).toBe('SPOT_ALLOWANCE');
      expect(parsed.conditional).toBe(true);
    }
    expect(JSON.stringify(v13)).not.toMatch(/Blindside WDG/);
  });

  test('February is Celsius alone: no Certainty, no surfactant, no Blindside, and the line says so', () => {
    expect(lines(visitFor(2).secondary)).toEqual(['Celsius WG — light weed spots only during green-up, 0.085 oz per 1,000 sq ft, alone: no Certainty and no surfactant this month']);
    const [parsed] = engine.parseProtocolLines(lines(visitFor(2).secondary)[0], 'conditional', { exactName: true });
    expect(parsed).toMatchObject({ scope: 'SPOT_ALLOWANCE', conditional: true });
  });

  test('program notes and safety rules keep Blindside to November through March and state the April-October rule', () => {
    for (const grass of V13_GRASSES) {
      const notes = v13[grass].notes.join('\n');
      expect(notes).toMatch(/Blindside Herbicide in its place from November through March \(April through October: no weed spray once the Celsius cap is reached\)/);
      expect(v13[grass].safety_rules.join('\n')).toMatch(/use Blindside after the Celsius cap, November through March only \(April through October: no weed spray once the Celsius cap is reached\)/);
    }
  });

  test('November has no weed lines (none added)', () => {
    expect(lines(visitFor(11).secondary).filter((l) => /Celsius|Certainty|Blindside|Nonionic/.test(l))).toEqual([]);
  });
});

describe('chinch bug trigger wording (owner 2026-10-08: the edge of a damaged patch, not a count)', () => {
  test('no chinch line in the recipe states a count per square foot; the staged trigger key keeps its name', () => {
    expect(JSON.stringify(v13)).not.toMatch(/20 to 25|20-25/);
    for (const grass of V13_GRASSES) {
      expect(v13[grass].notes.join('\n')).toMatch(/Chinch bugs \(found at the edge of a damaged patch, float test only if unsure, 4 gal per 1,000 sq ft into the thatch\)/);
    }
    const chinch = ['Apr', 'May', 'Jun'].map((m) => lines(v13.st_augustine.visits.find((v) => v.month === m).secondary).find((l) => l.startsWith('Arena 50 WDG')));
    const tail = ', 0.147 oz per 1,000 sq ft (6.4 oz per acre) in 4 gal per 1,000 sq ft into the thatch; a second application no sooner than 8 weeks later (SiteOne: Arena S.E., Florida only)';
    expect(chinch).toEqual([
      `Arena 50 WDG — chinch bugs found at the edge of a damaged patch (float test only if unsure)${tail}`,
      `Arena 50 WDG — chinch bugs outside the sunny turf, found at the edge of a damaged patch (float test only if unsure)${tail}`,
      `Arena 50 WDG — chinch bugs found at the edge of a damaged patch (float test only if unsure)${tail}`,
    ]);
    expect(JSON.stringify(migration.PRODUCTS)).toContain('chinch_20_to_25_per_sqft');
  });
});

describe('Arena at the label\'s low turf rate (owner 2026-10-08)', () => {
  test('every Arena line states 0.147 oz (6.4 oz per acre) and the 8-week repeat; the program note says so once, cites the label and names the current Florida 2(ee) sheet', () => {
    const arena = Array.from(new Set([4, 5, 6].flatMap((m) => lines(visitFor(m).secondary).filter((l) => l.startsWith('Arena 50 WDG')))));
    expect(arena).toHaveLength(2);
    for (const line of arena) expect(line).toMatch(/0\.147 oz per 1,000 sq ft \(6\.4 oz per acre\) in 4 gal per 1,000 sq ft into the thatch; a second application no sooner than 8 weeks later/);
    for (const grass of V13_GRASSES) {
      const note = v13[grass].notes.find((n) => n.startsWith('Chinch bugs'));
      expect(note).toContain('Tetrino in May, then Arena, then bifenthrin, then Dylox 6.2 G. Arena: 0.147 oz per 1,000 sq ft (6.4 oz per acre, the low end of the label\'s turf range; about 1.4 level teaspoons)');
      expect(note).toContain('up to 2 applications per lawn per year at least 8 weeks (56 days) apart (app-enforced)');
      // The owner holds the current sheet (2026-10-08): the note gives its expiry and says to carry it.
      expect(note).toContain("Valent's Florida 2(ee) recommendation for southern chinch bug (EPA Reg. No. 59639-152; expires December 31, 2028): keep a copy on the truck.");
      expect(note).not.toMatch(/never treat the same area twice/);
    }
  });

  test('a v13 spot row carries its own stated rate for the readers that size a dose (the job card\'s product search), not the catalog default', () => {
    const arenaRow = { ratePer1000: 0.147, rateUnit: 'oz', carrierGalPer1000: 4, gates: { trigger: 'chinch_20_to_25_per_sqft' } };
    const product = { id: 'a', name: 'Arena 50 WDG', default_rate_per_1000: 0.29, rate_unit: 'oz' };
    const fields = engine.v13ItemFields({ row: arenaRow, state: 'spot' }, {}, product);
    expect(fields.spot).toMatchObject({ reference: 'Label rate 0.147 oz per 1,000 sq ft', ratePer1000: 0.147, rateUnit: 'oz', carrierGalPer1000: 4 });
    // A spot row with no stated rate falls back to the catalog reference text and carries no number.
    const bare = engine.v13ItemFields({ row: { ratePer1000: null, rateUnit: 'label_rate', gates: {} }, state: 'spot' }, {}, product);
    expect(bare.spot).toMatchObject({ reference: 'Label rate 0.29 oz per 1,000 sq ft', ratePer1000: null, rateUnit: null, carrierGalPer1000: null });
  });
});
