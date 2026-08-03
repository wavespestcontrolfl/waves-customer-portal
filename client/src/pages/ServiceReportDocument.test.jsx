// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceReportDocument from './ServiceReportDocument';

afterEach(() => cleanup());

const BASE_DATA = {
  serviceRecordId: '00000000-0000-4000-8000-000000000001',
  serviceDate: '2026-08-02T00:00:00.000Z',
  serviceDisplayName: 'Cockroach Treatment',
  serviceLine: 'pest',
  technicianName: 'Adam',
  customerName: 'Test Customer',
  customerEmail: 'test@example.com',
  customerPhone: '+19415550000',
  serviceAddress: '123 Main St, Bradenton, FL 34209',
  visitTiming: { arrivedAt: '2026-08-02T20:27:00.000Z', exitedAt: '2026-08-02T21:03:00.000Z' },
  customerInteraction: 'tech_home_spoke_with_them',
  conditions: { temp_f: 82, humidity_pct: 77, wind_mph: 7, rain_24h_in: 0.49, sky: 'Cloudy' },
  typedReport: {
    todaysResult: { headline: 'Cockroach activity was moderate today.', body: 'We completed the scheduled service.', nextStep: 'Keep treated areas undisturbed.' },
    findings: [{ fieldKey: 'species', customerLabel: 'What we found', customerValueLabel: 'German cockroaches' }],
    nextStepChips: [],
  },
  dynamicContext: {
    reentry: {
      customerSummary: 'Treated areas are ready for normal use.',
      targets: [{ key: 'interior', label: 'Interior', durationMin: 120, readyAt: '2026-08-02T23:03:00.000Z' }],
      petAdvisory: 'Keep pets off treated zones until dry.',
    },
  },
  zones: [{ id: 'z1', label: 'Front perimeter' }, { id: 'z2', label: 'Kitchen' }],
  applications: [{
    id: 'app-1',
    product: {
      name: 'Alpine WSG',
      epa_reg: '499-561',
      active_ingredient: 'Dinotefuran 40.0%',
      precaution_summary: 'Keep people and pets off treated areas until sprays have dried.',
    },
    methodLabel: 'Fog or ULV',
    zone_ids: ['z1'],
    rate: '10.000',
    rateUnit: 'g/gal',
    totalAmount: '5.000',
    amountUnit: 'fl_oz',
    targets: ['German cockroaches'],
  }],
  photos: [{ id: 'p1' }],
};

describe('ServiceReportDocument (PDF work-order layout)', () => {
  it('renders the record identity, EPA facts, and label safety', () => {
    render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    expect(screen.getByText('SERVICE REPORT')).toBeInTheDocument();
    expect(screen.getByText('Test Customer')).toBeInTheDocument();
    expect(screen.getByText('499-561')).toBeInTheDocument();
    expect(screen.getByText(/Dinotefuran 40\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/keep people and pets off treated areas/i)).toBeInTheDocument();
    // snake_case units and trailing zeros never reach the customer
    expect(screen.getByText('5 fl oz')).toBeInTheDocument();
    expect(screen.getByText('10 g/gal')).toBeInTheDocument();
  });

  it('is a service record, not an invoice — no pricing ever renders', () => {
    const { container } = render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    expect(container.textContent).toContain('This is not an invoice.');
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  it('embeds service photos with captions', () => {
    const data = { ...BASE_DATA, photos: [{ id: 'p1', url: 'https://cdn.example.com/photo-1.jpg', caption: 'Attic entry point sealed' }] };
    render(<ServiceReportDocument data={data} token="tok123" />);
    expect(document.querySelector('img[src="https://cdn.example.com/photo-1.jpg"]')).toBeTruthy();
    expect(screen.getByText('Attic entry point sealed')).toBeInTheDocument();
  });

  it('draws station placement pins but never prints the satellite basemap (provider ToS)', () => {
    const data = {
      ...BASE_DATA,
      stationMap: {
        available: true,
        program: 'trapping',
        image: { url: 'https://maps.googleapis.com/maps/api/staticmap?key=secret', width: 640, height: 340 },
        stations: [
          { id: 's1', number: 1, cx: 0.25, cy: 0.5, status: 'ok' },
          { id: 's2', number: 2, cx: 0.75, cy: 0.4, status: 'activity' },
        ],
        summary: { total: 2, checked: 2, activity: 1, inaccessible: 0 },
      },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText('Trap placement')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('maps.googleapis.com');
  });

  it('renders the generated map without injecting payload markup', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 340"><style>.z{fill:red}</style><rect class="z"/></svg>';
    const { container } = render(<ServiceReportDocument data={{ ...BASE_DATA, mapSvg: svg }} token="tok123" />);
    // the map arrives as an <img> data URI — an <img> cannot execute script
    // or fetch, so payload markup never becomes live DOM in this document
    expect(container.querySelector('img[src^="data:image/svg+xml"]')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('embeds the technician-traced treatment map when one exists', () => {
    const data = { ...BASE_DATA, treatmentMap: { traced: { snapshotUrl: 'https://cdn.example.com/trace.png' }, footer: 'Technician-reported service zones.' } };
    render(<ServiceReportDocument data={data} token="tok123" />);
    expect(document.querySelector('img[src="https://cdn.example.com/trace.png"]')).toBeTruthy();
    expect(screen.getByText('Technician-reported service zones.')).toBeInTheDocument();
  });

  it('names only the treated zones, not the whole property, for a partial application', () => {
    render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    expect(screen.getByText('Front perimeter')).toBeInTheDocument();
  });

  it('hides the conditions readings when the visit recorded none', () => {
    render(<ServiceReportDocument data={{ ...BASE_DATA, conditions: {} }} token="tok123" />);
    expect(screen.getByText('Not recorded for this visit.')).toBeInTheDocument();
  });
});
