// @vitest-environment jsdom
// GATE_LAWN_REPORT_STAGE1_FIXES on the lawn PDF: the "What we found" bullet follows the damage insight (so it names the
// pest on its own), "What to expect" prints both lines, the "What we applied today" text is NOT left out (the PDF prints
// the summary once) and the contact block keeps the email and phone. Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceReportDocument from './ServiceReportDocument';

afterEach(() => cleanup());

const WEED = 'Treated weeds stop growing within hours, then yellow or redden and die back over about 1 to 4 weeks, depending on the weed and the weather.';
const INSECT = 'This treatment works to stop the insects causing the damage.';
const RESULT = 'Today we applied a spot treatment for weeds and a spot treatment for insects.';

const lawnData = (over = {}) => ({
  serviceRecordId: '00000000-0000-4000-8000-000000000003',
  serviceDate: '2026-10-08T00:00:00.000Z',
  serviceDisplayName: 'Lawn Care Service',
  serviceLine: 'lawn',
  technicianName: 'Test T.',
  customerName: 'Test Customer',
  customerEmail: 'test.customer@example.com',
  customerPhone: '9415550190',
  serviceAddress: '1 Test Way, Testville, FL 00000',
  applicationMade: true,
  applications: [],
  zones: [],
  photos: [],
  findings: [],
  reportV2: {
    snapshot: { overallScore: 78, status: 'healthy', statusHeadline: 'Stable', treatmentSummary: `${RESULT.slice(0, -1)}, targeting chinch bugs.` },
    todaysResult: RESULT,
    insights: [{
      category: 'damage', status: 'watch', headline: 'Chinch bug damage in one area — treated today',
      whatWeSaw: 'Your technician found chinch bugs and treated that spot today.', whyItMatters: null,
      wavesAction: 'Applied Arena 50 WDG to about 500 sq ft.', nextVisitPlan: 'Recheck these areas next visit to confirm what’s driving them.',
    }],
    diagnosis: [],
    lead: {
      headline: 'Stable', applied: `${RESULT.slice(0, -1)}, targeting chinch bugs.`, yourPart: [], next: null,
      whatToExpect: `${WEED} ${INSECT}`,
    },
  },
  lawnStage1Fixes: true,
  ...over,
});

const text = (data) => render(<ServiceReportDocument data={data} token="tok-s1-pdf" />).container.textContent;

describe('the lawn PDF with the stage 1 fixes live', () => {
  it('"What we found" prints the pest-named damage finding from the insight itself', () => {
    const out = text(lawnData());
    expect(out).toContain('Chinch bug damage in one area — treated today:');
    expect(out).toContain('Your technician found chinch bugs and treated that spot today.');
    expect(out).not.toContain('A few stress patterns to monitor');
  });

  it('"What to expect" prints the weed line and the second line', () => {
    const out = text(lawnData());
    expect(out).toContain(`What to expect: ${WEED} ${INSECT}`);
  });

  it('the applied text is printed (the PDF prints the summary once) and the contact block keeps the email and phone', () => {
    const out = text(lawnData());
    expect(out).toContain(RESULT.slice(0, -1));
    expect(out).toContain('test.customer@example.com');
    expect(out).toContain('555-0190');
  });

  it('the flag changes nothing in the PDF text by itself', () => {
    expect(text(lawnData())).toBe(text(lawnData({ lawnStage1Fixes: undefined })));
  });
});
