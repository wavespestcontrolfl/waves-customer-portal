// @vitest-environment jsdom
// GATE_LAWN_REPORT_FACTS: the lawn PDF prints the frozen re-entry condition (no clock, no countdown) and a spot
// product's frozen "where it was used". A payload without the new fields prints exactly as before. Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceReportDocument from './ServiceReportDocument';

afterEach(() => cleanup());

const SPRAY = 'Ready to walk on once the spray has dried.';
const PETS = 'Keep people and pets off the lawn until then.';

const app = (id, name, over = {}) => ({
  id,
  product: { name, category: 'herbicide', epa_reg: '12345-6', active_ingredient: 'x', facts_approved: false },
  method: 'spot_treatment',
  methodLabel: 'Spot treatment',
  zone_ids: ['z-a', 'z-b'],
  targets: [],
  appliedAt: '2026-10-08T20:05:00.000Z',
  ...over,
});

const lawnData = (over = {}) => ({
  serviceRecordId: '00000000-0000-4000-8000-000000000002',
  serviceDate: '2026-10-08T00:00:00.000Z',
  serviceDisplayName: 'Lawn Care Service',
  serviceLine: 'lawn',
  technicianName: 'Test T.',
  customerName: 'Test Customer',
  serviceAddress: '1 Test Way, Testville, FL 00000',
  applicationMade: true,
  applications: [app('a1', 'Spot Herbicide', { areaUse: 'Spot treatment, about 250 sq ft' }), app('a2', 'Feeding', { method: 'granular_broadcast' })],
  zones: [{ id: 'z-a', label: 'Front yard' }, { id: 'z-b', label: 'Back yard' }],
  photos: [],
  findings: [],
  dynamicContext: {
    reentry: {
      generatedAt: '2026-10-08T21:00:00.000Z',
      displayTimezone: 'America/New_York',
      targets: [],
      condition: { rule: 'dry', text: SPRAY, pets: PETS, statusLabel: 'Once dry' },
      customerSummary: SPRAY,
      petAdvisory: PETS,
    },
  },
  ...over,
});

const text = (data, token) => render(<ServiceReportDocument data={data} token={token} />).container.textContent;

describe('lawn PDF re-entry', () => {
  it('prints the frozen condition and the precaution line, with no ready-at time or countdown', () => {
    const out = text(lawnData(), 'tok-f1');
    expect(out).toContain('Re-entry & precautions');
    expect(out).toContain(SPRAY);
    expect(out).toContain(PETS);
    expect(out).not.toMatch(/ready at|ready after|Ready in|\d+ min|\d+ sec/i);
  });

  it('the aftercare line is the same sentence, so it prints once', () => {
    const data = lawnData({ reportV2: { aftercare: { reentry: SPRAY, watering: 'Water it in by Fri 8 PM.' } } });
    const out = text(data, 'tok-f1b');
    expect(out.split(SPRAY)).toHaveLength(2);
  });

  it('a payload with no condition prints the line it printed before', () => {
    const out = text(lawnData({
      dynamicContext: { reentry: { customerSummary: 'Exterior ready at 7:03 AM.', targets: [{ key: 'exterior', label: 'Exterior', readyAt: '2026-10-05T11:03:56.943Z' }], petAdvisory: 'Keep pets and family off treated turf until it dries.' } },
    }), 'tok-f2');
    expect(out).not.toContain(SPRAY);
    expect(out).toContain('Exterior: ready once dry');
  });
});

describe('lawn PDF product areas', () => {
  const areaLines = (container) => [...container.querySelectorAll('div')]
    .filter((el) => el.firstElementChild?.tagName === 'STRONG' && el.firstElementChild.textContent === 'Areas:')
    .map((el) => el.textContent.replace(/^Areas:\s*/, ''));

  it('a spot product prints its frozen text; a whole-lawn product keeps the zone text', () => {
    const { container } = render(<ServiceReportDocument data={lawnData()} token="tok-f3" />);
    const lines = areaLines(container);
    expect(lines).toContain('Spot treatment, about 250 sq ft');
    expect(lines).toContain('Your whole lawn');
  });

  it('without areaUse the spot product prints the zone text as before', () => {
    const data = lawnData({ applications: [app('a1', 'Spot Herbicide'), app('a2', 'Feeding', { method: 'granular_broadcast' })] });
    const lines = areaLines(render(<ServiceReportDocument data={data} token="tok-f4" />).container);
    expect(lines).toEqual(['Your whole lawn', 'Your whole lawn']);
  });
});
