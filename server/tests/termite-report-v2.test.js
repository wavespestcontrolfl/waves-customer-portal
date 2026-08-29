// Unit tests for the Termite Report V2 aggregator (bait-station protection
// dashboard). Asserts the trust-critical behavior: absence claims stay scoped
// to the stations inspected today, activity never renders as "protected",
// "serviced today" is claimed only on documented station work, the builder is
// null for non-bait typed types, and the PDF signature is empty when the gate
// is off or the line does not apply. Synthetic payloads only (no customer PII).

const {
  buildTermiteReportV2,
  attachTermiteReportV2,
  termiteBaitSnapshotOf,
  frozenTermiteServiceKey,
  recordStage,
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
  it('accepts bait-station termite names; a one-time cartridge replacement is not the routine check', () => {
    expect(isTermiteBaitServiceName('Termite Bait Station Service')).toBe(true);
    expect(isTermiteBaitServiceName('Termite Bait Monitoring (Quarterly)')).toBe(true);
    expect(isTermiteBaitServiceName('Termite Bait Cartridge Replacement')).toBe(false);
  });

  it('rejects installation / setup visits and detection-only monitoring names (no bait token)', () => {
    expect(isTermiteBaitServiceName('Termite Bait Station Installation')).toBe(false);
    expect(isTermiteBaitServiceName('Termite Station Setup')).toBe(false);
    expect(isTermiteBaitServiceName('Termite Monitoring Service')).toBe(false);
    expect(isTermiteBaitServiceName('Termite Bait Monitoring')).toBe(true);
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

  it('positive activity-sign chips override a legacy "None observed" select', () => {
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: 'None — bait intact', checked: 12, inaccessible: 0, activitySigns: 'Live termites in station' }).key).toBe('action');
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: 'None — bait intact', checked: 12, inaccessible: 0, activitySigns: 'Mud tubing in station, Favorable moisture / soil conditions' }).key).toBe('action');
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: 'None — bait intact', checked: 12, inaccessible: 0, activitySigns: 'Previous feeding evidence' }).key).toBe('evidence');
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: 'None — bait intact', checked: 12, inaccessible: 0, activitySigns: 'Bait feeding' }).key).toBe('monitoring');
    // a moisture-only chip is not activity
    expect(resolveTermiteStatus({ termiteActivity: 'None observed', baitConsumption: 'None — bait intact', checked: 12, inaccessible: 0, activitySigns: 'Favorable moisture / soil conditions' }).key).toBe('protected');
  });

  it('frozen positive evidence (activity count / active location) beside "None observed" is activity', () => {
    const base = { termiteActivity: 'None observed', baitConsumption: 'None — bait intact', checked: 12, inaccessible: 0 };
    expect(resolveTermiteStatus({ ...base, activityCount: 2 }).key).toBe('action');
    expect(resolveTermiteStatus({ ...base, activeLocation: 'Station 7, rear wall' }).key).toBe('action');
    expect(resolveTermiteStatus({ ...base, activityCount: 0, activeLocation: '  ' }).key).toBe('protected');
    // "Previous feeding noted" + a frozen count stays EVIDENCE, never "active"
    expect(resolveTermiteStatus({ ...base, termiteActivity: 'Previous feeding noted', activityCount: 2 }).key).toBe('evidence');
    expect(buildTermiteReportV2({ typedSnapshotValues: { ...CLEAN_VALUES, termite_activity: 'Previous feeding noted', stations_with_activity: 2 }, typedReportType: 'termite_bait_station' }).status.label).toBe('Evidence of termite activity observed at 2 stations');
    const out = buildTermiteReportV2({ typedSnapshotValues: { ...CLEAN_VALUES, stations_with_activity: 2 }, typedReportType: 'termite_bait_station' });
    expect(out.status.label).toBe('Termite activity observed at 2 stations');
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

  it('no inspected count → neutral monitoring copy; a recorded activity finding survives zero inspection', () => {
    const copy = buildTodaysResultCopy({ statusKey: 'monitoring', checked: null });
    expect(copy.headline).toBe('Bait stations being monitored');
    const active = buildTodaysResultCopy({ statusKey: 'action', checked: 0, total: 12, inaccessible: 12 });
    expect(active.headline).toBe('Termite activity recorded');
    expect(active.body).toMatch(/12 stations could not be accessed today/);
    const evidence = buildTodaysResultCopy({ statusKey: 'evidence', checked: 0 });
    expect(evidence.headline).toBe('Evidence of termite activity recorded');
    expect(evidence.body).toMatch(/could not be inspected today/);
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

describe('buildStationNetwork — a RECONCILED station-map summary drives the counts', () => {
  it('uses the station-map summary when it agrees with the typed counts', () => {
    const net = buildStationNetwork({
      values: { ...CLEAN_VALUES, total_stations: 14, stations_checked: 12, stations_inaccessible: 2 },
      stationSummary: { total: 14, checked: 12, activity: 2, serviced: 2, inaccessible: 2 },
    });
    expect(net.counts).toEqual({ total: 14, checked: 12, activity: 2, inaccessible: 2 });
    expect(net.items.map((i) => i.key)).toEqual(['inspected', 'activity', 'bait', 'access']);
    // bait intact + activity pins (live termites / mud tubing) → never "bait engaged"
    expect(net.items[1].detail).toBe('2 stations — activity observed');
    const feeding = buildStationNetwork({
      values: { ...CLEAN_VALUES, total_stations: 14, stations_checked: 12, stations_inaccessible: 2, bait_consumption: 'Moderate feeding' },
      stationSummary: { total: 14, checked: 12, activity: 2, serviced: 2, inaccessible: 2 },
    });
    expect(feeding.items[1].detail).toBe('2 stations — bait engaged');
    expect(net.summary).toBe('Your protective ring: 12 inspected · 2 with activity · 2 inaccessible.');
  });

  it('blank optional counts are absent, never 0 — a reconciled summary still drives the counts', () => {
    const values = { ...CLEAN_VALUES, total_stations: '', stations_inaccessible: null };
    const summary = { total: 12, checked: 12, activity: 1, serviced: 0, inaccessible: 0 };
    const net = buildStationNetwork({ values, stationSummary: summary });
    expect(net.counts).toEqual({ total: 12, checked: 12, activity: 1, inaccessible: 0 });
    const out = buildTermiteReportV2({ typedSnapshotValues: values, typedReportType: 'termite_bait_station', stationSummary: summary });
    expect(out.stationSyncPartial).toBe(false);
    expect(out.status.label).toBe('Termite activity observed at 1 station');
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

  it('a partially synced summary (counts disagree with the typed snapshot) never replaces the typed totals — status evidence still escalates', () => {
    // 12-of-12 documented; sync applied 11 checks (one entry skipped)
    const partial = { total: 11, checked: 11, activity: 1, serviced: 2, inaccessible: 0 };
    const net = buildStationNetwork({ values: CLEAN_VALUES, stationSummary: partial });
    expect(net.counts).toEqual({ total: 12, checked: 12, activity: 0, inaccessible: 0 });
    const out = buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', stationSummary: partial });
    expect(out.metrics[0].value).toBe('12 of 12');
    expect(out.statusSummary).not.toMatch(/all 11/);
    // the activity pin still escalates the status; serviced pins still count as
    // WORK — but a partial sync never prints an exact serviced number
    expect(out.status.key).toBe('action');
    expect(out.metrics[2]).toEqual({ label: 'Stations serviced', value: 'Performed' });
    expect(out.statusSummary).toMatch(/Bait service was performed today/);
    // the payload flags the partial sync so the client suppresses the map / rows
    expect(out.stationSyncPartial).toBe(true);
    // …and the frozen typed location stays with the frozen counts
    const partialLoc = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, termite_activity: 'Active termites present', stations_with_activity: 1, active_station_location: 'Station 7, rear wall' },
      typedReportType: 'termite_bait_station',
      stationSummary: partial,
    });
    expect(partialLoc.statusSummary).toMatch(/Station 7, rear wall/);
    // a reconciled summary DOES drive the counts (and the exact serviced number)
    const agreed = buildStationNetwork({ values: CLEAN_VALUES, stationSummary: { total: 12, checked: 12, activity: 1, serviced: 2, inaccessible: 0 } });
    expect(agreed.counts.activity).toBe(1);
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', stationSummary: { total: 12, checked: 12, activity: 1, serviced: 2, inaccessible: 0 } }).metrics[2]).toEqual({ label: 'Stations serviced', value: '2' });
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', stationSummary: { total: 12, checked: 12, activity: 1, serviced: 2, inaccessible: 0 } }).stationSyncPartial).toBe(false);
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station' }).stationSyncPartial).toBe(false);
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

  it('zero stations inspected → "Not assessed", and NO bait-condition claim anywhere', () => {
    expect(buildTodaysMetrics({ checked: 0, total: 12, activityCount: 0, servicedCount: 0, baitConsumption: 'None — bait intact' })[1].value).toBe('Not assessed');
    const out = buildTermiteReportV2({
      typedSnapshotValues: { stations_checked: 0, stations_inaccessible: 12, total_stations: 12, termite_activity: 'None observed', bait_consumption: 'None — bait intact' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status.label).toBe('Bait stations being monitored');
    expect(out.metrics[1]).toEqual({ label: 'Termite activity', value: 'Not assessed' });
    expect(out.metrics.find((m) => m.label === 'Bait condition')).toBeUndefined();
    expect(out.defense.items.map((i) => i.key)).not.toContain('bait');
  });

  it('feeding-backed monitoring never prints "None observed" as the activity metric', () => {
    const out = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, bait_consumption: 'Light feeding' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status.label).toBe('Bait feeding noted — monitoring continues');
    expect(out.metrics[1]).toEqual({ label: 'Termite activity', value: 'Feeding noted' });
    expect(out.metrics[3]).toEqual({ label: 'Bait condition', value: 'Light feeding' });
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

  it('a hand-typed activity location yields to visit-backed pins (count wording), and stands without them', () => {
    const values = { ...CLEAN_VALUES, termite_activity: 'Active termites present', stations_with_activity: 1, active_station_location: 'Station 7, rear wall' };
    const typedOnly = buildTermiteReportV2({ typedSnapshotValues: values, typedReportType: 'termite_bait_station' });
    expect(typedOnly.statusSummary).toMatch(/Station 7, rear wall/);
    const pinned = buildTermiteReportV2({
      typedSnapshotValues: values,
      typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 2, serviced: 0, inaccessible: 0 },
    });
    expect(pinned.statusSummary).not.toMatch(/Station 7/);
    expect(pinned.statusSummary).toMatch(/2 of the 12 stations inspected/);
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
    // the payload says the frozen select was overridden (the gauge trend is stale)
    expect(out.statusReconciled).toBe(true);
    // …and a frozen "No action needed" commitment is replaced by a monitoring commitment
    const noAction = buildTermiteReportV2({
      typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 2, serviced: 0, inaccessible: 0 },
      nextStep: 'No action needed.',
    });
    expect(noAction.nextStep).toBe('We will re-check the active stations at your next monitoring visit.');
    const followUp = buildTermiteReportV2({
      typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 2, serviced: 0, inaccessible: 0 },
      nextStep: 'Recheck active stations sooner.',
    });
    expect(followUp.nextStep).toBe('Recheck active stations sooner.');
    // no escalation → the frozen commitment stands verbatim
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station', nextStep: 'No action needed.' }).nextStep).toBe('No action needed.');
    expect(buildTermiteReportV2({ typedSnapshotValues: CLEAN_VALUES, typedReportType: 'termite_bait_station' }).statusReconciled).toBe(false);
    // …and so does EVERY reconciliation away from the select, not only pins
    expect(buildTermiteReportV2({ typedSnapshotValues: { ...CLEAN_VALUES, stations_with_activity: 2 }, typedReportType: 'termite_bait_station' }).statusReconciled).toBe(true);
    expect(buildTermiteReportV2({ typedSnapshotValues: { ...CLEAN_VALUES, activity_signs: 'Live termites in station' }, typedReportType: 'termite_bait_station' }).statusReconciled).toBe(true);
    expect(buildTermiteReportV2({ typedSnapshotValues: { ...CLEAN_VALUES, bait_consumption: 'Light feeding' }, typedReportType: 'termite_bait_station' }).statusReconciled).toBe(true);
    // an explicit activity selection is the select's own reading — not a reconciliation
    expect(buildTermiteReportV2({ typedSnapshotValues: { ...CLEAN_VALUES, termite_activity: 'Active termites present' }, typedReportType: 'termite_bait_station' }).statusReconciled).toBe(false);
    // frozen evidence also replaces a contradictory no-action step
    expect(buildTermiteReportV2({ typedSnapshotValues: { ...CLEAN_VALUES, stations_with_activity: 2 }, typedReportType: 'termite_bait_station', nextStep: 'No action needed.' }).nextStep).toBe('We will re-check the active stations at your next monitoring visit.');
    // current activity pins escalate the historical evidence state too — and mark it reconciled
    const fromEvidence = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, termite_activity: 'Previous feeding noted' },
      typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 1, serviced: 0, inaccessible: 0 },
    });
    expect(fromEvidence.status.key).toBe('action');
    expect(fromEvidence.statusReconciled).toBe(true);
    // pins never DOWNGRADE an explicit activity selection
    const kept = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, termite_activity: 'Previous feeding noted' },
      typedReportType: 'termite_bait_station',
      stationSummary: { total: 12, checked: 12, activity: 0, serviced: 0, inaccessible: 0 },
    });
    expect(kept.status.key).toBe('evidence');
  });

  it('legacy "None observed" + "Live termites in station" chip never headlines a clean visit', () => {
    const out = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, activity_signs: 'Live termites in station' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status.key).toBe('action');
    expect(out.status.label).toBe('Termite activity observed');
  });

  it('legacy "None observed" + feeding → monitoring headline that keeps the feeding evidence', () => {
    const out = buildTermiteReportV2({
      typedSnapshotValues: { ...CLEAN_VALUES, bait_consumption: 'Light feeding' },
      typedReportType: 'termite_bait_station',
    });
    expect(out.status).toEqual({ key: 'monitoring', tone: 'watch', label: 'Bait feeding noted — monitoring continues' });
  });
});

describe('attachTermiteReportV2 — the one composer shared by the route and the queued PDF renderer', () => {
  const original = process.env.TERMITE_REPORT_V2;
  afterEach(() => {
    if (original === undefined) delete process.env.TERMITE_REPORT_V2;
    else process.env.TERMITE_REPORT_V2 = original;
  });
  const service = { service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: CLEAN_VALUES } }) };
  const payload = () => ({
    serviceLine: 'termite',
    typedReport: { type: 'termite_bait_station', visitSequence: 2, todaysResult: { nextStep: 'Recheck sooner.' } },
    stationMap: { available: true, program: 'termite', summary: { total: 12, checked: 12, activity: 0, serviced: 1, inaccessible: 0 } },
    termiteNextMonitoringVisit: { scheduledDate: '2026-11-16', windowStart: '09:00', serviceType: 'Termite Bait Station Service' },
    summarySource: 'technician_report',
    summary: 'Reviewed copy.',
  });

  it('attaches the dashboard from the frozen snapshot + map summary and consumes the live-only next-visit field', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    const data = attachTermiteReportV2(payload(), service);
    expect(data.termiteReportV2.status.label).toBe('No termite activity observed');
    expect(data.termiteReportV2.visitSequence).toBe(2);
    expect(data.termiteReportV2.nextStep).toBe('Recheck sooner.');
    expect(data.termiteReportV2.nextVisit.scheduledDate).toBe('2026-11-16');
    expect(data.termiteReportV2.aiSummary).toEqual({ headline: null, body: 'Reviewed copy.' });
    expect(data.termiteReportV2.metrics[2].value).toBe('1');
    expect(data).not.toHaveProperty('termiteNextMonitoringVisit');
  });

  it('is a no-op (and still removes the live-only field) when the gate is off or on a non-bait typed type — never keyed on serviceLine', () => {
    process.env.TERMITE_REPORT_V2 = 'false';
    const off = attachTermiteReportV2(payload(), service);
    expect(off.termiteReportV2).toBeUndefined();
    expect(off).not.toHaveProperty('termiteNextMonitoringVisit');
    process.env.TERMITE_REPORT_V2 = 'true';
    // the name-derived serviceLine is NOT consulted — "Bait Annual" detects
    // as pest while its snapshot is termite_bait_station
    expect(attachTermiteReportV2({ ...payload(), serviceLine: 'pest' }, service).termiteReportV2.status.label).toBe('No termite activity observed');
    expect(attachTermiteReportV2({ ...payload(), typedReport: { type: 'termite_liquid' } }, service).termiteReportV2).toBeUndefined();
    expect(attachTermiteReportV2(null, service)).toBeNull();
  });
});

describe('termiteBaitSnapshotOf / companion snapshots (combined visits)', () => {
  const original = process.env.TERMITE_REPORT_V2;
  afterEach(() => {
    if (original === undefined) delete process.env.TERMITE_REPORT_V2;
    else process.env.TERMITE_REPORT_V2 = original;
  });
  const combined = { service_data: JSON.stringify({
    typedReportSnapshot: { type: 'cockroach', values: {} },
    companionReportSnapshots: [
      { type: 'termite_bait_station', delivery: 'auto_send', values: CLEAN_VALUES },
    ],
  }) };
  const internalOnly = { service_data: JSON.stringify({
    typedReportSnapshot: { type: 'cockroach', values: {} },
    companionReportSnapshots: [{ type: 'termite_bait_station', delivery: 'internal_only', values: CLEAN_VALUES }],
  }) };

  it('resolves the primary first, then an auto_send companion; internal_only companions never qualify', () => {
    expect(termiteBaitSnapshotOf({ service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: {} } }) }).source).toBe('primary');
    expect(termiteBaitSnapshotOf(combined).source).toBe('companion');
    expect(termiteBaitSnapshotOf(internalOnly)).toBeNull();
    expect(termiteBaitSnapshotOf({ service_data: '{}' })).toBeNull();
    expect(termiteBaitSnapshotOf({})).toBeNull();
  });

  it('attaches the dashboard from the auto_send companion, keyed to the companion report entry, tagged source=companion', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    const data = attachTermiteReportV2({
      serviceLine: 'pest',
      typedReport: { type: 'cockroach', visitSequence: 1, todaysResult: { nextStep: 'Roach next step.' } },
      companionReports: [{ type: 'termite_bait_station', visitSequence: 4, internalOnly: false, todaysResult: { nextStep: 'Recheck the bait ring.' } }],
      summarySource: 'technician_report',
      summary: 'Roach narrative.',
    }, combined);
    expect(data.termiteReportV2.source).toBe('companion');
    expect(data.termiteReportV2.visitSequence).toBe(4);
    expect(data.termiteReportV2.nextStep).toBe('Recheck the bait ring.');
    // the primary's narrative never rides a companion dashboard
    expect(data.termiteReportV2.aiSummary).toBeNull();
  });

  it('a companion dashboard carries the COMPANION\'s own accepted technician-report body', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    const withBody = attachTermiteReportV2({
      serviceLine: 'pest',
      typedReport: null,
      companionReports: [{ type: 'termite_bait_station', visitSequence: 2, internalOnly: false, todaysResult: { headline: 'x', body: 'Stations 6 and 10 fed heavily; both cartridges replaced.', bodySource: 'technician_report', nextStep: 'Recheck sooner.' } }],
      summarySource: 'technician_report',
      summary: 'Primary framing that must not ride the companion.',
    }, combined);
    expect(withBody.termiteReportV2.aiSummary).toEqual({ headline: null, body: 'Stations 6 and 10 fed heavily; both cartridges replaced.' });
    // a companion body the story did NOT accept (no bodySource) is never promoted
    const unaccepted = attachTermiteReportV2({
      typedReport: null,
      companionReports: [{ type: 'termite_bait_station', visitSequence: 2, internalOnly: false, todaysResult: { headline: 'x', body: 'Drafted, not accepted.' } }],
    }, combined);
    expect(unaccepted.termiteReportV2.aiSummary).toBeNull();
  });

  it('an installation-stage visit keeps the typed record (no dashboard) and consumes the stage field', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    const service = { service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: CLEAN_VALUES } }) };
    const install = attachTermiteReportV2({ typedReport: { type: 'termite_bait_station', visitSequence: 1 }, termiteBaitStage: 'installation' }, service);
    expect(install.termiteReportV2).toBeUndefined();
    expect(install).not.toHaveProperty('termiteBaitStage');
    const monitoring = attachTermiteReportV2({ typedReport: { type: 'termite_bait_station', visitSequence: 2 }, termiteBaitStage: 'monitoring' }, service);
    expect(monitoring.termiteReportV2.status.label).toBe('No termite activity observed');
    expect(monitoring).not.toHaveProperty('termiteBaitStage');
  });

  it('a detection-only monitoring visit keeps the typed record (no active-bait copy)', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    const service = { service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: CLEAN_VALUES } }) };
    const detection = attachTermiteReportV2({ typedReport: { type: 'termite_bait_station', visitSequence: 3 }, termiteBaitStage: 'detection' }, service);
    expect(detection.termiteReportV2).toBeUndefined();
    expect(detection).not.toHaveProperty('termiteBaitStage');
  });

  it('reconciles against the persisted check rows even when only the basemap failed (checkSummary)', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    const service = { service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: CLEAN_VALUES } }) };
    const data = attachTermiteReportV2({
      typedReport: { type: 'termite_bait_station', visitSequence: 2 },
      stationMap: { available: false, reason: 'provider_unavailable', program: 'termite', checkSummary: { total: 12, checked: 12, activity: 2, serviced: 0, inaccessible: 0 } },
    }, service);
    expect(data.termiteReportV2.status.label).toBe('Termite activity observed at 2 stations');
  });

  it('never consumes a non-termite program map (rodent primary + termite companion renders the RODENT pins)', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    const service = { service_data: JSON.stringify({
      typedReportSnapshot: { type: 'rodent_bait_station', values: {} },
      companionReportSnapshots: [{ type: 'termite_bait_station', delivery: 'auto_send', values: CLEAN_VALUES }],
    }) };
    const data = attachTermiteReportV2({
      typedReport: { type: 'rodent_bait_station', visitSequence: 1 },
      companionReports: [{ type: 'termite_bait_station', visitSequence: 2, internalOnly: false }],
      stationMap: { available: true, program: 'rodent', summary: { total: 12, checked: 12, activity: 3, serviced: 0, inaccessible: 0 } },
    }, service);
    // rodent capture pins must not escalate the termite status
    expect(data.termiteReportV2.status.label).toBe('No termite activity observed');
    expect(data.termiteReportV2.stationSyncPartial).toBe(false);
  });

  it('a companion the payload filtered out (internal_only) yields no dashboard', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    expect(attachTermiteReportV2({ typedReport: { type: 'cockroach' }, companionReports: [] }, internalOnly).termiteReportV2).toBeUndefined();
    expect(attachTermiteReportV2({ typedReport: { type: 'cockroach' }, companionReports: [{ type: 'termite_bait_station', internalOnly: true }] }, combined).termiteReportV2).toBeUndefined();
  });

  it('the PDF signature keys on the companion snapshot too', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    expect(termiteReportV2PdfSignature(combined)).toBe('-termv2');
    expect(termiteReportV2PdfSignature(internalOnly)).toBe('');
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

  it('frozenTermiteServiceKey / recordStage: completedServiceKey, else the snapshot\'s own serviceKey, else names', () => {
    const snap = (extra) => ({ service_type: 'Termite Bait Station Service', service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_bait_station', values: {}, ...extra } }) });
    expect(frozenTermiteServiceKey({ service_data: JSON.stringify({ completedServiceKey: 'termite_installation_setup', typedReportSnapshot: { type: 'termite_bait_station', serviceKey: 'termite_bait', values: {} } }) })).toBe('termite_installation_setup');
    expect(frozenTermiteServiceKey(snap({ serviceKey: 'termite_monitoring' }))).toBe('termite_monitoring');
    expect(frozenTermiteServiceKey(snap({}))).toBeNull();
    // the snapshot's immutable key drives the stage when no top-level freeze exists
    expect(recordStage(snap({ serviceKey: 'termite_monitoring' }))).toBe('detection');
    expect(recordStage(snap({ serviceKey: 'termite_installation_setup' }))).toBe('installation');
    expect(recordStage(snap({ serviceKey: 'termite_bait' }))).toBe('monitoring');
    // legacy (no frozen key at all): names
    expect(recordStage({ ...snap({}), service_type: 'Termite Monitoring Service' })).toBe('detection');
    // companion snapshot carries its own key
    const combined = { service_type: 'Quarterly Pest Control', service_data: JSON.stringify({ typedReportSnapshot: { type: 'cockroach', serviceKey: 'cockroach_treatment', values: {} }, companionReportSnapshots: [{ type: 'termite_bait_station', delivery: 'auto_send', serviceKey: 'termite_monitoring', values: {} }] }) };
    expect(recordStage(combined)).toBe('detection');
    process.env.TERMITE_REPORT_V2 = 'true';
    expect(termiteReportV2PdfSignature(snap({ serviceKey: 'termite_monitoring' }))).toBe('');
    expect(termiteReportV2PdfSignature(snap({ serviceKey: 'termite_bait' }))).toBe('-termv2');
  });

  it('keys the stage from the frozen completedServiceKey first; names only for legacy records without one', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    // legacy (no frozen key): names decide
    expect(termiteReportV2PdfSignature({ ...baitRecord, service_type: 'Termite Bait Station Installation' })).toBe('');
    expect(termiteReportV2PdfSignature({ ...baitRecord, service_type: 'Termite Bait Setup' })).toBe('');
    expect(termiteReportV2PdfSignature({ ...baitRecord, service_type: 'Termite Monitoring Service' })).toBe('');
    expect(termiteReportV2PdfSignature({ ...baitRecord, service_type: 'Termite Bait Station Service' })).toBe('-termv2');
    // frozen key wins over a customized label in BOTH directions
    const frozen = (key, service_type) => ({ service_type, service_data: JSON.stringify({ completedServiceKey: key, typedReportSnapshot: { type: 'termite_bait_station', values: {} } }) });
    expect(termiteReportV2PdfSignature(frozen('termite_bait', 'Termite Bait Station Installation'))).toBe('-termv2');
    expect(termiteReportV2PdfSignature(frozen('termite_installation_setup', 'Termite Bait Station Service'))).toBe('');
    expect(termiteReportV2PdfSignature(frozen('termite_monitoring', 'Termite Bait Station Service'))).toBe('');
  });

  it('is empty for other typed types, records without a snapshot, and malformed service_data', () => {
    process.env.TERMITE_REPORT_V2 = 'true';
    expect(termiteReportV2PdfSignature({ service_type: 'Termite Bait Station Service', service_data: JSON.stringify({ typedReportSnapshot: { type: 'termite_liquid' } }) })).toBe('');
    expect(termiteReportV2PdfSignature({ service_type: 'Termite Bait Station Service', service_data: null })).toBe('');
    expect(termiteReportV2PdfSignature({ service_data: '{not json' })).toBe('');
    expect(termiteReportV2PdfSignature({})).toBe('');
  });
});
