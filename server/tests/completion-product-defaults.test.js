const {
  resolveCompletionDefaultProductNames,
  resolveCatalogProductForName,
  resolveCompletionProductDefaults,
  resolveSeasonalWindow,
  isSeasonalWindowList,
  applyTaurusYearlySwap,
  countTaurusApplicationsThisYear,
} = require('../services/completion-product-defaults');
const realProtocols = require('../config/protocols.json');

// -- a minimal fake knex: only the chain shapes this module actually calls
// (where/whereIn/whereRaw/join/count/first/select, with select/first/count
// returning real Promises so the module's own .catch(...) works unmodified).
// Synthetic rows/names only. Non-aliased tables (scheduled_services,
// services, products_catalog, product_aliases) behave exactly as the
// original fixture; `join` + `whereRaw` + `count` only matter for the
// Taurus-count query (service_products/service_records, alias-prefixed
// keys post-join).
function fakeDb(tables) {
  function pick(row, cols) {
    if (!cols.length) return { ...row };
    const out = {};
    cols.forEach((col) => { out[col] = row[col]; });
    return out;
  }
  return function db(tableExpr) {
    const [tableName, alias] = String(tableExpr).split(/\s+as\s+/i);
    let rows = (tables[tableName] || []).map((row) => ({ ...row }));
    const builder = {
      join(joinExpr, leftCol, rightCol) {
        const [joinTable, joinAliasRaw] = String(joinExpr).split(/\s+as\s+/i);
        const joinAlias = joinAliasRaw || joinTable;
        const joinRows = tables[joinTable] || [];
        const [, leftField] = leftCol.split('.');
        const [rightAlias, rightField] = rightCol.split('.');
        rows = rows.flatMap((row) => {
          const rowKey = rightAlias === alias ? row[rightField] : row[rightCol] ?? row[rightField];
          const match = joinRows.find((jr) => jr[leftField] === rowKey);
          if (!match) return [];
          const merged = {};
          for (const [k, v] of Object.entries(row)) merged[alias ? `${alias}.${k}` : k] = v;
          for (const [k, v] of Object.entries(match)) merged[`${joinAlias}.${k}`] = v;
          return [merged];
        });
        return builder;
      },
      where(condOrCol, maybeVal) {
        if (typeof condOrCol === 'function') {
          const collected = {};
          const ctx = {
            where(c) { collected.and = c; return ctx; },
            orWhereNull(col) { collected.orNull = col; return ctx; },
          };
          condOrCol.call(ctx);
          rows = rows.filter((row) => {
            const andMatch = collected.and
              ? Object.entries(collected.and).every(([k, v]) => row[k] === v) : true;
            const nullMatch = collected.orNull ? row[collected.orNull] == null : false;
            return andMatch || nullMatch;
          });
          return builder;
        }
        if (typeof condOrCol === 'object' && condOrCol !== null) {
          rows = rows.filter((row) => Object.entries(condOrCol).every(([k, v]) => row[k] === v));
          return builder;
        }
        rows = rows.filter((row) => row[condOrCol] === maybeVal);
        return builder;
      },
      whereIn(col, values) {
        rows = rows.filter((row) => values.includes(row[col]));
        return builder;
      },
      whereRaw(sql, params = []) {
        if (/lower\(/i.test(sql)) {
          const col = sql.match(/lower\(([\w.]+)\)/i)[1];
          rows = rows.filter((row) => String(row[col] || '').toLowerCase() === params[0]);
        } else if (/extract\(year/i.test(sql)) {
          const col = sql.match(/extract\(year from ([\w.]+)\)/i)[1];
          rows = rows.filter((row) => {
            const d = row[col] instanceof Date ? row[col] : new Date(row[col]);
            return d.getUTCFullYear() === Number(params[0]);
          });
        } else if (/!~\*/.test(sql)) {
          const col = sql.match(/([\w.]+)\s*!~\*/)[1];
          const re = new RegExp(params[0], 'i');
          rows = rows.filter((row) => !re.test(String(row[col] || '')));
        }
        return builder;
      },
      count(spec) {
        const key = (String(spec || '')).split(/\s+as\s+/i)[1] || 'count';
        return { first: () => Promise.resolve({ [key]: rows.length }) };
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
      service_products: [],
      service_records: [],
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

describe('applyTaurusYearlySwap (pure)', () => {
  const entries = [
    { name: 'Taurus SC', ratePerGal: 0.8, rateUnit: 'fl_oz/gal', typicalGallons: 1, zone: 'band' },
    { name: 'Alpine WSG', ratePerGal: 10, rateUnit: 'g/gal', typicalGallons: 0.5, zone: 'spots' },
  ];

  test('below the label max (0 or 1 this year), Taurus stays and no note is added', () => {
    for (const count of [0, 1]) {
      const { entries: out, notes } = applyTaurusYearlySwap(entries, count);
      expect(out).toEqual(entries);
      expect(notes).toEqual([]);
    }
  });

  test('at or above the label max (2+), Taurus swaps for Alpine WSG (10 g/gal x 1 gal, foundation) with a note', () => {
    for (const count of [2, 3]) {
      const { entries: out, notes } = applyTaurusYearlySwap(entries, count);
      expect(out.find((e) => e.name === 'Taurus SC')).toBeUndefined();
      const swapped = out.filter((e) => e.name === 'Alpine WSG');
      expect(swapped).toHaveLength(2); // the original Alpine WSG line PLUS the swap-in
      expect(swapped.some((e) => e.ratePerGal === 10 && e.typicalGallons === 1 && e.zone === 'foundation')).toBe(true);
      expect(notes[0]).toMatch(/Taurus SC used/);
      expect(notes[0]).toMatch(new RegExp(`${count}`));
    }
  });

  test('never swaps or notes when Taurus is not even in the list', () => {
    const noTaurus = [{ name: 'Alpine WSG', ratePerGal: 10 }];
    const { entries: out, notes } = applyTaurusYearlySwap(noTaurus, 5);
    expect(out).toEqual(noTaurus);
    expect(notes).toEqual([]);
  });

  test('never blocks: an unusable count (NaN/undefined) is treated as "no swap"', () => {
    expect(applyTaurusYearlySwap(entries, NaN).entries).toEqual(entries);
    expect(applyTaurusYearlySwap(entries, undefined).entries).toEqual(entries);
  });
});

describe('countTaurusApplicationsThisYear', () => {
  function fixture() {
    return {
      service_records: [
        { id: 'rec-1', customer_id: 'cust-1', service_date: '2026-03-10', service_type: 'Quarterly Pest Control' },
        { id: 'rec-2', customer_id: 'cust-1', service_date: '2026-06-10', service_type: 'Quarterly Pest Control' },
        { id: 'rec-3', customer_id: 'cust-1', service_date: '2025-06-10', service_type: 'Quarterly Pest Control' }, // last year — excluded
        { id: 'rec-4', customer_id: 'cust-2', service_date: '2026-06-10', service_type: 'Quarterly Pest Control' }, // different customer — excluded
        { id: 'rec-5', customer_id: 'cust-1', service_date: '2026-07-10', service_type: 'Termite Pretreatment (Trench)' }, // termite — excluded
      ],
      service_products: [
        { id: 'sp-1', service_record_id: 'rec-1', product_name: 'Taurus SC' },
        { id: 'sp-2', service_record_id: 'rec-2', product_name: 'Taurus SC' },
        { id: 'sp-3', service_record_id: 'rec-3', product_name: 'Taurus SC' },
        { id: 'sp-4', service_record_id: 'rec-4', product_name: 'Taurus SC' },
        { id: 'sp-5', service_record_id: 'rec-5', product_name: 'Taurus SC' },
        { id: 'sp-6', service_record_id: 'rec-1', product_name: 'Alpine WSG' }, // different product — excluded
      ],
    };
  }

  test('counts only this customer, this calendar year, non-termite Taurus SC applications', async () => {
    const db = fakeDb(fixture());
    const count = await countTaurusApplicationsThisYear(db, 'cust-1', { asOfDate: new Date('2026-08-01T12:00:00Z') });
    expect(count).toBe(2); // rec-1 + rec-2 only
  });

  test('counts 0 and 1 correctly (the plain-info range, never blocking)', async () => {
    const tables = fixture();
    tables.service_records = tables.service_records.filter((r) => r.id === 'rec-1');
    tables.service_products = tables.service_products.filter((p) => p.service_record_id === 'rec-1');
    const oneDb = fakeDb(tables);
    expect(await countTaurusApplicationsThisYear(oneDb, 'cust-1', { asOfDate: new Date('2026-08-01T12:00:00Z') })).toBe(1);

    const zeroDb = fakeDb({ service_records: [], service_products: [] });
    expect(await countTaurusApplicationsThisYear(zeroDb, 'cust-1', { asOfDate: new Date('2026-08-01T12:00:00Z') })).toBe(0);
  });

  test('excludes termite/pre-slab/trench services from the count', async () => {
    const db = fakeDb(fixture());
    // rec-5 is a Termite Pretreatment (Trench) with a Taurus SC line — must
    // never count toward the perimeter-pest label rotation.
    const count = await countTaurusApplicationsThisYear(db, 'cust-1', { asOfDate: new Date('2026-08-01T12:00:00Z') });
    expect(count).toBe(2);
  });

  test('fail-soft: no db, no customerId, or a throwing query all resolve to 0', async () => {
    expect(await countTaurusApplicationsThisYear(null, 'cust-1')).toBe(0);
    expect(await countTaurusApplicationsThisYear(fakeDb(fixture()), null)).toBe(0);
    const throwingDb = () => ({ join() { throw new Error('boom'); } });
    expect(await countTaurusApplicationsThisYear(throwingDb, 'cust-1')).toBe(0);
  });
});

describe('resolveCompletionProductDefaults end to end: seasonal window + Taurus swap', () => {
  test('a June visit with 2 prior Taurus applications this year swaps Taurus for Alpine WSG and reports the count/note', async () => {
    const db = fakeDb({
      scheduled_services: [{ id: 'svc-swap', customer_id: 'cust-1', service_id: null, service_type: 'Quarterly Pest Control', service_key_snapshot: null, scheduled_date: '2026-06-15' }],
      services: [],
      products_catalog: [
        { id: 'p1', name: 'Alpine WSG', category: 'Insecticide', formulation: 'WSG', application_method: 'perimeter_spray', default_rate_per_1000: null, rate_unit: 'oz', default_rate: '0.5-1', default_unit: 'oz', epa_reg_number: '432-1333', active: true },
        { id: 'p4', name: 'Taurus SC', category: 'Insecticide', formulation: 'SC', application_method: 'perimeter_spray', default_rate_per_1000: 0.8, rate_unit: 'fl_oz', default_rate: null, default_unit: null, epa_reg_number: '53883-279', active: true },
        { id: 'p7', name: 'Onslaught Fastcap', category: 'Insecticide', formulation: 'SC', application_method: 'perimeter_spray', default_rate_per_1000: null, rate_unit: null, default_rate: null, default_unit: null, epa_reg_number: '499-561', active: true },
      ],
      product_aliases: [],
      service_records: [
        { id: 'rec-1', customer_id: 'cust-1', service_date: '2026-01-10', service_type: 'Quarterly Pest Control' },
        { id: 'rec-2', customer_id: 'cust-1', service_date: '2026-04-10', service_type: 'Quarterly Pest Control' },
      ],
      service_products: [
        { id: 'sp-1', service_record_id: 'rec-1', product_name: 'Taurus SC' },
        { id: 'sp-2', service_record_id: 'rec-2', product_name: 'Taurus SC' },
      ],
    });

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-swap', protocols: realProtocols });
    expect(result.programKey).toBe('pest');
    expect(result.taurusYearCount).toBe(2);
    expect(result.notes[0]).toMatch(/Taurus SC used 2/);
    const names = result.products.map((p) => p.name);
    expect(names).not.toContain('Taurus SC');
    // Two Alpine WSG entries this window (the swap-in AND the window's own
    // spots-zone Alpine line) collapse to ONE catalog row, since both
    // resolve to the same product id — the drawer gets one row, not two.
    expect(names.filter((n) => n === 'Alpine WSG')).toHaveLength(1);
    expect(names).toContain('Onslaught Fastcap');
  });

  test('a June visit with fewer than 2 prior Taurus applications keeps Taurus and reports the lower count', async () => {
    const db = fakeDb({
      scheduled_services: [{ id: 'svc-noswap', customer_id: 'cust-2', service_id: null, service_type: 'Quarterly Pest Control', service_key_snapshot: null, scheduled_date: '2026-06-15' }],
      services: [],
      products_catalog: [
        { id: 'p1', name: 'Alpine WSG', active: true },
        { id: 'p4', name: 'Taurus SC', active: true },
        { id: 'p7', name: 'Onslaught Fastcap', active: true },
      ],
      product_aliases: [],
      service_records: [],
      service_products: [],
    });
    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-noswap', protocols: realProtocols });
    expect(result.taurusYearCount).toBe(0);
    expect(result.notes).toEqual([]);
    expect(result.products.map((p) => p.name)).toContain('Taurus SC');
  });
});

// ---- real protocols.json: the owner-ruling lists actually landed ----

describe('protocols.json completionDefaultProducts (owner rulings 2026-09-26/27)', () => {
  test('pest visit 1 is a 4-window seasonal rotation, not a flat list (owner 2026-09-27)', () => {
    const visit1 = realProtocols.pest.visits.find((v) => v.visit === 1);
    expect(isSeasonalWindowList(visit1.completionDefaultProducts)).toBe(true);
    expect(visit1.completionDefaultProducts).toHaveLength(4);
    const monthsCovered = visit1.completionDefaultProducts.flatMap((w) => w.months);
    expect(monthsCovered.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test.each([
    [1, ['Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']],
    [3, ['Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']],
    [4, ['Alpine WSG', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']],
    [5, ['Alpine WSG', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']],
    [6, ['Taurus SC', 'Alpine WSG', 'Onslaught Fastcap']],
    [9, ['Taurus SC', 'Alpine WSG', 'Onslaught Fastcap']],
    [10, ['Alpine WSG', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']],
    [12, ['Alpine WSG', 'Atticus Talak 7.9 F', 'LESCO 90/10 Nonionic Surfactant']],
  ])('month %i resolves the right seasonal window products', (month, expectedNames) => {
    const result = resolveCompletionDefaultProductNames({
      protocols: realProtocols, serviceType: 'General Pest Control (Quarterly)', month,
    });
    expect(result.names).toEqual(expectedNames);
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

  test('other curated-less programs (tree & shrub, mosquito, termite) carry no field yet', () => {
    for (const visitList of Object.values({ tree_shrub: realProtocols.tree_shrub.visits, mosquito: realProtocols.mosquito.visits, termite: realProtocols.termite.visits })) {
      for (const visit of visitList) {
        expect(visit.completionDefaultProducts).toBeUndefined();
      }
    }
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
