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

  it('never publishes a fixed re-entry figure — duration OR computed clock time', () => {
    // AGENTS.md: no fixed re-entry/drying figure on a customer surface. A
    // readyAt clock time asserts the same thing as the duration it came from.
    const { container } = render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    expect(container.textContent).toMatch(/Interior: ready once dry/);
    expect(container.textContent).toMatch(/technician confirms timing/);
    expect(container.textContent).not.toMatch(/keep clear for/i);
    expect(container.textContent).not.toMatch(/\b\d+\s*(hours?|minutes?)\s*after treatment/i);
    expect(container.textContent).not.toMatch(/ready after \d/i);
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

  it('carries the WaveGuard benefit but never a next-appointment line', () => {
    // stripLiveOnlyScheduleFields removes nextAppointment from every non-live
    // render so a reschedule can't fossilize in a cached PDF — the document
    // must not depend on it even when a caller passes one.
    const data = { ...BASE_DATA, nextAppointment: { scheduledDate: '2026-09-01T00:00:00.000Z', serviceType: 'Quarterly Pest Control' }, waveGuardTier: 'Silver' };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/WaveGuard members receive free re-service/);
    expect(container.textContent).not.toMatch(/Next service:/);
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

  it('keeps a pest V2 customer concern, using buildCustomerConcernCard\'s real shape', () => {
    // { headline, concern, body, nextStep } — pest-report-v2.js:148-157.
    const card = {
      headline: 'What you flagged',
      concern: 'Ants by the dishwasher again.',
      body: 'You reported this during your visit.',
      nextStep: 'Text us if it changes.',
    };
    render(<ServiceReportDocument data={{ ...BASE_DATA, pestReportV2: { customerConcern: card } }} token="t" />);
    expect(screen.getByText('What you flagged')).toBeInTheDocument();
    expect(screen.getByText(/Ants by the dishwasher again/)).toBeInTheDocument();
    expect(screen.getByText(/You reported this during your visit/)).toBeInTheDocument();
    cleanup();
    // and the non-V2 fallback card uses the same builder
    const top = render(<ServiceReportDocument data={{ ...BASE_DATA, customerConcernCard: card }} token="t" />);
    expect(top.container.textContent).toMatch(/Ants by the dishwasher again/);
  });

  it('does not print default treatment precautions on an untreated visit', () => {
    // data.advisory carries service-line DEFAULTS even when nothing was applied
    const data = { ...BASE_DATA, applications: [], dynamicContext: {}, advisory: { pet_advisory: 'Keep pets off treated zones until dry.' } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('Keep pets off treated zones until dry.');
    expect(container.textContent).not.toContain('Re-entry & precautions');
  });

  it('resolves legacy contact dispositions and cleans legacy summaries', () => {
    const data = {
      ...BASE_DATA,
      typedReport: null,
      customerInteraction: 'spoke',
      summary: 'Thanks for having us out today. We focused on the perimeter. You should see activity ease over the next 1-2 weeks, and - Waves',
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(screen.getByText('Spoke with someone at the home')).toBeInTheDocument();
    expect(container.textContent).not.toContain(', and - Waves');
    expect(container.textContent).not.toContain('should see activity ease');
  });

  it("keeps a bug file's recorded location", () => {
    const data = { ...BASE_DATA, pestReportV2: { bugFiles: [{ pestKey: 'ghost_ant', suspectLabel: 'Ghost ant', whereSeen: 'the kitchen sink cabinet', whyItMatters: 'They trail to moisture.' }] } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Seen at the kitchen sink cabinet/);
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
    // NO next-service line: stripLiveOnlyScheduleFields deletes nextAppointment
    // from every non-live render, so rendering it would be dead code that only
    // ever appears in a test like this one.
    expect(container.textContent).not.toMatch(/Next service:/);
  });

  it('filters raw-note findings by provenance, not by category', () => {
    // admin-dispatch.js rewrites the category to 'conducive_condition' when a
    // raw note contains "concern", so a category-only filter is bypassed.
    // Raw-note rows are title-only (detail/recommendation null).
    const data = {
      ...BASE_DATA,
      findings: [
        { id: 'observation-1', category: 'observation', severity: 'medium', title: 'Gate code 4417, bill the office', detail: '', recommendation: '' },
        { id: 'observation-2', category: 'conducive_condition', severity: 'medium', title: 'Owner concern: lockbox code is 9902', detail: null, recommendation: null },
        { id: 'f3', category: 'pest_activity', severity: 'high', title: 'Ant trail at the slider', detail: 'Treated and monitored.' },
      ],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('Gate code');
    expect(container.textContent).not.toContain('lockbox');
    expect(container.textContent).not.toContain('9902');
    expect(container.textContent).toMatch(/Ant trail at the slider/);
  });

  it('does not print default lawn aftercare on an untreated visit', () => {
    // buildAftercare([]) still returns treatment-worded copy with no applications
    const aftercare = { watering: 'No special watering is needed because of today\u2019s treatment.', reentry: 'Water in per the visit notes.' };
    const data = { ...BASE_DATA, serviceLine: 'lawn', applications: [], dynamicContext: {}, reportV2: { aftercare } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('because of today');
    expect(container.textContent).not.toContain('Water in per the visit notes');
  });

  it('keeps a proof moment\'s tag and location alongside its caption', () => {
    const data = {
      ...BASE_DATA,
      photos: [],
      proofMoments: [{ id: 'm1', mediaUrl: 'https://cdn.example.com/seal.jpg', mediaType: 'image', tagLabel: 'Entry point sealed', locationArea: 'Garage soffit', customerCaption: 'Sealed with copper mesh and sealant.' }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Entry point sealed/);
    expect(container.textContent).toMatch(/Garage soffit/);
    expect(container.textContent).toMatch(/copper mesh/);
  });

  it('does not mount an empty findings section for a photo-only mowing record', () => {
    // buildMowingHeightContext returns a truthy object with heightIn: null
    const data = { ...BASE_DATA, typedReport: null, activity: null, serviceLine: 'lawn', mowingHeight: { heightIn: null, photoUrl: 'https://cdn.example.com/g.jpg' } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('What we found');
  });

  it('uses program-specific station outcome wording and the serviced state', () => {
    const data = {
      ...BASE_DATA,
      stationMap: {
        available: true,
        program: 'trapping',
        stations: [{ id: 's1', number: 1, cx: 0.4, cy: 0.5, status: 'serviced' }],
        summary: { total: 1, checked: 1, serviced: 1, activity: 1, inaccessible: 0 },
      },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/1 serviced this visit/);
    expect(container.textContent).toMatch(/1 with captures recorded/);
    expect(container.textContent).not.toMatch(/with activity/);
    expect(container.querySelector('.doc-station-pin.is-serviced')).toBeTruthy();
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

  it('does not stack legacy assessment recommendations on top of the V2 ones', () => {
    const legacyRec = 'Maintain mowing at approximately 3.5-4 inches.';
    const data = {
      ...BASE_DATA,
      serviceLine: 'lawn',
      lawnAssessment: { recommendations: { recommendations: [{ priority: 1, action: legacyRec }] } },
      reportV2: { mowing: { recommendation: 'The lawn is being kept at 3.5 inches — stay in that range.' } },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/stay in that range/);
    expect(container.textContent).not.toContain(legacyRec);
    cleanup();

    // ...but a legacy report with no V2 still shows them
    const legacy = render(<ServiceReportDocument data={{ ...data, reportV2: null }} token="t" />);
    expect(legacy.container.textContent).toContain(legacyRec);
  });

  it('keeps aftercare for a legacy application that has no zone ids', () => {
    // "did treatment happen" must not inherit the map predicate's zone-id rule
    const data = {
      ...BASE_DATA,
      serviceLine: 'lawn',
      dynamicContext: {},
      applications: [{ id: 'a1', method: 'broadcast_spray', zone_ids: [], applicationArea: 'Front lawn', product: { name: 'LESCO' } }],
      advisory: { pet_advisory: 'Keep pets off treated turf until dry.' },
      reportV2: { aftercare: { watering: 'Water in lightly tomorrow.', reentry: 'No re-entry wait once dry.' } },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toContain('Keep pets off treated turf until dry.');
    expect(container.textContent).toContain('Water in lightly tomorrow.');
    expect(container.textContent).toContain('No re-entry wait once dry.');
    // ...but the schematic still needs zone ids, so no treatment-map claim
    expect(container.textContent).not.toContain('Where we treated');
  });

  it('does not list a station check under products applied', () => {
    const data = {
      ...BASE_DATA,
      applications: [{ id: 'a1', method: 'station_check', totalAmount: '1', amountUnit: 'ea', product: { name: 'Victor Snap Trap' } }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toContain('Products applied');
    expect(container.textContent).not.toContain('Victor Snap Trap');
  });

  it('renders a structured finding\'s recommendation', () => {
    const data = { ...BASE_DATA, findings: [{ id: 'f1', category: 'conducive_condition', title: 'Mulch against the slab', detail: '', recommendation: 'Pull the mulch back six inches from the foundation.' }] };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Pull the mulch back six inches/);
  });

  it('keeps a companion service\'s next step', () => {
    const data = {
      ...BASE_DATA,
      companionReports: [{ type: 'mosquito', reportTypeLabel: 'Mosquito Service', todaysResult: { headline: 'Pressure was light', body: 'We treated the resting areas.', nextStep: 'Empty the bird bath weekly.' }, findings: [] }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Empty the bird bath weekly/);
  });

  it('does not republish a suppressed lawn caption through alt text', () => {
    const rawBlurb = 'Possible take-all root rot with severe decline visible';
    const data = {
      ...BASE_DATA,
      reportV2: { photoSummary: 'Turf is dense across the yard.' },
      photos: [{ id: 'lawn-9', url: 'https://cdn.example.com/lawn.jpg', caption: rawBlurb }],
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    const img = container.querySelector('img[src="https://cdn.example.com/lawn.jpg"]');
    expect(img).toBeTruthy();
    expect(img.getAttribute('alt')).not.toContain('root rot');
    expect(container.innerHTML).not.toContain(rawBlurb);
  });

  it('marks a target-derived pest card as not observed this visit', () => {
    const data = {
      ...BASE_DATA,
      pestReportV2: { bugFiles: [
        { pestKey: 'ghost_ant', suspectLabel: 'Ghost ant', confirmedByTech: false, whyItMatters: 'Common in this area.' },
        { pestKey: 'german_roach', suspectLabel: 'German roach', confirmedByTech: true, whereSeen: 'the pantry', whyItMatters: 'Tied to moisture.' },
      ] },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Ghost ant \(covered by today.s treatment/);
    expect(container.textContent).toMatch(/German roach:/);
    expect(container.textContent).not.toMatch(/German roach \(covered/);
  });

  it('carries the Waves-side next-visit commitment', () => {
    const data = { ...BASE_DATA, reportV2: { snapshot: { wavesNext: 'We will recheck the shaded areas at the next visit.' } } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/We will recheck the shaded areas/);
  });

  it('falls back to its own origin when no canonical origin is configured', () => {
    // a preview deployment must not bake a preview-only token into a
    // production URL — the server sends '' when nothing is configured
    const { container } = render(<ServiceReportDocument data={{ ...BASE_DATA, publicOrigin: '' }} token="tok123" />);
    expect(container.querySelector(`a[href="${window.location.origin}/report/tok123"]`)).toBeTruthy();
  });

  it('prefers the server\'s canonical public origin over the rendering host', () => {
    // prod renders open through CLIENT_URL = the raw Railway hostname
    const data = { ...BASE_DATA, publicOrigin: 'https://portal.wavespestcontrol.com' };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.querySelector('a[href="https://portal.wavespestcontrol.com/report/tok123"]')).toBeTruthy();
    expect(container.textContent).not.toContain(window.location.origin);
    cleanup();
    // preview/dev renders (no canonical origin) still link to themselves
    const preview = render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    expect(preview.container.querySelector(`a[href="${window.location.origin}/report/tok123"]`)).toBeTruthy();
  });

  it('emits the interactive report URL as a real link', () => {
    const { container } = render(<ServiceReportDocument data={BASE_DATA} token="tok123" />);
    const link = container.querySelector(`a[href="${window.location.origin}/report/tok123"]`);
    expect(link).toBeTruthy();
  });

  it('shows a checked-clear station as checked, not as on-file', () => {
    const data = {
      ...BASE_DATA,
      stationMap: { available: true, program: 'trapping', stations: [{ id: 's1', number: 1, cx: 0.3, cy: 0.4, status: 'ok' }], summary: { total: 1, checked: 1 } },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.querySelector('.doc-station-pin.is-ok')).toBeTruthy();
    expect(container.textContent).toMatch(/Checked — no capture/);
  });

  it('labels the station status colors', () => {
    const data = {
      ...BASE_DATA,
      stationMap: { available: true, program: 'rodent', stations: [{ id: 's1', number: 1, cx: 0.3, cy: 0.4, status: 'activity' }], summary: { total: 1, activity: 1 } },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).toMatch(/Bait consumption observed/);
    expect(container.textContent).toMatch(/Serviced this visit/);
    expect(container.textContent).toMatch(/Not accessible/);
  });

  it('humanizes an unlisted historical contact value instead of dropping the row', () => {
    render(<ServiceReportDocument data={{ ...BASE_DATA, customerInteraction: 'interior' }} token="t" />);
    expect(screen.getByText('Interior')).toBeInTheDocument();
  });

  it('hides a quantity that has no unit', () => {
    const app = { ...BASE_DATA.applications[0], rate: '5', rateUnit: null, totalAmount: '2', amountUnit: null };
    const { container } = render(<ServiceReportDocument data={{ ...BASE_DATA, applications: [app] }} token="t" />);
    // a bare number in a pesticide record can't be read as oz/gal/g
    expect(container.textContent).not.toMatch(/\b5\b/);
    expect(container.textContent).toContain('—');
  });

  it('sanitizes a ready-at clock time coming through the re-entry summary', () => {
    // buildReentrySummary emits "<area> ready at 7:03 PM" while the window is open
    const data = {
      ...BASE_DATA,
      dynamicContext: { reentry: { customerSummary: 'Exterior ready at 7:03 PM.', targets: [{ key: 'exterior', label: 'Exterior', durationMin: 30, readyAt: '2026-08-02T23:03:00.000Z' }] } },
    };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toMatch(/7:03 PM/);
    expect(container.textContent).not.toMatch(/ready at \d/i);
    expect(container.textContent).toMatch(/ready once dry/);
    cleanup();

    // the no-pending variant carries no time and passes through unchanged
    const done = render(<ServiceReportDocument data={{ ...BASE_DATA, dynamicContext: { reentry: { customerSummary: 'Treated areas are ready for normal use.', targets: [] } } }} token="t" />);
    expect(done.container.textContent).toMatch(/ready for normal use/);
  });

  it('sanitizes fixed timing out of label-derived re-entry copy too', () => {
    // catalog precaution/reentry text is unconstrained free text
    const app = {
      ...BASE_DATA.applications[0],
      product: { ...BASE_DATA.applications[0].product, precaution_summary: 'Keep people and pets off treated areas for about 1 hour.', reentry_summary: 'Re-enter after 45 minutes.' },
    };
    const data = { ...BASE_DATA, applications: [app], reportV2: { aftercare: { reentry: 'Safe to re-enter in 2 hours.' } } };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    expect(container.textContent).not.toMatch(/about 1 hour/i);
    expect(container.textContent).not.toMatch(/45 minutes/i);
    expect(container.textContent).not.toMatch(/in 2 hours/i);
    expect(container.textContent).toMatch(/once dry/i);
  });

  it('keeps label-required agronomic directions that carry time units', () => {
    // "irrigate within 14 days" is a real catalog reentry_text (LESCO seed) —
    // it has a time unit but makes no re-entry claim, so it must survive
    const app = {
      ...BASE_DATA.applications[0],
      product: { ...BASE_DATA.applications[0].product, reentry_summary: 'Irrigate within 14 days of application. Water in with 0.25 inches of irrigation.' },
    };
    const { container } = render(<ServiceReportDocument data={{ ...BASE_DATA, applications: [app] }} token="t" />);
    expect(container.textContent).toContain('within 14 days');
    expect(container.textContent).toContain('0.25 inches');
  });

  it('sanitizes a fixed pet restriction', () => {
    const data = { ...BASE_DATA, dynamicContext: { reentry: { petAdvisory: 'Keep pets off treated turf for 2 hours.', targets: [] } } };
    const { container } = render(<ServiceReportDocument data={data} token="t" />);
    expect(container.textContent).not.toMatch(/for 2 hours/);
    expect(container.textContent).toMatch(/once dry/i);
  });

  it('uses the legacy seven-day rainfall when V2 is absent', () => {
    const data = { ...BASE_DATA, serviceLine: 'lawn', reportV2: null, lawnAssessment: { waterContext: { rainfallInches7d: 2.43 } }, conditions: { rain_24h_in: 0 } };
    const { container } = render(<ServiceReportDocument data={data} token="t" />);
    expect(screen.getByText('Rain this week')).toBeInTheDocument();
    expect(container.textContent).toMatch(/2\.43 in/);
  });

  it('replaces a time figure only when the sentence makes a re-entry claim', () => {
    // allowlist: three rounds of widening a blocklist kept missing forms
    // ("Dry time is 2 hours", "Ready at 7 PM"), so a re-entry sentence
    // survives only when it states no quantity at all
    const cases = ['Keep clear for five hours.', 'Re-enter after ninety minutes.', 'Dry time is 2 hours.', 'Ready at 7 PM.', 'Stay off the treated area for twenty-four hours.'];
    cases.forEach((text) => {
      const app = { ...BASE_DATA.applications[0], product: { ...BASE_DATA.applications[0].product, reentry_summary: text } };
      const { container } = render(<ServiceReportDocument data={{ ...BASE_DATA, applications: [app] }} token="t" />);
      expect(container.textContent).not.toContain(text);
      expect(container.textContent).toMatch(/once dry/i);
      cleanup();
    });
  });

  it('leaves agronomic guidance alone — sanitization is scoped to re-entry fields', () => {
    // aftercare.watering and the recommendations list are never sanitized
    const data = { ...BASE_DATA, serviceLine: 'lawn', reportV2: { aftercare: { watering: 'Wait twenty-four hours before mowing, then water in within an hour.' } } };
    const { container } = render(<ServiceReportDocument data={data} token="t" />);
    expect(container.textContent).toContain('before mowing');
    expect(container.textContent).toContain('within an hour');
  });

  it('keeps the quantity-free sentences when it replaces one', () => {
    const mixed = 'Keep people and pets off treated areas for about 1 hour. Leave placements undisturbed.';
    const app = { ...BASE_DATA.applications[0], product: { ...BASE_DATA.applications[0].product, reentry_summary: mixed } };
    const { container } = render(<ServiceReportDocument data={{ ...BASE_DATA, applications: [app] }} token="t" />);
    expect(container.textContent).not.toContain('about 1 hour');
    expect(container.textContent).toContain('Leave placements undisturbed');
    expect(container.textContent).toMatch(/once dry/i);
  });

  it('shows an explicit unavailable note for a failed image, never a silent omission', () => {
    const data = { ...BASE_DATA, photos: [{ id: 'p1', url: 'https://cdn.example.com/dead.jpg', caption: 'Entry point' }] };
    const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
    fireEvent.error(container.querySelector('img[src="https://cdn.example.com/dead.jpg"]'));
    // the frame stays and says so — an omission nobody can see is worse in a
    // permanent record, and blocking the render risks denying the report
    expect(container.textContent).toMatch(/Photo unavailable in this document/);
    expect(container.querySelector('[data-render-incomplete]')).toBeNull();
  });

  it('keeps label copy that asserts no timing', () => {
    const app = {
      ...BASE_DATA.applications[0],
      product: { ...BASE_DATA.applications[0].product, precaution_summary: 'Keep people and pets off treated areas until sprays have dried.' },
    };
    const { container } = render(<ServiceReportDocument data={{ ...BASE_DATA, applications: [app] }} token="t" />);
    expect(container.textContent).toMatch(/until sprays have dried/);
  });

  it('hides the conditions readings when the visit recorded none', () => {
    render(<ServiceReportDocument data={{ ...BASE_DATA, conditions: {} }} token="tok123" />);
    expect(screen.getByText('Not recorded for this visit.')).toBeInTheDocument();
  });
});
