import { describe, expect, it } from 'vitest';
import { isFastCompleteReportEligible, isPestControlService } from './pest-fast-complete';
import { isAreaAddOnVisit } from './areaAddOns';

const pest = (completionProfile, extra = {}) => ({ fastCompleteReportEnabled: true, status: 'confirmed', completionProfile, ...extra });

describe('an area add-on is never the pest completion form', () => {
  it('the web sweep is pest control by family but generic work: no recap modal, no pest report flow', () => {
    const sweep = pest({ category: 'pest_control', serviceKey: 'area_addon_web_sweep', findingsType: null });
    expect(isPestControlService(sweep)).toBe(false);
    expect(isFastCompleteReportEligible(sweep)).toBe(false);
    const ordinary = pest({ category: 'pest_control', serviceKey: 'pest_general_quarterly', findingsType: null });
    expect(isPestControlService(ordinary)).toBe(true);
    expect(isFastCompleteReportEligible(ordinary)).toBe(true);
  });

  it('knows an add-on visit by the profile key, the schedule row key or the booked snapshot, never by name', () => {
    expect(isAreaAddOnVisit({ completionProfile: { serviceKey: 'area_addon_fire_ant_yard' } })).toBe(true);
    expect(isAreaAddOnVisit({ serviceKey: 'area_addon_bed_pre_emergent' })).toBe(true);
    expect(isAreaAddOnVisit({ service_key_snapshot: 'area_addon_web_sweep' })).toBe(true);
    expect(isAreaAddOnVisit({ serviceType: 'Fire Ant Yard Treatment', completionProfile: { serviceKey: 'fire_ant' } })).toBe(false);
    expect(isAreaAddOnVisit(null)).toBe(false);
    expect(isAreaAddOnVisit({})).toBe(false);
  });
});
