// Month -> suggested T&S products, resolved against synthetic catalog rows.
const {
  PROTOCOL_PRODUCTS, NON_PRODUCT_LINE, primaryLines, visitMonthET, resolveMonthProducts,
} = require('../services/tree-shrub-month-products');
const protocols = require('../config/protocols.json');

const row = (id, name, extra = {}) => ({ id, name, active: true, ...extra });

// Names as the prod catalog carries them (verified read-only 2026-10-01).
const CATALOG = [
  row('snapshot', 'Snapshot 2.5TG'),
  // Palm SKUs as #5089's migration seeds them (owner 2026-10-01 palm program).
  row('palm', 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)'),
  row('palm16', 'LESCO 0-0-16 Palm & Tropical Ornamental Fertilizer (#510513)'),
  // The lawn winterizer shares the 0-0-16 analysis and must never stand in.
  row('winterizer', 'LESCO 0-0-16 Winterizer'),
  row('orn', 'LESCO 13-0-13 60% PolyPlus Landscape'),
  row('tritek', 'TriTek Spray Oil Emulsion (OMRI)'),
  row('iron', 'LESCO Chelated Iron Plus'),
  row('kontos', 'Kontos Insecticide/Miticide'),
  row('mainspring', 'Mainspring GNL Insecticide'),
  row('distance', 'Distance IGR'),
  row('kphite', 'KPHITE 7LP Systemic Fungicide'),
  row('copper', 'Southern Ag Copper Fungicide 27.15%'),
  row('cytogro', 'Cytogro Liquid Biostimulant'),
  // No TriStar catalog row exists yet; one here proves it is a secondary line, never suggested.
  row('tristar', 'TriStar 8.5 SL Insecticide'),
  row('espoma', 'Espoma Organic Soil Acidifier'),
  row('sequestar', 'Sequestar 6% Fe EDDHA Soluble Micronutrient'),
  row('nr-1gal', 'Arborjet NUTRIROOT 1 gal'),
  row('nr-1qt', 'Arborjet NUTRIROOT 1 qt'),
  row('nr-25gal', 'Arborjet NUTRIROOT 2.5 gal'),
];

const ids = (date, rows = CATALOG) => resolveMonthProducts(date, rows).map((entry) => entry.productId);

describe('resolveMonthProducts', () => {
  test('every month matches the protocol primary list; the ambiguous NutriRoot entry is skipped', () => {
    // Every month card names Snapshot and a palm feed (program date rules,
    // owner 2026-10-05): Oct-May the 8-0-12 palm SKU, Jun-Sep the 0-0-16 one.
    // The due gates (60-day/quarter Snapshot, 3-month palm) decide what shows.
    // 13-0-13 is a primary line, only when due, on the Feb-May and Oct-Dec cards (label read 2026-10-22: two feedings a year;
    // the due rule picks the visit, so every cadence gets a spring and a fall feeding).
    expect(ids('2026-01-15')).toEqual(['snapshot', 'palm']);
    // TriTek is a secondary (live find) line in every month now (owner
    // 2026-10-09), so it is never a suggestion. NutriRoot is ambiguous in
    // this catalog; Mn Combo and the Sequestar/KPHITE lines are not primary.
    expect(ids('2026-02-10')).toEqual(['snapshot', 'palm', 'orn']);
    expect(ids('2026-03-10')).toEqual(['snapshot', 'palm', 'orn', 'mainspring', 'distance']);
    expect(ids('2026-04-10')).toEqual(['snapshot', 'palm', 'orn']);
    expect(ids('2026-05-10')).toEqual(['snapshot', 'mainspring', 'palm', 'orn']);
    // The summer palm feeding is the 0-0-16 palm SKU, never the lawn winterizer.
    expect(ids('2026-06-10')).toEqual(['snapshot', 'palm16']);
    expect(ids('2026-07-10')).toEqual(['snapshot', 'palm16']);
    expect(ids('2026-08-10')).toEqual(['snapshot', 'palm16', 'mainspring', 'distance', 'cytogro']);
    // Talus and Headway are gone from the program; TriStar is secondary only.
    expect(ids('2026-09-10')).toEqual(['snapshot', 'palm16', 'distance']);
    expect(ids('2026-10-01')).toEqual(['snapshot', 'palm', 'orn']);
    expect(ids('2026-11-10')).toEqual(['snapshot', 'palm', 'orn', 'espoma']);
    expect(ids('2026-12-10')).toEqual(['snapshot', 'palm', 'orn', 'cytogro']);
  });

  test('a visit in a month that used to have no palm line now yields the palm feed (signup-date visits)', () => {
    // February, March, June, August, September and November had no palm line before.
    expect(ids('2026-02-10')).toContain('palm');
    expect(ids('2026-02-10')).not.toContain('palm16');
    expect(ids('2026-08-10')).toContain('palm16');
    expect(ids('2026-08-10')).not.toContain('palm');
    expect(ids('2026-02-10')).toContain('snapshot');
    expect(ids('2026-08-10')).toContain('snapshot');
  });

  test('every month card carries both lines and a 6x flag; quarterly 4x is retired', () => {
    for (const visit of protocols.tree_shrub.visits) {
      const lines = primaryLines(visit);
      const summer = ['Jun', 'Jul', 'Aug', 'Sep'].includes(visit.month);
      expect(lines.some((l) => /^Snapshot 2\.5TG:.*only when due \(60\+ days since the last, one per quarter\)/.test(l))).toBe(true);
      expect(lines.some((l) => (summer ? /^LESCO 0-0-16 #510513 palm fertilizer/ : /^LESCO 8-0-12 #511542 palm fertilizer/).test(l)
        && /only when the last palm feed was 3 or more months ago/.test(l))).toBe(true);
      // Never the opposite-season palm SKU (8-0-12 carries N: June 1-Sept 30 blackout).
      expect(lines.some((l) => (summer ? /8-0-12/ : /0-0-16/).test(l))).toBe(false);
      expect(visit.tier_6x).toBe(true);
      expect(visit.tier_4x).toBe(false);
      // 6 and 9 visits a year are the sold tiers; the protocol calendar badges read these.
      expect(visit.tier_9x).toBe(true);
    }
  });

  test('Talus, Headway and the Apr rescue line are gone; TriStar is a conditional secondary line only', () => {
    const text = JSON.stringify(protocols.tree_shrub.visits);
    expect(text).not.toMatch(/talus|headway|talstar|sevin/i);
    for (const visit of protocols.tree_shrub.visits) {
      expect(primaryLines(visit).join('\n')).not.toMatch(/tristar/i);
    }
    // The nine cards that carry TriStar (ruling a, owner 2026-10-09); May, Nov and Dec never did.
    const withTriStar = protocols.tree_shrub.visits.filter((v) => /^TriStar/m.test(v.secondary)).map((v) => v.month);
    expect(withTriStar).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    for (const visit of protocols.tree_shrub.visits.filter((v) => withTriStar.includes(v.month))) {
      expect(visit.secondary).toMatch(/^TriStar 8\.5 SL \(acetamiprid\): whitefly, mealybug, aphid or soft scale \(wax, cottony cushion\), live finds only; foliar only; not for armored scale \(use Distance, oil or a Zylam drench\); label rate$/m);
    }
    expect(protocols.tree_shrub.notes.join('\n')).toMatch(/Visits start on the customer's signup date/);
  });

  test('TriStar is never offered for armored scale on any card, annual rotation or guide entry', () => {
    const program = protocols.tree_shrub;
    const guide = require('../config/tree-shrub-field-guide.json');
    const tristarLines = [
      ...program.visits.flatMap((v) => `${v.primary}\n${v.secondary}`.split('\n')),
      ...program.annual_rotation.insect_miticide,
      guide.products.tristar.targets,
      ...program.visits.flatMap((v) => v.fieldGuide.conditional.filter((c) => c.key === 'tristar').map((c) => c.where)),
    ].filter((line) => /tristar/i.test(line) || /live finds/i.test(line));
    expect(tristarLines.length).toBeGreaterThan(10);
    for (const line of tristarLines) {
      if (/armored scale/i.test(line)) expect(line).toMatch(/\bnot for armored scale\b/i);
    }
    expect(program.annual_rotation.insect_miticide.join('\n')).toMatch(/TriStar[^\n]*counts toward the annual 4A log[^\n]*not for armored scale/);
  });

  test('no month card offers TriTek or Mn Combo as a primary line, so neither is ever suggested (owner 2026-10-09)', () => {
    const months = ['01-15', '02-10', '03-10', '04-10', '05-10', '06-10', '07-10', '08-10', '09-10', '10-01', '11-10', '12-10'];
    const withMn = [...CATALOG, row('mn', 'Mn Combo')];
    for (const visit of protocols.tree_shrub.visits) {
      expect(primaryLines(visit).join('\n')).not.toMatch(/tritek|mn combo|fe\/mn micros|kphite|copper|azatin/i);
    }
    for (const m of months) {
      expect(ids(`2026-${m}`, withMn)).not.toContain('tritek');
      expect(ids(`2026-${m}`, withMn)).not.toContain('mn');
    }
    // Where the oil stays: one conditional secondary line per card, with the safety conditions.
    for (const month of ['Jan', 'Feb', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Nov']) {
      const oil = protocols.tree_shrub.visits.find((v) => v.month === month).secondary.split('\n').filter((l) => /^TriTek/.test(l));
      expect(oil).toHaveLength(1);
      expect(oil[0]).toMatch(/under 90°F; not on drought-stressed plants/);
    }
    // Every card's oil line carries all the limits: the job card shows this raw
    // text when GATE_TREE_SHRUB_FIELD_GUIDE is off (Codex r2 #6185).
    for (const month of ['Jan', 'Feb', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Nov']) {
      const oil = protocols.tree_shrub.visits.find((v) => v.month === month).secondary.split('\n').find((l) => /^TriTek/.test(l));
      expect(oil).toMatch(/on live scale crawlers, nymphs or mites only; under 90°F; not on drought-stressed plants; not within 7 days of a forecast cold snap/);
    }
    for (const month of ['Jun', 'Jul', 'Aug', 'Sep']) {
      expect(protocols.tree_shrub.visits.find((v) => v.month === month).secondary).toMatch(/TriTek spray oil 1\.0% only, before 9 AM,/);
    }
  });

  test('the phosphite line is Reliant, off the base program; copper and the routine fungicide line too; Azatin O is gone (owner 2026-10-09)', () => {
    const program = protocols.tree_shrub;
    for (const month of ['Mar', 'Jun', 'Oct']) {
      const visit = program.visits.find((v) => v.month === month);
      expect(visit.primary).not.toMatch(/kphite|reliant/i);
      const reliant = visit.secondary.split('\n').find((l) => /^Reliant Systemic Fungicide \(phosphite\) only on beds with root-rot history or replacement plantings; foliar spray 2–4 tsp\/gal, repeat at 14–21 days;/.test(l));
      expect(reliant).toBeDefined();
      for (const limit of [
        'not on dormant, heat-stressed or drought-stressed plants', 'not when rain is forecast within 24 hours',
        'keep people and pets out until the spray dries', 'no tank mix with copper', 'no soil drench on the program; FRAC P07',
      ]) expect(reliant).toContain(limit);
    }
    expect(JSON.stringify(program)).not.toMatch(/kphite/i);
    expect(JSON.stringify(program)).not.toMatch(/azatin|azamax/i);
    expect(JSON.stringify(program.visits)).not.toMatch(/Labeled ornamental fungicide|Copper: exact container label/);
    expect(program.annual_rotation.fungicide_disease.join('\n')).toMatch(/Copper only for a diagnosed labeled bacterial or leaf disease, after the exact container label is verified; not a routine program line/);
    expect(program.annual_rotation.fungicide_disease.join('\n')).toMatch(/7 to 28 day intervals; the 40 to 60 day visit cannot protect foliage\. No routine fungicide on the base program\./);
  });

  test('each entry carries the application method', () => {
    const october = Object.fromEntries(resolveMonthProducts('2026-10-01', CATALOG).map((e) => [e.productId, e.method]));
    expect(october).toEqual({ snapshot: 'granular_broadcast', palm: 'granular_broadcast', orn: 'granular_broadcast' });
    const november = Object.fromEntries(resolveMonthProducts('2026-11-10', CATALOG).map((e) => [e.productId, e.method]));
    expect(november.espoma).toBe('granular_broadcast');
  });

  test('a line whose method is unverified is never suggested, even with an exact catalog row', () => {
    expect(NON_PRODUCT_LINE.test('KPHITE 7LP: verify container label and method; foliar and soil rates differ; FRAC P07')).toBe(true);
    expect(NON_PRODUCT_LINE.test('Sequestar EDDHA: exact container label needed; no verified dose or injector recipe')).toBe(true);
    // An exact label still needed / a held dose is withheld too (Codex r3 #5089).
    expect(NON_PRODUCT_LINE.test('13-0-13 ornamental fertilizer: exact bag label needed; hold dose')).toBe(true);
    // The real 13-0-13 lines carry the label dose, so they are not held.
    const bed = protocols.tree_shrub.visits.find((v) => v.month === 'Apr').primary.split('\n').find((l) => /^13-0-13/.test(l));
    expect(NON_PRODUCT_LINE.test(bed)).toBe(false);
    expect(NON_PRODUCT_LINE.test('Snapshot 2.5TG Q4: 2.3–4.6 lb/1,000 sq ft beds; select the labeled weed rate; water in ($17.16)')).toBe(false);
  });

  test('NutriRoot resolves when the catalog carries exactly one active row', () => {
    const single = CATALOG.filter((r) => !r.id.startsWith('nr-')).concat(row('nr', 'Arborjet NUTRIROOT'));
    expect(resolveMonthProducts('2026-02-10', single)).toContainEqual({ productId: 'nr', method: 'soil_drench' });
  });

  test('zero matches: the entry is skipped, never substituted', () => {
    expect(ids('2026-07-10', CATALOG.filter((r) => r.id !== 'snapshot'))).toEqual(['palm16']);
    // A broad lookalike must not stand in for the missing exact row.
    expect(ids('2026-07-10', [row('x', 'Snapshot Lawn Pre-Emergent 2.5 TG blend')])).toEqual([]);
  });

  test('multiple active matches: skipped, not first-wins', () => {
    const dup = [...CATALOG, row('snapshot-2', 'Snapshot 2.5TG')];
    expect(ids('2026-07-10', dup)).toEqual(['palm16']);
  });

  test('inactive rows do not count: an inactive near-duplicate neither matches nor makes the entry ambiguous', () => {
    const withInactiveDup = [...CATALOG, row('distance-old', 'Distance IGR', { active: false })];
    expect(ids('2026-03-10', withInactiveDup)).toEqual(['snapshot', 'palm', 'orn', 'mainspring', 'distance']);
    expect(ids('2026-07-10', CATALOG.map((r) => (r.id === 'snapshot' ? { ...r, active: false } : r)))).toEqual(['palm16']);
  });

  test('a lawn 0-0-16 winterizer alone never fills the palm feeding', () => {
    expect(ids('2026-07-10', [row('winterizer', 'LESCO 0-0-16 Winterizer')])).toEqual([]);
  });

  test('Iron Plus is never suggested in any month (owner 2026-10-01: 12-0-0 N, dropped from T&S)', () => {
    const months = ['01-15', '02-10', '03-10', '04-10', '05-10', '06-10', '07-10', '08-10', '09-10', '10-01', '11-10', '12-10'];
    const withIron = [...CATALOG, row('iron', 'LESCO Chelated Iron Plus')];
    for (const m of months) expect(ids(`2026-${m}`, withIron)).not.toContain('iron');
  });

  test('names match case-insensitively and anchored at the start', () => {
    expect(ids('2026-07-10', [row('s', 'snapshot 2.5tg')])).toEqual(['s']);
    expect(ids('2026-07-10', [row('s', 'Old Snapshot 2.5TG')])).toEqual([]);
  });

  test('no catalog rows or a bad date resolves nothing', () => {
    expect(resolveMonthProducts('2026-07-10', [])).toEqual([]);
    expect(resolveMonthProducts('2026-07-10', null)).toEqual([]);
    expect(resolveMonthProducts(null, CATALOG)).toEqual([]);
  });

  test('suggestions follow the canonical protocol: an edited primary line changes them', () => {
    const edited = { tree_shrub: { visits: [{ month: 'Jan', primary: 'Kontos: 1.7-3.4 fl oz/100 gal\nScout palms', secondary: 'Snapshot 2.5TG if needed' }] } };
    // Secondary ("if needed") lines are never suggestions.
    expect(resolveMonthProducts('2027-01-12', CATALOG, edited).map((e) => e.productId)).toEqual(['kontos']);
  });

  test('a non-product line naming a product (the December report) suggests nothing', () => {
    const report = { tree_shrub: { visits: [{ month: 'Dec', primary: 'Annual health report with photos, IRAC/FRAC history, Snapshot history' }] } };
    expect(resolveMonthProducts('2026-12-10', CATALOG, report)).toEqual([]);
  });
});

describe('protocols.json tree_shrub drift guard', () => {
  test('there is a visit for every month', () => {
    expect(protocols.tree_shrub.visits.map((v) => v.month)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  test('every primary line names a product the sheet can place, or is a known non-product line', () => {
    const unplaced = [];
    for (const visit of protocols.tree_shrub.visits) {
      for (const line of primaryLines(visit)) {
        if (!NON_PRODUCT_LINE.test(line) && !PROTOCOL_PRODUCTS.some((p) => p.token.test(line))) unplaced.push(`${visit.month}: ${line}`);
      }
    }
    // A new product in a month's primary text needs a PROTOCOL_PRODUCTS entry
    // (token + exact catalog pattern) or it silently drops off the sheet.
    expect(unplaced).toEqual([]);
  });
});

describe('visitMonthET', () => {
  test('a calendar-day string and a DATE read back at UTC midnight give the same month', () => {
    expect(visitMonthET('2026-10-01')).toBe(10);
    expect(visitMonthET(new Date('2026-10-01T00:00:00.000Z'))).toBe(10);
    expect(visitMonthET('2026-09-30')).toBe(9);
    expect(visitMonthET(new Date('2026-09-30T00:00:00.000Z'))).toBe(9);
  });

  test('a real instant is read on the ET calendar, not UTC', () => {
    // 02:00Z on Oct 1 is 10 PM Sep 30 in New York.
    expect(visitMonthET(new Date('2026-10-01T02:00:00.000Z'))).toBe(9);
    // 05:00Z on Oct 1 is 1 AM Oct 1 in New York.
    expect(visitMonthET(new Date('2026-10-01T05:00:00.000Z'))).toBe(10);
    // Year end: 03:00Z Jan 1 is still Dec 31 in New York.
    expect(visitMonthET(new Date('2027-01-01T03:00:00.000Z'))).toBe(12);
  });

  test('a missing date has no month', () => {
    expect(visitMonthET(null)).toBeNull();
    expect(visitMonthET(undefined)).toBeNull();
  });
});

describe('13-0-13 and Sequestar card lines (labels read 2026-10-22, owner approved)', () => {
  const visits = protocols.tree_shrub.visits;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const lineOf = (visit, section, pattern) => String(visit[section] || '').split('\n').find((l) => pattern.test(l));

  const ORN_MONTHS = ['Feb', 'Mar', 'Apr', 'May', 'Oct', 'Nov', 'Dec'];
  test('13-0-13 is a primary line on the Feb-May and Oct-Dec cards, with the label dose and the county reason', () => {
    for (const visit of visits) {
      const line = lineOf(visit, 'primary', /^13-0-13/);
      if (!ORN_MONTHS.includes(visit.month)) { expect([visit.month, line]).toEqual([visit.month, undefined]); continue; }
      expect(line).toMatch(/beds 0\.75 lb per 100 sq ft \(a 1,200 sq ft bed is 9 lb\)/);
      expect(line).toMatch(/trees and large shrubs ½ lb per inch of trunk diameter spread under the drip line, never more than 0\.75 lb per 100 sq ft of the area under it/);
      // Below the bag's 1 to 1½ lb because 1 lb per 100 sq ft is over the 1 lb N per 1,000 sq ft county limit.
      expect(line).toMatch(/below the bag's 1 to 1½ lb per 100 sq ft because the Sarasota County fertilizer code caps nitrogen at 1 lb per 1,000 sq ft/);
      expect(line).toMatch(/only when due \(2 a year, spring and late fall, at least 5 months apart; none June 1 to Sept\. 30\)/);
      expect(line).not.toMatch(/label needed|hold dose/i);
    }
    // 7.5 lb per 1,000 sq ft x 13% = 0.975 lb N, under the cap; the bag's 1 lb per 100 sq ft x 13% = 1.3 lb N, over it.
    expect(7.5 * 0.13).toBeCloseTo(0.975, 3);
    expect(10 * 0.13).toBeGreaterThan(1);
    expect(protocols.tree_shrub.calibration.ornamental_fertilizer_rate).toMatch(/0\.75 lb per 100 sq ft \(7\.5 lb per 1,000 sq ft = 0\.98 lb N/);
  });

  test('the field guide row follows the card: 13-0-13 on the same months', () => {
    for (const visit of visits) {
      const row = visit.fieldGuide.routine.find((r) => r.key === 'f13013');
      expect([visit.month, Boolean(row)]).toEqual([visit.month, ORN_MONTHS.includes(visit.month)]);
    }
  });

  test('Sequestar is a symptom-only secondary line with the label dose, never a primary line', () => {
    expect(JSON.stringify(visits.map((v) => v.primary))).not.toMatch(/sequestar/i);
    for (const visit of visits) {
      const line = lineOf(visit, 'secondary', /^Sequestar/);
      const guided = visit.fieldGuide.conditional.some((r) => r.key === 'sequestar');
      expect([visit.month, Boolean(line), guided]).toEqual([visit.month, ['Jan', 'Feb', 'May', 'Nov', 'Dec'].includes(visit.month), Boolean(line)]);
      if (!line) continue;
      expect(line).toMatch(/^Sequestar 6% Fe EDDHA: only for iron chlorosis \(yellow new leaves with green veins;/);
      expect(line).toMatch(/2 oz per small shrub, up to 2 oz per inch of trunk diameter on large shrubs and trees, or up to 2 oz per 100 sq ft of bed/);
      expect(line).toMatch(/dissolve in water, pour at the root zone and water in; once a year per plant, in spring before new growth or when symptoms appear; never tank-mix with oil/);
    }
  });

  test('no program line still waits on a label, and the sheet suggests 13-0-13 but never Sequestar', () => {
    const text = JSON.stringify(protocols.tree_shrub);
    expect(text).not.toMatch(/exact (?:bag|container) label needed|hold dose|no verified dose|injector recipe/i);
    for (const month of ['Jan', 'Feb', 'May', 'Nov', 'Dec']) {
      const date = `2026-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-10`;
      expect(ids(date)).not.toContain('sequestar');
    }
    // January and the four blackout months carry no 13-0-13 line.
    for (const date of ['2026-01-10', '2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10']) expect(ids(date)).not.toContain('orn');
  });
});

