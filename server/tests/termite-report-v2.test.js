// Unit tests for the Termite Report V2 aggregator (bait-station protection
// dashboard). Asserts the trust-critical behavior: absence claims stay scoped
// to the stations inspected today, activity never renders as "protected",
// "serviced today" is claimed only on documented station work, the builder is
// null for non-bait typed types, and the PDF signature is empty when the gate
// is off or the line does not apply. Synthetic payloads only (no customer PII).

const {
  buildTermiteReportV2,
  termiteReportV2PdfSignature,
  isTermiteBaitServiceName,
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

describe('isTermiteBaitServiceName — next-visit predicate (bait-station appointments only)', () => {
  it('accepts bait / station / monitoring termite names', () => {
    expect(isTermiteBaitServiceName('Termite Bait Station Service')).toBe(true);
    expect(isTermiteBaitServiceName('Termite Monitoring (Quarterly)')).toBe(true);
    expect(isTermiteBaitServiceName('Termite Bait Cartridge Replacement')).toBe(true);
  });

  it('rejects liquid / trench / inspection termite work and other lines', () => {
    expect(isTermiteBaitServiceName('Termite Liquid Treatment')).toBe(false);
    expect(isTermiteBaitServiceName('Termite Trenching')).toBe(false);
    expect(isTermiteBaitServiceName('Termite Inspection')).toBe(false);
    expect(isTermiteBaitServiceName('Rodent Bait Station Service')).toBe(false);
    expect(isTermiteBaitServiceName(null)).toBe(false);
  });
});

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
    expect(copy.body).toMatch(/all 12 bait stations around the property/);
    expect(copy.body).toMatch(/at the stations inspected/);
    expect(copy.body).not.toMatch(/termite[- ]free|no termites|your home/i);
  });

  it('a checked count with no documented total never claims "all"', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'protected', checked: 12, total: null, activityCount: 0, inaccessible: 0 });
    expect(copy.headline).toBe('No termite activity observed');
    expect(copy.body).toMatch(/We inspected 12 bait stations around the property/);
    expect(copy.body).not.toMatch(/all 12/);
    expect(buildTodaysMetrics({ checked: 12, total: null, activityCount: 0, servicedCount: 0 })[0].value).toBe('12');
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: 0, servicedCount: 0 })[0].value).toBe('12 of 12');
  });

  it('a recorded total above the checked count (no inaccessible count) is partial coverage, never "all"', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'protected', checked: 10, total: 12, activityCount: 0, inaccessible: 0 });
    expect(copy.headline).toBe('10 of 12 stations inspected');
    expect(copy.body).toMatch(/in the 10 stations we inspected today/);
    expect(copy.body).not.toMatch(/all 10/);
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

  it('evidence (previous feeding) never escalates to an active-termites claim — headline or continuation', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'evidence', checked: 8, total: 8, activityCount: 1, servicedToday: false, inaccessible: 0 });
    expect(copy.headline).toMatch(/^Evidence of termite activity/);
    expect(copy.body).not.toMatch(/Active termites/);
    const serviced = buildTodaysResultCopy({ statusKey: 'evidence', checked: 8, total: 8, activityCount: 1, servicedCount: 1, servicedToday: true, inaccessible: 0 });
    expect(serviced.body).toMatch(/the affected stations will continue to be monitored/);
    expect(serviced.body).not.toMatch(/active stations/);
  });

  it('monitoring with feeding recorded keeps the feeding evidence out of a clean headline', () => {
    // Legacy snapshot: "None observed" beside positive bait consumption →
    // resolveTermiteStatus returns 'monitoring'; the copy must not say
    // "No termite activity observed" while the station card says feeding.
    const copy = buildTodaysResultCopy({ statusKey: 'monitoring', checked: 12, total: 12, inaccessible: 0, baitFeeding: true });
    expect(copy.headline).toBe('Bait feeding noted — monitoring continues');
    expect(copy.body).toMatch(/Bait feeding was noted/);
    const noReading = buildTodaysResultCopy({ statusKey: 'monitoring', checked: 10, total: 12, inaccessible: 2 });
    expect(noReading.headline).toBe('10 of 12 stations inspected');
    expect(noReading.body).not.toMatch(/No termite activity/);
    expect(noReading.body).toMatch(/2 stations could not be accessed/);
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
    // bait condition is a hero metric (the typed card drops the field)
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: 0, servicedCount: 0, baitConsumption: 'None — bait intact' })[3]).toEqual({ label: 'Bait condition', value: 'Intact' });
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: 0, servicedCount: 0, baitConsumption: 'Heavy feeding' })[3]).toEqual({ label: 'Bait condition', value: 'Heavy feeding' });
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: 0, servicedCount: 0 })).toHaveLength(3);
    // Activity recorded with no count: "Observed", never "None observed"
    // under a headline that says otherwise.
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: null, activityObserved: true, servicedCount: 0 })[1].value).toBe('Observed');
    // Form-documented service with no serviced pins: "Performed", never "0".
    expect(buildTodaysMetrics({ checked: 12, total: 12, activityCount: 0, servicedCount: 0, servicedToday: true })[2].value).toBe('Performed');
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
    // bait intact + activity pins (live termites / mud tubing) → never "bait engaged"
    expect(net.items[1].detail).toBe('2 stations — activity observed');
    const feeding = buildStationNetwork({
      values: { ...CLEAN_VALUES, bait_consumption: 'Moderate feeding' },
      stationSummary: { total: 14, checked: 12, activity: 2, serviced: 2, inaccessible: 2 },
    });
    expect(feeding.items[1].detail).toBe('2 stations — bait engaged');
    expect(net.summary).toBe('Your protective ring: 12 inspected · 2 with activity · 2 inaccessible.');
  });

  it('ignores a registry-only map summary (no per-visit statuses) and keeps the frozen typed counts', () => {
    // Fail-soft station sync: registry pins, no check rows → the map
    // summarises 0 checked / 0 activity. That must not erase a documented
    // 12-checked / 2-active snapshot.
    const net = buildStationNetwork({
      values: { ...CLEAN_VALUES, stations_with_activity: 2, termite_activity: 'Active termites present' },
      stationSummary: { total: 14, checked: 0, activity: 0, serviced: 0, inaccessible: 0 },
    });
    expect(net.counts).toEqual({ total: 12, checked: 12, activity: 2, inaccessible: 0 });
    const out = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, stations_with_activity: 2, termite_activity: 'Active termites present' },
      typedReportType: 'termite_bait_station',
      stationSummary: { total: 14, checked: 0, activity: 0, serviced: 0, inaccessible: 0 },
    });
    expect(out.status.label).toBe('Termite activity observed at 2 stations');
    expect(out.metrics[0].value).toBe('12 of 12');
    expect(out.metrics[2].value).toBe('0');
  });

  it('partial access without a recorded total derives a safe denominator — never "all N"', () => {
    const values = { stations_checked: 10, stations_inaccessible: 2, termite_activity: 'None observed', bait_consumption: 'None — bait intact' };
    const net = buildStationNetwork({ values });
    expect(net.counts.total).toBe(12);
    expect(net.items[0].detail).toBe('10 of 12 stations');
    const out = buildTermiteReportV2({ typedSnapshotValues: values, typedReportType: 'termite_bait_station' });
    expect(out.status.label).toBe('10 of 12 stations inspected');
    expect(out.statusSummary).toMatch(/10 stations we were able to inspect/);
    expect(out.statusSummary).not.toMatch(/all 10/);
    expect(out.metrics[0].value).toBe('10 of 12');
  });

  it('an activity count above the inspected count is treated as uncounted — never "12 of the 10"', () => {
    const net = buildStationNetwork({ values: { ...CLEAN_VALUES, stations_checked: 10, stations_with_activity: 12, termite_activity: 'Active termites present' } });
    expect(net.counts.activity).toBeNull();
    const out = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, stations_checked: 10, stations_with_activity: 12, termite_activity: 'Active termites present' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status.label).toBe('Termite activity observed');
    expect(out.statusSummary).not.toMatch(/12 of the 10/);
    expect(out.metrics[1].value).toBe('Observed');
  });

  it('zero stations inspected → the activity metric reads "Not assessed", never "None observed"', () => {
    expect(buildTodaysMetrics({ checked: 0, total: 12, activityCount: 0, servicedCount: 0 })[1].value).toBe('Not assessed');
    const out = buildTermiteReportV2({
      typedSnapshotValues: { stations_checked: 0, stations_inaccessible: 12, total_stations: 12, termite_activity: 'None observed', bait_consumption: 'None — bait intact' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status.label).toBe('Bait stations being monitored');
    expect(out.metrics[1]).toEqual({ label: 'Termite activity', value: 'Not assessed' });
  });

  it('clamps a recorded total below the documented counts — never "10 of 8"', () => {
    const net = buildStationNetwork({ values: { ...CLEAN_VALUES, total_stations: 8, stations_checked: 10 } });
    expect(net.counts.total).toBe(10);
    expect(buildTodaysMetrics({ checked: 10, total: net.counts.total, activityCount: 0, servicedCount: 0 })[0].value).toBe('10 of 10');
    const partial = buildStationNetwork({ values: { stations_checked: 10, stations_inaccessible: 2, total_stations: 11, termite_activity: 'None observed', bait_consumption: 'None — bait intact' } });
    expect(partial.counts.total).toBe(12);
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
    expect(out.metrics).toHaveLength(4);
    expect(out.metrics[3]).toEqual({ label: 'Bait condition', value: 'Intact' });
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
    expect(fromForm.metrics[2]).toEqual({ label: 'Stations serviced', value: 'Performed' });

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

  it('carries the tech-reviewed narrative as aiSummary in the pest/mosquito hero shape', () => {
    const out = buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', technicianReport: '  Reviewed copy.  ' });
    expect(out.aiSummary).toEqual({ headline: null, body: 'Reviewed copy.' });
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', technicianReport: '' }).aiSummary).toBeNull();
  });

  it('visit-backed activity pins escalate a "None observed" form select — never a clean headline beside active stations', () => {
    const out = buildTermiteReportV2({
      typedSnapshotValues: CLEAN_VALUES,
      typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 2, serviced: 0, inaccessible: 0 },
    });
    expect(out.status.key).toBe('action');
    expect(out.status.label).toBe('Termite activity observed at 2 stations');
    expect(out.metrics[1].value).toBe('2 stations');
    // pins never DOWNGRADE an explicit activity selection
    const kept = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, termite_activity: 'Previous feeding noted' },
      typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 0, serviced: 0, inaccessible: 0 },
    });
    expect(kept.status.key).toBe('evidence');
  });

  it('legacy "None observed" + feeding → monitoring headline that keeps the feeding evidence', () => {
    const out = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, bait_consumption: 'Light feeding' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status).toEqual({ key: 'monitoring', tone: 'watch', label: 'Bait feeding noted — monitoring continues' });
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
