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

  test('a customer-selected tier the replay cannot derive fails the sheet closed (codex P2)', () => {
    // The replay derives bronze for a solo termite estimate — a matching
    // persisted tier renders; a select-tier COMMITTED higher tier the
    // replay can't reproduce suppresses the sheet rather than misprinting
    // discounted figures. Case-insensitive (row stores 'Bronze').
    expect(buildTermiteComparisonData(termiteInputs(), { selectedTier: 'Bronze' })).toBeTruthy();
    expect(buildTermiteComparisonData(termiteInputs(), { selectedTier: 'bronze' })).toBeTruthy();
    expect(buildTermiteComparisonData(termiteInputs(), { selectedTier: 'Gold' })).toBeNull();
    // No persisted tier (legacy rows) → no guard, sheet renders.
    expect(buildTermiteComparisonData(termiteInputs(), { selectedTier: null })).toBeTruthy();
  });

  test('a quote-time tier discount the live replay does not reproduce fails the sheet closed (codex P1)', () => {
    const { WAVEGUARD } = require('../services/pricing-engine/constants');
    const liveBronze = Number(WAVEGUARD.tiers.bronze.discount) || 0;
    // Snapshot matches live config → renders.
    expect(buildTermiteComparisonData(termiteInputs(), {
      selectedTier: 'Bronze',
      expectedTierDiscount: liveBronze,
    })).toBeTruthy();
    // Admin changed the tier discount after send: the estimate page keeps
    // the quoted rate, the replay prices at the new one → no sheet.
    expect(buildTermiteComparisonData(termiteInputs(), {
      selectedTier: 'Bronze',
      expectedTierDiscount: liveBronze + 0.05,
    })).toBeNull();
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
    expect(data.own.perApp).toBe(102);
    const expectedUplift = Math.round(install / 20);
    expect(data.rent).toMatchObject({
      installToday: 0,
      hardwareValue: install,
      basePerApp: 102,
      upliftPerApp: expectedUplift,
      perApp: 102 + expectedUplift,
      recoveryQuarters: 20,
    });
    expect(data.visitsPerYear).toBe(4);

    // First year: buying carries the install, renting carries the uplift.
    expect(data.own.firstYear).toBe(install + 102 * 4);
    expect(data.rent.firstYear).toBe((102 + expectedUplift) * 4);

    // Parity at five years (20 quarters) is the honest framing on the sheet —
    // exact up to the whole-dollar uplift rounding (at most half the horizon,
    // $10 on 20 quarters).
    expect(Math.abs(data.own.fiveYear - data.rent.fiveYear)).toBeLessThanOrEqual(10);
  });

  test('bond menu comes from the QUOTE-TIME snapshot param, never the replay', () => {
    // The stored snapshot (what PUT /:token/bond validates against) is the
    // only source — a config change after send must not let the sheet
    // advertise terms the linked estimate cannot select (codex P1).
    const storedSnapshot = [
      { key: '1yr', label: '1-Year', years: 1, quarterly: 61, perApp: 61 },
      { key: '10yr', label: '10-Year', years: 10, quarterly: 44 },
      { key: 'junk', label: '', years: 0, perApp: 0 },
    ];
    const data = buildTermiteComparisonData(termiteInputs(), { bondOptions: storedSnapshot });
    expect(data.bondOptions).toEqual([
      { key: '1yr', label: '1-Year', years: 1, perApp: 61 },
      { key: '10yr', label: '10-Year', years: 10, perApp: 44 }, // perApp ?? quarterly
    ]);

    // No snapshot on the estimate (older saves, bond gate dark at quote
    // time) → no bond section, regardless of live gates.
    const withoutSnapshot = buildTermiteComparisonData(termiteInputs());
    expect(withoutSnapshot).toBeTruthy();
    expect(withoutSnapshot.bondOptions).toEqual([]);
  });

  test('per-application figures use the FINAL discounted annual, not the gross rate', () => {
    const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
    // Bundle termite with pest so the WaveGuard percentage applies; the
    // sheet must show what the estimate actually charges (codex P1).
    const bundled = translateV2CallToV1Input(PROFILE, ['GENERAL_PEST', 'TERMITE_BAIT'], {
      termiteBaitSystem: 'advance',
    });
    const replayBait = generateEstimate(JSON.parse(JSON.stringify(bundled))).lineItems
      .find((li) => li.service === 'termite_bait');
    const expectedAnnual = Number(replayBait.manualFinalAnnual ?? replayBait.annualAfterDiscount ?? replayBait.annual);
    const expectedPerApp = Math.round((expectedAnnual / replayBait.visitsPerYear) * 100) / 100;
    expect(expectedAnnual).toBeGreaterThan(0);

    const data = buildTermiteComparisonData(bundled);
    expect(data).toBeTruthy();
    expect(data.own.perApp).toBe(expectedPerApp);
    // The rent column's base is the same discounted figure; the exempt
    // uplift stacks on top.
    expect(data.rent.perApp).toBe(Math.round((data.rent.basePerApp + data.rent.upliftPerApp) * 100) / 100);
  });
});

describe('replay must reproduce the stored quote', () => {
  test('the sold-ownership column is checked against the persisted rows and fails closed on drift (codex P1)', () => {
    const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const rentMapped = mapV1ToLegacyShape(generateEstimate(termiteInputs({ termiteOwnership: 'rent' })));
    const baitRow = rentMapped.recurring.services.find((s) => s.service === 'termite_bait');
    const rentalRow = rentMapped.recurring.services.find((s) => s.service === 'termite_station_rental');

    // Matching persisted rows (what the frozen bundle serves) → renders.
    expect(buildTermiteComparisonData(termiteInputs(), {
      persistedQuote: { ownership: 'rent', baitPerApp: baitRow.perTreatment, upliftPerApp: rentalRow.perTreatment },
    })).toBeTruthy();
    // A config change after send (stored uplift no longer reproducible) → no sheet.
    expect(buildTermiteComparisonData(termiteInputs(), {
      persistedQuote: { ownership: 'rent', baitPerApp: baitRow.perTreatment, upliftPerApp: rentalRow.perTreatment + 7 },
    })).toBeNull();
    // Own-mode: stored bait rate must match too.
    expect(buildTermiteComparisonData(termiteInputs(), {
      persistedQuote: { ownership: 'own', baitPerApp: 102 },
    })).toBeTruthy();
    expect(buildTermiteComparisonData(termiteInputs(), {
      persistedQuote: { ownership: 'own', baitPerApp: 99 },
    })).toBeNull();
    // Own-mode install price is on the sheet — a termite_install config
    // change after send fails closed too (codex P1 follow-up).
    const ownMapped = mapV1ToLegacyShape(generateEstimate(termiteInputs()));
    const installItem = ownMapped.oneTime.items.find((i) => i.service === 'termite_bait_installation');
    expect(buildTermiteComparisonData(termiteInputs(), {
      persistedQuote: { ownership: 'own', baitPerApp: 102, installPrice: installItem.price },
    })).toBeTruthy();
    expect(buildTermiteComparisonData(termiteInputs(), {
      persistedQuote: { ownership: 'own', baitPerApp: 102, installPrice: installItem.price - 40 },
    })).toBeNull();
  });

  test('the guard is GROSS-vs-GROSS so discounted bundles still render (codex P1 follow-up)', () => {
    const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const { persistedTermiteQuoteFromEstimateData } = require('../services/termite-warranty-comparison');
    // Bundled estimate: WaveGuard percent applies, mapped rows stay
    // pre-discount — the stored gross rate must match the replay's gross,
    // not reject every discounted comparison.
    const bundled = translateV2CallToV1Input(PROFILE, ['GENERAL_PEST', 'TERMITE_BAIT'], {
      termiteBaitSystem: 'advance',
      termiteOwnership: 'rent',
    });
    const mapped = mapV1ToLegacyShape(generateEstimate(JSON.parse(JSON.stringify(bundled))));
    const persisted = persistedTermiteQuoteFromEstimateData({ result: mapped });
    expect(persisted).toMatchObject({ ownership: 'rent' });
    expect(buildTermiteComparisonData(bundled, { persistedQuote: persisted })).toBeTruthy();
  });

  test('persisted quote reads the raw { engineInputs, engineResult } shape too (codex P2)', () => {
    const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
    const { persistedTermiteQuoteFromEstimateData } = require('../services/termite-warranty-comparison');
    const rentResult = generateEstimate(termiteInputs({ termiteOwnership: 'rent' }));
    const raw = persistedTermiteQuoteFromEstimateData({ engineInputs: termiteInputs(), engineResult: rentResult });
    const rawBait = rentResult.lineItems.find((li) => li.service === 'termite_bait');
    const rawRental = rentResult.lineItems.find((li) => li.service === 'termite_station_rental');
    expect(raw).toMatchObject({
      ownership: 'rent',
      baitPerApp: rawBait.perApp,
      upliftPerApp: rawRental.perApp,
    });
    // The raw-shape quote round-trips through the guard.
    expect(buildTermiteComparisonData(termiteInputs(), { persistedQuote: raw })).toBeTruthy();
    // No termite anywhere → null.
    expect(persistedTermiteQuoteFromEstimateData({ inputs: {} })).toBeNull();
  });
});

describe('crossover copy', () => {
  test('fractional horizons keep their precision and pluralization (codex P2)', () => {
    const { crossoverText } = require('../services/pdf/termite-comparison-pdf');
    expect(crossoverText(1)).toBe('the first quarter');
    expect(crossoverText(2)).toBe('the first 2 quarters');
    expect(crossoverText(4)).toBe('the first 1 year');
    expect(crossoverText(10)).toBe('the first 2.5 years');
    expect(crossoverText(20)).toBe('the first 5 years');
    expect(crossoverText(0)).toBe('the recovery period');
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
