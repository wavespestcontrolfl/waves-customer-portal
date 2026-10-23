// Owner 2026-10-22: the termite and cockroach status cards say a fact once.
import { describe, expect, it } from 'vitest';
import { dashboardNarrative } from './ReportViewPage';

const FALLBACK = 'No termite activity was observed in the accessible bait stations today. We inspected 22 termite bait stations around the exterior perimeter today. 22 of 22 stations were inspected.';

describe('dashboardNarrative', () => {
  it('leaves out the fixed fallback summary the server marks', () => {
    const dash = { source: 'primary', aiSummary: { body: FALLBACK } };
    expect(dashboardNarrative({ summarySource: 'typed_narrative', summaryIsTemplate: true }, dash)).toBeNull();
  });

  it('prints model prose in full, a new place and an instruction included', () => {
    const body = 'We found fresh droppings at the interior stations by the garage. Keep the garage door closed at night.';
    const dash = { source: 'primary', aiSummary: { body } };
    expect(dashboardNarrative({ summarySource: 'typed_narrative', summaryIsTemplate: false }, dash)).toBe(body);
  });

  it('prints a written report and a companion block in full', () => {
    const body = 'We replaced the bait in station 4 after finding termite activity there.';
    expect(dashboardNarrative({ summarySource: 'technician_report' }, { source: 'primary', aiSummary: { body } })).toBe(body);
    expect(dashboardNarrative({ summarySource: 'typed_narrative', summaryIsTemplate: true }, { source: 'companion', aiSummary: { body } })).toBe(body);
  });

  it('no body, no narrative', () => {
    expect(dashboardNarrative({ summarySource: 'technician_report' }, { source: 'primary', aiSummary: null })).toBeNull();
  });
});
