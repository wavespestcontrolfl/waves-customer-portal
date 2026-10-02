// Lawn expectations engine + config (lawn report rebuild P10, dark). Pure
// module, synthetic data only. Mirrors pest-report-expectations.test.js.

const fs = require('fs');
const path = require('path');

const config = require('../config/lawn-expectations');
const {
  buildLawnExpectations,
  classifyLawnProduct,
  classifyLawnProductStatus,
  judgeProgress,
  nextVisitState,
  visitGapDays,
  wordCount,
} = require('../services/service-report/lawn-expectations');
const { LAWN_TARGET_SUGGESTIONS } = require('../config/treatment-target-vocabulary');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');

const {
  PRODUCT_ROWS, ISSUE_ROWS, PRODUCT_CLASS_ENTRIES, PRODUCT_CLASS, MAX_LINE_WORDS, CELSIUS_YTD_CAP, FAMILY,
} = config;

const PREVIEW = { includeUnapproved: true };

const REPRESENTATIVE = {
  [FAMILY.BROADLEAF]: 'Celsius WG',
  [FAMILY.SEDGE]: 'Dismiss',
  [FAMILY.PRE_EMERGENT]: 'Prodiamine 65 WDG',
  [FAMILY.GRANULAR_N]: 'LESCO 24-0-11',
  [FAMILY.POTASSIUM]: 'LESCO K-Flow 0-0-25',
  [FAMILY.IRON_MICROS]: 'LESCO Chelated Iron Plus',
  [FAMILY.FUNGICIDE]: 'Artavia 2 SC',
  [FAMILY.INSECTICIDE]: 'Arena 50 WDG',
};
const TARGET = { [FAMILY.FUNGICIDE]: 'large patch', [FAMILY.INSECTICIDE]: 'Southern chinch bugs' };

// Lawn-specific deny list: nothing about watering, rain, sprinklers, mowing,
// county ordinances or blackouts, laws, clock times, or plan tiers.
const LAWN_EXTRA_DENY = [
  /\bwater/i,
  /\birrigat/i,
  /\bsprinkl/i,
  /\brain/i,
  /\bmow/i,
  /\bordinance/i,
  /\bcount(?:y|ies)\b/i,
  /\bblackout/i,
  /\blaws?\b/i,
  /\bfertilizer (?:ban|restriction)/i,
  /\d{1,2}:\d{2}/,
  /\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i,
  /\b(?:noon|midnight)\b/i,
  /\b(?:bronze|silver|enhanced|premium|tier|waveguard)\b/i,
  /\bguarantee/i,
  /\beliminat/i,
  /\bcure[ds]?\b/i,
  /\bwill\b/i,
];

function rowStrings(row) {
  const out = [];
  const push = (label, text) => { if (text) out.push([label, text]); };
  push('visibleChange', row.visibleChange);
  (row.limits || []).forEach((t, i) => push(`limits[${i}]`, t));
  if (row.secondApp) {
    push('secondApp.line', row.secondApp.line);
    push('secondApp.cappedLine', row.secondApp.cappedLine);
  }
  Object.entries(row.byNextVisit || {}).forEach(([k, t]) => push(`byNextVisit.${k}`, t));
  push('contactTrigger', row.contactTrigger);
  Object.entries(row.issueOverrides || {}).forEach(([key, o]) => {
    (o.limits || []).forEach((t, i) => push(`override.${key}.limits[${i}]`, t));
    Object.entries(o.byNextVisit || {}).forEach(([k, t]) => push(`override.${key}.byNextVisit.${k}`, t));
  });
  return out;
}

const ALL_ROWS = [...Object.values(PRODUCT_ROWS), ...Object.values(ISSUE_ROWS)];

describe('lawn expectations config rows', () => {
  it('has a row for every family and every issue key', () => {
    const families = new Set(Object.values(PRODUCT_ROWS).map((r) => r.family));
    Object.values(FAMILY).forEach((family) => expect(families.has(family)).toBe(true));
    ['dry_spot', 'chinch', 'large_patch', 'thin_shade', 'seasonal_dip', 'mowed_short', 'weeds_untreated']
      .forEach((key) => expect(ISSUE_ROWS[key]).toBeTruthy());
    // Every row is reachable through the priority list.
    ALL_ROWS.forEach((row) => expect(config.ROW_PRIORITY).toContain(row.id));
  });

  it('every row ships unapproved and every window carries a proposed|catalog source', () => {
    for (const row of ALL_ROWS) {
      expect(row.approved).toBe(false);
      for (const win of [row.windows?.first, row.windows?.full, row.contactWindow].filter(Boolean)) {
        expect(['proposed', 'catalog']).toContain(win.source);
        if (win.source === 'catalog') expect(win.catalogRef).toBeTruthy();
        if (win.minDays == null) expect(win.text).toBeTruthy(); // qualitative window names itself
      }
    }
  });

  it.each(ALL_ROWS.flatMap((row) => rowStrings(row).map(([label, text]) => [row.id, label, text])))(
    '%s %s passes every customer-copy guard (<=33 words)',
    (_id, _label, text) => {
      expect(wordCount(text)).toBeLessThanOrEqual(MAX_LINE_WORDS);
      expect(validateCustomerCopy(text)).toBe(true);
      expect(findBannedCustomerCopy(text)).toEqual([]);
      for (const rx of LAWN_EXTRA_DENY) expect(text).not.toMatch(rx);
    },
  );

  it('no customer line names a product from the catalog map', () => {
    const names = PRODUCT_CLASS_ENTRIES.map(([n]) => n.toLowerCase());
    for (const row of ALL_ROWS) {
      for (const [, text] of rowStrings(row)) {
        const lower = text.toLowerCase();
        names.forEach((n) => expect(lower).not.toContain(n));
      }
    }
  });

  it('catalog-sourced windows quote a recovery_note that still exists in the species catalog', () => {
    const dir = path.join(__dirname, '../data/species-catalog-v1/entries');
    const catalogText = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const row of ALL_ROWS) {
      const hasCatalogWindow = [row.windows?.first, row.windows?.full].some((w) => w?.source === 'catalog');
      if (!hasCatalogWindow) continue;
      expect(row.catalogQuote).toBeTruthy();
      expect(catalogText).toContain(JSON.stringify(row.catalogQuote).slice(1, -1));
    }
  });

  it('transient rows are the iron and potassium rows, and only those', () => {
    const transient = Object.values(PRODUCT_ROWS).filter((r) => r.transient).map((r) => r.id).sort();
    expect(transient).toEqual(['iron_micros', 'potassium_feed']);
  });
});

describe('product name map', () => {
  it('product keys are unique after normalization', () => {
    const keys = PRODUCT_CLASS_ENTRIES.map(([name]) => config.normalizeProductName(name));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every mapped family has a row (curative and preventive for fungicide and insecticide)', () => {
    const rowFamilies = new Set(Object.values(PRODUCT_ROWS).map((r) => r.family));
    for (const entry of PRODUCT_CLASS.values()) {
      if (entry) expect(rowFamilies.has(entry.family)).toBe(true);
    }
    for (const family of [FAMILY.FUNGICIDE, FAMILY.INSECTICIDE]) {
      const modes = Object.values(PRODUCT_ROWS).filter((r) => r.family === family).map((r) => r.mode).sort();
      expect(modes).toEqual(['curative', 'preventive']);
    }
  });

  // The keys are the catalog's own names: each must appear as an exact quoted
  // literal in the migrations that seed or rename catalog rows. A typo here
  // would silently drop a product's line (the engine fails closed).
  it('every key matches a product name written by a catalog seed or backfill migration', () => {
    const dir = path.join(__dirname, '../models/migrations');
    const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
    // The report product wording table lists the longer display spelling of a
    // few catalog names (documented there as an alias of the catalog row).
    sources.push(path.join(__dirname, '../config/report-product-copy.js'));
    const literals = new Set();
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(["'`])((?:(?!\1)[^\n]){3,200})\1/g)) {
        literals.add(m[2].replace(/\\(["'`])/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase());
      }
    }
    const missing = PRODUCT_CLASS_ENTRIES
      .map(([name]) => name)
      .filter((name) => !literals.has(config.normalizeProductName(name)));
    expect(missing).toEqual([]);
  });

  it('"Talstar P" (the office name for Talak) maps exactly like Atticus Talak', () => {
    expect(classifyLawnProductStatus('Talstar P')).toBe('mapped');
    expect(classifyLawnProductStatus('  talstar   p ')).toBe('mapped');
    const base = { serviceDate: '2026-10-01', applications: [] };
    const talstar = buildLawnExpectations({ ...base, applications: [{ name: 'Talstar P', targets: ['Southern chinch bugs'] }] }, PREVIEW);
    const talak = buildLawnExpectations({ ...base, applications: [{ name: 'Atticus Talak', targets: ['Southern chinch bugs'] }] }, PREVIEW);
    expect(talstar.rows.map((r) => r.id)).toEqual(talak.rows.map((r) => r.id));
    expect(talstar.rows.map((r) => r.id)).toEqual(['insecticide_curative']);
  });

  it('every lawn product in use in the last 90 days is mapped or an explicit null', () => {
    // Fixture: the audit's in-use list (2026-09-29), exact catalog names.
    const inUse = [
      'LESCO K-Flow 0-0-25',
      'LESCO Chelated AM + Micros',
      'Atticus Talak',
      'Talstar P',
      'Artavia 2 SC',
      'Celsius WG',
      'SedgeHammer Plus',
      'Arena 50 WDG',
      'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer',
      'LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide',
      'LESCO T-Storm 2G Fungicide',
      'LESCO Green Flo Phyte Plus 0-0-26 + Micros Liquid Fertilizer',
      'LESCO Green Flo 6-0-0 10% Ca',
      'LESCO Chelated Iron Plus',
    ];
    for (const name of inUse) {
      expect(['mapped', 'explicit_null']).toContain(classifyLawnProductStatus(name));
    }
  });

  it('matches case-insensitively on the whole name, never a prefix or substring', () => {
    expect(classifyLawnProduct({ name: '  celsius   wg ' })).toMatchObject({ family: FAMILY.BROADLEAF });
    expect(classifyLawnProductStatus('Celsius')).toBe('unmapped');
    expect(classifyLawnProductStatus('Celsius WG 10 lb bag')).toBe('unmapped');
    expect(classifyLawnProductStatus('')).toBe('unmapped');
    expect(classifyLawnProductStatus('Primo Maxx')).toBe('explicit_null');
  });
});

describe('buildLawnExpectations', () => {
  const base = { visitDate: '2026-10-01', nextVisitDate: '2026-11-05' };

  it('ships dark: every row is withheld unless the caller asks for a preview', () => {
    const out = buildLawnExpectations({ ...base, applications: [{ name: 'Celsius WG' }] });
    expect(out.rows).toEqual([]);
    expect(out.lines).toEqual([]);
    expect(out.primaryRowId).toBeNull();
    expect(out.withheld).toEqual([{ rowId: 'herbicide_broadleaf', reason: 'not_approved' }]);
  });

  it('an approved row is surfaced without the preview flag', () => {
    const approved = { ...PRODUCT_ROWS.herbicide_broadleaf, approved: true };
    const original = PRODUCT_ROWS.herbicide_broadleaf;
    PRODUCT_ROWS.herbicide_broadleaf = approved;
    try {
      const out = buildLawnExpectations({ ...base, applications: [{ name: 'Celsius WG' }] });
      expect(out.primaryRowId).toBe('herbicide_broadleaf');
      expect(out.lines.length).toBeGreaterThan(0);
    } finally {
      PRODUCT_ROWS.herbicide_broadleaf = original;
    }
  });

  it('unmapped product names get NO line and an explicit null gets none either', () => {
    const out = buildLawnExpectations({
      ...base,
      applications: [{ name: 'Mystery Product 9000' }, { name: 'Primo Maxx' }, { name: '' }],
    }, PREVIEW);
    expect(out.rows).toEqual([]);
    expect(out.lines).toEqual([]);
    expect(out.unmapped).toEqual(['Mystery Product 9000']);
  });

  it('a mapped product beside an unmapped one still gets its own line only', () => {
    const out = buildLawnExpectations({
      ...base,
      applications: [{ name: 'Celsius WG' }, { name: 'Mystery Product 9000' }],
    }, PREVIEW);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_broadleaf']);
  });

  it('two products in one family give one row', () => {
    const out = buildLawnExpectations({
      ...base,
      applications: [{ name: 'Celsius WG' }, { name: 'SpeedZone Southern' }],
    }, PREVIEW);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_broadleaf']);
  });

  it('every emitted line is within the cap and clean, for every mapped product and every gap', () => {
    const names = PRODUCT_CLASS_ENTRIES.filter(([, family]) => family).map(([name]) => name);
    for (const name of names) {
      for (const gap of [null, 0, 2, 5, 10, 14, 21, 28, 42, 70, 120]) {
        for (const targets of [[], ['large patch'], ['Southern chinch bugs']]) {
          const out = buildLawnExpectations({
            visitDate: '2026-10-01',
            nextVisitGapDays: gap == null ? undefined : gap,
            applications: [{ name, targets }],
            issues: ['dry_spot', 'thin_shade', 'mowed_short', 'chinch', 'large_patch'],
            celsiusYtdCount: 3,
          }, PREVIEW);
          for (const row of out.rows) expect(row.droppedLines).toEqual([]);
          for (const line of out.lines) {
            expect(wordCount(line)).toBeLessThanOrEqual(MAX_LINE_WORDS);
            expect(findBannedCustomerCopy(line)).toEqual([]);
            for (const rx of LAWN_EXTRA_DENY) expect(line).not.toMatch(rx);
          }
        }
      }
    }
  });

  describe('Celsius cap swap', () => {
    const second = PRODUCT_ROWS.herbicide_broadleaf.secondApp;
    const run = (count) => buildLawnExpectations({
      ...base, applications: [{ name: 'Celsius WG' }], celsiusYtdCount: count,
    }, PREVIEW).rows[0];

    it('keeps the second-application line under the cap', () => {
      const row = run(CELSIUS_YTD_CAP - 1);
      expect(row.secondApp).toEqual({ possible: true, capped: false });
      expect(row.lines).toContain(second.line);
      expect(row.lines).not.toContain(second.cappedLine);
    });

    it('swaps to the different-product line at the cap and above it', () => {
      for (const count of [CELSIUS_YTD_CAP, CELSIUS_YTD_CAP + 1]) {
        const row = run(count);
        expect(row.secondApp).toEqual({ possible: true, capped: true });
        expect(row.lines).toContain(second.cappedLine);
        expect(row.lines).not.toContain(second.line);
      }
    });

    it('treats an unknown count as under the cap, and the cap constant is 3', () => {
      expect(CELSIUS_YTD_CAP).toBe(3);
      expect(run(null).secondApp.capped).toBe(false);
      expect(run(undefined).secondApp.capped).toBe(false);
    });

    it('only the broadleaf row carries a second-application line', () => {
      const withSecond = ALL_ROWS.filter((r) => r.secondApp).map((r) => r.id);
      expect(withSecond).toEqual(['herbicide_broadleaf']);
    });
  });

  describe('byNextVisit matrix', () => {
    const state = (rowId, gap) => nextVisitState(
      PRODUCT_ROWS[rowId] || Object.values(ISSUE_ROWS).find((r) => r.id === rowId),
      gap,
    );

    it('broadleaf walks too_early, partial, visible, complete across the gap', () => {
      const matrix = [[0, 'too_early'], [2, 'too_early'], [3, 'partial'], [13, 'partial'],
        [14, 'visible'], [20, 'visible'], [21, 'complete'], [42, 'complete']];
      for (const [gap, expected] of matrix) expect(state('herbicide_broadleaf', gap)).toBe(expected);
    });

    it('sedge, granular nitrogen and curative fungicide follow their own windows', () => {
      expect(state('herbicide_sedge', 6)).toBe('too_early');
      expect(state('herbicide_sedge', 7)).toBe('partial');
      expect(state('herbicide_sedge', 21)).toBe('visible');
      expect(state('herbicide_sedge', 28)).toBe('complete');
      expect(state('granular_fertilizer', 6)).toBe('too_early');
      expect(state('granular_fertilizer', 14)).toBe('visible');
      expect(state('granular_fertilizer', 21)).toBe('complete');
      expect(state('fungicide_curative', 2)).toBe('too_early');
      expect(state('fungicide_curative', 10)).toBe('partial');
      expect(state('fungicide_curative', 14)).toBe('visible');
      expect(state('fungicide_curative', 28)).toBe('complete');
    });

    it('a qualitative full window never reaches visible or complete', () => {
      expect(state('insecticide_curative', 2)).toBe('too_early');
      expect(state('insecticide_curative', 3)).toBe('partial');
      expect(state('insecticide_curative', 120)).toBe('partial');
    });

    it('rows judged by absence report absence at every gap', () => {
      for (const id of ['pre_emergent', 'potassium_feed', 'fungicide_preventive', 'insecticide_preventive']) {
        for (const gap of [0, 7, 42, 200]) expect(state(id, gap)).toBe('absence');
      }
    });

    it('iron has no full window: too_early before the first window, visible after', () => {
      expect(state('iron_micros', 2)).toBe('too_early');
      expect(state('iron_micros', 3)).toBe('visible');
      expect(state('iron_micros', 42)).toBe('visible');
    });

    it('the engine returns the line for the actual gap and picks it from the actual dates', () => {
      const lineFor = (nextVisitDate) => buildLawnExpectations({
        visitDate: '2026-10-01', nextVisitDate, applications: [{ name: 'Celsius WG' }],
      }, PREVIEW).byNextVisit[0];
      const early = lineFor('2026-10-03');
      const mid = lineFor('2026-10-08');
      const late = lineFor('2026-11-05');
      expect(early).toMatchObject({ rowId: 'herbicide_broadleaf', state: 'too_early' });
      expect(mid.state).toBe('partial');
      expect(late.state).toBe('complete');
      expect(new Set([early.line, mid.line, late.line]).size).toBe(3);
    });

    it('every row resolves a line for every reachable state (no gap leaves a hole)', () => {
      for (const row of ALL_ROWS) {
        for (const gap of [0, 1, 3, 7, 10, 14, 21, 28, 42, 90]) {
          const out = buildLawnExpectations({
            visitDate: '2026-12-01',
            nextVisitGapDays: gap,
            applications: row.family
              ? [{ name: REPRESENTATIVE[row.family], targets: row.mode === 'curative' ? [TARGET[row.family]] : [] }]
              : [],
            issues: row.issueKey ? [row.issueKey] : [],
          }, PREVIEW);
          const emitted = out.rows.find((r) => r.id === row.id);
          if (emitted) expect(emitted.byNextVisit).not.toBeNull();
        }
      }
    });

    it('no next visit date means no byNextVisit line, but the rest still reads', () => {
      const out = buildLawnExpectations({ visitDate: '2026-10-01', applications: [{ name: 'Celsius WG' }] }, PREVIEW);
      expect(out.gapDays).toBeNull();
      expect(out.byNextVisit).toEqual([]);
      expect(out.rows[0].lines.length).toBeGreaterThan(0);
    });

    describe('dates resolve to the Eastern calendar day', () => {
      it('a Date at 9 PM EDT on Oct 31 is October 31, not November 1 (UTC)', () => {
        const visit = new Date('2026-10-31T21:00:00-04:00'); // 2026-11-01T01:00:00Z
        expect(visitGapDays({ visitDate: visit, nextVisitDate: '2026-11-14' })).toBe(14);
      });

      it('the visit month is the ET month the other way too: Feb 28 9 PM EST is February (dip kept)', () => {
        const out = buildLawnExpectations({ visitDate: new Date('2027-02-28T21:00:00-05:00'), issues: ['seasonal_dip'] }, PREVIEW); // Mar 1 UTC
        expect(out.rows.map((r) => r.id)).toEqual(['issue_seasonal_dip']);
      });

      it('the visit month is the ET month: Oct 31 9 PM EDT is October (seasonal dip withheld)', () => {
        const out = buildLawnExpectations({ visitDate: new Date('2026-10-31T21:00:00-04:00'), issues: ['seasonal_dip'] }, PREVIEW);
        expect(out.rows).toEqual([]);
        expect(out.withheld).toEqual([{ rowId: 'issue_seasonal_dip', reason: 'out_of_season' }]);
      });

      it('timestamp strings with an offset resolve the same way as Dates', () => {
        expect(visitGapDays({ visitDate: '2026-10-31T21:00:00-04:00', nextVisitDate: '2026-11-14T08:00:00-05:00' })).toBe(14);
        expect(visitGapDays({ visitDate: '2026-11-01T01:00:00Z', nextVisitDate: '2026-11-14' })).toBe(14);
      });

      it('a naive timestamp string reads as ET wall-clock, not server-local UTC', () => {
        expect(visitGapDays({ visitDate: '2026-10-31T21:00', nextVisitDate: '2026-11-01' })).toBe(1);
      });

      it('date-only strings are read literally', () => {
        expect(visitGapDays({ visitDate: '2026-10-31', nextVisitDate: '2026-11-01' })).toBe(1);
        expect(visitGapDays({ visitDate: '2026-10-31', nextVisitDate: '2026-10-31' })).toBe(0);
      });

      it('gaps across the fall-back DST night (Nov 1, 2026) stay whole calendar days', () => {
        expect(visitGapDays({ visitDate: '2026-10-31', nextVisitDate: '2026-11-02' })).toBe(2);
        expect(visitGapDays({
          visitDate: new Date('2026-11-01T00:30:00-04:00'), // before the 2 AM fall-back
          nextVisitDate: new Date('2026-11-02T00:30:00-05:00'), // after it
        })).toBe(1);
      });

      it('gaps across the spring-forward night (Mar 8, 2026) stay whole calendar days', () => {
        expect(visitGapDays({
          visitDate: new Date('2026-03-07T23:30:00-05:00'),
          nextVisitDate: new Date('2026-03-08T23:30:00-04:00'),
        })).toBe(1);
        expect(visitGapDays({ visitDate: '2026-03-07', nextVisitDate: '2026-03-09' })).toBe(2);
      });

      it('gap math across midnight ET: 11:30 PM and 12:30 AM ET are one day apart', () => {
        expect(visitGapDays({
          visitDate: new Date('2026-10-14T23:30:00-04:00'), // 03:30Z on the 15th
          nextVisitDate: new Date('2026-10-15T00:30:00-04:00'), // 04:30Z on the 15th
        })).toBe(1);
        // Same ET day, but a UTC date change in between: zero days.
        expect(visitGapDays({
          visitDate: new Date('2026-10-14T18:00:00-04:00'), // 22:00Z on the 14th
          nextVisitDate: new Date('2026-10-14T23:30:00-04:00'), // 03:30Z on the 15th
        })).toBe(0);
      });

      it('an invalid date is null, not a crash', () => {
        expect(visitGapDays({ visitDate: 'garbage', nextVisitDate: '2026-11-01' })).toBeNull();
        expect(visitGapDays({ visitDate: new Date('nope'), nextVisitDate: '2026-11-01' })).toBeNull();
      });
    });

    it('visitGapDays reads dates, gap overrides, and rejects a next visit in the past', () => {
      expect(visitGapDays({ visitDate: '2026-10-01', nextVisitDate: '2026-11-05' })).toBe(35);
      expect(visitGapDays({ nextVisitGapDays: 12 })).toBe(12);
      expect(visitGapDays({ visitDate: '2026-10-10', nextVisitDate: '2026-10-01' })).toBeNull();
      expect(visitGapDays({})).toBeNull();
    });
  });

  describe('transient rows and "behind"', () => {
    const rowFor = (name, extra = {}) => buildLawnExpectations(
      { ...base, applications: [{ name, ...extra }] },
      PREVIEW,
    ).rows[0];

    it('iron and potassium rows are never behind-eligible, whatever the score does', () => {
      for (const name of ['LESCO Chelated Iron Plus', 'LESCO K-Flow 0-0-25']) {
        const row = rowFor(name);
        expect(row.transient).toBe(true);
        expect(row.behindEligible).toBe(false);
        for (const daysSinceApplication of [0, 3, 10, 35, 90, 400]) {
          for (const scoreDelta of [-30, -8, -3, 0, 8, 25]) {
            expect(judgeProgress(row, { daysSinceApplication, scoreDelta })).not.toBe('behind');
          }
        }
      }
    });

    it('a faded iron lift 35 days later reads as holding steady, not behind', () => {
      const row = rowFor('LESCO Chelated Iron Plus');
      expect(judgeProgress(row, { daysSinceApplication: 35, scoreDelta: -6 })).toBe('holding_steady');
      expect(judgeProgress(row, { daysSinceApplication: 35, scoreDelta: -12 })).toBe('holding_steady');
    });

    it('rows judged by absence and site limits are never behind either', () => {
      const issues = buildLawnExpectations({ visitDate: '2026-12-01', issues: ['thin_shade'] }, PREVIEW).rows;
      const shade = issues.find((r) => r.id === 'issue_thin_shade');
      expect(judgeProgress(shade, { daysSinceApplication: 200, scoreDelta: -20 })).toBe('holding_steady');
      const preEm = rowFor('Prodiamine 65 WDG');
      expect(judgeProgress(preEm, { daysSinceApplication: 200, scoreDelta: -20 })).toBe('holding_steady');
    });

    it('a normal row can still be behind, and too_early never is', () => {
      const row = rowFor('Celsius WG');
      expect(row.behindEligible).toBe(true);
      expect(judgeProgress(row, { daysSinceApplication: 2, scoreDelta: -20 })).toBe('too_early');
      expect(judgeProgress(row, { daysSinceApplication: 30, scoreDelta: -9 })).toBe('behind');
      expect(judgeProgress(row, { daysSinceApplication: 30, scoreDelta: 0 })).toBe('behind');
      expect(judgeProgress(row, { daysSinceApplication: 10, scoreDelta: 9 })).toBe('ahead');
      expect(judgeProgress(row, { daysSinceApplication: 25, scoreDelta: 9 })).toBe('on_track');
      expect(judgeProgress(row, { daysSinceApplication: 10, scoreDelta: 1 })).toBe('in_window');
      expect(judgeProgress(row, { daysSinceApplication: 10, scoreDelta: null })).toBe('unclear');
    });
  });

  describe('progress is judged against the window of the metric it measures', () => {
    const rowsWithWindows = ALL_ROWS.filter((r) => Object.keys(r.metricWindows || {}).length);
    const cases = rowsWithWindows.flatMap((row) => Object.entries(row.metricWindows)
      .map(([metric, win]) => [row.id, metric, row, win]));

    it('covers the rows that can be judged (config-derived, not a hand list)', () => {
      expect(rowsWithWindows.map((r) => r.id).sort()).toEqual([
        'herbicide_broadleaf', 'herbicide_sedge', 'granular_fertilizer', 'fungicide_curative',
        'insecticide_curative', 'issue_dry_spot', 'issue_chinch', 'issue_large_patch', 'issue_mowed_short',
      ].sort());
    });

    it.each(cases)('%s / %s window is well formed and sourced', (_id, _metric, _row, win) => {
      expect(['gain', 'hold']).toContain(win.mode);
      expect(['proposed', 'catalog']).toContain(win.source);
      if (win.source === 'catalog') expect(win.catalogRef).toBeTruthy();
      expect(Number.isFinite(win.closeDays)).toBe(true);
      expect(win.closeDays).toBeGreaterThanOrEqual(win.startDays);
      if (win.mode === 'gain') expect(win.fullMinDays).toBeGreaterThanOrEqual(win.startDays);
    });

    it.each(cases)('%s / %s: no behind verdict fires before that metric window closes', (_id, metric, row, win) => {
      for (let d = 0; d <= win.closeDays; d += 1) {
        for (const scoreDelta of [-60, -30, -8, -7, 0, 7, 8, 30]) {
          expect(judgeProgress(row, { metric, daysSinceApplication: d, scoreDelta })).not.toBe('behind');
        }
      }
    });

    it.each(cases)('%s / %s: behind can fire once the window has closed', (_id, metric, row, win) => {
      expect(judgeProgress(row, { metric, daysSinceApplication: win.closeDays + 1, scoreDelta: -30 })).toBe('behind');
      // A gain-mode metric is also behind with no gain; a hold-mode metric that stopped falling is on track.
      const flat = judgeProgress(row, { metric, daysSinceApplication: win.closeDays + 1, scoreDelta: 0 });
      expect(flat).toBe(win.mode === 'gain' ? 'behind' : 'on_track');
    });

    it('a metric a row has no window for is never judged, on any day', () => {
      const broadleaf = PRODUCT_ROWS.herbicide_broadleaf;
      for (const d of [0, 30, 400]) {
        expect(judgeProgress(broadleaf, { metric: 'turf_density', daysSinceApplication: d, scoreDelta: -40 })).toBe('holding_steady');
      }
    });

    it('the primary metric of every behind-capable row has a window of its own', () => {
      for (const row of ALL_ROWS) {
        const behindCapable = Object.values(row.metricWindows || {}).length > 0;
        if (behindCapable) expect(row.metricWindows[row.metric]).toBeTruthy();
      }
    });

    it('a density metric is never judged on a color-length window', () => {
      for (const row of ALL_ROWS) {
        const density = row.metricWindows?.turf_density;
        if (density) expect(density.closeDays).toBeGreaterThanOrEqual(60);
        const color = row.metricWindows?.color_health;
        if (color) expect(color.closeDays).toBeLessThanOrEqual(30);
      }
    });

    it('scalping regression: density is not behind at day 30 or 89, and is behind only after the 60 to 90 day window', () => {
      const scalped = ISSUE_ROWS.mowed_short;
      expect(scalped.metric).toBe('turf_density');
      for (const d of [14, 21, 30, 45, 60, 89, 90]) {
        expect(judgeProgress(scalped, { daysSinceApplication: d, scoreDelta: -20 })).not.toBe('behind');
        expect(judgeProgress(scalped, { daysSinceApplication: d, scoreDelta: 0 })).not.toBe('behind');
      }
      expect(judgeProgress(scalped, { daysSinceApplication: 91, scoreDelta: 0 })).toBe('behind');
      // Color keeps its own 2 to 3 week window on the same row.
      expect(judgeProgress(scalped, { metric: 'color_health', daysSinceApplication: 22, scoreDelta: 0 })).toBe('behind');
      expect(judgeProgress(scalped, { metric: 'color_health', daysSinceApplication: 20, scoreDelta: 0 })).toBe('in_window');
    });

    it('granular nitrogen: color closes at 21 days, density only at 90', () => {
      const n = PRODUCT_ROWS.granular_fertilizer;
      expect(judgeProgress(n, { metric: 'color_health', daysSinceApplication: 22, scoreDelta: 0 })).toBe('behind');
      expect(judgeProgress(n, { metric: 'turf_density', daysSinceApplication: 30, scoreDelta: 0 })).toBe('too_early');
      expect(judgeProgress(n, { metric: 'turf_density', daysSinceApplication: 75, scoreDelta: 0 })).toBe('in_window');
      expect(judgeProgress(n, { metric: 'turf_density', daysSinceApplication: 91, scoreDelta: 0 })).toBe('behind');
    });

    it('spread rows (fungicide, insecticide, chinch, large patch) judge a falling score, never regrowth or fill-in', () => {
      for (const row of [PRODUCT_ROWS.fungicide_curative, PRODUCT_ROWS.insecticide_curative, ISSUE_ROWS.chinch, ISSUE_ROWS.large_patch]) {
        expect(row.metricWindows.stress_damage.mode).toBe('hold');
        // 30 days later, flat: spread stopped, so not behind and not "no regrowth"
        expect(judgeProgress(row, { daysSinceApplication: 30, scoreDelta: 0 })).toBe('on_track');
        expect(judgeProgress(row, { daysSinceApplication: 30, scoreDelta: -12 })).toBe('behind');
        expect(judgeProgress(row, { daysSinceApplication: 5, scoreDelta: -12 })).toBe('in_window');
      }
    });

    it('dry spot color is judged on the catalog 2 to 3 week window', () => {
      const dry = ISSUE_ROWS.dry_spot;
      expect(judgeProgress(dry, { daysSinceApplication: 21, scoreDelta: 0 })).toBe('in_window');
      expect(judgeProgress(dry, { daysSinceApplication: 22, scoreDelta: 0 })).toBe('behind');
    });
  });

  describe('modes and issues', () => {
    it('a fungicide with no target is preventive; a tagged target or a named issue makes it curative', () => {
      const preventive = buildLawnExpectations({ ...base, applications: [{ name: 'Artavia 2 SC' }] }, PREVIEW);
      expect(preventive.rows.map((r) => r.id)).toEqual(['fungicide_preventive']);
      const tagged = buildLawnExpectations({ ...base, applications: [{ name: 'Artavia 2 SC', targets: ['Large patch'] }] }, PREVIEW);
      expect(tagged.rows.map((r) => r.id)).toEqual(['fungicide_curative']);
      const named = buildLawnExpectations({ ...base, applications: [{ name: 'Artavia 2 SC' }], issues: ['large_patch'] }, PREVIEW);
      expect(named.rows.map((r) => r.id)).toEqual(['fungicide_curative']);
    });

    it('an unrelated target tag does not make a fungicide curative', () => {
      const out = buildLawnExpectations({ ...base, applications: [{ name: 'Artavia 2 SC', targets: ['Broadleaf weeds'] }] }, PREVIEW);
      expect(out.rows.map((r) => r.id)).toEqual(['fungicide_preventive']);
    });

    it('a talak-class insecticide is curative only with a chinch target or issue; Acelepryn is always preventive', () => {
      const none = buildLawnExpectations({ ...base, applications: [{ name: 'Atticus Talak' }] }, PREVIEW);
      expect(none.rows.map((r) => r.id)).toEqual(['insecticide_preventive']);
      const curative = buildLawnExpectations({ ...base, applications: [{ name: 'Atticus Talak', targets: ['Southern chinch bugs'] }] }, PREVIEW);
      expect(curative.rows.map((r) => r.id)).toEqual(['insecticide_curative']);
      const acelepryn = buildLawnExpectations({
        ...base, applications: [{ name: 'Acelepryn Xtra', targets: ['Southern chinch bugs'] }], issues: ['chinch'],
      }, PREVIEW);
      expect(acelepryn.rows.map((r) => r.id)).toEqual(['insecticide_preventive', 'issue_chinch']);
    });

    it('does not say chinch or large patch twice when the curative product row already covers it', () => {
      const chinch = buildLawnExpectations({
        ...base, applications: [{ name: 'Arena 50 WDG' }], issues: ['chinch'],
      }, PREVIEW);
      expect(chinch.rows.map((r) => r.id)).toEqual(['insecticide_curative']);
      const patch = buildLawnExpectations({
        ...base, applications: [{ name: 'Torque SC' }], issues: ['large_patch'],
      }, PREVIEW);
      expect(patch.rows.map((r) => r.id)).toEqual(['fungicide_curative']);
    });

    it('a named large patch makes the longer catalog window win over the 2 to 4 week default', () => {
      const out = buildLawnExpectations({
        visitDate: '2026-10-01', nextVisitDate: '2026-10-22',
        applications: [{ name: 'Torque SC' }], issues: ['large_patch'],
      }, PREVIEW);
      const row = out.rows[0];
      expect(row.windowSources).toContain('catalog');
      expect(row.lines.join(' ')).toContain('weeks to months');
      expect(row.lines.join(' ')).not.toContain('2 to 4 weeks');
      expect(row.byNextVisit.state).toBe('partial');
    });

    describe('emit first, then dedupe', () => {
      const withApproval = (productApproved, issueApproved, fn) => {
        const originals = [PRODUCT_ROWS.fungicide_curative, ISSUE_ROWS.large_patch];
        PRODUCT_ROWS.fungicide_curative = { ...originals[0], approved: productApproved };
        ISSUE_ROWS.large_patch = { ...originals[1], approved: issueApproved };
        try {
          return fn();
        } finally {
          [PRODUCT_ROWS.fungicide_curative, ISSUE_ROWS.large_patch] = originals;
        }
      };
      const run = (opts) => buildLawnExpectations({
        ...base, applications: [{ name: 'Artavia 2 SC' }], issues: ['large_patch'],
      }, opts);

      it.each([
        // productApproved, issueApproved, includeUnapproved -> emitted ids
        [true, true, false, ['fungicide_curative']],
        [true, false, false, ['fungicide_curative']],
        [false, true, false, ['issue_large_patch']],
        [false, false, false, []],
        [true, true, true, ['fungicide_curative']],
        [true, false, true, ['fungicide_curative']],
        [false, true, true, ['fungicide_curative']],
        [false, false, true, ['fungicide_curative']],
      ])('product approved=%s issue approved=%s preview=%s emits %j', (product, issue, preview, expected) => {
        const out = withApproval(product, issue, () => run({ includeUnapproved: preview }));
        expect(out.rows.map((r) => r.id)).toEqual(expected);
      });

      it('an approved issue row is never silenced by an unapproved product row, for chinch either', () => {
        const original = [PRODUCT_ROWS.insecticide_curative, ISSUE_ROWS.chinch];
        PRODUCT_ROWS.insecticide_curative = { ...original[0], approved: false };
        ISSUE_ROWS.chinch = { ...original[1], approved: true };
        try {
          const out = buildLawnExpectations({ ...base, applications: [{ name: 'Arena 50 WDG' }], issues: ['chinch'] });
          expect(out.rows.map((r) => r.id)).toEqual(['issue_chinch']);
          expect(out.withheld).toEqual([{ rowId: 'insecticide_curative', reason: 'not_approved' }]);
        } finally {
          [PRODUCT_ROWS.insecticide_curative, ISSUE_ROWS.chinch] = original;
        }
      });
    });

    describe('treatment target vocabulary', () => {
      it('every lawn vocabulary tag is classified, and nothing else is', () => {
        expect(Object.keys(config.TARGET_CLASS_BY_NAME).sort()).toEqual([...LAWN_TARGET_SUGGESTIONS].sort());
      });

      const FAMILY_PRODUCT = { [FAMILY.FUNGICIDE]: 'Artavia 2 SC', [FAMILY.INSECTICIDE]: 'Arena 50 WDG' };
      const curativeTags = LAWN_TARGET_SUGGESTIONS
        .map((name) => [name, config.TARGET_CLASS_BY_NAME[name]])
        .filter(([, cls]) => cls);

      it('every lawn insect and disease tag is recognized (config-derived, includes fire ants, fairy ring, pythium)', () => {
        const names = curativeTags.map(([name]) => name);
        expect(names).toEqual(expect.arrayContaining(['Fire ants', 'Fairy ring', 'Pythium root rot', 'Southern chinch bugs', 'Large patch']));
      });

      it.each(curativeTags)('%s on its matching product family makes the row curative', (name, cls) => {
        const out = buildLawnExpectations({ ...base, applications: [{ name: FAMILY_PRODUCT[cls.family], targets: [name] }] }, PREVIEW);
        expect(out.rows.map((r) => r.mode)).toEqual(['curative']);
        expect(out.rows[0].lines.length).toBeGreaterThan(0);
      });

      it.each(curativeTags)('%s on a product of the OTHER family does not make a curative row', (name, cls) => {
        const other = cls.family === FAMILY.FUNGICIDE ? 'Arena 50 WDG' : 'Artavia 2 SC';
        const out = buildLawnExpectations({ ...base, applications: [{ name: other, targets: [name] }] }, PREVIEW);
        expect(out.rows.map((r) => r.mode)).toEqual(['preventive']);
      });

      it('weed and nematode tags never make a fungicide or insecticide curative', () => {
        const noFamily = LAWN_TARGET_SUGGESTIONS.filter((name) => !config.TARGET_CLASS_BY_NAME[name]);
        expect(noFamily).toEqual(expect.arrayContaining(['Crabgrass', 'Nematodes', 'Broadleaf weeds']));
        for (const name of noFamily) {
          for (const product of Object.values(FAMILY_PRODUCT)) {
            const out = buildLawnExpectations({ ...base, applications: [{ name: product, targets: [name] }] }, PREVIEW);
            expect(out.rows.map((r) => r.mode)).toEqual(['preventive']);
          }
        }
      });

      it('tags match the vocabulary case-insensitively, never a substring or a free-text guess', () => {
        const run = (tag) => buildLawnExpectations({ ...base, applications: [{ name: 'Artavia 2 SC', targets: [tag] }] }, PREVIEW).rows[0].mode;
        expect(run('FAIRY RING')).toBe('curative');
        expect(run('a patch of something')).toBe('preventive');
        expect(run('fungus')).toBe('preventive');
      });
    });

    describe('one recognized-cause set for overrides', () => {
      const run = (extra) => buildLawnExpectations({
        visitDate: '2026-10-01', nextVisitDate: '2026-10-22', applications: [{ name: 'Torque SC', ...extra.app }], issues: extra.issues,
      }, PREVIEW);

      it('a tagged Large patch and issues:[large_patch] give identical output', () => {
        const tagged = run({ app: { targets: ['Large patch'] } });
        const named = run({ issues: ['large_patch'] });
        const both = run({ app: { targets: ['Large patch'] }, issues: ['large_patch'] });
        expect(tagged).toEqual(named);
        expect(both).toEqual(named);
        expect(tagged.rows[0].lines.join(' ')).toContain('weeks to months');
        expect(tagged.rows[0].lines.join(' ')).not.toContain('2 to 4 weeks');
      });

      it('a tagged Southern chinch bugs and issues:[chinch] give identical output', () => {
        const input = (extra) => ({
          ...base, applications: [{ name: 'Arena 50 WDG', ...extra.app }], issues: extra.issues,
        });
        const tagged = buildLawnExpectations(input({ app: { targets: ['Southern chinch bugs'] } }), PREVIEW);
        const named = buildLawnExpectations(input({ issues: ['chinch'] }), PREVIEW);
        expect(tagged).toEqual(named);
      });

      it('a tag with no named cause (fairy ring) keeps the default window', () => {
        const out = run({ app: { targets: ['Fairy ring'] } });
        expect(out.rows[0].lines.join(' ')).toContain('2 to 4 weeks');
      });
    });

    it('weeds seen with no herbicide today says treatment is planned; any herbicide row silences it', () => {
      const alone = buildLawnExpectations({ ...base, issues: ['weeds_untreated'] }, PREVIEW);
      expect(alone.rows.map((r) => r.id)).toEqual(['issue_weeds_untreated']);
      const treated = buildLawnExpectations({
        ...base, applications: [{ name: 'Dismiss' }], issues: ['weeds_untreated'],
      }, PREVIEW);
      expect(treated.rows.map((r) => r.id)).toEqual(['herbicide_sedge']);
      const fertOnly = buildLawnExpectations({
        ...base, applications: [{ name: 'LESCO 24-0-11' }], issues: ['weeds_untreated'],
      }, PREVIEW);
      expect(fertOnly.rows.map((r) => r.id)).toContain('issue_weeds_untreated');
    });

    it('a seasonal dip appears only Nov to Feb and never for a new or worsening problem', () => {
      const dip = (visitDate, issue = 'seasonal_dip') => buildLawnExpectations({ visitDate, issues: [issue] }, PREVIEW);
      expect(dip('2026-12-10').rows.map((r) => r.id)).toEqual(['issue_seasonal_dip']);
      expect(dip('2027-02-10').rows).toHaveLength(1);
      const summer = dip('2026-07-10');
      expect(summer.rows).toEqual([]);
      expect(summer.withheld).toEqual([{ rowId: 'issue_seasonal_dip', reason: 'out_of_season' }]);
      const worsening = dip('2026-12-10', { key: 'seasonal_dip', worsening: true });
      expect(worsening.rows).toEqual([]);
      expect(worsening.withheld[0].reason).toBe('new_or_worsening');
      expect(dip('2026-12-10', { key: 'seasonal_dip', isNew: true }).rows).toEqual([]);
    });

    it('an unknown issue key adds nothing', () => {
      expect(buildLawnExpectations({ ...base, issues: ['not_a_real_issue'] }, PREVIEW).rows).toEqual([]);
    });
  });

  describe('independence', () => {
    it('never depends on a plan tier, lawn program or county', () => {
      const plain = buildLawnExpectations({ ...base, applications: [{ name: 'Celsius WG' }, { name: 'LESCO 24-0-11' }] }, PREVIEW);
      const tiered = buildLawnExpectations({
        ...base,
        tier: 'premium',
        waveguardTier: 'bronze',
        program: '12x',
        county: 'Manatee',
        applications: [{ name: 'Celsius WG', tier: 'enhanced' }, { name: 'LESCO 24-0-11', county: 'Sarasota' }],
      }, PREVIEW);
      expect(tiered).toEqual(plain);
    });

    it('ships dark: no runtime file other than its own tests, the audit script, the dark progress engine and the dark v6 copy writer reads the engine or config', () => {
      const root = path.join(__dirname, '..');
      const hits = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === 'tests') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.js') && /lawn-expectations['"]/.test(fs.readFileSync(full, 'utf8'))) {
            hits.push(path.relative(root, full));
          }
        }
      };
      walk(root);
      expect(hits.sort()).toEqual([
        'scripts/audit-lawn-expectation-products.js',
        // P14: the v6 copy writer (GATE_LAWN_REPORT_COPY_V6, dark) offers APPROVED rows' keyed sentences for selection.
        'services/service-report/lawn-copy-v6.js',
        'services/service-report/lawn-expectations.js',
        // P13: reuses judgeProgress / row resolution; itself read only by report-data (server-internal) and its replay script.
        'services/service-report/lawn-progress.js',
      ]);
    });
  });
});

describe('timestamp strings at exactly UTC midnight', () => {
  const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');
  test("'2026-11-01T00:00:00Z' is October 31 ET: 14-day gap to Nov 14 and no seasonal dip", () => {
    const out = buildLawnExpectations({ applications: [], issues: ['seasonal_dip'], visitDate: '2026-11-01T00:00:00Z', nextVisitDate: '2026-11-14' }, { includeUnapproved: true });
    expect(out.gapDays).toBe(14);
    expect(out.rows.map((r) => r.id)).not.toContain('issue_seasonal_dip');
  });
  test('control: a November 2 visit does get the seasonal dip row', () => {
    const out = buildLawnExpectations({ applications: [], issues: ['seasonal_dip'], visitDate: '2026-11-02', nextVisitDate: '2026-11-14' }, { includeUnapproved: true });
    expect(out.rows.map((r) => r.id)).toContain('issue_seasonal_dip');
  });
});

describe('issue normalization (terminal review)', () => {
  const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');
  const dipIds = (issues) => buildLawnExpectations({ applications: [], issues, visitDate: '2026-12-02', nextVisitDate: '2026-12-30' }, { includeUnapproved: true }).rows.map((r) => r.id);
  test('a worsening flag on any duplicate withholds the seasonal dip, in either order', () => {
    expect(dipIds([{ key: 'seasonal_dip', worsening: true }, 'seasonal_dip'])).not.toContain('issue_seasonal_dip');
    expect(dipIds(['seasonal_dip', { key: 'seasonal_dip', worsening: true }])).not.toContain('issue_seasonal_dip');
    expect(dipIds(['seasonal_dip'])).toContain('issue_seasonal_dip');
  });
  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('inherited key %s is ignored, not thrown on', (key) => {
    expect(() => buildLawnExpectations({ applications: [], issues: [key, 'seasonal_dip'], visitDate: '2026-12-02', nextVisitDate: '2026-12-30' }, { includeUnapproved: true })).not.toThrow();
    expect(() => buildLawnExpectations({ applications: [], issues: [key] })).not.toThrow();
  });
});

describe('iron by-next-visit wording holds for short and long gaps (terminal review)', () => {
  const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');
  test.each([5, 21])('a %i-day gap never claims color is unchanged', (gap) => {
    const out = buildLawnExpectations({ applications: [{ name: 'LESCO Chelated Iron Plus' }], issues: [], visitDate: '2026-06-02', nextVisitGapDays: gap }, { includeUnapproved: true });
    const lines = out.byNextVisit.map((b) => b.line).join(' ');
    expect(lines).not.toMatch(/about like today/i);
  });
});

describe('keyed sentences (what the P14 writer selects by id)', () => {
  it('every emitted row exposes its printable lines as keyed sentences, in reading order, with unique keys', () => {
    const out = buildLawnExpectations({
      applications: [{ name: 'Celsius WG' }, { name: 'LESCO Chelated Iron Plus' }],
      visitDate: '2026-09-30',
      nextVisitGapDays: 28,
      celsiusYtdCount: 1,
    }, PREVIEW);
    expect(out.rows.length).toBeGreaterThan(1);
    for (const row of out.rows) {
      expect(row.sentences.map((s) => s.text)).toEqual(row.lines);
      const keys = row.sentences.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys[0]).toBe('visibleChange');
    }
  });

  it('keys name the sentence, so a swapped second-application line keeps its key', () => {
    const second = (count) => buildLawnExpectations({ applications: [{ name: 'Celsius WG' }], nextVisitGapDays: 28, celsiusYtdCount: count }, PREVIEW)
      .rows[0].sentences.find((s) => s.key === 'secondApp');
    expect(second(1).text).toMatch(/second application/);
    expect(second(3).text).toMatch(/different weed-control product/);
  });
});
