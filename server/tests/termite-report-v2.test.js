// Unit tests for the Termite Report V2 aggregator (bait-station protection
// dashboard). Asserts the trust-critical behavior: absence claims stay scoped
// to the stations inspected today, activity never renders as "protected",
// "serviced today" is claimed only on documented station work, the builder is
// null for non-bait typed types, and the PDF signature is empty when the gate
// is off or the line does not apply. Synthetic payloads only (no customer PII).

const {
  buildTermiteReportV2,
  termiteReportV2PdfSignature,
  resolveTermiteStatus,
  buildStationNetwork,
  buildTodaysResultCopy,
  buildTodaysMetrics,
  buildPrimaryMove,
} = require('../services/service-report/termite-report-v2');

const CLEAN_VALUES = {
  total_stations: 12,
  stations_checked: 12,
  stations_with_activity: 0,
  stations_inaccessible: 0,
  termite_activity: 'None observed',
  bait_consumption: 'None — bait intact',
};

describe('resolveTermiteStatus — honest status ladder', () => {
  it('clean full inspection → protected (good)', () => {
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: 'None — bait intact', checked: 12, inaccessible: 0 }))
      .toEqual({ key: 'protected', tone: 'good' });
  });

  it('active termites → action, rendered as watch (bait engaged is the system working), never good', () => {
    const out = resolveTermiteStatus({ termiteActivity: 'Active termites present', baitConsumption: 'Heavy feeding', checked: 12, inaccessible: 0 });
    expect(out).toEqual({ key: 'action', tone: 'watch' });
  });

  it('previous feeding → evidence; feeding alone → monitoring', () => {
    expect(resolveTermiteStatus({ termiteActivity: 'Previous feeding noted', baitConsumption: null, checked: 12, inaccessible: 0 }).key).toBe('evidence');
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: 'Light feeding', checked: 12, inaccessible: 0 }).key).toBe('monitoring');
  });

  it('never claims protection without an inspected count', () => {
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: null, checked: 0, inaccessible: 0 }))
      .toEqual({ key: 'monitoring', tone: 'watch' });
    expect(resolveTermiteStatus({ termiteActivity: null, baitConsumption: null, checked: null, inaccessible: 0 }).key).toBe('monitoring');
  });
});

describe('buildTodaysResultCopy — absence claims scoped to stations inspected', () => {
  it('clean full inspection names the count and scopes the claim to stations inspected', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'protected', checked: 12, total: 12, activityCount: 0, servicedToday: false, inaccessible: 0 });
    expect(copy.headline).toBe('No termite activity observed');
    expect(copy.body).toMatch(/all 12 bait stations/);
    expect(copy.body).toMatch(/at the stations inspected/);
    expect(copy.body).not.toMatch(/termite[- ]free|no termites/i);
  });

  it('partial access leads with "N of M inspected" and promises the re-check', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'protected', checked: 10, total: 12, activityCount: 0, servicedToday: false, inaccessible: 2 });
    expect(copy.headline).toBe('10 of 12 stations inspected');
    expect(copy.body).toMatch(/10 stations we were able to inspect/);
    expect(copy.body).toMatch(/2 stations could not be accessed today and will be checked next visit/);
  });

  it('activity: says where; servicing is VISIT-scoped, never attributed to the activity stations', () => {
    // Pins are activity OR serviced — the copy counts serviced stations, it
    // never says the active stations themselves were serviced.
    const serviced = buildTodaysResultCopy({ statusKey: 'action', checked: 12, total: 12, activityCount: 2, servicedCount: 3, servicedToday: true, inaccessible: 0, activeLocation: 'Stations 6 and 10 on the north side' });
    expect(serviced.headline).toBe('Termite activity observed at 2 stations');
    expect(serviced.body).toMatch(/Stations 6 and 10 on the north side/);
    expect(serviced.body).toMatch(/Bait was serviced at 3 stations today/);
    expect(serviced.body).not.toMatch(/Both stations were serviced/);

    const formOnly = buildTodaysResultCopy({ statusKey: 'action', checked: 12, total: 12, activityCount: 1, servicedCount: 0, servicedToday: true, inaccessible: 0 });
    expect(formOnly.body).toMatch(/Bait service was performed today/);

    const unserviced = buildTodaysResultCopy({ statusKey: 'action', checked: 12, total: 12, activityCount: 1, servicedToday: false, inaccessible: 0 });
    expect(unserviced.headline).toBe('Termite activity observed at 1 station');
    expect(unserviced.body).toMatch(/1 of the 12 stations inspected/);
    expect(unserviced.body).not.toMatch(/serviced/);
    expect(unserviced.body).toMatch(/monitored closely/);
  });

  it('activity without a documented station count never invents one', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'action', checked: 12, total: 12, activityCount: null, inaccessible: 0 });
    expect(copy.headline).toBe('Termite activity observed');
    expect(copy.body).toMatch(/observed at the stations inspected today/);
    expect(copy.body).not.toMatch(/1 station/);
  });

  it('evidence (previous feeding) never escalates to an active-termites claim', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'evidence', checked: 8, total: 8, activityCount: 1, servicedToday: false, inaccessible: 0 });
    expect(copy.headline).toMatch(/^Evidence of termite activity/);
    expect(copy.body).not.toMatch(/Active termites/);
  });

  it('no inspected count → neutral monitoring copy', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'monitoring', checked: null });
    expect(copy.headline).toBe('Bait stations being monitored');
  });
});

describe('buildTodaysMetrics', () => {
  it('renders inspected / activity / serviced from documented counts', () => {
    expect(buildTodaysMetrics({ checked: 10, total: 12, activityCount: 2, servicedCount: 3 })).toEqual([
      { label: 'Stations inspected', value: '10 of 12' },
      { label: 'Termite activity', value: '2 stations' },
      { label: 'Stations serviced', value: '3' },
    ]);
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: 0, servicedCount: 0 })[1].value).toBe('None observed');
    // Activity recorded with no count: "Observed", never "None observed"
    // under a headline that says otherwise.
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: null, activityObserved: true, servicedCount: 0 })[1].value).toBe('Observed');
    expect(buildTodaysMetrics({ checked: null })).toBeNull();
  });
});

describe('buildStationNetwork — station-map summary wins over typed counts', () => {
  it('uses the station-map summary when present', () => {
    const net = buildStationNetwork({
      values: { ...CLEAN_VALUES, stations_checked: 3 },
      stationSummary: { total: 14, checked: 12, activity: 2, serviced: 2, inaccessible: 2 },
    });
    expect(net.counts).toEqual({ total: 14, checked: 12, activity: 2, inaccessible: 2 });
    expect(net.items.map((i) => i.key)).toEqual(['inspected', 'activity', 'bait', 'access']);
    expect(net.summary).toBe('Your protective ring: 12 inspected · 2 with activity · 2 inaccessible.');
  });

  it('falls back to the typed counts and returns null without an inspected count', () => {
    const net = buildStationNetwork({ values: CLEAN_VALUES });
    expect(net.counts.checked).toBe(12);
    expect(net.counts.activity).toBe(0);
    expect(net.items.map((i) => i.key)).toEqual(['inspected', 'bait']);
    // No count on the form and no map → null, not 0 (the copy distinguishes).
    expect(buildStationNetwork({ values: { stations_checked: 8 } }).counts.activity).toBeNull();
    expect(net.items[1].status).toBe('clear');
    expect(buildStationNetwork({ values: {} })).toBeNull();
  });
});

describe('buildPrimaryMove — first chip wins', () => {
  it('recommendation leads, conducive condition explains', () => {
    const move = buildPrimaryMove({ values: { customer_recommendations: 'Keep mulch 6 inches from the foundation, Fix the hose bib leak', conducive_conditions: 'Mulch against foundation' } });
    expect(move.title).toBe('Keep mulch 6 inches from the foundation');
    expect(move.why).toMatch(/mulch against foundation/);
    expect(move.dueLabel).toBe('Before your next visit');
  });

  it('conducive condition alone → generic reduce-conditions move; nothing → null', () => {
    expect(buildPrimaryMove({ values: { conducive_conditions: 'Wood-to-soil contact' } }).title).toBe('Reduce conditions termites love');
    expect(buildPrimaryMove({ values: {} })).toBeNull();
  });
});

describe('buildTermiteReportV2 — assembly and guards', () => {
  it('returns null for any typed type other than termite_bait_station', () => {
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_liquid' })).toBeNull();
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: null })).toBeNull();
  });

  it('returns null when there is nothing meaningful to show', () => {
    expect(buildTermiteReportV2({ typedSnapshotValues: {}, typedReportType: 'termite_bait_station' })).toBeNull();
  });

  it('clean visit assembles a good-tone hero with three metrics and no serviced claim', () => {
    const out = buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', visitSequence: 3 });
    expect(out.status).toEqual({ key: 'protected', tone: 'good', label: 'No termite activity observed' });
    expect(out.metrics).toHaveLength(3);
    expect(out.statusSummary).not.toMatch(/serviced/);
    expect(out.visitSequence).toBe(3);
    expect(out.nextStep).toBeNull();
    expect(out.nextVisit).toBeNull();
    expect(out.defense.items[0]).toMatchObject({ key: 'inspected', status: 'clear' });
    expect(out.primaryMove).toBeNull();
  });

  it('activity visit: serviced-today rides documented pins or typed bait actions only', () => {
    const values = { ...CLEAN_VALUES, termite_activity: 'Active termites present', bait_consumption: 'Moderate feeding', stations_with_activity: 2 };
    const fromPins = buildTermiteReportV2({
      typedSnapshotValues: values,
      typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 2, serviced: 2, inaccessible: 0 },
    });
    expect(fromPins.status.key).toBe('action');
    expect(fromPins.status.tone).toBe('watch');
    expect(fromPins.statusSummary).toMatch(/Bait was serviced at 2 stations today/);
    expect(fromPins.metrics[2]).toEqual({ label: 'Stations serviced', value: '2' });

    const fromForm = buildTermiteReportV2({ typedSnapshotValues: { ...values, bait_actions: 'Bait replaced' }, typedReportType: 'termite_bait_station' });
    expect(fromForm.statusSummary).toMatch(/Bait service was performed today/);

    const undocumented = buildTermiteReportV2({ typedSnapshotValues: values, typedReportType: 'termite_bait_station' });
    expect(undocumented.statusSummary).not.toMatch(/serviced/);
  });

  it('activity recorded without a station count → "observed" headline and metric, no invented count', () => {
    const out = buildTermiteReportV2({
      typedSnapshotValues: { stations_checked: 10, termite_activity: 'Previous feeding noted', bait_consumption: 'Light feeding' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status.key).toBe('evidence');
    expect(out.status.label).toBe('Evidence of termite activity observed');
    expect(out.metrics[1]).toEqual({ label: 'Termite activity', value: 'Observed' });
    expect(out.defense.items.map((i) => i.key)).toEqual(['inspected', 'bait']);
  });

  it('carries the required next step and only a same-line next visit', () => {
    const out = buildTermiteReportV2({
      typedSnapshotValues: CLEAN_VALUES,
      typedReportType: 'termite_bait_station',
      nextStep: '  Recheck active station sooner.  ',
      nextVisit: { scheduledDate: '2026-11-16', windowStart: '09:00', serviceType: 'Termite Bait Station Service' },
    });
    expect(out.nextStep).toBe('Recheck active station sooner.');
    expect(out.nextVisit).toEqual({ scheduledDate: '2026-11-16', windowStart: '09:00', serviceType: 'Termite Bait Station Service' });
    const none = buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', nextStep: '', nextVisit: { serviceType: 'x' } });
    expect(none.nextStep).toBeNull();
    expect(none.nextVisit).toBeNull();
  });

  it('passes the technician report through as aiSummary', () => {
    const out = buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', technicianReport: 'Reviewed copy.' });
    expect(out.aiSummary).toBe('Reviewed copy.');
  });
});

describe('termiteReportV2PdfSignature — PDF cache-key component', () => {
  const original = process.env.TERMITE_REPORT_V2;
  afterEach(() => {
    if (original === undefined) delete process.env.TERMITE_REPORT_V2;
    else process.env.TERMITE_REPORT_V2 = original;
  });
  const baitRecord = { service_type: 'Custom Termite Plan', service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: {} } }) };

  it('is empty when the gate is off', () => {
    delete process.env.TERMITE_REPORT_V2;
    expect(termiteReportV2PdfSignature(baitRecord)).toBe('');
  });

  it('keys on the frozen typed snapshot type — the same predicate as the render gate, not the service name', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    expect(termiteReportV2PdfSignature(baitRecord)).toBe('-termv2');
    // object-shaped service_data (already parsed by a caller)
    expect(termiteReportV2PdfSignature({ service_data: { typedReportSnapshot: { type: 'termite_bait_station' } } })).toBe('-termv2');
  });

  it('is empty for other typed types, records without a snapshot, and malformed service_data', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    expect(termiteReportV2PdfSignature({ service_type: 'Termite Bait Station Service', service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_liquid' } }) })).toBe('');
    expect(termiteReportV2PdfSignature({ service_type: 'Termite Bait Station Service', service_data: null })).toBe('');
    expect(termiteReportV2PdfSignature({ service_data: '{not json' })).toBe('');
    expect(termiteReportV2PdfSignature({})).toBe('');
  });
});
