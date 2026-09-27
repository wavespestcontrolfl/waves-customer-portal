import { describe, it, expect } from 'vitest';
import { isProductApplication, epaReg, isRodenticideRow, reportHasRodenticide } from './product-application';

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

describe('reportHasRodenticide — bait stations carry Poison Control though servicing is not an application', () => {
  it('rodenticide and rodent bait rows count; termite bait and ordinary pest bait do not', () => {
    expect(isRodenticideRow(app('Contrac Blox', 'station_check', { category: 'rodenticide' }))).toBe(true);
    expect(isRodenticideRow(app('Protecta Rodent Bait Station', 'station_check'))).toBe(true);
    expect(isRodenticideRow(app('Trelona ATBS Termite Bait Station', 'station_check'))).toBe(false);
    expect(isRodenticideRow(app('Advion Ant Bait Gel', 'bait_placement'))).toBe(false);
  });

  it('a rodent bait-station visit counts by typed flow, companion, station program or recorded row', () => {
    expect(reportHasRodenticide({ typedReport: { type: 'rodent_bait_station' } })).toBe(true);
    expect(reportHasRodenticide({ companionReports: [{ type: 'rodent_bait_station' }] })).toBe(true);
    expect(reportHasRodenticide({ stationMap: { program: 'rodent' } })).toBe(true);
    expect(reportHasRodenticide({ applications: [app('Contrac Blox', 'station_check', { category: 'rodenticide' })] })).toBe(true);
  });

  it('trapping, termite stations and ordinary visits do not', () => {
    expect(reportHasRodenticide({ typedReport: { type: 'rodent_trapping' }, stationMap: { program: 'trapping' } })).toBe(false);
    expect(reportHasRodenticide({ typedReport: { type: 'termite_bait_station' }, stationMap: { program: 'termite' } })).toBe(false);
    expect(reportHasRodenticide({ applications: [app('Talstar P', 'perimeter_spray')] })).toBe(false);
    expect(reportHasRodenticide(null)).toBe(false);
  });
});
