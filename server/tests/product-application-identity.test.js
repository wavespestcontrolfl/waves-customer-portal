'use strict';

const { isProductApplicationRow, isSprayApplicationMethod } = require('../services/service-report/service-line-configs');

// Server mirror of client/src/lib/product-application.js isProductApplication:
// the payload's applicationMade verdict must agree with what the web report
// and PDF count as an applied product.
describe('isProductApplicationRow', () => {
  test('ordinary applied pest baits, gels and trunk injections are applications without a dry-down', () => {
    for (const app of [
      { method: 'bait_placement', product: { name: 'Advion Ant Bait Gel', product_type: 'insecticide', epa_reg: '100-1498' } },
      { method: 'trunk_injection', product: { name: 'Arborjet Imidacloprid', category: 'Insecticide', epa_reg: '74578-1' } },
      { method: 'granular', product: { name: 'LESCO 24-0-11', product_type: 'fertilizer', epa_reg: 'N/A' } },
    ]) {
      expect(isProductApplicationRow(app)).toBe(true);
    }
    expect(isSprayApplicationMethod('bait_placement')).toBe(false);
    expect(isSprayApplicationMethod('trunk_injection')).toBe(false);
  });

  test('termite and rodent monitoring devices and baits are never applications', () => {
    for (const app of [
      { method: 'bait_placement', product: { name: 'Recruit HD Termite Bait', epa_reg: '62719-608' } },
      { method: 'station_check', product: { name: 'Trelona ATBS Station', product_type: 'termiticide' } },
      { method: 'bait_placement', product: { name: 'Contrac Blox Rodenticide Bait', epa_reg: '12455-79' } },
      { method: 'perimeter_spray', product: { name: 'Rodent monitor block' } },
    ]) {
      expect(isProductApplicationRow(app)).toBe(false);
    }
  });

  test('a station check only counts with pesticide identity that is not a bait', () => {
    expect(isProductApplicationRow({ method: 'station_check', product: { name: 'Termidor Foam', epa_reg: '7969-364' } })).toBe(true);
    expect(isProductApplicationRow({ method: 'station_check', product: { name: 'In2Care Mosquito Station', product_type: 'insecticide' } })).toBe(true);
    expect(isProductApplicationRow({ method: 'station_check', product: { name: 'Advion Ant Bait Gel', epa_reg: '100-1498' } })).toBe(false);
    expect(isProductApplicationRow({ method: 'station_check', product: { name: 'Sticky trap', epa_reg: 'N/A' } })).toBe(false);
    expect(isProductApplicationRow(null)).toBe(false);
  });
});
