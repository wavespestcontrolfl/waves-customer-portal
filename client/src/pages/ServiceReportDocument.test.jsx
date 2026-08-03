// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('never prints a fixed re-entry duration (AGENTS.md compliance)', () => {
    const { container } = render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    expect(container.textContent).toMatch(/Interior: ready after/);
    expect(container.textContent).not.toMatch(/keep clear for/i);
    expect(container.textContent).not.toMatch(/\b\d+\s*(hours?|minutes?)\s*after treatment/i);
  });

  it('renders top-level record findings, not just typed ones', () => {
    const data = { ...BASE_DATA, findings: [{ id: 'f1', title: 'Ant trail at the kitchen slider', detail: 'Treated and monitored.', severity: 'medium' }] };
    render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText(/Ant trail at the kitchen slider/)).toBeInTheDocument();
    expect(screen.getByText(/Treated and monitored\./)).toBeInTheDocument();
  });

  it('renders customer-facing companion services but never staff-only ones', () => {
    const data = {
      ...BASE_DATA,
      companionReports: [
        { type: 'mosquito', reportTypeLabel: 'Mosquito Service Summary', todaysResult: { headline: 'Mosquito pressure was light.' }, findings: [{ fieldKey: 'sites', customerLabel: 'Breeding sites', customerValueLabel: 'Two corrected' }] },
        { type: 'internal_audit', internalOnly: true, reportTypeLabel: 'Internal QA', todaysResult: { headline: 'Staff-only note.' }, findings: [] },
      ],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText('Mosquito Service Summary')).toBeInTheDocument();
    expect(screen.getByText(/Two corrected/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Internal QA');
    expect(container.textContent).not.toContain('Staff-only note');
  });

  it('claims tamper-evidence only when every displayed photo is chained', () => {
    const chained = { id: 'p1', url: 'https://cdn.example.com/a.jpg', hashSha256: 'abc' };
    const unchained = { id: 'p2', url: 'https://cdn.example.com/b.jpg' };
    const claim = /hash-chained and tamper-evident/;

    const all = render(<ServiceReportDocument data={{ ...BASE_DATA, photoChain: { valid: true }, photos: [chained] }} token="t" />);
    expect(all.container.textContent).toMatch(claim);
    cleanup();

    // one displayed photo outside the chain -> no claim
    const mixed = render(<ServiceReportDocument data={{ ...BASE_DATA, photoChain: { valid: true }, photos: [chained, unchained] }} token="t" />);
    expect(mixed.container.textContent).not.toMatch(claim);
    cleanup();

    // valid chain but nothing displayed (hidden gauge shot) -> no claim
    const none = render(<ServiceReportDocument data={{ ...BASE_DATA, photoChain: { valid: true }, photos: [] }} token="t" />);
    expect(none.container.textContent).not.toMatch(claim);
  });

  it('never egresses raw technician notes via the recommendations arrays', () => {
    // buildProtocolPayload folds raw [next]-tagged technician_notes into both
    // arrays; AGENTS.md forbids raw notes on any report path.
    const leak = 'Gate code 4417, bill the office not the tenant';
    const data = { ...BASE_DATA, recommendations: [leak], protocol: { recommendations: [leak] } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain(leak);
    expect(container.textContent).not.toContain('Gate code');
  });

  it('does not claim treatment areas on a visit with no applications', () => {
    // the server always builds mapSvg, even for inspection-only visits
    const data = { ...BASE_DATA, applications: [], mapSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('Where we treated');
    expect(container.querySelector('img[src^="data:image/svg+xml"]')).toBeNull();
  });

  it('renders the governed V2 result instead of dropping it', () => {
    const data = {
      ...BASE_DATA,
      typedReport: null,
      pestReportV2: {
        status: { label: 'Protected' },
        statusSummary: 'No activity found at the monitored points.',
        bugFiles: [{ pestKey: 'german_roach', suspectLabel: 'German roach', whyItMatters: 'Tied to interior moisture.', whatWeDid: 'Placed monitors.' }],
      },
    };
    render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText(/Protected/)).toBeInTheDocument();
    expect(screen.getByText(/Tied to interior moisture/)).toBeInTheDocument();
  });

  it('renders governed lawn V2 insights and never the raw per-photo blurbs', () => {
    const rawBlurb = 'Possible take-all root rot with severe decline visible';
    const data = {
      ...BASE_DATA,
      reportV2: {
        snapshot: { overallScore: 86, statusHeadline: 'St. Augustine lawn looking strong' },
        insights: [{ category: 'water', headline: 'A wet week to keep in mind', whatWeSaw: 'Rain totaled 2.43 inches.' }],
        photoSummary: 'Turf is dense across the yard.',
      },
      photos: [{ id: 'lawn-9', url: 'https://cdn.example.com/lawn.jpg', caption: rawBlurb }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText(/St\. Augustine lawn looking strong/)).toBeInTheDocument();
    expect(screen.getByText(/A wet week to keep in mind/)).toBeInTheDocument();
    expect(screen.getByText(/Turf is dense across the yard/)).toBeInTheDocument();
    expect(container.textContent).not.toContain(rawBlurb);
  });

  it('keeps approved visual moments and the turf-height gauge photo', () => {
    const data = {
      ...BASE_DATA,
      photos: [],
      proofMoments: [{ id: 'm1', mediaUrl: 'https://cdn.example.com/moment.jpg', mediaType: 'image', customerCaption: 'Entry point sealed' }],
      mowingHeight: { heightIn: 3.5, photoUrl: 'https://cdn.example.com/gauge.jpg' },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.querySelector('img[src="https://cdn.example.com/moment.jpg"]')).toBeTruthy();
    expect(container.querySelector('img[src="https://cdn.example.com/gauge.jpg"]')).toBeTruthy();
    // unchained media displayed -> the tamper-evidence claim must not appear
    expect(container.textContent).not.toMatch(/hash-chained/);
  });

  it('reads legacy weather aliases and canonical interaction outcomes', () => {
    const data = {
      ...BASE_DATA,
      conditions: { temp: 79, humidity: 64, wind: 4, cloudCover: 'Partly cloudy' },
      customerInteraction: 'not_home_partial_access',
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('Not recorded for this visit.');
    expect(screen.getByText('79 °F')).toBeInTheDocument();
    expect(screen.getByText(/Not home — partial access/)).toBeInTheDocument();
  });

  it('keeps a recorded application area when the app has no zones', () => {
    const app = { ...BASE_DATA.applications[0], zone_ids: [], applicationArea: 'Attic and soffit line' };
    render(<ServiceReportDocument data={{ ...BASE_DATA, applications: [app] }} token="tok123" />);
    expect(screen.getByText('Attic and soffit line')).toBeInTheDocument();
  });

  it('records serviced areas with reasons, and never the internal description', () => {
    const data = {
      ...BASE_DATA,
      coverageServiceType: 'pest_control',
      serviceCoverage: {
        enabled: true,
        items: [
          { id: 'z1', markerLabel: 'A', areaName: 'Front perimeter', status: 'completed', customerDescription: 'Exterior perimeter service completed.', internalDescription: 'perimeter dbl-rate' },
          { id: 'z2', markerLabel: 'B', areaName: 'Garage', status: 'inaccessible', customerDescription: '', skippedReason: 'vehicle parked inside' },
        ],
        summary: { completedCount: 1, inaccessibleCount: 1 },
      },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText('Areas serviced')).toBeInTheDocument();
    // "A — Front perimeter:" is the coverage row (the bare zone name also
    // appears in the products table, hence the marker-qualified match)
    expect(screen.getByText(/A — Front perimeter/)).toBeInTheDocument();
    expect(screen.getByText(/Exterior perimeter service completed/)).toBeInTheDocument();
    expect(screen.getByText(/Could not access: vehicle parked inside/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('perimeter dbl-rate');
  });

  it('honours the Pest Pressure visibility flags the PDF cache key is hashed on', () => {
    const pressure = { enabled: true, showOnCustomerReport: true, label: 'Very Low', displayScore: '0.9', maxScore: 5 };
    render(<ServiceReportDocument data={{ ...BASE_DATA, pestPressure: pressure }} token="t" />);
    expect(screen.getByText(/Very Low/)).toBeInTheDocument();
    cleanup();

    const hidden = render(<ServiceReportDocument data={{ ...BASE_DATA, pestPressure: { ...pressure, showOnCustomerReport: false } }} token="t" />);
    expect(hidden.container.textContent).not.toMatch(/Pest Pressure/);
    cleanup();

    const off = render(<ServiceReportDocument data={{ ...BASE_DATA, pestPressure: { ...pressure, enabled: false } }} token="t" />);
    expect(off.container.textContent).not.toMatch(/Pest Pressure/);
  });

  it('carries the next appointment and the WaveGuard re-service benefit', () => {
    const data = { ...BASE_DATA, nextAppointment: { scheduledDate: '2026-09-01T00:00:00.000Z', serviceType: 'Quarterly Pest Control' }, waveGuardTier: 'Silver' };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Next service: September 1, 2026/);
    expect(container.textContent).toMatch(/WaveGuard members receive free re-service/);
  });

  it('drops a treatment map that fails to load instead of printing an empty claim', () => {
    const data = { ...BASE_DATA, applications: [], treatmentMap: { traced: { snapshotUrl: 'https://cdn.example.com/dead.png' } } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    const img = container.querySelector('img[src="https://cdn.example.com/dead.png"]');
    expect(img).toBeTruthy();
    fireEvent.error(img);
    expect(container.querySelector('img[src="https://cdn.example.com/dead.png"]')).toBeNull();
    expect(container.textContent).not.toContain('Where we treated');
  });

  it('reads primaryMove from the builders\' real fields (title/why/impact/dueLabel)', () => {
    // buildPrimaryMove returns exactly these keys in pest-report-v2.js and
    // mosquito-report-v2.js — a customerText/text lookup silently yields null.
    const data = {
      ...BASE_DATA,
      pestReportV2: { primaryMove: { title: 'Clear the mulch bed', why: 'It holds moisture against the slab.', impact: 'Cuts ant harborage.', dueLabel: 'Before next service' } },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Clear the mulch bed/);
    expect(container.textContent).toMatch(/Before next service/);
  });

  it('renders V2 defense / habitat items', () => {
    const defense = { summary: 'Your property is in a strong position after this visit.', items: [
      { key: 'perimeter_shield', label: 'Perimeter shield', status: 'active', detail: 'Exterior protection was applied today.' },
    ] };
    render(<ServiceReportDocument data={{ ...BASE_DATA, pestReportV2: { defense } }} token="t" />);
    expect(screen.getByText(/strong position after this visit/)).toBeInTheDocument();
    expect(screen.getByText(/Exterior protection was applied today/)).toBeInTheDocument();
    cleanup();
    // mosquito stores the same shape under `habitat`
    const hab = render(<ServiceReportDocument data={{ ...BASE_DATA, mosquitoReportV2: { habitat: defense } }} token="t" />);
    expect(hab.container.textContent).toMatch(/Perimeter shield/);
  });

  it('does not claim treated areas when the only application is a station check', () => {
    // treatment-map.js isRenderableApplication excludes method 'station_check'
    const data = {
      ...BASE_DATA,
      mapSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      applications: [{ id: 'a1', method: 'station_check', product: { name: 'Snap trap' } }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('Where we treated');
  });

  it('keeps the legacy lawn assessment result when reportV2 is absent', () => {
    const data = {
      ...BASE_DATA,
      lawnAssessment: {
        scores: { overallScore: 86, turfDensity: 90, colorHealth: 80, weedSuppression: 95, stressDamage: 75 },
        recommendations: { summary: 'Lawn is performing very well for peak season.' },
        observations: '',
      },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/86\/100/);
    expect(container.textContent).toMatch(/Turf density 90/);
    expect(screen.getByText(/performing very well for peak season/)).toBeInTheDocument();
  });

  it('keeps a pest V2 customer concern, not just the top-level card', () => {
    const data = { ...BASE_DATA, pestReportV2: { customerConcern: { customerConcern: 'Ants by the dishwasher again.', acknowledgement: 'We treated that run and placed bait.' } } };
    render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText(/Ants by the dishwasher again/)).toBeInTheDocument();
    expect(screen.getByText(/We treated that run and placed bait/)).toBeInTheDocument();
  });

  it('hides an N/A EPA number and keeps lawn applications scoped to the lawn', () => {
    const data = {
      ...BASE_DATA,
      serviceLine: 'lawn',
      zones: [{ id: 'z1', label: 'Front yard' }, { id: 'z2', label: 'Back yard' }],
      applications: [{ id: 'a1', product: { name: 'LESCO 0-0-26', epa_reg: 'N/A' }, zone_ids: ['z1', 'z2'] }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('N/A');
    expect(screen.getByText('Your whole lawn')).toBeInTheDocument();
  });

  it('does not claim treated areas when applications carry no zone ids', () => {
    // treatment-map.js:184 requires isRenderableApplication AND zoneIds.length
    const data = {
      ...BASE_DATA,
      mapSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      applications: [{ id: 'a1', method: 'perimeter_spray', zone_ids: [], applicationArea: 'Side yard', product: { name: 'X' } }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('Where we treated');
  });

  it('renders tree/shrub assessment photos and the V2 customer next step', () => {
    const data = {
      ...BASE_DATA,
      photos: [],
      reportV2: {
        snapshot: { statusHeadline: 'Shrubs holding steady', customerAction: 'Move the sprinkler head off the hedge line.' },
        insights: [{ headline: 'Leaf spot watch', whatWeSaw: 'Spotting on the viburnum.', customerAction: 'Avoid overhead watering.' }],
        photos: [{ id: 'ts1', url: 'https://cdn.example.com/shrub.jpg', caption: 'Viburnum leaf spot' }],
      },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.querySelector('img[src="https://cdn.example.com/shrub.jpg"]')).toBeTruthy();
    expect(container.textContent).toMatch(/Move the sprinkler head off the hedge line/);
    expect(container.textContent).toMatch(/Avoid overhead watering/);
  });

  it('substitutes the week\'s rain on LAWN reports only', () => {
    const water = { water: { rainInches: 2.43 } };
    const lawn = render(<ServiceReportDocument data={{ ...BASE_DATA, serviceLine: 'lawn', reportV2: water, conditions: { rain_24h_in: 0 } }} token="t" />);
    expect(screen.getByText('Rain this week')).toBeInTheDocument();
    expect(lawn.container.textContent).toMatch(/2\.43 in/);
    cleanup();

    // tree & shrub shares the reportV2 slot and also has water.rainInches —
    // it must keep the visit's recorded 24-hour reading
    const ts = render(<ServiceReportDocument data={{ ...BASE_DATA, serviceLine: 'tree_shrub', reportV2: water, conditions: { rain_24h_in: 0.12 } }} token="t" />);
    expect(ts.container.textContent).not.toContain('Rain this week');
    expect(ts.container.textContent).toMatch(/0\.12 in/);
  });

  it('prefers the reconciled V2 result over contradictory legacy summary copy', () => {
    const data = {
      ...BASE_DATA,
      typedReport: null,
      summary: 'No notable issues were found today.',
      reportV2: { todaysResult: 'Routine service completed, and a follow-up is already planned.', insights: [{ headline: 'Fungus watch', whatWeSaw: 'Early thinning.' }] },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/a follow-up is already planned/);
    expect(container.textContent).not.toContain('No notable issues were found today.');
  });

  it('keeps a promised follow-up and the next-service arrival window', () => {
    const data = {
      ...BASE_DATA,
      reportV2: { followUp: { headline: 'Follow-up already planned', reason: 'We will recheck the flagged areas.', customerAction: 'No action needed before then.' } },
      nextAppointment: { scheduledDate: '2026-09-01T00:00:00.000Z', windowStart: '09:00:00', serviceType: 'Lawn Care' },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText('Follow-up already planned')).toBeInTheDocument();
    expect(screen.getByText(/We will recheck the flagged areas/)).toBeInTheDocument();
    expect(container.textContent).toMatch(/9:00 AM–11:00 AM/);
  });

  it('keeps the typed cross-visit history', () => {
    const data = {
      ...BASE_DATA,
      typedVisitTimeline: {
        label: 'Rodent Activity',
        visits: [
          { serviceRecordId: 'v1', serviceDate: '2026-07-27T00:00:00.000Z', headline: 'Rodent activity was moderate', isCurrent: false },
          { serviceRecordId: 'v2', serviceDate: '2026-08-02T00:00:00.000Z', headline: 'Activity trending down', isCurrent: true },
        ],
      },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText(/Rodent Activity — visit history/)).toBeInTheDocument();
    expect(container.textContent).toMatch(/July 27, 2026/);
    expect(container.textContent).toMatch(/August 2, 2026 \(today\)/);
  });

  it('links to the environment that rendered the PDF, not always production', () => {
    const { container } = render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    // jsdom origin is localhost — a preview-rendered PDF must not hardcode prod
    expect(container.textContent).toContain(`${window.location.origin}/report/tok123`);
  });

  it('always points to the interactive report, which carries what the record omits', () => {
    // Scope ruling A (record of service): the richer V2 analysis lives online,
    // so the link out is load-bearing and must render on every document.
    const { container } = render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    expect(container.textContent).toContain('Full interactive report');
    expect(container.textContent).toContain(`${window.location.origin}/report/tok123`);
  });

  it('hides the conditions readings when the visit recorded none', () => {
    render(<ServiceReportDocument data={{ ...BASE_DATA, conditions: {} }} token="tok123" />);
    expect(screen.getByText('Not recorded for this visit.')).toBeInTheDocument();
  });
});
