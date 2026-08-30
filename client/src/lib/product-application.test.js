import { describe, it, expect } from 'vitest';
import { isProductApplication, epaReg } from './product-application';

const app = (name, method, extra = {}) => ({ method, product: { name, ...extra } });

describe('isProductApplication — one identity rule for the live report and the PDF', () => {
  it('termite / rodent devices are never applications, whatever the method', () => {
    expect(isProductApplication(app('Trelona ATBS Termite Bait Station', 'bait_placement'))).toBe(false);
    expect(isProductApplication(app('Protecta Rodent Bait Station', 'station_check'))).toBe(false);
    expect(isProductApplication(app('Termite monitor cartridge', 'perimeter_spray', { epa_reg: '499-555' }))).toBe(false);
  });

  it('a termite / rodent BAIT named without a device token is device work too (local codex P1 #3600 r36)', () => {
    expect(isProductApplication(app('Recruit HD Termite Bait', 'bait_placement', { epa_reg: '62719-608' }))).toBe(false);
    expect(isProductApplication(app('Contrac Blox', 'bait_placement', { product_type: 'rodenticide bait' }))).toBe(false);
    expect(isProductApplication(app('Rat bait block', 'bait_placement'))).toBe(false);
  });

  it('ordinary applied pest baits and real treatments still count', () => {
    expect(isProductApplication(app('Advion Ant Bait Gel', 'bait_placement', { epa_reg: '100-1498' }))).toBe(true);
    expect(isProductApplication(app('Termidor Foam', 'foam_treatment', { epa_reg: '7969-361' }))).toBe(true);
    expect(isProductApplication(app('In2Care Mosquito Station', 'station_check', { epa_reg: '93813-3' }))).toBe(true);
    // methodless rows default to an application unless identity says device
    expect(isProductApplication(app('Bifen I/T', null, { product_type: 'insecticide' }))).toBe(true);
  });

  it('station_check context applies nothing unless the product is a registered non-bait pesticide', () => {
    expect(isProductApplication(app('Termidor SC', 'station_check', { epa_reg: '7969-210' }))).toBe(true);
    expect(isProductApplication(app('Advance Termite Bait', 'station_check', { epa_reg: '499-557' }))).toBe(false);
    expect(isProductApplication(app('Mechanical snap trap', 'station_check'))).toBe(false);
  });

  it('epaReg blanks the catalog "N/A" placeholder', () => {
    expect(epaReg({ product: { epa_reg: 'N/A' } })).toBe('');
    expect(epaReg({ product: { epa_reg: '7969-210' } })).toBe('7969-210');
  });
});
