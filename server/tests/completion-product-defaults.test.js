const {
  resolveCompletionDefaultProductNames,
  resolveCatalogProductForName,
  resolveCompletionProductDefaults,
  resolveSeasonalWindow,
  isSeasonalWindowList,
  monthFromDateColumn,
} = require('../services/completion-product-defaults');
const realProtocols = require('../config/protocols.json');

// -- a minimal fake knex: only the chain shapes this module actually calls
// (where/whereIn/first/select, with select/first returning real Promises so
// the module's own .catch(...) works unmodified). Synthetic rows/names only.
function fakeDb(tables) {
  function pick(row, cols) {
    if (!cols.length) return { ...row };
    const out = {};
    cols.forEach((col) => { out[col] = row[col]; });
    return out;
  }
  return function db(table) {
    let rows = [...(tables[table] || [])];
    const builder = {
      where(cond) {
        if (typeof cond === 'function') {
          const collected = {};
          const ctx = {
            where(c) { collected.and = c; return ctx; },
            orWhereNull(col) { collected.orNull = col; return ctx; },
          };
          cond.call(ctx);
          rows = rows.filter((row) => {
            const andMatch = collected.and
              ? Object.entries(collected.and).every(([k, v]) => row[k] === v) : true;
            const nullMatch = collected.orNull ? row[collected.orNull] == null : false;
            return andMatch || nullMatch;
          });
          return builder;
        }
        rows = rows.filter((row) => Object.entries(cond).every(([k, v]) => row[k] === v));
        return builder;
      },
      whereIn(col, values) {
        rows = rows.filter((row) => values.includes(row[col]));
        return builder;
      },
      first(...cols) { return Promise.resolve(rows[0] ? pick(rows[0], cols) : undefined); },
      select(...cols) { return Promise.resolve(rows.map((row) => pick(row, cols))); },
    };
    return builder;
  };
}

// ---- pure precedence resolution (resolveCompletionDefaultProductNames) ----

describe('resolveCompletionDefaultProductNames precedence', () => {
  const protocols = {
    pest: {
      visits: [
        {
          visit: 1, month: 'Any',
          completionDefaultProducts: ['Taurus SC', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant'],
        },
        { visit: 2, month: 'Any', completionDefaultProducts: ['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait'] },
      ],
    },
    lawn: { st_augustine: { visits: [{ visit: 1, month: 'Jan', completionDefaultProducts: ['Should never surface'] }] } },
  };

  test('protocol visit hints win over the services.default_products fallback', () => {
    const result = resolveCompletionDefaultProductNames({
      protocols, serviceType: 'General Pest Control (Quarterly)',
      fallbackDefaultProducts: ['Demand CS', 'Advion Gel'],
    });
    expect(result.source).toBe('protocol_visit');
    expect(result.programKey).toBe('pest');
    expect(result.matchedVisit.visit).toBe(1);
    expect(result.names).toEqual(['Taurus SC', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']);
  });

  test('one-time and re-service pest labels also resolve to the visit-1 defaults', () => {
    for (const serviceType of ['One-Time Pest Control Service', 'Pest Control - Re-Service']) {
      const result = resolveCompletionDefaultProductNames({ protocols, serviceType });
      expect(result.programKey).toBe('pest');
      expect(result.matchedVisit.visit).toBe(1);
      expect(result.names).toEqual(['Taurus SC', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']);
    }
  });

  test('falls back to services.default_products when the matched visit has no curated list', () => {
    const noListProtocols = { pest: { visits: [{ visit: 1, month: 'Any' }] } };
    const result = resolveCompletionDefaultProductNames({
      protocols: noListProtocols, serviceType: 'General Pest Control (Monthly)',
      fallbackDefaultProducts: JSON.stringify(['Demand CS', 'Advion Gel']),
    });
    expect(result.source).toBe('service_default_products');
    expect(result.names).toEqual(['Demand CS', 'Advion Gel']);
  });

  test('no curated list and no fallback resolves to empty, not an error', () => {
    const noListProtocols = { pest: { visits: [{ visit: 1, month: 'Any' }] } };
    const result = resolveCompletionDefaultProductNames({
      protocols: noListProtocols, serviceType: 'General Pest Control (Monthly)',
    });
    expect(result.source).toBe('none');
    expect(result.names).toEqual([]);
  });

  test('lawn is always excluded, even if a visit somehow carries the field', () => {
    const result = resolveCompletionDefaultProductNames({
      protocols, serviceType: 'St. Augustine Lawn Care', month: 1,
      fallbackDefaultProducts: ['Should never surface either'],
    });
    expect(result.programKey).toBe('lawn');
    expect(result.source).toBe('excluded_lawn');
    expect(result.names).toEqual([]);
  });

  test('fail-soft: a matcher throw never propagates, resolves to empty', () => {
    // A malformed `visits` (not an array) makes the matcher's own findVisit
    // throw ('not-an-array'.find is not a function) once a rule matches —
    // the resolver must swallow that and answer empty, never crash the
    // completion drawer over a config-file typo.
    const brokenProtocols = { pest: { visits: 'not-an-array' } };
    expect(() => resolveCompletionDefaultProductNames({
      protocols: brokenProtocols, serviceType: 'General Pest Control (Quarterly)',
    })).not.toThrow();
    const result = resolveCompletionDefaultProductNames({
      protocols: brokenProtocols, serviceType: 'General Pest Control (Quarterly)',
    });
    expect(result.names).toEqual([]);
    expect(result.programKey).toBeNull();
  });

  test('duplicate names in a curated list are deduped, case-insensitively, in order', () => {
    const dupeProtocols = { pest: { visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Taurus SC', 'taurus sc', 'Alpine WSG'] }] } };
    const result = resolveCompletionDefaultProductNames({ protocols: dupeProtocols, serviceType: 'General Pest Control (Quarterly)' });
    expect(result.names).toEqual(['Taurus SC', 'Alpine WSG']);
  });
});

// ---- seasonal windows + rate/amount objects (owner ruling 2026-09-27) ----

describe('seasonal window resolution', () => {
  const windows = [
    { months: [1, 2, 3], products: ['Winter product'] },
    { months: [10, 11, 12], products: ['Fall/winter product'] },
  ];

  test('isSeasonalWindowList distinguishes the new shape from a plain list', () => {
    expect(isSeasonalWindowList(windows)).toBe(true);
    expect(isSeasonalWindowList(['Taurus SC', 'Alpine WSG'])).toBe(false);
    expect(isSeasonalWindowList([])).toBe(false);
    expect(isSeasonalWindowList(null)).toBe(false);
  });

  test('resolveSeasonalWindow picks the window containing the month, including a December-to-October wrap set', () => {
    expect(resolveSeasonalWindow(windows, 1)?.products).toEqual(['Winter product']);
    expect(resolveSeasonalWindow(windows, 12)?.products).toEqual(['Fall/winter product']);
    expect(resolveSeasonalWindow(windows, 6)).toBeNull();
  });

  test('a seasonal visit with no window for the given month falls through to the fallback, not an error', () => {
    const protocols = { pest: { visits: [{ visit: 1, month: 'Any', completionDefaultProducts: windows }] } };
    const result = resolveCompletionDefaultProductNames({
      protocols, serviceType: 'General Pest Control (Quarterly)', month: 6,
      fallbackDefaultProducts: ['Fallback product'],
    });
    expect(result.source).toBe('service_default_products');
    expect(result.names).toEqual(['Fallback product']);
  });

  test('a plain (non-seasonal) list ignores month entirely — back-compat for cockroach / pest visit 2', () => {
    const protocols = { pest: { visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Alpine WSG', 'Gentrol IGR'] }] } };
    for (const month of [1, 6, 12, null]) {
      const result = resolveCompletionDefaultProductNames({ protocols, serviceType: 'General Pest Control (Quarterly)', month });
      expect(result.names).toEqual(['Alpine WSG', 'Gentrol IGR']);
    }
  });
});

describe('protocol-specified rate/amount object entries', () => {
  test('a rate object entry carries its ratePerGal x typicalGallons through to the shaped line', async () => {
    const protocols = {
      pest: {
        visits: [{
          visit: 1, month: 'Any',
          completionDefaultProducts: [{ name: 'Atticus Talak 7.9 F', ratePerGal: 0.5, rateUnit: 'fl_oz/gal', typicalGallons: 3, zone: 'band' }],
        }],
      },
    };
    const db = fakeDb({
      scheduled_services: [{ id: 'svc-rate', customer_id: 'cust-1', service_id: null, service_type: 'General Pest Control (Quarterly)', service_key_snapshot: null, scheduled_date: '2026-06-10' }],
      services: [],
      products_catalog: [{ id: 'p5', name: 'Atticus Talak 7.9 F', category: 'Insecticide', formulation: 'SC', application_method: 'perimeter_spray', default_rate_per_1000: null, rate_unit: 'fl_oz', default_rate: null, default_unit: null, epa_reg_number: '91234-145', active: true }],
      product_aliases: [],
    });
    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-rate', protocols });
    expect(result.products).toHaveLength(1);
    const line = result.products[0];
    expect(line.protocolRate).toBe(0.5);
    expect(line.protocolRateUnit).toBe('fl_oz/gal');
    expect(line.protocolAmount).toBe(1.5); // 0.5 x 3
    expect(line.protocolAmountUnit).toBe('fl_oz');
    expect(line.zone).toBe('band');
  });

  test('a plain string entry (no rate object) carries no protocol rate — client falls back to the catalog default', async () => {
    const protocols = { cockroach: { visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Alpine WSG'] }] } };
    const db = fakeDb({
      scheduled_services: [{ id: 'svc-plain', customer_id: 'cust-1', service_id: null, service_type: 'Cockroach Control Service', service_key_snapshot: null, scheduled_date: '2026-06-10' }],
      services: [],
      products_catalog: [{ id: 'p1', name: 'Alpine WSG', category: 'Insecticide', formulation: 'WSG', application_method: 'perimeter_spray', default_rate_per_1000: null, rate_unit: 'oz', default_rate: '0.5-1', default_unit: 'oz', epa_reg_number: '432-1333', active: true }],
      product_aliases: [],
    });
    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-plain', protocols });
    expect(result.products[0].protocolRate).toBeNull();
    expect(result.products[0].protocolAmount).toBeNull();
    expect(result.products[0].zone).toBeNull();
  });
});

// ---- calendar month from a DATE column (pre-push audit P1) ----
//
// scheduled_date is a DATE column with no time-of-day. The bug: building
// `new Date(value)` and reading it back through an America/New_York
// formatter (etParts) reads UTC midnight as still the PREVIOUS day in ET,
// so the 1st of a month resolved the LAST day of the PRIOR month's
// window. monthFromDateColumn reads the calendar parts directly — a
// 'YYYY-MM-DD' string prefix, or getUTCMonth() on a Date the pg driver
// built at UTC midnight — exactly like recap-payload.js's
// formatServiceDate, never through an ET conversion.
describe('monthFromDateColumn (pre-push audit P1: no ET shift on month/year boundaries)', () => {
  test.each([
    ['2026-10-01', 10],
    ['2026-01-01', 1],
    ['2026-12-01', 12],
    ['2026-06-15', 6],
  ])('a %s string date column resolves month %i, not the day before', (dateString, expectedMonth) => {
    expect(monthFromDateColumn(dateString)).toBe(expectedMonth);
  });

  test.each([
    [new Date('2026-10-01T00:00:00.000Z'), 10],
    [new Date('2026-01-01T00:00:00.000Z'), 1],
    [new Date('2026-12-01T00:00:00.000Z'), 12],
  ])('a Date object built at UTC midnight for the 1st of the month resolves that month, not the ET-shifted previous one', (dateValue, expectedMonth) => {
    // The exact shape node-pg hands back for a DATE column: a JS Date at
    // UTC midnight. new Date(...).toLocaleString with timeZone
    // 'America/New_York' would read this as 8pm the PREVIOUS day — the
    // bug this function exists to avoid.
    expect(monthFromDateColumn(dateValue)).toBe(expectedMonth);
  });

  test('null/undefined/unparseable resolves to null, never throws', () => {
    expect(monthFromDateColumn(null)).toBeNull();
    expect(monthFromDateColumn(undefined)).toBeNull();
    expect(monthFromDateColumn('not a date')).toBeNull();
    expect(monthFromDateColumn(new Date('invalid'))).toBeNull();
  });
});

describe('resolveCompletionProductDefaults: month-boundary dates select the right seasonal window', () => {
  // A synthetic seasonal protocol (the generic mechanism — no real program
  // carries this shape today; pest's own seasonal rotation is parked for a
  // later PR per the owner ruling of 2026-09-27). Two adjacent windows so a
  // one-day month-boundary error is unambiguous, not a coincidental match.
  const seasonalProtocols = {
    rodent: {
      visits: [{
        visit: 1, month: 'Any',
        completionDefaultProducts: [
          { months: [7, 8, 9], products: ['Summer product'] },
          { months: [10, 11, 12], products: ['Fall/winter product'] },
        ],
      }],
    },
  };

  function scheduledServiceDb(scheduledDate) {
    return fakeDb({
      scheduled_services: [{ id: 'svc-boundary', service_id: null, service_type: 'Rodent Monitoring', service_key_snapshot: null, scheduled_date: scheduledDate }],
      services: [],
      products_catalog: [],
      product_aliases: [],
    });
  }

  test('October 1st (string date) resolves the Oct-Dec window, not Jul-Sep', async () => {
    const result = await resolveCompletionProductDefaults({ db: scheduledServiceDb('2026-10-01'), serviceId: 'svc-boundary', protocols: seasonalProtocols });
    expect(result.unresolved).toEqual(['Fall/winter product']);
  });

  test('October 1st as a UTC-midnight Date object still resolves Oct-Dec, not the ET-shifted Sep 30', async () => {
    const result = await resolveCompletionProductDefaults({
      db: scheduledServiceDb(new Date('2026-10-01T00:00:00.000Z')), serviceId: 'svc-boundary', protocols: seasonalProtocols,
    });
    expect(result.unresolved).toEqual(['Fall/winter product']);
  });

  test('January 1st resolves neither window (no Jan-Mar window in this fixture) — proves the month read is exact, not off by one into December', async () => {
    const result = await resolveCompletionProductDefaults({ db: scheduledServiceDb('2026-01-01'), serviceId: 'svc-boundary', protocols: seasonalProtocols });
    // Neither window covers January — an off-by-one bug reading this as
    // December would have wrongly matched the Oct-Dec window instead.
    expect(result.source).toBe('none');
    expect(result.products).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

// ---- real protocols.json: the owner-ruling lists actually landed ----

describe('protocols.json completionDefaultProducts (owner rulings 2026-09-26/27)', () => {
  test('pest visit 1 (recurring/one-time general pest) carries NO completionDefaultProducts — owned by pest-default-mix.js', () => {
    // Owner ruling 2026-09-27 (pre-push audit): keep the pest 4-oz house
    // mix (lib/pest-default-mix.js) for now; a seasonal pest rotation with
    // per-window rates is parked for a later PR. Resolving through this
    // module for a plain recurring pest visit must fall through to the
    // services.default_products fallback (or empty) exactly like any
    // other program the owner hasn't curated yet — never invent a pest
    // default here.
    const visit1 = realProtocols.pest.visits.find((v) => v.visit === 1);
    expect(visit1.completionDefaultProducts).toBeUndefined();
    const result = resolveCompletionDefaultProductNames({
      protocols: realProtocols, serviceType: 'General Pest Control (Quarterly)',
    });
    expect(result.programKey).toBe('pest');
    expect(result.matchedVisit.visit).toBe(1);
    expect(result.source).toBe('none');
    expect(result.names).toEqual([]);
  });

  test('pest visit 2 (German roach cleanout) and cockroach visit 1 share the roach defaults', () => {
    const pestVisit2 = realProtocols.pest.visits.find((v) => v.visit === 2);
    const cockroachVisit1 = realProtocols.cockroach.visits.find((v) => v.visit === 1);
    expect(pestVisit2.completionDefaultProducts).toEqual(['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait']);
    expect(cockroachVisit1.completionDefaultProducts).toEqual(['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait']);
  });

  test('"Cockroach Control Service" resolves to the cockroach program visit 1 (German cleanout)', () => {
    const result = resolveCompletionDefaultProductNames({ protocols: realProtocols, serviceType: 'Cockroach Control Service' });
    expect(result.programKey).toBe('cockroach');
    expect(result.matchedVisit.visit).toBe(1);
    expect(result.source).toBe('protocol_visit');
    expect(result.names).toEqual(['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait']);
  });

  test('other curated-less programs (pest visit 1, tree & shrub, mosquito, termite) carry no field yet', () => {
    for (const visitList of Object.values({
      tree_shrub: realProtocols.tree_shrub.visits,
      mosquito: realProtocols.mosquito.visits,
      termite: realProtocols.termite.visits,
    })) {
      for (const visit of visitList) {
        expect(visit.completionDefaultProducts).toBeUndefined();
      }
    }
    expect(realProtocols.pest.visits.find((v) => v.visit === 1).completionDefaultProducts).toBeUndefined();
  });
});

// ---- catalog name resolution (resolveCatalogProductForName) ----

describe('resolveCatalogProductForName', () => {
  const catalog = [
    { id: 'p1', name: 'Alpine WSG', active: true },
    { id: 'p2', name: 'Gentrol IGR', active: true },
    { id: 'p3', name: 'Advion Cockroach Gel Bait', active: true, aliases: [] },
    { id: 'p4', name: 'Taurus SC', active: true },
    { id: 'p5', name: 'Atticus Talak 7.9 F', active: true },
    { id: 'p6', name: 'LESCO 90/10 Nonionic Surfactant', active: true },
    // The deactivated loser row from the 2026-07-12 dedupe — must never win.
    { id: 'p3-loser', name: 'Advion Cockroach Gel', active: false },
  ];

  test('exact name match', () => {
    expect(resolveCatalogProductForName('Alpine WSG', catalog).id).toBe('p1');
    expect(resolveCatalogProductForName('taurus sc', catalog).id).toBe('p4');
  });

  test('alias resolves via product_aliases before falling to token-subset', () => {
    const withAlias = catalog.map((row) => (row.id === 'p3' ? { ...row, aliases: ['Advion Gel'] } : row));
    expect(resolveCatalogProductForName('Advion Gel', withAlias).id).toBe('p3');
  });

  test('legacy "Advion Gel" token-subset-resolves to "Advion Cockroach Gel Bait" with no alias row', () => {
    // services.default_products still says "Advion Gel" for several rows
    // (20260602000002_cockroach_control_service.js) — this is the un-aliased
    // path that name must resolve through. Caller passes ACTIVE rows only
    // (as the real orchestrator does) — the deactivated 2026-07-12 dedupe
    // loser is excluded upstream, not by this pure matcher.
    const noAliasActiveCatalog = catalog.filter((row) => row.active !== false).map((row) => ({ ...row, aliases: [] }));
    const match = resolveCatalogProductForName('Advion Gel', noAliasActiveCatalog);
    expect(match?.id).toBe('p3');
  });

  test('never resolves to a deactivated/superseded row', () => {
    // Only active rows are ever passed in by the orchestrator, but the pure
    // matcher itself must not prefer a "better" inactive name over an active one.
    const activeOnly = catalog.filter((row) => row.active !== false);
    expect(resolveCatalogProductForName('Advion Gel', activeOnly).id).toBe('p3');
  });

  test('an unrelated or unanchored name resolves to nothing', () => {
    expect(resolveCatalogProductForName('Some Unlisted Product', catalog)).toBeNull();
    expect(resolveCatalogProductForName('CS', catalog)).toBeNull();
    expect(resolveCatalogProductForName('', catalog)).toBeNull();
  });
});

// ---- DB-backed orchestrator (resolveCompletionProductDefaults) ----

describe('resolveCompletionProductDefaults (fake db)', () => {
  const protocols = {
    pest: {
      visits: [
        { visit: 1, month: 'Any', completionDefaultProducts: ['Taurus SC', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant'] },
      ],
    },
    cockroach: {
      visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait'] }],
    },
    lawn: { st_augustine: { visits: [{ visit: 1, month: 'Jan' }] } },
  };

  function catalogTables() {
    return {
      products_catalog: [
        { id: 'p1', name: 'Alpine WSG', category: 'Insecticide', formulation: 'WSG', application_method: 'perimeter_spray', default_rate_per_1000: null, rate_unit: 'oz', default_rate: '0.5-1', default_unit: 'oz', epa_reg_number: '432-1333', active: true },
        { id: 'p2', name: 'Gentrol IGR', category: 'IGR', formulation: 'Aerosol', application_method: 'spot_treatment', default_rate_per_1000: null, rate_unit: null, default_rate: null, default_unit: null, epa_reg_number: '2724-529', active: true },
        { id: 'p3', name: 'Advion Cockroach Gel Bait', category: 'Bait', formulation: 'Gel', application_method: 'bait_placement', default_rate_per_1000: null, rate_unit: null, default_rate: null, default_unit: null, epa_reg_number: '352-746', active: true },
        { id: 'p4', name: 'Taurus SC', category: 'Insecticide', formulation: 'SC', application_method: 'perimeter_spray', default_rate_per_1000: 0.8, rate_unit: 'fl_oz', default_rate: null, default_unit: null, epa_reg_number: '53883-279', active: true },
        { id: 'p6', name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant', formulation: 'Liquid', application_method: null, default_rate_per_1000: null, rate_unit: 'fl_oz/gal', default_rate: '0.2', default_unit: 'fl_oz/gal', epa_reg_number: null, active: true },
      ],
      product_aliases: [],
      scheduled_services: [],
      services: [],
    };
  }

  test('protocol hints win: pest visit 1 resolves Taurus SC / Talak / LESCO 90/10 (Talak unresolved — not in fixture catalog)', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-1', service_id: 'lib-pest', service_type: 'General Pest Control (Quarterly)', service_key_snapshot: 'pest_general_quarterly', scheduled_date: '2026-10-01' }];
    tables.services = [{ id: 'lib-pest', default_products: JSON.stringify(['Demand CS', 'Advion Gel']) }];
    const db = fakeDb(tables);

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-1', protocols });
    expect(result.source).toBe('protocol_visit');
    expect(result.programKey).toBe('pest');
    expect(result.products.map((p) => p.name)).toEqual(['Taurus SC', 'LESCO 90/10 Nonionic Surfactant']);
    // "Atticus Talak 7.9 F" has no row in this fixture's tiny catalog —
    // reported unresolved, never dropped silently or substituted.
    expect(result.unresolved).toEqual(['Atticus Talak 7.9 F']);
  });

  test('default_products fallback resolves and aliases "Advion Gel" to the current catalog name', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-2', service_id: 'lib-none', service_type: 'Some Untracked Pest Visit With No Protocol Match At All', service_key_snapshot: null, scheduled_date: '2026-10-01' }];
    // No completionDefaultProducts anywhere for this made-up service type —
    // route it through a protocols object with no matching program data.
    tables.services = [{ id: 'lib-none', default_products: JSON.stringify(['Advion Gel']) }];
    const db = fakeDb(tables);
    const emptyProtocols = { pest: { visits: [{ visit: 1, month: 'Any' }] } };

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-2', protocols: emptyProtocols });
    expect(result.source).toBe('service_default_products');
    expect(result.products.map((p) => p.name)).toEqual(['Advion Cockroach Gel Bait']);
    expect(result.unresolved).toEqual([]);
  });

  test('cockroach program resolves its three defaults by catalog id, with a "source" stamp', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-3', service_id: 'lib-roach', service_type: 'Cockroach Control Service', service_key_snapshot: 'cockroach_control', scheduled_date: '2026-10-01' }];
    tables.services = [{ id: 'lib-roach', default_products: JSON.stringify(['Alpine WSG', 'Advion Gel', 'Gentrol IGR']) }];
    const db = fakeDb(tables);

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-3', protocols });
    expect(result.programKey).toBe('cockroach');
    expect(result.source).toBe('protocol_visit');
    const byName = Object.fromEntries(result.products.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['Advion Cockroach Gel Bait', 'Alpine WSG', 'Gentrol IGR'].sort());
    expect(byName['Advion Cockroach Gel Bait'].source).toEqual({ programKey: 'cockroach', visit: 1, origin: 'protocol_visit' });
  });

  test('lawn is excluded end to end: no products, source excluded_lawn', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-4', service_id: 'lib-lawn', service_type: 'St. Augustine Lawn Care', service_key_snapshot: null, scheduled_date: '2026-01-15' }];
    tables.services = [{ id: 'lib-lawn', default_products: JSON.stringify(['Should never surface']) }];
    const db = fakeDb(tables);

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-4', protocols });
    expect(result.programKey).toBe('lawn');
    expect(result.source).toBe('excluded_lawn');
    expect(result.products).toEqual([]);
  });

  test('fail-soft: a missing scheduled service resolves to an empty result, never throws', async () => {
    const db = fakeDb(catalogTables());
    const result = await resolveCompletionProductDefaults({ db, serviceId: 'does-not-exist', protocols });
    expect(result.products).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.source).toBe('none');
  });

  test('fail-soft: a thrown DB error resolves to an empty result, never throws', async () => {
    const throwingDb = () => ({
      where() { throw new Error('connection reset'); },
    });
    const result = await resolveCompletionProductDefaults({ db: throwingDb, serviceId: 'svc-1', protocols });
    expect(result.products).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  test('no db or no serviceId resolves to an empty result without querying', async () => {
    expect((await resolveCompletionProductDefaults({})).products).toEqual([]);
    expect((await resolveCompletionProductDefaults({ db: fakeDb(catalogTables()) })).products).toEqual([]);
  });
});
