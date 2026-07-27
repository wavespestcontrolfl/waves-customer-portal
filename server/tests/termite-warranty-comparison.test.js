/**
 * Termite options comparison sheet (buy vs rent + bond menu).
 *
 * The sheet is two deterministic engine replays of an estimate's saved
 * inputs with the bait ownership toggled, so these tests pin (1) the
 * fail-closed availability rules — gate off, no termite, rental dark, or an
 * unpriceable uplift all mean NO sheet, never a one-column comparison — and
 * (2) that the numbers on the sheet are exactly the engine's, including the
 * five-year parity the seeded 20-quarter horizon produces.
 */

const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const {
  termiteComparisonGateOn,
  buildTermiteComparisonData,
} = require('../services/termite-warranty-comparison');
const { renderTermiteComparisonPdf } = require('../services/pdf/termite-comparison-pdf');

const PROFILE = { homeSqFt: 2000, stories: 1, lotSqFt: 8000 };

function termiteInputs(options = {}) {
  return translateV2CallToV1Input(PROFILE, ['TERMITE_BAIT'], {
    termiteBaitSystem: 'advance',
    ...options,
  });
}

// The suite runs with every gate on; individual cases pin each dark default.
beforeEach(() => {
  process.env.GATE_TERMITE_COMPARISON_SHEET = 'true';
  process.env.GATE_TERMITE_STATION_RENTAL = 'true';
  process.env.GATE_TERMITE_BOND_OPTION = 'true';
});
afterAll(() => {
  delete process.env.GATE_TERMITE_COMPARISON_SHEET;
  delete process.env.GATE_TERMITE_STATION_RENTAL;
  delete process.env.GATE_TERMITE_BOND_OPTION;
});

describe('availability is fail-closed', () => {
  test('dark by default: sheet gate unset means no sheet', () => {
    delete process.env.GATE_TERMITE_COMPARISON_SHEET;
    expect(termiteComparisonGateOn()).toBe(false);
    expect(buildTermiteComparisonData(termiteInputs())).toBeNull();
  });

  test('no termite service on the estimate means no sheet', () => {
    expect(buildTermiteComparisonData(translateV2CallToV1Input(PROFILE, ['GENERAL_PEST'], {}))).toBeNull();
    expect(buildTermiteComparisonData(null)).toBeNull();
    expect(buildTermiteComparisonData({})).toBeNull();
  });

  test('rental gate dark means no sheet — both columns would price identically', () => {
    delete process.env.GATE_TERMITE_STATION_RENTAL;
    expect(buildTermiteComparisonData(termiteInputs())).toBeNull();
  });

  test('the saved inputs are never mutated by the replays', () => {
    const inputs = termiteInputs();
    const before = JSON.stringify(inputs);
    buildTermiteComparisonData(inputs);
    expect(JSON.stringify(inputs)).toBe(before);
  });
});

describe('the numbers are the engine’s', () => {
  test('own vs rent columns: $0 today, uplift on the quarterly, five-year parity at the seeded horizon', () => {
    const data = buildTermiteComparisonData(termiteInputs());
    expect(data).toBeTruthy();

    // Derive from the engine's own install price (bracket-priced per
    // footprint — this suite must not re-encode the bracket table). The
    // structural claims are what matter: $0 today, uplift =
    // round(install / seeded 20 quarters), rent per-app = monitoring + uplift.
    const install = data.own.installToday;
    expect(install).toBeGreaterThan(0);
    expect(data.own.perApp).toBe(105);
    const expectedUplift = Math.round(install / 20);
    expect(data.rent).toMatchObject({
      installToday: 0,
      hardwareValue: install,
      basePerApp: 105,
      upliftPerApp: expectedUplift,
      perApp: 105 + expectedUplift,
      recoveryQuarters: 20,
    });
    expect(data.visitsPerYear).toBe(4);

    // First year: buying carries the install, renting carries the uplift.
    expect(data.own.firstYear).toBe(install + 105 * 4);
    expect(data.rent.firstYear).toBe((105 + expectedUplift) * 4);

    // Parity at five years (20 quarters) is the honest framing on the sheet —
    // exact up to the whole-dollar uplift rounding (at most half the horizon,
    // $10 on 20 quarters).
    expect(Math.abs(data.own.fiveYear - data.rent.fiveYear)).toBeLessThanOrEqual(10);
  });

  test('bond menu rides the snapshot only when the bond gate emitted it', () => {
    const withBonds = buildTermiteComparisonData(termiteInputs());
    expect(withBonds.bondOptions.length).toBeGreaterThan(0);
    for (const opt of withBonds.bondOptions) {
      expect(opt.perApp).toBeGreaterThan(0);
      expect(opt.label).toBeTruthy();
    }
    // Longer terms lock lower per-application rates — the selling point the
    // sheet states must actually hold in the snapshot.
    const perApps = withBonds.bondOptions.map((o) => o.perApp);
    expect([...perApps].sort((a, b) => b - a)).toEqual(perApps);

    delete process.env.GATE_TERMITE_BOND_OPTION;
    const withoutBonds = buildTermiteComparisonData(termiteInputs());
    expect(withoutBonds).toBeTruthy();
    expect(withoutBonds.bondOptions).toEqual([]);
  });
});

describe('PDF renders', () => {
  test('a real buffer, with and without bond options', async () => {
    const data = buildTermiteComparisonData(termiteInputs());
    const pdf = await renderTermiteComparisonPdf({
      ...data,
      address: '123 Example Way, Bradenton, FL',
      estimateUrl: 'https://portal.wavespestcontrol.com/estimate/test-token',
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');

    const noBonds = await renderTermiteComparisonPdf({
      ...data,
      bondOptions: [],
      address: null,
      estimateUrl: null,
    });
    expect(noBonds.slice(0, 5).toString()).toBe('%PDF-');
  });
});
