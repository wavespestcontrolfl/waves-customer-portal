const {
  resolveCompletionDefaultProductNames,
  resolveCatalogProductForName,
  resolveCompletionProductDefaults,
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

describe('resolveCompletionDefaultProductNames', () => {
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

  test('a curated visit resolves source protocol_visit with its ordered names', () => {
    const result = resolveCompletionDefaultProductNames({ protocols, serviceType: 'General Pest Control (Quarterly)' });
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

  test('no curated list on the matched visit resolves to empty, not an error (no services.default_products fallback — Codex r2 P2, PR #5049)', () => {
    const noListProtocols = { pest: { visits: [{ visit: 1, month: 'Any' }] } };
    const result = resolveCompletionDefaultProductNames({
      protocols: noListProtocols, serviceType: 'General Pest Control (Monthly)',
    });
    expect(result.source).toBe('none');
    expect(result.names).toEqual([]);
    expect(result.methodsByName).toEqual({});
  });

  test('lawn is always excluded, even if a visit somehow carries the field', () => {
    const result = resolveCompletionDefaultProductNames({ protocols, serviceType: 'St. Augustine Lawn Care', month: 1 });
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

// ---- lineMeta completionApplicationMethod (Codex r2 P1, PR #5049) ----
//
// Alpine WSG and Gentrol IGR carry no products_catalog.application_method,
// so the client's own defaultApplicationMethodForLine infers
// 'perimeter_spray' for them — wrong for German-roach work, which applies
// both INSIDE, and 'perimeter_spray' demands linear footage the tech never
// measured for an interior placement. A lineMeta line's own
// completionApplicationMethod (one of the drawer's own method dropdown
// values) is the resolver's per-product override.
describe('resolveCompletionDefaultProductNames methodsByName', () => {
  const protocolsWithMethods = {
    cockroach: {
      visits: [{
        visit: 1, month: 'Any',
        completionDefaultProducts: ['Advion Cockroach Gel Bait', 'Alpine WSG', 'Gentrol IGR'],
        lineMeta: {
          'Apply cockroach gel bait in targeted placements': {
            scope: 'interior', treatmentApplied: true,
            catalogProductHints: ['Advion Cockroach Gel Bait'],
            completionApplicationMethod: 'bait_placement',
          },
          'Use non-repellent crack-and-crevice treatment where label allows': {
            scope: 'interior', treatmentApplied: true,
            catalogProductHints: ['Alpine WSG'],
            completionApplicationMethod: 'spot_treatment',
          },
          'Apply IGR point-source or aerosol where label allows': {
            scope: 'interior', treatmentApplied: true,
            catalogProductHints: ['Gentrol IGR'],
            completionApplicationMethod: 'spot_treatment',
          },
        },
      }],
    },
  };

  test('each curated name resolves the method named on the lineMeta line whose catalogProductHints names it', () => {
    const result = resolveCompletionDefaultProductNames({ protocols: protocolsWithMethods, serviceType: 'Cockroach Control Service' });
    expect(result.methodsByName).toEqual({
      'advion cockroach gel bait': 'bait_placement',
      'alpine wsg': 'spot_treatment',
      'gentrol igr': 'spot_treatment',
    });
  });

  test('a curated name with no matching lineMeta line (or no completionApplicationMethod on it) is simply absent from methodsByName', () => {
    const protocols = {
      cockroach: {
        visits: [{
          visit: 1, month: 'Any',
          completionDefaultProducts: ['Unnamed Product'],
          lineMeta: { 'Some line': { catalogProductHints: ['Something else'], completionApplicationMethod: 'spot_treatment' } },
        }],
      },
    };
    const result = resolveCompletionDefaultProductNames({ protocols, serviceType: 'Cockroach Control Service' });
    expect(result.methodsByName).toEqual({});
  });

  test('a visit with no lineMeta at all resolves an empty methodsByName, never throws', () => {
    const protocols = { cockroach: { visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Alpine WSG'] }] } };
    const result = resolveCompletionDefaultProductNames({ protocols, serviceType: 'Cockroach Control Service' });
    expect(result.methodsByName).toEqual({});
  });
});

// ---- follow-up visit override (Codex r3 P1, PR #5049) ----
//
// POST /:serviceId/schedule-followup books a follow-up child by copying
// its source visit's service_type verbatim and marking it ONLY with
// scheduled_services.followup_source_service_id — text/service-key
// matching alone resolves it back to the SOURCE visit's own rule.
// isFollowup overrides the resolved visit to the matched program's own
// follow-up visit, found from protocol-matcher's MATCH_RULES table
// (reason ending "_followup"), never a hard-coded visit number.
describe('resolveCompletionDefaultProductNames isFollowup (Codex r3 P1, PR #5049)', () => {
  const protocols = {
    cockroach: {
      visits: [
        { visit: 1, month: 'Any', completionDefaultProducts: ['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait'] },
        { visit: 2, month: 'Any' },
        // No completionDefaultProducts today — matches real protocols.json.
        { visit: 3, month: 'Any' },
      ],
    },
    pest: {
      visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Taurus SC'] }],
    },
  };

  test('a follow-up child of a cockroach service resolves visit 3 (reason cockroach_followup), source none — never the visit-1 cleanout mix', () => {
    const result = resolveCompletionDefaultProductNames({
      protocols, serviceType: 'Cockroach Control Service', isFollowup: true,
    });
    expect(result.programKey).toBe('cockroach');
    expect(result.matchedVisit).toEqual({ visit: 3, reason: 'cockroach_followup', matched: true });
    expect(result.source).toBe('none');
    expect(result.names).toEqual([]);
  });

  test('without isFollowup the same service still resolves visit 1 as usual (regression)', () => {
    const result = resolveCompletionDefaultProductNames({ protocols, serviceType: 'Cockroach Control Service' });
    expect(result.programKey).toBe('cockroach');
    expect(result.matchedVisit).toEqual({ visit: 1, reason: 'cockroach_control', matched: true });
    expect(result.source).toBe('protocol_visit');
  });

  test('isFollowup on a program with no follow-up rule (pest) leaves the normal resolution untouched', () => {
    const result = resolveCompletionDefaultProductNames({
      protocols, serviceType: 'General Pest Control (Quarterly)', isFollowup: true,
    });
    expect(result.programKey).toBe('pest');
    expect(result.matchedVisit.visit).toBe(1);
    expect(result.source).toBe('protocol_visit');
    expect(result.names).toEqual(['Taurus SC']);
  });

  test('isFollowup true but this protocols object has no visit 3 for cockroach falls back to the normal visit, never throws', () => {
    const noVisit3 = { cockroach: { visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Alpine WSG'] }] } };
    const result = resolveCompletionDefaultProductNames({
      protocols: noVisit3, serviceType: 'Cockroach Control Service', isFollowup: true,
    });
    expect(result.matchedVisit.visit).toBe(1);
    expect(result.source).toBe('protocol_visit');
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

describe('monthFromDateColumn feeding a real month-keyed program (tree & shrub)', () => {
  // completionDefaultProducts has no seasonal shape (removed, PR #5049 r1 —
  // AGENTS.md: no unexercised config contracts), but month-keyed PROGRAMS
  // (lawn, tree & shrub — one visit per calendar month) still resolve
  // their VISIT off this same month value via protocol-matcher.js's own
  // monthVisit — this is the real consumer monthFromDateColumn's fix
  // matters for. Tree & shrub visit numbers equal the calendar month
  // (visit 10 = Oct) so a wrong month reads as the wrong visit number.
  function monthFor(scheduledDate) {
    const result = resolveCompletionDefaultProductNames({
      protocols: realProtocols, serviceType: 'Tree & Shrub Care',
      month: monthFromDateColumn(scheduledDate),
    });
    return result.matchedVisit.visit;
  }

  test('October 1st (string date) resolves the October visit (10), not September', () => {
    expect(monthFor('2026-10-01')).toBe(10);
  });

  test('October 1st as a UTC-midnight Date object still resolves October, not the ET-shifted Sep 30', () => {
    // The exact shape node-pg hands back for a DATE column. Reading this
    // through an America/New_York formatter would land on Sep 30 evening —
    // the bug monthFromDateColumn exists to avoid.
    expect(monthFor(new Date('2026-10-01T00:00:00.000Z'))).toBe(10);
  });

  test('January 1st resolves the January visit (1), not December of the prior year', () => {
    expect(monthFor('2026-01-01')).toBe(1);
    expect(monthFor(new Date('2026-01-01T00:00:00.000Z'))).toBe(1);
  });

  test('a mid-month date is unaffected either way', () => {
    expect(monthFor('2026-06-15')).toBe(6);
  });
});

// ---- real protocols.json: the owner-ruling lists actually landed ----

describe('protocols.json completionDefaultProducts + completionApplicationMethod (owner rulings 2026-09-26/27, Codex r2)', () => {
  test('pest visit 1 (recurring/one-time general pest) carries NO completionDefaultProducts — owned by pest-default-mix.js', () => {
    // Owner ruling 2026-09-27 (pre-push audit): keep the pest 4-oz house
    // mix (lib/pest-default-mix.js) for now; a seasonal pest rotation with
    // per-window rates is parked for a later PR. Resolving through this
    // module for a plain recurring pest visit resolves to empty, exactly
    // like any other program the owner hasn't curated yet — never invent
    // a pest default here.
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

  test('cockroach visit 1 carries the roach defaults with their interior protocol methods', () => {
    const cockroachVisit1 = realProtocols.cockroach.visits.find((v) => v.visit === 1);
    expect(cockroachVisit1.completionDefaultProducts).toEqual(['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait']);
    expect(resolveCompletionDefaultProductNames({ protocols: realProtocols, serviceType: 'Cockroach Control Service' }).methodsByName)
      .toEqual({
        'alpine wsg': 'spot_treatment',
        'gentrol igr': 'spot_treatment',
        'advion cockroach gel bait': 'bait_placement',
      });
  });

  test('pest visit 2 carries no completion defaults — every real roach service routes to the cockroach program', () => {
    // The pest program is prefilled by pest-default-mix.js (owner ruling
    // 2026-09-27), so a list here could never reach the drawer.
    expect(realProtocols.pest.visits.find((v) => v.visit === 2).completionDefaultProducts).toBeUndefined();
    for (const serviceType of [
      'Cockroach Treatment Service', 'German Roach Cleanout Service',
      'German Roach Initial Service (3-Visit)', 'Initial German Roach Knockdown Service',
    ]) {
      const result = resolveCompletionDefaultProductNames({ protocols: realProtocols, serviceType });
      expect(result.programKey).toBe('cockroach');
      expect(result.matchedVisit.visit).toBe(1);
      expect(result.names).toEqual(['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait']);
    }
  });

  test('the native (exterior-species) roach knockdown routes to the exterior visit and prefills nothing', () => {
    // German interior products (gel bait, IGR, crack & crevice) must not
    // seed an American / smoky brown / palmetto knockdown.
    for (const args of [
      { serviceType: 'Initial Native Roach Knockdown Service' },
      { serviceType: 'Pest knockdown', serviceKey: 'pest_initial_palmetto_knockdown' },
    ]) {
      const result = resolveCompletionDefaultProductNames({ protocols: realProtocols, ...args });
      expect(result.programKey).toBe('cockroach');
      expect(result.matchedVisit.visit).toBe(2);
      expect(result.source).toBe('none');
      expect(result.names).toEqual([]);
    }
  });

  test('"Cockroach Control Service" resolves to the cockroach program visit 1 (German cleanout)', () => {
    const result = resolveCompletionDefaultProductNames({ protocols: realProtocols, serviceType: 'Cockroach Control Service' });
    expect(result.programKey).toBe('cockroach');
    expect(result.matchedVisit.visit).toBe(1);
    expect(result.source).toBe('protocol_visit');
    expect(result.names).toEqual(['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait']);
  });

  test('other curated-less programs (pest visit 1, mosquito, termite) carry no field yet', () => {
    for (const visitList of Object.values({
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
  test('ambiguous exact names, vendorless aliases and equally tight token matches stay unresolved', () => {
    expect(resolveCatalogProductForName('Fixture product', [
      { id: 'a', name: 'Fixture product' }, { id: 'b', name: 'Fixture product' },
    ])).toBeNull();
    expect(resolveCatalogProductForName('Fixture alias', [
      { id: 'a', name: 'Product A', aliases: ['Fixture alias'] },
      { id: 'b', name: 'Product B', aliases: ['Fixture alias'] },
    ])).toBeNull();
    expect(resolveCatalogProductForName('Fixture product', [
      { id: 'a', name: 'Fixture product alpha' }, { id: 'b', name: 'Fixture product beta' },
    ])).toBeNull();
  });
  test('T&S identities require one exact name or alias instead of a fuzzy SKU match', () => {
    const rows = [{ id: 'a', name: 'LESCO palm fertilizer', aliases: ['LESCO 8-0-12 #511542'] }];
    expect(resolveCatalogProductForName('LESCO 8-0-12 #511542', rows, { exactOnly: true }).id).toBe('a');
    expect(resolveCatalogProductForName('LESCO palm', rows, { exactOnly: true })).toBeNull();
    expect(resolveCatalogProductForName('LESCO 8-0-12 #511542', [...rows, { ...rows[0], id: 'b' }], { exactOnly: true })).toBeNull();
  });
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
      visits: [
        {
          visit: 1, month: 'Any',
          completionDefaultProducts: ['Alpine WSG', 'Gentrol IGR', 'Advion Cockroach Gel Bait'],
          lineMeta: {
            'Crack-and-crevice treatment': { catalogProductHints: ['Alpine WSG'], completionApplicationMethod: 'spot_treatment' },
            'IGR point-source': { catalogProductHints: ['Gentrol IGR'], completionApplicationMethod: 'spot_treatment' },
            'Gel bait': { catalogProductHints: ['Advion Cockroach Gel Bait'], completionApplicationMethod: 'bait_placement' },
          },
        },
        // Visit 3 (protocol-matcher.js reason 'cockroach_followup') — no
        // completionDefaultProducts today, matching real protocols.json.
        { visit: 3, month: 'Any' },
      ],
    },
    lawn: { st_augustine: { visits: [{ visit: 1, month: 'Jan' }] } },
  };

  function catalogTables() {
    return {
      products_catalog: [
        { id: 'p1', name: 'Alpine WSG', category: 'Insecticide', formulation: 'WSG', application_method: null, default_rate_per_1000: null, rate_unit: 'oz', default_rate: '0.5-1', default_unit: 'oz', epa_reg_number: '432-1333', active: true },
        { id: 'p2', name: 'Gentrol IGR', category: 'IGR', formulation: 'Aerosol', application_method: null, default_rate_per_1000: null, rate_unit: null, default_rate: null, default_unit: null, epa_reg_number: '2724-529', active: true },
        { id: 'p3', name: 'Advion Cockroach Gel Bait', category: 'Bait', formulation: 'Gel', application_method: 'bait_placement', default_rate_per_1000: null, rate_unit: null, default_rate: null, default_unit: null, epa_reg_number: '352-746', active: true },
        { id: 'p4', name: 'Taurus SC', category: 'Insecticide', formulation: 'SC', application_method: 'perimeter_spray', default_rate_per_1000: 0.8, rate_unit: 'fl_oz', default_rate: null, default_unit: null, epa_reg_number: '53883-279', active: true },
        { id: 'p6', name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant', formulation: 'Liquid', application_method: null, default_rate_per_1000: null, rate_unit: 'fl_oz/gal', default_rate: '0.2', default_unit: 'fl_oz/gal', epa_reg_number: null, active: true },
      ],
      product_aliases: [],
      scheduled_services: [],
    };
  }

  test('protocol hints win: pest visit 1 resolves Taurus SC / Talak / LESCO 90/10 (Talak unresolved — not in fixture catalog)', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-1', service_id: null, service_type: 'General Pest Control (Quarterly)', service_key_snapshot: 'pest_general_quarterly', scheduled_date: '2026-10-01' }];
    const db = fakeDb(tables);

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-1', protocols });
    expect(result.source).toBe('protocol_visit');
    expect(result.programKey).toBe('pest');
    expect(result.products.map((p) => p.name)).toEqual(['Taurus SC', 'LESCO 90/10 Nonionic Surfactant']);
    // "Atticus Talak 7.9 F" has no row in this fixture's tiny catalog —
    // reported unresolved, never dropped silently or substituted.
    expect(result.unresolved).toEqual(['Atticus Talak 7.9 F']);
  });

  test('no curated list resolves to empty products, source none — no services.default_products fallback query at all', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-2', service_id: null, service_type: 'Some Untracked Pest Visit With No Protocol Match At All', service_key_snapshot: null, scheduled_date: '2026-10-01' }];
    const db = fakeDb(tables);
    const emptyProtocols = { pest: { visits: [{ visit: 1, month: 'Any' }] } };

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-2', protocols: emptyProtocols });
    expect(result.source).toBe('none');
    expect(result.products).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  test('cockroach program resolves its three defaults by catalog id, each carrying its lineMeta application method', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-3', service_id: null, service_type: 'Cockroach Control Service', service_key_snapshot: 'cockroach_control', scheduled_date: '2026-10-01' }];
    const db = fakeDb(tables);

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-3', protocols });
    expect(result.programKey).toBe('cockroach');
    expect(result.source).toBe('protocol_visit');
    const byName = Object.fromEntries(result.products.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['Advion Cockroach Gel Bait', 'Alpine WSG', 'Gentrol IGR'].sort());
    expect(byName['Advion Cockroach Gel Bait'].source).toEqual({ programKey: 'cockroach', visit: 1, origin: 'protocol_visit' });
    // The two products with no catalog application_method get the
    // protocol's own interior method — never the catalog-inferred
    // 'perimeter_spray' that would demand linear footage indoors.
    expect(byName['Alpine WSG'].completionApplicationMethod).toBe('spot_treatment');
    expect(byName['Gentrol IGR'].completionApplicationMethod).toBe('spot_treatment');
    // Advion already resolves correctly via its catalog category (Bait)
    // but the lineMeta stamps the same method for consistency.
    expect(byName['Advion Cockroach Gel Bait'].completionApplicationMethod).toBe('bait_placement');
    expect(byName['Advion Cockroach Gel Bait'].applicationMethod).toBe('bait_placement');
  });

  test('a product whose lineMeta names no completionApplicationMethod carries null, not a guess', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-5', service_id: null, service_type: 'Cockroach Control Service', service_key_snapshot: 'cockroach_control', scheduled_date: '2026-10-01' }];
    const db = fakeDb(tables);
    const noMethodProtocols = {
      cockroach: { visits: [{ visit: 1, month: 'Any', completionDefaultProducts: ['Alpine WSG'] }] },
    };

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-5', protocols: noMethodProtocols });
    expect(result.products[0].completionApplicationMethod).toBeNull();
  });

  test('a follow-up child of a cockroach service (followup_source_service_id set) resolves visit 3, source none — never the visit-1 cleanout mix (Codex r3 P1, PR #5049)', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{
      id: 'svc-followup-1', service_id: null, service_type: 'Cockroach Control Service',
      service_key_snapshot: 'cockroach_control', scheduled_date: '2026-10-01',
      // schedule-followup copies service_type/service_key verbatim from the
      // source visit — only this column marks it as a follow-up child.
      followup_source_service_id: 'svc-3-source',
    }];
    const db = fakeDb(tables);

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-followup-1', protocols });
    expect(result.programKey).toBe('cockroach');
    expect(result.matchedVisit).toEqual({ visit: 3, reason: 'cockroach_followup', matched: true });
    expect(result.source).toBe('none');
    expect(result.products).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  test('a normal (non-follow-up) cockroach visit is unaffected: followup_source_service_id null still resolves visit 1 (regression)', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{
      id: 'svc-6', service_id: null, service_type: 'Cockroach Control Service',
      service_key_snapshot: 'cockroach_control', scheduled_date: '2026-10-01',
      followup_source_service_id: null,
    }];
    const db = fakeDb(tables);

    const result = await resolveCompletionProductDefaults({ db, serviceId: 'svc-6', protocols });
    expect(result.matchedVisit.visit).toBe(1);
    expect(result.source).toBe('protocol_visit');
    expect(result.products.map((p) => p.name).sort()).toEqual(
      ['Advion Cockroach Gel Bait', 'Alpine WSG', 'Gentrol IGR'].sort(),
    );
  });

  test('lawn is excluded end to end: no products, source excluded_lawn', async () => {
    const tables = catalogTables();
    tables.scheduled_services = [{ id: 'svc-4', service_id: null, service_type: 'St. Augustine Lawn Care', service_key_snapshot: null, scheduled_date: '2026-01-15' }];
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
