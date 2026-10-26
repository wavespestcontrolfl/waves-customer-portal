import { describe, expect, it } from 'vitest';
import {
  PUMP_NOZZLE_LIMIT, RISER_SPACING_FT, ZONE_KIT_NOZZLE_LIMIT, pumpLoad, pumpLoadLine, pumpNotice,
} from './mistingLayoutLimits';

describe('pump capacity (Pynamite: Cube Pro 60 nozzles, 120 with the Zone Kit)', () => {
  it('has the published numbers', () => {
    expect(PUMP_NOZZLE_LIMIT).toBe(60);
    expect(ZONE_KIT_NOZZLE_LIMIT).toBe(120);
    expect(RISER_SPACING_FT).toBe(8);
  });

  it('counts a riser as a nozzle: the load is nozzles plus risers', () => {
    expect(pumpLoad(40, 12)).toBe(52);
    expect(pumpLoad(0, 0)).toBe(0);
    expect(pumpLoad(undefined, '3')).toBe(3);
    expect(pumpLoadLine(52)).toBe('Pump load: 52 of 60');
  });

  it('says nothing up to 60, amber from 61 to 120 (a Zone Kit), red above 120 (a second system)', () => {
    expect(pumpNotice(0)).toBeNull();
    expect(pumpNotice(60)).toBeNull();
    expect(pumpNotice(61)).toEqual({ level: 'amber', text: 'Over 60 nozzles: needs a Pynamite Zone Kit (up to 120)' });
    expect(pumpNotice(120)).toMatchObject({ level: 'amber' });
    expect(pumpNotice(121)).toEqual({ level: 'red', text: 'Over 120 nozzles: needs a second system' });
  });
});
