/**
 * anchoredAnnualTotal — recomputed annual_total must anchor to the engine's
 * true annual (result.totals.year2), not round-trip through the rounded
 * monthly. Regression: quarterly $392/yr displays as $32.67/mo; a no-op
 * preference toggle or tier flip recomputed annual as 32.67 * 12 = 392.04
 * and clobbered the quoted $392 (prod rows b7d916a3 / 87401b86).
 */
const { anchoredAnnualTotal } = require('../routes/estimate-public');

const quarterlyBlob = (over = {}) => ({
  result: {
    totals: { year2: 392, year2mo: 32.67, ...over.totals },
    recurring: { monthlyTotal: 32.67, grandTotal: 32.67, ...over.recurring },
  },
});

describe('anchoredAnnualTotal', () => {
  test('no-op recompute returns the quoted engine annual exactly', () => {
    expect(anchoredAnnualTotal(quarterlyBlob(), 32.67)).toBe(392);
  });

  test('monthly delta shifts the anchor by its true annualized amount', () => {
    // Gold 15% off 392/yr: monthly 32.67 -> 27.77 (round2 of 27.7695);
    // anchored = 392 - 4.90 * 12 = 333.20 (matches 392 * 0.85 exactly),
    // where blind round(27.77 * 12) would give 333.24.
    expect(anchoredAnnualTotal(quarterlyBlob(), 27.77)).toBe(333.2);
  });

  test('pref discount larger than the plan floors at 0', () => {
    expect(anchoredAnnualTotal(quarterlyBlob(), 0)).toBe(0);
  });

  test('zero monthly clamps to 0 even when the anchor residue is positive', () => {
    // year2=100 with year2mo=8.33: residue 100 - 8.33*12 = +0.04 — a comped
    // plan must never persist a positive annual from the rounding residue.
    const blob = { result: { totals: { year2: 100, year2mo: 8.33 } } };
    expect(anchoredAnnualTotal(blob, 0)).toBe(0);
  });

  test('falls back to 12x monthly when the blob has no engine totals', () => {
    expect(anchoredAnnualTotal({}, 32.67)).toBe(392.04);
    expect(anchoredAnnualTotal(null, 32.67)).toBe(392.04);
    expect(anchoredAnnualTotal({ result: { totals: {} } }, 32.67)).toBe(392.04);
  });

  test('falls back when year2 does not correspond to the engine monthly', () => {
    // e.g. a blob whose year2 absorbed one-time work — the anchor is not a
    // recurring annual, so 12x monthly is the safer derivation.
    const blob = quarterlyBlob({ totals: { year2: 491, year2mo: 32.67 } });
    expect(anchoredAnnualTotal(blob, 32.67)).toBe(392.04);
  });

  test('reads root-level totals when the blob has no result wrapper', () => {
    const blob = { totals: { year2: 392, year2mo: 32.67 }, recurring: { monthlyTotal: 32.67 } };
    expect(anchoredAnnualTotal(blob, 32.67)).toBe(392);
  });

  test('engine monthly falls back to recurring totals when year2mo is absent', () => {
    const blob = { result: { totals: { year2: 392 }, recurring: { monthlyTotal: 32.67 } } };
    expect(anchoredAnnualTotal(blob, 32.67)).toBe(392);
  });

  test('grandTotal beats component monthlyTotal when year2mo is absent (v1-mapped supplements)', () => {
    // v1-mapped blobs: grandTotal is the full monthly counterpart to year2;
    // monthlyTotal excludes supplements (rodent bait / palm injection). Using
    // the partial 32.67 would trip the correspondence guard vs year2=692 and
    // forfeit the anchor — grandTotal keeps it.
    const blob = {
      result: {
        totals: { year2: 692 },
        recurring: { monthlyTotal: 32.67, grandTotal: 57.67, rodentBaitMo: 25 },
      },
    };
    expect(anchoredAnnualTotal(blob, 57.67)).toBe(692);
  });
});
