// Owner 2026-10-22: the termite and cockroach status cards say a fact once.
import { describe, expect, it } from 'vitest';
import { dashboardNarrative } from './ReportViewPage';

const TEMPLATE = 'No termite activity was observed in the accessible bait stations today. We inspected 22 termite bait stations around the exterior perimeter today. 22 of 22 stations were inspected.';

describe('dashboardNarrative', () => {
  it('a typed template prints only its next step, the rest restates the status line', () => {
    const dash = { source: 'primary', aiSummary: { body: `${TEMPLATE} A follow-up visit in 10–14 days is recommended.` } };
    const data = { summarySource: 'typed_narrative', typedReport: { todaysResult: { nextStep: 'A follow-up visit in 10–14 days is recommended.' } } };
    expect(dashboardNarrative(data, dash)).toBe('A follow-up visit in 10–14 days is recommended.');
    expect(dashboardNarrative({ summarySource: 'typed_narrative', typedReport: { todaysResult: {} } }, dash)).toBeNull();
  });

  it('a written report prints in full, a new place included', () => {
    const body = 'No termite activity was observed at the interior bait stations. We replaced the bait in station 4.';
    const dash = { source: 'primary', aiSummary: { body } };
    expect(dashboardNarrative({ summarySource: 'technician_report' }, dash)).toBe(body);
  });

  it('a companion block keeps its own accepted report', () => {
    const body = 'We checked the stations by the garage and found new mud tubes on station 7.';
    expect(dashboardNarrative({ summarySource: 'typed_narrative' }, { source: 'companion', aiSummary: { body } })).toBe(body);
  });

  it('no body, no narrative', () => {
    expect(dashboardNarrative({ summarySource: 'technician_report' }, { source: 'primary', aiSummary: null })).toBeNull();
  });
});
