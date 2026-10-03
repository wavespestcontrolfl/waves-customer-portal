// @vitest-environment jsdom
// New-sod mode (GATE_LAWN_NEW_SOD_MODE) over BOTH client documents: the web lawn section (with its
// watering banner) and the PDF work-order document. Both render from the MAXIMAL normal payload (a
// water-in product with creditableWaterIn, height-of-cut with a gauge photo, a forecast line, an
// observed-rain note, a hold plan) after the server's one payload rule (lawn-new-sod-payload.js) ran.
// The text must carry the fixed new-sod sentences and none of the watering / mowing wording the mode
// forbids. The same payload UNenforced is rendered first, as the control that proves the checks bite.
import React from 'react';
import { createRequire } from 'node:module';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceReportDocument from './ServiceReportDocument';
import LawnReportV2Section from '../components/report/lawnV2/LawnReportV2Section';
import { LawnWateringBanner } from '../components/report/lawnV2/LawnReportV2';

const nodeRequire = createRequire(import.meta.url);
const { maximalLawnPayload } = nodeRequire('../../../server/tests/helpers/new-sod-maximal-payload');
const { enforceNewSodPayload } = nodeRequire('../../../server/services/service-report/lawn-new-sod-payload');
const { collectRenderedImageUrls } = nodeRequire('../../../server/services/service-report/rendered-image-urls');

afterEach(cleanup);

const FIXED = [
  'Water your new sod lightly every day.',
  'Please hold off on mowing until the sod has rooted.',
];
const PLAN_TITLE = 'New sod: water lightly every day';

// What the mode forbids anywhere on the page.
const FORBIDDEN = [
  [/extra run/i, 'extra run'],
  [/no extra/i, 'no extra'],
  [/skip/i, 'skip'],
  [/hold off on watering/i, 'hold off on watering'],
  [/ease back|easing back/i, 'ease back'],
  [/mower/i, 'mower'],
  [/\b2\.5 in\b/, 'the measured height'],
  [/3\.5-4 in/, 'the target band'],
  [/Mowing height/i, 'the mowing height row'],
  [/inch of rain/i, 'a forecast / observed rain line'],
  [/Hold irrigation until/i, 'the label irrigation hold'],
  [/Watering in:/i, 'the product watering-in row'],
];

const webText = (v2, { lead = false } = {}) => {
  const data = lead ? { ...v2, lead: { headline: 'Stable', applied: 'We applied a fertilizer.', yourPart: [], next: null } } : v2;
  const { container } = render(
    <div>
      <LawnWateringBanner banner={data.banner} />
      <LawnReportV2Section data={data} />
    </div>,
  );
  return visibleText(container);
};
// Visible text only: the document inlines a <style> block whose class names (waves-skip-link) are not copy.
const visibleText = (container) => {
  const copy = container.cloneNode(true);
  copy.querySelectorAll('style, script').forEach((node) => node.remove());
  return copy.textContent;
};
const pdfText = (payload) => visibleText(render(<ServiceReportDocument data={payload} token="tok-newsod" />).container);

describe('control: the normal maximal payload prints what the mode forbids', () => {
  it('web: the run/hold credit wording, the forecast and the mowing height appear', () => {
    const text = webText(maximalLawnPayload().reportV2);
    expect(text).toMatch(/no extra runs/i);
    expect(text).toMatch(/inch of rain/i);
    expect(text).toMatch(/mower/i);
  });
  it('pdf: the mowing height row, the irrigation hold and the watering-in row appear', () => {
    const text = pdfText(maximalLawnPayload());
    expect(text).toMatch(/Mowing height/);
    expect(text).toMatch(/Hold irrigation until/);
    expect(text).toMatch(/Watering in:/);
  });
});

describe('new-sod mode: both documents from the enforced maximal payload', () => {
  const enforced = () => enforceNewSodPayload(maximalLawnPayload());

  it.each([['lead layout', true], ['classic layout', false]])('web section, %s: the fixed sentences, none of the forbidden wording', (_name, lead) => {
    const text = webText(enforced().reportV2, { lead });
    for (const sentence of FIXED) expect(text).toContain(sentence);
    expect(text).toContain(PLAN_TITLE);
    for (const [pattern, label] of FORBIDDEN) expect([label, pattern.test(text)]).toEqual([label, false]);
  });

  it('the week-plan card is the plain new-sod card, never a run/hold credit card', () => {
    const { container } = render(<LawnReportV2Section data={enforced().reportV2} />);
    const plan = container.querySelector('[data-testid="lawn-week-plan"]');
    expect(plan.getAttribute('data-plan-action')).toBe('new_sod');
    expect(plan.querySelector('[data-testid="lawn-week-plan-aftercare-note"]')).toBeNull();
    expect(plan.querySelector('[data-testid="lawn-week-plan-condition"]')).toBeNull();
  });

  it('even a new-sod plan that reaches the page beside a credit-bearing aftercare stays the plain card (client rule)', () => {
    const v2 = enforced().reportV2;
    v2.aftercare = { watering: 'Water in today’s treatment by Fri 3 PM.', creditableWaterIn: true, evidenceSource: 'product_instruction', waterInRequired: true };
    const text = webText(v2);
    expect(text).not.toMatch(/no extra runs|extra run/i);
    expect(text).toContain(PLAN_TITLE);
  });

  // Rain known, irrigation unknown: the server sends a finite 0 irrigation and scheduleOnFile:false.
  // The card must not turn that into a complete weekly Total or a measured irrigation figure.
  describe('rain known, irrigation missing', () => {
    const rainOnly = () => {
      const payload = maximalLawnPayload();
      Object.assign(payload.reportV2.water, { rainInches: 2.1, irrigationInches: 0, totalInches: 2.1, scheduleOnFile: false, scheduleUnconfirmed: false });
      return enforceNewSodPayload(payload);
    };

    it('the server keeps the evidence exactly as built', () => {
      const w = rainOnly().reportV2.water;
      expect(w).toMatchObject({ scheduleOnFile: false, rainInches: 2.1, irrigationInches: 0, totalInches: 2.1, targetInches: null });
    });

    it.each([['lead layout', true], ['classic layout', false]])('web section, %s: rain only, "Not on file", no Total, no zero irrigation, no schedule CTA', (_name, lead) => {
      const text = webText(rainOnly().reportV2, { lead });
      expect(text).toMatch(/Rain/);
      expect(text).toMatch(/2\.1/);
      expect(text).toMatch(/Not on file/);
      expect(text).not.toMatch(/Total/);
      expect(text).not.toMatch(/Irrigation\s*0/);
      expect(text).not.toMatch(/Add your watering schedule|we don’t have your watering schedule/i);
      expect(text).toContain(PLAN_TITLE);
    });

    it('web section: the move note is suppressed too (the evidence flag stays true)', () => {
      const payload = maximalLawnPayload();
      Object.assign(payload.reportV2.water, { rainInches: 2.1, irrigationInches: null, totalInches: null, scheduleOnFile: false, scheduleUnconfirmed: true });
      const v2 = enforceNewSodPayload(payload).reportV2;
      expect(v2.water.scheduleUnconfirmed).toBe(true);
      expect(webText(v2)).not.toMatch(/sprinkler settings|Re-enter your zone minutes/i);
    });

    it('the NORMAL card still shows the schedule CTA for the same evidence (the control)', () => {
      const payload = maximalLawnPayload();
      Object.assign(payload.reportV2.water, { rainInches: 2.1, irrigationInches: 0, totalInches: 2.1, scheduleOnFile: false });
      payload.reportV2.water.weekPlan = { title: 'Water twice this week', detail: 'x', action: 'run', visitInPlanWeek: true, prescribesRun: true };
      expect(webText(payload.reportV2)).toMatch(/Add your watering schedule/);
    });

    it('pdf document: it prints no Total or measured irrigation figure for the week either', () => {
      const text = pdfText(rainOnly());
      expect(text).not.toMatch(/Total water|Irrigation\s*0|Total\s*2\.1/i);
      for (const sentence of FIXED.map((s) => s.replace(/\.$/, ''))) expect(text).toContain(sentence);
    });
  });

  it('a new-sod visit with no rain or irrigation reading still shows the plan card', () => {
    const v2 = enforced().reportV2;
    v2.water = { ...v2.water, rainInches: null, irrigationInches: null, totalInches: null };
    const { container } = render(<LawnReportV2Section data={v2} />);
    expect(container.textContent).toContain(PLAN_TITLE);
  });

  it('pdf document: the fixed sentences, no mowing height, gauge photo, irrigation hold or watering-in row', () => {
    const payload = enforced();
    const text = pdfText(payload);
    for (const sentence of FIXED.map((s) => s.replace(/\.$/, ''))) expect(text).toContain(sentence);
    for (const [pattern, label] of FORBIDDEN) expect([label, pattern.test(text)]).toEqual([label, false]);
    // The gauge photo is not rendered: the server's image mirror agrees.
    expect(collectRenderedImageUrls(payload)).not.toContain('https://img.example.test/gauge.jpg');
    expect(document.querySelector('img[src="https://img.example.test/gauge.jpg"]')).toBeNull();
  });

  it('pdf document: the client rule alone (a payload the server did not clean) still prints none of it', () => {
    const payload = maximalLawnPayload();
    payload.reportV2.banner = { state: 'new_sod', lines: FIXED };
    const text = pdfText(payload);
    expect(text).not.toMatch(/Mowing height/);
    expect(text).not.toMatch(/Hold irrigation until/);
    expect(text).not.toMatch(/Watering in:/);
    expect(document.querySelector('img[src="https://img.example.test/gauge.jpg"]')).toBeNull();
    // ...and the image mirror agrees with the client.
    expect(collectRenderedImageUrls(payload)).not.toContain('https://img.example.test/gauge.jpg');
  });
});

// Visit-shape sweep: every shape a new-sod visit can take, in every layout the report has, on BOTH documents.
// The two fixed sentences print exactly once per document, whatever else is present or missing.
describe('visit-shape sweep', () => {
  const PHOTO_SET = [
    { url: 'https://img.example.test/set-front.jpg', shot: 'front', label: 'Front yard' },
    { url: 'https://img.example.test/set-back.jpg', shot: 'back', label: 'Back yard' },
  ];
  const EXPECT_LINE = 'Once the sod has rooted, you can start mowing and we can begin your regular lawn care.';
  const LAYOUTS = {
    'lead off': undefined,
    'lead on, v6 off': { headline: 'Stable', applied: 'We applied a fertilizer to feed the lawn.', yourPart: [], next: null },
    'lead on, v6 on': { headline: 'Stable', applied: 'We applied a fertilizer to feed the lawn.', whatToExpect: EXPECT_LINE, yourPart: [], next: null },
  };
  const SHAPES = {
    'normal treatment visit': () => {},
    'inspection-only: no applications, false treatment verdicts': (p) => {
      p.applications = [];
      p.treatmentPerformed = false;
      p.applicationMade = false;
      p.reportV2.treatment = null;
      p.reportV2.aftercare = { watering: 'No special watering is needed because of today’s treatment — keep your normal schedule unless your technician advised otherwise.', neutral: true, waterInRequired: false };
    },
    'water-in product with creditableWaterIn': (p) => { p.applicationMade = true; p.treatmentPerformed = true; },
    'no products readable (load failed)': (p) => {
      p.applications = [];
      p.applicationMade = null;
      p.reportV2.treatment = null;
    },
    'no rain or irrigation readings at all': (p) => {
      Object.assign(p.reportV2.water, { rainInches: null, irrigationInches: null, totalInches: null, scheduleOnFile: true });
      p.lawnAssessment.waterContext.rainfallInches7d = null;
      p.lawnAssessment.waterContext.irrigationInchesPerWeek = null;
    },
    'rain known, irrigation missing': (p) => {
      Object.assign(p.reportV2.water, { rainInches: 2.1, irrigationInches: 0, totalInches: 2.1, scheduleOnFile: false });
    },
    'height of cut captured': (p) => { p.mowingHeight.heightIn = 2.5; },
    'a photo set present beside the new-sod block': (p) => {
      p.reportV2.photoSet = PHOTO_SET;
      p.photos = [{ id: 'lawn-1', url: 'https://img.example.test/p1.jpg' }];
    },
  };

  const build = (shape, layout) => {
    const payload = maximalLawnPayload();
    SHAPES[shape](payload);
    const enforced = enforceNewSodPayload(payload);
    if (LAYOUTS[layout]) enforced.reportV2.lead = { ...LAYOUTS[layout] };
    return enforced;
  };
  const occurrences = (text, sentence) => text.split(sentence).length - 1;
  const cases = Object.keys(SHAPES).flatMap((shape) => Object.keys(LAYOUTS).map((layout) => [shape, layout]));

  it.each(cases)('web section — %s — %s: each fixed sentence once, nothing forbidden', (shape, layout) => {
    const enforced = build(shape, layout);
    const { container } = render(
      <div>
        <LawnWateringBanner banner={enforced.reportV2.banner} />
        <LawnReportV2Section data={enforced.reportV2} />
      </div>,
    );
    const text = visibleText(container);
    for (const sentence of FIXED) expect([sentence, occurrences(text, sentence)]).toEqual([sentence, 1]);
    for (const [pattern, label] of FORBIDDEN) expect([label, pattern.test(text)]).toEqual([label, false]);
    if (shape.startsWith('a photo set')) {
      expect(container.querySelector('img[src="https://img.example.test/set-front.jpg"]')).not.toBeNull();
    }
  });

  it.each(cases)('pdf document — %s — %s: each fixed sentence once, nothing forbidden', (shape, layout) => {
    const enforced = build(shape, layout);
    const { container } = render(<ServiceReportDocument data={enforced} token="tok-newsod" />);
    const text = visibleText(container);
    for (const sentence of FIXED) expect([sentence, occurrences(text, sentence)]).toEqual([sentence, 1]);
    for (const [pattern, label] of FORBIDDEN) expect([label, pattern.test(text)]).toEqual([label, false]);
    expect(container.querySelector('[data-testid="doc-new-sod"]')).not.toBeNull();
    expect(document.querySelector('img[src="https://img.example.test/gauge.jpg"]')).toBeNull();
    if (shape.startsWith('a photo set')) {
      expect(container.querySelector('img[src="https://img.example.test/set-front.jpg"]')).not.toBeNull();
    }
  });

  it('the pdf block is driven by the banner alone: no applications, no aftercare, no plan, no water card', () => {
    const payload = { ...maximalLawnPayload(), applications: [], treatmentPerformed: false, applicationMade: false };
    payload.reportV2 = { banner: { state: 'new_sod', lines: FIXED }, snapshot: { overallScore: 80, statusHeadline: 'Looking healthy' } };
    const { container } = render(<ServiceReportDocument data={payload} token="tok-newsod" />);
    const text = visibleText(container);
    for (const sentence of FIXED) expect([sentence, occurrences(text, sentence)]).toEqual([sentence, 1]);
  });
});
