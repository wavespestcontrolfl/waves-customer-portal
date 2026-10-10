// @vitest-environment jsdom
// The sub-line under "Services YTD" words its window from the stats route's celsiusWindow, so the text and the count cannot disagree:
// only 'rolling365' adds "in the last 12 months"; an older response without the field, or 'calendar_year', reads as it always did.
import { describe, expect, it } from 'vitest';
import source from './PortalPage.jsx?raw';
import { weedTreatmentsLine } from './PortalPage';

describe('weedTreatmentsLine', () => {
  it('rolling365: the count and "in the last 12 months"', () => {
    expect(weedTreatmentsLine({ celsiusApplicationsThisYear: 2, celsiusWindow: 'rolling365' })).toBe('2 weed treatments in the last 12 months');
    expect(weedTreatmentsLine({ celsiusApplicationsThisYear: 0, celsiusWindow: 'rolling365' })).toBe('0 weed treatments in the last 12 months');
  });
  it('calendar_year: exactly the text it has always had', () => {
    expect(weedTreatmentsLine({ celsiusApplicationsThisYear: 2, celsiusWindow: 'calendar_year' })).toBe('2 weed treatments');
  });
  it('an old API response without the field: exactly the text it has always had (no singular form is added)', () => {
    expect(weedTreatmentsLine({ celsiusApplicationsThisYear: 3 })).toBe('3 weed treatments');
    expect(weedTreatmentsLine({ celsiusApplicationsThisYear: 1 })).toBe('1 weed treatments');
  });
  it('an unknown window value reads as the old text', () => {
    expect(weedTreatmentsLine({ celsiusApplicationsThisYear: 2, celsiusWindow: 'other' })).toBe('2 weed treatments');
  });
  it('no count: nothing, so the tile falls back to "completed visits"', () => {
    expect(weedTreatmentsLine({})).toBeNull();
    expect(weedTreatmentsLine(null)).toBeNull();
    expect(weedTreatmentsLine(undefined)).toBeNull();
  });
  it('the Services YTD tile prints it, with the label unchanged', () => {
    expect(source).toContain("label: 'Services YTD'");
    expect(source).toContain("weedTreatmentsLine(stats) || 'completed visits'");
  });
});
