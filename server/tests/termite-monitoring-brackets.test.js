/**
 * Station-check brackets + per-system spacing (owner 2026-07-28).
 *
 * The flat Basic($35)/Premier($65) tiers are retired: the quarterly station
 * check prices by STATION COUNT in 5-station brackets ($19 base ≤10, +$5 per
 * further 5), and each system installs at its label spacing — Trelona 15 ft
 * (the annual system's selling point), Advance 10 ft. Anchor: a ~23-station
 * home lands $34/mo gross — the market ~$29/mo a WaveGuard Gold member sees.
 * Menu is Trelona-only; Advance stays priceable so old estimates replay
 * unchanged in structure.
 */
const {
  priceTermiteBait,
  termiteMonitoringMonthlyForStations,
} = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { TERMITE } = require('../services/pricing-engine/constants');

const PROFILE = { homeSqFt: 2000, stories: 1, lotSqFt: 8000 };
const input = (options = {}) => translateV2CallToV1Input(PROFILE, ['TERMITE_BAIT'], options);
const baitOf = (est) => est.lineItems.find((l) => l.service === 'termite_bait');

describe('bracket formula', () => {
  test('the owner table, exactly', () => {
    expect(termiteMonitoringMonthlyForStations(5)).toBe(19);
    expect(termiteMonitoringMonthlyForStations(8)).toBe(19);   // min-station floor
    expect(termiteMonitoringMonthlyForStations(10)).toBe(19);
    expect(termiteMonitoringMonthlyForStations(11)).toBe(24);
    expect(termiteMonitoringMonthlyForStations(15)).toBe(24);
    expect(termiteMonitoringMonthlyForStations(16)).toBe(29);
    expect(termiteMonitoringMonthlyForStations(20)).toBe(29);
    expect(termiteMonitoringMonthlyForStations(23)).toBe(34);  // the Stan anchor
    expect(termiteMonitoringMonthlyForStations(25)).toBe(34);
    expect(termiteMonitoringMonthlyForStations(30)).toBe(39);
    expect(termiteMonitoringMonthlyForStations(35)).toBe(44);
  });

  test('after WaveGuard Gold (15%) the anchor bracket lands the market ~$29/mo', () => {
    expect(Math.round(termiteMonitoringMonthlyForStations(23) * 0.85 * 100) / 100).toBe(28.9);
  });
});

describe('per-system spacing', () => {
  test('Trelona installs at 15 ft, Advance at 10 — each priced off its own count', () => {
    const tre = baitOf(generateEstimate(input({ termiteBaitSystem: 'trelona' })));
    const adv = baitOf(generateEstimate(input({ termiteBaitSystem: 'advance' })));
    expect(tre.perimeter).toBe(adv.perimeter);
    expect(tre.stations).toBe(Math.max(TERMITE.minStations, Math.ceil(tre.perimeter / 15)));
    expect(adv.stations).toBe(Math.max(TERMITE.minStations, Math.ceil(adv.perimeter / 10)));
    // The 2000 sqft reference home: 15 vs 23 stations, $610 vs $639 install,
    // $24/mo vs $34/mo — wider spacing is what makes Trelona-only sellable.
    expect(tre.stations).toBe(15);
    expect(adv.stations).toBe(23);
    expect(tre.installation.price).toBe(610);
    expect(adv.installation.price).toBe(639);
    expect(tre.monthly).toBe(24);
    expect(adv.monthly).toBe(34);
    expect(tre.perApp).toBe(72);
    expect(adv.perApp).toBe(102);
  });

  test('an absent system defaults to Trelona (menu is Trelona-only); explicit legacy values replay as sent', () => {
    const def = baitOf(generateEstimate(input({})));
    expect(def.selectedSystem).toBe('trelona');
    expect(baitOf(generateEstimate(input({ termiteBaitSystem: 'advance' }))).selectedSystem).toBe('advance');
    // Sentricon aliases still resolve to the 10-ft Advance class.
    expect(baitOf(generateEstimate(input({ termiteBaitSystem: 'sentricon' }))).selectedSystem).toBe('advance');
  });

  test('the retired monitoring tier input no longer changes price', () => {
    const basic = baitOf(generateEstimate(input({ termiteMonitoringTier: 'basic' })));
    const premier = baitOf(generateEstimate(input({ termiteMonitoringTier: 'premier' })));
    expect(premier.monthly).toBe(basic.monthly);
    expect(premier.perApp).toBe(basic.perApp);
  });
});

describe('priceTermiteBait direct', () => {
  test('bracket rides the actual station count, not the perimeter', () => {
    // Manual perimeter override: 320 LF at Trelona 15-ft → 22 stations →
    // 21-25 bracket $34/mo.
    const priced = priceTermiteBait({}, { system: 'trelona', perimeterLF: 320 });
    expect(priced.stations).toBe(22);
    expect(priced.monthly).toBe(34);
  });
});
